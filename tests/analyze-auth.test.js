// /api/analyze خدمة مكلفة (مزوّد ذكاء اصطناعي مدفوع): يجب أن تُحمى من الطلبات المباشرة المجهولة وإساءة الاستخدام.
// الاختبارات هنا بمحاكاة Firebase Admin ومزوّد وهمي؛ لا تثبت اتصالًا فعليًا بـ Firebase أو Gemini.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./fake-admin-db');

let fdb;
const tokens = {
  'tok-a': { uid: 'user-a', email: 'a@example.com', email_verified: true },
  'tok-b': { uid: 'user-b', email: 'b@example.com', email_verified: true },
  'tok-unverified': { uid: 'user-c', email: 'c@example.com', email_verified: false }
};

const firebasePath = require.resolve('../api/_lib/firebase-admin');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: {
    getFirebaseAdmin: async () => ({
      auth: { verifyIdToken: async t => { if (!tokens[t]) throw Object.assign(new Error('bad'), { code: 'auth/invalid-id-token' }); return tokens[t]; } },
      database: fdb.database
    })
  }
};

const handler = require('../api/analyze.js');
const { consumeRateLimit } = require('../api/_lib/rate-limit');
const data = require('../data/sample-data.json');

const body = () => ({ itemId: 'i1', delay: 10, safety: 3, items: data.items, suppliers: data.suppliers, orders: data.orders });
const real = global.fetch;
let providerCalls;
let lastProviderRequest;

async function call({ token, b = body(), method = 'POST', headers = {} } = {}) {
  let code, out; const h = {};
  const res = { setHeader: (k, v) => { h[k] = v; }, status: c => { code = c; return res; }, json: j => { out = j; return res; }, end: () => res };
  const hdr = { ...headers }; if (token) hdr.authorization = `Bearer ${token}`;
  await handler({ method, body: b, headers: hdr }, res);
  return { code, out, h };
}

beforeEach(() => {
  fdb = createFakeDb();
  providerCalls = 0;
  lastProviderRequest = null;
  process.env.GEMINI_API_KEY = 'unit-test-key-not-real';
  process.env.AI_MODEL = 'test-model';
  delete process.env.ALLOWED_ORIGIN;
  global.fetch = async (url, init) => {
    providerCalls += 1;
    lastProviderRequest = { url, init };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'ملخص' }) }] } }] }) };
  };
});
after(() => { global.fetch = real; });

test('بلا توكن: 401 ولا يُستدعى المزوّد المدفوع أبدًا', async () => {
  const r = await call({});
  assert.equal(r.code, 401);
  assert.equal(r.out.code, 'unauthorized');
  assert.equal(providerCalls, 0);
});

test('ping بلا توكن أيضًا 401 (كان يستهلك المزوّد دون مصادقة)', async () => {
  const r = await call({ b: { ping: true } });
  assert.equal(r.code, 401);
  assert.equal(providerCalls, 0);
});

test('توكن غير صالح أو بصيغة خاطئة: 401', async () => {
  assert.equal((await call({ token: 'garbage' })).code, 401);
  const r = await call({ headers: { authorization: 'Basic abc' } });
  assert.equal(r.code, 401);
  assert.equal(providerCalls, 0);
});

test('بريد غير مؤكَّد: 403 ولا استدعاء للمزوّد', async () => {
  const r = await call({ token: 'tok-unverified' });
  assert.equal(r.code, 403);
  assert.equal(r.out.code, 'email_not_verified');
  assert.equal(providerCalls, 0);
});

test('مستخدم موثَّق: ينجح الطلب، والمفتاح يذهب في ترويسة لا في عنوان الطلب', async () => {
  const r = await call({ token: 'tok-a' });
  assert.equal(r.code, 200);
  assert.equal(providerCalls, 1);
  assert.ok(!/key=/i.test(lastProviderRequest.url), 'المفتاح يجب ألا يظهر في العنوان');
  assert.ok(!lastProviderRequest.url.includes('unit-test-key-not-real'));
  assert.equal(lastProviderRequest.init.headers['x-goog-api-key'], 'unit-test-key-not-real');
});

test('تحديد المعدّل: الطلب 21 في الدقيقة يُرفض 429 مع Retry-After ولا يصل للمزوّد', async () => {
  for (let i = 0; i < 20; i += 1) assert.equal((await call({ token: 'tok-a' })).code, 200, `الطلب ${i + 1}`);
  const before = providerCalls;
  const blocked = await call({ token: 'tok-a' });
  assert.equal(blocked.code, 429);
  assert.equal(blocked.out.code, 'too_many_requests');
  assert.ok(Number(blocked.h['Retry-After']) >= 1);
  assert.equal(providerCalls, before, 'الطلب المحجوب لا يستهلك المزوّد');
});

test('تحديد المعدّل لكل مستخدم على حدة: استنفاد مستخدم لا يحجب غيره', async () => {
  for (let i = 0; i < 21; i += 1) await call({ token: 'tok-a' });
  assert.equal((await call({ token: 'tok-a' })).code, 429);
  assert.equal((await call({ token: 'tok-b' })).code, 200);
});

test('consumeRateLimit: تُفتح نافذة جديدة بعد انقضاء المدة، وتُرفض المفاتيح غير الآمنة', async () => {
  const { database } = await require('../api/_lib/firebase-admin').getFirebaseAdmin();
  const rule = { limit: 2, windowMs: 1000 };
  assert.equal((await consumeRateLimit(database, 'b1', 'u', { ...rule, now: 10_000 })).allowed, true);
  assert.equal((await consumeRateLimit(database, 'b1', 'u', { ...rule, now: 10_100 })).allowed, true);
  const denied = await consumeRateLimit(database, 'b1', 'u', { ...rule, now: 10_200 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSec, 1);
  assert.equal((await consumeRateLimit(database, 'b1', 'u', { ...rule, now: 11_001 })).allowed, true);
  await assert.rejects(() => consumeRateLimit(database, 'b1', '../users/x', { ...rule }), /invalid_rate_limit_key/);
  await assert.rejects(() => consumeRateLimit(database, 'b1', 'u', { limit: 0, windowMs: 1000 }), /invalid_rate_limit_config/);
});

test('عطل مخزن العدّاد: الفشل مغلق (لا يُستدعى المزوّد المدفوع)', async () => {
  fdb.hooks.transaction = () => 'before';
  const r = await call({ token: 'tok-a' });
  assert.equal(r.code, 500);
  assert.equal(providerCalls, 0);
});

test('رسائل خطأ المزوّد لا تُسرَّب للعميل (تُسجَّل في الخادم فقط)', async () => {
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'INTERNAL-PROVIDER-DETAIL project=secret-project-123' } }) });
  const log = console.error; console.error = () => { };
  try {
    const r = await call({ token: 'tok-a' });
    assert.equal(r.code, 502);
    assert.ok(!JSON.stringify(r.out).includes('secret-project-123'));
  } finally { console.error = log; }
});

test('CORS: طلب preflight لا يتطلب توكنًا لكنه يعلن ترويسة Authorization', async () => {
  process.env.ALLOWED_ORIGIN = 'https://ok.example';
  const r = await call({ method: 'OPTIONS', headers: { origin: 'https://ok.example' } });
  assert.equal(r.code, 204);
  assert.match(r.h['Access-Control-Allow-Headers'], /Authorization/);
  assert.equal(providerCalls, 0);
});
