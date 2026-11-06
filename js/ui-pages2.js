/* نبض ERP — صفحات الواجهة (2): المخازن والمخزون، سندات المخازن، الإنتاج، المحاسبة */
const ITYPE = E_.ITEM_TYPES, WKIND = E_.WH_KINDS;
const itemRefd = it => Math.abs(Number(it.qty) || 0) > 0 || E_.isItemReferenced(DB, it.id);
const stockStatus = i => { const q = Number(i.qty) || 0, m = Number(i.min) || 0; return m > 0 && q <= m ? ['تحت الحد الأدنى', 'low'] : ['سليم', 'ok']; };

/* ========== المخازن والمخزون ========== */
const INV_TABS = { stock: 'الأرصدة والأصناف', vouchers: 'السندات', ledger: 'دفتر الحركة', warehouses: 'المخازن' };
function pageInventory(tab) {
  tab = INV_TABS[tab] ? tab : 'stock';
  return `<h2>المخازن والمخزون</h2>${TABS('inventory', INV_TABS, tab)}` + ({ stock: invStock, vouchers: invVouchers, ledger: invLedger, warehouses: invWarehouses })[tab]();
}
function invStock() {
  const low = E_.lowStock(DB), bal = E_.balances(DB);
  let rows = DB.items.filter(i => matches('itm', { c: i.code, n: i.name }) && (!UI.f.itype || i.type === UI.f.itype) && (!UI.f.ist || (UI.f.ist === 'low' ? stockStatus(i)[1] === 'low' : stockStatus(i)[1] === 'ok')) && (!UI.f.iwh || (DB.stock[i.id] || {})[UI.f.iwh] > 0));
  const per = i => DB.warehouses.filter(w => ((DB.stock[i.id] || {})[w.id] || 0) > 0).map(w => `${esc(w.name)}: ${qfmt(DB.stock[i.id][w.id])}`).join('<br>') || '—';
  return `<div class="grid">${KPI(DB.items.length, 'صنف')}${KPI(money(bal['1310'] || 0), 'قيمة المواد الخام (ج)')}${KPI(money(bal['1320'] || 0), 'قيمة المنتجات التامة (ج)')}${KPI(low.length, 'تحت الحد الأدنى', low.length ? 'amb' : '')}</div>
  ${low.length ? `<div class="note"><b>تنبيه الحد الأدنى:</b> ${low.map(i => `${esc(i.name)} (${qfmt(i.qty)} ≤ ${qfmt(i.min)})`).join('، ')}</div>` : ''}
  <div class="tools">${SEARCH('itm', 'بحث بالكود أو الاسم')}${FSEL('itype', Object.entries(ITYPE), 'كل الأنواع')}${FSEL('iwh', DB.warehouses.map(w => [w.id, w.name]), 'كل المخازن')}${FSEL('ist', [['low', 'تحت الحد الأدنى'], ['ok', 'سليم']], 'كل الحالات')}<button data-act="new-item">+ صنف جديد</button></div>
  ${TBL(['الكود', 'الصنف', 'النوع', 'الأرصدة بالمخازن', 'الإجمالي', 'الحد الأدنى', 'متوسط التكلفة', 'القيمة', 'تغطية (يوم)', 'الحالة', ''], rows.map(i => { const s = stockStatus(i), cv = i.type === 'raw' ? K.cover(i.qty, i.daily) : null; return ROW([esc(i.code), esc(i.name) + (i.active === false ? ' ' + chip('معطّل', 'nodata') : ''), esc(ITYPE[i.type] || '—'), per(i), qfmt(i.qty) + ' ' + esc(i.unit || ''), i.min === '' ? '—' : qfmt(i.min), money(E_.avgCost(i)), money(i.stockValue), cv == null ? '—' : fmt(cv), chip(s[0], s[1]), BTN('edit-item', i.id, 'تعديل') + BTN('del-item', i.id, 'حذف', 'del')]); }), 'لا توجد أصناف. أضف صنفًا ثم سجّل رصيدًا افتتاحيًا أو سند استلام.')}`;
}
function openItem(id) {
  const it = id ? DB.items.find(x => x.id === id) : { type: 'raw', active: true }; if (!it) return;
  const locked = id && itemRefd(it), whOpts = type => activeWhs(whKindOf(type)).map(w => [w.id, w.name]);
  const num = (n, l, extra = {}) => ({ n, l, t: 'number', val: it[n] ?? '', ...extra });
  const fields = [{ n: 'code', l: 'كود الصنف', req: true, val: it.code }, { n: 'name', l: 'اسم الصنف', req: true, val: it.name },
    { n: 'type', l: 'النوع', t: 'select', opts: Object.entries(ITYPE), val: it.type, disabled: locked, hint: locked ? 'مقفل: للصنف رصيد أو حركات.' : 'مادة خام/تعبئة تُخزَّن في مخزن المواد، والمنتج التام في مخزن المنتجات.' },
    { n: 'unit', l: 'وحدة القياس', val: it.unit || '' }, num('min', 'الحد الأدنى للتنبيه'), num('price', 'سعر/تكلفة الوحدة المرجعية (ج)'), num('salePrice', 'سعر البيع (للمنتج التام)'),
    num('daily', 'متوسط الاستهلاك اليومي (لتحليل المخاطر)'), num('lead', 'مدة التوريد (يوم)'), num('inbound', 'أيام حتى وصول الشحنة'), num('delay', 'تأخر الشحنة (يوم)'),
    { n: 'supplierId', l: 'المورد الحالي', t: 'select', opts: DB.suppliers.map(s => [s.id, s.name]), ph: '— بلا —', val: it.supplierId || '' }, { n: 'active', l: 'الصنف نشط', t: 'check', val: it.active !== false }];
  if (!id) fields.push({ n: 'openingQty', l: 'رصيد افتتاحي (اختياري)', t: 'number', val: '' }, { n: 'openingWhId', l: 'مخزن الرصيد الافتتاحي', t: 'select', opts: whOpts('raw'), val: '' }, { n: 'openingCost', l: 'تكلفة وحدة الرصيد الافتتاحي', t: 'number', val: '', hint: 'فارغ = السعر المرجعي' });
  openDoc({ title: id ? 'تعديل صنف' : 'صنف جديد', wide: true, fields, intro: id ? 'الكمية لا تُعدَّل مباشرة؛ استخدم سندات الاستلام والصرف والتسوية حتى تبقى الحركة موثّقة.' : '',
    onInput: (el, api) => { if (el.name === 'type' && !id) api.setOptions('openingWhId', whOpts(el.value), ''); },
    build: v => { const input = { ...v, id }; if (locked) delete input.type; if (id) { delete input.openingQty; delete input.openingWhId; delete input.openingCost; } else if (!v.openingQty) { delete input.openingQty; delete input.openingWhId; delete input.openingCost; } if (!input.openingWhId) delete input.openingWhId; return { op: 'upsertItem', input }; }, ok: () => 'تم حفظ الصنف' });
}
function invVouchers() {
  const vs = [...DB.vouchers].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.no).localeCompare(String(a.no)));
  const T = { receipt: 'استلام', issue: 'صرف', transfer: 'تحويل', adjustment: 'تسوية جرد' };
  return `<div class="tools"><button data-act="v-receipt">+ سند استلام</button><button data-act="v-issue" class="sec">+ سند صرف</button><button data-act="v-transfer" class="sec">+ سند تحويل</button><button data-act="v-adjust" class="sec">+ جرد وتسوية</button></div>
  ${TBL(['الرقم', 'النوع', 'التاريخ', 'المخزن', 'السبب', 'البنود', ''], vs.map(v => ROW([esc(v.no), esc(T[v.type] || v.type), esc(v.date), esc(nm('warehouses', v.whId)) + (v.toWhId ? ' ← ' + esc(nm('warehouses', v.toWhId)) : ''), esc(E_.RECEIPT_REASONS[v.reason] || E_.ISSUE_REASONS[v.reason] || v.reason || '—'), esc(E_.toList(v.lines).map(l => `${itemName(l.itemId)} × ${qfmt(l.qty ?? l.diff)}`).join('، ')), BTN('view-voucher', v.id, 'عرض')])), 'لا توجد سندات.')}`;
}
// يعيد بناء قائمة الأصناف في كل صف حسب نوع المخزن المختار
function refilterLines(api, whId, extra) {
  const w = DB.warehouses.find(x => x.id === whId), kind = w && w.kind;
  api.rows().forEach(tr => { const s = api.cell(tr, 'itemId'), cur = s.value; s.innerHTML = optionsHtml(pickItems(null, extra).filter(([id]) => !kind || whKindOf((DB.items.find(i => i.id === id) || {}).type) === kind), cur, 'اختر…'); });
}
function voucherDoc(kind) {
  const whs = activeWhs(); if (!whs.length) return toast('أنشئ مخزنًا أولًا.');
  const base = { n: 'date', l: 'التاريخ', t: 'date', val: localToday(), req: true }, note = { n: 'note', l: 'ملاحظات', t: 'textarea' };
  const avail = (api, tr, whId) => { const id = api.cell(tr, 'itemId').value; api.setInfo(tr, 'avail', id ? qfmt(E_.stockOf(DB, id, whId)) : ''); };
  const itemCol = { n: 'itemId', l: 'الصنف', t: 'select', opts: pickItems(), ph: 'اختر…' };
  if (kind === 'receipt') return openDoc({ title: 'سند استلام مخزني', wide: true, submit: 'حفظ السند', intro: 'يزيد الرصيد ويُسجَّل في دفتر الحركة. للمشتريات من الموردين استخدم «أمر شراء ← استلام» حتى تُسجَّل ذمة المورد.',
    fields: [{ n: 'whId', l: 'المخزن', t: 'select', opts: whs.map(w => [w.id, `${w.name} (${WKIND[w.kind]})`]), val: whs[0].id, req: true }, { n: 'reason', l: 'السبب', t: 'select', opts: Object.entries(E_.RECEIPT_REASONS), val: 'opening' }, base, note],
    lines: { keyCol: 'itemId', cols: [itemCol, { n: 'qty', l: 'الكمية' }, { n: 'unitCost', l: 'تكلفة الوحدة (فارغ = المتوسط)' }] },
    onInput: (el, api) => { if (el.name === 'whId') refilterLines(api, el.value); }, build: v => ({ op: 'receiptVoucher', input: { ...v, lines: v.lines } }), ok: r => `تم سند الاستلام ${r.no}` });
  if (kind === 'issue') return openDoc({ title: 'سند صرف مخزني', wide: true, submit: 'حفظ السند', intro: 'يُخصم الرصيد بمتوسط التكلفة. لا يُسمح بالصرف أكثر من المتاح.',
    fields: [{ n: 'whId', l: 'المخزن', t: 'select', opts: whs.map(w => [w.id, `${w.name} (${WKIND[w.kind]})`]), val: whs[0].id, req: true }, { n: 'reason', l: 'السبب', t: 'select', opts: Object.entries(E_.ISSUE_REASONS), val: 'internal' }, base, note],
    lines: { keyCol: 'itemId', cols: [itemCol, { n: 'avail', l: 'المتاح', t: 'info' }, { n: 'qty', l: 'الكمية' }] },
    onInput: (el, api) => { if (el.name === 'whId') { refilterLines(api, el.value); api.rows().forEach(tr => avail(api, tr, el.value)); } if (el.dataset.c === 'itemId') avail(api, el.closest('tr'), api.val('whId')); }, build: v => ({ op: 'issueVoucher', input: v }), ok: r => `تم سند الصرف ${r.no}` });
  if (kind === 'transfer') return openDoc({ title: 'سند تحويل بين مخازن', wide: true, submit: 'حفظ السند', intro: 'التحويل مسموح بين مخازن من نفس النوع فقط (خام ← خام، تام ← تام).',
    fields: [{ n: 'fromWhId', l: 'من مخزن', t: 'select', opts: whs.map(w => [w.id, `${w.name} (${WKIND[w.kind]})`]), val: whs[0].id, req: true }, { n: 'toWhId', l: 'إلى مخزن', t: 'select', opts: whs.map(w => [w.id, `${w.name} (${WKIND[w.kind]})`]), val: (whs[1] || whs[0]).id, req: true }, base, note],
    lines: { keyCol: 'itemId', cols: [itemCol, { n: 'avail', l: 'المتاح بالمصدر', t: 'info' }, { n: 'qty', l: 'الكمية' }] },
    onInput: (el, api) => { if (el.name === 'fromWhId') { refilterLines(api, el.value); api.rows().forEach(tr => avail(api, tr, el.value)); } if (el.dataset.c === 'itemId') avail(api, el.closest('tr'), api.val('fromWhId')); }, build: v => ({ op: 'transferVoucher', input: v }), ok: r => `تم سند التحويل ${r.no}` });
  return openDoc({ title: 'جرد وتسوية مخزنية', wide: true, submit: 'حفظ التسوية', intro: 'أدخل الكمية المجرودة فعليًا؛ يحسب النظام الفرق ويسجّله كحركة تسوية بقيد محاسبي. السبب إلزامي.',
    fields: [{ n: 'whId', l: 'المخزن', t: 'select', opts: whs.map(w => [w.id, `${w.name} (${WKIND[w.kind]})`]), val: whs[0].id, req: true }, { n: 'reason', l: 'سبب التسوية', req: true, ph: 'مثال: جرد دوري' }, base, note],
    lines: { keyCol: 'itemId', cols: [itemCol, { n: 'avail', l: 'رصيد النظام', t: 'info' }, { n: 'countedQty', l: 'الكمية المجرودة' }] },
    onInput: (el, api) => { if (el.name === 'whId') { refilterLines(api, el.value); api.rows().forEach(tr => avail(api, tr, el.value)); } if (el.dataset.c === 'itemId') avail(api, el.closest('tr'), api.val('whId')); }, build: v => ({ op: 'adjustmentVoucher', input: v }), ok: r => `تم سند التسوية ${r.no}` });
}
function viewVoucher(id) {
  const v = DB.vouchers.find(x => x.id === id); if (!v) return;
  const T = { receipt: 'سند استلام', issue: 'سند صرف', transfer: 'سند تحويل', adjustment: 'سند تسوية جرد' };
  const adj = v.type === 'adjustment';
  showDoc(`${T[v.type] || 'سند'} ${esc(v.no)}`, `<p>التاريخ: ${esc(v.date)} — المخزن: ${esc(nm('warehouses', v.whId))}${v.toWhId ? ' ← ' + esc(nm('warehouses', v.toWhId)) : ''} — بواسطة: ${esc(v.createdBy || '—')}</p><p>السبب: ${esc(E_.RECEIPT_REASONS[v.reason] || E_.ISSUE_REASONS[v.reason] || v.reason || '—')}</p>
  ${TBL(adj ? ['الصنف', 'رصيد النظام', 'المجرود', 'الفرق'] : ['الصنف', 'الكمية', 'تكلفة الوحدة', 'القيمة'], E_.toList(v.lines).map(l => ROW(adj ? [esc(itemName(l.itemId)), qfmt(l.systemQty), qfmt(l.countedQty), qfmt(l.diff)] : [esc(itemName(l.itemId)), qfmt(l.qty), money(l.unitCost), money(l.value)])))}${v.note ? `<p>ملاحظات: ${esc(v.note)}</p>` : ''}`);
}
function invLedger() {
  const f = { from: UI.f.lfrom || '', to: UI.f.lto || '', itemId: UI.f.litem || '', whId: UI.f.lwh || '', type: UI.f.ltype || '' };
  const rep = Reports.movements(DB, f), sec = rep.sections[0], n = sec.rows.length;
  return `<div class="tools"><label>من <input id="f_lfrom" data-f="lfrom" type="date" value="${esc(f.from)}"></label><label>إلى <input id="f_lto" data-f="lto" type="date" value="${esc(f.to)}"></label>${FSEL('litem', DB.items.map(i => [i.id, itemLabel(i)]), 'كل الأصناف')}${FSEL('lwh', DB.warehouses.map(w => [w.id, w.name]), 'كل المخازن')}${FSEL('ltype', Object.entries(Reports.MOVE), 'كل أنواع الحركة')}
  <button class="sec" data-act="export-xlsx:movements">Excel</button><button class="sec" data-act="print-report">طباعة / PDF</button></div>
  <div id="reportArea" class="printable"><h3>${esc(rep.title)} — ${esc(rep.subtitle)}</h3>${renderSection(sec, 500)}</div>${n ? '' : ''}`;
}
function invWarehouses() {
  const rows = DB.warehouses.map(w => { const sr = Reports.stockRows(DB, { whId: w.id }); return ROW([esc(w.code), esc(w.name), esc(WKIND[w.kind]), sr.length, money(sr.reduce((s, r) => s + r.value, 0)), chip(w.active === false ? 'معطّل' : 'نشط', w.active === false ? 'nodata' : 'ok'), BTN('edit-wh', w.id, 'تعديل') + BTN('del-wh', w.id, 'حذف', 'del')]); });
  return `<div class="tools"><button data-act="new-wh">+ مخزن جديد</button></div><p class="note">مخزن المواد الخام منفصل تمامًا عن مخزن المنتجات التامة: لا يقبل النظام تخزين صنف في مخزن من نوع مختلف.</p>${TBL(['الكود', 'المخزن', 'النوع', 'أصناف بها رصيد', 'القيمة', 'الحالة', ''], rows, 'لا توجد مخازن.')}`;
}
function openWarehouse(id) {
  const w = id ? DB.warehouses.find(x => x.id === id) : { active: true }, used = id && (DB.ledger.some(e => e.whId === id));
  openDoc({ title: id ? 'تعديل مخزن' : 'مخزن جديد', fields: [{ n: 'code', l: 'الكود', req: true, val: w.code }, { n: 'name', l: 'اسم المخزن', req: true, val: w.name }, { n: 'kind', l: 'النوع', t: 'select', opts: Object.entries(WKIND), val: w.kind || 'raw', disabled: used, hint: used ? 'مقفل: للمخزن حركات.' : '' }, { n: 'active', l: 'نشط', t: 'check', val: w.active !== false }],
    build: v => { const i = { id, ...v }; if (used) delete i.kind; return { op: 'upsertWarehouse', input: i }; }, ok: () => 'تم حفظ المخزن' });
}

