// Grafik: tren utama (satu besaran), ringkasan semua sensor (satu grafik per
// besaran, kursor sinkron), dan tren latar di kartu metrik.
// Sumbu waktu nyata, pita min–maks per bucket, jeda data diarsir (tidak
// dijembatani), dan readout di bawah kursor.

import { fmtDuration, fmtNum, fmtTick } from './format.js';
import { levelOf, THRESHOLDS } from './risk.js';
import { fill, h } from './dom.js';

export const METRICS = [
  { key: 'risk', label: 'Skor risiko', short: 'Skor', unit: '', avg: 'risk_avg', min: 'risk_min', max: 'risk_max', live: 'riskScore', dec: 0, y: [0, 100], step: 20 },
  { key: 'suhu', label: 'Suhu', short: 'Suhu', unit: '°C', avg: 'suhu_avg', min: 'suhu_min', max: 'suhu_max', live: 'suhu', dec: 1, y: [10, 50], step: 10, spark: [15, 45] },
  { key: 'rh', label: 'Kelembapan udara', short: 'Kelembapan', unit: '%', avg: 'rh_avg', min: 'rh_min', max: 'rh_max', live: 'kelembapan', dec: 0, y: [0, 100], step: 25, spark: [0, 100] },
  { key: 'gas', label: 'Gas/asap', short: 'Gas/asap', unit: 'ADC', avg: 'gas_avg', min: 'gas_min', max: 'gas_max', live: 'gas', dec: 0, y: [0, 1000], grow: true, spark: [0, 1500], hint: 'Nilai mentah sensor MQ-2 (0–4095), belum dikalibrasi ke ppm.' },
  { key: 'tanah', label: 'Kelembapan tanah', short: 'Tanah', unit: '%', avg: 'tanah_avg', min: 'tanah_min', max: 'tanah_max', live: 'kelembapan_tanah', dec: 0, y: [0, 100], step: 25, spark: [0, 100] },
  { key: 'tekanan', label: 'Tekanan udara', short: 'Tekanan', unit: 'hPa', avg: 'tekanan_avg', min: 'tekanan_avg', max: 'tekanan_avg', live: 'tekanan', dec: 1, y: [990, 1020], step: 10, spark: [990, 1020], optional: true },
];
export const metricDef = (key) => METRICS.find((d) => d.key === key) || METRICS[0];

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const LEVEL_VAR = { NORMAL: '--risk-normal', SEDANG: '--risk-sedang', TINGGI: '--risk-tinggi', KRITIS: '--risk-kritis' };
let colors = null;
let timeAxis = 'time';
let registered = false;

function readColors() {
  colors = {
    seri: css('--seri'), seriHex: css('--seri'), band: css('--band'), line: css('--line'), text3: css('--text-3'), text2: css('--text-2'), accent: css('--accent'),
    level: Object.fromEntries(Object.entries(LEVEL_VAR).map(([k, v]) => [k, css(v)])),
  };
}

