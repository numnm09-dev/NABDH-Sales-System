const test = require('node:test');
const assert = require('node:assert/strict');

const firebasePath = require.resolve('../api/_lib/firebase-admin');

require.cache[firebasePath] = {
  id: firebasePath,
  filename: firebasePath,
  loaded: true,
  exports: {
    getFirebaseAdmin: async () => ({
      auth: {
        verifyIdToken: async () => ({ uid: 'admin-1' })
      }
    })
  }
};

const { requireSuperAdmin } = require('../api/_lib/require-super-admin');

test('رفض المدير العام عند غياب SUPER_ADMIN_UID: forbidden', async () => {
  const previous = process.env.SUPER_ADMIN_UID;

  try {
    delete process.env.SUPER_ADMIN_UID;

    await assert.rejects(
      requireSuperAdmin({
        headers: { authorization: 'Bearer valid-token' }
      }),
      { message: 'forbidden' }
    );
  } finally {
    if (previous === undefined) {
      delete process.env.SUPER_ADMIN_UID;
    } else {
      process.env.SUPER_ADMIN_UID = previous;
    }
  }
});
