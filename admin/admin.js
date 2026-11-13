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

      const invitationLine = document.createElement('p');
      invitationLine.className = 'invite-line';
      invitationLine.textContent =
        'حالة الدعوة: ' + invitationLabel(company.invitation);
      card.appendChild(invitationLine);

      if (company.managerUid) {
        const link = document.createElement('p');
        link.className = 'invite-line linked';
        link.textContent = 'تم ربط المدير (UID: ' + company.managerUid + ')';
        card.appendChild(link);
      } else if (company.status === 'pending_manager') {
        const resend = !!(company.invitation && company.invitation.status !== 'draft');

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'invite-btn';
        button.textContent = resend ? 'إعادة إرسال الدعوة' : 'إرسال الدعوة';

        const result = document.createElement('p');
        result.className = 'invite-msg';
        result.setAttribute('role', 'status');

        button.addEventListener('click', () => sendInvitation(company, resend, button, result));
        card.append(button, result);
      }

      list.appendChild(card);
    });
  }

  const INVITATION_LABELS = {
    draft: 'مسودة (لم تُرسل بعد)',
    send_pending: 'جارٍ الإرسال',
    send_failed: 'فشل الإرسال — أعد المحاولة',
    sent: 'أُرسلت — بانتظار قبول المدير',
    expired: 'انتهت صلاحيتها — أعد الإرسال',
    accepting: 'قيد القبول',
    accepted: 'قُبلت'
  };

  const SEND_ERRORS = {
    email_service_not_configured: 'خدمة البريد غير مُعدّة على الخادم (RESEND_API_KEY).',
    app_base_url_not_configured: 'رابط التطبيق غير مُعدّ على الخادم (APP_BASE_URL).',
    email_send_failed: 'فشل مزوّد البريد في إرسال الدعوة. حاول مرة أخرى.',
    company_not_waiting_for_manager: 'هذه الشركة لا تنتظر ربط مدير.',
    manager_email_invalid: 'بريد المدير المحفوظ للشركة غير صالح.',
    invitation_already_accepted: 'الدعوة قُبلت بالفعل.',
    invitation_send_in_progress: 'هناك عملية إرسال جارية لهذه الدعوة. انتظر قليلًا.',
    company_not_found: 'الشركة غير موجودة.'
  };

  function invitationLabel(invitation) {
    if (!invitation) return 'لم تُرسل دعوة بعد';
    return INVITATION_LABELS[invitation.status] || invitation.status;
  }

  async function sendInvitation(company, resend, button, result) {
    if (resend && !window.confirm(
      'إعادة الإرسال تُلغي الرابط السابق وتُنشئ رابطًا جديدًا. هل تريد المتابعة؟'
    )) {
      return;
    }

    button.disabled = true;
    result.textContent = 'جارٍ إرسال الدعوة...';

    try {
      const user = window.NabdhFirebase.auth.currentUser;
      const token = user ? await user.getIdToken() : authToken;

      const response = await fetch('/api/admin-invitations-send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token
        },
        body: JSON.stringify({ companyId: company.id })
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        result.textContent =
          SEND_ERRORS[data.error] || 'تعذر إرسال الدعوة. حاول مرة أخرى.';
        button.disabled = false;
        return;
      }

      message.textContent = 'تم قبول الدعوة من مزوّد البريد وهي في طريقها إلى ' + data.invitation.email;
      await loadCompanies();

    } catch (error) {
      console.error('Invitation send error:', error);
      result.textContent = 'حدث خطأ أثناء الاتصال. حاول مرة أخرى.';
      button.disabled = false;
    }
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
