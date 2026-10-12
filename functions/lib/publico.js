// API publica del sitio de pedidos (pedidos.suenodeluna.com.mx).
//
// Por que existe: el sitio publico antes leia/escribia clientesLealtad y pedidos
// directo en Firebase con una sesion anonima. Cualquiera que abriera el codigo del
// sitio podia bajar TODA la lista de clientes (nombre, telefono, direccion,
// cumpleanos, puntos). Ahora el sitio solo habla con estas funciones, que usan el
// Admin SDK (se saltan las reglas) y solo devuelven lo minimo, con limite de
// intentos. Las reglas de la base de datos cierran clientesLealtad y la lista de
// pedidos a todo lo que no sea personal (inicio de sesion con correo).
//
// Todo aqui es logica pura recibiendo `db` y `ahora`, para poder probarla.
const crypto = require('crypto');

class ErrorPublico extends Error {
  constructor(codigo, status) { super(codigo); this.codigo = codigo; this.status = status || 400; }
}

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;
const FALLOS_MAX_TEL = 5;        // intentos fallidos de cumpleanos por telefono...
const FALLOS_VENTANA = DIA;      // ...en 24 h (bloqueo hasta que pase la ventana)
const FALLOS_MAX_IP = 20;        // intentos fallidos por IP en 1 h

function normTel(t) {
  let d = String(t == null ? '' : t).replace(/\D/g, '');
  if (d.length === 12 && d.slice(0, 2) === '52') d = d.slice(2);
  else if (d.length === 13 && d.slice(0, 3) === '521') d = d.slice(3);
  return d;
}
function hash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24); }
function mmdd(v) {
  const m = /^(?:\d{4}-)?(\d{2})-(\d{2})/.exec(String(v || ''));
  return m ? m[1] + '-' + m[2] : '';
}
function texto(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }
function numero(v, min, max) { const n = Number(v); return isFinite(n) ? Math.min(max, Math.max(min, n)) : NaN; }
function redondea(n) { return Math.round(n * 100) / 100; }
function validaTel(t) { const n = normTel(t); if (n.length !== 10) throw new ErrorPublico('telefono_invalido'); return n; }
function validaDiaMes(dia, mes) {
  const d = String(dia || '').padStart(2, '0'), m = String(mes || '').padStart(2, '0');
  if (!/^(0[1-9]|[12]\d|3[01])$/.test(d) || !/^(0[1-9]|1[0-2])$/.test(m)) throw new ErrorPublico('cumpleanos_invalido');
  return { dia: d, mes: m };
}
function validaCumpleISO(v, ahora) {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ErrorPublico('cumpleanos_invalido');
  const f = new Date(s + 'T12:00:00Z');
  if (isNaN(f) || f.toISOString().slice(0, 10) !== s || s < '1920-01-01' || s > new Date(ahora).toISOString().slice(0, 10)) throw new ErrorPublico('cumpleanos_invalido');
  return s;
}

// Contador por clave dentro de una ventana de tiempo (transaccion en _limites/).
// Devuelve true si todavia esta dentro del maximo; cuenta este intento.
async function dentroDeLimite(db, tipo, clave, max, ventana, ahora) {
  let permitido = false;
  await db.ref('_limites/' + tipo + '/' + hash(clave)).transaction(function (cur) {
    cur = cur && typeof cur === 'object' ? cur : null;
    if (!cur || ahora - cur.t >= ventana) { permitido = max >= 1; return { n: 1, t: ahora }; }
    if (cur.n >= max) { permitido = false; return; }          // aborta: no suma
    permitido = true;
    return { n: cur.n + 1, t: cur.t };
  });
  return permitido;
}
async function exigeLimite(db, tipo, clave, max, ventana, ahora) {
  if (!(await dentroDeLimite(db, tipo, clave, max, ventana, ahora))) throw new ErrorPublico('demasiados_intentos', 429);
}
async function estaBloqueado(db, tipo, clave, max, ventana, ahora) {
  const v = (await db.ref('_limites/' + tipo + '/' + hash(clave)).once('value')).val();
  return !!(v && ahora - v.t < ventana && v.n >= max);
}
async function sumaFallo(db, tipo, clave, ventana, ahora) {
  await db.ref('_limites/' + tipo + '/' + hash(clave)).transaction(function (cur) {
    if (!cur || ahora - cur.t >= ventana) return { n: 1, t: ahora };
    return { n: cur.n + 1, t: cur.t };
  });
}

