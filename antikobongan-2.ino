/**
 * AntiKobongan ESP32 DevKit V1 di expansion board 30-pin
 * Alur: sensor -> ESP32 (skor, LED, buzzer, OLED) -> WiFi -> MQTT -> pencatat + dasbor
 * Prototipe demonstrasi, bukan alat deteksi kebakaran tersertifikasi.
 *
 * Hardware (baris = baris GPIO di expansion board, S/V/G):
 *   BME280   header I2C: VCC, GND, SDA D21, SCL D22 (alamat 0x76 atau 0x77)
 *   OLED     SSD1306 128x64, VCC=V D21, GND=G D21, SDA=S D21, SCL=S D22 (0x3C)
 *   MQ-2     VCC=5V & GND dari deret 8 pin; AO -> 1k -> D34, D34 -> 2x1k -> GND
 *   Tanah    modul: VCC=V, GND=G, AO=S baris D35
 *   Baterai  B+ modul 134N3P -> 10k -> D32 -> 10k -> GND (pembagi dua)
 *   LED      merah D25, hijau D26, kuning D33 (tiap LED 1k di kaki +; kaki - ke G)
 *   Buzzer   modul 3 pin: S=S, tengah=V, -=G baris D27
 *
 * Arti lampu:  hijau = NORMAL · kuning = SEDANG (siaga) · merah = TINGGI
 *              merah berkedip + buzzer cepat = KRITIS
 * Alat tetap membaca sensor dan menyalakan LED/OLED/buzzer walau WiFi putus.
 *
 * Prinsip data: nilai yang tidak masuk akal TIDAK dikirim dan TIDAK dipakai
 * menghitung skor. Lebih baik dasbor kosong (data basi) daripada alarm palsu.
 *
 * Library (Library Manager): PubSubClient, ArduinoJson, Adafruit BME280,
 *   Adafruit Unified Sensor, Adafruit SSD1306, Adafruit GFX.
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>
#include <time.h>

// ── WiFi hotspot PP ─────────────────────────────────────────────────────────
const char* WIFI_SSID     = "PP";
const char* WIFI_PASSWORD = "qwertyuiop";   // isi password hotspot Anda

// ── MQTT ────────────────────────────────────────────────────────────────────
const char* MQTT_HOST    = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;
const char* TOPIC_PREFIX = "antikobongan/prototipe-gx7q4m"; // sama dengan backend & dasbor
const char* NODE_ID      = "esp32-01";

// ── Waktu & interval ────────────────────────────────────────────────────────
// Baca sensor + kirim tiap 3 detik (mode uji realtime). Untuk produksi 45000
// dan setel STALE_SECONDS=180 di backend/.env.
const unsigned long SENSOR_INTERVAL_MS = 3000;
const unsigned long OLED_INTERVAL_MS   = 1000;
const long GMT_OFFSET_SEC = 7 * 3600; // WIB
const int  DAYLIGHT_OFFSET_SEC = 0;
const char* NTP_SERVER_1 = "pool.ntp.org";
const char* NTP_SERVER_2 = "time.nist.gov";

// ── Pin ─────────────────────────────────────────────────────────────────────
const uint8_t PIN_MQ2        = 34; // ADC1, input-only
const uint8_t PIN_SOIL       = 35; // ADC1, input-only
const uint8_t PIN_BAT        = 32; // ADC1, titik tengah pembagi baterai
const uint8_t PIN_LED_RED    = 25;
const uint8_t PIN_LED_GREEN  = 26;
const uint8_t PIN_LED_YELLOW = 33;
const uint8_t PIN_BUZZER     = 27;
const uint8_t I2C_SDA = 21;
const uint8_t I2C_SCL = 22;
const uint32_t I2C_CLOCK_HZ = 50000; // kabel BME280 ~30 cm: 50 kHz jauh lebih tahan

// ── Buzzer ──────────────────────────────────────────────────────────────────
// Uji buzzer: S ke 3,3V sebentar. Bunyi "biiip" = aktif (false). Hanya "tik" = pasif (true).
const bool BUZZER_PASSIVE    = false;
const unsigned int BUZZER_FREQ = 2700;   // nada untuk buzzer pasif (Hz)
const bool BUZZER_ACTIVE_LOW = false;    // true bila buzzer aktif berbunyi saat S = LOW
const bool BUZZER_ALARM      = true;     // bunyi saat TINGGI dan KRITIS
const bool BUZZER_HEARTBEAT  = false;    // true = bunyi pendek tiap data terkirim (perilaku lama)

// ── OLED & baterai ──────────────────────────────────────────────────────────
const uint8_t OLED_ADDR   = 0x3C;  // ganti 0x3D bila I2C scanner menunjukkan itu
const uint8_t OLED_ROTATE = 0;     // 2 = putar 180° bila tulisan terbalik
const float BAT_DIVIDER = 2.0f;    // 10k/10k. Setel (mis. 2.05) sampai sama dengan multimeter
const float BAT_V_EMPTY = 3.3f;    // 0 %
const float BAT_V_FULL  = 4.2f;    // 100 %

// ── Kalibrasi tanah (ADC 12-bit) ────────────────────────────────────────────
const int SOIL_RAW_DRY = 3200;
const int SOIL_RAW_WET = 1200;
// Di luar jendela ini pin dianggap lepas/terhubung ke rel, bukan membaca tanah.
const int SOIL_RAW_MIN = 20;
const int SOIL_RAW_MAX = 4080;

// ── Filter gas MQ-2 ─────────────────────────────────────────────────────────
const uint8_t GAS_FILTER_N  = 5;
const float   GAS_BASE_UP   = 0.005f; // baseline naik lambat
const float   GAS_BASE_DOWN = 0.10f;  // baseline turun cepat
const int     GAS_SPAN      = 400;    // selisih 400 ADC = 25 poin
// MQ-2 terpasang selalu memberi nilai positif; 0/4095 berarti AO lepas atau modul mati.
const int     GAS_RAW_MIN   = 5;
const int     GAS_RAW_MAX   = 4080;

// ── Batas kewajaran BME280 ──────────────────────────────────────────────────
// Kelembapan 0 % berarti bagian kelembapan tidak terbaca (sensor rusak / kena 5 V /
// kabel SDA-SCL bermasalah), bukan udara kering. Jangan dipakai menghitung skor.
const float BME_TEMP_MIN = -20.0f, BME_TEMP_MAX = 80.0f;
const float BME_HUM_MIN  = 0.5f,   BME_HUM_MAX  = 100.0f;
const float BME_PRESS_MIN = 300.0f, BME_PRESS_MAX = 1100.0f;
const uint8_t BME_FAIL_LIMIT = 3;   // 3 kali gagal berturut-turut -> init ulang

// ── Rumus risiko (total 100) ────────────────────────────────────────────────
// suhu 35 + kelembapan udara 25 + gas 25 + kelembapan tanah 15
const float TEMP_REF  = 25.0f, TEMP_STEP = 2.5f, TEMP_MAX = 35.0f;
const float HUM_REF   = 85.0f, HUM_STEP  = 0.5f, HUM_MAX  = 25.0f;
const float GAS_MAX   = 25.0f;
const float SOIL_REF  = 50.0f, SOIL_STEP = 0.3f, SOIL_MAX = 15.0f;

// ── Ambang kelas peringatan ─────────────────────────────────────────────────
const int RISK_MEDIUM   = 40; // Siaga (LED kuning)
const int RISK_HIGH     = 60; // Waspada Bara dan Asap (LED merah)
const int RISK_CRITICAL = 80; // Kebakaran Aktif (merah berkedip + buzzer)

// ── Objek & state ───────────────────────────────────────────────────────────
Adafruit_BME280 bme;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

String sensorTopic;
String statusTopic;
bool bmeReady = false;
bool oledReady = false;
uint8_t bmeAddress = 0;
uint8_t bmeFailCount = 0;
unsigned long lastBmeInitMs = 0;
unsigned long lastSensorMs = 0;
unsigned long lastOledMs = 0;
unsigned long lastWifiAttemptMs = 0;
unsigned long lastMqttAttemptMs = 0;
unsigned long mqttBackoffMs = 2000;

// indikator
uint8_t alertLevel = 0;              // 0 NORMAL, 1 SEDANG, 2 TINGGI, 3 KRITIS
bool buzzerOn = false;
unsigned long beepUntilMs = 0;  // bunyi sekali (boot / heartbeat)

// hasil baca terakhir
bool  haveData = false;
bool  sensorError = false;   // BME280 gagal / nilai tidak wajar
bool  gasOk = false;
bool  soilOk = false;
bool  pressureOk = false;
float lastSuhu = 0, lastHum = 0, lastSoil = 0, lastPress = 0;
int   lastGasExcess = 0, lastRisk = 0;
float batVolt = 0;
bool  batPresent = false;
int   lastGoodGas = 0;
bool  haveGoodGas = false;

int     gasHist[GAS_FILTER_N];
uint8_t gasHistCount = 0;
uint8_t gasHistIdx   = 0;
float   gasBaseline  = -1.0f;

// Hasil satu pembacaan BME280 beserta status kewajarannya.
struct BmeReading {
  bool ok;          // suhu + kelembapan wajar
  bool pressureOk;  // tekanan wajar
  float temp, hum, press;
};

// ── Util I2C ────────────────────────────────────────────────────────────────
bool i2cPresent(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

bool i2cReadReg(uint8_t addr, uint8_t reg, uint8_t &out) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)addr, 1) != 1) return false;
  out = Wire.read();
  return true;
}

bool i2cWriteReg(uint8_t addr, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

// ── Util matematika ─────────────────────────────────────────────────────────
int medianGasHistory() {
  int tmp[GAS_FILTER_N];
  uint8_t n = gasHistCount;
  for (uint8_t i = 0; i < n; i++) tmp[i] = gasHist[i];
  for (uint8_t i = 1; i < n; i++) {
    int key = tmp[i], j = i - 1;
    while (j >= 0 && tmp[j] > key) { tmp[j + 1] = tmp[j]; j--; }
    tmp[j + 1] = key;
  }
  return (n % 2) ? tmp[n / 2] : (tmp[n / 2 - 1] + tmp[n / 2]) / 2;
}

int readAdcAvg(uint8_t pin, uint8_t samples = 8) {
  uint32_t total = 0;
  for (uint8_t i = 0; i < samples; i++) {
    total += analogRead(pin);
    delay(2);
  }
  return (int)(total / samples);
}

int readGasFiltered() {
  gasHist[gasHistIdx] = readAdcAvg(PIN_MQ2, 4);
  gasHistIdx = (gasHistIdx + 1) % GAS_FILTER_N;
  if (gasHistCount < GAS_FILTER_N) gasHistCount++;
  return medianGasHistory();
}

int updateGasBaseline(int gasFiltered) {
  if (gasBaseline < 0) gasBaseline = (float)gasFiltered;
  else if (gasFiltered < gasBaseline) gasBaseline += GAS_BASE_DOWN * (gasFiltered - gasBaseline);
  else gasBaseline += GAS_BASE_UP * (gasFiltered - gasBaseline);
  int excess = gasFiltered - (int)(gasBaseline + 0.5f);
  return excess > 0 ? excess : 0;
}

// Komponen yang tidak valid tidak menyumbang poin sama sekali.
int calcRiskScore(float suhu, bool suhuOk, float kelembapan, bool humOk,
                  float gasExcess, bool gasValid, float soilPercent, bool soilValid) {
  float score = 0;
  if (suhuOk) score += constrain((suhu - TEMP_REF) * TEMP_STEP, 0.0f, TEMP_MAX);
  if (humOk)  score += constrain((HUM_REF - kelembapan) * HUM_STEP, 0.0f, HUM_MAX);
  if (gasValid) score += constrain(gasExcess * GAS_MAX / GAS_SPAN, 0.0f, GAS_MAX);
  if (soilValid) score += constrain((SOIL_REF - soilPercent) * SOIL_STEP, 0.0f, SOIL_MAX);
  return (int)(constrain(score, 0.0f, 100.0f) + 0.5f);
}

uint8_t riskIndex(int score) {
  if (score >= RISK_CRITICAL) return 3;
  if (score >= RISK_HIGH) return 2;
  if (score >= RISK_MEDIUM) return 1;
  return 0;
}

const char* riskLevel(int score) {
  static const char* NAMES[] = {"NORMAL", "SEDANG", "TINGGI", "KRITIS"};
  return NAMES[riskIndex(score)];
}

bool timeIsSynced() {
  return time(nullptr) > 1700000000L;
}

String isoTimestamp() {
  if (!timeIsSynced()) return "";
  time_t localEpoch = time(nullptr) + GMT_OFFSET_SEC;
  struct tm localTm;
  gmtime_r(&localEpoch, &localTm);
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &localTm);
  return String(buf) + "+07:00";
}

// ── BME280 ──────────────────────────────────────────────────────────────────
// Deteksi ketat: alamat harus menjawab, chipID harus 0x60, mode normal harus aktif.
// Banyak modul murah terpasang longgar di kabel 30 cm, jadi init diulang sampai 2x.
bool initBme() {
  for (uint8_t attempt = 0; attempt < 2; attempt++) {
    for (uint8_t addr = 0x76; addr <= 0x77; addr++) {
      if (!i2cPresent(addr)) continue;

      uint8_t chipId = 0;
      if (!i2cReadReg(addr, 0xD0, chipId)) {
        Serial.printf("[BME280] 0x%02X tidak menjawab saat baca chipID.\n", addr);
        continue;
      }
      if (chipId != 0x60) {
        Serial.printf("[BME280] 0x%02X chipID=0x%02X (bukan 0x60) - dilewati.\n", addr, chipId);
        continue;
      }

      i2cWriteReg(addr, 0xE0, 0xB6); // soft reset
      delay(20);
      unsigned long t0 = millis();
      uint8_t status = 0;
      do {
        if (!i2cReadReg(addr, 0xF3, status)) break;
        if (!(status & 0x01)) break; // im_update selesai
        delay(5);
      } while (millis() - t0 < 200);

      if (!bme.begin(addr, &Wire)) {
        Serial.printf("[BME280] begin(0x%02X) gagal meski chipID 0x60.\n", addr);
        continue;
      }

      bme.setSampling(Adafruit_BME280::MODE_NORMAL,
                      Adafruit_BME280::SAMPLING_X2,    // suhu
                      Adafruit_BME280::SAMPLING_X16,   // tekanan
                      Adafruit_BME280::SAMPLING_X1,    // kelembapan
                      Adafruit_BME280::FILTER_X16,
                      Adafruit_BME280::STANDBY_MS_500);

      uint8_t ctrl = 0;
      if (!i2cReadReg(addr, 0xF4, ctrl) || (ctrl & 0x03) != 0x03) {
        Serial.printf("[BME280] 0x%02X mode normal tidak aktif (ctrl_meas=0x%02X).\n", addr, ctrl);
        continue;
      }

      bmeAddress = addr;
      bmeFailCount = 0;
      Serial.printf("[BME280] Siap di 0x%02X, chipID=0x60, ctrl_meas=0x%02X.\n", addr, ctrl);
      return true;
    }
    delay(50);
  }
  Serial.println("[BME280] Tidak ditemukan. Cek VCC=3,3V, GND, SDA=21, SCL=22.");
  return false;
}

BmeReading readBme() {
  BmeReading r = {false, false, NAN, NAN, NAN};
  if (!bmeReady) return r;

  // Kontak kabel 30 cm sering goyah: satu pembacaan bisa berisi 0xFF/0x00.
  // Coba tiga kali sebelum menyatakan sensor benar-benar gagal.
  for (uint8_t attempt = 0; attempt < 3; attempt++) {
    if (!i2cPresent(bmeAddress)) break; // chip lepas dari bus -> minta init ulang

    r.temp = bme.readTemperature();
    r.hum = bme.readHumidity();
    r.press = bme.readPressure() / 100.0f;

    bool tempOk = !isnan(r.temp) && r.temp >= BME_TEMP_MIN && r.temp <= BME_TEMP_MAX;
    bool humOk = !isnan(r.hum) && r.hum >= BME_HUM_MIN && r.hum <= BME_HUM_MAX;
    bool pressOk = !isnan(r.press) && r.press >= BME_PRESS_MIN && r.press <= BME_PRESS_MAX;

    if (tempOk && humOk) {
      r.ok = true;
      r.pressureOk = pressOk;
      return r;
    }
    delay(30);
  }
  return r;
}

// ── Buzzer & LED ────────────────────────────────────────────────────────────
void buzzerWrite(bool on) {
  if (BUZZER_PASSIVE) {
    if (on) tone(PIN_BUZZER, BUZZER_FREQ);
    else noTone(PIN_BUZZER);
  } else {
    digitalWrite(PIN_BUZZER, (BUZZER_ACTIVE_LOW ? !on : on) ? HIGH : LOW);
  }
}

void beepOnce(unsigned long ms) {
  beepUntilMs = millis() + ms;
}

void setLeds(bool g, bool y, bool r) {
  digitalWrite(PIN_LED_GREEN, g ? HIGH : LOW);
  digitalWrite(PIN_LED_YELLOW, y ? HIGH : LOW);
  digitalWrite(PIN_LED_RED, r ? HIGH : LOW);
}

// Dipanggil terus di loop: LED dan pola bunyi mengikuti alertLevel, tanpa delay.
void maintainIndicators() {
  unsigned long now = millis();
  bool blink = (now % 600) < 300;

  if (!haveData) setLeds(false, false, false);
  else if (alertLevel == 0) setLeds(true, false, false);
  else if (alertLevel == 1) setLeds(false, true, false);
  else if (alertLevel == 2) setLeds(false, false, true);
  else setLeds(false, false, blink);

  bool on = (long)(beepUntilMs - now) > 0;
  if (!on && BUZZER_ALARM && haveData) {
    if (alertLevel == 3) on = (now % 600) < 250;        // KRITIS: bip-bip cepat
    else if (alertLevel == 2) on = (now % 3000) < 120;  // TINGGI: bip pendek tiap 3 detik
  }
  if (on != buzzerOn) { buzzerOn = on; buzzerWrite(on); }
}

void setupPins() {
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_YELLOW, OUTPUT);
  buzzerWrite(false);
  setLeds(false, false, false);
}

void selfTestLeds() { // hijau -> kuning -> merah saat menyala, untuk cek kabel
  setLeds(true, false, false);  delay(250);
  setLeds(false, true, false);  delay(250);
  setLeds(false, false, true);  delay(250);
  setLeds(false, false, false);
}

// ── Baterai & OLED ──────────────────────────────────────────────────────────
// Pembagi baterai yang belum dipasang membuat D32 melayang: tegangannya acak.
// Karena itu selain rata-rata, sebaran 16 bacaan juga diperiksa.
void readBattery() {
  uint32_t total = 0;
  uint16_t vmin = 65535, vmax = 0;
  for (uint8_t i = 0; i < 16; i++) {
    uint16_t mv = analogReadMilliVolts(PIN_BAT);
    total += mv;
    if (mv < vmin) vmin = mv;
    if (mv > vmax) vmax = mv;
    delay(2);
  }
  float avgMv = total / 16.0f;
  float raw = avgMv * BAT_DIVIDER / 1000.0f;
  bool stable = (vmax - vmin) < 200; // < 200 mV = pin benar-benar tersambung
  if (raw < 2.5f || !stable) {
    batPresent = false;
    return;
  }
  batVolt = (batVolt < 0.5f) ? raw : batVolt * 0.8f + raw * 0.2f; // haluskan
  batPresent = true;
}

int batteryPercent(float v) {
  return (int)constrain((v - BAT_V_EMPTY) * 100.0f / (BAT_V_FULL - BAT_V_EMPTY), 0.0f, 100.0f);
}

void drawBatteryIcon(int16_t x, int16_t y, int percent) {
  oled.drawRect(x, y, 22, 10, SSD1306_WHITE);
  oled.fillRect(x + 22, y + 3, 2, 4, SSD1306_WHITE);
  int w = map(percent, 0, 100, 0, 18);
  if (w > 0) oled.fillRect(x + 2, y + 2, w, 6, SSD1306_WHITE);
}

void drawOled() {
  if (!oledReady) return;
  readBattery();
  int pct = batteryPercent(batVolt);

  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);

  oled.setCursor(0, 1);
  oled.print("AntiKobongan");
  if (batPresent) {
    drawBatteryIcon(78, 0, pct);
    oled.setCursor(104, 1);
    oled.printf("%d%%", pct);
  } else {
    oled.setCursor(92, 1);
    oled.print("BAT --");
  }
  oled.drawFastHLine(0, 12, 128, SSD1306_WHITE);

  if (sensorError || !haveData) {
    oled.setCursor(0, 22); oled.print("BME280 TIDAK TERBACA");
    oled.setCursor(0, 34); oled.print("Cek VCC 3,3V / SDA-SCL");
    oled.setCursor(0, 46); oled.print("Data tidak dikirim");
  } else {
    oled.setCursor(0, 16);  oled.printf("Suhu  %.1f C", lastSuhu);
    oled.setCursor(0, 26);  oled.printf("Udara %.0f %%", lastHum);
    oled.setCursor(0, 36);  oled.printf("Tanah %.0f %%", lastSoil);
    oled.setCursor(80, 16); oled.printf("Gas +%d", lastGasExcess);
    oled.setCursor(80, 26); oled.printf("Skor %d", lastRisk);
    if (batPresent) { oled.setCursor(80, 36); oled.printf("%.2fV", batVolt); }
    if (alertLevel < 3 || (millis() / 400) % 2) {   // tulisan KRITIS berkedip
      oled.setTextSize(2);
      oled.setCursor(0, 48);
      oled.print(riskLevel(lastRisk));
      oled.setTextSize(1);
    }
  }

  oled.setCursor(80, 48);
  oled.print(mqttClient.connected() ? "ONLINE" : (WiFi.status() == WL_CONNECTED ? "WIFI OK" : "OFFLINE"));
  if (batPresent && pct <= 15 && (millis() / 500) % 2) {
    oled.setCursor(80, 57);
    oled.print("ISI DAYA");
  }
  oled.display();
}

// ── WiFi & MQTT non-blocking ────────────────────────────────────────────────
void startWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[WiFi] Menghubungkan ke %s...\n", WIFI_SSID);
}

void maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  unsigned long now = millis();
  if (now - lastWifiAttemptMs < 5000) return;
  lastWifiAttemptMs = now;
  Serial.printf("[WiFi] Belum terhubung (status=%d), mencoba ulang...\n", WiFi.status());
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void maintainMQTT() {
  if (WiFi.status() != WL_CONNECTED || mqttClient.connected()) return;
  unsigned long now = millis();
  if (now - lastMqttAttemptMs < mqttBackoffMs) return;
  lastMqttAttemptMs = now;

  char clientId[48];
  uint32_t chipId = (uint32_t)(ESP.getEfuseMac() & 0xFFFFFFFFULL);
  snprintf(clientId, sizeof(clientId), "ak-esp32-%s-%08X", NODE_ID, chipId);

  Serial.printf("[MQTT] Menghubungkan ke %s:%u sebagai %s...\n", MQTT_HOST, MQTT_PORT, clientId);
  // LWT retained: broker mengumumkan offline bila ESP putus mendadak.
  if (mqttClient.connect(clientId, nullptr, nullptr, statusTopic.c_str(), 1, true, "offline")) {
    bool statusOk = mqttClient.publish(statusTopic.c_str(), "online", true);
    Serial.println("[MQTT] Terhubung.");
    Serial.printf("[MQTT] Status online %s; publish ke %s\n", statusOk ? "OK" : "GAGAL", sensorTopic.c_str());
    mqttBackoffMs = 2000;
  } else {
    Serial.printf("[MQTT] Gagal, rc=%d. Backoff %lu ms.\n", mqttClient.state(), mqttBackoffMs);
    mqttBackoffMs = min(mqttBackoffMs * 2, 30000UL);
  }
}

// ── Baca sensor (selalu) lalu kirim (bila valid & MQTT tersambung) ──────────
void readAndPublish() {
  if (!bmeReady) {
    unsigned long nowMs = millis();
    if (nowMs - lastBmeInitMs >= 30000UL) {
      lastBmeInitMs = nowMs;
      bmeReady = initBme();
      if (!bmeReady) {
        sensorError = true;
        Serial.println("[SENSOR] BME280 belum siap, coba lagi 30 detik lagi.");
        return;
      }
    } else {
      if (!sensorError) Serial.println("[SENSOR] BME280 tidak siap.");
      sensorError = true;
      return;
    }
  }

  BmeReading bm = readBme();
  if (!bm.ok) {
    sensorError = true;
    haveData = false;
    bmeFailCount++;
    Serial.printf("[SENSOR] BME280 tidak valid (T=%.2f H=%.2f P=%.2f), gagal %u/%u\n",
                  bm.temp, bm.hum, bm.press, bmeFailCount, BME_FAIL_LIMIT);
    if (bmeFailCount >= BME_FAIL_LIMIT) {
      Serial.println("[SENSOR] Pembacaan tidak wajar berulang -> init ulang BME280.");
      bmeReady = false;
      bmeFailCount = 0;
      lastBmeInitMs = millis();
    }
    return;
  }
  sensorError = false;
  bmeFailCount = 0;
  pressureOk = bm.pressureOk;

  int gasFiltered = readGasFiltered();
  gasOk = gasFiltered >= GAS_RAW_MIN && gasFiltered <= GAS_RAW_MAX;
  int gasExcess = 0;
  if (gasOk) {
    gasExcess = updateGasBaseline(gasFiltered);
    lastGoodGas = gasFiltered;
    haveGoodGas = true;
  } else {
    Serial.printf("[SENSOR] MQ-2 tidak wajar (raw=%d) - gas diabaikan.\n", gasFiltered);
  }

  int soilRaw = readAdcAvg(PIN_SOIL, 8);
  soilOk = soilRaw >= SOIL_RAW_MIN && soilRaw <= SOIL_RAW_MAX;
  float soilPercent = 0;
  if (soilOk) {
    soilPercent = (float)(SOIL_RAW_DRY - soilRaw) * 100.0f / (float)(SOIL_RAW_DRY - SOIL_RAW_WET);
    soilPercent = constrain(soilPercent, 0.0f, 100.0f);
  } else {
    Serial.printf("[SENSOR] Sensor tanah tidak wajar (raw=%d) - tanah diabaikan.\n", soilRaw);
  }

  int riskScore = calcRiskScore(bm.temp, true, bm.hum, true, (float)gasExcess, gasOk, soilPercent, soilOk);
  alertLevel = riskIndex(riskScore);
  lastSuhu = bm.temp; lastHum = bm.hum; lastPress = bm.press; lastSoil = soilPercent;
  lastGasExcess = gasExcess; lastRisk = riskScore; haveData = true;

  if (!mqttClient.connected()) {
    Serial.printf("[LOKAL] suhu %.1f | udara %.0f%% | gas +%d | tanah %.0f%% | skor %d %s (MQTT belum terhubung)\n",
                  bm.temp, bm.hum, gasExcess, soilPercent, riskScore, riskLevel(riskScore));
    return;
  }

  JsonDocument doc;
  doc["suhu"] = round(bm.temp * 10) / 10.0;
  doc["kelembapan"] = round(bm.hum * 10) / 10.0;
  doc["gas"] = gasOk ? gasFiltered : (haveGoodGas ? lastGoodGas : 0);
  if (gasOk) doc["gas_excess"] = gasExcess;
  if (soilOk) doc["kelembapan_tanah"] = (int)round(soilPercent);
  doc["riskScore"] = riskScore;
  doc["status"] = riskLevel(riskScore);
  if (bm.pressureOk) doc["tekanan"] = round(bm.press * 100) / 100.0;
  // Penanda kualitas per sensor; backend mengabaikan field tambahan ini,
  // tetapi berguna saat menelusuri masalah lewat MQTT Explorer.
  doc["bme_ok"] = true;
  doc["gas_ok"] = gasOk;
  doc["tanah_ok"] = soilOk;

  String timestamp = isoTimestamp();
  if (timestamp.length() > 0) doc["timestamp"] = timestamp;

  char payload[384];
  size_t length = serializeJson(doc, payload, sizeof(payload));
  if (length == 0) { Serial.println("[JSON] Gagal membuat payload."); return; }

  bool ok = mqttClient.publish(sensorTopic.c_str(), payload, false);
  Serial.printf("[PUB] %s | %s\n", ok ? "OK" : "GAGAL", payload);
  if (ok && BUZZER_HEARTBEAT) beepOnce(80);
}

// ── Setup & loop ────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== AntiKobongan ESP32 Node ===");
  sensorTopic = String(TOPIC_PREFIX) + "/" + NODE_ID + "/sensor";
  statusTopic = String(TOPIC_PREFIX) + "/" + NODE_ID + "/status";
  Serial.printf("Node   : %s\nPrefix : %s\nTopic  : %s\nStatus : %s\n\n",
                NODE_ID, TOPIC_PREFIX, sensorTopic.c_str(), statusTopic.c_str());

  setupPins();
  selfTestLeds();

  Wire.begin(I2C_SDA, I2C_SCL, I2C_CLOCK_HZ);
  Wire.setClock(I2C_CLOCK_HZ);
  oledReady = oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  if (oledReady) {
    oled.setRotation(OLED_ROTATE);
    Serial.println("[OLED] Siap.");
  } else {
    Serial.println("[OLED] Tidak ditemukan. Cek kabel dan alamat (0x3C/0x3D).");
  }
  bmeReady = initBme();
  if (!bmeReady) sensorError = true;

  analogReadResolution(12);
  analogSetPinAttenuation(PIN_MQ2, ADC_11db);
  analogSetPinAttenuation(PIN_SOIL, ADC_11db);
  analogSetPinAttenuation(PIN_BAT, ADC_11db);

  beepOnce(300); // uji buzzer sekali saat menyala
  Serial.println("[BZ] Uji buzzer. Setelah ini buzzer hanya berbunyi saat TINGGI/KRITIS.");

  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER_1, NTP_SERVER_2);
  Serial.println("[NTP] Sinkronisasi waktu dimulai (UTC+7).");

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setKeepAlive(60);
  mqttClient.setBufferSize(512);
  startWiFi();
  drawOled();
}

void loop() {
  maintainWiFi();
  maintainMQTT();
  mqttClient.loop();
  maintainIndicators();

  unsigned long now = millis();
  if (now - lastSensorMs >= SENSOR_INTERVAL_MS) {
    lastSensorMs = now;
    readAndPublish();
  }
  if (now - lastOledMs >= OLED_INTERVAL_MS) {
    lastOledMs = now;
    drawOled();
  }
}
