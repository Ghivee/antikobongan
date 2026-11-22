/**
 * Utility functions for formatting data
 */

/**
 * Format temperature to human-readable string
 */
export function formatTemperature(temperature: number): string {
  return `${temperature.toFixed(1)}°C`;
}

/**
 * Format timestamp to readable date
 */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString('id-ID');
}

/**
 * Get severity level based on burning sensation
 */
export function getSeverityLevel(isBurning: boolean): string {
  if (!isBurning) {
    return 'Normal';
  }
  return 'WARNING';
}

/**
 * Format boolean to Indonesian text
 */
export function formatBooleanToIndonesian(value: boolean): string {
  return value ? 'Ya' : 'Tidak';
}