function withAlpha(hex, alpha) {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// ── Model data ─────────────────────────────────────────────────────────────
// series: kolom dari /api/series. tail: pembacaan live mentah yang lebih baru
// dari bucket terakhir. Hasil: titik per metrik + daftar jeda.
export function buildModel({ series, from, to, bucketSeconds, tail = [], now = Date.now() }) {
  const bucketMs = bucketSeconds * 1000;
  const gapMs = Math.max(3 * bucketMs, 60e3);
  const rows = [];
  const cols = series || { t: [] };
  for (let i = 0; i < cols.t.length; i += 1) {
    const row = { x: cols.t[i] + bucketMs / 2, n: cols.n ? cols.n[i] : null };
    for (const def of METRICS) {
      row[def.key] = { avg: cols[def.avg] ? cols[def.avg][i] : null, min: cols[def.min] ? cols[def.min][i] : null, max: cols[def.max] ? cols[def.max][i] : null };
    }
    rows.push(row);
  }
  const lastSeriesX = rows.length ? cols.t[cols.t.length - 1] + bucketMs : -Infinity;
  for (const sample of tail) {
    if (sample.at <= lastSeriesX || sample.at < from || sample.at > to) continue;
    const row = { x: sample.at, n: 1, live: true };
    for (const def of METRICS) {
      const v = sample[def.live] === undefined ? null : sample[def.live];
      row[def.key] = { avg: v, min: v, max: v };
    }
    rows.push(row);
  }

  const gaps = [];
  const end = Math.min(to, now);
  if (!rows.length) {
    gaps.push({ from, to: end });
  } else {
    if (rows[0].x - from > gapMs) gaps.push({ from, to: rows[0].x - bucketMs / 2 });
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i].x - rows[i - 1].x > gapMs) gaps.push({ from: rows[i - 1].x + bucketMs / 2, to: rows[i].x - bucketMs / 2, index: i });
    }
    const lastX = rows[rows.length - 1].x;
    if (end - lastX > gapMs) gaps.push({ from: lastX + bucketMs / 2, to: end });
  }

  const points = {};
  for (const def of METRICS) points[def.key] = { avg: [], min: [], max: [] };
  const gapStarts = new Set(gaps.filter((g) => g.index).map((g) => g.index));
  rows.forEach((row, i) => {
    if (gapStarts.has(i)) {
      const x = rows[i - 1].x + bucketMs;
      for (const def of METRICS) for (const k of ['avg', 'min', 'max']) points[def.key][k].push({ x, y: null });
    }
    for (const def of METRICS) for (const k of ['avg', 'min', 'max']) points[def.key][k].push({ x: row.x, y: row[def.key][k] });
  });

  return { from, to, bucketMs, rows, gaps, points };
}

export function extent(model, key) {
  if (!model) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const row of model.rows) {
    const cell = row[key];
    if (cell.min !== null && cell.min !== undefined) lo = Math.min(lo, cell.min);
    if (cell.max !== null && cell.max !== undefined) hi = Math.max(hi, cell.max);
  }
  return Number.isFinite(lo) ? { min: lo, max: hi } : null;
}

// Baris terdekat dari waktu x (pencarian biner); x null = baris terakhir.
export function rowAt(model, x) {
  if (!model || !model.rows.length) return null;
  const rows = model.rows;
  if (x === null || x === undefined) return rows[rows.length - 1];
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].x < x) lo = mid + 1;
    else hi = mid;
  }
  const best = lo > 0 && Math.abs(rows[lo - 1].x - x) < Math.abs(rows[lo].x - x) ? rows[lo - 1] : rows[lo];
  return Math.abs(best.x - x) <= Math.max(model.bucketMs * 1.5, 60e3) ? best : null;
}

function yRange(def, ext, base = def.y) {
  let [lo, hi] = base;
  if (ext) {
    const step = def.step || 1;
    if (def.grow) hi = Math.max(hi, Math.ceil((ext.max * 1.1) / 100) * 100);
    if (ext.min < lo) lo = Math.floor((ext.min - 1) / step) * step;
    if (ext.max > hi) hi = Math.ceil((ext.max + 1) / step) * step;
  }
  return [lo, hi];
}

// Langkah tick waktu yang rapi per lebar jendela.
function timeStep(spanMs) {
  const hour = 3600e3;
  if (spanMs <= 2 * hour) return { unit: 'minute', stepSize: 15 };
  if (spanMs <= 8 * hour) return { unit: 'hour', stepSize: 1 };
  if (spanMs <= 36 * hour) return { unit: 'hour', stepSize: 3 };
  if (spanMs <= 4 * 24 * hour) return { unit: 'hour', stepSize: 12 };
  if (spanMs <= 10 * 24 * hour) return { unit: 'day', stepSize: 1 };
  return { unit: 'day', stepSize: 5 };
}

