const { test } = require('node:test');
const assert = require('node:assert');
const { construirMenuRappi, validarMenu, skusDeProducto, slug } = require('../lib/menu');
const { gruposDe, tamanosDe, resolverSubitems, skuOpcion, skuTamano } = require('../lib/modificadores');
const { mapearPedidoRappi } = require('../lib/orderMapper');

const biblioteca = {
  mod01: { nombre: 'Tipo de leche', tipo: 'unico', obligatorio: false, opciones: [{ l: 'Entera', p: 0 }, { l: 'Almendra', p: 15 }] },
  mod12: { nombre: 'Shot extra', tipo: 'unico', obligatorio: false, opciones: [{ l: 'Sin shot extra', p: 0 }, { l: 'Espresso', p: 15, pRappi: 20 }] },
  mod06: { nombre: 'Como deseas la bebida', tipo: 'unico', obligatorio: true, opciones: [{ l: 'Helada', p: 0 }, { l: 'Caliente', p: 0 }, { l: 'Frappe', p: 0 }] },
  mod04: { nombre: 'Endulzante', tipo: 'cantidad', minCant: 0, maxCant: 2, opciones: [{ l: 'Stevia', p: 0 }, { l: 'Splenda', p: 0 }] },
};
const cat = [
  { id: 'cc147', name: 'Panchito', desc: 'Combo', menu: 'Bebidas', sub: 'Combos', price: 249, img: 'https://x/y.jpg', canales: { rappi: { activo: true, precio: 265 } } },
  { id: 'cc3', name: 'Cappuccino', menu: 'Bebidas', sub: 'Cafes', sized: true, prices: { 'El Chico': 60, 'El Mayor': 70 }, modAsignados: ['mod01', 'mod12'],
    modInv: { mod01: { 1: { 'El Chico': { modo: 'sustituye', quita: { articulo: 'LECHE ENTERA', cantidad: 150 }, pon: { articulo: 'LECHE ALMENDRA', cantidad: 150 } }, 'El Mayor': { modo: 'sustituye', quita: { articulo: 'LECHE ENTERA', cantidad: 195 }, pon: { articulo: 'LECHE ALMENDRA', cantidad: 195 } } } } },
    canales: { rappi: { activo: true, precios: { 'El Chico': 85, 'El Mayor': 100 } } } },
  { id: 'cc24', name: 'Te Negro', menu: 'Bebidas', sub: 'Tes', price: 90, modAsignados: ['mod06'], canales: { rappi: { activo: true, precio: 90, opcionesExcluir: { mod06: ['Frappe'] } } } },
  { id: 'cc120', name: 'Chai', menu: 'Bebidas', sub: 'Tes', price: 125, modAsignados: ['mod04', 'mod06'], canales: { rappi: { activo: true, precio: 125, modsExcluir: ['mod04'] } } },
  { id: 'cc1', name: 'Sin configurar', menu: 'Bebidas', price: 10 },
  { id: 'cc2', name: 'Apagado', menu: 'Bebidas', price: 10, canales: { rappi: { activo: false } } },
];

test('formato de POST /menu: storeId e items con category, sku, type, price y children', () => {
  const m = construirMenuRappi(cat, { storeId: 900175250, biblioteca });
  assert.strictEqual(m.storeId, '900175250');
  const p = m.items.find(i => i.sku === 'cc147');
  assert.strictEqual(p.type, 'PRODUCT');
  assert.strictEqual(p.price, 265);
  assert.strictEqual(p.imageUrl, 'https://x/y.jpg');
  assert.deepStrictEqual(p.children, []);
  assert.strictEqual(p.category.name, 'Combos');
  assert.strictEqual(p.category.id, 'cat-combos');
});

test('producto con tamanos: UN producto, precio del tamano chico y grupo "Elige Tamano" con la diferencia', () => {
  const m = construirMenuRappi(cat, { storeId: '1', biblioteca });
  const c = m.items.find(i => i.sku === 'cc3');
  assert.strictEqual(c.name, 'Cappuccino');
  assert.strictEqual(c.price, 85);
  const tam = c.children.filter(h => h.category.id === 'tam-cc3');
  assert.deepStrictEqual(tam.map(h => [h.name, h.price]), [['El Chico', 0], ['El Mayor', 15]]);
  assert.strictEqual(tam[0].category.minQty, 1);
  assert.strictEqual(tam[0].category.maxQty, 1);
  assert.strictEqual(tam[0].type, 'TOPPING');
});

test('modificadores del POS como toppings, con precio propio de Rappi y sin las opciones excluidas', () => {
  const m = construirMenuRappi(cat, { storeId: '1', biblioteca });
  const c = m.items.find(i => i.sku === 'cc3');
  const shot = c.children.find(h => h.sku === 'mod12-espresso');
  assert.strictEqual(shot.price, 20); // Rappi $20; el POS sigue en $15
  assert.strictEqual(c.children.find(h => h.sku === 'mod01-almendra').price, 15);
  const te = m.items.find(i => i.sku === 'cc24');
  assert.deepStrictEqual(te.children.map(h => h.name), ['Helada', 'Caliente']); // sin Frappe
  assert.strictEqual(te.children[0].category.minQty, 1); // obligatorio
  const chai = m.items.find(i => i.sku === 'cc120');
  assert.ok(!chai.children.some(h => h.category.id === 'mod-mod04')); // endulzante excluido
});

