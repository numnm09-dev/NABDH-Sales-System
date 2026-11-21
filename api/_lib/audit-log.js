// سجل تدقيق للعمليات الإدارية والأمنية (إنشاء شركة، إرسال/قبول/إلغاء دعوة، تغيير دور أو حالة موظف، صيانة).
// يُكتب في adminAudit/* الذي لا تفتحه قواعد القراءة/الكتابة للعميل (الجذر مغلق)، فلا يصله ولا يعدّله إلا الخادم.
// لا يُسجَّل أي توكن أو بصمة توكن؛ تُسجَّل المعرّفات (uid / companyId) والأفعال فقط.
// فشل التسجيل لا يُسقط العملية الأساسية (سبق تنفيذها) لكنه يُسجَّل في سجل الخادم.
const SAFE = value => (value === undefined ? null : value);

async function logAdminEvent(database, { action, actor, companyId, target, details }) {
  try {
    const ref = database.ref('adminAudit').push();

    await ref.set({
      ts: Date.now(),
      action: String(action).slice(0, 80),
      actor: SAFE(actor) && String(actor).slice(0, 128),
      companyId: SAFE(companyId) && String(companyId).slice(0, 128),
      target: SAFE(target) && String(target).slice(0, 200),
      details: SAFE(details)
    });

    return true;
  } catch (error) {
    console.error('Admin audit log write failed:', action, error && error.message);
    return false;
  }
}

module.exports = { logAdminEvent };
