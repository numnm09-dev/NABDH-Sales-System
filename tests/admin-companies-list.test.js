const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

let verifyToken;
let databaseError = false;
let databaseData = {};

const database = {
  ref(path) {
    return {
      once: async event => {
        if (databaseError) {
          throw new Error('database_unavailable');
        }

        assert.equal(event, 'value');

        return {
          val: () => databaseData[path] || null
        };
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

const handler = require('../api/admin-companies-list');

beforeEach(() => {
  verifyToken = async () => ({ uid: 'admin-1' });
  databaseError = false;
  databaseData = {};
});

async function call(method = 'GET', token = 'admin-token') {
  const req = {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {}
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

test('عرض الشركات للسوبر أدمن: 200', async () => {
  databaseData.companies = {
    'company-1': {
      name: 'شركة النور',
      managerEmail: 'manager@example.com',
      status: 'pending_manager'
    }
  };

  const r = await call();

  assert.equal(r.code, 200);
  assert.equal(r.body.companies.length, 1);
  assert.equal(r.body.companies[0].id, 'company-1');
  assert.equal(r.body.companies[0].name, 'شركة النور');
});

test('قائمة فارغة عند عدم وجود شركات: 200', async () => {
  const r = await call();

  assert.equal(r.code, 200);
  assert.deepEqual(r.body.companies, []);
});

test('رفض الطلب بدون توكن: 401', async () => {
  const r = await call('GET', null);
  assert.equal(r.code, 401);
});

test('رفض المستخدم العادي: 403', async () => {
  verifyToken = async () => ({ uid: 'user-2' });

  const r = await call();

  assert.equal(r.code, 403);
});

test('رفض طريقة غير GET: 405', async () => {
  const r = await call('POST');

  assert.equal(r.code, 405);
});

test('خطأ قاعدة البيانات: 500', async () => {
  databaseError = true;

  const r = await call();

  assert.equal(r.code, 500);
  assert.equal(r.body.error, 'company_list_failed');
});
