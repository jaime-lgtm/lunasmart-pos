// Modificadores del POS <-> toppings de Rappi.
//
// El POS tiene dos fuentes de modificadores por producto:
//   - la biblioteca compartida (modificadores/<sucursal>/<modX>, asignada en p.modAsignados)
//   - modificadores propios del producto (p.mods)
// Rappi los recibe como "toppings" dentro de `children` del producto (maximo 2 niveles),
// y cuando llega un pedido, cada seleccion viene como un subitem con el mismo SKU. Este
// modulo hace las dos conversiones y usa el MISMO calculo de inventario que el POS
// (p.modInv: efecto por opcion y por tamano) para que un pedido de Rappi descuente
// exactamente lo mismo que una venta de mostrador.
//
// Ajustes propios de Rappi (no cambian lo que se vende en mostrador):
//   - opcion.pRappi            precio de esa opcion SOLO en Rappi (ej. shot extra $20 vs $15)
//   - canales.rappi.modsExcluir        ids de modificadores que NO se envian a Rappi
//   - canales.rappi.opcionesExcluir    { modId: ['Frappe'] } opciones que NO se envian a Rappi
const TIPO_A_UI = { unico: 'single', multiple: 'multi', cantidad: 'distribuir' };

function slug(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function _norm(s) { return slug(s); }

function _grupo(id, nombre, tipo, req, min, max, opciones) {
  return { id: id, nombre: nombre, tipo: tipo, req: !!req, min: min, max: max, opciones: opciones };
}

// Grupos de modificadores de un producto, ya filtrados para el canal indicado.
function gruposDe(p, biblioteca, canal) {
  const lib = biblioteca || {};
  const cfg = (((p || {}).canales || {})[canal]) || {};
  const excluidos = cfg.modsExcluir || [];
  const opcionesExcluidas = cfg.opcionesExcluir || {};
  const grupos = [];

  function opciones(modId, lista, esPropio) {
    const quitar = (opcionesExcluidas[modId] || []).map(_norm);
    const out = [];
    (lista || []).forEach(function (o, i) {
      const label = o.l;
      if (quitar.indexOf(_norm(label)) >= 0) return;
      const precioCanal = (canal === 'rappi' && o.pRappi != null) ? Number(o.pRappi) : Number(o.p || 0);
      const inv = esPropio ? o.inv : (p.modInv && p.modInv[modId] && p.modInv[modId][i]) || undefined;
      out.push({ label: label, precio: precioCanal, inv: inv, idx: i });
    });
    return out;
  }

  (p.modAsignados || []).forEach(function (modId) {
    const m = lib[modId];
    if (!m || excluidos.indexOf(modId) >= 0) return;
    const tipo = TIPO_A_UI[m.tipo] || 'single';
    const ops = opciones(modId, m.opciones, false);
    if (!ops.length) return;
    grupos.push(_grupo(modId, m.nombre, tipo, m.obligatorio, tipo === 'distribuir' ? (m.minCant || 0) : null, tipo === 'distribuir' ? (m.maxCant || ops.length) : null, ops));
  });
  (p.mods || []).forEach(function (g, gi) {
    const modId = p.id + '-m' + gi;
    if (excluidos.indexOf(modId) >= 0) return;
    const ops = opciones(modId, g.opts, true);
    if (!ops.length) return;
    const tipo = g.type || 'single';
    grupos.push(_grupo(modId, g.label, tipo, g.req, tipo === 'distribuir' ? (typeof g.min === 'number' ? g.min : 0) : null, tipo === 'distribuir' ? (typeof g.max === 'number' ? g.max : ops.length) : null, ops));
  });
  return grupos;
}

// Tamanos de un producto con tamanos, del mas chico (precio base) al mas grande.
function tamanosDe(p, canal) {
  if (!p || !p.sized) return [];
  const cfg = (((p.canales || {})[canal]) || {});
  const precios = (canal === 'rappi' && cfg.precios) || p.prices || {};
  return Object.keys(precios).map(function (n) { return { nombre: n, precio: Number(precios[n]) }; })
    .sort(function (a, b) { return a.precio - b.precio; });
}

function skuTamano(p, nombre) { return p.id + '-tam-' + slug(nombre); }
function skuOpcion(grupo, opcion) { return grupo.id + '-' + slug(opcion.label); }

// SKU del subitem -> que significa (tamano u opcion de un grupo).
function indexarSkus(p, grupos, tamanos) {
  const idx = {};
  (tamanos || []).forEach(function (t) { idx[skuTamano(p, t.nombre)] = { tipo: 'tamano', tamano: t.nombre }; });
  (grupos || []).forEach(function (g) {
    g.opciones.forEach(function (o) { idx[skuOpcion(g, o)] = { tipo: 'opcion', grupo: g, opcion: o }; });
  });
  return idx;
}

// Misma regla que confirmMods() del POS: agrega / quita / sustituye ingredientes.
function _deltasDeOpcion(opcion, tamano, p, multiplicador, destino) {
  if (!opcion || !opcion.inv) return;
  const inv = opcion.inv[p.sized ? tamano : '__default__'];
  if (!inv) return;
  if (inv.modo === 'agrega' && inv.agrega) destino.push({ articulo: inv.agrega.articulo, cantidad: inv.agrega.cantidad * multiplicador });
  else if (inv.modo === 'quita' && inv.quita) destino.push({ articulo: inv.quita.articulo, cantidad: -inv.quita.cantidad * multiplicador });
  else if (inv.modo === 'sustituye' && inv.quita && inv.pon) {
    destino.push({ articulo: inv.quita.articulo, cantidad: -inv.quita.cantidad * multiplicador });
    destino.push({ articulo: inv.pon.articulo, cantidad: inv.pon.cantidad * multiplicador });
  }
}

// Subitems de un pedido de Rappi -> { size, partes, modDeltas, extras, sinResolver }.
function resolverSubitems(subitems, p, grupos, tamanos) {
  const idx = indexarSkus(p, grupos, tamanos);
  const res = { size: null, partes: [], modDeltas: [], extras: 0, sinResolver: [] };
  const lista = subitems || [];
  // El tamano primero: de el depende el inventario de cada opcion.
  lista.forEach(function (s) { const r = idx[String(s.sku)]; if (r && r.tipo === 'tamano') res.size = r.tamano; });
  if (!res.size && p && p.sized && tamanos && tamanos.length) res.size = tamanos[0].nombre; // sin seleccion = el base
  if (res.size) res.partes.push(res.size);
  lista.forEach(function (s) {
    const cant = Number(s.quantity) || 1;
    res.extras += (Number(s.price) || 0) * cant;
    const r = idx[String(s.sku)];
    if (r && r.tipo === 'tamano') return;
    if (r && r.tipo === 'opcion') {
      res.partes.push((cant > 1 ? cant + ' ' : '') + r.opcion.label);
      _deltasDeOpcion(r.opcion, res.size, p, cant, res.modDeltas);
    } else {
      res.partes.push((cant > 1 ? cant + 'x ' : '') + (s.name || ''));
      res.sinResolver.push(s.name || s.sku);
    }
  });
  return res;
}

module.exports = { slug, gruposDe, tamanosDe, skuTamano, skuOpcion, indexarSkus, resolverSubitems };