// ── Plugin ─────────────────────────────────────────────────────────────────
const bandsPlugin = {
  id: 'akBands',
  beforeDatasetsDraw(chart) {
    const ak = chart.$ak;
    if (!ak || ak.metric !== 'risk' || ak.spark) return;
    const { ctx, chartArea: area, scales: { y } } = chart;
    ctx.save();
    for (const [level, lo, hi] of [['SEDANG', THRESHOLDS.SEDANG, THRESHOLDS.TINGGI], ['TINGGI', THRESHOLDS.TINGGI, THRESHOLDS.KRITIS], ['KRITIS', THRESHOLDS.KRITIS, 100]]) {
      const top = y.getPixelForValue(hi);
      const bottom = y.getPixelForValue(lo);
      ctx.fillStyle = withAlpha(colors.level[level], 0.07);
      ctx.fillRect(area.left, top, area.right - area.left, bottom - top);
      ctx.strokeStyle = withAlpha(colors.level[level], 0.5);
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(area.left, bottom);
      ctx.lineTo(area.right, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      if (ak.mini) continue;
      ctx.fillStyle = colors.level[level];
      ctx.font = '12px "Public Sans", system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${level[0]}${level.slice(1).toLowerCase()} ≥ ${lo}`, area.right - 6, bottom - 2);
    }
    ctx.restore();
  },
};

const gapsPlugin = {
  id: 'akGaps',
  beforeDatasetsDraw(chart) {
    const ak = chart.$ak;
    if (!ak || !ak.model || !ak.model.gaps.length) return;
    const { ctx, chartArea: area, scales: { x } } = chart;
    const height = area.bottom - area.top;
    for (const gap of ak.model.gaps) {
      const left = Math.max(x.getPixelForValue(gap.from), area.left);
      const right = Math.min(x.getPixelForValue(gap.to), area.right);
      if (right - left < 2) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, area.top, right - left, height);
      ctx.clip();
      ctx.fillStyle = 'rgba(138, 144, 135, 0.07)';
      ctx.fillRect(left, area.top, right - left, height);
      // Tren latar kartu: cukup bidang samar, tanpa arsir.
      if (ak.spark) { ctx.restore(); continue; }
      ctx.strokeStyle = 'rgba(138, 144, 135, 0.14)';
      ctx.lineWidth = 1;
      for (let sx = left - height; sx < right; sx += ak.spark ? 5 : 8) {
        ctx.beginPath();
        ctx.moveTo(sx, area.bottom);
        ctx.lineTo(sx + height, area.top);
        ctx.stroke();
      }
      ctx.restore();
      if (!ak.spark && !ak.mini && right - left > 96) {
        ctx.save();
        ctx.fillStyle = colors.text2;
        ctx.font = '12px "Public Sans", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const mid = (left + right) / 2;
        ctx.fillText('tidak ada data', mid, area.top + height / 2 - 8);
        ctx.fillStyle = colors.text3;
        ctx.fillText(fmtDuration(gap.to - gap.from), mid, area.top + height / 2 + 9);
        ctx.restore();
      }
    }
  },
};

