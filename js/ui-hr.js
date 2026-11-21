/* نبض — واجهة الموارد البشرية (الموظفون، الحضور، الإجازات، الرواتب) وفريق العمل (دعوة الموظفين وأدوارهم).
   صلاحيات الأزرار هنا للعرض فقط؛ الفرض الحقيقي على الخادم (api/erp-op.js و api/company-staff.js). */

const HR_TABS = { employees: 'الموظفون', attendance: 'الحضور', leaves: 'الإجازات', payroll: 'الرواتب' };
const ATT_LABEL = { present: 'حاضر', absent: 'غائب', late: 'متأخر', leave: 'إجازة' };
const LEAVE_LABEL = { annual: 'سنوية', sick: 'مرضية', unpaid: 'بدون أجر', other: 'أخرى' };
const LEAVE_STATUS = { pending: ['بانتظار القرار', 'amb'], approved: ['معتمدة', 'ok'], rejected: ['مرفوضة', 'bad'] };
const PAY_STATUS = { draft: ['مسودة', 'amb'], approved: ['معتمد', 'ok'], posted: ['مُرحَّل للمحاسبة', 'ok'] };

// هل يسمح دور المستخدم الحالي بالعملية؟ (الحساب الشخصي: نعم دائمًا)
const canDo = op => scope.type !== 'company' || (typeof Roles !== 'undefined' && Roles.canRunOp(scope.role, op));
const hrList = k => (Array.isArray(DB[k]) ? DB[k] : []);
const empName = id => (hrList('employees').find(e => e.id === id) || {}).name || '—';
const activeEmployees = () => hrList('employees').filter(e => e.status === 'active');

function pageHr(tab) {
  tab = HR_TABS[tab] ? tab : 'employees';
  return `<h2>الموارد البشرية</h2>${TABS('hr', HR_TABS, tab)}` + ({ employees: hrEmployees, attendance: hrAttendance, leaves: hrLeaves, payroll: hrPayroll })[tab]();
}

/* ---------- الموظفون ---------- */
function hrEmployees() {
  const all = hrList('employees');
  const rows = all.filter(e => matches('emp', { c: e.code, n: e.name, j: e.jobTitle, d: e.department }));
  const active = all.filter(e => e.status === 'active');
  const payroll = active.reduce((s, e) => s + (Number(e.salary) || 0), 0);

  return `<div class="grid">${KPI(active.length, 'موظف على رأس العمل')}${KPI(all.length - active.length, 'منتهو الخدمة')}${KPI(money(payroll), 'إجمالي الرواتب الأساسية (ج)')}</div>
  <div class="tools">${SEARCH('emp')}${canDo('upsertEmployee') ? '<button data-act="new-employee">+ موظف جديد</button>' : ''}</div>
  ${TBL(['الكود', 'الموظف', 'الوظيفة', 'القسم', 'الراتب', 'التعيين', 'الحالة', ''], rows.map(e => ROW([
    esc(e.code), esc(e.name), esc(e.jobTitle || '—'), esc(e.department || '—'), money(e.salary), esc(e.hireDate),
    e.status === 'active' ? chip('على رأس العمل', 'ok') : chip('منتهي الخدمة ' + esc(e.terminationDate || ''), 'bad'),
    (canDo('upsertEmployee') ? BTN('edit-employee', e.id, 'تعديل') : '') +
    (e.status === 'active' && canDo('terminateEmployee') ? BTN('end-employee', e.id, 'إنهاء الخدمة') : '') +
    (canDo('deleteEmployee') ? BTN('del-employee', e.id, 'حذف', 'del') : '')
  ])), 'لا يوجد موظفون. أضف أول موظف.')}`;
}

function openEmployee(id) {
  const e = id ? hrList('employees').find(x => x.id === id) : {};
  openDoc({
    title: id ? 'تعديل موظف' : 'موظف جديد',
    fields: [
      { n: 'name', l: 'اسم الموظف', req: true, val: e.name },
      { n: 'jobTitle', l: 'الوظيفة', val: e.jobTitle },
      { n: 'department', l: 'القسم', val: e.department },
      { n: 'phone', l: 'الهاتف', val: e.phone, dir: 'ltr' },
      { n: 'email', l: 'البريد الإلكتروني (اختياري)', t: 'email', val: e.email, dir: 'ltr' },
      { n: 'hireDate', l: 'تاريخ التعيين', t: 'date', req: true, val: e.hireDate || localToday() },
      { n: 'salary', l: 'الراتب الأساسي الشهري (ج)', t: 'number', req: true, min: 0, val: e.salary },
      { n: 'note', l: 'ملاحظات', t: 'textarea', val: e.note }
    ],
    build: v => ({ op: 'upsertEmployee', input: { ...v, ...(id ? { id } : {}) } }),
    ok: r => `تم حفظ الموظف ${r.code}`
  });
}

