// دورة كاملة: إنشاء شركة -> إرسال دعوة -> محاولة خاطئة -> إعادة إرسال -> قبول -> عرض في لوحة الإدارة -> إعادة استخدام.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb, createRes } = require('./fake-admin-db');

const db = createFakeDb({
  companies: {
    'company-1': {
      id: 'company-1', name: 'شركة النور', managerEmail: 'manager@example.com',
      managerStatus: 'pending_invitation', status: 'pending_manager', createdAt: 1
    },
    'company-2': {
      id: 'company-2', name: 'شركة الأمل', managerEmail: 'other@example.com',
      managerStatus: 'pending_invitation', status: 'pending_manager', createdAt: 2
    }
  }
});

const tokens = {
  'admin-token': { uid: 'admin-1', email: 'admin@example.com', email_verified: true },
  'mgr-token': { uid: 'mgr-1', email: 'manager@example.com', email_verified: true },
  'other-mgr-token': { uid: 'mgr-2', email: 'other@example.com', email_verified: true }
};

const firebasePath = require.resolve('../api/_lib/firebase-admin');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: {
    getFirebaseAdmin: async () => ({
      auth: {
        verifyIdToken: async t => {
          if (!tokens[t]) throw Object.assign(new Error('x'), { code: 'auth/invalid-id-token' });
          return tokens[t];
        }
      },
      database: db.database
    })
  }
};

const mails = [];
const mailerPath = require.resolve('../api/_lib/mailer');
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: {
    assertMailConfigured() {},
    async sendMail(payload) { mails.push(payload); return { id: 'm' + mails.length }; }
  }
};

process.env.SUPER_ADMIN_UID = 'admin-1';
process.env.APP_BASE_URL = 'https://nabdh.example.com';

const send = require('../api/admin-invitations-send');
const accept = require('../api/accept-invitation');
const list = require('../api/admin-companies-list');

async function run(handler, method, token, body) {
  const res = createRes();
  await handler({ method, headers: { authorization: `Bearer ${token}` }, body }, res);
  return res;
}

const tokenOf = mail => mail.text.match(/&t=([A-Za-z0-9_-]{43})/)[1];
const adminList = async () => (await run(list, 'GET', 'admin-token')).data.companies;
const row = (rows, id) => rows.find(c => c.id === id);

test('الدورة الكاملة لدعوة مدير الشركة', async () => {
  // 1) قبل أي دعوة
  let rows = await adminList();
  assert.equal(row(rows, 'company-1').invitation, null);
  assert.equal(row(rows, 'company-1').managerUid, null);

  // 2) إرسال الدعوة
  let res = await run(send, 'POST', 'admin-token', { companyId: 'company-1' });
  assert.equal(res.statusCode, 200);
  rows = await adminList();
  assert.equal(row(rows, 'company-1').invitation.status, 'sent');
  assert.equal(row(rows, 'company-1').managerStatus, 'invited');
  assert.equal(row(rows, 'company-1').status, 'pending_manager');
  assert.ok(!JSON.stringify(rows).includes('tokenHash'));
  const firstToken = tokenOf(mails[0]);
  assert.ok(!JSON.stringify(rows).includes(firstToken));

  // 3) مدير شركة أخرى يحاول استخدام دعوة شركة company-1
  res = await run(accept, 'POST', 'other-mgr-token', { invitationId: 'manager_company-1', token: firstToken });
  assert.equal(res.statusCode, 403);
  assert.equal(db.get('companyMembers'), null);

  // 4) إعادة الإرسال تُبطل الرابط الأول
  await run(send, 'POST', 'admin-token', { companyId: 'company-1' });
  const secondToken = tokenOf(mails[1]);
  assert.notEqual(firstToken, secondToken);
  res = await run(accept, 'POST', 'mgr-token', { invitationId: 'manager_company-1', token: firstToken });
  assert.equal(res.statusCode, 404);
  assert.equal(db.get('companyMembers'), null);

  // 5) القبول الصحيح
  res = await run(accept, 'POST', 'mgr-token', { invitationId: 'manager_company-1', token: secondToken });
  assert.equal(res.statusCode, 200);

  // 6) ما تعرضه لوحة الإدارة
  rows = await adminList();
  const c1 = row(rows, 'company-1');
  assert.equal(c1.status, 'active');
  assert.equal(c1.managerStatus, 'linked');
  assert.equal(c1.managerUid, 'mgr-1');
  assert.ok(c1.managerLinkedAt);
  assert.deepEqual(c1.manager, { uid: 'mgr-1', email: 'manager@example.com', role: 'MANAGER', status: 'active' });
  assert.equal(c1.invitation.status, 'accepted');
  assert.ok(c1.invitation.acceptedAt);
  assert.ok(!JSON.stringify(rows).includes('tokenHash'));

  // الشركة الثانية لم تتأثر
  const c2 = row(rows, 'company-2');
  assert.equal(c2.status, 'pending_manager');
  assert.equal(c2.managerUid, null);
  assert.equal(c2.manager, null);

  // 7) لا إعادة استخدام ولا إعادة إرسال بعد القبول
  res = await run(accept, 'POST', 'mgr-token', { invitationId: 'manager_company-1', token: secondToken });
  assert.equal(res.statusCode, 409);
  res = await run(send, 'POST', 'admin-token', { companyId: 'company-1' });
  assert.equal(res.statusCode, 409);
  assert.equal(Object.keys(db.get('companyMembers/company-1')).length, 1);
  assert.equal(mails.length, 2);
});

test('الدعوة المنتهية تظهر في اللوحة كمنتهية ويمكن إعادة إصدارها', async () => {
  await run(send, 'POST', 'admin-token', { companyId: 'company-2' });
  db.set('invitations/manager_company-2/expiresAt', Date.now() - 1000);

  let rows = await adminList();
  assert.equal(row(rows, 'company-2').invitation.status, 'expired');

  const oldToken = tokenOf(mails[mails.length - 1]);
  let res = await run(accept, 'POST', 'other-mgr-token', { invitationId: 'manager_company-2', token: oldToken });
  assert.equal(res.statusCode, 410);

  res = await run(send, 'POST', 'admin-token', { companyId: 'company-2' });
  assert.equal(res.statusCode, 200);
  rows = await adminList();
  assert.equal(row(rows, 'company-2').invitation.status, 'sent');
});
