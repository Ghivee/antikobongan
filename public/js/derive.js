// Turunan dari state: pembacaan terkini dan rantai status.

import { state } from './store.js';
import { fmtAge, fmtDateTime } from './format.js';

// Stale data sensor: 15 detik = 5 x interval kirim 3 detik (mode uji realtime).
export const SENSOR_STALE_MS = 15e3;
const NODE_WARN_MS = 5 * 60e3;
const HEARTBEAT_OK_MS = 2 * 60e3;
const HEARTBEAT_WARN_MS = 10 * 60e3;
const DB_LAG_OK_MS = 2 * 60e3;
const DB_LAG_WARN_MS = 30 * 60e3;

const ms = (iso) => (iso ? Date.parse(iso) : NaN);

// Pembacaan paling baru dari MQTT live atau database, beserta sumbernya.
export function current(nodeId) {
  const live = state.live[nodeId];
  const db = state.latest[nodeId] && state.latest[nodeId].data && state.latest[nodeId].data.reading;
  const dbAt = db ? ms(db.received_at) : NaN;
  if (live && live.receivedAt && (!Number.isFinite(dbAt) || live.receivedAt >= dbAt)) {
    return { source: 'live', at: live.receivedAt, ...live.values, riskScore: live.riskScore, prev: live.prev };
  }
  if (db) {
    return {
      source: 'db',
      at: dbAt,
      suhu: db.suhu,
      kelembapan: db.kelembapan,
      gas: db.gas,
      gas_excess: db.gas_excess,
      tekanan: db.tekanan,
      kelembapan_tanah: db.kelembapan_tanah,
      riskScore: db.risk_score,
      prev: null,
    };
  }
  return null;
}

