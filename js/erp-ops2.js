/* نبض ERP — العمليات (2): الإنتاج، المشتريات، المبيعات، المحاسبة */
(function (root, f) { if (typeof module === 'object') module.exports = f(require('./erp-ops.js')); else f(root.Engine); })(this, function (E) {
  'use strict';
  const { err, r2, r3, r4, toNum, num, qtyOf, moneyOf, text, needDate, nowOf, toList, nextNo, audit, post, reverseJournal, find, need, stockOf, invAcct, avgCost,
    moveIn, moveOut, alertsFor, needLines, needItem, needWh, activeItem, OPS, mergeLines, PAY_METHODS, EXPENSE_CATEGORIES, PO_OPEN, EPS } = E;

  // لا يُسمح بخروج نقدية أكبر من رصيد الخزينة إلا إذا فعّل المستخدم «السماح برصيد نقدي سالب» في الإعدادات
  function needCash(d, amount, what) {
    if (d.settings && d.settings.allowNegativeCash) return;
    const bal = E.cashBalance(d);
    if (amount > bal + 0.005) throw err(`رصيد الخزينة (${bal}) لا يكفي لـ${what} (${amount}). سجّل إيداع رأس مال أو تحصيلًا أولًا.`, 'insufficient_cash');
  }

  /* ---------- الإنتاج: الوصفات (BOM) ---------- */
  OPS.upsertBom = (d, ctx, inp) => {
    const ex = inp.id ? find(d, 'boms', inp.id) : null; if (inp.id && !ex) throw err('الوصفة غير موجودة.', 'not_found');
    const product = needItem(d, inp.productId);
    if (product.type !== 'finished') throw err('منتج الوصفة يجب أن يكون صنفًا من نوع «منتج تام».', 'bad_product');
    const outputQty = qtyOf(inp.outputQty, 'كمية الإنتاج المرجعية');
    const seen = new Set(); const lines = [];
    for (const l of needLines(inp.lines, 'مكونات الوصفة')) {
      const it = needItem(d, l.itemId);
      if (it.type !== 'raw') throw err(`«${it.name}» ليس مادة خام؛ الوصفة تتكون من مواد خام وتعبئة فقط.`, 'bad_component');
      if (seen.has(it.id)) throw err(`المادة «${it.name}» مكررة في الوصفة.`, 'dup_line'); seen.add(it.id);
      lines.push({ itemId: it.id, qty: qtyOf(l.qty, `كمية «${it.name}»`), wastePct: (l.wastePct === '' || l.wastePct == null) ? 0 : num(l.wastePct, `نسبة هالك «${it.name}»`, { zero: true, max: 100 }) });
    }
    const o = ex || { id: nextNo(d, 'BOM').id };
    if (ex) nextNo(d, 'BOMV');
    Object.assign(o, { productId: product.id, name: text(inp.name, 80) || `وصفة ${product.name}`, outputQty, lines, active: inp.active !== false && inp.active !== 'false', updatedAt: nowOf(ctx) });
    if (!ex) d.boms.push(o);
    audit(d, ctx, ex ? 'update' : 'create', 'bom', o.id, o.name); return o;
  };
  OPS.deleteBom = (d, ctx, inp) => {
    const b = need(d, 'boms', inp.id, 'الوصفة');
    if (d.productions.some(p => p.bomId === b.id)) throw err('الوصفة مستخدمة في أوامر إنتاج؛ عطّلها بدل حذفها.', 'referenced');
    d.boms = d.boms.filter(x => x.id !== b.id); audit(d, ctx, 'delete', 'bom', b.id, b.name); return true;
  };
  // الاحتياج = كمية المكوّن × (المخطط ÷ المرجعي) × (1 + نسبة الهالك المسموح)
  function requirement(d, bomId, plannedQty) {
    const bom = need(d, 'boms', bomId, 'الوصفة'); const q = qtyOf(plannedQty, 'الكمية المخططة');
    return toList(bom.lines).map(l => ({ itemId: l.itemId, perBatch: l.qty, wastePct: l.wastePct || 0, required: r3(l.qty * q / bom.outputQty * (1 + (l.wastePct || 0) / 100)) }));
  }
  function checkAvailability(d, reqLines, rawWhId) {
    const lines = reqLines.map(r => { const it = find(d, 'items', r.itemId) || {}; const available = stockOf(d, r.itemId, rawWhId); return { itemId: r.itemId, name: it.name || '؟', unit: it.unit || '', required: r.required, available, shortage: Math.max(0, r3(r.required - available)) }; });
    return { ok: lines.every(l => l.shortage <= EPS), lines };
  }
  const shortMsg = c => 'نقص في المواد: ' + c.lines.filter(l => l.shortage > EPS).map(l => `${l.name} (المتاح ${r3(l.available)} من ${l.required}، العجز ${l.shortage})`).join('، ');

  OPS.createProduction = (d, ctx, inp) => {
    const bom = need(d, 'boms', inp.bomId, 'الوصفة'); if (bom.active === false) throw err('الوصفة معطّلة.', 'bom_inactive');
    const product = activeItem(d, bom.productId);
    const rawWh = needWh(d, inp.rawWhId), fgWh = needWh(d, inp.fgWhId);
    if (rawWh.kind !== 'raw') throw err('مخزن المواد يجب أن يكون من نوع «مواد خام».'); if (fgWh.kind !== 'finished') throw err('مخزن الناتج يجب أن يكون من نوع «منتجات تامة».');
    const planned = qtyOf(inp.plannedQty, 'الكمية المخططة'); const n = nextNo(d, 'PRD');
    const p = { id: n.id, no: n.no, bomId: bom.id, productId: product.id, plannedQty: planned, rawWhId: rawWh.id, fgWhId: fgWh.id, date: needDate(inp.date, ctx), status: 'مسودة', requirement: requirement(d, bom.id, planned), note: text(inp.note, 300), createdAt: nowOf(ctx), createdBy: ctx.user || 'unknown' };
    d.productions.push(p); audit(d, ctx, 'create', 'production', p.id, `${p.no} — ${product.name} × ${planned}`); return p;
  };
  OPS.startProduction = (d, ctx, inp) => {
    const p = need(d, 'productions', inp.id, 'أمر الإنتاج'); if (p.status !== 'مسودة') throw err(`لا يمكن بدء أمر بحالة «${p.status}».`, 'bad_status');
    const c = checkAvailability(d, toList(p.requirement), p.rawWhId); if (!c.ok) throw err(shortMsg(c), 'material_shortage', c);
    p.status = 'قيد التنفيذ'; p.startedAt = nowOf(ctx); audit(d, ctx, 'status', 'production', p.id, `${p.no} ← قيد التنفيذ`); return p;
  };
  OPS.cancelProduction = (d, ctx, inp) => {
    const p = need(d, 'productions', inp.id, 'أمر الإنتاج'); if (!['مسودة', 'قيد التنفيذ'].includes(p.status)) throw err(`لا يمكن إلغاء أمر بحالة «${p.status}».`, 'bad_status');
    p.status = 'ملغي'; p.cancelledAt = nowOf(ctx); audit(d, ctx, 'status', 'production', p.id, `${p.no} ← ملغي`); return p;
  };
  OPS.completeProduction = (d, ctx, inp) => {
    const p = need(d, 'productions', inp.id, 'أمر الإنتاج');
    if (!['مسودة', 'قيد التنفيذ'].includes(p.status)) throw err(`لا يمكن إكمال أمر بحالة «${p.status}».`, 'bad_status');
    const produced = qtyOf(inp.producedQty, 'الكمية المنتجة الفعلية');
    const rawWh = needWh(d, p.rawWhId), fgWh = needWh(d, p.fgWhId), product = activeItem(d, p.productId);
    const given = new Map(toList(inp.consumption).map(c => [c.itemId, c]));
    for (const id of given.keys()) if (!toList(p.requirement).some(r => r.itemId === id)) throw err('مادة غير موجودة في وصفة هذا الأمر.', 'bad_component');
    const plan = toList(p.requirement).map(r => {
      const it = needItem(d, r.itemId), g = given.get(r.itemId) || {};
      const actual = (g.actualQty === '' || g.actualQty == null) ? r.required : r3(num(g.actualQty, `الاستهلاك الفعلي لـ«${it.name}»`, { zero: true }));
      const waste = (g.wasteQty === '' || g.wasteQty == null) ? 0 : r3(num(g.wasteQty, `هالك «${it.name}»`, { zero: true }));
      if (waste > actual + EPS) throw err(`هالك «${it.name}» (${waste}) أكبر من الكمية المستهلكة (${actual}).`, 'bad_waste');
      return { it, required: r.required, actual, waste };
    });
    if (!plan.some(x => x.actual > 0)) throw err('لا يمكن إكمال الإنتاج دون استهلاك أي مادة.', 'no_consumption');
    const chk = checkAvailability(d, plan.map(x => ({ itemId: x.it.id, required: x.actual })), rawWh.id); if (!chk.ok) throw err(shortMsg(chk), 'material_shortage', chk);
    let matCost = 0, wasteValue = 0; const cons = [];
    for (const x of plan) {
      let cost = 0;
      if (x.actual > 0) cost = moveOut(d, ctx, { item: x.it, wh: rawWh, qty: x.actual, type: 'production_consume', date: p.date, refType: 'production', refId: p.id, refNo: p.no, note: 'استهلاك إنتاج' });
      matCost = r2(matCost + cost); const wv = x.actual > 0 ? r2(cost * x.waste / x.actual) : 0; wasteValue = r2(wasteValue + wv);
      cons.push({ itemId: x.it.id, required: x.required, actualQty: x.actual, wasteQty: x.waste, cost, wasteValue: wv, variance: r3(x.actual - x.required) });
    }
    const other = (inp.otherCost === '' || inp.otherCost == null) ? 0 : moneyOf(inp.otherCost, 'تكاليف التشغيل الأخرى'); const total = r2(matCost + other);
    if (other > 0) needCash(d, other, 'دفع تكاليف التشغيل الأخرى');
    moveIn(d, ctx, { item: product, wh: fgWh, qty: produced, value: total, type: 'production_output', date: p.date, refType: 'production', refId: p.id, refNo: p.no, note: 'ناتج إنتاج' });
    post(d, ctx, { date: p.date, refType: 'production', refId: p.id, refNo: p.no, memo: 'إكمال أمر إنتاج ' + p.no, lines: [{ acct: '1320', dr: total }, { acct: '1310', cr: matCost }, { acct: '1100', cr: other }] });
    product.lastCost = r4(total / produced);
    Object.assign(p, { status: 'مكتمل', producedQty: produced, consumption: cons, materialCost: matCost, otherCost: other, totalCost: total, unitCost: r4(total / produced), wasteValue, wasteQty: r3(cons.reduce((s, c) => s + c.wasteQty, 0)), yieldPct: Math.round(produced / p.plannedQty * 1000) / 10, completedAt: nowOf(ctx), completedBy: ctx.user || 'unknown' });
    audit(d, ctx, 'status', 'production', p.id, `${p.no} مكتمل — إنتاج ${produced} بتكلفة وحدة ${p.unitCost}`);
    return { ...p, alerts: alertsFor(d, plan.map(x => x.it.id)) };
  };

  /* ---------- المشتريات ---------- */
  function poLines(d, inp) {
    const seen = new Set(); let total = 0;
    const lines = needLines(inp.lines, 'بنود أمر الشراء').map(l => {
      const it = activeItem(d, l.itemId); if (seen.has(it.id)) throw err(`الصنف «${it.name}» مكرر في أمر الشراء.`, 'dup_line'); seen.add(it.id);
      const q = qtyOf(l.qty, `كمية «${it.name}»`), pr = moneyOf(l.price, `سعر «${it.name}»`); total = r2(total + q * pr);
      return { itemId: it.id, qty: q, price: pr, receivedQty: 0 };
    });
    return { lines, total };
  }
  function poHeader(d, inp, o) {
    const sup = need(d, 'suppliers', inp.supplierId, 'المورد'); o.supplierId = sup.id;
    if (inp.expectedDate) { if (!E.validDate(inp.expectedDate)) throw err('تاريخ التوريد المتوقع غير صالح.'); o.expectedDate = inp.expectedDate; } else delete o.expectedDate;
    o.note = text(inp.note, 300);
  }
  OPS.createPO = (d, ctx, inp) => {
    const n = nextNo(d, 'PO'); const o = { id: n.id, no: n.no, status: 'مسودة', date: needDate(inp.date, ctx), createdAt: nowOf(ctx), createdBy: ctx.user || 'unknown' };
    poHeader(d, inp, o); const { lines, total } = poLines(d, inp); o.lines = lines; o.total = total; o.itemId = lines[0].itemId; o.qty = r3(lines.reduce((s, l) => s + l.qty, 0));
    if (inp.source === 'risk-analysis') o.source = 'risk-analysis';
    d.orders.push(o); audit(d, ctx, 'create', 'po', o.id, `${o.no} (${lines.length} بند، ${total})`); return o;
  };
  OPS.updatePO = (d, ctx, inp) => {
    const o = need(d, 'orders', inp.id, 'أمر الشراء'); if (o.status !== 'مسودة') throw err('يمكن تعديل أوامر الشراء في حالة «مسودة» فقط.', 'bad_status');
    poHeader(d, inp, o); o.date = needDate(inp.date || o.date, ctx); const { lines, total } = poLines(d, inp); o.lines = lines; o.total = total; o.itemId = lines[0].itemId; o.qty = r3(lines.reduce((s, l) => s + l.qty, 0));
    audit(d, ctx, 'update', 'po', o.id, o.no); return o;
  };
  OPS.deletePO = (d, ctx, inp) => {
    const o = need(d, 'orders', inp.id, 'أمر الشراء');
    if (d.receipts.some(r => r.poId === o.id)) throw err('لا يمكن حذف أمر له استلامات.', 'referenced');
    if (!['مسودة', 'ملغي'].includes(o.status)) throw err('يُحذف أمر الشراء في حالة «مسودة» أو «ملغي» فقط؛ ألغِه أولًا.', 'bad_status');
    d.orders = d.orders.filter(x => x.id !== o.id); audit(d, ctx, 'delete', 'po', o.id, o.no || o.id); return true;
  };
  const PO_NEXT = { 'مسودة': ['مُرسل', 'ملغي'], 'مُرسل': ['قيد الشحن', 'ملغي'], 'قيد الشحن': ['ملغي'] };
  OPS.setPOStatus = (d, ctx, inp) => {
    const o = need(d, 'orders', inp.id, 'أمر الشراء'); const to = inp.status;
    if (!(PO_NEXT[o.status] || []).includes(to)) throw err(`لا يمكن الانتقال من «${o.status}» إلى «${to}».`, 'bad_status');
    if (to === 'ملغي' && (d.receipts.some(r => r.poId === o.id) || toList(o.lines).some(l => l.receivedQty > 0))) throw err('لا يمكن إلغاء أمر استُلم جزء منه.', 'has_receipts');
    audit(d, ctx, 'status', 'po', o.id, `${o.no || o.id}: ${o.status} ← ${to}`); o.status = to; return o;
  };
  OPS.receiveGoods = (d, ctx, inp) => {
    const po = need(d, 'orders', inp.poId, 'أمر الشراء');
    if (!PO_OPEN.includes(po.status)) throw err(`لا يمكن الاستلام على أمر بحالة «${po.status}»${po.status === 'مسودة' ? ' — اعتمد الأمر (إرسال) أولًا' : ''}.`, 'bad_status');
    const wh = needWh(d, inp.whId); const date = needDate(inp.date, ctx);
    const lines = mergeLines(needLines(inp.lines, 'بنود الاستلام'), l => l.itemId);
    const n = nextNo(d, 'GR'); const rc = { id: n.id, no: n.no, poId: po.id, poNo: po.no || po.id, supplierId: po.supplierId, date, whId: wh.id, lines: [], total: 0, note: text(inp.note, 300), createdAt: nowOf(ctx), createdBy: ctx.user || 'unknown' };
    const sums = {};
    for (const l of lines) {
      const pl = toList(po.lines).find(x => x.itemId === l.itemId); if (!pl) throw err('الصنف غير موجود في أمر الشراء.', 'not_in_po');
      const it = needItem(d, pl.itemId), q = qtyOf(l.qty, `كمية «${it.name}»`), remaining = r3(pl.qty - (pl.receivedQty || 0));
      if (q > remaining + EPS && !d.settings.allowOverReceipt) throw err(`كمية «${it.name}» (${q}) تتجاوز المتبقي في أمر الشراء (${remaining}).`, 'over_receipt');
      const uc = (l.unitCost === '' || l.unitCost == null) ? pl.price : num(l.unitCost, `تكلفة «${it.name}»`, { zero: true }); const val = r2(q * uc);
      moveIn(d, ctx, { item: it, wh, qty: q, value: val, type: 'purchase_receipt', date, refType: 'receipt', refId: rc.id, refNo: rc.no, note: `استلام ${rc.poNo}` });
      it.lastCost = r4(uc); pl.receivedQty = r3((pl.receivedQty || 0) + q);
      rc.lines.push({ itemId: it.id, qty: q, unitCost: r4(uc), value: val }); rc.total = r2(rc.total + val); sums[invAcct(it)] = r2((sums[invAcct(it)] || 0) + val);
    }
    const jl = Object.entries(sums).map(([a, v]) => ({ acct: a, dr: v })); jl.push({ acct: '2100', cr: rc.total, partyId: po.supplierId });
    post(d, ctx, { date, refType: 'receipt', refId: rc.id, refNo: rc.no, memo: `استلام بضاعة ${rc.poNo}`, lines: jl, poId: po.id });
    po.status = toList(po.lines).every(l => (l.receivedQty || 0) >= l.qty - EPS) ? 'مستلم' : 'مستلم جزئيًا';
    d.receipts.push(rc); audit(d, ctx, 'create', 'receipt', rc.id, `${rc.no} على ${rc.poNo} بقيمة ${rc.total}`); return rc;
  };
  OPS.paySupplier = (d, ctx, inp) => {
    const sup = need(d, 'suppliers', inp.supplierId, 'المورد'); const amount = moneyOf(inp.amount, 'المبلغ', { zero: false });
    if (!PAY_METHODS.includes(inp.method)) throw err('اختر طريقة الدفع.');
    const due = E.apBalance(d, sup.id); if (amount > due + 0.005) throw err(`المبلغ (${amount}) أكبر من المستحق للمورد «${sup.name}» (${due}).`, 'overpay');
    needCash(d, amount, 'سداد المورد');
    const n = nextNo(d, 'PAY'); const date = needDate(inp.date, ctx);
    const p = { id: n.id, no: n.no, supplierId: sup.id, date, amount, method: inp.method, note: text(inp.note, 300), createdAt: nowOf(ctx), createdBy: ctx.user || 'unknown' };
    post(d, ctx, { date, refType: 'payment', refId: p.id, refNo: p.no, memo: 'سداد مورد ' + sup.name, lines: [{ acct: '2100', dr: amount, partyId: sup.id }, { acct: '1100', cr: amount }] });
    d.payments.push(p); audit(d, ctx, 'create', 'payment', p.id, `${p.no} ${sup.name} ${amount}`); return { ...p, cashAfter: E.cashBalance(d) };
  };

  /* ---------- المبيعات ---------- */
  OPS.createInvoice = (d, ctx, inp) => {
    const wh = needWh(d, inp.whId); if (wh.kind !== 'finished') throw err('البيع يتم من مخزن «منتجات تامة» فقط.', 'wrong_warehouse');
    const cust = inp.customerId ? need(d, 'customers', inp.customerId, 'العميل') : null;
    const date = needDate(inp.date, ctx);
    const raw = mergeLines(needLines(inp.lines, 'بنود الفاتورة'), l => l.itemId);
    const ls = raw.map(l => { const it = activeItem(d, l.itemId); if (it.type !== 'finished') throw err(`«${it.name}» مادة خام؛ تُباع المنتجات التامة فقط.`, 'not_sellable'); const q = qtyOf(l.qty, `كمية «${it.name}»`), pr = moneyOf(l.unitPrice, `سعر «${it.name}»`); return { it, q, pr, gross: r2(q * pr) }; });
    const gross = r2(ls.reduce((s, x) => s + x.gross, 0));
    const discount = (inp.discount === '' || inp.discount == null) ? 0 : moneyOf(inp.discount, 'الخصم');
    if (discount > gross + 0.005) throw err('الخصم أكبر من إجمالي الفاتورة.', 'bad_discount');
    const total = r2(gross - discount); let alloc = 0;
    ls.forEach((x, i) => { x.net = i === ls.length - 1 ? r2(total - alloc) : r2(x.gross - (gross > 0 ? discount * x.gross / gross : 0)); alloc = r2(alloc + x.net); });
    const paid = (inp.paid === '' || inp.paid == null) ? (cust ? 0 : total) : moneyOf(inp.paid, 'المدفوع');
    if (paid > total + 0.005) throw err('المدفوع أكبر من إجمالي الفاتورة.', 'overpay');
    if (!cust && Math.abs(paid - total) > 0.005) throw err('البيع الآجل يتطلب اختيار عميل مسجّل؛ العميل العابر يدفع كامل المبلغ.', 'credit_needs_customer');
    if (paid > 0 && !PAY_METHODS.includes(inp.method)) throw err('اختر طريقة الدفع.');
    const owed = r2(total - paid);
    if (cust && cust.creditLimit > 0 && r2(E.arBalance(d, cust.id) + owed) > cust.creditLimit + 0.005) throw err(`تجاوز حد الائتمان للعميل «${cust.name}» (${cust.creditLimit}).`, 'credit_limit');
    const n = nextNo(d, 'INV'); let cogs = 0; const lines = []; const touched = [];
    for (const x of ls) {
      const cost = moveOut(d, ctx, { item: x.it, wh, qty: x.q, type: 'sale', date, refType: 'invoice', refId: n.id, refNo: n.no, note: cust ? cust.name : text(inp.customerName, 100) });
      cogs = r2(cogs + cost); touched.push(x.it.id);
      lines.push({ itemId: x.it.id, qty: x.q, unitPrice: x.pr, net: x.net, cost, returnedQty: 0, returnedValue: 0, returnedCost: 0 });
    }
    const s = { id: n.id, no: n.no, date, status: 'مؤكد', customerId: cust ? cust.id : '', customer: cust ? cust.name : text(inp.customerName, 100), customerName: cust ? cust.name : text(inp.customerName, 100), whId: wh.id, lines,
      itemId: lines[0].itemId, qty: r3(lines.reduce((a, l) => a + l.qty, 0)), unitPrice: lines.length === 1 ? lines[0].unitPrice : '', discount, total, paid, returned: 0, cogs, paymentMethod: paid > 0 ? inp.method : '', note: text(inp.note, 300), createdAt: nowOf(ctx), createdBy: ctx.user || 'unknown' };
    const jl = [{ acct: '1100', dr: paid }, { acct: '1200', dr: owed, partyId: cust && cust.id }, { acct: '4100', cr: total }, { acct: '5100', dr: cogs }, { acct: '1320', cr: cogs }];
    post(d, ctx, { date, refType: 'invoice', refId: s.id, refNo: s.no, memo: 'فاتورة مبيعات ' + s.no, lines: jl, saleId: s.id });
    d.sales.push(s); audit(d, ctx, 'create', 'invoice', s.id, `${s.no} بقيمة ${total}${owed > 0 ? ` (آجل ${owed})` : ''}`); return { ...s, alerts: alertsFor(d, touched) };
  };
  OPS.collectPayment = (d, ctx, inp) => {
    const cust = need(d, 'customers', inp.customerId, 'العميل'); const amount = moneyOf(inp.amount, 'المبلغ', { zero: false });
    if (!PAY_METHODS.includes(inp.method)) throw err('اختر طريقة الدفع.'); const date = needDate(inp.date, ctx);
    let invs = d.sales.filter(s => s.customerId === cust.id && s.status === 'مؤكد' && E.saleOutstanding(s) > 0.005).sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.no.localeCompare(b.no));
    if (inp.saleId) { invs = invs.filter(s => s.id === inp.saleId); if (!invs.length) throw err('الفاتورة غير مستحقة أو لا تخص هذا العميل.', 'not_due'); }
    const due = r2(invs.reduce((s, x) => s + E.saleOutstanding(x), 0));
    if (amount > due + 0.005) throw err(`المبلغ (${amount}) أكبر من المستحق على العميل «${cust.name}» (${due}).`, 'overpay');
    const n = nextNo(d, 'COL'); let left = amount; const allocations = [];
    for (const s of invs) { if (left <= 0.004) break; const a = Math.min(left, E.saleOutstanding(s)); const ar = r2(a); s.paid = r2(s.paid + ar); left = r2(left - ar); allocations.push({ saleId: s.id, saleNo: s.no, amount: ar });
      post(d, ctx, { date, refType: 'collection', refId: n.id, refNo: n.no, memo: `تحصيل من ${cust.name} على ${s.no}`, saleId: s.id, lines: [{ acct: '1100', dr: ar }, { acct: '1200', cr: ar, partyId: cust.id }] }); }
    const c = { id: n.id, no: n.no, customerId: cust.id, date, amount, method: inp.method, allocations, note: text(inp.note, 300), createdAt: nowOf(ctx), createdBy: ctx.user || 'unknown' };
    d.collections.push(c); audit(d, ctx, 'create', 'collection', c.id, `${c.no} ${cust.name} ${amount}`); return c;
  };
  OPS.createReturn = (d, ctx, inp) => {
    const s = need(d, 'sales', inp.saleId, 'الفاتورة'); if (s.status !== 'مؤكد') throw err('لا مرتجع على فاتورة ملغاة.', 'bad_status');
    if (s.legacy) throw err('هذه فاتورة قديمة (قبل الترحيل) بلا بيانات تكلفة؛ استخدم «إلغاء الفاتورة» لها.', 'legacy_invoice');
    const date = needDate(inp.date, ctx); const restock = inp.restock !== false && inp.restock !== 'false';
    const wh = restock ? needWh(d, inp.whId || s.whId) : null; if (wh && wh.kind !== 'finished') throw err('المرتجع الصالح يعود إلى مخزن «منتجات تامة».', 'wrong_warehouse');
    const n = nextNo(d, 'RET'); const lines = []; let V = 0, C = 0; const touched = [];
    for (const l of mergeLines(needLines(inp.lines, 'بنود المرتجع'), l => l.itemId)) {
      const sl = toList(s.lines).find(x => x.itemId === l.itemId); if (!sl) throw err('الصنف غير موجود في الفاتورة.', 'not_in_invoice');
      const it = needItem(d, sl.itemId), q = qtyOf(l.qty, `كمية «${it.name}»`), room = r3(sl.qty - (sl.returnedQty || 0));
      if (q > room + EPS) throw err(`مرتجع «${it.name}» (${q}) يتجاوز المتاح للإرجاع (${room}).`, 'over_return');
      const last = r3(room - q) <= 0;
      const val = last ? r2(sl.net - (sl.returnedValue || 0)) : r2(sl.net * q / sl.qty), cost = last ? r2(sl.cost - (sl.returnedCost || 0)) : r2(sl.cost * q / sl.qty);
      sl.returnedQty = r3((sl.returnedQty || 0) + q); sl.returnedValue = r2((sl.returnedValue || 0) + val); sl.returnedCost = r2((sl.returnedCost || 0) + cost);
      V = r2(V + val); C = r2(C + cost); lines.push({ itemId: it.id, qty: q, value: val, cost: restock ? cost : 0 });
      if (restock) { moveIn(d, ctx, { item: it, wh, qty: q, value: cost, type: 'sale_return', date, refType: 'return', refId: n.id, refNo: n.no, note: 'مرتجع ' + s.no }); touched.push(it.id); }
    }
    const out = Math.max(0, E.saleOutstanding(s)), arReduce = r2(Math.min(V, out)), refund = r2(V - arReduce);
    if (refund > 0 && !PAY_METHODS.includes(inp.refundMethod)) throw err('اختر طريقة رد المبلغ للعميل.', 'method_required');
    if (refund > 0) needCash(d, refund, 'رد المبلغ للعميل');
    s.returned = r2((s.returned || 0) + V); s.paid = r2(s.paid - refund);
    const jl = [{ acct: '4200', dr: V }, { acct: '1200', cr: arReduce, partyId: s.customerId || undefined }, { acct: '1100', cr: refund }];
    if (restock && C > 0) jl.push({ acct: '1320', dr: C }, { acct: '5100', cr: C });
    post(d, ctx, { date, refType: 'return', refId: n.id, refNo: n.no, memo: `مرتجع مبيعات على ${s.no}`, lines: jl, saleId: s.id });
    const r = { id: n.id, no: n.no, saleId: s.id, saleNo: s.no, date, lines, total: V, refund, arReduce, restock, refundMethod: refund > 0 ? inp.refundMethod : '', note: text(inp.note, 300), createdAt: nowOf(ctx), createdBy: ctx.user || 'unknown' };
    d.returns.push(r); audit(d, ctx, 'create', 'return', r.id, `${r.no} على ${s.no} بقيمة ${V}`); return r;
  };
  OPS.cancelInvoice = (d, ctx, inp) => {
    const s = need(d, 'sales', inp.id, 'الفاتورة'); if (s.status === 'ملغي') throw err('الفاتورة ملغاة بالفعل.', 'bad_status');
    if ((s.returned || 0) > 0 || d.returns.some(r => r.saleId === s.id)) throw err('لا يمكن إلغاء فاتورة لها مرتجعات.', 'has_returns');
    const date = needDate(inp.date, ctx);
    let wh = find(d, 'warehouses', s.whId); if (!wh || wh.kind !== 'finished' || wh.active === false) wh = d.warehouses.find(w => w.kind === 'finished' && w.active !== false); if (!wh) throw err('لا يوجد مخزن منتجات تامة نشط لاستلام الكمية.', 'no_wh');
    let legacyValue = 0;
    for (const l of toList(s.lines)) {
      const it = needItem(d, l.itemId);
      const value = s.legacy ? r2(l.qty * avgCost(it)) : l.cost; legacyValue = r2(legacyValue + (s.legacy ? value : 0));
      moveIn(d, ctx, { item: it, wh, qty: r3(l.qty), value, type: 'sale_cancel', date, refType: 'invoice', refId: s.id, refNo: s.no, note: 'إلغاء ' + s.no });
    }
    if (s.legacy && legacyValue > 0) post(d, ctx, { date, refType: 'invoice-cancel', refId: s.id, refNo: s.no, memo: 'إرجاع مخزون فاتورة قديمة ملغاة', lines: [{ acct: '1320', dr: legacyValue }, { acct: '5300', cr: legacyValue }] });
    reverseJournal(d, ctx, j => j.saleId === s.id, 'إلغاء فاتورة ' + s.no, date);
    s.status = 'ملغي'; s.cancelledAt = nowOf(ctx); s.cancelledBy = ctx.user || 'unknown'; s.cancelReason = text(inp.reason, 200);
    audit(d, ctx, 'status', 'invoice', s.id, `${s.no} ← ملغي`); return s;
  };

  /* ---------- المحاسبة الأساسية ---------- */
  OPS.recordExpense = (d, ctx, inp) => {
    if (!EXPENSE_CATEGORIES.includes(inp.category)) throw err('اختر بند المصروف.'); if (!PAY_METHODS.includes(inp.method)) throw err('اختر طريقة الدفع.');
    const amount = moneyOf(inp.amount, 'المبلغ', { zero: false }); const date = needDate(inp.date, ctx); const n = nextNo(d, 'EXP');
    needCash(d, amount, 'دفع المصروف');
    const e = { id: n.id, no: n.no, date, category: inp.category, amount, method: inp.method, note: text(inp.note, 300), createdAt: nowOf(ctx), createdBy: ctx.user || 'unknown' };
    post(d, ctx, { date, refType: 'expense', refId: e.id, refNo: e.no, memo: `${e.category}: ${e.note}`, lines: [{ acct: '5200', dr: amount }, { acct: '1100', cr: amount }] });
    d.expenses.push(e); audit(d, ctx, 'create', 'expense', e.id, `${e.no} ${e.category} ${amount}`); return { ...e, cashAfter: E.cashBalance(d) };
  };
  OPS.cashEntry = (d, ctx, inp) => {
    if (!['capital_in', 'withdrawal'].includes(inp.kind)) throw err('نوع الحركة غير صالح.');
    const amount = moneyOf(inp.amount, 'المبلغ', { zero: false }); const date = needDate(inp.date, ctx); const n = nextNo(d, 'CSH');
    if (inp.kind === 'withdrawal' && amount > E.cashBalance(d) + 0.005) throw err(`رصيد الخزينة (${E.cashBalance(d)}) لا يكفي لسحب ${amount}.`, 'insufficient_cash');
    const e = { id: n.id, no: n.no, date, kind: inp.kind, amount, note: text(inp.note, 300), createdAt: nowOf(ctx), createdBy: ctx.user || 'unknown' };
    post(d, ctx, { date, refType: 'cash', refId: e.id, refNo: e.no, memo: inp.kind === 'capital_in' ? 'إيداع رأس مال / رصيد افتتاحي نقدي' : 'مسحوبات', lines: inp.kind === 'capital_in' ? [{ acct: '1100', dr: amount }, { acct: '3100', cr: amount }] : [{ acct: '3100', dr: amount }, { acct: '1100', cr: amount }] });
    d.cashEntries.push(e); audit(d, ctx, 'create', 'cash', e.id, `${e.no} ${inp.kind} ${amount}`); return e;
  };

  Object.assign(E, { requirement, checkAvailability });
  return E;
});
