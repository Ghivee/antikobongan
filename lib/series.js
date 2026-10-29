// Logika rentang & bucket riwayat. Murni (tanpa jaringan) agar mudah dites.

const { PublicError } = require('./http');

const MAX_SPAN_MS = 90 * 24 * 3600 * 1000;
const MAX_BUCKETS = 720; // di bawah batas max-rows PostgREST Supabase (1000)
const NICE_BUCKETS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

const RANGES = {
  '1h': { ms: 3600e3, bucket: 15 },
  '6h': { ms: 6 * 3600e3, bucket: 30 },
  '24h': { ms: 24 * 3600e3, bucket: 120 },
  '7d': { ms: 7 * 24 * 3600e3, bucket: 900 },
  '30d': { ms: 30 * 24 * 3600e3, bucket: 3600 },
};

// Kolom yang dikirim ke klien (format kolumnar, hemat ukuran).
const FIELDS = [
  'n',
  'suhu_avg', 'suhu_min', 'suhu_max',
  'rh_avg', 'rh_min', 'rh_max',
  'gas_avg', 'gas_min', 'gas_max',
  'tanah_avg', 'tanah_min', 'tanah_max',
  'tekanan_avg',
  'risk_avg', 'risk_min', 'risk_max',
];

function bucketFor(spanMs) {
  for (const seconds of NICE_BUCKETS) {
    if (spanMs / (seconds * 1000) <= MAX_BUCKETS) return seconds;
  }
  return NICE_BUCKETS[NICE_BUCKETS.length - 1];
}

function parseTime(value, name) {
  const ms = /^\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new PublicError(`Parameter ${name} bukan waktu yang valid.`, 400);
  return ms;
}

// Tentukan jendela waktu + ukuran bucket dari query (?range= atau ?from=&to=).
function resolveWindow(params, now = Date.now()) {
  let fromMs;
  let toMs;
  let bucket;
  if (params.from || params.to) {
    if (!params.from || !params.to) throw new PublicError('Parameter from dan to harus diisi bersama.', 400);
    fromMs = parseTime(params.from, 'from');
    toMs = parseTime(params.to, 'to');
    if (toMs <= fromMs) throw new PublicError('Parameter to harus setelah from.', 400);
    if (toMs - fromMs > MAX_SPAN_MS) throw new PublicError('Rentang maksimal 90 hari.', 400);
    bucket = bucketFor(toMs - fromMs);
  } else {
    const key = String(params.range || '24h');
    const range = RANGES[key];
    if (!range) throw new PublicError(`Rentang tidak dikenal. Pilih: ${Object.keys(RANGES).join(', ')}.`, 400);
    toMs = now;
    fromMs = now - range.ms;
    bucket = range.bucket;
  }
  // Selaraskan ke batas bucket supaya bucket pertama tidak terpotong dan cache stabil.
  const step = bucket * 1000;
  fromMs = Math.floor(fromMs / step) * step;
  toMs = Math.ceil(toMs / step) * step;
  return { fromMs, toMs, bucket, live: toMs >= now };
}

function round(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

const DIGITS = { gas_avg: 0, gas_min: 0, gas_max: 0, risk_avg: 1, n: 0 };

// Baris hasil RPC reading_series -> objek kolumnar { t: [...], n: [...], suhu_avg: [...] ... }.
function toColumns(rows) {
  const out = { t: [] };
  for (const field of FIELDS) out[field] = [];
  for (const row of rows) {
    out.t.push(new Date(row.t).getTime());
    for (const field of FIELDS) out[field].push(round(row[field], DIGITS[field] ?? 1));
  }
  return out;
}

// Agregasi di Node untuk database yang belum menjalankan sql/002_series.sql.
// Hasilnya sama bentuknya dengan RPC reading_series.
function aggregateRows(readings, bucketSeconds, originMs = Date.UTC(2000, 0, 1)) {
  const step = bucketSeconds * 1000;
  const buckets = new Map();
  const pairs = [
    ['suhu', 'suhu'], ['rh', 'kelembapan'], ['gas', 'gas'],
    ['tanah', 'kelembapan_tanah'], ['tekanan', 'tekanan'], ['risk', 'risk_score'],
  ];
  for (const reading of readings) {
    const ms = Date.parse(reading.received_at);
    if (!Number.isFinite(ms)) continue;
    const start = originMs + Math.floor((ms - originMs) / step) * step;
    let bucket = buckets.get(start);
    if (!bucket) {
      bucket = { t: start, n: 0, acc: {} };
      for (const [short] of pairs) bucket.acc[short] = { sum: 0, count: 0, min: null, max: null };
      buckets.set(start, bucket);
    }
    bucket.n += 1;
    for (const [short, column] of pairs) {
      const value = reading[column];
      if (value === null || value === undefined) continue;
      const acc = bucket.acc[short];
      acc.sum += Number(value);
      acc.count += 1;
      acc.min = acc.min === null ? Number(value) : Math.min(acc.min, Number(value));
      acc.max = acc.max === null ? Number(value) : Math.max(acc.max, Number(value));
    }
  }
  return [...buckets.values()]
    .sort((a, b) => a.t - b.t)
    .map(({ t, n, acc }) => {
      const row = { t: new Date(t).toISOString(), n };
      for (const [short] of pairs) {
        const { sum, count, min, max } = acc[short];
        row[`${short}_avg`] = count ? sum / count : null;
        if (short !== 'tekanan') {
          row[`${short}_min`] = min;
          row[`${short}_max`] = max;
        }
      }
      return row;
    });
}

module.exports = { RANGES, FIELDS, MAX_BUCKETS, bucketFor, resolveWindow, toColumns, aggregateRows };
