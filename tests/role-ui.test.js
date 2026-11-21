/* واجهة الأدوار الحقيقية (app.js + ui-*.js + roles.js في vm) متصلة بالخادم الحقيقي (erp-op و company-staff) على قاعدة وهمية:
   كل دور يرى قسمه فقط، وصفحات قسمه تُعرض ببياناتها الصحيحة، وأزرار ما لا يملكه لا تظهر، وفريق العمل يعمل للمدير فقط.
   لا يثبت تخطيط المتصفح الفعلي. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeDb, createRes } = require('./fake-admin-db');
const { factory } = require('./helpers');
const E = require('../js/erp-hr.js');
const Roles = require('../js/roles.js');

let adminDb;
let mails;
const tokens = {};
for (const [role, uid] of [['MANAGER', 'mgr-1'], ['HR', 'hr-1'], ['ACCOUNTANT', 'acc-1'], ['WAREHOUSE', 'wh-1'], ['SALES', 'sal-1']])
  tokens['tok-' + uid] = { uid, email: `${uid}@example.com`, email_verified: true, _role: role };

const firebasePath = require.resolve('../api/_lib/firebase-admin');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { getFirebaseAdmin: async () => ({ auth: { verifyIdToken: async t => { if (!tokens[t]) throw Object.assign(new Error('x'), { code: 'auth/invalid-id-token' }); return tokens[t]; } }, database: adminDb.database }) }
};
const mailerPath = require.resolve('../api/_lib/mailer');
require.cache[mailerPath] = { id: mailerPath, filename: mailerPath, loaded: true, exports: { assertMailConfigured() { }, async sendMail(p) { mails.push(p); return { id: 'm' + mails.length }; } } };
process.env.APP_BASE_URL = 'https://nabdh.example.com';

const erpOp = require('../api/erp-op');
const staffApi = require('../api/company-staff');

const noop = () => { };
let seedN = 0;
const sctx = () => ({ opId: 'ui-seed-' + (++seedN), user: 'seed', now: '2026-11-14T10:00:00Z', today: '2026-11-14' });

function seed() {
  const s = factory();
  let d = s.db;
  const go = (op, i) => { const r = E.apply(d, sctx(), op, i); d = r.db; return r.result; };
  go('receiptVoucher', { whId: 'wh_fg', reason: 'opening', lines: [{ itemId: s.id('ORJ'), qty: 100, unitCost: 3 }] });
  go('cashEntry', { kind: 'capital_in', amount: 20000 });
  go('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, lines: [{ itemId: s.id('ORJ'), qty: 10, unitPrice: 6 }], paid: 20, method: 'نقدي' });
  go('upsertEmployee', { name: 'موظف سري', salary: 4000, hireDate: '2026-01-01', jobTitle: 'فني' });
  const p = go('preparePayroll', { month: '2026-11' });
  go('approvePayroll', { id: p.id });
  const members = {};
  for (const [uid, role] of [['mgr-1', 'MANAGER'], ['hr-1', 'HR'], ['acc-1', 'ACCOUNTANT'], ['wh-1', 'WAREHOUSE'], ['sal-1', 'SALES']])
    members[uid] = { uid, email: `${uid}@example.com`, role, status: 'active', createdAt: 1 };
  const userCompanies = {};
  for (const uid of Object.keys(members)) userCompanies[uid] = { c1: { companyId: 'c1', name: 'شركة النور', role: members[uid].role } };
  adminDb = createFakeDb({
    companies: { c1: { id: 'c1', name: 'شركة النور', status: 'active', managerUid: 'mgr-1' } },
    companyMembers: { c1: members }, userCompanies, companyData: { c1: d }
  });
  return { s, d };
}

function boot(uid) {
  const els = {};
  const el = () => ({ style: {}, classList: { toggle: noop, add: noop, remove: noop, contains: () => false }, dataset: {}, innerHTML: '', textContent: '', value: '', hidden: false, open: false, isConnected: true, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, setAttribute: noop, appendChild: noop, showModal: noop, close: noop, click: noop, remove: noop, focus: noop });
  const get = k => (els[k] = els[k] || el());
  const calls = [];
  const fb = { db: {}, auth: {}, signOut: async () => { }, onAuthStateChanged: noop, ref: (_d, p) => ({ path: p }), get: async r => { const sn = await adminDb.database.ref(r.path).get(); return { exists: () => sn.exists(), val: () => sn.val() }; }, set: noop, update: noop, runTransaction: noop };
  const ctx = { console: { ...console, error: noop, warn: noop }, Math, Date, JSON, Intl, Number, String, Array, Object, Set, Map, Promise, RegExp, Error, isFinite, isNaN, parseFloat, parseInt, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, Blob: class { }, FormData: class { }, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop } };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  ctx.document = { readyState: 'loading', title: '', visibilityState: 'visible', activeElement: null, body: el(), querySelector: get, querySelectorAll: () => [], addEventListener: noop, createElement: el, getElementById: id => get('#' + id) };
  ctx.location = { hash: '' }; ctx.addEventListener = noop; ctx.removeEventListener = noop; ctx.print = noop; ctx.confirm = () => true; ctx.prompt = () => 'x';
  ctx.localStorage = { getItem: () => null, setItem: noop };
  ctx.NabdhFirebase = fb;
  ctx.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const res = createRes();
    await (url === '/api/company-staff' ? staffApi : erpOp)({ method: 'POST', headers: { authorization: init.headers.Authorization }, body }, res);
    return { ok: res.statusCode < 400, status: res.statusCode, json: async () => res.data };
  };
  vm.createContext(ctx);
  for (const f of ['calc', 'erp-core', 'erp-ops', 'erp-ops2', 'erp-hr', 'roles', 'erp-reports', 'store', 'xlsx-lite', 'ui-kit', 'ui-pages', 'ui-pages2', 'ui-pages3', 'ui-hr', 'app'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f + '.js'), 'utf8'), ctx, { filename: f + '.js' });
  const t = { ctx, els, calls, get, run: c => vm.runInContext(c, ctx), view: () => get('#view').innerHTML, nav: () => get('#nav').innerHTML };
  t.login = () => { ctx.__u = { uid, email: `${uid}@example.com`, emailVerified: true, getIdToken: async () => 'tok-' + uid }; return t.run('handleAuth(__u)'); };
  t.go = async hash => { ctx.location.hash = hash; t.run('safeRoute()'); };
  return t;
}

const PAGES = ['home', 'sales', 'purchasing', 'inventory', 'production', 'accounting', 'hr', 'reports', 'risk', 'sim', 'team', 'settings'];
const hrefs = nav => [...nav.matchAll(/href="#([a-z]+)"/g)].map(m => m[1]);
const LANDING = { MANAGER: null, HR: 'hr', ACCOUNTANT: 'accounting', WAREHOUSE: 'inventory', SALES: 'sales' };
const UIDS = { MANAGER: 'mgr-1', HR: 'hr-1', ACCOUNTANT: 'acc-1', WAREHOUSE: 'wh-1', SALES: 'sal-1' };

test('كل دور يرى أقسامه فقط في الشريط، ويفتح على قسمه، والمدير يرى كل شيء + فريق العمل', async () => {
  for (const [role, uid] of Object.entries(UIDS)) {
    seed();
    const t = boot(uid);
    await t.login();

    assert.equal(t.run('ready'), true, role);
    assert.equal(t.run('scope.role'), role);
    assert.deepEqual(hrefs(t.nav()), Roles.pagesFor(role, PAGES), `قائمة ${role}`);
    if (role === 'MANAGER') assert.ok(hrefs(t.nav()).includes('team') && hrefs(t.nav()).includes('hr'));
    else assert.equal(hrefs(t.nav()).length, 1, `${role} قسم واحد فقط`);
    if (LANDING[role]) assert.match(t.nav(), new RegExp(`aria-current="page"[^>]*>`), 'القسم الحالي محدَّد');
  }
});

test('محاولة فتح قسم غير مسموح عبر الرابط تُعاد إلى قسم الدور، ولا تُعرض بياناته', async () => {
  seed();
  const t = boot('sal-1');
  await t.login();
  for (const hash of ['#accounting', '#hr/employees', '#inventory', '#team', '#home', '#settings', '#production']) {
    await t.go(hash);
    assert.ok(t.view().includes('المبيعات'), `${hash}: عاد إلى المبيعات`);
    assert.ok(!t.view().includes('موظف سري') && !t.view().includes('الموارد البشرية'), hash);
  }

  const h = boot('hr-1');
  await h.login();
  await h.go('#accounting');
  assert.ok(h.view().includes('الموارد البشرية') && !h.view().includes('الملخص المالي'));
});

test('الموارد البشرية: صفحاتها الأربع تُعرض ببياناتها، وأزرارها مناسبة لدورها، ولا ترحيل للمحاسبة', async () => {
  seed();
  const t = boot('hr-1');
  await t.login();
  for (const tab of ['employees', 'attendance', 'leaves', 'payroll']) {
    await t.go('#hr/' + tab);
    assert.ok(t.view().includes('الموارد البشرية'), tab);
  }
  await t.go('#hr/employees');
  assert.ok(t.view().includes('موظف سري') && t.view().includes('EMP-00001'));
  assert.ok(t.view().includes('data-act="new-employee"') && t.view().includes('data-act="del-employee"'));

  await t.go('#hr/payroll');
  assert.ok(t.view().includes('PAY-00001'));
  assert.ok(!t.view().includes('data-act="post-payroll"'), 'HR لا يرحّل للمحاسبة');
  assert.ok(!t.view().includes('data-act="approve-payroll"'), 'الكشف معتمد بالفعل');
  assert.ok(t.view().includes('data-act="view-payroll"'));
});

test('المحاسب: المحاسبة سليمة بلا إنذارات كاذبة، وتبويب الرواتب بالترحيل ورؤوس فقط بلا أسماء موظفين', async () => {
  seed();
  const t = boot('acc-1');
  await t.login();
  await t.go('#accounting/summary');
  assert.ok(t.view().includes('الملخص المالي'));
  assert.ok(!t.view().includes('تم رصد'), 'لا إنذارات سلامة كاذبة من البيانات الجزئية');
  assert.ok(t.view().includes('سليمة'));
  for (const tab of ['cash', 'expenses', 'journal', 'payroll']) { await t.go('#accounting/' + tab); assert.ok(t.view().includes('المحاسبة'), tab); }

  await t.go('#accounting/payroll');
  assert.ok(t.view().includes('PAY-00001') && t.view().includes('data-act="post-payroll"'));
  assert.ok(!t.view().includes('موظف سري'));

  // ترحيل فعلي عبر المحرك على الخادم
  const before = E.cashBalance(adminDb.get('companyData/c1'));
  await t.run(`act('postPayroll', { id: DB.payroll[0].id, method: 'نقدي' }, 'ui-post-1')`);
  assert.equal(E.cashBalance(adminDb.get('companyData/c1')), before - 4000);
  assert.equal(t.run('DB.payroll[0].status'), 'posted');
  await t.go('#accounting/payroll');
  assert.ok(!t.view().includes('data-act="post-payroll"'), 'زر الترحيل اختفى بعد الترحيل');
});

test('أمين المخازن: صفحات المخزون بأصنافه وأرصدته وقيمة المخزون الصحيحة، ولا شيء من المبيعات أو الأفراد', async () => {
  const { d } = seed();
  const t = boot('wh-1');
  await t.login();
  for (const tab of ['stock', 'vouchers', 'ledger', 'warehouses']) { await t.go('#inventory/' + tab); assert.ok(t.view().includes('المخازن'), tab); }
  await t.go('#inventory/stock');
  const full = E.ensure(JSON.parse(JSON.stringify(d)));
  assert.ok(t.view().includes(String(full.items.length)));
  assert.equal(t.run("Engine.balances(DB)['1320']"), E.balances(full)['1320'], 'قيمة المنتجات التامة مطابقة');
  assert.ok(!t.view().includes('موظف سري'));
  assert.equal(t.run('DB.sales.length'), 0);
});

test('المبيعات: صفحة المبيعات بأرصدة العملاء الصحيحة (المستحق) وبلا وصول لأي قسم آخر', async () => {
  const { s, d } = seed();
  const t = boot('sal-1');
  await t.login();
  for (const tab of ['invoices', 'customers']) { await t.go('#sales/' + tab); assert.ok(t.view().includes('المبيعات'), tab); }
  const full = E.ensure(JSON.parse(JSON.stringify(d)));
  assert.equal(t.run(`Engine.arBalance(DB, ${JSON.stringify(s.cust.id)})`), E.arBalance(full, s.cust.id));
  assert.ok(E.arBalance(full, s.cust.id) > 0, 'شرط الاختبار: للعميل مستحق فعلي');

  await t.go('#sales/customers');
  assert.ok(t.view().includes('data-act="new-customer"'));
  assert.equal(t.run('DB.journal.every(j => j.lines.every(l => l.acct === "1200"))'), true);
});

test('المدير: كل الأقسام تعمل بما فيها الموارد البشرية، وتتغير الأرقام بعد عملية بين القسمين', async () => {
  seed();
  const t = boot('mgr-1');
  await t.login();
  for (const p of ['home', 'sales', 'inventory', 'accounting', 'hr', 'reports', 'settings']) { await t.go('#' + p); assert.ok(t.view().length > 50, p); }
  await t.go('#hr/payroll');
  assert.ok(t.view().includes('data-act="post-payroll"'), 'المدير يرحّل أيضًا');
  await t.run(`act('upsertEmployee', { name: 'منى', salary: 2500, hireDate: '2026-03-01' }, 'ui-emp-1')`);
  await t.go('#hr/employees');
  assert.ok(t.view().includes('منى') && t.view().includes('EMP-00002'));
});

test('فريق العمل: المدير يرى الأعضاء ويدعو ويغيّر الدور ويوقف؛ الموظف لا يصل لأي من ذلك', async () => {
  seed(); mails = [];
  const t = boot('mgr-1');
  await t.login();
  await t.go('#team');
  await new Promise(r => setTimeout(r, 20));
  t.run('safeRoute()');
  assert.ok(t.view().includes('فريق العمل') && t.view().includes('hr-1@example.com') && t.view().includes('الموارد البشرية'));
  assert.ok(t.view().includes('data-act="team-invite"'));

  // دعوة موظف جديد (يقرأ الحقول من DOM)
  t.get('#teamEmail').value = 'new.sales@example.com';
  t.get('#teamRole').value = 'SALES';
  await t.run(`UI.actions['team-invite']()`);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'new.sales@example.com');
  assert.ok(mails[0].text.includes('«مبيعات»'));
  t.run('safeRoute()');
  assert.ok(t.view().includes('new.sales@example.com') && t.view().includes('أُرسلت'));

  // إيقاف موظف ثم تفعيله
  await t.run(`UI.actions['team-suspend']('hr-1')`);
  assert.equal(adminDb.get('companyMembers/c1/hr-1/status'), 'suspended');
  await t.run(`UI.actions['team-activate']('hr-1')`);
  assert.equal(adminDb.get('companyMembers/c1/hr-1/status'), 'active');

  // الموظف: لا قسم فريق، والخادم يرفض واجهته أيضًا
  const s = boot('sal-1');
  await s.login();
  assert.ok(!hrefs(s.nav()).includes('team'));
  await s.go('#team');
  assert.ok(!s.view().includes('فريق العمل'));
  const denied = await s.run(`callServer({ companyId: 'c1', action: 'list' }, currentUser, '/api/company-staff')`);
  assert.equal(denied.status, 403);
});

test('إيقاف الموظف أثناء جلسته يغلق الواجهة عند المزامنة، وتغيير دوره يبدّل أقسامه', async () => {
  seed();
  const t = boot('sal-1');
  await t.login();
  assert.deepEqual(hrefs(t.nav()), ['sales']);

  adminDb.set('companyMembers/c1/sal-1/role', 'ACCOUNTANT');
  await t.run('refreshData()');
  assert.equal(t.run('scope.role'), 'ACCOUNTANT');
  assert.deepEqual(hrefs(t.nav()), ['accounting'], 'الأقسام تغيّرت مع الدور');
  assert.equal(t.run('DB.sales.length > 0'), true);

  adminDb.set('companyMembers/c1/sal-1/status', 'suspended');
  await t.run('refreshData()');
  assert.equal(t.run('ready'), false);
  assert.ok(t.view().includes('تم إيقاف وصولك'));
});

test('الحساب الشخصي القديم: كل الأقسام عدا الفريق (بما فيها الموارد البشرية)، بلا أي تغيير في سلوكه', async () => {
  seed();
  adminDb.set('users/solo-1', factory().db);
  tokens['tok-solo-1'] = { uid: 'solo-1', email: 'solo-1@example.com', email_verified: true };
  adminDb.set('userCompanies/solo-1', null);
  const t = boot('solo-1');
  await t.login();
  assert.equal(t.run('scope.type'), 'user');
  assert.deepEqual(hrefs(t.nav()), PAGES.filter(p => p !== 'team'));
  await t.go('#hr/employees');
  assert.ok(t.view().includes('الموارد البشرية'));
  assert.equal(t.calls.length, 0, 'لا نداءات خادم لحساب شخصي غير مُرحَّل');
});
