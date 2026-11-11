const test = require('node:test');
const assert = require('node:assert/strict');

let verifyToken = async () => ({ uid: 'admin-1' });

const firebasePath = require.resolve('../api/_lib/firebase-admin');

require.cache[firebasePath] = {
  id: firebasePath,
  filename: firebasePath,
  loaded: true,
  exports: {
    getFirebaseAdmin: async () => ({
      auth: { verifyIdToken: (...args) => verifyToken(...args) }
    })
  }
};

process.env.SUPER_ADMIN_UID = 'admin-1';

const handler = require('../api/admin-check');

async function call(method = 'GET', authorization) {
  const req = {
    method,
    headers: authorization ? { authorization } : {}
  };

  const res = {
    code: 200,
    body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };

  await handler(req, res);
  return res;
}

test('رفض الطلب بدون توكن: 401', async () => {
  const r = await call();
  assert.equal(r.code, 401);
});

test('رفض التوكن المنتهي: 401', async () => {
  verifyToken = async () => {
    const e = new Error('expired');
    e.code = 'auth/id-token-expired';
    throw e;
  };
  const r = await call('GET', 'Bearer expired-token');
  assert.equal(r.code, 401);
});

test('رفض المستخدم العادي: 403', async () => {
  verifyToken = async () => ({ uid: 'normal-user' });
  const r = await call('GET', 'Bearer valid-token');
  assert.equal(r.code, 403);
});

test('نجاح المدير العام: 200', async () => {
  verifyToken = async (token, checkRevoked) => {
    assert.equal(checkRevoked, true);
    return { uid: 'admin-1' };
  };
  const r = await call('GET', 'Bearer admin-token');
  assert.equal(r.code, 200);
  assert.equal(r.body.role, 'SUPER_ADMIN');
});

test('رفض طريقة غير GET: 405', async () => {
  const r = await call('POST', 'Bearer admin-token');
  assert.equal(r.code, 405);
});

test('خطأ غير متوقع في التحقق: 500', async () => {
  verifyToken = async () => {
    throw new Error('database_unavailable');
  };
  const r = await call('GET', 'Bearer valid-token');
  assert.equal(r.code, 500);
});
