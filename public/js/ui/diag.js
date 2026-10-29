// Laci Diagnostik: konfigurasi koneksi, ringkasan data, dan log teknis.

import { state } from '../store.js';
import { fill, h, pick } from '../dom.js';
import { fmtDateTime, fmtNum } from '../format.js';
import { logEntries, onLog } from '../log.js';

let unsubscribe = null;

function rows(pairs) {
  return h('dl', { class: 'diag-grid' }, pairs.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v ?? '—' })]));
}

function render(dialog) {
  const id = state.activeId;
  const latest = id && state.latest[id] && state.latest[id].data;
  const series = id && state.series[id] && state.series[id].data;
  const cfg = state.mqtt.config;
  const time = (iso) => (iso ? fmtDateTime(Date.parse(iso), { seconds: true, year: true }) : '—');
  fill(dialog,
    h('div', { class: 'dialog-head' }, h('h2', { id: 'diag-title', text: 'Diagnostik' }),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Tutup', text: '×', onclick: () => dialog.close() })),
    h('div', { class: 'dialog-body' },
      rows([
        ['Broker', cfg ? `${cfg.url}${cfg.public ? ' (publik, tanpa login)' : ''}` : '—'],
        ['Prefix topik', cfg ? cfg.prefix : '—'],
        ['Status broker', `${state.mqtt.state}${state.mqtt.detail ? ` — ${state.mqtt.detail}` : ''}`],
        ['Node aktif', id],
        ['Pembacaan tersimpan', latest ? fmtNum(latest.total, 0) : '—'],
        ['Pembacaan pertama', latest ? time(latest.first_at) : '—'],
        ['Pembacaan terakhir', latest ? time(latest.latest_at) : '—'],
        ['Sinyal pencatat', latest && latest.heartbeat ? time(latest.heartbeat.ts) : '—'],
        ['Versi rumus skor', latest && latest.reading && latest.reading.formula_version ? `v${latest.reading.formula_version}` : 'tidak tercatat'],
        ['Sumber grafik', series ? `${series.source === 'rpc' ? 'agregasi database' : 'agregasi server (migrasi 002 belum dijalankan)'} · bucket ${series.bucket_seconds} dtk` : '—'],
        ['Daftar node', state.nodesSource === 'nodes' ? 'tabel nodes' : state.nodesSource === 'node_status' ? 'node_status (tabel nodes kosong)' : state.nodesSource || '—'],
      ]),
      h('h3', { text: 'Log teknis (sesi ini)' }),
      h('ol', { class: 'log' }, logEntries().map((e) => h('li', { class: `lg-${pick(e.level, ['info', 'ok', 'warn', 'err'], 'info')}` },
        h('time', { text: fmtDateTime(e.at, { seconds: true }) }), e.message)))));
}

export function openDiag(dialog) {
  render(dialog);
  if (unsubscribe) unsubscribe();
  unsubscribe = onLog(() => { if (dialog.open) render(dialog); });
  dialog.addEventListener('close', () => { if (unsubscribe) unsubscribe(); unsubscribe = null; }, { once: true });
  if (!dialog.open) dialog.showModal();
}
