// Convierte el catalogo de una sucursal (catalogo/<suc> en Firebase, el que
// llena "Nuevo producto" del admin) al JSON de POST /menu de Rappi
// (formato de dev-portal.rappi.com: { storeId, items:[{category, name,
// description, sku, type:'PRODUCT', price, ...}] }).
//
// El SKU es el id del producto en Luna Smart (ej. "cc147"); en productos con
// tamanos, cada tamano es un producto aparte con SKU "<id>-<tamano>". Solo se
// suben los productos que el merchant activo para Rappi en Catalogo POS
// (canales.rappi.activo === true), igual que ya pasa con Uber/DiDi.
function slug(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function activoEnRappi(p) {
  return !!(p && p.canales && p.canales.rappi && p.canales.rappi.activo === true);
}

// SKUs que existen en Rappi para un producto (1, o uno por tamano).
function skusDeProducto(p) {
  if (p.sized) return Object.keys(p.prices || {}).map(function (size) { return p.id + '-' + slug(size); });
  return [p.id];
}

function construirMenuRappi(productos, opciones) {
  opciones = opciones || {};
  const activos = (productos || []).filter(activoEnRappi);

  // Posicion de cada categoria = orden de aparicion (alfabetico para que sea estable)
  const nombreCategoria = function (p) { return (p.sub ? (p.menu ? p.menu + ' - ' + p.sub : p.sub) : (p.menu || 'General')); };
  const categorias = Array.from(new Set(activos.map(nombreCategoria))).sort(function (a, b) { return a.localeCompare(b); });

  const items = [];
  activos.forEach(function (p, idx) {
    const cfg = p.canales.rappi;
    const nomCat = nombreCategoria(p);
    const categoria = { id: 'cat-' + slug(nomCat), name: nomCat, minQty: 0, maxQty: 0, sortingPosition: categorias.indexOf(nomCat) };
    const base = {
      description: p.desc || p.name,
      type: 'PRODUCT',
      category: categoria,
      children: [],
      sortingPosition: idx,
    };
    if (p.img) base.imageUrl = p.img;
    if (p.sized) {
      Object.keys(p.prices || {}).forEach(function (size) {
        const precioCanal = cfg.precios && cfg.precios[size];
        items.push(Object.assign({}, base, {
          sku: p.id + '-' + slug(size),
          name: p.name + ' (' + size + ')',
          price: Number(precioCanal != null ? precioCanal : p.prices[size]),
        }));
      });
    } else {
      items.push(Object.assign({}, base, {
        sku: p.id,
        name: p.name,
        price: Number(cfg.precio != null ? cfg.precio : p.price),
      }));
    }
  });

  return { storeId: String(opciones.storeId || ''), items: items };
}

module.exports = { construirMenuRappi, skusDeProducto, activoEnRappi, slug };
