const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { firmaValida } = require('../lib/hmac');

test('firma valida coincide', () => {
  const secreto = 'secreto-de-prueba';
  const cuerpo = Buffer.from(JSON.stringify({ hola: 'mundo' }));
  const firma = crypto.createHmac('sha256', secreto).update(cuerpo).digest('hex');
  assert.strictEqual(firmaValida(cuerpo, firma, secreto), true);
});

test('firma invalida se rechaza', () => {
  const cuerpo = Buffer.from('{}');
  assert.strictEqual(firmaValida(cuerpo, 'firma-falsa-que-no-coincide', 'secreto'), false);
});

test('sin firma o sin secreto se rechaza', () => {
  assert.strictEqual(firmaValida(Buffer.from('{}'), null, 'secreto'), false);
  assert.strictEqual(firmaValida(Buffer.from('{}'), 'algo', null), false);
});
