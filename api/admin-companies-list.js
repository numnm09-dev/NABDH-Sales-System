const { requireSuperAdmin } = require('./_lib/require-super-admin');
const { getFirebaseAdmin } = require('./_lib/firebase-admin');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      error: 'method_not_allowed'
    });
  }

  try {
    await requireSuperAdmin(req);

    const { database } = await getFirebaseAdmin();
    const snapshot = await database.ref('companies').once('value');
    const data = snapshot.val() || {};

    const companies = Object.entries(data).map(([id, company]) => ({
      id,
      name: company.name || '',
      managerEmail: company.managerEmail || '',
      managerStatus: company.managerStatus || 'pending_invitation',
      status: company.status || 'pending_manager',
      createdAt: company.createdAt || null
    }));

    return res.status(200).json({
      ok: true,
      companies
    });

  } catch (error) {
    const status =
      error.message === 'unauthorized' ? 401 :
      error.message === 'forbidden' ? 403 : 500;

    if (status === 500) {
      console.error('Admin company list error:', error);
    }

    return res.status(status).json({
      ok: false,
      error: status === 500
        ? 'company_list_failed'
        : error.message
    });
  }
};
