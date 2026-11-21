// تحديد معدّل الطلبات لكل مستخدم موثَّق، مخزَّن في Realtime Database بمعاملة ذرّية كي يعمل عبر كل نسخ الدوال
// (Vercel Serverless لا تشارك الذاكرة بين النسخ، فالعدّاد في الذاكرة وحده لا يكفي).
// المسار rateLimits/* لا تفتحه قواعد القراءة/الكتابة للعميل (الجذر مغلق)، فلا يصله إلا الخادم.
const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

// يُرجع { allowed, retryAfterSec }. أي عطل في التخزين يرمي خطأً (الفشل مغلق: لا نسمح بطلب مكلف دون عدّاد).
async function consumeRateLimit(database, bucket, id, { limit, windowMs, now = Date.now() }) {
  if (!KEY_RE.test(String(bucket)) || !KEY_RE.test(String(id))) {
    throw new Error('invalid_rate_limit_key');
  }

  if (!(limit >= 1) || !(windowMs > 0)) {
    throw new Error('invalid_rate_limit_config');
  }

  const ref = database.ref(`rateLimits/${bucket}/${id}`);
  let allowed = false;
  let retryAfterMs = 0;

  const result = await ref.transaction(current => {
    allowed = false;
    retryAfterMs = 0;

    const fresh =
      !current ||
      typeof current !== 'object' ||
      !Number.isFinite(current.start) ||
      !Number.isFinite(current.count) ||
      now - current.start >= windowMs ||
      current.start > now; // ساعة غير منطقية: نبدأ نافذة جديدة بدل الحجب الدائم

    if (fresh) {
      allowed = true;
      return { start: now, count: 1 };
    }

    if (current.count >= limit) {
      retryAfterMs = current.start + windowMs - now;
      return; // إلغاء المعاملة دون كتابة
    }

    allowed = true;
    return { start: current.start, count: current.count + 1 };
  });

  // اعتُمدت القيمة لكن لم تُحفظ (تعارض متكرر): لا نسمح بالتخمين.
  if (allowed && !(result && result.committed)) {
    throw new Error('rate_limit_unavailable');
  }

  return {
    allowed,
    retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil(retryAfterMs / 1000))
  };
}

module.exports = { consumeRateLimit };
