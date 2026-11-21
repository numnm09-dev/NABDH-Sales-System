// محرك الموارد البشرية: الموظفون، الحضور، الإجازات، الرواتب وترحيلها للمحاسبة.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../js/erp-hr.js');

let n = 0;
const ctx = (extra = {}) => ({ opId: 'hr-' + (++n), user: 'hr@x.com', now: '2026-11-14T10:00:00Z', today: '2026-11-14', ...extra });
function world() {
  let d = E.migrate({}, ctx()).db;
  const go = (op, input, c) => { const r = E.apply(d, ctx(c), op, input); d = r.db; return r.result; };
  const fails = (op, input, code) => assert.throws(() => E.apply(d, ctx(), op, input), e => e.erp === true && (!code || e.code === code));
  return { go, fails, db: () => d };
}
const emp = (over = {}) => ({ name: 'أحمد', salary: 3000, hireDate: '2026-01-01', jobTitle: 'محاسب', ...over });

test('الموظفون: إنشاء بكود تلقائي، تعديل، تحقق من المدخلات', () => {
  const w = world();
  const e = w.go('upsertEmployee', emp({ email: 'A@X.com' }));
  assert.equal(e.code, 'EMP-00001');
  assert.equal(e.email, 'a@x.com');
  assert.equal(e.status, 'active');

  const u = w.go('upsertEmployee', emp({ id: e.id, name: 'أحمد علي', salary: 3500 }));
  assert.equal(u.code, 'EMP-00001');
  assert.equal(w.db().employees.length, 1);
  assert.equal(w.db().employees[0].salary, 3500);

  w.fails('upsertEmployee', emp({ name: '  ' }));
  w.fails('upsertEmployee', emp({ salary: -5 }));
  w.fails('upsertEmployee', emp({ email: 'bad' }));
  w.fails('upsertEmployee', emp({ hireDate: '2026-13-40' }), 'bad_date');
  w.fails('upsertEmployee', emp({ id: 'ghost' }), 'not_found');
});

test('إنهاء الخدمة والحذف: الحذف ممنوع لمن له سجلات', () => {
  const w = world();
  const a = w.go('upsertEmployee', emp());
  const b = w.go('upsertEmployee', emp({ name: 'منى' }));
  w.go('recordAttendance', { date: '2026-11-10', entries: [{ employeeId: a.id, status: 'present' }] });

  w.fails('deleteEmployee', { id: a.id }, 'referenced');
  w.go('deleteEmployee', { id: b.id });
  assert.equal(w.db().employees.length, 1);

  const t = w.go('terminateEmployee', { id: a.id, date: '2026-11-12', reason: 'استقالة' });
  assert.equal(t.status, 'terminated');
  w.fails('terminateEmployee', { id: a.id }, 'employee_inactive');
  w.fails('recordAttendance', { date: '2026-11-13', entries: [{ employeeId: a.id, status: 'present' }] }, 'employee_inactive');
});

test('الحضور: تسجيل جماعي، استبدال سجل اليوم نفسه، ورفض المستقبل والحالات الخاطئة والتكرار', () => {
  const w = world();
  const a = w.go('upsertEmployee', emp());
  const b = w.go('upsertEmployee', emp({ name: 'منى' }));

  const r = w.go('recordAttendance', { date: '2026-11-10', entries: [{ employeeId: a.id, status: 'present' }, { employeeId: b.id, status: 'late' }] });
  assert.equal(r.count, 2);
  w.go('recordAttendance', { date: '2026-11-10', entries: [{ employeeId: a.id, status: 'absent', note: 'غياب' }] });
  assert.equal(w.db().attendance.length, 2, 'استُبدل سجل نفس اليوم ولم يتكرر');
  assert.equal(w.db().attendance.find(x => x.employeeId === a.id).status, 'absent');

  w.fails('recordAttendance', { date: '2026-11-20', entries: [{ employeeId: a.id, status: 'present' }] }, 'future_date');
  w.fails('recordAttendance', { date: '2026-11-10', entries: [{ employeeId: a.id, status: 'weird' }] }, 'bad_status');
  w.fails('recordAttendance', { date: '2026-11-10', entries: [{ employeeId: a.id, status: 'present' }, { employeeId: a.id, status: 'absent' }] }, 'duplicate_entry');
  w.fails('recordAttendance', { date: '2026-11-10', entries: [] });
});

