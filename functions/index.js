const { onRequest } = require('firebase-functions/v2/https');
const { onValueUpdated } = require('firebase-functions/v2/database');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const { firmaValida } = require('./lib/hmac');
const { construirMenuRappi } = require('./lib/menu');
const { mapearPedidoRappi } = require('./lib/orderMapper');
const { obtenerTokenVigente } = require('./lib/token');
const rappiApi = require('./lib/rappiApi');

initializeApp();
const db = getDatabase();

const RAPPI_CLIENT_ID = defineSecret('RAPPI_CLIENT_ID');
const RAPPI_CLIENT_SECRET = defineSecret('RAPPI_CLIENT_SECRET');
const RAPPI_WEBHOOK_SECRET = defineSecret('RAPPI_WEBHOOK_SECRET');

// Mapa sucursal Luna Smart <-> store_id que Rappi asigna por tienda. Se
// completa cuando Rappi confirme el store_id de cada sucursal conectada
// -- hoy solo aplicaria a Casa de la Cultura ("cafeteria"), que es la
// unica en proceso de conectarse.
const SUCURSAL_POR_STORE_ID = {
  // 'STORE_ID_QUE_DE_RAPPI': 'cafeteria',
};

// Mientras solo haya una sucursal conectada a Rappi, esta es la lista
// donde se busca un pedido por rappiOrderId (ej. al llegar una
// cancelacion). Agregar aqui cuando se conecte otra sucursal.
const SUCURSALES_CONECTADAS_RAPPI = ['cafeteria'];

/* ============================================================
   Webhook receptor -- aqui llega TODO lo que manda Rappi: pedidos
   nuevos, cancelaciones, el PING cada 3 minutos, aprobacion de menu,
   etc. Rappi firma cada request con HMAC-SHA256 (header
   Rappi-Signature) -- si no coincide, se rechaza sin mirar el contenido.
   ============================================================ */
exports.rappiWebhook = onRequest(
  { secrets: [RAPPI_WEBHOOK_SECRET] },
  async (req, res) => {
    const firmaOk = firmaValida(req.rawBody, req.get('Rappi-Signature'), RAPPI_WEBHOOK_SECRET.value());
    if (!firmaOk) {
      logger.warn('Webhook de Rappi con firma invalida -- se ignora');
      res.status(401).send('firma invalida');
      return;
    }

    const evento = req.body || {};
    const tipo = evento.type || evento.event;
    logger.info('Webhook de Rappi recibido', { tipo });

    try {
      switch (tipo) {
        case 'PING':
          // Rappi espera exactamente esto cada ~3 min -- si no se
          // contesta a tiempo, puede desconectar la tienda.
          res.status(200).json({ status: 'OK' });
          return;
        case 'NEW_ORDER':
          await _procesarNuevoPedido(evento);
          break;
        case 'ORDER_EVENT_CANCEL':
          await _procesarCancelacion(evento);
          break;
        case 'MENU_APPROVED':
        case 'MENU_REJECTED':
          await db.ref('rappiMenuEstado').set({ tipo, detalle: evento, ts: Date.now() });
          break;
        default:
          logger.info('Evento de Rappi sin manejador especifico', { tipo });
      }
      res.status(200).json({ status: 'OK' });
    } catch (e) {
      logger.error('Error procesando webhook de Rappi', e);
      res.status(500).send('error interno');
    }
  }
);

async function _procesarNuevoPedido(evento) {
  const storeId = evento.store_id || (evento.data && evento.data.store_id);
  const suc = SUCURSAL_POR_STORE_ID[storeId] || 'cafeteria'; // fallback mientras solo hay una tienda conectada
  const rappiOrder = evento.data || evento.order || evento;

  const catSnap = await db.ref('catalogo/' + suc).once('value');
  const catalogoVal = catSnap.val() || {};
  const catalogo = Object.keys(catalogoVal).map(function (k) { return catalogoVal[k]; });

  const pedido = mapearPedidoRappi(rappiOrder, catalogo);
  await db.ref('pedidos/' + suc).push(pedido);
  logger.info('Pedido de Rappi creado en Firebase', { suc, rappiOrderId: pedido.rappiOrderId });
}

