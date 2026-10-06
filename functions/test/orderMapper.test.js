const { test } = require('node:test');
const assert = require('node:assert');
const { mapearPedidoRappi, MOTIVOS_RECHAZO } = require('../lib/orderMapper');

const catalogo = [
  { id: 'cc147', name: 'Panchito el Osito', price: 249, area: 'barra' },
  { id: 'cc200', name: 'Latte', price: 55, area: 'cocina' },
];

// Formato real de NEW_ORDER (dev-portal.rappi.com): {order_detail, customer, store}
const pedidoRappi = {
  order_detail: {
    order_id: '1308613474',
    cooking_time: 12,
    delivery_method: 'delivery',
    payment_method: 'cc',
    place_at: null,
    delivery_information: null,
    totals: { total_order: 304.5, charges: { shipping: 30 } },
    items: [
      { sku: 'cc147', id: '729963', name: 'Panchito el Osito', type: 'product', comments: 'sin azúcar', price: 249, unit_price_with_discount: 240, quantity: 1,
        subitems: [{ sku: 'm1', id: '55', name: 'Leche de almendra', price: 10, quantity: 1 }] },
      { sku: 'cc200-el-chico', id: '729964', name: 'Latte (El Chico)', type: 'product', comments: '', price: 55, quantity: 1, subitems: [] },
    ],
  },
  customer: null,
  store: { internal_id: '900175250', external_id: '900175250', name: 'Tienda de pruebas' },
};

test('mapea un NEW_ORDER real al formato interno del POS', () => {
  const p = mapearPedidoRappi(pedidoRappi, catalogo);
  assert.strictEqual(p.estado, 'pendienteRappi');
  assert.strictEqual(p.canal, 'rappi');
  assert.strictEqual(p.tipo, 'domicilio');
  assert.strictEqual(p.rappiOrderId, '1308613474');
  assert.strictEqual(p.rappiCookingTime, 12);
  assert.strictEqual(p.total, 304.5);
  assert.ok(p.rappiDeadline > Date.now());
  assert.strictEqual(p.id, '#RP613474');
});

test('items: precio con descuento + toppings, area del catalogo, ids de Rappi', () => {
  const p = mapearPedidoRappi(pedidoRappi, catalogo);
  assert.strictEqual(p.items[0].price, 250); // 240 con descuento + 10 de topping
  assert.strictEqual(p.items[0].mods, 'Leche de almendra');
  assert.strictEqual(p.items[0].note, 'sin azúcar');
  assert.strictEqual(p.items[0].area, 'barra');
  assert.strictEqual(p.items[0].rappiItemId, '729963');
  assert.strictEqual(p.items[1].id, 'cc200'); // sku con sufijo de tamano -> producto base
  assert.strictEqual(p.items[1].area, 'cocina');
});

test('full delivery: customer y direccion en null no truenan', () => {
  const p = mapearPedidoRappi(pedidoRappi, catalogo);
  assert.strictEqual(p.cliente.nombre, 'Cliente Rappi');
  assert.strictEqual(p.cliente.direccion, '');
});

test('marketplace: usa los datos del cliente y la direccion', () => {
  const mk = JSON.parse(JSON.stringify(pedidoRappi));
  mk.customer = { first_name: 'Ana', last_name: 'López', phone_number: '8781234567' };
  mk.order_detail.delivery_information = { complete_address: 'Calle 1 #2. Roma', complement: 'portón verde' };
  const p = mapearPedidoRappi(mk, catalogo);
  assert.strictEqual(p.cliente.nombre, 'Ana López');
  assert.strictEqual(p.cliente.telefono, '8781234567');
  assert.strictEqual(p.cliente.direccion, 'Calle 1 #2. Roma');
  assert.strictEqual(p.cliente.referencia, 'portón verde');
});

test('producto que no esta en el catalogo no truena', () => {
  const x = JSON.parse(JSON.stringify(pedidoRappi));
  x.order_detail.items = [{ sku: 'desconocido', id: '1', name: 'Prueba 1', price: 100, quantity: 2 }];
  const p = mapearPedidoRappi(x, catalogo);
  assert.strictEqual(p.items[0].id, null);
  assert.strictEqual(p.items[0].name, 'Prueba 1');
  assert.strictEqual(p.items[0].area, 'barra');
});

test('motivos de rechazo: los de producto exigen indicar productos', () => {
  assert.strictEqual(MOTIVOS_RECHAZO.producto_agotado.cancelType, 'ITEM_OUT_OF_STOCK');
  assert.strictEqual(MOTIVOS_RECHAZO.producto_agotado.requiereItems, true);
  assert.strictEqual(MOTIVOS_RECHAZO.info_incompleta.requiereItems, false);
});