test('الإجازات: طلب وقرار، حساب الأيام، ومنع التداخل وتكرار القرار', () => {
  const w = world();
  const a = w.go('upsertEmployee', emp());

  const l = w.go('requestLeave', { employeeId: a.id, type: 'annual', from: '2026-11-10', to: '2026-11-12' });
  assert.equal(l.days, 3);
  assert.equal(l.status, 'pending');

  w.fails('requestLeave', { employeeId: a.id, type: 'sick', from: '2026-11-12', to: '2026-11-14' }, 'leave_overlap');
  w.fails('requestLeave', { employeeId: a.id, type: 'annual', from: '2026-11-20', to: '2026-11-19' }, 'bad_range');
  w.fails('requestLeave', { employeeId: a.id, type: 'vacation', from: '2026-12-01', to: '2026-12-02' }, 'bad_type');

  const d = w.go('decideLeave', { id: l.id, decision: 'rejected' });
  assert.equal(d.status, 'rejected');
  w.fails('decideLeave', { id: l.id, decision: 'approved' }, 'already_decided');
  // المرفوضة لا تحجز الفترة
  assert.equal(w.go('requestLeave', { employeeId: a.id, type: 'annual', from: '2026-11-10', to: '2026-11-12' }).status, 'pending');
});

test('كشف الرواتب: يحسب الغياب والإجازة غير المدفوعة والمكافآت والخصومات بدقة', () => {
  const w = world();
  const a = w.go('upsertEmployee', emp({ salary: 3000 }));
  const b = w.go('upsertEmployee', emp({ name: 'منى', salary: 6000 }));
  w.go('recordAttendance', { date: '2026-11-03', entries: [{ employeeId: a.id, status: 'absent' }] });
  const lv = w.go('requestLeave', { employeeId: b.id, type: 'unpaid', from: '2026-11-10', to: '2026-11-11' });
  w.go('decideLeave', { id: lv.id, decision: 'approved' });
  // إجازة سنوية معتمدة لا تُخصم
  const lv2 = w.go('requestLeave', { employeeId: a.id, type: 'annual', from: '2026-11-20', to: '2026-11-22' });
  w.go('decideLeave', { id: lv2.id, decision: 'approved' });

  const p = w.go('preparePayroll', { month: '2026-11', adjustments: [{ employeeId: a.id, bonus: 100 }, { employeeId: b.id, deduction: 50 }] });
  const la = p.lines.find(l => l.employeeId === a.id);
  const lb = p.lines.find(l => l.employeeId === b.id);

  assert.deepEqual([la.absentDays, la.autoDeduction, la.bonus, la.net], [1, 100, 100, 3000]);
  assert.deepEqual([lb.unpaidLeaveDays, lb.autoDeduction, lb.deduction, lb.net], [2, 400, 50, 5550]);
  assert.equal(p.total, 8550);
  assert.equal(p.status, 'draft');
  assert.equal(p.no, 'PAY-00001');
});

test('الإجازة غير المدفوعة العابرة للشهور تُقصّ على الشهر المطلوب فقط', () => {
  const w = world();
  const a = w.go('upsertEmployee', emp({ salary: 3000 }));
  const lv = w.go('requestLeave', { employeeId: a.id, type: 'unpaid', from: '2026-10-30', to: '2026-11-02' });
  w.go('decideLeave', { id: lv.id, decision: 'approved' });

  assert.equal(w.go('preparePayroll', { month: '2026-11' }).lines[0].unpaidLeaveDays, 2);
  assert.equal(w.go('preparePayroll', { month: '2026-10' }).lines[0].unpaidLeaveDays, 2);
});

