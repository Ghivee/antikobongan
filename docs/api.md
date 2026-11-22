# API Documentation

Base URL: `http://localhost:3000`

## Overview

AntiKobongan provides RESTful API endpoints for ESP32 communication and mobile app integration.

## Authentication

Currently, all endpoints are public. Future versions may include authentication.

## Endpoints

### Health Check

Check the status of the API server.

**Endpoint:** `GET /health`

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2026-11-22T15:00:00.000Z",
  "version": "1.0.0"
}
```

**Status Codes:**
- `200 OK` - Server is healthy

---

### Get Detection Data

Retrieve the latest detection data from ESP32.

**Endpoint:** `GET /api/detection`

**Response:**

```json
{
  "temperature": 37.5,
  "burningSensation": false,
  "timestamp": 1700698800000
}
```

**Fields:**
- `temperature` (number): Current temperature in Celsius
- `burningSensation` (boolean): True if burning sensation detected
- `timestamp` (number): Unix timestamp of measurement

**Status Codes:**
- `200 OK` - Data retrieved successfully
- `500 Internal Server Error` - Error retrieving data

---

### Update Detection Data

Send detection data from ESP32 to the server.

**Endpoint:** `POST /api/detection`

**Request Body:**

```json
{
  "temperature": 95,
  "burningSensation": true
}
```

**Required Fields:**
- `temperature` (number): Temperature in Celsius
- `burningSensation` (boolean): Whether burning sensation is detected

**Response:**

```json
{
  "success": true,
  "message": "Detection data received",
  "data": {
    "temperature": 95,
    "burningSensation": true,
    "timestamp": 1700698800000
  }
}
```

**Status Codes:**
- `200 OK` - Data received successfully
- `400 Bad Request` - Missing required fields
- `500 Internal Server Error` - Error saving data

---

### Connect Device

Connect ESP32 device to the system.

**Endpoint:** `POST /api/device/connect`

**Request Body:**

```json
{
  "deviceId": "ESP32-12345"
}
```

**Required Fields:**
- `deviceId` (string): Unique identifier for the ESP32 device

**Response:**

```json
{
  "success": true,
  "message": "Device connected",
  "deviceId": "ESP32-12345"
}
```

**Status Codes:**
- `200 OK` - Device connected successfully
- `400 Bad Request` - Missing deviceId
- `500 Internal Server Error` - Error connecting device

---

### Disconnect Device

Disconnect ESP32 device from the system.

**Endpoint:** `POST /api/device/disconnect`

**Request Body:**

```json
{
  "deviceId": "ESP32-12345"
}
```

**Response:**

```json
{
  "success": true,
  "message": "Device disconnected"
}
```

**Status Codes:**
- `200 OK` - Device disconnected successfully
- `500 Internal Server Error` - Error disconnecting device

---

## Error Responses

All error responses follow this format:

```json
{
  "error": "Error message",
  "details": "Additional error details (optional)"
}
```

**Common Error Codes:**
- `400 Bad Request` - Invalid request parameters
- `404 Not Found` - Endpoint not found
- `500 Internal Server Error` - Server error

---

## Rate Limiting

Rate limiting is not currently implemented. Future versions may include rate limiting for API usage.

---

## Webhooks (Future)

Future versions may include webhook support for real-time notifications.

---

## Testing the API

### Using curl

```bash
# Health check
curl http://localhost:3000/health

# Get detection data
curl http://localhost:3000/api/detection

# Update detection data
curl -X POST http://localhost:3000/api/detection \
  -H "Content-Type: application/json" \
  -d '{"temperature": 95, "burningSensation": true}'

# Connect device
curl -X POST http://localhost:3000/api/device/connect \
  -H "Content-Type: application/json" \
  -d '{"deviceId": "ESP32-12345"}'
```

### Using JavaScript

```javascript
// Get detection data
fetch('http://localhost:3000/api/detection')
  .then(res => res.json())
  .then(data => {
    console.log('Temperature:', data.temperature);
    console.log('Burning:', data.burningSensation);
  });

// Update detection data
fetch('http://localhost:3000/api/detection', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    temperature: 95,
    burningSensation: true
  })
})
  .then(res => res.json())
  .then(data => console.log(data));
```

---

## WebSocket (Future)

Future versions may include WebSocket support for real-time data streaming.

---

## API Versioning

The API is currently in version 1.0.0. Future versions will be documented with version prefixes (e.g., `/api/v2/`).

---

**Last Updated:** 2026-11-22
