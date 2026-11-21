// اختبار صفحة قبول الدعوة الفعلية (accept-invitation/index.html + accept.js) بلا متصفح:
// يُحمَّل accept.js الحقيقي داخل بيئة معزولة (vm) مع بدائل DOM وFirebase وfetch.
// لا يثبت سلوك المتصفح الحقيقي (التخطيط، تركيز الحقول)؛ هذه تُجرَّب يدويًا.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'accept-invitation/index.html'), 'utf8');
const code = fs.readFileSync(path.join(root, 'accept-invitation/accept.js'), 'utf8');

const INV = 'manager_company-1';
const TOKEN = 'A'.repeat(43);

function element() {
  const handlers = {};
  return {
    hidden: false, textContent: '', value: '', disabled: false, handlers,
    addEventListener(type, fn) { handlers[type] = fn; }
  };
}

function boot({ hash = `#i=${INV}&t=${TOKEN}`, fetchImpl, user = null, firebase = true } = {}) {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const els = Object.fromEntries(ids.map(id => [id, element()]));
  const logs = [];
  const store = {};
  const replaced = [];
  let authCb = null;

  const fb = {
    auth: { currentUser: user },
    onAuthStateChanged: (auth, cb) => { authCb = cb; },
    signInWithEmailAndPassword: async (auth, e, p) => { fb.calls.push(['signIn', e, p]); if (fb.signInError) throw { code: fb.signInError }; },
    createUserWithEmailAndPassword: async (auth, e, p) => { fb.calls.push(['signUp', e, p]); return { user: { email: e } }; },
    sendEmailVerification: async u => { fb.calls.push(['verify', u && u.email]); },
    signOut: async () => { fb.calls.push(['signOut']); },
    reload: async u => { fb.calls.push(['reload']); if (u && u.afterReload) Object.assign(u, u.afterReload); },
    calls: []
  };

  const ctx = {
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
    URLSearchParams,
    JSON, Promise, String, Object,
    location: { hash, pathname: '/accept-invitation/', search: '' },
    history: { replaceState: (...a) => replaced.push(a) },
    document: { getElementById: id => els[id] },
    localStorage: { setItem: (k, v) => { store[k] = v; }, getItem: k => store[k] },
    fetch: fetchImpl || (async () => { throw new Error('fetch not expected'); })
  };
  ctx.window = ctx;
  if (firebase) ctx.NabdhFirebase = fb;
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'accept.js' });

  return { els, fb, ctx, logs, store, replaced, emit: u => { fb.auth.currentUser = u; authCb && authCb(u); } };
}

const reply = (status, data) => async () => ({ ok: status < 400, status, json: async () => data });
const verifiedUser = (over = {}) => ({
  uid: 'mgr-1', email: 'manager@example.com', emailVerified: true,
  getIdToken: async force => (force ? 'fresh-id-token' : 'id-token'), ...over
});

test('الصفحة موجودة ومترابطة: كل id يستعمله accept.js موجود في index.html والسكربتات بالترتيب الصحيح', () => {
  const used = [...code.matchAll(/\$\('([A-Za-z]+)'\)/g)].map(m => m[1]);
  const present = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));

  for (const id of new Set(used)) assert.ok(present.has(id), `id مفقود في الصفحة: ${id}`);
  for (const id of ['status', 'message', 'authForm', 'accountBox']) assert.ok(present.has(id), id);

  const firebaseAt = html.indexOf('../js/firebase-init.js');
  const acceptAt = html.indexOf('src="accept.js"');
  assert.ok(firebaseAt > 0 && acceptAt > firebaseAt, 'firebase-init قبل accept.js');
  assert.ok(html.includes('type="module" src="../js/firebase-init.js"'));
  assert.ok(html.includes('name="referrer" content="no-referrer"'));
  assert.ok(html.includes('dir="rtl"') && html.includes('lang="ar"'));
  assert.ok(!/<script(?![^>]*src)[^>]*>/.test(html), 'لا سكربت مضمَّن');
  assert.ok(fs.existsSync(path.join(root, 'admin/admin.css')), 'ملف التنسيق المرتبط موجود');
  assert.match(html, /id="authForm"[^>]*hidden/);
});

test('يقرأ المعرّف والتوكن من الـ fragment ويمسحهما من شريط العنوان فورًا', () => {
  const t = boot();
  assert.equal(t.replaced.length, 1);
  assert.deepEqual(t.replaced[0], [null, '', '/accept-invitation/']);
  assert.ok(!JSON.stringify(t.replaced).includes(TOKEN), 'التوكن ليس في العنوان');
  assert.equal(t.ctx.location.search, '', 'لا توكن في query string');
});

