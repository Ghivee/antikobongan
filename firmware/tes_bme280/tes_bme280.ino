#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
Adafruit_BME280 bme;
bool ok = false;
void setup() {
  Serial.begin(115200); delay(300);
  Wire.begin(21, 22);
  ok = bme.begin(0x76, &Wire) || bme.begin(0x77, &Wire);
  Serial.println(ok ? "BME280 terdeteksi." : "BME280 TIDAK terdeteksi. Cek wiring/alamat.");
  Serial.printf("sensorID=0x%02X (0x60=BME280, 0x56-0x58=BMP280 tanpa kelembapan, 0xFF=wiring/alamat salah)\n", bme.sensorID());
}
void loop() {
  if (ok) {
    Serial.printf("Suhu=%.1f C | Kelembapan=%.1f %% | Tekanan=%.1f hPa\n",
                  bme.readTemperature(), bme.readHumidity(), bme.readPressure() / 100.0f);
  }
  delay(2000);
}
