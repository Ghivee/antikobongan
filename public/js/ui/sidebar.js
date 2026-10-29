// Sidebar: node per lokasi (dengan pencarian), aksi cepat, tab.

import { nodeLabel, state } from '../store.js';
import { current, nodeLink } from '../derive.js';
import { fill, h, lvClass, pick } from '../dom.js';
import { fmtAge, fmtNum } from '../format.js';
import { LEVEL_INFO, levelOf } from '../risk.js';

const ST = ['ok', 'warn', 'bad', 'idle'];

export function visibleNodes() {
  return state.nodes.filter((node) => node.aktif !== false);
}

function subtitle(node) {
  const parts = [node.lapisan, Number.isFinite(node.ketinggian) ? `${fmtNum(node.ketinggian, 0)} mdpl` : null, node.node_id].filter(Boolean);
  return parts.join(' · ');
}

export function renderNodeGroups(el, countEl, { onSelect, now = Date.now() }) {
  const nodes = visibleNodes();
  countEl.textContent = String(nodes.length);
  if (!nodes.length) {
    fill(el, h('p', { class: 'hint', text: state.nodesError ? `Daftar node tidak dapat dimuat: ${state.nodesError}` : state.nodesLoaded ? 'Belum ada node. Tambahkan lewat Pengaturan › Kelola node.' : 'Memuat…' }));
    return;
  }
  const q = state.filter.trim().toLowerCase();
  const shown = nodes.filter((n) => !q || [n.node_id, n.nama, n.gunung, n.lapisan].some((v) => v && String(v).toLowerCase().includes(q)));
  if (!shown.length) { fill(el, h('p', { class: 'hint', text: 'Tidak ada node yang cocok.' })); return; }
  const groups = new Map();
  for (const node of shown) {
    const key = node.gunung || 'Lokasi belum diisi';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  fill(el, [...groups].map(([name, list]) => [
    h('div', { class: 'node-group-title', text: `${name} · ${list.length} node` }),
    list.map((node) => {
      const link = nodeLink(node.node_id, now);
      const cur = current(node.node_id);
      const level = cur ? levelOf(cur.riskScore) : null;
      return h('button', { type: 'button', class: 'node-item', 'aria-current': node.node_id === state.activeId ? 'true' : null, onclick: () => onSelect(node.node_id) },
        h('span', { class: `dot st-${pick(link.st, ST, 'idle')}`, title: link.state }),
        h('span', { class: 'node-name', text: nodeLabel(node) }),
        h('span', { class: `node-score ${lvClass(level)}` },
          h('b', { text: cur && Number.isFinite(cur.riskScore) ? String(cur.riskScore) : '—' }),
          h('span', { text: level ? LEVEL_INFO[level].label : 'skor' })),
        h('span', { class: 'node-sub', text: `${link.state} · ${cur ? fmtAge(cur.at, now) : 'belum ada data'}` }),
        h('span', { class: 'node-sub', text: subtitle(node) }));
    }),
  ]));
}

export function renderActions({ connectBtn, nodeLine }) {
  const st = state.mqtt.state;
  const connected = st === 'connected';
  const busy = st === 'connecting' || st === 'reconnecting';
  fill(connectBtn,
    h('span', { class: `dot st-${connected ? 'ok' : busy ? 'warn' : 'bad'}` }),
    connected ? 'Putuskan live' : busy ? 'Menyambung…' : st === 'unavailable' ? 'Live tidak tersedia' : 'Sambungkan live');
  connectBtn.disabled = st === 'unavailable';
  connectBtn.title = connected ? 'Hentikan data live dari broker (riwayat tetap tampil)' : 'Sambungkan ke broker MQTT untuk data live';
  const node = state.nodes.find((n) => n.node_id === state.activeId);
  nodeLine.textContent = node ? `Node aktif: ${node.node_id}${node.gunung ? ` · ${node.gunung}` : ''}${state.mqtt.config ? ` · topik ${state.mqtt.config.prefix}/${node.node_id}/sensor` : ''}` : '';
}

export function bindTabs(tablist, onTab) {
  const buttons = [...tablist.querySelectorAll('[role=tab]')];
  const select = (button) => onTab(button.id.replace('tab-', ''));
  tablist.addEventListener('click', (event) => { const b = event.target.closest('[role=tab]'); if (b) select(b); });
  tablist.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const next = buttons[(i + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
    next.focus();
    select(next);
  });
}

export function renderTabs(tablist) {
  for (const button of tablist.querySelectorAll('[role=tab]')) {
    const key = button.id.replace('tab-', '');
    const on = key === state.tab;
    button.setAttribute('aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
    document.getElementById(button.getAttribute('aria-controls')).hidden = !on;
  }
}
