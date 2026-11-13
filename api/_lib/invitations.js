const crypto = require('node:crypto');

const INVITATION_TTL_MS = 48 * 60 * 60 * 1000;

function createInvitationToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashInvitationToken(token) {
  if (
    typeof token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(token)
  ) {
    throw new Error('invalid_invitation_token');
  }

  return crypto
    .createHash('sha256')
    .update(token, 'utf8')
    .digest('hex');
}

function verifyInvitationToken(token, storedHash) {
  if (
    typeof storedHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(storedHash)
  ) {
    return false;
  }

  try {
    const actual = Buffer.from(hashInvitationToken(token), 'hex');
    const expected = Buffer.from(storedHash, 'hex');

    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function createInvitationExpiry(now = Date.now()) {
  return now + INVITATION_TTL_MS;
}

function isInvitationExpired(expiresAt, now = Date.now()) {
  return (
    !Number.isFinite(expiresAt) ||
    expiresAt <= now
  );
}

function normalizeInvitationEmail(email) {
  return String(email || '').trim().toLowerCase();
}

module.exports = {
  INVITATION_TTL_MS,
  createInvitationToken,
  hashInvitationToken,
  verifyInvitationToken,
  createInvitationExpiry,
  isInvitationExpired,
  normalizeInvitationEmail
};
