// تشخيص وإصلاح دخول Super Admin. الاختبارات هنا بمحاكاة Firebase Admin (والجزء المذكور صراحةً يستخدم مكتبة firebase-admin الحقيقية دون شبكة)؛
// لا تثبت شيئًا عن Firebase الحقيقي أو Vercel Production.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let verifyToken;
let adminFactory;
const firebasePath = require.resolve('../api/_lib/firebase-admin');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { getFirebaseAdmin: async () => (adminFactory ? adminFactory() : { auth: { verifyIdToken: (...a) => verifyToken(...a) } }) }
};
const handler = require('../api/admin-check');

const call = async (method = 'GET', authorization) => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method, headers: authorization ? { authorization } : {} }, res);
  return res;
};

let logs;
const realError = console.error;
beforeEach(() => {
  process.env.SUPER_ADMIN_UID = 'AdminUid123abcDEF456ghiJKL789';
  verifyToken = async () => ({ uid: 'AdminUid123abcDEF456ghiJKL789', email: 'nabdh.erp@gmail.com', email_verified: true });
  adminFactory = null;
  logs = [];
  console.error = (...a) => logs.push(a.join(' '));
});
test.after(() => { console.error = realError; });

test('Super Admin الصحيح: 200 و role=SUPER_ADMIN، ويُستدعى التحقق مع فحص الإبطال', async () => {
  let revoked;
  verifyToken = async (t, r) => { revoked = r; return { uid: 'AdminUid123abcDEF456ghiJKL789' }; };
  const r = await call('GET', 'Bearer good');
  assert.equal(r.code, 200);
  assert.equal(r.body.role, 'SUPER_ADMIN');
  assert.equal(revoked, true);
  assert.equal(logs.length, 0);
});

test('قيمة SUPER_ADMIN_UID بمسافة أو سطر جديد زائد (خطأ لصق شائع) لا تحجب المدير الحقيقي', async () => {
  for (const v of ['AdminUid123abcDEF456ghiJKL789\n', ' AdminUid123abcDEF456ghiJKL789 ', 'AdminUid123abcDEF456ghiJKL789\r\n']) {
    process.env.SUPER_ADMIN_UID = v;
    assert.equal((await call('GET', 'Bearer good')).code, 200, JSON.stringify(v));
  }
});

test('رفض آمن: المتغير غائب أو فارغ أو مسافات فقط → 403 (لا يُمنح أحد)', async () => {
  for (const v of [undefined, '', '   ', '\n']) {
    if (v === undefined) delete process.env.SUPER_ADMIN_UID; else process.env.SUPER_ADMIN_UID = v;
    verifyToken = async () => ({ uid: '' });
    assert.equal((await call('GET', 'Bearer good')).code, 403);
    verifyToken = async () => ({ uid: 'AdminUid123abcDEF456ghiJKL789' });
    assert.equal((await call('GET', 'Bearer good')).code, 403);
  }
});

test('الصلاحية لا تُمنح بالبريد وحده، ولا بـ UID مختلف أو مشابه (حالة أحرف/بادئة/لاحقة)', async () => {
  for (const uid of ['someone-else', 'adminuid123abcdef456ghijkl789', 'AdminUid123abcDEF456ghiJKL78', 'AdminUid123abcDEF456ghiJKL789x', 'x AdminUid123abcDEF456ghiJKL789']) {
    verifyToken = async () => ({ uid, email: 'nabdh.erp@gmail.com', email_verified: true });
    const r = await call('GET', 'Bearer good');
    assert.equal(r.code, 403, uid);
    assert.equal(r.body.role, undefined);
  }
});

test('غياب التوكن، أو صيغة غير Bearer: 401 ولا يُستدعى Firebase', async () => {
  let called = false; verifyToken = async () => { called = true; return {}; };
  assert.equal((await call('GET')).code, 401);
  assert.equal((await call('GET', 'Basic abc')).code, 401);
  assert.equal(called, false);
});

test('توكن غير صالح/منتهٍ/مُبطَل/مستخدم معطّل: 401، ويُسجَّل السبب الأصلي في الخادم دون إرساله للعميل', async () => {
  for (const code of ['auth/argument-error', 'auth/invalid-id-token', 'auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled']) {
    logs = [];
    verifyToken = async () => { const e = new Error('Firebase ID token has incorrect "aud" claim. Expected "A" but got "B"'); e.code = code; throw e; };
    const r = await call('GET', 'Bearer bad');
    assert.equal(r.code, 401, code);
    assert.deepEqual(r.body, { ok: false, error: 'unauthorized' });
    assert.match(logs[0], new RegExp(code.replace('/', '\\/')));
    assert.match(logs[0], /"result":"unauthorized"/);
  }
});

test('أعطال Firebase Admin/الإعداد: 500 برد عام آمن، والسبب الحقيقي في السجل مع حجب أي JWT', async () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
  for (const err of [
    Object.assign(new Error('missing_config:GCP_PROJECT_ID,GCP_PROJECT_NUMBER'), {}),
    Object.assign(new Error(`Credential implementation provided to initializeApp() failed to fetch a valid Google OAuth2 access token. token=${jwt}`), { code: 'app/invalid-credential' }),
    Object.assign(new Error('Permission denied'), { code: 'auth/insufficient-permission' }),
    Object.assign(new Error('network'), { code: 'app/network-error' })
  ]) {
    logs = [];
    verifyToken = async () => { throw err; };
    const r = await call('GET', 'Bearer good');
    assert.equal(r.code, 500);
    assert.deepEqual(r.body, { ok: false, error: 'authentication_failed' });
    assert.match(logs[0], /"result":"server_error"/);
    assert.ok(!logs[0].includes(jwt), 'JWT يجب أن يُحجب من السجل');
  }
  // وفشل تهيئة Firebase Admin نفسه (قبل التحقق من التوكن)
  logs = [];
  adminFactory = () => { throw new Error('missing_config:GCP_PROJECT_ID'); };
  const r = await call('GET', 'Bearer good');
  assert.equal(r.code, 500);
  assert.match(logs[0], /missing_config:GCP_PROJECT_ID/);
  assert.ok(!JSON.stringify(r.body).includes('GCP_PROJECT_ID'), 'اسم المتغير لا يصل للعميل');
});

