// Boot dasbor. Setiap panel dibungkus try/catch agar satu kegagalan tidak
// mematikan seluruh halaman.

import { $, fill, h, pick } from './dom.js';
import { activeNode, emit, nodeLabel, on, state } from './store.js';
import { log, logEntries, onLog } from './log.js';
import { fmtAge, fmtClock, fmtDateTime, fmtNum } from './format.js';
import { LEVEL_INFO, levelOf } from './risk.js';
import { buildModel, createMainChart, createOverview, METRICS } from './charts.js';
import { initMap, renderMarkers, resizeMap } from './map.js';
import { loadNodes, refreshAll, refreshEvents, refreshLatest, refreshReadings, refreshSeries, refreshSpark, startPolling, stopPolling } from './data.js';
import { startMqtt } from './mqtt-live.js';
import { current, nodeLink } from './derive.js';
import { mountMetrics, renderMetrics } from './ui/metrics.js';
import { renderRisk } from './ui/risk.js';
import { renderStatus } from './ui/status.js';
import { bindTrend, OVERVIEW, RANGES, renderFoot, renderReadout, renderSub, renderTabs as renderMetricTabs } from './ui/trend.js';
import { renderEvents } from './ui/events.js';
import { bindTabs, renderActions, renderNodeGroups, renderTabs as renderSideTabs, visibleNodes } from './ui/sidebar.js';
import { renderIo } from './ui/io.js';
import { renderHistory } from './ui/history.js';
import { openAdmin } from './ui/admin.js';
import { openDiag } from './ui/diag.js';
import { toast } from './ui/toast.js';
import { initLayout, resetLayout } from './ui/layout.js';

const PREF_KEY = 'antikobongan-pref';
const TAIL_MAX = 2000;
const el = {
  strip: $('#status-strip'), chainDetail: $('#chain-detail'), clock: $('#clock'), menuBtn: $('#menu-btn'), menu: $('#menu'),
  colMain: $('#col-main'), metrics: $('#metrics'),
  risk: $('#risk'), riskBadge: $('#risk-badge'), riskBody: $('#risk-body'),
  chartSub: $('#chart-sub'), range: $('#chart-range'), chartExpand: $('#chart-expand'), metricTabs: $('#metric-tabs'),
  customRange: $('#custom-range'), readout: $('#readout'), chartSingle: $('#chart-single'), chartMulti: $('#chart-multi'), chartFoot: $('#chart-foot'),
  map: $('#map'), mapOverlay: $('#map-overlay'), mapCoords: $('#map-coords'), mapExpand: $('#map-expand'),
  nodeGroups: $('#node-groups'), nodeCount: $('#node-count'), nodeFilter: $('#node-filter'),
  btnConnect: $('#btn-connect'), btnRefresh: $('#btn-refresh'), nodeLine: $('#node-line'),
  tabs: $('.tabs'), eventList: $('#event-list'), eventsFoot: $('#events-foot'), paneIo: $('#pane-io'), paneHistory: $('#pane-history'), logList: $('#log-list'),
  adminDialog: $('#admin-dialog'), diagDialog: $('#diag-dialog'),
};

function safe(name, fn) {
  try {
    return fn();
  } catch (error) {
    log(`Panel ${name} galat: ${error.message}`, 'err');
    console.error(error);
    return undefined;
  }
}

// ── Preferensi tampilan (per browser) ─────────────────────────────────────
function readPref() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (_) { return {}; }
}
function savePref() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify({ node: state.activeId, range: state.range === 'custom' ? '24h' : state.range, metric: state.metric, tab: state.tab })); } catch (_) { /* mode privat */ }
}

// ── Aksi ──────────────────────────────────────────────────────────────────
function selectNode(id) {
  if (!id || id === state.activeId) return;
  state.activeId = id;
  savePref();
  emit('active');
  refreshAll();
}

function setRange(range) {
  state.range = range;
  if (range !== 'custom') state.custom = null;
  savePref();
  emit('range');
  refreshSeries();
}

function setMetric(metric) {
  state.metric = metric;
  savePref();
  schedule('trend', 'metrics');
}

