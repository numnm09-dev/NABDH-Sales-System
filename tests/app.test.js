/* اختبار تكاملي لغلاف التطبيق (app.js الحقيقي) فوق محاكي Firebase: تحميل حساب جديد، ترقية حساب قديم بخطوة مراجعة،
   تنفيذ العمليات عبر act()، رفض الرصيد غير الكافي بلا تغيير، منع التكرار، تحويل خطأ الصلاحيات، وإبطال التحميل المتأخر عند تبديل المستخدم.
   المحاكي لا يثبت سلوك Firebase الحقيقي (قواعد الأمان مثلًا)؛ اختبار قواعد الأمان الفعلية يحتاج مشروع Firebase (انظر README). */
const test = require('node:test'), assert = require('node:assert');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const { createFake } = require('./fake-firebase.js');
const { E } = require('./helpers.js');

const noop = () => { };
function boot(initialUsers) {
  const el = () => ({ style: {}, classList: { toggle: noop, add: noop, remove: noop, contains: () => false }, dataset: {}, innerHTML: '', textContent: '', hidden: false, elements: {}, open: false, isConnected: true,
    querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, setAttribute: noop, appendChild: noop, showModal: noop, close: noop, click: noop, remove: noop, focus: noop });
  const shared = el();
  const ctx = { console: { ...console, error: noop, warn: noop }, Math, Date, JSON, Intl, Number, String, Array, Object, Set, Map, Promise, RegExp, Error, isFinite, isNaN, parseFloat, parseInt, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, Blob: class { }, FormData: class { }, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop } };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  ctx.document = { readyState: 'loading', title: '', visibilityState: 'visible', activeElement: null, body: el(), querySelector: () => shared, querySelectorAll: () => [], addEventListener: noop, createElement: el, getElementById: () => null };
  ctx.location = { hash: '' }; ctx.addEventListener = noop; ctx.removeEventListener = noop; ctx.print = noop; ctx.confirm = () => true; ctx.prompt = () => 'سبب';
  const fake = createFake(initialUsers ? { users: initialUsers } : undefined);
  ctx.NabdhFirebase = { ...fake.fb, auth: {}, signOut: async () => { }, onAuthStateChanged: noop };
  vm.createContext(ctx);
  for (const f of ['calc', 'erp-core', 'erp-ops', 'erp-ops2', 'erp-reports', 'store', 'xlsx-lite', 'ui-kit', 'ui-pages', 'ui-pages2', 'ui-pages3', 'app'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f + '.js'), 'utf8'), ctx, { filename: f + '.js' });
  ctx.shared = shared;
  return { ctx, fake, shared, run: code => vm.runInContext(code, ctx) };
}
const USER = { uid: 'u1', email: 'a@nabdh.test' };
const stored = (fake, uid = 'u1') => E.ensure(JSON.parse(JSON.stringify(fake.getAt('users/' + uid) || {})));
const legacyData = () => ({
  items: [{ id: 'i1', code: 'JUC', name: 'علب عصير', qty: 100, price: 10, daily: 5, min: 20, lead: 3, inbound: 2, delay: 0 }, { id: 'i2', code: 'WAT', name: 'مياه', qty: 50, price: 2 }],
  suppliers: [{ id: 's1', name: 'مورد قديم', itemCodes: 'JUC', price: 9, lead: 4, quality: 4, moq: 10, verified: 'تجريبي' }],
  orders: [{ id: 'o1', itemId: 'i1', supplierId: 's1', qty: 30, price: 9, status: 'مُرسل', date: '2026-10-01' }],
  sales: [{ id: 'sa1', itemId: 'i1', qty: 2, unitPrice: 15, total: 30, customer: 'أحمد', status: 'مؤكد', date: '2026-10-02 10:00:00' }],
  settings: { student: 'عبدالله', safety: 3 }
});

