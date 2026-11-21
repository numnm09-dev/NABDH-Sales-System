// عمليات الـ ERP على الخادم: عزل الشركات، الصلاحيات، منع التكرار، وقواعد المحرك نفسها (رصيد المخزون).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb, createRes } = require('./fake-admin-db');
const { factory, E } = require('./helpers');

let db;
const users = {
  'mgr1': { uid: 'mgr-1', email: 'Mgr1@Example.com', email_verified: true },
  'mgr2': { uid: 'mgr-2', email: 'mgr2@example.com', email_verified: true },
  'stranger': { uid: 'str-1', email: 'str@example.com', email_verified: true },
  'unverified': { uid: 'mgr-1', email: 'mgr1@example.com', email_verified: false },
  'solo': { uid: 'solo-1', email: 'solo@example.com', email_verified: true }
};

const firebasePath = require.resolve('../api/_lib/firebase-admin');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: {
    getFirebaseAdmin: async () => ({
      auth: {
        verifyIdToken: async t => {
          if (!users[t]) throw Object.assign(new Error('x'), { code: 'auth/invalid-id-token' });
          return users[t];
        }
      },
      database: db.database
    })
  }
};

const handler = require('../api/erp-op');
const { pickToday } = require('../api/_lib/erp-runner');

let seedFactory;
let opN = 0;
const newOp = () => 'srv-op-' + (++opN);

beforeEach(() => {
  seedFactory = { a: factory(), b: factory() };
  db = createFakeDb({
    companies: {
      'company-1': { id: 'company-1', name: 'شركة النور', status: 'active', managerUid: 'mgr-1' },
      'company-2': { id: 'company-2', name: 'شركة الأمل', status: 'active', managerUid: 'mgr-2' }
    },
    companyMembers: {
      'company-1': { 'mgr-1': { uid: 'mgr-1', role: 'MANAGER', status: 'active' } },
      'company-2': { 'mgr-2': { uid: 'mgr-2', role: 'MANAGER', status: 'active' } }
    },
    companyData: { 'company-1': seedFactory.a.db, 'company-2': seedFactory.b.db }
  });
});

