/* نبض ERP — غلاف التطبيق */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => n == null || !isFinite(n) ? '—' : (Math.round(n * 10) / 10).toLocaleString('ar-EG');
const VER = ['تجريبي', 'مرشح يحتاج إلى تأكيد', 'تم التحقق'];
const PAGES = { home: 'لوحة التحكم', sales: 'المبيعات', purchasing: 'المشتريات', inventory: 'المخازن والمخزون', production: 'الإنتاج', accounting: 'المحاسبة', reports: 'التقارير', risk: 'تحليل المخاطر', sim: 'المحاكاة', settings: 'الإعدادات' };
const LEGACY_HASH = { items: 'inventory/stock', orders: 'purchasing/orders', suppliers: 'purchasing/suppliers' };

const NEW_USER_SETTINGS = {
  student: 'عبدالله محمد أحمد وإسراء سامح فتحي نمر',
  supervisor: 'الدكتورة آية الشافعي',
  institute: 'المعهد العالي للإدارة بالمحلة الكبرى',
  company:'  أكتب اسم شركتك هنا من الإعدادات',
  safety: 3,
  apiUrl: 'https://nabdh-6b5p.vercel.app/api/analyze'
};

/* ---------- الحالة العامة ---------- */
let DB = null;
let currentUser = null;
let dbOwner = null;
let ready = false;
let authVersion = 0;
let opQueue = Promise.resolve();
let pendingOps = 0;
let authStarted = false;
let rawLegacy = null;

// الفترة المختارة في لوحة التحكم
let homePeriod = 'week';

/* ---------- أدوات مساعدة ---------- */
function toast(m, ms = 2600) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = m;
  t.style.display = 'block';
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.style.display = 'none', ms);
}

const tag = s => `<span class="tag ${s.k}">${esc(s.t)}</span>`;
const sf = (f, d = null) => {
  try {
    const v = f();
    return v === undefined ? d : v;
  } catch (e) {
    console.warn('Calc error:', e);
    return d;
  }
};

const NOSTAT = { k: '', t: 'بيانات ناقصة', c: null };
const statusOf = i => sf(() => Calc.status(i), NOSTAT) || NOSTAT;

const K = {
  cover: (q, d) => sf(() => Calc.coverDays(q, d)),
  arr: i => sf(() => Calc.arrival(i)),
  gap: i => sf(() => Calc.gapDays(i))
};

