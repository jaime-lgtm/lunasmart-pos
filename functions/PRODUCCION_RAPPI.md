# Pasar Rappi de PRUEBAS (DEV) a PRODUCCION

Todo el cambio de ambiente depende de **un interruptor** (`lib/ambiente.js`): `RAPPI_AMBIENTE=prod`.
Sin esa variable el sistema sigue en DEV. Hoy las tiendas reales ya estan mapeadas en `index.js`
(`TIENDAS_RAPPI`): `1923806519` -> Sueno de Luna / Casa de la Cultura, `1930016459` -> Helfy Fu
(ambas en la sucursal `cafeteria`).

## Antes de empezar (lo entrega Rappi)
- [ ] Credenciales de produccion: `client_id` y `client_secret` nuevos (NO reutilizar los de DEV).
- [ ] Dominios de Mexico. Por defecto se asume `https://services.mxgrability.rappi.com` para
      autenticacion, pedidos, menu y webhooks. Si Rappi indica otros, ponerlos en `functions/.env`
      (`RAPPI_DOMINIO`, o por separado `RAPPI_AUTH_BASE`, `RAPPI_API_BASE`, `RAPPI_WEBHOOKS_BASE`).
- [ ] Confirmar que el login del comerciante (Self Onboarding) en produccion es
      `https://login.partners.rappi.com` y cual es el `client_id` de ese flujo.
- [ ] Confirmar que 1923806519 y 1930016459 pertenecen a la cuenta de Partners del dueno.

## Pasos (en este orden)
1. **Secretos nuevos** (los corre el dueno en su terminal; piden pegar el valor):
   ```bash
   cd lunasmart-pos
   npx firebase-tools functions:secrets:set RAPPI_CLIENT_ID
   npx firebase-tools functions:secrets:set RAPPI_CLIENT_SECRET
   ```
2. **Interruptor** -- crear `functions/.env` con:
   ```
   RAPPI_AMBIENTE=prod
   ```
3. **Desplegar:** `npx firebase-tools deploy --only functions`
   (el token DEV guardado en cache se descarta solo: el cache ahora distingue ambiente).
4. **Probar login:** accion admin `probarAuth` debe responder "Login con Rappi correcto".
5. **Self Onboarding en produccion:**
   - accion `configurarWebhookOnboarding` (registra el aviso de aprovisionamiento);
   - actualizar `rappiAuth/onboardingConfig/clientId` con el client_id del flujo de produccion;
   - el dueno abre `https://us-central1-luna-smart-pos.cloudfunctions.net/rappiOnboardingInicio`
     e inicia sesion con SU cuenta real de Partners;
   - accion `onboardingTiendas` (debe listar las 2 tiendas reales) y despues
     `onboardingProvisionar` con `[{store_id:"1923806519",name:"Sueno de Luna Casa de la Cultura"},{store_id:"1930016459",name:"Helfy Fu"}]`.
6. **Webhooks de pedidos:** accion `registrarWebhooks` (registra los 7 eventos para las tiendas
   de produccion y guarda los secretos nuevos). Verificar con `listarWebhooks`.
7. **Menus** (primero revisar fotos/precios; ver el reporte de catalogo):
   - `enviarMenu` con `{"suc":"cafeteria"}` -> tienda 1923806519;
   - `enviarMenu` con `{"suc":"helfy"}` -> tienda 1930016459;
   - `estadoMenu` de cada una hasta que diga `AVAILABLE`.
8. **Disponibilidad y apertura:** `sincronizarDisponibilidad` por tienda y `tiendaAbierta`.
9. **Prueba real controlada:** pedir a Rappi (o hacer un pedido propio) de la tienda real y
   recorrer el flujo en el POS: alerta -> aceptar -> ticket -> listo -> corte.
10. **Primer dia:** vigilar `firebase functions:log` y el panel de Rappi del admin.

## Si algo sale mal (volver a DEV)
Borrar `RAPPI_AMBIENTE` de `functions/.env`, restaurar los secretos de DEV y volver a desplegar.
El POS no cambia: solo el backend de funciones.

## Notas
- Las pruebas de cancelacion/PING/HMAC del portal DEV caducan en ~1 dia; en produccion Rappi manda
  PING real cada ~3 min y no hace falta repetirlas.
- El token del comerciante (Self Onboarding) dura poco y no se renueva solo: si expira, repetir el paso 5.
