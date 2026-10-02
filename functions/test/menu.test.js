const { test } = require('node:test');
const assert = require('node:assert');
const { construirMenuRappi } = require('../lib/menu');

test('producto simple activo para rappi se convierte correctamente', () => {
  const productos = [
    { id: 'cc147', name: 'Panchito el Osito', desc: 'Combo', menu: 'Bebidas', sub: 'Combos', price: 249, canales: { rappi: { activo: true, precio: 265 } } },
  ];
  const menu = construirMenuRappi(productos, { storeId: 'TIENDA1' });
  assert.strictEqual(menu.store_id, 'TIENDA1');
  assert.strictEqual(menu.products.length, 1);
  assert.strictEqual(menu.products[0].sku, 'cc147');
  assert.strictEqual(menu.products[0].price, 265); // usa el precio del canal rappi, no el del POS
  assert.strictEqual(menu.products[0].category, 'Bebidas');
});

test('producto con tamanos genera una variante por tamano', () => {
  const productos = [
    {
      id: 'cc200', name: 'Latte', menu: 'Bebidas', sub: 'Cafés Calientes', sized: true,
      prices: { 'El Chico': 50, 'El Mayor': 65 },
      canales: { rappi: { activo: true, precios: { 'El Chico': 55, 'El Mayor': 70 } } },
    },
  ];
  const menu = construirMenuRappi(productos, { storeId: 'T1' });
  assert.strictEqual(menu.products.length, 2);
  assert.strictEqual(menu.products[0].sku, 'cc200-el-chico');
  assert.strictEqual(menu.products[0].price, 55);
  assert.strictEqual(menu.products[1].sku, 'cc200-el-mayor');
  assert.strictEqual(menu.products[1].price, 70);
});

test('producto sin canal rappi configurado no se incluye (por defecto apagado)', () => {
  const productos = [
    { id: 'cc1', name: 'Sin configurar', menu: 'Bebidas', price: 10 },
  ];
  const menu = construirMenuRappi(productos, {});
  assert.strictEqual(menu.products.length, 0);
});

test('producto con rappi explicitamente desactivado no se incluye', () => {
  const productos = [
    { id: 'cc2', name: 'Apagado', menu: 'Bebidas', price: 10, canales: { rappi: { activo: false } } },
  ];
  const menu = construirMenuRappi(productos, {});
  assert.strictEqual(menu.products.length, 0);
});

test('sin precio especifico de canal usa el precio del POS', () => {
  const productos = [
    { id: 'cc3', name: 'Normal', menu: 'Alimentos', price: 40, canales: { rappi: { activo: true } } },
  ];
  const menu = construirMenuRappi(productos, {});
  assert.strictEqual(menu.products[0].price, 40);
});
