# Hasil Analisis AntiKobongan

**Tanggal:** 16 November 2026
**Objek:** `antikobongan-2.ino`, `antikobongan_panduan_rakit.html`, backend + frontend
**Perangkat uji:** ESP32 DevKit V1 di expansion board 30-pin, port **COM8** (Silicon Labs CP210x)
**Alat:** `arduino-cli` (core `esp32:esp32` 3.3.12), Chrome headless (render visual), Node.js test runner, Python `unittest`

---

## 1. Ringkasan eksekutif

| Aspek | Status |
|---|---|
| Peta pin firmware vs panduan rakit | **Cocok 100%** |
| Kompilasi firmware | **Berhasil** — 987.985 B (75% flash), 50.308 B (15% RAM) |
| Upload ke ESP32 | **Berhasil** |
| OLED SSD1306 (0x3C) | **Normal** |
| WiFi `PP` + MQTT `broker.hivemq.com` | **Normal** — status `online`, LWT aktif, NTP UTC+7 |
| Backend + frontend test | **Lulus** — 18/18 (Node), 74 (Python) |
| Pembacaan BME280 | **GAGAL — cacat fisik pada jalur I2C** |
| Penyebab | Kontak kabel/header I2C goyah, **bukan** chip rusak, **bukan** kode |

**Kesimpulan:** perangkat lunak sudah valid dan tahan terhadap sensor gagal. Satu-satunya penghalang agar data mengalir ke dasbor adalah perbaikan mekanis pada sambungan 4 kabel BME280 ke header I2C.

---

## 2. Lingkup pemeriksaan

1. **Panduan rakit HTML** — dibaca penuh (127.025 byte) secara kode, lalu dirender ke PDF dan 12 tangkapan layar agar tata letak, tabel, dan diagram SVG ikut diverifikasi.
2. **Firmware** — kompilasi, upload, dan pemantauan Serial Monitor 115.200 baud.
3. **Konsistensi pin** — membandingkan `const uint8_t PIN_*` di firmware dengan tabel di panduan dan README.
4. **Backend** — `backend/validator.py`, `backend/config.py`, `backend/main.py`.
5. **Frontend** — `public/js/validate.js`, `public/js/risk.js`.
6. **Diagnostik register I2C** — dump register langsung untuk memisahkan kerusakan chip dari kerusakan kabel.

---

## 3. Temuan 1 — Konfigurasi pin sudah konsisten

Perbandingan firmware, panduan rakit, dan README:

| Komponen | Firmware | Panduan | README (lama) | Verdict |
|---|---|---|---|---|
| BME280 SDA / SCL | D21 / D22 | D21 / D22 | D21 / D22 | OK |
| OLED SDA / SCL | D21 / D22 (0x3C) | D21 / D22 | tidak tercantum | OK |
| MQ-2 AO | GPIO34 | GPIO34 | GPIO34 | OK |
| Sensor tanah AO | GPIO35 | GPIO35 | GPIO35 | OK |
| Baterai (pembagi) | GPIO32 | GPIO32 | tidak tercantum | OK |
| LED merah | GPIO25 | GPIO25 | **GPIO27** | README salah |
| LED hijau | GPIO26 | GPIO26 | **GPIO26** | OK |
| LED kuning | GPIO33 | GPIO33 | **tidak ada** | README salah |
| Buzzer | GPIO27 | GPIO27 | **GPIO25** | README salah |

**Tindakan:** README diperbaiki (lihat §6). Firmware dan panduan tidak perlu diubah karena sudah benar.

---

## 4. Temuan 2 — Kegagalan BME280

### 4.1 Gejala di Serial Monitor

```
[BME280] Siap di 0x76, chipID=0x60, ctrl_meas=0x57.
[MQTT] Terhubung.
[SENSOR] BME280 tidak valid (T=23.33 H=0.00 P=751.14), gagal 1/3
[SENSOR] BME280 tidak valid (T=23.33 H=0.00 P=751.14), gagal 2/3
[SENSOR] BME280 tidak valid (T=182.15 H=100.00 P=-99.23), gagal 3/3
[SENSOR] Pembacaan tidak wajar berulang -> init ulang BME280.
```

Dua pola muncul bergantian:

