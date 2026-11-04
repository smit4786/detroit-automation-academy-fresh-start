/* Mini fullscreen for The Signal / The Press views (design §4:
   fsmini on view headers). Toggles fullscreen on <main>; the
   engine's APP_LOCK_CSS fs-lock rules apply estate-wide via the
   fullscreenchange class on these pages' own body toggle below. */
(function () {
  'use strict';
  var main = document.getElementById('v2main');
  if (!main) return;
  var btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'fsmini'; btn.textContent = 'Fullscreen';
  btn.setAttribute('aria-pressed', 'false');
  document.body.appendChild(btn);
  function sync() {
    var on = document.fullscreenElement === main;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    document.body.classList.toggle('fs-lock', on);
  }
  btn.addEventListener('click', function () {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    var req = main.requestFullscreen || main.webkitRequestFullscreen;
    if (req) { var p = req.call(main); if (p && p.catch) p.catch(function () {}); }
  });
  document.addEventListener('fullscreenchange', sync);
})();
