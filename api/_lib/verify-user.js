const { getFirebaseAdmin } = require('./firebase-admin');

const INVALID_TOKEN_CODES = new Set([
  'auth/argument-error',
  'auth/invalid-id-token',
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/user-disabled'
]);

// يتحقق من Firebase ID Token لأي مستخدم مسجّل (وليس السوبر أدمن فقط).
// أي توكن غير صالح => unauthorized، وأي عطل آخر يُمرَّر كما هو (500).
async function requireUser(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    throw new Error('unauthorized');
  }

  const { auth } = await getFirebaseAdmin();

  try {
    return await auth.verifyIdToken(match[1], true);
  } catch (error) {
    if (INVALID_TOKEN_CODES.has(error.code)) {
      throw new Error('unauthorized');
    }

    throw error;
  }
}

module.exports = { requireUser };
