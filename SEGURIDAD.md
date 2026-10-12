# Seguridad de Luna Smart (base de datos, sitio publico y apps del personal)

## Que se encontro (2026-10-12)
Todas las apps (sitio publico, POS, monitor, pantalla del cliente, tareas, repartidor) entraban a Firebase
como **anonimas**, y las reglas decian "cualquiera con sesion puede leer/escribir". Como la configuracion de
Firebase es publica (esta en el codigo de las paginas), **cualquier persona con conocimientos de programacion**
podia abrirla, iniciar sesion anonima y leer: pedidos (nombre, telefono y direccion de los clientes),
`usuariosPOS` (nombres, correos y **PIN** del personal), ventas del turno, caja, etc., y tambien escribir.
`clientesLealtad` se podia leer por telefono (nombre, direccion, cumpleanos, puntos).

## Como queda
- **Personal** = sesion de Firebase con correo y contrasena. Las reglas (`database.rules.json`) piden
  `auth.token.firebase.sign_in_provider === 'password'` para todo lo privado.
- **Sitio publico**: ya no toca `clientesLealtad` ni la lista de pedidos. Usa funciones del servidor
  (`functions/lib/publico.js`): `lealtadExiste`, `lealtadVerificar`, `lealtadRegistrar`, `pedidoCrear`, `cuentaMesa`.
  Solo devuelven lo minimo, comprueban el cumpleanos (dia y mes) para dar datos/puntos, y limitan intentos
  (5 fallos por telefono = bloqueo 24 h; limites por IP; contadores en `_limites/`, que solo ve el servidor).
- Lo unico que sigue de lectura publica: menu (`catalogo`, `modificadores`, `agotados`), `horarioTienda`, `eventos`
  y `eventosCupo`. Los pedidos solo se pueden leer por su clave (seguimiento del cliente), nunca listarlos.
- Apps del personal: `staff-auth.js` muestra una pantalla de acceso (correo/contrasena) **una vez por dispositivo**.

## Puesta en marcha / dispositivos nuevos
1. Cuenta del personal: Firebase Console -> Authentication -> Users -> Add user (correo + contrasena).
2. En cada dispositivo (caja, monitor, pantalla del cliente, tareas, telefonos de repartidores): abrir la app,
   iniciar sesion con esa cuenta. Firebase recuerda la sesion.
3. Para quitar acceso a un dispositivo perdido: cambiar la contrasena de esa cuenta en la consola (o deshabilitarla).
   Mejor: una cuenta por rol (caja, repartidores) para poder revocarlas por separado.

## Verificar
`node scripts/auditar_acceso_anonimo.js` -- imprime solo codigos HTTP; todo lo privado debe salir BLOQUEADO.

## Rollback de reglas
`git show <commit-anterior>:database.rules.json > database.rules.json` y `npx firebase-tools deploy --only database`.

## Riesgos que quedan (conocidos)
- La prueba de identidad del cliente es "telefono + dia y mes de cumpleanos" (366 combinaciones): con el limite de
  5 intentos/24 h por telefono es dificil de adivinar, pero no es tan fuerte como un SMS. Subir de nivel = codigo por
  SMS/WhatsApp (requiere proveedor).
- Quien tenga la cuenta del personal ve todo (incluidos PIN en `usuariosPOS`). Rotar PIN tras este cambio (estuvieron expuestos).
- `catalogo`/`modificadores` son publicos (el menu los necesita) y pueden incluir costos/recetas.
- El sitio publico no valida precios contra el catalogo en el servidor (solo recalcula el total y limita rangos).