test('رابط ناقص أو بصيغة خاطئة: رسالة واضحة ولا نماذج دخول ولا طلبات', () => {
  for (const hash of ['', '#i=manager_c1', `#t=${TOKEN}`, `#i=../x&t=${TOKEN}`, `#i=${INV}&t=short`]) {
    const t = boot({ hash });
    assert.ok(t.els.status.textContent.includes('رابط الدعوة غير صالح'), hash);
    assert.equal(t.els.authForm.hidden, false, 'لم يُغيَّر hidden الافتراضي من الصفحة نفسها');
    assert.equal(t.fb.calls.length, 0);
  }
});

test('Firebase غير محمَّل: رسالة خطأ بدل انهيار', () => {
  const t = boot({ firebase: false });
  assert.ok(t.els.status.textContent.includes('تحميل Firebase'));
  assert.equal(t.fb.calls.length, 0);
});

test('غير مسجَّل: يظهر نموذج الدخول؛ تسجيل الدخول يمرّر البريد وكلمة المرور؛ الخطأ برسالة عربية', async () => {
  const t = boot();
  t.emit(null);
  assert.equal(t.els.authForm.hidden, false);
  assert.equal(t.els.accountBox.hidden, true);

  t.els.email.value = ' manager@example.com ';
  t.els.password.value = 'secret1';
  await t.els.authForm.handlers.submit({ preventDefault() {} });
  assert.deepEqual(t.fb.calls[0], ['signIn', 'manager@example.com', 'secret1']);

  t.fb.signInError = 'auth/invalid-credential';
  await t.els.authForm.handlers.submit({ preventDefault() {} });
  assert.ok(t.els.message.textContent.includes('غير صحيحة'));
});

test('إنشاء حساب: يُنشئ ثم يُرسل رسالة تأكيد البريد، ويرفض كلمة مرور قصيرة', async () => {
  const t = boot();
  t.emit(null);

  t.els.email.value = 'manager@example.com';
  t.els.password.value = '123';
  await t.els.signUpBtn.handlers.click();
  assert.equal(t.fb.calls.length, 0);
  assert.ok(t.els.message.textContent.includes('6 أحرف'));

  t.els.password.value = 'secret1';
  await t.els.signUpBtn.handlers.click();
  assert.deepEqual(t.fb.calls.map(c => c[0]), ['signUp', 'verify']);
  assert.ok(t.els.message.textContent.includes('رسالة تأكيد'));
});

test('مسجَّل لكن بريده غير مؤكَّد: لا يُرسَل أي طلب قبول، وزر إعادة إرسال التأكيد يظهر', async () => {
  const user = verifiedUser({ emailVerified: false });
  const t = boot({ user });
  t.emit(user);
  assert.equal(t.els.resendVerifyBtn.hidden, false);
  assert.equal(t.els.accountBox.hidden, false);

  await t.els.acceptBtn.handlers.click();
  assert.ok(t.els.message.textContent.includes('لم يتأكد'));
  assert.ok(t.fb.calls.some(c => c[0] === 'reload'));
});

test('القبول: POST إلى /api/accept-invitation بتوكن Firebase حديث وجسم صحيح، دون التوكن في العنوان', async () => {
  const requests = [];
  const user = verifiedUser();
  const t = boot({
    user,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ ok: true, role: 'MANAGER', company: { id: 'company-1', name: 'شركة النور' } }) };
    }
  });
  t.emit(user);

  await t.els.acceptBtn.handlers.click();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/accept-invitation');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer fresh-id-token');
  assert.deepEqual(JSON.parse(requests[0].init.body), { invitationId: INV, token: TOKEN });
  assert.ok(!requests[0].url.includes(TOKEN), 'التوكن ليس في الـ URL');

  assert.ok(t.els.status.textContent.includes('شركة النور'));
  assert.equal(t.els.accountBox.hidden, true);
  assert.equal(t.els.appLink.hidden, false);
  assert.equal(t.store['nabdh.scope.mgr-1'], 'company-1', 'يفتح التطبيق على الشركة بعد الربط');
  assert.equal(t.els.acceptBtn.disabled, false);
});

test('أخطاء الخادم تُترجم لرسائل عربية ولا يُسرَّب توكن ولا تفاصيل داخلية', async () => {
  const cases = [
    [403, 'invitation_email_mismatch', 'مخصصة لبريد إلكتروني آخر'],
    [410, 'invitation_expired', 'انتهت صلاحية الدعوة'],
    [409, 'invitation_already_used', 'استُخدمت من قبل'],
    [409, 'invitation_accept_in_progress', 'عملية قبول جارية'],
    [404, 'invalid_invitation', 'غير صالح'],
    [403, 'email_not_verified', 'تأكيد بريدك'],
    [500, 'invitation_accept_failed', 'أعد المحاولة'],
    [401, 'unauthorized', 'انتهت جلسة']
  ];

  for (const [status, error, expected] of cases) {
    const user = verifiedUser();
    const t = boot({ user, fetchImpl: reply(status, { ok: false, error }) });
    t.emit(user);
    await t.els.acceptBtn.handlers.click();

    assert.ok(t.els.message.textContent.includes(expected), `${error}: ${t.els.message.textContent}`);
    assert.equal(t.els.accountBox.hidden, false, 'يبقى صندوق الحساب ظاهرًا لإعادة المحاولة');
    assert.equal(t.store['nabdh.scope.mgr-1'], undefined, 'لا تفضيل شركة بعد فشل');
    assert.ok(!t.els.message.textContent.includes(TOKEN));
    assert.ok(!t.logs.join('\n').includes(TOKEN));
  }
});

