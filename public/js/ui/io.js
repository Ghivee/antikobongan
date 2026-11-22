// Tab I/O: kartu bertumpuk agar nama, nilai, dan detail hardware tidak
// bertabrakan di sidebar sempit. Isi mengikuti antikobongan-2.ino.

import { state } from '../store.js';
import { current, lastSeen, nodeStatusLink, SENSOR_STALE_MS } from '../derive.js';
import { fill, h, mark } from '../dom.js';
import { fmtAge, fmtDateTime, fmtNum } from '../format.js';
import { LEVEL_INFO, THRESHOLDS } from '../risk.js';
import { mergedEvents } from './events.js';

const STALE_MS = SENSOR_STALE_MS;

const INPUTS = [
  { field: 'suhu', name: 'Suhu udara', hw: 'BME280 · I2C SDA 21 / SCL 22 · valid −40 sampai 85 °C', unit: '°C', dec: 1 },
  { field: 'kelembapan', name: 'Kelembapan udara', hw: 'BME280 · I2C SDA 21 / SCL 22 · valid 0 sampai 100 %', unit: '%', dec: 1 },
  { field: 'gas', name: 'Gas dan asap', hw: 'MQ-2 · GPIO 34 · ADC mentah 0 sampai 4095, median 5 sampel', unit: 'ADC', dec: 0 },
  { field: 'gas_excess', name: 'Selisih gas dari baseline', hw: 'Dihitung firmware dari MQ-2 · dipakai rumus skor', unit: 'ADC', dec: 0 },
  { field: 'kelembapan_tanah', name: 'Kelembapan tanah', hw: 'Sensor tanah · GPIO 35 · kering 3200 / basah 1200 ADC', unit: '%', dec: 0 },
  { field: 'tekanan', name: 'Tekanan udara', hw: 'BME280 · I2C SDA 21 / SCL 22 · valid 300 sampai 1100 hPa', unit: 'hPa', dec: 2, optional: true },
];

const SENSOR_LIMITS = [
  { name: 'Suhu udara', range: '−40 sampai 85 °C', note: 'BME280, di luar rentang ini data ditolak firmware.' },
  { name: 'Kelembapan udara', range: '0 sampai 100 %', note: 'BME280, di luar rentang ini data ditolak firmware.' },
  { name: 'Tekanan udara', range: '300 sampai 1100 hPa', note: 'BME280, dikirim dengan 2 desimal.' },
  { name: 'Gas dan asap', range: '0 sampai 4095 ADC', note: 'MQ-2 mentah, belum dikalibrasi ppm. Selisih 400 ADC dari baseline = 25 poin.' },
  { name: 'Kelembapan tanah', range: '0 sampai 100 %', note: 'Kalibrasi kering 3200 ADC dan basah 1200 ADC.' },
  { name: 'Skor risiko', range: '0 sampai 100', note: 'Suhu di atas 25 °C, RH di bawah 85 %, dan tanah di bawah 50 % menambah skor.' },
];

const RISK_CLASSES = [
  { level: 'NORMAL', lo: 0, hi: THRESHOLDS.SEDANG - 1 },
  { level: 'SEDANG', lo: THRESHOLDS.SEDANG, hi: THRESHOLDS.TINGGI - 1 },
  { level: 'TINGGI', lo: THRESHOLDS.TINGGI, hi: THRESHOLDS.KRITIS - 1 },
  { level: 'KRITIS', lo: THRESHOLDS.KRITIS, hi: 100 },
];

function card(name, hw, value, note) {
  return h('div', { class: 'io-card' },
    h('div', { class: 'io-row' },
      h('span', { class: 'io-name', text: name }),
      h('span', { class: 'io-value' }, value)),
    hw && h('div', { class: 'io-hw', text: hw }),
    note && h('div', { class: 'io-note', text: note }));
}

function stateBadge(on, labelOn, labelOff, badWhenOff = false) {
  const st = on === null ? 'idle' : on ? 'ok' : badWhenOff ? 'bad' : 'idle';
  return h('span', { class: 'io-state' },
    h('span', { class: `dot st-${st}` }),
    on === null ? 'tidak diketahui' : on ? labelOn : labelOff);
}

