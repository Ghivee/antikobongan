/**
 * AntiKobongan ESP32 DevKit V1
 * Alur: sensor -> ESP32 (skor, LED, buzzer) -> WiFi -> MQTT -> pencatat + dasbor
 *
 * Hardware:
 *   BME280  3V3, GND, SDA GPIO21, SCL GPIO22 (alamat 0x76 atau 0x77)
 *   MQ-2    AO -> GPIO34, wajib pembagi tegangan 10k/20k
 *   Tanah   AO -> GPIO35
 *   Buzzer  GPIO25, LED merah GPIO26, LED hijau GPIO27
 *
 * Library: PubSubClient, ArduinoJson, Adafruit BME280, Adafruit Unified Sensor.
 * Kredensial WiFi ditulis langsung di bawah; tidak memakai secrets.h.
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <ArduinoJson.h>
#include <time.h>

// ── WiFi hotspot PP ─────────────────────────────────────────────────────────
const char* WIFI_SSID     = "PP";
const char* WIFI_PASSWORD = "qwertyuiop";

// ── MQTT ────────────────────────────────────────────────────────────────────
const char* MQTT_HOST    = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;
const char* TOPIC_PREFIX = "antikobongan/prototipe-gx7q4m"; // sama dengan backend & dasbor
const char* NODE_ID      = "esp32-01";

// ── Waktu & interval ────────────────────────────────────────────────────────
// Mode uji realtime: kirim tiap 3 detik. Untuk produksi kembalikan ke 45000
// dan setel STALE_SECONDS=180 di backend/.env.
const unsigned long PUBLISH_INTERVAL_MS = 3000;
const long GMT_OFFSET_SEC = 7 * 3600; // WIB
const int  DAYLIGHT_OFFSET_SEC = 0;
const char* NTP_SERVER_1 = "pool.ntp.org";
const char* NTP_SERVER_2 = "time.nist.gov";

// ── Pin ─────────────────────────────────────────────────────────────────────
const uint8_t PIN_MQ2    = 34; // ADC1, input-only
const uint8_t PIN_SOIL   = 35; // ADC1, input-only
const uint8_t PIN_BUZZER = 25;
const uint8_t PIN_LED_RED   = 26;
const uint8_t PIN_LED_GREEN = 27;
const uint8_t I2C_SDA = 21;
const uint8_t I2C_SCL = 22;

const bool BUZZER_ACTIVE_LOW = false; // true bila modul buzzer aktif-LOW
const unsigned long BUZZER_BEEP_MS = 80;

// ── Kalibrasi tanah (ADC 12-bit) ────────────────────────────────────────────
const int SOIL_RAW_DRY = 3200;
const int SOIL_RAW_WET = 1200;

// ── Filter gas MQ-2 ─────────────────────────────────────────────────────────
const uint8_t GAS_FILTER_N  = 5;
const float   GAS_BASE_UP   = 0.005f; // baseline naik lambat
const float   GAS_BASE_DOWN = 0.10f;  // baseline turun cepat
const int     GAS_SPAN      = 400;    // selisih 400 ADC = 25 poin

// ── Rumus risiko (total 100) ────────────────────────────────────────────────
// suhu 35 + kelembapan udara 25 + gas 25 + kelembapan tanah 15
const float TEMP_REF  = 25.0f, TEMP_STEP = 2.5f, TEMP_MAX = 35.0f;
const float HUM_REF   = 85.0f, HUM_STEP  = 0.5f, HUM_MAX  = 25.0f;
const float GAS_MAX   = 25.0f;
const float SOIL_REF  = 50.0f, SOIL_STEP = 0.3f, SOIL_MAX = 15.0f;

// ── Ambang kelas peringatan ─────────────────────────────────────────────────
const int RISK_HIGH     = 60; // Waspada Bara dan Asap
const int RISK_CRITICAL = 80; // Kebakaran Aktif

// ── Objek & state ───────────────────────────────────────────────────────────
Adafruit_BME280 bme;
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

String sensorTopic;
String statusTopic;
bool bmeReady = false;
unsigned long lastBmeInitMs = 0;
unsigned long lastPublishMs = 0;
unsigned long lastWifiAttemptMs = 0;
unsigned long lastMqttAttemptMs = 0;
unsigned long mqttBackoffMs = 2000;
bool buzzerActive = false;
unsigned long buzzerOffMs = 0;

int     gasHist[GAS_FILTER_N];
uint8_t gasHistCount = 0;
uint8_t gasHistIdx   = 0;
float   gasBaseline  = -1.0f;

// ── Util ────────────────────────────────────────────────────────────────────
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

int readGasFiltered() {
  gasHist[gasHistIdx] = analogRead(PIN_MQ2);
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

int calcRiskScore(float suhu, float kelembapan, float gasExcess, float soilPercent) {
  float score = 0;
  score += constrain((suhu - TEMP_REF) * TEMP_STEP, 0.0f, TEMP_MAX);
  score += constrain((HUM_REF - kelembapan) * HUM_STEP, 0.0f, HUM_MAX);
  score += constrain(gasExcess * GAS_MAX / GAS_SPAN, 0.0f, GAS_MAX);
  score += constrain((SOIL_REF - soilPercent) * SOIL_STEP, 0.0f, SOIL_MAX);
  return (int)(constrain(score, 0.0f, 100.0f) + 0.5f);
}

const char* riskLevel(int score) {
  if (score >= RISK_CRITICAL) return "KRITIS";
  if (score >= RISK_HIGH) return "TINGGI";
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

// ── BME280 ──────────────────────────────────────────────────────────────────
bool initBme() {
  bool ok = bme.begin(0x76, &Wire) || bme.begin(0x77, &Wire);
  if (!ok) {
    Serial.println("[BME280] Tidak ditemukan di 0x76/0x77. Cek VIN=3V3, GND, SDA=21, SCL=22.");
    Serial.printf("[BME280] sensorID=0x%02X\n", bme.sensorID());
    return false;
  }
  // Mode cuaca: tekanan oversampling tinggi + filter IIR agar stabil.
  bme.setSampling(Adafruit_BME280::MODE_NORMAL,
                  Adafruit_BME280::SAMPLING_X2,    // suhu
                  Adafruit_BME280::SAMPLING_X16,   // tekanan
                  Adafruit_BME280::SAMPLING_X1,    // kelembapan
                  Adafruit_BME280::FILTER_X16,
                  Adafruit_BME280::STANDBY_MS_500);
  Serial.println("[BME280] Siap (mode cuaca).");
  return true;
}

// ── Indikator lokal ─────────────────────────────────────────────────────────
void buzzerWrite(bool on) {
  digitalWrite(PIN_BUZZER, (BUZZER_ACTIVE_LOW ? !on : on) ? HIGH : LOW);
}

void heartbeatBeep(unsigned long ms = BUZZER_BEEP_MS) {
  buzzerWrite(true);
  buzzerActive = true;
  buzzerOffMs = millis() + ms;
}

void maintainBuzzer() {
  if (buzzerActive && (long)(millis() - buzzerOffMs) >= 0) {
    buzzerWrite(false);
    buzzerActive = false;
  }
}

void applyIndicators(int score) {
  bool red = score >= RISK_HIGH;
  digitalWrite(PIN_LED_GREEN, red ? LOW : HIGH);
  digitalWrite(PIN_LED_RED, red ? HIGH : LOW);
}

void setupPins() {
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  buzzerWrite(false);
  digitalWrite(PIN_LED_RED, LOW);
  digitalWrite(PIN_LED_GREEN, LOW);
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

// ── Publish sensor ──────────────────────────────────────────────────────────
void publishSensor() {
  if (!bmeReady) {
    unsigned long nowMs = millis();
    if (nowMs - lastBmeInitMs >= 30000UL) { lastBmeInitMs = nowMs; bmeReady = initBme(); }
    if (!bmeReady) { Serial.println("[SENSOR] BME280 tidak siap; payload tidak dikirim."); return; }
  }

  float suhu = bme.readTemperature();
  float kelembapan = bme.readHumidity();
  float pressureHpa = bme.readPressure() / 100.0f;
  if (isnan(suhu) || isnan(kelembapan) || suhu < -40 || suhu > 85 || kelembapan < 0 || kelembapan > 100) {
    Serial.println("[SENSOR] Pembacaan BME280 tidak valid; payload tidak dikirim.");
    return;
  }
  bool pressureValid = !isnan(pressureHpa) && pressureHpa > 300.0f && pressureHpa < 1100.0f;

  int gasFiltered = readGasFiltered();
  int gasExcess = updateGasBaseline(gasFiltered);
  int soilRaw = analogRead(PIN_SOIL);
  float soilPercent = (float)(SOIL_RAW_DRY - soilRaw) * 100.0f / (float)(SOIL_RAW_DRY - SOIL_RAW_WET);
  soilPercent = constrain(soilPercent, 0.0f, 100.0f);

  int riskScore = calcRiskScore(suhu, kelembapan, (float)gasExcess, soilPercent);
  applyIndicators(riskScore);

  JsonDocument doc;
  doc["suhu"] = round(suhu * 10) / 10.0;
  doc["kelembapan"] = round(kelembapan * 10) / 10.0;
  doc["gas"] = gasFiltered;
  doc["gas_excess"] = gasExcess;
  doc["kelembapan_tanah"] = (int)round(soilPercent);
  doc["riskScore"] = riskScore;
  doc["status"] = riskLevel(riskScore);
  if (pressureValid) doc["tekanan"] = round(pressureHpa * 100) / 100.0; // 2 desimal

  String timestamp = isoTimestamp();
  if (timestamp.length() > 0) doc["timestamp"] = timestamp;

  char payload[384];
  size_t length = serializeJson(doc, payload, sizeof(payload));
  if (length == 0) { Serial.println("[JSON] Gagal membuat payload."); return; }

  bool ok = mqttClient.publish(sensorTopic.c_str(), payload, false);
  Serial.printf("[PUB] %s | %s\n", ok ? "OK" : "GAGAL", payload);
  if (ok) heartbeatBeep();
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
  Wire.begin(I2C_SDA, I2C_SCL);
  bmeReady = initBme();

  heartbeatBeep(300); // uji buzzer sekali saat boot
  Serial.println("[BZ] Uji buzzer. Setelah ini bunyi = publish berhasil.");

  analogReadResolution(12);
  analogSetPinAttenuation(PIN_MQ2, ADC_11db);
  analogSetPinAttenuation(PIN_SOIL, ADC_11db);

  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER_1, NTP_SERVER_2);
  Serial.println("[NTP] Sinkronisasi waktu dimulai (UTC+7).");

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setKeepAlive(60);
  mqttClient.setBufferSize(512);
  startWiFi();
}

void loop() {
  maintainWiFi();
  maintainMQTT();
  mqttClient.loop();
  maintainBuzzer();

  unsigned long now = millis();
  if (now - lastPublishMs >= PUBLISH_INTERVAL_MS) {
    lastPublishMs = now;
    if (mqttClient.connected()) publishSensor();
    else Serial.println("[PUB] Dilewati: MQTT belum terhubung.");
  }
}
