const { requireSuperAdmin } = require('./_lib/require-super-admin');

const redact = text => String(text || '').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[jwt]').slice(0, 300);

function logAdminCheckFailure(error) {
  const root = error && error.cause ? error.cause : error;

  console.error('admin-check failed:', JSON.stringify({
    result: error && error.message === 'unauthorized' ? 'unauthorized' :
      error && error.message === 'forbidden' ? 'forbidden' : 'server_error',
    code: root && root.code,
    name: root && root.name,
    message: redact(root && root.message),
    details: error && error.details
  }));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      error: 'method_not_allowed'
    });
  }

  try {
    await requireSuperAdmin(req);

    return res.status(200).json({
      ok: true,
      role: 'SUPER_ADMIN'
    });
  } catch (error) {
    // كل سبب رفض أو فشل يُسجَّل في سجلات الخادم (بدون توكنات) كي يُعرف السبب الحقيقي من Vercel Logs.
    logAdminCheckFailure(error);

    const status =
      error.message === 'unauthorized' ? 401 :
      error.message === 'forbidden' ? 403 : 500;

    return res.status(status).json({
      ok: false,
      error:
        status === 500 ? 'authentication_failed' :
        error.message
    });
  }
};