const crosshairPlugin = {
  id: 'akCrosshair',
  afterDatasetsDraw(chart) {
    const ak = chart.$ak;
    if (!ak || ak.hoverX === null || ak.hoverX === undefined) return;
    const { ctx, chartArea: area, scales: { x } } = chart;
    const px = x.getPixelForValue(ak.hoverX);
    if (px < area.left || px > area.right) return;
    ctx.save();
    ctx.strokeStyle = colors.accent;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(px, area.top);
    ctx.lineTo(px, area.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

export function chartsAvailable() {
  return Boolean(window.Chart);
}

function ensureSetup() {
  if (registered) return;
  readColors();
  try {
    new window.Chart._adapters._date().format(0, 'yyyy');
  } catch (_) {
    timeAxis = 'linear';
  }
  window.Chart.register(bandsPlugin, gapsPlugin, crosshairPlugin);
  registered = true;
}

function datasets(isRisk, spark, bg = false) {
  const lineColor = (ctx) => {
    if (!isRisk) return colors.seri;
    const a = ctx.p0 && ctx.p0.parsed.y;
    const b = ctx.p1 && ctx.p1.parsed.y;
    return colors.level[levelOf(Math.max(a ?? 0, b ?? 0)) || 'NORMAL'];
  };
  const isolated = (ctx) => {
    const data = ctx.dataset.data;
    const i = ctx.dataIndex;
    if (!data[i] || data[i].y === null) return 0;
    const prev = data[i - 1];
    const next = data[i + 1];
    return (!prev || prev.y === null) && (!next || next.y === null) ? (spark ? 1.5 : 2.5) : 0;
  };
  if (bg) {
    // Tren latar kartu: area rata-rata yang samar di belakang angka.
    return [{
      label: 'rata-rata', data: [], borderColor: withAlpha(colors.seriHex, 0.55), borderWidth: 1.4, pointRadius: isolated, pointHoverRadius: 0,
      pointBackgroundColor: withAlpha(colors.seriHex, 0.7), fill: 'start', backgroundColor: withAlpha(colors.seriHex, 0.1), tension: 0.25, spanGaps: false,
    }];
  }
  return [
    { label: 'min', data: [], borderWidth: 0, pointRadius: 0, fill: false, spanGaps: false },
    { label: 'maks', data: [], borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: colors.band, spanGaps: false },
    {
      label: 'rata-rata', data: [], borderColor: colors.seri, borderWidth: spark ? 1.2 : 1.6, pointRadius: isolated, pointHoverRadius: 0,
      pointBackgroundColor: isRisk ? (ctx) => colors.level[levelOf(ctx.raw && ctx.raw.y) || 'NORMAL'] : colors.seri,
      tension: 0, spanGaps: false, segment: { borderColor: lineColor },
    },
  ];
}

function setData(chart, model, def) {
  const pts = model.points[def.key];
  if (chart.data.datasets.length === 1) { chart.data.datasets[0].data = pts.avg; return; }
  chart.data.datasets[0].data = pts.min;
  chart.data.datasets[1].data = pts.max;
  chart.data.datasets[2].data = pts.avg;
}

// Chart.js memutar ulang event mouse terakhir setiap update; abaikan bila
// kursor sebenarnya sudah tidak di atas kanvas (kursor tidak "tertinggal").
// Sentuhan: nilai tetap tampil setelah jari diangkat.
function hoverGuard(canvas, setHover) {
  let inside = false;
  canvas.addEventListener('pointerenter', () => { inside = true; });
  canvas.addEventListener('pointerdown', () => { inside = true; });
  canvas.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'touch') return;
    inside = false;
    setHover(null);
  });
  return (x) => { if (inside) setHover(x); };
}

function lineOptions(ak, onHover, mini) {
  return {
    animation: false, parsing: false, normalized: true, responsive: true, maintainAspectRatio: false,
    events: ['mousemove', 'mouseout', 'touchstart', 'touchmove', 'click'],
    onHover: (event, _items, c) => onHover(event.type === 'mouseout' ? null : c.scales.x.getValueForPixel(event.x)),
    plugins: { legend: { display: false }, tooltip: { enabled: false }, decimation: { enabled: false } },
    layout: { padding: mini ? { right: 4 } : 0 },
    scales: {
      x: {
        type: timeAxis, grid: { color: colors.line, drawTicks: false }, border: { display: false },
        ticks: { color: colors.text3, font: { size: 12 }, maxRotation: 0, autoSkip: Boolean(mini), autoSkipPadding: 16, maxTicksLimit: mini ? 6 : 14, padding: mini ? 4 : 6, callback: (v) => fmtTick(Number(v), ak.model ? ak.model.to - ak.model.from : 0) },
      },
      y: { grid: { color: colors.line, drawTicks: false }, border: { display: false }, ticks: { color: colors.text3, font: { size: 12 }, padding: mini ? 4 : 6, maxTicksLimit: mini ? 4 : 11, callback: (v) => fmtNum(v, 0) } },
    },
  };
}

