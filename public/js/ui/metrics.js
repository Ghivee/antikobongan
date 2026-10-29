// Deretan kartu metrik: nilai terkini + waktu pembacaan + sparkline 1 jam.

import { state } from '../store.js';
import { current } from '../derive.js';
import { fill, h } from '../dom.js';
import { fmtAge, fmtDateTime, fmtNum } from '../format.js';
import { buildModel, createSpark, extent, metricDef } from '../charts.js';

const STALE_MS = 5 * 60e3;
const CARDS = [
  { metric: 'suhu', field: 'suhu' },
  { metric: 'rh', field: 'kelembapan' },
  { metric: 'gas', field: 'gas' },
  { metric: 'tanah', field: 'kelembapan_tanah' },
  { metric: 'tekanan', field: 'tekanan', optional: true },
];
const cards = new Map();

export function mountMetrics(el, onPick) {
  for (const c of CARDS) {
    const def = metricDef(c.metric);
    const value = h('div', { class: 'met-value' });
    const delta = h('span', { class: 'met-delta' });
    const time = h('div', { class: 'met-time' });
    const box = h('div', { class: 'spark' });
    const cap = h('div', { class: 'spark-cap' });
    const card = h('button', { type: 'button', class: 'met', 'aria-pressed': 'false', title: def.hint ? `${def.hint} Klik untuk melihat grafiknya.` : `Klik untuk melihat grafik ${def.label.toLowerCase()}.`, onclick: () => onPick(c.metric) },
      h('div', { class: 'met-head' }, h('span', { class: 'met-label', text: def.label }), delta),
      value, time, box, cap);
    if (c.optional) card.hidden = true;
    el.append(card);
    cards.set(c.metric, { ...c, def, card, value, delta, time, box, cap, spark: null });
  }
}

export function renderMetrics({ now = Date.now(), sparkChanged = false } = {}) {
  const id = state.activeId;
  const cur = id ? current(id) : null;
  const latest = id && state.latest[id] && state.latest[id].data;
  const spark = id && state.spark[id];
  const live = id && state.live[id];
  let sparkModel = null;
  if (spark && spark.data) {
    const d = spark.data;
    sparkModel = buildModel({ series: d.series, from: d.from, to: spark.recent ? Math.max(d.to, now) : d.to, bucketSeconds: d.bucket_seconds, tail: spark.recent && live ? live.tail : [], now });
  }
  for (const c of cards.values()) {
    const { def, card } = c;
    const raw = cur ? cur[c.field] : null;
    const hasValue = raw !== null && raw !== undefined;
    if (c.optional) card.hidden = !(hasValue || (latest && latest.has_tekanan));
    if (card.hidden) continue;
    card.setAttribute('aria-pressed', String(state.metric === c.metric));
    const stale = cur ? now - cur.at > STALE_MS : false;
    card.classList.toggle('is-stale', stale);
    fill(c.value, hasValue ? fmtNum(raw, def.dec) : '—', hasValue ? h('small', { text: def.unit }) : null);
    const prev = cur && cur.prev ? cur.prev[c.field] : null;
    if (hasValue && prev !== null && prev !== undefined && !stale) {
      const d = raw - prev;
      c.delta.textContent = Math.abs(d) < 10 ** -def.dec / 2 ? 'tetap' : `${d > 0 ? '▲' : '▼'} ${fmtNum(Math.abs(d), def.dec)}`;
      c.delta.title = 'Perubahan dari pembacaan sebelumnya';
    } else {
      c.delta.textContent = '';
    }
    if (!cur) c.time.textContent = id ? 'Belum ada pembacaan' : '';
    else if (!hasValue) c.time.textContent = 'Tidak dikirim node';
    else c.time.textContent = stale ? `${fmtDateTime(cur.at)} · ${fmtAge(cur.at, now)}` : `${fmtDateTime(cur.at, { seconds: true })} · ${cur.source === 'live' ? 'live' : 'tersimpan'}`;

    if (!sparkModel || !sparkModel.rows.length) {
      if (c.spark || !c.box.querySelector('.spark-empty')) {
        c.spark = null;
        fill(c.box, h('div', { class: 'spark-empty', text: id ? 'Belum ada riwayat' : '' }));
      }
      c.cap.textContent = '';
      continue;
    }
    if (!c.spark) {
      fill(c.box);
      c.spark = createSpark(c.box, def);
      sparkChanged = true;
    }
    if (c.spark && (sparkChanged || spark.recent)) c.spark.render(sparkModel);
    const ext = extent(sparkModel, def.key);
    const until = spark.recent ? 'sampai sekarang' : `s/d ${fmtDateTime(spark.lastAt).replace(' WIB', '')}`;
    fill(c.cap, h('span', { text: `1 jam ${until}` }), h('span', { text: ext ? `${fmtNum(ext.min, def.dec)}–${fmtNum(ext.max, def.dec)}` : '' }));
  }
}
