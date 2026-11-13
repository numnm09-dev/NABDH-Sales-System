function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildInvitationEmail({ companyName, link, ttlHours }) {
  const name = escapeHtml(companyName);
  const href = escapeHtml(link);

  const subject = `دعوة لإدارة شركة ${String(companyName).slice(0, 100)} على نبض`;

  const html =
    '<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8;color:#172b4d">' +
    '<h2>مرحبًا بك في نبض</h2>' +
    `<p>تمت دعوتك لتكون مدير شركة <strong>${name}</strong> على منصة نبض.</p>` +
    '<p>اضغط على الزر التالي، ثم سجّل الدخول أو أنشئ حسابًا بنفس هذا البريد الإلكتروني وأكّده لإتمام الربط:</p>' +
    `<p><a href="${href}" style="display:inline-block;background:#087e78;color:#fff;` +
    'padding:12px 22px;border-radius:8px;text-decoration:none">قبول الدعوة</a></p>' +
    `<p>الدعوة صالحة لمدة ${ttlHours} ساعة وتُستخدم مرة واحدة فقط، ولا تصلح إلا للبريد الذي وصلته عليه.</p>` +
    '<p>إذا لم تكن تتوقع هذه الرسالة فتجاهلها.</p>' +
    '</div>';

  const text =
    `تمت دعوتك لتكون مدير شركة ${companyName} على منصة نبض.\n` +
    `افتح الرابط التالي وسجّل بنفس هذا البريد وأكّده لإتمام الربط:\n${link}\n` +
    `الدعوة صالحة ${ttlHours} ساعة وتُستخدم مرة واحدة. إن لم تكن تتوقعها فتجاهلها.`;

  return { subject, html, text };
}

module.exports = { buildInvitationEmail, escapeHtml };