test('دعوة مستخدمة سابقًا من نفس المستخدم (linkedToYou): يُخبَر أن ربطه قائم دون إعادة استخدام', async () => {
  const user = verifiedUser();
  const t = boot({ user, fetchImpl: reply(409, { ok: false, error: 'invitation_already_used', linkedToYou: true }) });
  t.emit(user);
  await t.els.acceptBtn.handlers.click();

  assert.ok(t.els.status.textContent.includes('مربوط بالشركة بالفعل'));
  assert.equal(t.els.appLink.hidden, false);
});

test('انقطاع الشبكة: رسالة عامة والزر يعود قابلًا للاستعمال، والتوكن لا يظهر في السجلات', async () => {
  const user = verifiedUser();
  const t = boot({ user, fetchImpl: async () => { throw new Error(`network down ${TOKEN}`); } });
  t.emit(user);
  await t.els.acceptBtn.handlers.click();

  assert.ok(t.els.message.textContent.includes('حدث خطأ أثناء الاتصال'));
  assert.equal(t.els.acceptBtn.disabled, false);
  assert.ok(!t.els.message.textContent.includes(TOKEN));
});

test('تسجيل الخروج واستخدام حساب آخر يستدعي signOut', async () => {
  const user = verifiedUser();
  const t = boot({ user });
  t.emit(user);
  await t.els.signOutBtn.handlers.click();
  assert.deepEqual(t.fb.calls.at(-1), ['signOut']);
});

const STAFF_INV = 'staff_company-1_AbCdEfGhIjKlMnOpQrStUvWx';

test('دعوة موظف: الرابط صالح، والجسم يحمل معرّف الدعوة كما هو، والنجاح يعرض الدور ويحفظ معرّف الشركة من رد الخادم', async () => {
  const requests = [];
  const user = verifiedUser();
  const t = boot({
    hash: `#i=${STAFF_INV}&t=${TOKEN}`,
    user,
    fetchImpl: async (url, init) => { requests.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true, role: 'ACCOUNTANT', company: { id: 'company-1', name: 'شركة النور' } }) }; }
  });
  t.emit(user);
  assert.ok(!t.els.status.textContent.includes('غير صالح'), 'رابط الموظف مقبول');

  await t.els.acceptBtn.handlers.click();
  assert.deepEqual(requests[0], { invitationId: STAFF_INV, token: TOKEN });
  assert.ok(t.els.status.textContent.includes('شركة النور') && t.els.status.textContent.includes('محاسب'), t.els.status.textContent);
  assert.equal(t.store['nabdh.scope.mgr-1'], 'company-1', 'من رد الخادم لا من معرّف الدعوة');
});

test('دعوة موظف مستخدمة سابقًا من صاحبها: يُحفظ معرّف الشركة القادم من الخادم (لا يُشتق من معرّف الدعوة)', async () => {
  const user = verifiedUser();
  const t = boot({ hash: `#i=${STAFF_INV}&t=${TOKEN}`, user, fetchImpl: reply(409, { ok: false, error: 'invitation_already_used', linkedToYou: true, companyId: 'company-1' }) });
  t.emit(user);
  await t.els.acceptBtn.handlers.click();
  assert.ok(t.els.status.textContent.includes('مربوط بالشركة بالفعل'));
  assert.equal(t.store['nabdh.scope.mgr-1'], 'company-1');
});

test('أخطاء دعوة الموظف الخاصة: عضو بالفعل وشركة غير فعّالة', async () => {
  for (const [error, expected] of [['already_member', 'عضو بالفعل'], ['company_not_active', 'غير فعّالة']]) {
    const user = verifiedUser();
    const t = boot({ hash: `#i=${STAFF_INV}&t=${TOKEN}`, user, fetchImpl: reply(409, { ok: false, error }) });
    t.emit(user);
    await t.els.acceptBtn.handlers.click();
    assert.ok(t.els.message.textContent.includes(expected), error);
  }
});

test('رابط بمعرّف من نوع غير معروف أو بمحارف غير مسموحة يُرفض', () => {
  for (const id of ['admin_x', 'staff_', 'staff_../x', 'manager_a b']) {
    const t = boot({ hash: `#i=${id}&t=${TOKEN}` });
    assert.ok(t.els.status.textContent.includes('رابط الدعوة غير صالح'), id);
  }
});
