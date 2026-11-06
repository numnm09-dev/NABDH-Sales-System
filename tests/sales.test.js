const test = require('node:test'), assert = require('node:assert');
const { E, factory } = require('./helpers.js');
function stocked() { const s = factory(); const p = s.go('createProduction', { bomId: s.bom.id, plannedQty: 2000, rawWhId: 'wh_raw', fgWhId: 'wh_fg' }); s.go('completeProduction', { id: p.id, producedQty: 2000, otherCost: 0 }); return s; }

test('البيع يخصم المنتج التام تلقائيًا ويسجّل التكلفة والإيراد', () => {
  const s = stocked(); const cost = s.item('ORJ').stockValue / 2000;
  const inv = s.go('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, lines: [{ itemId: s.id('ORJ'), qty: 500, unitPrice: 6 }], paid: 3000, method: 'نقدي' });
  assert.equal(s.qty('ORJ'), 1500); assert.equal(inv.total, 3000); assert.equal(inv.cogs, Math.round(500 * cost * 100) / 100);
  const led = s.db.ledger.filter(e => e.refId === inv.id); assert.equal(led.length, 1); assert.equal(led[0].type, 'sale'); assert.equal(led[0].qtyOut, 500);
  assert.equal(E.balances(s.db)['4100'], -3000); assert.equal(E.balances(s.db)['5100'], inv.cogs); assert.deepEqual(E.verify(s.db), []);
});
test('البيع بكمية أكبر من المتاح أو لمادة خام أو من مخزن خاطئ يُرفض', () => {
  const s = stocked(); s.go('upsertCustomer', { id: s.cust.id, name: s.cust.name, creditLimit: 0 });   // بلا حد ائتمان حتى يظهر خطأ المخزون لا الائتمان
  const base = { whId: 'wh_fg', customerId: s.cust.id, paid: 0 };
  s.fail('createInvoice', { ...base, lines: [{ itemId: s.id('ORJ'), qty: 2000.5, unitPrice: 6 }] }, 'insufficient_stock'); assert.equal(s.qty('ORJ'), 2000);
  s.fail('createInvoice', { ...base, lines: [{ itemId: s.id('CON'), qty: 1, unitPrice: 6 }] }, 'not_sellable'); s.fail('createInvoice', { ...base, whId: 'wh_raw', lines: [{ itemId: s.id('ORJ'), qty: 1, unitPrice: 6 }] }, 'wrong_warehouse');
  for (const q of [0, -3, '', NaN]) s.fail('createInvoice', { ...base, lines: [{ itemId: s.id('ORJ'), qty: q, unitPrice: 6 }] });
  s.fail('createInvoice', { ...base, lines: [{ itemId: s.id('ORJ'), qty: 1, unitPrice: -6 }] }); s.fail('createInvoice', { ...base, lines: [] }, 'no_lines');
  s.fail('createInvoice', { ...base, lines: [{ itemId: s.id('ORJ'), qty: 1500, unitPrice: 6 }, { itemId: s.id('ORJ'), qty: 600, unitPrice: 6 }] }, 'dup_line');
});
test('البيع الآجل: عميل مسجّل مطلوب، حد الائتمان، الخصم، والمدفوع', () => {
  const s = stocked(); const L = [{ itemId: s.id('ORJ'), qty: 100, unitPrice: 6 }];
  s.fail('createInvoice', { whId: 'wh_fg', lines: L, customerName: 'عابر', paid: 100 }, 'credit_needs_customer');
  s.fail('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, lines: [{ itemId: s.id('ORJ'), qty: 1000, unitPrice: 6 }], paid: 0 }, 'credit_limit');   // 6000 > 5000
  s.fail('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, lines: L, paid: 700, method: 'نقدي' }, 'overpay'); s.fail('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, lines: L, discount: 601, paid: 0 }, 'bad_discount');
  s.fail('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, lines: L, paid: 100 }, undefined);   // طريقة الدفع مطلوبة
  const cash = s.go('createInvoice', { whId: 'wh_fg', lines: L, customerName: 'زبون', discount: 50, method: 'نقدي' }); assert.equal(cash.total, 550); assert.equal(cash.paid, 550); assert.equal(s.db.sales[0].lines[0].net, 550);
  const cr = s.go('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, lines: L, paid: 200, method: 'تحويل بنكي' }); assert.equal(E.arBalance(s.db, s.cust.id), 400); assert.equal(E.saleOutstanding(cr), 400);
});
test('التحصيل: توزيع على الأقدم، ولا تحصيل أكبر من المستحق', () => {
  const s = stocked(); const L = n => [{ itemId: s.id('ORJ'), qty: n, unitPrice: 6 }];
  const a = s.go('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, lines: L(100), date: '2026-11-01' }), b = s.go('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, lines: L(100), date: '2026-11-02' });
  s.fail('collectPayment', { customerId: s.cust.id, amount: 1201, method: 'نقدي' }, 'overpay');
  const c = s.go('collectPayment', { customerId: s.cust.id, amount: 800, method: 'نقدي' }); assert.deepEqual(c.allocations.map(x => [x.saleNo, x.amount]), [[a.no, 600], [b.no, 200]]);
  assert.equal(E.arBalance(s.db, s.cust.id), 400); s.go('collectPayment', { customerId: s.cust.id, amount: 400, method: 'نقدي', saleId: b.id }); assert.equal(E.arBalance(s.db, s.cust.id), 0); s.fail('collectPayment', { customerId: s.cust.id, amount: 1, method: 'نقدي' }, 'overpay'); assert.deepEqual(E.verify(s.db), []);
});
test('المرتجعات: إعادة للمخزون، تخفيض الذمم أو رد نقدي، ولا إفراط', () => {
  const s = stocked(); const inv = s.go('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, lines: [{ itemId: s.id('ORJ'), qty: 100, unitPrice: 6 }], paid: 200, method: 'نقدي' });  // متبقٍ 400
  const r1 = s.go('createReturn', { saleId: inv.id, lines: [{ itemId: s.id('ORJ'), qty: 50 }], refundMethod: 'نقدي' }); assert.equal(r1.total, 300); assert.equal(r1.arReduce, 300); assert.equal(r1.refund, 0); assert.equal(s.qty('ORJ'), 1950);
  const r2 = s.go('createReturn', { saleId: inv.id, lines: [{ itemId: s.id('ORJ'), qty: 50 }], refundMethod: 'نقدي' }); assert.equal(r2.arReduce, 100); assert.equal(r2.refund, 200);   // الباقي 100 ثم يُرد 200 نقدًا
  const sale = s.db.sales.find(x => x.id === inv.id); assert.equal(sale.returned, 600); assert.equal(sale.paid, 0); assert.equal(E.saleOutstanding(sale), 0); assert.equal(E.arBalance(s.db, s.cust.id), 0);
  s.fail('createReturn', { saleId: inv.id, lines: [{ itemId: s.id('ORJ'), qty: 1 }], refundMethod: 'نقدي' }, 'over_return'); assert.equal(s.qty('ORJ'), 2000); assert.deepEqual(E.verify(s.db), []);
  assert.equal(E.balances(s.db)['5100'], 0);   // أُعيدت التكلفة كاملة
});
test('مرتجع تالف لا يعود للمخزون ولا يعكس التكلفة', () => {
  const s = stocked(); const inv = s.go('createInvoice', { whId: 'wh_fg', lines: [{ itemId: s.id('ORJ'), qty: 100, unitPrice: 6 }], customerName: 'زبون', method: 'نقدي' });
  s.fail('createReturn', { saleId: inv.id, lines: [{ itemId: s.id('ORJ'), qty: 10 }], restock: false }, 'method_required');
  s.go('createReturn', { saleId: inv.id, lines: [{ itemId: s.id('ORJ'), qty: 10 }], restock: false, refundMethod: 'نقدي' }); assert.equal(s.qty('ORJ'), 1900); assert.equal(E.balances(s.db)['5100'], inv.cogs); assert.deepEqual(E.verify(s.db), []);
});
test('إلغاء الفاتورة يعيد المخزون بتكلفته الأصلية ويعكس القيود', () => {
  const s = stocked(); const v0 = s.item('ORJ').stockValue; const inv = s.go('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, lines: [{ itemId: s.id('ORJ'), qty: 300, unitPrice: 6 }], paid: 500, method: 'نقدي' });
  s.go('collectPayment', { customerId: s.cust.id, amount: 100, method: 'نقدي' });
  s.go('cancelInvoice', { id: inv.id, reason: 'خطأ إدخال' }); assert.equal(s.qty('ORJ'), 2000); assert.equal(s.item('ORJ').stockValue, v0);
  const b = E.balances(s.db); assert.equal(b['4100'], 0); assert.equal(b['5100'], 0); assert.equal(b['1200'], 0); assert.equal(E.arBalance(s.db, s.cust.id), 0); assert.equal(b['1100'], 100000);
  s.fail('cancelInvoice', { id: inv.id }, 'bad_status'); assert.deepEqual(E.verify(s.db), []);
  const i2 = s.go('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, lines: [{ itemId: s.id('ORJ'), qty: 10, unitPrice: 6 }] }); s.go('createReturn', { saleId: i2.id, lines: [{ itemId: s.id('ORJ'), qty: 1 }], refundMethod: 'نقدي' }); s.fail('cancelInvoice', { id: i2.id }, 'has_returns');
});
test('عملاء: حذف عميل له فواتير مرفوض، وعميل مكرر مرفوض', () => {
  const s = stocked(); s.go('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, lines: [{ itemId: s.id('ORJ'), qty: 1, unitPrice: 6 }] }); s.fail('deleteCustomer', { id: s.cust.id }, 'referenced'); s.fail('upsertCustomer', { name: 'سوبر ماركت النور' }, 'dup_name');
});
