/**
 * Detection card component
 */

import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { DetectionData } from '../types';

interface DetectionCardProps {
  data: DetectionData | null;
  isLoading: boolean;
}

export function DetectionCard({ data, isLoading }: DetectionCardProps) {
  if (isLoading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.text}>Connecting to device...</Text>
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.container}>
        <Text style={styles.text}>No device connected</Text>
      </View>
    );
  }

  const isBurning = data.burningSensation;
  const temperature = data.temperature;

  return (
    <View style={[styles.container, isBurning && styles.warningContainer]}>
      <Text style={[styles.text, isBurning && styles.warningText]}>
        Temperature: {temperature}°C
      </Text>
      <Text style={[styles.text, isBurning && styles.warningText]}>
        Burning Sensation: {isBurning ? 'DETECTED' : 'NOT DETECTED'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    backgroundColor: '#ffffff',
    borderRadius: 8,
    marginTop: 20,
  },
  warningContainer: {
    backgroundColor: '#fff3cd',
    borderWidth: 1,
    borderColor: '#ffc107',
  },
  text: {
    fontSize: 16,
    color: '#333',
    marginBottom: 8,
  },
  warningText: {
    color: '#856404',
    fontWeight: 'bold',
  },
});
