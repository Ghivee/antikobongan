const { allow, handler, send } = require('../http');
const { getConfig } = require('../supabase');

module.exports = handler(async (req, res) => {
  if (!allow(req, res, ['GET'])) return;
  const { baseUrl, readKey, secretKey } = getConfig();
  send(res, 200, {
    ok: true,
    databaseConfigured: Boolean(baseUrl && readKey),
    adminConfigured: Boolean(process.env.ADMIN_PIN && secretKey),
  });
});
