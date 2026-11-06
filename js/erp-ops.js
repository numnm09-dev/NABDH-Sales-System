/* نبض ERP — العمليات: التنفيذ الذري، الترحيل، البيانات الأساسية، سندات المخازن */
(function (root, f) { if (typeof module === 'object') module.exports = f(require('./erp-core.js')); else f(root.Engine); })(this, function (E) {
  'use strict';
  const { err, r2, r3, r4, toNum, clone, num, qtyOf, moneyOf, text, needDate, nowOf, newId, toList, ensure, nextNo, audit, post, find, need, stockOf, invAcct, avgCost,
    moveIn, moveOut, alertsFor, needLines, needItem, needWh, activeItem, ACCOUNTS, ITEM_TYPES, WH_KINDS, RECEIPT_REASONS, ISSUE_REASONS } = E;
  const OPS = {};

  /* ---------- التنفيذ الذري + منع التكرار ---------- */
  function pruneOps(d) {
    const ids = Object.keys(d.ops); if (ids.length <= 5000) return;
    ids.sort((a, b) => String(d.ops[a]).localeCompare(String(d.ops[b]))).slice(0, ids.length - 4000).forEach(k => delete d.ops[k]);
  }
  // يعمل على نسخة؛ يرمي الخطأ دون أي تغيير في db الأصلية
  function exec(db, ctx, fn) {
    if (!ctx || typeof ctx.opId !== 'string' || !ctx.opId || /[.$#\[\]\/]/.test(ctx.opId)) throw err('معرّف العملية مفقود أو غير صالح.', 'no_op_id');
    const d = ensure(clone(db));
    if (d.ops[ctx.opId]) throw err('هذه العملية سُجّلت مسبقًا ولن تُكرَّر.', 'duplicate');
    const result = fn(d, ctx);
    d.ops[ctx.opId] = nowOf(ctx);
    d.rev = (Number(d.rev) || 0) + 1;   // يُستخدم لكشف النسخ القديمة داخل المعاملة
    pruneOps(d);
    const bad = verify(d, { light: true });
    if (bad.length) throw err('فشل فحص السلامة: ' + bad[0], 'integrity', bad);
    // Firebase Realtime Database يرفض القيم undefined؛ جولة JSON تحذفها قبل الحفظ (والنتيجة تُنسخ كذلك)
    return { db: JSON.parse(JSON.stringify(d)), result: result === undefined ? result : JSON.parse(JSON.stringify(result)) };
  }
  function apply(db, ctx, name, input) {
    const fn = OPS[name]; if (!fn) throw err('عملية غير معروفة: ' + name, 'no_such_op');
    return exec(db, ctx, (d, c) => fn(d, c, input || {}));
  }

  /* ---------- فحص السلامة ---------- */
  function verify(d, o = {}) {
    const bad = [];
    for (const it of d.items) {
      const per = d.stock[it.id] || {};
      let sum = 0;
      for (const [w, q] of Object.entries(per)) { if (!(q >= -1e-9)) bad.push(`رصيد سالب للصنف «${it.name}» في المخزن ${w}`); sum += q; }
      if (Math.abs(sum - (Number(it.qty) || 0)) > 0.0015) bad.push(`إجمالي رصيد «${it.name}» لا يطابق أرصدة المخازن`);
      if ((Number(it.qty) || 0) < -1e-9) bad.push(`كمية سالبة للصنف «${it.name}»`);
      if ((Number(it.stockValue) || 0) < -0.005) bad.push(`قيمة مخزون سالبة للصنف «${it.name}»`);
    }
    for (const j of d.journal) {
      const dr = r2(j.lines.reduce((s, l) => s + l.dr, 0)), cr = r2(j.lines.reduce((s, l) => s + l.cr, 0));
      if (Math.abs(dr - cr) > 0.005) bad.push(`قيد غير متوازن ${j.no}`);
    }
    for (const s of d.sales) if (s.status !== 'ملغي' && E.saleOutstanding(s) < -0.005) bad.push(`فاتورة ${s.no || s.id}: المدفوع والمرتجع يتجاوزان الإجمالي`);
    for (const o of d.orders) for (const l of toList(o.lines)) if ((Number(l.receivedQty) || 0) > (Number(l.qty) || 0) + 1e-9) bad.push(`أمر شراء ${o.no || o.id}: المستلم يتجاوز المطلوب`);
    if (o.light) return bad;
    // مطابقة كاملة: الدفتر ↔ الأرصدة، المخزون ↔ الأستاذ العام
    const led = {};
    for (const e of d.ledger) { const k = e.itemId + '|' + e.whId; led[k] = r3((led[k] || 0) + (e.qtyIn || 0) - (e.qtyOut || 0)); }
    for (const it of d.items) for (const w of d.warehouses) {
      const a = stockOf(d, it.id, w.id), b = led[it.id + '|' + w.id] || 0;
      if (Math.abs(a - b) > 0.0015) bad.push(`الدفتر لا يطابق الرصيد: «${it.name}» في «${w.name}» (رصيد ${a} / دفتر ${b})`);
    }
    const bal = E.balances(d);
    for (const [acct, type] of [['1310', 'raw'], ['1320', 'finished']]) {
      const v = r2(d.items.filter(i => (i.type === 'finished' ? 'finished' : 'raw') === type).reduce((s, i) => s + (Number(i.stockValue) || 0), 0));
      if (Math.abs(v - (bal[acct] || 0)) > 0.02) bad.push(`قيمة المخزون (${v}) لا تطابق حساب ${ACCOUNTS[acct].n} (${bal[acct] || 0})`);
    }
    const dr = r2(Object.values(bal).reduce((s, v) => s + (v > 0 ? v : 0), 0)), cr = r2(Object.values(bal).reduce((s, v) => s + (v < 0 ? -v : 0), 0));
    if (Math.abs(dr - cr) > 0.02) bad.push('ميزان المراجعة غير متوازن');
    return bad;
  }

  /* ---------- الترحيل المتوافق مع الإصدار 1 ---------- */
  function migrate(raw, ctx = {}) {
    const notes = [];
    const d = ensure(clone(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}));
    const hadData = d.items.length || d.sales.length || d.orders.length || d.suppliers.length;
    const c = { opId: 'migration-v2', user: ctx.user || 'system', now: ctx.now || new Date().toISOString(), today: ctx.today };
    c.today = c.today || c.now.slice(0, 10);
    for (const k of ['items', 'suppliers', 'orders', 'sales']) d[k].forEach(r => { if (!r.id) r.id = newId(c); });
    // مخازن افتراضية
    if (!d.warehouses.length) {
      d.warehouses.push({ id: 'wh_raw', code: 'WH-01', name: 'مخزن المواد الخام', kind: 'raw', active: true }, { id: 'wh_fg', code: 'WH-02', name: 'مخزن المنتجات التامة', kind: 'finished', active: true });
      notes.push('أُنشئ مخزنان افتراضيان: مواد خام ومنتجات تامة.');
    }
    if (d.schemaVersion < E.SCHEMA) {
      const soldIds = new Set(d.sales.filter(s => s.status !== 'ملغي').map(s => s.itemId));
      const whRaw = d.warehouses.find(w => w.kind === 'raw'), whFg = d.warehouses.find(w => w.kind === 'finished');
      const open = { '1310': 0, '1320': 0 }; const fixed = [];
      for (const it of d.items) {
        if (it.type !== 'raw' && it.type !== 'finished') {
          const chosen = ctx.itemTypes && ctx.itemTypes[it.id];   // اختيار المستخدم في شاشة المراجعة يسبق التخمين
          it.type = (chosen === 'raw' || chosen === 'finished') ? chosen : (soldIds.has(it.id) ? 'finished' : 'raw');
        }
        if (!it.unit) it.unit = 'وحدة';
        if (it.active == null) it.active = true;
        let q = toNum(it.qty); if (!Number.isFinite(q) || q < 0) { if (it.qty !== '' && it.qty != null) fixed.push(it.name); q = 0; }
        q = r3(q); it.qty = 0; it.stockValue = 0;
        const wh = it.type === 'finished' ? whFg : whRaw;
        if (q > 0) {
          const uc = Math.max(0, toNum(it.price) || 0), val = r2(q * uc);
          moveIn(d, c, { item: it, wh, qty: q, value: val, type: 'opening', date: c.today, refType: 'migration', refId: 'v2', refNo: 'MIG-V2', note: 'رصيد افتتاحي مُرحَّل من الإصدار السابق' });
          open[invAcct(it)] = r2(open[invAcct(it)] + val);
        }
      }
      const jl = []; for (const a of ['1310', '1320']) if (open[a] > 0) jl.push({ acct: a, dr: open[a] }, { acct: '3100', cr: open[a] });
      if (jl.length) post(d, c, { date: c.today, refType: 'migration', refId: 'v2', refNo: 'MIG-V2', memo: 'أرصدة مخزون افتتاحية مُرحَّلة', lines: jl });
      if (d.items.length) notes.push(`رُحّلت أرصدة ${d.items.length} صنف كأرصدة افتتاحية بسعر الوحدة المسجّل (الأصناف المرتبطة بمبيعات سابقة صُنّفت «منتج تام» والباقي «مادة خام»؛ يمكن تعديل ذلك).`);
      if (fixed.length) notes.push('كميات غير صالحة صُفّرت لـ: ' + fixed.join('، '));
      // المبيعات القديمة
      let n = 0;
      for (const s of d.sales.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))) {
        if (s.lines && s.lines.length) continue; n++;
        s.no = s.no || ('INV-L' + String(n).padStart(4, '0'));
        s.lines = [{ itemId: s.itemId, qty: Number(s.qty) || 0, unitPrice: Number(s.unitPrice) || 0, net: Number(s.total) || 0, cost: 0, returnedQty: 0 }];
        s.customerName = s.customerName || s.customer || ''; s.discount = 0; s.returned = 0;
        s.paid = s.status === 'ملغي' ? 0 : (Number(s.total) || 0); s.legacy = true; s.whId = s.whId || (whFg && whFg.id);
      }
      if (n) notes.push(`${n} فاتورة قديمة حُوّلت إلى بنية الفواتير (تُعدّ مدفوعة بالكامل ولا قيود محاسبية لها؛ المحاسبة تبدأ من تاريخ الترحيل).`);
      // أوامر الشراء القديمة
      let m = 0;
      for (const o of d.orders) {
        if (o.lines && o.lines.length) continue; m++;
        const q = Number(o.qty) || 0;
        o.no = o.no || ('PO-L' + String(m).padStart(4, '0'));
        o.lines = [{ itemId: o.itemId, qty: q, price: Number(o.price) || 0, receivedQty: o.status === 'مستلم' ? q : 0 }];
        o.legacy = true; o.date = o.date || c.today;
      }
      if (m) notes.push(`${m} أمر شراء قديم حُوّل لبنية البنود (الأوامر «المستلمة» سابقًا لا تُضيف مخزونًا لأن كميتها محتسبة في الرصيد وقت الترحيل).`);
      d.schemaVersion = E.SCHEMA; d.migratedAt = c.now;
      audit(d, c, 'migrate', 'db', 'v2', notes.join(' | ') || 'ترحيل البنية إلى الإصدار 2');
    }
    d.settings = { safety: 3, allowOverReceipt: false, allowNegativeCash: false, ...d.settings };
    return { db: d, notes, changed: JSON.stringify(d) !== JSON.stringify(raw), hadData: !!hadData };
  }

  /* ---------- بيانات أساسية ---------- */
  const NUM_ITEM = [['min', 'الحد الأدنى'], ['daily', 'متوسط الاستهلاك اليومي'], ['price', 'سعر الوحدة'], ['lead', 'مدة التوريد'], ['inbound', 'أيام حتى وصول الشحنة'], ['delay', 'تأخر الشحنة'], ['salePrice', 'سعر البيع']];
  function isItemReferenced(d, id) {
    return d.ledger.some(e => e.itemId === id && e.type !== 'opening') || d.boms.some(b => b.productId === id || toList(b.lines).some(l => l.itemId === id)) ||
      d.orders.some(o => toList(o.lines).some(l => l.itemId === id)) || d.sales.some(s => toList(s.lines).some(l => l.itemId === id)) || d.productions.some(p => p.productId === id);
  }
  OPS.upsertItem = (d, ctx, inp) => {
    const ex = inp.id ? find(d, 'items', inp.id) : null;
    if (inp.id && !ex) throw err('الصنف غير موجود.', 'not_found');
    const o = ex || { id: newId(ctx), qty: 0, stockValue: 0 };
    const has = k => Object.prototype.hasOwnProperty.call(inp, k);
    if (!ex || has('code')) { o.code = text(inp.code, 40); if (!o.code) throw err('كود الصنف مطلوب.'); }
    if (!ex || has('name')) { o.name = text(inp.name, 80); if (!o.name) throw err('اسم الصنف مطلوب.'); }
    if (d.items.some(x => x.id !== o.id && x.code === o.code)) throw err('هذا الكود مستخدم لصنف آخر.', 'dup_code');
    if (!ex || has('type')) {
      const t = inp.type || 'raw'; if (!ITEM_TYPES[t]) throw err('نوع الصنف غير صالح.');
      if (ex && ex.type !== t && (isItemReferenced(d, ex.id) || Math.abs(Number(ex.qty)) > 0)) throw err('لا يمكن تغيير نوع صنف له رصيد أو حركات أو مستندات؛ أنشئ صنفًا جديدًا.', 'type_locked');
      o.type = t;
    }
    if (has('unit') || !ex) o.unit = text(inp.unit, 20) || 'وحدة';
    for (const [k, label] of NUM_ITEM) if (has(k)) { o[k] = (inp[k] === '' || inp[k] == null) ? '' : num(inp[k], label, { zero: true }); } else if (!ex) o[k] = '';
    if (has('supplierId')) { if (inp.supplierId && !find(d, 'suppliers', inp.supplierId)) throw err('المورد غير موجود.'); o.supplierId = inp.supplierId || ''; } else if (!ex) o.supplierId = '';
    if (has('active')) o.active = inp.active !== false && inp.active !== 'false';
    else if (!ex) o.active = true;
    if (!ex) {
      d.items.push(o); d.stock[o.id] = {};
      const oq = toNum(inp.openingQty);
      if (Number.isFinite(oq) && oq > 0) {
        const wh = needWh(d, inp.openingWhId || d.warehouses.find(w => w.kind === (o.type === 'finished' ? 'finished' : 'raw') && w.active !== false)?.id);
        const uc = Number.isFinite(toNum(inp.openingCost)) ? num(inp.openingCost, 'تكلفة الرصيد الافتتاحي', { zero: true }) : Math.max(0, toNum(o.price) || 0);
        const q = qtyOf(oq, 'الرصيد الافتتاحي'), val = r2(q * uc);
        moveIn(d, ctx, { item: o, wh, qty: q, value: val, type: 'opening', date: needDate(inp.date, ctx), refType: 'item', refId: o.id, refNo: o.code, note: 'رصيد افتتاحي عند إنشاء الصنف' });
        post(d, ctx, { date: needDate(inp.date, ctx), refType: 'opening', refId: o.id, refNo: o.code, memo: 'رصيد افتتاحي ' + o.name, lines: [{ acct: invAcct(o), dr: val }, { acct: '3100', cr: val }] });
      }
    }
    audit(d, ctx, ex ? 'update' : 'create', 'item', o.id, `${o.code} — ${o.name}`);
    return o;
  };
  OPS.deleteItem = (d, ctx, inp) => {
    const it = needItem(d, inp.id);
    if (Math.abs(Number(it.qty) || 0) > 0) throw err('لا يمكن حذف صنف له رصيد مخزني. اصرفه أولًا أو عطّله.', 'has_stock');
    if (isItemReferenced(d, it.id) || d.ledger.some(e => e.itemId === it.id)) throw err('لا يمكن حذف صنف له حركات أو مستندات مرتبطة؛ عطّله بدل حذفه.', 'referenced');
    d.items = d.items.filter(x => x.id !== it.id); delete d.stock[it.id];
    audit(d, ctx, 'delete', 'item', it.id, `${it.code} — ${it.name}`); return true;
  };
  OPS.upsertSupplier = (d, ctx, inp) => {
    const ex = inp.id ? find(d, 'suppliers', inp.id) : null; if (inp.id && !ex) throw err('المورد غير موجود.', 'not_found');
    const o = ex || { id: newId(ctx) };
    o.name = text(inp.name, 80); if (!o.name) throw err('اسم المورد مطلوب.');
    if (d.suppliers.some(x => x.id !== o.id && x.name === o.name)) throw err('اسم المورد مستخدم.', 'dup_name');
    o.itemCodes = text(inp.itemCodes, 200); o.contact = text(inp.contact, 200);
    for (const [k, l] of [['price', 'السعر'], ['lead', 'مدة التوريد'], ['moq', 'الحد الأدنى للطلب']]) o[k] = (inp[k] === '' || inp[k] == null) ? '' : num(inp[k], l, { zero: true });
    o.quality = (inp.quality === '' || inp.quality == null) ? '' : num(inp.quality, 'الجودة', { zero: false, max: 5 }); if (o.quality !== '' && o.quality < 1) throw err('الجودة بين 1 و5.');
    o.verified = ['تجريبي', 'مرشح يحتاج إلى تأكيد', 'تم التحقق'].includes(inp.verified) ? inp.verified : 'تجريبي';
    if (!ex) d.suppliers.push(o);
    audit(d, ctx, ex ? 'update' : 'create', 'supplier', o.id, o.name); return o;
  };
  OPS.deleteSupplier = (d, ctx, inp) => {
    const s = need(d, 'suppliers', inp.id, 'المورد');
    if (d.orders.some(o => o.supplierId === s.id) || d.receipts.some(r => r.supplierId === s.id) || d.payments.some(p => p.supplierId === s.id) || d.items.some(i => i.supplierId === s.id)) throw err('لا يمكن حذف مورد مرتبط بأوامر شراء أو أصناف أو مدفوعات.', 'referenced');
    d.suppliers = d.suppliers.filter(x => x.id !== s.id); audit(d, ctx, 'delete', 'supplier', s.id, s.name); return true;
  };
  OPS.upsertCustomer = (d, ctx, inp) => {
    const ex = inp.id ? find(d, 'customers', inp.id) : null; if (inp.id && !ex) throw err('العميل غير موجود.', 'not_found');
    const o = ex || { id: newId(ctx) };
    o.name = text(inp.name, 80); if (!o.name) throw err('اسم العميل مطلوب.');
    if (d.customers.some(x => x.id !== o.id && x.name === o.name)) throw err('اسم العميل مستخدم.', 'dup_name');
    o.phone = text(inp.phone, 30); o.address = text(inp.address, 200);
    o.creditLimit = (inp.creditLimit === '' || inp.creditLimit == null) ? 0 : num(inp.creditLimit, 'حد الائتمان', { zero: true });
    if (!ex) d.customers.push(o);
    audit(d, ctx, ex ? 'update' : 'create', 'customer', o.id, o.name); return o;
  };
  OPS.deleteCustomer = (d, ctx, inp) => {
    const c = need(d, 'customers', inp.id, 'العميل');
    if (d.sales.some(s => s.customerId === c.id)) throw err('لا يمكن حذف عميل له فواتير.', 'referenced');
    d.customers = d.customers.filter(x => x.id !== c.id); audit(d, ctx, 'delete', 'customer', c.id, c.name); return true;
  };
  OPS.upsertWarehouse = (d, ctx, inp) => {
    const ex = inp.id ? find(d, 'warehouses', inp.id) : null; if (inp.id && !ex) throw err('المخزن غير موجود.', 'not_found');
    const o = ex || { id: 'wh_' + newId(ctx) };
    o.code = text(inp.code, 20); o.name = text(inp.name, 80);
    if (!o.code || !o.name) throw err('كود واسم المخزن مطلوبان.');
    if (d.warehouses.some(w => w.id !== o.id && w.code === o.code)) throw err('كود المخزن مستخدم.', 'dup_code');
    const kind = inp.kind || o.kind; if (!WH_KINDS[kind]) throw err('نوع المخزن غير صالح.');
    if (ex && ex.kind !== kind && (d.ledger.some(e => e.whId === ex.id) || Object.values(d.stock).some(s => s && s[ex.id]))) throw err('لا يمكن تغيير نوع مخزن له حركات.', 'kind_locked');
    o.kind = kind; o.active = inp.active !== false && inp.active !== 'false';
    if (!ex) d.warehouses.push(o);
    audit(d, ctx, ex ? 'update' : 'create', 'warehouse', o.id, `${o.code} — ${o.name}`); return o;
  };
  OPS.deleteWarehouse = (d, ctx, inp) => {
    const w = need(d, 'warehouses', inp.id, 'المخزن');
    if (d.ledger.some(e => e.whId === w.id) || d.productions.some(p => p.rawWhId === w.id || p.fgWhId === w.id)) throw err('لا يمكن حذف مخزن له حركات؛ عطّله بدل حذفه.', 'referenced');
    d.warehouses = d.warehouses.filter(x => x.id !== w.id); audit(d, ctx, 'delete', 'warehouse', w.id, w.name); return true;
  };
  OPS.setItemDelay = (d, ctx, inp) => {
    const it = needItem(d, inp.itemId); const v = num(inp.delay, 'التأخير', { zero: true });
    audit(d, ctx, 'update', 'item', it.id, `تأخر الشحنة ${it.delay ?? ''} ← ${v}`); it.delay = v; return it;
  };
  OPS.updateSettings = (d, ctx, inp) => {
    const s = { ...d.settings };
    for (const k of ['student', 'supervisor', 'institute']) if (inp[k] != null) s[k] = text(inp[k], 200);
    if (inp.safety != null) s.safety = num(inp.safety, 'أيام مخزون الأمان', { zero: true, max: 365 });
    if (inp.apiUrl != null) { const u = text(inp.apiUrl, 300); if (u && !/^https:\/\//.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(u)) throw err('رابط الخادم يجب أن يبدأ بـ https://'); s.apiUrl = u; }
    if (inp.company != null) s.company = text(inp.company, 100);
    for (const k of ['allowOverReceipt', 'allowNegativeCash']) if (inp[k] != null) s[k] = inp[k] === true || inp[k] === 'true';
    d.settings = s; audit(d, ctx, 'update', 'settings', 'settings', 'تحديث الإعدادات'); return s;
  };
  OPS.recordAiDecision = (d, ctx, inp) => {
    const it = needItem(d, inp.itemId);
    if (!['accepted', 'rejected'].includes(inp.decision)) throw err('قرار غير صالح.');
    const n = nextNo(d, 'AID');
    const r = { id: n.id, no: n.no, ts: nowOf(ctx), user: ctx.user || 'unknown', itemId: it.id, riskLevel: text(inp.riskLevel, 12), decision: inp.decision, summary: text(inp.summary, 300), note: text(inp.note, 300) };
    d.aiDecisions.push(r); audit(d, ctx, 'ai-decision', 'item', it.id, `${inp.decision === 'accepted' ? 'اعتماد' : 'رفض'} توصية — ${it.name}`); return r;
  };

  /* ---------- سندات المخازن ---------- */
  function voucherBase(d, ctx, inp, type, prefix) {
    const n = nextNo(d, prefix);
    return { id: n.id, no: n.no, type, date: needDate(inp.date, ctx), note: text(inp.note, 300), createdAt: nowOf(ctx), createdBy: ctx.user || 'unknown', opId: ctx.opId };
  }
  function mergeLines(lines, key) {
    const m = new Map(); for (const l of lines) { const k = key(l); if (m.has(k)) throw err('الصنف مكرر داخل نفس السند؛ ادمج الكميتين في بند واحد.', 'dup_line'); m.set(k, l); } return lines;
  }
  OPS.receiptVoucher = (d, ctx, inp) => {
    const wh = needWh(d, inp.whId); const reason = inp.reason; if (!RECEIPT_REASONS[reason]) throw err('اختر سبب الاستلام.');
    const lines = mergeLines(needLines(inp.lines), l => l.itemId);
    const v = { ...voucherBase(d, ctx, inp, 'receipt', 'RV'), whId: wh.id, reason, lines: [] }; const sums = {};
    for (const l of lines) {
      const it = activeItem(d, l.itemId), q = qtyOf(l.qty, `كمية «${it.name}»`);
      const uc = (l.unitCost === '' || l.unitCost == null) ? avgCost(it) : num(l.unitCost, `تكلفة «${it.name}»`, { zero: true });
      const val = r2(q * uc);
      moveIn(d, ctx, { item: it, wh, qty: q, value: val, type: reason === 'opening' ? 'opening' : 'receipt', date: v.date, refType: 'voucher', refId: v.id, refNo: v.no, note: v.note });
      v.lines.push({ itemId: it.id, qty: q, unitCost: r4(uc), value: val }); sums[invAcct(it)] = r2((sums[invAcct(it)] || 0) + val);
    }
    const jl = []; for (const [a, val] of Object.entries(sums)) jl.push({ acct: a, dr: val }, { acct: reason === 'opening' ? '3100' : '5300', cr: val });
    post(d, ctx, { date: v.date, refType: 'voucher', refId: v.id, refNo: v.no, memo: 'سند استلام — ' + RECEIPT_REASONS[reason], lines: jl });
    d.vouchers.push(v); audit(d, ctx, 'create', 'voucher', v.id, `${v.no} استلام (${v.lines.length} بند)`); return v;
  };
  OPS.issueVoucher = (d, ctx, inp) => {
    const wh = needWh(d, inp.whId); const reason = inp.reason; if (!ISSUE_REASONS[reason]) throw err('اختر سبب الصرف.');
    const lines = mergeLines(needLines(inp.lines), l => l.itemId);
    const v = { ...voucherBase(d, ctx, inp, 'issue', 'IV'), whId: wh.id, reason, lines: [] }; const sums = {}; const touched = [];
    for (const l of lines) {
      const it = activeItem(d, l.itemId), q = qtyOf(l.qty, `كمية «${it.name}»`);
      const cost = moveOut(d, ctx, { item: it, wh, qty: q, type: 'issue', date: v.date, refType: 'voucher', refId: v.id, refNo: v.no, note: v.note });
      v.lines.push({ itemId: it.id, qty: q, unitCost: r4(cost / q), value: cost }); sums[invAcct(it)] = r2((sums[invAcct(it)] || 0) + cost); touched.push(it.id);
    }
    const jl = []; for (const [a, val] of Object.entries(sums)) jl.push({ acct: '5300', dr: val }, { acct: a, cr: val });
    post(d, ctx, { date: v.date, refType: 'voucher', refId: v.id, refNo: v.no, memo: 'سند صرف — ' + ISSUE_REASONS[reason], lines: jl });
    d.vouchers.push(v); audit(d, ctx, 'create', 'voucher', v.id, `${v.no} صرف (${v.lines.length} بند)`);
    return { ...v, alerts: alertsFor(d, touched) };
  };
  OPS.transferVoucher = (d, ctx, inp) => {
    const from = needWh(d, inp.fromWhId), to = needWh(d, inp.toWhId);
    if (from.id === to.id) throw err('مخزن المصدر والوجهة متطابقان.', 'same_wh');
    if (from.kind !== to.kind) throw err('التحويل مسموح بين مخازن من نفس النوع فقط؛ المواد الخام لا تُحوَّل إلى مخزن المنتجات التامة.', 'kind_mismatch');
    const lines = mergeLines(needLines(inp.lines), l => l.itemId);
    const v = { ...voucherBase(d, ctx, inp, 'transfer', 'TV'), whId: from.id, toWhId: to.id, lines: [] }; const touched = [];
    for (const l of lines) {
      const it = activeItem(d, l.itemId), q = qtyOf(l.qty, `كمية «${it.name}»`);
      const avail = stockOf(d, it.id, from.id);
      if (q > avail + E.EPS) throw err(`رصيد غير كافٍ للصنف «${it.name}» في «${from.name}»: المتاح ${r3(avail)} والمطلوب ${q}.`, 'insufficient_stock');
      const uc = avgCost(it), val = r2(q * uc);
      // التحويل لا يغيّر الكمية الكلية ولا القيمة؛ نسجّل خروجًا ودخولًا في الدفتر فقط
      d.stock[it.id][from.id] = r3(avail - q); d.stock[it.id][to.id] = r3(stockOf(d, it.id, to.id) + q);
      E.ledgerPush(d, ctx, { date: v.date, itemId: it.id, whId: from.id, type: 'transfer_out', qtyIn: 0, qtyOut: q, balanceAfter: d.stock[it.id][from.id], itemBalanceAfter: it.qty, unitCost: r4(uc), value: val, refType: 'voucher', refId: v.id, refNo: v.no, note: v.note });
      E.ledgerPush(d, ctx, { date: v.date, itemId: it.id, whId: to.id, type: 'transfer_in', qtyIn: q, qtyOut: 0, balanceAfter: d.stock[it.id][to.id], itemBalanceAfter: it.qty, unitCost: r4(uc), value: val, refType: 'voucher', refId: v.id, refNo: v.no, note: v.note });
      v.lines.push({ itemId: it.id, qty: q, unitCost: r4(uc), value: val }); touched.push(it.id);
    }
    d.vouchers.push(v); audit(d, ctx, 'create', 'voucher', v.id, `${v.no} تحويل ${from.name} ← ${to.name}`); return v;
  };
  OPS.adjustmentVoucher = (d, ctx, inp) => {
    const wh = needWh(d, inp.whId); const reason = text(inp.reason, 200);
    if (reason.length < 3) throw err('سبب التسوية مطلوب (3 أحرف على الأقل).', 'reason_required');
    const lines = mergeLines(needLines(inp.lines), l => l.itemId);
    const v = { ...voucherBase(d, ctx, inp, 'adjustment', 'AV'), whId: wh.id, reason, lines: [] }; const sums = {}; let changed = 0; const touched = [];
    for (const l of lines) {
      const it = activeItem(d, l.itemId); const counted = r3(num(l.countedQty, `الكمية المجرودة لـ«${it.name}»`, { zero: true }));
      const sys = stockOf(d, it.id, wh.id), diff = r3(counted - sys);
      v.lines.push({ itemId: it.id, systemQty: sys, countedQty: counted, diff });
      if (Math.abs(diff) < 0.0005) continue; changed++; touched.push(it.id);
      if (diff > 0) { const uc = avgCost(it), val = r2(diff * uc); moveIn(d, ctx, { item: it, wh, qty: diff, value: val, type: 'adjustment', date: v.date, refType: 'voucher', refId: v.id, refNo: v.no, note: reason }); sums[invAcct(it)] = r2((sums[invAcct(it)] || 0) + val); }
      else { const cost = moveOut(d, ctx, { item: it, wh, qty: -diff, type: 'adjustment', date: v.date, refType: 'voucher', refId: v.id, refNo: v.no, note: reason }); sums[invAcct(it)] = r2((sums[invAcct(it)] || 0) - cost); }
    }
    if (!changed) throw err('لا توجد فروقات بين الجرد ورصيد النظام؛ لا حاجة لسند تسوية.', 'no_diff');
    const jl = []; for (const [a, val] of Object.entries(sums)) { if (val > 0) jl.push({ acct: a, dr: val }, { acct: '5300', cr: val }); else if (val < 0) jl.push({ acct: '5300', dr: -val }, { acct: a, cr: -val }); }
    post(d, ctx, { date: v.date, refType: 'voucher', refId: v.id, refNo: v.no, memo: 'سند تسوية جرد — ' + reason, lines: jl });
    d.vouchers.push(v); audit(d, ctx, 'create', 'voucher', v.id, `${v.no} تسوية جرد (${changed} فرق)`);
    return { ...v, alerts: alertsFor(d, touched) };
  };

  Object.assign(E, { OPS, exec, apply, verify, migrate, isItemReferenced, mergeLines, voucherBase });
  return E;
});
