// Convierte el payload del webhook NEW_ORDER de Rappi al formato interno
// de pedido que ya usa todo Luna Smart POS (pedidos/<suc>/<id>) -- el
// mismo que produce un pedido de pedidos.suenodeluna.com.mx, para que el
// POS no necesite saber nada especial de Rappi mas alla del campo
// canal:'rappi' (ver _formProductoPOS/pos.html, seccion "PEDIDOS DE
// RAPPI").
//
// OJO: los nombres de campo del lado "rappiOrder.*" son la mejor
// reconstruccion disponible a partir de la documentacion revisada (no se
// ha visto un payload real todavia). En cuanto llegue el primer webhook
// de verdad, hay que comparar contra esta funcion y ajustar los que no
// coincidan -- toda la logica de mapeo vive aqui, en un solo lugar, para
// que ese ajuste sea rapido y no haya que tocar nada mas.
const SEIS_MINUTOS_MS = 6 * 60 * 1000;

function mapearPedidoRappi(rappiOrder, catalogoSuc) {
  const catalogoPorId = {};
  (catalogoSuc || []).forEach(function (p) { catalogoPorId[p.id] = p; });

  const itemsRappi = rappiOrder.products || rappiOrder.items || [];
  const items = itemsRappi.map(function (it) {
    // Un SKU de producto con tamanos lleva sufijo ("cc200-el-chico") --
    // se quita para encontrar el producto base en nuestro catalogo; el
    // precio y nombre ya vienen correctos desde Rappi (son por variante).
    const skuBase = String(it.sku || it.id || '').split('-')[0];
    const prod = catalogoPorId[skuBase];
    return {
      id: skuBase,
      name: (prod && prod.name) || it.name || 'Producto Rappi',
      qty: it.quantity || it.qty || 1,
      price: it.unit_price != null ? it.unit_price : (it.price != null ? it.price : ((prod && prod.price) || 0)),
      note: it.remarks || it.notes || '',
      area: (prod && prod.area) || 'barra',
      size: null,
      listo: false,
      listoTs: null,
    };
  });

  const cliente = rappiOrder.client || rappiOrder.customer || {};
  const direccion = rappiOrder.delivery_address || rappiOrder.address || {};

  return {
    id: '#RP' + String(rappiOrder.order_id || rappiOrder.id || Date.now()).slice(-6).toUpperCase(),
    estado: 'pendienteRappi',
    tipo: 'domicilio',
    canal: 'rappi',
    rappiOrderId: String(rappiOrder.order_id || rappiOrder.id || ''),
    rappiDeadline: Date.now() + SEIS_MINUTOS_MS,
    cliente: {
      nombre: cliente.name || cliente.full_name || '',
      telefono: cliente.phone || cliente.phone_number || '',
      direccion: direccion.details || direccion.full_address || direccion.address || '',
      referencia: rappiOrder.special_instructions || direccion.comments || '',
    },
    items: items,
    total: rappiOrder.total != null ? rappiOrder.total : items.reduce(function (a, l) { return a + l.price * l.qty; }, 0),
    metodo: 'rappi',
    hora: new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }),
    _ts: Date.now(),
  };
}

module.exports = { mapearPedidoRappi, SEIS_MINUTOS_MS };
