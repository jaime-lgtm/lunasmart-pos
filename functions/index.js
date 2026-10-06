const { onRequest } = require('firebase-functions/v2/https');
const { onValueUpdated, onValueCreated, onValueWritten } = require('firebase-functions/v2/database');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const { firmaValida } = require('./lib/hmac');
const { mapearPedidoRappi, MOTIVOS_RECHAZO } = require('./lib/orderMapper');
const { obtenerTokenVigente } = require('./lib/token');
const { construirMenuRappi } = require('./lib/menu');
const { skusARappi, calcularDisponibilidadCompleta } = require('./lib/disponibilidad');
const rappiApi = require('./lib/rappiApi');

initializeApp();
const db = getDatabase();

const RAPPI_CLIENT_ID = defineSecret('RAPPI_CLIENT_ID');
const RAPPI_CLIENT_SECRET = defineSecret('RAPPI_CLIENT_SECRET');

// store_id de Rappi -> sucursal de Luna Smart POS. El 900175250 es la tienda
// de PRUEBAS (DEV) que Rappi asigno; sus pedidos de prueba caen en la
// sucursal "eventos" para no sonarle alarmas al mostrador real. Al pasar a
// produccion se agrega aqui el store_id real de Casa de la Cultura -> 'cafeteria'.
// store_id de Rappi -> { suc: sucursal del POS donde caen los pedidos y su
// corte, marca: negocio con el que se vende (= id de su catalogo en Firebase) }.
// Varias marcas pueden compartir sucursal (dark kitchen): Casa de la Cultura y
// Helfy Fu salen de un mismo punto de venta con un solo corte, y la marca
// distingue de cual tienda de Rappi llego cada pedido. prod:true = tiendas
// reales (no se registran webhooks DEV sobre ellas).
const TIENDAS_RAPPI = {
  '900175250':  { suc: 'eventos',   marca: 'eventos' },                  // tienda de PRUEBAS (DEV)
  '1923806519': { suc: 'cafeteria', marca: 'cafeteria', prod: true },    // Sueno de Luna Casa de la Cultura
  '1930016459': { suc: 'cafeteria', marca: 'helfy',     prod: true },    // Helfy Fu
};

const URL_WEBHOOK = 'https://us-central1-luna-smart-pos.cloudfunctions.net/rappiWebhook';
// Eventos que se registran en Rappi (cada uno lleva su propia URL y secreto).
const EVENTOS_WEBHOOK = ['NEW_ORDER', 'ORDER_EVENT_CANCEL', 'ORDER_OTHER_EVENT', 'MENU_APPROVED', 'MENU_REJECTED', 'PING', 'STORE_CONNECTIVITY'];

function _infoDeTienda(storeId) { return TIENDAS_RAPPI[String(storeId)] || null; }
function _sucursalDeTienda(storeId) { const t = _infoDeTienda(storeId); return t ? t.suc : null; }
// Tienda de Rappi que vende el catalogo <id> (el "ojito" de Disponibilidad y el
// envio de menu trabajan por catalogo, no por sucursal). Prefiere la real si hay dos.
// Solo cuenta las tiendas del ambiente activo (DEV por defecto; RAPPI_AMBIENTE=prod
// al pasar a produccion), para no usar un token DEV sobre una tienda real.
const AMBIENTE_PROD = process.env.RAPPI_AMBIENTE === 'prod';
function _tiendaDeSucursal(catalogoId) {
  return Object.keys(TIENDAS_RAPPI).find(function (k) { return TIENDAS_RAPPI[k].marca === catalogoId && !!TIENDAS_RAPPI[k].prod === AMBIENTE_PROD; }) || null;
}
async function _catalogoDe(suc) {
  const v = (await db.ref('catalogo/' + suc).once('value')).val() || {};
  return Object.keys(v).map(function (k) { return v[k]; });
}

async function _buscarPedido(suc, rappiOrderId) {
  const snap = await db.ref('pedidos/' + suc).orderByChild('rappiOrderId').equalTo(String(rappiOrderId)).once('value');
  const val = snap.val();
  if (!val) return null;
  const id = Object.keys(val)[0];
  return { id, ref: db.ref('pedidos/' + suc + '/' + id), pedido: val[id] };
}

