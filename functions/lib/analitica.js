// Analitica propia del sitio de pedidos (pedidos.suenodeluna.com.mx).
//
// El sitio manda UN aviso por sesion de navegador (ver el bloque "analitica" de su index.html) a
// la funcion analiticaVisita. Aqui se cuenta -- sin cookies ni datos personales: el identificador
// del navegador (aleatorio) se guarda solo como hash -- y se agrega por dia, semana, mes y año en
// analitica/{dias|semanas|meses|anios}/{clave}. Solo el Admin SDK escribe; el administrador lee
// (reglas: analitica = solo personal). El dashboard del admin usa las mismas claves (ver
// claves() -- la semana es ISO, lunes a domingo).
const crypto = require('crypto');

const ZONA = 'America/Matamoros';   // hora de Piedras Negras (con horario de verano de la frontera)
const HORA = 60 * 60 * 1000;

function hash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24); }

// Fecha local (en ZONA) de un instante.
function partesLocales(ms) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const o = {}; f.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour };
}
const p2 = function (n) { return String(n).padStart(2, '0'); };

// Semana ISO (lunes primero) de una fecha y-m-d -> 'AAAA-Www'
function semanaISO(y, m, d) {
  const fecha = Date.UTC(y, m - 1, d);
  const dow = (new Date(fecha).getUTCDay() + 6) % 7;            // lunes=0
  const jueves = fecha + (3 - dow) * 86400000;
  const anioISO = new Date(jueves).getUTCFullYear();
  const enero4 = Date.UTC(anioISO, 0, 4);
  const sem = 1 + Math.floor((jueves - enero4 + ((new Date(enero4).getUTCDay() + 6) % 7) * 86400000) / (7 * 86400000));
  return anioISO + '-W' + p2(sem);
}

function claves(ms) {
  const t = partesLocales(ms);
  return {
    dias: t.y + '-' + p2(t.m) + '-' + p2(t.d),
    semanas: semanaISO(t.y, t.m, t.d),
    meses: t.y + '-' + p2(t.m),
    anios: String(t.y),
    hora: p2(t.h),
  };
}

const RE_BOT = /bot\b|crawl|spider|slurp|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|facebookexternalhit|facebot|whatsapp\/|telegrambot|preview|curl\/|wget|python-requests|node-fetch|axios|go-http|java\//i;
function clasificaUA(ua) {
  ua = String(ua || '');
  if (!ua || RE_BOT.test(ua)) return { bot: true, dispositivo: 'otro' };
  if (/ipad|tablet|kindle|silk|(android(?!.*mobile))/i.test(ua)) return { bot: false, dispositivo: 'tablet' };
  if (/mobi|iphone|ipod|android|windows phone/i.test(ua)) return { bot: false, dispositivo: 'movil' };
  return { bot: false, dispositivo: 'escritorio' };
}

const HOST_PROPIO = /(^|\.)suenodeluna\.com\.mx$/i;
function clasificaOrigen(d) {
  if (d.mesa) return 'qr_mesa';
  const utm = String(d.utm || '').toLowerCase();
  let host = '';
  try { host = new URL(String(d.ref || '')).hostname.toLowerCase(); } catch (e) { host = ''; }
  const fuente = utm || host;
  if (/instagram|^ig$|l\.instagram/.test(fuente)) return 'instagram';
  if (/facebook|^fb$|fb\.com|fb\.me|messenger/.test(fuente)) return 'facebook';
  if (/google|^gmb$/.test(fuente)) return 'google';
  if (/whatsapp|wa\.me/.test(fuente)) return 'whatsapp';
  if (/tiktok/.test(fuente)) return 'tiktok';
  if (/rappi|uber|didi/.test(fuente)) return 'apps_reparto';
  if (!fuente || HOST_PROPIO.test(host)) return 'directo';
  return 'otro';
}

// Cuenta un pedido web en los 4 periodos (conversion = pedidos / visitas)
async function registrarPedido(db, sv, ahora, monto) {
  const c = claves(ahora), up = {};
  ['dias', 'semanas', 'meses', 'anios'].forEach(function (t) {
    up['analitica/' + t + '/' + c[t] + '/pedidos'] = sv.increment(1);
    up['analitica/' + t + '/' + c[t] + '/pedidosMonto'] = sv.increment(Math.round((Number(monto) || 0) * 100) / 100);
  });
  await db.ref().update(up);
}

// Cuenta una visita (sesion). Devuelve false si se descarto (bot, limite, datos invalidos).
async function registrarVisita(db, sv, d) {
  const ahora = d.ahora;
  const ua = clasificaUA(d.ua);
  if (ua.bot) return false;
  const vid = String(d.vid || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(vid)) return false;
  const { dentroDeLimite } = require('./publico');                       // lazy: publico tambien usa este modulo
  if (!(await dentroDeLimite(db, 'visitaVid', vid, 20, HORA, ahora))) return false;   // un navegador no puede inflar el conteo
  if (!(await dentroDeLimite(db, 'visitaIp', d.ip || 'sin-ip', 1500, HORA, ahora))) return false;

  const c = claves(ahora), h = hash(vid);
  const origen = clasificaOrigen(d);
  const up = {};
  let primeraDelDia = false;
  for (const t of ['dias', 'semanas', 'meses', 'anios']) {
    const base = 'analitica/' + t + '/' + c[t];
    up[base + '/visitas'] = sv.increment(1);
    up[base + '/dispositivos/' + ua.dispositivo] = sv.increment(1);
    up[base + '/origenes/' + origen] = sv.increment(1);
    // visitante unico del periodo: la primera vez que ese navegador aparece en el periodo
    const r = await db.ref('analitica/vistos/' + t + '/' + c[t] + '/' + h).transaction(function (cur) { return cur ? undefined : true; });
    if (r.committed) {
      up[base + '/unicos'] = sv.increment(1);
      if (t === 'dias') { up[base + '/unicosDisp/' + ua.dispositivo] = sv.increment(1); }
    }
  }
  up['analitica/dias/' + c.dias + '/horas/' + c.hora] = sv.increment(1);
  await db.ref().update(up);

  // una vez al dia: limpiar la lista de "vistos" por dia de hace mas de 60 dias
  const dv = (await db.ref('analitica/dias/' + c.dias + '/visitas').once('value')).val();
  if (dv === 1) {
    await db.ref('analitica/inicio').transaction(function (cur) { return cur || c.dias; });   // fecha desde la que se cuenta (la ve el dashboard)
    const corte = claves(ahora - 60 * 86400000).dias;
    const viejos = await db.ref('analitica/vistos/dias').orderByKey().endAt(corte).once('value');
    const del = {}; viejos.forEach(function (n) { del['analitica/vistos/dias/' + n.key] = null; });
    if (Object.keys(del).length) await db.ref().update(del);
  }
  primeraDelDia = dv === 1;
  return { ok: true, primeraDelDia: primeraDelDia };
}

module.exports = { ZONA, claves, semanaISO, partesLocales, clasificaUA, clasificaOrigen, registrarVisita, registrarPedido, hash };
