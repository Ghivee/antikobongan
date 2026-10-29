// Koneksi MQTT browser (WebSocket). Hanya topik sensor & status yang dipakai;
// semua payload divalidasi dulu dan dibuang bila tidak lolos.

import { getJSON } from './api.js';
import { log } from './log.js';
import { parseStatus, parseTopic, validateSensor } from './validate.js';

const FALLBACK = { url: 'wss://broker.hivemq.com:8884/mqtt', prefix: 'antikobongan/prototipe-gx7q4m', username: null, password: null, public: true };
const MAX_PAYLOAD = 2048;

export async function startMqtt({ onState, onSensor, onStatus }) {
  if (!window.mqtt || typeof window.mqtt.connect !== 'function') {
    onState('unavailable', 'Pustaka MQTT gagal dimuat. Data live tidak tersedia; data tersimpan tetap tampil.');
    log('Pustaka MQTT tidak termuat.', 'err');
    return null;
  }
  let config;
  try {
    config = await getJSON('/api/mqtt-config', { timeout: 8000 });
  } catch (error) {
    config = FALLBACK;
    log(`Konfigurasi broker tidak terbaca (${error.message}); memakai broker publik.`, 'warn');
  }
  onState('connecting', '', config);

  const client = window.mqtt.connect(config.url, {
    clientId: `ak-web-${Math.random().toString(16).slice(2, 10)}`,
    username: config.username || undefined,
    password: config.password || undefined,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    keepalive: 30,
  });
  const topics = [`${config.prefix}/+/sensor`, `${config.prefix}/+/status`];

  client.on('connect', () => {
    client.subscribe(topics, { qos: 0 }, (error) => {
      if (error) log(`Gagal subscribe: ${error.message}`, 'err');
    });
    onState('connected', '', config);
    log(`Terhubung ke broker ${new URL(config.url).host}; subscribe ${topics.join(', ')}.`, 'ok');
  });
  client.on('reconnect', () => onState('reconnecting', 'Mencoba menyambung ulang ke broker…', config));
  client.on('offline', () => onState('offline', 'Koneksi ke broker terputus.', config));
  client.on('error', (error) => {
    onState('error', error.message, config);
    log(`Galat broker: ${error.message}`, 'err');
  });

  client.on('message', (topic, payload) => {
    if (payload.length > MAX_PAYLOAD) {
      log(`Pesan terlalu besar diabaikan (${payload.length} byte).`, 'warn');
      return;
    }
    const parsed = parseTopic(topic, config.prefix);
    if (parsed.error) {
      log(`Pesan diabaikan: ${parsed.error}.`, 'warn');
      return;
    }
    const text = payload.toString();
    if (parsed.type === 'status') {
      const status = parseStatus(text);
      if (!status) {
        log(`Status node ${parsed.nodeId} tidak dikenal; diabaikan.`, 'warn');
        return;
      }
      onStatus(parsed.nodeId, status);
      return;
    }
    const result = validateSensor(text);
    if (!result.ok) {
      log(`Payload sensor ${parsed.nodeId} ditolak: ${result.reason}.`, 'err');
      return;
    }
    result.warnings.forEach((warning) => log(`Payload ${parsed.nodeId}: ${warning}.`, 'warn'));
    onSensor(parsed.nodeId, result);
  });

  return client;
}
