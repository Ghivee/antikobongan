/**
 * Custom hook for Bluetooth operations
 */

import { useState, useEffect } from 'react';
import { bluetoothService, DetectionData } from '../services/BluetoothService';

export function useBluetooth() {
  const [isConnected, setIsConnected] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<any>(null);
  const [detectionData, setDetectionData] = useState<DetectionData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check connection status
    setIsConnected(bluetoothService.getConnectionStatus());
    setDeviceInfo(bluetoothService.getDeviceInfo());

    // TODO: Set up real-time data polling
    const interval = setInterval(() => {
      fetchDetectionData();
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const connect = async (deviceId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const success = await bluetoothService.connect(deviceId);
      if (success) {
        setIsConnected(true);
        setDeviceInfo(bluetoothService.getDeviceInfo());
        await fetchDetectionData();
      } else {
        setError('Failed to connect to device');
      }
    } catch (err) {
      setError('Connection error');
    } finally {
      setIsLoading(false);
    }
  };

  const disconnect = async () => {
    await bluetoothService.disconnect();
    setIsConnected(false);
    setDeviceInfo(null);
    setDetectionData(null);
  };

  const fetchDetectionData = async () => {
    setIsLoading(true);
    try {
      const data = await bluetoothService.getDetectionData();
      if (data) {
        setDetectionData(data);
      }
    } catch (err) {
      setError('Failed to fetch data');
    } finally {
      setIsLoading(false);
    }
  };

  return {
    isConnected,
    deviceInfo,
    detectionData,
    isLoading,
    error,
    connect,
    disconnect,
    fetchDetectionData,
  };
}
