# Deploy & Konfigurasi

## Ringkasan

| Bagian | Lokasi | Cara jalan |
|---|---|---|
| Dasbor + API | Vercel | Static `public/**` + serverless `api/*.js` |
| Database | Supabase (project yang sudah ada) | Dibaca/ditulis API dan pencatat |
| Pencatat & alert Telegram | `backend/` di laptop/PC | `./backend/jalankan.sh` atau `run_backend.bat` |
| Firmware | `esp32_firmware.ino` | Arduino IDE / PlatformIO |

Repository: <https://github.com/Ghivee/antikobongan> · Produksi:
<https://antikobongan.vercel.app>. Push ke `main` = deploy Production.

## 1. Database (sekali, urut)

Buka **Supabase → SQL Editor** dan jalankan:

1. `sql/001_schema.sql` — tabel dasar. Idempotent, aman bila sudah pernah dijalankan.
2. `sql/002_series.sql` — **baru**. Isinya:
   - kolom `readings.gas_excess` dan `readings.formula_version` (audit skor);
   - kolom `nodes.lapisan`, `nodes.ketinggian`, dan `nodes.updated_at`;
   - fungsi `reading_series` (agregasi per bucket) dan `reading_latest`;
   - tabel `admin_attempts` (batas percobaan PIN);
   - index `events (node_id, created_at desc)`.

Keduanya tidak menghapus data. Urutan deploy aman: kode lama tetap jalan
setelah 002, dan kode baru tetap jalan sebelum 002 (dengan fallback).

## 2. Environment Vercel

**Project → Settings → Environment Variables** (Production, Preview, Development):

| Name | Nilai |
|---|---|
| `SUPABASE_URL` | Project URL Supabase |
| `SUPABASE_SECRET_KEY` | service_role key (wajib untuk Kelola node & batas PIN) |
| `ADMIN_PIN` | PIN admin |
| `ADMIN_TOKEN_SECRET` | `openssl rand -hex 32` |
| `TOPIC_PREFIX` | `antikobongan/prototipe-gx7q4m` |
| `MQTT_WS_URL` | Kosongkan untuk broker publik, atau `wss://<cluster>:8884/mqtt` |
| `MQTT_WEB_USERNAME`, `MQTT_WEB_PASSWORD` | Akun broker **hanya subscribe** (kosong untuk publik) |

Setelah env diubah, **Redeploy**.

## 3. Verifikasi setelah deploy

```sh
curl https://antikobongan.vercel.app/api/health
# {"ok":true,"databaseConfigured":true,"adminConfigured":true}

curl "https://antikobongan.vercel.app/api/latest?node_id=esp32-01"
# latest_at = pembacaan TERBARU (bukan tertua), heartbeat = sinyal pencatat

curl "https://antikobongan.vercel.app/api/series?node_id=esp32-01&range=7d"
# "source":"rpc" berarti 002 aktif; "rest" berarti 002 belum dijalankan
```

Lalu buka dasbor → menu ⋯ → **Kelola node**, dan isi nama, lokasi, serta
koordinat node yang sebenarnya. Peta baru muncul setelah ada koordinat.

## 4. Pindah ke broker privat (disarankan)

Broker publik membuat siapa pun bisa mengirim pesan ke topik. Langkahnya:

1. Buat cluster gratis HiveMQ Cloud (atau EMQX Serverless).
2. Buat tiga akun beserta ACL-nya:
   - `perangkat-esp32-01`: publish `antikobongan/<prefix>/esp32-01/#`
   - `pencatat`: subscribe `antikobongan/<prefix>/#`
   - `dasbor`: subscribe `antikobongan/<prefix>/#` saja
3. Firmware (`secrets.h`): `SECRET_MQTT_HOST`, `SECRET_MQTT_TLS 1`, dan akun
   perangkat. Lalu flash ulang.
4. Pencatat (`backend/.env`): `MQTT_HOST`, `MQTT_TLS=1`, `MQTT_USERNAME`, dan
   `MQTT_PASSWORD` (akun pencatat).
5. Vercel: `MQTT_WS_URL`, `MQTT_WEB_USERNAME`, dan `MQTT_WEB_PASSWORD` (akun
   dasbor), lalu Redeploy.

Diagnostik di dasbor menampilkan broker yang sedang dipakai.

## 5. Troubleshooting

| Gejala di rantai status | Penyebab | Solusi |
|---|---|---|
| **Node** merah "Tidak mengirim" | ESP32 mati, WiFi atau broker putus | Cek daya/WiFi; lihat Serial Monitor |
| **Broker** merah | Jaringan memblokir WSS 8884, atau kredensial salah | Coba jaringan lain; cek `MQTT_WS_URL`/akun |
| **Pencatat** merah "Berhenti" | Laptop tidur atau `main.py` berhenti | Jalankan ulang pencatat, pakai `caffeinate -i` |
| **Database** "Tertinggal" | Live masuk tetapi tidak tersimpan (pencatat mati/galat) | Lihat `backend/logs/backend.log` |
| **Database** "Tidak dapat dibaca" | Env Vercel kosong atau key ditolak | Cek env, lalu Redeploy; lihat Vercel → Logs |
| Kelola node: "Kolom tabel nodes belum lengkap" | 002 belum dijalankan | Jalankan `sql/002_series.sql` |
| Kelola node: "Kunci tulis database belum dikonfigurasi" | `SUPABASE_SECRET_KEY` kosong | Isi di Vercel |

## 6. Keamanan

- `SUPABASE_SECRET_KEY`, `ADMIN_PIN`, `ADMIN_TOKEN_SECRET`, dan
  `TELEGRAM_BOT_TOKEN` hanya ada di env Vercel dan `backend/.env`.
- Dasbor tidak memuat skrip dari CDN. CSP-nya `script-src 'self'`, dan semua
  teks dari jaringan dirender lewat `textContent`.
- `/api/admin` dibatasi 5 percobaan gagal per 15 menit per IP. Sukses
  menghasilkan token HMAC 30 menit; `POST /api/nodes` menolak tanpa token.
- API baca (latest/series/events/nodes) bersifat publik. Bila data tidak boleh
  publik, tambahkan autentikasi di `lib/handlers/*` atau batasi RLS.
