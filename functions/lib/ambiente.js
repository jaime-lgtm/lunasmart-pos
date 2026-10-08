// Un solo interruptor entre PRUEBAS (DEV, el que usamos hoy) y PRODUCCION.
// Para pasar a produccion: RAPPI_AMBIENTE=prod en functions/.env, secretos nuevos
// (RAPPI_CLIENT_ID / RAPPI_CLIENT_SECRET) y volver a desplegar -- ver PRODUCCION_RAPPI.md.
// Los dominios de produccion se pueden corregir con variables de entorno si Rappi
// confirma otros distintos a los de la guia (dominio de pais de Mexico).
const PROD = process.env.RAPPI_AMBIENTE === 'prod';
const DOMINIO_PROD = process.env.RAPPI_DOMINIO || 'https://services.mxgrability.rappi.com';

module.exports = {
  PROD: PROD,
  NOMBRE: PROD ? 'prod' : 'dev',
  AUTH_BASE: process.env.RAPPI_AUTH_BASE || (PROD ? DOMINIO_PROD : 'https://api.dev.rappi.com'),
  ORDERS_BASE: process.env.RAPPI_API_BASE || (PROD ? DOMINIO_PROD : 'https://microservices.dev.rappi.com'),
  WEBHOOKS_BASE: process.env.RAPPI_WEBHOOKS_BASE || (PROD ? DOMINIO_PROD : 'https://api.dev.rappi.com'),
  PARTNERS_BASE: process.env.RAPPI_PARTNERS_BASE || (PROD ? 'https://login.partners.rappi.com' : 'https://login.partners.dev.rappi.com'),
};
