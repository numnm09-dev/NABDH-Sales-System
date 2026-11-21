const { requireUser } = require('./_lib/verify-user');
const { getFirebaseAdmin } = require('./_lib/firebase-admin');
const { logAdminEvent } = require('./_lib/audit-log');
const {
  normalizeInvitationEmail,
  evaluateInvitationForAccept,
  verifyInvitationToken,
  getAppBaseUrl
} = require('./_lib/invitations');
const {
  readLinkState, completeLink, repairForward,
  readStaffState, completeStaffLink, repairStaffForward
} = require('./_lib/reconcile');
const { Roles } = require('./_lib/company-access');

// POST /api/accept-invitation  { invitationId, token }  + Authorization: Bearer <Firebase ID token>
// نوعان من الدعوات: manager_* (مدير الشركة، من مدير النظام) وstaff_* (موظف بدور محدد، من مدير الشركة).
// (1) هوية موثّقة وبريد مؤكَّد  (2) حجز الدعوة بمعاملة ذرّية تتحقق من التوكن والبريد والصلاحية
// (3) كتابة الربط/العضوية في تحديث واحد متعدد المسارات  (4) أي خطأ في الخطوة 3 يُعامل كـ«ملتبس»:
// تُقرأ الحالة الفعلية وتُصالَح (إكمال للأمام أو إرجاع الحجز)، ولا يُفترض الفشل.

const COMPANY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function optionalBaseUrl() {
  try {
    return getAppBaseUrl();
  } catch {
    return undefined;
  }
}

async function releaseClaim(invitationRef, uid, claimedAt) {
  await invitationRef.transaction(current => {
    if (
      !current ||
      current.status !== 'accepting' ||
      current.acceptedBy !== uid ||
      current.acceptingAt !== claimedAt
    ) {
      return;
    }

    return {
      ...current,
      status: 'sent',
      acceptedBy: null,
      acceptedEmail: null,
      acceptingAt: null
    };
  });
}

