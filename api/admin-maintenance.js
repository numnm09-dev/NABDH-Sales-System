const { requireSuperAdmin } = require('./_lib/require-super-admin');
const { getFirebaseAdmin } = require('./_lib/firebase-admin');
const { logAdminEvent } = require('./_lib/audit-log');
const { E } = require('./_lib/erp-runner');
const { getAppBaseUrl } = require('./_lib/invitations');
const { readLinkState, describeState, repairForward } = require('./_lib/reconcile');

// POST /api/admin-maintenance  { action, ... }   (SUPER_ADMIN فقط)
//  reconcile-company   { companyId }  فحص اتساق الدعوة/الشركة/العضوية وإصلاحه للأمام عند وجود نية موثَّقة
//  enable-server-ops   { uid }        ترحيل اختياري لحساب قديم إلى عمليات الخادم (نسخة احتياطية + فحص سلامة + علم)
//  disable-server-ops  { uid }        التراجع: حذف العلم فقط (النسخة الاحتياطية تبقى)
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function optionalBaseUrl() {
  try { return getAppBaseUrl(); } catch { return undefined; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  try {
    const admin = await requireSuperAdmin(req);
    const action = String(req.body?.action || '');
    const { database } = await getFirebaseAdmin();

    if (action === 'reconcile-company') {
      const companyId = String(req.body?.companyId || '').trim();

      if (!ID_RE.test(companyId)) {
        return res.status(400).json({ ok: false, error: 'invalid_company_id' });
      }

      const state = await readLinkState(database, companyId);

      if (!state.company) {
        return res.status(404).json({ ok: false, error: 'company_not_found' });
      }

      const before = describeState(state).issues;

      if (!before.length) {
        return res.status(200).json({ ok: true, status: 'consistent', issues: [] });
      }

      const result = await repairForward(database, state, { appBaseUrl: optionalBaseUrl() });
      await logAdminEvent(database, { action: 'maintenance.reconcile-company', actor: admin.uid, companyId, target: companyId, details: { result: result.status, issues: before } });
      return res.status(200).json({ ok: true, ...result, issues: before });
    }

    if (action === 'enable-server-ops' || action === 'disable-server-ops') {
      const uid = String(req.body?.uid || '').trim();

      if (!ID_RE.test(uid)) {
        return res.status(400).json({ ok: false, error: 'invalid_uid' });
      }

      const flagRef = database.ref(`serverOps/${uid}`);

      if (action === 'disable-server-ops') {
        await flagRef.remove();
        await logAdminEvent(database, { action: 'maintenance.disable-server-ops', actor: admin.uid, target: uid });
        return res.status(200).json({ ok: true, enabled: false });
      }

      const userRef = database.ref(`users/${uid}`);
      const snapshot = await userRef.get();

      if (!snapshot.exists()) {
        return res.status(404).json({ ok: false, error: 'user_data_not_found' });
      }

      const raw = snapshot.val();

      if (!(Number(raw.schemaVersion) >= E.SCHEMA)) {
        return res.status(409).json({ ok: false, error: 'user_needs_migration' });
      }

      // 1) فحص السلامة الكامل قبل أي تغيير: لا نُثبّت حسابًا مختلّ الأرصدة.
      const problems = E.verify(E.ensure(E.clone(raw)), {});

      if (problems.length) {
        return res.status(409).json({
          ok: false,
          error: 'integrity_check_failed',
          problemCount: problems.length,
          sample: problems.slice(0, 5)
        });
      }

      // 2) نسخة احتياطية تُكتب مرة واحدة فقط (لا تُستبدل أبدًا).
      let backupCreated = false;
      await database.ref(`backups/${uid}/pre_server_ops`).transaction(current => {
        backupCreated = false;
        if (current !== null && current !== undefined) return;
        backupCreated = true;
        return raw;
      });

      // 3) العلم لا يُكتب إلا بعد نجاح الخطوتين السابقتين.
      await flagRef.set({ enabledAt: Date.now(), enabledBy: admin.uid });

      // 4) إعادة فحص بعد التفعيل (تغيّر محتمل أثناء الخطوات)؛ عند الفشل يُسحب العلم.
      const after = (await userRef.get()).val();
      const recheck = E.verify(E.ensure(E.clone(after)), {});

      if (recheck.length) {
        await flagRef.remove();
        return res.status(409).json({ ok: false, error: 'integrity_changed_during_enable' });
      }

      await logAdminEvent(database, { action: 'maintenance.enable-server-ops', actor: admin.uid, target: uid, details: { backupCreated } });
      return res.status(200).json({ ok: true, enabled: true, backupCreated });
    }

    return res.status(400).json({ ok: false, error: 'invalid_action' });

  } catch (error) {
    const status =
      error.message === 'unauthorized' ? 401 :
      error.message === 'forbidden' ? 403 : 500;

    if (status === 500) {
      console.error('Admin maintenance error:', error);
    }

    return res.status(status).json({
      ok: false,
      error: status === 500 ? 'maintenance_failed' : error.message
    });
  }
};
