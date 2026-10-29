// Helper HTTP yang sama untuk Vercel (@vercel/node) dan Express (server.js).

const NODE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

class PublicError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
    this.publicMessage = message;
  }
}

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!headers['Cache-Control']) res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

function query(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  return Object.fromEntries(new URL(req.url || '/', 'http://localhost').searchParams);
}

function bodyOf(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return {};
}

function allow(req, res, methods) {
  if (methods.includes(req.method)) return true;
  res.setHeader('Allow', methods.join(', '));
  send(res, 405, { error: 'Metode tidak didukung.' });
  return false;
}

function nodeIdOf(req) {
  const nodeId = String(query(req).node_id || '').trim();
  if (!NODE_ID_RE.test(nodeId)) throw new PublicError('node_id tidak valid.', 400);
  return nodeId;
}

function clientIp(req) {
  const forwarded = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Bungkus handler: semua error dijawab JSON dengan pesan yang aman ditampilkan.
function handler(fn) {
  return async function wrapped(req, res) {
    try {
      await fn(req, res);
    } catch (error) {
      if (!error.publicMessage) console.error(`[api] ${req.url}: ${error.stack || error.message}`);
      else if (error.status >= 500) console.error(`[api] ${req.url}: ${error.publicMessage}`);
      send(res, error.status || 500, { error: error.publicMessage || 'Kesalahan server.' });
    }
  };
}

module.exports = { NODE_ID_RE, PublicError, send, query, bodyOf, allow, nodeIdOf, clientIp, handler };
