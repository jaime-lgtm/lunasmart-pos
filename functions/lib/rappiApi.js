// Llamadas HTTP a la API de Rappi (documentacion: dev-portal.rappi.com).
// - Login:    POST {AUTH}/restaurants/auth/v1/token/login/integrations
// - Todo lo demas lleva el header  x-authorization: Bearer <token>
// - Pedidos / webhooks / menu viven bajo  {HOST}/api/v2/restaurants-integrations-public-api
// Hoy solo esta configurado el ambiente DEV (credenciales de pruebas); los
// dominios de produccion de Mexico se agregan al pasar a produccion.
const AUTH_BASE = process.env.RAPPI_AUTH_BASE || 'https://api.dev.rappi.com';
const ORDERS_BASE = process.env.RAPPI_API_BASE || 'https://microservices.dev.rappi.com';
const WEBHOOKS_BASE = process.env.RAPPI_WEBHOOKS_BASE || 'https://api.dev.rappi.com';
const RUTA = '/api/v2/restaurants-integrations-public-api';

async function _rappiFetch(base, ruta, token, opciones) {
  opciones = opciones || {};
  const res = await fetch(base + RUTA + ruta, {
    method: opciones.method || 'GET',
    headers: {
      'x-authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: opciones.body ? JSON.stringify(opciones.body) : undefined,
  });
  const texto = await res.text().catch(function () { return ''; });
  if (!res.ok) throw new Error('Rappi ' + (opciones.method || 'GET') + ' ' + ruta + ' -> ' + res.status + ': ' + texto.slice(0, 400));
  try { return texto ? JSON.parse(texto) : null; } catch (e) { return texto; }
}

// Login. Las credenciales de DEV que entrego Rappi funcionan con su login de
// Auth0 (el "anterior"); el endpoint "nuevo" de su documentacion
// (/restaurants/auth/v1/token/login/integrations/) las rechazo con 401 --
// se usa Auth0 primero y el nuevo solo como respaldo.
const AUTH0_DOMINIO = process.env.RAPPI_AUTH0_DOMAIN || 'rests-integrations-dev.auth0.com';
const AUTH0_AUDIENCE = process.env.RAPPI_AUTH0_AUDIENCE || 'https://int-public-api-v2/api';

async function obtenerToken(clientId, clientSecret) {
  const errores = [];
  try {
    const res = await fetch('https://' + AUTH0_DOMINIO + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, audience: AUTH0_AUDIENCE, grant_type: 'client_credentials' }),
    });
    const texto = await res.text().catch(function () { return ''; });
    if (res.ok) return JSON.parse(texto); // { access_token, expires_in, ... }
    errores.push('Auth0 ' + res.status + ': ' + texto.slice(0, 150));
  } catch (e) { errores.push('Auth0: ' + e.message); }
  try {
    const res = await fetch(AUTH_BASE + '/restaurants/auth/v1/token/login/integrations/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    });
    const texto = await res.text().catch(function () { return ''; });
    if (res.ok) return JSON.parse(texto);
    errores.push('login nuevo ' + res.status + ': ' + texto.slice(0, 150));
  } catch (e) { errores.push('login nuevo: ' + e.message); }
  throw new Error('Login Rappi fallo -- ' + errores.join(' | '));
}

// Aceptar un pedido (pasa a TAKEN). cookingTime = minutos de preparacion.
function tomarPedido(token, orderId, cookingTime) {
  const min = parseInt(cookingTime, 10);
  return _rappiFetch(ORDERS_BASE, '/orders/' + orderId + '/take' + (min > 0 ? '/' + min : ''), token, { method: 'PUT' });
}

// Rechazar (solo pedidos en SENT). cancel_type obligatorio; si es de
// producto (agotado/precio/no existe) hay que mandar los productos.
function rechazarPedido(token, orderId, razon) {
  const body = { reason: razon.reason || 'Pedido rechazado por la tienda', cancel_type: razon.cancelType };
  if (razon.itemsIds && razon.itemsIds.length) body.items_ids = razon.itemsIds;
  if (razon.itemsSkus && razon.itemsSkus.length) body.items_skus = razon.itemsSkus;
  return _rappiFetch(ORDERS_BASE, '/orders/' + orderId + '/reject', token, { method: 'PUT', body: body });
}

// Avisa al repartidor de Rappi que el pedido esta listo. Rappi solo permite
// 3 llamadas por pedido -- quien llame debe asegurarse de hacerlo una vez.
function marcarListoParaRecoger(token, orderId) {
  return _rappiFetch(ORDERS_BASE, '/orders/' + orderId + '/ready-for-pickup', token, { method: 'POST' });
}

function registrarWebhook(token, evento, url, tiendas) {
  return _rappiFetch(WEBHOOKS_BASE, '/webhook', token, { method: 'POST', body: { event: evento, data: [{ url: url, stores: tiendas }] } });
}
function listarWebhooks(token) {
  return _rappiFetch(WEBHOOKS_BASE, '/webhook', token, { method: 'GET' });
}

module.exports = { obtenerToken, tomarPedido, rechazarPedido, marcarListoParaRecoger, registrarWebhook, listarWebhooks };
