// الأدوار على الخادم (api/erp-op.js): من ينفّذ ماذا، وما الذي يصله من بيانات، وأن الأرقام التي تحسبها
// واجهة كل دور من بياناتها المُصفّاة تطابق الأرقام الحقيقية (فلا ينكسر عرض قسمه بسبب التصفية).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb, createRes } = require('./fake-admin-db');
const { factory } = require('./helpers');
const E = require('../js/erp-hr.js');
const Reports = require('../js/erp-reports.js');

let db;
let seeded;
const users = {};
for (const [t, uid] of [['mgr', 'mgr-1'], ['hr', 'hr-1'], ['acc', 'acc-1'], ['wh', 'wh-1'], ['sal', 'sal-1'], ['jan', 'jan-1'], ['out', 'out-1']])
  users[t] = { uid, email: `${t}@example.com`, email_verified: true };

const firebasePath = require.resolve('../api/_lib/firebase-admin');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { getFirebaseAdmin: async () => ({ auth: { verifyIdToken: async t => { if (!users[t]) throw Object.assign(new Error('x'), { code: 'auth/invalid-id-token' }); return users[t]; } }, database: db.database }) }
};
const handler = require('../api/erp-op');

let n = 0;
const ctx = () => ({ opId: 'seed-' + (++n), user: 'seed', now: '2026-11-14T10:00:00Z', today: '2026-11-14' });

