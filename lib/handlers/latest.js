// GET /api/latest?node_id= — pembacaan terakhir + kesehatan pencatat (< 1 KB).

const { allow, handler, nodeIdOf, send } = require('../http');
const { isMissingSchema, request, rpc, select } = require('../supabase');

const READING_COLUMNS = 'received_at,sensor_ts,suhu,kelembapan,gas,tekanan,kelembapan_tanah,risk_score,status';

// Database tanpa sql/002_series.sql: tiga query REST biasa.
async function latestWithoutRpc(nodeId) {
  const base = { node_id: `eq.${nodeId}` };
  const [last, first, pressure, counted] = await Promise.all([
    select('readings', { ...base, select: READING_COLUMNS, order: 'received_at.desc', limit: '1' }),
    select('readings', { ...base, select: 'received_at', order: 'received_at.asc', limit: '1' }),
    select('readings', { ...base, select: 'received_at', tekanan: 'not.is.null', limit: '1' }),
    request(`/rest/v1/readings?select=id&node_id=eq.${encodeURIComponent(nodeId)}&limit=1`, {
      headers: { Prefer: 'count=exact', Range: '0-0' },
    }),
  ]);
  const range = counted.headers.get('content-range') || '';
  const total = Number(range.split('/')[1]);
  if (!last.length) return null;
  return {
    ...last[0],
    gas_excess: null,
    formula_version: null,
    first_at: first[0] ? first[0].received_at : null,
    total: Number.isFinite(total) ? total : null,
    has_tekanan: pressure.length > 0,
  };
}

module.exports = handler(async (req, res) => {
  if (!allow(req, res, ['GET'])) return;
  const nodeId = nodeIdOf(req);

  let row;
  try {
    const rows = await rpc('reading_latest', { p_node: nodeId });
    row = Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
    row = await latestWithoutRpc(nodeId);
  }

  const [heartbeat, status] = await Promise.all([
    select('backend_heartbeat', { id: 'eq.1', select: 'ts,status,telegram' }).catch(() => select('backend_heartbeat', { id: 'eq.1', select: 'ts,status' })).catch(() => []),
    select('node_status', { node_id: `eq.${nodeId}`, select: 'online,last_seen,updated_at' }).catch(() => []),
  ]);

  let reading = null;
  if (row) {
    const { first_at: firstAt, total, has_tekanan: hasTekanan, ...rest } = row;
    reading = rest;
    reading.first_at = firstAt;
    reading.total = total === null || total === undefined ? null : Number(total);
    reading.has_tekanan = Boolean(hasTekanan);
  }

  send(res, 200, {
    node_id: nodeId,
    server_time: new Date().toISOString(),
    latest_at: reading ? reading.received_at : null,
    first_at: reading ? reading.first_at : null,
    total: reading ? reading.total : 0,
    has_tekanan: reading ? reading.has_tekanan : false,
    reading: reading && {
      received_at: reading.received_at,
      sensor_ts: reading.sensor_ts,
      suhu: reading.suhu,
      kelembapan: reading.kelembapan,
      gas: reading.gas,
      gas_excess: reading.gas_excess,
      tekanan: reading.tekanan,
      kelembapan_tanah: reading.kelembapan_tanah,
      risk_score: reading.risk_score,
      status: reading.status,
      formula_version: reading.formula_version,
    },
    heartbeat: heartbeat[0] || null,
    node_status: status[0] || null,
  });
});