async function call(body, { method = 'POST', token = 'mgr1' } = {}) {
  const res = createRes();
  await handler({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
  return res;
}

const company = (extra = {}) => ({ scope: 'company', companyId: 'company-1', opId: newOp(), ...extra });
const itemId = (code, which = 'a') => seedFactory[which].id(code);
const stockIn = (which = 'a', qty = 100, id = 'company-1') => ({
  ...company({ companyId: id }),
  op: 'receiptVoucher',
  input: { whId: 'wh_fg', reason: 'opening', lines: [{ itemId: itemId('ORJ', which), qty, unitCost: 3 }] }
});
const fp = path => JSON.stringify(db.get(path));

test('رفض: غير POST / بلا توكن / بريد غير مؤكَّد / مدخلات ناقصة أو نطاق غير معروف', async () => {
  assert.equal((await call(company({ op: 'cashEntry' }), { method: 'GET' })).statusCode, 405);
  assert.equal((await call(company({ op: 'cashEntry' }), { token: null })).statusCode, 401);
  assert.equal((await call(company({ op: 'cashEntry' }), { token: 'bad' })).statusCode, 401);
  assert.equal((await call(company({ op: 'cashEntry' }), { token: 'unverified' })).statusCode, 403);
  assert.equal((await call({ scope: 'company', companyId: 'company-1' })).statusCode, 400);
  assert.equal((await call({ scope: 'planet', op: 'cashEntry', opId: 'x' })).data.error, 'invalid_scope');
  assert.equal((await call({ scope: 'company', companyId: '../x', op: 'cashEntry', opId: 'x' })).data.error, 'invalid_company_id');
});

test('مدير الشركة ينفّذ عملية حقيقية: تُحفظ في بيانات شركته فقط ولا يُنشأ حساب شخصي', async () => {
  const before2 = fp('companyData/company-2');
  const res = await call(stockIn('a', 100));

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.duplicate, false);
  assert.equal(E.stockOf(res.data.db, itemId('ORJ'), 'wh_fg'), 100);
  assert.equal(E.stockOf(db.get('companyData/company-1'), itemId('ORJ'), 'wh_fg'), 100);
  assert.deepEqual(E.verify(db.get('companyData/company-1')), []);

  assert.equal(fp('companyData/company-2'), before2, 'شركة أخرى لم تتغير');
  assert.equal(db.get('users'), null, 'لا حساب شخصي');
});

test('اسم المنفّذ في سجل التدقيق يُؤخذ من التوكن الموثَّق وليس من العميل', async () => {
  const res = await call({ ...stockIn(), user: 'admin@evil.com', ctx: { user: 'evil' }, input: { ...stockIn().input, user: 'evil' } });
  assert.equal(res.statusCode, 200);

  const data = db.get('companyData/company-1');
  const last = data.audit[data.audit.length - 1];
  assert.equal(last.user, 'Mgr1@Example.com');
  assert.ok(!JSON.stringify(data.audit).includes('evil'));
});

test('عزل الشركات: مدير شركة 1 لا يكتب في شركة 2 ولا يقرأ منها عبر الخادم', async () => {
  const before = fp('companyData/company-2');

  const res = await call(stockIn('b', 50, 'company-2'));
  assert.equal(res.statusCode, 403);
  assert.equal(res.data.error, 'forbidden');
  assert.equal(fp('companyData/company-2'), before);

  // والعكس: مدير شركة 2 يعمل على شركته فقط
  const ok = await call(stockIn('b', 5, 'company-2'), { token: 'mgr2' });
  assert.equal(ok.statusCode, 200);
  assert.equal(E.stockOf(db.get('companyData/company-1'), itemId('ORJ'), 'wh_fg'), 0);
});

test('غير الأعضاء والأعضاء الموقوفون والأدوار غير المعرّفة والشركات غير الفعّالة: 403 بلا أي تغيير', async () => {
  const before = fp('companyData/company-1');

  assert.equal((await call(stockIn(), { token: 'stranger' })).statusCode, 403);

  db.set('companyMembers/company-1/mgr-1/status', 'suspended');
  assert.equal((await call(stockIn())).statusCode, 403);
  db.set('companyMembers/company-1/mgr-1/status', 'active');

  db.set('companyMembers/company-1/mgr-1/role', 'ACCOUNTANT');
  assert.equal((await call(stockIn())).statusCode, 403);
  db.set('companyMembers/company-1/mgr-1/role', 'MANAGER');

  db.set('companies/company-1/status', 'suspended');
  assert.equal((await call(stockIn())).statusCode, 403);
  db.set('companies/company-1/status', 'active');

  assert.equal(fp('companyData/company-1'), before);
  assert.equal((await call(stockIn())).statusCode, 200);
});

test('قواعد المحرك مفروضة: رصيد غير كافٍ يُرفض بـ422 ورسالة عربية والبيانات كما هي', async () => {
  const before = fp('companyData/company-1');

  const res = await call({
    ...company(),
    op: 'createInvoice',
    input: { whId: 'wh_fg', customerId: seedFactory.a.cust.id, lines: [{ itemId: itemId('ORJ'), qty: 10, unitPrice: 6 }], paid: 0, method: 'نقدي' }
  });

  assert.equal(res.statusCode, 422);
  assert.equal(res.data.error, 'insufficient_stock');
  assert.ok(res.data.message.includes('رصيد غير كافٍ'));
  assert.equal(fp('companyData/company-1'), before);
});

test('بيع بعد استلام مخزون: المخزون والمحاسبة تتغيران معًا وتبقى السلامة', async () => {
  await call(stockIn('a', 100));
  const res = await call({
    ...company(),
    op: 'createInvoice',
    input: { whId: 'wh_fg', customerId: seedFactory.a.cust.id, lines: [{ itemId: itemId('ORJ'), qty: 40, unitPrice: 6 }], paid: 100, method: 'نقدي' }
  });

  assert.equal(res.statusCode, 200);
  const data = db.get('companyData/company-1');
  assert.equal(E.stockOf(data, itemId('ORJ'), 'wh_fg'), 60);
  assert.equal(data.sales.length, 1);
  assert.deepEqual(E.verify(data), []);
});

test('منع التكرار: نفس opId مرتين ينفَّذ مرة واحدة والثاني duplicate، ومتزامنًا كذلك', async () => {
  const body = stockIn('a', 10);

  const first = await call(body);
  const second = await call(body);
  assert.equal(first.data.duplicate, false);
  assert.equal(second.statusCode, 200);
  assert.equal(second.data.duplicate, true);
  assert.equal(E.stockOf(db.get('companyData/company-1'), itemId('ORJ'), 'wh_fg'), 10);

  const concurrent = stockIn('a', 7);
  const [a, b] = await Promise.all([call(concurrent), call(concurrent)]);
  assert.deepEqual([a.data.duplicate, b.data.duplicate].sort(), [false, true]);
  assert.equal(E.stockOf(db.get('companyData/company-1'), itemId('ORJ'), 'wh_fg'), 17);
});

test('عمليتان مختلفتان متزامنتان تُنفَّذان كلتاهما دون فقد', async () => {
  const [a, b] = await Promise.all([call(stockIn('a', 3)), call(stockIn('a', 4))]);
  assert.equal(a.statusCode + b.statusCode, 400);
  assert.equal(E.stockOf(db.get('companyData/company-1'), itemId('ORJ'), 'wh_fg'), 7);
  assert.equal(db.get('companyData/company-1/rev') - seedFactory.a.db.rev, 2);
});

test('أسماء عمليات خاطئة أو حساسة للنموذج (constructor/__proto__/toString) مرفوضة', async () => {
  const before = fp('companyData/company-1');
  for (const op of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nope', '']) {
    const res = await call({ ...company(), op, input: {} });
    assert.ok([400, 422].includes(res.statusCode), `${op} -> ${res.statusCode}`);
  }
  assert.equal(fp('companyData/company-1'), before);
});

test('بيانات الشركة غير موجودة أو بنية قديمة: 422 دون إنشاء أي شيء', async () => {
  db.set('companyData/company-1', null);
  let res = await call(stockIn());
  assert.equal(res.statusCode, 422);
  assert.equal(res.data.error, 'no_data');
  assert.equal(db.get('companyData/company-1'), null);

  db.set('companyData/company-1', { schemaVersion: 1, items: [] });
  res = await call(stockIn());
  assert.equal(res.data.error, 'needs_migration');
});

test('تاريخ العميل: يُقبل ضمن ±يوم من الخادم وإلا يُستبدل بتاريخ الخادم', () => {
  const now = new Date('2026-11-13T10:00:00Z');
  assert.equal(pickToday('2026-11-14', now), '2026-11-14');
  assert.equal(pickToday('2026-11-12', now), '2026-11-12');
  assert.equal(pickToday('2020-01-01', now), '2026-11-13');
  assert.equal(pickToday('2026-13-45xx', now), '2026-11-13');
  assert.equal(pickToday(undefined, now), '2026-11-13');
  assert.equal(pickToday({ a: 1 }, now), '2026-11-13');
});

/* ---------- نطاق المستخدم القديم: مقيَّد بعلم يضعه مدير النظام فقط ---------- */
test('scope=user مرفوض افتراضيًا، ويعمل لصاحب العلم فقط وعلى بياناته هو', async () => {
  const solo = factory();
  db.set('users/solo-1', solo.db);
  db.set('users/mgr-1', factory().db);
  const body = {
    scope: 'user', opId: newOp(), op: 'receiptVoucher',
    input: { whId: 'wh_fg', reason: 'opening', lines: [{ itemId: solo.id('ORJ'), qty: 9, unitCost: 3 }] }
  };

  let res = await call(body, { token: 'solo' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.data.error, 'server_ops_not_enabled');
  assert.equal(E.stockOf(db.get('users/solo-1'), solo.id('ORJ'), 'wh_fg'), 0);

  db.set('serverOps/solo-1', { enabledAt: 1, enabledBy: 'admin-1' });
  const otherBefore = fp('users/mgr-1');
  res = await call({ ...body, opId: newOp(), uid: 'mgr-1', companyId: 'x' }, { token: 'solo' });
  assert.equal(res.statusCode, 200);
  assert.equal(E.stockOf(db.get('users/solo-1'), solo.id('ORJ'), 'wh_fg'), 9);
  assert.equal(fp('users/mgr-1'), otherBefore, 'لا كتابة على مستخدم آخر مهما أُرسل في الطلب');

  // العلم لا يفتح نطاق المستخدم لغير صاحبه
  assert.equal((await call({ ...body, opId: newOp() }, { token: 'mgr1' })).statusCode, 403);
});
