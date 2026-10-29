// Pengambilan data: satu fungsi per jenis, satu jadwal, pembatalan permintaan
// lama, dan jeda saat tab tersembunyi.

import { getJSON } from './api.js';
import { emit, state } from './store.js';
import { log } from './log.js';

const controllers = {};
const POLL = { latest: 30e3, events: 60e3, seriesLive: 60e3, seriesSlow: 5 * 60e3 };
const timers = [];

function fresh(kind) {
  if (controllers[kind]) controllers[kind].abort();
  controllers[kind] = new AbortController();
  return controllers[kind].signal;
}

const enc = encodeURIComponent;

export async function loadNodes() {
  try {
    const data = await getJSON('/api/nodes', { signal: fresh('nodes') });
    state.nodes = data.nodes;
    state.nodesSource = data.source;
    state.nodesError = null;
  } catch (error) {
    if (error.name === 'AbortError') return;
    state.nodesError = error.message;
    log(`Daftar node gagal dimuat: ${error.message}`, 'err');
  }
  state.nodesLoaded = true;
  emit('nodes');
}

export async function refreshLatest(id = state.activeId) {
  if (!id) return;
  const prev = state.latest[id];
  try {
    const data = await getJSON(`/api/latest?node_id=${enc(id)}`, { signal: fresh(`latest:${id}`) });
    state.latest[id] = { data, error: null, at: Date.now() };
  } catch (error) {
    if (error.name === 'AbortError') return;
    state.latest[id] = { data: prev ? prev.data : null, error: error.message, at: prev ? prev.at : null };
    log(`Pembacaan terakhir gagal dimuat: ${error.message}`, 'err');
  }
  emit('latest');
}

export function seriesQuery() {
  if (state.range === 'custom' && state.custom) {
    return `from=${enc(new Date(state.custom.from).toISOString())}&to=${enc(new Date(state.custom.to).toISOString())}`;
  }
  return `range=${enc(state.range)}`;
}

export async function refreshSeries(id = state.activeId) {
  if (!id) return;
  const key = seriesQuery();
  const prev = state.series[id];
  const keep = prev && prev.key === key ? prev.data : null;
  state.series[id] = { key, data: keep, error: null, loading: true, fetchedAt: prev ? prev.fetchedAt : null };
  emit('series-loading');
  try {
    const data = await getJSON(`/api/series?node_id=${enc(id)}&${key}`, { signal: fresh(`series:${id}`), timeout: 20000 });
    state.series[id] = { key, data, error: null, loading: false, fetchedAt: Date.now() };
  } catch (error) {
    if (error.name === 'AbortError') return;
    state.series[id] = { key, data: keep, error: error.message, loading: false, fetchedAt: prev ? prev.fetchedAt : null };
    log(`Riwayat gagal dimuat: ${error.message}`, 'err');
  }
  emit('series');
}

export async function refreshEvents(id = state.activeId, { more = false } = {}) {
  if (!id) return;
  const prev = state.events[id] || { items: null, nextBefore: null };
  state.events[id] = { ...prev, loading: true, error: null };
  emit('events');
  const before = more && prev.nextBefore ? `&before=${enc(prev.nextBefore)}` : '';
  try {
    const data = await getJSON(`/api/events?node_id=${enc(id)}&limit=20${before}`, { signal: fresh(`events:${id}${more ? ':more' : ''}`) });
    let items = data.events;
    let nextBefore = data.next_before;
    if (more && prev.items) {
      items = [...prev.items, ...data.events];
    } else if (prev.items && prev.items.length > data.events.length) {
      // Polling halaman pertama: gabungkan dengan halaman lama yang sudah dimuat.
      const ids = new Set(data.events.map((e) => e.id));
      items = [...data.events, ...prev.items.filter((e) => !ids.has(e.id))];
      nextBefore = prev.nextBefore;
    }
    state.events[id] = { items, nextBefore, loading: false, error: null };
  } catch (error) {
    if (error.name === 'AbortError') return;
    state.events[id] = { ...prev, loading: false, error: error.message };
    log(`Kejadian gagal dimuat: ${error.message}`, 'err');
  }
  emit('events');
}

// Sparkline: 1 jam terakhir sampai pembacaan terbaru (live atau tersimpan),
// supaya kartu tetap informatif walau node sudah lama tidak mengirim.
export async function refreshSpark(id = state.activeId) {
  if (!id) return;
  const latest = state.latest[id] && state.latest[id].data;
  const live = state.live[id];
  const lastAt = Math.max(live && live.receivedAt ? live.receivedAt : 0, latest && latest.latest_at ? Date.parse(latest.latest_at) : 0);
  if (!lastAt) return;
  const recent = Date.now() - lastAt < 10 * 60e3;
  const query = recent ? 'range=1h' : `from=${enc(new Date(lastAt - 3600e3).toISOString())}&to=${enc(new Date(lastAt + 60e3).toISOString())}`;
  try {
    const data = await getJSON(`/api/series?node_id=${enc(id)}&${query}`, { signal: fresh(`spark:${id}`) });
    state.spark[id] = { data, recent, lastAt };
  } catch (error) {
    if (error.name === 'AbortError') return;
    log(`Data sparkline gagal dimuat: ${error.message}`, 'warn');
  }
  emit('spark');
}

export async function refreshReadings(id = state.activeId) {
  if (!id) return;
  const prev = state.readings[id];
  state.readings[id] = { items: prev ? prev.items : null, loading: true, error: null };
  emit('readings');
  try {
    const data = await getJSON(`/api/readings?node_id=${enc(id)}&limit=30`, { signal: fresh(`readings:${id}`) });
    state.readings[id] = { items: data.readings, loading: false, error: null, at: Date.now() };
  } catch (error) {
    if (error.name === 'AbortError') return;
    state.readings[id] = { items: prev ? prev.items : null, loading: false, error: error.message };
  }
  emit('readings');
}

export function refreshAll() {
  refreshLatest().then(() => refreshSpark());
  refreshSeries();
  refreshEvents();
  if (state.tab === 'history') refreshReadings();
}

export function startPolling() {
  stopPolling();
  timers.push(setInterval(() => refreshLatest().then(() => refreshSpark()), POLL.latest));
  timers.push(setInterval(() => { if (state.tab === 'history') refreshReadings(); }, POLL.events));
  timers.push(setInterval(() => refreshEvents(), POLL.events));
  timers.push(setInterval(() => {
    if (state.range === 'custom') return;
    const slow = state.range === '7d' || state.range === '30d';
    const entry = state.series[state.activeId];
    const age = entry && entry.fetchedAt ? Date.now() - entry.fetchedAt : Infinity;
    if (!slow || age >= POLL.seriesSlow) refreshSeries();
  }, POLL.seriesLive));
  timers.push(setInterval(() => loadNodes(), 5 * 60e3));
}

export function stopPolling() {
  while (timers.length) clearInterval(timers.pop());
}
