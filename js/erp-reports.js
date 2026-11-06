/* نبض ERP — مولّدات التقارير (دوال نقية) + لوحة المؤشرات. كل تقرير: { id, title, subtitle, sections:[{title, columns, rows, totals, note}] } */
(function (root, f) { if (typeof module === 'object') module.exports = f(require('./erp-ops2.js'), require('./calc.js')); else root.Reports = f(root.Engine, root.Calc); })(this, function (E, Calc) {
  'use strict';
  const { r2, r3, toList, ACCOUNTS } = E;
  const MOVE = { opening: 'رصيد افتتاحي', receipt: 'سند استلام', issue: 'سند صرف', transfer_in: 'تحويل (وارد)', transfer_out: 'تحويل (صادر)', adjustment: 'تسوية جرد', purchase_receipt: 'استلام مشتريات',
    production_consume: 'استهلاك إنتاج', production_output: 'ناتج إنتاج', sale: 'بيع', sale_return: 'مرتجع مبيعات', sale_cancel: 'إلغاء بيع' };
  const dOf = s => String(s || '').slice(0, 10);
  const inR = (date, f) => { const x = dOf(date); return (!f || !f.from || x >= f.from) && (!f || !f.to || x <= f.to); };
  const name = (d, k, id) => (d[k].find(x => x.id === id) || {}).name || '—';
  const col = (k, l, t = 'text') => ({ k, l, t });
  const sum = (rows, k) => r2(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0));
  const rng = f => (f && (f.from || f.to)) ? `الفترة: ${f.from || 'البداية'} — ${f.to || 'اليوم'}` : 'كل الفترات';

  /* ---- المخزون (مركز الأرصدة عند تاريخ معيّن) ---- */
  function stockRows(d, f) {
    const asOf = f && f.to; const m = {};
    for (const e of d.ledger) { if (asOf && dOf(e.date) > asOf) continue; const k = e.itemId + '|' + e.whId; const o = m[k] || (m[k] = { q: 0, v: 0 }); o.q = r3(o.q + e.qtyIn - e.qtyOut); o.v = r2(o.v + (e.qtyIn ? e.value : -e.value)); }
    const rows = [];
    for (const it of d.items) for (const w of d.warehouses) {
      if (f && f.whId && f.whId !== w.id) continue; if (f && f.type && f.type !== it.type) continue;
      const o = m[it.id + '|' + w.id]; if (!o || (Math.abs(o.q) < 1e-9 && !(f && f.zero))) continue;
      rows.push({ code: it.code, name: it.name, type: E.ITEM_TYPES[it.type], unit: it.unit || '', wh: w.name, qty: o.q, min: it.min === '' ? '' : Number(it.min) || 0, avg: o.q > 0 ? r2(o.v / o.q) : 0, value: Math.max(0, o.v), status: (!asOf && Number(it.min) > 0 && (Number(it.qty) || 0) <= Number(it.min)) ? 'تحت الحد الأدنى' : 'سليم' });
    }
    return rows;
  }
  function inventory(d, f = {}) {
    const rows = stockRows(d, f); const low = E.lowStock(d);
    const secs = [{ title: 'أرصدة المخزون' + (f.to ? ` حتى ${f.to}` : ' الحالية'), columns: [col('code', 'الكود'), col('name', 'الصنف'), col('type', 'النوع'), col('wh', 'المخزن'), col('qty', 'الكمية', 'num'), col('unit', 'الوحدة'), col('min', 'الحد الأدنى', 'num'), col('avg', 'متوسط التكلفة', 'money'), col('value', 'القيمة', 'money'), col('status', 'الحالة')], rows, totals: { name: 'الإجمالي', value: sum(rows, 'value') } }];
    if (!f.to) secs.push({ title: 'تنبيهات الحد الأدنى', columns: [col('code', 'الكود'), col('name', 'الصنف'), col('qty', 'الكمية الكلية', 'num'), col('min', 'الحد الأدنى', 'num'), col('need', 'العجز عن الحد', 'num')], rows: low.map(i => ({ code: i.code, name: i.name, qty: i.qty, min: Number(i.min), need: Math.max(0, r3(Number(i.min) - i.qty)) })), note: low.length ? '' : 'لا توجد أصناف تحت الحد الأدنى.' });
    return { id: 'inventory', title: 'تقرير المخزون', subtitle: f.to ? `الأرصدة حتى ${f.to}` : 'الأرصدة الحالية', sections: secs };
  }
  function movements(d, f = {}) {
    const rows = d.ledger.filter(e => inR(e.date, f) && (!f.itemId || e.itemId === f.itemId) && (!f.whId || e.whId === f.whId) && (!f.type || e.type === f.type)).sort((a, b) => a.seq - b.seq)
      .map(e => ({ date: dOf(e.date), ref: e.refNo || '', type: MOVE[e.type] || e.type, item: name(d, 'items', e.itemId), wh: name(d, 'warehouses', e.whId), qin: e.qtyIn || 0, qout: e.qtyOut || 0, bal: e.balanceAfter, cost: e.unitCost, value: e.value, user: e.user || '', note: e.note || '' }));
    return { id: 'movements', title: 'دفتر حركة المخزون', subtitle: rng(f), sections: [{ title: 'الحركات', columns: [col('date', 'التاريخ', 'date'), col('ref', 'المرجع'), col('type', 'نوع الحركة'), col('item', 'الصنف'), col('wh', 'المخزن'), col('qin', 'وارد', 'num'), col('qout', 'صادر', 'num'), col('bal', 'الرصيد بعد الحركة', 'num'), col('cost', 'تكلفة الوحدة', 'money'), col('value', 'القيمة', 'money'), col('user', 'المستخدم'), col('note', 'ملاحظة')], rows, totals: { item: 'الإجمالي', qin: r3(rows.reduce((s, r) => s + r.qin, 0)), qout: r3(rows.reduce((s, r) => s + r.qout, 0)) } }] };
  }
  /* ---- الإنتاج ---- */
  function production(d, f = {}) {
    const list = d.productions.filter(p => inR(p.date, f) && (!f.status || p.status === f.status));
    const rows = list.map(p => ({ date: p.date, no: p.no, product: name(d, 'items', p.productId), planned: p.plannedQty, produced: p.producedQty ?? '', yieldPct: p.yieldPct ?? '', mat: p.materialCost ?? '', other: p.otherCost ?? '', total: p.totalCost ?? '', unit: p.unitCost ?? '', wasteQty: p.wasteQty ?? '', wasteVal: p.wasteValue ?? '', status: p.status }));
    const done = list.filter(p => p.status === 'مكتمل'); const vm = {};
    for (const p of done) for (const c of toList(p.consumption)) { const o = vm[c.itemId] || (vm[c.itemId] = { req: 0, act: 0, waste: 0, cost: 0 }); o.req = r3(o.req + c.required); o.act = r3(o.act + c.actualQty); o.waste = r3(o.waste + c.wasteQty); o.cost = r2(o.cost + c.cost); }
    const vrows = Object.entries(vm).map(([id, o]) => ({ item: name(d, 'items', id), req: o.req, act: o.act, var: r3(o.act - o.req), waste: o.waste, wastePct: o.act ? Math.round(o.waste / o.act * 1000) / 10 : 0, cost: o.cost }));
    return { id: 'production', title: 'تقرير الإنتاج', subtitle: rng(f), sections: [
      { title: 'أوامر الإنتاج', columns: [col('date', 'التاريخ', 'date'), col('no', 'الأمر'), col('product', 'المنتج'), col('planned', 'المخطط', 'num'), col('produced', 'المنتج فعليًا', 'num'), col('yieldPct', 'نسبة التحقق %', 'num'), col('mat', 'تكلفة المواد', 'money'), col('other', 'تكاليف أخرى', 'money'), col('total', 'إجمالي التكلفة', 'money'), col('unit', 'تكلفة الوحدة', 'money'), col('wasteQty', 'كمية الهالك', 'num'), col('wasteVal', 'قيمة الهالك', 'money'), col('status', 'الحالة')], rows, totals: { product: 'الإجمالي', mat: sum(rows, 'mat'), other: sum(rows, 'other'), total: sum(rows, 'total'), wasteVal: sum(rows, 'wasteVal') } },
      { title: 'انحراف الاستهلاك والهالك (الأوامر المكتملة)', columns: [col('item', 'المادة'), col('req', 'المعياري', 'num'), col('act', 'الفعلي', 'num'), col('var', 'الانحراف', 'num'), col('waste', 'الهالك', 'num'), col('wastePct', 'الهالك %', 'num'), col('cost', 'التكلفة', 'money')], rows: vrows }] };
  }
  /* ---- المبيعات ---- */
  const ps = s => s.status === 'ملغي' ? 'ملغاة' : (E.saleOutstanding(s) <= 0.005 ? 'مسددة' : (s.paid > 0 ? 'مسددة جزئيًا' : 'غير مسددة'));
  function sales(d, f = {}) {
    const all = d.sales.filter(s => inR(s.date, f) && (!f.customerId || s.customerId === f.customerId)); const act = all.filter(s => s.status !== 'ملغي');
    const rows = all.map(s => ({ date: dOf(s.date), no: s.no || s.id, customer: s.customerName || s.customer || '—', total: s.total, disc: s.discount || 0, ret: s.returned || 0, paid: s.paid || 0, due: s.status === 'ملغي' ? 0 : E.saleOutstanding(s), cogs: s.legacy ? '' : (s.cogs || 0), profit: s.legacy ? '' : r2((s.total || 0) - (s.returned || 0) - (s.cogs || 0) + sum(toList(s.lines).map(l => ({ v: l.returnedCost || 0 })), 'v')), status: ps(s) }));
    const live = rows.filter((r, i) => all[i].status !== 'ملغي'); const byItem = {}, byCust = {};
    for (const s of act) { for (const l of toList(s.lines)) { const o = byItem[l.itemId] || (byItem[l.itemId] = { q: 0, rq: 0, v: 0 }); o.q = r3(o.q + l.qty); o.rq = r3(o.rq + (l.returnedQty || 0)); o.v = r2(o.v + l.net - (l.returnedValue || 0)); }
      const k = s.customerName || s.customer || 'عميل عابر'; const o = byCust[k] || (byCust[k] = { n: 0, v: 0, due: 0 }); o.n++; o.v = r2(o.v + s.total - (s.returned || 0)); o.due = r2(o.due + E.saleOutstanding(s)); }
    const retRows = d.returns.filter(r => inR(r.date, f)).map(r => ({ date: r.date, no: r.no, sale: r.saleNo, total: r.total, refund: r.refund, restock: r.restock ? 'نعم' : 'لا (هالك)' }));
    return { id: 'sales', title: 'تقرير المبيعات', subtitle: rng(f), sections: [
      { title: 'الفواتير', columns: [col('date', 'التاريخ', 'date'), col('no', 'الفاتورة'), col('customer', 'العميل'), col('total', 'الإجمالي', 'money'), col('disc', 'الخصم', 'money'), col('ret', 'المرتجع', 'money'), col('paid', 'المدفوع', 'money'), col('due', 'المتبقي', 'money'), col('cogs', 'التكلفة', 'money'), col('profit', 'الربح الإجمالي', 'money'), col('status', 'الحالة')], rows, totals: { customer: 'الإجمالي (دون الملغاة)', total: sum(live, 'total'), ret: sum(live, 'ret'), paid: sum(live, 'paid'), due: sum(live, 'due'), profit: sum(live, 'profit') }, note: 'الفواتير القديمة (قبل الترحيل) بلا تكلفة ولا ربح محسوب.' },
      { title: 'المبيعات حسب الصنف', columns: [col('item', 'الصنف'), col('qty', 'الكمية المباعة', 'num'), col('rq', 'المرتجع', 'num'), col('val', 'صافي القيمة', 'money')], rows: Object.entries(byItem).map(([id, o]) => ({ item: name(d, 'items', id), qty: o.q, rq: o.rq, val: o.v })) },
      { title: 'المبيعات حسب العميل', columns: [col('c', 'العميل'), col('n', 'عدد الفواتير', 'num'), col('v', 'صافي المبيعات', 'money'), col('due', 'المتبقي', 'money')], rows: Object.entries(byCust).map(([c, o]) => ({ c, n: o.n, v: o.v, due: o.due })) },
      { title: 'المرتجعات', columns: [col('date', 'التاريخ', 'date'), col('no', 'المرتجع'), col('sale', 'الفاتورة'), col('total', 'القيمة', 'money'), col('refund', 'المردود نقدًا', 'money'), col('restock', 'أُعيد للمخزون')], rows: retRows, totals: { sale: 'الإجمالي', total: sum(retRows, 'total'), refund: sum(retRows, 'refund') } }] };
  }
  /* ---- المشتريات ---- */
  function purchasing(d, f = {}) {
    const pos = d.orders.filter(o => inR(o.date, f) && (!f.supplierId || o.supplierId === f.supplierId));
    const rows = pos.map(o => { const ls = toList(o.lines), ordered = r3(ls.reduce((s, l) => s + l.qty, 0)), got = r3(ls.reduce((s, l) => s + (l.receivedQty || 0), 0)); return { date: o.date, no: o.no || o.id, sup: name(d, 'suppliers', o.supplierId), items: ls.map(l => name(d, 'items', l.itemId)).join('، '), total: r2(ls.reduce((s, l) => s + l.qty * l.price, 0)), ordered, got, status: o.status }; });
    const rc = d.receipts.filter(r => inR(r.date, f) && (!f.supplierId || r.supplierId === f.supplierId)).map(r => ({ date: r.date, no: r.no, po: r.poNo, sup: name(d, 'suppliers', r.supplierId), wh: name(d, 'warehouses', r.whId), total: r.total }));
    const ap = d.suppliers.map(s => { const rec = r2(d.receipts.filter(r => r.supplierId === s.id).reduce((a, r) => a + r.total, 0)), paid = r2(d.payments.filter(p => p.supplierId === s.id).reduce((a, p) => a + p.amount, 0)); return { sup: s.name, rec, paid, due: E.apBalance(d, s.id) }; }).filter(r => r.rec || r.paid);
    const pay = d.payments.filter(p => inR(p.date, f) && (!f.supplierId || p.supplierId === f.supplierId)).map(p => ({ date: p.date, no: p.no, sup: name(d, 'suppliers', p.supplierId), method: p.method, amount: p.amount }));
    return { id: 'purchasing', title: 'تقرير المشتريات', subtitle: rng(f), sections: [
      { title: 'أوامر الشراء', columns: [col('date', 'التاريخ', 'date'), col('no', 'الأمر'), col('sup', 'المورد'), col('items', 'الأصناف'), col('ordered', 'المطلوب', 'num'), col('got', 'المستلم', 'num'), col('total', 'القيمة', 'money'), col('status', 'الحالة')], rows, totals: { sup: 'الإجمالي', total: sum(rows, 'total') } },
      { title: 'استلامات البضاعة', columns: [col('date', 'التاريخ', 'date'), col('no', 'الاستلام'), col('po', 'أمر الشراء'), col('sup', 'المورد'), col('wh', 'المخزن'), col('total', 'القيمة', 'money')], rows: rc, totals: { sup: 'الإجمالي', total: sum(rc, 'total') } },
      { title: 'مدفوعات الموردين', columns: [col('date', 'التاريخ', 'date'), col('no', 'السند'), col('sup', 'المورد'), col('method', 'الطريقة'), col('amount', 'المبلغ', 'money')], rows: pay, totals: { sup: 'الإجمالي', amount: sum(pay, 'amount') } },
      { title: 'أرصدة الموردين (الذمم الدائنة)', columns: [col('sup', 'المورد'), col('rec', 'إجمالي المستلم', 'money'), col('paid', 'إجمالي المسدد', 'money'), col('due', 'المستحق', 'money')], rows: ap, totals: { sup: 'الإجمالي', due: sum(ap, 'due') } }] };
  }
  /* ---- المالية ---- */
  function glUpTo(d, to) { const b = {}; for (const j of d.journal) { if (to && dOf(j.date) > to) continue; for (const l of j.lines) b[l.acct] = r2((b[l.acct] || 0) + l.dr - l.cr); } return b; }
  function glRange(d, f) { const b = {}; for (const j of d.journal) { if (!inR(j.date, f)) continue; for (const l of j.lines) b[l.acct] = r2((b[l.acct] || 0) + l.dr - l.cr); } return b; }
  function pnl(d, f = {}) {
    const g = glRange(d, f), v = a => g[a] || 0;
    const rev = r2(-v('4100')), ret = r2(v('4200')), net = r2(rev - ret), cogs = v('5100'), gp = r2(net - cogs), opx = v('5200'), adj = v('5300'), np = r2(gp - opx - adj);
    return { revenue: rev, returns: ret, netRevenue: net, cogs, grossProfit: gp, opex: opx, adjustments: adj, netProfit: np };
  }
  function finance(d, f = {}) {
    const p = pnl(d, f); const L = (k, a, b) => ({ item: k, amount: a, note: b || '' });
    const pl = [L('إيرادات المبيعات', p.revenue), L('(−) مردودات المبيعات', p.returns), L('صافي الإيرادات', p.netRevenue), L('(−) تكلفة البضاعة المباعة', p.cogs), L('مجمل الربح', p.grossProfit), L('(−) المصروفات التشغيلية', p.opex), L('(−/+) فروقات وتسويات المخزون', p.adjustments), L('صافي الربح / الخسارة', p.netProfit)];
    const g = glUpTo(d, f.to), v = a => g[a] || 0; const income = glUpTo(d, f.to); const retained = r2(-(['4100', '4200', '5100', '5200', '5300'].reduce((s, a) => s + (income[a] || 0), 0)));
    const assets = r2(v('1100') + v('1200') + v('1310') + v('1320')), liab = r2(-v('2100')), eq = r2(-v('3100')), tot = r2(liab + eq + retained);
    const bs = [L('النقدية', v('1100')), L('العملاء', v('1200')), L('مخزون المواد الخام', v('1310')), L('مخزون المنتجات التامة', v('1320')), L('إجمالي الأصول', assets), L('الموردون', liab), L('رأس المال والأرصدة الافتتاحية', eq), L('الأرباح المرحّلة (حتى التاريخ)', retained), L('إجمالي الخصوم وحقوق الملكية', tot, Math.abs(assets - tot) < 0.02 ? 'الميزانية متوازنة' : 'غير متوازنة — راجع القيود')];
    // دفتر الخزينة
    let run = r2(d.journal.filter(j => f.from && dOf(j.date) < f.from).reduce((s, j) => s + j.lines.filter(l => l.acct === '1100').reduce((a, l) => a + l.dr - l.cr, 0), 0)); const open = run;
    const cash = []; for (const j of d.journal.filter(j => inR(j.date, f)).sort((a, b) => a.date.localeCompare(b.date) || a.ts.localeCompare(b.ts))) for (const l of j.lines) if (l.acct === '1100') { run = r2(run + l.dr - l.cr); cash.push({ date: j.date, no: j.ref.no || j.no, memo: j.memo, inn: l.dr, out: l.cr, bal: run }); }
    const ar = d.customers.map(c => ({ c: c.name, due: E.arBalance(d, c.id), limit: c.creditLimit || 0 })).filter(r => r.due);
    const ap = d.suppliers.map(s => ({ c: s.name, due: E.apBalance(d, s.id) })).filter(r => r.due);
    const tb = Object.keys(ACCOUNTS).map(a => { const x = g[a] || 0; return { acct: a, name: ACCOUNTS[a].n, dr: x > 0 ? x : 0, cr: x < 0 ? -x : 0 }; }).filter(r => r.dr || r.cr);
    return { id: 'finance', title: 'التقارير المالية', subtitle: rng(f) + ' (الميزانية وميزان المراجعة تراكميان حتى تاريخ النهاية)', sections: [
      { title: 'قائمة الدخل', columns: [col('item', 'البند'), col('amount', 'المبلغ', 'money')], rows: pl },
      { title: 'المركز المالي', columns: [col('item', 'البند'), col('amount', 'المبلغ', 'money'), col('note', 'ملاحظة')], rows: bs },
      { title: 'دفتر الخزينة', columns: [col('date', 'التاريخ', 'date'), col('no', 'المرجع'), col('memo', 'البيان'), col('inn', 'داخل', 'money'), col('out', 'خارج', 'money'), col('bal', 'الرصيد', 'money')], rows: cash, note: `رصيد أول الفترة: ${open}` },
      { title: 'أرصدة العملاء (ذمم مدينة)', columns: [col('c', 'العميل'), col('due', 'المستحق', 'money'), col('limit', 'حد الائتمان', 'money')], rows: ar, totals: { c: 'الإجمالي', due: sum(ar, 'due') } },
      { title: 'أرصدة الموردين (ذمم دائنة)', columns: [col('c', 'المورد'), col('due', 'المستحق', 'money')], rows: ap, totals: { c: 'الإجمالي', due: sum(ap, 'due') } },
      { title: 'ميزان المراجعة', columns: [col('acct', 'الحساب'), col('name', 'الاسم'), col('dr', 'مدين', 'money'), col('cr', 'دائن', 'money')], rows: tb, totals: { name: 'الإجمالي', dr: sum(tb, 'dr'), cr: sum(tb, 'cr') } }], pnl: p };
  }
  /* ---- مخاطر الذكاء الاصطناعي / سلسلة الإمداد ---- */
  function consumptionRate(d, itemId, days = 30, today) {
    const end = today || new Date().toISOString().slice(0, 10); const t = new Date(end + 'T00:00:00Z').getTime(); const from = new Date(t - (days - 1) * 86400000).toISOString().slice(0, 10);
    const out = d.ledger.filter(e => e.itemId === itemId && ['production_consume', 'sale', 'issue'].includes(e.type) && dOf(e.date) >= from && dOf(e.date) <= end).reduce((s, e) => s + e.qtyOut, 0);
    return { perDay: r3(out / days), total: r3(out), days };
  }
  function openDemand(d) { // احتياج المواد لأوامر الإنتاج المفتوحة مقابل رصيد مخزن المواد
    const need = {}; for (const p of d.productions.filter(p => ['مسودة', 'قيد التنفيذ'].includes(p.status))) for (const r of toList(p.requirement)) { const o = need[r.itemId + '|' + p.rawWhId] || (need[r.itemId + '|' + p.rawWhId] = { itemId: r.itemId, whId: p.rawWhId, required: 0 }); o.required = r3(o.required + r.required); }
    return Object.values(need).map(o => ({ ...o, available: E.stockOf(d, o.itemId, o.whId), shortage: Math.max(0, r3(o.required - E.stockOf(d, o.itemId, o.whId))) }));
  }
  function aiRisk(d, f = {}) {
    const today = f.to || new Date().toISOString().slice(0, 10); const safety = Number(d.settings.safety) || 3;
    const openQty = id => r3(d.orders.filter(o => E.PO_OPEN.includes(o.status)).reduce((s, o) => s + toList(o.lines).filter(l => l.itemId === id).reduce((a, l) => a + l.qty - (l.receivedQty || 0), 0), 0));
    const rows = d.items.filter(i => i.type === 'raw' && i.active !== false).map(i => {
      const st = (() => { try { return Calc.status(i); } catch { return { k: 'nodata', t: 'بيانات ناقصة', c: null }; } })(); const gap = (() => { try { return Calc.gapDays(i); } catch { return null; } })();
      const cr = consumptionRate(d, i.id, 30, today); const risk = st.k === 'nodata' ? 'بيانات ناقصة' : (gap > 0 ? 'مرتفع' : (st.c < Calc.arrival(i) + safety ? 'متوسط' : 'منخفض'));
      return { code: i.code, name: i.name, qty: i.qty, cover: st.c == null ? '' : Math.round(st.c * 10) / 10, arrival: Calc.arrival(i), gap: gap == null ? '' : Math.round(gap * 10) / 10, risk, daily: i.daily === '' ? '' : Number(i.daily), actual: cr.perDay, open: openQty(i.id), status: st.t };
    });
    const dem = openDemand(d).filter(x => x.shortage > 0).map(x => ({ item: name(d, 'items', x.itemId), wh: name(d, 'warehouses', x.whId), required: x.required, available: x.available, shortage: x.shortage }));
    const dec = d.aiDecisions.filter(a => inR(a.ts, f)).map(a => ({ date: dOf(a.ts), item: name(d, 'items', a.itemId), risk: a.riskLevel, decision: a.decision === 'accepted' ? 'اعتُمدت' : 'رُفضت', by: a.user, summary: a.summary }));
    return { id: 'ai', title: 'تقرير مخاطر سلسلة الإمداد', subtitle: 'الحسابات رياضية بحتة؛ توصيات الذكاء الاصطناعي استرشادية والقرار للإنسان', sections: [
      { title: 'مخاطر المواد الخام', columns: [col('code', 'الكود'), col('name', 'المادة'), col('qty', 'الرصيد', 'num'), col('cover', 'أيام التغطية', 'num'), col('arrival', 'وصول الشحنة (يوم)', 'num'), col('gap', 'فجوة التوريد (يوم)', 'num'), col('risk', 'مستوى الخطر'), col('daily', 'الاستهلاك اليومي المُدخل', 'num'), col('actual', 'الاستهلاك الفعلي (30 يوم)', 'num'), col('open', 'مطلوب بأوامر شراء مفتوحة', 'num')], rows },
      { title: 'عجز المواد لأوامر الإنتاج المفتوحة', columns: [col('item', 'المادة'), col('wh', 'المخزن'), col('required', 'المطلوب', 'num'), col('available', 'المتاح', 'num'), col('shortage', 'العجز', 'num')], rows: dem, note: dem.length ? '' : 'لا عجز في المواد لأوامر الإنتاج المفتوحة.' },
      { title: 'سجل قرارات التوصيات (اعتماد/رفض بشري)', columns: [col('date', 'التاريخ', 'date'), col('item', 'الصنف'), col('risk', 'الخطر'), col('decision', 'القرار'), col('by', 'بواسطة'), col('summary', 'الملخص')], rows: dec }] };
  }
  function auditReport(d, f = {}) {
    // الأحدث أولًا؛ عند تساوي الوقت يُفصل بترتيب التسجيل
    const rows = d.audit.map((a, i) => ({ a, i })).filter(({ a }) => inR(a.ts, f) && (!f.entity || a.entity === f.entity)).sort((x, y) => String(y.a.ts).localeCompare(String(x.a.ts)) || y.i - x.i).map(({ a }) => ({ ts: String(a.ts).replace('T', ' ').slice(0, 19), user: a.user, action: a.action, entity: a.entity, ref: a.entityId, summary: a.summary }));
    return { id: 'audit', title: 'سجل المراجعة', subtitle: rng(f), sections: [{ title: 'العمليات', columns: [col('ts', 'الوقت'), col('user', 'المستخدم'), col('action', 'العملية'), col('entity', 'الكيان'), col('ref', 'المعرّف'), col('summary', 'التفاصيل')], rows }] };
  }
  /* ---- لوحة المؤشرات التنفيذية ---- */
  function dashboard(d, today) {
    const mFrom = today.slice(0, 7) + '-01'; const m = { from: mFrom, to: today }; const p = pnl(d, m); const bal = E.balances(d);
    const sToday = d.sales.filter(s => s.status !== 'ملغي' && dOf(s.date) === today); const sMonth = d.sales.filter(s => s.status !== 'ملغي' && inR(s.date, m));
    const prods = d.productions;
    const series = []; for (let i = 6; i >= 0; i--) { const dt = new Date(new Date(today + 'T00:00:00Z').getTime() - i * 86400000).toISOString().slice(0, 10); series.push({ date: dt, v: r2(d.sales.filter(s => s.status !== 'ملغي' && dOf(s.date) === dt).reduce((a, s) => a + s.total - (s.returned || 0), 0)) }); }
    return { salesToday: r2(sToday.reduce((s, x) => s + x.total, 0)), salesMonth: r2(sMonth.reduce((s, x) => s + x.total - (x.returned || 0), 0)), invoicesMonth: sMonth.length,
      inventoryRaw: bal['1310'] || 0, inventoryFinished: bal['1320'] || 0, cash: bal['1100'] || 0, receivables: bal['1200'] || 0, payables: r2(-(bal['2100'] || 0)),
      netProfitMonth: p.netProfit, grossProfitMonth: p.grossProfit, lowStock: E.lowStock(d).length, openPOs: d.orders.filter(o => !['مستلم', 'ملغي'].includes(o.status)).length,
      prodInProgress: prods.filter(x => x.status === 'قيد التنفيذ').length, prodDraft: prods.filter(x => x.status === 'مسودة').length, prodDoneMonth: prods.filter(x => x.status === 'مكتمل' && inR(x.completedAt, m)).length,
      shortages: openDemand(d).filter(x => x.shortage > 0).length, series };
  }
  const REPORTS = { inventory, movements, production, sales, purchasing, finance, ai: aiRisk, audit: auditReport };
  // يحوّل قسمًا إلى مصفوفة ثنائية للتصدير (CSV / Excel)
  function toMatrix(sec) {
    const head = sec.columns.map(c => c.l); const body = sec.rows.map(r => sec.columns.map(c => r[c.k] ?? ''));
    if (sec.totals) body.push(sec.columns.map(c => sec.totals[c.k] ?? ''));
    return [head, ...body];
  }
  return { MOVE, inventory, movements, production, sales, purchasing, finance, pnl, aiRisk, auditReport, dashboard, consumptionRate, openDemand, stockRows, REPORTS, toMatrix, inR };
});
