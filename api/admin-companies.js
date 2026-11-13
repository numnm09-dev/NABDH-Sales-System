const { requireSuperAdmin } = require('./_lib/require-super-admin');
const { getFirebaseAdmin } = require('./_lib/firebase-admin');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'method_not_allowed'
    });
  }

  try {
    const admin = await requireSuperAdmin(req);

    const name = String(req.body?.name || '')
      .trim()
      .replace(/\s+/g, ' ');

    const managerEmail = String(req.body?.managerEmail || '')
      .trim()
      .toLowerCase();

    if (name.length < 2 || name.length > 100) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_company_name'
      });
    }

    if (
      managerEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(managerEmail)
    ) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_manager_email'
      });
    }

    const { database } = await getFirebaseAdmin();

    const companyRef = database.ref('companies').push();
    const companyId = companyRef.key;

    if (!companyId) {
      throw new Error('company_id_generation_failed');
    }

    const normalizedName = name.toLocaleLowerCase();
    const indexKey = Buffer.from(normalizedName).toString('base64url');
    const indexRef = database.ref(`companyNameIndex/${indexKey}`);
    const createdAt = Date.now();

    const reservation = await indexRef.transaction(current => {
      if (current) return;
      return {
        companyId,
        name,
        createdAt
      };
    });

    if (!reservation.committed) {
      return res.status(409).json({
        ok: false,
        error: 'company_name_exists'
      });
    }

    try {
      await companyRef.set({
        id: companyId,
        name,
        normalizedName,
        managerEmail,
        managerStatus: 'pending_invitation',
        status: 'pending_manager',
        createdAt,
        createdBy: admin.uid
      });
    } catch (error) {
      await indexRef.transaction(current =>
        current?.companyId === companyId ? null : current
      );
      throw error;
    }

    return res.status(201).json({
      ok: true,
      company: {
        id: companyId,
        name,
        managerEmail,
        managerStatus: 'pending_invitation',
        status: 'pending_manager',
        createdAt
      }
    });

  } catch (error) {
    const status =
      error.message === 'unauthorized' ? 401 :
      error.message === 'forbidden' ? 403 : 500;

    if (status === 500) {
      console.error('Admin company creation error:', error);
    }

    return res.status(status).json({
      ok: false,
      error: status === 500
        ? 'company_creation_failed'
        : error.message
    });
  }
};
