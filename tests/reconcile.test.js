const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./fake-admin-db');
const {
  readLinkState,
  describeState,
  repairForward,
  readStaffState,
  describeStaffState,
  repairStaffForward
} = require('../api/_lib/reconcile');

const base = () => ({
  companies: { c1: { id: 'c1', name: 'شركة', status: 'pending_manager', managerStatus: 'invited', managerEmail: 'm@x.com' } },
  invitations: { manager_c1: { id: 'manager_c1', companyId: 'c1', email: 'm@x.com', status: 'sent' } }
});

const linked = () => ({
  companies: { c1: { id: 'c1', name: 'شركة', status: 'active', managerStatus: 'linked', managerUid: 'u1' } },
  invitations: { manager_c1: { id: 'manager_c1', companyId: 'c1', email: 'm@x.com', status: 'accepted', acceptedBy: 'u1' } },
  companyMembers: { c1: { u1: { uid: 'u1', email: 'm@x.com', role: 'MANAGER', status: 'active' } } },
  userCompanies: { u1: { c1: { companyId: 'c1', role: 'MANAGER' } } },
  companyData: { c1: { schemaVersion: 2 } }
});

const issuesOf = async db => describeState(await readLinkState(db.database, 'c1')).issues;

test('حالة قبل أي قبول وحالة ربط كامل: لا تعارضات', async () => {
  assert.deepEqual(await issuesOf(createFakeDb(base())), []);
  assert.deepEqual(await issuesOf(createFakeDb(linked())), []);
});

test('اكتشاف كل تعارض محتمل بين الدعوة والشركة والعضوية', async () => {
  const cases = [
    [d => { d.invitations.manager_c1.status = 'sent'; }, ['invitation_not_accepted']],
    [d => { delete d.companyMembers; }, ['member_missing']],
    [d => { delete d.userCompanies; }, ['user_company_missing']],
    [d => { delete d.companyData; }, ['company_data_missing']],
    [d => { d.companies.c1.managerUid = null; d.companies.c1.status = 'pending_manager'; d.companies.c1.managerStatus = 'invited'; }, ['company_not_linked']]
  ];

  for (const [mutate, expected] of cases) {
    const data = linked();
    mutate(data);
    const issues = await issuesOf(createFakeDb(data));
    for (const code of expected) assert.ok(issues.includes(code), `${code} ضمن ${JSON.stringify(issues)}`);
  }
});

test('الإصلاح للأمام يُكمل الناقص بنية موثَّقة ويكون متكررًا (idempotent)', async () => {
  const data = linked();
  data.invitations.manager_c1.status = 'accepting';
  data.invitations.manager_c1.acceptedEmail = 'm@x.com';
  delete data.companyMembers;
  delete data.userCompanies;
  delete data.companyData;
  const db = createFakeDb(data);

  const state = await readLinkState(db.database, 'c1');
  const result = await repairForward(db.database, state);
  assert.equal(result.status, 'repaired');
  assert.deepEqual(await issuesOf(db), []);
  assert.equal(db.get('invitations/manager_c1/status'), 'accepted');
  assert.equal(db.get('companyMembers/c1/u1').role, 'MANAGER');
  assert.equal(db.get('companyData/c1/schemaVersion'), 2);

  const again = await repairForward(db.database, await readLinkState(db.database, 'c1'));
  assert.equal(again.status, 'consistent');
});

test('بلا نية موثَّقة أو مع مدير آخر: مراجعة يدوية ولا كتابة', async () => {
  // شركة مربوطة بلا أي أثر للدعوة ولا العضوية: لا نخمّن
  const orphan = { companies: linked().companies };
  let db = createFakeDb(orphan);
  const before = JSON.stringify(db.dump());
  let result = await repairForward(db.database, await readLinkState(db.database, 'c1'));
  assert.equal(result.status, 'needs_manual_review');
  assert.equal(JSON.stringify(db.dump()), before);

  // حجز مستخدم بينما الشركة مربوطة بمدير مختلف
  const conflict = linked();
  conflict.invitations.manager_c1.status = 'accepting';
  conflict.invitations.manager_c1.acceptedBy = 'u2';
  conflict.invitations.manager_c1.acceptedEmail = 'z@x.com';
  db = createFakeDb(conflict);
  const snapshot = JSON.stringify(db.dump());
  result = await repairForward(db.database, await readLinkState(db.database, 'c1'));
  assert.equal(result.status, 'needs_manual_review');
  assert.equal(JSON.stringify(db.dump()), snapshot, 'لم يُكتب فوق المدير القائم');
});
test('رفض إصلاح عضوية موظف متعارضة دون استبدال بياناتها', async () => {
  const db = createFakeDb({
    invitations: {
      staff_c1_test: {
        id: 'staff_c1_test',
        companyId: 'c1',
        status: 'accepting',
        acceptedBy: 'u1',
        acceptedEmail: 'acc@example.com',
        role: 'ACCOUNTANT',
        invitedBy: 'manager-1'
      }
    },
    companyMembers: {
      c1: {
        u1: {
          uid: 'u1',
          email: 'acc@example.com',
          role: 'SALES',
          companyId: 'c1',
          invitationId: 'staff_c1_old',
          status: 'active'
        }
      }
    },
    userCompanies: {
      u1: {
        c1: {
          companyId: 'c1',
          role: 'SALES'
        }
      }
    }
  });

  const before = JSON.stringify(db.dump());
  const state = await readStaffState(
    db.database,
    'c1',
    'staff_c1_test'
  );

  const result = await repairStaffForward(
    db.database,
    state,
    { name: 'شركة الاختبار' }
  );

  assert.equal(result.status, 'needs_manual_review');
  assert.equal(JSON.stringify(db.dump()), before);
});