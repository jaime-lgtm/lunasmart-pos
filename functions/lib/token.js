// Cachea el token OAuth2 M2M de Rappi en Realtime Database (rappiAuth/token)
// para no pedir uno nuevo en cada funcion -- Rappi lo documenta como
// valido por ~1 semana, pero aqui se refresca con margen de seguridad
// para nunca usarlo ya vencido a medio webhook.
const { obtenerToken } = require('./rappiApi');

const MARGEN_SEGURIDAD_MS = 10 * 60 * 1000; // renovar 10 min antes de que expire

async function obtenerTokenVigente(db, clientId, clientSecret) {
  const ref = db.ref('rappiAuth/token');
  const snap = await ref.once('value');
  const actual = snap.val();
  if (actual && actual.expiresAt && actual.expiresAt - Date.now() > MARGEN_SEGURIDAD_MS) {
    return actual.accessToken;
  }
  const nuevo = await obtenerToken(clientId, clientSecret);
  const expiresAt = Date.now() + (nuevo.expires_in || 604800) * 1000;
  await ref.set({ accessToken: nuevo.access_token, expiresAt: expiresAt });
  return nuevo.access_token;
}

module.exports = { obtenerTokenVigente };
