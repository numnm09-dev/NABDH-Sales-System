const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

let authError = null;
let sendError = null;
let sendResult = { data: { id: 'email_test_123' }, error: null };
let capturedPayload = null;
let capturedApiKey = null;
let sendCount = 0;

const resendPath = require.resolve('resend');
const authPath = require.resolve('../api/_lib/require-super-admin');
const apiPath = require.resolve('../api/test-email');

require.cache[resendPath] = {
  id: resendPath,
  filename: resendPath,
  loaded: true,
  exports: {
    Resend: class MockResend {
      constructor(apiKey) {
        capturedApiKey = apiKey;
        this.emails = {
          send: async payload => {
            sendCount++;
            capturedPayload = payload;
            if (sendError) throw sendError;
            return sendResult;
          }
        };
      }
    }
  }
};

require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    requireSuperAdmin: async req => {
      if (authError) throw new Error(authError);
      if (req.headers.authorization !== 'Bearer admin-token') {
        throw new Error('unauthorized');
      }
      return { uid: 'admin-1' };
    }
  }
};

const handler = require('../api/test-email');

beforeEach(() => {
  authError = null;
  sendError = null;
  sendResult = { data: { id: 'email_test_123' }, error: null };
  capturedPayload = null;
  capturedApiKey = null;
  sendCount = 0;
  process.env.RESEND_API_KEY = 'test-only-key';
  process.env.RESEND_TEST_TO_EMAIL = 'owner@example.com';
});

async function call({ method = 'POST', token = 'admin-token' } = {}) {
  const req = {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {}
  };

  const res = {
    code: 200,
    body: null,
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };

  await handler(req, res);
  return res;
}

test('رفض أي طريقة غير POST: 405', async () => {
  const r = await call({ method: 'GET' });
  assert.equal(r.code, 405);
  assert.equal(sendCount, 0);
});

test('رفض الطلب بدون تسجيل دخول: 401', async () => {
  const r = await call({ token: null });
  assert.equal(r.code, 401);
  assert.equal(sendCount, 0);
});

test('رفض المستخدم غير المصرح له: 403', async () => {
  authError = 'forbidden';
  const r = await call();
  assert.equal(r.code, 403);
  assert.equal(sendCount, 0);
});

test('رفض الإرسال عند غياب مفتاح Resend', async () => {
  delete process.env.RESEND_API_KEY;
  const r = await call();
  assert.equal(r.code, 500);
  assert.equal(r.body.error, 'email_service_not_configured');
  assert.equal(sendCount, 0);
});

test('إرسال الاختبار إلى عنوان Resend التجريبي الثابت فقط', async () => {
  const r = await call();

  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.id, 'email_test_123');
  assert.equal(capturedApiKey, 'test-only-key');
  assert.deepEqual(capturedPayload.to, ['owner@example.com']);
  assert.equal(capturedPayload.from, 'NABDH <onboarding@resend.dev>');
  assert.equal(sendCount, 1);
});

test('اعتبار رفض Resend فشلًا في الإرسال: 502', async () => {
  sendResult = { data: null, error: { message: 'rejected' } };

  const r = await call();

  assert.equal(r.code, 502);
  assert.equal(r.body.error, 'email_send_failed');
});
