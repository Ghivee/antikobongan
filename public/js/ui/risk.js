// Panel indeks risiko: gauge (satu angka), level, waktu data, kontribusi
// skor per faktor, skala ambang, dan saran.

import { state } from '../store.js';
import { current } from '../derive.js';
import { fill, h, lvClass, mark } from '../dom.js';
import { fmtAge, fmtDateTime, fmtNum } from '../format.js';
import { components, FACTORS, LEVEL_INFO, levelOf, THRESHOLDS } from '../risk.js';
import { rowAt } from '../charts.js';

const STALE_MS = 5 * 60e3;
const SVG = 'http://www.w3.org/2000/svg';
const LEVEL_VAR = { NORMAL: '--risk-normal', SEDANG: '--risk-sedang', TINGGI: '--risk-tinggi', KRITIS: '--risk-kritis' };

function svg(tag, attrs) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function gauge(score, level) {
  const r = 56;
  const len = Math.PI * r;
  const root = svg('svg', { viewBox: '0 0 132 70', width: 132, height: 70, 'aria-hidden': 'true' });
  const arc = `M10 66 A${r} ${r} 0 0 1 122 66`;
  root.append(svg('path', { d: arc, fill: 'none', stroke: 'var(--line)', 'stroke-width': 10, 'stroke-linecap': 'round' }));
  if (Number.isFinite(score)) {
    const v = Math.max(0, Math.min(score, 100)) / 100;
    root.append(svg('path', {
      d: arc, fill: 'none', stroke: `var(${LEVEL_VAR[level] || '--none'})`, 'stroke-width': 10, 'stroke-linecap': 'round',
      'stroke-dasharray': `${len * v} ${len}`,
    }));
  }
  return h('div', { class: 'gauge' }, root, h('div', { class: 'gauge-num' }, Number.isFinite(score) ? String(score) : '—', h('small', { text: '/100' })));
}

function trendText(cur) {
  if (!Number.isFinite(cur.riskScore)) return null;
  const past = rowAt(state.mainModel, cur.at - 3600e3);
  if (!past || past.risk.avg === null || Math.abs(past.x - (cur.at - 3600e3)) > 10 * 60e3) return null;
  const diff = Math.round(cur.riskScore - past.risk.avg);
  if (diff === 0) return 'Sama dengan 1 jam sebelumnya';
  return `${diff > 0 ? '▲ Naik' : '▼ Turun'} ${Math.abs(diff)} poin dari 1 jam sebelumnya`;
}

function scale(score) {
  const zones = [['NORMAL', 0, THRESHOLDS.SEDANG], ['SEDANG', THRESHOLDS.SEDANG, THRESHOLDS.TINGGI], ['TINGGI', THRESHOLDS.TINGGI, THRESHOLDS.KRITIS], ['KRITIS', THRESHOLDS.KRITIS, 100]];
  const bar = h('div', { class: 'scale-bar' }, zones.map(([lv, a, b]) => h('span', { class: lvClass(lv), dataset: { w: b - a } })));
  const labels = h('div', { class: 'scale-labels' }, [0, 40, 60, 80, 100].map((v) => h('span', { dataset: { x: v }, text: String(v) })));
  const pointer = h('div', { class: 'scale-pointer' }, Number.isFinite(score) ? h('i', { dataset: { x: Math.min(Math.max(score, 0), 100) } }) : null);
  return h('div', { class: 'scale', title: 'Ambang: Normal < 40 ≤ Sedang < 60 ≤ Tinggi < 80 ≤ Kritis' }, bar, pointer, labels);
}

