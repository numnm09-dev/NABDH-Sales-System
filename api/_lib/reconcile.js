// مصالحة ربط مدير الشركة. الفكرة: فشل إقرار الكتابة لا يثبت أنها لم تُنفَّذ (قد تُحفظ ثم ينقطع الرد)،
// لذلك لا نُرجع شيئًا بالتخمين؛ نقرأ الحالة الفعلية ثم نُكمل للأمام أو نُرجع الحجز فقط حين لا أثر لأي كتابة.
const { normalizeInvitationEmail } = require('./invitations');
const { ensureCompanyData } = require('./erp-runner');

const val = snapshot => (snapshot.exists() ? snapshot.val() : null);

async function readLinkState(database, companyId) {
  const invitationId = `manager_${companyId}`;

  const [invitationSnap, companySnap, dataSnap] = await Promise.all([
    database.ref(`invitations/${invitationId}`).get(),
    database.ref(`companies/${companyId}`).get(),
    database.ref(`companyData/${companyId}`).get()
  ]);

  const invitation = val(invitationSnap);
  const company = val(companySnap);
  const uid =
    (invitation && invitation.acceptedBy) || (company && company.managerUid) || null;

  let member = null;
  let userCompany = null;

  if (uid) {
    const [memberSnap, userCompanySnap] = await Promise.all([
      database.ref(`companyMembers/${companyId}/${uid}`).get(),
      database.ref(`userCompanies/${uid}/${companyId}`).get()
    ]);
    member = val(memberSnap);
    userCompany = val(userCompanySnap);
  }

  return {
    companyId,
    invitationId,
    invitation,
    company,
    uid,
    member,
    userCompany,
    hasData: dataSnap.exists()
  };
}

// يصف التعارضات بين الدعوة والشركة والعضوية. الحالة السليمة: لا شيء مربوط ولا دعوة قيد القبول،
// أو ربط كامل ودعوة مقبولة.
function describeState(state, { partial = false } = {}) {
  const { invitation, company, uid, member, userCompany, hasData } = state;
  const issues = [];

  if (!company) return { issues: ['company_missing'], intent: false };

  const claimed = !!invitation && ['accepting', 'accepted'].includes(invitation.status) && !!invitation.acceptedBy;
  const linked = !!company.managerUid;

  if (claimed && (company.managerUid !== uid || company.managerStatus !== 'linked' || company.status !== 'active')) {
    issues.push('company_not_linked');
  }

  if (linked && (!invitation || invitation.status !== 'accepted')) {
    issues.push('invitation_not_accepted');
  }

  if (claimed || linked) {
    if (!member) issues.push('member_missing');
    // الفحص الجزئي (لوحة الإدارة) لا يقرأ userCompanies ولا بيانات الشركة الضخمة
    if (!partial && !userCompany) issues.push('user_company_missing');
    if (!partial && !hasData) issues.push('company_data_missing');
  }

  return { issues, intent: claimed || linked };
}

// كتابة الربط كاملة في تحديث واحد متعدد المسارات (ذرّي)، بعد التأكد من وجود بيانات الشركة.
async function completeLink(database, { companyId, invitationId, uid, email, name, at }, options = {}) {
  await ensureCompanyData(database, companyId, { name }, options);

  await database.ref().update({
    [`companies/${companyId}/managerUid`]: uid,
    [`companies/${companyId}/managerStatus`]: 'linked',
    [`companies/${companyId}/status`]: 'active',
    [`companies/${companyId}/managerLinkedAt`]: at,
    [`companyMembers/${companyId}/${uid}`]: {
      uid,
      email,
      role: 'MANAGER',
      companyId,
      invitationId,
      status: 'active',
      createdAt: at
    },
    [`userCompanies/${uid}/${companyId}`]: {
      companyId,
      name,
      role: 'MANAGER',
      createdAt: at
    },
    [`invitations/${invitationId}/status`]: 'accepted',
    [`invitations/${invitationId}/acceptedAt`]: at,
    [`invitations/${invitationId}/acceptedBy`]: uid
  });
}

// إصلاح للأمام فقط عندما توجد نية موثَّقة (حجز قبول تحقق منه الخادم). لا يُكتب فوق مدير آخر أبدًا.
async function repairForward(database, state, options = {}) {
  const { invitation, company, uid, member } = state;
  const { issues, intent } = describeState(state);

  if (!issues.length) return { status: 'consistent', actions: [] };

  if (!intent || !uid) return { status: 'needs_manual_review', issues, actions: [] };

  if (company.managerUid && company.managerUid !== uid) {
    return { status: 'needs_manual_review', issues, actions: [] };
  }

  const email = normalizeInvitationEmail(
    (invitation && (invitation.acceptedEmail || invitation.email)) || (member && member.email)
  );

  if (!email) return { status: 'needs_manual_review', issues, actions: [] };

  await completeLink(
    database,
    {
      companyId: state.companyId,
      invitationId: state.invitationId,
      uid,
      email,
      name: company.name || '',
      at: Date.now()
    },
    options
  );

  return { status: 'repaired', issues, actions: issues.slice() };
}