test('solo se suben los productos activados explicitamente para Rappi', () => {
  const m = construirMenuRappi(cat, { storeId: '1', biblioteca });
  assert.ok(!m.items.find(i => i.sku === 'cc1' || i.sku === 'cc2'));
  assert.strictEqual(m.items.length, 4);
});

test('validarMenu detecta SKU repetido con datos distintos y precios invalidos', () => {
  const m = construirMenuRappi(cat, { storeId: '1', biblioteca });
  assert.deepStrictEqual(validarMenu(m).errores, []);
  const malo = JSON.parse(JSON.stringify(m));
  malo.items[1].children.push(Object.assign({}, malo.items[1].children[2], { price: 99 }));
  malo.items[0].price = 0;
  const e = validarMenu(malo).errores.join(' | ');
  assert.match(e, /SKU repetido/);
  assert.match(e, /sin precio/);
});

test('skusDeProducto y slug', () => {
  assert.deepStrictEqual(skusDeProducto(cat[1]), ['cc3']);
  assert.strictEqual(slug('Cafés Calientes'), 'cafes-calientes');
});

test('pedido de Rappi: el tamano y las opciones descuentan inventario como en el POS', () => {
  const grupos = gruposDe(cat[1], biblioteca, 'rappi');
  const tam = tamanosDe(cat[1], 'rappi');
  const r = resolverSubitems([
    { sku: skuTamano(cat[1], 'El Mayor'), name: 'El Mayor', price: 15, quantity: 1 },
    { sku: skuOpcion(grupos[0], grupos[0].opciones[1]), name: 'Almendra', price: 15, quantity: 1 },
  ], cat[1], grupos, tam);
  assert.strictEqual(r.size, 'El Mayor');
  assert.deepStrictEqual(r.modDeltas, [{ articulo: 'LECHE ENTERA', cantidad: -195 }, { articulo: 'LECHE ALMENDRA', cantidad: 195 }]);
  assert.strictEqual(r.partes.join(' · '), 'El Mayor · Almendra');
  assert.strictEqual(r.extras, 30);
});

test('mapearPedidoRappi usa la biblioteca para tamano, texto y precio', () => {
  const payload = { order_detail: { order_id: '5', items: [{ id: 1, sku: 'cc3', name: 'Cappuccino', quantity: 2, unit_price_with_discount: 85,
    subitems: [{ sku: 'cc3-tam-el-mayor', name: 'El Mayor', price: 15, quantity: 1 }, { sku: 'mod12-espresso', name: 'Espresso', price: 20, quantity: 1 }] }], totals: { total_order: 240 } }, store: {} };
  const p = mapearPedidoRappi(payload, cat, 'cafeteria', biblioteca);
  assert.strictEqual(p.items[0].size, 'El Mayor');
  assert.strictEqual(p.items[0].mods, 'El Mayor · Espresso');
  assert.strictEqual(p.items[0].price, 120);
  assert.strictEqual(p.total, 240);
});

test('las categorias van sin el prefijo del menu y las repetidas se unen en una sola', () => {
  const prods = [
    { id: 'a1', name: 'Chilaquiles', menu: 'Alimentos', sub: 'Desayuno', price: 90, canales: { rappi: { activo: true } } },
    { id: 'a2', name: 'Combo comida', menu: 'Alimentos', sub: 'Combos', price: 150, canales: { rappi: { activo: true } } },
    { id: 'b1', name: 'Latte', menu: 'Bebidas', sub: 'Cafés Calientes', price: 60, canales: { rappi: { activo: true } } },
    { id: 'b2', name: 'Combo cafe', menu: 'Bebidas', sub: 'Combos', price: 99, canales: { rappi: { activo: true } } },
    { id: 'h1', name: 'Wrap', menu: 'Helfy Wraps', sub: '', price: 80, canales: { rappi: { activo: true } } },
  ];
  const m = construirMenuRappi(prods, { storeId: '1' });
  const cat = id => m.items.find(i => i.sku === id).category;
  assert.strictEqual(cat('a1').name, 'Desayuno');
  assert.strictEqual(cat('b1').name, 'Cafés Calientes');
  assert.strictEqual(cat('h1').name, 'Helfy Wraps');             // sin subcategoria: queda el nombre del menu
  assert.strictEqual(cat('a2').id, cat('b2').id);                  // "Combos" de los dos menus = una categoria
  assert.strictEqual(cat('a2').sortingPosition, cat('b2').sortingPosition);
  assert.ok(cat('a2').sortingPosition < cat('b1').sortingPosition); // Alimentos antes que Bebidas
});
