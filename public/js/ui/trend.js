// Panel tren: tab besaran, rentang waktu, readout di bawah kursor, keterangan.

import { state } from '../store.js';
import { fill, h } from '../dom.js';
import { fmtDateTime, fmtDuration, fmtNum, fromLocalInput, toLocalInput } from '../format.js';
import { METRICS, metricDef } from '../charts.js';

// Tab "Semua sensor": satu grafik per besaran dalam satu panel.
export const OVERVIEW = { key: 'all', label: 'Semua sensor', hint: 'Semua besaran sekaligus, kursor sinkron di semua grafik.' };

export const RANGES = [
  { key: '1h', label: '1 jam', ms: 3600e3 },
  { key: '6h', label: '6 jam', ms: 6 * 3600e3 },
  { key: '24h', label: '24 jam', ms: 24 * 3600e3 },
  { key: '7d', label: '7 hari', ms: 7 * 24 * 3600e3 },
  { key: '30d', label: '30 hari', ms: 30 * 24 * 3600e3 },
];

export function bindTrend({ select, form, tabs, onRange, onCustom, onMetric }) {
  select.addEventListener('change', () => {
    if (select.value === 'custom') {
      form.hidden = false;
      const to = state.custom ? state.custom.to : Date.now();
      const from = state.custom ? state.custom.from : to - 24 * 3600e3;
      form.elements.from.value = toLocalInput(from);
      form.elements.to.value = toLocalInput(to);
      form.elements.from.focus();
      return;
    }
    form.hidden = true;
    onRange(select.value);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const from = fromLocalInput(form.elements.from.value);
    const to = fromLocalInput(form.elements.to.value);
    let message = '';
    if (!from || !to || to <= from) message = 'Waktu akhir harus setelah waktu awal.';
    else if (to - from > 90 * 24 * 3600e3) message = 'Rentang maksimal 90 hari.';
    form.elements.to.setCustomValidity(message);
    if (message) { form.reportValidity(); return; }
    form.hidden = true;
    onCustom({ from, to });
  });
  form.elements.to.addEventListener('input', () => form.elements.to.setCustomValidity(''));
  tabs.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-metric]');
    if (button) onMetric(button.dataset.metric);
  });
  tabs.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const buttons = [...tabs.querySelectorAll('button')];
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const next = buttons[(i + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
    next.focus();
    onMetric(next.dataset.metric);
  });
}

export function renderTabs(tabs, select, hasTekanan) {
  const defs = [OVERVIEW, ...METRICS.filter((d) => !d.optional || hasTekanan)];
  if (tabs.childElementCount !== defs.length) {
    fill(tabs, defs.map((d) => h('button', { type: 'button', role: 'tab', dataset: { metric: d.key }, text: d.unit ? `${d.label} (${d.unit})` : d.label, title: d.hint || null })));
  }
  tabs.querySelectorAll('button').forEach((b) => {
    const on = b.dataset.metric === state.metric;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  if (select.value !== state.range && document.activeElement !== select) select.value = state.range;
}

export function renderSub(el, model) {
  const label = state.metric === OVERVIEW.key ? OVERVIEW.label : metricDef(state.metric).label;
  if (!model) { el.textContent = 'Memuat riwayat…'; return; }
  el.textContent = `${label} · ${fmtDateTime(model.from)} – ${fmtDateTime(model.to)}`;
}

export function renderFoot(el, { entry, model, latestAt, onJump, onRetry, onNow }) {
  if (!entry || (entry.loading && !entry.data)) { fill(el, h('span', { text: 'Memuat riwayat…' })); return; }
  if (entry.error && !entry.data) {
    fill(el, h('span', { class: 'notice', text: `Riwayat tidak dapat dimuat: ${entry.error}` }), h('button', { type: 'button', class: 'link-btn', text: 'Coba lagi', onclick: onRetry }));
    return;
  }
  const data = entry.data;
  const total = (data.series.n || []).reduce((sum, n) => sum + (n || 0), 0);
  const b = data.bucket_seconds;
  const bucket = b >= 3600 ? `${b / 3600} jam` : b >= 60 ? `${b / 60} menit` : `${b} detik`;
  const parts = [h('span', { text: `Garis = rata-rata per ${bucket}, pita = rentang min–maks` }), h('span', { text: `${fmtNum(total, 0)} pembacaan tersimpan` })];
  const liveCount = model.rows.filter((row) => row.live).length;
  if (liveCount) parts.push(h('span', { text: `+ ${fmtNum(liveCount, 0)} pembacaan live` }));
  const inner = model.gaps.filter((g) => g.index);
  if (inner.length) parts.push(h('span', { text: `${inner.length} jeda data (terpanjang ${fmtDuration(Math.max(...inner.map((g) => g.to - g.from)))})` }));
  if (data.truncated) parts.push(h('span', { class: 'notice', text: 'Data dipotong; jalankan sql/002_series.sql.' }));
  if (entry.error) parts.push(h('span', { class: 'notice', text: `Pembaruan gagal: ${entry.error}` }));
  if (state.range === 'custom') parts.push(h('button', { type: 'button', class: 'link-btn', text: 'Kembali ke 24 jam terakhir', onclick: onNow }));

  if (!model.rows.length) {
    const latest = latestAt ? Date.parse(latestAt) : NaN;
    const notice = [h('span', { class: 'notice', text: 'Tidak ada data di rentang ini.' })];
    if (Number.isFinite(latest) && latest < model.from) {
      notice.push(h('span', { text: `Pembacaan terakhir ${fmtDateTime(latest)}.` }));
      notice.push(h('button', { type: 'button', class: 'link-btn', text: 'Lompat ke data terakhir', onclick: () => onJump(latest) }));
    }
    fill(el, notice, state.range === 'custom' ? parts.slice(-1) : null);
    return;
  }
  fill(el, parts);
}

// timeOnly: mode Semua sensor — nilai tiap besaran sudah tampil di kepala grafiknya.
export function renderReadout(el, row, hovering, { timeOnly = false } = {}) {
  if (!row) {
    fill(el, h('span', { text: 'Arahkan kursor atau sentuh grafik untuk melihat nilai di waktu tertentu.' }));
    return;
  }
  if (timeOnly) {
    fill(el,
      h('span', { class: 'rd-time', text: `${hovering ? '' : 'Terakhir · '}${fmtDateTime(row.x, { seconds: Boolean(row.live) })}${row.live ? ' · live' : ''}` }),
      row.n > 1 && h('span', { text: `${row.n} sampel` }),
      h('span', { text: 'Nilai di kepala tiap grafik · klik judul untuk memperbesar' }));
    return;
  }
  const items = METRICS.filter((d) => !d.optional || row[d.key].avg !== null).map((def) => {
    const cell = row[def.key];
    if (cell.avg === null || cell.avg === undefined) return h('span', {}, `${def.short} `, h('b', { text: '—' }));
    const range = !row.live && cell.min !== null && cell.max !== null && cell.min !== cell.max ? ` (${fmtNum(cell.min, def.dec)}–${fmtNum(cell.max, def.dec)})` : '';
    return h('span', {}, `${def.short} `, h('b', { text: `${fmtNum(cell.avg, def.dec)}${def.unit ? ` ${def.unit}` : ''}` }), range);
  });
  fill(el,
    h('span', { class: 'rd-time', text: `${hovering ? '' : 'Terakhir · '}${fmtDateTime(row.x, { seconds: Boolean(row.live) })}${row.live ? ' · live' : ''}` }),
    items,
    row.n > 1 && h('span', { text: `${row.n} sampel` }));
}
