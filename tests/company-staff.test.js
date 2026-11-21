// دعوة الموظفين: مدير الشركة يدعو بدور، الموظف يقبل، ثم الإيقاف وتغيير الدور وإلغاء الدعوة، مع العزل والأعطال الملتبسة.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb, createRes } = require('./fake-admin-db');
const { factory } = require('./helpers');
const { describeStaffState, readStaffState } = require('../api/_lib/reconcile');

let db;
let mails;
let mailFails;
let mailConfigError;
const users = {};
const addUser = (t, uid, email, verified = true) => { users[t] = { uid, email, email_verified: verified }; };

const firebasePath = require.resolve('../api/_lib/firebase-admin');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { getFirebaseAdmin: async () => ({ auth: { verifyIdToken: async t => { if (!users[t]) throw Object.assign(new Error('x'), { code: 'auth/invalid-id-token' }); return users[t]; } }, database: db.database }) }
};
const mailerPath = require.resolve('../api/_lib/mailer');
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: {
    assertMailConfigured: () => { if (mailConfigError) throw new Error('email_service_not_configured'); },
    sendMail: async p => { if (mailFails) throw new Error('email_send_failed'); mails.push(p); return { id: 'm' + mails.length }; }
  }
};
process.env.APP_BASE_URL = 'https://nabdh.example.com';

const staff = require('../api/company-staff');
const accept = require('../api/accept-invitation');
const erpOp = require('../api/erp-op');
const { hashInvitationToken } = require('../api/_lib/invitations');

beforeEach(() => {
  for (const k of Object.keys(users)) delete users[k];
  addUser('mgr', 'mgr-1', 'manager@example.com');
  addUser('mgr2', 'mgr-2', 'other-manager@example.com');
  addUser('hr', 'hr-1', 'hr@example.com');
  addUser('acc', 'acc-9', 'acc@example.com');
  addUser('acc-unverified', 'acc-9', 'acc@example.com', false);
  addUser('sal', 'sal-9', 'sales@example.com');
  addUser('stranger', 'str-1', 'stranger@example.com');
  mails = []; mailFails = false; mailConfigError = false;
  process.env.APP_BASE_URL = 'https://nabdh.example.com';

  db = createFakeDb({
    companies: {
      c1: { id: 'c1', name: 'شركة النور', status: 'active', managerStatus: 'linked', managerUid: 'mgr-1', managerEmail: 'manager@example.com' },
      c2: { id: 'c2', name: 'شركة الأمل', status: 'active', managerStatus: 'linked', managerUid: 'mgr-2', managerEmail: 'other-manager@example.com' }
    },
    companyMembers: {
      c1: {
        'mgr-1': { uid: 'mgr-1', email: 'manager@example.com', role: 'MANAGER', status: 'active' },
        'hr-1': { uid: 'hr-1', email: 'hr@example.com', role: 'HR', status: 'active' }
      },
      c2: { 'mgr-2': { uid: 'mgr-2', email: 'other-manager@example.com', role: 'MANAGER', status: 'active' } }
    },
    userCompanies: { 'hr-1': { c1: { companyId: 'c1', name: 'شركة النور', role: 'HR' } } },
    companyData: { c1: factory().db, c2: factory().db }
  });
});

