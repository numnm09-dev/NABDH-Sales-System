// اختبارات انحدار لإصلاحات المراجعة التقنية والأمنية. كلها على المحرك الحقيقي (js/) ودوال api/ الحقيقية
// بقاعدة بيانات وهمية في الذاكرة؛ لا تثبت سلوك Firebase الفعلي ولا الاتصال بأي خدمة خارجية.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeDb, createRes } = require('./fake-admin-db');
const { E, ctx, mk } = require('./helpers');
const Reports = require('../js/erp-reports.js');

/* ---------- 1) ربح الفاتورة يطابق الأستاذ العام حتى مع المرتجع التالف ---------- */
function shop() {
  const s = mk();
  s.go('cashEntry', { kind: 'capital_in', amount: 10000 });
  const fg = s.db.warehouses.find(w => w.kind === 'finished').id;
  const item = s.go('upsertItem', { code: 'FG1', name: 'منتج', type: 'finished', openingQty: 10, openingCost: 50, openingWhId: fg });
  const cust = s.go('upsertCustomer', { name: 'عميل' });
  s.fg = fg; s.item = item; s.cust = cust;
  return s;
}
const sumProfit = db => Reports.sales(db, {}).sections[0].rows.reduce((a, r) => a + (Number(r.profit) || 0), 0);

test('مرتجع تالف: ربح الفاتورة في تقرير المبيعات يطابق مجمل الربح في قائمة الدخل (كان يزيد بتكلفة التالف)', () => {
  const s = shop();
  const inv = s.go('createInvoice', { whId: s.fg, customerId: s.cust.id, lines: [{ itemId: s.item.id, qty: 4, unitPrice: 100 }], paid: 400, method: 'نقدي' });
  s.go('createReturn', { saleId: inv.id, lines: [{ itemId: s.item.id, qty: 2 }], restock: false, refundMethod: 'نقدي' });
  const gl = Reports.pnl(s.db, {});
  assert.equal(gl.grossProfit, 0);                       // بيع 4×100، رُدّ 2 تالفتان: الإيراد الصافي 200 وتكلفة الأربع 200
  assert.equal(sumProfit(s.db), gl.grossProfit);
});

test('مرتجع صالح ثم تالف ثم صالح على فاتورة واحدة: مجموع أرباح الفواتير = مجمل الربح بالأستاذ', () => {
  const s = shop();
  const inv = s.go('createInvoice', { whId: s.fg, customerId: s.cust.id, lines: [{ itemId: s.item.id, qty: 5, unitPrice: 100 }], paid: 500, method: 'نقدي' });
  s.go('createReturn', { saleId: inv.id, lines: [{ itemId: s.item.id, qty: 1 }], restock: true, refundMethod: 'نقدي' });
  assert.equal(sumProfit(s.db), Reports.pnl(s.db, {}).grossProfit);
  s.go('createReturn', { saleId: inv.id, lines: [{ itemId: s.item.id, qty: 1 }], restock: false, refundMethod: 'نقدي' });
  assert.equal(sumProfit(s.db), Reports.pnl(s.db, {}).grossProfit);
  s.go('createReturn', { saleId: inv.id, lines: [{ itemId: s.item.id, qty: 3 }], restock: true, refundMethod: 'نقدي' });
  const gl = Reports.pnl(s.db, {});
  assert.equal(sumProfit(s.db), gl.grossProfit);
  assert.equal(gl.grossProfit, -50);                     // وحدة واحدة تالفة (تكلفتها 50) خسارة صافية مقابل مبلغ رُدّ
  assert.deepEqual(E.verify(s.db, {}), []);
});

/* ---------- 2) إلغاء الفاتورة يخضع لقاعدة رصيد الخزينة ---------- */
function cashTight() {
  const s = mk();
  s.go('cashEntry', { kind: 'capital_in', amount: 100 });
  const fg = s.db.warehouses.find(w => w.kind === 'finished').id;
  const item = s.go('upsertItem', { code: 'FG1', name: 'منتج', type: 'finished', openingQty: 10, openingCost: 50, openingWhId: fg });
  const inv = s.go('createInvoice', { whId: fg, lines: [{ itemId: item.id, qty: 4, unitPrice: 100 }], method: 'نقدي' });
  s.go('recordExpense', { category: 'إيجار', method: 'نقدي', amount: 450 });
  return { s, inv };
}

