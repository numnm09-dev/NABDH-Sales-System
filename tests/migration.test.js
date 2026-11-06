const test = require('node:test'), assert = require('node:assert');
const E = require('../js/erp-ops2.js'); const sample = require('../data/sample-data.json');
const v1 = () => JSON.parse(JSON.stringify({ items: sample.items, suppliers: sample.suppliers, orders: sample.orders, settings: sample.settings,
  sales: [{ id: 's1', itemId: 'i1', qty: 5, unitPrice: 12, total: 60, customer: 'أحمد', status: 'مؤكد', date: '2026-10-30 12:00:00' }, { id: 's2', itemId: 'i1', qty: 1, unitPrice: 12, total: 12, customer: '', status: 'ملغي', date: '2026-10-31 09:00:00' }] }));
const M = (raw, c = {}) => E.migrate(raw, { now: '2026-11-01T08:00:00.000Z', ...c });

test('الترحيل يحفظ كل السجلات القديمة ولا يغيّر الكميات', () => {
  const raw = v1(), m = M(raw), d = m.db;
  assert.equal(d.schemaVersion, 2); assert.deepEqual(d.items.map(i => [i.id, i.qty]), raw.items.map(i => [i.id, i.qty])); assert.equal(d.suppliers.length, 4); assert.equal(d.orders.length, 1); assert.equal(d.sales.length, 2);
  assert.equal(d.warehouses.length, 2); assert.deepEqual(E.verify(d), []);
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), v1(), 'المدخلات الأصلية لم تُعدَّل');
});
test('تصنيف الأصناف: ما بيع يصبح تام، والباقي خام، واختيار المستخدم يغلب التخمين', () => {
  assert.deepEqual(Object.fromEntries(M(v1()).db.items.map(i => [i.id, i.type])), { i1: 'finished', i2: 'raw', i3: 'raw' });
  const d = M(v1(), { itemTypes: { i1: 'raw', i2: 'finished' } }).db; assert.deepEqual(Object.fromEntries(d.items.map(i => [i.id, i.type])), { i1: 'raw', i2: 'finished', i3: 'raw' });
  assert.deepEqual(E.verify(d), []); assert.equal(E.stockOf(d, 'i2', d.warehouses.find(w => w.kind === 'finished').id), 2400);
});
test('الفواتير والأوامر القديمة تتحول لبنية البنود، والملغاة لا تُحتسب مدفوعة', () => {
  const d = M(v1()).db, s1 = d.sales.find(s => s.id === 's1'), s2 = d.sales.find(s => s.id === 's2');
  assert.equal(s1.legacy, true); assert.equal(s1.lines.length, 1); assert.equal(s1.paid, 60); assert.equal(s2.paid, 0); assert.equal(d.orders[0].lines[0].qty, 400); assert.equal(d.orders[0].lines[0].receivedQty, 0);
  assert.equal(d.audit.filter(a => a.action === 'migrate').length, 1);
});
test('الترحيل متكرر وآمن (idempotent) ويقبل بيانات فارغة أو ناقصة أو كائنات بدل مصفوفات', () => {
  const once = M(v1()).db, twice = M(once).db; assert.equal(JSON.stringify(once.items), JSON.stringify(twice.items)); assert.equal(once.ledger.length, twice.ledger.length); assert.equal(once.journal.length, twice.journal.length);
  assert.equal(M({}).db.warehouses.length, 2); assert.equal(M(null).db.schemaVersion, 2);
  const obj = v1(); obj.items = Object.fromEntries(obj.items.map((x, i) => [i, x])); assert.equal(M(obj).db.items.length, 3);
  const bad = v1(); bad.items[0].qty = -5; bad.items[1].qty = 'abc'; const m = M(bad); assert.ok(m.notes.some(n => /كميات غير صالحة/.test(n))); assert.deepEqual(E.verify(m.db), []); assert.equal(m.db.items[0].qty, 0);
});
test('بعد الترحيل تعمل العمليات الجديدة على الأصناف القديمة (بيع من الرصيد المرحّل)', () => {
  let d = M(v1()).db; const fg = d.warehouses.find(w => w.kind === 'finished').id; let n = 0; const c = () => ({ opId: 'm' + (++n), user: 't', now: '2026-11-02T08:00:00.000Z', today: '2026-11-02' });
  d = E.apply(d, c(), 'cashEntry', { kind: 'capital_in', amount: 1000 }).db;
  d = E.apply(d, c(), 'createInvoice', { whId: fg, customerName: 'زبون', method: 'نقدي', lines: [{ itemId: 'i1', qty: 100, unitPrice: 12 }] }).db; assert.equal(d.items[0].qty, 500);
  assert.throws(() => E.apply(d, c(), 'createInvoice', { whId: fg, customerName: 'زبون', method: 'نقدي', lines: [{ itemId: 'i1', qty: 501, unitPrice: 12 }] }), e => e.code === 'insufficient_stock'); assert.deepEqual(E.verify(d), []);
});
