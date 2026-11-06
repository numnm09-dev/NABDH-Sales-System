const E = require('../js/erp-ops2.js');
let n = 0;
const ctx = (o = {}) => ({ opId: 'op' + (++n), user: 'tester@nabdh', now: '2026-11-04T10:00:00.000Z', today: '2026-11-04', ...o });
// ينفّذ عملية ويُرجع { db, r } مع تحديث الحالة؛ يرمي الخطأ كما هو
function mk() {
  const st = { db: E.migrate({}, { now: '2026-11-01T08:00:00.000Z' }).db };
  st.go = (name, inp, c) => { const x = E.apply(st.db, ctx(c), name, inp); st.db = x.db; return x.result; };
  st.fail = (name, inp, code) => { const before = JSON.stringify(st.db); let e; try { E.apply(st.db, ctx(), name, inp); } catch (x) { e = x; } if (!e) throw new Error('كان يجب أن تفشل العملية ' + name); if (code && e.code !== code) throw new Error(`رمز الخطأ ${e.code} بدل ${code}: ${e.message}`); if (JSON.stringify(st.db) !== before) throw new Error('تغيّرت البيانات رغم الفشل'); return e; };
  st.item = code => st.db.items.find(i => i.code === code);
  st.qty = (code, wh) => wh ? E.stockOf(st.db, st.item(code).id, wh) : st.item(code).qty;
  return st;
}
// بيئة مصنع عصائر: مواد خام + منتج تام + وصفة + عملاء + مورد + رأس مال
function factory() {
  const s = mk();
  s.go('upsertItem', { code: 'CON', name: 'مركز برتقال', type: 'raw', unit: 'لتر', min: 100, price: 20, daily: 50, lead: 5, inbound: 3, delay: 0 });
  s.go('upsertItem', { code: 'SUG', name: 'سكر', type: 'raw', unit: 'كجم', min: 50, price: 5, daily: 20, lead: 3, inbound: 2, delay: 0 });
  s.go('upsertItem', { code: 'BOT', name: 'عبوة 250مل', type: 'raw', unit: 'قطعة', min: 500, price: 1, daily: 300, lead: 4, inbound: 2, delay: 0 });
  s.go('upsertItem', { code: 'ORJ', name: 'عصير برتقال 250مل', type: 'finished', unit: 'عبوة', min: 100, salePrice: 6 });
  s.go('upsertSupplier', { name: 'شركة المزارع', itemCodes: 'CON,SUG', price: 20, lead: 5, quality: 4, moq: 50, verified: 'تم التحقق' });
  s.go('upsertCustomer', { name: 'سوبر ماركت النور', creditLimit: 5000 });
  s.go('cashEntry', { kind: 'capital_in', amount: 100000, note: 'رأس مال افتتاحي' });
  const id = c => s.item(c).id;
  s.go('receiptVoucher', { whId: 'wh_raw', reason: 'opening', lines: [{ itemId: id('CON'), qty: 1000, unitCost: 20 }, { itemId: id('SUG'), qty: 400, unitCost: 5 }, { itemId: id('BOT'), qty: 20000, unitCost: 1 }] });
  s.bom = s.go('upsertBom', { productId: id('ORJ'), outputQty: 1000, name: 'وصفة برتقال', lines: [{ itemId: id('CON'), qty: 150, wastePct: 2 }, { itemId: id('SUG'), qty: 40, wastePct: 0 }, { itemId: id('BOT'), qty: 1000, wastePct: 1 }] });
  s.id = id; s.cust = s.db.customers[0]; s.sup = s.db.suppliers[0];
  return s;
}
module.exports = { E, ctx, mk, factory };
