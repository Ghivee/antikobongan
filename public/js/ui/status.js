// Bilah status ringkas di topbar (Node · Broker · Pencatat · Database) + rinciannya.

import { state } from '../store.js';
import { chain } from '../derive.js';
import { fill, h, pick } from '../dom.js';

const ST = ['ok', 'warn', 'bad', 'idle'];
const SHORT = { node: 'Node', broker: 'Broker', logger: 'Pencatat', db: 'Database' };

function age(link) {
  // Umur ringkas dari kalimat detail ("(3 hari lalu)" → "3 hari").
  const m = /\(([^)]+?)(?: lalu)?\)/.exec(link.detail || '');
  return m && /dtk|mnt|jam|hari|baru/.test(m[1]) ? m[1] : '';
}

export function renderStatus({ strip, detail, now = Date.now() }) {
  if (!state.activeId) {
    fill(strip, h('span', { class: 'st-item st-idle' }, h('span', { class: 'dot st-idle' }), h('span', { class: 'st-val', text: state.nodesLoaded ? 'Belum ada node' : 'Memeriksa sistem…' })));
    return;
  }
  const result = chain(state.activeId, now);
  strip.setAttribute('aria-label', `Status sistem: ${result.headline}. Klik untuk rincian.`);
  strip.title = `${result.headline} · klik untuk rincian`;
  // Satu baris ringkas: titik warna + nama + keadaan. Bila sehat cukup umur
  // datanya; bila bermasalah, keadaan ditulis (berwarna) beserta umurnya.
  fill(strip, result.links.map((l) => {
    const st = pick(l.st, ST, 'idle');
    const a = age(l);
    const val = st === 'ok' ? (a || l.state.toLowerCase()) : `${l.state.toLowerCase()}${a ? ` · ${a}` : ''}`;
    return h('span', { class: `st-item st-${st}`, title: `${l.title}: ${l.state}${l.detail ? ` — ${l.detail}` : ''}` },
      h('span', { class: `dot st-${st}` }),
      h('span', { class: 'st-name', text: SHORT[l.key] }),
      h('span', { class: 'st-val', text: val }));
  }));
  if (!detail.hidden) {
    fill(detail, h('ol', { class: 'chain-steps' }, result.links.map((l) => h('li', { class: 'chain-step' },
      h('span', { class: `dot st-${pick(l.st, ST, 'idle')}` }),
      h('h3', { text: `${l.title} · ${l.state}` }),
      l.detail && h('p', { text: l.detail })))));
  }
}
