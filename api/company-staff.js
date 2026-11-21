const crypto = require('node:crypto');
const { requireUser } = require('./_lib/verify-user');
const { getFirebaseAdmin } = require('./_lib/firebase-admin');
const { Roles, getCompanyAccess } = require('./_lib/company-access');
const { logAdminEvent } = require('./_lib/audit-log');
const mailer = require('./_lib/mailer');
const { buildInvitationEmail } = require('./_lib/invitation-email');
const {
  INVITATION_TTL_MS,
  SEND_LOCK_MS,
  EMAIL_RE,
  createInvitationToken,
  hashInvitationToken,
  createInvitationExpiry,
  normalizeInvitationEmail,
  isInvitationExpired,
  getAppBaseUrl,
  buildInvitationLink
} = require('./_lib/invitations');

// POST /api/company-staff  { action, companyId, ... }   — لمدير الشركة (MANAGER) فقط، وعلى شركته هو فقط.
//  list                          الأعضاء والدعوات المعلّقة
//  invite {email, role}          دعوة موظف بدور (HR | ACCOUNTANT | WAREHOUSE | SALES)
//  revoke-invitation {invitationId}
//  set-status {uid, status}      active | suspended (الموقوف لا يصل لأي بيانات ولا ينفّذ أي عملية)
//  set-role {uid, role}          تغيير دور موظف
// لا يمكن دعوة مدير آخر ولا تعديل المدير ولا تعديل النفس؛ ذلك لمدير النظام.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CONFIG_ERRORS = new Set(['app_base_url_not_configured', 'email_service_not_configured']);

const emailKey = email => crypto.createHash('sha256').update(email).digest('base64url').slice(0, 24);
const val = snapshot => (snapshot.exists() ? snapshot.val() : null);

const publicMember = m => ({
  uid: m.uid,
  email: m.email || '',
  role: m.role,
  roleLabel: Roles.roleLabel(m.role),
  status: m.status || 'active',
  createdAt: m.createdAt || null
});

const publicInvitation = i => ({
  id: i.id,
  email: i.email || '',
  role: i.role,
  roleLabel: Roles.roleLabel(i.role),
  status: i.status === 'sent' && isInvitationExpired(i.expiresAt) ? 'expired' : i.status || 'draft',
  expiresAt: i.expiresAt || null,
  sentAt: i.sentAt || null
});

