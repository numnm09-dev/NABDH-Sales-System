const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => n == null || !isFinite(n) ? '—' : (Math.round(n * 10) / 10).toLocaleString('ar-EG');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const VER = ['تجريبي', 'مرشح يحتاج إلى تأكيد', 'تم التحقق'], OST = ['مسودة', 'مُرسل', 'قيد الشحن', 'مستلم', 'ملغي'];
const PAGES = { home: 'الرئيسية', items: 'المخزون', sales: 'المبيعات', suppliers: 'الموردون', risk: 'تحليل المخاطر', sim: 'محاكاة السيناريوهات', orders: 'المشتريات', reports: 'التقارير', settings: 'الإعدادات' };
const SC = {
  items: { t: 'المخزون', f: [['code', 'الكود', 'text'], ['name', 'اسم الصنف', 'text'], ['qty', 'الكمية الحالية', 'number'], ['min', 'الحد الأدنى', 'number'], ['daily', 'متوسط الاستهلاك اليومي', 'number'], ['price', 'سعر الوحدة', 'number'], ['lead', 'مدة التوريد (أيام)', 'number'], ['supplierId', 'المورد الحالي', 'text'], ['inbound', 'أيام حتى وصول الشحنة', 'number'], ['delay', 'تأخر الشحنة (أيام)', 'number']] },
  suppliers: { t: 'الموردون', f: [['name', 'اسم المورد', 'text'], ['itemCodes', 'أكواد الأصناف (مفصولة بفاصلة)', 'text'], ['price', 'السعر', 'number'], ['lead', 'مدة التوريد (أيام)', 'number'], ['quality', 'الجودة (1–5)', 'number'], ['moq', 'الحد الأدنى للطلب', 'number'], ['contact', 'بيانات الاتصال', 'text'], ['verified', 'حالة التحقق', 'sel:' + VER.join('|')]] },
  orders: { t: 'المشتريات', f: [['itemId', 'الصنف', 'ref:items'], ['supplierId', 'المورد', 'ref:suppliers'], ['qty', 'الكمية', 'number'], ['price', 'سعر الوحدة', 'number'], ['status', 'الحالة', 'sel:' + OST.join('|')], ['date', 'التاريخ', 'date']] }
};
const COLS = { items: ['code', 'name', 'qty', 'min', 'daily', 'price', 'lead'], suppliers: ['name', 'itemCodes', 'price', 'lead', 'quality', 'moq', 'contact', 'verified'], orders: ['itemId', 'supplierId', 'qty', 'price', 'status', 'date'] };

/* ---------- الحالة العامة ---------- */
let DB = null;                    // بيانات المستخدم الحالي فقط (null عند عدم وجود مستخدم أو أثناء التحميل)
let currentUser = null;           // مستخدم Firebase الحالي
let dbOwner = null;               // uid صاحب البيانات الموجودة في DB
let ready = false;                // تم تحميل بيانات المستخدم بالكامل
let authVersion = 0;              // يزيد عند كل تغيّر في حالة الدخول لإبطال أي تحميل قديم
let saveQueue = Promise.resolve(true);  // طابور الكتابة؛ لا يُرفض أبدًا
let pendingSaves = 0;             // عدد عمليات الحفظ المعلّقة
let authStarted = false;
const freshUI = () => ({ q: {}, st: '', riskItem: '', riskDelay: null, sim: { d: 0, x: 0, p: 0 } });
let ui = freshUI();

/* ---------- أدوات مساعدة ---------- */
function toast(m) { const t = $('#toast'); if (!t) return; t.textContent = m; t.style.display = 'block'; clearTimeout(toast.h); toast.h = setTimeout(() => t.style.display = 'none', 2600); }
const nameOf = (k, id) => ((DB && DB[k] || []).find(x => x.id === id) || {}).name || '—';
const tag = s => `<span class="tag ${s.k}">${esc(s.t)}</span>`;
// تنفيذ آمن: إذا فشلت دالة الحساب بسبب بيانات ناقصة نرجع قيمة افتراضية بدل تعطيل الصفحة
const sf = (f, d = null) => { try { const v = f(); return v === undefined ? d : v; } catch (e) { console.warn('Calc error:', e); return d; } };
const NOSTAT = { k: '', t: 'بيانات ناقصة', c: null };
const statusOf = i => sf(() => Calc.status(i), NOSTAT) || NOSTAT;
const K = {
  cover: (q, d) => sf(() => Calc.coverDays(q, d)),
  arr: i => sf(() => Calc.arrival(i)),
  gap: i => sf(() => Calc.gapDays(i))
};

function fbErrorMsg(e) {
  const code = String((e && e.code) || ''), msg = String((e && e.message) || '');
  if (/permission[_-]?denied/i.test(code + ' ' + msg)) return 'ليست لديك صلاحية للوصول إلى هذه البيانات. تأكد من تسجيل الدخول ومن قواعد Firebase.';
  if (/network|offline|unavailable|failed to fetch/i.test(code + ' ' + msg)) return 'تعذّر الاتصال بخادم Firebase. تحقق من اتصال الإنترنت.';
  return msg || 'خطأ غير معروف';
}
function authErrorMsg(e) {
  const m = {
    'auth/email-already-in-use': 'البريد الإلكتروني مستخدم بالفعل.',
    'auth/invalid-email': 'البريد الإلكتروني غير صحيح.',
    'auth/weak-password': 'كلمة المرور يجب ألا تقل عن 6 أحرف.',
    'auth/invalid-credential': 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    'auth/user-not-found': 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    'auth/wrong-password': 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    'auth/missing-password': 'أدخل كلمة المرور.',
    'auth/user-disabled': 'هذا الحساب معطّل.',
    'auth/too-many-requests': 'محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.',
    'auth/network-request-failed': 'تعذّر الاتصال بالإنترنت. تحقق من الشبكة وحاول مرة أخرى.',
    'auth/operation-not-allowed': 'تسجيل الدخول بالبريد وكلمة المرور غير مفعّل في Firebase.'
  };
  return m[e && e.code] || ('حدث خطأ: ' + ((e && e.message) || 'غير معروف'));
}

/* ---------- حالة الواجهة: شاشة الترحيب / التطبيق / الانتظار ---------- */
function setShell(state) {
  const show = (el, on) => { if (!el) return; el.hidden = !on; el.style.display = on ? '' : 'none'; };
  show(document.querySelector('header.top'), state === 'app');
  show($('#nav'), state === 'app');
  show($('#welcomeScreen'), state === 'guest');
}

