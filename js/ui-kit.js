/* نبض ERP — أدوات الواجهة المشتركة: جداول، تبويبات، نماذج المستندات (برؤوس وبنود)، طباعة وتصدير.
   تعتمد على متغيرات app.js العامة (DB, esc, fmt, toast, act, safeRoute) وتستخدمها وقت الاستدعاء فقط. */
const UI = { actions: {}, f: {} };

const money = n => (n == null || n === '' || !isFinite(n)) ? '—' : Number(n).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qfmt = n => (n == null || n === '' || !isFinite(n)) ? '—' : Number(n).toLocaleString('ar-EG', { maximumFractionDigits: 3 });
const localToday = () => new Date().toLocaleDateString('sv-SE');
const newOpId = () => 'op_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
const chip = (t, k = '') => `<span class="tag ${k}">${esc(t)}</span>`;
const nm = (list, id) => { const x = (DB[list] || []).find(r => r.id === id); return x ? x.name : '—'; };
const itemLabel = i => `${i.code} — ${i.name}`;
const optionsHtml = (pairs, sel, ph) => (ph != null ? `<option value="">${esc(ph)}</option>` : '') + pairs.map(([v, l, extra]) => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''} ${extra || ''}>${esc(l)}</option>`).join('');
const activeItems = type => (DB.items || []).filter(i => i.active !== false && (!type || i.type === type));
const activeWhs = kind => (DB.warehouses || []).filter(w => w.active !== false && (!kind || w.kind === kind));
const whKindOf = type => (type === 'finished' ? 'finished' : 'raw');

/* ---------- جداول وتبويبات ---------- */
const TBL = (head, rows, empty = 'لا توجد بيانات.') => `<div class="tw"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}">${esc(empty)}</td></tr>`}</tbody></table></div>`;
const ROW = cells => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
const BTN = (act, id, label, cls = 'sec') => `<button type="button" class="${cls}" data-act="${act}" data-id="${esc(id)}">${label}</button>`;
const TABS = (mod, tabs, cur) => `<div class="tabs" role="tablist">${Object.entries(tabs).map(([k, v]) => `<a href="#${mod}/${k}" role="tab" ${k === cur ? 'aria-current="page"' : ''}>${v}</a>`).join('')}</div>`;
const KPI = (v, l, cls = '') => `<div class="kpi ${cls}"><b>${v}</b>${l}</div>`;
const SEARCH = (key, ph = 'بحث…') => `<input id="f_${key}" data-f="${key}" type="search" placeholder="${esc(ph)}" value="${esc(UI.f[key] || '')}" aria-label="${esc(ph)}">`;
const FSEL = (key, pairs, ph) => `<select id="f_${key}" data-f="${key}" aria-label="${esc(ph)}">${optionsHtml(pairs, UI.f[key] || '', ph)}</select>`;
const matches = (key, obj) => { const q = (UI.f[key] || '').trim().toLowerCase(); return !q || JSON.stringify(obj).toLowerCase().includes(q); };

function fieldHtml(f) {
  const v = f.val ?? '', id = 'fld_' + f.n, req = f.req ? 'required' : '', dis = f.disabled ? 'disabled' : '';
  let c;
  if (f.t === 'select') c = `<select id="${id}" name="${f.n}" ${req} ${dis}>${optionsHtml(f.opts || [], v, f.ph)}</select>`;
  else if (f.t === 'textarea') c = `<textarea id="${id}" name="${f.n}" rows="2" maxlength="300" ${dis}>${esc(v)}</textarea>`;
  else if (f.t === 'check') return `<label class="chk"><input id="${id}" type="checkbox" name="${f.n}" ${v ? 'checked' : ''} ${dis}> ${f.l}</label>`;
  else c = `<input id="${id}" name="${f.n}" type="${f.t || 'text'}" value="${esc(v)}" ${f.t === 'number' ? `min="${f.min ?? 0}" step="${f.step ?? 'any'}"` : ''} ${f.max ? `max="${f.max}"` : ''} ${f.ph ? `placeholder="${esc(f.ph)}"` : ''} ${req} ${dis} ${f.dir ? `dir="${f.dir}"` : ''}>`;
  return `<label data-field="${f.n}">${f.l}${f.req ? ' *' : ''}${c}${f.hint ? `<small class="hint">${f.hint}</small>` : ''}</label>`;
}

