// Convierte el webhook NEW_ORDER de Rappi ({order_detail, customer, store},
// el mismo formato de GET orders -- ver dev-portal.rappi.com) al pedido
// interno de Luna Smart POS (pedidos/<suc>/<id>) -- el mismo que ya produce
// pedidos.suenodeluna.com.mx, para que el POS solo necesite saber que
// canal es 'rappi' (ver pos.html, seccion "PEDIDOS DE RAPPI").
const SEIS_MINUTOS_MS = 6 * 60 * 1000;

function _num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

function mapearPedidoRappi(payload, catalogoSuc, marca) {
  payload = payload || {};
  const od = payload.order_detail || {};
  const cliente = payload.customer || {};
  const di = od.delivery_information || {};

  const catalogoPorId = {};
  (catalogoSuc || []).forEach(function (p) { catalogoPorId[p.id] = p; });

  const items = (od.items || []).map(function (it) {
    // El SKU que mandamos al subir el menu es el id del producto (con
    // sufijo "-tamano" en productos con tamanos) -- se quita para ubicar
    // el producto en nuestro catalogo y heredar su area (barra/cocina).
    const skuBase = String(it.sku || '').split('-')[0];
    const prod = catalogoPorId[skuBase];
    const subitems = it.subitems || [];
    const extras = subitems.reduce(function (a, s) { return a + _num(s.price) * (_num(s.quantity) || 1); }, 0);
    const precioBase = it.unit_price_with_discount != null ? _num(it.unit_price_with_discount) : _num(it.price);
    const comentario = Array.isArray(it.comments) ? it.comments.join(' ') : (it.comments || '');
    const subTxt = subitems.map(function (s) { return ((_num(s.quantity) || 1) > 1 ? s.quantity + 'x ' : '') + s.name; }).join(', ');
    return {
      id: prod ? skuBase : null,
      marca: marca || null,
      name: it.name || (prod && prod.name) || 'Producto Rappi',
      qty: _num(it.quantity) || 1,
      price: precioBase + extras,
      note: comentario,
      mods: subTxt,
      area: (prod && prod.area) || 'barra',
      size: null,
      rappiItemId: it.id != null ? String(it.id) : null,
      rappiSku: it.sku != null ? String(it.sku) : null,
      listo: false,
      listoTs: null,
    };
  });

  const orderId = String(od.order_id || '');
  const nombre = [cliente.first_name, cliente.last_name].filter(Boolean).join(' ');
  const totalOrden = od.totals && od.totals.total_order != null ? _num(od.totals.total_order) : null;

  return {
    id: '#RP' + (orderId.slice(-6) || String(Date.now()).slice(-6)).toUpperCase(),
    estado: 'pendienteRappi',
    tipo: 'domicilio',
    canal: 'rappi',
    marca: marca || null,
    rappiOrderId: orderId,
    rappiDeadline: Date.now() + SEIS_MINUTOS_MS,
    rappiCookingTime: _num(od.cooking_time) || 15,
    rappiDeliveryMethod: od.delivery_method || null,
    rappiPlaceAt: od.place_at || null,
    cliente: {
      // En "Full delivery" Rappi manda customer y direccion en null: el
      // repartidor es de Rappi y no hace falta contactar al cliente.
      nombre: nombre || 'Cliente Rappi',
      telefono: cliente.phone_number || '',
      direccion: di.complete_address || '',
      referencia: di.complement || '',
    },
    items: items,
    total: totalOrden != null ? totalOrden : items.reduce(function (a, l) { return a + l.price * l.qty; }, 0),
    metodo: 'rappi',
    hora: new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' }),
    _ts: Date.now(),
  };
}

// Motivos de rechazo del POS -> cancel_type de Rappi. Rappi no tiene motivos
// como "cerrado" o "saturado": solo estos. Los 3 primeros exigen indicar
// los productos afectados.
const MOTIVOS_RECHAZO = {
  producto_agotado: { cancelType: 'ITEM_OUT_OF_STOCK', requiereItems: true, texto: 'Producto agotado' },
  precio_incorrecto: { cancelType: 'ITEM_WRONG_PRICE', requiereItems: true, texto: 'Precio incorrecto de un producto' },
  producto_inexistente: { cancelType: 'ITEM_NOT_FOUND', requiereItems: true, texto: 'Producto no disponible en el menú' },
  info_incompleta: { cancelType: 'ORDER_MISSING_INFORMATION', requiereItems: false, texto: 'Información del pedido incompleta' },
  total_incorrecto: { cancelType: 'ORDER_TOTAL_INCORRECT', requiereItems: false, texto: 'Total del pedido incorrecto' },
};

module.exports = { mapearPedidoRappi, MOTIVOS_RECHAZO, SEIS_MINUTOS_MS };
