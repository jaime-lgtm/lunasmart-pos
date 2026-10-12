const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/publico');

test('normTel quita 52/521 y deja 10 digitos', () => {
  assert.strictEqual(P.normTel('+52 (878) 123-4567'), '8781234567');
  assert.strictEqual(P.normTel('5218781234567'), '8781234567');
  assert.strictEqual(P.normTel('abc'), '');
});
test('validaTel rechaza numeros que no son de 10 digitos', () => {
  assert.throws(() => P.validaTel('123'), { codigo: 'telefono_invalido' });
  assert.strictEqual(P.validaTel('878 123 4567'), '8781234567');
});
test('mmdd lee AAAA-MM-DD y MM-DD', () => {
  assert.strictEqual(P.mmdd('1990-07-22'), '07-22');
  assert.strictEqual(P.mmdd('07-22'), '07-22');
  assert.strictEqual(P.mmdd(''), '');
});
test('validaDiaMes rellena ceros y rechaza invalidos', () => {
  assert.deepStrictEqual(P.validaDiaMes(2, 7), { dia: '02', mes: '07' });
  assert.throws(() => P.validaDiaMes('32', '01'), { codigo: 'cumpleanos_invalido' });
  assert.throws(() => P.validaDiaMes('10', '13'), { codigo: 'cumpleanos_invalido' });
});
test('validaCumpleISO rechaza futuro, inexistentes y muy antiguos', () => {
  const ahora = Date.parse('2026-10-12T12:00:00Z');
  assert.strictEqual(P.validaCumpleISO('1990-07-22', ahora), '1990-07-22');
  assert.throws(() => P.validaCumpleISO('2027-01-01', ahora));
  assert.throws(() => P.validaCumpleISO('1990-02-30', ahora));
  assert.throws(() => P.validaCumpleISO('1900-01-01', ahora));
});
test('construirPedido recalcula el total en el servidor y no confia en el del cliente', () => {
  const p = P.construirPedido({
    telefono: '8781234567', nombre: 'Ana', delivery: 'delivery', direccion: 'Calle 1', total: 1,
    items: [{ id: 'a', name: 'Latte', price: 70 }, { id: 'b', name: 'Pan', price: 40 }], metodo: 'efectivo',
  }, '#ABCDE', '10:00 a. m.', 10);
  assert.strictEqual(p.total, 70 + 40 - 10 + 60);
  assert.strictEqual(p.tipo, 'domicilio');
  assert.strictEqual(p.estado, 'pendienteWeb');
  assert.strictEqual(p.origenWeb, true);
});
test('construirPedido: pedido de mesa no cobra domicilio ni guarda direccion', () => {
  const p = P.construirPedido({ telefono: '8781234567', mesa: 5, delivery: 'delivery', direccion: 'x', items: [{ name: 'Latte', price: 70 }] }, '#A', 'h', 0);
  assert.strictEqual(p.tipo, 'aqui'); assert.strictEqual(p.mesa, 5); assert.strictEqual(p.cargoDomicilio, 0); assert.strictEqual(p.cliente.direccion, ''); assert.strictEqual(p.metodo, null);
});
test('construirPedido rechaza carritos vacios, precios absurdos y sin nombre', () => {
  assert.throws(() => P.construirPedido({ items: [] }, '#A', 'h', 0), { codigo: 'pedido_invalido' });
  assert.throws(() => P.construirPedido({ items: [{ name: 'x', price: 'abc' }] }, '#A', 'h', 0), { codigo: 'pedido_invalido' });
  assert.throws(() => P.construirPedido({ items: [{ name: '', price: 10 }] }, '#A', 'h', 0), { codigo: 'pedido_invalido' });
  assert.strictEqual(P.construirPedido({ items: [{ name: 'x', price: 99999999 }] }, '#A', 'h', 0).items[0].price, 5000);
});