/* ---------- الحفظ ---------- */
// ترجع Promise تُحلّ بـ true عند تأكيد Firebase، وبـ false عند الفشل (بعد عرض رسالة الخطأ)
function save() {
  const fb = window.NabdhFirebase;
  if (!currentUser || !DB || !ready || !fb || dbOwner !== currentUser.uid) {
    toast('لا يوجد مستخدم مسجل لحفظ البيانات');
    return Promise.resolve(false);
  }
  const userId = currentUser.uid;   // المالك وقت الطلب
  let data;
  try { data = JSON.parse(JSON.stringify(DB)); }
  catch (e) { console.error('Serialize error:', e); toast('تعذّر تجهيز البيانات للحفظ'); return Promise.resolve(false); }
  pendingSaves++;
  const job = saveQueue.then(async () => {
    try {
      await fb.set(fb.ref(fb.db, 'users/' + userId), data);
      return true;
    } catch (error) {
      console.error('Firebase save error:', error);
      toast('تعذّر حفظ البيانات على الخادم: ' + fbErrorMsg(error));
      return false;
    } finally { pendingSaves--; }
  });
  saveQueue = job;
  return job;
}
// تنفيذ تعديل ثم حفظه؛ عند الفشل يُتراجع عن التعديل (إذا لم يتغير المستخدم)
async function commit(mutate, undo) {
  const owner = DB;
  if (!owner) return false;
  mutate();
  const ok = await save();
  if (!ok && DB === owner && undo) { try { undo(); } catch (e) { console.error(e); } }
  return ok;
}
const commitList = (k, next) => { const prev = DB && DB[k]; return commit(() => { DB[k] = next; }, () => { if (DB[k] === next) DB[k] = prev; }); };
addEventListener('beforeunload', e => { if (pendingSaves > 0) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- عرض الأخطاء ---------- */
function showErr(msg) {
  const v = $('#view'); if (!v) return;
  v.innerHTML = `<p class="pad err">${esc(msg)}</p><div class="tools"><button id="retryLoad">إعادة المحاولة</button>${currentUser ? '<button class="sec" id="errLogout">تسجيل الخروج</button>' : ''}</div>`;
  $('#retryLoad').onclick = () => location.reload();
  const o = $('#errLogout'); if (o) o.onclick = logout;
}
function safeRoute() {
  if (!ready || !DB || !currentUser) return;   // لا تُفتح الصفحات قبل اكتمال تحميل بيانات المستخدم
  try { route(); } catch (e) { console.error(e); showErr('حدث خطأ أثناء عرض الصفحة: ' + e.message); }
}

/* ---------- بيانات المستخدم ---------- */
function emptyDB() {
  return {
    items: [],
    suppliers: [],
    orders: [],
    sales: [],
    settings: {
      student: 'عبدالله محمد أحمد وإسراء سامح فتحي نمر',
      supervisor: 'الدكتورة آية الشافعي',
      institute: 'المعهد العالي للإدارة بالمحلة الكبرى',
      safety: 3,
      apiUrl: 'https://nabdh-6b5p.vercel.app/api/analyze'
    }
  };
}
// Firebase Realtime Database لا يخزّن المصفوفات الفارغة، وقد يعيد المصفوفات ككائنات؛ لذلك نطبّع البيانات عند القراءة
const toList = v => (Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : [])).filter(x => x && typeof x === 'object');
function normalizeDB(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('بيانات الحساب غير صالحة.');
  const base = emptyDB();
  const out = {
    ...d,
    items: toList(d.items),
    suppliers: toList(d.suppliers),
    orders: toList(d.orders),
    sales: toList(d.sales),
    settings: { ...base.settings, ...(d.settings && typeof d.settings === 'object' && !Array.isArray(d.settings) ? d.settings : {}) }
  };
  [out.items, out.suppliers, out.orders, out.sales].forEach(list => list.forEach(r => { if (!r.id) r.id = uid(); }));
  return out;
}
async function loadUserData(user, v) {
  const fb = window.NabdhFirebase;
  try {
    const userRef = fb.ref(fb.db, 'users/' + user.uid);
    const snapshot = await fb.get(userRef);
    if (v !== authVersion) return;            // تغيّر المستخدم أثناء التحميل: تجاهل النتيجة

    let data;
    if (snapshot.exists()) {
      data = normalizeDB(snapshot.val());
    } else {
      data = emptyDB();
      await fb.set(userRef, data);
      if (v !== authVersion) return;
    }

    DB = data;
    dbOwner = user.uid;
    ready = true;
    safeRoute();
  } catch (error) {
    if (v !== authVersion) return;
    console.error('Firebase load error:', error);
    DB = null; dbOwner = null; ready = false;
    showErr('تعذّر تحميل بيانات حسابك: ' + fbErrorMsg(error));
  }
}

/* ---------- تسجيل الدخول والخروج ---------- */
function showAuthForm(mode) {
  const isSignup = mode === 'signup';

  $('#frm').innerHTML = `
    <h2>${isSignup ? 'إنشاء حساب جديد' : 'تسجيل الدخول'}</h2>

    <label>
      البريد الإلكتروني
      <input name="email" type="email" required autocomplete="email">
    </label>

    <label>
      كلمة المرور
      <input name="password" type="password" required minlength="6"
        autocomplete="${isSignup ? 'new-password' : 'current-password'}">
    </label>

    <p class="err" id="authError"></p>

    <div class="tools">
      <button type="submit">${isSignup ? 'إنشاء الحساب' : 'دخول'}</button>
      <button type="button" class="sec" id="authCancel">إلغاء</button>
    </div>
  `;

  $('#authCancel').onclick = () => $('#dlg').close();

  $('#frm').onsubmit = async e => {
    e.preventDefault();

    const email = $('#frm').elements.email.value.trim();
    const password = $('#frm').elements.password.value;
    const errorBox = $('#authError');

    const buttons = $('#frm').querySelectorAll('button');
    buttons.forEach(b => b.disabled = true);
    errorBox.textContent = 'جارٍ التنفيذ…';

    try {
      const fb = window.NabdhFirebase;
      if (!fb) throw new Error('خدمة تسجيل الدخول غير جاهزة. أعد تحميل الصفحة.');

      if (isSignup) {
        await fb.createUserWithEmailAndPassword(fb.auth, email, password);
      } else {
        await fb.signInWithEmailAndPassword(fb.auth, email, password);
      }

      $('#dlg').close();
    } catch (error) {
      console.error(error);
      errorBox.textContent = authErrorMsg(error);
      buttons.forEach(b => b.disabled = false);
    }
  };

  $('#dlg').showModal();
}
async function logout() {
  const fb = window.NabdhFirebase, btn = $('#logoutBtn');
  if (btn) btn.disabled = true;
  try {
    await saveQueue;                       // انتظار عمليات الحفظ المعلّقة قبل الخروج
    await fb.signOut(fb.auth);
  } catch (e) {
    console.error(e);
    toast('تعذّر تسجيل الخروج: ' + fbErrorMsg(e));
    if (btn) btn.disabled = false;
  }
}
async function handleAuth(user) {
  const v = ++authVersion;                 // أي تحميل أقدم يصبح باطلًا
  currentUser = user || null;
  DB = null; dbOwner = null; ready = false;
  ui = freshUI();                          // عدم إبقاء حالة الواجهة الخاصة بالمستخدم السابق

  const view = $('#view'), nav = $('#nav');
  if (!user) {
    const dlg = $('#dlg'); try { if (dlg && dlg.open && !$('#authError')) dlg.close(); } catch {}
    if (nav) nav.innerHTML = '';
    if (view) view.innerHTML = '';
    setShell('guest');
    return;
  }

  setShell('app');
  if (nav) nav.innerHTML = '';
  if (view) view.innerHTML = '<p class="pad">جارٍ تحميل بياناتك…</p>';
  await loadUserData(user, v);
}
function watchAuth() {
  if (authStarted) return;
  authStarted = true;
  const fb = window.NabdhFirebase;

  if (!fb) {
    showErr('تعذّر الاتصال بخدمة تسجيل الدخول. أعد تحميل الصفحة.');
    return;
  }

  fb.onAuthStateChanged(fb.auth, user => { handleAuth(user); }, error => {
    console.error('Auth state error:', error);
    showErr('تعذّر التحقق من حالة تسجيل الدخول: ' + fbErrorMsg(error));
  });
}
function waitForFirebase(cb) {
  if (window.NabdhFirebase) { cb(); return; }
  let done = false, tries = 0, t;
  const go = () => { if (done) return; done = true; clearInterval(t); cb(); };
  addEventListener('nabdh-firebase-ready', go, { once: true });
  t = setInterval(() => {
    if (window.NabdhFirebase) go();
    else if (++tries > 100 && !done) { done = true; clearInterval(t); showErr('تعذّر الاتصال بخدمة تسجيل الدخول. أعد تحميل الصفحة.'); }
  }, 200);
}
function bindWelcome() {
  const lb = $('#loginBtn'), sb = $('#signupBtn');
  if (lb) lb.onclick = () => showAuthForm('login');
  if (sb) sb.onclick = () => showAuthForm('signup');
}
async function init() {
  setShell('wait');
  bindWelcome();
  addEventListener('hashchange', safeRoute);
  const v = $('#view'); if (v) v.innerHTML = '<p class="pad">جارٍ التحميل…</p>';

  if (typeof Calc === 'undefined') {
    showErr('ملف الحسابات (calc.js) لم يُحمّل. تأكد من وجوده قبل app.js.');
    return;
  }

  waitForFirebase(watchAuth);
}

/* ---------- التوجيه ---------- */
function route() {
  const p = (location.hash || '#home').slice(1); const page = PAGES[p] ? p : 'home';
  $('#nav').innerHTML = Object.entries(PAGES).map(([k, v]) =>
    `<a href="#${k}" ${k === page ? 'aria-current="page"' : ''}>${v}</a>`
  ).join('') + `<button id="logoutBtn" class="sec">تسجيل الخروج</button>`;
  $('#logoutBtn').onclick = logout;
  $('#view').innerHTML = ({ home, items: () => crud('items'), sales: salesPage, suppliers: () => crud('suppliers'), risk, sim, orders: () => crud('orders'), reports, settings })[page]();
  bind(page); document.title = PAGES[page] + ' | نبض';
}
const rerender = () => {
  const el = document.activeElement, id = el && el.id;
  let s = null, e = null;
  try { s = el.selectionStart; e = el.selectionEnd; } catch {}
  safeRoute();
  if (id) {
    const n = document.getElementById(id);
    if (n) { n.focus(); try { if (s != null) n.setSelectionRange(s, e); } catch {} }
  }
};

/* ---------- الصفحات ---------- */
function home() {
  const S = DB.settings, st = DB.items.map(i => ({ i, s: statusOf(i) }));
  const crit = st.filter(x => x.s.k === 'crit'), low = st.filter(x => x.s.k === 'low');
  const mx = Math.max(1, ...st.map(x => x.s.c || 0));
  return `<section class="hero"><div class="cover">${esc(S.institute)}<br>إعداد الطالب: ${esc(S.student)} — تحت إشراف: ${esc(S.supervisor)}</div>
  <h1>نبض | شبكة الإمداد الذكية</h1><p>NABDH — Intelligent Supply Network. تابع المخزون، واكتشف النقص قبل وقوعه، وقارن بدائل التوريد بالأرقام.</p>
  <svg class="pulse" viewBox="0 0 400 40" preserveAspectRatio="none" aria-hidden="true"><path d="M0 20h120l15-17 25 34 20-26 10 9h210" fill="none" stroke="currentColor" stroke-width="2"/></svg></section>
  <div class="note">بياناتك محفوظة في حسابك على Firebase، ولكل مستخدم بيانات مستقلة عن باقي المستخدمين.</div>
  <div class="grid"><div class="kpi"><b>${DB.items.length}</b>صنف</div><div class="kpi red"><b>${crit.length}</b>سينفد قبل الشحنة</div><div class="kpi amb"><b>${low.length}</b>تحت الحد الأدنى</div>
  <div class="kpi"><b>${DB.suppliers.filter(s => s.verified === 'تم التحقق').length}/${DB.suppliers.length}</b>موردون تم التحقق منهم</div><div class="kpi"><b>${DB.orders.filter(o => !['مستلم', 'ملغي'].includes(o.status)).length}</b>طلبات مفتوحة</div></div>
  <div class="box"><h2>أيام التغطية لكل صنف</h2>${st.map(({ i, s }) => `<div class="bar"><span>${esc(i.name)}</span><i class="${s.k}" style="width:${Math.max(2, (s.c || 0) / mx * 60)}%"></i><span>${fmt(s.c)} يوم — ${esc(s.t)}</span></div>`).join('') || 'لا توجد أصناف.'}</div>
  <div class="box"><h2>تنبيهات</h2>${crit.concat(low).map(({ i, s }) => `<p>${tag(s)} <b>${esc(i.name)}</b>: يكفي ${fmt(s.c)} يوم، والشحنة تصل بعد ${fmt(K.arr(i))} يوم. <a href="#risk" data-risk="${esc(i.id)}">حلّل البدائل</a></p>`).join('') || '<p>لا توجد تنبيهات حالية.</p>'}</div>`;
}


function salesPage() {
  const active = DB.sales.filter(x => x.status !== 'ملغي');
  const total = active.reduce((n, x) => n + Number(x.total || 0), 0);
  const qtyTotal = active.reduce((n, x) => n + Number(x.qty || 0), 0);
  const itemOptions = DB.items.map(i =>
    `<option value="${esc(i.id)}" data-price="${Number(i.price) || 0}" data-qty="${Number(i.qty) || 0}">${esc(i.name)} — المتاح: ${fmt(i.qty)}</option>`
  ).join('');
  const rows = [...DB.sales].sort((a,b) => String(b.date || '').localeCompare(String(a.date || '')));
  return `<h2>إدارة المبيعات</h2>
    <div class="grid">
      <div class="kpi"><b>${fmt(total)}</b>إجمالي قيمة المبيعات (جنيه)</div>
      <div class="kpi"><b>${active.length}</b>عمليات بيع مؤكدة</div>
      <div class="kpi"><b>${fmt(qtyTotal)}</b>إجمالي الوحدات المباعة</div>
    </div>
    <section class="box">
      <h3>تسجيل عملية بيع جديدة</h3>
      ${DB.items.length ? `<form id="saleForm" class="sale-form">
        <label>الصنف
          <select id="saleItem" name="itemId" required><option value="">اختر الصنف</option>${itemOptions}</select>
        </label>
        <div class="grid sale-fields">
          <label>الكمية المباعة
            <input name="qty" id="saleQty" type="number" min="0.01" step="any" required placeholder="مثال: 5">
          </label>
          <label>سعر بيع الوحدة (جنيه)
            <input name="unitPrice" id="salePrice" type="number" min="0" step="0.01" required placeholder="سعر الوحدة">
          </label>
        </div>
        <label>اسم العميل (اختياري)
          <input name="customer" type="text" maxlength="100" placeholder="اسم العميل">
        </label>
        <p class="note" id="saleStockHint">اختر الصنف لمعرفة الكمية المتاحة.</p>
        <p class="note" id="saleTotal">الإجمالي: —</p>
        <p class="err" id="saleError" role="alert"></p>
        <div class="tools"><button type="submit">تأكيد البيع وخصم الكمية من المخزون</button></div>
      </form>` : '<p class="note">أضف أصنافًا في صفحة المخزون أولًا حتى تتمكن من تسجيل المبيعات.</p>'}
    </section>
    <section class="box">
      <h3>سجل المبيعات</h3>
      <div class="tw"><table><thead><tr><th>التاريخ والوقت</th><th>الصنف</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th><th>العميل</th><th>الحالة</th><th>الإجراء</th></tr></thead>
      <tbody>${rows.map(x => `<tr>
        <td>${esc(x.date || '—')}</td><td>${esc(nameOf('items', x.itemId))}</td>
        <td>${fmt(x.qty)}</td><td>${fmt(x.unitPrice)} ج</td><td>${fmt(x.total)} ج</td>
        <td>${esc(x.customer || '—')}</td><td>${x.status === 'ملغي' ? '<span class="tag crit">ملغي</span>' : '<span class="tag ok">مؤكد</span>'}</td>
        <td>${x.status === 'ملغي' ? '—' : `<button class="del" data-cancel-sale="${esc(x.id)}">إلغاء البيع وإرجاع المخزون</button>`}</td>
      </tr>`).join('') || '<tr><td colspan="8">لا توجد عمليات بيع حتى الآن.</td></tr>'}</tbody></table></div>
    </section>`;
}

function crud(k) {
  const sc = SC[k], q = ui.q[k] || '';
  let rows = DB[k].filter(r => JSON.stringify(r).includes(q));
  if (k === 'items' && ui.st) rows = rows.filter(r => statusOf(r).k === ui.st);
  const cell = (r, c) => { const d = sc.f.find(x => x[0] === c); const v = r[c]; return d[2].startsWith('ref:') ? esc(nameOf(d[2].slice(4), v)) : esc(v); };
  const head = COLS[k].map(c => `<th>${sc.f.find(x => x[0] === c)[1]}</th>`).join('') + (k === 'items' ? '<th>أيام التغطية</th><th>الحالة</th>' : '');
  return `<h2>${sc.t}</h2><div class="tools"><input id="q" type="search" placeholder="بحث…" value="${esc(q)}" aria-label="بحث">
  ${k === 'items' ? `<select id="st" aria-label="تصفية"><option value="">كل الحالات</option><option value="crit">سينفد قبل الشحنة</option><option value="low">تحت الحد الأدنى</option><option value="ok">آمن</option></select>` : ''}
  <button data-add="${k}">إضافة</button></div>
  <div class="tw"><table><thead><tr>${head}<th></th></tr></thead><tbody>${rows.map(r => `<tr>${COLS[k].map(c => `<td>${cell(r, c)}</td>`).join('')}${k === 'items' ? (s => `<td>${fmt(s.c)}</td><td>${tag(s)}</td>`)(statusOf(r)) : ''}
  <td><button class="sec" data-edit="${k}:${esc(r.id)}">تعديل</button> <button class="del" data-del="${k}:${esc(r.id)}">حذف</button></td></tr>`).join('') || `<tr><td colspan="12">لا توجد نتائج. أضف سجلًا جديدًا.</td></tr>`}</tbody></table></div>`;
}
function openForm(k, id) {
  if (!DB) return;
  const sc = SC[k], r = (id ? DB[k].find(x => x.id === id) : null) || {};
  $('#frm').innerHTML = `<h2>${id ? 'تعديل' : 'إضافة'} — ${sc.t}</h2>` + sc.f.map(([n, l, t]) => {
    const v = esc(r[n] ?? ''); let c;
    if (t.startsWith('ref:')) {
      const opts = DB[t.slice(4)].map(o => `<option value="${esc(o.id)}" ${o.id === r[n] ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
      c = `<select name="${n}" required>${opts || '<option value="">— لا توجد سجلات، أضف سجلًا أولًا —</option>'}</select>`;
    }
    else if (t.startsWith('sel:')) c = `<select name="${n}">${t.slice(4).split('|').map(o => `<option ${o === r[n] ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    else c = `<input name="${n}" type="${t}" value="${v}" ${t === 'number' ? 'min="0" step="any"' : ''} ${n === 'name' || n === 'code' ? 'required' : ''}>`;
    return `<label>${l}${c}</label>`;
  }).join('') + `<p class="err" id="ferr"></p><div class="tools"><button type="submit">حفظ</button><button type="button" class="sec" id="cx">إلغاء</button></div>`;
  $('#cx').onclick = () => $('#dlg').close();
  $('#frm').onsubmit = async e => {
    e.preventDefault();
    if (!DB) return;
    const bad = m => { $('#ferr').textContent = m; };
    const o = { id: id || uid() }, fd = new FormData($('#frm'));
    for (const [n, , t] of sc.f) {
      let v = fd.get(n);
      if (t === 'number') { v = v === '' || v == null ? '' : Number(v); if (v !== '' && (!isFinite(v) || v < 0)) return bad('أدخل أرقامًا صحيحة غير سالبة.'); }
      o[n] = v ?? '';
    }
    if (k === 'suppliers' && o.quality !== '' && (o.quality < 1 || o.quality > 5)) return bad('الجودة بين 1 و5.');
    if (k === 'items' && DB.items.some(x => x.code === o.code && x.id !== o.id)) return bad('هذا الكود مستخدم لصنف آخر.');
    const exists = !!id && DB[k].some(x => x.id === id);
    const next = exists ? DB[k].map(x => x.id === id ? o : x) : DB[k].concat([o]);
    const btns = $('#frm').querySelectorAll('button'); btns.forEach(b => b.disabled = true);
    $('#ferr').textContent = 'جارٍ الحفظ…';
    const ok = await commitList(k, next);
    if (!DB) return;
    if (ok) { $('#dlg').close(); safeRoute(); toast('تم الحفظ'); }
    else { btns.forEach(b => b.disabled = false); bad('تعذّر حفظ البيانات على الخادم، ولم يُطبَّق التغيير. تحقق من الاتصال وحاول مرة أخرى.'); }
  };
  $('#dlg').showModal();
}

function risk() {
  const it0 = DB.items.find(i => i.id === ui.riskItem) || DB.items[0];
  if (!it0) return '<p class="pad">أضف أصنافًا أولًا.</p>';
  ui.riskItem = it0.id; const dl = ui.riskDelay ?? it0.delay ?? 0, it = { ...it0, delay: dl };
  const c = K.cover(it.qty, it.daily), alts = sf(() => Calc.rank(it, DB.suppliers), []) || [];
  let out = '';
  if (c == null) out = '<div class="note">بيانات الكمية أو الاستهلاك اليومي غير صالحة. أدخلها في صفحة المخزون ليتم التحليل.</div>';
  else {
    const gap = K.gap(it), arr = K.arr(it);
    if (gap == null || arr == null) out = '<div class="note">بيانات الشحنة (أيام الوصول أو التأخير) ناقصة أو غير صالحة. أدخلها في صفحة المخزون ليتم التحليل.</div>';
    else {
      out = `<div class="box"><h2>الحسابات الرياضية</h2><p>أيام التغطية = ${fmt(it.qty)} ÷ ${fmt(it.daily)} = <b>${fmt(c)} يوم</b><br>وصول الشحنة = ${fmt(it.inbound)} + ${fmt(dl)} تأخير = <b>${fmt(arr)} يوم</b><br>فجوة التوريد = <b>${fmt(gap)} يوم</b> ${gap > 0 ? `(نقص متوقع ≈ ${fmt(gap * it.daily)} وحدة)` : '(لا نقص متوقع)'}</p></div>`;
      if (gap <= 0) out += `<div class="box"><h2>التوصية</h2><p>المخزون يكفي حتى وصول الشحنة بزيادة ${fmt(c - arr)} يوم. لا حاجة لتغيير المورد الآن.</p></div>`;
      else if (!alts.length) out += `<div class="box"><h2>التوصية</h2><p>لا يوجد مورد بديل مسجّل لهذا الصنف. سجّل موردين مرشحين (السعر والمدة والجودة) ليقارن النظام بينهم.</p></div>`;
      else {
        const top = alts[0], cmp = sf(() => Calc.compare(it, top.s, { safety: DB.settings.safety ?? 3 }));
        if (!cmp) out += `<div class="note">تعذّر إجراء المقارنة مع «${esc(top.s.name)}» بسبب بيانات ناقصة في الصنف أو المورد.</div>`;
        else out += `<div class="box"><h2>البدائل المرشحة</h2><div class="tw"><table><thead><tr><th>المورد</th><th>السعر</th><th>المدة</th><th>الجودة</th><th>الحد الأدنى</th><th>الدرجة</th><th>الحالة</th></tr></thead><tbody>${alts.map(a => `<tr><td>${esc(a.s.name)}</td><td>${fmt(a.s.price)}</td><td>${fmt(a.s.lead)}</td><td>${fmt(a.s.quality)}</td><td>${fmt(a.s.moq)}</td><td>${a.score}</td><td>${esc(a.s.verified)}</td></tr>`).join('')}</tbody></table></div><p class="note">الدرجة = 35٪ سعر + 35٪ وقت + 30٪ جودة، وهي معادلة بسيطة وليست تنبؤًا.</p></div>
      <div class="box"><h2>الانتظار أم الشراء من «${esc(top.s.name)}»؟</h2><div class="tw"><table><thead><tr><th></th><th>الانتظار</th><th>البديل</th></tr></thead><tbody>
      <tr><td>وصول البضاعة</td><td>${fmt(cmp.waitArr)} يوم</td><td>${fmt(cmp.altArr)} يوم</td></tr>
      <tr><td>أيام نقص متوقعة</td><td>${fmt(cmp.waitShort)}</td><td>${fmt(cmp.altShort)}</td></tr>
      <tr><td>وحدات غير متوفرة</td><td>${fmt(cmp.waitLostUnits)}</td><td>${fmt(cmp.altLostUnits)}</td></tr>
      <tr><td>قيمة النقص بسعر الوحدة الحالي</td><td>${fmt(cmp.waitLostValue)}</td><td>—</td></tr>
      <tr><td>كمية الطلب المقترحة (تغطي فترة التأخير + أمان)</td><td>—</td><td>${fmt(cmp.qty)}</td></tr>
      <tr><td>التكلفة الإضافية مقابل المورد الحالي</td><td>—</td><td>${fmt(cmp.extraCost)}</td></tr></tbody></table></div>
      <p><b>سبب الاختيار:</b> ${esc(top.s.name)} أعلى درجة بين المرشحين (${top.score}) بمدة ${fmt(top.s.lead)} يوم وجودة ${fmt(top.s.quality)}/5. ${cmp.altShort < cmp.waitShort ? `يقلّل أيام النقص من ${fmt(cmp.waitShort)} إلى ${fmt(cmp.altShort)} بتكلفة إضافية ≈ ${fmt(cmp.extraCost)}.` : 'لكنه لا يقلل النقص مقارنةً بالانتظار؛ راجع الكمية أو ابحث عن مورد أسرع.'}${cmp.altShort > 0 ? ' سيبقى نقص جزئي حتى مع البديل، فكّر بشحنة طارئة أو تقسيم الطلب.' : ''}</p>
      <p>افتراض: إن وصلت الشحنة الأصلية لاحقًا فسيزيد مخزونك عن الحاجة.</p><div class="note">${top.s.verified === 'تم التحقق' ? 'تم التحقق من هذا المورد يدويًا؛ أكّد السعر والتوفر قبل الطلب.' : 'مرشح يحتاج إلى تأكيد: البيانات تجريبية، والسعر والتوفر غير مؤكدين.'}</div>
      <div class="tools"><button id="mkorder" data-s="${esc(top.s.id)}" data-q="${esc(cmp.qty)}" data-p="${esc(top.s.price)}">أنشئ طلب شراء مسودة</button></div></div>`;
      }
    }
  }
  return `<h2>تحليل المخاطر</h2><div class="tools"><label>الصنف <select id="ri">${DB.items.map(i => `<option value="${esc(i.id)}" ${i.id === it0.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select></label>
  <label>تأخر المورد (أيام) <input id="rd" type="number" min="0" value="${dl}"></label><button id="svd" class="sec">احفظ التأخير على الصنف</button></div>${out}
  <div class="box"><h2>رأي الذكاء الاصطناعي (تفسير لغوي، وليس حسابًا)</h2><p>يعتمد على أرقامك أعلاه ولا يضيف بيانات عن موردين حقيقيين.</p><button id="ai" class="sec">اطلب تحليل الذكاء الاصطناعي</button><div id="aiout" aria-live="polite"></div></div>`;
}

/* ---------- الذكاء الاصطناعي (الرابط وطريقة الاتصال وشكل البيانات دون تغيير) ---------- */
const RISK = { high: ['crit', 'مرتفع'], medium: ['low', 'متوسط'], low: ['ok', 'منخفض'] };
const ERR = { not_configured: 'الذكاء الاصطناعي غير مهيأ على الخادم (المفتاح أو اسم النموذج غير مضبوط).' };
const ul = a => Array.isArray(a) && a.length ? `<ul>${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>—</p>';
const tx = x => esc(x == null || x === '' ? '—' : x);
function apiUrl() {
  const u = String((DB && DB.settings && DB.settings.apiUrl) || '').trim();
  if (!u) return { e: 'الذكاء الاصطناعي غير متصل: لم يتم إدخال رابط الخادم في الإعدادات. الحسابات أعلاه تعمل بدونه.' };
  if (!/^https:\/\//.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(u)) return { e: 'رابط الخادم يجب أن يبدأ بـ https://' };
  return { u };
}
async function post(u, body) {
  let r; try { r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch { throw new Error('تعذّر الوصول إلى الخادم. تحقق من الرابط في الإعدادات ومن ضبط ALLOWED_ORIGIN (CORS) على Vercel.'); }
  let j; try { j = await r.json(); } catch { throw new Error('رد الخادم غير مفهوم (قد يكون الرابط خاطئًا).'); }
  if (!r.ok || !j || !j.ok) throw new Error(ERR[(j || {}).code] || (j || {}).error || 'فشل الطلب');
  return j;
}
async function askAI() {
  const o = $('#aiout'); if (!o || !DB) return;
  const c = apiUrl(); if (c.e) { o.innerHTML = `<p class="note">${esc(c.e)}</p>`; return; }
  const it = DB.items.find(i => i.id === ui.riskItem);
  if (!it) { o.innerHTML = '<p class="note">اختر صنفًا أولًا.</p>'; return; }
  const v = authVersion; o.textContent = 'جارٍ التحليل…';
  const strip = (r, ks) => r.map(x => Object.fromEntries(ks.map(k => [k, x[k]])));
  try {
    const j = await post(c.u, { itemId: it.id, delay: ui.riskDelay ?? it.delay ?? 0, safety: DB.settings.safety ?? 3,
      items: strip(DB.items, ['id', 'code', 'name', 'qty', 'min', 'daily', 'price', 'lead', 'supplierId', 'inbound', 'delay']),
      suppliers: strip(DB.suppliers, ['id', 'name', 'itemCodes', 'price', 'lead', 'quality', 'moq', 'verified']),
      orders: strip(DB.orders, ['itemId', 'supplierId', 'qty', 'price', 'status']) });
    if (v !== authVersion) return;   // تغيّر المستخدم أثناء انتظار الرد
    const a = j.analysis || {}, rk = RISK[j.riskLevel] || RISK.low;
    const cands = Array.isArray(j.candidates) ? j.candidates : [], alts = Array.isArray(a.alternatives) ? a.alternatives : [], notices = Array.isArray(j.notices) ? j.notices : [];
    const by = id => cands.find(x => x.supplierId === id);
    o.innerHTML = `<p>مستوى الخطر (محسوب رياضيًا): <span class="tag ${rk[0]}">${rk[1]}</span></p>
    <p><b>الملخص:</b> ${tx(a.summary)}</p><p><b>نفاد المخزون:</b> ${tx(a.stockoutExplanation)}</p><p><b>أثر التأخير:</b> ${tx(a.delayImpact)}</p>
    ${a.recommendedSupplierId ? `<p><b>الأنسب بحسب التحليل:</b> ${tx((by(a.recommendedSupplierId) || {}).name || a.recommendedSupplierId)}</p>` : '<p><b>لا توصية بمورد محدد.</b></p>'}
    ${cands.length ? `<div class="tw"><table><thead><tr><th>المورد</th><th>السعر</th><th>المدة</th><th>الجودة</th><th>الحالة</th><th>المزايا</th><th>العيوب</th></tr></thead><tbody>${cands.map(x => { const e = alts.find(y => y.supplierId === x.supplierId) || {}; return `<tr><td>${esc(x.name)}</td><td>${fmt(x.price)}</td><td>${fmt(x.leadDays)}</td><td>${fmt(x.quality)}</td><td>${esc(x.verified)}</td><td>${ul(e.pros)}</td><td>${ul(e.cons)}</td></tr>`; }).join('')}</tbody></table></div>` : '<p>لا يوجد موردون بدلاء مسجلون لهذا الصنف.</p>'}
    <p><b>كمية إعادة الطلب:</b> ${tx(a.reorderComment)}</p><p><b>الافتراضات:</b></p>${ul(a.assumptions)}<p><b>بيانات ناقصة:</b></p>${ul(a.dataGaps)}
    ${notices.map(n => `<div class="note">${esc(n)}</div>`).join('')}`;
  } catch (e) { if (v !== authVersion) return; o.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
async function testAI() {
  const o = $('#aitest'); if (!o || !DB) return;
  const c = apiUrl(); if (c.e) { o.textContent = c.e; return; }
  const v = authVersion;
  o.textContent = 'جارٍ اختبار الاتصال…';
  try { const j = await post(c.u, { ping: true }); if (v !== authVersion) return; o.textContent = j.message || 'تم الاتصال بالخادم بنجاح.'; }
  catch (e) { if (v !== authVersion) return; o.textContent = e.message; }
}

function sim() {
  const s = ui.sim, p = { demand: 1 + s.d / 100, extraDelay: s.x, priceMult: 1 + s.p / 100 };
  const rows = DB.items.map(i => { const b = statusOf(i), n = statusOf({ ...i, daily: Number(i.daily) * p.demand, delay: (Number(i.delay) || 0) + p.extraDelay });
    const q = sf(() => Calc.reorderQty({ ...i, daily: Number(i.daily) * p.demand }, i.lead, DB.settings.safety ?? 3)); return { i, b, n, q, cost: q == null ? null : q * Number(i.price) * p.priceMult }; });
  return `<h2>محاكاة السيناريوهات</h2><div class="box"><label>زيادة الطلب: <b>${s.d}%</b><input id="sd" type="range" min="-30" max="100" value="${s.d}"></label>
  <label>تأخر إضافي في الشحن: <b>${s.x} يوم</b><input id="sx" type="range" min="0" max="30" value="${s.x}"></label>
  <label>ارتفاع السعر: <b>${s.p}%</b><input id="sp" type="range" min="-20" max="60" value="${s.p}"></label></div>
  <div class="tw"><table><thead><tr><th>الصنف</th><th>التغطية الآن</th><th>التغطية بعد السيناريو</th><th>الحالة بعده</th><th>كمية إعادة الطلب</th><th>تكلفتها</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.i.name)}</td><td>${fmt(r.b.c)} (${esc(r.b.t)})</td><td>${fmt(r.n.c)}</td><td>${tag(r.n)}</td><td>${fmt(r.q)}</td><td>${fmt(r.cost)}</td></tr>`).join('')}</tbody></table></div>
  <p class="note">الافتراض: السيناريو يغيّر الاستهلاك والتأخر والسعر فقط، وتبقى بقية البيانات كما هي. كمية إعادة الطلب = الاستهلاك خلال مدة التوريد + ${DB.settings.safety ?? 3} أيام أمان − المتاح.</p>`;
}

function orders() { return crud('orders'); }
const downloadFile = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + text], { type })); a.download = name; a.click(); URL.revokeObjectURL(a.href); };
const csv = k => { const f = SC[k].f; const cell = v => { v = String(v ?? ''); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; }; return [f.map(x => cell(x[1])).join(',')].concat(DB[k].map(r => f.map(x => cell(x[2].startsWith('ref:') ? nameOf(x[2].slice(4), r[x[0]]) : r[x[0]])).join(','))).join('\n'); };
function reports() {
  return `<h2>التقارير</h2><div class="box"><p>صدّر بياناتك بصيغة CSV أو JSON.</p>${Object.keys(SC).map(k => `<div class="tools"><b>${SC[k].t}</b><button class="sec" data-csv="${k}">CSV</button><button class="sec" data-json="${k}">JSON</button></div>`).join('')}<div class="tools"><button data-json="all">نسخة كاملة JSON</button></div></div>
  <div class="box"><h2>ملخص المخاطر</h2><div class="tw"><table><thead><tr><th>الصنف</th><th>التغطية</th><th>وصول الشحنة</th><th>الفجوة</th><th>الحالة</th></tr></thead><tbody>${DB.items.map(i => `<tr><td>${esc(i.name)}</td><td>${fmt(K.cover(i.qty, i.daily))}</td><td>${fmt(K.arr(i))}</td><td>${fmt(K.gap(i))}</td><td>${tag(statusOf(i))}</td></tr>`).join('')}</tbody></table></div><div class="tools"><button class="sec" onclick="print()">طباعة</button></div></div>`;
}
function settings() {
  const S = DB.settings, f = (n, l) => `<label>${l}<input name="${n}" value="${esc(S[n])}"></label>`;
  return `<h2>الإعدادات</h2><div class="box"><h2>بيانات الغلاف الأكاديمي</h2>${f('student', 'اسم الطالب')}${f('supervisor', 'اسم المشرف (عدّله بعد التأكد من الاسم الكامل)')}${f('institute', 'المعهد')}
  <label>أيام مخزون الأمان<input name="safety" type="number" min="0" value="${esc(S.safety ?? 3)}"></label>
  <label>رابط خادم الذكاء الاصطناعي (مثال: https://your-app.vercel.app/api/analyze)<input name="apiUrl" type="url" dir="ltr" value="${esc(S.apiUrl)}"></label>
  <div class="tools"><button id="ts" class="sec">اختبار الاتصال بالذكاء الاصطناعي</button><span id="aitest" aria-live="polite"></span></div>
  <div class="tools">   <button id="sv">حفظ الإعدادات</button> </div></div>
  <div class="note">تُحفظ بيانات حسابك على Firebase بشكل مستقل عن المستخدمين الآخرين. لا تضع أي مفتاح سري هنا؛ المفاتيح تُضبط في الخادم فقط.</div>`;
}

/* ---------- ربط الأحداث ---------- */

function bind(page) {
  const v = $('#view');
  const saleForm = v.querySelector('#saleForm');
  if (saleForm) {
    const itemSelect = saleForm.querySelector('#saleItem');
    const qtyInput = saleForm.querySelector('#saleQty');
    const priceInput = saleForm.querySelector('#salePrice');
    const hint = saleForm.querySelector('#saleStockHint');
    const totalBox = saleForm.querySelector('#saleTotal');
    const updateSalePreview = () => {
      const item = DB.items.find(x => x.id === itemSelect.value);
      const qty = Number(qtyInput.value), price = Number(priceInput.value);
      if (!item) { hint.textContent = 'اختر الصنف لمعرفة الكمية المتاحة.'; totalBox.textContent = 'الإجمالي: —'; return; }
      hint.textContent = `المتاح حاليًا في المخزون: ${fmt(item.qty)} وحدة`;
      totalBox.textContent = Number.isFinite(qty) && qty > 0 && Number.isFinite(price) && price >= 0
        ? `الإجمالي: ${fmt(qty * price)} جنيه` : 'الإجمالي: —';
    };
    itemSelect.addEventListener('change', () => {
      const opt = itemSelect.selectedOptions[0];
      if (opt && opt.value) priceInput.value = opt.dataset.price || '';
      updateSalePreview();
    });
    qtyInput.addEventListener('input', updateSalePreview);
    priceInput.addEventListener('input', updateSalePreview);
    saleForm.addEventListener('submit', async e => {
      e.preventDefault();
      if (!DB) return;
      const error = saleForm.querySelector('#saleError');
      const item = DB.items.find(x => x.id === itemSelect.value);
      const qty = Number(qtyInput.value), unitPrice = Number(priceInput.value);
      const customer = saleForm.elements.customer.value.trim();
      if (!item) { error.textContent = 'اختر صنفًا صحيحًا.'; return; }
      if (!Number.isFinite(qty) || qty <= 0) { error.textContent = 'أدخل كمية صحيحة أكبر من صفر.'; return; }
      if (!Number.isFinite(Number(item.qty)) || Number(item.qty) < qty) { error.textContent = `الكمية غير متاحة. المتوفر حاليًا ${fmt(item.qty)} فقط.`; return; }
      if (!Number.isFinite(unitPrice) || unitPrice < 0) { error.textContent = 'أدخل سعر بيع صحيحًا غير سالب.'; return; }
      const sale = {
        id: uid(), itemId: item.id, qty, unitPrice,
        total: Math.round(qty * unitPrice * 100) / 100,
        customer, status: 'مؤكد', date: new Date().toLocaleString('sv-SE')
      };
      const oldQty = item.qty;
      const btn = saleForm.querySelector('button[type="submit"]');
      btn.disabled = true; error.textContent = 'جارٍ حفظ البيع وتحديث المخزون…';
      const ok = await commit(() => {
        item.qty = Number(item.qty) - qty;
        DB.sales = (DB.sales || []).concat([sale]);
      }, () => {
        item.qty = oldQty;
        DB.sales = (DB.sales || []).filter(x => x.id !== sale.id);
      });
      if (!DB) return;
      if (ok) { safeRoute(); toast('تم تسجيل البيع وخصم الكمية من المخزون'); }
      else { btn.disabled = false; error.textContent = 'لم يتم حفظ العملية؛ لم يُعتمد البيع. حاول مرة أخرى.'; }
    });
  }
  v.querySelectorAll('[data-cancel-sale]').forEach(btn => btn.onclick = async () => {
    if (!DB) return;
    const sale = DB.sales.find(x => x.id === btn.dataset.cancelSale);
    if (!sale || sale.status === 'ملغي') return;
    const item = DB.items.find(x => x.id === sale.itemId);
    if (!item) { toast('تعذّر إرجاع المخزون: الصنف غير موجود.'); return; }
    if (!confirm('سيتم إلغاء عملية البيع وإرجاع الكمية إلى المخزون. هل تريد المتابعة؟')) return;
    const oldQty = item.qty, oldStatus = sale.status;
    btn.disabled = true;
    const ok = await commit(() => {
      item.qty = Number(item.qty || 0) + Number(sale.qty || 0);
      sale.status = 'ملغي';
    }, () => { item.qty = oldQty; sale.status = oldStatus; });
    if (!DB) return;
    if (ok) { safeRoute(); toast('تم إلغاء البيع وإرجاع الكمية للمخزون'); }
    else { btn.disabled = false; toast('تعذّر حفظ الإلغاء. لم يُعتمد التغيير.'); }
  });

  v.querySelector('#q')?.addEventListener('input', e => { ui.q[page] = e.target.value; rerender(); });
  const st = v.querySelector('#st'); if (st) { st.value = ui.st; st.onchange = e => { ui.st = e.target.value; rerender(); }; }
  v.querySelectorAll('[data-add]').forEach(b => b.onclick = () => openForm(b.dataset.add));
  v.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openForm(...b.dataset.edit.split(':')));
  v.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const [k, id] = b.dataset.del.split(':');
    if (!DB || !confirm('هل تريد حذف هذا السجل نهائيًا؟')) return;
    b.disabled = true;
    const ok = await commitList(k, DB[k].filter(x => x.id !== id));
    if (!DB) return;
    safeRoute();
    if (ok) toast('تم الحذف');
  });
  v.querySelectorAll('[data-risk]').forEach(a => a.onclick = e => {
    e.preventDefault();
    ui.riskItem = a.dataset.risk; ui.riskDelay = null;
    if (location.hash === '#risk') safeRoute(); else location.hash = '#risk';
  });
  v.querySelector('#ri') && (v.querySelector('#ri').onchange = e => { ui.riskItem = e.target.value; ui.riskDelay = null; safeRoute(); });
  v.querySelector('#rd') && (v.querySelector('#rd').oninput = e => { ui.riskDelay = Math.max(0, Number(e.target.value) || 0); rerender(); });
  v.querySelector('#svd') && (v.querySelector('#svd').onclick = async e => {
    const i = DB.items.find(x => x.id === ui.riskItem); if (!i) return;
    const btn = e.currentTarget, prev = i.delay, next = ui.riskDelay ?? i.delay;
    btn.disabled = true;
    const ok = await commit(() => { i.delay = next; }, () => { i.delay = prev; });
    if (!DB) return;
    btn.disabled = false;
    if (ok) toast('تم حفظ التأخير');
  });
  v.querySelector('#ts') && (v.querySelector('#ts').onclick = testAI);
  v.querySelector('#ai') && (v.querySelector('#ai').onclick = askAI);
  v.querySelector('#mkorder') && (v.querySelector('#mkorder').onclick = async e => {
    const btn = e.currentTarget, d = btn.dataset;
    if (!DB || !ui.riskItem) return;
    const qty = Number(d.q), price = Number(d.p);
    if (!isFinite(qty) || !isFinite(price) || d.q === '' || d.p === '') { toast('تعذّر إنشاء الطلب: الكمية أو السعر غير صالح'); return; }
    const order = { id: uid(), itemId: ui.riskItem, supplierId: d.s, qty, price, status: 'مسودة', date: new Date().toISOString().slice(0, 10) };
    btn.disabled = true;
    const ok = await commitList('orders', DB.orders.concat([order]));
    if (!DB) return;
    btn.disabled = false;
    if (ok) toast('أُنشئ طلب مسودة في المشتريات');
  });
  [['sd', 'd'], ['sx', 'x'], ['sp', 'p']].forEach(([id, k]) => v.querySelector('#' + id) && (v.querySelector('#' + id).oninput = e => { ui.sim[k] = Number(e.target.value); rerender(); }));
  v.querySelectorAll('[data-csv]').forEach(b => b.onclick = () => downloadFile(`nabdh_${b.dataset.csv}.csv`, csv(b.dataset.csv), 'text/csv'));
  v.querySelectorAll('[data-json]').forEach(b => b.onclick = () => downloadFile(`nabdh_${b.dataset.json}.json`, JSON.stringify(b.dataset.json === 'all' ? DB : DB[b.dataset.json], null, 2), 'application/json'));
  v.querySelector('#sv') && (v.querySelector('#sv').onclick = async e => {
    const btn = e.currentTarget, prev = DB.settings, next = { ...prev };
    v.querySelectorAll('input[name]').forEach(i => next[i.name] = i.name === 'safety' ? Math.max(0, Number(i.value) || 0) : i.value.trim());
    btn.disabled = true;
    const ok = await commit(() => { DB.settings = next; }, () => { if (DB.settings === next) DB.settings = prev; });
    if (!DB) return;
    btn.disabled = false;
    if (ok) toast('تم حفظ الإعدادات');
  });
}
document.readyState === 'loading' ? addEventListener('DOMContentLoaded', init) : init();
