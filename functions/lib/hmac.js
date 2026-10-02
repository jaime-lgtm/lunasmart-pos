const crypto = require('crypto');

// Rappi firma cada webhook con HMAC-SHA256 sobre el cuerpo crudo (sin
// parsear) y lo manda en el header "Rappi-Signature". Si no coincide, el
// request NO es de Rappi -- se rechaza sin procesar nada de su contenido
// (nunca hay que confiar en el body antes de validar esto).
function firmaValida(rawBody, firmaRecibida, secreto) {
  if (!rawBody || !firmaRecibida || !secreto) return false;
  const esperada = crypto.createHmac('sha256', secreto).update(rawBody).digest('hex');
  const bufEsperada = Buffer.from(esperada, 'utf8');
  const bufRecibida = Buffer.from(String(firmaRecibida), 'utf8');
  if (bufEsperada.length !== bufRecibida.length) return false;
  return crypto.timingSafeEqual(bufEsperada, bufRecibida);
}

module.exports = { firmaValida };