function fbErrorMsg(e) {
  const code = String((e && e.code) || '');
  const msg = String((e && e.message) || '');

  if (/permission[_-]?denied/i.test(code + ' ' + msg))
    return 'ليست لديك صلاحية للوصول إلى هذه البيانات. تأكد من تسجيل الدخول ومن قواعد Firebase.';

  if (/network|offline|unavailable|failed to fetch/i.test(code + ' ' + msg))
    return 'تعذّر الاتصال بخادم Firebase. تحقق من اتصال الإنترنت.';

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

/* ---------- حالة الواجهة ---------- */
function setShell(state) {
  const show = (el, on) => {
    if (!el) return;
    el.hidden = !on;
    el.style.display = on ? '' : 'none';
  };

  show(document.querySelector('header.top'), state === 'app');
  show($('#nav'), state === 'app');
  show($('#welcomeScreen'), state === 'guest');
}

/* ---------- تنفيذ العمليات ---------- */
const mkCtx = (opId, extra = {}) => ({
  opId,
  user: (currentUser && (currentUser.email || currentUser.uid)) || 'unknown',
  now: new Date().toISOString(),
  today: localToday(),
  ...extra
});

async function act(op, input, opId) {
  const fb = window.NabdhFirebase;

  if (!currentUser || !DB || !ready || !fb || dbOwner !== currentUser.uid)
    throw Engine.err('لا يوجد مستخدم مسجّل أو البيانات غير جاهزة.', 'not_ready');

  const owner = currentUser.uid;
  const v = authVersion;
  const ctx = mkCtx(opId || newOpId());

  pendingOps++;

  const job = opQueue.then(() => Store.run(fb, owner, ctx, op, input));
  opQueue = job.catch(() => { });

  try {
    const r = await job;

    if (v === authVersion && dbOwner === owner && r && r.db)
      DB = r.db;

    return r;
  } catch (e) {
    if (e && !e.erp) console.error('Operation failed:', op, e);

    if (e && !e.erp &&
        /permission[_-]?denied/i.test(String(e.code || '') + ' ' + String(e.message || '')))
      throw Engine.err(fbErrorMsg(e), 'permission');

    throw e;
  } finally {
    pendingOps--;
  }
}

addEventListener('beforeunload', e => {
  if (pendingOps > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* ---------- عرض الأخطاء ---------- */
function showErr(msg) {
  const v = $('#view');
  if (!v) return;

  v.innerHTML = `
    <p class="pad err">${esc(msg)}</p>
    <div class="tools">
      <button id="retryLoad">إعادة المحاولة</button>
      ${currentUser ? '<button class="sec" id="errLogout">تسجيل الخروج</button>' : ''}
    </div>
  `;

  $('#retryLoad').onclick = () => location.reload();

  const o = $('#errLogout');
  if (o) o.onclick = logout;
}

function safeRoute() {
  if (!ready || !DB || !currentUser) return;

  try {
    route();
  } catch (e) {
    console.error(e);
    showErr('حدث خطأ أثناء عرض الصفحة: ' + e.message);
  }
}

/* ---------- تحميل البيانات ---------- */
async function loadUserData(user, v) {
  const fb = window.NabdhFirebase;

  try {
    const userRef = Store.userRef(fb, user.uid);
    const snapshot = await fb.get(userRef);

    if (v !== authVersion) return;

    let raw = null;

    if (snapshot.exists()) {
      raw = snapshot.val();
    } else {
      const m = Engine.migrate(
        { settings: { ...NEW_USER_SETTINGS } },
        mkCtx('migration-v2')
      );

      await fb.set(userRef, m.db);

      if (v !== authVersion) return;
      raw = m.db;
    }

    if (Number(raw.schemaVersion) >= Engine.SCHEMA)
      return finishLoad(user, v, Engine.ensure(Engine.clone(raw)));

    const probe = Engine.migrate(raw, mkCtx('migration-v2'));

    if (!probe.hadData) {
      const r = await Store.migrate(fb, user.uid, mkCtx('migration-v2'));
      if (v !== authVersion) return;
      return finishLoad(user, v, r.db);
    }

    rawLegacy = raw;
    showMigration(user, v);

  } catch (error) {
    if (v !== authVersion) return;

    console.error('Firebase load error:', error);
    DB = null;
    dbOwner = null;
    ready = false;

    showErr('تعذّر تحميل بيانات حسابك: ' + fbErrorMsg(error));
  }
}

function finishLoad(user, v, data) {
  if (v !== authVersion) return;

  DB = data;
  dbOwner = user.uid;
  ready = true;
  rawLegacy = null;

  safeRoute();
}

function showMigration(user, v) {
  const view = $('#view');
  const nav = $('#nav');

  if (nav) nav.innerHTML = '';
  view.innerHTML = renderMigration(rawLegacy);

  view.onchange = e => {
    const t = e.target;
    if (t && t.dataset && t.dataset.mig)
      UI.mig.types[t.dataset.mig] = t.value;
  };

  $('#miglogout').onclick = logout;

  $('#migrun').onclick = async () => {
    const btn = $('#migrun');
    const er = $('#migerr');

    btn.disabled = true;
    er.textContent = 'جارٍ النسخ الاحتياطي والترقية…';

    try {
      const r = await Store.migrate(
        window.NabdhFirebase,
        user.uid,
        mkCtx('migration-v2', { itemTypes: { ...UI.mig.types } })
      );

      if (v !== authVersion) return;

      view.onchange = null;
      finishLoad(user, v, r.db);

      toast(
        (r.backedUp
          ? 'تم حفظ نسخة احتياطية. '
          : 'تنبيه: تعذّر حفظ النسخة الاحتياطية، لكن البيانات الأصلية لم تُحذف. ')
        + (r.notes || []).join(' '),
        9000
      );

    } catch (e) {
      if (v !== authVersion) return;
      btn.disabled = false;
      er.textContent =
        (e && e.erp ? e.message : fbErrorMsg(e)) +
        ' — لم يتغير شيء.';
    }
  };
}

/* ---------- المزامنة ---------- */
async function refreshData() {
  const fb = window.NabdhFirebase;
  const dlg = $('#dlg');

  if (!ready || !DB || !currentUser || pendingOps || !fb ||
      (dlg && dlg.open)) return;

  const v = authVersion;
  const owner = currentUser.uid;

  try {
    const raw = (await fb.get(Store.userRef(fb, owner))).val();

    if (v !== authVersion || pendingOps || !raw ||
        !(Number(raw.schemaVersion) >= Engine.SCHEMA)) return;

    if ((Number(raw.rev) || 0) !== (Number(DB.rev) || 0)) {
      DB = Engine.ensure(Engine.clone(raw));
      safeRoute();
    }
  } catch (e) {
    // المزامنة اختيارية
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshData();
});

/* ---------- تسجيل الدخول ---------- */
function showAuthForm(mode) {
  const isSignup = mode === 'signup';

  $('#dlg').classList.remove('wide');
  $('#frm').oninput = $('#frm').onchange = $('#frm').onclick = null;

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

      if (!fb)
        throw new Error('خدمة تسجيل الدخول غير جاهزة. أعد تحميل الصفحة.');

      if (isSignup)
        await fb.createUserWithEmailAndPassword(fb.auth, email, password);
      else
        await fb.signInWithEmailAndPassword(fb.auth, email, password);

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
  const fb = window.NabdhFirebase;
  const btn = $('#logoutBtn');

  if (btn) btn.disabled = true;

  try {
    await opQueue;
    await fb.signOut(fb.auth);
  } catch (e) {
    console.error(e);
    toast('تعذّر تسجيل الخروج: ' + fbErrorMsg(e));
    if (btn) btn.disabled = false;
  }
}

async function handleAuth(user) {
  const v = ++authVersion;

  currentUser = user || null;
  DB = null;
  dbOwner = null;
  ready = false;
  rawLegacy = null;

  UI.reset();
  homePeriod = 'week';

  const view = $('#view');
  const nav = $('#nav');

  if (!user) {
    if (nav) nav.innerHTML = '';
    if (view) view.innerHTML = '';

    setShell('guest');
    return;
  }

  if (!user.emailVerified) {
    if (nav) nav.innerHTML = '';
    if (view) {
      view.innerHTML = `
        <div class="pad">
          <h2>تأكيد البريد الإلكتروني مطلوب</h2>
          <p>افتح رسالة التأكيد التي أرسلناها إلى بريدك الإلكتروني واضغط على رابط التأكيد.</p>
          <button id="checkVerification">تحققت من البريد</button>
          <button id="resendVerification" class="sec">إعادة إرسال رسالة التأكيد</button>
          <button id="unverifiedLogout" class="sec">تسجيل الخروج</button>
          <p id="verificationMessage" class="err"></p>
        </div>
      `;

      $('#checkVerification').onclick = async () => {
        try {
          await window.NabdhFirebase.reload(user);
          if (window.NabdhFirebase.auth.currentUser.emailVerified) {
            await handleAuth(window.NabdhFirebase.auth.currentUser);
          } else {
            $('#verificationMessage').textContent = 'البريد لم يتم تأكيده حتى الآن.';
          }
        } catch (e) {
          $('#verificationMessage').textContent = fbErrorMsg(e);
        }
      };

      $('#resendVerification').onclick = async () => {
        try {
          await window.NabdhFirebase.sendEmailVerification(user);
          $('#verificationMessage').textContent = 'تم إرسال رسالة تأكيد جديدة.';
        } catch (e) {
          $('#verificationMessage').textContent = fbErrorMsg(e);
        }
      };

      $('#unverifiedLogout').onclick = logout;
    }

    setShell('app');
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

  fb.onAuthStateChanged(
    fb.auth,
    user => { handleAuth(user); },
    error => {
      console.error('Auth state error:', error);
      showErr('تعذّر التحقق من حالة تسجيل الدخول: ' + fbErrorMsg(error));
    }
  );
}

function waitForFirebase(cb) {
  if (window.NabdhFirebase) {
    cb();
    return;
  }

  let done = false;
  let tries = 0;
  let t;

  const go = () => {
    if (done) return;
    done = true;
    clearInterval(t);
    cb();
  };

  addEventListener('nabdh-firebase-ready', go, { once: true });

  t = setInterval(() => {
    if (window.NabdhFirebase) go();
    else if (++tries > 100 && !done) {
      done = true;
      clearInterval(t);
      showErr('تعذّر الاتصال بخدمة تسجيل الدخول. أعد تحميل الصفحة.');
    }
  }, 200);
}

function bindWelcome() {
  const lb = $('#loginBtn');
  const sb = $('#signupBtn');

  if (lb) lb.onclick = () => showAuthForm('login');
  if (sb) sb.onclick = () => showAuthForm('signup');
}

/* ---------- التوجيه ---------- */
function parseHash() {
  let h = (location.hash || '#home').slice(1);

  if (LEGACY_HASH[h]) h = LEGACY_HASH[h];

  const [p, tab] = h.split('/');

  return {
    page: PAGES[p] ? p : 'home',
    tab: tab || ''
  };
}

function route() {
  const { page, tab } = parseHash();

  $('#nav').innerHTML =
    Object.entries(PAGES).map(([k, v]) =>
      `<a href="#${k}" ${k === page ? 'aria-current="page"' : ''}>${v}</a>`
    ).join('') +
    `<button id="logoutBtn" class="sec">تسجيل الخروج</button>`;

  $('#logoutBtn').onclick = logout;

  const views = {
    home: pageHome,
    sales: () => pageSales(tab),
    purchasing: () => pagePurchasing(tab),
    inventory: () => pageInventory(tab),
    production: () => pageProduction(tab),
    accounting: () => pageAccounting(tab),
    reports: () => pageReports(tab),
    risk: pageRisk,
    sim: pageSim,
    settings: pageSettings
  };

  $('#view').innerHTML = views[page]();
  document.title = PAGES[page] + ' | نبض';
}

/* ---------- إعادة الرسم ---------- */
function rerender() {
  const el = document.activeElement;
  const id = el && el.id;

  let s = null;
  let e = null;

  try {
    s = el.selectionStart;
    e = el.selectionEnd;
  } catch { }

  safeRoute();

  if (id) {
    const n = document.getElementById(id);

    if (n) {
      n.focus();

      try {
        if (s != null) n.setSelectionRange(s, e);
      } catch { }
    }
  }
}

/* ---------- ربط الأحداث ---------- */
function bindEvents() {
  const v = $('#view');

  v.addEventListener('click', e => {
    const risk = e.target.closest('[data-risk]');

    if (risk) {
      e.preventDefault();
      UI.risk.item = risk.dataset.risk;
      UI.risk.delay = null;

      if (location.hash === '#risk') safeRoute();
      else location.hash = '#risk';

      return;
    }

    const b = e.target.closest('[data-act]');

    if (!b || b.disabled) return;

    const fn = UI.actions[b.dataset.act];

    if (!fn) {
      console.warn('أمر غير معروف:', b.dataset.act);
      return;
    }

    try {
      const r = fn(b.dataset.id, b);

      if (r && typeof r.then === 'function') {
        b.disabled = true;
        r.finally(() => {
          if (b.isConnected) b.disabled = false;
        });
      }
    } catch (x) {
      console.error(x);
      toast('تعذّر تنفيذ الأمر: ' + x.message);
    }
  });

  const onInput = e => {
    const t = e.target;

    if (!t || (!t.dataset && !t.id)) return;

    // فلتر لوحة التحكم الجديد
    if (t.dataset.homePeriod) {
      const allowed = ['day', 'week', 'month', 'year'];

      if (allowed.includes(t.dataset.homePeriod)) {
        homePeriod = t.dataset.homePeriod;
        safeRoute();
      }

      return;
    }

    if (t.dataset.f) {
      UI.f[t.dataset.f] = t.value;
      rerender();
      return;
    }

    if (t.dataset.rf) {
      UI.rf[t.dataset.rf] = t.value;
      rerender();
      return;
    }

    if (t.id === 'ri') {
      UI.risk.item = t.value;
      UI.risk.delay = null;
      safeRoute();
      return;
    }

    if (t.id === 'rd') {
      UI.risk.delay = Math.max(0, Number(t.value) || 0);
      rerender();
      return;
    }

    const sim = { sd: 'd', sx: 'x', sp: 'p' }[t.id];

    if (sim) {
      UI.sim[sim] = Number(t.value);
      rerender();
    }
  };

  v.addEventListener('input', e => {
    if (e.target.type !== 'date' && e.target.tagName !== 'SELECT')
      onInput(e);
  });

  v.addEventListener('change', e => {
    if (e.target.type === 'date' || e.target.tagName === 'SELECT')
      onInput(e);
  });

  v.addEventListener('submit', async e => {
    if (e.target.id !== 'setForm') return;

    e.preventDefault();

    const f = e.target.elements;
    const input = {};

    for (const n of [
      'company', 'student', 'supervisor',
      'institute', 'safety', 'apiUrl'
    ]) {
      if (f[n]) input[n] = f[n].value.trim();
    }

    for (const n of ['allowOverReceipt', 'allowNegativeCash']) {
      if (f[n]) input[n] = f[n].checked;
    }

    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;

    try {
      await quickAct('updateSettings', input, 'تم حفظ الإعدادات');
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  });
}

/* ---------- بدء التطبيق ---------- */
async function init() {
  setShell('wait');
  bindWelcome();
  bindEvents();

  addEventListener('hashchange', safeRoute);

  const v = $('#view');

  if (v) v.innerHTML = '<p class="pad">جارٍ التحميل…</p>';

  const need = {
    Calc: typeof Calc,
    Engine: typeof Engine,
    Store: typeof Store,
    Reports: typeof Reports
  };

  const miss = Object.entries(need)
    .filter(([, t]) => t === 'undefined')
    .map(([k]) => k);

  if (miss.length) {
    showErr(
      'تعذّر تحميل ملفات النظام: ' +
      miss.join('، ') +
      '. تأكد من ترتيب الملفات في index.html.'
    );
    return;
  }

  waitForFirebase(watchAuth);
}

document.readyState === 'loading'
  ? addEventListener('DOMContentLoaded', init)
  : init();
