/**
 * Express server for AntiKobongan IoT application
 */

import express, { Request, Response } from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// Detection endpoint (for ESP32 communication)
app.get('/api/detection', (req: Request, res: Response) => {
  // TODO: Implement actual detection logic
  res.json({
    temperature: 37,
    burningSensation: false,
    timestamp: Date.now(),
  });
});

// Update detection endpoint (for ESP32 to send data)
app.post('/api/detection', (req: Request, res: Response) => {
  // TODO: Implement actual update logic
  const { temperature, burningSensation } = req.body;

  if (temperature === undefined || burningSensation === undefined) {
    return res.status(400).json({
      error: 'Missing required fields: temperature and burningSensation',
    });
  }

  res.json({
    success: true,
    message: 'Detection data received',
    data: {
      temperature,
      burningSensation,
      timestamp: Date.now(),
    },
  });
});

// Device connection endpoint
app.post('/api/device/connect', (req: Request, res: Response) => {
  // TODO: Implement device connection logic
  const { deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).json({
      error: 'Missing deviceId',
    });
  }

  res.json({
    success: true,
    message: 'Device connected',
    deviceId,
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`AntiKobongan server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API detection: http://localhost:${PORT}/api/detection`);
});