/* ============================================================
   Webhook receptor. Rappi NO manda el tipo de evento en el cuerpo: cada
   evento se registra con su propia URL (aqui: .../rappiWebhook/<EVENTO>) y
   un secreto propio, guardado en rappiAuth/webhookSecrets/<EVENTO>. Cada
   request se valida con HMAC antes de mirar su contenido.
   ============================================================ */
exports.rappiWebhook = onRequest(async (req, res) => {
  const evento = String((req.path || '').split('/').filter(Boolean)[0] || '').toUpperCase();
  if (!evento) { res.status(404).send('falta el evento en la URL'); return; }

  const secreto = (await db.ref('rappiAuth/webhookSecrets/' + evento).once('value')).val();
  if (!firmaValida(req.rawBody, req.get('Rappi-Signature'), secreto)) {
    logger.warn('Webhook de Rappi con firma invalida o sin secreto configurado', { evento });
    res.status(401).send('firma invalida');
    return;
  }

  const cuerpo = req.body || {};
  logger.info('Webhook de Rappi recibido', { evento });
  try {
    switch (evento) {
      case 'PING':
        // Rappi pregunta cada ~3 min si la tienda esta disponible; si el
        // status no es "OK" la considera no disponible.
        res.status(200).json({ status: 'OK', description: 'Store on' });
        return;
      case 'NEW_ORDER':
        await _procesarNuevoPedido(cuerpo);
        break;
      case 'ORDER_EVENT_CANCEL':
        await _procesarCancelacion(cuerpo);
        break;
      case 'ORDER_OTHER_EVENT':
        await _procesarOtroEvento(cuerpo);
        break;
      case 'MENU_APPROVED':
      case 'MENU_REJECTED':
        await db.ref('rappiAuth/menuEstado/' + (cuerpo.store_id || 'x')).set({ evento, detalle: cuerpo, ts: Date.now() });
        break;
      case 'STORE_CONNECTIVITY':
        await db.ref('rappiAuth/conectividad/' + (cuerpo.external_store_id || 'x')).set({ enabled: cuerpo.enabled, message: cuerpo.message || '', ts: Date.now() });
        break;
      default:
        logger.info('Evento de Rappi sin manejador especifico', { evento });
    }
    res.status(200).json({ status: 'OK' });
  } catch (e) {
    logger.error('Error procesando webhook de Rappi', e);
    res.status(500).send('error interno');
  }
});

async function _procesarNuevoPedido(cuerpo) {
  const store = cuerpo.store || {};
  const info = _infoDeTienda(store.internal_id) || _infoDeTienda(store.external_id);
  if (!info) { logger.warn('NEW_ORDER de una tienda sin sucursal asignada', { store }); return; }
  const suc = info.suc;

  const orderId = String((cuerpo.order_detail || {}).order_id || '');
  if (orderId && await _buscarPedido(suc, orderId)) { logger.info('NEW_ORDER duplicado, se ignora', { orderId }); return; }

  const catSnap = await db.ref('catalogo/' + info.marca).once('value');
  const catalogoVal = catSnap.val() || {};
  const catalogo = Object.keys(catalogoVal).map(function (k) { return catalogoVal[k]; });

  const pedido = mapearPedidoRappi(cuerpo, catalogo, info.marca);
  await db.ref('pedidos/' + suc).push(pedido);
  logger.info('Pedido de Rappi creado en Firebase', { suc, rappiOrderId: pedido.rappiOrderId });
}

async function _procesarCancelacion(cuerpo) {
  const suc = _sucursalDeTienda(cuerpo.store_id);
  if (!suc || !cuerpo.order_id) return;
  const hallado = await _buscarPedido(suc, cuerpo.order_id);
  if (!hallado) { logger.warn('Cancelacion de Rappi para un pedido que no se encontro', { order_id: cuerpo.order_id }); return; }
  await hallado.ref.update({ estado: 'cancelado', rappiCancelEvento: cuerpo.event || '', estadoBarra: 'listo', estadoCocina: 'listo' });
  // Si ya se habia aceptado, su venta (turnoSales/<suc>/rappi_<pedido>) entro al
  // corte: se quita para que el turno no cuente dinero que Rappi no va a pagar.
  const ventaRef = db.ref('turnoSales/' + suc + '/rappi_' + hallado.id);
  if ((await ventaRef.once('value')).exists()) {
    await ventaRef.remove();
  } else if (hallado.pedido.estado === 'pagado') {
    // La venta ya salio en un corte cerrado: no hay turno del que restarla.
    await hallado.ref.update({ rappiCancelDespuesDeCorte: true });
    logger.warn('Rappi cancelo un pedido ya incluido en un corte cerrado', { suc, order_id: cuerpo.order_id });
  }
  logger.info('Pedido de Rappi cancelado por Rappi', { suc, order_id: cuerpo.order_id });
}

