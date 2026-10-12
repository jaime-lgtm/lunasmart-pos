#!/usr/bin/env node
// Prueba lo que puede hacer un VISITANTE cualquiera (sesion anonima, la misma que
// obtiene cualquiera que abra el sitio publico) contra la base de datos.
// Solo imprime codigos de respuesta -- nunca el contenido que regresa la base.
//   node scripts/auditar_acceso_anonimo.js
// Resultado esperado tras cerrar las reglas: "BLOQUEADO" en todo lo privado y
// "permitido" solo en lo que el sitio publico necesita (menu, horario, eventos).
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyAylUrEQGXad-DAZrTCWVrrXeq1rrLVTwM';
const DB = 'https://luna-smart-pos-default-rtdb.firebaseio.com';
const PRIVADO = ['clientesLealtad', 'pedidos/cafeteria', 'pedidos/helfy', 'usuariosPOS', 'turnoSales/cafeteria', 'cajaEstado/cafeteria', 'negocioInfo/cafeteria', 'repartidores/cafeteria', 'tiposDescuento', 'terminalesMP', 'comisionesDelivery', 'metasTiempo', 'tipoCambioUSD', 'mesasEstado/cafeteria',
  'asistenciaActiva/cafeteria', 'checklistTurnos/cafeteria', 'eventosInscripciones', 'rappiAdmin', '_limites'];
const PUBLICO = ['cajaLive/cafeteria', 'displayConfig/cafeteria', 'catalogo/cafeteria', 'modificadores/cafeteria', 'agotados/cafeteria', 'horarioTienda', 'eventos'];
(async () => {
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
  const { idToken } = await r.json();
  if (!idToken) { console.error('No se pudo obtener sesion anonima'); process.exit(2); }
  const leer = async (p) => (await fetch(DB + '/' + p + '.json?shallow=true&auth=' + idToken)).status;
  let fallos = 0;
  console.log('--- Debe estar BLOQUEADO para un visitante anonimo ---');
  for (const p of PRIVADO) { const s = await leer(p); const ok = s === 401 || s === 403; if (!ok) fallos++; console.log((ok ? 'BLOQUEADO  ' : '¡ABIERTO!   ') + p + '  (HTTP ' + s + ')'); }
  console.log('--- Publico a proposito (menu del sitio) ---');
  for (const p of PUBLICO) { const s = await leer(p); console.log((s === 200 ? 'permitido   ' : 'revisar     ') + p + '  (HTTP ' + s + ')'); }
  console.log(fallos ? '\n' + fallos + ' ruta(s) privada(s) siguen abiertas.' : '\nTodo lo privado esta cerrado a visitantes anonimos.');
  process.exit(fallos ? 1 : 0);
})();
