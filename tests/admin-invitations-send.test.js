const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb, createRes } = require('./fake-admin-db');

let db;
let verifyToken;
let mails;
let mailFails;
let mailConfigError;

const firebasePath = require.resolve('../api/_lib/firebase-admin');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: {
    getFirebaseAdmin: async () => ({
      auth: { verifyIdToken: (...a) => verifyToken(...a) },
      database: db.database
    })
  }
};

const mailerPath = require.resolve('../api/_lib/mailer');
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: {
    assertMailConfigured: () => { if (mailConfigError) throw new Error('email_service_not_configured'); },
    sendMail: async payload => {
      if (mailFails) throw new Error('email_send_failed');
      mails.push(payload);
      return { id: 'msg-' + mails.length };
    }
  }
};

process.env.SUPER_ADMIN_UID = 'admin-1';
process.env.APP_BASE_URL = 'https://nabdh.example.com/';

const handler = require('../api/admin-invitations-send');
const { hashInvitationToken } = require('../api/_lib/invitations');

const company = (over = {}) => ({
  id: 'company-1',
  name: 'شركة <النور>',
  managerEmail: 'Manager@Example.com',
  managerStatus: 'pending_invitation',
  status: 'pending_manager',
  ...over
});

beforeEach(() => {
  db = createFakeDb({ companies: { 'company-1': company() } });
  verifyToken = async () => ({ uid: 'admin-1' });
  mails = [];
  mailFails = false;
  mailConfigError = false;
  process.env.APP_BASE_URL = 'https://nabdh.example.com/';
});

async function call({ method = 'POST', token = 'admin-token', body = { companyId: 'company-1' } } = {}) {
  const res = createRes();
  await handler({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
  return res;
}

function tokenFromMail(mail) {
  return decodeURIComponent(mail.text.match(/&t=([A-Za-z0-9_-]{43})/)[1]);
}

test('رفض غير POST / بلا توكن / مستخدم عادي', async () => {
  assert.equal((await call({ method: 'GET' })).statusCode, 405);
  assert.equal((await call({ token: null })).statusCode, 401);
  verifyToken = async () => ({ uid: 'someone' });
  assert.equal((await call()).statusCode, 403);
  assert.equal(mails.length, 0);
});

test('رفض معرّف شركة غير صالح وشركة غير موجودة', async () => {
  assert.equal((await call({ body: { companyId: '../x' } })).data.error, 'invalid_company_id');
  const res = await call({ body: { companyId: 'nope' } });
  assert.equal(res.statusCode, 404);
});

test('رفض شركة لا تنتظر مديرًا أو بريدًا غير صالح', async () => {
  db.set('companies/company-1/status', 'active');
  assert.equal((await call()).data.error, 'company_not_waiting_for_manager');
  db.set('companies/company-1/status', 'pending_manager');
  db.set('companies/company-1/managerEmail', 'bad');
  assert.equal((await call()).data.error, 'manager_email_invalid');
  assert.equal(mails.length, 0);
});

test('إعداد ناقص: 500 برمز واضح ولا يُكتب شيء', async () => {
  process.env.APP_BASE_URL = '';
  let res = await call();
  assert.equal(res.statusCode, 500);
  assert.equal(res.data.error, 'app_base_url_not_configured');

  process.env.APP_BASE_URL = 'http://evil.example.com';
  assert.equal((await call()).data.error, 'app_base_url_not_configured');

  process.env.APP_BASE_URL = 'https://nabdh.example.com';
  mailConfigError = true;
  res = await call();
  assert.equal(res.data.error, 'email_service_not_configured');

  assert.equal(db.get('invitations'), null);
});

test('نجاح الإرسال: تخزين البصمة فقط وإرسال الرابط للبريد الصحيح', async () => {
  const res = await call();

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.invitation.status, 'sent');
  assert.equal(res.data.invitation.email, 'manager@example.com');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'manager@example.com');

  const token = tokenFromMail(mails[0]);
  const saved = db.get('invitations/manager_company-1');

  assert.equal(saved.tokenHash, hashInvitationToken(token));
  assert.equal(saved.status, 'sent');
  assert.equal(saved.role, 'MANAGER');
  assert.equal(saved.providerMessageId, 'msg-1');
  assert.ok(saved.expiresAt > Date.now());

  // التوكن الخام لا يظهر في قاعدة البيانات ولا في الاستجابة
  assert.ok(!JSON.stringify(db.dump()).includes(token));
  assert.ok(!JSON.stringify(res.data).includes(token));
  assert.ok(!JSON.stringify(res.data).includes('tokenHash'));

  assert.ok(mails[0].text.startsWith('تمت دعوتك'));
  assert.ok(mails[0].text.includes('https://nabdh.example.com/accept-invitation/#i=manager_company-1&t='));
  assert.ok(mails[0].html.includes('شركة &lt;النور&gt;'));
  assert.ok(!mails[0].html.includes('<النور>'));

  const co = db.get('companies/company-1');
  assert.equal(co.status, 'pending_manager');
  assert.equal(co.managerStatus, 'invited');
  assert.equal(co.managerUid, undefined);
  assert.equal(db.get('companyMembers'), null);
});

