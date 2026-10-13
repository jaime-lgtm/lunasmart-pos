const { onRequest } = require('firebase-functions/v2/https');
const { onValueUpdated, onValueCreated, onValueWritten } = require('firebase-functions/v2/database');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase, ServerValue } = require('firebase-admin/database');

const { firmaValida } = require('./lib/hmac');
const { mapearPedidoRappi, MOTIVOS_RECHAZO } = require('./lib/orderMapper');
const { obtenerTokenVigente } = require('./lib/token');
const { construirMenuRappi, validarMenu } = require('./lib/menu');
const { skusARappi, calcularDisponibilidadCompleta } = require('./lib/disponibilidad');
const rappiApi = require('./lib/rappiApi');
const pkce = require('./lib/pkce');
const publico = require('./lib/publico');
const analitica = require('./lib/analitica');
const amb = require('./lib/ambiente');
const crypto = require('crypto');

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
const AMBIENTE_PROD = amb.PROD;
function _tiendaDeSucursal(catalogoId) {
  return Object.keys(TIENDAS_RAPPI).find(function (k) { return TIENDAS_RAPPI[k].marca === catalogoId && !!TIENDAS_RAPPI[k].prod === AMBIENTE_PROD; }) || null;
}
async function _bibliotecaDe(suc) { return (await db.ref('modificadores/' + suc).once('value')).val() || {}; }
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
      case 'STORE_PROVISIONING_STATUS':
        // Resultado (asincrono) de aprovisionar/dar de baja tiendas por Self Onboarding.
        await db.ref('rappiAuth/onboarding/resultados/' + String(cuerpo.batchId || Date.now()).replace(/[.#$\[\]\/]/g, '_')).set(Object.assign({ recibido: Date.now() }, cuerpo));
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

  const pedido = mapearPedidoRappi(cuerpo, catalogo, info.marca, await _bibliotecaDe(info.marca));
  pedido.rappiStoreId = String(store.internal_id || store.external_id || '');
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
      } else if (sol.accion === 'estadoIntegracion') {
        // Para el panel del admin: ambiente activo y las tiendas que le corresponden.
        const tiendas = Object.keys(TIENDAS_RAPPI).filter(function (k) { return !!TIENDAS_RAPPI[k].prod === AMBIENTE_PROD; })
          .map(function (k) { return { tienda: k, suc: TIENDAS_RAPPI[k].suc, marca: TIENDAS_RAPPI[k].marca }; });
        resultado = { ok: true, ambiente: amb.NOMBRE, tiendas: tiendas, login: true };
      } else if (sol.accion === 'probarAuth') {
        resultado = { ok: true, mensaje: 'Login con Rappi correcto' };
      } else if (sol.accion === 'listarWebhooks') {
        resultado = { ok: true, webhooks: await rappiApi.listarWebhooks(token) };
      } else if (sol.accion === 'enviarMenu' || sol.accion === 'previsualizarMenu') {
        const suc = sol.suc || 'eventos';
        const tienda = sol.tienda || _tiendaDeSucursal(suc);
        if (!tienda) throw new Error('La sucursal ' + suc + ' no tiene tienda de Rappi asignada');
        const menu = construirMenuRappi(await _catalogoDe(suc), { storeId: tienda, biblioteca: await _bibliotecaDe(suc) });
        if (sol.limite) menu.items = menu.items.slice(0, Number(sol.limite));
        if (!menu.items.length) throw new Error('Ningun producto de ' + suc + ' esta activado para Rappi en Catalogo POS');
        const val = validarMenu(menu);
        const resumen = { productos: menu.items.length, modificadores: menu.items.reduce(function (a, i) { return a + i.children.length; }, 0), categorias: Array.from(new Set(menu.items.map(function (i) { return i.category.name; }))).length, advertencias: val.advertencias.slice(0, 20) };
        if (val.errores.length) {
          resultado = { ok: false, error: 'El menu tiene ' + val.errores.length + ' problema(s): ' + val.errores.slice(0, 8).join(' | '), errores: val.errores };
        } else if (sol.accion === 'previsualizarMenu') {
          resultado = Object.assign({ ok: true, soloVista: true }, resumen);
        } else {
          resultado = Object.assign({ ok: true }, resumen, { respuesta: await rappiApi.enviarMenu(token, menu) });
        }
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
      } else if (sol.accion === 'configurarWebhookOnboarding') {
        // Un secreto propio para firmar los avisos de aprovisionamiento; se guarda antes de
        // registrarlo para no perder un aviso que llegue de inmediato.
        const secreto = crypto.randomBytes(24).toString('hex');
        const refSecreto = db.ref('rappiAuth/webhookSecrets/STORE_PROVISIONING_STATUS');
        const anterior = (await refSecreto.once('value')).val();
        await refSecreto.set(secreto);
        try {
          resultado = { ok: true, respuesta: await rappiApi.configurarWebhookOnboarding(token, RAPPI_CLIENT_ID.value().trim(), URL_WEBHOOK + '/STORE_PROVISIONING_STATUS', secreto) };
        } catch (e) { if (anterior) await refSecreto.set(anterior); else await refSecreto.remove(); throw e; }
      } else if (sol.accion === 'onboardingTiendas' || sol.accion === 'onboardingProvisionar') {
        const tokenCom = await _tokenComerciante();
        if (sol.accion === 'onboardingTiendas') {
          resultado = { ok: true, tiendas: await rappiApi.estadoTiendasOnboarding(token, tokenCom) };
        } else {
          // Sin store_integration_id: Rappi usa el store_id, que es el que ya mapeamos en TIENDAS_RAPPI.
          const tiendas = (sol.tiendas || []).map(function (t) { return { store_id: String(t.store_id), name: String(t.name), status: t.status || 'ACTIVE' }; });
          if (!tiendas.length) throw new Error('Falta la lista de tiendas');
          const r = await rappiApi.provisionarTiendas(token, tokenCom, tiendas);
          await db.ref('rappiAuth/onboarding/solicitudes/' + String((r && r.batch_id) || Date.now())).set({ ts: Date.now(), tiendas: tiendas, respuesta: r });
          resultado = { ok: true, respuesta: r };
        }
      } else if (sol.accion === 'listarHorarios') {
        resultado = { ok: true, horarios: await rappiApi.listarHorarios(await rappiApi.obtenerTokenUtils(RAPPI_CLIENT_ID.value().trim(), RAPPI_CLIENT_SECRET.value().trim()), sol.tienda || _tiendaDeSucursal(sol.suc || 'eventos')) };
      } else if (sol.accion === 'crearHorario') {
        resultado = { ok: true, respuesta: await rappiApi.crearHorario(await rappiApi.obtenerTokenUtils(RAPPI_CLIENT_ID.value().trim(), RAPPI_CLIENT_SECRET.value().trim()), sol.tienda || _tiendaDeSucursal(sol.suc || 'eventos'), sol.dia, sol.inicio, sol.fin) };
      } else if (sol.accion === 'agregarTiendasWebhooks') {
        // Suma tiendas a los avisos ya registrados (ej. una tienda que se aprovisiono despues).
        const delAmbiente = Object.keys(TIENDAS_RAPPI).filter(function (k) { return !!TIENDAS_RAPPI[k].prod === AMBIENTE_PROD; });
        const tiendas = (Array.isArray(sol.tiendas) ? sol.tiendas.map(String) : []).filter(function (k) { return delAmbiente.indexOf(k) >= 0; });
        if (!tiendas.length) throw new Error('Indica { tiendas:[...] } de este ambiente');
        const detalle = {};
        for (const ev of EVENTOS_WEBHOOK) {
          try { const r = await rappiApi.agregarTiendasWebhook(token, ev, URL_WEBHOOK + '/' + ev, tiendas); detalle[ev] = 'ok ' + JSON.stringify(r).slice(0, 120); }
          catch (e) { detalle[ev] = 'ERROR: ' + String(e.message || e).slice(0, 300); }
        }
        resultado = { ok: true, detalle };
      } else if (sol.accion === 'registrarWebhooks') {
        // Por defecto, todas las tiendas del ambiente; con { tiendas:[...] } solo esas (util si una tienda sigue con otro proveedor).
        const delAmbiente = Object.keys(TIENDAS_RAPPI).filter(function (k) { return !!TIENDAS_RAPPI[k].prod === AMBIENTE_PROD; });
        const tiendas = Array.isArray(sol.tiendas) && sol.tiendas.length ? sol.tiendas.map(String).filter(function (k) { return delAmbiente.indexOf(k) >= 0; }) : delAmbiente;
        if (!tiendas.length) throw new Error('Ninguna de las tiendas pedidas es de este ambiente');
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

/* ============================================================
   Self Onboarding -- autorizacion del comerciante (OAuth2 + PKCE).
   1) /rappiOnboardingInicio  -> manda al comerciante al login de Portal Partners.
   2) /rappiOnboardingCallback -> Rappi regresa aqui con ?code; se cambia por el
      id_token del comerciante (JWT) y se guarda SOLO en el servidor
      (rappiAuth/merchantToken, sin acceso desde navegadores segun las reglas).
   La direccion de callback debe estar registrada con Rappi (su TAM).
   ============================================================ */
const PARTNERS_BASE = amb.PARTNERS_BASE;
const URL_ONBOARDING_CALLBACK = 'https://us-central1-luna-smart-pos.cloudfunctions.net/rappiOnboardingCallback';

async function _clienteOauth() {
  // El client_id del flujo del comerciante (publico, PKCE) puede ser distinto al de la
  // integracion: Rappi lo registra aparte. Si no se configura, se prueba con el de la integracion.
  const cfg = (await db.ref('rappiAuth/onboardingConfig').once('value')).val() || {};
  return cfg.clientId || RAPPI_CLIENT_ID.value().trim();
}
async function _tokenComerciante() {
  const t = (await db.ref('rappiAuth/merchantToken').once('value')).val();
  if (!t || !t.idToken) throw new Error('Falta autorizar al comerciante: abre /rappiOnboardingInicio e inicia sesion con la cuenta de Portal Partners');
  if (t.exp && t.exp - Date.now() < 60 * 1000) throw new Error('La autorizacion del comerciante expiro: repite /rappiOnboardingInicio');
  return t.idToken;
}

exports.rappiOnboardingInicio = onRequest({ secrets: [RAPPI_CLIENT_ID] }, async (req, res) => {
  const verifier = pkce.nuevoVerifier();
  const state = pkce.nuevoState();
  await db.ref('rappiAuth/onboarding/pkce/' + state).set({ verifier: verifier, ts: Date.now() });
  const clientId = await _clienteOauth();
  const url = PARTNERS_BASE + '/authorize?' + new URLSearchParams({
    client_id: clientId, redirect_uri: URL_ONBOARDING_CALLBACK, response_type: 'code', scope: 'openid profile email',
    code_challenge: pkce.desafioDe(verifier), code_challenge_method: 'S256', state: state,
  }).toString();
  res.redirect(302, url);
});

exports.rappiOnboardingCallback = onRequest({ secrets: [RAPPI_CLIENT_ID] }, async (req, res) => {
  const pagina = function (titulo, texto) { res.status(200).set('Content-Type', 'text/html; charset=utf-8').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;max-width:480px;margin:12vh auto;padding:0 20px"><h2>' + titulo + '</h2><p>' + texto + '</p>'); };
  try {
    if (req.query.error) { pagina('No se autorizo', 'Rappi respondio: ' + String(req.query.error_description || req.query.error).replace(/[<>&]/g, '')); return; }
    const state = String(req.query.state || ''), code = String(req.query.code || '');
    if (!state || !code) { res.status(400).send('Faltan datos'); return; }
    const ref = db.ref('rappiAuth/onboarding/pkce/' + state.replace(/[.#$\[\]\/]/g, '_'));
    const guardado = (await ref.once('value')).val();
    await ref.remove(); // un solo uso
    if (!guardado || Date.now() - guardado.ts > 15 * 60 * 1000) { res.status(400).send('Solicitud no valida o vencida: vuelve a empezar'); return; }

    const r = await fetch(PARTNERS_BASE + '/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: code, client_id: await _clienteOauth(), code_verifier: guardado.verifier, redirect_uri: URL_ONBOARDING_CALLBACK }).toString(),
    });
    const cuerpo = await r.json().catch(function () { return {}; });
    if (!r.ok || !cuerpo.id_token) { logger.error('Intercambio de codigo fallo', { status: r.status, error: cuerpo.error }); pagina('No se pudo completar', 'Rappi no entrego el token (' + r.status + '). Avisa a quien configuro la integracion.'); return; }
    if (!pkce.esJwtFirmado(cuerpo.id_token)) { pagina('Token inesperado', 'El token recibido no tiene el formato esperado.'); return; }
    await db.ref('rappiAuth/merchantToken').set({ idToken: cuerpo.id_token, exp: pkce.expDeJwt(cuerpo.id_token), ts: Date.now() });
    pagina('Listo', 'Rappi autorizo la conexion de tus tiendas. Ya puedes cerrar esta ventana.');
  } catch (e) {
    logger.error('Callback de onboarding', e);
    res.status(500).send('Error interno');
  }
});


// =====================================================================
// API PUBLICA del sitio de pedidos (clientes de lealtad y pedidos web).
// El sitio ya no toca clientesLealtad ni la lista de pedidos: ver lib/publico.js.
// =====================================================================
const ORIGENES_SITIO = [
  'https://pedidos.suenodeluna.com.mx', 'https://suenodeluna.com.mx', 'https://www.suenodeluna.com.mx',
  /^https:\/\/[a-z0-9-]+--[a-z0-9-]+\.netlify\.app$/, /^https:\/\/[a-z0-9-]+\.netlify\.app$/,
  'http://localhost:3739',
];
function ipDe(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.ip || 'sin-ip');   // el ultimo lo agrega Google: no se puede falsificar
}
function endpointPublico(nombre, manejador) {
  return onRequest({ cors: ORIGENES_SITIO, maxInstances: 10, invoker: 'public' }, async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'metodo' }); return; }
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      res.json(await manejador({ body, ip: ipDe(req), db, ahora: Date.now(), sv: ServerValue.TIMESTAMP }));
    } catch (e) {
      if (e instanceof publico.ErrorPublico) { res.status(e.status).json({ ok: false, error: e.codigo }); return; }
      logger.error('API publica ' + nombre, e);
      res.status(500).json({ ok: false, error: 'interno' });
    }
  });
}
exports.lealtadExiste = endpointPublico('lealtadExiste', publico.lealtadExiste);
exports.lealtadVerificar = endpointPublico('lealtadVerificar', publico.lealtadVerificar);
exports.lealtadRegistrar = endpointPublico('lealtadRegistrar', publico.lealtadRegistrar);
exports.pedidoCrear = endpointPublico('pedidoCrear', publico.pedidoCrear);
exports.cuentaMesa = endpointPublico('cuentaMesa', publico.cuentaMesa);

