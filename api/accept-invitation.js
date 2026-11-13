const { requireUser } = require('./_lib/verify-user');
const { getFirebaseAdmin } = require('./_lib/firebase-admin');
const {
  normalizeInvitationEmail,
  evaluateInvitationForAccept
} = require('./_lib/invitations');

// POST /api/accept-invitation  { invitationId, token }  + Authorization: Bearer <Firebase ID token>
// الخطوات: (1) هوية موثّقة وبريد مؤكَّد (2) "حجز" الدعوة بمعاملة ذرّية تتحقق من التوكن والبريد والصلاحية
// (3) كتابة الربط والعضوية وتغيير الحالات في تحديث واحد متعدد المسارات (ذرّي) (4) أي فشل يُرجع الحجز.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  try {
    const decoded = await requireUser(req);

    const invitationId = String(req.body?.invitationId || '').trim();
    const token = String(req.body?.token || '').trim();

    if (
      !/^manager_[A-Za-z0-9_-]{1,128}$/.test(invitationId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(token)
    ) {
      return res.status(400).json({ ok: false, error: 'invalid_invitation' });
    }

    if (decoded.email_verified !== true || !decoded.email) {
      return res.status(403).json({ ok: false, error: 'email_not_verified' });
    }

    const uid = decoded.uid;
    const email = normalizeInvitationEmail(decoded.email);
    const companyId = invitationId.slice('manager_'.length);

    const { database } = await getFirebaseAdmin();

    const invitationRef = database.ref(`invitations/${invitationId}`);
    const companyRef = database.ref(`companies/${companyId}`);

    // فحص الشركة قبل الحجز حتى لا تُغيَّر الدعوة إن كانت الشركة غير جاهزة.
    const companySnapshot = await companyRef.get();

    if (!companySnapshot.exists()) {
      return res.status(404).json({ ok: false, error: 'invalid_invitation' });
    }

    const company = companySnapshot.val() || {};

    const companyReady =
      company.status === 'pending_manager' &&
      ['pending_invitation', 'invited'].includes(company.managerStatus) &&
      !company.managerUid &&
      normalizeInvitationEmail(company.managerEmail) === email;

    // الدعوة المقبولة سابقًا تُرفض برسالتها الدقيقة أدناه، لا برسالة الشركة.
    const now = Date.now();
    let verdict = null;

    const claim = await invitationRef.transaction(current => {
      verdict = null;

      // null هنا قد يكون تخمينًا محليًا قبل وصول القيمة الحقيقية: نُرجعه كما هو
      // ليُعاد استدعاء الدالة بالقيمة الفعلية من الخادم.
      if (current === null || current === undefined) {
        return null;
      }

      verdict = evaluateInvitationForAccept(current, { token, email, uid, now });

      if (!verdict.ok) return;

      if (current.companyId !== companyId || !companyReady) {
        verdict = { ok: false, status: 409, error: 'company_not_waiting_for_manager' };
        return;
      }

      return {
        ...current,
        status: 'accepting',
        acceptedBy: uid,
        acceptingAt: now
      };
    });

    if (!verdict) {
      return res.status(404).json({ ok: false, error: 'invalid_invitation' });
    }

    if (!claim.committed || !verdict.ok) {
      const failure = verdict.ok
        ? { status: 409, error: 'invitation_accept_in_progress' }
        : verdict;

      return res.status(failure.status).json({ ok: false, error: failure.error });
    }

    const linkedAt = Date.now();

    try {
      await database.ref().update({
        [`companies/${companyId}/managerUid`]: uid,
        [`companies/${companyId}/managerStatus`]: 'linked',
        [`companies/${companyId}/status`]: 'active',
        [`companies/${companyId}/managerLinkedAt`]: linkedAt,
        [`companyMembers/${companyId}/${uid}`]: {
          uid,
          email,
          role: 'MANAGER',
          companyId,
          invitationId,
          status: 'active',
          createdAt: linkedAt
        },
        [`userCompanies/${uid}/${companyId}`]: {
          companyId,
          role: 'MANAGER',
          createdAt: linkedAt
        },
        [`invitations/${invitationId}/status`]: 'accepted',
        [`invitations/${invitationId}/acceptedAt`]: linkedAt,
        [`invitations/${invitationId}/acceptedBy`]: uid
      });
    } catch (writeError) {
      // التحديث متعدد المسارات ذرّي، فلم يُكتب شيء: نُرجع الحجز ليستطيع المدير إعادة المحاولة.
      await invitationRef.transaction(current => {
        if (!current || current.status !== 'accepting' || current.acceptedBy !== uid) return;
        return {
          ...current,
          status: 'sent',
          acceptedBy: null,
          acceptingAt: null
        };
      }).catch(() => {});

      throw writeError;
    }

    return res.status(200).json({
      ok: true,
      role: 'MANAGER',
      company: { id: companyId, name: company.name || '' }
    });

  } catch (error) {
    const status = error.message === 'unauthorized' ? 401 : 500;

    if (status === 500) {
      console.error('Accept invitation error:', error);
    }

    return res.status(status).json({
      ok: false,
      error: status === 500 ? 'invitation_accept_failed' : error.message
    });
  }
};
