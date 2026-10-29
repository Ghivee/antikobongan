// POST /api/admin — tukar PIN dengan token sesi admin (30 menit).
// Dibatasi 5 percobaan gagal per 15 menit per IP.

const crypto = require('crypto');
const { allow, bodyOf, clientIp, handler, PublicError, send } = require('../http');
const { issueToken, sameSecret } = require('../admin-token');
const { getConfig, request, select } = require('../supabase');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const memoryFails = new Map(); // cadangan bila tabel admin_attempts belum ada

function ipHash(req) {
  const salt = String(process.env.ADMIN_TOKEN_SECRET || process.env.ADMIN_PIN || '');
  return crypto.createHash('sha256').update(`${salt}:${clientIp(req)}`).digest('hex').slice(0, 32);
}

async function recentFails(hash) {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  if (getConfig().secretKey) {
    try {
      const rows = await select(
        'admin_attempts',
        { select: 'id', ip_hash: `eq.${hash}`, ok: 'eq.false', at: `gte.${since}`, limit: String(MAX_FAILS) },
        { write: true },
      );
      return { count: rows.length, persistent: true };
    } catch (_) { /* tabel belum dibuat: pakai memori */ }
  }
  const list = (memoryFails.get(hash) || []).filter((t) => t > Date.now() - WINDOW_MS);
  memoryFails.set(hash, list);
  return { count: list.length, persistent: false };
}

async function recordAttempt(hash, ok, persistent) {
  if (persistent) {
    await request('/rest/v1/admin_attempts', {
      method: 'POST',
      write: true,
      body: { ip_hash: hash, ok },
      headers: { Prefer: 'return=minimal' },
    }).catch(() => {});
    return;
  }
  if (!ok) memoryFails.set(hash, [...(memoryFails.get(hash) || []), Date.now()]);
}

module.exports = handler(async (req, res) => {
  if (!allow(req, res, ['POST'])) return;
  const expected = String(process.env.ADMIN_PIN || '').trim();
  if (!expected) throw new PublicError('Admin belum dikonfigurasi di server.', 503);

  const hash = ipHash(req);
  const { count, persistent } = await recentFails(hash);
  if (count >= MAX_FAILS) {
    res.setHeader('Retry-After', String(WINDOW_MS / 1000));
    throw new PublicError('Terlalu banyak percobaan PIN. Coba lagi dalam 15 menit.', 429);
  }

  const submitted = String(bodyOf(req).pin || '').trim();
  const ok = sameSecret(submitted, expected);
  await recordAttempt(hash, ok, persistent);
  if (!ok) throw new PublicError(`PIN admin salah. Sisa percobaan: ${MAX_FAILS - count - 1}.`, 401);

  const session = issueToken();
  if (!session) throw new PublicError('Admin belum dikonfigurasi di server.', 503);
  send(res, 200, { ok: true, token: session.token, expires_at: session.expiresAt });
});
