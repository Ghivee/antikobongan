// Tab I/O: apa yang MASUK (sensor node, beserta pin & aturan validasi) dan apa
// yang KELUAR (LED, buzzer, MQTT, penyimpanan, Telegram, peringatan dasbor).
// Pemetaan pin & aturan mengikuti esp32_firmware.ino.

import { state } from '../store.js';
import { current, lastSeen } from '../derive.js';
import { fill, h } from '../dom.js';
import { fmtAge, fmtDateTime, fmtNum } from '../format.js';
import { THRESHOLDS } from '../risk.js';
import { mergedEvents } from './events.js';

const STALE_MS = 5 * 60e3;

const INPUTS = [
  { field: 'suhu', name: 'Suhu udara', hw: 'DHT11 · GPIO 4 · valid −20…80 °C', unit: '°C', dec: 1 },
  { field: 'kelembapan', name: 'Kelembapan udara', hw: 'DHT11 · GPIO 4 · valid 0…100 %', unit: '%', dec: 0 },
  { field: 'gas', name: 'Gas/asap', hw: 'MQ-2 · GPIO 34 · ADC mentah 0…4095, median 5 sampel', unit: 'ADC', dec: 0 },
  { field: 'gas_excess', name: 'Selisih gas dari baseline', hw: 'Dihitung firmware dari MQ-2 · dipakai rumus skor', unit: 'ADC', dec: 0 },
  { field: 'kelembapan_tanah', name: 'Kelembapan tanah', hw: 'Sensor tanah · GPIO 35 · kering 3200 / basah 1200', unit: '%', dec: 0 },
  { field: 'tekanan', name: 'Tekanan udara', hw: 'BMP180 · I2C 21/22 · opsional', unit: 'hPa', dec: 1, optional: true },
];

function item(name, hw, value, sub) {
  return h('div', { class: 'io-item' },
    h('div', {}, h('div', { class: 'io-name', text: name }), h('div', { class: 'io-hw', text: hw })),
    h('div', { class: 'io-val' }, value, sub && h('span', { text: sub })));
}

function state2(on, labelOn, labelOff) {
  return h('span', { class: 'io-state' }, h('span', { class: `dot st-${on === null ? 'idle' : on ? 'ok' : 'idle'}` }), on === null ? 'tidak diketahui' : on ? labelOn : labelOff);
}

export function renderIo(el, now = Date.now()) {
  const id = state.activeId;
  if (!id) { fill(el, h('p', { class: 'hint', text: 'Pilih node terlebih dahulu.' })); return; }
  const cur = current(id);
  const latest = state.latest[id] && state.latest[id].data;
  const live = state.live[id];
  const stale = !cur || now - cur.at > STALE_MS;
  const when = cur ? `${fmtDateTime(cur.at, { seconds: !stale })} · ${fmtAge(cur.at, now)}` : 'belum ada pembacaan';
  const score = cur && Number.isFinite(cur.riskScore) ? cur.riskScore : null;

  const inputs = INPUTS.filter((i) => !i.optional || (cur && cur[i.field] !== null && cur[i.field] !== undefined) || (latest && latest.has_tekanan)).map((i) => {
    const v = cur ? cur[i.field] : null;
    const has = v !== null && v !== undefined;
    return item(i.name, i.hw, has ? `${fmtNum(v, i.dec)} ${i.unit}` : '—', has ? (stale ? 'terakhir diketahui' : 'valid') : cur ? 'tidak dikirim' : '');
  });
  if (!(latest && latest.has_tekanan) && !(cur && cur.tekanan !== null && cur.tekanan !== undefined)) {
    inputs.push(item('Tekanan udara', 'BMP180 · I2C 21/22 · belum terpasang (ENABLE_BMP180 = 0)', '—', 'tidak dipasang'));
  }

  const ledRed = score === null ? null : score >= THRESHOLDS.TINGGI;
  const seenLive = live && live.receivedAt;
  const hb = latest && latest.heartbeat;
  const telegram = hb && typeof hb.telegram === 'boolean' ? hb.telegram : null;
  const lastNotify = mergedEvents(id).find((e) => !e.live);
  const outputs = [
    item('LED hijau', 'GPIO 27 · menyala bila skor < 60', state2(ledRed === null ? null : !ledRed, 'menyala', 'padam'), stale ? 'menurut skor terakhir' : 'menurut skor live'),
    item('LED merah', 'GPIO 26 · menyala bila skor ≥ 60', state2(ledRed, 'menyala', 'padam'), stale ? 'menurut skor terakhir' : 'menurut skor live'),
    item('Buzzer', 'GPIO 25 · bunyi singkat tiap data berhasil terkirim', seenLive ? fmtDateTime(live.receivedAt, { seconds: true }) : '—', seenLive ? `bunyi terakhir · ${fmtAge(live.receivedAt, now)}` : 'belum terlihat di sesi ini'),
    item('Kirim MQTT', 'Topik sensor tiap 15 detik · status online/offline (LWT)', lastSeen(id) ? fmtAge(lastSeen(id), now) : '—', live && live.lwt ? `status broker: ${live.lwt.state}` : 'pesan terakhir'),
    item('Simpan ke database', 'Pencatat Python → Supabase', latest && latest.latest_at ? fmtAge(Date.parse(latest.latest_at), now) : '—', latest && latest.latest_at ? fmtDateTime(Date.parse(latest.latest_at)) : 'belum ada'),
    item('Notifikasi Telegram', 'Dari pencatat: skor ≥ 60, ≥ 80, pulih, node offline/online', telegram === null ? 'tidak diketahui' : telegram ? 'aktif' : 'nonaktif', lastNotify ? `kejadian terakhir ${fmtAge(lastNotify.at, now)}` : 'belum ada kejadian'),
    item('Peringatan dasbor', 'Notifikasi di layar saat skor live melewati 60 / 80', state.mqtt.state === 'connected' ? 'aktif' : 'menunggu live', 'dihitung di browser'),
  ];

  fill(el,
    h('div', { class: 'io-section' }, h('h3', { text: 'Input · sensor node' }), h('p', { text: `Pembacaan ${when}` }), inputs),
    h('div', { class: 'io-section' }, h('h3', { text: 'Output · perangkat & sistem' }), h('p', { text: 'Status LED diturunkan dari skor sesuai aturan firmware, bukan dibaca langsung dari pin.' }), outputs),
    h('p', { class: 'io-flow', text: 'Alur: sensor → ESP32 (hitung skor, LED, buzzer) → MQTT → pencatat (Supabase, Telegram) → dasbor.' }));
}
