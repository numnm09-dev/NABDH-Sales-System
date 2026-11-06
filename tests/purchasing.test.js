const test = require('node:test'), assert = require('node:assert');
const { E, ctx, factory } = require('./helpers.js');
const L = (s, o = {}) => [{ itemId: s.id('CON'), qty: 100, price: 20, ...o }, { itemId: s.id('SUG'), qty: 50, price: 5 }];
const mkPO = (s, o = {}) => s.go('createPO', { supplierId: s.sup.id, lines: L(s), ...o });

test('أمر الشراء: التحقق من المورد والبنود والأسعار', () => {
  const s = factory();
  s.fail('createPO', { supplierId: 'nope', lines: L(s) }, 'not_found'); s.fail('createPO', { supplierId: s.sup.id, lines: [] }, 'no_lines');
  s.fail('createPO', { supplierId: s.sup.id, lines: [{ itemId: s.id('CON'), qty: 0, price: 1 }] }); s.fail('createPO', { supplierId: s.sup.id, lines: [{ itemId: s.id('CON'), qty: 1, price: -1 }] });
  s.fail('createPO', { supplierId: s.sup.id, lines: [{ itemId: s.id('CON'), qty: 1, price: 1 }, { itemId: s.id('CON'), qty: 1, price: 1 }] }, 'dup_line');
  s.fail('createPO', { supplierId: s.sup.id, lines: L(s), expectedDate: '2026-02-30' });
  const po = mkPO(s); assert.equal(po.status, 'مسودة'); assert.equal(po.total, 100 * 20 + 50 * 5);
  s.go('updatePO', { id: po.id, supplierId: s.sup.id, lines: [{ itemId: s.id('CON'), qty: 10, price: 20 }] }); assert.equal(s.db.orders[0].total, 200);
});
test('لا استلام قبل اعتماد الأمر، والحالات تتبع تسلسلًا صحيحًا', () => {
  const s = factory(); const po = mkPO(s);
  s.fail('receiveGoods', { poId: po.id, whId: 'wh_raw', lines: [{ itemId: s.id('CON'), qty: 1 }] }, 'bad_status');
  s.fail('setPOStatus', { id: po.id, status: 'قيد الشحن' }, 'bad_status'); s.go('setPOStatus', { id: po.id, status: 'مُرسل' }); s.go('setPOStatus', { id: po.id, status: 'قيد الشحن' });
  s.fail('updatePO', { id: po.id, supplierId: s.sup.id, lines: L(s) }, 'bad_status');
});
test('استلام جزئي ثم كلي: مخزون + ذمم دائنة + حد أقصى للمتبقي', () => {
  const s = factory(); const po = mkPO(s); s.go('setPOStatus', { id: po.id, status: 'مُرسل' });
  const r1 = s.go('receiveGoods', { poId: po.id, whId: 'wh_raw', lines: [{ itemId: s.id('CON'), qty: 60 }] });
  assert.equal(s.qty('CON'), 1060); assert.equal(r1.total, 1200); assert.equal(s.db.orders[0].status, 'مستلم جزئيًا'); assert.equal(E.apBalance(s.db, s.sup.id), 1200);
  s.fail('receiveGoods', { poId: po.id, whId: 'wh_raw', lines: [{ itemId: s.id('CON'), qty: 41 }] }, 'over_receipt');
  s.fail('receiveGoods', { poId: po.id, whId: 'wh_fg', lines: [{ itemId: s.id('CON'), qty: 1 }] }, 'wrong_warehouse');
  s.fail('receiveGoods', { poId: po.id, whId: 'wh_raw', lines: [{ itemId: s.id('BOT'), qty: 1 }] }, 'not_in_po');
  s.go('receiveGoods', { poId: po.id, whId: 'wh_raw', lines: [{ itemId: s.id('CON'), qty: 40 }, { itemId: s.id('SUG'), qty: 50 }] });
  assert.equal(s.db.orders[0].status, 'مستلم'); assert.equal(E.apBalance(s.db, s.sup.id), 2000 + 250); assert.equal(s.qty('SUG'), 450);
  s.fail('receiveGoods', { poId: po.id, whId: 'wh_raw', lines: [{ itemId: s.id('CON'), qty: 1 }] }, 'bad_status');
  assert.deepEqual(E.verify(s.db), []);
});
test('تكلفة الاستلام بسعر مختلف تحدّث متوسط التكلفة', () => {
  const s = factory(); const po = s.go('createPO', { supplierId: s.sup.id, lines: [{ itemId: s.id('CON'), qty: 1000, price: 30 }] }); s.go('setPOStatus', { id: po.id, status: 'مُرسل' });
  s.go('receiveGoods', { poId: po.id, whId: 'wh_raw', lines: [{ itemId: s.id('CON'), qty: 1000 }] }); assert.equal(s.item('CON').stockValue, 1000 * 20 + 1000 * 30);
});
test('سداد المورد: لا يتجاوز المستحق ولا رصيد الخزينة', () => {
  const s = factory(); const po = mkPO(s); s.go('setPOStatus', { id: po.id, status: 'مُرسل' }); s.go('receiveGoods', { poId: po.id, whId: 'wh_raw', lines: [{ itemId: s.id('CON'), qty: 100 }] });   // مستحق 2000
  s.fail('paySupplier', { supplierId: s.sup.id, amount: 2000.01, method: 'نقدي' }, 'overpay'); s.fail('paySupplier', { supplierId: s.sup.id, amount: 0, method: 'نقدي' }); s.fail('paySupplier', { supplierId: s.sup.id, amount: 10, method: 'x' });
  const p = s.go('paySupplier', { supplierId: s.sup.id, amount: 500, method: 'نقدي' }); assert.equal(p.cashAfter, 100000 - 500); assert.equal(E.apBalance(s.db, s.sup.id), 1500);
  s.go('cashEntry', { kind: 'withdrawal', amount: 99000 }); s.fail('paySupplier', { supplierId: s.sup.id, amount: 1500, method: 'نقدي' }, 'insufficient_cash');
  s.go('updateSettings', { allowNegativeCash: true }); s.go('paySupplier', { supplierId: s.sup.id, amount: 1500, method: 'نقدي' }); assert.equal(E.apBalance(s.db, s.sup.id), 0);
  assert.deepEqual(E.verify(s.db), []);
});
test('إلغاء الأمر وحذفه وحماية المورد', () => {
  const s = factory(); const po = mkPO(s); s.fail('deleteSupplier', { id: s.sup.id }, 'referenced'); s.go('setPOStatus', { id: po.id, status: 'مُرسل' });
  s.go('receiveGoods', { poId: po.id, whId: 'wh_raw', lines: [{ itemId: s.id('CON'), qty: 1 }] }); s.fail('setPOStatus', { id: po.id, status: 'ملغي' }, 'bad_status');
  const p2 = mkPO(s); s.go('setPOStatus', { id: p2.id, status: 'ملغي' }); s.fail('receiveGoods', { poId: p2.id, whId: 'wh_raw', lines: [{ itemId: s.id('CON'), qty: 1 }] }, 'bad_status'); s.go('deletePO', { id: p2.id });
  s.fail('deletePO', { id: po.id }, 'referenced');
});
test('لا تتكرر العملية عند إعادة إرسال نفس opId (استلام بضاعة)', () => {
  const s = factory(); const po = mkPO(s); s.go('setPOStatus', { id: po.id, status: 'مُرسل' }); const c = ctx({ opId: 'gr-once' }); const inp = { poId: po.id, whId: 'wh_raw', lines: [{ itemId: s.id('CON'), qty: 10 }] };
  s.db = E.apply(s.db, c, 'receiveGoods', inp).db; assert.throws(() => E.apply(s.db, c, 'receiveGoods', inp), e => e.code === 'duplicate'); assert.equal(s.qty('CON'), 1010);
});
