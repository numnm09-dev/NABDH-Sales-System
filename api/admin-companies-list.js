const { requireSuperAdmin } = require('./_lib/require-super-admin');
const { getFirebaseAdmin } = require('./_lib/firebase-admin');
const { isInvitationExpired } = require('./_lib/invitations');

// حالة الدعوة كما تُعرض للإدارة. لا تُرجَع بصمة التوكن ولا أي توكن أبدًا.
function describeInvitation(invitation) {
  if (!invitation || typeof invitation !== 'object') return null;

  const status =
    invitation.status === 'sent' && isInvitationExpired(invitation.expiresAt)
      ? 'expired'
      : invitation.status || 'draft';

  return {
    status,
    deliveryStatus: invitation.deliveryStatus || 'not_sent',
    email: invitation.email || '',
    expiresAt: invitation.expiresAt || null,
    sentAt: invitation.sentAt || null,
    acceptedAt: invitation.acceptedAt || null
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      error: 'method_not_allowed'
    });
  }

  try {
    await requireSuperAdmin(req);

    const { database } = await getFirebaseAdmin();
    const snapshot = await database.ref('companies').once('value');
    const data = snapshot.val() || {};

    const invitationsSnapshot = await database.ref('invitations').once('value');
    const invitations = invitationsSnapshot.val() || {};

    const membersSnapshot = await database.ref('companyMembers').once('value');
    const members = membersSnapshot.val() || {};

    const companies = Object.entries(data).map(([id, company]) => {
      const managerUid = company.managerUid || null;
      const member = managerUid ? (members[id] || {})[managerUid] : null;

      return {
        id,
        name: company.name || '',
        managerEmail: company.managerEmail || '',
        managerStatus: company.managerStatus || 'pending_invitation',
        status: company.status || 'pending_manager',
        createdAt: company.createdAt || null,
        managerUid,
        managerLinkedAt: company.managerLinkedAt || null,
        manager: member
          ? {
              uid: member.uid || managerUid,
              email: member.email || '',
              role: member.role || 'MANAGER',
              status: member.status || 'active'
            }
          : null,
        invitation: describeInvitation(invitations[`manager_${id}`])
      };
    });

    return res.status(200).json({
      ok: true,
      companies
    });

  } catch (error) {
    const status =
      error.message === 'unauthorized' ? 401 :
      error.message === 'forbidden' ? 403 : 500;

    if (status === 500) {
      console.error('Admin company list error:', error);
    }

    return res.status(status).json({
      ok: false,
      error: status === 500
        ? 'company_list_failed'
        : error.message
    });
  }
};