async function _procesarOtroEvento(cuerpo) {
  const suc = _sucursalDeTienda(cuerpo.store_id);
  if (!suc || !cuerpo.order_id) return;
  const hallado = await _buscarPedido(suc, cuerpo.order_id);
  if (!hallado) return;
  const info = cuerpo.additional_information || {};
  const upd = { rappiUltimoEvento: cuerpo.event || '', rappiUltimoEventoTs: Date.now() };
  if (info.courier_data) upd.rappiRepartidor = { nombre: info.courier_data.full_name || '', telefono: info.courier_data.phone || '' };
  if (info.eta_to_store != null) upd.rappiEtaTienda = info.eta_to_store;
  await hallado.ref.update(upd);
}

/* ============================================================
   Reacciona a las banderas que deja el POS (pos.html) al aceptar,
   rechazar o marcar listo un pedido de Rappi -- el POS nunca llama a la
   API de Rappi (no tiene el token), solo escribe aqui y esta funcion es
   quien de verdad le avisa a Rappi.
   ============================================================ */
exports.rappiAvisoProcesado = onValueWritten(
  { ref: '/pedidos/{suc}/{pedidoId}/avisoRappi', secrets: [RAPPI_CLIENT_ID, RAPPI_CLIENT_SECRET] },
  async (event) => {
    const aviso = event.data.after.val();
    if (!aviso || aviso === 'hecho') return;

    const { suc, pedidoId } = event.params;
    const ref = db.ref('pedidos/' + suc + '/' + pedidoId);
    const pedido = (await ref.once('value')).val();
    if (!pedido || !pedido.rappiOrderId) return;

    try {
      const token = await obtenerTokenVigente(db, RAPPI_CLIENT_ID.value().trim(), RAPPI_CLIENT_SECRET.value().trim());
      if (aviso === 'accept') {
        await rappiApi.tomarPedido(token, pedido.rappiOrderId, pedido.rappiCookingTime);
      } else if (aviso === 'reject') {
        const motivo = MOTIVOS_RECHAZO[pedido.avisoRappiMotivo] || MOTIVOS_RECHAZO.info_incompleta;
        const ids = Array.isArray(pedido.avisoRappiItems) ? pedido.avisoRappiItems : [];
        await rappiApi.rechazarPedido(token, pedido.rappiOrderId, { reason: motivo.texto, cancelType: motivo.cancelType, itemsIds: motivo.requiereItems ? ids : [] });
      } else if (aviso === 'ready') {
        // Rappi permite 3 llamadas por pedido: nunca mas de una desde aqui.
        if (pedido.rappiListoEnviado) { await ref.child('avisoRappi').set('hecho'); return; }
        await rappiApi.marcarListoParaRecoger(token, pedido.rappiOrderId);
        await ref.child('rappiListoEnviado').set(true);
      } else {
        return;
      }
      await ref.child('avisoRappi').set('hecho');
      logger.info('Aviso a Rappi enviado', { suc, pedidoId, aviso });
    } catch (e) {
      // No se marca "hecho" si de verdad fallo -- queda visible para revisar.
      logger.error('Error avisando a Rappi (' + aviso + ')', e);
      await ref.child('avisoRappiError').set(String(e.message || e).slice(0, 300));
    }
  }
);

/* ============================================================
   Tareas de administracion (registrar webhooks, probar login). Se piden
   escribiendo en rappiAdmin/solicitudes/<id> desde una sesion de admin
   (correo/contrasena -- las reglas de la base lo exigen) y el resultado
   queda en rappiAdmin/resultados/<id>.
   ============================================================ */