// Aviso de visita del sitio de pedidos (1 por sesion de navegador). Siempre responde 204: el sitio no espera nada.
exports.analiticaVisita = onRequest({ cors: ORIGENES_SITIO, maxInstances: 10, invoker: 'public' }, async (req, res) => {
  try {
    if (req.method === 'POST') {
      let body = req.body;
      if (!body || typeof body !== 'object') { try { body = JSON.parse(req.rawBody ? req.rawBody.toString('utf8') : '{}'); } catch (e) { body = {}; } }   // sendBeacon manda text/plain
      await analitica.registrarVisita(db, ServerValue, {
        ahora: Date.now(), ip: ipDe(req), ua: req.headers['user-agent'] || '',
        vid: String(body.vid || '').slice(0, 64), ref: String(body.ref || '').slice(0, 300),
        utm: String(body.utm || '').slice(0, 60), mesa: !!body.mesa,
      });
    }
  } catch (e) { logger.error('analiticaVisita', e); }
  res.status(204).send('');
});

// Conversion del sitio: cuando la caja cobra (estado 'pagado') un pedido que vino del sitio, cuenta como venta real
// en analitica/ (y deja de contar si luego se cancela). Ver lib/analitica.js.
exports.analiticaVentaWeb = onValueWritten({ ref: '/pedidos/{suc}/{pedidoId}' }, async (event) => {
  try {
    const antes = event.data.before.val(), despues = event.data.after.val();
    if (!despues || !despues.origenWeb) return;
    const eraPagado = !!antes && antes.estado === 'pagado';
    if (despues.estado === 'pagado' && !eraPagado) {
      await analitica.registrarVenta(db, ServerValue, event.params.pedidoId, despues._ts, despues.total);
    } else if (eraPagado && despues.estado === 'cancelado') {
      await analitica.anularVenta(db, ServerValue, event.params.pedidoId);
    }
  } catch (e) { logger.error('analiticaVentaWeb', e); }
});

// Registros a eventos del sitio -> analitica/ (cuantas personas se registran por dia/semana/mes/año).
exports.analiticaInscripcionEvento = onValueCreated({ ref: '/eventosInscripciones/{eventoId}/{regId}' }, async (event) => {
  try {
    const r = event.data.val() || {};
    await analitica.registrarInscripcion(db, ServerValue, r.ts);
  } catch (e) { logger.error('analiticaInscripcionEvento', e); }
});
