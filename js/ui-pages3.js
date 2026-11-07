/* نبض ERP — صفحات الواجهة (3): مركز التقارير، تحليل المخاطر والذكاء الاصطناعي، المحاكاة، الإعدادات، شاشة الترقية.
   تعتمد على متغيرات app.js وui-kit.js العامة وتستخدمها وقت الاستدعاء فقط. */
UI.reset = () => {
  UI.f = {};
  UI.rf = { from: '', to: '', whId: '', status: '', customerId: '', supplierId: '' };
  UI.risk = { item: '', delay: null };
  UI.sim = { d: 0, x: 0, p: 0 };
  UI.mig = { types: {} };
};
UI.reset();

/* ========== مركز التقارير ========== */
const REP_TABS = { inventory: 'المخزون', movements: 'حركة المخزون', production: 'الإنتاج', sales: 'المبيعات', purchasing: 'المشتريات', finance: 'المالية', ai: 'مخاطر الإمداد', audit: 'سجل المراجعة' };
const repFilter = id => {
  const f = UI.rf, o = { from: f.from || '', to: f.to || '' };
  if ((id === 'inventory' || id === 'movements') && f.whId) o.whId = f.whId;
  if (id === 'production' && f.status) o.status = f.status;
  if (id === 'sales' && f.customerId) o.customerId = f.customerId;
  if (id === 'purchasing' && f.supplierId) o.supplierId = f.supplierId;
  if (!o.from) delete o.from; if (!o.to) delete o.to;
  return o;
};
const cellFmt = (c, v) => v == null || v === '' ? '' : (c.t === 'money' ? money(v) : c.t === 'num' ? qfmt(v) : esc(v));
function renderSection(s, limit) {
  const head = s.columns.map(c => c.l), all = s.rows, shown = limit && all.length > limit ? all.slice(-limit) : all;
  const rows = shown.map(r => ROW(s.columns.map(c => cellFmt(c, r[c.k]))));
  if (s.totals) rows.push(`<tr class="tot">${s.columns.map(c => `<td><b>${cellFmt(c, s.totals[c.k])}</b></td>`).join('')}</tr>`);
  return `${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}${shown.length < all.length ? `<p class="note">يُعرض آخر ${qfmt(shown.length)} من ${qfmt(all.length)} سطرًا؛ ضيّق الفترة أو صدّر إلى Excel للكل.</p>` : ''}${TBL(head, rows, 'لا توجد بيانات في هذه الفترة.')}`;
}
const repSectionHtml = s => `<h3>${esc(s.title)}</h3>${renderSection(s)}`;
function buildReport(id) { const fn = Reports.REPORTS[id]; return fn ? fn(DB, repFilter(id)) : null; }
function pageReports(tab) {
  const id = REP_TABS[tab] ? tab : 'inventory', f = UI.rf;
  const lab = (k, l) => `<label>${l}<input type="date" data-rf="${k}" value="${esc(f[k] || '')}"></label>`;
  const sel = (k, l, pairs, ph) => `<label>${l}<select data-rf="${k}">${optionsHtml(pairs, f[k] || '', ph)}</select></label>`;
  let extra = '';
  if (id === 'inventory' || id === 'movements') extra = sel('whId', 'المخزن', DB.warehouses.map(w => [w.id, w.name]), 'كل المخازن');
  if (id === 'production') extra = sel('status', 'الحالة', E_.PROD_STATUS.map(x => [x, x]), 'كل الحالات');
  if (id === 'sales') extra = sel('customerId', 'العميل', DB.customers.map(c => [c.id, c.name]), 'كل العملاء');
  if (id === 'purchasing') extra = sel('supplierId', 'المورد', DB.suppliers.map(s => [s.id, s.name]), 'كل الموردين');
  const rep = buildReport(id);
  return `<h2>مركز التقارير</h2>${TABS('reports', REP_TABS, id)}
  <div class="tools noprint">${lab('from', 'من تاريخ')}${lab('to', id === 'inventory' ? 'الأرصدة حتى' : id === 'finance' ? 'حتى تاريخ' : 'إلى تاريخ')}${extra}
  <button type="button" class="sec" data-act="rep-clear">مسح المرشحات</button></div>
  <div class="tools noprint"><button type="button" data-act="rep-print">طباعة / حفظ PDF</button><button type="button" class="sec" data-act="rep-xlsx">تصدير Excel</button><button type="button" class="sec" data-act="rep-csv">تصدير CSV</button></div>
  <div id="repbox" class="box printable"><h2>${esc(rep.title)}</h2><p class="muted">${esc((DB.settings && DB.settings.company) || 'الشركة')} — ${esc(rep.subtitle || '')}</p>${rep.sections.map(repSectionHtml).join('')}<p class="muted">طُبع بتاريخ ${esc(localToday())}</p></div>`;
}
const repFileName = (id, ext) => `nabdh_${id}_${localToday()}.${ext}`;
function currentReportId() { const t = (location.hash || '').split('/')[1]; return REP_TABS[t] ? t : 'inventory'; }
function exportRep(id, rep, kind) {
  if (!rep) return;
  if (kind === 'csv') {
    const out = [[rep.title], [rep.subtitle || '']];
    rep.sections.forEach(s => { out.push([]); out.push([s.title]); Reports.toMatrix(s).forEach(r => out.push(r)); });
    downloadBlob(repFileName(id, 'csv'), '\ufeff' + matrixToCsv(out), 'text/csv;charset=utf-8');
  } else {
    if (typeof XlsxLite === 'undefined') return toast('مكتبة التصدير غير محمّلة.');
    const sheets = rep.sections.map(s => ({ name: s.title, rows: Reports.toMatrix(s) }));
    downloadBlob(repFileName(id, 'xlsx'), XlsxLite.build(sheets.length ? sheets : [{ name: 'تقرير', rows: [['لا توجد بيانات']] }]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }
}
const exportReport = kind => { const id = currentReportId(); exportRep(id, buildReport(id), kind); };
// تبويب «دفتر الحركة» في صفحة المخزون يستخدم مرشحاته الخاصة (UI.f.l*)
const ledgerReport = () => Reports.movements(DB, { from: UI.f.lfrom || '', to: UI.f.lto || '', itemId: UI.f.litem || '', whId: UI.f.lwh || '', type: UI.f.ltype || '' });

/* ========== تحليل المخاطر (حسابات رياضية + رأي الذكاء الاصطناعي؛ القرار للإنسان) ========== */
const rawItemsList = () => (DB.items || []).filter(i => i.type === 'raw' && i.active !== false);
function pageRisk() {
  const raws = rawItemsList();
  const it0 = raws.find(i => i.id === UI.risk.item) || raws[0];
  if (!it0) return '<h2>تحليل المخاطر</h2><p class="note">أضف مواد خام في صفحة المخزون أولًا.</p>';
  UI.risk.item = it0.id; const dl = UI.risk.delay ?? it0.delay ?? 0, it = { ...it0, delay: dl };
  const c = K.cover(it.qty, it.daily), alts = sf(() => Calc.rank(it, DB.suppliers), []) || [];
  let out = '';
  if (c == null) out = '<div class="note">بيانات الكمية أو الاستهلاك اليومي غير صالحة. أدخلها في صفحة المخزون ليتم التحليل.</div>';
  else {
    const gap = K.gap(it), arr = K.arr(it);
    if (gap == null || arr == null) out = '<div class="note">بيانات الشحنة (أيام الوصول أو التأخير) ناقصة أو غير صالحة. أدخلها في صفحة المخزون ليتم التحليل.</div>';
    else {
      out = `<div class="box"><h3>الحسابات الرياضية</h3><p>أيام التغطية = ${fmt(it.qty)} ÷ ${fmt(it.daily)} = <b>${fmt(c)} يوم</b><br>وصول الشحنة = ${fmt(it.inbound)} + ${fmt(dl)} تأخير = <b>${fmt(arr)} يوم</b><br>فجوة التوريد = <b>${fmt(gap)} يوم</b> ${gap > 0 ? `(نقص متوقع ≈ ${fmt(gap * it.daily)} وحدة)` : '(لا نقص متوقع)'}</p></div>`;
      if (gap <= 0) out += `<div class="box"><h3>التوصية</h3><p>المخزون يكفي حتى وصول الشحنة بزيادة ${fmt(c - arr)} يوم. لا حاجة لتغيير المورد الآن.</p></div>`;
      else if (!alts.length) out += '<div class="box"><h3>التوصية</h3><p>لا يوجد مورد بديل مسجّل لهذا الصنف. سجّل موردين مرشحين (السعر والمدة والجودة) ليقارن النظام بينهم.</p></div>';
      else {
        const top = alts[0], cmp = sf(() => Calc.compare(it, top.s, { safety: DB.settings.safety ?? 3 }));
        if (!cmp) out += `<div class="note">تعذّر إجراء المقارنة مع «${esc(top.s.name)}» بسبب بيانات ناقصة في الصنف أو المورد.</div>`;
        else out += `<div class="box"><h3>البدائل المرشحة</h3>${TBL(['المورد', 'السعر', 'المدة', 'الجودة', 'الحد الأدنى', 'الدرجة', 'الحالة'], alts.map(a => ROW([esc(a.s.name), fmt(a.s.price), fmt(a.s.lead), fmt(a.s.quality), fmt(a.s.moq), a.score, esc(a.s.verified)])))}<p class="note">الدرجة = 35٪ سعر + 35٪ وقت + 30٪ جودة، وهي معادلة بسيطة وليست تنبؤًا.</p></div>
      <div class="box"><h3>الانتظار أم الشراء من «${esc(top.s.name)}»؟</h3>${TBL(['', 'الانتظار', 'البديل'], [
          ROW(['وصول البضاعة', fmt(cmp.waitArr) + ' يوم', fmt(cmp.altArr) + ' يوم']), ROW(['أيام نقص متوقعة', fmt(cmp.waitShort), fmt(cmp.altShort)]),
          ROW(['وحدات غير متوفرة', fmt(cmp.waitLostUnits), fmt(cmp.altLostUnits)]), ROW(['قيمة النقص بسعر الوحدة الحالي', fmt(cmp.waitLostValue), '—']),
          ROW(['كمية الطلب المقترحة (تغطي فترة التأخير + أمان)', '—', fmt(cmp.qty)]), ROW(['التكلفة الإضافية مقابل المورد الحالي', '—', fmt(cmp.extraCost)])])}
      <p><b>سبب الاختيار:</b> ${esc(top.s.name)} أعلى درجة بين المرشحين (${top.score}) بمدة ${fmt(top.s.lead)} يوم وجودة ${fmt(top.s.quality)}/5. ${cmp.altShort < cmp.waitShort ? `يقلّل أيام النقص من ${fmt(cmp.waitShort)} إلى ${fmt(cmp.altShort)} بتكلفة إضافية ≈ ${fmt(cmp.extraCost)}.` : 'لكنه لا يقلل النقص مقارنةً بالانتظار؛ راجع الكمية أو ابحث عن مورد أسرع.'}${cmp.altShort > 0 ? ' سيبقى نقص جزئي حتى مع البديل، فكّر بشحنة طارئة أو تقسيم الطلب.' : ''}</p>
      <p>افتراض: إن وصلت الشحنة الأصلية لاحقًا فسيزيد مخزونك عن الحاجة.</p><div class="note">${top.s.verified === 'تم التحقق' ? 'تم التحقق من هذا المورد يدويًا؛ أكّد السعر والتوفر قبل الطلب.' : 'مرشح يحتاج إلى تأكيد: البيانات تجريبية، والسعر والتوفر غير مؤكدين.'}</div>
      <div class="tools"><button type="button" data-act="risk-po" data-s="${esc(top.s.id)}" data-q="${esc(cmp.qty)}" data-p="${esc(top.s.price)}">أنشئ أمر شراء مسودة (قرار بشري لاحق)</button></div></div>`;
      }
    }
  }
  const decs = (DB.aiDecisions || []).filter(a => a.itemId === it0.id).slice(-3).reverse();
  return `<h2>تحليل المخاطر</h2><div class="tools"><label>الصنف <select id="ri">${raws.map(i => `<option value="${esc(i.id)}" ${i.id === it0.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select></label>
  <label>تأخر المورد (أيام) <input id="rd" type="number" min="0" step="any" value="${esc(dl)}"></label><button type="button" class="sec" data-act="risk-save-delay">احفظ التأخير على الصنف</button></div>${out}
  <div class="box"><h3>رأي الذكاء الاصطناعي (تفسير لغوي، وليس حسابًا)</h3><p>يعتمد على أرقامك أعلاه ولا يضيف بيانات عن موردين حقيقيين. الذكاء يوصي والقرار لك.</p><button type="button" class="sec" data-act="risk-ai">اطلب تحليل الذكاء الاصطناعي</button><div id="aiout" aria-live="polite"></div></div>
  ${decs.length ? `<div class="box"><h3>آخر قرارات التوصيات لهذا الصنف</h3>${decs.map(a => `<p>${chip(a.decision === 'accepted' ? 'اعتُمدت' : 'رُفضت', a.decision === 'accepted' ? 'ok' : 'crit')} ${esc(String(a.ts).slice(0, 10))} — ${esc(a.user)} — ${esc(a.summary || '')}</p>`).join('')}</div>` : ''}`;
}

/* ---- الاتصال بخادم الذكاء الاصطناعي (الرابط وطريقة الاتصال وشكل البيانات دون تغيير) ---- */
const RISK_LV = { high: ['crit', 'مرتفع'], medium: ['low', 'متوسط'], low: ['ok', 'منخفض'] };
const AI_ERR = { not_configured: 'الذكاء الاصطناعي غير مهيأ على الخادم (المفتاح أو اسم النموذج غير مضبوط).' };
const ulist = a => Array.isArray(a) && a.length ? `<ul>${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>—</p>';
const tx = x => esc(x == null || x === '' ? '—' : x);
function apiUrl() {
  const u = String((DB && DB.settings && DB.settings.apiUrl) || '').trim();
  if (!u) return { e: 'الذكاء الاصطناعي غير متصل: لم يتم إدخال رابط الخادم في الإعدادات. الحسابات أعلاه تعمل بدونه.' };
  if (!/^https:\/\//.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(u)) return { e: 'رابط الخادم يجب أن يبدأ بـ https://' };
  return { u };
}
async function aiPost(u, body) {
  let r; try { r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch { throw new Error('تعذّر الوصول إلى الخادم. تحقق من الرابط في الإعدادات ومن ضبط ALLOWED_ORIGIN (CORS) على Vercel.'); }
  let j; try { j = await r.json(); } catch { throw new Error('رد الخادم غير مفهوم (قد يكون الرابط خاطئًا).'); }
  if (!r.ok || !j || !j.ok) throw new Error(AI_ERR[(j || {}).code] || (j || {}).error || 'فشل الطلب');
  return j;
}
// أوامر الشراء الجديدة بنود متعددة؛ الخادم يتوقع صفًا لكل بند مفتوح (الكمية المتبقية فقط)
function aiOrders() {
  const rows = [];
  for (const o of DB.orders) { if (o.status === 'ملغي' || o.status === 'مستلم') continue;
    for (const l of E_.toList(o.lines)) { const open = Math.max(0, (Number(l.qty) || 0) - (Number(l.receivedQty) || 0)); if (open > 0) rows.push({ itemId: l.itemId, supplierId: o.supplierId, qty: open, price: l.price, status: o.status }); } }
  return rows.slice(0, 300);
}
let aiLast = null;   // آخر رد صالح (لتسجيل قرار الاعتماد/الرفض)
async function askAI() {
  const o = $('#aiout'); if (!o || !DB) return;
  const c = apiUrl(); if (c.e) { o.innerHTML = `<p class="note">${esc(c.e)}</p>`; return; }
  const it = DB.items.find(i => i.id === UI.risk.item);
  if (!it) { o.innerHTML = '<p class="note">اختر صنفًا أولًا.</p>'; return; }
  const v = authVersion; o.textContent = 'جارٍ التحليل…';
  const strip = (r, ks) => r.map(x => Object.fromEntries(ks.map(k => [k, x[k]])));
  try {
    const delay = UI.risk.delay ?? it.delay ?? 0;
    const j = await aiPost(c.u, { itemId: it.id, delay, safety: DB.settings.safety ?? 3,
      items: strip(rawItemsList(), ['id', 'code', 'name', 'qty', 'min', 'daily', 'price', 'lead', 'supplierId', 'inbound', 'delay']),
      suppliers: strip(DB.suppliers, ['id', 'name', 'itemCodes', 'price', 'lead', 'quality', 'moq', 'verified']), orders: aiOrders() });
    if (v !== authVersion) return;
    const a = j.analysis || {}, rk = RISK_LV[j.riskLevel] || RISK_LV.low;
    const cands = Array.isArray(j.candidates) ? j.candidates : [], alts = Array.isArray(a.alternatives) ? a.alternatives : [], notices = Array.isArray(j.notices) ? j.notices : [];
    const by = id => cands.find(x => x.supplierId === id);
    aiLast = { itemId: it.id, riskLevel: j.riskLevel || '', summary: String(a.summary || '').slice(0, 280) };
    o.innerHTML = `<p>مستوى الخطر (محسوب رياضيًا): <span class="tag ${rk[0]}">${rk[1]}</span></p>
    <p><b>الملخص:</b> ${tx(a.summary)}</p><p><b>نفاد المخزون:</b> ${tx(a.stockoutExplanation)}</p><p><b>أثر التأخير:</b> ${tx(a.delayImpact)}</p>
    ${a.recommendedSupplierId ? `<p><b>الأنسب بحسب التحليل:</b> ${tx((by(a.recommendedSupplierId) || {}).name || a.recommendedSupplierId)}</p>` : '<p><b>لا توصية بمورد محدد.</b></p>'}
    ${cands.length ? TBL(['المورد', 'السعر', 'المدة', 'الجودة', 'الحالة', 'المزايا', 'العيوب'], cands.map(x => { const e = alts.find(y => y.supplierId === x.supplierId) || {}; return ROW([esc(x.name), fmt(x.price), fmt(x.leadDays), fmt(x.quality), esc(x.verified), ulist(e.pros), ulist(e.cons)]); })) : '<p>لا يوجد موردون بدلاء مسجلون لهذا الصنف.</p>'}
    <p><b>كمية إعادة الطلب:</b> ${tx(a.reorderComment)}</p><p><b>الافتراضات:</b></p>${ulist(a.assumptions)}<p><b>بيانات ناقصة:</b></p>${ulist(a.dataGaps)}
    ${notices.map(n => `<div class="note">${esc(n)}</div>`).join('')}
    <div class="note"><b>القرار لك:</b> هذه توصية استرشادية وليست أمرًا. سجّل قرارك ليُحفظ في سجل المراجعة.</div>
    <div class="tools"><button type="button" data-act="ai-accept">اعتماد التوصية</button><button type="button" class="sec" data-act="ai-reject">رفض التوصية</button></div>`;
  } catch (e) { if (v !== authVersion) return; o.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
async function testAI() {
  const o = $('#aitest'); if (!o || !DB) return;
  const c = apiUrl(); if (c.e) { o.textContent = c.e; return; }
  const v = authVersion; o.textContent = 'جارٍ اختبار الاتصال…';
  try { const j = await aiPost(c.u, { ping: true }); if (v !== authVersion) return; o.textContent = j.message || 'تم الاتصال بالخادم بنجاح.'; }
  catch (e) { if (v !== authVersion) return; o.textContent = e.message; }
}

/* ========== محاكاة السيناريوهات ========== */
function pageSim() {
  const s = UI.sim, p = { demand: 1 + s.d / 100, extraDelay: s.x, priceMult: 1 + s.p / 100 };
  const rows = rawItemsList().map(i => {
    const b = statusOf(i), n = statusOf({ ...i, daily: Number(i.daily) * p.demand, delay: (Number(i.delay) || 0) + p.extraDelay });
    const q = sf(() => Calc.reorderQty({ ...i, daily: Number(i.daily) * p.demand }, i.lead, DB.settings.safety ?? 3)); return { i, b, n, q, cost: q == null ? null : q * Number(i.price) * p.priceMult };
  });
  return `<h2>محاكاة السيناريوهات</h2><div class="box"><label>زيادة الطلب: <b>${s.d}%</b><input id="sd" type="range" min="-30" max="100" value="${s.d}"></label>
  <label>تأخر إضافي في الشحن: <b>${s.x} يوم</b><input id="sx" type="range" min="0" max="30" value="${s.x}"></label>
  <label>ارتفاع السعر: <b>${s.p}%</b><input id="sp" type="range" min="-20" max="60" value="${s.p}"></label></div>
  ${TBL(['الصنف', 'التغطية الآن', 'التغطية بعد السيناريو', 'الحالة بعده', 'كمية إعادة الطلب', 'تكلفتها'], rows.map(r => ROW([esc(r.i.name), `${fmt(r.b.c)} (${esc(r.b.t)})`, fmt(r.n.c), tag(r.n), fmt(r.q), fmt(r.cost)])), 'لا توجد مواد خام.')}
  <p class="note">الافتراض: السيناريو يغيّر الاستهلاك والتأخر والسعر فقط، وتبقى بقية البيانات كما هي. كمية إعادة الطلب = الاستهلاك خلال مدة التوريد + ${DB.settings.safety ?? 3} أيام أمان − المتاح. المحاكاة للعرض فقط ولا تغيّر أي بيانات.</p>`;
}

/* ========== الإعدادات والنسخ الاحتياطي ========== */
function pageSettings() {
  const S = DB.settings, f = (n, l, t = 'text') => `<label>${l}<input name="${n}" type="${t}" value="${esc(S[n] ?? '')}"></label>`, ck = (n, l) => `<label class="chk"><input type="checkbox" name="${n}" ${S[n] ? 'checked' : ''}> ${l}</label>`;
  return `<h2>الإعدادات</h2><form id="setForm" class="box"><h3>بيانات الشركة والغلاف الأكاديمي</h3>${f('company', 'اسم الشركة')}${f('student', 'اسم الطالب')}${f('supervisor', 'اسم المشرف (عدّله بعد التأكد من الاسم الكامل)')}${f('institute', 'المعهد')}
  <label>أيام مخزون الأمان<input name="safety" type="number" min="0" max="365" step="any" value="${esc(S.safety ?? 3)}"></label>
  <label>رابط خادم الذكاء الاصطناعي (مثال: https://your-app.vercel.app/api/analyze)<input name="apiUrl" type="url" dir="ltr" value="${esc(S.apiUrl ?? '')}"></label>
  ${ck('allowOverReceipt', 'السماح باستلام كمية أكبر من المطلوب في أمر الشراء')}${ck('allowNegativeCash', 'السماح برصيد خزينة سالب (غير مستحسن)')}
  <div class="tools"><button type="submit">حفظ الإعدادات</button><button type="button" class="sec" data-act="ai-test">اختبار الاتصال بالذكاء الاصطناعي</button><span id="aitest" aria-live="polite"></span></div></form>
  <div class="box"><h3>نسخة احتياطية</h3><p>تنزيل نسخة كاملة من بياناتك بصيغة JSON (للقراءة والأرشفة).</p><div class="tools"><button type="button" class="sec" data-act="backup-json">تنزيل نسخة كاملة JSON</button></div></div>
  <div class="box">
  <h3>تغيير البريد الإلكتروني للمدير</h3>
  <form id="emailChangeForm">
    <label>
      البريد الإلكتروني الجديد
      <input name="newEmail" type="email" required
        placeholder="nabdh.erp@gmail.com" dir="ltr">
    </label>

    <label>
      كلمة المرور الحالية
      <input name="password" type="password" required
        autocomplete="current-password">
    </label>

    <p id="emailChangeMessage" aria-live="polite"></p>

    <button type="submit">إرسال رابط تأكيد البريد الجديد</button>
  </form>
</div>
  <div class="note">تُحفظ بيانات حسابك على Firebase بشكل مستقل عن المستخدمين الآخرين. لا تضع أي مفتاح سري هنا؛ المفاتيح تُضبط في الخادم فقط. إصدار بنية البيانات: ${esc(DB.schemaVersion)}.</div>`;
}

/* ========== شاشة الترقية (بيانات الإصدار 1 → 2) ========== */
function renderMigration(raw, state) {
  const items = toListLocal(raw.items), sales = toListLocal(raw.sales), orders = toListLocal(raw.orders);
  const sold = new Set(sales.filter(s => s.status !== 'ملغي').map(s => s.itemId));
  const rows = items.map(i => { const guess = sold.has(i.id) ? 'finished' : 'raw', cur = UI.mig.types[i.id] || (i.type === 'raw' || i.type === 'finished' ? i.type : guess);
    return ROW([esc(i.code), esc(i.name), fmt(i.qty), `<select data-mig="${esc(i.id)}" aria-label="نوع ${esc(i.name)}">${optionsHtml(Object.entries(E_.ITEM_TYPES), cur)}</select>`]); });
  return `<section class="box"><h2>ترقية بيانات حسابك إلى نظام ERP</h2>
  <p>حسابك يحتوي بيانات من الإصدار السابق (${items.length} صنف، ${sales.length} عملية بيع، ${orders.length} طلب شراء). قبل الترقية يُحفظ <b>نسخة احتياطية كاملة</b> من بياناتك الحالية، ولا يُحذف أي سجل.</p>
  <ul><li>تُنشأ مخازن افتراضية (مواد خام / منتجات تامة) وتُرحَّل الكميات كأرصدة افتتاحية بسعر الوحدة المسجّل.</li><li>المبيعات القديمة تُحوَّل إلى فواتير مدفوعة بلا قيود محاسبية، وطلبات الشراء القديمة إلى أوامر بنود.</li><li>راجع نوع كل صنف أدناه (الافتراضي: «منتج تام» إن سبق بيعه، وإلا «مادة خام»).</li></ul>
  ${items.length ? TBL(['الكود', 'الصنف', 'الكمية', 'النوع'], rows) : ''}
  <p class="err" id="migerr" role="alert"></p><div class="tools"><button type="button" id="migrun">ابدأ الترقية</button><button type="button" class="sec" id="miglogout">تسجيل الخروج</button></div></section>`;
}
const toListLocal = v => (Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : [])).filter(x => x && typeof x === 'object');

/* ========== أوامر الأزرار ========== */
Object.assign(UI.actions, {
  'rep-print': () => printNode('area'),
  'rep-csv': () => exportReport('csv'), 'rep-xlsx': () => exportReport('xlsx'),
  'export-xlsx:movements': () => exportRep('movements', ledgerReport(), 'xlsx'), 'print-report': () => printNode('area'),
  'rep-clear': () => { UI.rf = { from: '', to: '', whId: '', status: '', customerId: '', supplierId: '' }; safeRoute(); },
  'risk-save-delay': () => { const it = DB.items.find(x => x.id === UI.risk.item); if (!it) return; const dl = UI.risk.delay ?? it.delay ?? 0; return quickAct('setItemDelay', { itemId: it.id, delay: dl }, 'تم حفظ التأخير'); },
  'risk-po': (id, btn) => {
    const d = btn.dataset, qty = Number(d.q), price = Number(d.p);
    if (!UI.risk.item || d.q === '' || d.p === '' || !isFinite(qty) || qty <= 0 || !isFinite(price) || price < 0) return toast('تعذّر إنشاء الأمر: الكمية أو السعر غير صالح.');
    return quickAct('createPO', { supplierId: d.s, source: 'risk-analysis', note: 'أُنشئ من تحليل المخاطر — مسودة تحتاج مراجعة واعتماد', lines: [{ itemId: UI.risk.item, qty, price }] }, 'أُنشئ أمر شراء مسودة في المشتريات');
  },
  'risk-ai': () => askAI(),
  'ai-accept': () => aiDecide('accepted'), 'ai-reject': () => aiDecide('rejected'),
  'ai-test': () => testAI(),
  'backup-json': () => downloadBlob(`nabdh_backup_${localToday()}.json`, JSON.stringify(DB, null, 2), 'application/json')
});
function aiDecide(decision) {
  if (!aiLast || aiLast.itemId !== UI.risk.item) return toast('اطلب التحليل أولًا ثم قرّر.');
  const note = decision === 'rejected' ? (prompt('سبب الرفض (اختياري):', '') || '') : '';
  quickAct('recordAiDecision', { itemId: aiLast.itemId, decision, riskLevel: aiLast.riskLevel, summary: aiLast.summary, note }, decision === 'accepted' ? 'سُجّل اعتماد التوصية' : 'سُجّل رفض التوصية');
}
