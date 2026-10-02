// Prueba manual (no es parte de "npm test") del handler HTTP real del
// webhook, para los caminos que NO tocan Firebase (PING y firma
// invalida) -- los que si tocan Firebase (NEW_ORDER) ya se prueban por
// separado via orderMapper.test.js, porque requeririan credenciales
// reales de un service account para correr aqui.
process.env.GCLOUD_PROJECT = 'luna-smart-pos';
process.env.FIREBASE_CONFIG = JSON.stringify({ databaseURL: 'https://luna-smart-pos-default-rtdb.firebaseio.com', projectId: 'luna-smart-pos' });
process.env.RAPPI_CLIENT_ID = 'fake';
process.env.RAPPI_CLIENT_SECRET = 'fake';
process.env.RAPPI_WEBHOOK_SECRET = 'secreto-de-prueba-local';

const crypto = require('crypto');
const { rappiWebhook } = require('../index.js');

function mockRes() {
  const r = { _status: null, _json: null, _sent: null };
  r.status = function (s) { r._status = s; return r; };
  r.json = function (j) { r._json = j; return r; };
  r.send = function (s) { r._sent = s; return r; };
  return r;
}

async function main() {
  // 1) PING con firma valida -> debe responder 200 {status:'OK'}
  const bodyPing = JSON.stringify({ type: 'PING' });
  const firmaPing = crypto.createHmac('sha256', 'secreto-de-prueba-local').update(bodyPing).digest('hex');
  const reqPing = { rawBody: Buffer.from(bodyPing), body: JSON.parse(bodyPing), get: function (h) { return h === 'Rappi-Signature' ? firmaPing : undefined; } };
  const resPing = mockRes();
  await rappiWebhook(reqPing, resPing);
  console.log('PING ->', resPing._status, resPing._json);
  if (resPing._status !== 200 || !resPing._json || resPing._json.status !== 'OK') throw new Error('PING no respondio OK');

  // 2) Firma invalida -> debe responder 401 sin procesar nada
  const reqMalo = { rawBody: Buffer.from(bodyPing), body: JSON.parse(bodyPing), get: function () { return 'firma-que-no-es'; } };
  const resMalo = mockRes();
  await rappiWebhook(reqMalo, resMalo);
  console.log('Firma invalida ->', resMalo._status, resMalo._sent);
  if (resMalo._status !== 401) throw new Error('Deberia haber rechazado con 401');

  console.log('\nTODO OK -- el handler HTTP responde correctamente al PING y rechaza firmas invalidas.');
}

main().catch(function (e) { console.error('FALLO:', e); process.exit(1); });
