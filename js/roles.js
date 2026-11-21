/* نبض — الأدوار والصلاحيات (مصدر واحد للخادم والمتصفح).
   الفرض الحقيقي يتم على الخادم: (1) أي عمليات مسموحة للدور (canRunOp) و(2) أي بيانات تُرسَل له (project).
   الواجهة تستعمل pagesFor فقط لإخفاء الأقسام؛ إخفاؤها ليس حماية بحد ذاته. */
(function (root, f) { const R = f(); if (typeof module === 'object') module.exports = R; else root.Roles = R; })(this, function () {
  'use strict';

  const ALL = '*';

  const ROLES = {
    MANAGER: { label: 'مدير الشركة', pages: ALL, ops: ALL, data: ALL },

    HR: {
      label: 'الموارد البشرية',
      pages: ['hr'],
      ops: ['upsertEmployee', 'terminateEmployee', 'deleteEmployee', 'recordAttendance', 'requestLeave', 'decideLeave', 'preparePayroll', 'approvePayroll'],
      data: ['employees', 'attendance', 'leaves', 'payroll']
    },

    ACCOUNTANT: {
      label: 'محاسب',
      pages: ['accounting'],
      ops: ['recordExpense', 'cashEntry', 'paySupplier', 'collectPayment', 'postPayroll'],
      // كشف الرواتب يصل للمحاسب كرؤوس فقط (بلا أسطر الموظفين) لغرض الترحيل.
      data: ['journal', 'expenses', 'cashEntries', 'payments', 'collections', 'sales', 'returns', 'orders', 'receipts', 'suppliers', 'customers', 'payroll:header']
    },

    WAREHOUSE: {
      label: 'أمين مخازن',
      pages: ['inventory'],
      ops: ['upsertItem', 'upsertWarehouse', 'receiptVoucher', 'issueVoucher', 'transferVoucher', 'adjustmentVoucher'],
      // قيود الأستاذ لا تصل إلا بأسطر حسابات المخزون (13xx) لحساب قيمة المخزون المعروضة في صفحته.
      data: ['items', 'warehouses', 'stock', 'ledger', 'vouchers', 'journal:inventory']
    },

    SALES: {
      label: 'مبيعات',
      pages: ['sales'],
      ops: ['upsertCustomer', 'createInvoice', 'collectPayment', 'createReturn'],
      // أسطر حساب الذمم المدينة 1200 فقط، لأن «المستحق على العميل» يُحسب من قيود الأستاذ.
      // حقول التكلفة (سعر الشراء، قيمة المخزون، تكلفة البضاعة المباعة) تُحذف من أصنافه وفواتيره فلا يحسب هامش الربح.
      data: ['items:nocost', 'warehouses', 'stock', 'customers', 'sales:nocost', 'returns:nocost', 'collections', 'journal:receivable']
    }
  };

  const STAFF_ROLES = ['HR', 'ACCOUNTANT', 'WAREHOUSE', 'SALES'];
  const ALL_ROLES = ['MANAGER', ...STAFF_ROLES];
  const LISTS = ['items', 'suppliers', 'orders', 'sales', 'warehouses', 'ledger', 'vouchers', 'boms', 'productions', 'receipts', 'customers', 'returns', 'payments', 'collections', 'expenses', 'cashEntries', 'journal', 'audit', 'aiDecisions', 'employees', 'attendance', 'leaves', 'payroll'];

  // قيود الأستاذ المحدودة بحسابات قسم معيّن (تصل أسطرها فقط)
  const JOURNAL_FILTERS = { inventory: /^13/, receivable: /^1200$/ };

  // حقول التكلفة التي لا تصل لدور المبيعات (تُحذف بصرف النظر عن عمقها داخل الفواتير والمرتجعات)
  const COST_KEYS = new Set(['cogs', 'cost', 'returnedCost', 'avgCost', 'unitCost', 'stockValue']);
  const omitCosts = v => {
    if (Array.isArray(v)) return v.map(omitCosts);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) if (!COST_KEYS.has(k)) o[k] = omitCosts(v[k]);
      return o;
    }
    return v;
  };
  // الأصناف: سعر الشراء `price` يُستبدل بسعر البيع (الصفحة تستعمله احتياطيًا لسعر البيع)، وتُحذف حقول التوريد والتكلفة.
  const saleItem = i => {
    const { id, code, name, type, unit, qty, min, salePrice, active } = i;
    return { id, code, name, type, unit, qty, min, salePrice, active, price: Number(salePrice) || 0 };
  };

  const has = Object.prototype.hasOwnProperty;
  const isRole = r => typeof r === 'string' && has.call(ROLES, r);
  const roleLabel = r => (isRole(r) ? ROLES[r].label : 'غير معروف');

  function canRunOp(role, op) {
    if (!isRole(role) || typeof op !== 'string') return false;
    const ops = ROLES[role].ops;
    return ops === ALL || ops.includes(op);
  }

  // أقسام الواجهة المتاحة للدور (كل الأقسام للمدير + قسم الفريق، وللموظف قسمه فقط).
  function pagesFor(role, allPages) {
    if (!isRole(role)) return [];
    const p = ROLES[role].pages;
    return p === ALL ? allPages.slice() : allPages.filter(k => p.includes(k));
  }

  const landingPage = (role, allPages) => pagesFor(role, allPages)[0] || '';

  /* إسقاط البيانات: يُرجع نسخة تحوي فقط ما يحق للدور رؤيته. المجموعات الأخرى تُرسَل فارغة.
     counters/ops/audit لا تصل لغير المدير. settings تصل للجميع (اسم الشركة والتفضيلات). */
  function project(db, role, extra = {}) {
    if (!isRole(role)) return null;
    const spec = ROLES[role].data;
    if (spec === ALL) return db;

    const out = { schemaVersion: db.schemaVersion, rev: db.rev, settings: db.settings || {}, stock: {}, ops: {}, counters: {} };
    for (const k of LISTS) out[k] = [];

    for (const entry of spec) {
      const [name, mode] = entry.split(':');

      if (name === 'stock') { out.stock = db.stock || {}; continue; }

      if (mode === 'nocost' && Array.isArray(db[name])) {
        out[name] = name === 'items' ? db.items.map(saleItem) : omitCosts(db[name]);
        continue;
      }

      if (name === 'payroll' && mode === 'header') {
        out.payroll = (db.payroll || []).map(({ id, no, month, status, total, employeesCount, approvedAt, postedAt }) =>
          ({ id, no, month, status, total, employeesCount, approvedAt, postedAt }));
        continue;
      }

      if (name === 'journal' && JOURNAL_FILTERS[mode]) {
        out.journal = (db.journal || [])
          .map(j => ({ ...j, lines: (Array.isArray(j.lines) ? j.lines : []).filter(l => JOURNAL_FILTERS[mode].test(String(l.acct))) }))
          .filter(j => j.lines.length);
        continue;
      }

      if (Array.isArray(db[name])) out[name] = db[name];
    }

    // عدد مشاكل سلامة قاعدة البيانات الكاملة (محسوب على الخادم) كي لا تظهر إنذارات كاذبة من البيانات الجزئية.
    if (extra.integrityCount != null) out.__integrity = { count: extra.integrityCount };
    return out;
  }

  return { ROLES, STAFF_ROLES, ALL_ROLES, isRole, roleLabel, canRunOp, pagesFor, landingPage, project };
});
