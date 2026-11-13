const { requireSuperAdmin } = require('./_lib/require-super-admin');
const { getFirebaseAdmin } = require('./_lib/firebase-admin');
const { normalizeInvitationEmail } = require('./_lib/invitations');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'method_not_allowed'
    });
  }

  try {
    const admin = await requireSuperAdmin(req);

    const companyId = String(req.body?.companyId || '').trim();

    if (!/^[A-Za-z0-9_-]{1,128}$/.test(companyId)) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_company_id'
      });
    }

    const { database } = await getFirebaseAdmin();

    const companySnapshot = await database
      .ref(`companies/${companyId}`)
      .get();

    if (!companySnapshot.exists()) {
      return res.status(404).json({
        ok: false,
        error: 'company_not_found'
      });
    }

    const company = companySnapshot.val() || {};

    if (
      company.status !== 'pending_manager' ||
      company.managerStatus !== 'pending_invitation'
    ) {
      return res.status(409).json({
        ok: false,
        error: 'company_not_waiting_for_manager'
      });
    }

    const email = normalizeInvitationEmail(company.managerEmail);

    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return res.status(409).json({
        ok: false,
        error: 'manager_email_invalid'
      });
    }

    const invitationId = `manager_${companyId}`;
    const createdAt = Date.now();

    const invitation = {
      id: invitationId,
      companyId,
      email,
      role: 'MANAGER',
      status: 'draft',
      deliveryStatus: 'not_sent',
      createdAt,
      createdBy: admin.uid
    };

    const invitationRef = database.ref(
      `invitations/${invitationId}`
    );

    const result = await invitationRef.transaction(current => {
      if (current !== null) return;
      return invitation;
    });

    if (!result.committed) {
      return res.status(409).json({
        ok: false,
        error: 'invitation_already_exists'
      });
    }

    return res.status(201).json({
      ok: true,
      invitation: {
        id: invitationId,
        companyId,
        email,
        role: 'MANAGER',
        status: 'draft',
        deliveryStatus: 'not_sent'
      }
    });

  } catch (error) {
    const status =
      error.message === 'unauthorized' ? 401 :
      error.message === 'forbidden' ? 403 : 500;

    if (status === 500) {
      console.error('Admin invitation creation error:', error);
    }

    return res.status(status).json({
      ok: false,
      error: status === 500
        ? 'invitation_creation_failed'
        : error.message
    });
  }
};
