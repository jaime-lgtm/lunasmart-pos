const { test } = require('node:test');
const assert = require('node:assert');
const { desafioDe, nuevoVerifier, esJwtFirmado, expDeJwt } = require('../lib/pkce');

test('desafio PKCE: vector de la RFC 7636', () => {
  assert.strictEqual(desafioDe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
test('verifier: largo valido y solo caracteres URL-safe', () => {
  const v = nuevoVerifier();
  assert.ok(v.length >= 43 && v.length <= 128);
  assert.match(v, /^[A-Za-z0-9_-]+$/);
});
test('id_token (2 puntos) si, access_token JWE (4 puntos) no', () => {
  assert.strictEqual(esJwtFirmado('a.b.c'), true);
  assert.strictEqual(esJwtFirmado('a.b.c.d.e'), false);
});
test('expiracion del JWT', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1800000000 })).toString('base64');
  assert.strictEqual(expDeJwt('h.' + payload + '.s'), 1800000000000);
});
