/* محاكي بسيط لسلوك Firebase Realtime Database المهم لنا (للاختبارات فقط؛ ليس بديلًا عن اختبار حقيقي):
   - يرفض القيم undefined ويحذف null والمصفوفات/الكائنات الفارغة
   - يحوّل المصفوفات إلى كائنات بمفاتيح رقمية ثم يعيدها مصفوفات إن كانت المفاتيح متتابعة
   - runTransaction: أول استدعاء بقيمة null (ذاكرة باردة) ثم إعادة المحاولة بالقيمة الفعلية، ويمكن حقن تعديل متزامن */
function createFake(initial) {
  let root = {};
  const clean = v => {
    if (v === undefined) throw new Error('Firebase: القيمة تحتوي على undefined');
    if (v === null) return null;
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('Firebase: رقم غير صالح'); return v; }
    if (typeof v !== 'object') return v;
    const out = {};
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
    for (const [k, x] of entries) { if (/[.$#\[\]\/]/.test(k)) throw new Error('Firebase: مفتاح غير صالح ' + k); const c = clean(x); if (c !== null) out[k] = c; }
    return Object.keys(out).length ? out : null;
  };
  const arrayish = o => { const ks = Object.keys(o); if (!ks.length || !ks.every(k => /^\d+$/.test(k))) return false; return Math.max(...ks.map(Number)) < 2 * ks.length; };
  const out = v => { if (v === null || typeof v !== 'object') return v; const o = {}; for (const [k, x] of Object.entries(v)) o[k] = out(x); if (arrayish(o)) { const a = []; for (const [k, x] of Object.entries(o)) a[Number(k)] = x; return a; } return o; };
  const parts = p => String(p).split('/').filter(Boolean);
  const getAt = p => { let c = root; for (const k of parts(p)) { if (c == null || typeof c !== 'object') return null; c = c[k]; } return c === undefined ? null : c; };
  const setAt = (p, v) => { const ks = parts(p), c = clean(v); if (!ks.length) { root = c || {}; return; } let cur = root; for (const k of ks.slice(0, -1)) { if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {}; cur = cur[k]; } if (c === null) delete cur[ks[ks.length - 1]]; else cur[ks[ks.length - 1]] = c; };
  const snap = v => ({ val: () => out(JSON.parse(JSON.stringify(v))), exists: () => v !== null && v !== undefined });
  const hooks = { beforeCommit: null, calls: 0 };
  const fb = {
    db: {}, auth: {},
    ref: (_db, p) => ({ path: p }),
    get: async r => snap(getAt(r.path)),
    set: async (r, v) => { setAt(r.path, v); },
    update: async (r, v) => { for (const [k, x] of Object.entries(v)) setAt(r.path + '/' + k, x); },
    runTransaction: async (r, fn) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        hooks.calls++;
        const local = attempt === 0 ? null : getAt(r.path);          // الذاكرة الباردة تعطي null أولًا
        const next = fn(local === null ? null : out(JSON.parse(JSON.stringify(local))));
        if (next === undefined) return { committed: false, snapshot: snap(getAt(r.path)) };
        if (hooks.beforeCommit && local !== null) { const h = hooks.beforeCommit; hooks.beforeCommit = null; h(); }   // جهاز آخر يكتب بعد أن حسبنا نتيجتنا
        // كما يفعل Firebase: إن اختلفت قيمة الخادم عمّا بنينا عليه نتيجتنا تُعاد المحاولة بالقيمة الجديدة
        if (JSON.stringify(getAt(r.path)) !== JSON.stringify(local)) continue;
        setAt(r.path, next); return { committed: true, snapshot: snap(getAt(r.path)) };
      }
      return { committed: false, snapshot: snap(getAt(r.path)) };
    }
  };
  if (initial) setAt('', initial);
  return { fb, hooks, raw: () => root, setAt, getAt };
}
if (typeof module === 'object') module.exports = { createFake };
