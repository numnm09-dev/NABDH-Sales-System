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
  const hooks = { failUpdate: false };
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
        get: async () => snapshot(getAt(path)),
        once: async () => snapshot(getAt(path)),
        set: async value => setAt(path, value),
        update: async values => {
          if (hooks.failUpdate) throw new Error('simulated_write_failure');
          // تطبيق متعدد المسارات: يُكتب كله أو لا شيء (الفشل يُحاكى قبل أي كتابة).
          for (const [key, value] of Object.entries(values)) {
            setAt([path, key].filter(Boolean).join('/'), value === undefined ? null : value);
          }
        },
        transaction: async fn => {
          const next = fn(getAt(path));
          if (next === undefined) return { committed: false };
          setAt(path, next);
          return { committed: true };
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
