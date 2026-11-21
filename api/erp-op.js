const { requireUser } = require('./_lib/verify-user');
const { getFirebaseAdmin } = require('./_lib/firebase-admin');
const { runOp, E } = require('./_lib/erp-runner');
const { Roles, canRunOp, getCompanyAccess } = require('./_lib/company-access');

// POST /api/erp-op  { scope: 'company'|'user', companyId?, op, input, opId, today? }
// تنفيذ عمليات الـ ERP على الخادم بالمحرك نفسه داخل معاملة.
//  - scope=company: العضوية النشطة والدور يُقرآن من قاعدة البيانات بمعرّف المستخدم الموثَّق، ولا يُصدَّق العميل في أيهما.
//  - scope=user: متاح فقط للحسابات التي فعّل مدير النظام لها serverOps (ترحيل اختياري)، ويكتب في users/{uid} الخاص بصاحبه فحسب.
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
    const isRead = body.action === 'read';
    const op = typeof body.op === 'string' ? body.op : '';
    const opId = typeof body.opId === 'string' ? body.opId : '';

    if (!isRead && (!op || !opId)) {
      return res.status(400).json({ ok: false, error: 'invalid_request' });
    }

    const { database } = await getFirebaseAdmin();
    let path;
    let role = null;
    let companyInfo = null;

    if (body.scope === 'company') {
      const companyId = String(body.companyId || '').trim();

      if (!/^[A-Za-z0-9_-]{1,128}$/.test(companyId)) {
        return res.status(400).json({ ok: false, error: 'invalid_company_id' });
      }

      const { member, company } = await getCompanyAccess(database, companyId, decoded.uid);

      // القراءة متاحة لكل دور معرَّف (تُصفّى بياناتها أدناه)؛ العمليات حسب الدور فقط.
      if (!isRead && !canRunOp(member.role, op)) {
        return res.status(403).json({ ok: false, error: 'forbidden' });
      }

      role = member.role;
      companyInfo = { id: companyId, name: company.name || '' };
      path = `companyData/${companyId}`;
    } else if (body.scope === 'user') {
      if (isRead) {
        return res.status(400).json({ ok: false, error: 'invalid_scope' });
      }

      const flag = await database.ref(`serverOps/${decoded.uid}`).get();

      if (!flag.exists()) {
        return res.status(403).json({ ok: false, error: 'server_ops_not_enabled' });
      }

      path = `users/${decoded.uid}`;
    } else {
      return res.status(400).json({ ok: false, error: 'invalid_scope' });
    }

    // إسقاط البيانات حسب الدور: غير المدير لا تصله إلا مجموعات قسمه. سلامة البيانات تُحسب على الكاملة (للمحاسب).
    const view = db => {
      if (!role || role === 'MANAGER') return db;
      const integrityCount = role === 'ACCOUNTANT' ? E.verify(E.ensure(E.clone(db)), {}).length : null;
      return Roles.project(db, role, { integrityCount });
    };

    if (isRead) {
      const snapshot = await database.ref(path).get();

      if (!snapshot.exists()) {
        return res.status(422).json({ ok: false, error: 'no_data', message: 'بيانات الشركة غير مهيأة بعد. تواصل مع مدير النظام.' });
      }

      const raw = snapshot.val();

      if (!(Number(raw.schemaVersion) >= E.SCHEMA)) {
        return res.status(422).json({ ok: false, error: 'needs_migration', message: 'بيانات الشركة تحتاج إلى ترقية من مدير النظام.' });
      }

      return res.status(200).json({ ok: true, db: view(E.ensure(E.clone(raw))), role, company: companyInfo });
    }

    const outcome = await runOp(database, path, {
      op,
      input: body.input,
      opId,
      user: decoded.email || decoded.uid,
      today: body.today
    });

    return res.status(200).json({
      ok: true,
      db: view(outcome.db),
      result: outcome.result,
      duplicate: !!outcome.duplicate,
      role
    });

  } catch (error) {
    if (error && error.erp) {
      // أخطاء المحرك (رصيد غير كافٍ، تاريخ غير صالح...) رسائلها عربية وآمنة للعرض.
      return res.status(422).json({ ok: false, error: error.code, message: error.message });
    }

    const status =
      error.message === 'unauthorized' ? 401 :
      error.message === 'forbidden' ? 403 : 500;

    if (status === 500) {
      console.error('ERP operation error:', error);
    }

    return res.status(status).json({
      ok: false,
      error: status === 500 ? 'operation_failed' : error.message
    });
  }
};