const NICE = [1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];

function applyScales(chart, model, def, mini) {
  chart.options.scales.x.min = model.from;
  chart.options.scales.x.max = model.to;
  if (timeAxis === 'time') {
    const step = timeStep(model.to - model.from);
    // Grafik sempit: jarak tick digandakan agar label tidak berdempet.
    if (chart.width < 560) step.stepSize *= 2;
    if (mini) chart.options.scales.x.time = { unit: step.unit };
    else chart.options.scales.x.time = step;
  }
  const [lo, hi] = yRange(def, extent(model, def.key));
  chart.options.scales.y.min = lo;
  chart.options.scales.y.max = hi;
  chart.options.scales.y.ticks.stepSize = mini ? NICE.find((c) => (hi - lo) / c <= 4) : def.step;
}

// ── Grafik utama ──────────────────────────────────────────────────────────
export function createMainChart(container, { onHover }) {
  if (!chartsAvailable()) {
    fill(container, h('div', { class: 'chart-error' }, h('p', { text: 'Grafik tidak dapat dimuat karena pustaka grafik gagal diunduh. Panel lain tetap berjalan.' })));
    return null;
  }
  ensureSetup();
  const canvas = h('canvas', { role: 'img', 'aria-label': 'Grafik tren sensor' });
  container.append(canvas);
  let current = null;
  const ak = { model: null, metric: 'risk', hoverX: null };
  const chart = new window.Chart(canvas, { type: 'line', data: { datasets: [] }, options: lineOptions(ak, hoverGuard(canvas, (x) => setHover(x)), false) });
  chart.$ak = ak;

  function setHover(x) {
    chart.$ak.hoverX = x;
    chart.draw();
    onHover(rowAt(chart.$ak.model, x), x !== null);
  }

  return {
    render(model, metricKey) {
      const def = metricDef(metricKey);
      if (!current || current !== def.key) {
        chart.data.datasets = datasets(def.key === 'risk', false);
        current = def.key;
      }
      chart.$ak.model = model;
      chart.$ak.metric = def.key;
      setData(chart, model, def);
      applyScales(chart, model, def, false);
      chart.update('none');
      onHover(rowAt(model, chart.$ak.hoverX), chart.$ak.hoverX !== null);
    },
    resize() { chart.resize(); },
  };
}

// ── Semua sensor: satu grafik kecil per besaran, sumbu waktu & kursor sinkron ──
// Jumlah kolom dipilih dari rasio kotak agar tiap grafik tetap proporsional.
function bestColumns(n, width, height) {
  let best = 1;
  let score = Infinity;
  for (let cols = 1; cols <= n; cols += 1) {
    const rows = Math.ceil(n / cols);
    const w = width / cols;
    const hgt = height / rows;
    if (w < 190 && cols > 1) break;
    // Utamakan grafik setinggi ≥ 130 px; di bawah itu kotak digulir.
    const s = Math.abs(Math.log((w / hgt) / 2.4)) + (rows * cols - n) * 0.15 + (hgt < 130 ? 4 + (130 - hgt) / 20 : 0);
    if (s < score) { score = s; best = cols; }
  }
  return best;
}

