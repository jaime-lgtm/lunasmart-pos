// Llamadas HTTP reales a la API de Rappi. Las rutas y nombres de campo
// exactos son los documentados en el Portal de Desarrolladores -- hay
// que confirmarlos contra el sandbox real en cuanto Rappi entregue las
// credenciales (client_id/client_secret); por eso la URL base es
// configurable (RAPPI_API_BASE) y no esta "quemada" en cada funcion --
// si algo no coincide, se corrige aqui sin tocar el resto del backend.
const BASE = process.env.RAPPI_API_BASE || 'https://api.rappi.com';

async function _rappiFetch(path, token, opciones) {
  opciones = opciones || {};
  const res = await fetch(BASE + path, {
    method: opciones.method || 'GET',
    headers: Object.assign({
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    }, opciones.headers || {}),
    body: opciones.body ? JSON.stringify(opciones.body) : undefined,
  });
  if (!res.ok) {
    const texto = await res.text().catch(function () { return ''; });
    throw new Error('Rappi API ' + path + ' -> ' + res.status + ': ' + texto);
  }
  return res.status === 204 ? null : res.json().catch(function () { return null; });
}

async function obtenerToken(clientId, clientSecret) {
  const res = await fetch(BASE + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(clientId) + '&client_secret=' + encodeURIComponent(clientSecret),
  });
  if (!res.ok) throw new Error('No se pudo obtener token de Rappi: ' + res.status);
  return res.json(); // { access_token, expires_in, ... }
}

function aceptarPedido(token, rappiOrderId) {
  return _rappiFetch('/orders/' + rappiOrderId + '/accept', token, { method: 'POST' });
}
function rechazarPedido(token, rappiOrderId, motivo) {
  return _rappiFetch('/orders/' + rappiOrderId + '/reject', token, { method: 'POST', body: { reason: motivo || 'other' } });
}
function marcarListoParaRecoger(token, rappiOrderId) {
  return _rappiFetch('/orders/' + rappiOrderId + '/ready', token, { method: 'POST' });
}
function subirMenu(token, storeId, menu) {
  return _rappiFetch('/menu', token, { method: 'POST', body: Object.assign({ store_id: storeId }, menu) });
}

module.exports = { obtenerToken, aceptarPedido, rechazarPedido, marcarListoParaRecoger, subirMenu };