test('حساب جديد: يُنشأ بنية ERP كاملة بمخزنين افتراضيين وإعدادات الشركة', async () => {
  const t = boot(); await t.run('handleAuth({ uid: "u1", email: "a@nabdh.test" })');
  assert.equal(t.run('ready'), true);
  const d = stored(t.fake); assert.equal(d.schemaVersion, E.SCHEMA); assert.equal(d.warehouses.length, 2); assert.ok(d.settings.company); assert.deepEqual(E.verify(d), []);
});
test('حساب من الإصدار 1: لا يُعرض النظام قبل مراجعة الترقية، ولا تتغير البيانات قبل الضغط', async () => {
  const t = boot({ u1: legacyData() }); await t.run('handleAuth({ uid: "u1", email: "a@nabdh.test" })');
  assert.equal(t.run('ready'), false); assert.equal(t.run('DB'), null);
  assert.ok(t.shared.innerHTML.includes('ترقية بيانات حسابك') && t.shared.innerHTML.includes('علب عصير'));
  assert.equal(t.fake.getAt('users/u1').schemaVersion, undefined, 'لم تُرقَّ البيانات بعد');
  await assert.rejects(t.run('act("cashEntry", { kind: "capital_in", amount: 5 })'), e => e.code === 'not_ready');
});
test('الترقية: نسخة احتياطية، حفظ كل السجلات القديمة، واختيار المستخدم لنوع الصنف', async () => {
  const t = boot({ u1: legacyData() }); await t.run('handleAuth({ uid: "u1", email: "a@nabdh.test" })');
  t.run('UI.mig.types["i2"] = "finished"');
  await t.shared.onclick();                               // زر «ابدأ الترقية» (عناصر الاختبار تشترك في كائن واحد؛ آخر onclick هو زر الترقية)
  assert.equal(t.run('ready'), true, 'جاهز بعد الترقية');
  const d = stored(t.fake);
  assert.ok(t.fake.getAt('backups/u1/pre_v2'), 'نسخة احتياطية موجودة'); assert.equal(t.fake.getAt('backups/u1/pre_v2/items')[0].qty, 100);
  assert.equal(d.items.find(i => i.id === 'i1').qty, 100); assert.equal(d.items.find(i => i.id === 'i2').type, 'finished'); assert.equal(d.items.find(i => i.id === 'i1').type, 'finished', 'صنف سبق بيعه يُصنَّف منتجًا تامًا');
  assert.equal(d.sales[0].legacy, true); assert.equal(d.sales[0].total, 30); assert.equal(d.orders[0].legacy, true); assert.equal(d.suppliers[0].name, 'مورد قديم'); assert.deepEqual(E.verify(d), []);
  assert.doesNotThrow(() => t.run('pageHome()')); assert.doesNotThrow(() => t.run('pageSales("invoices")'));
});
test('act: بيع يخصم المخزون ويحدّث DB المحلي من نتيجة المعاملة المؤكدة فقط', async () => {
  const t = boot(); await t.run('handleAuth({ uid: "u1", email: "a@nabdh.test" })');
  await t.run(`act("upsertItem", { code: "FG1", name: "عصير", type: "finished", unit: "عبوة", salePrice: 5, openingQty: 10, openingWhId: "wh_fg", openingCost: 2 })`);
  const id = t.run('DB.items[0].id');
  await t.run('act("cashEntry", { kind: "capital_in", amount: 1000 })');
  const r = await t.run(`act("createInvoice", { whId: "wh_fg", lines: [{ itemId: "${id}", qty: 4, unitPrice: 5 }], paid: 20, method: "نقدي" })`);
  assert.equal(r.result.total, 20); assert.equal(t.run('DB.items[0].qty'), 6); assert.equal(stored(t.fake).items[0].qty, 6);
});
test('act: بيع أكبر من الرصيد يُرفض ولا يتغير شيء محليًا أو في الخادم', async () => {
  const t = boot(); await t.run('handleAuth({ uid: "u1", email: "a@nabdh.test" })');
  await t.run(`act("upsertItem", { code: "FG1", name: "عصير", type: "finished", unit: "عبوة", salePrice: 5, openingQty: 3, openingWhId: "wh_fg", openingCost: 2 })`);
  const id = t.run('DB.items[0].id'), before = JSON.stringify(t.fake.getAt('users/u1')), revBefore = t.run('DB.rev');
  await assert.rejects(t.run(`act("createInvoice", { whId: "wh_fg", lines: [{ itemId: "${id}", qty: 4, unitPrice: 5 }], paid: 0 })`), e => e.code === 'insufficient_stock' || e.erp);
  assert.equal(JSON.stringify(t.fake.getAt('users/u1')), before); assert.equal(t.run('DB.rev'), revBefore); assert.equal(t.run('DB.items[0].qty'), 3);
});
test('act: إعادة إرسال نفس opId لا تكرر العملية', async () => {
  const t = boot(); await t.run('handleAuth({ uid: "u1", email: "a@nabdh.test" })');
  await t.run('act("cashEntry", { kind: "capital_in", amount: 100 }, "op_same_1")');
  const r2 = await t.run('act("cashEntry", { kind: "capital_in", amount: 100 }, "op_same_1")');
  assert.equal(r2.duplicate, true); assert.equal(E.cashBalance(stored(t.fake)), 100); assert.equal(t.run('E_.cashBalance(DB)'), 100);
});
test('act: خطأ صلاحيات Firebase يتحول لرسالة واضحة بلا تغيير محلي', async () => {
  const t = boot(); await t.run('handleAuth({ uid: "u1", email: "a@nabdh.test" })');
  t.ctx.NabdhFirebase.runTransaction = async () => { throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' }); };
  const revBefore = t.run('DB.rev');
  await assert.rejects(t.run('act("cashEntry", { kind: "capital_in", amount: 1 })'), e => e.code === 'permission' && /صلاحية/.test(e.message));
  assert.equal(t.run('DB.rev'), revBefore);
});
test('تبديل المستخدم أثناء التحميل: النتيجة المتأخرة تُهمل ولا تظهر بيانات مستخدم لآخر', async () => {
  const t = boot({ u1: E.migrate({ items: [{ id: 'x', code: 'A', name: 'سري', qty: 1 }] }, {}).db });
  const realGet = t.ctx.NabdhFirebase.get; let release; const gate = new Promise(r => { release = r; });
  t.ctx.NabdhFirebase.get = async r => { await gate; return realGet(r); };
  const loading = t.run('handleAuth({ uid: "u1", email: "a@nabdh.test" })');
  await t.run('handleAuth(null)'); release(); await loading;
  assert.equal(t.run('DB'), null); assert.equal(t.run('ready'), false);
});
