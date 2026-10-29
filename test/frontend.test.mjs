import test from 'node:test';
import assert from 'node:assert/strict';
import { components, levelOf } from '../public/js/risk.js';
import { parseTopic, validateSensor } from '../public/js/validate.js';
import { fmtAge, fmtDateTime, fmtNum, fromLocalInput, toLocalInput } from '../public/js/format.js';
import { buildModel } from '../public/js/charts.js';

const PREFIX = 'antikobongan/prototipe-gx7q4m';

test('ambang level risiko 40/60/80', () => {
  assert.equal(levelOf(39), 'NORMAL');
  assert.equal(levelOf(40), 'SEDANG');
  assert.equal(levelOf(60), 'TINGGI');
  assert.equal(levelOf(80), 'KRITIS');
  assert.equal(levelOf(null), null);
});

test('komponen risiko sama dengan rumus firmware', () => {
  // suhu 31 -> 15, RH 51 -> 17, gas_excess 400 -> 25, tanah 32 -> 5.4 => 62
  const c = components({ suhu: 31, kelembapan: 51, gas_excess: 400, kelembapan_tanah: 32 });
  assert.equal(c.suhu, 15);
  assert.equal(c.rh, 17);
  assert.equal(c.gas, 25);
  assert.ok(Math.abs(c.tanah - 5.4) < 1e-9);
  assert.equal(c.total, 62);
  assert.equal(components({ suhu: 31, kelembapan: 51, gas_excess: null, kelembapan_tanah: 32 }).total, null);
});

test('topik: hanya sensor & status dari prefix yang benar', () => {
  assert.deepEqual(parseTopic(`${PREFIX}/esp32-01/sensor`, PREFIX), { nodeId: 'esp32-01', type: 'sensor' });
  assert.ok(parseTopic(`${PREFIX}/esp32-01/alert`, PREFIX).error);
  assert.ok(parseTopic(`${PREFIX}/<img src=x>/sensor`, PREFIX).error);
  assert.ok(parseTopic(`lain/esp32-01/sensor`, PREFIX).error);
});

test('payload sensor divalidasi; isi berbahaya tidak lolos', () => {
  const ok = validateSensor(JSON.stringify({ suhu: 29.8, kelembapan: 51, gas: 1292, gas_excess: 212, kelembapan_tanah: 32, riskScore: 47, status: 'SEDANG', timestamp: '2026-10-28T22:41:05+07:00' }));
  assert.equal(ok.ok, true);
  assert.equal(ok.values.gas_excess, 212);
  assert.equal(ok.riskScore, 47);
  const evil = validateSensor(JSON.stringify({ suhu: 30, kelembapan: 50, gas: 100, status: '<img src=x onerror=alert(1)>', riskScore: '<b>' }));
  assert.equal(evil.ok, true);
  assert.equal(evil.status, null);
  assert.equal(evil.riskScore, null);
  assert.equal(validateSensor('{"level":"<img src=x onerror=alert(1)>"}').ok, false);
  assert.equal(validateSensor('not json').ok, false);
  assert.equal(validateSensor(JSON.stringify({ suhu: 300, kelembapan: 50, gas: 1 })).ok, false);
});

test('format waktu WIB dan angka Indonesia', () => {
  assert.equal(fmtDateTime(Date.parse('2026-10-25T16:54:00Z')), '25 Okt 23:54 WIB');
  assert.equal(fmtNum(29.85, 1), '29,9');
  assert.equal(fmtAge(Date.now() - 3 * 86400e3), '3 hari lalu');
  const ms = Date.parse('2026-10-25T16:54:00Z');
  assert.equal(toLocalInput(ms), '2026-10-25T23:54');
  assert.equal(fromLocalInput('2026-10-25T23:54'), ms);
});

test('model grafik menandai jeda dan tidak menjembatani garis', () => {
  const t0 = Date.parse('2026-10-23T16:00:00Z');
  const series = { t: [t0, t0 + 60e3, t0 + 42.5 * 3600e3], n: [30, 30, 30], risk_avg: [40, 42, 39], risk_min: [38, 40, 37], risk_max: [44, 45, 41] };
  const model = buildModel({ series, from: t0, to: t0 + 43 * 3600e3, bucketSeconds: 60, now: t0 + 43 * 3600e3 });
  const inner = model.gaps.filter((g) => g.index);
  assert.equal(inner.length, 1);
  assert.ok(inner[0].to - inner[0].from > 42 * 3600e3);
  const ys = model.points.risk.avg.map((p) => p.y);
  assert.deepEqual(ys, [40, 42, null, 39]);
});

test('titik live hanya ditempel bila lebih baru dari bucket terakhir', () => {
  const t0 = Date.parse('2026-10-28T15:00:00Z');
  const series = { t: [t0], n: [4], risk_avg: [40], risk_min: [40], risk_max: [40] };
  const tail = [{ at: t0 + 10e3, riskScore: 99 }, { at: t0 + 75e3, riskScore: 41 }];
  const model = buildModel({ series, from: t0, to: t0 + 120e3, bucketSeconds: 60, tail, now: t0 + 80e3 });
  assert.deepEqual(model.rows.map((r) => r.risk.avg), [40, 41]);
});
