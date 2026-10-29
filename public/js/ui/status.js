// Pil status di topbar (Node · Broker · Pencatat · Database) + rinciannya.

import { state } from '../store.js';
import { chain } from '../derive.js';
import { fill, h, pick } from '../dom.js';

const ST = ['ok', 'warn', 'bad', 'idle'];
const SHORT = { node: 'Node', broker: 'Broker', logger: 'Pencatat', db: 'Database' };

function sub(link) {
  // Ringkas untuk pil: ambil umur dari kalimat detail ("(3 hari lalu)").
  const age = /\(([^)]+lalu|baru saja)\)/.exec(link.detail || '');
  return age ? age[1] : '';
}

export function renderStatus({ strip, detail, now = Date.now() }) {
  if (!state.activeId) {
    fill(strip, h('span', { class: 'pill st-idle' }, h('span', { class: 'dot st-idle' }), h('span', { class: 'pill-label', text: state.nodesLoaded ? 'Belum ada node' : 'Memeriksa sistem…' })));
    return;
  }
  const result = chain(state.activeId, now);
  strip.setAttribute('aria-label', `Status sistem: ${result.headline}. Klik untuk rincian.`);
  fill(strip, result.links.map((l) => {
    const st = pick(l.st, ST, 'idle');
    const age = sub(l);
    return h('span', { class: `pill st-${st}`, title: `${l.title}: ${l.state}${l.detail ? ` — ${l.detail}` : ''}`, 'data-short': SHORT[l.key] },
      h('span', { class: `dot st-${st}` }),
      h('span', { class: 'pill-text' },
        h('span', { class: 'pill-label', text: `${SHORT[l.key]}: ${l.state.toLowerCase()}` }),
        age && h('span', { class: 'pill-sub', text: age })));
  }));
  if (!detail.hidden) {
    fill(detail, h('ol', { class: 'chain-steps' }, result.links.map((l) => h('li', { class: 'chain-step' },
      h('span', { class: `dot st-${pick(l.st, ST, 'idle')}` }),
      h('h3', { text: `${l.title} · ${l.state}` }),
      l.detail && h('p', { text: l.detail })))));
  }
}
