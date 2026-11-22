/**
 * Settings component
 */

import React from 'react';
import { View, Text, StyleSheet, Switch, TouchableOpacity } from 'react-native';
import { UserSettings } from '../types';

interface SettingsProps {
  settings: UserSettings;
  onSettingsChange: (settings: UserSettings) => void;
}

export function Settings({ settings, onSettingsChange }: SettingsProps) {
  const toggleNotification = () => {
    onSettingsChange({
      ...settings,
      notificationEnabled: !settings.notificationEnabled,
    });
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.settingItem}>
        <Text style={styles.label}>Notifications</Text>
        <Switch
          value={settings.notificationEnabled}
          onValueChange={toggleNotification}
          trackColor={{ false: '#767577', true: '#4CAF50' }}
        />
      </View>

      <TouchableOpacity
        style={styles.settingItem}
        onPress={() => {
          // TODO: Implement language selection
          console.log('Language selection');
        }}
      >
        <Text style={styles.label}>Language</Text>
        <Text style={styles.value}>
          {settings.language === 'id' ? 'Indonesia' : 'English'}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.settingItem}
        onPress={() => {
          // TODO: Implement sensitivity level selection
          console.log('Sensitivity level selection');
        }}
      >
        <Text style={styles.label}>Sensitivity Level</Text>
        <Text style={styles.value}>Medium</Text>
      </TouchableOpacity>
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
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 16,
    color: '#333',
  },
  settingItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  label: {
    fontSize: 16,
    color: '#333',
  },
  value: {
    fontSize: 16,
    color: '#666',
  },
});