function jumpTo(latestMs) {
  const preset = RANGES.find((r) => r.key === state.range);
  const span = preset ? preset.ms : 24 * 3600e3;
  state.custom = { from: latestMs - span + 60e3, to: latestMs + 60e3 };
  setRange('custom');
}

function setFocus(mode) {
  state.focus = state.focus === mode ? null : mode;
  el.colMain.classList.toggle('chart-focus', state.focus === 'chart');
  el.colMain.classList.toggle('map-focus', state.focus === 'map');
  el.chartExpand.setAttribute('aria-pressed', String(state.focus === 'chart'));
  el.mapExpand.setAttribute('aria-pressed', String(state.focus === 'map'));
  el.chartExpand.textContent = state.focus === 'chart' ? 'Kembalikan' : 'Perluas';
  el.mapExpand.textContent = state.focus === 'map' ? 'Kembalikan' : 'Perluas';
  resizeMap();
}

function resetView() {
  resetLayout();
  if (state.focus) setFocus(state.focus);
  resizeMap();
  toast({ level: 'NORMAL', title: 'Tampilan dikembalikan', text: 'Ukuran semua panel kembali ke bawaan.' });
}

function setTab(tab) {
  state.tab = pick(tab, ['alerts', 'io', 'history', 'log'], 'alerts');
  savePref();
  if (state.tab === 'history') refreshReadings();
  schedule('side');
}

function openAdminPanel() {
  openAdmin(el.adminDialog, (data) => { state.nodes = data.nodes; state.nodesSource = data.source; emit('nodes'); });
}

function chooseActive() {
  const nodes = visibleNodes();
  if (state.activeId && nodes.some((n) => n.node_id === state.activeId)) return;
  const wanted = new URLSearchParams(location.search).get('node') || readPref().node;
  const next = nodes.find((n) => n.node_id === wanted) || nodes[0];
  if (next && next.node_id !== state.activeId) {
    state.activeId = next.node_id;
    emit('active');
    refreshAll();
  }
}

// ── Data live ─────────────────────────────────────────────────────────────
let mqClient = null;

function onSensor(nodeId, result) {
  if (!state.nodes.some((n) => n.node_id === nodeId)) {
    state.nodes.push({ node_id: nodeId, nama: null, aktif: true, discovered: true });
    log(`Node baru terdeteksi dari broker: ${nodeId}.`, 'info');
    emit('nodes');
  }
  const prevLive = state.live[nodeId];
  const receivedAt = Date.now();
  const prevLevel = prevLive && prevLive.receivedAt ? levelOf(prevLive.riskScore) : levelOf(state.latest[nodeId]?.data?.reading?.risk_score);
  const tail = prevLive ? prevLive.tail : [];
  tail.push({ at: receivedAt, ...result.values, riskScore: result.riskScore });
  if (tail.length > TAIL_MAX) tail.splice(0, tail.length - TAIL_MAX);
  state.live[nodeId] = {
    values: result.values, riskScore: result.riskScore, status: result.status, sensorTime: result.sensorTime,
    receivedAt, prev: prevLive && prevLive.receivedAt ? prevLive.values : null, lwt: { state: 'online', at: receivedAt }, tail,
  };
  if (nodeId === state.activeId && (!prevLive || !prevLive.receivedAt)) refreshSpark();

  // Peringatan dihitung dari skor live (ambang sama dengan pencatat: 60 / 80).
  const level = levelOf(result.riskScore);
  const rank = { NORMAL: 0, SEDANG: 0, TINGGI: 1, KRITIS: 2 };
  if (level && rank[level] !== rank[prevLevel || 'NORMAL']) {
    const up = rank[level] > rank[prevLevel || 'NORMAL'];
    const alerts = (state.liveAlerts[nodeId] = state.liveAlerts[nodeId] || []);
    if (up) {
      alerts.unshift({ level, score: result.riskScore, at: receivedAt });
      const node = state.nodes.find((n) => n.node_id === nodeId);
      toast({ level, title: `${LEVEL_INFO[level].label}: skor ${result.riskScore}/100`, text: `${nodeLabel(node)} · ${fmtDateTime(receivedAt, { seconds: true })} · ${LEVEL_INFO[level].note}`, sticky: level === 'KRITIS' });
    } else if (rank[level] === 0) {
      alerts.unshift({ level: 'NORMAL', score: result.riskScore, at: receivedAt, recovered: true });
    }
    if (alerts.length > 30) alerts.length = 30;
    emit('events');
  }
  emit('live');
}