| Pola | Nilai | Arti teknis |
|---|---|---|
| A | `T=23.33  H=0.00  P=751.14` | Bus mengembalikan **0x00** → suhu "kebetulan" wajar, kelembapan mustahil 0 |
| B | `T=182.15 H=100.00 P=-99.23` | Bus mengembalikan **0xFF** → semua bit 1, hasil hitungan meledak |

Keduanya **bukan** data sensor. Udara tidak mungkin 182 °C dengan RH tepat 100,00 % dan tekanan negatif.

### 4.2 Bukti dari dump register

```
[I2C] 0x76 present=1 chipID=0x60
calib T/P 0x88 ..: EB 6D 32 67 32 00 97 90 82 FF EE EE EE EE EE EE EE EE ...
calib H   0xE1 ..: EE EE EE EE EE EE EE
data      0xF7 ..: EE EE EE EE EE EE EE EE
[BME280] begin=0 T=nan H=nan P=nan
[BMP280] begin=0 T=nan P=nan
```

Poin penting:

- **`chipID = 0x60`** → ini benar BME280, bukan BMP280 yang dilabeli salah.
- **`dig_T1 = 0x6DEB`, `dig_P1 = 0x9097`** → blok kalibrasi terbaca utuh dan masuk akal. Chip hidup dan menyimpan data pabriknya.
- **`0xE1` dan `0xF7` mengembalikan `0xEE`** (nilai sentinel "gagal baca" di sketch diagnostik) → transfer **berhenti bekerja setelah 9 byte pertama**.
- Driver `Adafruit_BME280` **dan** `Adafruit_BMP280` sama-sama `begin=0` → bukan masalah library atau rumus kompensasi.

### 4.3 Diagnosis diferensial

| Hipotesis | Uji | Hasil |
|---|---|---|
| Chip BME280 palsu (die BMP280) | Cek `chipID`; blok kalibrasi kelembapan `0xE1` | chipID `0x60` asli — **ditolak** |
| Chip rusak total | Baca blok kalibrasi `0x88` | 9 byte pertama valid — **ditolak** |
| Library/rumus salah | Uji dengan dua library berbeda | Keduanya gagal identik — **ditolak** |
| Clock I2C terlalu tinggi | Turunkan 50 kHz → **10 kHz** | Hasil identik — **ditolak** |
| Tegangan kurang | `chipID` masih terbaca, OLED di bus yang sama normal | Tidak konsisten dengan gejala — **tidak terbukti** |
| **Kontak kabel/header goyah** | Kegagalan mulai persis setelah N byte, nilai 0x00/0xFF bergantian | **Paling sesuai** |

**Kesimpulan:** jalur SDA/SCL ke modul BME280 kehilangan kontak secara intermiten. Kalibrasi (26 byte pertama, dibaca saat init) lolos, lalu transfer berikutnya putus di tengah. Ini tipikal kabel Dupont 30 cm yang kendor di header, atau solderan pin header modul yang retak.

> Catatan tambahan: kalau header I2C ternyata memberi **5 V** (posisi JUMP salah), BME280 bisa rusak sebagian — gejalanya juga RH 0 % permanen. Karena itu pengukuran tegangan header menjadi langkah pertama, bukan opsional.

---

## 5. Perbaikan firmware (`antikobongan-2.ino`)

Prinsip yang dipakai: **lebih baik dasbor kosong daripada alarm palsu.**

| # | Masalah | Perbaikan |
|---|---|---|
| 1 | Nilai rusak tetap dikirim ke MQTT | Pembacaan divalidasi; yang di luar batas **tidak dipublikasikan** |
| 2 | Nilai rusak menambah skor risiko | Sensor tidak valid **tidak menyumbang poin** (`calcRiskScore` menerima flag `*Ok`) |
| 3 | Gagal sesaat langsung memicu init ulang | 3× retry + cek `i2cPresent(bmeAddress)` sebelum menyimpulkan |
| 4 | Init terlalu longgar | Wajib `chipID == 0x60`, soft reset `0xE0=0xB6`, tunggu `im_update`, verifikasi `ctrl_meas & 0x03 == 0x03` |
| 5 | Sensor mati permanen tanpa pemulihan | Init diulang tiap 30 detik; 3 kegagalan berturut → init ulang |
| 6 | Bus error pada kabel panjang | I2C 50 kHz |
| 7 | D32 melayang saat baterai belum dipasang | 16 sampel + cek sebaran < 200 mV → `BAT --` bila tidak stabil |
| 8 | Field opsional dikirim 0 saat sensor lepas | `tekanan`, `gas_excess`, `kelembapan_tanah` dihilangkan dari JSON |
| 9 | Sulit menelusuri masalah via MQTT | Penanda `bme_ok`, `gas_ok`, `tanah_ok` di payload |
| 10 | ADC tunggal mudah terganggu | Rata-rata 8 sampel, median 5 sampel untuk MQ-2 |
| 11 | OLED diam saat sensor gagal | Pesan `BME280 TIDAK TERBACA` + petunjuk `Cek VCC 3,3V / SDA-SCL` |

