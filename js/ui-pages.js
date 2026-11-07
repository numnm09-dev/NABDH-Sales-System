/* نبض ERP — صفحات الواجهة (1): لوحة التحكم، المبيعات، المشتريات */
const POCHIP = { 'مسودة': '', 'مُرسل': '', 'قيد الشحن': 'low', 'مستلم جزئيًا': 'low', 'مستلم': 'ok', 'ملغي': 'crit' };
const salePay = s => s.status === 'ملغي' ? ['ملغاة', 'crit'] : (E_.saleOutstanding(s) <= 0.005 ? ['مسددة', 'ok'] : (s.paid > 0 ? ['مسددة جزئيًا', 'low'] : ['غير مسددة', 'crit']));
const E_ = Engine;
const itemName = id => nm('items', id);
const pickItems = (type, extra) => activeItems(type).map(i => [i.id, itemLabel(i), extra ? extra(i) : '']);

/* ========== لوحة التحكم ========== */
/* ---------- فترات تحليلات لوحة التحكم ---------- */

function homeDateRange(period, today = localToday()) {
  const parts = String(today).split('-').map(Number);

  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) {
    throw new Error('تاريخ اليوم غير صالح');
  }

  const [year, month, day] = parts;
  const date = new Date(year, month - 1, day);

  let from;
  let to = new Date(year, month - 1, day);

  if (period === 'day') {
    from = new Date(year, month - 1, day);
  } else if (period === 'week') {
    const weekday = date.getDay();
    const daysSinceSaturday = (weekday + 1) % 7;
    from = new Date(year, month - 1, day - daysSinceSaturday);
  } else if (period === 'month') {
    from = new Date(year, month - 1, 1);
  } else if (period === 'year') {
    from = new Date(year, 0, 1);
  } else {
    from = new Date(year, month - 1, day - 6);
  }

  const toISO = d =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  return {
    from: toISO(from),
    to: toISO(to),
    period
  };
}

/* ========== تحليلات لوحة التحكم ========== */

function homeMoneyChart(rows, maxValue) {
  if (!rows.length) return '<p class="note">لا توجد بيانات في الفترة المحددة.</p>';

  return rows.map(x => {
    const width = Math.max(0, Math.min(100, x.value / maxValue * 100));

    return `
      <div class="bar">
        <span>${esc(x.label)}</span>
        <i style="width:${width}%"></i>
        <span>${money(x.value)}</span>
      </div>
    `;
  }).join('');
}

function homePeriodSales(period, today) {
  const range = homeDateRange(period, today);
  const sales = DB.sales.filter(s =>
    s.status !== 'ملغي' &&
    String(s.date || '') >= range.from &&
    String(s.date || '') <= range.to
  );

  const rows = new Map();

  sales.forEach(s => {
    const date = String(s.date || '');
    const value = Math.max(0, Number(s.total || 0) - Number(s.returned || 0));

    rows.set(date, (rows.get(date) || 0) + value);
  });

  let result = [];

  if (period === 'day') {
    result = [{ label: 'اليوم', value: rows.get(today) || 0 }];
  } else if (period === 'week') {
    for (let i = 0; i < 7; i++) {
      const d = new Date(
        Number(range.from.slice(0, 4)),
        Number(range.from.slice(5, 7)) - 1,
        Number(range.from.slice(8, 10)) + i
      );

      const key = [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0')
      ].join('-');

      result.push({ label: key.slice(5), value: rows.get(key) || 0 });
    }
  } else if (period === 'month') {
    const days = Number(range.to.slice(8, 10));

    for (let i = 1; i <= days; i++) {
      const key = range.to.slice(0, 7) + '-' + String(i).padStart(2, '0');
      result.push({ label: String(i), value: rows.get(key) || 0 });
    }
  } else {
    for (let m = 1; m <= 12; m++) {
      const prefix = range.to.slice(0, 4) + '-' + String(m).padStart(2, '0');
      let value = 0;

      rows.forEach((v, date) => {
        if (date.startsWith(prefix)) value += v;
      });

      result.push({
        label: new Date(Number(range.to.slice(0, 4)), m - 1, 1)
          .toLocaleDateString('ar-EG', { month: 'short' }),
        value
      });
    }
  }

  return result;
}

function homePeriodLabel(period) {
  return ({
    day: 'اليوم',
    week: 'هذا الأسبوع',
    month: 'هذا الشهر',
    year: 'هذه السنة'
  })[period] || 'هذا الأسبوع';
}

function homeDelayedOrders(today) {
  return DB.orders.filter(o => {
    if (!o.expectedDate) return false;
    if (['ملغي', 'مستلم'].includes(o.status)) return false;
    if (String(o.expectedDate) >= today) return false;

    const remaining = E_.toList(o.lines).reduce(
      (sum, line) => sum + Math.max(
        0,
        Number(line.qty || 0) - Number(line.receivedQty || 0)
      ),
      0
    );

    return remaining > 0;
  });
}

/* ========== لوحة التحكم الرئيسية ========== */

