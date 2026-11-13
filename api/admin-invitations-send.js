const { requireSuperAdmin } = require('./_lib/require-super-admin');
const { getFirebaseAdmin } = require('./_lib/firebase-admin');
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
  getAppBaseUrl,
  buildInvitationLink
} = require('./_lib/invitations');

const CONFIG_ERRORS = new Set([
  'app_base_url_not_configured',
  'email_service_not_configured'
]);

// POST /api/admin-invitations-send  { companyId }
// ينشئ (أو يعيد إصدار) دعوة المدير بتوكن عشوائي، يخزّن بصمته فقط، ثم يرسلها بالبريد.
// الحالة لا تصبح "sent" إلا بعد قبول مزوّد البريد للرسالة فعلًا.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  try {
    const admin = await requireSuperAdmin(req);

    const companyId = String(req.body?.companyId || '').trim();

    if (!/^[A-Za-z0-9_-]{1,128}$/.test(companyId)) {
      return res.status(400).json({ ok: false, error: 'invalid_company_id' });
    }

    // فحص الإعدادات قبل أي كتابة حتى لا تبقى دعوة معلّقة بسبب إعداد ناقص.
    const baseUrl = getAppBaseUrl();
    mailer.assertMailConfigured();

    const { database } = await getFirebaseAdmin();

    const companyRef = database.ref(`companies/${companyId}`);
    const companySnapshot = await companyRef.get();

    if (!companySnapshot.exists()) {
      return res.status(404).json({ ok: false, error: 'company_not_found' });
    }

    const company = companySnapshot.val() || {};

    if (
      company.status !== 'pending_manager' ||
      !['pending_invitation', 'invited'].includes(company.managerStatus) ||
      company.managerUid
    ) {
      return res.status(409).json({
        ok: false,
        error: 'company_not_waiting_for_manager'
      });
    }

    const email = normalizeInvitationEmail(company.managerEmail);

    if (email.length > 254 || !EMAIL_RE.test(email)) {
      return res.status(409).json({ ok: false, error: 'manager_email_invalid' });
    }

    const invitationId = `manager_${companyId}`;
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
        companyId,
        email,
        role: 'MANAGER',
        status: 'send_pending',
        deliveryStatus: 'queued',
        tokenHash,
        expiresAt,
        sendStartedAt: now,
        createdAt: previous.createdAt || now,
        createdBy: previous.createdBy || admin.uid,
        lastSentBy: admin.uid,
        sendCount: (Number(previous.sendCount) || 0) + 1
      };
    });

    if (!claim.committed) {
      return res.status(409).json({
        ok: false,
        error: blocked || 'invitation_send_conflict'
      });
    }

    const mail = buildInvitationEmail({
      companyName: company.name || '',
      link: buildInvitationLink(baseUrl, invitationId, token),
      ttlHours: Math.round(INVITATION_TTL_MS / 3600000)
    });

    let sent;

    try {
      sent = await mailer.sendMail({ to: email, ...mail });
    } catch (mailError) {
      // نسجّل الفشل فقط إذا كانت هذه الدعوة (نفس البصمة) ما زالت الحالية.
      await invitationRef.transaction(current => {
        if (!current || current.tokenHash !== tokenHash) return;
        return {
          ...current,
          status: 'send_failed',
          deliveryStatus: 'failed',
          failedAt: Date.now()
        };
      });

      return res.status(502).json({ ok: false, error: 'email_send_failed' });
    }

    const sentAt = Date.now();

    await invitationRef.transaction(current => {
      if (!current || current.tokenHash !== tokenHash) return;
      return {
        ...current,
        status: 'sent',
        deliveryStatus: 'accepted_by_provider',
        providerMessageId: sent.id,
        sentAt
      };
    });

    try {
      await companyRef.update({
        managerStatus: 'invited',
        managerInvitedAt: sentAt
      });
    } catch (updateError) {
      // الدعوة نفسها محفوظة بحالتها الصحيحة؛ هذا حقل عرض فقط.
      console.error('Company invited-status update error:', updateError);
    }

    return res.status(200).json({
      ok: true,
      invitation: {
        id: invitationId,
        companyId,
        email,
        role: 'MANAGER',
        status: 'sent',
        deliveryStatus: 'accepted_by_provider',
        expiresAt,
        sentAt
      }
    });

  } catch (error) {
    const status =
      error.message === 'unauthorized' ? 401 :
      error.message === 'forbidden' ? 403 : 500;

    if (status === 500 && !CONFIG_ERRORS.has(error.message)) {
      console.error('Admin invitation send error:', error);
    }

    return res.status(status).json({
      ok: false,
      error:
        status !== 500 ? error.message :
        CONFIG_ERRORS.has(error.message) ? error.message :
        'invitation_send_failed'
    });
  }
};
