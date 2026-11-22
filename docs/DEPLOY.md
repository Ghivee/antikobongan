# Deploy & Konfigurasi

## Ringkasan

| Bagian | Lokasi | Cara jalan |
|---|---|---|
| Dasbor + API | Vercel | Static `public/**` + serverless `api/*.js` |
| Database | Supabase (project yang sudah ada) | Dibaca/ditulis API dan pencatat |
| Pencatat & alert Telegram | `backend/` di laptop/PC | `./backend/jalankan.sh` atau `run_backend.bat` |
| Firmware | `antikobongan-2.ino` (BME280 + MQ-2 + sensor tanah) | Arduino IDE / PlatformIO |

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

Firmware memakai **BME280** (I2C: VIN/VCC → 3V3, GND, SCL → D22, SDA → D21)
dan tidak lagi memakai DHT11/BMP180. Pasang library `Adafruit BME280 Library`
dan `Adafruit Unified Sensor` sebelum meng-upload. Untuk pencatat, default
`STALE_SECONDS` adalah **15** (5 × interval kirim 3 detik, mode uji realtime);
untuk produksi dengan interval 45 detik, setel **180**.

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
3. Firmware (`antikobongan-2.ino`): ganti `MQTT_HOST`, atur `MQTT_PORT`/TLS,
   dan isi akun perangkat pada bagian konfigurasi di atas file. Lalu flash ulang.
4. Pencatat (`backend/.env`): `MQTT_HOST`, `MQTT_TLS=1`, `MQTT_USERNAME`, dan
   `MQTT_PASSWORD` (akun pencatat).
5. Vercel: `MQTT_WS_URL`, `MQTT_WEB_USERNAME`, dan `MQTT_WEB_PASSWORD` (akun
   dasbor), lalu Redeploy.

Diagnostik di dasbor menampilkan broker yang sedang dipakai.

## 5. Troubleshooting

| Gejala di rantai status | Penyebab | Solusi |
|---|---|---|
| **Node** merah "Offline" | Broker menerima LWT/status `offline` | Cek daya/WiFi ESP32; status dari broker bisa dipalsukan di broker publik |
| **Sensor** merah "Tidak mengirim" | Node online tetapi tidak ada payload valid ≥ 15 detik | Baca Serial Monitor: BME280 gagal (`sensorID=0xFF` = wiring/alamat) |
| **Broker** merah | Jaringan memblokir WSS 8884, atau kredensial salah | Coba jaringan lain; cek `MQTT_WS_URL`/akun |
| **Pencatat** merah "Berhenti" | Laptop tidur atau `main.py` berhenti | Jalankan ulang pencatat, pakai `caffeinate -i` |
| **Database** "Tertinggal" | Live masuk tetapi tidak tersimpan (pencatat mati/galat) | Lihat `backend/logs/backend.log` |
| **Database** "Tidak dapat dibaca" | Env Vercel kosong atau key ditolak | Cek env, lalu Redeploy; lihat Vercel → Logs |
| Telegram 409 / balasan tidak terkirim | Dua backend memakai token yang sama | Jalankan `run_backend.bat` (otomatis menghentikan instance lama) atau `backend\main.py --stop` |
| Kelola node: "Kolom tabel nodes belum lengkap" | 002 belum dijalankan | Jalankan `sql/002_series.sql` |
| Kelola node: "Kunci tulis database belum dikonfigurasi" | `SUPABASE_SECRET_KEY` kosong | Isi di Vercel |

## 6. Bot perintah Telegram

Pencatat menjalankan bot long polling (`getUpdates`) bila token terisi. Chat id
hanya diperlukan untuk notifikasi; bot tetap publik tanpa `TELEGRAM_CHAT_ID`. Tidak perlu webhook; justru webhook harus kosong. Bila log menulis
"webhook bot masih aktif", hapus webhook lewat BotFather/`deleteWebhook`.

| Perintah | Isi |
|---|---|
| `/status` | Ringkasan kondisi, skor, semua sensor, saran, umur data |
| `/risiko` `/suhu` `/kelembapan` `/gas` `/tanah` `/tekanan` | Nilai terakhir + tren 1 jam |
| `/tren` · `/harian` | Ringkasan 1 jam · 24 jam (min–maks, rata-rata, jumlah) |
| `/riwayat` | 5 pembacaan terakhir |
| `/node` | Status node, data terakhir, topik sensor |
| `/waktu` · `/id` | Waktu server + umur data · chat id untuk menambah grup |
| `/bantuan` | Daftar perintah |

Pertanyaan bebas juga dikenali ("berapa suhu sekarang", "apakah aman").
Bot bersifat publik: semua chat dan grup boleh bertanya tanpa mendaftarkan
chat id. Bila perlu dibatasi, setel `TELEGRAM_ALLOW_UNKNOWN=0` dan isi
`TELEGRAM_CHAT_ID`. `TELEGRAM_COMMANDS=0` mematikan bot tanpa mematikan
notifikasi. Pasang menu manual: `backend/main.py --setup-telegram`; uji balasan
tanpa mengirim: `--test-commands`.

Di grup, Telegram hanya mengirim pesan bebas yang menyebut bot
(`@antikobonganbot`) atau membalas pesannya. Perintah `/...` selalu diterima.
Agar pertanyaan bebas tanpa mention juga masuk, matikan privacy mode lewat
BotFather (`/setprivacy` → Disable).

Bila dua proses memakai token yang sama, `getUpdates` mengembalikan 409 dan
balasan bisa tidak terkirim. `run_backend.bat` otomatis menghentikan instance
lama sebelum mulai; untuk menghentikan saja gunakan
`backend\main.py --stop`. Hentikan pencatat sebelum memakai
`backend/get_chat_id.py`.

## 7. Keamanan

- `SUPABASE_SECRET_KEY`, `ADMIN_PIN`, `ADMIN_TOKEN_SECRET`, dan
  `TELEGRAM_BOT_TOKEN` hanya ada di env Vercel dan `backend/.env`.
- Dasbor tidak memuat skrip dari CDN. CSP-nya `script-src 'self'`, dan semua
  teks dari jaringan dirender lewat `textContent`.
- `/api/admin` dibatasi 5 percobaan gagal per 15 menit per IP. Sukses
  menghasilkan token HMAC 30 menit; `POST /api/nodes` menolak tanpa token.
- API baca (latest/series/events/nodes) bersifat publik. Bila data tidak boleh
  publik, tambahkan autentikasi di `lib/handlers/*` atau batasi RLS.
