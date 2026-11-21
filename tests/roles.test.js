// تعريف الأدوار: اتساقه مع المحرك، وعدم وجود عملية بلا تصنيف، وإسقاط البيانات لكل دور.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Roles = require('../js/roles.js');
const E = require('../js/erp-hr.js');

const PAGES = ['home', 'sales', 'purchasing', 'inventory', 'production', 'accounting', 'reports', 'risk', 'sim', 'settings', 'hr', 'team'];

test('أدوار الموظفين الأربعة + المدير، وكل دور بتسمية عربية', () => {
  assert.deepEqual(Roles.ALL_ROLES, ['MANAGER', 'HR', 'ACCOUNTANT', 'WAREHOUSE', 'SALES']);
  assert.deepEqual(Roles.STAFF_ROLES, ['HR', 'ACCOUNTANT', 'WAREHOUSE', 'SALES']);
  assert.equal(Roles.roleLabel('HR'), 'الموارد البشرية');
  assert.equal(Roles.roleLabel('nope'), 'غير معروف');
  assert.ok(!Roles.isRole('__proto__') && !Roles.isRole('constructor') && !Roles.isRole(undefined));
});

test('كل عملية يمنحها دور موجودة فعلًا في المحرك (لا أخطاء إملائية)', () => {
  for (const [role, spec] of Object.entries(Roles.ROLES)) {
    if (spec.ops === '*') continue;
    for (const op of spec.ops) assert.ok(Object.prototype.hasOwnProperty.call(E.OPS, op), `${role}: ${op}`);
  }
});

test('المدير يملك كل عمليات المحرك؛ والموظف لا يملك إلا عمليات قسمه المسماة', () => {
  for (const op of Object.keys(E.OPS)) assert.ok(Roles.canRunOp('MANAGER', op), op);

  const expected = {
    HR: ['upsertEmployee', 'recordAttendance', 'preparePayroll', 'approvePayroll'],
    ACCOUNTANT: ['recordExpense', 'cashEntry', 'paySupplier', 'postPayroll'],
    WAREHOUSE: ['receiptVoucher', 'issueVoucher', 'transferVoucher', 'adjustmentVoucher'],
    SALES: ['createInvoice', 'collectPayment', 'createReturn', 'upsertCustomer']
  };
  for (const [role, ops] of Object.entries(expected)) for (const op of ops) assert.ok(Roles.canRunOp(role, op), `${role} ${op}`);

  // عمليات حساسة محجوزة للمدير: لا يملكها أي موظف
  const managerOnly = ['cancelInvoice', 'deleteCustomer', 'deleteItem', 'deleteWarehouse', 'receiveGoods', 'createPO', 'createProduction', 'completeProduction', 'updateSettings', 'recordAiDecision', 'upsertBom', 'upsertSupplier', 'setItemDelay'];
  for (const op of managerOnly) for (const role of Roles.STAFF_ROLES) assert.ok(!Roles.canRunOp(role, op), `${role} يجب ألا ينفّذ ${op}`);

  // الأقسام لا تتقاطع في عمليات الكتابة الخاصة بها إلا collectPayment (تحصيل: مبيعات ومحاسبة)
  const owners = {};
  for (const role of Roles.STAFF_ROLES) for (const op of Roles.ROLES[role].ops) (owners[op] = owners[op] || []).push(role);
  const shared = Object.entries(owners).filter(([, r]) => r.length > 1).map(([op]) => op);
  assert.deepEqual(shared, ['collectPayment']);
});

test('صلاحيات غير صالحة مرفوضة: دور مجهول، عملية ليست نصًا، أسماء الكائنات', () => {
  for (const role of [undefined, null, '', 'JANITOR', '__proto__', 'constructor']) assert.equal(Roles.canRunOp(role, 'createInvoice'), false);
  assert.equal(Roles.canRunOp('HR', 123), false);
  assert.equal(Roles.canRunOp('HR', 'constructor'), false);
  assert.equal(Roles.canRunOp('SALES', 'toString'), false);
});