function lineRowHtml(cols, row = {}) {
  return `<tr class="lr">${cols.map(c => {
    const v = row[c.n] ?? '';
    if (c.t === 'select') return `<td><select data-c="${c.n}" aria-label="${esc(c.l)}">${optionsHtml((row._opts && row._opts[c.n]) || c.opts || [], v, (row._opts && row._opts[c.n]) ? null : c.ph)}</select></td>`;
    if (c.t === 'info') return `<td><span class="info" data-c="${c.n}" data-info="1">${esc(row[c.n] ?? '')}</span></td>`;
    return `<td><input data-c="${c.n}" type="${c.t || 'number'}" ${(c.t || 'number') === 'number' ? `min="${c.min ?? 0}" step="${c.step ?? 'any'}"` : ''} value="${esc(v)}" aria-label="${esc(c.l)}" ${c.ph ? `placeholder="${esc(c.ph)}"` : ''}></td>`;
  }).join('')}<td><button type="button" class="sec rm" aria-label="حذف البند">×</button></td></tr>`;
}

function openDoc(spec) {
  if (!DB) return;
  const opId = newOpId(), frm = $('#frm'), dlg = $('#dlg');
  dlg.classList.toggle('wide', !!spec.wide);
  const L = spec.lines;
  frm.innerHTML = `<h2>${spec.title}</h2>${spec.intro ? `<p class="note">${spec.intro}</p>` : ''}<div class="fgrid">${(spec.fields || []).map(fieldHtml).join('')}</div>
  ${L ? `<div class="tw"><table class="lines"><thead><tr>${L.cols.map(c => `<th>${c.l}</th>`).join('')}<th></th></tr></thead><tbody id="lbody">${(L.rows && L.rows.length ? L.rows : [{}]).map(r => lineRowHtml(L.cols, r)).join('')}</tbody></table></div>
  ${L.fixed ? '' : `<div class="tools"><button type="button" class="sec" id="addLine">+ ${L.addLabel || 'إضافة بند'}</button></div>`}` : ''}
  <div class="note" id="sumbox" hidden></div><p class="err" id="ferr" role="alert"></p>
  <div class="tools"><button type="submit" id="fsub">${spec.submit || 'حفظ'}</button><button type="button" class="sec" id="cx">إلغاء</button></div>`;
  const api = {
    val: n => { const e = frm.elements[n]; return e ? (e.type === 'checkbox' ? e.checked : e.value) : ''; },
    set: (n, v) => { const e = frm.elements[n]; if (e) e.value = v; },
    rows: () => [...frm.querySelectorAll('#lbody .lr')],
    cell: (tr, c) => tr.querySelector(`[data-c="${c}"]`),
    setInfo: (tr, c, t) => { const e = tr.querySelector(`[data-c="${c}"][data-info]`); if (e) e.textContent = t; },
    setOptions: (n, pairs, sel, ph) => { const e = frm.elements[n]; if (e) e.innerHTML = optionsHtml(pairs, sel, ph); },
    setVisible: (n, visible) => { const e = frm.querySelector(`[data-field="${n}"]`); if (e) e.style.display = visible ? '' : 'none'; }
  };
  const collect = () => {
    const values = {};
    for (const f of spec.fields || []) values[f.n] = api.val(f.n);
    if (L) values.lines = api.rows().map(tr => { const o = {}; tr.querySelectorAll('[data-c]:not([data-info])').forEach(e => { o[e.dataset.c] = e.value; }); return o; })
      .filter(o => L.keyCol ? o[L.keyCol] !== '' : Object.values(o).some(v => v !== ''));
    return values;
  };
  const refresh = () => { if (!spec.summary) return; const b = $('#sumbox'); try { const h = spec.summary(collect(), api); b.hidden = !h; b.innerHTML = h || ''; } catch (e) { b.hidden = true; } };
  frm.oninput = frm.onchange = e => { if (spec.onInput) try { spec.onInput(e.target, api); } catch (x) { console.warn(x); } refresh(); };
  frm.onclick = e => {
    if (e.target.id === 'addLine') { $('#lbody').insertAdjacentHTML('beforeend', lineRowHtml(L.cols, {})); refresh(); }
    if (e.target.classList.contains('rm')) { const rows = api.rows(); if (rows.length > 1) e.target.closest('tr').remove(); else e.target.closest('tr').querySelectorAll('input,select').forEach(x => { x.value = ''; }); refresh(); }
  };
  $('#cx').onclick = () => dlg.close();
  frm.onsubmit = async e => {
    e.preventDefault();
    const err = $('#ferr'); err.textContent = '';
    let built; try { built = spec.build(collect(), api); } catch (x) { built = { error: x.message }; }
    if (!built || built.error) { err.textContent = (built && built.error) || 'تعذّر تجهيز البيانات.'; return; }
    const btns = frm.querySelectorAll('button'); btns.forEach(b => { b.disabled = true; }); err.textContent = 'جارٍ التنفيذ والحفظ…';
    try {
      const r = await act(built.op, built.input, opId);
      if (!DB) return;
      dlg.close(); safeRoute();
      if (r.duplicate) { toast('هذه العملية سُجّلت مسبقًا ولم تتكرر.'); return; }
      const alerts = (r.result && r.result.alerts) || [];
      const msg = spec.ok ? spec.ok(r.result) : 'تم الحفظ';
      toast(msg + (alerts.length ? ' — ' + alerts.map(a => a.text).join(' | ') : ''), alerts.length ? 7000 : 2600);
      if (spec.after) spec.after(r.result);
    } catch (x) {
      if (!DB) return;
      btns.forEach(b => { b.disabled = false; });
      err.textContent = x && x.erp ? x.message : ('تعذّر الحفظ: ' + ((x && x.message) || 'خطأ غير معروف') + ' — لم يُطبَّق أي تغيير.');
    }
  };
  dlg.showModal(); refresh();
  return api;
}

