// Server lokal: dasbor statis + handler API yang sama persis dengan Vercel.

const express = require('express');
const path = require('path');
const fs = require('fs');

function loadLocalEnv() {
  const envPath = path.join(__dirname, 'backend', '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

loadLocalEnv();

// Header keamanan statis diambil dari vercel.json supaya lokal = produksi.
const STATIC_HEADERS = (() => {
  const routes = JSON.parse(fs.readFileSync(path.join(__dirname, 'vercel.json'), 'utf8')).routes;
  const route = routes.find((r) => r.src === '/(.*)');
  return route ? route.headers : {};
})();

const ENDPOINTS = ['health', 'latest', 'series', 'events', 'nodes', 'readings', 'admin', 'mqtt-config'];

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
for (const name of ENDPOINTS) {
  app.all(`/api/${name}`, require(`./lib/handlers/${name}`));
}
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ada.' }));
app.use((req, res, next) => {
  for (const [name, value] of Object.entries(STATIC_HEADERS)) res.setHeader(name, value);
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function listen(port) {
  const srv = app.listen(port, () => {
    console.log(`\n  AntiKobongan  http://localhost:${port}\n`);
  });
  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < 3010) {
      console.log(`  Port ${port} dipakai, mencoba ${port + 1}...`);
      listen(port + 1);
    } else {
      throw err;
    }
  });
}

listen(Number(process.env.PORT) || 3000);