function onStatus(nodeId, status) {
  const live = state.live[nodeId] || (state.live[nodeId] = { values: {}, riskScore: null, receivedAt: null, prev: null, tail: [] });
  live.lwt = { state: status, at: Date.now() };
  log(`Status broker untuk ${nodeId}: ${status}.`, status === 'online' ? 'ok' : 'warn');
  emit('live');
}

function onMqttState(st, detail, config) {
  if (state.mqtt.state === 'off' && st !== 'connecting') return;
  state.mqtt = { ...state.mqtt, state: st, detail: detail || '', config: config || state.mqtt.config, since: Date.now() };
  emit('mqtt');
}

function connectLive() {
  state.mqtt = { ...state.mqtt, state: 'connecting' };
  emit('mqtt');
  startMqtt({ onState: onMqttState, onSensor, onStatus })
    .then((client) => { mqClient = client; })
    .catch((error) => { onMqttState('error', error.message); log(`MQTT gagal dimulai: ${error.message}`, 'err'); });
}

function toggleLive() {
  if (mqClient && state.mqtt.state !== 'off') {
    mqClient.end(true);
    mqClient = null;
    state.mqtt = { ...state.mqtt, state: 'off', detail: '' };
    log('Data live diputus oleh pengguna.', 'warn');
    emit('mqtt');
  } else {
    connectLive();
  }
}

// ── Render ────────────────────────────────────────────────────────────────
let mainChart = null;
let overviewChart = null;
let mapReady = false;

function hasTekanan() {
  const id = state.activeId;
  const latest = id && state.latest[id] && state.latest[id].data;
  const live = id && state.live[id];
  return Boolean((latest && latest.has_tekanan) || (live && live.values && live.values.tekanan !== null && live.values.tekanan !== undefined));
}

function renderTrend() {
  const id = state.activeId;
  const entry = id ? state.series[id] : null;
  if (state.metric === 'tekanan' && !hasTekanan()) state.metric = 'risk';
  const overview = state.metric === OVERVIEW.key && Boolean(overviewChart);
  el.chartSingle.hidden = overview;
  el.chartMulti.hidden = !overview;
  renderMetricTabs(el.metricTabs, el.range, hasTekanan());
  if (!entry || !entry.data) {
    renderSub(el.chartSub, null);
    renderFoot(el.chartFoot, { entry, onRetry: () => refreshSeries() });
    return;
  }
  const data = entry.data;
  const now = Date.now();
  const liveWindow = state.range !== 'custom';
  const to = liveWindow ? Math.max(data.to, now) : data.to;
  const tail = liveWindow && state.live[id] ? state.live[id].tail : [];
  state.mainModel = buildModel({ series: data.series, from: data.from, to, bucketSeconds: data.bucket_seconds, tail, now });
  renderSub(el.chartSub, state.mainModel);
  renderFoot(el.chartFoot, {
    entry, model: state.mainModel,
    latestAt: state.latest[id] && state.latest[id].data ? state.latest[id].data.latest_at : null,
    onJump: jumpTo, onRetry: () => refreshSeries(), onNow: () => setRange('24h'),
  });
  if (overview) overviewChart.render(state.mainModel, { hasTekanan: hasTekanan() });
  else if (mainChart) mainChart.render(state.mainModel, state.metric === OVERVIEW.key ? 'risk' : state.metric);
}

