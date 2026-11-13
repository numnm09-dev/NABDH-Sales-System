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

const SEND_LOCK_MS = 2 * 60 * 1000;
const ACCEPT_LOCK_MS = 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// الرابط الأساسي يُؤخذ من إعداد ثابت (APP_BASE_URL) ولا يُشتق أبدًا من ترويسات الطلب.
function getAppBaseUrl(env = process.env) {
  const raw = String(env.APP_BASE_URL || '').trim();

  if (!raw) {
    throw new Error('app_base_url_not_configured');
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    throw new Error('app_base_url_not_configured');
  }

  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) {
    throw new Error('app_base_url_not_configured');
  }

  return url.origin + url.pathname.replace(/\/+$/, '');
}

// التوكن يوضع في fragment (#) كي لا يصل إلى سجلات الخوادم ولا إلى Referer.
function buildInvitationLink(baseUrl, invitationId, token) {
  return `${baseUrl}/accept-invitation/#i=${encodeURIComponent(invitationId)}&t=${token}`;
}

// قرار قبول الدعوة: دالة نقية تُستدعى داخل معاملة قاعدة البيانات.
function evaluateInvitationForAccept(invitation, { token, email, uid, now = Date.now() }) {
  if (!invitation || typeof invitation !== 'object') {
    return { ok: false, status: 404, error: 'invalid_invitation' };
  }

  if (!verifyInvitationToken(token, invitation.tokenHash)) {
    return { ok: false, status: 404, error: 'invalid_invitation' };
  }

  if (invitation.status === 'accepted') {
    return { ok: false, status: 409, error: 'invitation_already_used' };
  }

  if (invitation.status === 'accepting') {
    const sameUser = invitation.acceptedBy === uid;
    const stale = Number.isFinite(invitation.acceptingAt) &&
      now - invitation.acceptingAt >= ACCEPT_LOCK_MS;

    if (sameUser && stale) {
      return { ok: true, resume: true };
    }

    return { ok: false, status: 409, error: 'invitation_accept_in_progress' };
  }

  if (invitation.status !== 'sent') {
    return { ok: false, status: 409, error: 'invitation_not_active' };
  }

  if (isInvitationExpired(invitation.expiresAt, now)) {
    return { ok: false, status: 410, error: 'invitation_expired' };
  }

  if (normalizeInvitationEmail(invitation.email) !== email) {
    return { ok: false, status: 403, error: 'invitation_email_mismatch' };
  }

  return { ok: true, resume: false };
}

module.exports = {
  SEND_LOCK_MS,
  ACCEPT_LOCK_MS,
  EMAIL_RE,
  getAppBaseUrl,
  buildInvitationLink,
  evaluateInvitationForAccept,
  INVITATION_TTL_MS,
  createInvitationToken,
  hashInvitationToken,
  verifyInvitationToken,
  createInvitationExpiry,
  isInvitationExpired,
  normalizeInvitationEmail
};