function openTerminate(id) {
  const e = hrList('employees').find(x => x.id === id);
  openDoc({
    title: 'إنهاء خدمة ' + (e ? e.name : ''),
    fields: [
      { n: 'date', l: 'تاريخ إنهاء الخدمة', t: 'date', req: true, val: localToday() },
      { n: 'reason', l: 'السبب', t: 'textarea' }
    ],
    build: v => ({ op: 'terminateEmployee', input: { id, ...v } }),
    ok: () => 'تم إنهاء الخدمة'
  });
}

/* ---------- الحضور ---------- */
function hrAttendance() {
  const date = UI.f.attdate || localToday();
  const emps = activeEmployees();
  const byEmp = Object.fromEntries(hrList('attendance').filter(a => a.date === date).map(a => [a.employeeId, a]));
  const counts = Object.keys(ATT_LABEL).map(k => KPI(Object.values(byEmp).filter(a => a.status === k).length, ATT_LABEL[k]));

  return `<div class="tools"><label>التاريخ <input type="date" data-f="attdate" value="${esc(date)}" max="${esc(localToday())}" aria-label="تاريخ الحضور"></label>
    ${canDo('recordAttendance') && emps.length ? '<button data-act="save-attendance">حفظ حضور اليوم</button>' : ''}</div>
  <div class="grid">${counts.join('')}</div>
  ${TBL(['الموظف', 'الوظيفة', 'الحالة', 'ملاحظة'], emps.map(e => {
    const a = byEmp[e.id] || {};
    return ROW([esc(e.name), esc(e.jobTitle || '—'),
      `<select data-emp-att="${esc(e.id)}" aria-label="حالة ${esc(e.name)}" ${canDo('recordAttendance') ? '' : 'disabled'}>${Object.entries(ATT_LABEL).map(([k, v]) => `<option value="${k}" ${(a.status || 'present') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`,
      `<input data-emp-note="${esc(e.id)}" value="${esc(a.note || '')}" maxlength="200" aria-label="ملاحظة ${esc(e.name)}" ${canDo('recordAttendance') ? '' : 'disabled'}>`]);
  }), 'لا يوجد موظفون على رأس العمل.')}`;
}

async function saveAttendance() {
  const date = UI.f.attdate || localToday();
  const entries = [...document.querySelectorAll('[data-emp-att]')].map(sel => {
    const id = sel.getAttribute('data-emp-att');
    const note = document.querySelector(`[data-emp-note="${id}"]`);
    return { employeeId: id, status: sel.value, note: note ? note.value : '' };
  });
  if (!entries.length) return;
  await quickAct('recordAttendance', { date, entries }, `تم حفظ حضور ${entries.length} موظف`);
}

/* ---------- الإجازات ---------- */
function hrLeaves() {
  const rows = [...hrList('leaves')].reverse();
  return `<div class="tools">${canDo('requestLeave') ? '<button data-act="new-leave">+ طلب إجازة</button>' : ''}</div>
  ${TBL(['الرقم', 'الموظف', 'النوع', 'من', 'إلى', 'الأيام', 'الحالة', ''], rows.map(l => {
    const st = LEAVE_STATUS[l.status] || [l.status, ''];
    return ROW([esc(l.no), esc(empName(l.employeeId)), LEAVE_LABEL[l.type] || esc(l.type), esc(l.from), esc(l.to), l.days, chip(st[0], st[1]),
      l.status === 'pending' && canDo('decideLeave') ? BTN('approve-leave', l.id, 'اعتماد') + BTN('reject-leave', l.id, 'رفض', 'del') : '']);
  }), 'لا توجد طلبات إجازة.')}`;
}

function openLeave() {
  openDoc({
    title: 'طلب إجازة',
    fields: [
      { n: 'employeeId', l: 'الموظف', t: 'select', req: true, opts: activeEmployees().map(e => [e.id, `${e.code} — ${e.name}`]), ph: 'اختر الموظف' },
      { n: 'type', l: 'نوع الإجازة', t: 'select', req: true, opts: Object.entries(LEAVE_LABEL), val: 'annual' },
      { n: 'from', l: 'من', t: 'date', req: true, val: localToday() },
      { n: 'to', l: 'إلى', t: 'date', req: true, val: localToday() },
      { n: 'note', l: 'ملاحظات', t: 'textarea' }
    ],
    build: v => ({ op: 'requestLeave', input: v }),
    ok: r => `تم تسجيل الطلب ${r.no} (${r.days} يوم)`
  });
}

/* ---------- الرواتب ---------- */
function hrPayroll() {
  const rows = [...hrList('payroll')].reverse();
  return `<div class="tools">${canDo('preparePayroll') ? '<button data-act="new-payroll">+ إعداد كشف رواتب شهر</button>' : ''}</div>
  ${TBL(['الرقم', 'الشهر', 'الموظفون', 'الإجمالي', 'الحالة', ''], rows.map(p => {
    const st = PAY_STATUS[p.status] || [p.status, ''];
    return ROW([esc(p.no), esc(p.month), p.employeesCount, money(p.total), chip(st[0], st[1]),
      BTN('view-payroll', p.id, 'عرض') +
      (p.status === 'draft' && canDo('preparePayroll') ? BTN('edit-payroll', p.id, 'إعادة الإعداد') : '') +
      (p.status === 'draft' && canDo('approvePayroll') ? BTN('approve-payroll', p.id, 'اعتماد') : '') +
      (p.status === 'approved' && canDo('postPayroll') ? BTN('post-payroll', p.id, 'ترحيل للمحاسبة') : '')]);
  }), 'لا توجد كشوف رواتب. أعدّ كشف أول شهر.')}
  <p class="hint">الخصم التلقائي = (أيام الغياب + أيام الإجازة بدون أجر) × الراتب ÷ 30. الكشف المعتمد لا يُعدَّل، وترحيله للمحاسبة يتم من المحاسب أو المدير.</p>`;
}

function openPayroll(id) {
  const p = id ? hrList('payroll').find(x => x.id === id) : null;
  openDoc({
    title: p ? 'إعادة إعداد كشف ' + p.month : 'إعداد كشف رواتب',
    fields: [
      { n: 'month', l: 'الشهر', t: 'month', req: true, val: p ? p.month : localToday().slice(0, 7), disabled: !!p },
      { n: 'adj', l: 'مكافآت وخصومات يدوية (اختياري)', t: 'textarea', hint: 'سطر لكل موظف بالصيغة: الكود، المكافأة، الخصم — مثال: EMP-00001,100,0', val: p ? p.lines.filter(l => l.bonus || l.deduction).map(l => `${l.code},${l.bonus},${l.deduction}`).join('\n') : '' }
    ],
    build: v => {
      const adjustments = [];
      for (const line of String(v.adj || '').split('\n').map(x => x.trim()).filter(Boolean)) {
        const [code, bonus, deduction] = line.split(',').map(x => x.trim());
        const e = hrList('employees').find(x => x.code === code);
        if (!e) return { error: `كود موظف غير معروف: ${code}` };
        adjustments.push({ employeeId: e.id, bonus: Number(bonus) || 0, deduction: Number(deduction) || 0 });
      }
      return { op: 'preparePayroll', input: { month: p ? p.month : v.month, adjustments } };
    },
    ok: r => `تم إعداد الكشف ${r.no} — الإجمالي ${money(r.total)}`
  });
}

function viewPayroll(id) {
  const p = hrList('payroll').find(x => x.id === id);
  if (!p) return;
  const lines = Array.isArray(p.lines) ? p.lines : null;
  showDoc(`كشف رواتب ${p.month} (${p.no})`,
    lines
      ? TBL(['الموظف', 'الأساسي', 'غياب', 'إجازة بدون أجر', 'خصم تلقائي', 'خصم يدوي', 'مكافأة', 'الصافي'], lines.map(l => ROW([esc(l.name), money(l.base), l.absentDays, l.unpaidLeaveDays, money(l.autoDeduction), money(l.deduction), money(l.bonus), `<b>${money(l.net)}</b>`])).concat(ROW(['<b>الإجمالي</b>', '', '', '', '', '', '', `<b>${money(p.total)}</b>`])))
      : `<p>عدد الموظفين: ${p.employeesCount} — الإجمالي: <b>${money(p.total)}</b> ج</p><p class="hint">تفاصيل الموظفين متاحة للموارد البشرية والمدير فقط.</p>`);
}

function openPostPayroll(id) {
  const p = hrList('payroll').find(x => x.id === id);
  openDoc({
    title: `ترحيل كشف ${p ? p.month : ''} للمحاسبة`,
    fields: [
      { n: 'method', l: 'طريقة الدفع', t: 'select', req: true, opts: E_.PAY_METHODS.map(x => [x, x]), val: 'نقدي' },
      { n: 'date', l: 'تاريخ الصرف', t: 'date', req: true, val: localToday() }
    ],
    summary: () => p ? `سيُسجَّل مصروف «رواتب وأجور» بقيمة <b>${money(p.total)}</b> ج ويُخصم من الخزينة.` : '',
    build: v => ({ op: 'postPayroll', input: { id, ...v } }),
    ok: r => `تم الترحيل (${r.expenseNo})`
  });
}

// تبويب «الرواتب» داخل المحاسبة: الكشوف المعتمدة بانتظار الترحيل (رؤوس فقط للمحاسب).
function accPayroll() {
  const rows = [...hrList('payroll')].filter(p => p.status !== 'draft').reverse();
  return TBL(['الرقم', 'الشهر', 'الموظفون', 'الإجمالي', 'الحالة', ''], rows.map(p => {
    const st = PAY_STATUS[p.status] || [p.status, ''];
    return ROW([esc(p.no), esc(p.month), p.employeesCount, money(p.total), chip(st[0], st[1]),
      BTN('view-payroll', p.id, 'عرض') + (p.status === 'approved' && canDo('postPayroll') ? BTN('post-payroll', p.id, 'ترحيل للمحاسبة') : '')]);
  }), 'لا توجد كشوف رواتب معتمدة بانتظار الترحيل.');
}

/* ---------- فريق العمل (دعوة الموظفين وأدوارهم) ---------- */
const STAFF_ROLE_OPTIONS = () => (typeof Roles !== 'undefined' ? Roles.STAFF_ROLES : []).map(r => [r, Roles.roleLabel(r)]);
const TEAM_ERRORS = {
  already_member: 'هذا البريد عضو بالفعل في فريق الشركة.',
  invalid_email: 'صيغة البريد الإلكتروني غير صحيحة.',
  invalid_role: 'الدور غير صالح.',
  email_service_not_configured: 'خدمة البريد غير مُعدّة على الخادم. تواصل مع مدير النظام.',
  app_base_url_not_configured: 'رابط التطبيق غير مُعدّ على الخادم. تواصل مع مدير النظام.',
  email_send_failed: 'فشل إرسال الدعوة بالبريد. حاول مرة أخرى.',
  invitation_send_in_progress: 'هناك إرسال جارٍ لهذه الدعوة. انتظر قليلًا.',
  invitation_already_accepted: 'هذه الدعوة قُبلت بالفعل.',
  cannot_modify_self: 'لا يمكنك تعديل حسابك.',
  forbidden: 'ليست لديك صلاحية على هذا الإجراء.',
  unauthorized: 'انتهت جلسة الدخول. سجّل الدخول من جديد.'
};

UI.team = { companyId: '', loaded: false, loading: false, members: [], invitations: [], msg: '' };

async function teamCall(body) {
  const reply = await callServer({ companyId: scope.companyId, ...body }, currentUser, '/api/company-staff');
  const data = reply && reply.data;
  if (!data || !data.ok) {
    const err = new Error(TEAM_ERRORS[data && data.error] || 'تعذّر تنفيذ الإجراء. حاول مرة أخرى.');
    err.code = data && data.error;
    throw err;
  }
  return data;
}

async function loadTeam() {
  UI.team = { companyId: scope.companyId, loaded: false, loading: true, members: [], invitations: [], msg: '' };
  const mine = UI.team;
  try {
    const data = await teamCall({ action: 'list' });
    if (UI.team !== mine) return;
    Object.assign(mine, { members: data.members, invitations: data.invitations, loaded: true, loading: false });
  } catch (e) {
    if (UI.team !== mine) return;
    Object.assign(mine, { loaded: true, loading: false, msg: e.message });
  }
  if (DB) rerender();
}

async function teamAction(body, okMsg) {
  try {
    await teamCall(body);
    UI.team.msg = okMsg;
  } catch (e) {
    UI.team.msg = e.message;
  }
  await loadTeam();
}

function pageTeam() {
  if (scope.type !== 'company') return '<div class="box"><p>هذا القسم متاح داخل حساب شركة فقط.</p></div>';
  if (UI.team.companyId !== scope.companyId) loadTeam();

  const t = UI.team;
  const roleSelect = (id, val) => `<select id="${id}" aria-label="الدور">${STAFF_ROLE_OPTIONS().map(([k, l]) => `<option value="${k}" ${k === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

  const members = t.members.map(m => ROW([
    esc(m.email), m.role === 'MANAGER' ? esc(m.roleLabel) : roleSelect('role_' + m.uid, m.role),
    m.status === 'active' ? chip('نشط', 'ok') : chip('موقوف', 'bad'),
    m.role === 'MANAGER' ? '—' :
      BTN('team-setrole', m.uid, 'حفظ الدور') + (m.status === 'active' ? BTN('team-suspend', m.uid, 'إيقاف', 'del') : BTN('team-activate', m.uid, 'تفعيل'))
  ]));

  const invs = t.invitations.map(i => ROW([
    esc(i.email), esc(i.roleLabel),
    i.status === 'sent' ? chip('أُرسلت', 'ok') : chip({ expired: 'منتهية', revoked: 'ملغاة', send_failed: 'فشل الإرسال', send_pending: 'جارٍ الإرسال', draft: 'مسودة' }[i.status] || i.status, 'amb'),
    BTN('team-resend', i.id, 'إعادة إرسال') + (i.status !== 'revoked' ? BTN('team-revoke', i.id, 'إلغاء', 'del') : '')
  ]));

  return `<h2>فريق العمل</h2>
  <div class="box"><h3>دعوة موظف</h3>
    <div class="tools"><input id="teamEmail" type="email" dir="ltr" placeholder="البريد الإلكتروني للموظف" aria-label="البريد الإلكتروني للموظف">
    ${roleSelect('teamRole', 'SALES')}<button data-act="team-invite">إرسال الدعوة</button></div>
    <p class="hint">يستلم الموظف رابطًا بالبريد، يسجّل بنفس البريد ويؤكده، فيرى قسم دوره فقط: الموارد البشرية، المحاسبة، المخازن، أو المبيعات.</p>
    <p id="teamMsg" role="status">${esc(t.msg || '')}</p></div>
  ${t.loading ? '<p>جارٍ التحميل…</p>' : ''}
  <h3>الأعضاء</h3>${TBL(['البريد', 'الدور', 'الحالة', ''], members, 'لا يوجد أعضاء.')}
  <h3>الدعوات المعلّقة</h3>${TBL(['البريد', 'الدور', 'الحالة', ''], invs, 'لا توجد دعوات معلّقة.')}`;
}

/* ---------- الأوامر ---------- */
Object.assign(UI.actions, {
  'new-employee': () => openEmployee(),
  'edit-employee': id => openEmployee(id),
  'end-employee': id => openTerminate(id),
  'del-employee': id => quickAct('deleteEmployee', { id }, 'تم حذف الموظف', 'حذف هذا الموظف نهائيًا؟'),
  'save-attendance': () => saveAttendance(),
  'new-leave': () => openLeave(),
  'approve-leave': id => quickAct('decideLeave', { id, decision: 'approved' }, 'تم اعتماد الإجازة'),
  'reject-leave': id => quickAct('decideLeave', { id, decision: 'rejected' }, 'تم رفض الإجازة', 'رفض طلب الإجازة؟'),
  'new-payroll': () => openPayroll(),
  'edit-payroll': id => openPayroll(id),
  'view-payroll': id => viewPayroll(id),
  'approve-payroll': id => quickAct('approvePayroll', { id }, 'تم اعتماد الكشف', 'اعتماد الكشف؟ لا يمكن تعديله بعد الاعتماد.'),
  'post-payroll': id => openPostPayroll(id),

  'team-invite': () => {
    const email = (document.getElementById('teamEmail') || {}).value || '';
    const role = (document.getElementById('teamRole') || {}).value || '';
    return teamAction({ action: 'invite', email, role }, 'أُرسلت الدعوة إلى ' + email.trim());
  },
  'team-resend': id => {
    const i = UI.team.invitations.find(x => x.id === id);
    return i ? teamAction({ action: 'invite', email: i.email, role: i.role }, 'أُعيد إرسال الدعوة (الرابط السابق لم يعد صالحًا).') : null;
  },
  'team-revoke': id => teamAction({ action: 'revoke-invitation', invitationId: id }, 'أُلغيت الدعوة.'),
  'team-setrole': uid => teamAction({ action: 'set-role', uid, role: (document.getElementById('role_' + uid) || {}).value }, 'تم تغيير الدور.'),
  'team-suspend': uid => teamAction({ action: 'set-status', uid, status: 'suspended' }, 'تم إيقاف الموظف.'),
  'team-activate': uid => teamAction({ action: 'set-status', uid, status: 'active' }, 'تم تفعيل الموظف.')
});
