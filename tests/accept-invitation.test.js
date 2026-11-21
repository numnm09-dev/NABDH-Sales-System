const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb, createRes } = require('./fake-admin-db');

let db;
let users; // idToken -> decoded token

const firebasePath = require.resolve('../api/_lib/firebase-admin');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: {
    getFirebaseAdmin: async () => ({
      auth: {
        verifyIdToken: async token => {
          if (!users[token]) throw Object.assign(new Error('bad'), { code: 'auth/invalid-id-token' });
          return users[token];
        }
      },
      database: db.database
    })
  }
};

const handler = require('../api/accept-invitation');
const { createInvitationToken, hashInvitationToken } = require('../api/_lib/invitations');

const TOKEN = createInvitationToken();
const ID = 'manager_company-1';

function seed(over = {}, companyOver = {}) {
  db = createFakeDb({
    companies: {
      'company-1': {
        id: 'company-1', name: 'شركة النور', managerEmail: 'manager@example.com',
        managerStatus: 'invited', status: 'pending_manager', ...companyOver
      },
      'company-2': {
        id: 'company-2', name: 'شركة الأمل', managerEmail: 'other@example.com',
        managerStatus: 'invited', status: 'pending_manager'
      }
    },
    invitations: {
      [ID]: {
        id: ID, companyId: 'company-1', email: 'manager@example.com', role: 'MANAGER',
        status: 'sent', deliveryStatus: 'accepted_by_provider',
        tokenHash: hashInvitationToken(TOKEN), expiresAt: Date.now() + 3600e3, ...over
      }
    }
  });
}

beforeEach(() => {
  seed();
  users = {
    'mgr-token': { uid: 'mgr-1', email: 'Manager@Example.com', email_verified: true },
    'unverified-token': { uid: 'mgr-1', email: 'manager@example.com', email_verified: false },
    'other-token': { uid: 'other-9', email: 'someone@else.com', email_verified: true },
    'admin-token': { uid: 'admin-1', email: 'admin@example.com', email_verified: true }
  };
});

