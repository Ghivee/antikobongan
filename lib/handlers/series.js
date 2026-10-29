// GET /api/series?node_id=&range=1h|6h|24h|7d|30d  (atau &from=&to=)
// Riwayat teragregasi per bucket waktu, maksimal 720 bucket.

const { allow, handler, nodeIdOf, PublicError, query, send } = require('../http');
const { isMissingSchema, rpc, select } = require('../supabase');
const { aggregateRows, resolveWindow, toColumns } = require('../series');

const FALLBACK_PAGE = 1000;
const FALLBACK_MAX_ROWS = 60000;

// Database tanpa sql/002_series.sql: ambil baris mentah lalu agregasi di sini.
async function seriesWithoutRpc(nodeId, fromIso, toIso, bucket) {
  const rows = [];
  for (let offset = 0; offset < FALLBACK_MAX_ROWS; offset += FALLBACK_PAGE) {
    const chunk = await select('readings', {
      select: 'received_at,suhu,kelembapan,gas,tekanan,kelembapan_tanah,risk_score',
      node_id: `eq.${nodeId}`,
      and: `(received_at.gte.${fromIso},received_at.lt.${toIso})`,
      order: 'received_at.asc',
      offset: String(offset),
      limit: String(FALLBACK_PAGE),
    });
    rows.push(...chunk);
    if (chunk.length < FALLBACK_PAGE) return { rows: aggregateRows(rows, bucket), truncated: false };
  }
  return { rows: aggregateRows(rows, bucket), truncated: true };
}

module.exports = handler(async (req, res) => {
  if (!allow(req, res, ['GET'])) return;
  const nodeId = nodeIdOf(req);
  const window = resolveWindow(query(req));
  const fromIso = new Date(window.fromMs).toISOString();
  const toIso = new Date(window.toMs).toISOString();

  let rows;
  let source = 'rpc';
  let truncated = false;
  try {
    rows = await rpc('reading_series', { p_node: nodeId, p_from: fromIso, p_to: toIso, p_bucket_seconds: window.bucket });
    if (!Array.isArray(rows)) throw new PublicError('Respons database tidak valid.', 502);
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
    ({ rows, truncated } = await seriesWithoutRpc(nodeId, fromIso, toIso, window.bucket));
    source = 'rest';
  }

  send(
    res,
    200,
    {
      node_id: nodeId,
      from: window.fromMs,
      to: window.toMs,
      bucket_seconds: window.bucket,
      source,
      truncated,
      series: toColumns(rows),
    },
    // Jendela yang sudah lewat tidak berubah lagi -> boleh di-cache di edge.
    { 'Cache-Control': window.live ? 'no-store' : 'public, s-maxage=300, stale-while-revalidate=60' },
  );
});
