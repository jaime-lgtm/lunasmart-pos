const { test } = require('node:test');
const assert = require('node:assert');
const { construirMenuRappi, skusDeProducto, slug } = require('../lib/menu');

const cat = [
  { id: 'cc147', name: 'Panchito el Osito', desc: 'Combo', menu: 'Bebidas', sub: 'Combos', price: 249, img: 'https://x/y.jpg', canales: { rappi: { activo: true, precio: 265 } } },
  { id: 'cc200', name: 'Latte', menu: 'Bebidas', sub: 'Cafés Calientes', sized: true, prices: { 'El Chico': 50, 'El Mayor': 65 }, canales: { rappi: { activo: true, precios: { 'El Chico': 55, 'El Mayor': 70 } } } },
  { id: 'cc1', name: 'Sin configurar', menu: 'Bebidas', price: 10 },
  { id: 'cc2', name: 'Apagado', menu: 'Bebidas', price: 10, canales: { rappi: { activo: false } } },
];

test('formato de POST /menu: storeId e items con category, sku, type y price', () => {
  const m = construirMenuRappi(cat, { storeId: 900175250 });
  assert.strictEqual(m.storeId, '900175250');
  const p = m.items.find(i => i.sku === 'cc147');
  assert.strictEqual(p.type, 'PRODUCT');
  assert.strictEqual(p.price, 265); // precio del canal Rappi
  assert.strictEqual(p.name, 'Panchito el Osito');
  assert.strictEqual(p.imageUrl, 'https://x/y.jpg');
  assert.deepStrictEqual(p.children, []);
  assert.strictEqual(p.category.name, 'Bebidas - Combos');
  assert.strictEqual(p.category.id, 'cat-bebidas-combos');
  assert.strictEqual(typeof p.category.sortingPosition, 'number');
});

test('producto con tamanos: un item por tamano con precio de canal', () => {
  const m = construirMenuRappi(cat, { storeId: '1' });
  const chico = m.items.find(i => i.sku === 'cc200-el-chico');
  assert.strictEqual(chico.name, 'Latte (El Chico)');
  assert.strictEqual(chico.price, 55);
  assert.strictEqual(m.items.find(i => i.sku === 'cc200-el-mayor').price, 70);
});

test('solo se suben los productos activados explicitamente para Rappi', () => {
  const m = construirMenuRappi(cat, { storeId: '1' });
  assert.strictEqual(m.items.length, 3); // cc147 + 2 tamanos de Latte
  assert.ok(!m.items.find(i => i.sku === 'cc1' || i.sku === 'cc2'));
});

test('skusDeProducto y slug', () => {
  assert.deepStrictEqual(skusDeProducto(cat[0]), ['cc147']);
  assert.deepStrictEqual(skusDeProducto(cat[1]), ['cc200-el-chico', 'cc200-el-mayor']);
  assert.strictEqual(slug('Cafés Calientes'), 'cafes-calientes');
});
