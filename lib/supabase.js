// Akses Supabase (PostgREST) dari server. Kunci tidak pernah dikirim ke browser.

const { PublicError } = require('./http');

function getConfig(env = process.env) {
  const baseUrl = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const secretKey = String(env.SUPABASE_SECRET_KEY || '').trim();
  const readKey = String(env.SUPABASE_ANON_KEY || '').trim() || secretKey;
  return { baseUrl, readKey, secretKey };
}

function requireConfig(needWrite = false, env = process.env) {
  const cfg = getConfig(env);
  if (!cfg.baseUrl || !cfg.readKey) throw new PublicError('Database belum dikonfigurasi di server.', 503);
  if (!/^https:\/\//i.test(cfg.baseUrl)) throw new PublicError('Konfigurasi database server tidak valid.', 500);
  if (needWrite && !cfg.secretKey) throw new PublicError('Kunci tulis database belum dikonfigurasi di server.', 503);
  return cfg;
}

// Galat PostgREST yang berarti "migrasi belum dijalankan" (fungsi/kolom/tabel tidak ada).
function isMissingSchema(error) {
  return Boolean(error && error.pgCode && ['PGRST202', 'PGRST204', 'PGRST205', '42703', '42883', '42P01'].includes(error.pgCode));
}

async function request(path, { method = 'GET', body, headers = {}, write = false, timeoutMs = 8000, env } = {}) {
  const cfg = requireConfig(write, env);
  const key = write ? cfg.secretKey : cfg.readKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new PublicError('Database tidak merespons tepat waktu.', 504);
    throw new PublicError('Tidak dapat menghubungi database.', 502);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = null; }
  }
  if (!response.ok) {
    const error = new PublicError(`Database menolak permintaan (HTTP ${response.status}).`, 502);
    error.pgCode = data && data.code;
    error.httpStatus = response.status;
    throw error;
  }
  return { data, headers: response.headers };
}

async function select(table, params, options = {}) {
  const search = new URLSearchParams(params).toString();
  const { data } = await request(`/rest/v1/${table}?${search}`, options);
  if (!Array.isArray(data)) throw new PublicError('Respons database tidak valid.', 502);
  return data;
}

async function rpc(name, args, options = {}) {
  const { data } = await request(`/rest/v1/rpc/${name}`, { ...options, method: 'POST', body: args });
  return data;
}

module.exports = { getConfig, requireConfig, isMissingSchema, request, select, rpc };