let markerSig = '';
function renderMap(now = Date.now()) {
  const nodes = visibleNodes();
  const placed = nodes.filter((n) => Number.isFinite(n.lat) && Number.isFinite(n.lon));
  const active = activeNode();
  el.mapCoords.textContent = active && Number.isFinite(active.lat)
    ? `Lintang ${fmtNum(active.lat, 5)} · Bujur ${fmtNum(active.lon, 5)}${Number.isFinite(active.ketinggian) ? ` · ${fmtNum(active.ketinggian, 0)} mdpl` : ''}`
    : active ? 'Koordinat node belum diatur' : '';
  if (!mapReady) {
    el.mapOverlay.hidden = false;
    fill(el.mapOverlay, h('strong', { text: 'Peta tidak dapat dimuat' }), h('p', { text: 'Pustaka peta gagal diunduh. Panel lain tetap berjalan.' }));
    return;
  }
  el.mapOverlay.hidden = placed.length > 0;
  if (!placed.length) {
    fill(el.mapOverlay,
      h('strong', { text: nodes.length ? 'Lokasi node belum diatur' : 'Belum ada node' }),
      h('p', { text: 'Isi lintang dan bujur node agar posisinya tampil di peta. Peta saat ini menampilkan Pulau Jawa sebagai tampilan awal.' }),
      h('button', { type: 'button', class: 'link-btn', text: 'Atur lokasi node', onclick: openAdminPanel }));
  }
  const markers = placed.map((node) => {
    const link = nodeLink(node.node_id, now);
    const cur = current(node.node_id);
    const level = cur ? levelOf(cur.riskScore) : null;
    const rows = [['Status', link.state]];
    if (cur) {
      rows.push(['Skor risiko', Number.isFinite(cur.riskScore) ? `${cur.riskScore} · ${LEVEL_INFO[level].label}` : '—']);
      rows.push(['Suhu', `${fmtNum(cur.suhu, 1)} °C`], ['Kelembapan', `${fmtNum(cur.kelembapan, 0)} %`], ['Gas/asap', `${fmtNum(cur.gas, 0)} ADC`], ['Tanah', `${fmtNum(cur.kelembapan_tanah, 0)} %`]);
      rows.push(['Pembacaan', `${fmtDateTime(cur.at)} (${fmtAge(cur.at, now)})`]);
    }
    if (Number.isFinite(node.ketinggian)) rows.push(['Ketinggian', `${fmtNum(node.ketinggian, 0)} mdpl`]);
    return { id: node.node_id, lat: node.lat, lon: node.lon, conn: link.st, active: node.node_id === state.activeId, title: `${nodeLabel(node)}${node.gunung ? ` · ${node.gunung}` : ''}`, rows };
  });
  // Gambar ulang hanya bila isi berubah (umur relatif dibulatkan ke menit) agar popup tidak tertutup tiap detik.
  const sig = JSON.stringify(markers.map((m) => [m.id, m.lat, m.lon, m.conn, m.active, m.rows.slice(0, -1)]));
  if (sig === markerSig) return;
  markerSig = sig;
  renderMarkers(markers, { onSelect: selectNode });
}

function renderSide() {
  renderSideTabs(el.tabs);
  if (state.tab === 'alerts') renderEvents(el.eventList, el.eventsFoot, { onMore: () => refreshEvents(state.activeId, { more: true }), onRetry: () => refreshEvents() });
  if (state.tab === 'io') renderIo(el.paneIo);
  if (state.tab === 'history') renderHistory(el.paneHistory, { onRetry: () => refreshReadings() });
  if (state.tab === 'log') {
    fill(el.logList, logEntries().map((e) => h('li', { class: `lg-${pick(e.level, ['info', 'ok', 'warn', 'err'], 'info')}` }, h('time', { text: fmtDateTime(e.at, { seconds: true }).replace(' WIB', '') }), e.message)));
  }
}

let frame = 0;
const pending = new Set();
function schedule(...parts) {
  parts.forEach((p) => pending.add(p));
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const todo = new Set(pending);
    pending.clear();
    if (todo.has('trend')) safe('tren', renderTrend);
    if (todo.has('live')) {
      safe('risiko', () => renderRisk(el.risk, el.riskBadge, el.riskBody, { onRetry: () => refreshLatest() }));
      safe('status', () => renderStatus({ strip: el.strip, detail: el.chainDetail }));
      safe('aksi', () => renderActions({ connectBtn: el.btnConnect, nodeLine: el.nodeLine }));
    }
    if (todo.has('metrics') || todo.has('spark') || todo.has('live')) safe('kartu', () => renderMetrics({ sparkChanged: todo.has('spark') || todo.has('metrics') }));
    if (todo.has('nodes')) {
      safe('node', () => renderNodeGroups(el.nodeGroups, el.nodeCount, { onSelect: selectNode }));
      safe('peta', () => renderMap());
    }
    if (todo.has('side')) safe('sidebar', renderSide);
    const node = activeNode();
    document.title = node ? `${nodeLabel(node)} · AntiKobongan` : 'AntiKobongan — Pemantauan Kebakaran Hutan';
  });
}

