// Peta node (Leaflet). Selalu tampil; bila belum ada koordinat, peta menampilkan
// Pulau Jawa dengan keterangan cara menambahkan lokasi node.

import { h } from './dom.js';

const DEFAULT_VIEW = { center: [-7.4, 110.2], zoom: 7 };
const COLORS = { ok: '#4FB37E', warn: '#E3BC3F', bad: '#F0565B', idle: '#6B7069' };

let map = null;
let layer = null;
let lastBoundsSig = '';

export function initMap(el) {
  if (!window.L) return false;
  map = window.L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© kontributor OpenStreetMap' }).addTo(map);
  layer = window.L.layerGroup().addTo(map);
  // Kotak peta ikut berubah saat jendela di-zoom/diubah ukurannya atau panel diperluas.
  if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize()).observe(el);
  return true;
}

function popup(m) {
  return h('div', {},
    h('strong', { text: m.title }),
    h('dl', {}, m.rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])));
}

// markers: [{ id, lat, lon, conn, active, title, rows: [[label, value]] }]
export function renderMarkers(markers, { onSelect }) {
  if (!map) return;
  layer.clearLayers();
  for (const m of markers) {
    window.L.circleMarker([m.lat, m.lon], {
      radius: m.active ? 10 : 7,
      color: m.active ? '#E8E4D8' : '#0E100F',
      weight: 2,
      fillColor: COLORS[m.conn] || COLORS.idle,
      fillOpacity: 0.95,
    })
      .bindPopup(popup(m))
      .bindTooltip(m.title, { direction: 'top', offset: [0, -8] })
      .on('click', () => onSelect(m.id))
      .addTo(layer);
  }
  const sig = markers.map((m) => `${m.lat},${m.lon}`).join('|');
  if (sig !== lastBoundsSig) {
    lastBoundsSig = sig;
    if (markers.length === 1) map.setView([markers[0].lat, markers[0].lon], 13);
    else if (markers.length) map.fitBounds(markers.map((m) => [m.lat, m.lon]), { padding: [32, 32], maxZoom: 14 });
    else map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
  }
}

export function resizeMap() {
  if (map) setTimeout(() => map.invalidateSize(), 0);
}
