const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateRows, bucketFor, MAX_BUCKETS, RANGES, resolveWindow, toColumns } = require('../lib/series');

const NOW = Date.parse('2026-10-28T15:37:00Z');

test('setiap rentang preset tetap di bawah batas bucket', () => {
  for (const [key, range] of Object.entries(RANGES)) {
    const w = resolveWindow({ range: key }, NOW);
    assert.ok((w.toMs - w.fromMs) / (w.bucket * 1000) <= MAX_BUCKETS + 1, key);
    assert.equal(w.bucket, range.bucket);
    assert.equal(w.live, true);
  }
});

test('rentang kustom memilih bucket terkecil yang muat', () => {
  assert.equal(bucketFor(3600e3), 15);
  assert.equal(bucketFor(7 * 24 * 3600e3), 900);
  const w = resolveWindow({ from: '2026-10-23T00:00:00Z', to: '2026-10-26T00:00:00Z' }, NOW);
  assert.equal(w.bucket, 600);
  assert.equal(w.live, false);
});

test('parameter rentang yang salah ditolak dengan 400', () => {
  assert.throws(() => resolveWindow({ range: 'semua' }, NOW), (e) => e.status === 400);
  assert.throws(() => resolveWindow({ from: '2026-10-25T00:00:00Z' }, NOW), (e) => e.status === 400);
  assert.throws(() => resolveWindow({ from: '2026-10-25T00:00:00Z', to: '2026-10-24T00:00:00Z' }, NOW), (e) => e.status === 400);
  assert.throws(() => resolveWindow({ from: '2026-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }, NOW), (e) => e.status === 400);
});

test('agregasi per bucket menghitung rata-rata, min, maks, dan n', () => {
  const rows = aggregateRows([
    { received_at: '2026-10-25T16:54:01Z', suhu: 30, kelembapan: 50, gas: 600, tekanan: null, kelembapan_tanah: 24, risk_score: 40 },
    { received_at: '2026-10-25T16:54:59Z', suhu: 32, kelembapan: 54, gas: 620, tekanan: null, kelembapan_tanah: 26, risk_score: 44 },
    { received_at: '2026-10-25T16:56:10Z', suhu: 29, kelembapan: 60, gas: 500, tekanan: null, kelembapan_tanah: null, risk_score: null },
  ], 60);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].t, '2026-10-25T16:54:00.000Z');
  assert.equal(rows[0].n, 2);
  assert.equal(rows[0].suhu_avg, 31);
  assert.equal(rows[0].suhu_min, 30);
  assert.equal(rows[0].risk_max, 44);
  assert.equal(rows[0].tekanan_avg, null);
  assert.equal(rows[1].tanah_avg, null);
  const cols = toColumns(rows);
  assert.deepEqual(cols.n, [2, 1]);
  assert.equal(cols.t[0], Date.parse('2026-10-25T16:54:00Z'));
});
