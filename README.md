# AntiKobongan — Pemantauan Risiko Kebakaran Hutan

Dasbor IoT untuk memantau suhu, kelembapan udara, gas/asap, dan kelembapan
tanah dari node ESP32. Data live dikirim lewat MQTT, pencatat Python menyimpan
riwayat ke Supabase dan mengirim notifikasi Telegram, dan dasbor menampilkan
keduanya. Semua yang tampil di dasbor adalah data sensor asli; tidak ada mode
simulasi.

## Arsitektur

```
ESP32 ──MQTT──► broker (publik / privat + TLS) ◄──WSS── dasbor (Vercel)
                         │                                  ▲
                         ▼                                  │ /api/*
              pencatat Python (laptop/PC)                   │
               ├─► Supabase ─────────────────────────────────┘
               └─► Telegram (opsional)
```

| Bagian | Lokasi |
|---|---|
| Dasbor (HTML/CSS/JS modul ES, tanpa build) | `public/` |
| API serverless (dipakai Vercel **dan** `server.js`) | `api/*.js` → `lib/handlers/*.js` |
| Pencatat (MQTT → validasi → Supabase/Telegram) | `backend/` |
| Firmware ESP32 | `esp32_firmware.ino` + `secrets.h` |
| Skema database | `sql/001_schema.sql`, `sql/002_series.sql` |
| Panduan deploy | `docs/DEPLOY.md` |

Prefix: `antikobongan/prototipe-gx7q4m`, node `esp32-01`, interval kirim 15 detik.
Topik yang dipakai: `<prefix>/<node>/sensor` (JSON) dan `<prefix>/<node>/status`
(`online`/`offline`, LWT).

## Dasbor

- **Risiko sekarang** — satu angka utama, level (Normal/Sedang/Tinggi/Kritis
  dengan warna + bentuk), tren 1 jam, umur data, dan saran. Bila data lebih
  tua dari 5 menit, dasbor menyatakan dengan jelas bahwa itu bukan kondisi
  sekarang.
- **Rantai status** Node → Broker → Pencatat → Database, menunjukkan di mana
  aliran data putus (misalnya "node mengirim, tetapi pencatat berhenti").
- **Pembacaan & kontribusi skor** — empat komponen rumus firmware (`x/35`,
  `x/25`, …). Data lama tanpa `gas_excess` ditandai "n/a", tidak ditebak.
- **Tren** — grafik skor dengan pita ambang 40/60/80 dan grafik kecil per
  besaran. Sumbu waktunya nyata, pita min–maks per bucket ditampilkan, jeda
  data diarsir sebagai "tidak ada data", dan crosshair serta readout
  tersinkron. Rentang yang tersedia: 1 jam, 6 jam, 24 jam, 7 hari, 30 hari,
  dan Kustom, plus "Lompat ke data terakhir".
- **Peringatan & kejadian** — event dari database ditambah peringatan yang
  dihitung dasbor dari skor live. Topik MQTT `alert` sengaja tidak dipakai.
- **Node** — daftar node dan peta Leaflet. Peta hanya muncul bila ada node
  berkoordinat.
- **Kelola node** (menu ⋯) — PIN diperiksa server, lalu daftar node disimpan
  ke tabel `nodes` dan berlaku untuk semua pengguna.
- **Diagnostik** (menu ⋯) — konfigurasi broker, ringkasan data, dan log teknis.

## Menjalankan lokal

```sh
npm install
cp backend/.env.example backend/.env   # lalu isi nilainya
npm start                               # http://localhost:3000
```

`server.js` membaca `backend/.env`, memakai handler API yang sama dengan Vercel,
dan mengirim header keamanan yang sama (diambil dari `vercel.json`).

## Menjalankan pencatat (backend)

macOS/Linux:

```sh
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
caffeinate -i ./backend/jalankan.sh
```

Windows: `run_backend.bat`. Pencatat harus terus berjalan agar riwayat dan
notifikasi tercatat. Bila pencatat berhenti, rantai status di dasbor menyala
merah di mata rantai **Pencatat**.

## Konfigurasi

Semua nilai ada di `backend/.env.example` (salin ke `backend/.env`; untuk
Vercel isi di Environment Variables):

| Variabel | Dipakai | Keterangan |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | pencatat, API | Server-side saja |
| `SUPABASE_ANON_KEY` | API (opsional) | Dipakai untuk baca bila diisi |
| `ADMIN_PIN`, `ADMIN_TOKEN_SECRET` | API | PIN panel Kelola node + rahasia token sesi |
| `MQTT_HOST`, `MQTT_PORT`, `MQTT_TLS`, `MQTT_USERNAME`, `MQTT_PASSWORD` | pencatat | Broker untuk pencatat |
| `MQTT_WS_URL`, `MQTT_WEB_USERNAME`, `MQTT_WEB_PASSWORD` | API → browser | Broker WebSocket dasbor; akun **hanya subscribe** |
| `TOPIC_PREFIX`, `NODE_ID` | pencatat, API | Harus sama dengan firmware |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | pencatat | Opsional |
| `STALE_SECONDS`, `RETENTION_DAYS`, `ALERT_*` | pencatat | Deteksi offline, retensi, ambang alert |

Firmware memakai `secrets.h` (salin dari `secrets.example.h`): WiFi, serta
host/TLS/akun broker. File itu masuk `.gitignore`.

## API

| Endpoint | Isi | Ukuran (data asli) |
|---|---|---|
| `GET /api/latest?node_id=` | Pembacaan terakhir, `latest_at`, total, heartbeat pencatat, status node | ±0,6 KB |
| `GET /api/series?node_id=&range=1h\|6h\|24h\|7d\|30d` atau `&from=&to=` | Agregat per bucket (avg/min/maks, n), maks 720 bucket | ≤ ±70 KB |
| `GET /api/events?node_id=&limit=20&before=` | Kejadian terbaru dulu + paginasi | ±4 KB |
| `GET /api/nodes` · `POST /api/nodes` | Daftar node · simpan (butuh token admin) | < 5 KB |
| `POST /api/admin` | `{pin}` → token sesi 30 menit; maks 5 gagal / 15 menit per IP | — |
| `GET /api/mqtt-config` | Alamat broker WebSocket + akun baca | — |
| `GET /api/health` | Status konfigurasi | — |

Bila `sql/002_series.sql` belum dijalankan, `/api/series` dan `/api/latest`
tetap bekerja dengan agregasi di server (lebih lambat). Diagnostik akan
menyebut "migrasi 002 belum dijalankan".

## Pengujian

```sh
npm test                                              # API + modul dasbor
npm run check                                         # cek sintaks
.venv/bin/python -m unittest discover -s backend/tests -t . -v
```

## Pustaka frontend

Pustaka disimpan di `public/vendor/` dengan versi terkunci di `package.json`
(lihat `public/vendor/VERSIONS.txt`). Setelah mengubah versi: `npm install &&
npm run vendor`. Tidak ada CDN, sehingga CSP bisa `script-src 'self'`.

## Batasan

Prototipe satu node, DHT11, MQ-2 tanpa kalibrasi ppm, dan pencatat yang
berjalan di laptop. Skor risiko adalah proksi sederhana, bukan FWI/KBDI resmi.
Selama broker masih publik, siapa pun bisa mengirim pesan ke topik. Dasbor
memvalidasi dan tidak pernah merender isi pesan sebagai HTML, tetapi data
palsu tetap bisa terlihat. Pindah ke broker privat menutup celah ini
(`docs/DEPLOY.md` §4).
