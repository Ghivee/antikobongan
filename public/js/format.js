// Format waktu & angka seragam: "25 Okt 23:54 WIB", koma desimal.

const TZ = 'Asia/Jakarta';
const dateParts = new Intl.DateTimeFormat('id-ID', {
  timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const numberFormats = new Map();

function parts(ms) {
  const out = {};
  for (const { type, value } of dateParts.formatToParts(new Date(ms))) out[type] = value;
  out.month = out.month.replace('.', '');
  return out;
}

export function fmtDateTime(ms, { seconds = false, year = false } = {}) {
  if (!Number.isFinite(ms)) return '—';
  const p = parts(ms);
  const time = seconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
  return `${p.day} ${p.month}${year ? ` ${p.year}` : ''} ${time} WIB`;
}

export function fmtClock(ms) {
  const p = parts(ms);
  return `${p.hour}:${p.minute}:${p.second} WIB`;
}

export function fmtTick(ms, spanMs) {
  const p = parts(ms);
  if (spanMs <= 36 * 3600e3) return `${p.hour}:${p.minute}`;
  return `${p.day} ${p.month}`;
}

export function fmtAge(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return 'belum ada';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'baru saja';
  if (s < 60) return `${s} dtk lalu`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} jam lalu`;
  return `${Math.round(h / 24)} hari lalu`;
}

export function fmtDuration(ms) {
  const h = ms / 3600e3;
  if (h >= 48) return `${fmtNum(h / 24, 1)} hari`;
  if (h >= 1) return `${fmtNum(h, 1)} jam`;
  return `${Math.round(ms / 60e3)} mnt`;
}

export function fmtNum(value, decimals = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  let format = numberFormats.get(decimals);
  if (!format) {
    format = new Intl.NumberFormat('id-ID', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    numberFormats.set(decimals, format);
  }
  return format.format(Number(value));
}

// "2026-10-25T23:54" (input datetime-local, dianggap WIB) <-> epoch ms
export function toLocalInput(ms) {
  // WIB tidak punya DST: cukup geser +7 jam lalu ambil komponen UTC.
  return new Date(ms + 7 * 3600e3).toISOString().slice(0, 16);
}

export function fromLocalInput(value) {
  const ms = Date.parse(`${value}:00+07:00`);
  return Number.isFinite(ms) ? ms : null;
}
