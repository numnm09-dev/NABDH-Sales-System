(() => {
  const status = document.getElementById('adminAuthStatus');
  const panel = document.querySelector('main.container');

  const form = document.getElementById('companyForm');
  const list = document.getElementById('companyList');
  const message = document.getElementById('formMessage');
  const count = document.getElementById('companyCount');
  const active = document.getElementById('activeCount');

  const companies = [];
  let authToken = '';

  function deny(text) {
    panel.hidden = true;
    status.textContent = text;
  }

  function render() {
    count.textContent = companies.length;
    active.textContent = companies.filter(c => c.status === 'active').length;

    if (!companies.length) {
      list.className = 'empty';
      list.textContent = 'لا توجد شركات مضافة حتى الآن.';
      return;
    }

    list.className = '';
    list.replaceChildren();

    companies.forEach(company => {
      const card = document.createElement('article');
      card.className = 'company-card';

      const name = document.createElement('strong');
      name.textContent = company.name;

      const email = document.createElement('p');
      email.textContent = 'مدير الشركة: ' + company.managerEmail;

      const badge = document.createElement('span');
      badge.textContent =
        company.status === 'pending_manager' ? 'بانتظار ربط المدير' :
        company.status === 'active' ? 'نشطة' :
        company.status || 'غير محددة';
      badge.className = 'company-status';

      card.append(name, email, badge);
      list.appendChild(card);
    });
  }

  async function loadCompanies() {
    const response = await fetch('/api/admin-companies-list', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + authToken
      }
    });

    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || 'تعذر تحميل الشركات.');
    }

    companies.splice(
      0,
      companies.length,
      ...(Array.isArray(result.companies) ? result.companies : [])
    );

    render();
  }

  async function authorize(user) {
    if (!user) {
      deny('يجب تسجيل الدخول من الصفحة الرئيسية أولًا.');
      return;
    }

    if (!user.emailVerified) {
      deny('يجب تأكيد بريدك الإلكتروني قبل دخول لوحة الإدارة.');
      return;
    }

    status.textContent = 'جارٍ التحقق من صلاحيات مدير النظام...';

    try {
      const token = await user.getIdToken(true);

      const response = await fetch('/api/admin-check', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + token
        }
      });

      const result = await response.json();

      if (!response.ok || result.role !== 'SUPER_ADMIN') {
        deny('غير مصرح لك بدخول لوحة مدير النظام.');
        return;
      }

      authToken = token;
      status.textContent = 'تم التحقق من صلاحيات مدير النظام.';
      panel.hidden = false;
      await loadCompanies();

    } catch (error) {
      console.error('Admin authorization error:', error);
      deny('تعذر التحقق من الصلاحيات. حاول مرة أخرى.');
    }
  }

  if (!window.NabdhFirebase) {
    deny('تعذر تحميل Firebase. أعد تحميل الصفحة.');
    return;
  }

  window.NabdhFirebase.onAuthStateChanged(
    window.NabdhFirebase.auth,
    authorize,
    error => {
      console.error(error);
      deny('حدث خطأ أثناء التحقق من تسجيل الدخول.');
    }
  );

  form.addEventListener('submit', async event => {
    event.preventDefault();

    const name = document.getElementById('companyName').value.trim();
    const email = document.getElementById('managerEmail').value.trim().toLowerCase();

    if (!name || !email) {
      message.textContent = 'من فضلك أكمل البيانات.';
      return;
    }

    message.textContent = 'جارٍ حفظ الشركة...';

    try {
      const response = await fetch('/api/admin-companies', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + authToken
        },
        body: JSON.stringify({
          name,
          managerEmail: email
        })
      });

      const result = await response.json();

      if (!response.ok || !result.ok) {
        if (response.status === 409) {
          message.textContent = 'اسم الشركة مسجل بالفعل.';
        } else {
          message.textContent = result.error || 'تعذر إضافة الشركة.';
        }
        return;
      }

      form.reset();
      message.textContent = 'تم حفظ الشركة بنجاح، وهي بانتظار دعوة المدير.';
      await loadCompanies();

    } catch (error) {
      console.error('Company creation error:', error);
      message.textContent = 'حدث خطأ أثناء الاتصال. حاول مرة أخرى.';
    }
  });
})();