async function call({ method = 'POST', token = 'mgr-token', body = { invitationId: ID, token: TOKEN } } = {}) {
  const res = createRes();
  await handler({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
  return res;
}

const untouched = () => {
  assert.equal(db.get('companyMembers'), null);
  assert.equal(db.get('userCompanies'), null);
  assert.equal(db.get('companies/company-1/managerUid'), null);
  assert.equal(db.get('companies/company-1/status'), 'pending_manager');
};

test('رفض غير POST / بلا توكن / توكن Firebase غير صالح', async () => {
  assert.equal((await call({ method: 'GET' })).statusCode, 405);
  assert.equal((await call({ token: null })).statusCode, 401);
  assert.equal((await call({ token: 'garbage' })).statusCode, 401);
  untouched();
});

test('رفض مدخلات بصيغة خاطئة', async () => {
  for (const body of [
    {}, { invitationId: ID }, { invitationId: ID, token: 'short' },
    { invitationId: '../x', token: TOKEN }, { invitationId: 'company-1', token: TOKEN }
  ]) {
    const res = await call({ body });
    assert.equal(res.statusCode, 400);
    assert.equal(res.data.error, 'invalid_invitation');
  }
  untouched();
});

test('رفض البريد غير المؤكَّد ولا تُنشأ عضوية', async () => {
  const res = await call({ token: 'unverified-token' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.data.error, 'email_not_verified');
  untouched();
  assert.equal(db.get(`invitations/${ID}/status`), 'sent');
});

test('رفض توكن دعوة خاطئ أو دعوة غير موجودة: 404', async () => {
  let res = await call({ body: { invitationId: ID, token: createInvitationToken() } });
  assert.equal(res.statusCode, 404);
  res = await call({ body: { invitationId: 'manager_missing', token: TOKEN } });
  assert.equal(res.statusCode, 404);
  untouched();
});

test('مستخدم آخر يملك الرابط لا يستطيع قبول دعوة مخصصة لغيره', async () => {
  const res = await call({ token: 'other-token' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.data.error, 'invitation_email_mismatch');
  untouched();
  assert.equal(db.get(`invitations/${ID}/status`), 'sent');
  assert.equal(db.get(`invitations/${ID}/acceptedBy`), null);
});

test('السوبر أدمن نفسه لا يتجاوز تطابق البريد', async () => {
  const res = await call({ token: 'admin-token' });
  assert.equal(res.data.error, 'invitation_email_mismatch');
  untouched();
});

test('دعوة منتهية: 410، ومسودة/فاشلة/مُلغاة: 409', async () => {
  seed({ expiresAt: Date.now() - 1000 });
  let res = await call();
  assert.equal(res.statusCode, 410);
  untouched();

  for (const status of ['draft', 'send_failed', 'revoked']) {
    seed({ status });
    res = await call();
    assert.equal(res.statusCode, 409);
    assert.equal(res.data.error, 'invitation_not_active');
    untouched();
  }
});

test('النجاح: ربط UID وإنشاء العضوية وتحديث الحالات', async () => {
  const res = await call();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.data, { ok: true, role: 'MANAGER', company: { id: 'company-1', name: 'شركة النور' } });

  const company = db.get('companies/company-1');
  assert.equal(company.managerUid, 'mgr-1');
  assert.equal(company.managerStatus, 'linked');
  assert.equal(company.status, 'active');
  assert.ok(company.managerLinkedAt);

  const member = db.get('companyMembers/company-1/mgr-1');
  assert.equal(member.uid, 'mgr-1');
  assert.equal(member.role, 'MANAGER');
  assert.equal(member.email, 'manager@example.com');
  assert.equal(member.invitationId, ID);

  assert.equal(db.get('userCompanies/mgr-1/company-1').role, 'MANAGER');
  assert.equal(db.get('userCompanies/mgr-1/company-1').name, 'شركة النور');

  // بيانات ERP الخاصة بالشركة هُيِّئت (بنية محرك كاملة باسم الشركة) ولا حساب شخصي أُنشئ للمدير
  const data = db.get('companyData/company-1');
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.settings.company, 'شركة النور');
  const Engine = require('../js/erp-ops2.js');
  assert.deepEqual(Engine.verify(Engine.ensure(data), {}), [], 'بيانات الشركة المهيأة تجتاز فحص سلامة المحرك الكامل');
  assert.equal(db.get('users'), null);
  assert.equal(db.get('companyData/company-2'), null);

  const invitation = db.get(`invitations/${ID}`);
  assert.equal(invitation.status, 'accepted');
  assert.equal(invitation.acceptedBy, 'mgr-1');
  assert.ok(invitation.acceptedAt);

  // لا ارتباط بالشركة الأخرى ولا تغيير عليها
  assert.equal(db.get('companyMembers/company-2'), null);
  assert.equal(db.get('companies/company-2/status'), 'pending_manager');
  assert.equal(db.get('companies/company-2/managerUid'), null);
  assert.equal(db.get('userCompanies/mgr-1/company-2'), null);
});

test('منع إعادة الاستخدام: نفس المدير ثم شخص آخر', async () => {
  assert.equal((await call()).statusCode, 200);
  const before = db.dump();

  let res = await call();
  assert.equal(res.statusCode, 409);
  assert.equal(res.data.error, 'invitation_already_used');

  res = await call({ token: 'other-token' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.data.error, 'invitation_already_used');

  assert.deepEqual(db.dump(), before);
});

test('طلبان متزامنان لنفس الدعوة: واحد ينجح والآخر يُرفض وعضوية واحدة فقط', async () => {
  const [a, b] = await Promise.all([call(), call()]);
  const codes = [a.statusCode, b.statusCode].sort();

  assert.deepEqual(codes, [200, 409]);
  assert.equal(Object.keys(db.get('companyMembers/company-1')).length, 1);
  assert.equal(db.get(`invitations/${ID}/status`), 'accepted');
});

test('فشل الكتابة النهائية يُرجع الحجز ولا يترك عضوية، ثم تنجح إعادة المحاولة', async () => {
  db.hooks.failUpdate = true;
  let res = await call();

  assert.equal(res.statusCode, 500);
  assert.equal(res.data.error, 'invitation_accept_failed');
  assert.ok(!JSON.stringify(res.data).includes('simulated'));
  untouched();
  assert.equal(db.get(`invitations/${ID}/status`), 'sent');

  db.hooks.failUpdate = false;
  res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(db.get('companies/company-1/managerUid'), 'mgr-1');
});

test('حجز قديم عالق لنفس المستخدم يُستأنف، أما لمستخدم آخر أو حديث فيُرفض', async () => {
  seed({ status: 'accepting', acceptedBy: 'mgr-1', acceptingAt: Date.now() });
  assert.equal((await call()).data.error, 'invitation_accept_in_progress');

  seed({ status: 'accepting', acceptedBy: 'someone-else', acceptingAt: Date.now() - 10 * 60e3 });
  assert.equal((await call()).data.error, 'invitation_accept_in_progress');

  seed({ status: 'accepting', acceptedBy: 'mgr-1', acceptingAt: Date.now() - 10 * 60e3 });
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(db.get('companies/company-1/managerUid'), 'mgr-1');
});

test('الشركة تغيّر بريدها أو لم تعد بانتظار مدير: 409 دون أي حجز', async () => {
  seed({}, { managerEmail: 'new@example.com' });
  let res = await call();
  assert.equal(res.statusCode, 409);
  assert.equal(res.data.error, 'company_not_waiting_for_manager');
  assert.equal(db.get(`invitations/${ID}/status`), 'sent');

  seed({}, { status: 'active', managerUid: 'x' });
  res = await call();
  assert.equal(res.data.error, 'company_not_waiting_for_manager');
  assert.equal(db.get('companyMembers'), null);
});

test('بريد من خارج الدعوة بنفس UID لا يمر حتى لو التوكن صحيح', async () => {
  users['mgr-token'] = { uid: 'mgr-1', email: 'attacker@evil.com', email_verified: true };
  const res = await call();
  assert.equal(res.data.error, 'invitation_email_mismatch');
  untouched();
});

/* ---------- التزام ملتبس (commit-then-timeout) والمصالحة ---------- */
const { describeState, readLinkState } = require('../api/_lib/reconcile');

async function consistent() {
  const state = await readLinkState(db.database, 'company-1');
  return describeState(state).issues;
}

test('دعوة في send_pending يحملها صاحبها بتوكن صحيح تُقبل (تعذّر تسجيل sent بعد الإرسال)', async () => {
  seed({ status: 'send_pending', sendStartedAt: Date.now() });
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await consistent(), []);
});

test('الكتابة النهائية حُفظت ثم انقطع الإقرار: النتيجة نجاح والحالة متسقة بلا إرجاع للحجز', async () => {
  db.hooks.update = 'after';
  const res = await call();

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.ok, true);
  assert.equal(db.get(`invitations/${ID}/status`), 'accepted');
  assert.equal(db.get('companies/company-1/managerUid'), 'mgr-1');
  assert.equal(db.get('companyMembers/company-1/mgr-1').role, 'MANAGER');
  assert.deepEqual(await consistent(), []);

  // إعادة الاستخدام ما زالت ممنوعة، لكن صاحب الربط يُخبَر أن ربطه قائم
  db.hooks.update = null;
  const again = await call();
  assert.equal(again.statusCode, 409);
  assert.equal(again.data.error, 'invitation_already_used');
  assert.equal(again.data.linkedToYou, true);
  assert.equal(Object.keys(db.get('companyMembers/company-1')).length, 1);
});

test('الكتابة النهائية حُفظت ثم انقطع الإقرار وفشلت قراءة التحقق: 500 لكن لا تضارب ولا استخدام ثانٍ', async () => {
  let armed = false;
  // القراءة الأولى (فحص الشركة) تنجح؛ بعد الكتابة الملتبسة تفشل قراءة التحقق
  db.hooks.update = () => { armed = true; return 'after'; };
  db.hooks.get = path => armed && path.startsWith('companies/');

  const res = await call();
  assert.equal(res.statusCode, 500);
  assert.equal(res.data.error, 'invitation_accept_failed');
  assert.ok(!JSON.stringify(res.data).includes('simulated'));

  db.hooks.get = null;
  db.hooks.update = null;
  assert.deepEqual(await consistent(), [], 'الحالة المحفوظة كاملة ومتسقة رغم الخطأ');
  assert.equal(db.get(`invitations/${ID}/status`), 'accepted');

  const again = await call();
  assert.equal(again.statusCode, 409);
  assert.equal(again.data.linkedToYou, true);
});

test('فشل الكتابة مرة واحدة: المحاولة الداخلية تُكمل الربط بنجاح', async () => {
  let calls = 0;
  db.hooks.update = () => (++calls === 1 ? 'before' : null);

  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(calls, 2);
  assert.deepEqual(await consistent(), []);
  assert.equal(Object.keys(db.get('companyMembers/company-1')).length, 1);
});

test('فشل الكتابة دائمًا: يُرجَع الحجز، ولا ربط ولا عضوية، وتنجح إعادة المحاولة لاحقًا', async () => {
  db.hooks.update = 'before';
  const res = await call();

  assert.equal(res.statusCode, 500);
  assert.equal(db.get(`invitations/${ID}/status`), 'sent');
  assert.equal(db.get(`invitations/${ID}/acceptedBy`), null);
  assert.equal(db.get('companyMembers'), null);
  assert.equal(db.get('userCompanies'), null);
  assert.equal(db.get('companies/company-1/managerUid'), null);
  assert.equal(db.get('companies/company-1/status'), 'pending_manager');

  db.hooks.update = null;
  assert.equal((await call()).statusCode, 200);
  assert.deepEqual(await consistent(), []);
});

test('الحجز نفسه حُفظ ثم انقطع الإقرار: يُحاول إرجاعه وتنجح إعادة المحاولة فورًا', async () => {
  let n = 0;
  db.hooks.transaction = path => (path.startsWith('invitations/') && ++n === 1 ? 'after' : null);

  const first = await call();
  assert.equal(first.statusCode, 500);
  assert.equal(db.get(`invitations/${ID}/status`), 'sent', 'أُرجع الحجز');
  assert.equal(db.get('companyMembers'), null);

  const second = await call();
  assert.equal(second.statusCode, 200);
  assert.deepEqual(await consistent(), []);
});

test('الحجز حُفظ وفشل إرجاعه أيضًا: يبقى محجوزًا لصاحبه ويُستأنف بعد المهلة دون مساس بغيره', async () => {
  let n = 0;
  db.hooks.transaction = path => {
    if (!path.startsWith('invitations/')) return null;
    n += 1;
    return n === 1 ? 'after' : 'before';
  };

  assert.equal((await call()).statusCode, 500);
  assert.equal(db.get(`invitations/${ID}/status`), 'accepting');
  assert.equal(db.get(`invitations/${ID}/acceptedBy`), 'mgr-1');
  assert.equal(db.get('companyMembers'), null);
  db.hooks.transaction = null;

  // خلال المهلة: لا استئناف، ولا لأي مستخدم آخر
  assert.equal((await call()).data.error, 'invitation_accept_in_progress');
  assert.equal((await call({ token: 'other-token' })).statusCode, 409);

  // بعد انتهاء المهلة: صاحب الحجز فقط يُكمل
  db.set(`invitations/${ID}/acceptingAt`, Date.now() - 10 * 60e3);
  assert.equal((await call({ token: 'other-token' })).statusCode, 409);
  assert.equal((await call()).statusCode, 200);
  assert.deepEqual(await consistent(), []);
});

test('عطل في القراءة بعد فشل الكتابة لا يُرجع الحجز بالتخمين (حالة غير معروفة)', async () => {
  let armed = false;
  db.hooks.update = () => { armed = true; return 'before'; };
  db.hooks.get = path => armed && path.startsWith('invitations/');

  const res = await call();
  assert.equal(res.statusCode, 500);
  // لم يُعلَن نجاح ولم تُكتب عضوية، والحجز باقٍ لصاحبه (لا إرجاع بلا دليل)
  assert.equal(db.get('companyMembers'), null);
  assert.equal(db.get(`invitations/${ID}/status`), 'accepting');
});

test('مصالحة عند الدخول: ربط مكتمل لكن الدعوة ما زالت accepting فتُستكمل دون استخدام جديد', async () => {
  seed({ status: 'accepting', acceptedBy: 'mgr-1', acceptedEmail: 'manager@example.com', acceptingAt: Date.now() });
  db.set('companies/company-1/managerUid', 'mgr-1');
  db.set('companies/company-1/managerStatus', 'linked');
  db.set('companies/company-1/status', 'active');
  db.set('companyMembers/company-1/mgr-1', { uid: 'mgr-1', email: 'manager@example.com', role: 'MANAGER', status: 'active' });
  db.set('userCompanies/mgr-1/company-1', { companyId: 'company-1', role: 'MANAGER' });

  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(db.get(`invitations/${ID}/status`), 'accepted');
  assert.ok(db.get('companyData/company-1'), 'اكتملت بيانات الشركة الناقصة');
  assert.deepEqual(await consistent(), []);
});

test('لا يُكتب فوق مدير آخر مربوط بالشركة أبدًا', async () => {
  seed({ status: 'accepting', acceptedBy: 'mgr-1', acceptedEmail: 'manager@example.com', acceptingAt: Date.now() });
  db.set('companies/company-1/managerUid', 'someone-else');
  db.set('companies/company-1/status', 'active');

  const res = await call();
  assert.notEqual(res.statusCode, 200);
  assert.equal(db.get('companies/company-1/managerUid'), 'someone-else');
  assert.equal(db.get('companyMembers'), null);
});

test('بيانات شركة قائمة لا تُستبدل عند القبول', async () => {
  db.set('companyData/company-1', { schemaVersion: 2, marker: 'keep-me', settings: { company: 'x' } });
  assert.equal((await call()).statusCode, 200);
  assert.equal(db.get('companyData/company-1/marker'), 'keep-me');
});