// يُرجع: completed | released | unknown. لا يرمي أبدًا.
async function recoverAfterFailure(database, invitationRef, kind, params, company, options, claimedAt) {
  try {
    if (kind === 'manager') {
      const state = await readLinkState(database, params.companyId);

      if (state.company && state.company.managerUid === params.uid) {
        const repaired = await repairForward(database, state, options);
        return repaired.status === 'needs_manual_review' ? 'unknown' : 'completed';
      }
    } else {
      const state = await readStaffState(database, params.companyId, params.invitationId);

      if (state.member && state.member.uid === params.uid) {
        const repaired = await repairStaffForward(database, state, company);
        return repaired.status === 'needs_manual_review' ? 'unknown' : 'completed';
      }
    }

    // لا أثر لأي كتابة: محاولة واحدة إضافية ثم إرجاع الحجز.
    try {
      if (kind === 'manager') await completeLink(database, params, options);
      else await completeStaffLink(database, params);
      return 'completed';
    } catch (retryError) {
      // نكمل إلى إرجاع الحجز
    }

    await releaseClaim(invitationRef, params.uid, claimedAt);
    return 'released';
  } catch (error) {
    return 'unknown';
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  try {
    const decoded = await requireUser(req);

    const invitationId = String(req.body?.invitationId || '').trim();
    const token = String(req.body?.token || '').trim();

    if (
      !/^(manager|staff)_[A-Za-z0-9_-]{1,200}$/.test(invitationId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(token)
    ) {
      return res.status(400).json({ ok: false, error: 'invalid_invitation' });
    }

    if (decoded.email_verified !== true || !decoded.email) {
      return res.status(403).json({ ok: false, error: 'email_not_verified' });
    }

    const uid = decoded.uid;
    const email = normalizeInvitationEmail(decoded.email);
    const kind = invitationId.startsWith('staff_') ? 'staff' : 'manager';

    const { database } = await getFirebaseAdmin();

    const invitationRef = database.ref(`invitations/${invitationId}`);
    const preSnapshot = await invitationRef.get();
    const pre = preSnapshot.exists() ? preSnapshot.val() : null;

    if (!pre) {
      return res.status(404).json({ ok: false, error: 'invalid_invitation' });
    }

    // معرّف الشركة: لدعوة المدير من المعرّف نفسه، ولدعوة الموظف من سجل الدعوة (والنوع والدور يُتحقق منهما).
    const companyId = kind === 'manager' ? invitationId.slice('manager_'.length) : String(pre.companyId || '');

    if (!COMPANY_ID_RE.test(companyId) ||
      (kind === 'staff' && (pre.kind !== 'staff' || !Roles.STAFF_ROLES.includes(pre.role)))) {
      return res.status(404).json({ ok: false, error: 'invalid_invitation' });
    }

    const companyRef = database.ref(`companies/${companyId}`);
    const options = { appBaseUrl: optionalBaseUrl() };

    const companySnapshot = await companyRef.get();

    if (!companySnapshot.exists()) {
      return res.status(404).json({ ok: false, error: 'invalid_invitation' });
    }

    const company = companySnapshot.val() || {};

    const success = async role => {
      await logAdminEvent(database, { action: 'invitation.accept', actor: uid, companyId, target: invitationId, details: { kind, role } });

      return res.status(200).json({
        ok: true,
        role,
        company: { id: companyId, name: company.name || '' }
      });
    };

    // مصالحة عند الدخول: حجز سابق لنفس المستخدم نُفِّذ ربطه فعلًا لكن الإقرار ضاع (انقطاع بعد الحفظ).
    if (
      pre.status === 'accepting' &&
      pre.acceptedBy === uid &&
      verifyInvitationToken(token, pre.tokenHash)
    ) {
      if (kind === 'manager') {
        const state = await readLinkState(database, companyId);

        if (state.company && state.company.managerUid === uid) {
          const repaired = await repairForward(database, state, options);

          if (repaired.status !== 'needs_manual_review') {
            return success('MANAGER');
          }
        }
      } else {
        const state = await readStaffState(database, companyId, invitationId);

        if (state.member && state.member.uid === uid) {
          const repaired = await repairStaffForward(database, state, company);

          if (repaired.status !== 'needs_manual_review') {
            return success(pre.role);
          }
        }
      }
    }

    let companyReady;
    let notReadyError = 'company_not_waiting_for_manager';

    if (kind === 'manager') {
      companyReady =
        company.status === 'pending_manager' &&
        ['pending_invitation', 'invited'].includes(company.managerStatus) &&
        !company.managerUid &&
        normalizeInvitationEmail(company.managerEmail) === email;
    } else {
      const existing = await database.ref(`companyMembers/${companyId}/${uid}`).get();
      companyReady = company.status === 'active' && !!company.managerUid && !existing.exists();
      notReadyError = existing.exists() ? 'already_member' : 'company_not_active';
    }

    const now = Date.now();
    let verdict = null;
    let seen = null;
    let claimed = null;

    let claim;

    try {
      claim = await invitationRef.transaction(current => {
        verdict = null;
        seen = null;
        claimed = null;

        // null قد يكون تخمينًا محليًا قبل وصول القيمة الحقيقية: نُرجعه كما هو
        // ليُعاد استدعاء الدالة بالقيمة الفعلية من الخادم.
        if (current === null || current === undefined) {
          return null;
        }

        seen = current;
        verdict = evaluateInvitationForAccept(current, { token, email, uid, now });

        if (!verdict.ok) return;

        if (current.companyId !== companyId || !companyReady) {
          verdict = { ok: false, status: 409, error: notReadyError };
          return;
        }

        claimed = current;

        return {
          ...current,
          status: 'accepting',
          acceptedBy: uid,
          acceptedEmail: email,
          acceptingAt: now
        };
      });
    } catch (claimError) {
      // التزام ملتبس للحجز: لا نعرف إن حُفظ. نحاول إرجاعه إن كان لنا؛ وإلا يُستأنف بعد انتهاء مهلته.
      await releaseClaim(invitationRef, uid, now).catch(() => {});
      throw claimError;
    }

    if (!verdict) {
      return res.status(404).json({ ok: false, error: 'invalid_invitation' });
    }

    if (!claim.committed || !verdict.ok) {
      const failure = verdict.ok
        ? { status: 409, error: 'invitation_accept_in_progress' }
        : verdict;

      const body = { ok: false, error: failure.error };

      // دعوة مقبولة سابقًا بيد نفس المستخدم: لا استخدام ثانٍ، لكن نُخبره أن ربطه قائم.
      if (failure.error === 'invitation_already_used' && seen && seen.acceptedBy === uid) {
        body.linkedToYou = true;
        body.companyId = seen.companyId || companyId;
      }

      return res.status(failure.status).json(body);
    }

    const role = kind === 'manager' ? 'MANAGER' : claimed.role;

    const params = kind === 'manager'
      ? { companyId, invitationId, uid, email, name: company.name || '', at: Date.now() }
      : { companyId, invitationId, uid, email, name: company.name || '', role, invitedBy: claimed.invitedBy, at: Date.now() };

    try {
      if (kind === 'manager') await completeLink(database, params, options);
      else await completeStaffLink(database, params);
    } catch (writeError) {
      const outcome = await recoverAfterFailure(database, invitationRef, kind, params, company, options, now);

      if (outcome === 'completed') {
        return success(role);
      }

      throw writeError;
    }

    return success(role);

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
