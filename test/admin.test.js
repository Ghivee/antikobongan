const test = require('node:test');
const assert = require('node:assert/strict');
const { issueToken, verifyToken, TOKEN_TTL_MS } = require('../lib/admin-token');
const { validateNodes } = require('../lib/handlers/nodes');

const ENV = { ADMIN_PIN: '482913', ADMIN_TOKEN_SECRET: 'a'.repeat(64) };

test('token admin sah sampai kedaluwarsa', () => {
  const now = Date.now();
  const { token } = issueToken(ENV, now);
  assert.equal(verifyToken(token, ENV, now + 1000), true);
  assert.equal(verifyToken(token, ENV, now + TOKEN_TTL_MS + 1), false);
});

test('token yang diubah atau dari rahasia lain ditolak', () => {
  const { token } = issueToken(ENV);
  const [kind, exp, sig] = token.split('.');
  assert.equal(verifyToken(`${kind}.${Number(exp) + 999999}.${sig}`, ENV), false);
  assert.equal(verifyToken(token, { ...ENV, ADMIN_TOKEN_SECRET: 'b'.repeat(64) }), false);
  assert.equal(verifyToken('', ENV), false);
  assert.equal(issueToken({}), null);
});

test('validasi node menerima data lengkap dan menormalkan', () => {
  const [node] = validateNodes([{ node_id: 'esp32-01', nama: ' Node Utama ', lat: '-7.3305', lon: 110.1442, ketinggian: '1210' }]);
  assert.equal(node.nama, 'Node Utama');
  assert.equal(node.lat, -7.3305);
  assert.equal(node.ketinggian, 1210);
  assert.equal(node.aktif, true);
});

test('validasi node menolak input berbahaya atau tidak lengkap', () => {
  assert.throws(() => validateNodes([]), (e) => e.status === 400);
  assert.throws(() => validateNodes([{ node_id: '<script>' }]), /ID/);
  assert.throws(() => validateNodes([{ node_id: 'a' }, { node_id: 'a' }]), /dua kali/);
  assert.throws(() => validateNodes([{ node_id: 'a', lat: 95, lon: 0 }]), /lintang/);
  assert.throws(() => validateNodes([{ node_id: 'a', lat: -7 }]), /bersamaan/);
});