/* ========== الإنتاج ========== */
const PRD_TABS = { orders: 'أوامر الإنتاج', boms: 'الوصفات (BOM)' };
const PRCHIP = { 'مسودة': '', 'قيد التنفيذ': 'low', 'مكتمل': 'ok', 'ملغي': 'crit' };
function pageProduction(tab) {
  tab = PRD_TABS[tab] ? tab : 'orders';
  return `<h2>الإنتاج</h2>${TABS('production', PRD_TABS, tab)}` + (tab === 'orders' ? prdOrders() : prdBoms());
}
function prdBoms() {
  return `<div class="tools"><button data-act="new-bom">+ وصفة جديدة</button></div>${TBL(['الوصفة', 'المنتج', 'كمية الدفعة', 'المكونات (لكل دفعة)', 'الحالة', ''], DB.boms.map(b => ROW([esc(b.name), esc(itemName(b.productId)), qfmt(b.outputQty), esc(E_.toList(b.lines).map(l => `${itemName(l.itemId)} ${qfmt(l.qty)}${l.wastePct ? ` (+${l.wastePct}% هالك)` : ''}`).join('، ')), chip(b.active === false ? 'معطّلة' : 'نشطة', b.active === false ? 'nodata' : 'ok'), BTN('edit-bom', b.id, 'تعديل') + BTN('new-production', b.id, 'أمر إنتاج') + BTN('del-bom', b.id, 'حذف', 'del')])), 'لا توجد وصفات. أنشئ وصفة لكل منتج تام.')}`;
}
function openBom(id) {
  if (!activeItems('finished').length || !activeItems('raw').length) return toast('أضف منتجًا تامًا ومواد خام أولًا من «المخازن».');
  const b = id ? DB.boms.find(x => x.id === id) : { active: true };
  openDoc({ title: id ? 'تعديل وصفة' : 'وصفة جديدة (BOM)', wide: true, intro: 'الوصفة تحدد المواد اللازمة لإنتاج كمية مرجعية من المنتج. نسبة الهالك المسموح تُضاف على المطلوب.',
    fields: [{ n: 'name', l: 'اسم الوصفة', val: b.name }, { n: 'productId', l: 'المنتج التام', t: 'select', opts: pickItems('finished'), val: b.productId || '', ph: 'اختر…', req: true }, { n: 'outputQty', l: 'الكمية المرجعية للإنتاج', t: 'number', val: b.outputQty || '', req: true, min: 0.001 }, { n: 'active', l: 'نشطة', t: 'check', val: b.active !== false }],
    lines: { keyCol: 'itemId', addLabel: 'إضافة مكوّن', rows: E_.toList(b.lines).map(l => ({ itemId: l.itemId, qty: l.qty, wastePct: l.wastePct || '' })), cols: [{ n: 'itemId', l: 'المادة الخام / التعبئة', t: 'select', opts: pickItems('raw'), ph: 'اختر…' }, { n: 'qty', l: 'الكمية لكل دفعة' }, { n: 'wastePct', l: 'هالك مسموح %' }] },
    build: v => ({ op: 'upsertBom', input: { id, name: v.name, productId: v.productId, outputQty: v.outputQty, active: v.active, lines: v.lines } }), ok: () => 'تم حفظ الوصفة' });
}
function prdOrders() {
  const rows = [...DB.productions].filter(p => matches('prd', p) && (!UI.f.prst || p.status === UI.f.prst)).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.no).localeCompare(String(a.no)));
  const act = p => BTN('view-prod', p.id, 'عرض') + (p.status === 'مسودة' ? BTN('start-prod', p.id, 'بدء التنفيذ') : '') + (['مسودة', 'قيد التنفيذ'].includes(p.status) ? BTN('complete-prod', p.id, 'إكمال') + BTN('cancel-prod', p.id, 'إلغاء', 'del') : '');
  return `<div class="tools">${SEARCH('prd')}${FSEL('prst', E_.PROD_STATUS.map(x => [x, x]), 'كل الحالات')}<button data-act="new-production">+ أمر إنتاج</button></div>
  ${TBL(['الأمر', 'التاريخ', 'المنتج', 'المخطط', 'المنتج فعليًا', 'التحقق', 'التكلفة الكلية', 'تكلفة الوحدة', 'الهالك', 'الحالة', ''], rows.map(p => ROW([esc(p.no), esc(p.date), esc(itemName(p.productId)), qfmt(p.plannedQty), p.producedQty != null ? qfmt(p.producedQty) : '—', p.yieldPct != null ? p.yieldPct + '%' : '—', p.totalCost != null ? money(p.totalCost) : '—', p.unitCost != null ? money(p.unitCost) : '—', p.wasteValue != null ? money(p.wasteValue) : '—', chip(p.status, PRCHIP[p.status] || ''), act(p)])), 'لا توجد أوامر إنتاج.')}`;
}
function reqTable(reqLines, rawWhId) {
  const chk = E_.checkAvailability(DB, reqLines, rawWhId);
  return { ok: chk.ok, html: `<b>احتياج المواد مقابل رصيد المخزن:</b>${TBL(['المادة', 'المطلوب', 'المتاح', 'العجز'], chk.lines.map(l => ROW([esc(l.name), qfmt(l.required), qfmt(l.available), l.shortage > 0 ? `<b class="err">${qfmt(l.shortage)}</b>` : '—'])))}${chk.ok ? '<span class="tag ok">المواد كافية</span>' : '<span class="tag crit">يوجد نقص — لن يمكن بدء التنفيذ قبل توفير المواد</span>'}` };
}
function openProduction(bomId) {
  const boms = DB.boms.filter(b => b.active !== false); if (!boms.length) return toast('أنشئ وصفة (BOM) أولًا.');
  const raws = activeWhs('raw'), fgs = activeWhs('finished'); if (!raws.length || !fgs.length) return toast('يلزم مخزن مواد خام ومخزن منتجات تامة نشطان.');
  openDoc({ title: 'أمر إنتاج جديد', wide: true, submit: 'حفظ كمسودة', intro: 'الأمر يُحفظ كمسودة بلا أثر مخزني. تُستهلك المواد وتُدخل المنتجات التامة عند «إكمال» الأمر.',
    fields: [{ n: 'bomId', l: 'الوصفة', t: 'select', opts: boms.map(b => [b.id, `${b.name} → ${itemName(b.productId)}`]), val: bomId || boms[0].id, req: true }, { n: 'plannedQty', l: 'الكمية المخططة', t: 'number', req: true, min: 0.001 },
      { n: 'rawWhId', l: 'مخزن المواد الخام', t: 'select', opts: raws.map(w => [w.id, w.name]), val: raws[0].id, req: true }, { n: 'fgWhId', l: 'مخزن المنتجات التامة', t: 'select', opts: fgs.map(w => [w.id, w.name]), val: fgs[0].id, req: true }, { n: 'date', l: 'التاريخ', t: 'date', val: localToday(), req: true }, { n: 'note', l: 'ملاحظات', t: 'textarea' }],
    summary: v => { if (!(Number(v.plannedQty) > 0) || !v.bomId) return ''; try { return reqTable(E_.requirement(DB, v.bomId, v.plannedQty), v.rawWhId).html; } catch (e) { return esc(e.message); } },
    build: v => ({ op: 'createProduction', input: v }), ok: r => `تم إنشاء أمر الإنتاج ${r.no}` });
}
function openCompleteProd(id) {
  const p = DB.productions.find(x => x.id === id); if (!p) return;
  const rows = E_.toList(p.requirement).map(r => ({ itemId: r.itemId, req: `${qfmt(r.required)} (متاح ${qfmt(E_.stockOf(DB, r.itemId, p.rawWhId))})`, actualQty: r.required, wasteQty: '', _opts: { itemId: [[r.itemId, itemName(r.itemId)]] } }));
  openDoc({ title: `إكمال أمر الإنتاج ${esc(p.no)} — ${esc(itemName(p.productId))}`, wide: true, submit: 'إكمال وتسجيل الإنتاج',
    intro: 'أدخل الكمية المنتجة فعليًا والاستهلاك الفعلي (الافتراضي = المعياري) والهالك. تُخصم المواد من المخزن بمتوسط التكلفة وتدخل المنتجات التامة بتكلفة الوحدة المحسوبة.',
    fields: [{ n: 'producedQty', l: `الكمية المنتجة فعليًا (المخطط ${qfmt(p.plannedQty)})`, t: 'number', req: true, min: 0.001, val: p.plannedQty }, { n: 'otherCost', l: 'تكاليف تشغيل أخرى مدفوعة نقدًا (ج)', t: 'number', val: '', hint: `رصيد الخزينة: ${money(E_.cashBalance(DB))}` }],
    lines: { fixed: true, keyCol: 'itemId', cols: [{ n: 'itemId', l: 'المادة', t: 'select' }, { n: 'req', l: 'المعياري (والمتاح)', t: 'info' }, { n: 'actualQty', l: 'الاستهلاك الفعلي' }, { n: 'wasteQty', l: 'منه هالك' }], rows },
    build: v => ({ op: 'completeProduction', input: { id, producedQty: v.producedQty, otherCost: v.otherCost, consumption: v.lines.map(l => ({ itemId: l.itemId, actualQty: l.actualQty, wasteQty: l.wasteQty })) } }), ok: r => `اكتمل الأمر ${r.no} — تكلفة الوحدة ${money(r.unitCost)}` });
}
function viewProd(id) {
  const p = DB.productions.find(x => x.id === id); if (!p) return;
  const cons = E_.toList(p.consumption), req = E_.toList(p.requirement);
  showDoc(`أمر إنتاج ${esc(p.no)}`, `<p>المنتج: ${esc(itemName(p.productId))} — الحالة: ${esc(p.status)} — التاريخ: ${esc(p.date)} — المخازن: ${esc(nm('warehouses', p.rawWhId))} ← ${esc(nm('warehouses', p.fgWhId))}</p>
  ${p.status === 'مكتمل' ? `<p>المخطط ${qfmt(p.plannedQty)} — المنتج ${qfmt(p.producedQty)} (${p.yieldPct}%) — تكلفة المواد ${money(p.materialCost)} + أخرى ${money(p.otherCost)} = <b>${money(p.totalCost)}</b> — تكلفة الوحدة <b>${money(p.unitCost)}</b> — قيمة الهالك ${money(p.wasteValue)}</p>
  ${TBL(['المادة', 'المعياري', 'الفعلي', 'الانحراف', 'الهالك', 'التكلفة'], cons.map(c => ROW([esc(itemName(c.itemId)), qfmt(c.required), qfmt(c.actualQty), qfmt(c.variance), qfmt(c.wasteQty), money(c.cost)])))}` : TBL(['المادة', 'المطلوب'], req.map(r => ROW([esc(itemName(r.itemId)), qfmt(r.required)])))}${p.note ? `<p>ملاحظات: ${esc(p.note)}</p>` : ''}`);
}