exports.rappiAdminSolicitud = onValueCreated(
  { ref: '/rappiAdmin/solicitudes/{id}', secrets: [RAPPI_CLIENT_ID, RAPPI_CLIENT_SECRET] },
  async (event) => {
    const sol = event.data.val() || {};
    const id = event.params.id;
    let resultado;
    try {
      const token = sol.accion === 'diagnostico' ? null : await obtenerTokenVigente(db, RAPPI_CLIENT_ID.value().trim(), RAPPI_CLIENT_SECRET.value().trim());
      if (sol.accion === 'diagnostico') {
        // Solo longitudes y codigos HTTP -- nunca los valores de los secretos.
        const idv = RAPPI_CLIENT_ID.value(), sv = RAPPI_CLIENT_SECRET.value();
        const info = { idLen: idv.length, secretLen: sv.length, idEspacios: idv !== idv.trim(), secretEspacios: sv !== sv.trim(), idInicio: idv.slice(0, 4) };
        const pruebas = {};
        for (const h of ['https://api.dev.rappi.com', 'https://microservices.dev.rappi.com']) {
          for (const ruta of ['/restaurants/auth/v1/token/login/integrations', '/restaurants/auth/v1/token/login/utils']) {
            try {
              const r = await fetch(h + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: idv.trim(), client_secret: sv.trim() }) });
              pruebas[(h.indexOf('microservices') >= 0 ? 'microservices' : 'api') + '_' + (ruta.indexOf('integrations') >= 0 ? 'integrations' : 'utils')] = r.status;
            } catch (e) { pruebas[(h.indexOf('microservices') >= 0 ? 'microservices' : 'api') + '_' + (ruta.indexOf('integrations') >= 0 ? 'integrations' : 'utils')] = 'error de red'; }
          }
        }
        resultado = { ok: true, info, pruebas };
      } else if (sol.accion === 'probarAuth') {
        resultado = { ok: true, mensaje: 'Login con Rappi correcto' };
      } else if (sol.accion === 'listarWebhooks') {
        resultado = { ok: true, webhooks: await rappiApi.listarWebhooks(token) };
      } else if (sol.accion === 'enviarMenu') {
        const suc = sol.suc || 'eventos';
        const tienda = sol.tienda || _tiendaDeSucursal(suc);
        if (!tienda) throw new Error('La sucursal ' + suc + ' no tiene tienda de Rappi asignada');
        const menu = construirMenuRappi(await _catalogoDe(suc), { storeId: tienda });
        if (sol.limite) menu.items = menu.items.slice(0, Number(sol.limite));
        if (!menu.items.length) throw new Error('Ningun producto de ' + suc + ' esta activado para Rappi en Catalogo POS');
        resultado = { ok: true, productos: menu.items.length, respuesta: await rappiApi.enviarMenu(token, menu) };
      } else if (sol.accion === 'estadoMenu') {
        resultado = { ok: true, estado: await rappiApi.estadoMenu(token, sol.tienda || _tiendaDeSucursal(sol.suc || 'eventos')) };
      } else if (sol.accion === 'listarTiendas') {
        resultado = { ok: true, tiendas: await rappiApi.listarTiendas(token) };
      } else if (sol.accion === 'tiendaAbierta') {
        resultado = { ok: true, respuesta: await rappiApi.habilitarTienda(token, sol.tienda || _tiendaDeSucursal(sol.suc || 'eventos'), sol.abierta !== false) };
      } else if (sol.accion === 'sincronizarDisponibilidad') {
        const suc = sol.suc || 'eventos';
        const agotados = (await db.ref('agotados/' + suc).once('value')).val() || {};
        const cambios = calcularDisponibilidadCompleta(agotados, await _catalogoDe(suc));
        resultado = { ok: true, apagados: cambios.turnOff.length, encendidos: cambios.turnOn.length, respuesta: await rappiApi.disponibilidadItems(token, sol.tienda || _tiendaDeSucursal(suc), cambios) };
      } else if (sol.accion === 'listarHorarios') {
        resultado = { ok: true, horarios: await rappiApi.listarHorarios(await rappiApi.obtenerTokenUtils(RAPPI_CLIENT_ID.value().trim(), RAPPI_CLIENT_SECRET.value().trim()), sol.tienda || _tiendaDeSucursal(sol.suc || 'eventos')) };
      } else if (sol.accion === 'crearHorario') {
        resultado = { ok: true, respuesta: await rappiApi.crearHorario(await rappiApi.obtenerTokenUtils(RAPPI_CLIENT_ID.value().trim(), RAPPI_CLIENT_SECRET.value().trim()), sol.tienda || _tiendaDeSucursal(sol.suc || 'eventos'), sol.dia, sol.inicio, sol.fin) };
      } else if (sol.accion === 'registrarWebhooks') {
        const tiendas = Object.keys(TIENDAS_RAPPI).filter(function (k) { return !!TIENDAS_RAPPI[k].prod === AMBIENTE_PROD; });
        const detalle = {};
        for (const ev of EVENTOS_WEBHOOK) {
          try {
            const r = await rappiApi.registrarWebhook(token, ev, URL_WEBHOOK + '/' + ev, tiendas);
            if (r && r.secret) await db.ref('rappiAuth/webhookSecrets/' + ev).set(r.secret);
            detalle[ev] = r && r.secret ? 'registrado (secreto guardado)' : 'respuesta sin secreto: ' + JSON.stringify(r).slice(0, 200);
          } catch (e) {
            const msg = String(e.message || e);
            if (msg.indexOf('406') >= 0 && /already|aready/.test(msg)) {
              // Ya estaba configurado (ej. desde el portal): se corrige la URL y se regenera el secreto.
              try {
                await rappiApi.cambiarUrlWebhook(token, ev, URL_WEBHOOK + '/' + ev, tiendas);
                const r2 = await rappiApi.resetSecretWebhook(token, ev);
                const secreto = r2 && (r2.secret || (r2.data && r2.data.secret));
                if (secreto) await db.ref('rappiAuth/webhookSecrets/' + ev).set(secreto);
                detalle[ev] = secreto ? 'ya existia: URL corregida y secreto regenerado' : 'URL corregida pero sin secreto en la respuesta: ' + JSON.stringify(r2).slice(0, 200);
              } catch (e2) { detalle[ev] = 'ERROR al corregir: ' + String(e2.message || e2).slice(0, 300); }
            } else {
              detalle[ev] = 'ERROR: ' + msg.slice(0, 300);
            }
          }
        }
        resultado = { ok: true, detalle };
      } else {
        resultado = { ok: false, error: 'accion desconocida: ' + sol.accion };
      }
    } catch (e) {
      logger.error('Error en tarea de administracion de Rappi', e);
      resultado = { ok: false, error: String(e.message || e).slice(0, 500) };
    }
    await db.ref('rappiAdmin/resultados/' + id).set(Object.assign({ ts: Date.now(), accion: sol.accion || '' }, resultado));
  }
);

