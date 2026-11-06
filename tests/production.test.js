const test = require('node:test'), assert = require('node:assert');
const { E, factory } = require('./helpers.js');
const mkProd = (s, qty = 2000) => s.go('createProduction', { bomId: s.bom.id, plannedQty: qty, rawWhId: 'wh_raw', fgWhId: 'wh_fg' });

test('الوصفة: المنتج تام والمكونات خام ولا تكرار', () => {
  const s = factory();
  s.fail('upsertBom', { productId: s.id('CON'), outputQty: 10, lines: [{ itemId: s.id('SUG'), qty: 1 }] }, 'bad_product');
  s.fail('upsertBom', { productId: s.id('ORJ'), outputQty: 10, lines: [{ itemId: s.id('ORJ'), qty: 1 }] }, 'bad_component');
  s.fail('upsertBom', { productId: s.id('ORJ'), outputQty: 10, lines: [{ itemId: s.id('SUG'), qty: 1 }, { itemId: s.id('SUG'), qty: 2 }] }, 'dup_line');
  s.fail('upsertBom', { productId: s.id('ORJ'), outputQty: 0, lines: [{ itemId: s.id('SUG'), qty: 1 }] });
  s.fail('upsertBom', { productId: s.id('ORJ'), outputQty: 10, lines: [{ itemId: s.id('SUG'), qty: 1, wastePct: 120 }] });
  s.fail('upsertBom', { productId: s.id('ORJ'), outputQty: 10, lines: [] }, 'no_lines');
});
test('حساب الاحتياج يشمل نسبة الهالك المسموح', () => {
  const s = factory(); const p = mkProd(s, 2000); const r = Object.fromEntries(p.requirement.map(x => [x.itemId, x.required]));
  assert.equal(r[s.id('CON')], 306);      // 150 × 2 × 1.02
  assert.equal(r[s.id('SUG')], 80);       // 40 × 2
  assert.equal(r[s.id('BOT')], 2020);     // 1000 × 2 × 1.01
});
test('فحص توفر المواد: العجز يمنع البدء ويذكر المواد الناقصة', () => {
  const s = factory(); const p = mkProd(s, 10000);   // يحتاج 1530 مركز والمتاح 1000
  const chk = E.checkAvailability(s.db, p.requirement, 'wh_raw'); assert.equal(chk.ok, false);
  assert.equal(chk.lines.find(l => l.name === 'مركز برتقال').shortage, 530);
  const e = s.fail('startProduction', { id: p.id }, 'material_shortage'); assert.match(e.message, /مركز برتقال/); assert.equal(s.db.productions[0].status, 'مسودة');
  s.go('receiptVoucher', { whId: 'wh_raw', reason: 'other', lines: [{ itemId: s.id('CON'), qty: 600, unitCost: 20 }] });
  assert.equal(s.go('startProduction', { id: p.id }).status, 'قيد التنفيذ');
});
test('إكمال الإنتاج: استهلاك، هالك، تكلفة، واستلام منتج تام', () => {
  const s = factory(); const p = mkProd(s, 2000); s.go('startProduction', { id: p.id });
  const done = s.go('completeProduction', { id: p.id, producedQty: 1950, otherCost: 300, consumption: [{ itemId: s.id('CON'), actualQty: 310, wasteQty: 6 }, { itemId: s.id('SUG'), actualQty: 80 }, { itemId: s.id('BOT'), actualQty: 2050, wasteQty: 50 }] });
  assert.equal(done.status, 'مكتمل'); assert.equal(done.materialCost, 310 * 20 + 80 * 5 + 2050 * 1); assert.equal(done.totalCost, 8650 + 300); assert.equal(done.unitCost, 4.5897);   // 8950 ÷ 1950
  assert.equal(done.wasteValue, 120 + 50); assert.equal(done.yieldPct, 97.5); assert.equal(done.consumption.find(c => c.itemId === s.id('CON')).variance, 4);
  assert.equal(s.qty('CON'), 690); assert.equal(s.qty('ORJ', 'wh_fg'), 1950); assert.equal(s.qty('ORJ', 'wh_raw'), 0);
  assert.equal(s.item('ORJ').stockValue, 8950);
  const led = s.db.ledger.filter(e => e.refId === p.id); assert.equal(led.filter(e => e.type === 'production_consume').length, 3); assert.equal(led.filter(e => e.type === 'production_output').length, 1);
  assert.deepEqual(E.verify(s.db), []); assert.equal(E.balances(s.db)['1320'], 8950);
});
test('الإنتاج لا يستهلك أكثر من المتاح ولا يُكمل أمرًا مرتين', () => {
  const s = factory(); const p = mkProd(s, 2000);
  s.fail('completeProduction', { id: p.id, producedQty: 100, consumption: [{ itemId: s.id('CON'), actualQty: 1500 }] }, 'material_shortage'); assert.equal(s.qty('CON'), 1000);
  s.fail('completeProduction', { id: p.id, producedQty: 100, consumption: [{ itemId: s.id('CON'), actualQty: 10, wasteQty: 11 }] }, 'bad_waste');
  s.fail('completeProduction', { id: p.id, producedQty: 0 }); s.fail('completeProduction', { id: p.id, producedQty: -5 });
  s.fail('completeProduction', { id: p.id, producedQty: 10, consumption: [{ itemId: s.id('SUG'), actualQty: 0 }, { itemId: s.id('CON'), actualQty: 0 }, { itemId: s.id('BOT'), actualQty: 0 }] }, 'no_consumption');
  s.fail('completeProduction', { id: p.id, producedQty: 10, consumption: [{ itemId: 'zzz', actualQty: 1 }] }, 'bad_component');
  s.go('completeProduction', { id: p.id, producedQty: 1900 }); s.fail('completeProduction', { id: p.id, producedQty: 1 }, 'bad_status'); s.fail('cancelProduction', { id: p.id }, 'bad_status');
});
test('أمر الإنتاج: المخازن بنوعها الصحيح وإلغاء المسودة بلا أثر مخزني', () => {
  const s = factory();
  s.fail('createProduction', { bomId: s.bom.id, plannedQty: 100, rawWhId: 'wh_fg', fgWhId: 'wh_fg' }); s.fail('createProduction', { bomId: s.bom.id, plannedQty: 100, rawWhId: 'wh_raw', fgWhId: 'wh_raw' });
  const p = mkProd(s, 100); s.go('cancelProduction', { id: p.id }); assert.equal(s.db.productions[0].status, 'ملغي'); assert.equal(s.qty('CON'), 1000);
  s.fail('startProduction', { id: p.id }, 'bad_status'); s.fail('deleteBom', { id: s.bom.id }, 'referenced');
});
test('الإنتاج بتكلفة المتوسط المتحرك بعد استلام مورد بسعر مختلف', () => {
  const s = factory(); s.go('receiptVoucher', { whId: 'wh_raw', reason: 'other', lines: [{ itemId: s.id('SUG'), qty: 400, unitCost: 7 }] });   // متوسط السكر 6
  const p = mkProd(s, 1000); const d = s.go('completeProduction', { id: p.id, producedQty: 1000 }); assert.equal(d.consumption.find(c => c.itemId === s.id('SUG')).cost, 240);
});
