// GET  /api/nodes — daftar node + lokasi (publik).
// POST /api/nodes — simpan daftar node (butuh token sesi admin dari /api/admin).

const { allow, bodyOf, handler, NODE_ID_RE, PublicError, send } = require('../http');
const { bearer, verifyToken } = require('../admin-token');
const { isMissingSchema, request, select } = require('../supabase');

const FULL_COLUMNS = 'node_id,nama,gunung,lapisan,lat,lon,ketinggian,aktif';
const BASIC_COLUMNS = 'node_id,nama,gunung,lat,lon,aktif';
const MAX_NODES = 50;

function normalize(row) {
  return {
    node_id: row.node_id,
    nama: row.nama || null,
    gunung: row.gunung || null,
    lapisan: row.lapisan || null,
    lat: row.lat ?? null,
    lon: row.lon ?? null,
    ketinggian: row.ketinggian ?? null,
    aktif: row.aktif !== false,
  };
}

async function listNodes() {
  let rows;
  try {
    rows = await select('nodes', { select: FULL_COLUMNS, order: 'node_id.asc' });
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
    rows = await select('nodes', { select: BASIC_COLUMNS, order: 'node_id.asc' });
  }
  if (rows.length) return { nodes: rows.map(normalize), source: 'nodes' };

  // Belum ada master node: pakai node yang benar-benar pernah tercatat pencatat.
  const seen = await select('node_status', { select: 'node_id', order: 'node_id.asc' }).catch(() => []);
  if (seen.length) return { nodes: seen.map(normalize), source: 'node_status' };
  return { nodes: [], source: 'none' };
}

function text(value, max, name) {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  if (!out) return null;
  if (out.length > max) throw new PublicError(`${name} maksimal ${max} karakter.`, 400);
  return out;
}

function number(value, min, max, name) {
  if (value === null || value === undefined || value === '') return null;
  const out = Number(value);
  if (!Number.isFinite(out) || out < min || out > max) throw new PublicError(`${name} harus angka ${min}..${max}.`, 400);
  return out;
}

function validateNodes(input) {
  if (!Array.isArray(input) || input.length === 0) throw new PublicError('Minimal satu node.', 400);
  if (input.length > MAX_NODES) throw new PublicError(`Maksimal ${MAX_NODES} node.`, 400);
  const ids = new Set();
  return input.map((raw, index) => {
    const label = `Node #${index + 1}`;
    const nodeId = String((raw && raw.node_id) || '').trim();
    if (!NODE_ID_RE.test(nodeId)) throw new PublicError(`${label}: ID hanya huruf, angka, - dan _ (maks 64).`, 400);
    if (ids.has(nodeId)) throw new PublicError(`${label}: ID ${nodeId} dipakai dua kali.`, 400);
    ids.add(nodeId);
    const lat = number(raw.lat, -90, 90, `${label}: lintang`);
    const lon = number(raw.lon, -180, 180, `${label}: bujur`);
    if ((lat === null) !== (lon === null)) throw new PublicError(`${label}: isi lintang dan bujur bersamaan.`, 400);
    return {
      node_id: nodeId,
      nama: text(raw.nama, 80, `${label}: nama`) || nodeId,
      gunung: text(raw.gunung, 80, `${label}: lokasi`),
      lapisan: text(raw.lapisan, 80, `${label}: zona`),
      lat,
      lon,
      ketinggian: number(raw.ketinggian, -500, 9000, `${label}: ketinggian`),
      aktif: raw.aktif !== false,
      updated_at: new Date().toISOString(),
    };
  });
}

module.exports = handler(async (req, res) => {
  if (!allow(req, res, ['GET', 'POST'])) return;

  if (req.method === 'GET') {
    const result = await listNodes();
    send(res, 200, result, { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' });
    return;
  }

  if (!verifyToken(bearer(req))) throw new PublicError('Sesi admin tidak valid atau kedaluwarsa. Masukkan PIN lagi.', 401);
  const nodes = validateNodes(bodyOf(req).nodes);
  const write = (rows) => request('/rest/v1/nodes?on_conflict=node_id', {
    method: 'POST',
    write: true,
    body: rows,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  });
  try {
    await write(nodes);
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
    throw new PublicError('Kolom tabel nodes belum lengkap. Jalankan sql/002_series.sql di Supabase.', 409);
  }

  // Node yang dihapus dari form dinonaktifkan (riwayatnya tetap ada).
  const keep = nodes.map((node) => `"${node.node_id}"`).join(',');
  await request(`/rest/v1/nodes?node_id=not.in.(${encodeURIComponent(keep)})`, {
    method: 'PATCH',
    write: true,
    body: { aktif: false },
    headers: { Prefer: 'return=minimal' },
  });

  send(res, 200, { ok: true, ...(await listNodes()) });
});

module.exports.validateNodes = validateNodes;
