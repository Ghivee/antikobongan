// GET /api/mqtt-config — alamat broker untuk browser.
// Kredensial yang dikirim HARUS akun broker yang hanya boleh subscribe.

const { allow, handler, send } = require('../http');

const PUBLIC_BROKER = 'wss://broker.hivemq.com:8884/mqtt';
const DEFAULT_PREFIX = 'antikobongan/prototipe-gx7q4m';

function mqttConfig(env = process.env) {
  const url = String(env.MQTT_WS_URL || '').trim() || PUBLIC_BROKER;
  const username = String(env.MQTT_WEB_USERNAME || '').trim();
  return {
    url,
    username: username || null,
    password: username ? String(env.MQTT_WEB_PASSWORD || '') : null,
    prefix: String(env.TOPIC_PREFIX || '').trim().replace(/\/+$/, '') || DEFAULT_PREFIX,
    public: url === PUBLIC_BROKER && !username,
  };
}

module.exports = handler(async (req, res) => {
  if (!allow(req, res, ['GET'])) return;
  send(res, 200, mqttConfig());
});

module.exports.mqttConfig = mqttConfig;
