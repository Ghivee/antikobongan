/**
 * ============================================================
 *  AntiKobongan ESP32 DevKit V1 — Firmware Sensor MQTT
 *  Alur: ESP32 -> WiFi -> broker MQTT -> pencatat (Supabase) + dashboard
 *  Broker diatur di secrets.h (default: broker publik HiveMQ tanpa login).
 * ============================================================
 *
 *  Hardware yang dipakai:
 *    - DHT11 (suhu + kelembapan udara)  -> GPIO 4
 *    - MQ-2 AO (gas/asap, ADC mentah)   -> GPIO 34 (WAJIB pembagi tegangan)
 *    - MH Soil Moisture AO              -> GPIO 35
 *    - Buzzer                           -> GPIO 25
 *    - LED merah                        -> GPIO 26
 *    - LED hijau                        -> GPIO 27
 *    - BMP180 (OPSIONAL, belum ada)     -> I2C SDA 21 / SCL 22, alamat 0x77
 *
 *  Library:
 *    - PubSubClient (Nick O'Leary)
 *    - DHT sensor library (Adafruit)
 *    - ArduinoJson (Benoit Blanchon)
 *    - Adafruit BMP085 Library (hanya jika ENABLE_BMP180 = 1)
 *
 *  CATATAN PENTING:
 *    - AO MQ-2 maksimum ~5 V. Gunakan pembagi tegangan
 *      AO -> 10k -> GPIO34 -> 20k -> GND agar aman untuk ADC 3,3 V.
 *    - MQ-2 perlu preheat beberapa menit sebelum pembacaan stabil.
 *    - DHT11 maksimal sekitar 1 pembacaan per detik; interval 2 detik aman untuk pengiriman data realtime.
 *    - SOIL_RAW_DRY / SOIL_RAW_WET HARUS dikalibrasi di tanah kering dan basah.
 *    - Nilai gas dikirim sebagai ADC mentah 0..4095, bukan ppm.
 *    - Jangan simpan kredensial Wi-Fi asli di repo. Untuk Wokwi gunakan
 *      SSID "Wokwi-GUEST" dan password kosong.
 *    - Broker publik HiveMQ hanya untuk uji coba, tidak privat/terjamin.
 *    - Aturan buzzer/LED tidak ditemukan di dokumen proposal. Pemetaan yang
 *      dipakai: hijau < 60, merah >= 60, buzzer >= 80. Sesuaikan bila perlu.
 * ============================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <ArduinoJson.h>
#include <time.h>
#include "secrets.h"

// Nilai default bila secrets.h versi lama belum memuat pengaturan broker.
#ifndef SECRET_MQTT_HOST
  #define SECRET_MQTT_HOST "broker.hivemq.com"
#endif
#ifndef SECRET_MQTT_TLS
  #define SECRET_MQTT_TLS 0
#endif
#ifndef SECRET_MQTT_PORT
  #define SECRET_MQTT_PORT (SECRET_MQTT_TLS ? 8883 : 1883)
#endif
#ifndef SECRET_MQTT_USERNAME
  #define SECRET_MQTT_USERNAME ""
#endif
#ifndef SECRET_MQTT_PASSWORD
  #define SECRET_MQTT_PASSWORD ""
#endif

// ─── Pilih sensor tekanan (BMP180 belum tersedia secara fisik) ───────────────
#define ENABLE_BMP180 0

#if ENABLE_BMP180
  #include <Wire.h>
  #include <Adafruit_BMP085.h>
  Adafruit_BMP085 bmp;
#endif

// ─── Konfigurasi WiFi ────────────────────────────────────────────────────────
// Kredensial TIDAK disimpan di file ini. Isi secrets.h (lihat secrets.example.h).
// Untuk Wokwi: SSID "Wokwi-GUEST", password kosong (tidak memakai secrets.h).
// Untuk perangkat fisik: isi SECRET_WIFI_SSID / SECRET_WIFI_PASSWORD di secrets.h.
#ifdef WOKWI_SIM
const char* WIFI_SSID     = "Wokwi-GUEST";
const char* WIFI_PASSWORD = "";
#else
const char* WIFI_SSID     = SECRET_WIFI_SSID;
const char* WIFI_PASSWORD = SECRET_WIFI_PASSWORD;
#endif

// ─── Konfigurasi MQTT ────────────────────────────────────────────────────────
const char* MQTT_HOST     = SECRET_MQTT_HOST;
const uint16_t MQTT_PORT  = SECRET_MQTT_PORT;
const char* MQTT_USERNAME = SECRET_MQTT_USERNAME; // kosong = tanpa login (broker publik)
const char* MQTT_PASSWORD = SECRET_MQTT_PASSWORD;
const char* TOPIC_PREFIX  = "antikobongan/prototipe-gx7q4m"; // harus sama dengan dashboard & backend
const char* NODE_ID       = "esp32-01";
String sensorTopic;
String statusTopic;

// ─── Interval ────────────────────────────────────────────────────────────────
const unsigned long PUBLISH_INTERVAL_MS = 15000;

// ─── Pin ─────────────────────────────────────────────────────────────────────
const uint8_t DHT_PIN          = 4;
#ifdef WOKWI_SIM
const uint8_t DHT_TYPE         = DHT22; // part Wokwi yang tersedia adalah DHT22
#else
const uint8_t DHT_TYPE         = DHT11;
#endif
const uint8_t MQ2_PIN          = 34; // ADC1, input-only
const uint8_t SOIL_PIN         = 35; // ADC1, input-only
const uint8_t BUZZER_PIN       = 25;
const uint8_t LED_RED_PIN      = 26;
const uint8_t LED_GREEN_PIN    = 27;
// Polaritas modul buzzer.
//   false = modul aktif-HIGH (pin HIGH = bunyi)  -> pakai ini jika bunyi terus saat idle
//   true  = modul aktif-LOW  (pin LOW  = bunyi)
const bool    BUZZER_ACTIVE_LOW = false;

// ─── Buzzer heartbeat ────────────────────────────────────────────────────────
// Bunyi HANYA ketika data berhasil terkirim ke broker (publish == true).
// Tidak akan bunyi jika: WiFi putus, MQTT terputus, publish gagal, atau
// pembacaan sensor gagal (payload tidak dikirim).
const unsigned long BUZZER_BEEP_MS = 80; // durasi1 denyut

// ─── Kalibrasi sensor tanah (ADC 12-bit) ─────────────────────────────────────
// Ukur nilai ADC saat probe di udara/tanah kering dan saat di air/tanah basah.
const int SOIL_RAW_DRY = 3200;
const int SOIL_RAW_WET = 1200;

// ─── Kalibrasi gas MQ-2 (ADC 12-bit) ─────────────────────────────────────────
// GAS_FILTER_N : median bergerak -> buang spike dan dropout (nilai 0 mendadak).
// GAS_BASE_*   : baseline udara bersih ikut menyesuaikan (drift MQ-2).
//                naik sangat lambat, turun cepat -> asap tetap terbaca sebagai
//                selisih (excess).
// GAS_SPAN     : selisih excess berapa ADC = poin gas penuh (30).
const uint8_t GAS_FILTER_N  = 5;
const float   GAS_BASE_UP   = 0.005f;
const float   GAS_BASE_DOWN = 0.10f;
const int     GAS_SPAN      = 400;

// ─── Rentang rumus risiko (disetel untuk iklim tropis) ──────────────────────
// Total 100 poin: suhu 35, kelembapan udara 25, gas 25, kelembapan tanah 15.
//   suhu  : (suhu - 25) * 2.5, dibatasi 0..35
//   lembap: (85 - RH) * 0.5, dibatasi 0..25
//   gas   : gas_excess * 25 / 400, dibatasi 0..25
//   tanah : (50 - soil%) * 0.3, dibatasi 0..15
const float TEMP_REF  = 25.0f;
const float TEMP_STEP = 2.5f;
const float TEMP_MAX  = 35.0f;
const float HUM_REF   = 85.0f;
const float HUM_STEP  = 0.5f;
const float HUM_MAX   = 25.0f;
const float GAS_MAX   = 25.0f;
const float SOIL_REF  = 50.0f;
const float SOIL_STEP = 0.3f;
const float SOIL_MAX  = 15.0f;

// ─── Threshold risiko (mengikuti README proyek) ──────────────────────────────
const int RISK_HIGH     = 60;
const int RISK_CRITICAL = 80;

// ─── Zona waktu ──────────────────────────────────────────────────────────────
const long GMT_OFFSET_SEC = 7 * 3600; // UTC+7
const int  DAYLIGHT_OFFSET_SEC = 0;
const char* NTP_SERVER_1 = "pool.ntp.org";
const char* NTP_SERVER_2 = "time.nist.gov";

// ─── Objek ───────────────────────────────────────────────────────────────────
DHT dht(DHT_PIN, DHT_TYPE);
#if SECRET_MQTT_TLS
WiFiClientSecure wifiClient; // TLS ke broker privat (HiveMQ Cloud / EMQX)
#else
WiFiClient wifiClient;
#endif
PubSubClient mqttClient(wifiClient);

unsigned long lastPublishMs = 0;
unsigned long lastWifiAttemptMs = 0;
unsigned long lastMqttAttemptMs = 0;
unsigned long mqttBackoffMs = 2000;
bool buzzerActive = false;
unsigned long buzzerOffMs = 0;

// state filter gas
int     gasHist[GAS_FILTER_N];
uint8_t gasHistCount = 0;
uint8_t gasHistIdx   = 0;
float   gasBaseline  = -1.0f;

// ─── Util ────────────────────────────────────────────────────────────────────
int medianGasHistory() {
  int tmp[GAS_FILTER_N];
  uint8_t n = gasHistCount;
  for (uint8_t i = 0; i < n; i++) tmp[i] = gasHist[i];
  for (uint8_t i = 1; i < n; i++) {
    int k = tmp[i];
    int j = i - 1;
    while (j >= 0 && tmp[j] > k) { tmp[j + 1] = tmp[j]; j--; }
    tmp[j + 1] = k;
  }
  return (n % 2) ? tmp[n / 2] : (tmp[n / 2 - 1] + tmp[n / 2]) / 2;
}

// baca gas + median filter (membuang spike/dropout)
int readGasFiltered() {
  gasHist[gasHistIdx] = analogRead(MQ2_PIN);
  gasHistIdx = (gasHistIdx + 1) % GAS_FILTER_N;
  if (gasHistCount < GAS_FILTER_N) gasHistCount++;
  return medianGasHistory();
}

// gasExcess = nilai terfilter − baseline udara bersih (tidak pernah negatif)
int updateGasBaseline(int gasFiltered) {
  if (gasBaseline < 0) {
    gasBaseline = (float)gasFiltered;
  } else if (gasFiltered < gasBaseline) {
    gasBaseline += GAS_BASE_DOWN * (gasFiltered - gasBaseline);
  } else {
    gasBaseline += GAS_BASE_UP * (gasFiltered - gasBaseline);
  }
  int excess = gasFiltered - (int)(gasBaseline + 0.5f);
  return excess > 0 ? excess : 0;
}

// gasExcess sudah dinormalisasi terhadap baseline (0 = udara bersih)
int calcRiskScore(float suhu, float kelembapan, float gasExcess, float soilPercent) {
  float score = 0;
  score += constrain((suhu - TEMP_REF) * TEMP_STEP, 0.0f, TEMP_MAX);
  score += constrain((HUM_REF - kelembapan) * HUM_STEP, 0.0f, HUM_MAX);
  score += constrain(gasExcess * GAS_MAX / GAS_SPAN, 0.0f, GAS_MAX);
  score += constrain((SOIL_REF - soilPercent) * SOIL_STEP, 0.0f, SOIL_MAX);
  score = constrain(score, 0.0f, 100.0f);
  return (int)(score + 0.5f);
}

const char* riskLevel(int score) {
  if (score >= 80) return "KRITIS";
  if (score >= 60) return "TINGGI";
  if (score >= 40) return "SEDANG";
  return "NORMAL";
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

// ─── Buzzer (detak jantung koneksi) ──────────────────────────────────────────
void buzzerWrite(bool on) {
#ifdef WOKWI_SIM
  if (on) tone(BUZZER_PIN, 2000);
  else noTone(BUZZER_PIN);
#else
  digitalWrite(BUZZER_PIN, ((BUZZER_ACTIVE_LOW ? !on : on)) ? HIGH : LOW);
#endif
}

// Satu denyut pendek. Hanya dipanggil ketika publish BERHASIL.
void heartbeatBeep(unsigned long ms = BUZZER_BEEP_MS) {
  buzzerWrite(true);
  buzzerActive = true;
  buzzerOffMs = millis() + ms;
}

// Matikan buzzer setelah durasi tercapai (non-blocking, tanpa delay()).
void maintainBuzzer() {
  if (!buzzerActive) return;
  if ((long)(millis() - buzzerOffMs) >= 0) {
    buzzerWrite(false);
    buzzerActive = false;
  }
}

void applyIndicators(int score) {
  bool red = score >= RISK_HIGH;
  bool green = !red;
  digitalWrite(LED_GREEN_PIN, green ? HIGH : LOW);
  digitalWrite(LED_RED_PIN, red ? HIGH : LOW);
}

void setupPins() {
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_RED_PIN, OUTPUT);
  pinMode(LED_GREEN_PIN, OUTPUT);
  buzzerWrite(false); // idle: senyap
  digitalWrite(LED_RED_PIN, LOW);
  digitalWrite(LED_GREEN_PIN, LOW);
}

// ─── WiFi non-blocking ───────────────────────────────────────────────────────
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

// ─── MQTT non-blocking dengan backoff ────────────────────────────────────────
void maintainMQTT() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (mqttClient.connected()) return;
  unsigned long now = millis();
  if (now - lastMqttAttemptMs < mqttBackoffMs) return;
  lastMqttAttemptMs = now;

  char clientId[48];
  uint32_t chipId = (uint32_t)(ESP.getEfuseMac() & 0xFFFFFFFFULL);
  snprintf(clientId, sizeof(clientId), "ak-esp32-%s-%08X", NODE_ID, chipId);

  Serial.printf("[MQTT] Mencoba terhubung ke %s:%u sebagai %s...\n", MQTT_HOST, MQTT_PORT, clientId);
  // LWT retained: broker mengumumkan "offline" jika koneksi ESP putus mendadak.
  const char* user = MQTT_USERNAME[0] ? MQTT_USERNAME : nullptr;
  const char* pass = MQTT_USERNAME[0] ? MQTT_PASSWORD : nullptr;
  if (mqttClient.connect(clientId, user, pass, statusTopic.c_str(), 1, true, "offline")) {
    bool statusOk = mqttClient.publish(statusTopic.c_str(), "online", true);
    Serial.println("[MQTT] Terhubung.");
    Serial.printf("[MQTT] Status online %s; publish sensor ke: %s\n",
                  statusOk ? "OK" : "GAGAL", sensorTopic.c_str());
    mqttBackoffMs = 2000;
  } else {
    Serial.printf("[MQTT] Gagal, rc=%d. Backoff %lu ms.\n", mqttClient.state(), mqttBackoffMs);
    mqttBackoffMs = min(mqttBackoffMs * 2, 30000UL);
  }
}

// ─── Publish sensor ──────────────────────────────────────────────────────────
void publishSensor() {
  float suhu = dht.readTemperature();
  float kelembapan = dht.readHumidity();

  // DHT11 gagal: jangan kirim suhu/kelembapan palsu atau nilai lama.
  if (isnan(suhu) || isnan(kelembapan)) {
    Serial.println("[SENSOR] DHT11 gagal dibaca; payload tidak dikirim.");
    return;
  }

  int gasFiltered = readGasFiltered();     // median filter, buang spike/dropout
  int gasExcess   = updateGasBaseline(gasFiltered); // selisih vs baseline bersih
  int soilRaw = analogRead(SOIL_PIN);
  float soilPercent = (float)(SOIL_RAW_DRY - soilRaw) * 100.0f /
                      (float)(SOIL_RAW_DRY - SOIL_RAW_WET);
  soilPercent = constrain(soilPercent, 0.0f, 100.0f);

  int riskScore = calcRiskScore(suhu, kelembapan, (float)gasExcess, soilPercent);
  applyIndicators(riskScore);

  StaticJsonDocument<384> doc;
  doc["suhu"] = round(suhu * 10) / 10.0;
  doc["kelembapan"] = round(kelembapan * 10) / 10.0;
  doc["gas"] = gasFiltered;                 // nilai stabil hasil filter
  doc["gas_excess"] = gasExcess;            // selisih vs baseline (untuk debug)
  doc["kelembapan_tanah"] = (int)round(soilPercent);
  doc["riskScore"] = riskScore;
  doc["status"] = riskLevel(riskScore);

  // tekanan hanya dikirim jika BMP180 aktif DAN pembacaan valid
  bool pressureValid = false;
  float pressureHpa = 0;
#if ENABLE_BMP180
  pressureHpa = bmp.readPressure() / 100.0f;
  pressureValid = pressureHpa > 300.0f && pressureHpa < 1100.0f;
  if (pressureValid) doc["tekanan"] = round(pressureHpa * 10) / 10.0;
#endif

  // timestamp hanya jika NTP sinkron; jangan mengarang waktu
  String timestamp = isoTimestamp();
  if (timestamp.length() > 0) doc["timestamp"] = timestamp;

  char payload[384];
  size_t length = serializeJson(doc, payload, sizeof(payload));
  if (length == 0) {
    Serial.println("[JSON] Gagal membuat payload.");
    return;
  }

  bool ok = mqttClient.publish(sensorTopic.c_str(), payload, false); // QoS 0, retain=false
  Serial.printf("[PUB] %s | %s | %s\n", sensorTopic.c_str(), payload, ok ? "OK" : "GAGAL");

  // Detak jantung: berbunyi HANYA jika data benar-benar terkirim ke broker.
  if (ok) heartbeatBeep();

  if (!pressureValid) {
    static bool warnedPressure = false;
    if (!warnedPressure) {
      Serial.println("[SENSOR] tekanan tidak tersedia (BMP180 nonaktif/tidak valid).");
      warnedPressure = true;
    }
  }
}

// ─── Setup ───────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n\n=== AntiKobongan ESP32 Node ===");
  sensorTopic = String(TOPIC_PREFIX) + "/" + NODE_ID + "/sensor";
  statusTopic = String(TOPIC_PREFIX) + "/" + NODE_ID + "/status";
  Serial.printf("Node ID : %s\n", NODE_ID);
  Serial.printf("Prefix  : %s\n", TOPIC_PREFIX);
  Serial.printf("Topic   : %s\n", sensorTopic.c_str());
  Serial.printf("Status  : %s\n\n", statusTopic.c_str());

  setupPins();
  dht.begin();

  // Uji buzzer sekali di boot (pendek) untuk memastikan polaritas benar.
  heartbeatBeep(300);
  Serial.println("[BZ] Uji buzzer 1 denyut. Setelah ini bunyi = publish berhasil.");

  analogReadResolution(12);
  analogSetPinAttenuation(MQ2_PIN, ADC_11db);
  analogSetPinAttenuation(SOIL_PIN, ADC_11db);

#if ENABLE_BMP180
  Wire.begin(21, 22);
  if (!bmp.begin()) {
    Serial.println("[BMP180] Tidak ditemukan di alamat 0x77. Periksa wiring.");
  } else {
    Serial.println("[BMP180] Siap.");
  }
#else
  Serial.println("[BMP180] Dinonaktifkan (ENABLE_BMP180=0). Field tekanan tidak dikirim.");
#endif

  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER_1, NTP_SERVER_2);
  Serial.println("[NTP] Sinkronisasi waktu dimulai (UTC+7).");

#if SECRET_MQTT_TLS
  // Sertifikat tidak diverifikasi agar mudah dipasang; untuk produksi ganti
  // dengan wifiClient.setCACert(<root CA broker>).
  wifiClient.setInsecure();
#endif
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setKeepAlive(60);
  mqttClient.setBufferSize(512);
  startWiFi();
}

// ─── Loop ────────────────────────────────────────────────────────────────────
void loop() {
  maintainWiFi();
  maintainMQTT();
  mqttClient.loop();
  maintainBuzzer();

  unsigned long now = millis();
  if (now - lastPublishMs >= PUBLISH_INTERVAL_MS) {
    lastPublishMs = now;
    if (mqttClient.connected()) {
      publishSensor();
    } else {
      Serial.println("[PUB] Dilewati: MQTT belum terhubung.");
    }
  }
}