/* ========== المحاسبة ========== */
const ACC_TABS = { summary: 'الملخص المالي', cash: 'الخزينة', expenses: 'المصروفات', journal: 'القيود' };
function pageAccounting(tab) {
  tab = ACC_TABS[tab] ? tab : 'summary';
  return `<h2>المحاسبة</h2>${TABS('accounting', ACC_TABS, tab)}` + ({ summary: accSummary, cash: accCash, expenses: accExpenses, journal: accJournal })[tab]();
}
function accSummary() {
  const t = localToday(), m = Reports.pnl(DB, { from: t.slice(0, 7) + '-01', to: t }), all = Reports.pnl(DB, {}), b = E_.balances(DB), bad = E_.verify(DB, {});
  const P = (l, a, bb) => ROW([l, money(a), money(bb)]);
  return `<div class="grid">${KPI(money(b['1100'] || 0), 'النقدية (ج)')}${KPI(money(b['1200'] || 0), 'العملاء (ج)')}${KPI(money(-(b['2100'] || 0)), 'الموردون (ج)')}${KPI(money((b['1310'] || 0) + (b['1320'] || 0)), 'قيمة المخزون (ج)')}</div>
  <div class="box"><h3>قائمة الدخل</h3>${TBL(['البند', 'هذا الشهر', 'الإجمالي'], [P('إيرادات المبيعات', m.revenue, all.revenue), P('(−) مردودات', m.returns, all.returns), P('<b>صافي الإيرادات</b>', m.netRevenue, all.netRevenue), P('(−) تكلفة البضاعة المباعة', m.cogs, all.cogs), P('<b>مجمل الربح</b>', m.grossProfit, all.grossProfit), P('(−) مصروفات تشغيلية', m.opex, all.opex), P('(−/+) فروقات وتسويات مخزون', m.adjustments, all.adjustments), P('<b>صافي الربح / الخسارة</b>', m.netProfit, all.netProfit)])}
  <p class="note">الفواتير القديمة المُرحَّلة (قبل الإصدار 2) بلا قيود محاسبية؛ المحاسبة تبدأ من تاريخ الترحيل. التقرير الكامل (ميزانية، ميزان مراجعة، دفتر خزينة) في «مركز التقارير ← المالية».</p></div>
  <div class="box"><h3>سلامة البيانات</h3>${bad.length ? `<p class="err"><b>تم رصد ${bad.length} مشكلة:</b></p><ul>${bad.slice(0, 10).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>' + chip('سليمة', 'ok') + ' أرصدة المخازن تطابق دفتر الحركة، وقيمة المخزون تطابق الأستاذ العام، وميزان المراجعة متوازن، ولا أرصدة سالبة.</p>'}</div>`;
}
function accCash() {
  const f = Reports.finance(DB, {}), sec = f.sections.find(s => s.title === 'دفتر الخزينة'), rows = sec.rows.slice(-100).reverse();
  return `<div class="grid">${KPI(money(E_.cashBalance(DB)), 'رصيد الخزينة (ج)', E_.cashBalance(DB) < 0 ? 'red' : '')}</div><div class="tools"><button data-act="cash-in">+ إيداع رأس مال / رصيد افتتاحي</button><button class="sec" data-act="cash-out">− مسحوبات</button></div>
  <h3>آخر حركات الخزينة</h3>${TBL(['التاريخ', 'المرجع', 'البيان', 'داخل', 'خارج', 'الرصيد'], rows.map(r => ROW([esc(r.date), esc(r.no), esc(r.memo), r.inn ? money(r.inn) : '—', r.out ? money(r.out) : '—', money(r.bal)])), 'لا توجد حركات نقدية. ابدأ بإيداع رأس مال.')}`;
}
function openCash(kind) {
  openDoc({ title: kind === 'capital_in' ? 'إيداع رأس مال / رصيد افتتاحي نقدي' : 'مسحوبات من الخزينة', submit: 'تسجيل', intro: `رصيد الخزينة الحالي: ${money(E_.cashBalance(DB))} ج`,
    fields: [{ n: 'amount', l: 'المبلغ (ج)', t: 'number', req: true, min: 0.01 }, { n: 'date', l: 'التاريخ', t: 'date', val: localToday(), req: true }, { n: 'note', l: 'ملاحظات', t: 'textarea' }], build: v => ({ op: 'cashEntry', input: { kind, ...v } }), ok: r => `تم التسجيل ${r.no}` });
}
function accExpenses() {
  const ex = [...DB.expenses].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return `<div class="grid">${KPI(money(ex.reduce((s, e) => s + e.amount, 0)), 'إجمالي المصروفات (ج)')}</div><div class="tools"><button data-act="new-expense">+ مصروف</button></div>${TBL(['الرقم', 'التاريخ', 'البند', 'المبلغ', 'الطريقة', 'ملاحظة'], ex.map(e => ROW([esc(e.no), esc(e.date), esc(e.category), money(e.amount), esc(e.method), esc(e.note || '')])), 'لا توجد مصروفات.')}`;
}
function openExpense() {
  openDoc({ title: 'تسجيل مصروف', submit: 'تسجيل المصروف', intro: `يُخصم من الخزينة (الرصيد ${money(E_.cashBalance(DB))} ج). لا يُسمح بمصروف أكبر من الرصيد.`,
    fields: [{ n: 'category', l: 'بند المصروف', t: 'select', opts: E_.EXPENSE_CATEGORIES.map(x => [x, x]), req: true }, { n: 'amount', l: 'المبلغ (ج)', t: 'number', req: true, min: 0.01 }, { n: 'method', l: 'طريقة الدفع', t: 'select', opts: E_.PAY_METHODS.map(x => [x, x]), val: 'نقدي' }, { n: 'date', l: 'التاريخ', t: 'date', val: localToday(), req: true }, { n: 'note', l: 'ملاحظات', t: 'textarea' }],
    build: v => ({ op: 'recordExpense', input: v }), ok: r => `تم تسجيل المصروف ${r.no}` });
}
function accJournal() {
  const js = [...DB.journal].filter(j => matches('jv', { m: j.memo, n: j.no, r: j.ref })).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.ts).localeCompare(String(a.ts))).slice(0, 200);
  return `<p class="note">القيود تُنشأ تلقائيًا من العمليات (مبيعات، مشتريات، إنتاج، مصروفات…) ولا تُعدَّل يدويًا؛ التصحيح يتم بعملية عكسية موثّقة.</p><div class="tools">${SEARCH('jv', 'بحث في القيود')}</div>
  ${TBL(['القيد', 'التاريخ', 'البيان', 'الأطراف'], js.map(j => ROW([esc(j.no) + (j.reversed ? ' ' + chip('معكوس', 'nodata') : '') + (j.reverses ? ' ' + chip('عكس', 'low') : ''), esc(j.date), esc(j.memo), E_.toList(j.lines).map(l => `${esc(E_.ACCOUNTS[l.acct].n)}: ${l.dr ? 'مدين ' + money(l.dr) : 'دائن ' + money(l.cr)}`).join('<br>')])), 'لا توجد قيود.')}${DB.journal.length > 200 ? '<p class="note">يُعرض آخر 200 قيد؛ التقارير تشمل الكل.</p>' : ''}`;
}

