/* نبض ERP — الموارد البشرية: الموظفون، الحضور، الإجازات، الرواتب.
   امتداد للمحرك نفسه (نفس OPS ونفس التدقيق ومنع التكرار ونفس عمل المتصفح والخادم) دون تعديل erp-core ولا العمليات القائمة.
   ترحيل الرواتب للمحاسبة يمر بعملية recordExpense نفسها (قيد واحد، وفحص رصيد الخزينة)، فلا يوجد منطق محاسبي مكرّر. */
(function (root, f) { if (typeof module === 'object') module.exports = f(require('./erp-ops2.js')); else f(root.Engine); })(this, function (E) {
  'use strict';
  const { err, r2, moneyOf, text, needDate, nowOf, toList, nextNo, audit, OPS, PAY_METHODS } = E;

  const EMP_STATUS = ['active', 'terminated'];
  const ATT_STATUS = ['present', 'absent', 'late', 'leave'];
  const LEAVE_TYPES = ['annual', 'sick', 'unpaid', 'other'];
  const DAY = 86400000;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /* مجموعات الموارد البشرية تُنشأ عند الحاجة (حسابات قديمة بلا هذه المجموعات تبقى سليمة بلا ترحيل). */
  const HR_LISTS = ['employees', 'attendance', 'leaves', 'payroll'];
  const hr = d => { for (const k of HR_LISTS) d[k] = toList(d[k]); return d; };

  const baseEnsure = E.ensure;
  E.ensure = d => hr(baseEnsure(d));

  const dayNum = s => Date.parse(s + 'T00:00:00Z') / DAY;
  const validMonth = m => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
  const monthRange = m => {
    const [y, mo] = m.split('-').map(Number);
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return [`${m}-01`, `${m}-${String(last).padStart(2, '0')}`];
  };
  const needEmployee = (d, id, { active = false } = {}) => {
    const e = d.employees.find(x => x.id === id);
    if (!e) throw err('الموظف غير موجود.', 'not_found');
    if (active && e.status !== 'active') throw err('الموظف منتهي الخدمة.', 'employee_inactive');
    return e;
  };

  /* ---------- الموظفون ---------- */
  OPS.upsertEmployee = (d, ctx, inp) => {
    hr(d);
    const name = text(inp.name, 100);
    if (!name) throw err('اسم الموظف مطلوب.');
    const email = text(inp.email, 120).toLowerCase();
    if (email && !EMAIL_RE.test(email)) throw err('البريد الإلكتروني غير صالح.');
    const salary = moneyOf(inp.salary, 'الراتب الأساسي', { zero: true });
    if (salary < 0) throw err('الراتب الأساسي لا يمكن أن يكون سالبًا.');
    const hireDate = needDate(inp.hireDate, ctx);

    const fields = {
      name,
      jobTitle: text(inp.jobTitle, 100),
      department: text(inp.department, 100),
      phone: text(inp.phone, 30),
      email,
      hireDate,
      salary,
      note: text(inp.note, 300)
    };

    if (inp.id) {
      const e = needEmployee(d, inp.id);
      Object.assign(e, fields, { updatedAt: nowOf(ctx) });
      audit(d, ctx, 'update', 'employee', e.id, `${e.code} ${e.name}`);
      return { ...e };
    }

    const n = nextNo(d, 'EMP');
    const e = { id: n.id, code: n.no, ...fields, status: 'active', createdAt: nowOf(ctx), createdBy: ctx.user || 'unknown' };
    d.employees.push(e);
    audit(d, ctx, 'create', 'employee', e.id, `${e.code} ${e.name}`);
    return { ...e };
  };

  OPS.terminateEmployee = (d, ctx, inp) => {
    hr(d);
    const e = needEmployee(d, inp.id);
    if (e.status === 'terminated') throw err('الموظف منتهي الخدمة بالفعل.', 'employee_inactive');
    e.status = 'terminated';
    e.terminationDate = needDate(inp.date, ctx);
    e.terminationReason = text(inp.reason, 300);
    audit(d, ctx, 'terminate', 'employee', e.id, `${e.code} ${e.name}`);
    return { ...e };
  };

  OPS.deleteEmployee = (d, ctx, inp) => {
    hr(d);
    const e = needEmployee(d, inp.id);
    const used = d.attendance.some(a => a.employeeId === e.id) || d.leaves.some(l => l.employeeId === e.id) ||
      d.payroll.some(p => toList(p.lines).some(l => l.employeeId === e.id));
    if (used) throw err('لا يمكن حذف موظف له حضور أو إجازات أو رواتب؛ أنهِ خدمته بدل حذفه.', 'referenced');
    d.employees = d.employees.filter(x => x.id !== e.id);
    audit(d, ctx, 'delete', 'employee', e.id, `${e.code} ${e.name}`);
    return { id: e.id };
  };

  /* ---------- الحضور ---------- */
  OPS.recordAttendance = (d, ctx, inp) => {
    hr(d);
    const date = needDate(inp.date, ctx);
    const today = ctx.today || nowOf(ctx).slice(0, 10);
    if (date > today) throw err('لا يمكن تسجيل حضور لتاريخ مستقبلي.', 'future_date');
    const entries = toList(inp.entries);
    if (!entries.length) throw err('أضف موظفًا واحدًا على الأقل.');
    if (entries.length > 500) throw err('عدد السجلات أكبر من المسموح (500).');

    const seen = new Set();
    const saved = [];

    for (const en of entries) {
      if (!ATT_STATUS.includes(en.status)) throw err('حالة الحضور غير صالحة.', 'bad_status');
      const e = needEmployee(d, en.employeeId, { active: true });
      if (seen.has(e.id)) throw err('موظف مكرر في نفس اليوم.', 'duplicate_entry');
      seen.add(e.id);

      const rec = { id: `att_${date}_${e.id}`, date, employeeId: e.id, status: en.status, note: text(en.note, 200), by: ctx.user || 'unknown' };
      const i = d.attendance.findIndex(a => a.id === rec.id);
      if (i >= 0) d.attendance[i] = rec; else d.attendance.push(rec);
      saved.push(rec.id);
    }

    audit(d, ctx, 'attendance', 'attendance', date, `${saved.length} سجل حضور بتاريخ ${date}`);
    return { date, count: saved.length };
  };

  /* ---------- الإجازات ---------- */
  OPS.requestLeave = (d, ctx, inp) => {
    hr(d);
    const e = needEmployee(d, inp.employeeId, { active: true });
    if (!LEAVE_TYPES.includes(inp.type)) throw err('نوع الإجازة غير صالح.', 'bad_type');
    const from = needDate(inp.from, ctx);
    const to = needDate(inp.to, ctx);
    if (to < from) throw err('تاريخ نهاية الإجازة قبل بدايتها.', 'bad_range');
    const days = dayNum(to) - dayNum(from) + 1;
    if (days > 365) throw err('مدة الإجازة أطول من المسموح (365 يومًا).', 'bad_range');

    const clash = d.leaves.find(l => l.employeeId === e.id && l.status !== 'rejected' && l.from <= to && l.to >= from);
    if (clash) throw err(`تتداخل الفترة مع إجازة أخرى (${clash.no}).`, 'leave_overlap');

    const n = nextNo(d, 'LV');
    const l = { id: n.id, no: n.no, employeeId: e.id, type: inp.type, from, to, days, status: 'pending', note: text(inp.note, 300), createdAt: nowOf(ctx), createdBy: ctx.user || 'unknown' };
    d.leaves.push(l);
    audit(d, ctx, 'create', 'leave', l.id, `${l.no} ${e.name} ${days} يوم`);
    return { ...l };
  };

  OPS.decideLeave = (d, ctx, inp) => {
    hr(d);
    const l = d.leaves.find(x => x.id === inp.id);
    if (!l) throw err('طلب الإجازة غير موجود.', 'not_found');
    if (l.status !== 'pending') throw err('تم البت في هذا الطلب مسبقًا.', 'already_decided');
    if (!['approved', 'rejected'].includes(inp.decision)) throw err('القرار غير صالح.', 'bad_decision');
    l.status = inp.decision;
    l.decidedAt = nowOf(ctx);
    l.decidedBy = ctx.user || 'unknown';
    l.decisionNote = text(inp.note, 300);
    audit(d, ctx, inp.decision === 'approved' ? 'approve' : 'reject', 'leave', l.id, l.no);
    return { ...l };
  };

  /* ---------- الرواتب ---------- */
  function unpaidLeaveDays(d, employeeId, start, end) {
    let days = 0;
    for (const l of d.leaves) {
      if (l.employeeId !== employeeId || l.status !== 'approved' || l.type !== 'unpaid') continue;
      const a = Math.max(dayNum(l.from), dayNum(start));
      const b = Math.min(dayNum(l.to), dayNum(end));
      if (b >= a) days += b - a + 1;
    }
    return days;
  }

  OPS.preparePayroll = (d, ctx, inp) => {
    hr(d);
    if (!validMonth(inp.month)) throw err('الشهر غير صالح (الصيغة YYYY-MM).', 'bad_month');
    const [start, end] = monthRange(inp.month);

    const existing = d.payroll.find(p => p.month === inp.month);
    if (existing && existing.status !== 'draft') throw err('رواتب هذا الشهر معتمدة أو مرحَّلة بالفعل.', 'payroll_locked');

    const adj = new Map();
    for (const a of toList(inp.adjustments)) {
      const e = needEmployee(d, a.employeeId);
      const bonus = moneyOf(a.bonus || 0, 'المكافأة', { zero: true });
      const deduction = moneyOf(a.deduction || 0, 'الخصم', { zero: true });
      if (bonus < 0 || deduction < 0) throw err('المكافأة والخصم لا يكونان سالبين.');
      adj.set(e.id, { bonus, deduction, note: text(a.note, 200) });
    }

    const lines = [];
    for (const e of d.employees) {
      if (e.status !== 'active' && !(e.terminationDate && e.terminationDate >= start)) continue;
      if (e.hireDate > end) continue;

      const absent = d.attendance.filter(a => a.employeeId === e.id && a.status === 'absent' && a.date >= start && a.date <= end).length;
      const unpaid = unpaidLeaveDays(d, e.id, start, end);
      const daily = e.salary / 30;
      const autoDeduction = Math.min(e.salary, r2((absent + unpaid) * daily));
      const manual = adj.get(e.id) || { bonus: 0, deduction: 0, note: '' };
      const net = r2(e.salary - autoDeduction - manual.deduction + manual.bonus);
      if (net < 0) throw err(`صافي راتب ${e.name} سالب بعد الخصومات.`, 'negative_net');

      lines.push({ employeeId: e.id, name: e.name, code: e.code, base: e.salary, absentDays: absent, unpaidLeaveDays: unpaid, autoDeduction, deduction: manual.deduction, bonus: manual.bonus, note: manual.note, net });
    }

    if (!lines.length) throw err('لا يوجد موظفون مستحقون لراتب هذا الشهر.', 'no_employees');
    const total = r2(lines.reduce((s, l) => s + l.net, 0));

    if (existing) {
      Object.assign(existing, { lines, total, employeesCount: lines.length, updatedAt: nowOf(ctx) });
      audit(d, ctx, 'update', 'payroll', existing.id, `${existing.no} ${inp.month}`);
      return { ...existing };
    }

    const n = nextNo(d, 'PAY');
    const p = { id: n.id, no: n.no, month: inp.month, status: 'draft', lines, total, employeesCount: lines.length, createdAt: nowOf(ctx), createdBy: ctx.user || 'unknown' };
    d.payroll.push(p);
    audit(d, ctx, 'create', 'payroll', p.id, `${p.no} ${p.month} إجمالي ${total}`);
    return { ...p };
  };

  OPS.approvePayroll = (d, ctx, inp) => {
    hr(d);
    const p = d.payroll.find(x => x.id === inp.id);
    if (!p) throw err('كشف الرواتب غير موجود.', 'not_found');
    if (p.status !== 'draft') throw err('الكشف معتمد أو مرحَّل بالفعل.', 'payroll_locked');
    p.status = 'approved';
    p.approvedAt = nowOf(ctx);
    p.approvedBy = ctx.user || 'unknown';
    audit(d, ctx, 'approve', 'payroll', p.id, p.no);
    return { ...p };
  };

  /* يرحّل الكشف المعتمد إلى المحاسبة كمصروف «رواتب وأجور» عبر recordExpense نفسها (قيد واحد وفحص الخزينة). */
  OPS.postPayroll = (d, ctx, inp) => {
    hr(d);
    const p = d.payroll.find(x => x.id === inp.id);
    if (!p) throw err('كشف الرواتب غير موجود.', 'not_found');
    if (p.status !== 'approved') throw err('يجب اعتماد الكشف قبل ترحيله للمحاسبة.', 'payroll_not_approved');
    if (!(p.total > 0)) throw err('إجمالي الكشف صفر.', 'bad_amount');
    if (!PAY_METHODS.includes(inp.method)) throw err('اختر طريقة الدفع.');

    const exp = OPS.recordExpense(d, ctx, { category: 'رواتب وأجور', method: inp.method, amount: p.total, date: inp.date, note: `رواتب شهر ${p.month} (${p.no})` });
    p.status = 'posted';
    p.postedAt = nowOf(ctx);
    p.postedBy = ctx.user || 'unknown';
    p.expenseId = exp.id;
    audit(d, ctx, 'post', 'payroll', p.id, `${p.no} → ${exp.no}`);
    return { ...p, expenseNo: exp.no };
  };

  Object.assign(E, { HR_LISTS, EMP_STATUS, ATT_STATUS, LEAVE_TYPES });
  return E;
});