// Verifica "telefono + dia y mes de cumpleanos". Misma respuesta (null) si el
// cliente no existe, no tiene cumpleanos o no coincide, para no revelar cuales
// telefonos son clientes. Cada fallo cuenta contra el telefono y la IP.
async function verificaCliente(db, ip, tel, dia, mes, ahora) {
  if (await estaBloqueado(db, 'fallosTel', tel, FALLOS_MAX_TEL, FALLOS_VENTANA, ahora)) throw new ErrorPublico('bloqueado', 429);
  if (await estaBloqueado(db, 'fallosIp', ip, FALLOS_MAX_IP, HORA, ahora)) throw new ErrorPublico('bloqueado', 429);
  const cli = (await db.ref('clientesLealtad/' + tel).once('value')).val();
  if (cli && cli.nombre && cli.cumpleanos && mmdd(cli.cumpleanos) === mes + '-' + dia) {
    await db.ref('_limites/fallosTel/' + hash(tel)).remove();
    return cli;
  }
  await sumaFallo(db, 'fallosTel', tel, FALLOS_VENTANA, ahora);
  await sumaFallo(db, 'fallosIp', ip, HORA, ahora);
  return null;
}
function clientePublico(cli) {
  return {
    nombre: cli.nombre || '', puntos: Number(cli.puntos) || 0, visitas: Number(cli.visitas) || 0,
    creado: cli.creado || null, direccion: cli.direccion || '', referencia: cli.referencia || '',
  };
}

// ---- crea la cuenta solo si no existe (nunca pisa nombre, cumpleanos ni puntos) ----
async function creaCliente(db, tel, nombre, cumple, ahora) {
  let creado = false;
  await db.ref('clientesLealtad/' + tel).transaction(function (cur) {
    if (cur && cur.nombre) { creado = false; return; }
    creado = true;
    const base = cur || {};
    base.telefono = tel; base.nombre = nombre;
    if (!base.cumpleanos) base.cumpleanos = cumple;
    if (base.puntos == null) base.puntos = 0;
    if (base.visitas == null) base.visitas = 0;
    if (!base.creado) base.creado = ahora;
    return base;
  });
  return creado;
}

// ============================ endpoints ============================
async function lealtadExiste({ body, ip, db, ahora }) {
  const tel = validaTel(body.telefono);
  await exigeLimite(db, 'existe', ip, 120, HORA, ahora);
  const nombre = (await db.ref('clientesLealtad/' + tel + '/nombre').once('value')).val();
  return { ok: true, existe: !!nombre };
}

async function lealtadVerificar({ body, ip, db, ahora }) {
  const tel = validaTel(body.telefono);
  const { dia, mes } = validaDiaMes(body.dia, body.mes);
  await exigeLimite(db, 'verificar', ip, 60, HORA, ahora);
  const cli = await verificaCliente(db, ip, tel, dia, mes, ahora);
  if (!cli) return { ok: false, error: 'no_coincide' };
  return { ok: true, cliente: clientePublico(cli) };
}

async function lealtadRegistrar({ body, ip, db, ahora }) {
  const tel = validaTel(body.telefono);
  const nombre = texto(body.nombre, 80);
  if (nombre.length < 2) throw new ErrorPublico('nombre_invalido');
  const cumple = validaCumpleISO(body.cumpleanos, ahora);
  await exigeLimite(db, 'registrar', ip, 40, HORA, ahora);
  await exigeLimite(db, 'registrarTel', tel, 5, HORA, ahora);
  const creado = await creaCliente(db, tel, nombre, cumple, ahora);
  return creado ? { ok: true } : { ok: false, error: 'ya_existe' };
}