function pageHome() {
  const today = localToday();

  const period = ['day', 'week', 'month', 'year'].includes(UI.f.homePeriod)
    ? UI.f.homePeriod
    : 'week';

  const range = homeDateRange(period, today);
  const S = DB.settings;
  const k = Reports.dashboard(DB, today);

  const low = E_.lowStock(DB);
  const short = Reports.openDemand(DB).filter(x => x.shortage > 0);

  const st = DB.items
    .filter(i => i.type === 'raw' && i.active !== false)
    .map(i => ({ i, s: statusOf(i) }));

  const crit = st.filter(x => x.s.k === 'crit');
  const mx = Math.max(1, ...st.map(x => x.s.c || 0));

  const salesRows = homePeriodSales(period, today);
  const salesMax = Math.max(1, ...salesRows.map(x => x.value));

  const delayed = homeDelayedOrders(today);

  const periodSales = DB.sales
    .filter(s =>
      s.status !== 'ملغي' &&
      String(s.date || '') >= range.from &&
      String(s.date || '') <= range.to
    )
    .reduce(
      (sum, s) => sum + Number(s.total || 0) - Number(s.returned || 0),
      0
    );

  const pnl = Reports.pnl(DB, { from: range.from, to: range.to }) || {};

  const cash = Number(k.cash || 0);
  const receivables = Number(k.receivables || 0);
  const payables = Number(k.payables || 0);

  const rawValue = Number(k.inventoryRaw || 0);
  const finishedValue = Number(k.inventoryFinished || 0);

  const productionInProgress = DB.production.filter(p =>
    ['قيد التنفيذ', 'جارٍ التنفيذ', 'جاري التنفيذ'].includes(p.status)
  ).length;

  const productionDraft = DB.production.filter(p =>
    p.status === 'مسودة'
  ).length;

  const productionDone = DB.production.filter(p =>
    p.status === 'مكتمل' &&
    String(p.date || p.completedAt || '') >= range.from &&
    String(p.date || p.completedAt || '') <= range.to
  ).length;

  const periodButtons = [
    ['day', 'يومي'],
    ['week', 'أسبوعي'],
    ['month', 'شهري'],
    ['year', 'سنوي']
  ];

  const periodSalesValue = money(periodSales);

  return `
  <section class="hero">
    <div class="cover">
      ${esc(S.institute)}<br>
      إعداد الطالب: ${esc(S.student)}
      — تحت إشراف: ${esc(S.supervisor)}
    </div>

    <h1>نبض | ${esc(S.company || 'نظام ERP لمصنع العصائر والمشروبات')}</h1>

    <p>
      NABDH — إدارة المبيعات والمشتريات والمخازن والإنتاج والمحاسبة،
      وتحليل مخاطر سلسلة الإمداد.
    </p>

    <svg class="pulse" viewBox="0 0 400 40"
      preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 20h120l15-17 25 34 20-26 10 9h210"
        fill="none" stroke="currentColor" stroke-width="2"/>
    </svg>
  </section>

  <div class="box">
    <h2>تحليلات الأداء</h2>

    <p class="note">
      اختر الفترة لعرض المبيعات ومؤشرات الأداء المرتبطة بها.
    </p>

    <div class="tools">
      ${periodButtons.map(([value, label]) => `
        <button
          type="button"
          data-act="home-period"
          data-period="${value}"
          class="${period === value ? '' : 'sec'}"
          aria-pressed="${period === value}">
          ${label}
        </button>
      `).join('')}
    </div>

    <p class="note">
      الفترة المحددة: ${homePeriodLabel(period)}
      — من ${esc(range.from)} إلى ${esc(range.to)}
    </p>
  </div>

  <div class="grid">
    ${KPI(periodSalesValue, 'صافي المبيعات للفترة (ج)')}
    ${KPI(money(pnl.grossProfit || 0), 'مجمل الربح للفترة (ج)')}
    ${KPI(money(pnl.netProfit || 0), 'صافي الربح للفترة (ج)',
      Number(pnl.netProfit || 0) < 0 ? 'red' : '')}

    ${KPI(money(cash), 'رصيد الخزينة (ج)', cash < 0 ? 'red' : '')}
    ${KPI(money(receivables), 'ذمم العملاء (ج)')}
    ${KPI(money(payables), 'مستحقات الموردين (ج)')}

    ${KPI(money(rawValue), 'قيمة مخزون المواد الخام (ج)')}
    ${KPI(money(finishedValue), 'قيمة المنتجات التامة (ج)')}

    ${KPI(low.length, 'أصناف تحت الحد الأدنى', low.length ? 'amb' : '')}
    ${KPI(short.length, 'مواد ناقصة للإنتاج', short.length ? 'red' : '')}
    ${KPI(delayed.length, 'أوامر توريد متأخرة', delayed.length ? 'red' : '')}
    ${KPI(DB.orders.filter(o => E_.PO_OPEN.includes(o.status)).length,
      'أوامر شراء مفتوحة')}

    ${KPI(productionInProgress, 'إنتاج قيد التنفيذ')}
    ${KPI(productionDraft, 'مسودات الإنتاج')}
    ${KPI(productionDone, 'إنتاج مكتمل خلال الفترة')}
  </div>

  <div class="box">
    <h2>المبيعات — ${homePeriodLabel(period)}</h2>
    ${homeMoneyChart(salesRows, salesMax)}
  </div>

  <div class="box">
    <h2>تنبيهات المخزون والإنتاج</h2>

    ${low.map(i => `
      <p>
        ${chip('تحت الحد الأدنى', 'low')}
        <b>${esc(i.name)}</b>:
        الرصيد ${qfmt(i.qty)} ${esc(i.unit || '')}
        (الحد الأدنى ${qfmt(i.min)}).
        <a href="#inventory/stock">المخزون</a>
      </p>
    `).join('')}

    ${short.map(x => `
      <p>
        ${chip('نقص للإنتاج', 'crit')}
        <b>${esc(itemName(x.itemId))}</b>:
        المطلوب ${qfmt(x.required)}
        والمتاح ${qfmt(x.available)}
        والعجز ${qfmt(x.shortage)}.
        <a href="#purchasing/orders">إنشاء أمر شراء</a>
      </p>
    `).join('')}

    ${crit.map(({ i, s }) => `
      <p>
        ${tag(s)}
        <b>${esc(i.name)}</b>:
        يكفي ${fmt(s.c)} يوم
        والشحنة بعد ${fmt(K.arr(i))} يوم.
        <a href="#risk" data-risk="${esc(i.id)}">تحليل البدائل</a>
      </p>
    `).join('')}

    ${!(low.length + short.length + crit.length)
      ? '<p>لا توجد تنبيهات حالية.</p>'
      : ''}
  </div>

  <div class="box">
    <h2>تأخيرات الموردين</h2>

    ${delayed.length
      ? delayed.map(o => {
          const remaining = E_.toList(o.lines).reduce(
            (sum, line) => sum + Math.max(
              0,
              Number(line.qty || 0) - Number(line.receivedQty || 0)
            ),
            0
          );

          return `
            <p>
              ${chip('متأخر', 'crit')}
              <b>${esc(o.no || o.id)}</b>
              — المورد: ${esc(nm('suppliers', o.supplierId))}
              — المتوقع: ${esc(o.expectedDate)}
              — الحالة: ${esc(o.status)}
              — الكمية المتبقية: ${qfmt(remaining)}
              <a href="#purchasing/orders">أوامر الشراء</a>
            </p>
          `;
        }).join('')
      : '<p>لا توجد أوامر توريد متأخرة وفق تواريخ التوريد المسجلة.</p>'
    }
  </div>

  <div class="box">
    <h2>أيام تغطية المواد الخام</h2>

    ${st.map(({ i, s }) => `
      <div class="bar">
        <span>${esc(i.name)}</span>
        <i class="${s.k}"
          style="width:${Math.max(2, (s.c || 0) / mx * 60)}%">
        </i>
        <span>${fmt(s.c)} يوم — ${esc(s.t)}</span>
      </div>
    `).join('') || '<p>لا توجد مواد خام.</p>'}
  </div>

  <div class="tools">
    <button data-act="new-invoice">+ فاتورة بيع</button>
    <button data-act="new-po" class="sec">+ أمر شراء</button>
    <button data-act="new-production" class="sec">+ أمر إنتاج</button>
    <button data-act="v-receipt" class="sec">+ سند استلام</button>
    <button data-act="new-expense" class="sec">+ مصروف</button>
  </div>

  <div class="note">
    جميع المؤشرات مبنية على البيانات المسجلة في نظام نبض.
    قيمة المخزون والأرصدة تعكس الوضع الحالي، بينما المبيعات والأرباح
    مرتبطة بالفترة المختارة. توصيات المخاطر استرشادية والقرار النهائي للإدارة.
  </div>
  `;
}

