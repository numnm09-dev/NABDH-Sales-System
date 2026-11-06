const test = require('node:test'), assert = require('node:assert');
const { E, ctx, mk, factory } = require('./helpers.js');

test('سند استلام يزيد الرصيد ويكتب الدفتر والقيد المحاسبي', () => {
  const s = mk(); s.go('upsertItem', { code: 'A', name: 'مادة', type: 'raw' });
  const v = s.go('receiptVoucher', { whId: 'wh_raw', reason: 'opening', lines: [{ itemId: s.item('A').id, qty: 100, unitCost: 3 }] });
  assert.equal(s.qty('A'), 100); assert.equal(s.qty('A', 'wh_raw'), 100); assert.equal(s.item('A').stockValue, 300);
  const led = s.db.ledger.filter(e => e.refId === v.id); assert.equal(led.length, 1); assert.equal(led[0].qtyIn, 100); assert.equal(led[0].balanceAfter, 100);
  assert.equal(E.balances(s.db)['1310'], 300); assert.deepEqual(E.verify(s.db), []);
  assert.ok(s.db.audit.some(a => a.entity === 'voucher' && a.entityId === v.id));
});
test('لا رصيد سالب: صرف أكبر من المتاح يُرفض ولا يغيّر شيئًا', () => {
  const s = mk(); s.go('upsertItem', { code: 'A', name: 'مادة', type: 'raw', openingQty: 10, openingCost: 2 });
  const e = s.fail('issueVoucher', { whId: 'wh_raw', reason: 'scrap', lines: [{ itemId: s.item('A').id, qty: 10.5 }] }, 'insufficient_stock');
  assert.match(e.message, /المتاح 10/); assert.equal(s.qty('A'), 10);
});
test('الصرف حتى الصفر مسموح وتتصفّر القيمة تمامًا', () => {
  const s = mk(); s.go('upsertItem', { code: 'A', name: 'مادة', type: 'raw', openingQty: 3, openingCost: 3.333 });
  s.go('issueVoucher', { whId: 'wh_raw', reason: 'internal', lines: [{ itemId: s.item('A').id, qty: 3 }] });
  assert.equal(s.qty('A'), 0); assert.equal(s.item('A').stockValue, 0); assert.deepEqual(E.verify(s.db), []);
});
test('فشل بند ثانٍ يلغي السند كله (ذرّية)', () => {
  const s = mk(); s.go('upsertItem', { code: 'A', name: 'أ', type: 'raw', openingQty: 10, openingCost: 1 }); s.go('upsertItem', { code: 'B', name: 'ب', type: 'raw', openingQty: 1, openingCost: 1 });
  s.fail('issueVoucher', { whId: 'wh_raw', reason: 'scrap', lines: [{ itemId: s.item('A').id, qty: 5 }, { itemId: s.item('B').id, qty: 2 }] }, 'insufficient_stock');
  assert.equal(s.qty('A'), 10);
});
test('منع تكرار العملية بنفس المعرّف', () => {
  const s = mk(); s.go('upsertItem', { code: 'A', name: 'أ', type: 'raw' }); const c = ctx({ opId: 'same-op' }); const inp = { whId: 'wh_raw', reason: 'other', lines: [{ itemId: s.item('A').id, qty: 5, unitCost: 1 }] };
  const r = E.apply(s.db, c, 'receiptVoucher', inp); s.db = r.db; assert.equal(s.qty('A'), 5);
  assert.throws(() => E.apply(s.db, c, 'receiptVoucher', inp), e => e.code === 'duplicate'); assert.equal(s.qty('A'), 5);
});
test('معرّف عملية غير صالح يُرفض', () => { const s = mk(); assert.throws(() => E.apply(s.db, { opId: '' }, 'upsertItem', {}), e => e.code === 'no_op_id'); assert.throws(() => E.apply(s.db, { opId: 'a.b' }, 'upsertItem', {}), e => e.code === 'no_op_id'); });
test('فصل المواد الخام عن المنتجات التامة', () => {
  const s = factory();
  const e = s.fail('receiptVoucher', { whId: 'wh_fg', reason: 'other', lines: [{ itemId: s.id('CON'), qty: 1, unitCost: 1 }] }, 'wrong_warehouse'); assert.match(e.message, /منفصل/);
  s.fail('receiptVoucher', { whId: 'wh_raw', reason: 'other', lines: [{ itemId: s.id('ORJ'), qty: 1, unitCost: 1 }] }, 'wrong_warehouse');
  s.go('upsertWarehouse', { code: 'WH-03', name: 'مخزن تعبئة', kind: 'raw' }); const w3 = s.db.warehouses.find(w => w.code === 'WH-03');
  s.fail('transferVoucher', { fromWhId: 'wh_raw', toWhId: 'wh_fg', lines: [{ itemId: s.id('SUG'), qty: 1 }] }, 'kind_mismatch');
  s.go('transferVoucher', { fromWhId: 'wh_raw', toWhId: w3.id, lines: [{ itemId: s.id('SUG'), qty: 100 }] });
  assert.equal(s.qty('SUG', 'wh_raw'), 300); assert.equal(s.qty('SUG', w3.id), 100); assert.equal(s.qty('SUG'), 400);
  s.fail('transferVoucher', { fromWhId: w3.id, toWhId: 'wh_raw', lines: [{ itemId: s.id('SUG'), qty: 101 }] }, 'insufficient_stock');
  s.fail('transferVoucher', { fromWhId: 'wh_raw', toWhId: 'wh_raw', lines: [{ itemId: s.id('SUG'), qty: 1 }] }, 'same_wh');
  assert.deepEqual(E.verify(s.db), []);
});
test('التسوية: فرق بالزيادة والنقص، سبب مطلوب، ولا فرق = رفض', () => {
  const s = factory(); const sug = s.id('SUG');
  s.fail('adjustmentVoucher', { whId: 'wh_raw', reason: '', lines: [{ itemId: sug, countedQty: 390 }] }, 'reason_required');
  s.fail('adjustmentVoucher', { whId: 'wh_raw', reason: 'جرد دوري', lines: [{ itemId: sug, countedQty: 400 }] }, 'no_diff');
  s.fail('adjustmentVoucher', { whId: 'wh_raw', reason: 'جرد دوري', lines: [{ itemId: sug, countedQty: -1 }] });
  s.go('adjustmentVoucher', { whId: 'wh_raw', reason: 'جرد دوري', lines: [{ itemId: sug, countedQty: 390 }] }); assert.equal(s.qty('SUG'), 390);
  assert.equal(E.balances(s.db)['5300'], 50);
  s.go('adjustmentVoucher', { whId: 'wh_raw', reason: 'عثر على زيادة', lines: [{ itemId: sug, countedQty: 395 }] }); assert.equal(s.qty('SUG'), 395); assert.deepEqual(E.verify(s.db), []);
});
test('متوسط التكلفة المتحرك', () => {
  const s = mk(); s.go('upsertItem', { code: 'A', name: 'أ', type: 'raw' }); const id = s.item('A').id;
  s.go('receiptVoucher', { whId: 'wh_raw', reason: 'other', lines: [{ itemId: id, qty: 100, unitCost: 10 }] }); s.go('receiptVoucher', { whId: 'wh_raw', reason: 'other', lines: [{ itemId: id, qty: 100, unitCost: 20 }] });
  const v = s.go('issueVoucher', { whId: 'wh_raw', reason: 'internal', lines: [{ itemId: id, qty: 50 }] }); assert.equal(v.lines[0].value, 750); assert.equal(s.item('A').stockValue, 2250);
});
test('تنبيه الحد الأدنى بعد الصرف + قائمة النواقص', () => {
  const s = factory(); const v = s.go('issueVoucher', { whId: 'wh_raw', reason: 'scrap', lines: [{ itemId: s.id('CON'), qty: 905 }] });
  assert.equal(v.alerts.length, 1); assert.match(v.alerts[0].text, /مركز برتقال/); assert.ok(E.lowStock(s.db).some(i => i.code === 'CON')); assert.ok(!s.db.vouchers.some(x => x.alerts), 'التنبيهات لا تُحفظ في البيانات');
});
test('مدخلات غير صالحة تُرفض', () => {
  const s = mk(); s.go('upsertItem', { code: 'A', name: 'أ', type: 'raw', openingQty: 10, openingCost: 1 }); const id = s.item('A').id;
  for (const q of [0, -1, NaN, '', 'abc', null, Infinity, 1e12]) s.fail('issueVoucher', { whId: 'wh_raw', reason: 'scrap', lines: [{ itemId: id, qty: q }] });
  s.fail('issueVoucher', { whId: 'wh_raw', reason: 'scrap', lines: [] }, 'no_lines'); s.fail('issueVoucher', { whId: 'nope', reason: 'scrap', lines: [{ itemId: id, qty: 1 }] }, 'not_found');
  s.fail('issueVoucher', { whId: 'wh_raw', reason: 'zzz', lines: [{ itemId: id, qty: 1 }] }); s.fail('issueVoucher', { whId: 'wh_raw', reason: 'scrap', date: '2026-13-45', lines: [{ itemId: id, qty: 1 }] }, 'bad_date');
  s.fail('receiptVoucher', { whId: 'wh_raw', reason: 'other', lines: [{ itemId: id, qty: 1, unitCost: -5 }] }); s.fail('issueVoucher', { whId: 'wh_raw', reason: 'scrap', lines: [{ itemId: id, qty: 1 }, { itemId: id, qty: 1 }] }, 'dup_line');
});
test('حماية الأصناف: كود مكرر، حذف صنف له رصيد/حركات، تغيير النوع', () => {
  const s = factory(); s.fail('upsertItem', { code: 'CON', name: 'x', type: 'raw' }, 'dup_dode'.replace('dode', 'code'));
  s.fail('deleteItem', { id: s.id('CON') }, 'has_stock'); s.fail('upsertItem', { id: s.id('CON'), type: 'finished' }, 'type_locked');
  s.go('upsertItem', { code: 'TMP', name: 'مؤقت', type: 'raw' }); s.go('deleteItem', { id: s.item('TMP').id }); assert.equal(s.item('TMP'), undefined);
  s.go('upsertItem', { id: s.id('CON'), name: 'مركز برتقال طبيعي' }); assert.equal(s.item('CON').qty, 1000); // التعديل لا يمسّ الرصيد
  s.go('upsertItem', { id: s.id('CON'), qty: 5 }); assert.equal(s.item('CON').qty, 1000);   // لا تعديل مباشر للكمية
});
test('اختبار عشوائي: بعد مئات العمليات تبقى كل قواعد السلامة صحيحة', () => {
  const s = factory(); let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; const raws = ['CON', 'SUG', 'BOT'].map(c => s.id(c)); let ok = 0, rejected = 0;
  s.go('upsertWarehouse', { code: 'WH-03', name: 'مخزن 3', kind: 'raw' }); const w3 = s.db.warehouses.find(w => w.code === 'WH-03').id;
  for (let i = 0; i < 400; i++) {
    const it = raws[Math.floor(rnd() * 3)], q = Math.round(rnd() * 500) / 10 + 0.1, k = Math.floor(rnd() * 5);
    try {
      if (k === 0) s.go('receiptVoucher', { whId: rnd() > .5 ? 'wh_raw' : w3, reason: 'other', lines: [{ itemId: it, qty: q, unitCost: Math.round(rnd() * 100) / 10 }] });
      else if (k === 1) s.go('issueVoucher', { whId: rnd() > .5 ? 'wh_raw' : w3, reason: 'scrap', lines: [{ itemId: it, qty: q * 5 }] });
      else if (k === 2) s.go('transferVoucher', { fromWhId: 'wh_raw', toWhId: w3, lines: [{ itemId: it, qty: q * 3 }] });
      else if (k === 3) s.go('adjustmentVoucher', { whId: 'wh_raw', reason: 'جرد عشوائي', lines: [{ itemId: it, countedQty: Math.round(rnd() * 2000) / 10 }] });
      else { const p = s.go('createProduction', { bomId: s.bom.id, plannedQty: Math.round(rnd() * 200) + 1, rawWhId: 'wh_raw', fgWhId: 'wh_fg' }); s.go('completeProduction', { id: p.id, producedQty: Math.round(rnd() * 150) + 1 }); }
      ok++;
    } catch (e) { assert.ok(e.erp, 'خطأ غير متوقع: ' + e.stack); rejected++; }
    if (i % 25 === 0) assert.deepEqual(E.verify(s.db), []);
  }
  assert.deepEqual(E.verify(s.db), []); assert.ok(ok > 50 && rejected > 10, `ok=${ok} rejected=${rejected}`);
  for (const it of s.db.items) for (const q of Object.values(s.db.stock[it.id] || {})) assert.ok(q >= 0);
});
