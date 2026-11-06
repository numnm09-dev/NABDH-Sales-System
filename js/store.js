/* نبض ERP — طبقة الحفظ: كل عملية تُنفَّذ داخل معاملة (transaction) على عقدة المستخدم في Firebase.
   المعاملة تعيد تشغيل المحرك على أحدث نسخة من الخادم، فتُرفض أي عملية تخالف قواعد المخزون حتى لو كانت نسخة المتصفح قديمة،
   ويمنع معرّف العملية (opId) التسجيل المزدوج عند إعادة المحاولة. */
(function (root, f) { if (typeof module === 'object') module.exports = f(require('./erp-ops2.js')); else root.Store = f(root.Engine); })(this, function (E) {
  'use strict';
  const userRef = (fb, uid) => fb.ref(fb.db, 'users/' + uid);
  const rev = x => (x && Number(x.rev)) || 0;

  async function run(fb, uid, ctx, opName, input) {
    let fresh; try { fresh = (await fb.get(userRef(fb, uid))).val(); } catch (e) { throw e; }
    if (!fresh) throw E.err('تعذّر قراءة بيانات الحساب من الخادم.', 'no_data');
    if (!(Number(fresh.schemaVersion) >= E.SCHEMA)) throw E.err('بيانات الحساب تحتاج إلى ترقية أولًا (شاشة الترقية).', 'needs_migration');
    let outcome = null, abortErr = null;
    const res = await fb.runTransaction(userRef(fb, uid), cur => {
      if (cur === null) return cur;                       // أول استدعاء قد يكون بلا ذاكرة محلية؛ يعاد بالقيمة الفعلية
      if (rev(cur) < rev(fresh)) return cur;              // نسخة محلية أقدم: لا تحكم عليها، دع المعاملة تُعاد
      try { outcome = E.apply(cur, ctx, opName, input); return outcome.db; }
      catch (e) { if (e && e.erp) { abortErr = e; return; } throw e; }
    });
    if (abortErr) {
      if (abortErr.code === 'duplicate') { const now = (await fb.get(userRef(fb, uid))).val(); return { duplicate: true, db: E.ensure(E.clone(now)), result: null }; }
      throw abortErr;
    }
    if (!res || !res.committed || !outcome) throw E.err('لم تُنفَّذ العملية (تعارض مع تعديل آخر أو انقطاع). أعد المحاولة.', 'not_committed');
    return { db: E.ensure(E.clone(res.snapshot.val())), result: outcome.result };
  }

  // ترقية بنية البيانات داخل معاملة (آمنة ومتكررة): النسخ الاحتياطي يُحاوَل أولًا ولا يمنع الترقية إن فشل
  async function migrate(fb, uid, ctx) {
    const snap = await fb.get(userRef(fb, uid)); const raw = snap.val() || {};
    let backedUp = false;
    if (!(Number(raw.schemaVersion) >= E.SCHEMA)) {
      try { const bref = fb.ref(fb.db, `backups/${uid}/pre_v2`); const ex = await fb.get(bref); if (!ex.exists()) await fb.set(bref, raw); backedUp = true; } catch (e) { backedUp = false; }
    }
    let notes = [];
    const res = await fb.runTransaction(userRef(fb, uid), cur => { if (cur === null) return cur; const m = E.migrate(cur, ctx); notes = m.notes; return m.db; });
    if (!res || !res.committed) throw E.err('تعذّرت ترقية البيانات. لم يتغير شيء.', 'not_committed');
    return { db: E.ensure(E.clone(res.snapshot.val())), notes, backedUp };
  }
  return { run, migrate, userRef };
});
