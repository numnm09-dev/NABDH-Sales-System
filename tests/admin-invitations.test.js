const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

let verifyToken;
let databaseData = {};

const database = {
  ref(path) {
    return {
      get: async () => {
        const value = databaseData[path];
        return {
          exists: () => value !== undefined,
          val: () => value ?? null
        };
      },
      transaction: async update => {
        const current = databaseData[path] ?? null;
        const next = update(current);

        if (next === undefined) {
          return { committed: false };
        }

        if (next === null) {
          delete databaseData[path];
        } else {
          databaseData[path] = next;
        }

        return { committed: true };
      }
    };
  }
};

const firebasePath = require.resolve('../api/_lib/firebase-admin');

require.cache[firebasePath] = {
  id: firebasePath,
  filename: firebasePath,
  loaded: true,
  exports: {
    getFirebaseAdmin: async () => ({
      auth: {
        verifyIdToken: (...args) => verifyToken(...args)
      },
      database
    })
  }
};

process.env.SUPER_ADMIN_UID = 'admin-1';

const handler = require('../api/admin-invitations');

beforeEach(() => {
  verifyToken = async () => ({ uid: 'admin-1' });
  databaseData = {};
});

async function call({
  method = 'POST',
  token = 'admin-token',
  body = { companyId: 'company-1' }
} = {}) {
  const req = {
    method,
    headers: { authorization: `Bearer ${token}` },
    body
  };

  const res = {
    statusCode: 200,
    data: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.data = value;
      return this;
    }
  };

  await handler(req, res);
  return res;
}

function addCompany(overrides = {}) {
  databaseData['companies/company-1'] = {
    id: 'company-1',
    name: 'شركة النور',
    managerEmail: 'manager@example.com',
    managerStatus: 'pending_invitation',
    status: 'pending_manager',
    ...overrides
  };
}

test('رفض أي طريقة غير POST', async () => {
  const res = await call({ method: 'GET' });
  assert.equal(res.statusCode, 405);
});

test('رفض المستخدم غير المسجل: 401', async () => {
  verifyToken = async () => {
    throw Object.assign(new Error('expired'), { code: 'auth/id-token-expired' });
  };

  const res = await call();
  assert.equal(res.statusCode, 401);
});

test('رفض المستخدم غير المسؤول: 403', async () => {
  verifyToken = async () => ({ uid: 'normal-user' });

  const res = await call();
  assert.equal(res.statusCode, 403);
});

test('رفض معرّف الشركة غير الصحيح', async () => {
  const res = await call({ body: { companyId: '../other' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.data.error, 'invalid_company_id');
});

test('رفض الشركة غير الموجودة: 404', async () => {
  const res = await call();
  assert.equal(res.statusCode, 404);
  assert.equal(res.data.error, 'company_not_found');
});

test('إنشاء مسودة دعوة للمدير دون إرسال بريد', async () => {
  addCompany();

  const res = await call();

  assert.equal(res.statusCode, 201);
  assert.equal(res.data.invitation.status, 'draft');
  assert.equal(res.data.invitation.deliveryStatus, 'not_sent');
  assert.equal(res.data.invitation.email, 'manager@example.com');

  const saved = databaseData['invitations/manager_company-1'];
  assert.equal(saved.role, 'MANAGER');
  assert.equal(saved.createdBy, 'admin-1');
  assert.equal(saved.deliveryStatus, 'not_sent');
});

test('منع إنشاء دعوة ثانية للشركة نفسها', async () => {
  addCompany();
  await call();

  const res = await call();

  assert.equal(res.statusCode, 409);
  assert.equal(res.data.error, 'invitation_already_exists');
});

test('رفض شركة لا تنتظر تعيين مدير', async () => {
  addCompany({ status: 'active' });

  const res = await call();

  assert.equal(res.statusCode, 409);
  assert.equal(res.data.error, 'company_not_waiting_for_manager');
});

test('رفض البريد غير الصحيح المحفوظ للشركة', async () => {
  addCompany({ managerEmail: 'not-an-email' });

  const res = await call();

  assert.equal(res.statusCode, 409);
  assert.equal(res.data.error, 'manager_email_invalid');
});