test('إلغاء فاتورة مدفوعة والخزينة لا تكفي لردّها: يُرفض insufficient_cash والبيانات كما هي', () => {
  const { s, inv } = cashTight();
  assert.equal(E.cashBalance(s.db), 50);
  const e = s.fail('cancelInvoice', { id: inv.id, reason: 'خطأ' }, 'insufficient_cash');
  assert.match(e.message, /الخزينة/);
  assert.equal(s.db.sales[0].status, 'مؤكد');
  assert.equal(E.cashBalance(s.db), 50);
});

test('إلغاء الفاتورة: ينجح عند كفاية الخزينة، وعند تفعيل السماح برصيد سالب، وفاتورة آجلة بلا نقد لا تتأثر', () => {
  const { s, inv } = cashTight();
  s.go('cashEntry', { kind: 'capital_in', amount: 400 });
  s.go('cancelInvoice', { id: inv.id, reason: 'خطأ' });
  assert.equal(E.cashBalance(s.db), 50);
  assert.deepEqual(E.verify(s.db, {}), []);

  const t = cashTight();
  t.s.go('updateSettings', { allowNegativeCash: true });
  t.s.go('cancelInvoice', { id: t.inv.id, reason: 'خطأ' });
  assert.equal(E.cashBalance(t.s.db), -350);

  const u = mk();
  const fg = u.db.warehouses.find(w => w.kind === 'finished').id;
  const it = u.go('upsertItem', { code: 'FG1', name: 'منتج', type: 'finished', openingQty: 5, openingCost: 10, openingWhId: fg });
  const c = u.go('upsertCustomer', { name: 'عميل' });
  const credit = u.go('createInvoice', { whId: fg, customerId: c.id, lines: [{ itemId: it.id, qty: 2, unitPrice: 30 }], paid: 0 });
  u.go('cancelInvoice', { id: credit.id });
  assert.equal(E.cashBalance(u.db), 0);
});

/* ---------- 3) معرّف العملية opId ---------- */
test('opId: طول محدود وأحرف آمنة فقط، و__proto__ مرفوض؛ و«constructor» وأمثاله تُنفَّذ مرة واحدة فقط', () => {
  const db = E.migrate({}).db;
  const run = opId => E.apply(db, { opId, user: 't', now: '2026-11-10T10:00:00.000Z', today: '2026-11-10' }, 'cashEntry', { kind: 'capital_in', amount: 1 });

  for (const bad of ['', 'a'.repeat(101), '__proto__', 'a b', 'a/b', 'a.b', 'a$b', 'a#b', 'a[b', 'a\u0000b', 'مفتاح', null, undefined, 5]) {
    assert.throws(() => run(bad), e => e.code === 'no_op_id', `يجب رفض ${JSON.stringify(bad)}`);
  }

  assert.doesNotThrow(() => run('a'.repeat(100)));

  // اسم يطابق خاصية في Object.prototype لم يعد يُعدّ «مكررًا» من أول مرة، ويُكتشف تكراره فعلًا في الثانية
  const first = run('constructor');
  assert.equal(first.db.cashEntries.length, 1);
  assert.throws(() => E.apply(first.db, { opId: 'constructor', user: 't', now: '2026-11-10T10:00:00.000Z' }, 'cashEntry', { kind: 'capital_in', amount: 1 }), e => e.code === 'duplicate');
});

/* ---------- 4) مصالحة قبول دعوة الموظف لا تستبدل عضوية قائمة ---------- */
let adb;
let users;
const firebasePath = require.resolve('../api/_lib/firebase-admin');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: {
    getFirebaseAdmin: async () => ({
      auth: { verifyIdToken: async t => { if (!users[t]) throw Object.assign(new Error('bad'), { code: 'auth/invalid-id-token' }); return users[t]; } },
      database: adb.database
    })
  }
};
const acceptHandler = require('../api/accept-invitation');
const staffHandler = require('../api/company-staff');
const { createInvitationToken, hashInvitationToken } = require('../api/_lib/invitations');