Object.assign(UI.actions, {
  'new-item': () => openItem(), 'edit-item': id => openItem(id), 'del-item': id => quickAct('deleteItem', { id }, 'تم حذف الصنف', 'حذف هذا الصنف نهائيًا؟ (يُرفض إن كان له رصيد أو حركات)'),
  'v-receipt': () => voucherDoc('receipt'), 'v-issue': () => voucherDoc('issue'), 'v-transfer': () => voucherDoc('transfer'), 'v-adjust': () => voucherDoc('adjust'), 'view-voucher': id => viewVoucher(id),
  'new-wh': () => openWarehouse(), 'edit-wh': id => openWarehouse(id), 'del-wh': id => quickAct('deleteWarehouse', { id }, 'تم حذف المخزن', 'حذف هذا المخزن؟ (يُرفض إن كانت له حركات)'),
  'new-bom': () => openBom(), 'edit-bom': id => openBom(id), 'del-bom': id => quickAct('deleteBom', { id }, 'تم حذف الوصفة', 'حذف هذه الوصفة؟'),
  'new-production': id => openProduction(id && DB.boms.some(b => b.id === id) ? id : undefined), 'view-prod': id => viewProd(id), 'complete-prod': id => openCompleteProd(id),
  'start-prod': id => quickAct('startProduction', { id }, 'بدأ تنفيذ الأمر'), 'cancel-prod': id => quickAct('cancelProduction', { id }, 'تم إلغاء الأمر', 'إلغاء أمر الإنتاج؟'),
  'cash-in': () => openCash('capital_in'), 'cash-out': () => openCash('withdrawal'), 'new-expense': () => openExpense()
});