async function quickAct(op, input, okMsg, confirmMsg) {
  if (!DB) return;
  if (confirmMsg && !confirm(confirmMsg)) return;
  try {
    const r = await act(op, input, newOpId()); if (!DB) return; safeRoute();
    const alerts = (r.result && r.result.alerts) || [];
    toast((okMsg || 'تم') + (alerts.length ? ' — ' + alerts.map(a => a.text).join(' | ') : ''), alerts.length ? 7000 : 2600);
    return r.result;
  } catch (x) { toast(x && x.erp ? x.message : 'تعذّر التنفيذ: ' + ((x && x.message) || '')); }
}

function showDoc(title, html) {
  const dlg = $('#dlg'); dlg.classList.add('wide');
  $('#frm').onsubmit = e => e.preventDefault(); $('#frm').oninput = $('#frm').onchange = $('#frm').onclick = null;
  $('#frm').innerHTML = `<div class="printable"><h2>${title}</h2><p class="muted">${esc((DB.settings && DB.settings.company) || 'الشركة')}</p>${html}</div><div class="tools noprint"><button type="button" id="pdoc">طباعة / حفظ PDF</button><button type="button" class="sec" id="cx">إغلاق</button></div>`;
  $('#cx').onclick = () => dlg.close(); $('#pdoc').onclick = () => printNode('dialog');
  dlg.showModal();
}
function printNode(kind) {
  document.body.classList.add(kind === 'dialog' ? 'print-dlg' : 'print-area');
  const done = () => { document.body.classList.remove('print-dlg', 'print-area'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done); setTimeout(done, 60000); print();
}
function downloadBlob(name, data, type) { const a = document.createElement('a'); const url = URL.createObjectURL(new Blob([data], { type })); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); }
const csvCell = v => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v) && isNaN(Number(v))) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
const matrixToCsv = m => m.map(r => r.map(csvCell).join(',')).join('\n');
const dateVal = d => String(d || '').slice(0, 10);
