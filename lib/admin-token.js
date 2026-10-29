// Token sesi admin bertanda tangan HMAC (tanpa penyimpanan di server).

const crypto = require('crypto');

const TOKEN_TTL_MS = 30 * 60 * 1000;

function tokenSecret(env = process.env) {
  const explicit = String(env.ADMIN_TOKEN_SECRET || '').trim();
  if (explicit) return explicit;
  // Cadangan bila ADMIN_TOKEN_SECRET belum diisi: turunan dari dua rahasia server.
  const pin = String(env.ADMIN_PIN || '').trim();
  if (!pin) return '';
  return crypto.createHash('sha256').update(`antikobongan-admin:${pin}:${env.SUPABASE_SECRET_KEY || ''}`).digest('hex');
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function issueToken(env = process.env, now = Date.now()) {
  const secret = tokenSecret(env);
  if (!secret) return null;
  const expiresAt = now + TOKEN_TTL_MS;
  const payload = `admin.${expiresAt}`;
  return { token: `${payload}.${sign(payload, secret)}`, expiresAt };
}

function verifyToken(token, env = process.env, now = Date.now()) {
  const secret = tokenSecret(env);
  const parts = String(token || '').split('.');
  if (!secret || parts.length !== 3 || parts[0] !== 'admin') return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  return sameSecret(parts[2], sign(`${parts[0]}.${parts[1]}`, secret));
}

function bearer(req) {
  const header = String((req.headers && req.headers.authorization) || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

module.exports = { TOKEN_TTL_MS, sameSecret, issueToken, verifyToken, bearer };
