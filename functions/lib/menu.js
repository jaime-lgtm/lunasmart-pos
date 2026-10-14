// Convierte el catalogo de una sucursal (catalogo/<suc> en Firebase, el que
// llena "Nuevo producto" del admin) al JSON de POST /menu de Rappi
// (formato de dev-portal.rappi.com: { storeId, items:[{category, name,
// description, sku, type:'PRODUCT', price, children:[toppings...]}] }).
//
// El SKU del producto es su id en Luna Smart (ej. "cc147"). Solo se suben los
// productos que el merchant activo para Rappi en Catalogo POS
// (canales.rappi.activo === true), igual que ya pasa con Uber/DiDi.
//
// Tamanos: como en el menu actual de Rappi, un producto con tamanos es UN solo
// producto (precio del tamano mas chico) con un grupo "Elige Tamano" cuyas
// opciones suman la diferencia de precio. Modificadores: los mismos del POS
// (ver lib/modificadores.js) como toppings; Rappi permite 2 niveles maximo.
const { slug, gruposDe, tamanosDe, skuTamano, skuOpcion } = require('./modificadores');

function activoEnRappi(p) {
  return !!(p && p.canales && p.canales.rappi && p.canales.rappi.activo === true);
}

// En Rappi cada producto es un solo SKU (los tamanos son un grupo de toppings).
function skusDeProducto(p) { return [p.id]; }

function _topping(grupo, nombre, sku, precio, maxLimit, orden) {
  return { category: grupo, name: nombre, price: precio, sku: sku, maxLimit: maxLimit, sortingPosition: orden, type: 'TOPPING' };
}

function _hijos(p, biblioteca, precioBase) {
  const hijos = [];
  const tamanos = tamanosDe(p, 'rappi');
  if (tamanos.length > 1) {
    const cat = { id: 'tam-' + p.id, name: 'Elige Tamaño', minQty: 1, maxQty: 1, sortingPosition: 0 };
    tamanos.forEach(function (t, i) { hijos.push(_topping(cat, t.nombre, skuTamano(p, t.nombre), t.precio - precioBase, 1, i)); });
  }
  gruposDe(p, biblioteca, 'rappi').forEach(function (g, gi) {
    const n = g.opciones.length;
    let minQty, maxQty, maxLimit;
    if (g.tipo === 'distribuir') { minQty = g.min; maxQty = Math.max(g.max, g.min); maxLimit = maxQty; }
    else if (g.tipo === 'multi') { minQty = g.req ? 1 : 0; maxQty = n; maxLimit = 1; }
    else { minQty = g.req ? 1 : 0; maxQty = 1; maxLimit = 1; }
    const cat = { id: 'mod-' + g.id, name: g.nombre, minQty: minQty, maxQty: maxQty, sortingPosition: gi + 1 };
    g.opciones.forEach(function (o, i) { hijos.push(_topping(cat, o.label, skuOpcion(g, o), o.precio, maxLimit, i)); });
  });
  return hijos;
}

function construirMenuRappi(productos, opciones) {
  opciones = opciones || {};
  const biblioteca = opciones.biblioteca || {};
  const activos = (productos || []).filter(activoEnRappi);

  // La categoria en Rappi se llama como la subcategoria del POS ("Desayuno", "Postres", "Cafés Calientes"...),
  // sin el prefijo del menu ("Alimentos - ..."). Si una subcategoria se repite en dos menus (ej. "Combos") queda
  // una sola categoria. El ORDEN sigue agrupado por menu y luego alfabetico, para que sea estable.
  const nombreCategoria = function (p) { return p.sub ? p.sub : (p.menu || 'General'); };
  const claveOrden = function (p) { return (p.menu || '') + ' - ' + (p.sub || ''); };
  const categorias = [];
  activos.slice().sort(function (a, b) { return claveOrden(a).localeCompare(claveOrden(b)); }).forEach(function (p) {
    const n = nombreCategoria(p); if (categorias.indexOf(n) < 0) categorias.push(n);
  });

  const items = activos.map(function (p, idx) {
    const cfg = p.canales.rappi;
    const nomCat = nombreCategoria(p);
    const tamanos = tamanosDe(p, 'rappi');
    const precioBase = tamanos.length ? tamanos[0].precio : Number(cfg.precio != null ? cfg.precio : p.price);
    const item = {
      description: p.desc || p.name,
      type: 'PRODUCT',
      category: { id: 'cat-' + slug(nomCat), name: nomCat, minQty: 0, maxQty: 0, sortingPosition: categorias.indexOf(nomCat) },
      children: _hijos(p, biblioteca, precioBase),
      sortingPosition: idx,
      sku: p.id,
      name: p.name,
      price: precioBase,
    };
    if (p.img) item.imageUrl = p.img;
    return item;
  });
  return { storeId: String(opciones.storeId || ''), items: items };
}

// Revisa el menu contra las reglas publicadas por Rappi ANTES de enviarlo, para no
// mandar algo que va a rechazar. Devuelve { errores:[], advertencias:[] }.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
function validarMenu(menu) {
  const errores = [], advertencias = [];
  const porSku = {}, porCategoria = {};
  (menu.items || []).forEach(function (it) {
    (porCategoria[it.category.id] = porCategoria[it.category.id] || []).push(it);
    if (!(it.price > 0)) errores.push('Producto sin precio: ' + it.name);
    if (!it.sku) errores.push('Producto sin SKU: ' + it.name);
    [it.name, it.description].forEach(function (t) { if (EMOJI.test(t || '')) errores.push('Emoji en el texto de ' + it.name); });
    if (it.imageUrl && !/^https:\/\/\S+$/.test(it.imageUrl)) errores.push('Foto invalida en ' + it.name);
    if (!it.imageUrl) advertencias.push('Sin foto: ' + it.name);
    if (it.children.length > 50) errores.push(it.name + ' tiene ' + it.children.length + ' modificadores (maximo 50)');
    const reg = function (x, ctx) {
      const firma = JSON.stringify([x.name, x.price, x.type === 'TOPPING' ? x.maxLimit : null]);
      if (porSku[x.sku] && porSku[x.sku].firma !== firma) errores.push('SKU repetido con datos distintos: ' + x.sku + ' (' + ctx + ' y ' + porSku[x.sku].ctx + ')');
      else porSku[x.sku] = { firma: firma, ctx: ctx };
    };
    reg(it, it.name);
    const cats = {};
    it.children.forEach(function (c) {
      if (c.type !== 'TOPPING') errores.push('Un modificador debe ser TOPPING: ' + c.name);
      if (c.children && c.children.length) errores.push('Modificadores anidados (maximo 2 niveles): ' + c.name);
      if (c.maxLimit > c.category.maxQty) errores.push('Limite de ' + c.name + ' mayor al de su grupo en ' + it.name);
      if (EMOJI.test(c.name || '')) errores.push('Emoji en el modificador ' + c.name);
      reg(c, it.name);
      (cats[c.category.id] = cats[c.category.id] || []).push(c);
    });
    Object.keys(cats).forEach(function (k) { if (cats[k].length > 50) errores.push('Grupo con mas de 50 opciones en ' + it.name); });
  });
  Object.keys(porCategoria).forEach(function (k) { if (porCategoria[k].length > 50) errores.push('La categoria ' + porCategoria[k][0].category.name + ' tiene ' + porCategoria[k].length + ' productos (maximo 50)'); });
  return { errores: errores, advertencias: advertencias };
}

module.exports = { construirMenuRappi, validarMenu, skusDeProducto, activoEnRappi, slug };