/* ============================================================
   Disponibilidad: el "ojito" de Configuracion > Disponibilidad del POS
   (agotados/<suc>/<producto> = true) tambien oculta o muestra el producto en
   Rappi. Solo aplica a sucursales con tienda de Rappi y a productos activados
   para Rappi en Catalogo POS (los demas no existen en su menu).
   ============================================================ */
exports.rappiDisponibilidad = onValueWritten(
  { ref: '/agotados/{suc}/{prodId}', secrets: [RAPPI_CLIENT_ID, RAPPI_CLIENT_SECRET] },
  async (event) => {
    const { suc, prodId } = event.params;
    const tienda = _tiendaDeSucursal(suc);
    if (!tienda) return;
    const antes = event.data.before.exists(), ahora = event.data.after.exists();
    if (antes === ahora) return;
    const prod = (await db.ref('catalogo/' + suc + '/' + prodId).once('value')).val();
    const skus = prod ? skusARappi(prod) : [];
    if (!skus.length) return;
    try {
      const token = await obtenerTokenVigente(db, RAPPI_CLIENT_ID.value().trim(), RAPPI_CLIENT_SECRET.value().trim());
      await rappiApi.disponibilidadItems(token, tienda, ahora ? { turnOff: skus } : { turnOn: skus });
      logger.info('Disponibilidad actualizada en Rappi', { suc, prodId, disponible: !ahora });
    } catch (e) {
      // Se puede reconciliar despues con la accion "sincronizarDisponibilidad".
      logger.error('No se pudo actualizar la disponibilidad en Rappi', e);
      await db.ref('rappiAuth/disponibilidadPendiente/' + suc).set({ ts: Date.now(), error: String(e.message || e).slice(0, 200) });
    }
  }
);
