/* اختبار الواجهة بلا متصفح: تُحمَّل ملفات المتصفح الفعلية بالترتيب نفسه في index.html داخل بيئة معزولة (vm)
   مع بدائل بسيطة لـ DOM، ثم تُرسم كل صفحة وتبويب ببيانات مصنع حقيقية.
   يثبت هذا: لا أخطاء أثناء الرسم، لا undefined/NaN في النصوص، وكل زر data-act له معالج فعلي، ونماذج المستندات تُبنى دون أخطاء.
   لا يثبت سلوك المتصفح الحقيقي (التركيز، الطباعة، التنزيل)؛ هذه تُجرَّب يدويًا (انظر README). */
const test = require('node:test'), assert = require('node:assert');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const { E, factory } = require('./helpers.js');

const noop = () => { };
function loadBrowser() {
  const el = () => ({ style: {}, classList: { toggle: noop, add: noop, remove: noop, contains: () => false }, dataset: {}, innerHTML: '', textContent: '', hidden: false, elements: {}, open: false, isConnected: true,
    querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, setAttribute: noop, appendChild: noop, showModal: noop, close: noop, click: noop, remove: noop, focus: noop });
  const shared = el();
  const ctx = { console, Math, Date, JSON, Intl, Number, String, Array, Object, Set, Map, Promise, RegExp, Error, isFinite, isNaN, parseFloat, parseInt, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, Blob: class { }, FormData: class { }, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop } };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  ctx.document = { readyState: 'loading', title: '', visibilityState: 'visible', activeElement: null, body: el(), querySelector: () => shared, querySelectorAll: () => [], addEventListener: noop, createElement: el, getElementById: () => null };
  ctx.location = { hash: '' }; ctx.addEventListener = noop; ctx.removeEventListener = noop; ctx.print = noop; ctx.confirm = () => true; ctx.prompt = () => 'سبب';
  vm.createContext(ctx);
  const order = ['calc', 'erp-core', 'erp-ops', 'erp-ops2', 'erp-reports', 'store', 'xlsx-lite', 'ui-kit', 'ui-pages', 'ui-pages2', 'ui-pages3', 'app'];
  for (const f of order) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f + '.js'), 'utf8'), ctx, { filename: f + '.js' });
  ctx.shared = shared;
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);
const setDB = (ctx, db) => { ctx.__db = db; run(ctx, 'DB = __db; ready = true; currentUser = { uid: "u1", email: "t@t" }; dbOwner = "u1"; UI.reset();'); };

