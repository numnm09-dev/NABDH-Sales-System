const { Resend } = require('resend');
const { requireSuperAdmin } = require('./_lib/require-super-admin');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'method_not_allowed'
    });
  }

  try {
    await requireSuperAdmin(req);

    if (!process.env.RESEND_TEST_TO_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.RESEND_TEST_TO_EMAIL)) {
      return res.status(500).json({
        ok: false,
        error: 'test_email_not_configured'
      });
    }

    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'email_service_not_configured'
      });
    }

    const resend = new Resend(process.env.RESEND_API_KEY);

    const result = await resend.emails.send({
      from: 'NABDH <onboarding@resend.dev>',
      to: [process.env.RESEND_TEST_TO_EMAIL],
      subject: 'NABDH - Email Configuration Test',
      html: '<p>NABDH email service test successful.</p>'
    });

    if (result.error || !result.data?.id) {
      return res.status(502).json({
        ok: false,
        error: 'email_send_failed'
      });
    }

    return res.status(200).json({
      ok: true,
      message: 'email_accepted',
      id: result.data.id
    });
  } catch (error) {
    const status =
      error.message === 'unauthorized' ? 401 :
      error.message === 'forbidden' ? 403 : 500;

    return res.status(status).json({
      ok: false,
      error:
        status === 500 ? 'email_service_failed' :
        error.message
    });
  }
};
