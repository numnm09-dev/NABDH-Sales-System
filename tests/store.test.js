const test = require('node:test'), assert = require('node:assert');
const { createFake } = require('./fake-firebase.js');
const E = require('../js/erp-ops2.js'), Store = require('../js/store.js');
const { ctx } = require('./helpers.js');
const UID = 'u1';
const legacy = () => ({ items: [{ id: 'i1', code: 'JUC', name: 'علب', qty: 100, price: 10 }], suppliers: [], orders: [], sales: [], settings: { safety: 3 } });
const boot = async (data) => { const f = createFake({ users: { [UID]: data } }); await Store.migrate(f.fb, UID, { user: 't', now: '2026-11-01T08:00:00.000Z' }); return f; };
const stored = f => E.ensure(JSON.parse(JSON.stringify(f.getAt('users/' + UID) || {})));

test('رفض أي عملية قبل ترقية البنية، ثم الترقية تنسخ احتياطيًا وتحفظ البيانات القديمة', async () => {
  const f = createFake({ users: { [UID]: legacy() } });
  await assert.rejects(Store.run(f.fb, UID, ctx(), 'recordExpense', { category: 'إيجار', amount: 1, method: 'نقدي' }), e => e.code === 'needs_migration');
  const m = await Store.migrate(f.fb, UID, { user: 't', now: '2026-11-01T08:00:00.000Z' });
  assert.equal(m.backedUp, true); assert.ok(f.getAt('backups/' + UID + '/pre_v2'), 'النسخة الاحتياطية موجودة'); assert.equal(f.getAt('backups/' + UID + '/pre_v2/items')[0].qty, 100);
  const d = stored(f); assert.equal(d.schemaVersion, 2); assert.equal(d.items[0].qty, 100); assert.deepEqual(E.verify(d), []);
  const again = await Store.migrate(f.fb, UID, {}); assert.equal(again.notes.length, 0);   // الترقية متكررة وآمنة
});
test('عملية عبر المعاملة تُحفظ بشكل صالح لـ Firebase (لا undefined) وبنفس النتيجة', async () => {
  const f = await boot(legacy());
  const r = await Store.run(f.fb, UID, ctx(), 'upsertItem', { code: 'RAW1', name: 'مادة', type: 'raw', openingQty: 5, openingCost: 2 });
  assert.equal(r.result.code, 'RAW1'); const d = stored(f); assert.equal(d.items.find(i => i.code === 'RAW1').qty, 5); assert.deepEqual(E.verify(d), []);
});
test('منع التكرار: نفس opId لا يُنفَّذ مرتين حتى عبر المعاملة', async () => {
  const f = await boot(legacy()); const c = ctx({ opId: 'same' });
  await Store.run(f.fb, UID, c, 'cashEntry', { kind: 'capital_in', amount: 100 }); const r2 = await Store.run(f.fb, UID, c, 'cashEntry', { kind: 'capital_in', amount: 100 });
  assert.equal(r2.duplicate, true); assert.equal(E.cashBalance(stored(f)), 100);
});
test('تعديل متزامن من جهاز آخر: لا يضيع تعديل أي طرف', async () => {
  const f = await boot(legacy()); await Store.run(f.fb, UID, ctx(), 'cashEntry', { kind: 'capital_in', amount: 100 });
  f.hooks.beforeCommit = () => { const x = E.apply(stored(f), ctx(), 'cashEntry', { kind: 'capital_in', amount: 10 }); f.setAt('users/' + UID, x.db); };   // جهاز آخر يكتب بعد أن حسبنا نتيجتنا
  await Store.run(f.fb, UID, ctx(), 'recordExpense', { category: 'إيجار', amount: 30, method: 'نقدي' });
  assert.equal(E.cashBalance(stored(f)), 100 + 10 - 30); assert.deepEqual(E.verify(stored(f)), []);
});
test('تعديل متزامن يجعل العملية غير صالحة: تُعاد على أحدث نسخة وتُرفض (لا رصيد نقدي سالب)', async () => {
  const f = await boot(legacy()); await Store.run(f.fb, UID, ctx(), 'cashEntry', { kind: 'capital_in', amount: 100 });
  f.hooks.beforeCommit = () => { const x = E.apply(stored(f), ctx(), 'cashEntry', { kind: 'withdrawal', amount: 50 }); f.setAt('users/' + UID, x.db); };   // النسخة القديمة كانت تسمح بمصروف 80
  await assert.rejects(Store.run(f.fb, UID, ctx(), 'recordExpense', { category: 'إيجار', amount: 80, method: 'نقدي' }), e => e.code === 'insufficient_cash');
  assert.equal(E.cashBalance(stored(f)), 50);
});
test('رفض عملية تخالف قواعد المخزون على نسخة الخادم الأحدث (لا رصيد سالب)', async () => {
  const f = await boot(legacy()); const it = stored(f).items[0];
  await assert.rejects(Store.run(f.fb, UID, ctx(), 'issueVoucher', { whId: 'wh_fg', reason: 'scrap', lines: [{ itemId: it.id, qty: 101 }] }), e => e.erp && ['insufficient_stock', 'wrong_warehouse'].includes(e.code));
  const wh = stored(f).warehouses.find(w => w.kind === 'raw').id;
  await assert.rejects(Store.run(f.fb, UID, ctx(), 'issueVoucher', { whId: wh, reason: 'scrap', lines: [{ itemId: it.id, qty: 101 }] }), e => e.code === 'insufficient_stock');
  assert.equal(stored(f).items[0].qty, 100);
});
test('بيانات تعود من Firebase ككائنات بدل مصفوفات تُقرأ سليمة', async () => {
  const f = await boot(legacy()); await Store.run(f.fb, UID, ctx(), 'upsertSupplier', { name: 'مورد' });
  const raw = f.getAt('users/' + UID); const d = E.ensure(JSON.parse(JSON.stringify(raw))); assert.equal(d.suppliers.length, 1); assert.equal(d.warehouses.length, 2);
});
