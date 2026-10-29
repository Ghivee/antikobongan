// Tab Riwayat: 30 pembacaan mentah terakhir yang tersimpan di database.

import { state } from '../store.js';
import { fill, h, lvClass, mark } from '../dom.js';
import { fmtAge, fmtDateTime, fmtNum } from '../format.js';
import { levelOf } from '../risk.js';

export function renderHistory(el, { onRetry, now = Date.now() }) {
  const id = state.activeId;
  const entry = id && state.readings[id];
  const latest = id && state.latest[id] && state.latest[id].data;
  if (!entry || (entry.loading && !entry.items)) { fill(el, h('p', { class: 'hint', text: 'Memuat pembacaan tersimpan…' })); return; }
  if (entry.error && !entry.items) {
    fill(el, h('p', { class: 'hint' }, `Riwayat tidak dapat dimuat (${entry.error}). `, h('button', { type: 'button', class: 'link-btn', text: 'Coba lagi', onclick: onRetry })));
    return;
  }
  const rows = entry.items || [];
  if (!rows.length) { fill(el, h('p', { class: 'hint', text: 'Belum ada pembacaan tersimpan untuk node ini.' })); return; }
  fill(el,
    h('p', { class: 'hist-meta', text: `${rows.length} pembacaan terakhir dari ${latest ? fmtNum(latest.total, 0) : '?'} tersimpan · terbaru ${fmtAge(Date.parse(rows[0].received_at), now)}` }),
    h('table', { class: 'hist-table' },
      h('thead', {}, h('tr', {}, ['Waktu (WIB)', '°C', 'RH %', 'Gas', 'Tanah', 'Skor'].map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', {}, rows.map((r) => {
        const level = levelOf(r.risk_score);
        return h('tr', {},
          h('td', { title: fmtDateTime(Date.parse(r.received_at), { seconds: true, year: true }), text: fmtDateTime(Date.parse(r.received_at), { seconds: true }).replace(' WIB', '') }),
          h('td', { text: fmtNum(r.suhu, 1) }),
          h('td', { text: fmtNum(r.kelembapan, 0) }),
          h('td', { text: fmtNum(r.gas, 0) }),
          h('td', { text: fmtNum(r.kelembapan_tanah, 0) }),
          h('td', { class: lvClass(level) }, Number.isFinite(r.risk_score) ? [mark(level), ` ${r.risk_score}`] : '—'));
      }))));
}
