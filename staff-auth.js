/* Acceso del personal (POS, monitor, pantalla del cliente, tareas, repartidor).
 *
 * Antes estas apps entraban a Firebase como "anonimas", igual que cualquier
 * visitante del sitio publico: no habia forma de que las reglas de la base de
 * datos distinguieran a la caja de alguien con conocimientos de programacion.
 * Ahora cada dispositivo inicia sesion UNA vez con la cuenta del personal
 * (correo y contrasena) y Firebase guarda la sesion en el dispositivo.
 *
 * Uso: cargar despues de firebase-auth y sustituir
 *   var fbAuthReady = firebase.auth().signInAnonymously()...
 * por
 *   var fbAuthReady = staffAuthReady();
 * Se resuelve con el usuario cuando hay sesion de correo/contrasena.
 */
(function () {
  function esPersonal(u) {
    return !!(u && !u.isAnonymous && (u.providerData || []).some(function (p) { return p && p.providerId === 'password'; }));
  }
  function mensaje(e) {
    var c = (e && e.code) || '';
    if (c === 'auth/invalid-email') return 'Escribe un correo válido.';
    if (c === 'auth/too-many-requests') return 'Demasiados intentos. Espera unos minutos e intenta de nuevo.';
    if (c === 'auth/network-request-failed') return 'Sin conexión. Revisa el internet e intenta de nuevo.';
    if (c === 'auth/user-disabled') return 'Esta cuenta está desactivada. Pide ayuda al administrador.';
    return 'Correo o contraseña incorrectos.';
  }

  var overlay = null;
  function mostrarLogin(alEntrar) {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'staffLogin';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Iniciar sesión');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#1a1410;color:#f5ead8;display:flex;align-items:center;justify-content:center;padding:24px;font-family:Figtree,system-ui,-apple-system,Segoe UI,sans-serif;';
    overlay.innerHTML =
      '<form id="staffLoginForm" style="width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px;text-align:center" autocomplete="on">' +
        '<img src="logo-badge.png" alt="" style="width:84px;height:84px;margin:0 auto;border-radius:20px;object-fit:contain" onerror="this.remove()">' +
        '<div style="font-size:24px;font-weight:800;letter-spacing:.02em">Luna Smart</div>' +
        '<div style="font-size:14.5px;line-height:1.5;opacity:.75;margin-bottom:6px">Inicia sesión con la cuenta del personal. Solo se pide una vez en este dispositivo.</div>' +
        '<input id="staffEmail" type="email" name="username" autocomplete="username" inputmode="email" placeholder="Correo" required style="padding:15px 18px;border-radius:14px;border:2px solid rgba(245,234,216,.2);background:#2b2420;color:#f5ead8;font-size:16px;outline:none">' +
        '<input id="staffPass" type="password" name="password" autocomplete="current-password" placeholder="Contraseña" required style="padding:15px 18px;border-radius:14px;border:2px solid rgba(245,234,216,.2);background:#2b2420;color:#f5ead8;font-size:16px;outline:none">' +
        '<div id="staffErr" role="alert" style="min-height:20px;font-size:14px;font-weight:700;color:#ff9b8a"></div>' +
        '<button id="staffBtn" type="submit" style="padding:16px;border:0;border-radius:14px;background:#b14618;color:#f5ead8;font-size:16px;font-weight:800;letter-spacing:.04em;cursor:pointer">ENTRAR</button>' +
      '</form>';
    document.body.appendChild(overlay);
    var form = overlay.querySelector('#staffLoginForm'), err = overlay.querySelector('#staffErr'), btn = overlay.querySelector('#staffBtn');
    overlay.querySelector('#staffEmail').focus();
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      err.textContent = ''; btn.disabled = true; btn.textContent = 'ENTRANDO…';
      firebase.auth().signInWithEmailAndPassword(overlay.querySelector('#staffEmail').value.trim(), overlay.querySelector('#staffPass').value)
        .then(function (cred) {
          if (overlay) { overlay.remove(); overlay = null; }
          alEntrar(cred.user);
        })
        .catch(function (e) {
          btn.disabled = false; btn.textContent = 'ENTRAR';
          err.textContent = mensaje(e);
          overlay.querySelector('#staffPass').value = '';
        });
    });
  }

  window.staffAuthReady = function () {
    return new Promise(function (resolve) {
      var resuelto = false;
      function esperarDom(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }
      firebase.auth().onAuthStateChanged(function (u) {
        if (esPersonal(u)) {
          if (!resuelto) { resuelto = true; resolve(u); }
          return;
        }
        // Sin sesion de personal (primera vez, sesion anonima antigua o sesion cerrada/revocada).
        esperarDom(function () {
          mostrarLogin(function (usuario) {
            if (resuelto) { location.reload(); return; }   // se perdio la sesion con la app abierta: recargar para reconectar todo
            resuelto = true; resolve(usuario);
          });
        });
      });
    });
  };
})();