function build() {
  const s = factory();
  let d = s.db;
  const go = (op, i) => { const r = E.apply(d, ctx(), op, i); d = r.db; return r.result; };
  go('receiptVoucher', { whId: 'wh_fg', reason: 'opening', lines: [{ itemId: s.id('ORJ'), qty: 100, unitCost: 3 }] });
  go('cashEntry', { kind: 'capital_in', amount: 20000 });
  go('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, lines: [{ itemId: s.id('ORJ'), qty: 10, unitPrice: 6 }], paid: 20, method: 'نقدي' });
  const emp = go('upsertEmployee', { name: 'موظف سري', salary: 4000, hireDate: '2026-01-01' });
  const p = go('preparePayroll', { month: '2026-11' });
  go('approvePayroll', { id: p.id });
  return { s, d, emp, payrollId: p.id };
}

beforeEach(() => {
  seeded = build();
  const members = {};
  for (const [uid, role, status] of [['mgr-1', 'MANAGER'], ['hr-1', 'HR'], ['acc-1', 'ACCOUNTANT'], ['wh-1', 'WAREHOUSE'], ['sal-1', 'SALES'], ['jan-1', 'JANITOR']])
    members[uid] = { uid, role, status: status || 'active' };
  db = createFakeDb({
    companies: { c1: { id: 'c1', name: 'شركة النور', status: 'active' }, c2: { id: 'c2', name: 'أخرى', status: 'active' } },
    companyMembers: { c1: members, c2: { 'out-1': { uid: 'out-1', role: 'MANAGER', status: 'active' } } },
    companyData: { c1: seeded.d, c2: factory().db }
  });
});

async function call(token, body) {
  const res = createRes();
  await handler({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { scope: 'company', companyId: 'c1', ...body } }, res);
  return res;
}
const read = async token => call(token, { action: 'read' });
let op = 0;
const run = (token, name, input) => call(token, { op: name, input, opId: 'op-' + (++op) });
const ORJ = () => seeded.s.id('ORJ');

test('القراءة: كل دور يستلم بيانات قسمه فقط، ولا يصل غير المدير سجل التدقيق ولا العدّادات', async () => {
  const mgr = await read('mgr');
  assert.equal(mgr.statusCode, 200);
  assert.equal(mgr.data.role, 'MANAGER');
  assert.equal(mgr.data.company.name, 'شركة النور');
  assert.ok(mgr.data.db.audit.length > 0 && mgr.data.db.employees.length === 1 && mgr.data.db.sales.length === 1);

  const raw = JSON.stringify;
  const hr = (await read('hr')).data.db;
  assert.equal(hr.employees[0].name, 'موظف سري');
  for (const k of ['journal', 'sales', 'items', 'customers', 'ledger', 'expenses', 'audit']) assert.deepEqual(hr[k], [], `HR/${k}`);

  const acc = (await read('acc')).data.db;
  assert.ok(acc.journal.length > 0 && acc.sales.length === 1);
  assert.deepEqual(acc.employees, []);
  assert.deepEqual(acc.ledger, []);
  assert.ok(!raw(acc).includes('موظف سري'), 'المحاسب لا يرى اسم موظف');
  assert.equal(acc.payroll[0].lines, undefined);

  const wh = (await read('wh')).data.db;
  assert.ok(wh.items.length > 0 && wh.ledger.length > 0);
  for (const k of ['sales', 'customers', 'expenses', 'employees', 'payroll', 'audit']) assert.deepEqual(wh[k], [], `WH/${k}`);
  assert.ok(wh.journal.every(j => j.lines.every(l => /^13/.test(l.acct))));

  const sal = (await read('sal')).data.db;
  assert.equal(sal.sales.length, 1);
  for (const k of ['expenses', 'employees', 'payroll', 'suppliers', 'ledger', 'audit']) assert.deepEqual(sal[k], [], `SALES/${k}`);
  assert.ok(sal.journal.length > 0 && sal.journal.every(j => j.lines.every(l => l.acct === '1200')), 'قيود الذمم 1200 فقط');

  for (const t of ['hr', 'acc', 'wh', 'sal']) {
    const v = (await read(t)).data.db;
    assert.deepEqual(v.ops, {}); assert.deepEqual(v.counters, {});
  }
});

test('الأرقام المحسوبة من بيانات كل دور تطابق الحقيقية (الخزينة، الذمم، الأرصدة، قيمة المخزون، التقارير)', async () => {
  const full = E.ensure(JSON.parse(JSON.stringify(seeded.d)));
  const acc = E.ensure((await read('acc')).data.db);
  assert.equal(E.cashBalance(acc), E.cashBalance(full));
  assert.equal(E.arBalance(acc, seeded.s.cust.id), E.arBalance(full, seeded.s.cust.id));
  assert.deepEqual(E.balances(acc), E.balances(full));
  assert.deepEqual(Reports.pnl(acc, {}), Reports.pnl(full, {}));
  assert.deepEqual(Reports.finance(acc, {}), Reports.finance(full, {}));
  assert.equal((await read('acc')).data.db.__integrity.count, E.verify(full, {}).length);

  const wh = E.ensure((await read('wh')).data.db);
  assert.equal(E.balances(wh)['1310'], E.balances(full)['1310']);
  assert.equal(E.balances(wh)['1320'], E.balances(full)['1320']);
  assert.deepEqual(E.lowStock(wh), E.lowStock(full));
  assert.equal(E.stockOf(wh, ORJ(), 'wh_fg'), E.stockOf(full, ORJ(), 'wh_fg'));
  assert.deepEqual(Reports.stockRows(wh, {}), Reports.stockRows(full, {}));
  assert.deepEqual(Reports.movements(wh, {}), Reports.movements(full, {}));

  const sal = E.ensure((await read('sal')).data.db);
  assert.equal(E.arBalance(sal, seeded.s.cust.id), E.arBalance(full, seeded.s.cust.id));
  assert.equal(E.stockOf(sal, ORJ(), 'wh_fg'), E.stockOf(full, ORJ(), 'wh_fg'));
  for (const sale of full.sales) assert.equal(E.saleOutstanding(sal.sales.find(x => x.id === sale.id)), E.saleOutstanding(sale));
});

test('عدد مشاكل السلامة للمحاسب يُحسب على البيانات الكاملة ويكشف أي فساد حقيقي', async () => {
  assert.equal((await read('acc')).data.db.__integrity.count, 0);
  const data = db.get('companyData/c1');
  data.items[0].qty = 9999; // رصيد لا يطابق الحركات
  db.set('companyData/c1', data);
  const count = (await read('acc')).data.db.__integrity.count;
  assert.ok(count > 0, 'الفساد مكتشَف رغم أن المحاسب لا يرى المخزون');
  assert.ok(!JSON.stringify((await read('acc')).data).includes('9999'));
});

test('HR: ينفّذ عمليات الموارد البشرية فقط، وتصله بياناته فقط حتى في رد العملية', async () => {
  const ok = await run('hr', 'upsertEmployee', { name: 'منى', salary: 2500, hireDate: '2026-02-01' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.data.role, 'HR');
  assert.equal(ok.data.db.employees.length, 2);
  assert.deepEqual(ok.data.db.journal, [], 'رد العملية مُصفّى أيضًا');
  assert.equal(db.get('companyData/c1').employees.length, 2);

  const before = JSON.stringify(db.get('companyData/c1'));
  for (const [name, input] of [['recordExpense', { category: 'إيجار', method: 'نقدي', amount: 5 }], ['createInvoice', {}], ['receiptVoucher', {}], ['postPayroll', { id: seeded.payrollId, method: 'نقدي' }], ['cashEntry', { kind: 'capital_in', amount: 1 }]]) {
    const r = await run('hr', name, input);
    assert.equal(r.statusCode, 403, name);
    assert.equal(r.data.error, 'forbidden');
  }
  assert.equal(JSON.stringify(db.get('companyData/c1')), before);
});

test('المحاسب: يرحّل الرواتب المعتمدة بقيد صحيح دون رؤية سطور الموظفين، ولا يمس الموارد البشرية ولا المخزون', async () => {
  const cashBefore = E.cashBalance(db.get('companyData/c1'));
  const r = await run('acc', 'postPayroll', { id: seeded.payrollId, method: 'نقدي' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.data.db.payroll[0].status, 'posted');
  assert.equal(r.data.db.payroll[0].lines, undefined);
  assert.equal(E.cashBalance(db.get('companyData/c1')), cashBefore - 4000);
  assert.deepEqual(E.verify(db.get('companyData/c1'), {}), []);

  assert.equal((await run('acc', 'recordExpense', { category: 'إيجار', method: 'نقدي', amount: 10 })).statusCode, 200);
  for (const name of ['upsertEmployee', 'preparePayroll', 'receiptVoucher', 'createInvoice', 'upsertItem', 'cancelInvoice'])
    assert.equal((await run('acc', name, {})).statusCode, 403, name);
});

test('أمين المخازن: سندات المخزون فقط، وحذف الأصناف واستلام الموردين وفواتير البيع ممنوعة', async () => {
  const r = await run('wh', 'receiptVoucher', { whId: 'wh_fg', reason: 'opening', lines: [{ itemId: ORJ(), qty: 5, unitCost: 3 }] });
  assert.equal(r.statusCode, 200);
  assert.equal(E.stockOf(db.get('companyData/c1'), ORJ(), 'wh_fg'), 95);
  assert.deepEqual(r.data.db.sales, []);

  for (const name of ['deleteItem', 'receiveGoods', 'createInvoice', 'recordExpense', 'upsertEmployee', 'createProduction'])
    assert.equal((await run('wh', name, {})).statusCode, 403, name);
});

test('المبيعات: فواتير وعملاء وتحصيل فقط، والإلغاء والحذف وكل ما سواه ممنوع، والرصيد يُفرض من المحرك', async () => {
  const input = { whId: 'wh_fg', customerId: seeded.s.cust.id, lines: [{ itemId: ORJ(), qty: 5, unitPrice: 6 }], paid: 30, method: 'نقدي' };
  const r = await run('sal', 'createInvoice', input);
  assert.equal(r.statusCode, 200);
  assert.equal(r.data.db.sales.length, 2);
  assert.ok(r.data.db.journal.every(j => j.lines.every(l => l.acct === '1200')), 'رد المبيعات بلا قيود غير الذمم');
  assert.equal(E.stockOf(db.get('companyData/c1'), ORJ(), 'wh_fg'), 85);

  const tooMuch = await run('sal', 'createInvoice', { ...input, lines: [{ itemId: ORJ(), qty: 9999, unitPrice: 6 }], paid: 59994 });
  assert.equal(tooMuch.statusCode, 422);
  assert.equal(tooMuch.data.error, 'insufficient_stock');

  for (const name of ['cancelInvoice', 'deleteCustomer', 'receiptVoucher', 'recordExpense', 'upsertEmployee', 'updateSettings'])
    assert.equal((await run('sal', name, {})).statusCode, 403, name);
});

test('المدير: كل العمليات بما فيها الموارد البشرية والمحاسبة والمخزون، ويستلم البيانات كاملة', async () => {
  assert.equal((await run('mgr', 'upsertEmployee', { name: 'س', salary: 1, hireDate: '2026-03-01' })).statusCode, 200);
  assert.equal((await run('mgr', 'recordExpense', { category: 'إيجار', method: 'نقدي', amount: 5 })).statusCode, 200);
  const r = await run('mgr', 'receiptVoucher', { whId: 'wh_fg', reason: 'opening', lines: [{ itemId: ORJ(), qty: 1, unitCost: 3 }] });
  assert.equal(r.statusCode, 200);
  assert.ok(r.data.db.employees.length >= 2 && r.data.db.journal.length > 0 && r.data.db.audit.length > 0);
});

test('دور غير معروف أو عضو موقوف أو من شركة أخرى: ممنوع من القراءة والعمليات', async () => {
  assert.equal((await read('jan')).statusCode, 403);
  assert.equal((await run('jan', 'createInvoice', {})).statusCode, 403);

  db.set('companyMembers/c1/sal-1/status', 'suspended');
  assert.equal((await read('sal')).statusCode, 403);
  assert.equal((await run('sal', 'createInvoice', {})).statusCode, 403);

  assert.equal((await read('out')).statusCode, 403, 'مدير شركة أخرى لا يقرأ بيانات هذه الشركة');
  assert.equal((await call('out', { action: 'read', companyId: 'c2' })).statusCode, 200);
});

test('القراءة: لا تُنشئ بيانات، وترفض نطاق المستخدم، والبيانات الناقصة/القديمة برسائل واضحة', async () => {
  const res = createRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer mgr' }, body: { scope: 'user', action: 'read' } }, res);
  assert.equal(res.statusCode, 400);

  db.set('companyData/c1', null);
  let r = await read('mgr');
  assert.equal(r.statusCode, 422);
  assert.equal(r.data.error, 'no_data');
  assert.equal(db.get('companyData/c1'), null);

  db.set('companyData/c1', { schemaVersion: 1 });
  r = await read('mgr');
  assert.equal(r.data.error, 'needs_migration');
});

test('المبيعات لا تستلم أي حقل تكلفة: لا سعر شراء ولا قيمة مخزون ولا تكلفة بضاعة مباعة، وصفحاتها وأرقامها سليمة', async () => {
  const sal = (await read('sal')).data.db;
  const raw = JSON.stringify(sal);
  for (const key of ['cogs', 'cost', 'returnedCost', 'stockValue', 'avgCost', 'unitCost']) assert.ok(!raw.includes(`"${key}"`), `لا يجب أن يصل ${key} للمبيعات`);

  const full = db.get('companyData/c1');
  const fullItem = full.items.find(i => i.id === ORJ());
  const item = sal.items.find(i => i.id === ORJ());
  assert.equal(item.price, Number(fullItem.salePrice) || 0, 'سعر الشراء استُبدل بسعر البيع');
  assert.equal(item.salePrice, fullItem.salePrice);
  assert.equal(item.qty, fullItem.qty);
  for (const hidden of ['stockValue', 'lead', 'daily', 'inbound', 'delay', 'supplierId']) assert.equal(item[hidden], undefined, hidden);

  // الأرقام التي يحتاجها قسمها لم تتأثر
  assert.equal(sal.sales[0].total, full.sales[0].total);
  assert.equal(sal.sales[0].paid, full.sales[0].paid);

  // بينما أمين المخازن والمحاسب والمدير يرون التكلفة في مجالهم (المخزون)
  const wh = (await read('wh')).data.db;
  assert.ok(wh.items.find(i => i.id === ORJ()).stockValue !== undefined, 'أمين المخازن يرى قيمة المخزون');
});
