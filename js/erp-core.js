/* نبض ERP — المحرك الأساسي (دوال نقية بلا واجهة): مخازن، دفتر حركة، إنتاج، مشتريات، مبيعات، محاسبة، تدقيق.
   كل عملية تُنفَّذ على نسخة (clone) ثم تُفحص قواعد السلامة؛ عند أي خطأ تُهمل النسخة ولا يتغير شيء. */
(function (root, f) { if (typeof module === 'object') module.exports = f(); else root.Engine = f(); })(this, function () {
  'use strict';
  const EPS = 1e-6;
  const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const r3 = n => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
  const r4 = n => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
  const toNum = v => (v === '' || v == null ? NaN : Number(v));
  const clone = x => JSON.parse(JSON.stringify(x));
  const SCHEMA = 2;

  function err(msg, code, extra) { const e = new Error(msg); e.code = code || 'invalid'; e.erp = true; if (extra) e.details = extra; return e; }

  /* ---------- ثوابت ---------- */
  const ACCOUNTS = {
    '1100': { n: 'النقدية (خزينة وبنك)', t: 'asset' },
    '1200': { n: 'العملاء (ذمم مدينة)', t: 'asset' },
    '1310': { n: 'مخزون المواد الخام', t: 'asset' },
    '1320': { n: 'مخزون المنتجات التامة', t: 'asset' },
    '2100': { n: 'الموردون (ذمم دائنة)', t: 'liability' },
    '3100': { n: 'رأس المال والأرصدة الافتتاحية', t: 'equity' },
    '4100': { n: 'إيرادات المبيعات', t: 'revenue' },
    '4200': { n: 'مردودات المبيعات', t: 'revenue' },
    '5100': { n: 'تكلفة البضاعة المباعة', t: 'expense' },
    '5200': { n: 'المصروفات التشغيلية', t: 'expense' },
    '5300': { n: 'فروقات وتسويات المخزون', t: 'expense' }
  };
  const ITEM_TYPES = { raw: 'مادة خام / تعبئة', finished: 'منتج تام' };
  const WH_KINDS = { raw: 'مواد خام', finished: 'منتجات تامة' };
  const RECEIPT_REASONS = { opening: 'رصيد افتتاحي', other: 'استلام آخر' };
  const ISSUE_REASONS = { scrap: 'تالف / هالك', internal: 'استهلاك داخلي', sample: 'عينات', other: 'صرف آخر' };
  const PAY_METHODS = ['نقدي', 'تحويل بنكي', 'شيك'];
  const EXPENSE_CATEGORIES = ['رواتب وأجور', 'إيجار', 'كهرباء ومياه', 'صيانة', 'نقل وشحن', 'تسويق', 'مصروفات إدارية', 'أخرى'];
  const PO_OPEN = ['مُرسل', 'قيد الشحن', 'مستلم جزئيًا'];
  const PO_ALL = ['مسودة', 'مُرسل', 'قيد الشحن', 'مستلم جزئيًا', 'مستلم', 'ملغي'];
  const PROD_STATUS = ['مسودة', 'قيد التنفيذ', 'مكتمل', 'ملغي'];

  /* ---------- أدوات التحقق ---------- */
  function num(v, label, o = {}) {
    const n = toNum(v);
    if (!Number.isFinite(n)) throw err(`${label}: أدخل رقمًا صحيحًا.`, 'bad_number');
    if (n < 0 || (!o.zero && n === 0)) throw err(`${label}: يجب أن يكون ${o.zero ? 'صفرًا أو أكبر' : 'أكبر من صفر'}.`, 'bad_number');
    if (n > (o.max || 1e9)) throw err(`${label}: القيمة كبيرة جدًا.`, 'bad_number');
    return n;
  }
  const qtyOf = (v, label) => { const q = r3(num(v, label)); if (q <= 0) throw err(`${label}: الكمية صغيرة جدًا (أقل من 0.001).`, 'bad_number'); return q; };
  const moneyOf = (v, label, o = { zero: true }) => r2(num(v, label, o));
  const text = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  function validDate(s) { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(s + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s; }
  function needDate(v, ctx) { const s = v || ctx.today || nowOf(ctx).slice(0, 10); if (!validDate(s)) throw err('التاريخ غير صالح (الصيغة YYYY-MM-DD).', 'bad_date'); return s; }
  const nowOf = ctx => ctx.now || new Date().toISOString();
  const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const newId = ctx => (ctx && typeof ctx.newId === 'function') ? ctx.newId() : rid();

  /* ---------- هيكل البيانات ---------- */
  const toList = v => (Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : [])).filter(x => x && typeof x === 'object');
  const LISTS = ['items', 'suppliers', 'orders', 'sales', 'warehouses', 'ledger', 'vouchers', 'boms', 'productions', 'receipts', 'customers', 'returns', 'payments', 'collections', 'expenses', 'cashEntries', 'journal', 'audit', 'aiDecisions'];
  function ensure(d) {
    for (const k of LISTS) d[k] = toList(d[k]);
    for (const k of ['stock', 'ops', 'counters', 'settings']) if (!d[k] || typeof d[k] !== 'object' || Array.isArray(d[k])) d[k] = {};
    for (const it of d.items) {
      if (it.stockValue == null) it.stockValue = 0;
      if (it.lines && !Array.isArray(it.lines)) it.lines = toList(it.lines);
    }
    for (const k of ['orders', 'sales', 'vouchers', 'boms', 'productions', 'receipts', 'returns', 'collections']) for (const x of d[k]) {
      for (const lk of ['lines', 'consumption', 'allocations', 'requirement']) if (x[lk] && !Array.isArray(x[lk])) x[lk] = toList(x[lk]);
    }
    for (const j of d.journal) if (j.lines && !Array.isArray(j.lines)) j.lines = toList(j.lines);
    if (!Number.isFinite(d.schemaVersion)) d.schemaVersion = 1;
    return d;
  }
  function nextNo(d, prefix) { d.counters[prefix] = (Number(d.counters[prefix]) || 0) + 1; return { n: d.counters[prefix], no: `${prefix}-${String(d.counters[prefix]).padStart(5, '0')}`, id: prefix.toLowerCase() + d.counters[prefix] }; }

  /* ---------- التدقيق والقيود ---------- */
  function audit(d, ctx, action, entity, entityId, summary) {
    const n = nextNo(d, 'AUD');
    d.audit.push({ id: n.id, ts: nowOf(ctx), user: ctx.user || 'unknown', action, entity, entityId: entityId || '', summary: String(summary || '').slice(0, 300), opId: ctx.opId });
  }
  function post(d, ctx, { date, refType, refId, refNo, memo, lines, saleId, poId }) {
    const ls = lines.filter(l => (l.dr || 0) > 0 || (l.cr || 0) > 0).map(l => {
      if (!ACCOUNTS[l.acct]) throw err('حساب غير معروف: ' + l.acct, 'bad_account');
      const o = { acct: l.acct, dr: r2(l.dr || 0), cr: r2(l.cr || 0) }; if (l.partyId) o.partyId = l.partyId; return o;
    });
    if (!ls.length) return null;
    const dr = r2(ls.reduce((s, l) => s + l.dr, 0)), cr = r2(ls.reduce((s, l) => s + l.cr, 0));
    if (Math.abs(dr - cr) > 0.005) throw err(`قيد غير متوازن (مدين ${dr} / دائن ${cr}).`, 'unbalanced');
    const n = nextNo(d, 'JV');
    const j = { id: n.id, no: n.no, date, ts: nowOf(ctx), ref: { type: refType, id: refId || '', no: refNo || '' }, memo: String(memo || '').slice(0, 200), lines: ls };
    if (saleId) j.saleId = saleId; if (poId) j.poId = poId;
    d.journal.push(j); return j;
  }
  // عكس كل القيود المرتبطة بفاتورة (إلغاء الفاتورة)
  function reverseJournal(d, ctx, pred, memo, date) {
    const targets = d.journal.filter(j => pred(j) && !j.reversed && !j.reverses);
    for (const j of targets) {
      post(d, ctx, { date, refType: 'reversal', refId: j.id, refNo: j.no, memo, saleId: j.saleId, poId: j.poId, lines: j.lines.map(l => ({ acct: l.acct, dr: l.cr, cr: l.dr, partyId: l.partyId })) });
      j.reversed = true; d.journal[d.journal.length - 1].reverses = j.id;
    }
  }

  /* ---------- استعلامات ---------- */
  const find = (d, k, id) => d[k].find(x => x.id === id);
  function need(d, k, id, label) { const x = find(d, k, id); if (!x) throw err(`${label} غير موجود.`, 'not_found'); return x; }
  const stockOf = (d, itemId, whId) => ((d.stock[itemId] || {})[whId]) || 0;
  const invAcct = it => (it.type === 'finished' ? '1320' : '1310');
  function avgCost(it) {
    const q = Number(it.qty) || 0;
    if (q > EPS) return (Number(it.stockValue) || 0) / q;
    const lc = toNum(it.lastCost), p = toNum(it.price);
    return lc > 0 ? lc : (p > 0 ? p : 0);
  }
  function balances(d) {
    const b = {};
    for (const j of d.journal) for (const l of j.lines) { b[l.acct] = r2((b[l.acct] || 0) + l.dr - l.cr); }
    return b;
  }
  function partyBalance(d, acct, partyId) {
    let s = 0; for (const j of d.journal) for (const l of j.lines) if (l.acct === acct && l.partyId === partyId) s += l.dr - l.cr;
    return r2(acct === '2100' ? -s : s);
  }
  const cashBalance = d => balances(d)['1100'] || 0;
  const arBalance = (d, cid) => partyBalance(d, '1200', cid);
  const apBalance = (d, sid) => partyBalance(d, '2100', sid);
  function saleOutstanding(s) { return r2((Number(s.total) || 0) - (Number(s.returned) || 0) - (Number(s.paid) || 0)); }
  const lowStock = d => d.items.filter(i => i.active !== false && Number(i.min) > 0 && (Number(i.qty) || 0) <= Number(i.min));

  /* ---------- حركة المخزون (الدفتر) ---------- */
  function assertKind(it, wh) {
    const need = it.type === 'finished' ? 'finished' : 'raw';
    if (wh.kind !== need) throw err(`لا يمكن تخزين «${it.name}» (${ITEM_TYPES[need]}) في «${wh.name}» (${WH_KINDS[wh.kind]}) — مخزن المواد الخام منفصل عن مخزن المنتجات التامة.`, 'wrong_warehouse');
  }
  function ledgerPush(d, ctx, e) {
    const n = nextNo(d, 'LED');
    d.ledger.push({ id: n.id, seq: n.n, ts: nowOf(ctx), user: ctx.user || 'unknown', opId: ctx.opId, ...e });
  }
  function moveIn(d, ctx, { item, wh, qty, value, type, date, refType, refId, refNo, note }) {
    assertKind(item, wh);
    if (wh.active === false) throw err(`المخزن «${wh.name}» غير نشط.`, 'wh_inactive');
    d.stock[item.id] = d.stock[item.id] || {};
    const bal = r3(stockOf(d, item.id, wh.id) + qty);
    d.stock[item.id][wh.id] = bal;
    item.qty = r3((Number(item.qty) || 0) + qty);
    item.stockValue = r2((Number(item.stockValue) || 0) + value);
    ledgerPush(d, ctx, { date, itemId: item.id, whId: wh.id, type, qtyIn: qty, qtyOut: 0, balanceAfter: bal, itemBalanceAfter: item.qty, unitCost: r4(qty > 0 ? value / qty : 0), value: r2(value), refType, refId, refNo, note: note || '' });
  }
  // يُرجع تكلفة الكمية المصروفة بمتوسط التكلفة المتحرك
  function moveOut(d, ctx, { item, wh, qty, type, date, refType, refId, refNo, note }) {
    assertKind(item, wh);
    const avail = stockOf(d, item.id, wh.id);
    if (qty > avail + EPS) throw err(`رصيد غير كافٍ للصنف «${item.name}» في «${wh.name}»: المتاح ${r3(avail)} والمطلوب ${qty}.`, 'insufficient_stock', { itemId: item.id, whId: wh.id, available: avail, required: qty });
    const totalQty = Number(item.qty) || 0, totalVal = Number(item.stockValue) || 0;
    const cost = (r3(totalQty - qty) <= 0) ? totalVal : r2(totalVal * qty / totalQty);
    const bal = r3(avail - qty);
    d.stock[item.id][wh.id] = bal;
    item.qty = r3(totalQty - qty);
    item.stockValue = Math.max(0, r2(totalVal - cost));
    ledgerPush(d, ctx, { date, itemId: item.id, whId: wh.id, type, qtyIn: 0, qtyOut: qty, balanceAfter: bal, itemBalanceAfter: item.qty, unitCost: r4(qty > 0 ? cost / qty : 0), value: r2(cost), refType, refId, refNo, note: note || '' });
    return r2(cost);
  }
  // تنبيه الحد الأدنى بعد العملية
  function alertsFor(d, itemIds) {
    return [...new Set(itemIds)].map(id => find(d, 'items', id)).filter(i => i && i.active !== false && Number(i.min) > 0 && (Number(i.qty) || 0) <= Number(i.min))
      .map(i => ({ itemId: i.id, name: i.name, qty: i.qty, min: i.min, text: `تنبيه: «${i.name}» أصبح ${r3(i.qty)} (الحد الأدنى ${i.min}).` }));
  }
  function needLines(lines, label = 'بنود المستند') {
    const ls = toList(lines);
    if (!ls.length) throw err(`${label}: أضف بندًا واحدًا على الأقل.`, 'no_lines');
    if (ls.length > 200) throw err(`${label}: عدد البنود كبير جدًا.`, 'too_many');
    return ls;
  }
  const needItem = (d, id) => need(d, 'items', id, 'الصنف');
  const needWh = (d, id) => { const w = need(d, 'warehouses', id, 'المخزن'); if (w.active === false) throw err(`المخزن «${w.name}» غير نشط.`, 'wh_inactive'); return w; };
  const activeItem = (d, id) => { const it = needItem(d, id); if (it.active === false) throw err(`الصنف «${it.name}» غير نشط.`, 'item_inactive'); return it; };

  return { EPS, r2, r3, r4, toNum, clone, SCHEMA, err, ACCOUNTS, ITEM_TYPES, WH_KINDS, RECEIPT_REASONS, ISSUE_REASONS, PAY_METHODS, EXPENSE_CATEGORIES, PO_OPEN, PO_ALL, PROD_STATUS,
    num, qtyOf, moneyOf, text, validDate, needDate, nowOf, newId, toList, ensure, nextNo, audit, post, reverseJournal, find, need, stockOf, invAcct, avgCost, balances, partyBalance, cashBalance, arBalance, apBalance, saleOutstanding, lowStock,
    assertKind, moveIn, moveOut, alertsFor, needLines, needItem, needWh, activeItem, ledgerPush, LISTS, _ext: {} };
});
