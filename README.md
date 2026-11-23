# AntiKobongan

AntiKobongan is a forest fire risk monitoring system. "Kobongan" is Javanese/Indonesian slang for something burning down, and the project exists because early smoke and heat signs in a forest or peatland area are easy to miss until a fire is already out of control. An ESP32 node in the field publishes temperature, air humidity, gas and smoke levels, and soil moisture over MQTT. A small Python logger running on a laptop or PC subscribes to that stream, validates it, stores the history in Supabase, and can push Telegram alerts. A web dashboard shows both the live reading and the history. Every number the dashboard shows is a real sensor reading; there is no simulation or demo mode that could be mistaken for live data.

[Baca dalam Bahasa Indonesia di bawah](#bahasa-indonesia)

## Architecture

```
ESP32 --MQTT--> broker (public, or private with TLS) <--WSS-- dashboard (Vercel)
                         |                                      ^
                         v                                      | /api/*
              Python logger (laptop or PC)                      |
               +--> Supabase -----------------------------------+
               +--> Telegram (optional)
```

| Part | Location | Role |
| --- | --- | --- |
| Dashboard | `public/` | Plain HTML, CSS and ES modules, no build step; shows current risk, trends, alerts and node status |
| Serverless API | `api/*.js`, `lib/handlers/*.js` | Used both by Vercel in production and by `server.js` when running the dashboard locally |
| Logger | `backend/` | Subscribes over MQTT, validates each reading, writes it to Supabase, optionally sends a Telegram message |
| Firmware | `esp32_firmware.ino`, `secrets.h` | Reads the sensors and publishes over MQTT |
| Database schema | `sql/001_schema.sql`, `sql/002_series.sql` | Tables and the aggregation function the dashboard's trend view relies on |
| Deployment guide | `docs/DEPLOY.md` | Step-by-step Vercel and environment setup |

MQTT topics follow `<prefix>/<node>/sensor` (a JSON payload) and `<prefix>/<node>/status` (`online` or `offline`, published through MQTT's last-will mechanism so a node that loses power or connectivity is marked offline automatically rather than just going silent).

## What the dashboard shows

- **Current risk**: one headline number, a level (Normal, Medium, High or Critical, shown with both color and shape so it still reads correctly for colorblind users), the trend over the last hour, the age of the data, and a short piece of advice. If the latest reading is older than five minutes, the dashboard says so explicitly instead of quietly showing stale data as if it were current.
- **Status chain**: Node, Broker, Logger, Database shown as a chain, so when something stops updating it is clear which link broke (for example, "the node is still publishing, but the logger has stopped").
- **Readings and score contributions**: the four components of the firmware's risk formula (each scaled to a fraction such as `x/35` or `x/25`). Older rows recorded before a component like `gas_excess` existed are marked "n/a" rather than guessed at, so historical charts never fabricate a number that was never measured.
- **Trends**: score charts with shaded threshold bands at 40, 60 and 80, a min-max band per time bucket, gaps in the data shown as "no data" instead of a flat or interpolated line, and a synchronized crosshair and readout. Ranges run from 1 hour up to 30 days, plus a custom range and a "jump to latest data" shortcut.
- **Alerts and events**: events recorded in the database, plus alerts the dashboard computes live from the current score. The MQTT `alert` topic is intentionally unused for this, so an alert always reflects what the dashboard itself just calculated rather than trusting a message that might be stale.
- **Nodes**: a list of nodes and a Leaflet map, which only appears once at least one node has coordinates.
- **Node management**: behind a PIN checked server-side, where the node list is edited and saved to the `nodes` table for every viewer to see.
- **Diagnostics**: broker configuration, a data summary, and technical logs, useful when something in the chain above is not behaving as expected.

## Running it locally

```sh
npm install
cp backend/.env.example backend/.env   # then fill in the values
npm start                               # http://localhost:3000
```

`server.js` reads `backend/.env`, uses the exact same API handlers Vercel runs in production, and sends the same security headers (sourced from `vercel.json`), so a local run behaves the same way the deployed dashboard does.

### Running the logger

On macOS or Linux:

```sh
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
./backend/jalankan.sh
```

On Windows, use `run_backend.bat` instead. The logger has to keep running continuously for history and alerts to be recorded at all; if it stops, the Logger link in the dashboard's status chain turns red so the gap is visible immediately rather than silently losing data.

## Configuration

All values are listed with explanations in `backend/.env.example`. For a Vercel deployment, set the same names as environment variables in the project settings instead of a `.env` file.

| Variable | Used by | Notes |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | logger, API | Server side only; never expose the secret key to a browser |
| `SUPABASE_ANON_KEY` | API | Optional, used for reads when set |
| `ADMIN_PIN`, `ADMIN_TOKEN_SECRET` | API | The node management PIN and the secret used to sign its short-lived session token |
| `MQTT_HOST`, `MQTT_PORT`, `MQTT_TLS`, `MQTT_USERNAME`, `MQTT_PASSWORD` | logger | Broker connection for the logger |
| `MQTT_WS_URL`, `MQTT_WEB_USERNAME`, `MQTT_WEB_PASSWORD` | API, browser | WebSocket broker connection for the dashboard; use a subscribe-only account, since this account's credentials reach the browser |
| `TOPIC_PREFIX`, `NODE_ID` | logger, API | Must match what the firmware publishes |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | logger | Optional alerting |
| `STALE_SECONDS`, `RETENTION_DAYS`, `ALERT_*` | logger | How quickly a node is considered offline, how long history is kept, and alert thresholds |

The firmware itself reads a separate `secrets.h` (copy `secrets.example.h`): WiFi credentials, and the broker's host, TLS setting and account. It is listed in `.gitignore` so it is never committed.

## API

| Endpoint | Returns |
| --- | --- |
| `GET /api/latest?node_id=` | The latest reading, `latest_at`, totals, the logger's heartbeat, and the node's online/offline status |
| `GET /api/series?node_id=&range=1h\|6h\|24h\|7d\|30d` (or `&from=&to=`) | Per-bucket aggregates (average, min, max, sample count), capped at 720 buckets per request |
| `GET /api/events?node_id=&limit=20&before=` | Newest events first, with cursor-based pagination |
| `GET /api/nodes`, `POST /api/nodes` | List nodes; save the node list (requires an admin token) |
| `POST /api/admin` | `{pin}` returns a 30-minute session token; capped at 5 failed attempts per 15 minutes per IP address |
| `GET /api/mqtt-config` | The WebSocket broker address and its read-only account, for the dashboard to connect with |
| `GET /api/health` | Whether the server's configuration looks complete |

If `sql/002_series.sql` has not yet been applied to the database, `/api/series` and `/api/latest` still work, just more slowly, because the aggregation then happens on the server instead of in the database.

## Tests

```sh
npm test                                              # API and dashboard modules
npm run check                                         # a syntax check across every script
.venv/bin/python -m unittest discover -s backend/tests -t . -v
```

---

## Bahasa Indonesia

AntiKobongan adalah sistem pemantauan risiko kebakaran hutan. "Kobongan" artinya sesuatu yang terbakar, dan proyek ini dibuat karena tanda-tanda awal asap dan panas di area hutan atau lahan gambut mudah terlewat sampai kebakarannya sudah tidak terkendali. Node ESP32 di lapangan mengirim suhu, kelembapan udara, tingkat gas dan asap, serta kelembapan tanah lewat MQTT. Pencatat Python kecil yang berjalan di laptop atau PC berlangganan aliran data itu, memvalidasinya, menyimpan riwayatnya di Supabase, dan bisa mengirim peringatan Telegram. Dashboard web menampilkan pembacaan langsung sekaligus riwayatnya. Setiap angka yang ditampilkan dashboard adalah pembacaan sensor sungguhan; tidak ada mode simulasi atau demo yang bisa disalahartikan sebagai data langsung.

### Arsitektur

```
ESP32 --MQTT--> broker (publik, atau privat dengan TLS) <--WSS-- dashboard (Vercel)
                         |                                      ^
                         v                                      | /api/*
              pencatat Python (laptop atau PC)                  |
               +--> Supabase -----------------------------------+
               +--> Telegram (opsional)
```

| Bagian | Lokasi | Peran |
| --- | --- | --- |
| Dashboard | `public/` | HTML, CSS, dan ES modules biasa, tanpa langkah build; menampilkan risiko saat ini, tren, peringatan, dan status node |
| API serverless | `api/*.js`, `lib/handlers/*.js` | Dipakai Vercel di produksi maupun `server.js` saat dashboard dijalankan lokal |
| Pencatat | `backend/` | Berlangganan lewat MQTT, memvalidasi setiap pembacaan, menuliskannya ke Supabase, opsional mengirim pesan Telegram |
| Firmware | `esp32_firmware.ino`, `secrets.h` | Membaca sensor dan mengirim lewat MQTT |
| Skema database | `sql/001_schema.sql`, `sql/002_series.sql` | Tabel dan fungsi agregasi yang diandalkan tampilan tren dashboard |
| Panduan deploy | `docs/DEPLOY.md` | Langkah demi langkah setup Vercel dan variabel lingkungan |

Topik MQTT memakai format `<prefix>/<node>/sensor` (payload JSON) dan `<prefix>/<node>/status` (`online` atau `offline`, diterbitkan lewat mekanisme last-will MQTT sehingga node yang kehilangan daya atau koneksi otomatis ditandai offline, bukan sekadar diam tanpa penjelasan).

### Isi dashboard

- **Risiko sekarang**: satu angka utama, level (Normal, Sedang, Tinggi, atau Kritis, ditampilkan dengan warna sekaligus bentuk agar tetap terbaca bagi pengguna buta warna), tren satu jam terakhir, umur data, dan saran singkat. Bila pembacaan terakhir lebih tua dari lima menit, dashboard menyatakan hal itu secara eksplisit, bukan diam-diam menampilkan data basi seolah masih kondisi sekarang.
- **Rantai status**: Node, Broker, Pencatat, Database ditampilkan sebagai satu rantai, sehingga saat sesuatu berhenti memperbarui, jelas mata rantai mana yang putus (misalnya, "node masih mengirim, tetapi pencatat sudah berhenti").
- **Pembacaan dan kontribusi skor**: empat komponen rumus risiko firmware (masing-masing diskalakan menjadi pecahan seperti `x/35` atau `x/25`). Baris lama yang dicatat sebelum komponen seperti `gas_excess` ada ditandai "n/a" bukan ditebak, sehingga grafik historis tidak pernah mengarang angka yang tidak pernah benar-benar diukur.
- **Tren**: grafik skor dengan pita ambang berwarna di 40, 60, dan 80, pita min-maks per bucket waktu, jeda pada data ditandai "tidak ada data" bukan garis rata atau interpolasi, serta crosshair dan readout yang tersinkron. Rentang mulai dari 1 jam sampai 30 hari, ditambah rentang kustom dan pintasan "lompat ke data terakhir".
- **Peringatan dan kejadian**: kejadian yang tercatat di database, ditambah peringatan yang dihitung dashboard secara langsung dari skor saat ini. Topik MQTT `alert` sengaja tidak dipakai untuk ini, sehingga peringatan selalu mencerminkan hasil hitungan dashboard sendiri, bukan mempercayai pesan yang mungkin sudah basi.
- **Node**: daftar node dan peta Leaflet, yang hanya muncul setelah ada minimal satu node berkoordinat.
- **Kelola node**: di belakang PIN yang diperiksa di server, tempat daftar node diedit dan disimpan ke tabel `nodes` untuk dilihat semua pengguna.
- **Diagnostik**: konfigurasi broker, ringkasan data, dan log teknis, berguna saat ada bagian dari rantai di atas yang tidak berperilaku sesuai harapan.

### Menjalankan lokal

```sh
npm install
cp backend/.env.example backend/.env   # lalu isi nilainya
npm start                               # http://localhost:3000
```

`server.js` membaca `backend/.env`, memakai handler API yang persis sama dengan yang dijalankan Vercel di produksi, dan mengirim header keamanan yang sama (diambil dari `vercel.json`), sehingga jalan lokal berperilaku sama seperti dashboard yang sudah dideploy.

#### Menjalankan pencatat

Di macOS atau Linux:

```sh
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
./backend/jalankan.sh
```

Di Windows, pakai `run_backend.bat`. Pencatat harus terus berjalan agar riwayat dan peringatan benar-benar tercatat; bila berhenti, mata rantai Pencatat di status chain dashboard menyala merah sehingga jedanya langsung terlihat, bukan diam-diam kehilangan data.

### Konfigurasi

Semua nilai tercantum dengan penjelasannya di `backend/.env.example`. Untuk deployment Vercel, atur nama yang sama sebagai variabel lingkungan di pengaturan proyek, bukan berkas `.env`.

| Variabel | Dipakai | Keterangan |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | pencatat, API | Hanya sisi server; jangan pernah mengekspos secret key ini ke peramban |
| `SUPABASE_ANON_KEY` | API | Opsional, dipakai untuk baca bila diisi |
| `ADMIN_PIN`, `ADMIN_TOKEN_SECRET` | API | PIN kelola node dan secret untuk menandatangani token sesinya yang berumur pendek |
| `MQTT_HOST`, `MQTT_PORT`, `MQTT_TLS`, `MQTT_USERNAME`, `MQTT_PASSWORD` | pencatat | Koneksi broker untuk pencatat |
| `MQTT_WS_URL`, `MQTT_WEB_USERNAME`, `MQTT_WEB_PASSWORD` | API, peramban | Koneksi broker WebSocket untuk dashboard; pakai akun baca-saja, karena kredensial akun ini sampai ke peramban |
| `TOPIC_PREFIX`, `NODE_ID` | pencatat, API | Harus sama dengan yang dikirim firmware |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | pencatat | Peringatan opsional |
| `STALE_SECONDS`, `RETENTION_DAYS`, `ALERT_*` | pencatat | Seberapa cepat node dianggap offline, berapa lama riwayat disimpan, dan ambang peringatan |

Firmware sendiri membaca berkas `secrets.h` terpisah (salin dari `secrets.example.h`): kredensial WiFi, serta host, setelan TLS, dan akun broker. Berkas ini masuk `.gitignore` agar tidak pernah ter-commit.

### API

| Endpoint | Hasil |
| --- | --- |
| `GET /api/latest?node_id=` | Pembacaan terakhir, `latest_at`, total, heartbeat pencatat, dan status online/offline node |
| `GET /api/series?node_id=&range=1h\|6h\|24h\|7d\|30d` (atau `&from=&to=`) | Agregat per bucket (rata-rata, min, maks, jumlah sampel), maksimal 720 bucket per permintaan |
| `GET /api/events?node_id=&limit=20&before=` | Kejadian terbaru dulu, dengan paginasi berbasis cursor |
| `GET /api/nodes`, `POST /api/nodes` | Daftar node; simpan daftar node (butuh token admin) |
| `POST /api/admin` | `{pin}` mengembalikan token sesi 30 menit; dibatasi maksimal 5 percobaan gagal per 15 menit per alamat IP |
| `GET /api/mqtt-config` | Alamat broker WebSocket dan akun baca-saja-nya, untuk disambungkan dashboard |
| `GET /api/health` | Apakah konfigurasi server terlihat lengkap |

Bila `sql/002_series.sql` belum diterapkan ke database, `/api/series` dan `/api/latest` tetap bekerja, hanya lebih lambat, karena agregasi dilakukan di server, bukan di database.

### Pengujian

```sh
npm test                                              # API dan modul dashboard
npm run check                                         # cek sintaks di semua skrip
.venv/bin/python -m unittest discover -s backend/tests -t . -v
```
