const { getFirebaseAdmin } = require('./firebase-admin');

const INVALID_TOKEN_CODES = new Set([
  'auth/argument-error',
  'auth/invalid-id-token',
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/user-disabled'
]);

async function requireSuperAdmin(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    throw new Error('unauthorized');
  }

  const { auth } = await getFirebaseAdmin();
  let decoded;

  try {
    decoded = await auth.verifyIdToken(match[1], true);
  } catch (error) {
    if (INVALID_TOKEN_CODES.has(error.code)) {
      // السبب الأصلي (مثل auth/argument-error عند اختلاف المشروع) يُحفظ للتسجيل في الخادم فقط، ولا يُرسل للعميل.
      throw Object.assign(new Error('unauthorized'), { cause: error });
    }
    throw error;
  }

  // مسافة/سطر جديد زائد عند لصق القيمة في Vercel يكسر المطابقة الصارمة؛ UID في Firebase لا يحوي مسافات.
  const rawExpected = process.env.SUPER_ADMIN_UID || '';
  const expected = rawExpected.trim();

  if (!expected || decoded.uid !== expected) {
    throw Object.assign(new Error('forbidden'), {
      // أطوال فقط (لا قيم) لتشخيص عدم المطابقة دون كشف الـ UID في السجلات.
      details: {
        configured: Boolean(expected),
        configuredRawLength: rawExpected.length,
        configuredLength: expected.length,
        tokenUidLength: String(decoded.uid || '').length
      }
    });
  }

  return decoded;
}

module.exports = { requireSuperAdmin };
