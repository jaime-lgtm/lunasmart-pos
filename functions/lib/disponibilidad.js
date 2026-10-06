// Disponibilidad: el "ojito" del POS (agotados/<suc>/<productoId> = true) se
// refleja en Rappi -- un producto apagado en el POS se oculta tambien en la
// app de Rappi, y se vuelve a mostrar al prenderlo.
const { skusDeProducto, activoEnRappi } = require('./menu');

// Un producto no activado para Rappi no existe en su menu: no se manda nada.
function skusARappi(producto) {
  return activoEnRappi(producto) ? skusDeProducto(producto) : [];
}

// Calculo completo (para la sincronizacion manual): todo lo agotado se apaga,
// todo lo demas activo en Rappi se prende.
function calcularDisponibilidadCompleta(agotados, catalogo) {
  const apagar = [], encender = [];
  (catalogo || []).forEach(function (p) {
    const skus = skusARappi(p);
    if (!skus.length) return;
    ((agotados || {})[p.id] ? apagar : encender).push.apply((agotados || {})[p.id] ? apagar : encender, skus);
  });
  return { turnOff: apagar, turnOn: encender };
}

module.exports = { skusARappi, calcularDisponibilidadCompleta };
