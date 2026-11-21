// فحص بنيوي لقواعد Firebase (JSON فقط). لا يشغّل محرك قواعد Firebase الحقيقي؛ لاختبار سلوكها فعليًا استعمل
// Firebase Emulator (انظر README). هذا الاختبار يمنع تراجعات واضحة: فتح الكتابة، أو تعديل قواعد الحسابات القديمة بالخطأ.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../database.rules.json').rules;
const phase2 = require('../database.rules.phase2.json').rules;

// قواعد الحسابات القديمة كما كانت في النسخة الأصلية قبل أي تعديل (يجب ألا تتغير في الملف الرئيسي).
const LEGACY = {
  "users": {
    "$uid": {
      ".read": "auth != null && auth.uid === $uid",
      ".write": "auth != null && auth.uid === $uid",
      "stock": {
        "$itemId": {
          "$whId": {
            ".validate": "newData.isNumber() && newData.val() >= 0"
          }
        }
      }
    }
  },
  "backups": {
    "$uid": {
      ".read": "auth != null && auth.uid === $uid",
      "pre_v2": {
        ".write": "auth != null && auth.uid === $uid && !data.exists()"
      }
    }
  }
};

const walk = (node, fn, trail = []) => {
  for (const [k, v] of Object.entries(node)) {
    fn(k, v, [...trail, k]);
    if (v && typeof v === 'object') walk(v, fn, [...trail, k]);
  }
};

test('الجذر مغلق والعقد المعروفة فقط موجودة (لا wildcard علوي)', () => {
  assert.equal(rules['.read'], false);
  assert.equal(rules['.write'], false);
  const keys = Object.keys(rules).filter(k => !k.startsWith('.')).sort();
  assert.deepEqual(keys, ['backups', 'companyData', 'companyMembers', 'serverOps', 'userCompanies', 'users']);
});

test('قواعد users و backups القديمة لم تتغير حرفيًا في الملف الرئيسي', () => {
  assert.deepEqual(rules.users, LEGACY.users);
  assert.deepEqual(rules.backups, LEGACY.backups);
});

test('العقد الجديدة: لا كتابة من أي عميل في أي مستوى؛ بيانات الشركة لا تُقرأ مباشرة أبدًا (القراءة عبر الخادم المُصفّي حسب الدور)', () => {
  for (const name of ['companyData', 'companyMembers', 'userCompanies', 'serverOps']) {
    let writes = 0;
    walk(rules[name], (k, v) => {
      if (k === '.write') { writes += 1; assert.equal(v, false, `${name}: .write يجب أن تكون false`); }
      if (k === '.read' && name !== 'companyData') assert.match(v, /auth != null/, `${name}: القراءة تتطلب مصادقة`);
    });
    assert.ok(writes >= 1, `${name}: ذُكر المنع صراحةً`);
  }

  // كل عضو نشط كان سيقرأ بيانات الشركة كاملة (محاسبة وموارد بشرية ومخازن) مهما كان دوره؛ لذلك أُغلقت القراءة المباشرة.
  let reads = 0;
  walk(rules.companyData, (k, v) => { if (k === '.read') { reads += 1; assert.equal(v, false, 'companyData: .read يجب أن تكون false'); } });
  assert.ok(reads >= 1);

  assert.match(rules.companyMembers.$companyId.$uid['.read'], /auth\.uid === \$uid/);
  assert.match(rules.userCompanies.$uid['.read'], /auth\.uid === \$uid/);
  assert.match(rules.serverOps.$uid['.read'], /auth\.uid === \$uid/);
});

test('ملف المرحلة 2 يطابق الرئيسي عدا شرط منع كتابة users/$uid المباشرة لمن فُعّل له serverOps', () => {
  const clone = x => JSON.parse(JSON.stringify(x));
  const a = clone(rules); const b = clone(phase2);
  const expr = b.users.$uid['.write'];
  assert.match(expr, /auth\.uid === \$uid/);
  assert.match(expr, /!root\.child\('serverOps'\)\.child\(auth\.uid\)\.exists\(\)/);
  delete a.users.$uid['.write']; delete b.users.$uid['.write'];
  assert.deepEqual(b, a);
});