async function post(handler, token, body, method = 'POST') {
  const res = createRes();
  await handler({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
  return res;
}
const call = (token, body) => post(staff, token, { companyId: 'c1', ...body });
const tokenOf = mail => mail.text.match(/&t=([A-Za-z0-9_-]{43})/)[1];
const idOf = mail => decodeURIComponent(mail.text.match(/#i=([^&]+)&/)[1]);
const acceptWith = (token, mail) => post(accept, token, { invitationId: idOf(mail), token: tokenOf(mail) });
async function inviteAndGet(email, role, token = 'mgr') {
  const r = await call(token, { action: 'invite', email, role });
  assert.equal(r.statusCode, 200, JSON.stringify(r.data));
  return mails[mails.length - 1];
}

test('رفض: غير POST / بلا توكن / بريد غير مؤكَّد / شركة أو إجراء غير صالح', async () => {
  assert.equal((await post(staff, 'mgr', { companyId: 'c1' }, 'GET')).statusCode, 405);
  assert.equal((await call(null, { action: 'list' })).statusCode, 401);
  assert.equal((await call('bad', { action: 'list' })).statusCode, 401);
  assert.equal((await call('acc-unverified', { action: 'list' })).statusCode, 403);
  assert.equal((await post(staff, 'mgr', { companyId: '../x', action: 'list' })).data.error, 'invalid_company_id');
  assert.equal((await call('mgr', { action: 'nope' })).data.error, 'invalid_action');
});

test('إدارة الفريق لمدير الشركة فقط: الموظفون والغرباء ومديرو الشركات الأخرى ممنوعون من كل الإجراءات', async () => {
  const before = JSON.stringify(db.dump());
  for (const token of ['hr', 'stranger', 'mgr2']) {
    for (const body of [{ action: 'list' }, { action: 'invite', email: 'x@example.com', role: 'SALES' }, { action: 'set-status', uid: 'hr-1', status: 'suspended' }, { action: 'set-role', uid: 'hr-1', role: 'SALES' }, { action: 'revoke-invitation', invitationId: 'staff_c1_x' }]) {
      const r = await call(token, body);
      assert.equal(r.statusCode, 403, `${token} ${body.action}`);
    }
  }
  assert.equal(JSON.stringify(db.dump()), before);
  assert.equal(mails.length, 0);
});

test('دعوة موظف لكل دور: يُخزَّن الدور والبصمة فقط، والبريد للعنوان الصحيح بوصف الدور، بلا توكن في الرد', async () => {
  for (const [role, label] of [['HR', 'الموارد البشرية'], ['ACCOUNTANT', 'محاسب'], ['WAREHOUSE', 'أمين مخازن'], ['SALES', 'مبيعات']]) {
    const email = `${role.toLowerCase()}.new@Example.com`;
    const res = await call('mgr', { action: 'invite', email, role });
    assert.equal(res.statusCode, 200);

    const mail = mails[mails.length - 1];
    assert.equal(mail.to, email.toLowerCase());
    assert.ok(mail.text.includes(`بدور «${label}»`), mail.text);
    assert.ok(mail.text.includes('https://nabdh.example.com/accept-invitation/#i=staff_c1_'));

    const inv = db.get(`invitations/${idOf(mail)}`);
    assert.equal(inv.kind, 'staff');
    assert.equal(inv.role, role);
    assert.equal(inv.companyId, 'c1');
    assert.equal(inv.invitedBy, 'mgr-1');
    assert.equal(inv.status, 'sent');
    assert.equal(inv.tokenHash, hashInvitationToken(tokenOf(mail)));
    assert.ok(!JSON.stringify(db.dump()).includes(tokenOf(mail)), 'التوكن الخام غير مخزَّن');
    assert.ok(!JSON.stringify(res.data).includes(tokenOf(mail)) && !JSON.stringify(res.data).includes('tokenHash'));
    assert.equal(res.data.invitation.roleLabel, label);
  }
});

test('التحقق من الدعوة: لا دعوة مدير ولا دور مجهول ولا بريد سيئ ولا عضو قائم، وإعدادات ناقصة بلا أي كتابة', async () => {
  const bad = (body, error, status = 400) => call('mgr', { action: 'invite', ...body }).then(r => { assert.equal(r.data.error, error, JSON.stringify(body)); assert.equal(r.statusCode, status); });
  await bad({ email: 'a@example.com', role: 'MANAGER' }, 'invalid_role');
  await bad({ email: 'a@example.com', role: 'JANITOR' }, 'invalid_role');
  await bad({ email: 'a@example.com', role: '__proto__' }, 'invalid_role');
  await bad({ email: 'not-an-email', role: 'SALES' }, 'invalid_email');
  await bad({ email: 'HR@example.com', role: 'SALES' }, 'already_member', 409);
  await bad({ email: 'manager@example.com', role: 'SALES' }, 'already_member', 409);
  assert.equal(db.get('invitations'), null);

  process.env.APP_BASE_URL = '';
  assert.equal((await call('mgr', { action: 'invite', email: 'a@example.com', role: 'SALES' })).data.error, 'app_base_url_not_configured');
  process.env.APP_BASE_URL = 'https://nabdh.example.com';
  mailConfigError = true;
  assert.equal((await call('mgr', { action: 'invite', email: 'a@example.com', role: 'SALES' })).data.error, 'email_service_not_configured');
  assert.equal(db.get('invitations'), null);
  assert.equal(mails.length, 0);
});

test('فشل مزوّد البريد: 502 والدعوة send_failed ثم تنجح إعادة الدعوة', async () => {
  mailFails = true;
  const r = await call('mgr', { action: 'invite', email: 'acc@example.com', role: 'ACCOUNTANT' });
  assert.equal(r.statusCode, 502);
  const id = Object.keys(db.get('invitations'))[0];
  assert.equal(db.get(`invitations/${id}/status`), 'send_failed');

  mailFails = false;
  assert.equal((await call('mgr', { action: 'invite', email: 'acc@example.com', role: 'ACCOUNTANT' })).statusCode, 200);
  assert.equal(db.get(`invitations/${id}/status`), 'sent');
  assert.equal(db.get(`invitations/${id}/sendCount`), 2);
});

test('إعادة الدعوة تُبطل الرابط القديم وتسمح بتغيير الدور قبل القبول', async () => {
  const first = await inviteAndGet('acc@example.com', 'ACCOUNTANT');
  const second = await inviteAndGet('acc@example.com', 'SALES');
  assert.notEqual(tokenOf(first), tokenOf(second));

  const old = await acceptWith('acc', first);
  assert.equal(old.statusCode, 404);
  assert.equal(db.get('companyMembers/c1/acc-9'), null);

  const ok = await acceptWith('acc', second);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.data.role, 'SALES');
});

test('القبول: عضوية بالدور المدعو، ربط الحساب بالشركة، الشركة ومديرها وبياناتها لا تتغير', async () => {
  const mail = await inviteAndGet('acc@example.com', 'ACCOUNTANT');
  const companyBefore = JSON.stringify(db.get('companies/c1'));
  const dataBefore = JSON.stringify(db.get('companyData/c1'));

  const res = await acceptWith('acc', mail);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.data, { ok: true, role: 'ACCOUNTANT', company: { id: 'c1', name: 'شركة النور' } });

  const member = db.get('companyMembers/c1/acc-9');
  assert.equal(member.role, 'ACCOUNTANT');
  assert.equal(member.email, 'acc@example.com');
  assert.equal(member.status, 'active');
  assert.equal(member.invitedBy, 'mgr-1');
  assert.equal(db.get('userCompanies/acc-9/c1').role, 'ACCOUNTANT');
  assert.equal(db.get('userCompanies/acc-9/c1').name, 'شركة النور');
  assert.equal(db.get(`invitations/${idOf(mail)}/status`), 'accepted');

  assert.equal(JSON.stringify(db.get('companies/c1')), companyBefore, 'الشركة ومديرها لم يتغيرا');
  assert.equal(JSON.stringify(db.get('companyData/c1')), dataBefore, 'بيانات الشركة لم تتغير');
  assert.equal(db.get('users'), null, 'لا حساب شخصي');
  assert.deepEqual(describeStaffState(await readStaffState(db.database, 'c1', idOf(mail))).issues, []);
});

test('أمان القبول: بريد مختلف 403، لا استخدام ثانٍ، منتهية 410، مدير آخر لا يقبل دعوة غيره، وتوكن خاطئ 404', async () => {
  const mail = await inviteAndGet('acc@example.com', 'ACCOUNTANT');

  assert.equal((await acceptWith('sal', mail)).data.error, 'invitation_email_mismatch');
  assert.equal((await acceptWith('mgr2', mail)).data.error, 'invitation_email_mismatch');
  assert.equal((await post(accept, 'acc', { invitationId: idOf(mail), token: 'A'.repeat(43) })).statusCode, 404);
  assert.equal((await acceptWith('acc-unverified', mail)).data.error, 'email_not_verified');
  assert.equal(db.get('companyMembers/c1/acc-9'), null);
  assert.equal(db.get('companyMembers/c1/sal-9'), null);

  db.set(`invitations/${idOf(mail)}/expiresAt`, Date.now() - 1000);
  assert.equal((await acceptWith('acc', mail)).statusCode, 410);
  db.set(`invitations/${idOf(mail)}/expiresAt`, Date.now() + 3600e3);

  assert.equal((await acceptWith('acc', mail)).statusCode, 200);
  const again = await acceptWith('acc', mail);
  assert.equal(again.statusCode, 409);
  assert.equal(again.data.error, 'invitation_already_used');
  assert.equal(again.data.linkedToYou, true);
  assert.equal((await acceptWith('sal', mail)).data.error, 'invitation_already_used');
  assert.equal(Object.keys(db.get('companyMembers/c1')).length, 3);
});

test('قبول متزامن: عضوية واحدة فقط', async () => {
  const mail = await inviteAndGet('acc@example.com', 'ACCOUNTANT');
  const [a, b] = await Promise.all([acceptWith('acc', mail), acceptWith('acc', mail)]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  assert.equal(db.get('companyMembers/c1/acc-9').role, 'ACCOUNTANT');
});

test('دعوة تُقبل لشركة غير فعّالة أو لعضو قائم: مرفوضة بسبب واضح ولا تغيّر شيئًا', async () => {
  const mail = await inviteAndGet('acc@example.com', 'ACCOUNTANT');
  db.set('companies/c1/status', 'suspended');
  assert.equal((await acceptWith('acc', mail)).data.error, 'company_not_active');
  db.set('companies/c1/status', 'active');
  assert.equal(db.get(`invitations/${idOf(mail)}/status`), 'sent');

  db.set('companyMembers/c1/acc-9', { uid: 'acc-9', email: 'acc@example.com', role: 'SALES', status: 'suspended' });
  assert.equal((await acceptWith('acc', mail)).data.error, 'already_member');
  assert.equal(db.get('companyMembers/c1/acc-9').role, 'SALES', 'لم تُستبدل عضوية قائمة');
});

test('أعطال ملتبسة عند قبول الموظف: كتابة حُفظت ثم انقطع الإقرار تُصالَح، وفشل كامل يُرجع الحجز', async () => {
  let mail = await inviteAndGet('acc@example.com', 'ACCOUNTANT');
  db.hooks.update = 'after';
  let res = await acceptWith('acc', mail);
  assert.equal(res.statusCode, 200, 'نجاح رغم ضياع الإقرار');
  db.hooks.update = null;
  assert.deepEqual(describeStaffState(await readStaffState(db.database, 'c1', idOf(mail))).issues, []);
  assert.equal(db.get(`invitations/${idOf(mail)}/status`), 'accepted');
  assert.equal((await acceptWith('acc', mail)).data.linkedToYou, true);

  mail = await inviteAndGet('sales@example.com', 'SALES');
  db.hooks.update = 'before';
  res = await acceptWith('sal', mail);
  assert.equal(res.statusCode, 500);
  assert.ok(!JSON.stringify(res.data).includes('simulated'));
  assert.equal(db.get('companyMembers/c1/sal-9'), null);
  assert.equal(db.get(`invitations/${idOf(mail)}/status`), 'sent', 'أُرجع الحجز');
  db.hooks.update = null;
  assert.equal((await acceptWith('sal', mail)).statusCode, 200);
});

test('قائمة الفريق: الأعضاء والدعوات المعلّقة (المقبولة تختفي، المنتهية تُحسب) بلا بصمات توكن، ولشركتها فقط', async () => {
  const m1 = await inviteAndGet('acc@example.com', 'ACCOUNTANT');
  await inviteAndGet('sales@example.com', 'SALES');
  await acceptWith('acc', m1);
  const sales = Object.keys(db.get('invitations')).find(k => k !== idOf(m1));
  db.set(`invitations/${sales}/expiresAt`, Date.now() - 1000);
  await post(staff, 'mgr2', { companyId: 'c2', action: 'invite', email: 'x@example.com', role: 'HR' });

  const r = await call('mgr', { action: 'list' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.data.members.map(m => m.role).sort(), ['ACCOUNTANT', 'HR', 'MANAGER']);
  assert.equal(r.data.invitations.length, 1);
  assert.equal(r.data.invitations[0].email, 'sales@example.com');
  assert.equal(r.data.invitations[0].status, 'expired');
  assert.ok(!JSON.stringify(r.data).includes('tokenHash'));
  assert.ok(!JSON.stringify(r.data).includes('x@example.com'), 'دعوات شركة أخرى لا تظهر');
});

test('إلغاء الدعوة: تمنع القبول، ولا تُلغى مقبولة، ولا تُلغى دعوة شركة أخرى', async () => {
  const mail = await inviteAndGet('acc@example.com', 'ACCOUNTANT');
  assert.equal((await call('mgr', { action: 'revoke-invitation', invitationId: 'staff_c1_nothing' })).statusCode, 404);
  assert.equal((await post(staff, 'mgr2', { companyId: 'c2', action: 'revoke-invitation', invitationId: idOf(mail) })).statusCode, 404);
  assert.equal(db.get(`invitations/${idOf(mail)}/status`), 'sent');

  assert.equal((await call('mgr', { action: 'revoke-invitation', invitationId: idOf(mail) })).statusCode, 200);
  assert.equal(db.get(`invitations/${idOf(mail)}/status`), 'revoked');
  assert.equal((await acceptWith('acc', mail)).data.error, 'invitation_not_active');

  const m2 = await inviteAndGet('sales@example.com', 'SALES');
  await acceptWith('sal', m2);
  const r = await call('mgr', { action: 'revoke-invitation', invitationId: idOf(m2) });
  assert.equal(r.statusCode, 409);
  assert.equal(db.get('companyMembers/c1/sal-9').status, 'active');
});

let opN = 0;
const op = (token, name, input, companyId = 'c1') => post(erpOp, token, { scope: 'company', companyId, op: name, input, opId: 'staff-op-' + (++opN) });
const read = token => post(erpOp, token, { scope: 'company', companyId: 'c1', action: 'read' });

test('إيقاف الموظف يقطع وصوله فورًا (قراءة وعمليات) والتفعيل يعيده؛ المدير والنفس محميان', async () => {
  assert.equal((await read('hr')).statusCode, 200);

  const r = await call('mgr', { action: 'set-status', uid: 'hr-1', status: 'suspended' });
  assert.equal(r.statusCode, 200);
  assert.equal(db.get('companyMembers/c1/hr-1/status'), 'suspended');
  assert.equal((await read('hr')).statusCode, 403);
  assert.equal((await op('hr', 'upsertEmployee', { name: 'x', salary: 1, hireDate: '2026-01-01' })).statusCode, 403);

  await call('mgr', { action: 'set-status', uid: 'hr-1', status: 'active' });
  assert.equal((await read('hr')).statusCode, 200);

  assert.equal((await call('mgr', { action: 'set-status', uid: 'mgr-1', status: 'suspended' })).data.error, 'cannot_modify_self');
  assert.equal((await call('mgr', { action: 'set-status', uid: 'hr-1', status: 'deleted' })).data.error, 'invalid_status');
  assert.equal((await call('mgr', { action: 'set-status', uid: 'ghost', status: 'active' })).statusCode, 404);

  // مدير آخر في نفس الشركة لا يُعدَّل من هنا
  db.set('companyMembers/c1/mgr-3', { uid: 'mgr-3', email: 'm3@x.com', role: 'MANAGER', status: 'active' });
  assert.equal((await call('mgr', { action: 'set-status', uid: 'mgr-3', status: 'suspended' })).statusCode, 403);
});

test('تغيير الدور: العضوية وربط الحساب معًا، وتتبدل الصلاحيات فورًا؛ لا ترقية إلى مدير', async () => {
  assert.equal((await op('hr', 'recordExpense', { category: 'إيجار', method: 'نقدي', amount: 1 })).statusCode, 403);

  const r = await call('mgr', { action: 'set-role', uid: 'hr-1', role: 'ACCOUNTANT' });
  assert.equal(r.statusCode, 200);
  assert.equal(db.get('companyMembers/c1/hr-1/role'), 'ACCOUNTANT');
  assert.equal(db.get('userCompanies/hr-1/c1/role'), 'ACCOUNTANT');
  assert.equal((await read('hr')).data.role, 'ACCOUNTANT');
  assert.equal((await op('hr', 'upsertEmployee', { name: 'x', salary: 1, hireDate: '2026-01-01' })).statusCode, 403, 'فقد صلاحيات الموارد البشرية');

  assert.equal((await call('mgr', { action: 'set-role', uid: 'hr-1', role: 'MANAGER' })).data.error, 'invalid_role');
  assert.equal((await call('mgr', { action: 'set-role', uid: 'hr-1', role: 'JANITOR' })).data.error, 'invalid_role');
  assert.equal(db.get('companyMembers/c1/hr-1/role'), 'ACCOUNTANT');
});

test('الدورة الكاملة: دعوة محاسب ← قبوله ← يقرأ المحاسبة فقط وينفّذ عملياتها ولا يمس الموارد البشرية', async () => {
  const mail = await inviteAndGet('acc@example.com', 'ACCOUNTANT');
  assert.equal((await read('acc')).statusCode, 403, 'قبل القبول: لا وصول');
  await acceptWith('acc', mail);

  const view = await read('acc');
  assert.equal(view.statusCode, 200);
  assert.equal(view.data.role, 'ACCOUNTANT');
  assert.deepEqual(view.data.db.employees, []);
  assert.equal((await op('acc', 'cashEntry', { kind: 'capital_in', amount: 100 })).statusCode, 200);
  assert.equal((await op('acc', 'upsertEmployee', { name: 'x', salary: 1, hireDate: '2026-01-01' })).statusCode, 403);
  assert.equal((await op('acc', 'cashEntry', { kind: 'capital_in', amount: 1 }, 'c2')).statusCode, 403, 'لا وصول لشركة أخرى');
});
