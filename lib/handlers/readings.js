// GET /api/readings?node_id=&limit=30 — pembacaan mentah terbaru (tab Riwayat).

const { allow, handler, nodeIdOf, query, send } = require('../http');
const { isMissingSchema, select } = require('../supabase');

const BASE = 'received_at,sensor_ts,suhu,kelembapan,gas,tekanan,kelembapan_tanah,risk_score,status';

module.exports = handler(async (req, res) => {
  if (!allow(req, res, ['GET'])) return;
  const nodeId = nodeIdOf(req);
  const limit = Math.min(Math.max(Number.parseInt(query(req).limit || '30', 10) || 30, 1), 200);
  const params = { node_id: `eq.${nodeId}`, order: 'received_at.desc', limit: String(limit) };
  let rows;
  try {
    rows = await select('readings', { ...params, select: `${BASE},gas_excess` });
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
    rows = await select('readings', { ...params, select: BASE });
  }
  send(res, 200, { node_id: nodeId, readings: rows });
});
