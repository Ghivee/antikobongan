// GET /api/events?node_id=&limit=20&before=ISO — kejadian terbaru dulu.

const { allow, handler, nodeIdOf, PublicError, query, send } = require('../http');
const { select } = require('../supabase');

module.exports = handler(async (req, res) => {
  if (!allow(req, res, ['GET'])) return;
  const nodeId = nodeIdOf(req);
  const params = query(req);
  const limit = Math.min(Math.max(Number.parseInt(params.limit || '20', 10) || 20, 1), 100);

  const filter = {
    select: 'id,created_at,kind,message,meta',
    node_id: `eq.${nodeId}`,
    order: 'created_at.desc,id.desc',
    limit: String(limit + 1),
  };
  if (params.before) {
    const before = Date.parse(String(params.before));
    if (!Number.isFinite(before)) throw new PublicError('Parameter before bukan waktu yang valid.', 400);
    filter.created_at = `lt.${new Date(before).toISOString()}`;
  }

  const rows = await select('events', filter);
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit);
  send(res, 200, {
    node_id: nodeId,
    events,
    next_before: hasMore ? events[events.length - 1].created_at : null,
  });
});
