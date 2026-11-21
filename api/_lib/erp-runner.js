// تشغيل محرك ERP نفسه (js/erp-ops2.js) على الخادم داخل معاملة firebase-admin.
// المحرك هو المصدر الوحيد لقواعد المخزون والمحاسبة؛ لا نسخة ثانية من المنطق.
const E = require('../../js/erp-hr.js'); // المحرك + عمليات الموارد البشرية

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(now) {
  return now.toISOString().slice(0, 10);
}

// تاريخ المستخدم المحلي يُقبل فقط إذا كان ضمن ±يوم من تاريخ الخادم (فروق المناطق الزمنية)؛ وإلا يُستعمل تاريخ الخادم.
function pickToday(clientToday, now) {
  if (typeof clientToday === 'string' && DATE_RE.test(clientToday)) {
    const diff = Math.abs(Date.parse(clientToday + 'T00:00:00Z') - Date.parse(utcDay(now) + 'T00:00:00Z'));
    if (Number.isFinite(diff) && diff <= DAY_MS) return clientToday;
  }
  return utcDay(now);
}

// اسم المستخدم في سجل التدقيق يأتي من التوكن الموثَّق، ولا يقبل أي قيمة من العميل.
async function runOp(database, path, { op, input, opId, user, today }) {
  if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(E.OPS, op)) {
    throw E.err('عملية غير معروفة.', 'no_such_op');
  }

  const now = new Date();
  const ctx = { opId, user, now: now.toISOString(), today: pickToday(today, now) };
  const ref = database.ref(path);

  let outcome = null;
  let abortErr = null;

  const res = await ref.transaction(current => {
    outcome = null;
    abortErr = null;

    // null قد يكون تخمينًا محليًا قبل وصول القيمة الحقيقية؛ يعاد استدعاء الدالة بالقيمة الفعلية.
    if (current === null || current === undefined) return null;

    if (!(Number(current.schemaVersion) >= E.SCHEMA)) {
      abortErr = E.err('بيانات الحساب تحتاج إلى ترقية أولًا.', 'needs_migration');
      return;
    }

    try {
      outcome = E.apply(current, ctx, op, input);
      return outcome.db;
    } catch (error) {
      if (error && error.erp) {
        abortErr = error;
        return;
      }
      throw error;
    }
  });

  if (abortErr) {
    if (abortErr.code === 'duplicate') {
      const snapshot = await ref.get();
      return { duplicate: true, db: E.ensure(E.clone(snapshot.val())), result: null };
    }
    throw abortErr;
  }

  if (res && res.committed && res.snapshot.val() === null) {
    throw E.err('بيانات غير مهيأة بعد.', 'no_data');
  }

  if (!res || !res.committed || !outcome) {
    throw E.err('لم تُنفَّذ العملية (تعارض مع تعديل آخر). أعد المحاولة.', 'not_committed');
  }

  return {
    duplicate: false,
    db: E.ensure(E.clone(res.snapshot.val())),
    result: outcome.result
  };
}

// بنية بيانات شركة جديدة: نفس مسار الترقية الذي يستعمله حساب جديد (migrate) باسم الشركة.
function buildInitialCompanyData(company, { appBaseUrl } = {}) {
  const now = new Date();
  const settings = { company: String(company.name || '').slice(0, 100) };

  if (appBaseUrl) settings.apiUrl = `${appBaseUrl}/api/analyze`;

  const migrated = E.migrate(
    { settings },
    { opId: 'migration-v2', user: 'system', now: now.toISOString(), today: utcDay(now) }
  );

  return migrated.db;
}

// إنشاء بيانات الشركة إن لم تكن موجودة فقط (لا تُستبدل بيانات قائمة أبدًا).
async function ensureCompanyData(database, companyId, company, options) {
  const ref = database.ref(`companyData/${companyId}`);
  const initial = buildInitialCompanyData(company, options);
  let created = false;

  await ref.transaction(current => {
    created = false;
    if (current !== null && current !== undefined) return;
    created = true;
    return initial;
  });

  return created;
}

module.exports = { E, runOp, pickToday, buildInitialCompanyData, ensureCompanyData };