test('عدم تطابق UID: السجل يحوي أطوالًا فقط، ولا يكشف قيمة UID المُعدّ ولا uid المستخدم', async () => {
  process.env.SUPER_ADMIN_UID = 'AdminUid123abcDEF456ghiJKL789 ';
  verifyToken = async () => ({ uid: 'UserUidDIFFERENT000000000000' });
  const r = await call('GET', 'Bearer good');
  assert.equal(r.code, 403);
  assert.match(logs[0], /"result":"forbidden"/);
  assert.match(logs[0], /"configuredRawLength":30/);
  assert.match(logs[0], /"configuredLength":29/);
  assert.ok(!logs[0].includes('AdminUid123') && !logs[0].includes('UserUidDIFFERENT'));
});

test('طريقة غير GET: 405 (POST/PUT/DELETE/OPTIONS...) دون أي تحقق', async () => {
  let called = false; verifyToken = async () => { called = true; return { uid: 'AdminUid123abcDEF456ghiJKL789' }; };
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) assert.equal((await call(m, 'Bearer good')).code, 405, m);
  assert.equal(called, false);
});

test('[مكتبة firebase-admin الحقيقية دون شبكة] اختلاف GCP_PROJECT_ID عن مشروع Firebase للتوكن → auth/argument-error → 401', async () => {
  const { initializeApp } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = `${b64({ alg: 'RS256', kid: 'k', typ: 'JWT' })}.${b64({ aud: 'nabdh-erp', iss: 'https://securetoken.google.com/nabdh-erp', sub: 'AdminUid123abcDEF456ghiJKL789', iat: 1, exp: 9999999999, auth_time: 1 })}.sig`;
  const app = initializeApp({ credential: { getAccessToken: async () => { throw new Error('no network in tests'); } }, projectId: 'a-different-gcp-project' }, 'diag-probe');
  adminFactory = () => ({ auth: getAuth(app) });
  const r = await call('GET', `Bearer ${token}`);
  assert.equal(r.code, 401);
  assert.match(logs[0], /auth\/argument-error/);
  assert.match(logs[0], /incorrect \\"aud\\"/);
  assert.match(logs[0], /a-different-gcp-project/);
});

/* ---------- الواجهة: رسائل مميزة لكل حالة ---------- */
function runAdminUi(status, body) {
  const els = new Map();
  const stub = () => ({ hidden: true, textContent: '', className: '', value: '', addEventListener() { }, replaceChildren() { }, append() { }, appendChild() { }, setAttribute() { } });
  const doc = { getElementById: id => { if (!els.has(id)) els.set(id, stub()); return els.get(id); }, querySelector: () => { if (!els.has('main')) els.set('main', stub()); return els.get('main'); }, createElement: stub };
  let onAuth;
  const win = { NabdhFirebase: { auth: {}, onAuthStateChanged: (a, cb) => { onAuth = cb; } } };
  const fetchMock = async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const code = fs.readFileSync(path.join(__dirname, '..', 'admin', 'admin.js'), 'utf8');
  vm.runInNewContext(code, { document: doc, window: win, fetch: fetchMock, console: { error() { }, log() { } } });
  return onAuth({ emailVerified: true, getIdToken: async () => 'tok' }).then(() => ({ text: els.get('adminAuthStatus').textContent, panelHidden: els.get('main').hidden }));
}

test('واجهة الإدارة: 403 → رسالة عدم التصريح الأصلية؛ 500 و401 → رسائل مختلفة تدل على الخادم/الجلسة', async () => {
  const forbidden = await runAdminUi(403, { ok: false, error: 'forbidden' });
  assert.match(forbidden.text, /غير مصرح لك بدخول لوحة مدير النظام/);
  const server = await runAdminUi(500, { ok: false, error: 'authentication_failed' });
  assert.match(server.text, /خطأ في إعداد الخادم/);
  assert.doesNotMatch(server.text, /غير مصرح لك/);
  const session = await runAdminUi(401, { ok: false, error: 'unauthorized' });
  assert.match(session.text, /جلسة الدخول/);
  for (const x of [forbidden, server, session]) assert.equal(x.panelHidden, true);
});

test('واجهة الإدارة: ردّ 200 بدور غير SUPER_ADMIN لا يفتح اللوحة', async () => {
  const r = await runAdminUi(200, { ok: true, role: 'MANAGER' });
  assert.match(r.text, /غير مصرح لك/);
  assert.equal(r.panelHidden, true);
});

test('واجهة الإدارة: 200 + SUPER_ADMIN تفتح اللوحة وتحمّل الشركات', async () => {
  const r = await runAdminUi(200, { ok: true, role: 'SUPER_ADMIN', companies: [] });
  assert.match(r.text, /تم التحقق/);
  assert.equal(r.panelHidden, false);
});