on('nodes', () => { chooseActive(); schedule('nodes', 'live', 'side'); });
on('active', () => schedule('nodes', 'live', 'trend', 'side', 'spark'));
on('latest', () => schedule('live', 'nodes', 'trend', 'side'));
on('series', () => schedule('trend', 'live'));
on('series-loading', () => schedule('trend'));
on('spark', () => schedule('spark'));
on('range', () => schedule('trend'));
on('events', () => schedule('side'));
on('readings', () => schedule('side'));
on('live', () => schedule('live', 'trend', 'nodes', 'side'));
on('mqtt', () => schedule('live', 'side'));
onLog(() => { if (state.tab === 'log') schedule('side'); });

// ── Kontrol ───────────────────────────────────────────────────────────────
function bindControls() {
  el.strip.addEventListener('click', () => {
    const open = el.chainDetail.hidden;
    el.chainDetail.hidden = !open;
    el.strip.setAttribute('aria-expanded', String(open));
    schedule('live');
  });
  const closeMenu = () => { el.menu.hidden = true; el.menuBtn.setAttribute('aria-expanded', 'false'); };
  el.menuBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    el.menu.hidden = !el.menu.hidden;
    el.menuBtn.setAttribute('aria-expanded', String(!el.menu.hidden));
    if (!el.menu.hidden) el.menu.querySelector('button').focus();
  });
  document.addEventListener('click', (event) => { if (!el.menu.contains(event.target)) closeMenu(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !el.menu.hidden) { closeMenu(); el.menuBtn.focus(); } });
  el.menu.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    closeMenu();
    if (!button) return;
    if (button.dataset.action === 'admin') openAdminPanel();
    if (button.dataset.action === 'diag') openDiag(el.diagDialog);
    if (button.dataset.action === 'reset-layout') resetView();
  });
  bindTrend({ select: el.range, form: el.customRange, tabs: el.metricTabs, onRange: setRange, onCustom: (custom) => { state.custom = custom; setRange('custom'); }, onMetric: setMetric });
  el.chartExpand.addEventListener('click', () => setFocus('chart'));
  el.mapExpand.addEventListener('click', () => setFocus('map'));
  el.nodeFilter.addEventListener('input', () => { state.filter = el.nodeFilter.value; schedule('nodes'); });
  el.btnConnect.addEventListener('click', toggleLive);
  el.btnRefresh.addEventListener('click', () => { loadNodes(); refreshAll(); log('Data dimuat ulang.', 'info'); });
  bindTabs(el.tabs, setTab);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else { refreshAll(); startPolling(); }
  });
}

function tick() {
  el.clock.textContent = fmtClock(Date.now());
  schedule('live');
}

// ── Boot ──────────────────────────────────────────────────────────────────
function boot() {
  const pref = readPref();
  if (RANGES.some((r) => r.key === pref.range)) state.range = pref.range;
  if (pref.metric && (pref.metric === OVERVIEW.key || METRICS.some((d) => d.key === pref.metric))) state.metric = pref.metric;
  if (pref.tab) state.tab = pick(pref.tab, ['alerts', 'io', 'history', 'log'], 'alerts');
  safe('kontrol', bindControls);
  safe('kartu', () => mountMetrics(el.metrics, setMetric));
  const onHover = (row, hovering) => safe('readout', () => renderReadout(el.readout, row, hovering));
  mainChart = safe('grafik', () => createMainChart(el.chartSingle, { onHover })) || null;
  overviewChart = safe('grafik semua', () => createOverview(el.chartMulti, {
    onHover: (row, hovering) => safe('readout', () => renderReadout(el.readout, row, hovering, { timeOnly: true })),
    onPick: setMetric,
  })) || null;
  safe('tata letak', () => initLayout(resizeMap));
  mapReady = Boolean(safe('peta', () => initMap(el.map)));
  tick();
  setInterval(tick, 1000);
  setInterval(() => schedule('side', 'nodes'), 30e3);
  loadNodes();
  connectLive();
  startPolling();
  schedule('live', 'trend', 'side', 'nodes', 'metrics');
}

boot();