async function invite(database, companyId, company, manager, body, res) {
  const role = String(body.role || '');

  if (!Roles.STAFF_ROLES.includes(role)) {
    return res.status(400).json({ ok: false, error: 'invalid_role' });
  }

  const email = normalizeInvitationEmail(body.email);

  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }

  // فحص الإعدادات قبل أي كتابة حتى لا تبقى دعوة معلّقة بسبب إعداد ناقص.
  const baseUrl = getAppBaseUrl();
  mailer.assertMailConfigured();

  const members = val(await database.ref(`companyMembers/${companyId}`).get()) || {};

  if (Object.values(members).some(m => normalizeInvitationEmail(m.email) === email)) {
    return res.status(409).json({ ok: false, error: 'already_member' });
  }

  const invitationId = `staff_${companyId}_${emailKey(email)}`;
  const invitationRef = database.ref(`invitations/${invitationId}`);

  const token = createInvitationToken();
  const tokenHash = hashInvitationToken(token);
  const now = Date.now();
  const expiresAt = createInvitationExpiry(now);

  let blocked = null;

  const claim = await invitationRef.transaction(current => {
    blocked = null;

    if (current !== null && current !== undefined) {
      if (current.status === 'accepted' || current.status === 'accepting') {
        blocked = 'invitation_already_accepted';
        return;
      }

      if (
        current.status === 'send_pending' &&
        Number.isFinite(current.sendStartedAt) &&
        now - current.sendStartedAt < SEND_LOCK_MS
      ) {
        blocked = 'invitation_send_in_progress';
        return;
      }
    }

    const previous = current || {};

    return {
      id: invitationId,
      kind: 'staff',
      companyId,
      email,
      role,
      status: 'send_pending',
      deliveryStatus: 'queued',
      tokenHash,
      expiresAt,
      sendStartedAt: now,
      createdAt: previous.createdAt || now,
      createdBy: previous.createdBy || manager.uid,
      invitedBy: manager.uid,
      sendCount: (Number(previous.sendCount) || 0) + 1
    };
  });

  if (!claim.committed) {
    return res.status(409).json({ ok: false, error: blocked || 'invitation_send_conflict' });
  }

  const mail = buildInvitationEmail({
    companyName: company.name || '',
    link: buildInvitationLink(baseUrl, invitationId, token),
    ttlHours: Math.round(INVITATION_TTL_MS / 3600000),
    roleLabel: Roles.roleLabel(role)
  });

  let sent;

  try {
    sent = await mailer.sendMail({ to: email, ...mail });
  } catch (mailError) {
    await invitationRef.transaction(current => {
      if (!current || current.tokenHash !== tokenHash) return;
      return { ...current, status: 'send_failed', deliveryStatus: 'failed', failedAt: Date.now() };
    });

    return res.status(502).json({ ok: false, error: 'email_send_failed' });
  }

  const sentAt = Date.now();

  await invitationRef.transaction(current => {
    if (!current || current.tokenHash !== tokenHash) return;
    return { ...current, status: 'sent', deliveryStatus: 'accepted_by_provider', providerMessageId: sent.id, sentAt };
  });

  await logAdminEvent(database, { action: 'staff.invite', actor: manager.uid, companyId, target: invitationId, details: { role } });

  return res.status(200).json({
    ok: true,
    invitation: publicInvitation({ id: invitationId, email, role, status: 'sent', expiresAt, sentAt })
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  try {
    const decoded = await requireUser(req);

    if (decoded.email_verified !== true) {
      return res.status(403).json({ ok: false, error: 'email_not_verified' });
    }

    const body = req.body || {};
    const action = String(body.action || '');
    const companyId = String(body.companyId || '').trim();

    if (!ID_RE.test(companyId)) {
      return res.status(400).json({ ok: false, error: 'invalid_company_id' });
    }

    const { database } = await getFirebaseAdmin();
    const { member, company } = await getCompanyAccess(database, companyId, decoded.uid);

    // إدارة الفريق لمدير الشركة فقط؛ أي موظف مهما كان دوره ممنوع.
    if (member.role !== 'MANAGER') {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    if (action === 'invite') {
      return await invite(database, companyId, company, decoded, body, res);
    }

    if (action === 'list') {
      const members = val(await database.ref(`companyMembers/${companyId}`).get()) || {};
      const invitations = val(await database.ref('invitations').get()) || {};

      return res.status(200).json({
        ok: true,
        members: Object.values(members).map(publicMember),
        invitations: Object.values(invitations)
          .filter(i => i && i.kind === 'staff' && i.companyId === companyId && i.status !== 'accepted')
          .map(publicInvitation)
      });
    }

    if (action === 'revoke-invitation') {
      const invitationId = String(body.invitationId || '');

      if (!invitationId.startsWith(`staff_${companyId}_`)) {
        return res.status(404).json({ ok: false, error: 'invitation_not_found' });
      }

      const ref = database.ref(`invitations/${invitationId}`);
      let outcome = 'invitation_not_found';

      await ref.transaction(current => {
        if (current === null || current === undefined) return null;
        if (current.kind !== 'staff' || current.companyId !== companyId) { outcome = 'invitation_not_found'; return; }
        if (current.status === 'accepted' || current.status === 'accepting') { outcome = 'invitation_already_accepted'; return; }
        outcome = 'ok';
        return { ...current, status: 'revoked', revokedAt: Date.now(), revokedBy: decoded.uid };
      });

      if (outcome !== 'ok') {
        return res.status(outcome === 'invitation_not_found' ? 404 : 409).json({ ok: false, error: outcome });
      }

      await logAdminEvent(database, { action: 'staff.revoke-invitation', actor: decoded.uid, companyId, target: invitationId });
      return res.status(200).json({ ok: true });
    }

    if (action === 'set-status' || action === 'set-role') {
      const targetUid = String(body.uid || '').trim();

      if (!ID_RE.test(targetUid)) {
        return res.status(400).json({ ok: false, error: 'invalid_uid' });
      }

      if (targetUid === decoded.uid) {
        return res.status(409).json({ ok: false, error: 'cannot_modify_self' });
      }

      const target = val(await database.ref(`companyMembers/${companyId}/${targetUid}`).get());

      if (!target) {
        return res.status(404).json({ ok: false, error: 'member_not_found' });
      }

      // مدير الشركة (وأي MANAGER) لا يُعدَّل من هنا.
      if (target.role === 'MANAGER') {
        return res.status(403).json({ ok: false, error: 'forbidden' });
      }

      if (action === 'set-status') {
        const status = String(body.status || '');

        if (!['active', 'suspended'].includes(status)) {
          return res.status(400).json({ ok: false, error: 'invalid_status' });
        }

        await database.ref(`companyMembers/${companyId}/${targetUid}`).update({ status });
        await logAdminEvent(database, { action: 'staff.set-status', actor: decoded.uid, companyId, target: targetUid, details: { from: target.status || 'active', to: status } });
        return res.status(200).json({ ok: true, member: publicMember({ ...target, status }) });
      }

      const role = String(body.role || '');

      if (!Roles.STAFF_ROLES.includes(role)) {
        return res.status(400).json({ ok: false, error: 'invalid_role' });
      }

      // العضوية وربط حساب الموظف بالشركة يتغيران معًا في تحديث واحد.
      const updates = { [`companyMembers/${companyId}/${targetUid}/role`]: role };
      const link = await database.ref(`userCompanies/${targetUid}/${companyId}`).get();
      if (link.exists()) updates[`userCompanies/${targetUid}/${companyId}/role`] = role;

      await database.ref().update(updates);
      await logAdminEvent(database, { action: 'staff.set-role', actor: decoded.uid, companyId, target: targetUid, details: { from: target.role, to: role } });
      return res.status(200).json({ ok: true, member: publicMember({ ...target, role }) });
    }

    return res.status(400).json({ ok: false, error: 'invalid_action' });

  } catch (error) {
    const status =
      error.message === 'unauthorized' ? 401 :
      error.message === 'forbidden' ? 403 : 500;

    if (status === 500 && !CONFIG_ERRORS.has(error.message)) {
      console.error('Company staff error:', error);
    }

    return res.status(status).json({
      ok: false,
      error: status !== 500 ? error.message : CONFIG_ERRORS.has(error.message) ? error.message : 'staff_operation_failed'
    });
  }
};
