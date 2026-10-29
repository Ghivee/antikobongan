// Tingkat & rumus risiko. Rumus HARUS sama dengan calcRiskScore di
// esp32_firmware.ino (formula_version 1).

export const LEVELS = ['NORMAL', 'SEDANG', 'TINGGI', 'KRITIS'];
export const THRESHOLDS = { SEDANG: 40, TINGGI: 60, KRITIS: 80 };

export const LEVEL_INFO = {
  NORMAL: { label: 'Normal', note: 'Semua parameter dalam batas aman. Tidak perlu tindakan.' },
  SEDANG: { label: 'Sedang', note: 'Beberapa parameter mendekati ambang. Tingkatkan frekuensi pemantauan.' },
  TINGGI: { label: 'Tinggi', note: 'Risiko tinggi. Siapkan tim tanggap dan pantau lokasi secara intensif.' },
  KRITIS: { label: 'Kritis', note: 'Kondisi kritis. Kirim tim tanggap ke lokasi dan siapkan protokol evakuasi.' },
};

export function levelOf(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) return null;
  if (score >= THRESHOLDS.KRITIS) return 'KRITIS';
  if (score >= THRESHOLDS.TINGGI) return 'TINGGI';
  if (score >= THRESHOLDS.SEDANG) return 'SEDANG';
  return 'NORMAL';
}

export const FACTORS = [
  { key: 'suhu', label: 'Suhu', short: 'Suhu', max: 35, rule: '(suhu − 25) × 2,5' },
  { key: 'rh', label: 'Kelembapan udara', short: 'Kelembapan', max: 25, rule: '(85 − RH) × 0,5' },
  { key: 'gas', label: 'Gas/asap', short: 'Gas/asap', max: 25, rule: 'selisih gas dari baseline × 25/400' },
  { key: 'tanah', label: 'Kelembapan tanah', short: 'Tanah', max: 15, rule: '(50 − tanah) × 0,3' },
];

const clamp = (value, max) => Math.min(Math.max(value, 0), max);
const isNum = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));

// Komponen per faktor; null bila data faktor itu tidak tersedia.
export function components({ suhu, kelembapan, gas_excess: gasExcess, kelembapan_tanah: tanah }) {
  const out = {
    suhu: isNum(suhu) ? clamp((suhu - 25) * 2.5, 35) : null,
    rh: isNum(kelembapan) ? clamp((85 - kelembapan) * 0.5, 25) : null,
    gas: isNum(gasExcess) ? clamp((gasExcess * 25) / 400, 25) : null,
    tanah: isNum(tanah) ? clamp((50 - tanah) * 0.3, 15) : null,
  };
  const complete = Object.values(out).every((value) => value !== null);
  out.total = complete ? Math.round(Math.min(out.suhu + out.rh + out.gas + out.tanah, 100)) : null;
  return out;
}