### Batas kewajaran yang dipakai

```
Suhu      : -20 … 80 °C
Kelembapan:  0,5 … 100 %
Tekanan   : 300 … 1100 hPa
Gas (ADC) : 5 … 4080   (0 dan 4095 = pin lepas)
Tanah(ADC): 20 … 4080  (0 dan 4095 = pin lepas)
```

### Hasil build

```
Sketch uses 987985 bytes (75%) of program storage space. Maximum is 1310720 bytes.
Global variables use 50308 bytes (15%) of dynamic memory, leaving 277372 bytes for local variables.
```

Upload ke COM8 berhasil, dan firmware berjalan sesuai rancangan: menolak data rusak, OLED tetap hidup, MQTT tetap `online`, dan tidak ada payload palsu yang terkirim.

---

## 6. Perbaikan dokumentasi

| Berkas | Perubahan |
|---|---|
| `antikobongan_panduan_rakit.html` | Nama firmware → `antikobongan-2.ino` (4 tempat); "belum ada di kode" → "sudah ada di kode"; catatan bagian 8 ditulis ulang; **bagian 9 baru "Kalau sensor bermasalah"** |
| `README.md` | Tabel hardware dikoreksi total (LED merah 25, kuning 33, buzzer 27, OLED, pembagi baterai); `SENSOR_INTERVAL_MS`; catatan buzzer & validitas data; referensi `LAPORAN-BME280.md` yang sudah dihapus diganti |
| `docs/DEPLOY.md` | `esp32_firmware.ino` → `antikobongan-2.ino` (2 tempat) |
| `docs/panduan-sistem.html` | idem (2 tempat) |
| `backend/main.py` | komentar `calcRiskScore` |
| `public/js/risk.js` | komentar `calcRiskScore` |
| `public/js/ui/io.js` | komentar acuan firmware |

Isi bagian 9 panduan rakit:

1. Ukur header I2C (harus 3,3 V) sebelum memasang BME280.
2. I2C scanner harus menemukan **dua** alamat: `0x76` dan `0x3C`.
3. Arti baris log `[BME280] Siap…` vs `[SENSOR] BME280 tidak valid…`.
4. Penjelasan pola `H=0.00` dan `T=182 / H=100 / P=-99` sebagai ciri kabel lepas.
5. Larangan menaikkan I2C ke 400 kHz.
6. Gejala lain: tanah 0/100 %, gas 0, `BAT --`, dasbor kosong yang disengaja.

---

## 7. Hasil pengujian otomatis

```
npm test
ℹ tests 18
ℹ pass 18
ℹ fail 0

python -m unittest discover -s backend/tests -t . -q
Ran 74 tests in 0.029s
OK
```

Yang diverifikasi antara lain: validasi topik & payload, hanya `online`/`offline` yang diterima, ambang data basi 15 detik, agregasi bucket grafik, format WIB/angka Indonesia, dan pembulatan tekanan 2 desimal.

---

## 8. Tindakan yang diperlukan (fisik)

Firmware **tidak perlu di-upload ulang** setelah ini. Cukup perbaiki sambungan:

- [ ] **Ukur header I2C** — probe hitam di `G`, merah di `V`. Harus **3,3 V**.
- [ ] Kalau terbaca 5 V: matikan alat, geser jumper **JUMP** ke 3,3 V, ukur lagi, baru pasang modul.
- [ ] Cabut dan colok ulang keempat Dupont (VCC, GND, SDA, SCL) sampai terasa klik.
- [ ] Periksa solderan 4 pin header **di modul BME280** — tersangka utama bila Dupont sudah rapi.
- [ ] Coba kabel lebih pendek (±15 cm) sebagai uji banding.
- [ ] Nyalakan ulang dan pantau Serial Monitor.