test('الأقسام: المدير يرى كل شيء، والموظف قسمه فقط، ومجهول لا يرى شيئًا', () => {
  assert.deepEqual(Roles.pagesFor('MANAGER', PAGES), PAGES);
  assert.deepEqual(Roles.pagesFor('HR', PAGES), ['hr']);
  assert.deepEqual(Roles.pagesFor('ACCOUNTANT', PAGES), ['accounting']);
  assert.deepEqual(Roles.pagesFor('WAREHOUSE', PAGES), ['inventory']);
  assert.deepEqual(Roles.pagesFor('SALES', PAGES), ['sales']);
  assert.deepEqual(Roles.pagesFor('JANITOR', PAGES), []);
  assert.equal(Roles.landingPage('SALES', PAGES), 'sales');
  assert.equal(Roles.landingPage('MANAGER', PAGES), 'home');
  // قسم الفريق للمدير فقط
  for (const r of Roles.STAFF_ROLES) assert.ok(!Roles.pagesFor(r, PAGES).includes('team'));
});

/* ---------- الإسقاط ---------- */
function richDb() {
  let n = 0;
  const c = () => ({ opId: 'r' + (++n), user: 'm@x.com', now: '2026-11-14T10:00:00Z', today: '2026-11-14' });
  let d = E.migrate({ settings: { company: 'شركة' } }, c()).db;
  const go = (op, i) => { const r = E.apply(d, c(), op, i); d = r.db; return r.result; };
  go('upsertEmployee', { name: 'أحمد', salary: 3000, hireDate: '2026-01-01' });
  go('cashEntry', { kind: 'capital_in', amount: 5000 });
  go('recordExpense', { category: 'إيجار', method: 'نقدي', amount: 100 });
  go('preparePayroll', { month: '2026-11' });
  return d;
}

test('إسقاط HR: مجموعاته فقط، بلا حسابات ولا مبيعات ولا تدقيق', () => {
  const db = richDb();
  const v = Roles.project(db, 'HR');
  assert.equal(v.employees.length, 1);
  assert.equal(v.payroll[0].lines.length, 1);
  for (const k of ['journal', 'expenses', 'cashEntries', 'sales', 'customers', 'items', 'ledger', 'audit']) assert.deepEqual(v[k], [], k);
  assert.deepEqual(v.ops, {}); assert.deepEqual(v.counters, {});
  assert.equal(v.settings.company, 'شركة');
  assert.equal(v.schemaVersion, db.schemaVersion);
});

test('إسقاط المحاسب: كشف الرواتب رؤوس فقط بلا أسطر الموظفين، ولا موظفين ولا مخزون', () => {
  const db = richDb();
  const v = Roles.project(db, 'ACCOUNTANT', { integrityCount: 0 });
  assert.ok(v.journal.length > 0 && v.expenses.length === 1);
  assert.equal(v.payroll.length, 1);
  assert.equal(v.payroll[0].lines, undefined, 'لا أسطر موظفين');
  assert.equal(v.payroll[0].total, 3000);
  assert.deepEqual(v.employees, []);
  assert.deepEqual(v.attendance, []);
  assert.deepEqual(v.ledger, []);
  assert.deepEqual(v.stock, {});
  assert.equal(v.__integrity.count, 0);
  assert.ok(!JSON.stringify(v).includes('أحمد'), 'اسم موظف لا يتسرب للمحاسب');
});

test('إسقاط أمين المخازن: قيود حسابات المخزون 13xx فقط ولا تسريب لحسابات أخرى', () => {
  const db = richDb();
  db.journal.push({ id: 'j9', date: '2026-11-01', lines: [{ acct: '1310', dr: 50 }, { acct: '2100', cr: 50 }] });
  const v = Roles.project(db, 'WAREHOUSE');
  assert.equal(v.journal.length, 1);
  assert.deepEqual(v.journal[0].lines, [{ acct: '1310', dr: 50 }]);
  assert.deepEqual(v.expenses, []);
  assert.deepEqual(v.employees, []);
  assert.deepEqual(v.payroll, []);
});

test('إسقاط المبيعات، والمدير يستلم الكائن كما هو، والدور المجهول لا يستلم شيئًا', () => {
  const db = richDb();
  const s = Roles.project(db, 'SALES');
  for (const k of ['expenses', 'employees', 'payroll', 'suppliers', 'orders', 'ledger', 'vouchers']) assert.deepEqual(s[k], [], k);
  assert.ok(s.journal.every(j => j.lines.every(l => l.acct === '1200')));
  assert.ok(!s.journal.some(j => j.lines.some(l => l.acct === '1100')), 'لا أسطر الخزينة');
  assert.strictEqual(Roles.project(db, 'MANAGER'), db);
  assert.equal(Roles.project(db, 'JANITOR'), null);
  // الإسقاط لا يغيّر الأصل
  assert.equal(db.employees.length, 1);
});
