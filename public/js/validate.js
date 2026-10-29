// Validasi topik & payload MQTT di browser. Aturannya sama dengan
// backend/validator.py; semua yang tidak lolos dibuang, tidak pernah dirender.

const NODE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const REQUIRED = { suhu: [-20, 80], kelembapan: [0, 100], gas: [0, 4095] };
const OPTIONAL = { tekanan: [300, 1100], kelembapan_tanah: [0, 100], gas_excess: [0, 4095] };
const VALID_STATUS = ['NORMAL', 'SEDANG', 'TINGGI', 'KRITIS'];

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

export function parseTopic(topic, prefix) {
  const head = `${prefix}/`;
  if (typeof topic !== 'string' || !topic.startsWith(head)) return { error: 'prefix topik berbeda' };
  const rest = topic.slice(head.length).split('/');
  if (rest.length !== 2) return { error: 'struktur topik tidak dikenal' };
  const [nodeId, type] = rest;
  if (!NODE_ID_RE.test(nodeId)) return { error: 'ID node tidak valid' };
  if (type !== 'sensor' && type !== 'status') return { error: `jenis pesan "${type.slice(0, 20)}" tidak dipakai` };
  return { nodeId, type };
}

export function parseStatus(text) {
  const value = String(text || '').trim().toLowerCase();
  return value === 'online' || value === 'offline' ? value : null;
}

export function validateSensor(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return { ok: false, reason: 'payload bukan JSON valid' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'payload harus objek JSON' };

  const values = {};
  for (const [key, [min, max]] of Object.entries(REQUIRED)) {
    const value = data[key];
    if (!isNum(value)) return { ok: false, reason: `field wajib "${key}" tidak ada atau bukan angka` };
    if (value < min || value > max) return { ok: false, reason: `field "${key}" di luar rentang ${min}..${max}` };
    values[key] = key === 'gas' ? Math.round(value) : value;
  }

  const warnings = [];
  for (const [key, [min, max]] of Object.entries(OPTIONAL)) {
    let value = data[key];
    if (value === undefined && key === 'kelembapan_tanah') value = data.tanah;
    if (value === undefined || value === null) { values[key] = null; continue; }
    if (!isNum(value) || value < min || value > max) {
      warnings.push(`field "${key}" diabaikan (bukan angka ${min}..${max})`);
      values[key] = null;
      continue;
    }
    values[key] = key === 'gas_excess' ? Math.round(value) : value;
  }

  let riskScore = null;
  if (data.riskScore !== undefined && data.riskScore !== null) {
    const value = data.riskScore;
    if (isNum(value) && Number.isInteger(value) && value >= 0 && value <= 100) riskScore = value;
    else warnings.push('field "riskScore" diabaikan (harus bilangan bulat 0..100)');
  }

  let status = null;
  if (data.status !== undefined && data.status !== null) {
    if (VALID_STATUS.includes(data.status)) status = data.status;
    else warnings.push('field "status" diabaikan');
  }

  let sensorTime = null;
  if (typeof data.timestamp === 'string' && data.timestamp.trim()) {
    const text2 = data.timestamp.trim();
    const ms = Date.parse(text2);
    if (Number.isFinite(ms) && /(Z|[+-]\d{2}:?\d{2})$/.test(text2)) sensorTime = ms;
    else warnings.push('field "timestamp" diabaikan (harus ISO dengan zona waktu)');
  }

  return { ok: true, values, riskScore, status, sensorTime, warnings };
}
