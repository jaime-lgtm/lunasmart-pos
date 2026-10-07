// OAuth2 Authorization Code + PKCE (RFC 7636) para el Self Onboarding de Rappi:
// el comerciante autoriza a la integracion desde el login de Portal Partners.
const crypto = require('crypto');

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function nuevoVerifier() { return base64url(crypto.randomBytes(48)); } // 64 caracteres
function desafioDe(verifier) { return base64url(crypto.createHash('sha256').update(verifier).digest()); }
function nuevoState() { return base64url(crypto.randomBytes(24)); }

// id_token correcto = JWT firmado (3 partes, 2 puntos); el access_token es un
// JWE opaco (5 partes) que Rappi rechaza con 401 aunque el mensaje hable de firma.
function esJwtFirmado(token) { return typeof token === 'string' && token.split('.').length === 3; }
function expDeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')).exp * 1000; } catch (e) { return 0; }
}

module.exports = { nuevoVerifier, desafioDe, nuevoState, esJwtFirmado, expDeJwt, base64url };