// Arma el pedido con la misma forma que antes escribia el navegador, pero
// validada y con total recalculado en el servidor.
function construirPedido(b, nid, hora, puntosUsados) {
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length || items.length > 60) throw new ErrorPublico('pedido_invalido');
  const limpios = items.map(function (i) {
    const price = numero(i && i.price, 0, 5000);
    if (!isFinite(price)) throw new ErrorPublico('pedido_invalido');
    return {
      id: i.id ? texto(i.id, 60) : null, name: texto(i.name, 120), size: i.size ? texto(i.size, 40) : null,
      mods: texto(i.mods, 400), note: '', price: price, qty: 1,
      area: i.area === 'cocina' ? 'cocina' : 'barra', modDeltas: [],
    };
  });
  if (limpios.some(function (i) { return !i.name; })) throw new ErrorPublico('pedido_invalido');
  // la mesa se guarda como numero (asi la escribia el sitio y la lee el POS); solo si no es numerica queda como texto
  let mesa = b.mesa != null && b.mesa !== '' ? texto(b.mesa, 12) : null;
  if (mesa !== null && /^\d+$/.test(mesa)) mesa = Number(mesa);
  const domicilio = !mesa && b.delivery === 'delivery';
  const tipo = mesa ? 'aqui' : (domicilio ? 'domicilio' : 'llevar');
  const cargo = domicilio ? numero(b.cargoDomicilio != null ? b.cargoDomicilio : 60, 0, 150) : 0;
  const subtotal = limpios.reduce(function (a, i) { return a + i.price; }, 0);
  const total = Math.max(0, redondea(subtotal - puntosUsados + (isFinite(cargo) ? cargo : 0)));
  const metodoTxt = texto(b.metodo, 20);
  const pedido = {
    id: nid, tipo: tipo, mesa: mesa, estado: 'pendienteWeb',
    metodo: mesa ? null : (b.pagadoMP ? 'mercadopago' : (metodoTxt || null)),
    cliente: {
      nombre: texto(b.nombre, 80), telefono: normTel(b.telefono),
      direccion: domicilio ? texto(b.direccion, 300) : '', referencia: texto(b.referencia, 300),
    },
    items: limpios, cargoDomicilio: isFinite(cargo) ? cargo : 0, puntosUsados: puntosUsados, total: total,
    hora: hora, origenWeb: true,
  };
  const refMP = texto(b.referenciaMP, 80);
  if (refMP) pedido.referenciaMP = refMP;
  if (b.programado && b.programado.fecha) {
    pedido.programado = true;
    pedido.entregaProgramadaFecha = texto(b.programado.fecha, 20);
    pedido.entregaProgramadaHora = texto(b.programado.hora, 20);
  }
  return pedido;
}

