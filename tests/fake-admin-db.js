// قاعدة بيانات وهمية (شجرة) تحاكي واجهات firebase-admin المستخدمة:
// get / once / set / update (متعدد المسارات) / transaction. ليست ملف اختبار بحد ذاتها.
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function strip(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (value[key] === null || value[key] === undefined) delete value[key];
      else strip(value[key]);
    }
  }
  return value;
}

function createFakeDb(initial = {}) {
  let root = clone(initial);
  // محاكاة الأعطال: كل خطاف يقبل 'before' (يفشل قبل الكتابة) أو 'after' (تُحفظ الكتابة ثم ينقطع الإقرار).
  //   hooks.update: 'before' | 'after' | (keys) => mode      hooks.transaction: (path) => mode
  //   hooks.get: (path) => true لإفشال القراءة                  hooks.failUpdate (قديم) = 'before'
  const hooks = { failUpdate: false, update: null, transaction: null, get: null };
  let pushCounter = 0;
  const parts = path => String(path || '').split('/').filter(Boolean);

  function getAt(path) {
    let node = root;
    for (const key of parts(path)) {
      if (node === null || typeof node !== 'object') return null;
      node = node[key];
    }
    return node === undefined ? null : clone(node);
  }

  function setAt(path, value) {
    const keys = parts(path);

    if (!keys.length) {
      root = value === null ? {} : strip(clone(value));
      return;
    }

    let node = root;
    for (let i = 0; i < keys.length - 1; i += 1) {
      if (node[keys[i]] === null || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
      node = node[keys[i]];
    }

    const last = keys[keys.length - 1];
    if (value === null || value === undefined) delete node[last];
    else node[last] = strip(clone(value));
  }

  const snapshot = value => ({ exists: () => value !== null, val: () => value });

  const database = {
    ref(path = '') {
      return {
        get: async () => {
          if (hooks.get && hooks.get(path)) throw new Error('simulated_read_failure');
          return snapshot(getAt(path));
        },
        once: async () => {
          if (hooks.get && hooks.get(path)) throw new Error('simulated_read_failure');
          return snapshot(getAt(path));
        },
        set: async value => setAt(path, value),
        // يحاكي ref.push(): مفتاح فريد يرتّب زمنيًا ويُرجع مرجعًا قابلًا للكتابة.
        push: () => {
          pushCounter += 1;
          const key = '-push' + String(pushCounter).padStart(8, '0');
          const child = database.ref([path, key].filter(Boolean).join('/'));
          child.key = key;
          return child;
        },
        remove: async () => setAt(path, null),
        update: async values => {
          const mode = hooks.failUpdate
            ? 'before'
            : typeof hooks.update === 'function' ? hooks.update(Object.keys(values)) : hooks.update;

          if (mode === 'before') throw new Error('simulated_write_failure');

          // تطبيق متعدد المسارات: يُكتب كله أو لا شيء.
          for (const [key, value] of Object.entries(values)) {
            setAt([path, key].filter(Boolean).join('/'), value === undefined ? null : value);
          }

          if (mode === 'after') throw new Error('simulated_timeout_after_commit');
        },
        transaction: async fn => {
          const mode = hooks.transaction ? hooks.transaction(path) : null;

          if (mode === 'before') throw new Error('simulated_transaction_failure');

          const next = fn(getAt(path));

          if (next === undefined) return { committed: false, snapshot: snapshot(getAt(path)) };

          setAt(path, next);

          if (mode === 'after') throw new Error('simulated_timeout_after_commit');

          return { committed: true, snapshot: snapshot(getAt(path)) };
        }
      };
    }
  };

  return {
    database,
    hooks,
    get: getAt,
    set: setAt,
    dump: () => clone(root)
  };
}

function createRes() {
  return {
    statusCode: 200,
    data: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.data = value; return this; }
  };
}

module.exports = { createFakeDb, createRes };
