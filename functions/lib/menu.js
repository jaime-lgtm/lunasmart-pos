// Convierte el catalogo de una sucursal (tal como vive en catalogo/<suc>
// en Firebase, el mismo que llena el formulario "Nuevo producto" del
// admin) al formato que espera el endpoint POST /menu de Rappi -- el
// "mapeo automatico" que confirmaron en la reunion, sin pasar por el
// portal a mano.
//
// El SKU es el mismo id que ya usa Luna Smart POS (ej. "cc147"), asi no
// hace falta inventar ni mantener un mapeo aparte en otro lado.
//
// OJO: solo se sube un producto si el merchant lo activo explicitamente
// para Rappi (canales.rappi.activo === true) en el formulario de
// Catalogo POS -- igual que ya pasa con Uber Eats/DiDi, por defecto un
// producto nuevo NO se vende en delivery hasta que alguien lo prenda.
//
// Los nombres exactos de los campos del JSON de Rappi (sku, name, price,
// etc.) son los documentados en su guia de mapeo automatico -- hay que
// confirmarlos contra la respuesta real del sandbox en cuanto lleguen
// las credenciales, por si Rappi cambio algo desde que se reviso la
// documentacion.
function construirMenuRappi(productos, opciones) {
  opciones = opciones || {};
  const storeId = opciones.storeId || null;

  const activos = (productos || []).filter(function (p) {
    return !!(p && p.canales && p.canales.rappi && p.canales.rappi.activo === true);
  });

  const items = activos.map(function (p) {
    const cfgRappi = p.canales.rappi;
    if (p.sized) {
      // Un producto con tamanos se manda como una variante por tamano,
      // cada una con su propio SKU (id + sufijo del tamano), para que
      // Rappi pueda ofrecer ambos tamanos por separado en su app.
      return Object.keys(p.prices || {}).map(function (size) {
        const precioCanal = cfgRappi.precios && cfgRappi.precios[size];
        return {
          sku: p.id + '-' + _slug(size),
          name: p.name + ' (' + size + ')',
          description: p.desc || '',
          price: precioCanal != null ? precioCanal : p.prices[size],
          available: true,
          image_url: p.img || null,
          category: p.menu || 'General',
          subcategory: p.sub || null,
        };
      });
    }
    return [{
      sku: p.id,
      name: p.name,
      description: p.desc || '',
      price: cfgRappi.precio != null ? cfgRappi.precio : p.price,
      available: true,
      image_url: p.img || null,
      category: p.menu || 'General',
      subcategory: p.sub || null,
    }];
  });

  return { store_id: storeId, products: [].concat.apply([], items) };
}

function _slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

module.exports = { construirMenuRappi };