export function createOverview(container, { onHover, onPick }) {
  if (!chartsAvailable()) return null;
  ensureSetup();
  const grid = h('div', { class: 'ov-grid' });
  container.append(grid);
  const cells = new Map();
  let model = null;
  let hoverX = null;

  for (const def of METRICS) {
    const range = h('span', { class: 'ov-range' });
    const plot = h('div', { class: 'ov-plot' });
    const canvas = h('canvas', { role: 'img', 'aria-label': `Grafik ${def.label.toLowerCase()}` });
    plot.append(canvas);
    const title = def.unit ? `${def.label} (${def.unit})` : `${def.label} (/100)`;
    const head = h('button', { type: 'button', class: 'ov-head', title: `Buka grafik ${def.label.toLowerCase()} saja`, onclick: () => onPick(def.key) },
      h('span', { class: 'ov-label', text: title }), range);
    const cell = h('div', { class: 'ov-cell', dataset: { metric: def.key } }, head, plot);
    grid.append(cell);
    const ak = { model: null, metric: def.key, hoverX: null, mini: true };
    const chart = new window.Chart(canvas, { type: 'line', data: { datasets: datasets(def.key === 'risk', false) }, options: lineOptions(ak, hoverGuard(canvas, (x) => setHover(x)), true) });
    chart.$ak = ak;
      cells.set(def.key, { def, cell, chart, range });
  }

  // Kepala tiap grafik: nilai di kursor (atau terakhir) · rentang di jendela.
  function showValues(row) {
    for (const c of cells.values()) {
      if (c.cell.hidden) continue;
      const v = row ? row[c.def.key].avg : null;
      fill(c.range, h('b', { text: v === null || v === undefined ? '—' : `${fmtNum(v, c.def.dec)}${c.def.unit ? ` ${c.def.unit}` : ''}` }), c.ext ? ` · ${c.ext}` : '');
    }
  }

  function setHover(x) {
    hoverX = x;
    for (const c of cells.values()) { c.chart.$ak.hoverX = x; if (!c.cell.hidden) c.chart.draw(); }
    const row = rowAt(model, x);
    showValues(row);
    onHover(row, x !== null);
  }

  function layout() {
    const visible = [...cells.values()].filter((c) => !c.cell.hidden).length || 1;
    const fixed = getComputedStyle(grid).position === 'absolute';
    grid.style.setProperty('--ov-cols', String(fixed ? bestColumns(visible, grid.clientWidth, grid.clientHeight) : Math.max(1, Math.floor(grid.clientWidth / 280))));
    grid.style.setProperty('--ov-rows', String(Math.ceil(visible / Number(grid.style.getPropertyValue('--ov-cols')))));
  }
  if (window.ResizeObserver) new ResizeObserver(layout).observe(grid);

  return {
    render(nextModel, { hasTekanan }) {
      model = nextModel;
      for (const c of cells.values()) {
        c.cell.hidden = Boolean(c.def.optional && !hasTekanan);
        if (c.cell.hidden) continue;
        c.chart.$ak.model = model;
        setData(c.chart, model, c.def);
        applyScales(c.chart, model, c.def, true);
        c.chart.update('none');
        const ext = extent(model, c.def.key);
        c.ext = ext ? `${fmtNum(ext.min, c.def.dec)}–${fmtNum(ext.max, c.def.dec)}` : 'tidak ada data';
        c.range.title = ext ? `Rentang di jendela ini: ${c.ext}${c.def.unit ? ` ${c.def.unit}` : ''}` : '';
      }
      layout();
      const row = rowAt(model, hoverX);
      showValues(row);
      onHover(row, hoverX !== null);
    },
  };
}

// ── Tren latar kartu (skala Y tetap per besaran) ──────────────────────────
export function createSpark(box, def) {
  if (!chartsAvailable()) return null;
  ensureSetup();
  const canvas = h('canvas', { 'aria-hidden': 'true' });
  box.append(canvas);
  const chart = new window.Chart(canvas, {
    type: 'line',
    data: { datasets: datasets(def.key === 'risk', true, true) },
    options: {
      animation: false, parsing: false, normalized: true, responsive: true, maintainAspectRatio: false, events: [],
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      layout: { padding: { top: 4, bottom: 0 } },
      scales: { x: { type: 'linear', display: false }, y: { display: false } },
    },
  });
  chart.$ak = { model: null, metric: def.key, spark: true };
  return {
    render(model) {
      chart.$ak.model = model;
      setData(chart, model, def);
      chart.options.scales.x.min = model.from;
      chart.options.scales.x.max = model.to;
      const [lo, hi] = yRange(def, extent(model, def.key), def.spark || def.y);
      chart.options.scales.y.min = lo;
      chart.options.scales.y.max = hi;
      chart.update('none');
    },
  };
}