function openInvoice() {
  const fg = activeWhs('finished');
  if (!fg.length) return toast('أنشئ مخزن منتجات تامة أولًا من صفحة المخازن.');
  if (!activeItems('finished').length) return toast('لا توجد منتجات تامة. أضفها من «المخازن ← الأرصدة والأصناف» بنوع «منتج تام».');

  const info = (api, tr) => {
    const id = api.cell(tr, 'itemId').value;
    api.setInfo(tr, 'avail', id ? qfmt(E_.stockOf(DB, id, api.val('whId'))) : '');
  };

  openDoc({
    title: 'فاتورة بيع جديدة',
    wide: true,
    submit: 'تأكيد الفاتورة وخصم المخزون',
    intro: 'يُخصم المنتج التام تلقائيًا من المخزن المحدد بمتوسط التكلفة المتحرك، ولا يُسمح برصيد سالب.',
    fields: [
      { n: 'customerId', l: 'العميل', t: 'select', opts: DB.customers.map(c => [c.id, `${c.name} (مستحق ${money(E_.arBalance(DB, c.id))})`]), ph: 'عميل عابر (دفع كامل)' },
      { n: 'customerName', l: 'اسم العميل العابر (اختياري)', t: 'text' },
      { n: 'whId', l: 'مخزن المنتجات التامة', t: 'select', opts: fg.map(w => [w.id, w.name]), val: fg[0].id, req: true },
      { n: 'date', l: 'التاريخ', t: 'date', val: localToday(), req: true },
      { n: 'discount', l: 'الخصم (ج)', t: 'number', val: '' },
      { n: 'paid', l: 'المدفوع الآن (ج)', t: 'number', val: '', hint: 'فارغ: العميل العابر يدفع الكل، والمسجّل يُسجَّل آجلًا.' },
      { n: 'method', l: 'طريقة الدفع', t: 'select', opts: E_.PAY_METHODS.map(x => [x, x]), val: 'نقدي' },
      { n: 'note', l: 'ملاحظات', t: 'textarea' }
    ],
    lines: {
      keyCol: 'itemId',
      addLabel: 'إضافة صنف',
      cols: [
        { n: 'itemId', l: 'المنتج', t: 'select', opts: pickItems('finished', i => `data-price="${Number(i.salePrice) || Number(i.price) || ''}"`), ph: 'اختر…' },
        { n: 'avail', l: 'المتاح', t: 'info' },
        { n: 'qty', l: 'الكمية' },
        { n: 'unitPrice', l: 'سعر الوحدة' }
      ]
    },
    onInput: (el, api) => {
      if (el.dataset.c === 'itemId') {
        const tr = el.closest('tr');
        const o = el.selectedOptions[0];
        const p = api.cell(tr, 'unitPrice');
        if (o && o.dataset.price && !p.value) p.value = o.dataset.price;
        info(api, tr);
      }
      if (el.name === 'whId') api.rows().forEach(tr => info(api, tr));
      if (el.name === 'customerId') api.set('customerName', '');
    },
    summary: v => {
      const g = v.lines.reduce((n, l) => n + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
      const d = Number(v.discount) || 0;
      const t = Math.max(0, g - d);
      const paid = v.paid === '' ? (v.customerId ? 0 : t) : Number(v.paid) || 0;
      return `الإجمالي: <b>${money(g)}</b> — الخصم: ${money(d)} — الصافي: <b>${money(t)}</b> — المدفوع: ${money(paid)} — المتبقي آجل: <b>${money(Math.max(0, t - paid))}</b>`;
    },
    build: v => ({
      op: 'createInvoice',
      input: {
        whId: v.whId,
        customerId: v.customerId,
        customerName: v.customerName,
        date: v.date,
        discount: v.discount,
        paid: v.paid,
        method: v.method,
        note: v.note,
        lines: v.lines.map(l => ({ itemId: l.itemId, qty: l.qty, unitPrice: l.unitPrice }))
      }
    }),
    ok: r => `تم إصدار الفاتورة ${r.no} وخصم المخزون`
  });
}

function viewInvoice(id) {
  const s = DB.sales.find(x => x.id === id);
  if (!s) return;

  const rows = (s.lines || []).map(l =>
    ROW([esc(itemName(l.itemId)), qfmt(l.qty), money(l.unitPrice), money(l.net), l.returnedQty ? qfmt(l.returnedQty) : '—'])
  );

  showDoc(`فاتورة ${esc(s.no || s.id)}${s.status === 'ملغي' ? ' (ملغاة)' : ''}`, `<p>التاريخ: ${esc(dateVal(s.date))} — العميل: ${esc(s.customerName || s.customer || 'عميل عابر')} — المخزن: ${esc(nm('warehouses', s.whId))}</p>
  ${s.legacy ? '<p class="note">فاتورة قديمة مُرحَّلة: بلا تفاصيل تكلفة.</p>' : ''}${TBL(['الصنف', 'الكمية', 'سعر الوحدة', 'الصافي', 'المرتجع'], rows)}
  <p>الخصم: ${money(s.discount || 0)} — الإجمالي: <b>${money(s.total)}</b> — المرتجع: ${money(s.returned || 0)} — المدفوع: ${money(s.paid || 0)} — المتبقي: <b>${s.status === 'ملغي' ? '—' : money(E_.saleOutstanding(s))}</b></p>
  ${s.note ? `<p>ملاحظات: ${esc(s.note)}</p>` : ''}${s.cancelReason ? `<p>سبب الإلغاء: ${esc(s.cancelReason)}</p>` : ''}`);
}

function openReturn(saleId) {
  const s = DB.sales.find(x => x.id === saleId);
  if (!s) return;

  const rows = (s.lines || []).map(l => {
    const room = E_.r3(l.qty - (l.returnedQty || 0));
    return {
      itemId: l.itemId,
      sold: `${qfmt(l.qty)} / متاح للإرجاع ${qfmt(room)}`,
      qty: '',
      _opts: { itemId: [[l.itemId, itemName(l.itemId)]] }
    };
  });

  const fg = activeWhs('finished');

  openDoc({
    title: `مرتجع على الفاتورة ${esc(s.no)}`,
    wide: true,
    submit: 'تسجيل المرتجع',
    intro: 'المرتجع الصالح يعود للمخزون بتكلفته الأصلية. يُخصم أولًا من المتبقي على العميل، والباقي يُرد نقدًا (ويُرفض إن لم يكفِ رصيد الخزينة).',
    fields: [
      { n: 'date', l: 'التاريخ', t: 'date', val: localToday(), req: true },
      { n: 'restock', l: 'المنتج صالح ويعود للمخزون', t: 'check', val: true },
      { n: 'whId', l: 'مخزن الإرجاع', t: 'select', opts: fg.map(w => [w.id, w.name]), val: s.whId },
      { n: 'refundMethod', l: 'طريقة رد المبلغ (إن وُجد)', t: 'select', opts: E_.PAY_METHODS.map(x => [x, x]), val: 'نقدي' },
      { n: 'note', l: 'السبب / ملاحظات', t: 'textarea' }
    ],
    lines: {
      fixed: true,
      keyCol: 'qty',
      cols: [
        { n: 'itemId', l: 'الصنف', t: 'select' },
        { n: 'sold', l: 'المباع', t: 'info' },
        { n: 'qty', l: 'كمية المرتجع' }
      ],
      rows
    },
    build: v => ({
      op: 'createReturn',
      input: {
        saleId,
        date: v.date,
        restock: v.restock,
        whId: v.whId,
        refundMethod: v.refundMethod,
        note: v.note,
        lines: v.lines.map(l => ({ itemId: l.itemId, qty: l.qty }))
      }
    }),
    ok: r => `تم تسجيل المرتجع ${r.no}`
  });
}

function salesCustomers() {
  const rows = DB.customers.filter(c => matches('cus', c));

  return `<div class="tools">${SEARCH('cus')}<button data-act="new-customer">+ عميل جديد</button></div>
  ${TBL(['العميل', 'الهاتف', 'العنوان', 'حد الائتمان', 'المستحق', 'الفواتير', ''], rows.map(c => ROW([esc(c.name), esc(c.phone || '—'), esc(c.address || '—'), c.creditLimit ? money(c.creditLimit) : 'بلا حد', money(E_.arBalance(DB, c.id)), DB.sales.filter(s => s.customerId === c.id && s.status !== 'ملغي').length, BTN('edit-customer', c.id, 'تعديل') + BTN('collect', c.id, 'تحصيل') + BTN('del-customer', c.id, 'حذف', 'del')])), 'لا يوجد عملاء. أضف عميلًا لتتمكن من البيع الآجل.')}`;
}

function openCustomer(id) {
  const c = id ? DB.customers.find(x => x.id === id) : {};

  openDoc({
    title: id ? 'تعديل عميل' : 'عميل جديد',
    fields: [
      { n: 'name', l: 'اسم العميل', req: true, val: c.name },
      { n: 'phone', l: 'الهاتف', val: c.phone },
      { n: 'address', l: 'العنوان', val: c.address },
      { n: 'creditLimit', l: 'حد الائتمان (ج، 0 = بلا حد)', t: 'number', val: c.creditLimit || '' }
    ],
    build: v => ({ op: 'upsertCustomer', input: { id, ...v } }),
    ok: () => 'تم حفظ العميل'
  });
}

function salesReturns() {
  const rets = [...DB.returns].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const elig = DB.sales.filter(s => s.status === 'مؤكد' && !s.legacy && (s.lines || []).some(l => l.qty - (l.returnedQty || 0) > 1e-9));

  return `<div class="box"><h3>المرتجعات المسجّلة</h3>${TBL(['الرقم', 'التاريخ', 'الفاتورة', 'القيمة', 'مردود نقدًا', 'عاد للمخزون'], rets.map(r => ROW([esc(r.no), esc(r.date), esc(r.saleNo), money(r.total), money(r.refund), r.restock ? 'نعم' : 'لا (تالف)'])), 'لا توجد مرتجعات.')}</div>
  <div class="box"><h3>فواتير يمكن إرجاع أصناف منها</h3>${TBL(['الفاتورة', 'التاريخ', 'العميل', 'الإجمالي', ''], elig.map(s => ROW([esc(s.no), esc(dateVal(s.date)), esc(s.customerName || 'عميل عابر'), money(s.total), BTN('new-return', s.id, 'مرتجع')])), 'لا توجد فواتير قابلة للإرجاع.')}</div>`;
}

function salesCollections() {
  const cols = [...DB.collections].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  return `<div class="tools"><button data-act="collect">+ تحصيل من عميل</button></div>
  ${TBL(['الرقم', 'التاريخ', 'العميل', 'المبلغ', 'الطريقة', 'الفواتير المسددة'], cols.map(c => ROW([esc(c.no), esc(c.date), esc(nm('customers', c.customerId)), money(c.amount), esc(c.method), esc(toListSafe(c.allocations).map(a => `${a.saleNo}: ${money(a.amount)}`).join('، '))])), 'لا توجد تحصيلات.')}`;
}

const toListSafe = v => E_.toList(v);

function openCollect(customerId) {
  const dues = DB.customers.map(c => [c, E_.arBalance(DB, c.id)]).filter(x => x[1] > 0.005);
  if (!dues.length) return toast('لا توجد مبالغ مستحقة على أي عميل.');

  const invOpts = cid => [['', 'الأقدم أولًا (توزيع تلقائي)']].concat(DB.sales.filter(s => s.customerId === cid && s.status === 'مؤكد' && E_.saleOutstanding(s) > 0.005).map(s => [s.id, `${s.no} — متبقٍ ${money(E_.saleOutstanding(s))}`]));
  const first = (customerId && dues.find(x => x[0].id === customerId)) ? customerId : dues[0][0].id;

  openDoc({
    title: 'تحصيل من عميل',
    submit: 'تسجيل التحصيل',
    fields: [
      { n: 'customerId', l: 'العميل', t: 'select', opts: dues.map(([c, b]) => [c.id, `${c.name} (مستحق ${money(b)})`]), val: first, req: true },
      { n: 'saleId', l: 'الفاتورة', t: 'select', opts: invOpts(first), val: '' },
      { n: 'amount', l: 'المبلغ (ج)', t: 'number', req: true, min: 0.01 },
      { n: 'method', l: 'طريقة الدفع', t: 'select', opts: E_.PAY_METHODS.map(x => [x, x]), val: 'نقدي' },
      { n: 'date', l: 'التاريخ', t: 'date', val: localToday(), req: true },
      { n: 'note', l: 'ملاحظات', t: 'textarea' }
    ],
    onInput: (el, api) => {
      if (el.name === 'customerId') api.setOptions('saleId', invOpts(el.value), '');
    },
    build: v => ({ op: 'collectPayment', input: v }),
    ok: r => `تم التحصيل ${r.no}`
  });
}

/* ========== المشتريات ========== */

const PUR_TABS = {
  orders: 'أوامر الشراء',
  receipts: 'استلام البضاعة',
  suppliers: 'الموردون',
  payments: 'مدفوعات الموردين'
};

function pagePurchasing(tab) {
  tab = PUR_TABS[tab] ? tab : 'orders';
  return `<h2>المشتريات والموردون</h2>${TABS('purchasing', PUR_TABS, tab)}` +
    ({ orders: purOrders, receipts: purReceipts, suppliers: purSuppliers, payments: purPayments })[tab]();
}

const poRecv = o => {
  const ls = E_.toList(o.lines);
  const q = ls.reduce((s, l) => s + l.qty, 0);
  const r = ls.reduce((s, l) => s + (l.receivedQty || 0), 0);
  return q ? Math.round(r / q * 100) : 0;
};

function purOrders() {
  const rows = [...DB.orders]
    .filter(o => matches('po', o) && (!UI.f.post || o.status === UI.f.post))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  const open = DB.orders.filter(o => E_.PO_OPEN.includes(o.status));

  const act = o => {
    const b = [BTN('view-po', o.id, 'عرض')];
    const lg = o.legacy;

    if (o.status === 'مسودة') {
      b.push(BTN('edit-po', o.id, 'تعديل'), BTN('po-status:مُرسل', o.id, 'اعتماد وإرسال'), BTN('po-status:ملغي', o.id, 'إلغاء', 'del'));
    }

    if (o.status === 'مُرسل') {
      b.push(BTN('receive-po', o.id, 'استلام'), BTN('po-status:قيد الشحن', o.id, 'قيد الشحن'), BTN('po-status:ملغي', o.id, 'إلغاء', 'del'));
    }

    if (o.status === 'قيد الشحن') {
      b.push(BTN('receive-po', o.id, 'استلام'), BTN('po-status:ملغي', o.id, 'إلغاء', 'del'));
    }

    if (o.status === 'مستلم جزئيًا') {
      b.push(BTN('receive-po', o.id, 'استلام المتبقي'));
    }

    if (['مسودة', 'ملغي'].includes(o.status)) {
      b.push(BTN('del-po', o.id, 'حذف', 'del'));
    }

    void lg;
    return b.join('');
  };

  return `<div class="grid">${KPI(open.length, 'أوامر مفتوحة')}${KPI(money(open.reduce((s, o) => s + (o.total || 0), 0)), 'قيمة الأوامر المفتوحة (ج)')}</div>
  <div class="tools">${SEARCH('po')}${FSEL('post', E_.PO_ALL.map(x => [x, x]), 'كل الحالات')}<button data-act="new-po">+ أمر شراء جديد</button></div>
  ${TBL(['الرقم', 'التاريخ', 'المورد', 'الأصناف', 'القيمة', 'الاستلام', 'الحالة', ''], rows.map(o => ROW([esc(o.no || o.id) + (o.legacy ? ' ' + chip('قديم', 'nodata') : '') + (o.source === 'risk-analysis' ? ' ' + chip('من تحليل المخاطر', 'low') : ''), esc(o.date || '—'), esc(nm('suppliers', o.supplierId)), esc(E_.toList(o.lines).map(l => itemName(l.itemId)).join('، ')), money(o.total != null ? o.total : E_.toList(o.lines).reduce((s, l) => s + l.qty * l.price, 0)), poRecv(o) + '%', chip(o.status, POCHIP[o.status] || ''), act(o)])), 'لا توجد أوامر شراء.')}`;
}

function openPO(id, preset) {
  if (!DB.suppliers.length) return toast('أضف موردًا أولًا من تبويب «الموردون».');
  if (!activeItems().length) return toast('لا توجد أصناف. أضفها من «المخازن».');

  const o = id ? DB.orders.find(x => x.id === id) : null;
  const rows = o
    ? E_.toList(o.lines).map(l => ({ itemId: l.itemId, qty: l.qty, price: l.price }))
    : (preset && preset.lines) || [];

  openDoc({
    title: o ? `تعديل أمر الشراء ${esc(o.no)}` : 'أمر شراء جديد',
    wide: true,
    submit: o ? 'حفظ التعديل' : 'حفظ كمسودة',
    intro: 'يُحفظ الأمر كمسودة ولا يؤثر على المخزون. بعد الاعتماد يمكن استلام البضاعة (كلّيًا أو جزئيًا).',
    fields: [
      { n: 'supplierId', l: 'المورد', t: 'select', opts: DB.suppliers.map(s => [s.id, s.name]), val: o ? o.supplierId : (preset && preset.supplierId) || '', ph: 'اختر المورد', req: true },
      { n: 'date', l: 'التاريخ', t: 'date', val: o ? o.date : localToday(), req: true },
      { n: 'expectedDate', l: 'تاريخ التوريد المتوقع', t: 'date', val: o ? o.expectedDate : '' },
      { n: 'note', l: 'ملاحظات', t: 'textarea', val: o ? o.note : '' }
    ],
    lines: {
      keyCol: 'itemId',
      addLabel: 'إضافة صنف',
      rows,
      cols: [
        { n: 'itemId', l: 'الصنف', t: 'select', opts: pickItems(null, i => `data-price="${Number(i.lastCost) || Number(i.price) || ''}"`), ph: 'اختر…' },
        { n: 'qty', l: 'الكمية' },
        { n: 'price', l: 'سعر الوحدة' }
      ]
    },
    onInput: el => {
      if (el.dataset.c === 'itemId') {
        const p = el.closest('tr').querySelector('[data-c="price"]');
        const op = el.selectedOptions[0];
        if (op && op.dataset.price && !p.value) p.value = op.dataset.price;
      }
    },
    summary: v => `إجمالي الأمر: <b>${money(v.lines.reduce((n, l) => n + (Number(l.qty) || 0) * (Number(l.price) || 0), 0))}</b>`,
    build: v => ({
      op: o ? 'updatePO' : 'createPO',
      input: {
        id,
        supplierId: v.supplierId,
        date: v.date,
        expectedDate: v.expectedDate,
        note: v.note,
        source: preset && preset.source,
        lines: v.lines.map(l => ({ itemId: l.itemId, qty: l.qty, price: l.price }))
      }
    }),
    ok: r => `تم حفظ أمر الشراء ${r.no}`
  });
}

function viewPO(id) {
  const o = DB.orders.find(x => x.id === id);
  if (!o) return;

  const ls = E_.toList(o.lines);
  const rcs = DB.receipts.filter(r => r.poId === o.id);

  showDoc(`أمر شراء ${esc(o.no || o.id)}`, `<p>المورد: ${esc(nm('suppliers', o.supplierId))} — التاريخ: ${esc(o.date || '—')} — الحالة: ${esc(o.status)}${o.expectedDate ? ' — التوريد المتوقع: ' + esc(o.expectedDate) : ''}</p>
  ${TBL(['الصنف', 'الكمية', 'المستلم', 'السعر', 'القيمة'], ls.map(l => ROW([esc(itemName(l.itemId)), qfmt(l.qty), qfmt(l.receivedQty || 0), money(l.price), money(l.qty * l.price)])))}
  <p>الإجمالي: <b>${money(ls.reduce((s, l) => s + l.qty * l.price, 0))}</b></p>${rcs.length ? `<h3>الاستلامات</h3>${TBL(['الرقم', 'التاريخ', 'المخزن', 'القيمة'], rcs.map(r => ROW([esc(r.no), esc(r.date), esc(nm('warehouses', r.whId)), money(r.total)])))}` : ''}${o.note ? `<p>ملاحظات: ${esc(o.note)}</p>` : ''}`);
}

function openReceive(poId) {
  const o = DB.orders.find(x => x.id === poId);
  if (!o) return;

  const rows = E_.toList(o.lines)
    .map(l => ({ l, rem: E_.r3(l.qty - (l.receivedQty || 0)) }))
    .filter(x => x.rem > 0)
    .map(({ l, rem }) => ({
      itemId: l.itemId,
      rem: `${qfmt(rem)} (سعر الأمر ${money(l.price)})`,
      qty: rem,
      unitCost: '',
      _opts: { itemId: [[l.itemId, itemName(l.itemId)]] }
    }));

  if (!rows.length) return toast('لا توجد كميات متبقية للاستلام.');

  const kinds = new Set(E_.toList(o.lines).map(l => whKindOf((DB.items.find(i => i.id === l.itemId) || {}).type)));
  const whs = activeWhs(kinds.size === 1 ? [...kinds][0] : null);

  openDoc({
    title: `استلام بضاعة على ${esc(o.no)}`,
    wide: true,
    submit: 'تأكيد الاستلام',
    intro: 'الاستلام يزيد رصيد المخزن ويُسجَّل في دفتر الحركة، ويُنشئ مستحقًا للمورد (ذمة دائنة) بقيمة المستلم. الكمية لا تتجاوز المتبقي في الأمر.',
    fields: [
      { n: 'whId', l: 'المخزن', t: 'select', opts: whs.map(w => [w.id, w.name]), val: whs[0] && whs[0].id, req: true },
      { n: 'date', l: 'التاريخ', t: 'date', val: localToday(), req: true },
      { n: 'note', l: 'ملاحظات (رقم إذن/فاتورة المورد)', t: 'textarea' }
    ],
    lines: {
      fixed: true,
      keyCol: 'qty',
      rows,
      cols: [
        { n: 'itemId', l: 'الصنف', t: 'select' },
        { n: 'rem', l: 'المتبقي', t: 'info' },
        { n: 'qty', l: 'الكمية المستلمة' },
        { n: 'unitCost', l: 'تكلفة فعلية (اختياري)' }
      ]
    },
    build: v => ({
      op: 'receiveGoods',
      input: {
        poId,
        whId: v.whId,
        date: v.date,
        note: v.note,
        lines: v.lines.map(l => ({ itemId: l.itemId, qty: l.qty, unitCost: l.unitCost }))
      }
    }),
    ok: r => `تم الاستلام ${r.no}`
  });
}

function purReceipts() {
  const rs = [...DB.receipts].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  return `<p class="note">الاستلام يتم من أمر شراء معتمد (تبويب «أوامر الشراء» ← استلام).</p>${TBL(['الرقم', 'التاريخ', 'أمر الشراء', 'المورد', 'المخزن', 'القيمة', 'البنود'], rs.map(r => ROW([esc(r.no), esc(r.date), esc(r.poNo), esc(nm('suppliers', r.supplierId)), esc(nm('warehouses', r.whId)), money(r.total), esc(E_.toList(r.lines).map(l => `${itemName(l.itemId)} × ${qfmt(l.qty)}`).join('، '))])), 'لا توجد استلامات.')}`;
}

function purSuppliers() {
  const rows = DB.suppliers.filter(s => matches('sup', s));

  return `<div class="tools">${SEARCH('sup')}<button data-act="new-supplier">+ مورد جديد</button></div>
  ${TBL(['المورد', 'أكواد الأصناف', 'السعر', 'المدة (يوم)', 'الجودة', 'الحد الأدنى', 'التحقق', 'المستحق له', ''], rows.map(s => ROW([esc(s.name), esc(s.itemCodes || '—'), s.price === '' ? '—' : money(s.price), fmt(s.lead), fmt(s.quality), fmt(s.moq), chip(s.verified || 'تجريبي', s.verified === 'تم التحقق' ? 'ok' : 'low'), money(E_.apBalance(DB, s.id)), BTN('edit-supplier', s.id, 'تعديل') + BTN('pay-supplier', s.id, 'سداد') + BTN('del-supplier', s.id, 'حذف', 'del')])), 'لا يوجد موردون.')}`;
}

function openSupplier(id) {
  const s = id ? DB.suppliers.find(x => x.id === id) : {};

  openDoc({
    title: id ? 'تعديل مورد' : 'مورد جديد',
    fields: [
      { n: 'name', l: 'اسم المورد', req: true, val: s.name },
      { n: 'itemCodes', l: 'أكواد الأصناف (مفصولة بفاصلة)', val: s.itemCodes },
      { n: 'price', l: 'السعر', t: 'number', val: s.price },
      { n: 'lead', l: 'مدة التوريد (أيام)', t: 'number', val: s.lead },
      { n: 'quality', l: 'الجودة (1–5)', t: 'number', val: s.quality, min: 1, max: 5 },
      { n: 'moq', l: 'الحد الأدنى للطلب', t: 'number', val: s.moq },
      { n: 'contact', l: 'بيانات الاتصال', val: s.contact },
      { n: 'verified', l: 'حالة التحقق', t: 'select', opts: VER.map(x => [x, x]), val: s.verified || 'تجريبي' }
    ],
    build: v => ({ op: 'upsertSupplier', input: { id, ...v } }),
    ok: () => 'تم حفظ المورد'
  });
}

function purPayments() {
  const ps = [...DB.payments].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  return `<div class="tools"><button data-act="pay-supplier">+ سداد لمورد</button></div>${TBL(['الرقم', 'التاريخ', 'المورد', 'الطريقة', 'المبلغ', 'ملاحظة'], ps.map(p => ROW([esc(p.no), esc(p.date), esc(nm('suppliers', p.supplierId)), esc(p.method), money(p.amount), esc(p.note || '')])), 'لا توجد مدفوعات.')}`;
}

function openPaySupplier(supplierId) {
  const dues = DB.suppliers.map(s => [s, E_.apBalance(DB, s.id)]).filter(x => x[1] > 0.005);
  if (!dues.length) return toast('لا توجد مستحقات للموردين.');

  openDoc({
    title: 'سداد لمورد',
    submit: 'تسجيل السداد',
    intro: `رصيد الخزينة الحالي: ${money(E_.cashBalance(DB))} ج — لا يُسمح بسداد أكبر من المستحق أو من رصيد الخزينة.`,
    fields: [
      { n: 'supplierId', l: 'المورد', t: 'select', opts: dues.map(([s, b]) => [s.id, `${s.name} (مستحق ${money(b)})`]), val: (dues.find(x => x[0].id === supplierId) || dues[0])[0].id, req: true },
      { n: 'amount', l: 'المبلغ (ج)', t: 'number', req: true, min: 0.01 },
      { n: 'method', l: 'طريقة الدفع', t: 'select', opts: E_.PAY_METHODS.map(x => [x, x]), val: 'نقدي' },
      { n: 'date', l: 'التاريخ', t: 'date', val: localToday(), req: true },
      { n: 'note', l: 'ملاحظات', t: 'textarea' }
    ],
    build: v => ({ op: 'paySupplier', input: v }),
    ok: r => `تم السداد ${r.no}`
  });
}

/* ========== أوامر الأزرار (المبيعات والمشتريات) ========== */

Object.assign(UI.actions, {
  'new-invoice': () => openInvoice(),
  'view-invoice': id => viewInvoice(id),
  'new-return': id => openReturn(id),

  'cancel-invoice': id => {
    const s = DB.sales.find(x => x.id === id);
    if (!s) return;

    const r = prompt(`سبب إلغاء الفاتورة ${s.no || ''} (سيُعاد المخزون وتُعكس القيود):`, '');
    if (r === null) return;
    if (r.trim().length < 2) return toast('سبب الإلغاء مطلوب.');

    quickAct('cancelInvoice', { id, reason: r.trim() }, 'تم إلغاء الفاتورة وإرجاع المخزون');
  },

  'new-customer': () => openCustomer(),
  'edit-customer': id => openCustomer(id),
  'del-customer': id => quickAct('deleteCustomer', { id }, 'تم حذف العميل', 'حذف هذا العميل نهائيًا؟'),
  'collect': id => openCollect(id),

  'new-po': () => openPO(),
  'edit-po': id => openPO(id),
  'view-po': id => viewPO(id),
  'receive-po': id => openReceive(id),
  'del-po': id => quickAct('deletePO', { id }, 'تم حذف أمر الشراء', 'حذف أمر الشراء نهائيًا؟'),

  'new-supplier': () => openSupplier(),
  'edit-supplier': id => openSupplier(id),
  'del-supplier': id => quickAct('deleteSupplier', { id }, 'تم حذف المورد', 'حذف هذا المورد نهائيًا؟'),
  'pay-supplier': id => openPaySupplier(id)
});

// تغيير فترة تحليلات لوحة التحكم
UI.actions['home-period'] = (id, b) => {
  UI.f.homePeriod = b.dataset.period;
  safeRoute();
};

// أزرار تغيير حالة أمر الشراء
['مُرسل', 'قيد الشحن', 'ملغي'].forEach(st => {
  UI.actions['po-status:' + st] = id =>
    quickAct(
      'setPOStatus',
      { id, status: st },
      'تم تحديث حالة الأمر إلى «' + st + '»',
      st === 'ملغي'
        ? 'إلغاء أمر الشراء؟'
        : (st === 'مُرسل' ? 'اعتماد وإرسال الأمر للمورد؟' : null)
    );
});