async function _procesarCancelacion(evento) {
  const rappiOrderId = String((evento.data && evento.data.order_id) || evento.order_id || '');
  if (!rappiOrderId) return;
  for (const suc of SUCURSALES_CONECTADAS_RAPPI) {
    // Nota: una busqueda por rappiOrderId en una sucursal con muchos
    // pedidos activos se beneficia de un indice (.indexOn en las reglas
    // de Firebase) -- sin el, Firebase igual funciona pero avisa en el
    // log que seria mas eficiente con uno.
    const snap = await db.ref('pedidos/' + suc).orderByChild('rappiOrderId').equalTo(rappiOrderId).once('value');
    const val = snap.val();
    if (val) {
      const pedidoId = Object.keys(val)[0];
      await db.ref('pedidos/' + suc + '/' + pedidoId).update({ estado: 'cancelado' });
      logger.info('Pedido de Rappi cancelado por Rappi', { suc, rappiOrderId });
      return;
    }
  }
  logger.warn('Cancelacion de Rappi para un pedido que no se encontro', { rappiOrderId });
}

/* ============================================================
   Reacciona a las banderas que deja el POS (pos.html) al aceptar,
   rechazar o marcar listo un pedido de Rappi -- el POS nunca llama a la
   API de Rappi directamente (no tiene el token), solo escribe aqui y
   esta funcion es quien de verdad le avisa a Rappi.
   ============================================================ */
exports.rappiAvisoProcesado = onValueUpdated(
  { ref: '/pedidos/{suc}/{pedidoId}/avisoRappi', secrets: [RAPPI_CLIENT_ID, RAPPI_CLIENT_SECRET] },
  async (event) => {
    const aviso = event.data.after.val();
    if (!aviso || aviso === 'hecho') return; // ya procesado o se borro la bandera

    const { suc, pedidoId } = event.params;
    const pedidoSnap = await db.ref('pedidos/' + suc + '/' + pedidoId).once('value');
    const pedido = pedidoSnap.val();
    if (!pedido || !pedido.rappiOrderId) return;

    try {
      const token = await obtenerTokenVigente(db, RAPPI_CLIENT_ID.value(), RAPPI_CLIENT_SECRET.value());
      if (aviso === 'accept') {
        await rappiApi.aceptarPedido(token, pedido.rappiOrderId);
      } else if (aviso === 'reject') {
        await rappiApi.rechazarPedido(token, pedido.rappiOrderId, pedido.avisoRappiMotivo);
      } else if (aviso === 'ready') {
        await rappiApi.marcarListoParaRecoger(token, pedido.rappiOrderId);
      } else {
        return;
      }
      await db.ref('pedidos/' + suc + '/' + pedidoId + '/avisoRappi').set('hecho');
      logger.info('Aviso a Rappi enviado', { suc, pedidoId, aviso });
    } catch (e) {
      // No se marca "hecho" si de verdad fallo -- asi queda visible para
      // reintentar o revisar a mano en vez de perderse en silencio.
      logger.error('Error avisando a Rappi (' + aviso + ')', e);
    }
  }
);

/* ============================================================
   Sincroniza el menu de una sucursal con Rappi. Se dispara a mano por
   ahora (llamando esta URL), no en cada cambio del catalogo -- asi no se
   satura la API de Rappi con una llamada por cada edicion pequena. Mas
   adelante se puede agregar un boton en el admin que la llame, o un
   cron diario.
   ============================================================ */
exports.rappiSincronizarMenu = onRequest(
  // invoker:'private' -- solo quien tenga permisos de Google Cloud puede
  // llamarla; sin esto cualquiera con la URL podria disparar subidas de
  // menu a Rappi (el webhook, en cambio, si debe ser publico porque lo
  // llama Rappi, y se protege con la firma HMAC).
  { secrets: [RAPPI_CLIENT_ID, RAPPI_CLIENT_SECRET], invoker: 'private' },
  async (req, res) => {
    const suc = req.query.suc || 'cafeteria';
    const storeId = Object.keys(SUCURSAL_POR_STORE_ID).find(function (k) { return SUCURSAL_POR_STORE_ID[k] === suc; });
    if (!storeId) {
      res.status(400).json({ ok: false, error: 'No hay store_id de Rappi registrado para la sucursal "' + suc + '"' });
      return;
    }
    try {
      const catSnap = await db.ref('catalogo/' + suc).once('value');
      const catalogoVal = catSnap.val() || {};
      const catalogo = Object.keys(catalogoVal).map(function (k) { return catalogoVal[k]; });
      const menu = construirMenuRappi(catalogo, { storeId });

      const token = await obtenerTokenVigente(db, RAPPI_CLIENT_ID.value(), RAPPI_CLIENT_SECRET.value());
      await rappiApi.subirMenu(token, storeId, menu);

      res.status(200).json({ ok: true, productos: menu.products.length });
    } catch (e) {
      logger.error('Error sincronizando menu con Rappi', e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }
);
