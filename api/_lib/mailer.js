// إرسال البريد عبر Resend. تحميل الحزمة متأخر (lazy) ليبقى باقي النظام
// وأي اختبار لا يحتاجها مستقلًا عن وجودها.
const DEFAULT_FROM = 'NABDH <onboarding@resend.dev>';

function getMailConfig(env = process.env) {
  const apiKey = env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error('email_service_not_configured');
  }

  return {
    apiKey,
    from: env.INVITATION_FROM_EMAIL || DEFAULT_FROM
  };
}

function assertMailConfigured() {
  getMailConfig();
}

async function sendMail({ to, subject, html, text }) {
  const { apiKey, from } = getMailConfig();
  const { Resend } = require('resend');
  const resend = new Resend(apiKey);

  let result;

  try {
    result = await resend.emails.send({ from, to: [to], subject, html, text });
  } catch (error) {
    throw new Error('email_send_failed');
  }

  if (!result || result.error || !result.data || !result.data.id) {
    throw new Error('email_send_failed');
  }

  return { id: result.data.id };
}

module.exports = { getMailConfig, assertMailConfigured, sendMail };
