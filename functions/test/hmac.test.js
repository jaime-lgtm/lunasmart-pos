const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { firmaValida, parsearFirma } = require('../lib/hmac');

function firmar(cuerpo, secreto, t) {
  const sign = crypto.createHmac('sha256', secreto).update(t + '.' + cuerpo).digest('hex');
  return 't=' + t + ',sign=' + sign;
}

test('firma valida: HMAC de "t.cuerpo" con el secreto', () => {
  const cuerpo = Buffer.from(JSON.stringify({ store_id: 999 }));
  const header = firmar(cuerpo.toString(), 'secreto-de-prueba', '1790000000');
  assert.strictEqual(firmaValida(cuerpo, header, 'secreto-de-prueba'), true);
});

test('firma invalida se rechaza', () => {
  const cuerpo = Buffer.from('{}');
  assert.strictEqual(firmaValida(cuerpo, 't=1,sign=firma-falsa', 'secreto'), false);
});

test('cuerpo alterado o secreto equivocado se rechaza', () => {
  const header = firmar('{"a":1}', 'secreto', '5');
  assert.strictEqual(firmaValida(Buffer.from('{"a":2}'), header, 'secreto'), false);
  assert.strictEqual(firmaValida(Buffer.from('{"a":1}'), header, 'otro-secreto'), false);
});

test('firma de solo el cuerpo (sin timestamp) ya NO es valida', () => {
  const cuerpo = Buffer.from('{}');
  const soloCuerpo = crypto.createHmac('sha256', 'secreto').update(cuerpo).digest('hex');
  assert.strictEqual(firmaValida(cuerpo, soloCuerpo, 'secreto'), false);
});

test('sin header o sin secreto se rechaza', () => {
  assert.strictEqual(firmaValida(Buffer.from('{}'), null, 'secreto'), false);
  assert.strictEqual(firmaValida(Buffer.from('{}'), 't=1,sign=ab', null), false);
});

test('parsearFirma separa t y sign', () => {
  assert.deepStrictEqual(parsearFirma('t=123456,sign=abc'), { t: '123456', sign: 'abc' });
});
