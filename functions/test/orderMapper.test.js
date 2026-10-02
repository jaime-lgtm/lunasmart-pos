const { test } = require('node:test');
const assert = require('node:assert');
const { mapearPedidoRappi } = require('../lib/orderMapper');

const catalogoDePrueba = [
  { id: 'cc147', name: 'Panchito el Osito', price: 249, area: 'barra' },
  { id: 'cc200', name: 'Latte', price: 55, area: 'barra' },
];

test('mapea un pedido simple al formato interno del POS', () => {
  const rappiOrder = {
    order_id: 'RP-00012345',
    products: [{ sku: 'cc147', quantity: 1, unit_price: 265 }],
    client: { name: 'Juan Perez', phone: '8781234567' },
    delivery_address: { details: 'Calle Falsa 123', comments: 'Tocar timbre' },
    total: 265,
  };
  const pedido = mapearPedidoRappi(rappiOrder, catalogoDePrueba);

  assert.strictEqual(pedido.estado, 'pendienteRappi');
  assert.strictEqual(pedido.canal, 'rappi');
  assert.strictEqual(pedido.tipo, 'domicilio');
  assert.strictEqual(pedido.metodo, 'rappi');
  assert.strictEqual(pedido.rappiOrderId, 'RP-00012345');
  assert.strictEqual(pedido.items.length, 1);
  assert.strictEqual(pedido.items[0].id, 'cc147');
  assert.strictEqual(pedido.items[0].name, 'Panchito el Osito'); // toma el nombre del catalogo, no de Rappi
  assert.strictEqual(pedido.items[0].price, 265); // pero el precio si es el que mando Rappi
  assert.strictEqual(pedido.cliente.nombre, 'Juan Perez');
  assert.strictEqual(pedido.cliente.direccion, 'Calle Falsa 123');
  assert.strictEqual(pedido.total, 265);
  assert.ok(pedido.rappiDeadline > Date.now()); // el cronometro de 6 min ya quedo armado
});

test('un sku con sufijo de tamano se resuelve al producto base del catalogo', () => {
  const rappiOrder = {
    order_id: 'RP-999',
    products: [{ sku: 'cc200-el-chico', quantity: 2, unit_price: 55 }],
    client: {},
    delivery_address: {},
  };
  const pedido = mapearPedidoRappi(rappiOrder, catalogoDePrueba);
  assert.strictEqual(pedido.items[0].id, 'cc200');
  assert.strictEqual(pedido.items[0].name, 'Latte');
  assert.strictEqual(pedido.items[0].qty, 2);
});

test('si el total no viene explicito, se calcula sumando los items', () => {
  const rappiOrder = {
    order_id: 'RP-1',
    products: [{ sku: 'cc147', quantity: 2, unit_price: 100 }],
    client: {}, delivery_address: {},
  };
  const pedido = mapearPedidoRappi(rappiOrder, catalogoDePrueba);
  assert.strictEqual(pedido.total, 200);
});

test('un producto que no esta en el catalogo no truena -- usa lo que mando Rappi', () => {
  const rappiOrder = {
    order_id: 'RP-2',
    products: [{ sku: 'inexistente', quantity: 1, name: 'Producto fantasma', unit_price: 30 }],
    client: {}, delivery_address: {},
  };
  const pedido = mapearPedidoRappi(rappiOrder, catalogoDePrueba);
  assert.strictEqual(pedido.items[0].name, 'Producto fantasma');
  assert.strictEqual(pedido.items[0].area, 'barra'); // area por defecto
});
