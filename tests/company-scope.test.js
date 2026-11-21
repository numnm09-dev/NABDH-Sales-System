/* تكامل كامل: app.js الحقيقي (في vm) ← fetch ← api/erp-op.js الحقيقي ← قاعدة بيانات الخادم الوهمية.
   يثبت: مدير الشركة يعمل على بيانات شركته (لا حساب شخصي فارغ)، لا كتابة مباشرة من العميل على بيانات الشركة،
   الحسابات القديمة تبقى كما هي، وسلوك الأعطال لا يُنشئ بيانات خاطئة.
   لا يثبت قواعد Firebase الفعلية (انظر rules.test.js للفحص البنيوي فقط). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeDb, createRes } = require('./fake-admin-db');
const { factory, E } = require('./helpers');

let adminDb;
const tokens = {
  'tok-mgr-1': { uid: 'mgr-1', email: 'mgr1@example.com', email_verified: true },
  'tok-solo': { uid: 'solo-1', email: 'solo@example.com', email_verified: true }
};

const firebasePath = require.resolve('../api/_lib/firebase-admin');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: {
    getFirebaseAdmin: async () => ({
      auth: { verifyIdToken: async t => { if (!tokens[t]) throw Object.assign(new Error('x'), { code: 'auth/invalid-id-token' }); return tokens[t]; } },
      database: adminDb.database
    })
  }
};
const erpOp = require('../api/erp-op');

const noop = () => { };

function boot({ data, fetchImpl, readFails = {} } = {}) {
  adminDb = createFakeDb(data);
  const writes = [];           // كل ما يكتبه العميل مباشرة
  const reads = [];            // كل ما يقرأه العميل مباشرة من Firebase
  const fb = {
    db: {}, auth: {}, signOut: async () => { }, onAuthStateChanged: noop,
    ref: (_d, p) => ({ path: p }),
    get: async r => {
      reads.push(r.path);
      const failing = Object.keys(readFails).find(k => r.path.startsWith(k));
      if (failing) throw readFails[failing];
      const s = await adminDb.database.ref(r.path).get();
      return { exists: () => s.exists(), val: () => s.val() };
    },
    set: async (r, v) => { writes.push(['set', r.path]); return adminDb.database.ref(r.path).set(v); },
    update: async (r, v) => { writes.push(['update', r.path]); return adminDb.database.ref(r.path).update(v); },
    runTransaction: async (r, fn) => {
      writes.push(['txn', r.path]);
      const res = await adminDb.database.ref(r.path).transaction(fn);
      return { committed: res.committed, snapshot: res.snapshot };
    }
  };

  const el = () => ({ style: {}, classList: { toggle: noop, add: noop, remove: noop, contains: () => false }, dataset: {}, innerHTML: '', textContent: '', hidden: false, elements: {}, open: false, isConnected: true,
    querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, setAttribute: noop, appendChild: noop, showModal: noop, close: noop, click: noop, remove: noop, focus: noop });
  const shared = el();
  const storage = {};
  const calls = [];
  const ctx = { console: { ...console, error: noop, warn: noop }, Math, Date, JSON, Intl, Number, String, Array, Object, Set, Map, Promise, RegExp, Error, isFinite, isNaN, parseFloat, parseInt, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, Blob: class { }, FormData: class { }, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop } };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  ctx.document = { readyState: 'loading', title: '', visibilityState: 'visible', activeElement: null, body: el(), querySelector: () => shared, querySelectorAll: () => [], addEventListener: noop, createElement: el, getElementById: () => null };
  ctx.location = { hash: '' }; ctx.addEventListener = noop; ctx.removeEventListener = noop; ctx.print = noop; ctx.confirm = () => true; ctx.prompt = () => 'سبب';
  ctx.localStorage = { getItem: k => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); } };
  ctx.NabdhFirebase = fb;
  ctx.fetch = fetchImpl || (async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, init });
    const res = createRes();
    await erpOp({ method: init.method, headers: { authorization: init.headers.Authorization }, body }, res);
    return { ok: res.statusCode < 400, status: res.statusCode, json: async () => res.data };
  });
  vm.createContext(ctx);
  for (const f of ['calc', 'erp-core', 'erp-ops', 'erp-ops2', 'erp-hr', 'roles', 'erp-reports', 'store', 'xlsx-lite', 'ui-kit', 'ui-pages', 'ui-pages2', 'ui-pages3', 'ui-hr', 'app'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f + '.js'), 'utf8'), ctx, { filename: f + '.js' });
  ctx.shared = shared;
  return { ctx, shared, writes, reads, calls, storage, run: code => vm.runInContext(code, ctx) };
}

const login = (t, uid, email, token) => {
  t.ctx.__u = { uid, email, emailVerified: true, getIdToken: async () => token };
  return t.run('handleAuth(__u)');
};

function world() {
  const a = factory(); const b = factory();
  return {
    a, b,
    data: {
      companies: {
        'company-1': { id: 'company-1', name: 'شركة النور', status: 'active', managerUid: 'mgr-1' },
        'company-2': { id: 'company-2', name: 'شركة الأمل', status: 'active', managerUid: 'mgr-2' }
      },
      companyMembers: {
        'company-1': { 'mgr-1': { uid: 'mgr-1', role: 'MANAGER', status: 'active' } },
        'company-2': { 'mgr-2': { uid: 'mgr-2', role: 'MANAGER', status: 'active' } }
      },
      userCompanies: { 'mgr-1': { 'company-1': { companyId: 'company-1', name: 'شركة النور', role: 'MANAGER' } } },
      companyData: { 'company-1': a.db, 'company-2': b.db }
    }
  };
}

const receipt = (w, qty) => ({ whId: 'wh_fg', reason: 'opening', lines: [{ itemId: w.a.id('ORJ'), qty, unitCost: 3 }] });
const act = (t, op, input, opId) => { t.ctx.__in = input; return t.run(`act(${JSON.stringify(op)}, __in, ${JSON.stringify(opId)})`); };

test('مدير شركة بلا حساب شخصي: يُحمَّل ERP الشركة نفسه ولا يُنشأ users/{uid} ولا يُكتب شيء من العميل', async () => {
  const w = world();
  const t = boot({ data: w.data });
  await login(t, 'mgr-1', 'mgr1@example.com', 'tok-mgr-1');

  assert.equal(t.run('ready'), true);
  assert.equal(t.run('scope.type'), 'company');
  assert.equal(t.run('scope.companyId'), 'company-1');
  assert.equal(t.run('DB.items.length'), w.a.db.items.length, 'بيانات شركته هي المحمّلة');
  assert.equal(adminDb.get('users'), null, 'لا قاعدة بيانات شخصية فارغة');
  assert.deepEqual(t.writes, [], 'العميل لم يكتب أي شيء');
  assert.ok(!t.reads.some(p => p.startsWith('companyData')), 'لا قراءة مباشرة من companyData: القراءة عبر الخادم فقط');
  assert.equal(t.run('scope.role'), 'MANAGER');
  assert.equal(t.run('scopeOptions.length'), 1);
  assert.equal(t.run('scopeSwitchHtml()'), '', 'نطاق واحد فقط: لا مبدّل');
});

test('عملية من العميل تمر عبر الخادم: تُحفظ في بيانات الشركة وتحدّث DB المحلي، ولا كتابة مباشرة من العميل', async () => {
  const w = world();
  const t = boot({ data: w.data });
  await login(t, 'mgr-1', 'mgr1@example.com', 'tok-mgr-1');

  await act(t, 'receiptVoucher', receipt(w, 25), 'c-op-1');

  const ops = t.calls.filter(c => c.body.action !== 'read');
  assert.equal(t.calls.filter(c => c.body.action === 'read').length, 1, 'القراءة الأولى عبر الخادم');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].url, '/api/erp-op');
  assert.equal(ops[0].body.scope, 'company');
  assert.equal(ops[0].body.companyId, 'company-1');
  assert.equal(ops[0].init.headers.Authorization, 'Bearer tok-mgr-1');

  assert.equal(E.stockOf(adminDb.get('companyData/company-1'), w.a.id('ORJ'), 'wh_fg'), 25);
  assert.equal(t.run(`Engine.stockOf(DB, ${JSON.stringify(w.a.id('ORJ'))}, 'wh_fg')`), 25);
  assert.equal(E.stockOf(adminDb.get('companyData/company-2'), w.b.id('ORJ'), 'wh_fg'), 0, 'شركة أخرى لم تتأثر');
  assert.deepEqual(t.writes, [], 'لا كتابة مباشرة من العميل على أي مسار');
  assert.equal(adminDb.get('users'), null);
});

test('رفض المحرك يصل للواجهة برمزه ورسالته العربية، والبيانات المحلية والمخزَّنة كما هي', async () => {
  const w = world();
  const t = boot({ data: w.data });
  await login(t, 'mgr-1', 'mgr1@example.com', 'tok-mgr-1');
  const before = JSON.stringify(adminDb.get('companyData/company-1'));

  const input = { whId: 'wh_fg', customerId: w.a.cust.id, lines: [{ itemId: w.a.id('ORJ'), qty: 5, unitPrice: 6 }], paid: 0, method: 'نقدي' };
  await assert.rejects(act(t, 'createInvoice', input, 'c-op-2'), e => e.erp === true && e.code === 'insufficient_stock' && e.message.includes('رصيد غير كافٍ'));

  assert.equal(JSON.stringify(adminDb.get('companyData/company-1')), before);
  assert.equal(t.run('DB.sales.length'), 0);
});

test('منع التكرار عبر العميل: نفس opId مرتين يُحتسب مرة واحدة', async () => {
  const w = world();
  const t = boot({ data: w.data });
  await login(t, 'mgr-1', 'mgr1@example.com', 'tok-mgr-1');

  await act(t, 'receiptVoucher', receipt(w, 10), 'c-op-dup');
  await act(t, 'receiptVoucher', receipt(w, 10), 'c-op-dup');

  assert.equal(E.stockOf(adminDb.get('companyData/company-1'), w.a.id('ORJ'), 'wh_fg'), 10);
});

test('أخطاء الخادم (شركة موقوفة، انقطاع شبكة) تصل برمز واضح ولا تغيّر DB المحلي', async () => {
  const w = world();
  let t = boot({ data: w.data });
  await login(t, 'mgr-1', 'mgr1@example.com', 'tok-mgr-1');
  adminDb.set('companies/company-1/status', 'suspended');
  const revBefore = t.run('DB.rev');
  await assert.rejects(act(t, 'receiptVoucher', receipt(w, 1), 'c-op-3'), e => e.code === 'forbidden' && /صلاحية/.test(e.message));
  assert.equal(t.run('DB.rev'), revBefore);

  t = boot({ data: world().data });
  await login(t, 'mgr-1', 'mgr1@example.com', 'tok-mgr-1');
  t.ctx.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(act(t, 'receiptVoucher', receipt(w, 1), 'c-op-4'), e => e.code === 'network');
});

test('حساب قديم له بيانات + عضوية شركة: يبقى شخصيًا افتراضيًا بلا أي نداء خادم، ويبدّل لشركته عند الاختيار', async () => {
  const w = world();
  const personal = factory();
  w.data.users = { 'mgr-1': personal.db };
  const personalBefore = JSON.stringify(personal.db);

  const t = boot({ data: w.data });
  await login(t, 'mgr-1', 'mgr1@example.com', 'tok-mgr-1');

  assert.equal(t.run('scope.type'), 'user', 'السلوك القديم محفوظ');
  assert.equal(t.run('scopeOptions.length'), 2);
  assert.ok(t.run('scopeSwitchHtml()').includes('حسابي الشخصي') && t.run('scopeSwitchHtml()').includes('شركة النور'));
  assert.equal(JSON.stringify(adminDb.get('users/mgr-1')), personalBefore, 'لا تغيير على بياناته الشخصية');
  assert.equal(t.calls.length, 0);

  t.storage['nabdh.scope.mgr-1'] = 'company-1';
  await login(t, 'mgr-1', 'mgr1@example.com', 'tok-mgr-1');
  assert.equal(t.run('scope.type'), 'company');
  assert.equal(t.run('DB.items.length'), w.a.db.items.length);

  // والعودة للشخصي
  t.storage['nabdh.scope.mgr-1'] = 'user';
  await login(t, 'mgr-1', 'mgr1@example.com', 'tok-mgr-1');
  assert.equal(t.run('scope.type'), 'user');
});

test('تفضيل شركة غير مرتبطة بالحساب يُتجاهل (لا وصول لشركة أخرى عبر التفضيل)', async () => {
  const w = world();
  const t = boot({ data: w.data });
  t.storage['nabdh.scope.mgr-1'] = 'company-2';
  await login(t, 'mgr-1', 'mgr1@example.com', 'tok-mgr-1');

  assert.equal(t.run('scope.companyId'), 'company-1');
  assert.ok(!t.run('scopeSwitchHtml()').includes('الأمل'));
});

test('حساب قديم بلا عضويات لا يتأثر: يُحمَّل كما كان ولا نداء خادم', async () => {
  const personal = factory();
  const t = boot({ data: { users: { 'solo-1': personal.db } } });
  await login(t, 'solo-1', 'solo@example.com', 'tok-solo');

  assert.equal(t.run('ready'), true);
  assert.equal(t.run('scope.type'), 'user');
  assert.equal(t.run('serverOps'), false);
  assert.equal(t.calls.length, 0);
  assert.equal(t.run('scopeSwitchHtml()'), '');
});

test('قواعد الشركات لم تُنشر بعد (permission denied): الحساب القديم يعمل كما كان، والجديد يرى خطأ ولا يُنشأ له حساب شخصي فارغ', async () => {
  const denied = Object.assign(new Error('PERMISSION_DENIED: Permission denied'), { code: 'PERMISSION_DENIED' });

  // حساب قديم له بيانات: لا يتأثر إطلاقًا
  let t = boot({ data: { users: { 'solo-1': factory().db } }, readFails: { 'userCompanies/': denied, 'serverOps/': denied } });
  await login(t, 'solo-1', 'solo@example.com', 'tok-solo');
  assert.equal(t.run('ready'), true);
  assert.equal(t.run('scope.type'), 'user');
  assert.equal(t.run('serverOps'), false);

  // حساب بلا بيانات (قد يكون مديرًا مدعوًّا): فشل مغلق، لا حساب شخصي فارغ
  t = boot({ data: {}, readFails: { 'userCompanies/': denied, 'serverOps/': denied } });
  await login(t, 'new-1', 'new@example.com', 'tok-new');
  assert.equal(t.run('ready'), false);
  assert.equal(adminDb.get('users'), null);
  assert.ok(t.shared.innerHTML.includes('تعذّر التحقق من الشركات'));
});

test('عطل شبكة أثناء اكتشاف الشركات لمن لا بيانات شخصية له: خطأ وليس إنشاء حساب شخصي فارغ', async () => {
  const w = world();
  const t = boot({ data: w.data, readFails: { 'userCompanies/': Object.assign(new Error('network error'), { code: 'unavailable' }) } });
  await login(t, 'mgr-1', 'mgr1@example.com', 'tok-mgr-1');

  assert.equal(t.run('ready'), false);
  assert.equal(adminDb.get('users'), null, 'لم يُنشأ حساب شخصي');
  assert.ok(t.shared.innerHTML.includes('تعذّر التحقق من الشركات'));
});

test('بيانات الشركة غير مهيأة أو بنية قديمة: خطأ واضح ولا تغيير', async () => {
  const w = world();
  delete w.data.companyData['company-1'];
  let t = boot({ data: w.data });
  await login(t, 'mgr-1', 'mgr1@example.com', 'tok-mgr-1');
  assert.equal(t.run('ready'), false);
  assert.ok(t.shared.innerHTML.includes('غير مهيأة'));
  assert.equal(adminDb.get('companyData/company-1'), null, 'لم تُنشأ بيانات الشركة من العميل');
  assert.equal(adminDb.get('users'), null);

  const w2 = world();
  w2.data.companyData['company-1'] = { schemaVersion: 1 };
  t = boot({ data: w2.data });
  await login(t, 'mgr-1', 'mgr1@example.com', 'tok-mgr-1');
  assert.equal(t.run('ready'), false);
  assert.ok(t.shared.innerHTML.includes('ترقية'));
});

test('حساب شخصي رُحِّل إلى عمليات الخادم (serverOps): العمليات عبر الخادم فقط والعميل لا يكتب على users/{uid}', async () => {
  const personal = factory();
  const t = boot({ data: { users: { 'solo-1': personal.db }, serverOps: { 'solo-1': { enabledAt: 1, enabledBy: 'admin-1' } } } });
  await login(t, 'solo-1', 'solo@example.com', 'tok-solo');

  assert.equal(t.run('serverOps'), true);
  assert.equal(t.run('scope.type'), 'user');

  await act(t, 'receiptVoucher', { whId: 'wh_fg', reason: 'opening', lines: [{ itemId: personal.id('ORJ'), qty: 8, unitCost: 3 }] }, 's-op-1');

  assert.equal(t.calls[0].body.scope, 'user');
  assert.equal(E.stockOf(adminDb.get('users/solo-1'), personal.id('ORJ'), 'wh_fg'), 8);
  assert.deepEqual(t.writes, [], 'لا كتابة مباشرة من العميل');
  const audit = adminDb.get('users/solo-1/audit');
  assert.equal(audit[audit.length - 1].user, 'solo@example.com');
});