const call = async (handler, token, body, method = 'POST') => {
  const res = createRes();
  await handler({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
  return res;
};

const TOKEN = createInvitationToken();
const INV = 'staff_c1_abc';

function seedStuckAccept(memberOver = {}) {
  adb = createFakeDb({
    companies: { c1: { id: 'c1', name: 'شركة', status: 'active', managerUid: 'm1', managerStatus: 'linked' } },
    companyMembers: { c1: { m1: { uid: 'm1', email: 'mgr@example.com', role: 'MANAGER', companyId: 'c1', status: 'active' }, 'emp-1': { uid: 'emp-1', email: 'emp@example.com', role: 'SALES', companyId: 'c1', invitationId: INV, status: 'active', invitedBy: 'm1', createdAt: 1, ...memberOver } } },
    userCompanies: { 'emp-1': { c1: { companyId: 'c1', name: 'شركة', role: memberOver.role || 'SALES', createdAt: 1 } } },
    invitations: { [INV]: { id: INV, kind: 'staff', companyId: 'c1', email: 'emp@example.com', role: 'SALES', status: 'accepting', acceptedBy: 'emp-1', acceptedEmail: 'emp@example.com', acceptingAt: Date.now() - 120000, tokenHash: hashInvitationToken(TOKEN), expiresAt: Date.now() + 3600e3, invitedBy: 'm1' } }
  });
}

beforeEach(() => {
  users = {
    'emp-tok': { uid: 'emp-1', email: 'emp@example.com', email_verified: true },
    'mgr-tok': { uid: 'm1', email: 'mgr@example.com', email_verified: true },
    'mgr2-tok': { uid: 'm2', email: 'mgr2@example.com', email_verified: true }
  };
  seedStuckAccept();
});

test('قبول عالق ثم إعادة المحاولة لا يعيد تفعيل موظف أوقفه المدير (كان يكتب status=active فوق suspended)', async () => {
  seedStuckAccept({ status: 'suspended' });
  const res = await call(acceptHandler, 'emp-tok', { invitationId: INV, token: TOKEN });
  assert.equal(adb.get('companyMembers/c1/emp-1/status'), 'suspended');
  assert.equal(adb.get(`invitations/${INV}/status`), 'accepted');
  assert.ok([200, 409].includes(res.statusCode));

  // ويبقى الموقوف ممنوعًا من العمليات فعليًا
  const erpOp = require('../api/erp-op');
  const r = await call(erpOp, 'emp-tok', { scope: 'company', companyId: 'c1', action: 'read' });
  assert.equal(r.statusCode, 403);
});

test('المصالحة تُكمل الناقص فقط: عضوية مفقودة تُنشأ نشطة، وربط حساب مفقود يُنشأ دون مساس بالعضوية القائمة', async () => {
  seedStuckAccept();
  adb.set('userCompanies/emp-1/c1', null);
  adb.set('companyMembers/c1/emp-1/createdAt', 12345);
  await call(acceptHandler, 'emp-tok', { invitationId: INV, token: TOKEN });
  assert.equal(adb.get('companyMembers/c1/emp-1/createdAt'), 12345);       // لم تُستبدل
  assert.equal(adb.get('userCompanies/emp-1/c1/role'), 'SALES');           // أُكمل الناقص
  assert.equal(adb.get(`invitations/${INV}/status`), 'accepted');
});

test('تعارض دور بين العضوية والدعوة: مراجعة يدوية ولا كتابة (العضوية كما هي)', async () => {
  seedStuckAccept({ role: 'HR' });
  const before = JSON.stringify(adb.get('companyMembers'));
  const res = await call(acceptHandler, 'emp-tok', { invitationId: INV, token: TOKEN });
  assert.notEqual(res.statusCode, 200);
  assert.equal(JSON.stringify(adb.get('companyMembers')), before);
});

/* ---------- 5) سجل التدقيق للعمليات الإدارية ---------- */
const auditEntries = () => Object.values(adb.get('adminAudit') || {});

test('تغيير دور وحالة الموظف يُسجَّلان في adminAudit بالفاعل والقيم القديمة والجديدة، دون أي توكن', async () => {
  seedStuckAccept();
  adb.set(`invitations/${INV}/status`, 'accepted');
  let res = await call(staffHandler, 'mgr-tok', { action: 'set-role', companyId: 'c1', uid: 'emp-1', role: 'ACCOUNTANT' });
  assert.equal(res.statusCode, 200);
  res = await call(staffHandler, 'mgr-tok', { action: 'set-status', companyId: 'c1', uid: 'emp-1', status: 'suspended' });
  assert.equal(res.statusCode, 200);

  const log = auditEntries();
  const role = log.find(x => x.action === 'staff.set-role');
  const status = log.find(x => x.action === 'staff.set-status');
  assert.deepEqual([role.actor, role.companyId, role.target, role.details], ['m1', 'c1', 'emp-1', { from: 'SALES', to: 'ACCOUNTANT' }]);
  assert.deepEqual(status.details, { from: 'active', to: 'suspended' });
  assert.ok(Number.isFinite(role.ts));
  assert.ok(!JSON.stringify(log).match(/tokenHash|Bearer|[A-Za-z0-9_-]{43}/));
});

test('محاولة مرفوضة (مدير شركة أخرى) لا تغيّر شيئًا ولا تُسجَّل كنجاح', async () => {
  seedStuckAccept();
  adb.set('companyMembers/c2/m2', { uid: 'm2', role: 'MANAGER', status: 'active', companyId: 'c2', email: 'mgr2@example.com' });
  adb.set('companies/c2', { id: 'c2', name: 'أخرى', status: 'active', managerUid: 'm2' });
  const res = await call(staffHandler, 'mgr2-tok', { action: 'set-role', companyId: 'c1', uid: 'emp-1', role: 'HR' });
  assert.equal(res.statusCode, 403);
  assert.equal(adb.get('companyMembers/c1/emp-1/role'), 'SALES');
  assert.equal(auditEntries().length, 0);
});

test('فشل كتابة السجل لا يُسقط العملية الأساسية (تُسجَّل في سجل الخادم)', async () => {
  seedStuckAccept();
  adb.set(`invitations/${INV}/status`, 'accepted');
  const original = adb.database.ref;
  adb.database.ref = p => { const r = original(p); if (String(p).startsWith('adminAudit')) { r.set = async () => { throw new Error('boom'); }; } return r; };
  const log = console.error; console.error = () => { };
  try {
    const res = await call(staffHandler, 'mgr-tok', { action: 'set-status', companyId: 'c1', uid: 'emp-1', status: 'suspended' });
    assert.equal(res.statusCode, 200);
    assert.equal(adb.get('companyMembers/c1/emp-1/status'), 'suspended');
  } finally { console.error = log; adb.database.ref = original; }
});

/* ---------- 6) إعدادات النشر ---------- */
test('vercel.json: ترويسات الأمان الأساسية موجودة، وAPI بلا تخزين مؤقت', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const all = Object.fromEntries(cfg.headers.find(h => h.source === '/(.*)').headers.map(h => [h.key, h.value]));
  assert.equal(all['X-Content-Type-Options'], 'nosniff');
  assert.equal(all['X-Frame-Options'], 'DENY');
  assert.ok(all['Referrer-Policy']);
  assert.match(all['Strict-Transport-Security'], /max-age=\d{7,}/);
  assert.ok(all['Content-Security-Policy-Report-Only'], 'CSP تجريبية (Report-Only) حتى تُجرَّب في متصفح حقيقي');
  assert.equal(cfg.headers.find(h => h.source === '/api/(.*)').headers[0].value, 'no-store');
});

test('الحزمة النهائية: لا ملفات .env حقيقية ولا رموز Vercel OIDC داخل شجرة المشروع التي تُسلَّم', () => {
  const root = path.join(__dirname, '..');
  const offenders = [];
  const walk = dir => { for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === 'node_modules' || d.name === '.git') continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p);
    else if (/^\.env(\..+)?$/.test(d.name) && d.name !== '.env.example') offenders.push(path.relative(root, p));
  } };
  walk(root);
  // في بيئة التطوير قد يوجد .env.local محلي (متجاهَل في git)؛ المهم ألا يحوي توكن Vercel OIDC حقيقيًا يُشحن مع الحزمة.
  for (const f of offenders) assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./.test(fs.readFileSync(path.join(root, f), 'utf8')), `رمز JWT داخل ${f}`);
});