**Kriteria berhasil:**

```
[BME280] Siap di 0x76, chipID=0x60, ctrl_meas=0x57.
[PUB] OK | {"suhu":29.4,"kelembapan":61.2,"gas":812,"gas_excess":3,
            "kelembapan_tanah":47,"riskScore":12,"status":"NORMAL",
            "tekanan":1009.84,"bme_ok":true,"gas_ok":true,"tanah_ok":true,
            "timestamp":"2026-11-16T21:04:00+07:00"}
```

Firmware mencoba init ulang tiap **30 detik**, jadi data akan mengalir sendiri tanpa perlu flashing ulang.

---

## 9. Risiko & rekomendasi lanjutan

| Prioritas | Rekomendasi | Alasan |
|---|---|---|
| Tinggi | Ganti Dupont 30 cm dengan kabel tersolder atau konektor JST | Kontak mekanis adalah satu-satunya kegagalan yang tersisa |
| Tinggi | Tambahkan pull-up 4,7 kΩ di SDA/SCL bila kabel > 30 cm | Bus I2C lebih stabil untuk dua perangkat |
| Sedang | Kalibrasi MQ-2 ke ppm, bukan ADC mentah | Skor gas saat ini hanya proksi |
| Sedang | Pindah ke broker MQTT privat + kredensial | Saat ini siapa pun bisa memalsukan `online`/`offline` |
| Rendah | Turunkan `SENSOR_INTERVAL_MS` ke 45.000 untuk produksi | 3 detik menghasilkan ±28.800 baris/hari di Supabase |
| Rendah | Samakan `esp32_firmware.ino` lama atau hapus + perbarui `wokwi.toml` | Masih ada dua sumber firmware di repo |

---

## 10. Lampiran — log perangkat terakhir

```
=== AntiKobongan ESP32 Node ===
Node   : esp32-01
Prefix : antikobongan/prototipe-gx7q4m
Topic  : antikobongan/prototipe-gx7q4m/esp32-01/sensor
Status : antikobongan/prototipe-gx7q4m/esp32-01/status

[OLED] Siap.
[BME280] Siap di 0x76, chipID=0x60, ctrl_meas=0x57.
[BZ] Uji buzzer. Setelah ini buzzer hanya berbunyi saat TINGGI/KRITIS.
[NTP] Sinkronisasi waktu dimulai (UTC+7).
[WiFi] Menghubungkan ke PP...
[MQTT] Menghubungkan ke broker.hivemq.com:1883 sebagai ak-esp32-esp32-01-D7CD31E8...
[MQTT] Terhubung.
[MQTT] Status online OK; publish ke antikobongan/prototipe-gx7q4m/esp32-01/sensor
[SENSOR] BME280 tidak valid (T=nan H=nan P=nan), gagal 1/3
[SENSOR] BME280 tidak valid (T=23.33 H=0.00 P=751.14), gagal 2/3
[SENSOR] BME280 tidak valid (T=23.33 H=0.00 P=751.14), gagal 3/3
[SENSOR] Pembacaan tidak wajar berulang -> init ulang BME280.
```

Semua subsistem kecuali jalur data BME280 bekerja normal. Perangkat lunak siap pakai; yang tertinggal hanya pekerjaan mekanis.

---

## 11. Catatan perubahan repositori

Perubahan **belum di-commit**. Berkas yang saya ubah/tambahkan pada sesi ini:

- Ditulis ulang: `antikobongan-2.ino` (untracked)
- Diubah: `README.md`, `antikobongan_panduan_rakit.html`, `docs/DEPLOY.md`, `docs/panduan-sistem.html`, `backend/main.py`, `public/js/risk.js`, `public/js/ui/io.js`
- Dihapus: 7 berkas `.md` di root (cadangan: `%TEMP%\opencode\backup-md-root.zip`)

Perubahan lain yang terlihat di `git status` berasal dari pekerjaan sebelumnya, bukan dari sesi ini.