export function renderRisk(section, badge, body, { onRetry, now = Date.now() }) {
  const id = state.activeId;
  const latest = id ? state.latest[id] : null;
  const cur = id ? current(id) : null;
  section.classList.remove('is-stale');
  badge.className = 'risk-badge';
  fill(badge);

  if (!id) {
    fill(body, h('div', { class: 'empty' }, h('p', { text: state.nodesLoaded ? 'Belum ada node terdaftar.' : 'Memuat daftar node…' })));
    return;
  }
  if (!cur) {
    if (!latest) {
      fill(body, h('div', { class: 'skeleton skeleton-risk', 'aria-label': 'Memuat' }));
      return;
    }
    if (latest.error) {
      fill(body, h('div', { class: 'empty' }, h('p', { text: `Pembacaan tidak dapat dimuat: ${latest.error}` }), h('p', {}, h('button', { type: 'button', class: 'link-btn', text: 'Coba lagi', onclick: onRetry }))));
      return;
    }
    const prefix = state.mqtt.config ? state.mqtt.config.prefix : 'antikobongan/…';
    fill(body, h('div', { class: 'empty' }, h('p', { text: 'Belum ada data dari node ini.' }), h('p', { class: 'hint' }, 'Node harus mengirim ke topik ', h('span', { class: 'mono', text: `${prefix}/${id}/sensor` }), '.')));
    return;
  }

  const level = levelOf(cur.riskScore);
  const stale = now - cur.at > STALE_MS;
  section.classList.toggle('is-stale', stale);
  badge.classList.add(lvClass(level));
  fill(badge, mark(level), level ? LEVEL_INFO[level].label : 'Skor tidak tersedia');

  const comps = components(cur);
  const factors = h('ul', { class: 'factor-list' }, FACTORS.map((f) => {
    const value = comps[f.key];
    const na = value === null;
    return h('li', { class: `factor${na ? ' is-na' : ''}`, title: `${f.label}: ${f.rule}, maksimal ${f.max} poin` },
      h('span', { class: 'factor-name', text: f.short }),
      h('span', { class: 'factor-bar' }, h('span', { class: 'factor-fill', dataset: { w: na ? 0 : (value / f.max) * 100 } })),
      h('span', { class: 'factor-val' }, na ? 'n/a' : fmtNum(value, 1), h('small', { text: ` /${f.max}` })));
  }));

  const notes = [];
  if (comps.gas === null) notes.push(cur.source === 'db' ? 'Gas n/a: data tersimpan lama belum merekam selisih gas dari baseline.' : 'Gas n/a: node tidak mengirim gas_excess.');
  if (comps.total !== null && Number.isFinite(cur.riskScore) && Math.abs(comps.total - cur.riskScore) > 1) notes.push(`Jumlah komponen (${comps.total}) berbeda dari skor node (${cur.riskScore}); periksa versi rumus firmware.`);

  const trend = !stale ? trendText(cur) : null;
  let note;
  if (stale) note = h('p', { class: 'risk-note is-stale' }, h('strong', { text: `Data ${fmtAge(cur.at, now)}. ` }), 'Bukan kondisi sekarang: node tidak mengirim pembacaan baru. Periksa daya, WiFi, dan broker di lokasi.');
  else if (level) note = h('p', { class: `risk-note ${lvClass(level)}`, text: LEVEL_INFO[level].note });
  else note = h('p', { class: 'risk-note', text: 'Node mengirim data tanpa skor risiko. Perbarui firmware agar skor dihitung di perangkat.' });

  fill(body,
    h('div', { class: 'gauge-row' },
      gauge(cur.riskScore, level),
      h('div', { class: 'risk-when' },
        h('strong', { text: stale ? `Pembacaan ${fmtAge(cur.at, now)}` : `Diperbarui ${fmtAge(cur.at, now)}` }),
        `${fmtDateTime(cur.at, { seconds: !stale })} · ${cur.source === 'live' ? 'data live' : 'dari database'}`,
        trend && h('div', { class: 'risk-trend', text: trend }))),
    factors,
    notes.map((text) => h('p', { class: 'hint', text })),
    scale(cur.riskScore),
    note);

  // Lebar & posisi lewat CSSOM (diizinkan CSP), bukan atribut style.
  body.querySelectorAll('[data-w]').forEach((el) => {
    if (el.classList.contains('factor-fill')) el.style.width = `${Math.min(Number(el.dataset.w), 100)}%`;
    else el.style.width = `${el.dataset.w}%`;
  });
  body.querySelectorAll('[data-x]').forEach((el) => { el.style.left = `${el.dataset.x}%`; });
}
