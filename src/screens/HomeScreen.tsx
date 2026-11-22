/**
 * Home screen component
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Header } from '../components/Header';
import { DetectionCard } from '../components/DetectionCard';
import { Settings } from '../components/Settings';
import { useBluetooth } from '../hooks/useBluetooth';
import { UserSettings } from '../types';

export function HomeScreen() {
  const { isConnected, detectionData, isLoading, connect, disconnect } = useBluetooth();
  const [settings, setSettings] = useState<UserSettings>({
    notificationEnabled: true,
    sensitivityLevel: 2,
    language: 'id',
  });

  const handleConnect = () => {
    // TODO: Implement device selection dialog
    connect('DEVICE_ID_HERE');
  };

  return (
    <View style={styles.container}>
      <Header />
      <DetectionCard data={detectionData} isLoading={isLoading} />
      <Settings settings={settings} onSettingsChange={setSettings} />

      <TouchableOpacity
        style={[styles.button, isConnected && styles.connectedButton]}
        onPress={isConnected ? disconnect : handleConnect}
      >
        <Text style={styles.buttonText}>
          {isConnected ? 'Disconnect' : 'Connect Device'}
        </Text>
      </TouchableOpacity>

      <View style={styles.infoContainer}>
        <Text style={styles.infoText}>
          {isConnected ? 'Device connected' : 'No device connected'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  button: {
    backgroundColor: '#007AFF',
    padding: 16,
    borderRadius: 8,
    margin: 20,
    alignItems: 'center',
  },
  connectedButton: {
    backgroundColor: '#4CAF50',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  infoContainer: {
    padding: 20,
    alignItems: 'center',
  },
  infoText: {
    color: '#666',
    fontSize: 14,
  },
});
