const { test } = require('node:test');
const assert = require('node:assert');
const { skusARappi, calcularDisponibilidadCompleta } = require('../lib/disponibilidad');

const catalogo = [
  { id: 'a', name: 'A', canales: { rappi: { activo: true } } },
  { id: 'b', name: 'B', sized: true, prices: { Chico: 1, Grande: 2 }, canales: { rappi: { activo: true } } },
  { id: 'c', name: 'C' }, // no esta en Rappi
];

test('un producto no activado para Rappi no genera SKUs', () => {
  assert.deepStrictEqual(skusARappi(catalogo[2]), []);
  assert.deepStrictEqual(skusARappi(catalogo[0]), ['a']);
  assert.deepStrictEqual(skusARappi(catalogo[1]), ['b']); // un producto con tamanos es un solo SKU
});

test('sincronizacion completa: lo agotado se apaga y lo demas se enciende', () => {
  const c = calcularDisponibilidadCompleta({ b: true, c: true }, catalogo);
  assert.deepStrictEqual(c.turnOff, ['b']); // c se ignora: no esta en Rappi
  assert.deepStrictEqual(c.turnOn, ['a']);
});

test('sin agotados todo se enciende', () => {
  const c = calcularDisponibilidadCompleta({}, catalogo);
  assert.deepStrictEqual(c.turnOff, []);
  assert.deepStrictEqual(c.turnOn, ['a', 'b']);
});
