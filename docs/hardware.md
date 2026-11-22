# Hardware Setup Guide

## Overview

The AntiKobongan system consists of three main components:

1. **ESP32 Device** - Hardware sensor for temperature detection
2. **Mobile Application** - User interface for monitoring
3. **Backend Server** - API server for data handling

---

## ESP32 Hardware Requirements

### Components Needed

- **ESP32 Development Board** (e.g., ESP32-DevKitC)
- **Temperature Sensor** (DS18B20 or built-in sensor)
- **Jumper Wires** - For connections
- **Breadboard** - Optional, for prototyping
- **LED** - For visual feedback (optional)
- **Current Limiting Resistor** (220-330 ohm) - For LED (optional)

### electrical Connect-ions

```
ESP32 Pinout:
- VCC -> 3.3V
- GND -> GND
- D1 (GPIO5) -> Temperature Sensor Data
- D2 (GPIO4) -> Photoresistor (optional)
```

---

## Firmware Development

### Prerequisites

- **Arduino IDE**
- **ESP32 Board Support** (via Board Manager)

### Step 1: Install Arduino IDE

1. Download and install Arduino IDE from [arduino.cc](https://www.arduino.cc/en/software)

2. Add ESP32 Board Support:

```javascript
// In Arduino IDE, go to:
// File > Preferences > Additional Boards Manager URLs
// Add: https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
```

3. Install ESP32 Board:

```javascript
// In Arduino IDE, go to:
// Tools > Board > Boards Manager
// Search for "ESP32"
// Click "Install"
```

### Step 2: Create New Sketch

```cpp
/*
 * AntiKobongan - ESP32 Firmware
 * Detects burning sensation from temperature
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// WiFi Configuration
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";
const char* serverUrl = "http://YOUR_SERVER_IP:3000/api/detection";

// Pin Configuration
#define ONE_WIRE_BUS 5

// OneWire Instance
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

void setup() {
  Serial.begin(115200);
  sensors.begin();

  // Connect to WiFi
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    Serial.println("Connecting to WiFi...");
  }
  Serial.println("WiFi Connected");
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    // Get temperature
    sensors.requestTemperatures();
    float temperature = sensors.getTempCByIndex(0);

    // Send data to server
    HTTPClient http;
    http.begin(serverUrl);
    http.addHeader("Content-Type", "application/json");

    String jsonData = "{\"temperature\":" + String(temperature) +
                     ",\"burningSensation\":" + String(temperature > 85 ? "true" : "false") + "}";

    int httpResponseCode = http.POST(jsonData);

    if (httpResponseCode > 0) {
      String response = http.getString();
      Serial.println("Temperature: " + String(temperature) + "C");
      Serial.println("Burning Detected: " + (temperature > 85 ? "Yes" : "No"));
    }

    http.end();
  }

  delay(5000); // Send data every 5 seconds
}
```

### Step 3: Upload Firmware

1. Select board and port:
```javascript
// In Arduino IDE:
// Tools > Board > ESP32 Arduino > ESP32DEV
// Tools > Port > COMx
```

2. Click "Upload"

3. Monitor serial output:
```javascript
// Tools > Serial Monitor
// Baud rate: 115200
```

---

## Wi-Fi Configuration

### Connecting ESP32 to Wi-Fi

Edit the firmware:

```cpp
const char* ssid = "YourWifiNetwork";
const char* password = "YourPassword";
```

### REST API Integration

The firmware sends data to:

```
POST http://YOUR_SERVER_IP:3000/api/detection
Content-Type: application/json

{
  "temperature": 95,
  "burningSensation": true
}
```

---

## Mobile App Requirements

### Prerequisites

- **React Native** development environment
- **Node.js** v18 or higher
- **Android Studio** (for Android development)
- **Xcode** (for iOS development)

### Connecting ESP32 via Bluetooth

1. Enable Bluetooth on mobile device

2. Scan for ESP32:
```javascript
// Using React Native Ble Manager
import BleManager from 'react-native-ble-manager';

BleManager.startNotification({ serviceUUID: 'YOUR_SERVICE_UUID', featureUUID: 'YOUR_FEATURE_UUID' })
  .then(() => {
    console.log('Notification started');
  });
```

3. Connect to ESP32:
```javascript
BleManager.connect(deviceId)
  .then(() => {
    console.log('Connected to ESP32');
  })
  .catch((error) => {
    console.error('Connection failed:', error);
  });
```

---

## calibration

### Temperature Sensor Calibration

1. **Place sensor in ice water:**
```
Expected reading: 0°C
Expected error: ±0.5°C
```

2. **Place sensor in boiling water:**
```
Expected reading: 100°C
Expected error: ±0.5°C
```

3. **Adjust calibration:**
```cpp
sensors.setResolution(12); // Set resolution to 12 bits
```

---

## Troubleshooting

### ESP32 Not Connecting to Wi-Fi

- Check Wi-Fi credentials
- Ensure Wi-Fi password is correct
- Try different Wi-Fi network
- Check ESP32 baud rate

### No Temperature Reading

- Check temperature sensor connections
- Verify OneWire bus is correct
- Calibrate sensor (see calibration section)
- Check sensor wiring

### Wi-Fi Connection Timeout

- Try increasing delay in loop()
- Reduce frequency of data transmission
- Check firewall settings
- Verify server URL is correct

### Mobile App Not Connecting to ESP32

- Ensure Bluetooth is enabled
- Check device discovery
- Verify service UUIDs match
- Reboot ESP32 and try again

---

## Power Consumption

### ESP32 Current Draw

- **Standby:** ~80mA
- **Active (WiFi):** ~160-200mA
- **Temperature Measurement:** ~20mA

### Power Recommendations

- Use external power source if monitoring for long periods
- Consider sleep mode to reduce power consumption
- Use PoE (Power over Ethernet) if available

---

## security

### Securing WiFi

```cpp
const char* ssid = "AntiKobongan_WiFi";
const char* password = "StrongPassword123!";
```

### API Security (Future)

- Add API keys
- Implement authentication
- Use HTTPS
- Rate limiting

---

## Maintenance

### Firmware Updates

1. Backup current firmware
2. Update sketch
3. Upload new firmware
4. Test functionality
5. Monitor for errors

### Sensor Maintenance

- Clean sensor regularly
- Check wiring connections
- Calibrate periodically
- Replace sensor if faulty

---

## Testing

### Hardware Testing Checklist

- [ ] ESP32 connects to Wi-Fi
- [ ] Temperature readings are accurate
- [ ] Data transmission to server works
- [ ] Mobile app discovers and connects to ESP32
- [ ] Burning detection triggers notifications
- [ ] LED indicators work (if installed)

### API Testing

- [ ] Health check endpoint responds
- [ ] Get detection data works
- [ ] Post detection data works
- [ ] Connection/disconnection work

---

## Future Features

- [ ] MQTT support for real-time communication
- [ ] Cloud backup of detection data
- [ ] Multiple device support
- [ ] Mobile app push notifications
- [ ] Cloud dashboard for monitoring
- [ ] Multiple temperature sensors
- [ ] Image capture when burning detected

---

**Last Updated:** 2026-11-22