const test = require('node:test'), assert = require('node:assert'), C = require('../js/calc.js');
test('أيام التغطية', () => { assert.equal(C.coverDays(600, 100), 6); assert.equal(C.coverDays(10, 0), null); assert.equal(C.coverDays('', 5), null); assert.equal(C.coverDays(-1, 5), null); });
test('الفجوة والحالة', () => { const it = { qty: 600, daily: 100, min: 300, inbound: 2, delay: 10 }; assert.equal(C.gapDays(it), 6); assert.equal(C.status(it).k, 'crit'); assert.equal(C.status({ ...it, delay: 0 }).k, 'ok'); });
test('كمية إعادة الطلب', () => { assert.equal(C.reorderQty({ qty: 600, daily: 100 }, 3, 3, 0), 0); assert.equal(C.reorderQty({ qty: 600, daily: 100 }, 7, 3, 500), 500); });
test('ترتيب البدلاء يستبعد المورد الحالي', () => {
  const it = { code: 'A', supplierId: 's1' }, S = [{ id: 's1', itemCodes: 'A', price: 1, lead: 1, quality: 5 }, { id: 's2', itemCodes: 'A', price: 2, lead: 2, quality: 4 }, { id: 's3', itemCodes: 'B', price: 1, lead: 1, quality: 5 }];
  const r = C.rank(it, S); assert.equal(r.length, 1); assert.equal(r[0].s.id, 's2');
});
test('مقارنة الانتظار بالبديل', () => {
  const it = { qty: 600, daily: 100, price: 10, inbound: 2, delay: 10 }, c = C.compare(it, { lead: 3, price: 11.5, moq: 200 });
  assert.equal(c.waitShort, 6); assert.equal(c.altShort, 0); assert.equal(c.qty, 900); assert.equal(c.extraCost, 1350);
});