// ---- base de datos en memoria con lo minimo que usan los limites y la verificacion ----
function dbFalsa(datos) {
  const raiz = datos || {};
  const get = (path) => path.split('/').reduce((o, k) => (o == null ? undefined : o[k]), raiz);
  const set = (path, val) => {
    const ks = path.split('/'); const ult = ks.pop();
    let o = raiz; ks.forEach((k) => { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; });
    if (val === null || val === undefined) delete o[ult]; else o[ult] = val;
  };
  return {
    raiz,
    ref: (path) => ({
      once: async () => ({ val: () => { const v = get(path); return v === undefined ? null : JSON.parse(JSON.stringify(v)); } }),
      remove: async () => set(path, null),
      transaction: async (fn) => { const v = get(path); const r = fn(v === undefined ? null : JSON.parse(JSON.stringify(v))); if (r !== undefined) set(path, r); return { committed: r !== undefined }; },
    }),
  };
}

test('dentroDeLimite deja pasar hasta el maximo y bloquea despues; la ventana lo reinicia', async () => {
  const db = dbFalsa(); const t0 = 1000000;
  for (let i = 0; i < 3; i++) assert.strictEqual(await P.dentroDeLimite(db, 'x', 'ip1', 3, 1000, t0), true);
  assert.strictEqual(await P.dentroDeLimite(db, 'x', 'ip1', 3, 1000, t0 + 10), false);
  assert.strictEqual(await P.dentroDeLimite(db, 'x', 'ip2', 3, 1000, t0 + 10), true);       // otra clave no se afecta
  assert.strictEqual(await P.dentroDeLimite(db, 'x', 'ip1', 3, 1000, t0 + 1500), true);     // paso la ventana
});
test('verificaCliente: acierta con el cumpleanos, y tras 5 fallos bloquea incluso al correcto', async () => {
  const db = dbFalsa({ clientesLealtad: { '8781234567': { nombre: 'Ana', cumpleanos: '1990-07-22', puntos: 12 } } });
  const t = 5000000;
  assert.strictEqual(await P.verificaCliente(db, 'ip', '8781234567', '23', '07', t), null);
  assert.strictEqual(await P.verificaCliente(db, 'ip', '8781234567', '22', '07', t) !== null, true);   // acierto reinicia el contador
  for (let i = 0; i < P.FALLOS_MAX_TEL; i++) assert.strictEqual(await P.verificaCliente(db, 'ip' + i, '8781234567', '01', '01', t), null);
  await assert.rejects(P.verificaCliente(db, 'ipNueva', '8781234567', '22', '07', t), { codigo: 'bloqueado' });
  assert.strictEqual((await P.verificaCliente(db, 'ipNueva', '8781234567', '22', '07', t + 25 * 3600 * 1000)) !== null, true);  // pasa el bloqueo de 24 h
});
test('verificaCliente: telefono inexistente se comporta igual que cumpleanos incorrecto', async () => {
  const db = dbFalsa(); const t = 7000000;
  assert.strictEqual(await P.verificaCliente(db, 'ip', '8780000000', '01', '01', t), null);
});
test('lealtadRegistrar no pisa una cuenta existente', async () => {
  const db = dbFalsa({ clientesLealtad: { '8781234567': { nombre: 'Ana Real', cumpleanos: '1990-07-22', puntos: 50 } } });
  const r = await P.lealtadRegistrar({ body: { telefono: '8781234567', nombre: 'Intruso', cumpleanos: '2000-01-01' }, ip: 'ip', db, ahora: Date.parse('2026-10-12') });
  assert.deepStrictEqual(r, { ok: false, error: 'ya_existe' });
  assert.strictEqual(db.raiz.clientesLealtad['8781234567'].nombre, 'Ana Real');
  assert.strictEqual(db.raiz.clientesLealtad['8781234567'].puntos, 50);
});
test('lealtadRegistrar crea cuenta nueva con 0 puntos', async () => {
  const db = dbFalsa();
  const r = await P.lealtadRegistrar({ body: { telefono: '8781234567', nombre: 'Ana García', cumpleanos: '1990-07-22' }, ip: 'ip', db, ahora: Date.parse('2026-10-12') });
  assert.deepStrictEqual(r, { ok: true });
  const c = db.raiz.clientesLealtad['8781234567'];
  assert.strictEqual(c.nombre, 'Ana García'); assert.strictEqual(c.puntos, 0); assert.strictEqual(c.cumpleanos, '1990-07-22');
});