function limitRow(name, range, note, level = null) {
  return h('div', { class: 'io-limit' },
    level ? mark(level) : h('span', { class: 'io-limit-dot' }),
    h('div', { class: 'io-limit-body' },
      h('div', { class: 'io-limit-top' },
        h('span', { class: 'io-limit-name', text: name }),
        h('span', { class: 'io-limit-range', text: range })),
      note && h('div', { class: 'io-limit-note', text: note })));
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

  const hasPressure = Boolean(
    (cur && cur.tekanan !== null && cur.tekanan !== undefined) ||
    (latest && latest.has_tekanan),
  );

  const inputs = INPUTS
    .filter((i) => !i.optional || hasPressure)
    .map((i) => {
      const v = cur ? cur[i.field] : null;
      const has = v !== null && v !== undefined;
      return card(
        i.name,
        i.hw,
        has ? `${fmtNum(v, i.dec)} ${i.unit}` : '—',
        has ? (stale ? 'terakhir diketahui' : 'valid') : cur ? 'tidak dikirim node' : 'belum ada data',
      );
    });
  if (!hasPressure) {
    inputs.push(card('Tekanan udara', 'BME280 · I2C SDA 21 / SCL 22 · pembacaan tidak valid', '—', 'tidak tersedia'));
  }

  const ledRed = score === null ? null : score >= THRESHOLDS.TINGGI;
  const seenLive = live && live.receivedAt;
  const hb = latest && latest.heartbeat;
  const telegram = hb && typeof hb.telegram === 'boolean' ? hb.telegram : null;
  const lastNotify = mergedEvents(id).find((e) => !e.live);
  const broker = nodeStatusLink(id, now);
  const brokerDetail = live && live.lwt
    ? `Status broker: ${live.lwt.state}${live.lwt.retained ? ' (retained, terakhir diketahui)' : ''}`
    : 'Broker belum melaporkan status.';

  const outputs = [
    card('LED hijau', 'GPIO 27 · menyala bila skor di bawah 60', stateBadge(ledRed === null ? null : !ledRed, 'menyala', 'padam'), stale ? 'Menurut skor terakhir.' : 'Menurut skor live.'),
    card('LED merah', 'GPIO 26 · menyala bila skor 60 atau lebih', stateBadge(ledRed, 'menyala', 'padam'), stale ? 'Menurut skor terakhir.' : 'Menurut skor live.'),
    card('Buzzer', 'GPIO 25 · bunyi pendek tiap publish berhasil, bukan alarm risiko',
      seenLive ? fmtDateTime(live.receivedAt, { seconds: true }) : '—',
      seenLive ? `Bunyi terakhir ${fmtAge(live.receivedAt, now)}.` : 'Belum terlihat di sesi ini.'),
    card('Kirim MQTT', 'Topik sensor tiap 45 detik · status online/offline (LWT)',
      lastSeen(id) ? fmtAge(lastSeen(id), now) : '—', brokerDetail),
    card('Status node di broker', 'Topik <prefix>/<node>/status · nilai sah hanya online/offline',
      stateBadge(broker.st === 'ok' ? true : broker.st === 'bad' ? false : null, 'online', 'offline', true), broker.detail),
    card('Simpan ke database', 'Pencatat Python ke Supabase',
      latest && latest.latest_at ? fmtAge(Date.parse(latest.latest_at), now) : '—',
      latest && latest.latest_at ? fmtDateTime(Date.parse(latest.latest_at)) : 'Belum ada.'),
    card('Notifikasi Telegram', 'Dikirim ke semua chat id · tanpa mention, semua anggota melihat',
      telegram === null ? 'tidak diketahui' : telegram ? 'aktif' : 'nonaktif',
      lastNotify ? `Kejadian terakhir ${fmtAge(lastNotify.at, now)}.` : 'Belum ada kejadian.'),
    card('Peringatan dasbor', 'Notifikasi layar saat skor live melewati 60 atau 80',
      state.mqtt.state === 'connected' ? 'aktif' : 'menunggu live', 'Dihitung di browser.'),
  ];

  const sensorLimits = SENSOR_LIMITS.map((s) => limitRow(s.name, s.range, s.note));
  const riskClasses = RISK_CLASSES.map((c) => limitRow(
    LEVEL_INFO[c.level].label,
    `skor ${c.lo} sampai ${c.hi}`,
    LEVEL_INFO[c.level].note,
    c.level,
  ));

  fill(el,
    h('div', { class: 'io-section' },
      h('h3', { text: 'Input sensor' }),
      h('p', { text: `Pembacaan ${when}.` }),
      h('div', { class: 'io-list' }, inputs)),
    h('div', { class: 'io-section' },
      h('h3', { text: 'Output perangkat dan sistem' }),
      h('p', { text: 'Status LED mengikuti skor firmware, bukan dibaca langsung dari pin.' }),
      h('div', { class: 'io-list' }, outputs)),
    h('div', { class: 'io-section' },
      h('h3', { text: 'Batas sensor' }),
      h('p', { text: 'Rentang valid dan titik kalibrasi yang dipakai firmware.' }),
      h('div', { class: 'io-list' }, sensorLimits)),
    h('div', { class: 'io-section' },
      h('h3', { text: 'Kelas peringatan' }),
      h('p', { text: 'Acuan proposal: Normal, Siaga Cuaca Kering, Waspada Bara dan Asap, Kebakaran Aktif.' }),
      h('div', { class: 'io-list' }, riskClasses)));
}