test('فشل مزوّد البريد: 502 والحالة send_failed وليست sent', async () => {
  mailFails = true;
  const res = await call();

  assert.equal(res.statusCode, 502);
  assert.equal(res.data.error, 'email_send_failed');
  const saved = db.get('invitations/manager_company-1');
  assert.equal(saved.status, 'send_failed');
  assert.equal(saved.deliveryStatus, 'failed');
  assert.equal(db.get('companies/company-1/managerStatus'), 'pending_invitation');
});

test('إعادة الإرسال تُبطل التوكن القديم وتُصدر جديدًا', async () => {
  await call();
  await call();

  assert.equal(mails.length, 2);
  const [first, second] = mails.map(tokenFromMail);
  assert.notEqual(first, second);
  assert.equal(db.get('invitations/manager_company-1').tokenHash, hashInvitationToken(second));
  assert.equal(db.get('invitations/manager_company-1').sendCount, 2);
});

test('إعادة الإرسال بعد فشل سابق تنجح', async () => {
  mailFails = true;
  await call();
  mailFails = false;
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(db.get('invitations/manager_company-1').status, 'sent');
});

test('تتحول المسودة القديمة إلى دعوة مرسلة مع الحفاظ على بياناتها', async () => {
  db.set('invitations/manager_company-1', {
    id: 'manager_company-1', companyId: 'company-1', email: 'manager@example.com',
    role: 'MANAGER', status: 'draft', deliveryStatus: 'not_sent', createdAt: 111, createdBy: 'admin-0'
  });

  const res = await call();
  assert.equal(res.statusCode, 200);
  const saved = db.get('invitations/manager_company-1');
  assert.equal(saved.createdAt, 111);
  assert.equal(saved.createdBy, 'admin-0');
  assert.equal(saved.status, 'sent');
});

test('منع الإرسال بعد قبول الدعوة أو أثناء القبول', async () => {
  for (const status of ['accepted', 'accepting']) {
    db.set('invitations/manager_company-1', { status, tokenHash: 'x', companyId: 'company-1' });
    const res = await call();
    assert.equal(res.statusCode, 409);
    assert.equal(res.data.error, 'invitation_already_accepted');
  }
  assert.equal(mails.length, 0);
});

test('قفل الإرسال الجاري يمنع التكرار ثم ينتهي', async () => {
  db.set('invitations/manager_company-1', {
    status: 'send_pending', sendStartedAt: Date.now(), tokenHash: 'x', companyId: 'company-1'
  });
  assert.equal((await call()).data.error, 'invitation_send_in_progress');

  db.set('invitations/manager_company-1/sendStartedAt', Date.now() - 5 * 60 * 1000);
  assert.equal((await call()).statusCode, 200);
});

test('شركة مربوطة بمدير بالفعل لا تقبل دعوة جديدة', async () => {
  db.set('companies/company-1/managerUid', 'u1');
  assert.equal((await call()).data.error, 'company_not_waiting_for_manager');
});