export function lastSeen(nodeId) {
  const live = state.live[nodeId];
  const latest = state.latest[nodeId] && state.latest[nodeId].data;
  const values = [live && live.receivedAt, latest && ms(latest.latest_at)].filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

// Status node dari broker (LWT/retained), TERPISAH dari status data sensor.
export function nodeStatusLink(nodeId, now = Date.now()) {
  const live = state.live[nodeId];
  const lwt = live && live.lwt;
  if (!lwt || !lwt.state) {
    return { st: 'idle', state: 'Belum diketahui', detail: 'Broker belum mengirim status online/offline untuk node ini.' };
  }
  const retained = lwt.retained
    ? ' Nilai retained dari broker: status terakhir diketahui, bukan bukti data baru.'
    : '';
  if (lwt.state === 'offline') {
    return { st: 'bad', state: 'Offline', detail: `Broker melaporkan node terputus ${fmtAge(lwt.at, now)}.${retained}` };
  }
  return { st: 'ok', state: 'Online', detail: `Broker melaporkan node online ${fmtAge(lwt.at, now)}.${retained}` };
}

// Status data sensor: apakah node masih mengirim pembacaan.
export function sensorLink(nodeId, now = Date.now()) {
  const seen = lastSeen(nodeId);
  if (!seen) {
    const loading = !state.latest[nodeId];
    return { st: loading ? 'idle' : 'bad', state: loading ? 'Memeriksa…' : 'Belum ada data', detail: 'Belum pernah ada pembacaan dari node ini.' };
  }
  const age = now - seen;
  const detail = `Pembacaan terakhir ${fmtDateTime(seen)} (${fmtAge(seen, now)}).`;
  if (age <= SENSOR_STALE_MS) return { st: 'ok', state: 'Mengirim', detail };
  if (age <= NODE_WARN_MS) return { st: 'warn', state: 'Tertunda', detail };
  return { st: 'bad', state: 'Tidak mengirim', detail };
}

// Ringkasan satu node untuk daftar/peta: offline broker menang, lalu data sensor.
export function nodeLink(nodeId, now = Date.now()) {
  const broker = nodeStatusLink(nodeId, now);
  if (broker.st === 'bad') return broker;
  return sensorLink(nodeId, now);
}

function brokerLink() {
  const { state: st, detail, config } = state.mqtt;
  const where = config ? new URL(config.url).host : 'broker';
  const map = {
    connected: { st: 'ok', state: 'Terhubung', detail: `${where}${config && config.public ? ' (broker publik)' : ''}` },
    connecting: { st: 'warn', state: 'Menyambung…', detail: where },
    reconnecting: { st: 'warn', state: 'Menyambung ulang…', detail: detail || where },
    offline: { st: 'bad', state: 'Terputus', detail: detail || 'Koneksi ke broker terputus.' },
    error: { st: 'bad', state: 'Galat', detail: detail || 'Broker menolak koneksi.' },
    unavailable: { st: 'bad', state: 'Tidak tersedia', detail: detail || 'Pustaka MQTT gagal dimuat.' },
    idle: { st: 'idle', state: 'Belum tersambung', detail: '' },
    off: { st: 'warn', state: 'Diputus', detail: 'Data live dihentikan dari tombol Aksi cepat. Riwayat tetap diperbarui.' },
  };
  return map[st] || map.idle;
}

function loggerLink(nodeId, now) {
  const latest = state.latest[nodeId];
  if (!latest) return { st: 'idle', state: 'Memeriksa…', detail: '' };
  if (latest.error && !latest.data) return { st: 'bad', state: 'Tidak diketahui', detail: 'Status pencatat tidak dapat dibaca.' };
  const hb = latest.data && latest.data.heartbeat;
  if (!hb || !hb.ts) return { st: 'bad', state: 'Tidak ada sinyal', detail: 'Tabel backend_heartbeat kosong. Jalankan backend/main.py.' };
  const at = ms(hb.ts);
  const age = now - at;
  const detail = `Sinyal terakhir ${fmtDateTime(at)} (${fmtAge(at, now)}).`;
  if (age <= HEARTBEAT_OK_MS) return { st: 'ok', state: 'Aktif', detail };
  if (age <= HEARTBEAT_WARN_MS) return { st: 'warn', state: 'Tertunda', detail };
  return { st: 'bad', state: 'Berhenti', detail };
}

function databaseLink(nodeId, now) {
  const latest = state.latest[nodeId];
  if (!latest) return { st: 'idle', state: 'Memeriksa…', detail: '' };
  if (latest.error) {
    return { st: 'bad', state: 'Tidak dapat dibaca', detail: latest.data ? `${latest.error} Menampilkan data ${fmtAge(latest.at, now)}.` : latest.error };
  }
  const latestAt = ms(latest.data.latest_at);
  if (!Number.isFinite(latestAt)) return { st: 'warn', state: 'Kosong', detail: 'Belum ada pembacaan tersimpan untuk node ini.' };
  const live = state.live[nodeId];
  const tersimpan = `Tersimpan terakhir ${fmtDateTime(latestAt)} (${fmtAge(latestAt, now)}).`;
  if (live && live.receivedAt > latestAt) {
    const lag = live.receivedAt - latestAt;
    if (lag > DB_LAG_WARN_MS) return { st: 'bad', state: 'Tertinggal', detail: `Data live masuk, tetapi tidak tersimpan. ${tersimpan}` };
    if (lag > DB_LAG_OK_MS) return { st: 'warn', state: 'Tertinggal', detail: tersimpan };
  }
  return { st: 'ok', state: 'Terbaca', detail: tersimpan };
}

export function chain(nodeId, now = Date.now()) {
  const links = [
    { key: 'node', title: 'Node (broker)', ...nodeStatusLink(nodeId, now) },
    { key: 'sensor', title: 'Sensor (data)', ...sensorLink(nodeId, now) },
    { key: 'broker', title: 'Broker (dasbor)', ...brokerLink() },
    { key: 'logger', title: 'Pencatat', ...loggerLink(nodeId, now) },
    { key: 'db', title: 'Database', ...databaseLink(nodeId, now) },
  ];
  const worst = links.find((l) => l.st === 'bad') || links.find((l) => l.st === 'warn');
  const idle = links.filter((l) => l.st === 'idle');
  let headline;
  if (!worst) {
    if (!idle.length) headline = 'Semua mata rantai normal';
    else if (idle.length === 1 && idle[0].key === 'node') headline = 'Data sensor aktif · status broker belum diketahui';
    else if (idle.length === 1 && idle[0].key === 'sensor') headline = 'Node online · menunggu data sensor';
    else headline = 'Memeriksa sistem…';
  } else if (worst.key === 'node') headline = `Node ${worst.state.toLowerCase()}`;
  else if (worst.key === 'sensor') {
    const seen = lastSeen(nodeId);
    headline = seen ? `Sensor ${worst.state.toLowerCase()} · data terakhir ${fmtAge(seen, now)}` : 'Sensor belum mengirim data';
  } else headline = `${worst.title}: ${worst.state.toLowerCase()}`;
  return { links, headline };
}