// مصنع مكتمل الحركة: إنتاج، بيع، مرتجع، شراء، مصروف، سداد، قرار ذكاء اصطناعي
function richFactory() {
  const s = factory();
  const po = s.go('createPO', { supplierId: s.sup.id, lines: [{ itemId: s.id('CON'), qty: 100, price: 20 }] });
  s.go('setPOStatus', { id: po.id, status: 'مُرسل' });
  s.go('receiveGoods', { poId: po.id, whId: 'wh_raw', lines: [{ itemId: s.id('CON'), qty: 60 }] });
  s.go('paySupplier', { supplierId: s.sup.id, amount: 500, method: 'نقدي' });
  const p = s.go('createProduction', { bomId: s.bom.id, plannedQty: 2000, rawWhId: 'wh_raw', fgWhId: 'wh_fg' });
  s.go('startProduction', { id: p.id });
  s.go('completeProduction', { id: p.id, producedQty: 1980, otherCost: 300 });
  const inv = s.go('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, lines: [{ itemId: s.id('ORJ'), qty: 400, unitPrice: 6 }], paid: 1000, method: 'نقدي' });
  s.go('createReturn', { saleId: inv.id, lines: [{ itemId: s.id('ORJ'), qty: 10 }], refund: 0 });
  s.go('recordExpense', { category: E.EXPENSE_CATEGORIES[0], amount: 250, method: 'نقدي' });
  s.go('issueVoucher', { whId: 'wh_raw', reason: ISSUE_FIRST(), lines: [{ itemId: s.id('SUG'), qty: 5 }] });
  s.go('recordAiDecision', { itemId: s.id('CON'), decision: 'accepted', riskLevel: 'high', summary: 'اختبار' });
  return s;
}
function ISSUE_FIRST() { return Array.isArray(E.ISSUE_REASONS) ? E.ISSUE_REASONS[0] : Object.keys(E.ISSUE_REASONS)[0]; }

const PAGE_CALLS = [
  ['pageHome()'], ['pageSales("invoices")'], ['pageSales("customers")'], ['pageSales("returns")'], ['pageSales("collections")'],
  ['pagePurchasing("orders")'], ['pagePurchasing("receipts")'], ['pagePurchasing("suppliers")'], ['pagePurchasing("payments")'],
  ['pageInventory("stock")'], ['pageInventory("vouchers")'], ['pageInventory("ledger")'], ['pageInventory("warehouses")'],
  ['pageProduction("orders")'], ['pageProduction("boms")'], ['pageAccounting("summary")'], ['pageAccounting("cash")'], ['pageAccounting("expenses")'], ['pageAccounting("journal")'],
  ['pageReports("inventory")'], ['pageReports("movements")'], ['pageReports("production")'], ['pageReports("sales")'], ['pageReports("purchasing")'], ['pageReports("finance")'], ['pageReports("ai")'], ['pageReports("audit")'],
  ['pageRisk()'], ['pageSim()'], ['pageSettings()']
];
const BAD = /undefined|NaN|\[object|Infinity/;

test('كل صفحة وتبويب تُرسم ببيانات مصنع كاملة بلا أخطاء ولا قيم تالفة', () => {
  const ctx = loadBrowser(), s = richFactory(); setDB(ctx, s.db);
  for (const [call] of PAGE_CALLS) {
    const html = run(ctx, call);
    assert.ok(typeof html === 'string' && html.length > 80, call + ' لم تُرجع محتوى');
    assert.ok(!BAD.test(html), `${call}: يحتوي قيمة تالفة: ${(html.match(new RegExp('.{0,40}(' + BAD.source + ').{0,40}')) || [''])[0]}`);
  }
});
test('كل صفحة تُرسم أيضًا على بيانات فارغة (حساب جديد)', () => {
  const ctx = loadBrowser(); setDB(ctx, E.migrate({ settings: { company: 'شركة' } }, {}).db);
  for (const [call] of PAGE_CALLS) {
    const html = run(ctx, call);
    assert.ok(typeof html === 'string' && html.length > 40, call);
    assert.ok(!BAD.test(html), `${call}: قيمة تالفة على بيانات فارغة: ${(html.match(new RegExp('.{0,40}(' + BAD.source + ').{0,40}')) || [''])[0]}`);
  }
});
test('كل زر data-act ظاهر في أي صفحة له معالج مسجّل في UI.actions', () => {
  const ctx = loadBrowser(), s = richFactory(); setDB(ctx, s.db);
  const registered = new Set(Object.keys(run(ctx, 'UI.actions'))), missing = new Set(); let seen = 0;
  for (const [call] of PAGE_CALLS) for (const m of run(ctx, call).matchAll(/data-act="([^"]+)"/g)) { seen++; if (!registered.has(m[1])) missing.add(m[1]); }
  assert.ok(seen > 40, 'عدد الأزرار المفحوصة قليل بشكل مريب: ' + seen);
  assert.deepEqual([...missing], [], 'أزرار بلا معالج: ' + [...missing].join(' | '));
});
test('أزرار الفتح (new-*، v-*) تبني نماذجها دون أخطاء', () => {
  const ctx = loadBrowser(), s = richFactory(); setDB(ctx, s.db);
  const names = Object.keys(run(ctx, 'UI.actions')).filter(k => /^(new-|v-|cash-|rep-clear)/.test(k) && k !== 'new-production');
  assert.ok(names.length >= 12, 'عدد غير متوقع: ' + names.length);
  for (const k of names) assert.doesNotThrow(() => run(ctx, `UI.actions[${JSON.stringify(k)}]()`), k);
  assert.doesNotThrow(() => run(ctx, `UI.actions['new-production'](${JSON.stringify(s.bom.id)})`));
  assert.doesNotThrow(() => run(ctx, `UI.actions['edit-item'](${JSON.stringify(s.id('CON'))})`));
});
test('المرشحات تعمل: بحث الفواتير وتصفية التقارير بالتاريخ', () => {
  const ctx = loadBrowser(), s = richFactory(); setDB(ctx, s.db);
  const all = run(ctx, 'pageSales("invoices")'); const inv = s.db.sales[0].no;
  assert.ok(all.includes(inv));
  run(ctx, 'UI.f.inv = "لا-يوجد-هذا-النص"'); assert.ok(!run(ctx, 'pageSales("invoices")').includes('>' + inv + '<'));
  run(ctx, 'UI.rf.from = "2030-01-01"'); const rep = run(ctx, 'pageReports("sales")'); assert.ok(!rep.includes(inv));
});
test('تصدير التقارير: CSV وExcel يُنتجان ملفين صالحين من بيانات التقرير نفسها', () => {
  const ctx = loadBrowser(), s = richFactory(); setDB(ctx, s.db);
  const got = []; ctx.downloadBlob = (name, data, type) => got.push({ name, data, type });
  run(ctx, 'location.hash = "#reports/sales"; exportReport("csv"); exportReport("xlsx");');
  assert.equal(got.length, 2);
  assert.match(got[0].name, /^nabdh_sales_\d{4}-\d\d-\d\d\.csv$/); assert.ok(String(got[0].data).includes(s.db.sales[0].no));
  assert.match(got[1].name, /\.xlsx$/); const bytes = got[1].data; assert.ok(bytes.length > 500); assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b);   // PK = ملف ZIP/XLSX
});
test('شاشة الترقية تعرض أصناف الإصدار 1 وتحفظ اختيار النوع', () => {
  const ctx = loadBrowser(); setDB(ctx, E.migrate({}, {}).db);
  const legacy = { items: [{ id: 'a', code: 'JUC', name: 'علب عصير', qty: 10, price: 3 }, { id: 'b', code: 'WAT', name: 'ماء', qty: 5 }], sales: [{ id: 's', itemId: 'a', qty: 1, unitPrice: 5, total: 5, status: 'مؤكد' }], orders: [], suppliers: [] };
  ctx.__raw = legacy; const html = run(ctx, 'renderMigration(__raw)');
  assert.ok(html.includes('علب عصير') && html.includes('data-mig="a"') && html.includes('migrun'));
  assert.ok(!BAD.test(html));
});
test('طلبات الذكاء الاصطناعي تُسطَّح بنود أوامر الشراء المفتوحة (الكمية المتبقية فقط)', () => {
  const ctx = loadBrowser(), s = richFactory(); setDB(ctx, s.db);
  const rows = JSON.parse(run(ctx, 'JSON.stringify(aiOrders())'));
  assert.equal(rows.length, 1); assert.equal(rows[0].qty, 40); assert.equal(rows[0].itemId, s.id('CON'));
});
test('نوافذ العرض (فاتورة، أمر شراء، أمر إنتاج، سند) تُبنى سليمة وأزرارها لها معالجات', () => {
  const ctx = loadBrowser(), s = richFactory(); setDB(ctx, s.db);
  const registered = new Set(Object.keys(run(ctx, 'UI.actions'))); const d = s.db;
  const calls = [[`UI.actions['view-invoice']("${d.sales[0].id}")`], [`UI.actions['view-po']("${d.orders[0].id}")`], [`UI.actions['view-prod']("${d.productions[0].id}")`], [`UI.actions['view-voucher']("${d.vouchers[0].id}")`],
    [`UI.actions['complete-prod']("${d.productions[0].id}")`], [`UI.actions['receive-po']("${d.orders[0].id}")`], [`UI.actions['edit-po']("${d.orders[0].id}")`], [`UI.actions['edit-bom']("${d.boms[0].id}")`], [`UI.actions['edit-supplier']("${d.suppliers[0].id}")`], [`UI.actions['edit-customer']("${d.customers[0].id}")`],
    [`UI.actions['new-return']("${d.sales[0].id}")`], [`UI.actions['collect']("${d.customers[0].id}")`], [`UI.actions['pay-supplier']("${d.suppliers[0].id}")`], [`UI.actions['edit-wh']("${d.warehouses[0].id}")`]];
  for (const [c] of calls) {
    ctx.shared.innerHTML = '';
    try { run(ctx, c); } catch (e) { assert.fail(`${c} → ${e.message}`); }
    const html = ctx.shared.innerHTML;
    // بعض النوافذ تُرفض عمدًا (مثل إكمال أمر مكتمل) فتبقى فارغة؛ المهم ألا يوجد خطأ ولا قيم تالفة ولا أزرار بلا معالج
    assert.ok(!BAD.test(html), `${c}: قيمة تالفة: ${(html.match(new RegExp('.{0,40}(' + BAD.source + ').{0,40}')) || [''])[0]}`);
    for (const m of html.matchAll(/data-act="([^"]+)"/g)) assert.ok(registered.has(m[1]), `${c}: زر بلا معالج ${m[1]}`);
  }
});
test('أمان: أسماء تحتوي HTML/سكربت تُعرض نصًا مُهرَّبًا في كل الصفحات (لا حقن)', () => {
  const ctx = loadBrowser(), s = factory(), evil = '<img src=x onerror=alert(1)>';
  s.go('upsertItem', { code: 'EVIL', name: evil, type: 'raw', unit: 'كجم', min: 5, price: 1, daily: 1, lead: 1, inbound: 1, delay: 0 });
  s.go('upsertSupplier', { name: evil, itemCodes: 'EVIL', price: 1, lead: 1, quality: 3, moq: 1, verified: 'تجريبي' });
  s.go('upsertCustomer', { name: evil, creditLimit: 10 });
  s.go('upsertWarehouse', { code: 'WH-X', name: evil, kind: 'raw' });
  s.go('receiptVoucher', { whId: 'wh_raw', reason: 'opening', note: evil, lines: [{ itemId: s.id('EVIL'), qty: 2, unitCost: 1 }] });
  setDB(ctx, s.db);
  for (const [call] of PAGE_CALLS) { const html = run(ctx, call); assert.ok(!html.includes('<img src=x'), `${call}: نص غير مُهرَّب`); }
  assert.ok(run(ctx, 'pagePurchasing("suppliers")').includes('&lt;img src=x'), 'الاسم يظهر نصًا مُهرَّبًا');
});