/* ---------- دعوات الموظفين (staff): لا تمس بيانات الشركة ولا مديرها؛ فقط العضوية وربط الحساب والدعوة ---------- */
async function readStaffState(database, companyId, invitationId) {
  const invitation = val(await database.ref(`invitations/${invitationId}`).get());
  const uid = (invitation && invitation.acceptedBy) || null;

  let member = null;
  let userCompany = null;

  if (uid) {
    const [memberSnap, userCompanySnap] = await Promise.all([
      database.ref(`companyMembers/${companyId}/${uid}`).get(),
      database.ref(`userCompanies/${uid}/${companyId}`).get()
    ]);
    member = val(memberSnap);
    userCompany = val(userCompanySnap);
  }

  return { companyId, invitationId, invitation, uid, member, userCompany };
}

function describeStaffState(state) {
  const { invitation, member, userCompany, uid } = state;
  const issues = [];

  const claimed =
    !!invitation &&
    ['accepting', 'accepted'].includes(invitation.status) &&
    !!invitation.acceptedBy;

  if (!claimed) {
    return { issues, intent: false };
  }

  if (!member) {
    issues.push('member_missing');
  } else {
    if (member.uid !== uid) issues.push('member_uid_mismatch');
    if (member.companyId !== state.companyId) issues.push('member_company_mismatch');
    if (member.invitationId !== state.invitationId) issues.push('member_invitation_mismatch');
    if (member.role !== invitation.role) issues.push('member_role_mismatch');

    const expectedEmail = normalizeInvitationEmail(invitation.acceptedEmail || '');
    const actualEmail = normalizeInvitationEmail(member.email || '');

    if (!expectedEmail || actualEmail !== expectedEmail) {
      issues.push('member_email_mismatch');
    }
  }

  if (!userCompany) {
    issues.push('user_company_missing');
  } else {
    if (userCompany.companyId !== state.companyId) {
      issues.push('user_company_mismatch');
    }
    if (userCompany.role !== invitation.role) {
      issues.push('user_company_role_mismatch');
    }
  }

  if (invitation.status !== 'accepted' && member && userCompany) {
    issues.push('invitation_not_accepted');
  }

  return { issues, intent: true };
}
async function completeStaffLink(database, { companyId, invitationId, uid, email, name, role, invitedBy, at }) {
  await database.ref().update({
    [`companyMembers/${companyId}/${uid}`]: {
      uid,
      email,
      role,
      companyId,
      invitationId,
      status: 'active',
      invitedBy: invitedBy || null,
      createdAt: at
    },
    [`userCompanies/${uid}/${companyId}`]: {
      companyId,
      name,
      role,
      createdAt: at
    },
    [`invitations/${invitationId}/status`]: 'accepted',
    [`invitations/${invitationId}/acceptedAt`]: at,
    [`invitations/${invitationId}/acceptedBy`]: uid
  });
}

async function repairStaffForward(database, state, company) {
  const { invitation, uid } = state;
  const { issues, intent } = describeStaffState(state);

  if (!issues.length) return { status: 'consistent', actions: [] };
  if (
    !intent ||
    !uid ||
    !invitation.acceptedEmail ||
    !invitation.role ||
    issues.some(issue => issue.includes('mismatch'))
  ) {
    return { status: 'needs_manual_review', issues, actions: [] };
  }

  // عضوية موجودة (قد يكون المدير أوقفها أو غيّر دورها بعد القبول) لا تُستبدل أبدًا: يُكتب فقط ما هو مفقود، ثم تُقفل الدعوة.
  // (الاستبدال الكامل كان يعيد تفعيل موظف موقوف عند إعادة محاولة قبول عالق.)
  const { companyId, invitationId, member, userCompany } = state;
  const at = Date.now();
  const updates = {};

  if (!member) {
    updates[`companyMembers/${companyId}/${uid}`] = {
      uid,
      email: normalizeInvitationEmail(invitation.acceptedEmail),
      role: invitation.role,
      companyId,
      invitationId,
      status: 'active',
      invitedBy: invitation.invitedBy || null,
      createdAt: at
    };
  }

  if (!userCompany) {
    updates[`userCompanies/${uid}/${companyId}`] = {
      companyId,
      name: (company && company.name) || '',
      role: member ? member.role : invitation.role,
      createdAt: at
    };
  }

  updates[`invitations/${invitationId}/status`] = 'accepted';
  updates[`invitations/${invitationId}/acceptedAt`] = at;
  updates[`invitations/${invitationId}/acceptedBy`] = uid;

  await database.ref().update(updates);

  return { status: 'repaired', issues, actions: issues.slice() };
}

module.exports = {
  readLinkState, describeState, completeLink, repairForward,
  readStaffState, describeStaffState, completeStaffLink, repairStaffForward
};
