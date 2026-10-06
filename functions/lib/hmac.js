const crypto = require('crypto');

// Rappi firma cada webhook con HMAC-SHA256. El header "Rappi-Signature" trae
// "t=<timestamp>,sign=<hex>"; lo que se firma es "<timestamp>.<cuerpo crudo>"
// usando como llave el secreto que Rappi devuelve al registrar ese webhook.
// Si no coincide, el request NO es de Rappi -- se rechaza sin procesar nada
// (nunca hay que confiar en el body antes de validar esto).
function parsearFirma(header) {
  const out = {};
  String(header || '').split(',').forEach(function (par) {
    const i = par.indexOf('=');
    if (i > 0) out[par.slice(0, i).trim()] = par.slice(i + 1).trim();
  });
  return out;
}

function firmaValida(rawBody, header, secreto) {
  if (!rawBody || !header || !secreto) return false;
  const p = parsearFirma(header);
  if (!p.t || !p.sign) return false;
  const esperada = crypto.createHmac('sha256', secreto).update(p.t + '.').update(rawBody).digest('hex');
  const bufEsperada = Buffer.from(esperada, 'utf8');
  const bufRecibida = Buffer.from(String(p.sign), 'utf8');
  if (bufEsperada.length !== bufRecibida.length) return false;
  return crypto.timingSafeEqual(bufEsperada, bufRecibida);
}

module.exports = { firmaValida, parsearFirma };
