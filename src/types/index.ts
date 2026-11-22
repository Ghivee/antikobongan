/**
 * Type definitions for AntiKobongan application
 */

export interface DetectionData {
  temperature: number;
  burningSensation: boolean;
  timestamp: number;
}

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  batteryLevel?: number;
}

export interface AppConfig {
  appName: string;
  appVersion: string;
  esp32BaudRate: number;
  esp32BleDeviceName: string;
}

export interface UserSettings {
  deviceId?: string;
  notificationEnabled: boolean;
  sensitivityLevel: number;
  language: 'id' | 'en';
}