test('الخصم لا يتجاوز الراتب، وصافي سالب مرفوض، وموظف عُيّن بعد الشهر لا يُحتسب', () => {
  const w = world();
  const a = w.go('upsertEmployee', emp({ salary: 300 }));
  w.go('upsertEmployee', emp({ name: 'جديد', hireDate: '2026-12-01' }));
  for (const day of ['01', '02', '03', '04', '05']) {
    w.go('recordAttendance', { date: `2026-11-${day}`, entries: [{ employeeId: a.id, status: 'absent' }] });
  }

  const p = w.go('preparePayroll', { month: '2026-11' });
  assert.equal(p.lines.length, 1, 'الموظف المعيَّن لاحقًا خارج الكشف');
  assert.equal(p.lines[0].autoDeduction, 50);

  w.fails('preparePayroll', { month: '2026-11', adjustments: [{ employeeId: a.id, deduction: 1000 }] }, 'negative_net');
  w.fails('preparePayroll', { month: '2026-13' }, 'bad_month');
  w.fails('preparePayroll', { month: '2026-11', adjustments: [{ employeeId: a.id, bonus: -1 }] });
  w.fails('preparePayroll', { month: '2020-01' }, 'no_employees');
});

test('دورة الكشف: مسودة قابلة لإعادة الإعداد ← اعتماد ← ترحيل للمحاسبة مرة واحدة بقيد صحيح', () => {
  const w = world();
  const a = w.go('upsertEmployee', emp({ salary: 3000 }));
  const p1 = w.go('preparePayroll', { month: '2026-11' });
  const p2 = w.go('preparePayroll', { month: '2026-11', adjustments: [{ employeeId: a.id, bonus: 500 }] });
  assert.equal(p2.id, p1.id, 'المسودة تُحدَّث ولا تتكرر');
  assert.equal(w.db().payroll.length, 1);
  assert.equal(p2.total, 3500);

  w.fails('postPayroll', { id: p1.id, method: 'نقدي' }, 'payroll_not_approved');
  w.go('approvePayroll', { id: p1.id });
  w.fails('approvePayroll', { id: p1.id }, 'payroll_locked');
  w.fails('preparePayroll', { month: '2026-11' }, 'payroll_locked');

  // خزينة فارغة: الترحيل يُرفض بقاعدة المحاسبة نفسها
  w.fails('postPayroll', { id: p1.id, method: 'نقدي' });
  w.go('cashEntry', { kind: 'capital_in', amount: 10000 });
  w.fails('postPayroll', { id: p1.id, method: 'دفع غريب' });

  const posted = w.go('postPayroll', { id: p1.id, method: 'نقدي' });
  assert.equal(posted.status, 'posted');
  assert.equal(E.cashBalance(w.db()), 6500);
  assert.equal(w.db().expenses.length, 1);
  assert.equal(w.db().expenses[0].category, 'رواتب وأجور');
  assert.equal(w.db().expenses[0].amount, 3500);
  assert.deepEqual(E.verify(w.db(), {}), []);

  w.fails('postPayroll', { id: p1.id, method: 'نقدي' }, 'payroll_not_approved');
});

test('منع التكرار بـopId لعمليات الموارد البشرية (لا موظف ولا راتب مزدوج)', () => {
  const w = world();
  const c = ctx({ opId: 'same-op' });
  let d = E.migrate({}, ctx()).db;
  d = E.apply(d, c, 'upsertEmployee', emp()).db;
  assert.throws(() => E.apply(d, c, 'upsertEmployee', emp()), e => e.code === 'duplicate');
  assert.equal(d.employees.length, 1);
  void w;
});

test('حساب قديم بلا مجموعات الموارد البشرية يبقى سليمًا؛ ensure تضيفها فارغة دون ترحيل', () => {
  const old = E.migrate({}, ctx()).db;
  delete old.employees; delete old.attendance; delete old.leaves; delete old.payroll;
  const ensured = E.ensure(JSON.parse(JSON.stringify(old)));
  for (const k of ['employees', 'attendance', 'leaves', 'payroll']) assert.deepEqual(ensured[k], []);
  assert.equal(ensured.schemaVersion, old.schemaVersion);
  assert.deepEqual(E.verify(ensured, {}), []);
});

test('Firebase يحوّل المصفوفات إلى كائنات: عمليات الموارد البشرية تتعامل مع الشكلين', () => {
  let d = E.migrate({}, ctx()).db;
  d = E.apply(d, ctx(), 'upsertEmployee', emp()).db;
  const asObject = JSON.parse(JSON.stringify(d));
  asObject.employees = { 0: asObject.employees[0] };
  const r = E.apply(asObject, ctx(), 'upsertEmployee', emp({ name: 'منى' }));
  assert.equal(r.db.employees.length, 2);
});
