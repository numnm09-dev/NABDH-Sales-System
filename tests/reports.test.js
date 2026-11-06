const test = require('node:test'), assert = require('node:assert');
const { E, factory } = require('./helpers.js'); const R = require('../js/erp-reports.js'); const X = require('../js/xlsx-lite.js');
function world() {
  const s = factory(); const po = s.go('createPO', { supplierId: s.sup.id, date: '2026-10-10', lines: [{ itemId: s.id('CON'), qty: 100, price: 21 }] }); s.go('setPOStatus', { id: po.id, status: 'مُرسل' }); s.go('receiveGoods', { poId: po.id, whId: 'wh_raw', date: '2026-10-12', lines: [{ itemId: s.id('CON'), qty: 100 }] });
  const p = s.go('createProduction', { bomId: s.bom.id, plannedQty: 2000, rawWhId: 'wh_raw', fgWhId: 'wh_fg', date: '2026-10-20' }); s.go('completeProduction', { id: p.id, producedQty: 1900, otherCost: 200, consumption: [{ itemId: s.id('CON'), actualQty: 320, wasteQty: 10 }] });
  s.go('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, date: '2026-11-02', lines: [{ itemId: s.id('ORJ'), qty: 300, unitPrice: 6 }], paid: 600, method: 'نقدي' });
  s.go('issueVoucher', { whId: 'wh_raw', reason: 'scrap', date: '2026-11-03', lines: [{ itemId: s.id('SUG'), qty: 290 }] });   // يبقى 30 من السكر (الحد 50)
  return s;
}
const sec = (r, t) => r.sections.find(x => x.title.startsWith(t));

test('كل التقارير تُنتج أقسامًا وأعمدة وصفوفًا بالشكل المتفق عليه', () => {
  const s = world(); for (const [id, fn] of Object.entries(R.REPORTS)) { const r = fn(s.db, {}); assert.ok(r.title && r.sections.length, id); for (const sc of r.sections) { assert.ok(sc.columns.length, id); const m = R.toMatrix(sc); assert.equal(m[0].length, sc.columns.length); assert.ok(m.every(row => row.length === sc.columns.length)); } }
});
test('تقرير المخزون: أرصدة بالمخازن وتنبيه الحد الأدنى ومطابقة القيمة للأستاذ', () => {
  const s = world(), r = R.inventory(s.db, {}), rows = sec(r, 'أرصدة').rows;
  assert.equal(rows.find(x => x.code === 'ORJ').qty, 1600); assert.equal(rows.find(x => x.code === 'ORJ').wh, 'مخزن المنتجات التامة'); assert.equal(rows.find(x => x.code === 'SUG').status, 'تحت الحد الأدنى');
  assert.equal(sec(r, 'أرصدة').totals.value, E.r2(E.balances(s.db)['1310'] + E.balances(s.db)['1320'])); assert.ok(sec(r, 'تنبيهات').rows.some(x => x.code === 'SUG'));
  assert.equal(R.inventory(s.db, { whId: 'wh_fg' }).sections[0].rows.length, 1);
  const past = R.inventory(s.db, { to: '2026-10-15' }).sections[0].rows; assert.equal(past.find(x => x.code === 'ORJ'), undefined); assert.equal(past.find(x => x.code === 'CON').qty, 100);   // الأرصدة التاريخية: الرصيد الافتتاحي مؤرخ 2026-11-04 فلا يظهر، وبقي استلام 10-12 فقط
});
test('دفتر الحركة: فلاتر التاريخ والصنف والنوع وإجماليات الوارد/الصادر', () => {
  const s = world(); const all = R.movements(s.db, {}).sections[0]; const oct = R.movements(s.db, { from: '2026-10-01', to: '2026-10-31' }).sections[0];
  assert.ok(oct.rows.length < all.rows.length && oct.rows.every(r => r.date >= '2026-10-01' && r.date <= '2026-10-31'));
  const con = R.movements(s.db, { itemId: s.id('CON') }).sections[0]; assert.ok(con.rows.every(r => r.item === 'مركز برتقال')); assert.equal(R.movements(s.db, { type: 'sale' }).sections[0].rows.length, 1);
  assert.equal(all.totals.qin - all.totals.qout, E.r3(s.db.items.reduce((a, i) => a + i.qty, 0)));
});
test('تقرير الإنتاج: التكلفة والهالك والانحراف', () => {
  const s = world(), r = R.production(s.db, {}), row = r.sections[0].rows[0]; assert.equal(row.status, 'مكتمل'); assert.equal(row.produced, 1900); assert.equal(row.yieldPct, 95); assert.ok(row.total > 0 && row.unit > 0);
  const v = r.sections[1].rows.find(x => x.item === 'مركز برتقال'); assert.equal(v.act, 320); assert.equal(v.waste, 10); assert.equal(v.var, 14);   // المعياري 306
  assert.equal(R.production(s.db, { from: '2026-11-01' }).sections[0].rows.length, 0);
});
test('تقرير المبيعات والمشتريات: إجماليات وأرصدة', () => {
  const s = world(), r = R.sales(s.db, {}); assert.equal(r.sections[0].totals.total, 1800); assert.equal(r.sections[0].totals.due, 1200); assert.equal(R.sales(s.db, { customerId: 'x' }).sections[0].rows.length, 0);
  const p = R.purchasing(s.db, {}); assert.equal(p.sections[0].totals.total, 2100); assert.equal(p.sections[3].totals.due, 2100); assert.equal(R.purchasing(s.db, { from: '2026-11-01' }).sections[0].rows.length, 0);
});
test('لوحة المؤشرات تطابق الأستاذ العام', () => {
  const s = world(), k = R.dashboard(s.db, '2026-11-04'); const b = E.balances(s.db);
  assert.equal(k.cash, b['1100']); assert.equal(k.receivables, b['1200']); assert.equal(k.inventoryRaw, b['1310']); assert.equal(k.inventoryFinished, b['1320']); assert.equal(k.salesMonth, 1800); assert.equal(k.salesToday, 0); assert.equal(k.lowStock, 1); assert.equal(k.series.length, 7);
});
test('تقرير مخاطر الذكاء الاصطناعي: الاستهلاك الفعلي والعجز وسجل القرارات البشرية', () => {
  const s = world(); s.go('upsertItem', { id: s.id('CON'), qty: undefined, daily: 50, inbound: 3, delay: 10 });
  const open = s.go('createProduction', { bomId: s.bom.id, plannedQty: 50000, rawWhId: 'wh_raw', fgWhId: 'wh_fg' }); void open;
  const r = R.aiRisk(s.db, { to: '2026-11-04' }); const con = r.sections[0].rows.find(x => x.code === 'CON'); assert.ok(['مرتفع', 'متوسط', 'منخفض'].includes(con.risk)); assert.ok(con.actual > 0);
  assert.ok(r.sections[1].rows.some(x => x.item === 'مركز برتقال' && x.shortage > 0), 'عجز أوامر الإنتاج المفتوحة');
  s.fail('recordAiDecision', { itemId: s.id('CON'), decision: 'maybe' }); s.go('recordAiDecision', { itemId: s.id('CON'), decision: 'rejected', riskLevel: 'high', summary: 'ملخص', note: 'ننتظر الشحنة' });
  const dec = R.aiRisk(s.db, {}).sections[2].rows; assert.equal(dec.length, 1); assert.equal(dec[0].decision, 'رُفضت'); assert.ok(s.db.audit.some(a => a.action === 'ai-decision'));
  assert.equal(s.item('CON').qty, 1000 + 100 - 320, 'قرار الذكاء الاصطناعي لا يغيّر المخزون');
});
test('سجل المراجعة يسجّل كل عملية ولا يُكتب فوقه', () => {
  const s = world(); const n = s.db.audit.length; assert.ok(n > 10); s.go('recordExpense', { category: 'إيجار', amount: 5, method: 'نقدي' }); assert.equal(s.db.audit.length, n + 1);
  const a = R.auditReport(s.db, {}).sections[0].rows; assert.equal(a.length, n + 1); assert.equal(a[0].entity, 'expense');
});
test('تصدير Excel حقيقي: ملف ZIP/OOXML صالح بأوراق RTL', () => {
  const s = world(); const f = R.finance(s.db, {}); const u8 = X.build(f.sections.map(x => ({ name: x.title, rows: R.toMatrix(x) })));
  assert.equal(u8[0], 0x50); assert.equal(u8[1], 0x4b); const txt = Buffer.from(u8).toString('latin1'); assert.ok(txt.includes('xl/workbook.xml') && txt.includes('rightToLeft="1"'));
});