async function pedidoCrear({ body, ip, db, ahora, sv }) {
  const tel = validaTel(body.telefono);
  await exigeLimite(db, 'pedido', ip, 40, HORA, ahora);
  await exigeLimite(db, 'pedidoTel', tel, 10, HORA, ahora);

  // Pago ya hecho con Mercado Pago: el webhook de Apps Script puede haber creado el pedido primero.
  const refMP = texto(body.referenciaMP, 80);
  if (refMP) {
    const ex = (await db.ref('pedidos/cafeteria').orderByChild('referenciaMP').equalTo(refMP).limitToFirst(1).once('value'));
    if (ex.exists()) {
      let key = null; ex.forEach(function (h) { key = h.key; });
      const p = ex.val()[key] || {};
      return { ok: true, key: key, tipo: p.tipo || 'llevar', duplicado: true };
    }
  }

  // Puntos: solo se descuentan si el cliente prueba su cuenta (telefono + cumpleanos) y le alcanzan.
  let puntosUsados = numero(body.puntosUsados || 0, 0, 100000);
  if (!isFinite(puntosUsados)) puntosUsados = 0;
  puntosUsados = redondea(puntosUsados);
  let cli = null;
  const v = body.verificacion;
  if (v && v.dia && v.mes) {
    const { dia, mes } = validaDiaMes(v.dia, v.mes);
    try { cli = await verificaCliente(db, ip, tel, dia, mes, ahora); }
    catch (e) { if (!(e instanceof ErrorPublico) || e.codigo !== 'bloqueado') throw e; cli = null; }   // telefono bloqueado: el pedido sigue, sin puntos
  }
  if (puntosUsados > 0) {
    if (!cli) throw new ErrorPublico('puntos_no_verificados', 403);
    if ((Number(cli.puntos) || 0) + 0.001 < puntosUsados) throw new ErrorPublico('puntos_insuficientes', 409);
  }

  const horaTxt = new Date(ahora).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Matamoros' });
  const ref = db.ref('pedidos/cafeteria').push();
  const nid = '#' + ref.key.replace(/[^a-zA-Z0-9]/g, '').slice(-5).toUpperCase();
  const pedido = construirPedido(Object.assign({}, body, { telefono: tel }), nid, horaTxt, puntosUsados);
  pedido._ts = sv;                                             // ServerValue.TIMESTAMP
  await ref.set(pedido);

  // Cuenta de lealtad: nueva si pidio inscribirse; si ya probo ser el dueno, se actualiza su direccion.
  try {
    if (body.inscribir && body.inscribir.cumpleanos && texto(body.inscribir.nombre || body.nombre, 80).length >= 2) {
      await creaCliente(db, tel, texto(body.inscribir.nombre || body.nombre, 80), validaCumpleISO(body.inscribir.cumpleanos, ahora), ahora);
    } else if (cli) {
      const cambios = {};
      if (pedido.cliente.direccion) cambios.direccion = pedido.cliente.direccion;
      if (pedido.cliente.referencia) cambios.referencia = pedido.cliente.referencia;
      if (Object.keys(cambios).length) await db.ref('clientesLealtad/' + tel).update(cambios);
    }
  } catch (e) { /* el pedido ya quedo guardado; la cuenta no debe tumbarlo */ }
  try { await require('./analitica').registrarPedido(db, sv, ahora, pedido.total); } catch (e) { /* la analitica nunca debe tumbar un pedido */ }
  return { ok: true, key: ref.key, tipo: pedido.tipo, id: nid };
}

async function cuentaMesa({ body, ip, db, ahora }) {
  const mesa = texto(body.mesa, 12);
  if (!mesa) throw new ErrorPublico('mesa_invalida');
  await exigeLimite(db, 'mesa', ip, 120, HORA, ahora);
  const consultas = [mesa];
  if (/^\d+$/.test(mesa)) consultas.push(Number(mesa));
  const out = [];
  for (const m of consultas) {
    const snap = await db.ref('pedidos/cafeteria').orderByChild('mesa').equalTo(m).once('value');
    snap.forEach(function (h) {
      const p = h.val() || {};
      if (p.tipo === 'aqui' && (p.estado === 'abierto' || p.estado === 'pendienteWeb')) {
        out.push({
          tipo: p.tipo, estado: p.estado,
          items: (p.items || []).map(function (i) { return { name: i.name, qty: i.qty || 1, price: i.price }; }),
        });
      }
    });
  }
  return { ok: true, pedidos: out };
}

module.exports = {
  ErrorPublico, normTel, mmdd, hash, validaTel, validaDiaMes, validaCumpleISO, construirPedido, redondea,
  lealtadExiste, lealtadVerificar, lealtadRegistrar, pedidoCrear, cuentaMesa,
  dentroDeLimite, verificaCliente, FALLOS_MAX_TEL,
};
