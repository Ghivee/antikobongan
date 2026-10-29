// Salin pustaka frontend (versi terkunci di package.json) ke public/vendor.
// Jalankan ulang setelah mengubah versi: npm run vendor

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'vendor');
const files = {
  'mqtt.min.js': 'node_modules/mqtt/dist/mqtt.min.js',
  'chart.umd.min.js': 'node_modules/chart.js/dist/chart.umd.min.js',
  'chartjs-adapter-date-fns.bundle.min.js': 'node_modules/chartjs-adapter-date-fns/dist/chartjs-adapter-date-fns.bundle.min.js',
  'leaflet/leaflet.js': 'node_modules/leaflet/dist/leaflet.js',
  'leaflet/leaflet.css': 'node_modules/leaflet/dist/leaflet.css',
  'fonts/public-sans-400.woff2': 'node_modules/@fontsource/public-sans/files/public-sans-latin-400-normal.woff2',
  'fonts/public-sans-500.woff2': 'node_modules/@fontsource/public-sans/files/public-sans-latin-500-normal.woff2',
  'fonts/public-sans-600.woff2': 'node_modules/@fontsource/public-sans/files/public-sans-latin-600-normal.woff2',
};

fs.rmSync(out, { recursive: true, force: true });
for (const [target, source] of Object.entries(files)) {
  const dest = path.join(out, target);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, source), dest);
}
const versions = ['mqtt', 'chart.js', 'chartjs-adapter-date-fns', 'leaflet', '@fontsource/public-sans']
  .map((name) => `${name}@${require(path.join(root, 'node_modules', name, 'package.json')).version}`);
fs.writeFileSync(path.join(out, 'VERSIONS.txt'), `${versions.join('\n')}\n`);
console.log(`public/vendor diperbarui:\n  ${versions.join('\n  ')}`);
