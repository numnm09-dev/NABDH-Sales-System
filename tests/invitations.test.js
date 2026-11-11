const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INVITATION_TTL_MS,
  createInvitationToken,
  hashInvitationToken,
  verifyInvitationToken,
  createInvitationExpiry,
  isInvitationExpired,
  normalizeInvitationEmail
} = require('../api/_lib/invitations');

test('invitation token is random and has the expected format', () => {
  const first = createInvitationToken();
  const second = createInvitationToken();

  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});

test('only the matching token verifies against its hash', () => {
  const token = createInvitationToken();
  const hash = hashInvitationToken(token);

  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(verifyInvitationToken(token, hash), true);
  assert.equal(verifyInvitationToken(createInvitationToken(), hash), false);
});

test('invalid tokens and hashes are rejected safely', () => {
  assert.throws(
    () => hashInvitationToken('not-a-valid-token'),
    { message: 'invalid_invitation_token' }
  );

  assert.equal(verifyInvitationToken('bad-token', 'bad-hash'), false);
});

test('invitation expires after 48 hours', () => {
  const now = 1000000;
  const expiresAt = createInvitationExpiry(now);

  assert.equal(expiresAt - now, INVITATION_TTL_MS);
  assert.equal(isInvitationExpired(expiresAt, now), false);
  assert.equal(isInvitationExpired(expiresAt, expiresAt), true);
});

test('invalid expiry is treated as expired', () => {
  assert.equal(isInvitationExpired(null), true);
  assert.equal(isInvitationExpired(NaN), true);
});

test('invitation email is normalized', () => {
  assert.equal(
    normalizeInvitationEmail('  Manager@Example.COM  '),
    'manager@example.com'
  );
});
