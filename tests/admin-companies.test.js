const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

let verifyToken;
let failCompanySet = false;
let databaseData = {};
let nextId = 0;

const database = {
  ref(path) {
    return {
      push() {
        const key = `company-${++nextId}`;
        return {
          key,
          set: async value => {
            if (failCompanySet) {
              throw new Error('database_unavailable');
            }
            databaseData[path] ||= {};
            databaseData[path][key] = value;
          }
        };
      },

      transaction: async update => {
        const parts = path.split('/');
        const key = parts.pop();
        const parent = parts.join('/');

        databaseData[parent] ||= {};
        const current = databaseData[parent][key] ?? null;
        const next = update(current);

        if (next === undefined) {
          return { committed: false };
        }

        if (next === null) {
          delete databaseData[parent][key];
        } else {
          databaseData[parent][key] = next;
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

const handler = require('../api/admin-companies');

beforeEach(() => {
  verifyToken = async () => ({ uid: 'admin-1' });
  failCompanySet = false;
  databaseData = {};
  nextId = 0;
});

async function call({
  method = 'POST',
  token = 'admin-token',
  body = {
    name: 'شركة النور',
    managerEmail: 'manager@example.com'
  }
} = {}) {
  const req = {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body
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

test('إنشاء شركة بنجاح: 201', async () => {
  const r = await call();

  assert.equal(r.code, 201);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.company.name, 'شركة النور');
  assert.equal(
    r.body.company.managerStatus,
    'pending_invitation'
  );
  assert.equal(databaseData.companies['company-1'].managerEmail,
    'manager@example.com');
});

test('منع تكرار اسم الشركة: 409', async () => {
  await call();

  const r = await call({
    body: {
      name: '  شركة النور  ',
      managerEmail: 'other@example.com'
    }
  });

  assert.equal(r.code, 409);
  assert.equal(r.body.error, 'company_name_exists');
});

test('رفض الطلب بدون توكن: 401', async () => {
  const r = await call({ token: null });
  assert.equal(r.code, 401);
});

test('رفض المستخدم العادي: 403', async () => {
  verifyToken = async () => ({ uid: 'user-2' });

  const r = await call();
  assert.equal(r.code, 403);
});

test('رفض اسم الشركة غير الصحيح: 400', async () => {
  const r = await call({
    body: {
      name: 'A',
      managerEmail: 'manager@example.com'
    }
  });

  assert.equal(r.code, 400);
  assert.equal(Object.keys(databaseData).length, 0);
});

test('رفض البريد الإلكتروني غير الصحيح: 400', async () => {
  const r = await call({
    body: {
      name: 'شركة جديدة',
      managerEmail: 'wrong-email'
    }
  });

  assert.equal(r.code, 400);
  assert.equal(Object.keys(databaseData).length, 0);
});

test('رفض طريقة غير POST: 405', async () => {
  const r = await call({ method: 'GET' });
  assert.equal(r.code, 405);
});

test('فشل الحفظ يعيد حجز الاسم: 500', async () => {
  failCompanySet = true;

  const r = await call();

  assert.equal(r.code, 500);
  assert.equal(
    Object.keys(databaseData.companyNameIndex || {}).length,
    0
  );
});
