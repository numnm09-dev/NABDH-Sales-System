const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb, createRes } = require('./fake-admin-db');
const { factory, E } = require('./helpers');

let db;
let verify;

const firebasePath = require.resolve('../api/_lib/firebase-admin');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { getFirebaseAdmin: async () => ({ auth: { verifyIdToken: (...a) => verify(...a) }, database: db.database }) }
};

process.env.SUPER_ADMIN_UID = 'admin-1';
const handler = require('../api/admin-maintenance');

beforeEach(() => {
  verify = async () => ({ uid: 'admin-1' });
  db = createFakeDb({});
});

async function call(body, { method = 'POST', token = 't' } = {}) {
  const res = createRes();
  await handler({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
  return res;
}

test('مدير النظام فقط: 405 / 401 / 403 / إجراء غير معروف', async () => {
  assert.equal((await call({}, { method: 'GET' })).statusCode, 405);
  assert.equal((await call({}, { token: null })).statusCode, 401);
  verify = async () => ({ uid: 'someone' });
  assert.equal((await call({ action: 'enable-server-ops', uid: 'u1' })).statusCode, 403);
  verify = async () => ({ uid: 'admin-1' });
  assert.equal((await call({ action: 'nope' })).data.error, 'invalid_action');
  assert.equal(db.get('serverOps'), null);
});

test('reconcile-company: متسقة / تُصلَح / غير موجودة / معرّف سيئ', async () => {
  assert.equal((await call({ action: 'reconcile-company', companyId: '../x' })).data.error, 'invalid_company_id');
  assert.equal((await call({ action: 'reconcile-company', companyId: 'nope' })).statusCode, 404);

  db.set('companies/c1', { id: 'c1', name: 'ش', status: 'active', managerStatus: 'linked', managerUid: 'u1' });
  db.set('invitations/manager_c1', { companyId: 'c1', email: 'm@x.com', status: 'accepting', acceptedBy: 'u1', acceptedEmail: 'm@x.com' });

  const res = await call({ action: 'reconcile-company', companyId: 'c1' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.status, 'repaired');
  assert.equal(db.get('invitations/manager_c1/status'), 'accepted');
  assert.ok(db.get('companyMembers/c1/u1'));

  assert.equal((await call({ action: 'reconcile-company', companyId: 'c1' })).data.status, 'consistent');
});

test('enable-server-ops: نسخة احتياطية write-once ثم العلم، ولا يمس بيانات المستخدم', async () => {
  const s = factory();
  db.set('users/u1', s.db);
  const before = JSON.stringify(db.get('users/u1'));

  const res = await call({ action: 'enable-server-ops', uid: 'u1' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.backupCreated, true);
  assert.equal(db.get('serverOps/u1').enabledBy, 'admin-1');
  assert.equal(JSON.stringify(db.get('users/u1')), before, 'بيانات المستخدم لم تتغير');
  assert.equal(JSON.stringify(db.get('backups/u1/pre_server_ops')), before);

  // تعديل لاحق ثم تفعيل ثانٍ: النسخة الأولى لا تُستبدل
  db.set('users/u1/settings/company', 'changed');
  const again = await call({ action: 'enable-server-ops', uid: 'u1' });
  assert.equal(again.data.backupCreated, false);
  assert.equal(JSON.stringify(db.get('backups/u1/pre_server_ops')), before);
});

test('enable-server-ops يرفض: بلا بيانات / بنية قديمة / فشل فحص السلامة، دون وضع العلم', async () => {
  assert.equal((await call({ action: 'enable-server-ops', uid: 'ghost' })).statusCode, 404);

  db.set('users/old', { schemaVersion: 1, items: [] });
  assert.equal((await call({ action: 'enable-server-ops', uid: 'old' })).data.error, 'user_needs_migration');

  // نُفسد رصيد صنف (قيمة لا تطابق حركات المخزون) فيجب أن يكتشفه فحص المحرك
  const s = factory();
  s.db.items[0].qty = 999999;
  db.set('users/bad', s.db);
  assert.ok(E.verify(E.ensure(JSON.parse(JSON.stringify(s.db))), {}).length > 0, 'شرط الاختبار: الفساد مكتشَف');

  const res = await call({ action: 'enable-server-ops', uid: 'bad' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.data.error, 'integrity_check_failed');
  assert.ok(res.data.problemCount > 0);

  assert.equal(db.get('serverOps'), null);
  assert.equal(db.get('backups'), null);
  assert.equal((await call({ action: 'enable-server-ops', uid: '../x' })).data.error, 'invalid_uid');
});

test('disable-server-ops يحذف العلم فقط ويُبقي النسخة الاحتياطية', async () => {
  db.set('users/u1', factory().db);
  await call({ action: 'enable-server-ops', uid: 'u1' });
  const res = await call({ action: 'disable-server-ops', uid: 'u1' });
  assert.equal(res.data.enabled, false);
  assert.equal(db.get('serverOps/u1'), null);
  assert.ok(db.get('backups/u1/pre_server_ops'));
  assert.ok(db.get('users/u1'));
});
