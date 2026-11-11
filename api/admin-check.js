const { requireSuperAdmin } = require('./_lib/require-super-admin');

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
