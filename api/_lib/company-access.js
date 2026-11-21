const Roles = require('../../js/roles.js');

const canRunOp = (role, op) => Roles.canRunOp(role, op);

async function getCompanyAccess(database, companyId, uid) {
  const [memberSnap, companySnap] = await Promise.all([
    database.ref(`companyMembers/${companyId}/${uid}`).get(),
    database.ref(`companies/${companyId}`).get()
  ]);

  const member = memberSnap.exists() ? memberSnap.val() : null;
  const company = companySnap.exists() ? companySnap.val() : null;

  if (
    !member ||
    member.status !== 'active' ||
    !Roles.isRole(member.role) ||
    !company ||
    company.status !== 'active'
  ) {
    throw new Error('forbidden');
  }

  return { member, company };
}

module.exports = { Roles, canRunOp, getCompanyAccess };