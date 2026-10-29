// Satu sumber state klien. Data live, riwayat, dan kejadian disimpan terpisah
// dan tidak pernah digabung (titik live hanya ditempel di ujung grafik bila
// lebih baru dari riwayat).

export const state = {
  nodes: [],
  nodesSource: null,
  nodesError: null,
  nodesLoaded: false,
  activeId: null,
  range: '24h',
  custom: null, // { from, to } epoch ms
  metric: 'all', // besaran di grafik tren ('all' = semua sensor)
  tab: 'alerts', // tab sidebar
  filter: '', // pencarian node
  focus: null, // 'chart' | 'map' | null
  latest: {}, // nodeId -> { data, error, at }
  series: {}, // nodeId -> { key, data, error, loading }
  spark: {}, // nodeId -> { data, anchor } riwayat 1 jam untuk sparkline kartu
  readings: {}, // nodeId -> { items, error, loading } pembacaan mentah (tab Riwayat)
  events: {}, // nodeId -> { items, nextBefore, error, loading, more }
  live: {}, // nodeId -> { values, riskScore, status, receivedAt, sensorTime, prev, lwt, tail }
  liveAlerts: {}, // nodeId -> [{ level, score, at, recovered }]
  mqtt: { state: 'idle', detail: '', config: null, since: null },
};

const listeners = new Map();

export function on(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
}

export function emit(...topics) {
  for (const topic of topics) (listeners.get(topic) || []).forEach((fn) => fn(topic));
  (listeners.get('*') || []).forEach((fn) => fn(topics));
}

export function activeNode() {
  return state.nodes.find((node) => node.node_id === state.activeId) || null;
}

export function nodeLabel(node) {
  if (!node) return '—';
  return node.nama && node.nama !== node.node_id ? node.nama : node.node_id;
}
