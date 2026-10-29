// Peringatan & kejadian: event database (pencatat) + peringatan yang dihitung
// dasbor dari data live. Topik MQTT "alert" sengaja tidak dipakai.

import { state } from '../store.js';
import { fill, h, mark } from '../dom.js';
import { fmtAge, fmtDateTime, fmtNum } from '../format.js';

const KINDS = {
  RISK_HIGH: { level: 'TINGGI', title: 'Risiko tinggi' },
  RISK_CRITICAL: { level: 'KRITIS', title: 'Risiko kritis' },
  RISK_RECOVERED: { level: 'NORMAL', title: 'Risiko kembali normal' },
  NODE_OFFLINE: { level: null, title: 'Node berhenti mengirim' },
  NODE_ONLINE: { level: null, title: 'Node kembali mengirim' },
};

function metaText(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  if (Number.isFinite(meta.risk_score)) parts.push(`skor ${meta.risk_score}`);
  if (Number.isFinite(meta.suhu)) parts.push(`suhu ${fmtNum(meta.suhu, 1)} °C`);
  if (Number.isFinite(meta.kelembapan)) parts.push(`kelembapan ${fmtNum(meta.kelembapan, 0)} %`);
  if (Number.isFinite(meta.gas)) parts.push(`gas ${fmtNum(meta.gas, 0)} ADC`);
  if (Number.isFinite(meta.kelembapan_tanah)) parts.push(`tanah ${fmtNum(meta.kelembapan_tanah, 0)} %`);
  if (Number.isFinite(meta.silent_seconds)) parts.push(`tanpa data ${fmtNum(meta.silent_seconds, 0)} detik`);
  return parts.join(' · ');
}

function fromDb(row) {
  const kind = KINDS[row.kind] || { level: null, title: String(row.kind || 'Kejadian') };
  const message = typeof row.message === 'string' && !/^AntiKobongan:/.test(row.message) ? row.message : '';
  return { at: Date.parse(row.created_at), level: kind.level, title: kind.title, detail: metaText(row.meta) || message, live: false, kind: row.kind };
}

function fromLive(alert) {
  return {
    at: alert.at,
    level: alert.recovered ? 'NORMAL' : alert.level,
    title: alert.recovered ? 'Risiko kembali di bawah 60' : alert.level === 'KRITIS' ? 'Risiko kritis' : 'Risiko tinggi',
    detail: `skor ${alert.score}`,
    live: true,
  };
}

export function mergedEvents(nodeId) {
  const db = ((state.events[nodeId] && state.events[nodeId].items) || []).map(fromDb);
  // Peringatan live yang sudah tercatat pencatat (±2 menit, level sama) tidak digandakan.
  const live = (state.liveAlerts[nodeId] || []).map(fromLive)
    .filter((a) => !db.some((e) => e.level === a.level && Math.abs(e.at - a.at) < 120e3));
  return [...live, ...db].sort((a, b) => b.at - a.at);
}

export function renderEvents(list, foot, { onMore, onRetry, now = Date.now() }) {
  const id = state.activeId;
  const entry = id && state.events[id];
  const items = id ? mergedEvents(id) : [];
  if (!items.length) {
    let text = 'Belum ada peringatan atau kejadian tercatat untuk node ini.';
    if (!entry || (entry.loading && !entry.items)) text = 'Memuat kejadian…';
    fill(list, h('li', { class: 'empty', text: entry && entry.error ? '' : text }));
  } else {
    fill(list, items.map((e) => h('li', { class: 'event' },
      mark(e.level),
      h('div', {},
        h('span', { class: 'event-title', text: e.title }),
        e.live && h('span', { class: 'event-tag', text: 'live', title: 'Dihitung dasbor dari data live' }),
        h('time', { class: 'event-time', datetime: new Date(e.at).toISOString(), title: fmtDateTime(e.at, { year: true, seconds: true }) }, `${fmtDateTime(e.at)} · ${fmtAge(e.at, now)}`)),
      e.detail && h('p', { class: 'event-detail', text: e.detail }))));
  }
  const footer = [];
  if (entry && entry.error) {
    footer.push(h('p', { class: 'hint' }, `Kejadian tersimpan tidak dapat dimuat (${entry.error}). `, h('button', { type: 'button', class: 'link-btn', text: 'Coba lagi', onclick: onRetry })));
  }
  if (entry && entry.nextBefore) {
    footer.push(h('button', { type: 'button', class: 'btn-small', text: entry.loading ? 'Memuat…' : 'Muat kejadian lebih lama', disabled: entry.loading, onclick: onMore }));
  }
  fill(foot, footer);
}
