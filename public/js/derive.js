// Turunan dari state: pembacaan terkini dan rantai status.

import { state } from './store.js';
import { fmtAge, fmtDateTime } from './format.js';

const LIVE_OK_MS = 30e3;
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

export function nodeLink(nodeId, now = Date.now()) {
  const live = state.live[nodeId];
  const seen = lastSeen(nodeId);
  if (live && live.lwt && live.lwt.state === 'offline' && (!seen || live.lwt.at >= seen)) {
    return { st: 'bad', state: 'Offline', detail: `Broker melaporkan node terputus ${fmtAge(live.lwt.at, now)}.` };
  }
  if (!seen) {
    const loading = !state.latest[nodeId];
    return { st: loading ? 'idle' : 'bad', state: loading ? 'Memeriksa…' : 'Belum ada data', detail: 'Belum pernah ada pembacaan dari node ini.' };
  }
  const age = now - seen;
  const detail = `Pembacaan terakhir ${fmtDateTime(seen)} (${fmtAge(seen, now)}).`;
  if (age <= LIVE_OK_MS) return { st: 'ok', state: 'Mengirim', detail };
  if (age <= NODE_WARN_MS) return { st: 'warn', state: 'Tertunda', detail };
  return { st: 'bad', state: 'Tidak mengirim', detail };
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
    { key: 'node', title: 'Node', ...nodeLink(nodeId, now) },
    { key: 'broker', title: 'Broker', ...brokerLink() },
    { key: 'logger', title: 'Pencatat', ...loggerLink(nodeId, now) },
    { key: 'db', title: 'Database', ...databaseLink(nodeId, now) },
  ];
  const worst = links.find((l) => l.st === 'bad') || links.find((l) => l.st === 'warn');
  let headline;
  if (!worst) headline = links.some((l) => l.st === 'idle') ? 'Memeriksa sistem…' : 'Semua mata rantai normal';
  else if (worst.key === 'node') {
    const seen = lastSeen(nodeId);
    headline = seen ? `Node ${worst.state.toLowerCase()} · data terakhir ${fmtAge(seen, now)}` : 'Node belum mengirim data';
  } else headline = `${worst.title}: ${worst.state.toLowerCase()}`;
  return { links, headline };
}
