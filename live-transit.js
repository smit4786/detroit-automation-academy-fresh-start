/* Live Transit · Detroit — dedicated 3D page.
 *
 * All 37 DDOT routes (GTFS shapes) rendered as elevated 3D guideways, with
 * live bus positions polled from the Forge Line proxy every 60s. Bus pillars
 * are InstancedMesh (4 draw calls total); zooming in swaps to true-scale bus
 * models built lazily. Instant paint from the logged history file, with
 * honest live/retry badge states. Route filters by group (ConnectTen /
 * Primary / Neighborhood) plus per-route chips.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

(function () {
  'use strict';

  var STAMP = '20261025-2057';
  // Build string in the help footer derives from the cache stamp — never
  // hardcoded (2026-10-06: a stale hardcoded "Build 20261002-2780" shipped
  // for days before anyone noticed).
  try {
    var _bs = document.getElementById('build-stamp');
    if (_bs) _bs.textContent = 'Build ' + STAMP + '.';
  } catch (e) {}

  // === Error handling, steps 1–5 (2026-10-16) ==============================
  // Architecture: goals/forge-line-live-transit-layer/files/error-handling/
  // architectural-review-2026-10-16.md §4–§5. The pre-existing mechanisms
  // (recoverReload, the F2 frame guard + watchdog, the boot-chain catch,
  // the feed degradation notice) watch the render pipeline and the feed.
  // This block adds what they cannot see: global error capture with a
  // bounded on-device log (step 1), planner fault accounting (steps 2–3),
  // an interaction heartbeat distinct from frame production (step 4a),
  // camera sanity supervision (step 4b), and the recovery ladder that the
  // detectors route through (step 5). Everything here is defensive: the
  // logger never throws, and a supervisor's recovery is always cheaper
  // than the reload it precedes.
  var ERRLOG_MAX = 50, ERRLOG_BYTES = 65536;
  var flErrLog = [];
  var flErrLastKey = '', flErrLastAt = 0;
  var flFrameAt = 0; // mirrored by the frame loop each successful frame
  // Step 4a input stamps: passive listeners only observe; they never
  // intercept, preventDefault, or alter the event's path.
  var lastInputAt = 0, inputSeq = 0, flInputSeqSeen = 0;
  // Reduced-motion posture (project 28 item 4, register C-10): one flag
  // for the whole page, read from the OS preference at boot and kept
  // current if the preference changes mid-session. It governs camera
  // and marker MOTION only: OrbitControls damping off, camera glides
  // and planner flights complete in place, the stale-marker ease-back
  // starts already done, and the you-badge bob stills. Motion that
  // carries information (positions, treatments, the live dot) is never
  // gated by it — only the interpolation between states. The alerts
  // module reads the same media query at its own seam for the pulse
  // rings; that seam predates this flag and is left as shipped.
  var reducedMotionMq = (typeof window !== 'undefined' && window.matchMedia)
    ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var reducedMotion = !!(reducedMotionMq && reducedMotionMq.matches);
  if (reducedMotionMq && reducedMotionMq.addEventListener) {
    reducedMotionMq.addEventListener('change', function (e) {
      reducedMotion = !!e.matches;
      if (typeof controls !== 'undefined' && controls) {
        controls.enableDamping = !reducedMotion;
      }
    });
  }
  // Recovery ladder state (§4.6): per-rung fire counters, reset on boot
  // and after a rung's condition has stayed clear for 60 s.
  var ladderCounts = { interaction: 0, planner: 0, camera: 0 };
  var ladderLastFire = { interaction: 0, planner: 0, camera: 0 };
  // Planner fault accounting (§4.2): consecutive planner-path faults;
  // at 3, background re-planning and guidance pause until the next
  // successful user-initiated plan.
  var plannerFaultStreak = 0, plannerPaused = false, plannerFaultThisPoll = false;
  var plannerPollActive = false; // re-entry guard (stack-overflow fix, 20261016-2029)

  function errSnapshot() {
    var s = {};
    try {
      s.build = STAMP;
      s.tripMode = !!tripMode;
      s.tripLoading = !!tripLoading;
      s.journey = !!(tripJourneys && tripJourneys.length && tripSel >= 0);
      s.controlsEnabled = controls ? !!controls.enabled : null;
      s.camOwner = tripFly ? 'fly' : (streetTween ? 'tween' : (followVId ? 'follow' : null));
      s.streetView = !!streetView;
      if (camera && controls) s.camDist = Math.round(camera.position.distanceTo(controls.target));
      s.feedAgeS = lastPollT ? Math.round((performance.now() - lastPollT) / 1000) : null;
      s.inputAgeS = lastInputAt ? Math.round((performance.now() - lastInputAt) / 1000) : null;
      s.frameAgeMs = flFrameAt ? Math.round(performance.now() - flFrameAt) : null;
      s.plannerFaults = plannerFaultStreak;
      s.plannerPaused = plannerPaused;
    } catch (e) {}
    return s;
  }
  function errLogPersist() {
    try {
      var s = JSON.stringify(flErrLog);
      while (s.length > ERRLOG_BYTES && flErrLog.length > 1) {
        flErrLog.shift();
        s = JSON.stringify(flErrLog);
      }
      sessionStorage.setItem('fl-errlog', s);
    } catch (e) { /* storage unavailable: the log stays memory-only */ }
  }
  function errLog(cls, msg, err) {
    try {
      var m = String(msg == null ? '' : msg).slice(0, 300);
      var key = cls + '|' + m, now = Date.now();
      if (key === flErrLastKey && now - flErrLastAt < 5000) return; // de-dupe bursts
      flErrLastKey = key; flErrLastAt = now;
      var entry = { t: now, cls: cls, msg: m, snap: errSnapshot() };
      if (err && err.stack) {
        entry.stack = String(err.stack).split('\n').slice(0, 3).join(' | ').slice(0, 300);
      }
      flErrLog.push(entry);
      while (flErrLog.length > ERRLOG_MAX) flErrLog.shift();
      try { console.error('[fl-err]', cls, m); } catch (e2) {}
      errLogPersist();
    } catch (e3) { /* the logger must never throw */ }
  }
  // Previous session's entries survive one reload (marked prev), so a
  // freeze that ends in an OS tab kill still leaves its antecedents.
  try {
    var flPrevLog = JSON.parse(sessionStorage.getItem('fl-errlog') || '[]');
    if (flPrevLog && flPrevLog.length) {
      flPrevLog.forEach(function (en) { en.prev = 1; });
      flErrLog = flPrevLog.slice(-ERRLOG_MAX);
    }
  } catch (e) {}
  // Read-back hook for support/diagnostics (read-only copy).
  window.__flErrLog = function () { return flErrLog.slice(); };
  // Step 1: global capture. Installed before renderer construction so
  // boot-adjacent faults are captured too. Uncaught errors are logged,
  // never auto-recovered from here: recovery belongs to the detectors
  // that own a diagnosis (frame guard, watchdog, supervisors, ladder).
  window.addEventListener('error', function (e) {
    try {
      if (e && e.error) {
        errLog('error', (e.message || String(e.error)).slice(0, 300), e.error);
      } else if (e && e.target && e.target !== window) {
        errLog('background', 'resource error: ' + (e.target.tagName || 'unknown'));
      }
    } catch (e2) {}
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    try {
      var r = e && e.reason;
      errLog('rejection', ((r && r.message) || String(r)).slice(0, 300), r);
    } catch (e2) {}
  });
  // Step 4a: input heartbeat stamps (passive, capture-phase so a handler
  // that stops propagation cannot hide the input from the heartbeat).
  ['pointerdown', 'pointermove', 'touchstart', 'wheel', 'keydown'].forEach(function (type) {
    window.addEventListener(type, function () {
      lastInputAt = performance.now();
      inputSeq++;
    }, { passive: true, capture: true });
  });
  // Planner fault accounting (§4.2).
  function notePlannerFault(err, where) {
    plannerFaultThisPoll = true;
    plannerFaultStreak++;
    ladderCounts.planner++;
    ladderLastFire.planner = Date.now();
    errLog('planner', (where || 'planner') + ': ' + ((err && err.message) || String(err)), err);
    if (plannerFaultStreak >= 3 && !plannerPaused) {
      plannerPaused = true;
      hideGuidanceBanner();
      showPlannerFaultNote();
    }
  }
  function showPlannerFaultNote() {
    try {
      var host = document.getElementById('trip-results');
      if (!host || document.getElementById('trip-planner-fault')) return;
      var p = document.createElement('p');
      p.className = 'trip-note';
      p.id = 'trip-planner-fault';
      p.textContent = 'Could not plan the trip. Check your connection and try again.';
      host.insertBefore(p, host.firstChild);
    } catch (e) {}
  }
  function clearPlannerFaultNote() {
    try {
      var n = document.getElementById('trip-planner-fault');
      if (n && n.parentNode) n.parentNode.removeChild(n);
    } catch (e) {}
  }
  function unpausePlanner() {
    plannerPaused = false;
    plannerFaultStreak = 0;
    clearPlannerFaultNote();
  }
  // Recovery ladder (§4.6): L1 interaction reset, L2 planner reset
  // (containment + rollback + pause, above), L3 camera reset,
  // L4 ladderReload -> recoverReload, L5 fail(). A rung that would fire
  // a third time in a session escalates to L4 instead of repeating.
  function ladderFire(rung, action) {
    ladderCounts[rung] = (ladderCounts[rung] || 0) + 1;
    ladderLastFire[rung] = Date.now();
    errLog('ladder', rung + ' reset #' + ladderCounts[rung]);
    if (ladderCounts[rung] >= 3) {
      try {
        showToast(rung === 'camera' ? 'The map view was reset.'
          : 'The map stopped responding and was reset.', false);
      } catch (e) {}
      ladderReload('ladder-' + rung);
      return false;
    }
    action();
    return true;
  }
  function ladderReload(reason) {
    errLog('recovery', 'reload requested: ' + reason);
    recoverReload(reason);
  }
  // Step 4 frame-loop tick: input-starvation inference + camera sanity.
  // Runs inside the frame loop's try, but guards itself so a supervisor
  // fault can never masquerade as a frame fault.
  var ehCamBadStreak = 0, ehCamLastCheck = 0;
  function ehFrameTick(now) {
    try {
      if (inputSeq !== flInputSeqSeen) {
        if (lastInputAt && now - lastInputAt > 1000) {
          errLog('longtask', 'input observed late (>1000 ms): main-thread starvation inferred');
        }
        flInputSeqSeen = inputSeq;
      }
    } catch (e) {}
    if (now - ehCamLastCheck < 1000) return;
    ehCamLastCheck = now;
    try { ehCameraCheck(); } catch (e) {}
  }
  function ehCameraCheck() {
    if (tripFly || streetTween) { ehCamBadStreak = 0; return; } // an animation owns the camera
    var p = camera.position, t = controls.target;
    var bad = !(isFinite(p.x) && isFinite(p.y) && isFinite(p.z) &&
                isFinite(t.x) && isFinite(t.y) && isFinite(t.z));
    if (!bad) {
      var d = p.distanceTo(t);
      if (streetView) { if (d < 100 || d > 60000) bad = true; }
      else if (d < controls.minDistance * 0.8 || d > controls.maxDistance * 1.05) bad = true;
    }
    if (!bad) {
      ehCamBadStreak = 0;
      if (ladderCounts.camera > 0 && ladderLastFire.camera &&
          Date.now() - ladderLastFire.camera > 60000) ladderCounts.camera = 0;
      return;
    }
    ehCamBadStreak++;
    if (ehCamBadStreak < 3) return; // 3-check debounce (~3 s)
    ehCamBadStreak = 0;
    ladderFire('camera', function () {
      cancelTripFly();
      cancelStreetTween();
      var pos, tgt;
      if (camMem) { pos = camMem.pos.clone(); tgt = camMem.tgt.clone(); }
      else {
        // No preserved framing: recover to the home framing — the
        // setup literals (Project 16 overhaul, Option A).
        pos = new THREE.Vector3(3826, 8039, 9372);
        tgt = new THREE.Vector3(3826, 0, -205);
      }
      glideTo(pos, tgt, 900); // the existing interruptible glide: the rider can grab the camera mid-recovery
      try { showToast('The map view was reset.', false); } catch (e) {}
    });
  }
  // === Error handling block end ============================================
  var POLL_MS = 60000;

  var BUS_MAX = 400;
  var DETAIL_MAX = 48;
  var DEG = Math.PI / 180;
  var COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  var HISTORY_URL = 'https://raw.githubusercontent.com/smit4786/forge-line-transit-data/main/data/latest.json';

  var container = document.getElementById('live-map');
  if (!container) return;
  // Map gesture containment + trackpad-pinch bridge (backstop 2026-10-15;
  // bridge 2026-10-18, project 28 C-2): iOS Safari drives page pinch-zoom
  // through the proprietary gesture events when a pinch starts on a
  // surface touch-action does not cover, so gesture events originating
  // inside the map stage are always cancelled here (the document handler
  // further down is the second layer). The 2026-10-15 reasoning — camera
  // control is unaffected because OrbitControls consumes pointer events,
  // never gesture events — holds for TOUCHSCREEN pinch and fails for a
  // Magic Trackpad pinch on iPad, which arrives ONLY as gesture events:
  // the cancelled-and-dropped gesture left trackpad users with no pinch
  // zoom at all (project 28's founding defect). The stage handlers below
  // therefore CONSUME a canvas gesture while cancelling it: e.scale maps
  // to an anchored camera dolly (dollyAroundPoint, with the distance
  // clamps of zoomStep). Guards keep the touchscreen path exactly as
  // shipped: a gesture that begins while touch pointers are live on the
  // canvas belongs to the OrbitControls pointer pinch and is never consumed,
  // and if the camera moves during a gesture without the bridge moving
  // it, the bridge stands down for the rest of that gesture. Gestures
  // starting on panels (target is not the canvas) keep the plain
  // cancel-only defense.
  var mapStage = document.querySelector('.map-stage');
  var stageTouchPointers = 0;
  var stageGesture = null;
  if (mapStage && mapStage.addEventListener) {
    mapStage.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch' && renderer && e.target === renderer.domElement) stageTouchPointers++;
    }, true);
    mapStage.addEventListener('pointerup', function (e) {
      if (e.pointerType === 'touch' && stageTouchPointers > 0) stageTouchPointers--;
    }, true);
    mapStage.addEventListener('pointercancel', function (e) {
      if (e.pointerType === 'touch' && stageTouchPointers > 0) stageTouchPointers--;
    }, true);
    mapStage.addEventListener('gesturestart', function (e) {
      e.preventDefault();
      stageGesture = null;
      if (!renderer || e.target !== renderer.domElement) return;
      if (stageTouchPointers > 0) return; // touchscreen pinch: OrbitControls owns it
      if (typeof e.scale !== 'number' || !(e.scale > 0)) return;
      var dist = camera.position.distanceTo(controls.target);
      if (!(dist > 0)) return;
      stageGesture = { base: dist, last: dist, x: e.clientX, y: e.clientY };
    }, { passive: false });
    mapStage.addEventListener('gesturechange', function (e) {
      e.preventDefault();
      if (!stageGesture) return;
      if (typeof e.scale !== 'number' || !(e.scale > 0)) { stageGesture = null; return; }
      var dist = camera.position.distanceTo(controls.target);
      if (Math.abs(dist - stageGesture.last) > Math.max(2, stageGesture.last * 0.02)) {
        stageGesture = null; // the camera moved without the bridge: not ours
        return;
      }
      if (typeof e.clientX === 'number' && typeof e.clientY === 'number') {
        stageGesture.x = e.clientX; stageGesture.y = e.clientY;
      }
      var want = stageGesture.base / e.scale;
      want = Math.max(controls.minDistance, Math.min(controls.maxDistance, want));
      dollyAroundPoint(stageGesture.x, stageGesture.y, want / dist);
      stageGesture.last = camera.position.distanceTo(controls.target);
    }, { passive: false });
    mapStage.addEventListener('gestureend', function (e) {
      e.preventDefault();
      stageGesture = null;
    }, { passive: false });
    // Selection discipline (project 28 item 6, register C-19): the CSS in
    // live-transit.html opts the whole stage out of text selection and
    // re-enables it only in the reading surfaces (cards, panels, Help,
    // the fallback message), but CSS alone cannot stop a selection that
    // STARTS on the canvas — a non-selectable element — and anchors as
    // the drag sweeps across one of those kept-selectable surfaces in
    // iPad Safari (founding capture 2026-10-18: an external-mouse drag
    // painting a select-all highlight across the map chrome). A
    // mousedown on the stage outside the reading surfaces and the form
    // fields is a navigation gesture, so its default — selection
    // start — is prevented here. Nothing else rides that default:
    // OrbitControls, the picks and the gesture bridge consume
    // pointer/gesture events, and click still fires. One side effect is
    // repaired explicitly: a prevented mousedown would keep a mouse
    // click from focusing #live-map, the documented entry to the
    // keyboard map ("click the map: arrow keys move"), so a canvas
    // mousedown restores that focus itself.
    mapStage.addEventListener('mousedown', function (e) {
      var t = e.target;
      if (t && t !== mapStage && t.closest &&
          t.closest('input, textarea, select, [contenteditable], .bus-card, .filter-panel, .browse-panel, .nav-card, .map-fallback')) return;
      e.preventDefault();
      if (renderer && t === renderer.domElement && container && container.focus) {
        try { container.focus({ preventScroll: true }); } catch (err) { container.focus(); }
      }
    });
  }
  var $ = function (id) { return document.getElementById(id); };
  // Shared screen-reader announcements (defect sr-status): one polite live
  // region (#sr-status in live-transit.html) for dynamic changes that have
  // no visible live region of their own — card opens, trip results, and
  // filter changes. Clearing first, then setting in a timeout, makes a
  // repeated identical message announce again.
  var _srFilterShown = null;
  function announceSr(msg) {
    var el = $('sr-status');
    if (!el || !msg) return;
    el.textContent = '';
    setTimeout(function () { el.textContent = msg; }, 30);
  }

  function fail(msg) {
    container.innerHTML = '<div class="map-fallback"><p>' + msg + '</p></div>';
  }

  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (e) {
    fail('3D is not available in this browser.');
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  // Crash recovery (2026-10-16, post-incident F1): iOS WebKit kills the
  // GPU process under sustained memory pressure; the canvas then
  // composites black indefinitely and, before this block existed,
  // nothing in the app detected it, recovered, or told the user. On
  // context loss: notify and reload once. The reload is guarded by a
  // sessionStorage timestamp — a second loss within 30 s of a recovery
  // reload shows the standing fallback surface with manual instructions
  // instead of looping. If the platform restores the context before the
  // reload fires, the reload stands down.
  var recovering = false;
  var flStateProvider = null; // boot scope registers a camera+selection snapshot for recovery reloads
  function recoverReload(reason) {
    if (recovering) return;
    recovering = true;
    var last = 0;
    try { last = +(sessionStorage.getItem('fl-recover-at') || 0); } catch (e) {}
    if (Date.now() - last < 30000) {
      fail('The map display stopped and could not be restored automatically. Close this tab and reopen the page to continue.');
      return;
    }
    showToast('Display interrupted — reloading the map…', true);
    setTimeout(function () {
      var gl = null;
      try { gl = renderer.getContext(); } catch (e) {}
      if (gl && !gl.isContextLost()) { recovering = false; return; }
      // Token fix (2026-10-16, error-handling step 5): the loop-guard
      // timestamp is written only here, once the reload is certain. The
      // previous bytes stamped it before the stand-down check above, so
      // a stand-down (context alive, no reload ever attempted) consumed
      // the one automatic recovery and a genuine failure within 30 s
      // went straight to the terminal fallback.
      try { sessionStorage.setItem('fl-recover-at', '' + Date.now()); } catch (e) {}
      // State preservation (2026-11-05, owner directive): a recovery
      // reload must not destroy the rider's place — snapshot camera and
      // route selection; the boot scope restores them (10 min window).
      try {
        if (typeof flStateProvider === 'function') {
          var flSt = flStateProvider();
          if (flSt) { flSt.at = Date.now(); sessionStorage.setItem('fl-state', JSON.stringify(flSt)); }
        }
      } catch (e) {}
      location.reload();
    }, 600);
  }
  renderer.domElement.addEventListener('webglcontextlost', function (e) {
    e.preventDefault(); // lets the platform fire contextrestored
    ladderReload('context');
  }, false);
  renderer.domElement.addEventListener('webglcontextrestored', function () {
    try { sessionStorage.removeItem('fl-recover-at'); } catch (e) {}
  }, false);

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010103);
  scene.fog = new THREE.Fog(0x010103, 32000, 75000);

  var camera = new THREE.PerspectiveCamera(42, 1, 100, 140000);
  // Home framing (2026-10-18, Project 16 overhaul gate, Option A —
  // Justin's pick): the first-load view centers Detroit's geographic
  // center (42.383, -83.102 in scene units) at a 40-degree elevation
  // and 12,500 m distance, so the first frame is the city itself, with
  // the downtown hub still in view lower-right. This supersedes the
  // 2026-10-15 Accessible Detroit framing (Campus Martius, 35 degrees,
  // ~20.5 km), retained by Project 16 on 2026-10-17 before the overhaul
  // gate reframed the question around screen composition: in the
  // founding capture the water was ~a quarter of the screen at 2.6x
  // the ground's luminance (diagnosis-and-options.md has the numbers).
  // Distance-keyed consequences at 12,500 m, all automatic: the frame
  // crosses the 13,000 m label band, so live single-route stops
  // (tier 2) join the home label set under the standing cap of 12; the
  // stop glyph footprint at home is stopXZFor(12500) = 1.5625x; the
  // water quiets to 0x1f1f1f and the far shore reads as dim land at
  // 0x141414 (buildWater). The 22,000 m local-street ceiling in the
  // frame loop stands as the bound on ANY home distance: 12,500 m
  // keeps local streets on at home with 9,500 m of headroom, and no
  // future reframe may park home at or above the ceiling without
  // re-setting it in the same build.
  // homePos/homeTarget below clone these values, so the rail's Home/Reset
  // control returns to exactly this framing.
  camera.position.set(3826, 8039, 9372);

  var controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(3826, 0, -205);
  controls.enableDamping = !reducedMotion;
  controls.dampingFactor = 0.08;
  // Pinch/wheel zoom anchors to the fingers/cursor, not the orbit target —
  // otherwise the point you meant to zoom into drifts away mid-gesture.
  // (r160 already implements this; it just ships disabled by default.)
  controls.zoomToCursor = true;
  controls.maxPolarAngle = 1.35;
  controls.minDistance = 1200;
  controls.maxDistance = 55000;

  // Touchscreen navigation: one finger drags the map (like a maps app),
  // pinch zooms and two-finger twist rotates. Desktop keeps drag-orbit.
  var homePos = camera.position.clone();
  var homeTarget = controls.target.clone();
  var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  if (isTouch) {
    controls.touches.ONE = THREE.TOUCH.PAN;
    controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
    // Pointer parity on touch-first hardware (project 28, C-3): a mouse
    // or trackpad attached to a touch device mirrors the touch grammar —
    // primary drag pans, right-drag orbits/tilts — instead of the
    // OrbitControls desktop defaults (primary orbits, pan on right-drag
    // only), under which an iPad pointer has no pan path at all (no
    // button-2 drag stream is deliverable there). Non-touch desktops
    // keep the defaults untouched. mouseButtons governs mouse/pen
    // pointers only; the touch mapping above is unchanged.
    controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
    controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
  }

  scene.add(new THREE.HemisphereLight(0xf2f2f2, 0x101010, 0.9));
  var sun = new THREE.DirectionalLight(0xffffff, 0.7);
  sun.position.set(9000, 14000, 5000);
  scene.add(sun);

  // --- textures -----------------------------------------------------------
  function radialTex(inner, mid) {
    var c = document.createElement('canvas');
    c.width = c.height = 256;
    var x = c.getContext('2d');
    var g = x.createRadialGradient(128, 128, 8, 128, 128, 126);
    g.addColorStop(0, inner);
    g.addColorStop(0.45, mid);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
  }
  var glowTex = radialTex('rgba(255,255,255,1)', 'rgba(255,255,255,0.35)');

  // Street-map coverage bounds (WGS84). Streets are drawn as vector
  // geometry from U.S. Census TIGER/Line 2025 (see build scripts); no raster tiles.
  var STREET_BOUNDS = { lonW: -83.3431083, lonE: -82.8992288, latN: 42.47997522924901, latS: 42.25539743550126 };
  // Street-mosaic bounds: the expanded mosaic (Downriver south, suburbs
  // west). The ground plane and the coverage border are drawn to this
  // extent; the core street tiers render inside STREET_BOUNDS.
  var MOSAIC_BOUNDS = { lonW: -83.385, lonE: -82.8992288, latN: 42.47997522924901, latS: 42.178 };

  // --- path smoothing ---------------------------------------------------
  // Chaikin corner-cutting: each iteration replaces every segment with two
  // quarter-points, quadrupling density and rounding kinks into smooth
  // curves. Fixes the blocky "plank joint" look at intermediate zooms.
  // Returns a new array; the input is never mutated.
  function chaikin(pts) {
    var n = pts.length;
    if (n < 3) return pts.slice();
    var out = [pts[0]];
    for (var i = 0; i < n - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out.push(pts[n - 1]);
    return out;
  }
  // Angle-aware resampling (ribbon splintering repair, queue step 3):
  // the compiled paths bound POSITIONAL deviation (DP eps = 2 m) but
  // not angle, so curves digitized as a few long chords keep hard
  // joints after smoothing (diagnosis class 3): a smoothed edge over
  // 20 m beside a turn over 3 deg is a visible plank joint, and there
  // were 21,678 of them. A raw edge only produces a > 20 m smoothed
  // edge when it runs longer than ~80 m, and the Chaikin pass reaches
  // only the two segments beside a vertex, so the rule is narrow:
  // beside any turn of 3-150 deg, an adjacent edge longer than 80 m
  // gets a point 40 m from the turn vertex (and a second at 120 m
  // when the edge runs longer), making the two segments the
  // redistribution touches <= 40 and <= 80 m. Everything else --
  // short edges, gentle vertices, the far middle of a long edge --
  // is emitted untouched. Inserted points lie ON the path's chords --
  // the centerline as a point set is unchanged; only its sampling
  // density beside turns changes. Turns >= 150 deg are folds, not
  // curves, and vertices beside short edges are already dense: both
  // are emitted untouched, as is every vertex the rule does not reach.
  // (An arc-insertion variant aimed at class 1's tight-radius family
  // was built and measured during this repair and rejected: at
  // digitization density, circumradius < 48 m describes most vertices
  // on the SMART layer, and the insertions multiplied the strip
  // without reducing its dark census. Class 1 is repaired in the
  // sweep and the normals instead -- foldLift below and
  // windingSplitNormals at the deck merge.) Only the guideway build
  // opts in (see the route loop); other ribbonGeometry callers keep
  // the exact pre-patch point stream.
  function resamplePath(pts) {
    var n = pts.length;
    if (n < 3) return pts.slice();
    function elen(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
    function turnDeg(a, b, c) {
      var d0x = b[0] - a[0], d0z = b[1] - a[1];
      var d1x = c[0] - b[0], d1z = c[1] - b[1];
      var l0 = Math.hypot(d0x, d0z), l1 = Math.hypot(d1x, d1z);
      if (l0 < 1e-9 || l1 < 1e-9) return 0;
      var cs = (d0x * d1x + d0z * d1z) / (l0 * l1);
      return Math.acos(Math.max(-1, Math.min(1, cs))) * 180 / Math.PI;
    }
    // Insertion fractions per edge (edge i runs pts[i] -> pts[i+1]),
    // demanded by the turn at either endpoint.
    var cuts = [];
    for (var e = 0; e < n - 1; e++) cuts.push([]);
    function demand(e2, fromStart) {
      var L = elen(pts[e2], pts[e2 + 1]);
      if (L <= 80) return;
      cuts[e2].push(fromStart ? 40 / L : 1 - 40 / L);
      if (L > 120) cuts[e2].push(fromStart ? 120 / L : 1 - 120 / L);
    }
    for (var i = 1; i < n - 1; i++) {
      var t = turnDeg(pts[i - 1], pts[i], pts[i + 1]);
      if (t <= 3 || t >= 150) continue;
      demand(i - 1, false);
      demand(i, true);
    }
    var out = [pts[0]];
    for (var v = 1; v < n; v++) {
      var a0 = pts[v - 1], b0 = pts[v], fr = cuts[v - 1].sort(function (x, y) { return x - y; });
      for (var s2 = 0; s2 < fr.length; s2++) {
        if (s2 > 0 && fr[s2] - fr[s2 - 1] < 1e-9) continue;
        var f = fr[s2];
        out.push([a0[0] + (b0[0] - a0[0]) * f, a0[1] + (b0[1] - a0[1]) * f]);
      }
      out.push(pts[v]);
    }
    return out;
  }
  // Fold lift (ribbon splintering repair, class 1): where the smoothed
  // strip folds back on itself or pinches (local circumradius under
  // the layer half-width), the strip's return leg rides up to 2.4 m
  // above the outgoing leg across a 45 m window past the fold vertex.
  // Separated in height, the two legs stop sharing a plane; combined
  // with the deck's explicit up normals (route build, below) the fold
  // fan shades as lit surface instead of near-black shards. The window
  // mirrors the diagnosis (93.7% of fold detections had a dark fan
  // within 45 m) and the peak is two of the existing 1.2 m inter-route
  // steps -- the largest separation the layer cake already uses, so no
  // new visual scale is introduced. Points outside every window get
  // lift 0 and keep their exact pre-patch height.
  function foldLift(pts, hw) {
    var n = pts.length;
    var lift = new Float32Array(n);
    var PEAK = 2.4, WIN = 45;
    for (var j = 1; j < n - 1; j++) {
      var a = pts[j - 1], b = pts[j], c = pts[j + 1];
      var cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(cr) < 1e-9) continue;
      var la = Math.hypot(c[0] - b[0], c[1] - b[1]);
      var lb = Math.hypot(c[0] - a[0], c[1] - a[1]);
      var lc = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (la * lb * lc / (2 * Math.abs(cr)) >= hw) continue;
      var acc = 0;
      for (var i = j; i < n; i++) {
        if (i > j) {
          acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
          if (acc > WIN) break;
        }
        var w = 1 - acc / WIN;
        var prof = (i === j) ? 0.5 : w * w * (3 - 2 * w);
        var val = PEAK * prof;
        if (val > lift[i]) lift[i] = val;
      }
    }
    return lift;
  }
  // True miter offset for point i: offset along the angle bisector, scaled
  // by 1/cos(half-angle) so the ribbon holds constant width through turns
  // instead of pinching. Clamped to 2x to avoid spikes on hairpins.
  function miterOffset(pts, i, hw) {
    var n = pts.length;
    var p = pts[i];
    var a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    var d0x = p[0] - a[0], d0z = p[1] - a[1];
    var d1x = b[0] - p[0], d1z = b[1] - p[1];
    var l0 = Math.hypot(d0x, d0z), l1 = Math.hypot(d1x, d1z);
    var nx, nz, m;
    if (l0 < 1e-6 || l1 < 1e-6) {
      var ex = l0 >= l1 ? d0x : d1x, ez = l0 >= l1 ? d0z : d1z;
      var el = Math.hypot(ex, ez) || 1;
      nx = -ez / el; nz = ex / el; m = 1;
    } else {
      d0x /= l0; d0z /= l0; d1x /= l1; d1z /= l1;
      var tx = d0x + d1x, tz = d0z + d1z, tl = Math.hypot(tx, tz);
      if (tl < 1e-6) { nx = -d0z; nz = d0x; m = 1; }
      else {
        tx /= tl; tz /= tl; nx = -tz; nz = tx;
        m = 1 / Math.max(0.5, nx * -d0z + nz * d0x);
      }
    }
    return [nx * hw * m, nz * hw * m];
  }

  // --- geometry helpers ---------------------------------------------------
  function ribbonGeometry(pts, width, y, opts) {
    // opts (guideway build only): { repair, slot, lift } -- resample
    // the raw path, ride the strip on this path's height slot plus the
    // fold lift. Callers without opts (trip highlight, People Mover,
    // alert ribbons) get the exact pre-patch geometry: same point
    // stream, same heights.
    var repair = !!(opts && opts.repair);
    if (repair) pts = resamplePath(pts);
    pts = chaikin(chaikin(pts));
    var n = pts.length;
    var pos = new Float32Array(n * 2 * 3);
    var idx = [];
    var hw = width / 2;
    var slot = repair ? (opts.slot || 0) : 0;
    var lift = (repair && opts.lift !== false) ? foldLift(pts, hw) : null;
    for (var i = 0; i < n; i++) {
      var p = pts[i], o = miterOffset(pts, i, hw);
      var yy = y + slot + (lift ? lift[i] : 0);
      pos.set([p[0] + o[0], yy, p[1] + o[1]], i * 6);
      pos.set([p[0] - o[0], yy, p[1] - o[1]], i * 6 + 3);
      if (i < n - 1) {
        var k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  }

  // Merge position-only ribbon geometries into one geometry (crash
  // resilience, 2026-10-16): the route builder used to add four meshes
  // per PATH — 206 paths x 4 = ~824 draw calls at boot, sustained GPU
  // pressure in an all-day mobile tab. Merging each route's paths per
  // layer cuts that to at most four meshes per ROUTE (~332) with
  // identical vertices: nothing downstream addresses a per-path mesh
  // (picking uses the instanced stops and vehicle bodies; dimming and
  // street fade act on per-route materials; toggles act on the route
  // group), so the merge is render-equivalent. Normals merge when every
  // input carries them (skirts); the deck computes its normals after
  // the merge, exactly as it did per path. Inputs are disposed.
  function mergeGeoms(geoms) {
    if (geoms.length === 1) return geoms[0];
    var total = 0, idxTotal = 0, withNormals = geoms.length > 0;
    var withARoute = geoms.length > 0, withColor = geoms.length > 0;
    geoms.forEach(function (g) {
      total += g.attributes.position.count;
      idxTotal += g.index.count;
      if (!g.attributes.normal) withNormals = false;
      if (!g.attributes.aRoute) withARoute = false;
      if (!g.attributes.color) withColor = false;
    });
    var pos = new Float32Array(total * 3);
    var nor = withNormals ? new Float32Array(total * 3) : null;
    var art = withARoute ? new Float32Array(total) : null;
    var col = withColor ? new Float32Array(total * 3) : null;
    var idx = new Uint32Array(idxTotal);
    var vo = 0, io = 0;
    geoms.forEach(function (g) {
      pos.set(g.attributes.position.array, vo * 3);
      if (nor) nor.set(g.attributes.normal.array, vo * 3);
      if (art) art.set(g.attributes.aRoute.array, vo);
      if (col) col.set(g.attributes.color.array, vo * 3);
      var gi = g.index.array;
      for (var i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
      vo += g.attributes.position.count;
      io += gi.length;
      g.dispose();
    });
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (nor) out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (art) out.setAttribute('aRoute', new THREE.BufferAttribute(art, 1));
    if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    return out;
  }

  // Winding-split normals (ribbon splintering repair, class 1): returns
  // a copy of an indexed ribbon geometry in which no vertex is shared
  // between faces of opposite plan-view winding, with vertex normals
  // computed on the split. A swept strip reverses its winding where it
  // folds back on itself; with shared vertices, computeVertexNormals
  // averages the two legs' opposite face normals at the fold and the
  // fan triangles between the populations shade near-black under the
  // scene's light rig. After the split, each face's normals come only
  // from its own winding population, so both legs of a fold shade as
  // the lit surface they are. Vertices away from winding boundaries
  // are shared exactly as before (the split costs duplicates only at
  // fold seams), positions and attributes are copied verbatim, and
  // face order is preserved.
  function windingSplitNormals(g) {
    var pos = g.attributes.position.array;
    var idx = g.index.array;
    var names = [];
    ['aRoute', 'color'].forEach(function (nm) { if (g.attributes[nm]) names.push(nm); });
    var srcAttrs = names.map(function (nm) { return g.attributes[nm]; });
    var outAttrs = names.map(function () { return []; });
    var map = {};
    var newPos = [];
    var newIdx = new Uint32Array(idx.length);
    var next = 0;
    function emit(v, sign) {
      var key = v * 2 + (sign > 0 ? 1 : 0);
      var ni = map[key];
      if (ni === undefined) {
        ni = next++; map[key] = ni;
        newPos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        for (var a = 0; a < names.length; a++) {
          var sa = srcAttrs[a], isz = sa.itemSize;
          for (var c = 0; c < isz; c++) outAttrs[a].push(sa.array[v * isz + c]);
        }
      }
      return ni;
    }
    for (var f = 0; f < idx.length; f += 3) {
      var a3 = idx[f], b3 = idx[f + 1], c3 = idx[f + 2];
      var cy = (pos[b3 * 3 + 2] - pos[a3 * 3 + 2]) * (pos[c3 * 3] - pos[a3 * 3]) -
               (pos[b3 * 3] - pos[a3 * 3]) * (pos[c3 * 3 + 2] - pos[a3 * 3 + 2]);
      var sign = cy >= 0 ? 1 : -1;
      newIdx[f] = emit(a3, sign);
      newIdx[f + 1] = emit(b3, sign);
      newIdx[f + 2] = emit(c3, sign);
    }
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(newPos), 3));
    for (var a2 = 0; a2 < names.length; a2++) {
      out.setAttribute(names[a2], new THREE.BufferAttribute(new Float32Array(outAttrs[a2]), srcAttrs[a2].itemSize));
    }
    out.setIndex(new THREE.BufferAttribute(newIdx, 1));
    out.computeVertexNormals();
    return out;
  }

  // Vertical skirts under an elevated ribbon: turns a flat strip into a solid
  // 3D guideway. One skirt per edge, from y=0 up to yTop.
  function skirtGeometry(pts, width, yTop, opts) {
    // Same guideway opts contract as ribbonGeometry: the skirt top
    // follows the deck's slot + fold lift exactly, so the wall still
    // meets the deck edge at fold sites (no slot of daylight under a
    // lifted return leg). The ground edge stays at y = 0.
    var repair = !!(opts && opts.repair);
    if (repair) pts = resamplePath(pts);
    pts = chaikin(chaikin(pts));
    var n = pts.length;
    var pos = [];
    var idx = [];
    var hw = width / 2;
    var slot = repair ? (opts.slot || 0) : 0;
    var lift = repair ? foldLift(pts, hw) : null;
    function edgePt(i, side, y) {
      var p = pts[i], o = miterOffset(pts, i, hw);
      return [p[0] + o[0] * side, y, p[1] + o[1] * side];
    }
    [1, -1].forEach(function (side) {
      var base = pos.length / 3;
      for (var i = 0; i < n; i++) {
        var b = edgePt(i, side, 0), t = edgePt(i, side, yTop + slot + (lift ? lift[i] : 0));
        pos.push(b[0], b[1], b[2], t[0], t[1], t[2]);
        if (i < n - 1) {
          var k = base + i * 2;
          idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
        }
      }
    });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  function makeLabel(text, colorHex) {
    var c = document.createElement('canvas');
    c.height = 128;
    // Long text (the People Mover title) must not clip at the canvas edge:
    // measure at the standard size and widen the pill to fit, keeping the
    // same type size as the route chips.
    var mx = c.getContext('2d');
    mx.font = '600 52px "Space Grotesk", sans-serif';
    var tw = Math.ceil(mx.measureText(text).width);
    c.width = tw > 460 ? tw + 52 : 512;
    var x = c.getContext('2d');
    x.fillStyle = 'rgba(16,16,16,0.85)';
    x.beginPath();
    if (x.roundRect) x.roundRect(6, 14, c.width - 12, 100, 50); else x.rect(6, 14, c.width - 12, 100);
    x.fill();
    x.strokeStyle = colorHex; x.lineWidth = 4; x.stroke();
    x.fillStyle = colorHex;
    x.font = '600 52px "Space Grotesk", sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, c.width / 2, 68);
    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(375 * c.width / c.height, 375, 1);
    return sp;
  }

  // --- state ---------------------------------------------------------------
  var routeColors = {};   // id -> THREE.Color
  var routeNames = {};    // id -> name
  var routeById = {};     // id -> route record from JSON
  var routeGroups = {};   // route id -> THREE.Group (guideway + label + tether)
  // Render-engine refactor Phase 1 (project 15): guideway geometry is
  // merged across routes into one mesh per class (glow / casing / deck /
  // skirt). Per-route visibility and dimming — the filter gate's core
  // operations — are preserved in the shader: every merged vertex carries
  // an aRoute index; uRouteVis discards hidden routes' fragments and
  // uRouteAlpha carries the per-route guide alpha (dim x street fade).
  // routeGroups[rid].visible keeps its exact semantics for the label,
  // tether, alert overlays, and updateBuses' group check; applyFilters
  // mirrors the same routeShown() result into uRouteVis.
  var ROUTE_MAX = 128;
  var routeVisU = { value: new Float32Array(ROUTE_MAX).fill(1) };
  var routeAlphaU = { value: new Float32Array(ROUTE_MAX).fill(1) };
  var routeIndexById = {};  // route id -> index into the uniform arrays
  var routeDimmed = {};     // route id -> current dim state (applyDim)
  function routeShader(mat, withAlpha) {
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uRouteVis = routeVisU;
      if (withAlpha) sh.uniforms.uRouteAlpha = routeAlphaU;
      sh.vertexShader = 'attribute float aRoute;\nvarying float vRoute;\n' +
        sh.vertexShader.replace('#include <begin_vertex>',
          '#include <begin_vertex>\n\tvRoute = aRoute;');
      sh.fragmentShader = ('uniform float uRouteVis[' + ROUTE_MAX + '];\n' +
        (withAlpha ? 'uniform float uRouteAlpha[' + ROUTE_MAX + '];\n' : '') +
        'varying float vRoute;\n') + sh.fragmentShader
        .replace('#include <clipping_planes_fragment>',
          '#include <clipping_planes_fragment>\n\tif (uRouteVis[int(vRoute + 0.5)] < 0.5) discard;')
        .replace('#include <color_fragment>',
          '#include <color_fragment>' + (withAlpha ?
            '\n\tdiffuseColor.a *= uRouteAlpha[int(vRoute + 0.5)];' : ''));
    };
    mat.customProgramCacheKey = function () { return withAlpha ? 'routeA' : 'routeV'; };
    return mat;
  }
  function tagRouteGeom(g, routeIdx, color) {
    var n = g.attributes.position.count;
    var ar = new Float32Array(n);
    for (var i = 0; i < n; i++) ar[i] = routeIdx;
    g.setAttribute('aRoute', new THREE.BufferAttribute(ar, 1));
    if (color) {
      var col = new Float32Array(n * 3);
      for (var j = 0; j < n; j++) { col[j * 3] = color.r; col[j * 3 + 1] = color.g; col[j * 3 + 2] = color.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    return g;
  }
  function refreshRouteAlpha(rid) {
    var idx = routeIndexById[rid];
    if (idx == null) return;
    routeAlphaU.value[idx] = (routeDimmed[rid] ? DIM_OPACITY : 1) * streetGuideFade;
  }
  var groupObjs = {};     // group id -> THREE.Group (stops cloud)
  var routeOrder = [];
  var groupOrder = [];
  var labelSprites = [];  // { sprite, routeId }
  var liveCounts = {};    // route id -> live bus count (raw, pre-filter)
  // Smart disabling: per-route running state. 'unknown' until the first live
  // poll (history paint never marks routes not-running). A route flips to
  // 'not-running' only after 3 consecutive polls with zero buses (grace
  // against brief feed dropouts); any bus resets the streak immediately.
  var runningState = {};  // rid -> 'unknown' | 'running' | 'not-running'
  var quietStreak = {};   // rid -> consecutive polls with zero buses
  var DIM_OPACITY = 0.22;
  var proj = null;
  var streetData = null; // vector streets (assets/detroit-streets.json)
  var streetNameData = null; // street name anchors (assets/detroit-street-names.json)
  var stopData = null;   // raw stops array from ddot-routes-3d.json

  // People Mover layer: static schedule geometry (no live feed exists —
  // verified 2026-10-05). Independent of the DDOT route filter machinery:
  // its own toggle, its own honesty labeling, never presented as live.
  var pmGroup = null;      // THREE.Group: loop deck + skirts + station pins + label
  var pmStations = [];     // pickable records {id, n, x, z, r:['DPM'], pm:true}
  var pmPins = [];         // station pin meshes (zoom-scaled with the stop family)
  var pmLabel = null, pmTether = null;
  var pmVisible = false; // OFF by default: user enables via pm-toggle
  var belleIsleLabel = null, belleIsleTether = null; // island landmass label (static layer)
  var waterLabels = [];    // project 16 place labels {sprite, tether} (Detroit River / Windsor / Lake St. Clair)
  var PM_DECK_Y = 140;     // elevated guideway: floats above the highest DDOT route deck (~110)

  function project(lat, lon) {
    return [(lon - proj.lon0) * proj.mLon, -(lat - proj.lat0) * proj.mLat];
  }

  // --- fleet data: vehicle number -> model, dimensions, seating ----------------
  var fleetData = null;
  function fleetLookup(vehicleId) {
    var fallback = { model: '40-ft transit bus', detail: 'model assumed', length_m: 12.19, width_m: 2.59, height_m: 3.3, seats: null, assumed: true };
    if (!fleetData || !fleetData.ranges) return fallback;
    var m = String(vehicleId == null ? '' : vehicleId).match(/^(\d+)/);
    if (!m) return fallback;
    var num = parseInt(m[1], 10);
    for (var i = 0; i < fleetData.ranges.length; i++) {
      var r = fleetData.ranges[i];
      if (num >= r.from && num <= r.to) {
        return {
          model: r.model,
          detail: r.year + (r.note ? ' · ' + r.note : ''),
          length_m: r.length_m, width_m: r.width_m, height_m: r.height_m,
          seats: r.seats, assumed: false
        };
      }
    }
    return fallback;
  }

  // --- bus pillars: InstancedMesh, 4 draw calls total --------------------------
  // Marker assembly redesigned 2026-10-06 for the true-scale skyline
  // (landmark massing: RenCen 221m). The full stack — glow, core, beacon
  // ("ceiling"), ground ring ("floor"), badges — is sized as one coherent
  // marker language: visible at wide zoom, subordinate to the towers,
  // compact at street zoom. Nothing in the assembly exceeds ~265m.
  var PILLAR_H = 220;
  // Zoom-coupled marker scale: full-height symbolic pillars wide out, shrinking
  // as the camera dives so downtown stays intelligible at street zoom. The
  // handoff to true-scale bus models happens at ~2.6 km (updateLOD).
  var pillarYS = 1;
  function pillarScaleFor(d) {
    // Same close-zoom floor as stops: bus markers must stay readable when the
    // camera moves in close (e.g. after selecting a bus flies the view to it).
    var lo = (typeof streetView !== 'undefined' && streetView) ? 0.55 : 0.35;
    if (d >= 8000) return 1;
    if (d <= 2800) return lo;
    var t = (d - 2800) / (8000 - 2800);
    t = t * t * (3 - 2 * t); // smoothstep: gentle at both ends
    return lo + (1 - lo) * t;
  }
  var pillarGlowIM = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(36, 36, PILLAR_H, 12, 1, true),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    BUS_MAX);
  var pillarCoreIM = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(12, 16, PILLAR_H, 10),
    new THREE.MeshLambertMaterial({}),
    BUS_MAX);
  var pillarBeaconIM = new THREE.InstancedMesh(
    new THREE.SphereGeometry(20, 16, 12),
    new THREE.MeshBasicMaterial({}),
    BUS_MAX);
  var pillarRingIM = new THREE.InstancedMesh(
    new THREE.RingGeometry(20, 36, 28),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    BUS_MAX);
  var pillarMeshes = [pillarGlowIM, pillarCoreIM, pillarBeaconIM, pillarRingIM];
  // Uncertainty halo: one soft disc per bus, radius = 3σ of the Kalman
  // position variance. Additive, subtle — it reads as "confidence," not geometry.
  var haloIM = new THREE.InstancedMesh(
    new THREE.CircleGeometry(1, 24),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    BUS_MAX);
  haloIM.frustumCulled = false;
  haloIM.renderOrder = 4;
  pillarMeshes.push(haloIM);

  // Per-bus route badges: number-only chips. Destinations live in the bus
  // card (title + Destination row) — the floating badge stays compact.
  var badgeTexCache = {};
  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/(?:^|\s)\S/g, function (m) { return m.toUpperCase(); });
  }
  function formatDest(rid, dest) {
    if (!dest) return '';
    // BusTime destination signs often repeat the route ("10 to Fairlane") — strip it.
    var dRaw = String(dest).trim().replace(new RegExp('^' + rid + '\\s*(to\\s+)?', 'i'), '');
    var dShort = titleCase(dRaw);
    if (dShort.length > 24) dShort = dShort.slice(0, 23) + '…';
    return dShort;
  }
  // Route identity label — the naming convention (settled 2026-10-11):
  // "Name - Number" ("Greenfield - 10", "Fast Michigan - 261"). A route
  // whose name equals its id renders name only (QLINE — never
  // "QLINE - QLINE"); a route with no registry name falls back to the
  // bare id; a non-numeric id renders name only (the code-registered
  // Detroit People Mover pseudo-route carries no route number). Every
  // surface that names a route goes through this one formatter.
  function routeLabel(rid) {
    var name = routeNames[rid];
    if (!name) return String(rid);
    if (name === rid) return name;
    if (/^\d+$/.test(rid)) return name + ' - ' + rid;
    return name;
  }

  function routeBadgeTexture(rid) {
    var t = badgeTexCache[rid];
    if (t) return t;
    var rc = routeColors[rid];
    var col = '#' + (rc ? rc.getHexString() : '9aa0a6');
    var label = String(rid);
    var c = document.createElement('canvas');
    // Bus silhouette (top-down): fixed proportions read as a bus at any zoom.
    var W = 168, H = 84;
    c.width = W; c.height = H;
    var x = c.getContext('2d');
    // Wheels: small dark blocks on both flanks.
    x.fillStyle = 'rgba(5,7,10,0.95)';
    x.fillRect(18, 0, 16, 10);
    x.fillRect(W - 34, 0, 16, 10);
    x.fillRect(18, H - 10, 16, 10);
    x.fillRect(W - 34, H - 10, 16, 10);
    // Body.
    x.fillStyle = 'rgba(9,13,17,0.88)';
    x.beginPath();
    if (x.roundRect) x.roundRect(8, 6, W - 16, H - 12, 14); else x.rect(8, 6, W - 16, H - 12);
    x.fill();
    x.lineWidth = 4; x.strokeStyle = col; x.stroke();
    // Windshield: light band across the front.
    x.fillStyle = 'rgba(197,197,197,0.35)';
    x.fillRect(20, 14, W - 40, 10);
    // Route number centered on the body.
    x.fillStyle = '#ffffff';
    x.font = '700 30px system-ui, -apple-system, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    // Shrink font for long route ids so the number stays inside the body.
    var tw = x.measureText(label).width;
    if (tw > W - 48) {
      x.font = '700 ' + Math.floor(30 * (W - 48) / tw) + 'px system-ui, -apple-system, sans-serif';
    }
    x.fillText(label, W / 2, H / 2 + 8);
    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    t = { tex: tex, aspect: c.width / c.height };
    badgeTexCache[rid] = t;
    return t;
  }
  var badgePool = [];
  for (var _bi = 0; _bi < BUS_MAX; _bi++) {
    var _sp = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true }));
    _sp.scale.set(480, 240, 1);
    _sp.visible = false;
    _sp.renderOrder = 40;
    scene.add(_sp);
    badgePool.push(_sp);
  }

  // In-scene info label for the tapped bus: route + destination up top,
  // vehicle + speed + data age below. Drawn on demand (not cached — the
  // age text goes stale), parked beside the bus so it never covers it.
  var busInfoSprite = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true }));
  busInfoSprite.visible = false;
  busInfoSprite.renderOrder = 41;
  scene.add(busInfoSprite);

  // === SMART FRESHNESS LABELING (reactivation graft, 2026-10-15) =========
  // SMART positions arrive via Swiftly GTFS-Realtime in a separate display
  // payload (live-data/smart-display.json), rebuilt on the feed's 5-minute
  // cadence. Display-only under the Swiftly API License §4(vi): the
  // payload is this application's own rendering channel and is never part
  // of the public vehicles.json contract. S6: a surface may claim only
  // the freshness its source measures, so SMART carries its measured age
  // wherever it is presented as current: the SMART filter-group header,
  // the SMART group note, the live-count pill, and SMART stop cards.
  // Text only, by design: age is never carried by appearance alone.
  // DDOT and QLINE are never touched.
  // The age source is the payload's own generated_at paired with the
  // oldest vehicle updated_at inside the same payload, so client clock
  // skew cannot distort it. Bands: fresh (payload at most 7.5 minutes
  // old — within 1.5 build cycles; nothing to label), aging (payload
  // up to 15 minutes old; surfaces state the positions' as-of time),
  // stale (past 15 minutes — 3x the build cadence): the payload's
  // vehicles are dropped at ingest (smartDisplayVehicles) and the
  // surfaces say the data is old instead of rendering positions as
  // current. This restores the labeling the SMART removal took out with
  // the Transit snapshot source it was written for, re-based on a live
  // GPS source: there is no snapshot age to report because the feed
  // carries one timestamp per vehicle.
  var smartAge = { band: 'unknown', ageMin: null, payloadAtMs: null,
                   oldestAtMs: null, payloadAgeMin: null, count: 0 };
  var SMART_PAYLOAD_STALE_MS = 15 * 60 * 1000; // 3x the 5-minute build cadence

  function computeSmartAge(s, nowMs) {
    var out = { band: 'unknown', ageMin: null, payloadAtMs: null,
                oldestAtMs: null, payloadAgeMin: null, count: 0 };
    if (!s || !Array.isArray(s.vehicles)) return out;
    out.count = s.vehicles.length;
    var gen = s.generated_at ? new Date(s.generated_at).getTime() : NaN;
    if (isNaN(gen)) return out;
    out.payloadAtMs = gen;
    var oldest = null;
    for (var i = 0; i < s.vehicles.length; i++) {
      var v = s.vehicles[i];
      if (!v || !v.updated_at) continue;
      var vt = new Date(v.updated_at).getTime();
      if (isNaN(vt)) continue;
      if (oldest == null || vt < oldest) oldest = vt;
    }
    out.oldestAtMs = oldest;
    if (oldest != null) out.ageMin = Math.max(0, (gen - oldest) / 60000);
    var payloadAgeMs = nowMs - gen;
    out.payloadAgeMin = Math.max(0, payloadAgeMs / 60000);
    out.band = payloadAgeMs > SMART_PAYLOAD_STALE_MS ? 'stale'
      : (payloadAgeMs > SMART_PAYLOAD_STALE_MS / 2 ? 'aging' : 'fresh');
    return out;
  }
  // The vehicles a display payload contributes to the merged live set:
  // none when the payload is missing, malformed, or stale — SMART
  // vehicles age out and disappear honestly rather than render as
  // stale ghosts. Records without a position are dropped here as well.
  function smartDisplayVehicles(s, nowMs) {
    if (!s || !Array.isArray(s.vehicles)) return [];
    if (computeSmartAge(s, nowMs).band === 'stale') return [];
    return s.vehicles.filter(function (v) {
      return v && v.agency === 'smart' && v.lat != null && v.lon != null;
    });
  }
  // === SMART HEADSIGN JOIN (stop-card Option A, 2026-10-21) ========
  // The stop card's live rows group by route + headsign (Justin's
  // decision, 2026-10-21). DDOT vehicles carry their destination in
  // vehicles.json; SMART vehicles carry none — the Swiftly positions
  // payload has no headsign field. The join is static and display-only:
  // the feed builder restores each SMART vehicle's trip_id and
  // direction_id to the display payload, and this map — built from
  // SMART's own published GTFS by tools/build-smart-headsigns.py and
  // regenerated with the GTFS feed version, the same cadence as the
  // planner timetable merge — resolves the trip to its headsign.
  // Exact on trip_id; the route+direction dominant headsign is the
  // fallback for a trip the map does not know (e.g. an added trip).
  // Fetched once per session from the live-data base; until it lands,
  // SMART rows group by route alone (the pre-Option-A label) rather
  // than wait or fabricate a destination. This map is never read by
  // the planner, the delay matcher, or any computation path.
  var smartHeadsigns = null;   // {by_trip: {}, by_route_dir: {}}
  var smartHeadsignsRequested = false;
  function ensureSmartHeadsigns(proxy) {
    if (smartHeadsigns || smartHeadsignsRequested) return;
    smartHeadsignsRequested = true;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 8000);
    fetch(proxy + '/smart-headsigns.json', { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); return r.ok ? r.json() : null; },
            function () { clearTimeout(timer); return null; })
      .then(function (d) {
        if (d && d.by_trip && d.by_route_dir) {
          smartHeadsigns = d;
          // Upgrade an open card in place: rows regroup with their
          // headsigns on the same render path the poll uses.
          if (selectedStop) renderStopLive();
        }
      });
  }
  function smartHeadSignFor(v) {
    if (!v || v.agency !== 'smart' || !smartHeadsigns) return '';
    if (v.trip_id && smartHeadsigns.by_trip[v.trip_id]) return smartHeadsigns.by_trip[v.trip_id];
    if (v.route_id) {
      var key = v.route_id + '|' + (v.direction_id == null ? '' : v.direction_id);
      if (smartHeadsigns.by_route_dir[key]) return smartHeadsigns.by_route_dir[key];
    }
    return '';
  }
  // === SMART TRIP UPDATES (deployed 2026-10-17) ===
  // Swiftly's 2026-10-15 issuance enabled trip updates alongside vehicle
  // positions; the feed builder publishes them as a separate
  // display payload (live-data/smart-trip-updates.json). Display-only
  // under the same §4(vi) terms, and under the no-contamination rule
  // this state has exactly ONE reader — renderStopArrivals, for SMART
  // stop cards. It is never read by tripDelayState, the delay matcher,
  // RAPTOR, live-fusion, or any planner input. Freshness mirrors the
  // positions payload's S6 rule: a payload whose generated_at is older
  // than 15 minutes (3x the build cadence) is dropped at ingest, and
  // the stop card falls back to the positions-only note rather than
  // present old times as current.
  var smartTuByStop = {};   // bare stop id -> [{rid, trip, bus, time, delay}]
  var smartTuAtMs = null;   // generated_at of the ingested payload
  var SMART_TU_STALE_MS = 15 * 60 * 1000;
  function smartTuStopKey(id) {
    // Registry ids carry an agency prefix ('SMARTMI:44016'); the feed's
    // stop_id may arrive bare or prefixed — compare on the bare id.
    var s = String(id == null ? '' : id);
    var i = s.lastIndexOf(':');
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function ingestSmartTripUpdates(p, nowMs) {
    smartTuByStop = {};
    smartTuAtMs = null;
    if (!p || !Array.isArray(p.trips)) return;
    var gen = p.generated_at ? new Date(p.generated_at).getTime() : NaN;
    if (isNaN(gen) || nowMs - gen > SMART_TU_STALE_MS) return;
    smartTuAtMs = gen;
    for (var ti = 0; ti < p.trips.length; ti++) {
      var t = p.trips[ti];
      if (!t || t.schedule_relationship === 'CANCELED') continue;
      var stus = t.stop_time_updates || [];
      for (var si = 0; si < stus.length; si++) {
        var stu = stus[si];
        if (!stu || stu.schedule_relationship !== 'SCHEDULED') continue;
        var tm = stu.arrival_time != null ? stu.arrival_time : stu.departure_time;
        if (tm == null) continue;
        var key = smartTuStopKey(stu.stop_id);
        if (!smartTuByStop[key]) smartTuByStop[key] = [];
        smartTuByStop[key].push({
          rid: t.route_id || '', trip: t.trip_id || '', bus: t.vehicle_id || null,
          time: tm,
          delay: stu.arrival_delay_sec != null ? stu.arrival_delay_sec : stu.departure_delay_sec
        });
      }
    }
  }
  // Upcoming live arrivals at a SMART stop from the ingested trip
  // updates. Returns null when no usable payload exists (the caller
  // falls back to the positions-only note), or an array — empty when
  // the payload is live but reports no time for this stop.
  function smartTuRowsForStop(st, nowMs) {
    if (!st || smartTuAtMs == null) return null;
    if (!stopServedBySmart(st)) return null;
    var list = smartTuByStop[smartTuStopKey(st.id)] || [];
    var nowSec = nowMs / 1000;
    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r.time < nowSec - 30 || r.time > nowSec + 3 * 3600) continue;
      // Project 13, candidate C2 (Justin's decision, 2026-10-17:
      // "TU rows obey the toggles like every other surface") — the
      // same one-line gate computeStopArrivals applies to DDOT
      // arrivals: a TU row whose route is switched off (directly or
      // by its group header) or near-me-excluded does not present.
      if (!routeIsOn(r.rid) || !routeNearOk(r.rid)) continue;
      rows.push(r);
    }
    rows.sort(function (a, b) { return a.time - b.time; });
    return rows.slice(0, 5);
  }
  function formatClock12(ms) {
    var d = new Date(ms);
    var h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
  }
  function formatAgeLong(ageMin) {
    if (ageMin == null || isNaN(ageMin)) return '';
    if (ageMin < 1.5) return 'about a minute';
    if (ageMin < 55) return Math.round(ageMin) + ' minutes';
    var hrs = ageMin / 60;
    if (hrs < 1.5) return 'about an hour';
    return Math.round(hrs) + ' hours';
  }
  function smartHeaderText(age) {
    if (!age || age.band === 'unknown' || age.band === 'fresh') return '';
    if (age.band === 'aging') return age.oldestAtMs != null ? 'as of ' + formatClock12(age.oldestAtMs) : '';
    return formatAgeLong(age.payloadAgeMin) + ' old';
  }
  function smartNoteText(age) {
    if (!age || age.band === 'unknown' || age.band === 'fresh') return '';
    if (age.band === 'aging') return age.oldestAtMs != null ? 'SMART positions as of ' + formatClock12(age.oldestAtMs) + '.' : '';
    return 'SMART data is ' + formatAgeLong(age.payloadAgeMin) + ' old \u2014 positions may have moved.';
  }
  function smartStopNoteText(age) {
    if (!age) return '';
    if (age.band === 'aging') return age.oldestAtMs != null ? 'SMART positions as of ' + formatClock12(age.oldestAtMs) + '.' : '';
    if (age.band === 'stale') return 'SMART data is ' + formatAgeLong(age.payloadAgeMin) + ' old \u2014 buses may have moved from the positions shown.';
    return '';
  }
  function smartPillText(age) {
    if (!age || age.band !== 'stale') return '';
    return 'SMART ' + age.count + ' (stale)';
  }

  // Applies the current smartAge object to every SMART age surface.
  // Called after the filter panel is built and on every live poll; each
  // surface is independently optional, so a missing element is a no-op.
  function applySmartAgeUI() {
    var label = $('smart-age-label');
    if (label) label.textContent = smartHeaderText(smartAge);
    var note = $('smart-age-note');
    if (note) note.textContent = smartNoteText(smartAge);
    var pill = $('smart-pill-note');
    if (pill) {
      var t = smartPillText(smartAge);
      pill.textContent = t;
      pill.hidden = !t;
    }
    renderStopSmartNote();
  }
  function stopServedBySmart(st) {
    if (!st || !st.r || !st.r.length) return false;
    var smartRoutes = groupRoutes.smart || [];
    if (!smartRoutes.length) return false;
    for (var i = 0; i < st.r.length; i++) {
      if (smartRoutes.indexOf(String(st.r[i])) !== -1) return true;
    }
    return false;
  }
  function renderStopSmartNote() {
    var el = $('stop-smart-note');
    if (!el) return;
    var t = (selectedStop && stopServedBySmart(selectedStop)) ? smartStopNoteText(smartAge) : '';
    el.textContent = t;
    el.hidden = !t;
  }
  // === END SMART FRESHNESS LABELING ===

  function busAgeText(v) {
    if (!v.updated_at) return '–';
    var s = Math.max(0, Math.round((Date.now() - new Date(v.updated_at).getTime()) / 1000));
    return s < 60 ? s + 's ago' : Math.floor(s / 60) + 'm ago';
  }
  // Route Reverse (project 18): the direction-label rule — when a
  // binding exists, the bound trip's headsign is what every direction
  // surface shows; unbound, the feed's sign. One rule, applied at the
  // __setRideVehicles seam for the widget and here for the host
  // surfaces (specification section 2.1).
  function tripBindingFor(vid) {
    var found = null;
    tripDelayState.forEach(function (st, trip) { if (st.vehicleId === vid) found = { st: st, trip: trip }; });
    return found;
  }
  function displayDest(v) {
    if (!v) return '';
    var b = tripBindingFor(v.vehicle_id);
    return formatDest(v.route_id, (b && b.trip.h) ? b.trip.h : v.destination);
  }
  function drawBusInfo(v) {
    var col = routeColors[v.route_id] ? '#' + routeColors[v.route_id].getHexString() : '#9F9F9F';
    var dest = displayDest(v);
    var line1 = routeLabel(v.route_id) + (dest ? ' → ' + dest : '');
    var spd = (v.speed_mph != null && !isNaN(v.speed_mph)) ? Math.round(v.speed_mph) + ' mph' : '–';
    var line2 = 'Bus ' + (v.vehicle_id || '–') + ' · ' + spd + ' · ' + busAgeText(v);
    var c = document.createElement('canvas');
    var m = c.getContext('2d');
    m.font = '700 34px system-ui, -apple-system, sans-serif';
    var w1 = Math.ceil(m.measureText(line1).width);
    m.font = '500 28px system-ui, -apple-system, sans-serif';
    var w2 = Math.ceil(m.measureText(line2).width);
    c.width = Math.max(w1, w2) + 72; c.height = 128;
    var x = c.getContext('2d');
    x.fillStyle = 'rgba(9,13,17,0.92)';
    x.beginPath();
    if (x.roundRect) x.roundRect(4, 4, c.width - 8, c.height - 8, 20); else x.rect(4, 4, c.width - 8, c.height - 8);
    x.fill();
    x.lineWidth = 4; x.strokeStyle = col; x.stroke();
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#ffffff';
    x.font = '700 34px system-ui, -apple-system, sans-serif';
    x.fillText(line1, c.width / 2 - 14, 42);
    x.fillStyle = '#CDCDCD';
    x.font = '500 28px system-ui, -apple-system, sans-serif';
    x.fillText(line2, c.width / 2 - 14, 88);
    // Dismiss × — the whole pill is tappable, this is the affordance.
    x.strokeStyle = '#9F9F9F'; x.lineWidth = 5; x.lineCap = 'round';
    var xx = c.width - 36, xy = 34;
    x.beginPath(); x.arc(xx, xy, 16, 0, Math.PI * 2); x.stroke();
    x.beginPath();
    x.moveTo(xx - 6, xy - 6); x.lineTo(xx + 6, xy + 6);
    x.moveTo(xx + 6, xy - 6); x.lineTo(xx - 6, xy + 6);
    x.stroke();
    if (busInfoSprite.material.map) busInfoSprite.material.map.dispose();
    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    busInfoSprite.material.map = tex;
    busInfoSprite.material.needsUpdate = true;
    busInfoSprite.userData.aspect = c.width / c.height;
    var h = badgeHeight() * 1.15;
    busInfoSprite.scale.set(h * busInfoSprite.userData.aspect, h, 1);
  }
  function placeBusInfo() {
    if (!busInfoSprite.visible || !selectedVehicleId) return;
    for (var i = 0; i < busSlots.length; i++) {
      var s = busSlots[i];
      if (s.vehicle && s.vehicle.vehicle_id === selectedVehicleId) {
        // Upper area of the column, clear of the route badge: reads as a unit
        // with the badge without covering the pillar. Tracks the zoom-coupled
        // pillar height (busMode uses true-scale models instead). Scale eases
        // per frame with the badges so the card glides instead of stepping.
        var y = busMode ? 150 : Math.max(60, PILLAR_H * pillarYS - 40);
        busInfoSprite.position.set(s.x + 200, y, s.z);
        if (busInfoSprite.userData.aspect) {
          var ih = badgeHeight() * 1.15;
          busInfoSprite.scale.set(ih * busInfoSprite.userData.aspect, ih, 1);
        }
        return;
      }
    }
    busInfoSprite.visible = false; // bus left the visible set
  }
  function refreshBusInfo() {    if (!selectedVehicleId) { busInfoSprite.visible = false; return; }
    for (var i = 0; i < busSlots.length; i++) {
      var s = busSlots[i];
      if (s.vehicle && s.vehicle.vehicle_id === selectedVehicleId) {
        drawBusInfo(s.vehicle);
        busInfoSprite.visible = true;
        placeBusInfo();
        return;
      }
    }
    busInfoSprite.visible = false;
  }

  // Shared temps.
  var _e3 = new THREE.Euler();

  // Street name labels: pooled sprites fed from detroit-street-names.json.
  // Freeway/arterial names under 20 km, local names under 6 km, deduped by
  // name within view, nearest 14 win.
  var streetLabelCache = {};
  var streetLabelOrder = [];
  var STREET_LABEL_CACHE_MAX = 256;
  function streetLabelTexture(name) {
    var t = streetLabelCache[name];
    if (t) {
      var ti = streetLabelOrder.indexOf(name);
      if (ti >= 0) { streetLabelOrder.splice(ti, 1); streetLabelOrder.push(name); }
      return t;
    }
    var c = document.createElement('canvas');
    var mc = c.getContext('2d');
    mc.font = '600 36px system-ui, -apple-system, sans-serif';
    var tw = Math.ceil(mc.measureText(name).width);
    c.width = tw + 44; c.height = 56;
    var x = c.getContext('2d');
    x.fillStyle = 'rgba(16,16,16,0.85)';
    x.beginPath();
    if (x.roundRect) x.roundRect(2, 2, c.width - 4, 52, 14); else x.rect(2, 2, c.width - 4, 52);
    x.fill();
    x.lineWidth = 3; x.strokeStyle = 'rgba(242,242,242,0.35)'; x.stroke();
    x.fillStyle = '#F2F2F2';
    x.font = '600 36px system-ui, -apple-system, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(name, c.width / 2, 29);
    t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    var o = { tex: t, aspect: c.width / c.height };
    streetLabelCache[name] = o;
    streetLabelOrder.push(name);
    // LRU eviction (2026-10-16, crash fix F3): this cache previously kept
    // every canvas texture it created for the life of the page — up to
    // 6,640 distinct street names — a monotonic GPU-memory growth vector
    // in long-lived tabs. Evicted textures are disposed; a pooled sprite
    // still referencing one re-uploads it on next render.
    while (streetLabelOrder.length > STREET_LABEL_CACHE_MAX) {
      var evictName = streetLabelOrder.shift();
      var evictEntry = streetLabelCache[evictName];
      if (evictEntry) {
        if (evictEntry.tex) evictEntry.tex.dispose();
        delete streetLabelCache[evictName];
      }
    }
    return o;
  }
  var streetLabelPool = [];
  for (var _sli = 0; _sli < 14; _sli++) {
    var _sl = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }));
    _sl.visible = false;
    _sl.renderOrder = 35;
    scene.add(_sl);
    streetLabelPool.push(_sl);
  }
  var lastStreetLabelUpdate = 0;
  var MAX_STREET_LABELS = 6;
  // Street-label stability: without memory the picker churns — the nearest
  // anchor per street jumps as you pan and the nearest-N set reshuffles, so
  // labels pop and swap. We keep the previously shown anchor per street
  // (within a 1.3x radius hysteresis) and place previously shown streets
  // first, so the set only changes when it has to.
  var prevStreetNames = []; // names shown last update, in placement order
  var streetAnchorIdx = {}; // name -> index into streetNameData.labels
  function updateStreetLabels() {
    var now = performance.now();
    if (now - lastStreetLabelUpdate < 350) return;
    lastStreetLabelUpdate = now;
    function clearLabels() {
      for (var i = 0; i < streetLabelPool.length; i++) streetLabelPool[i].visible = false;
      prevStreetNames = [];
      streetAnchorIdx = {};
    }
    var labels = streetNameData && streetNameData.labels;
    var camDist = camera.position.distanceTo(controls.target);
    var showMajor = camDist < 10000, showLocal = camDist < 5000;
    if (!labels || (!showMajor && !showLocal)) { clearLabels(); return; }
    var tx = controls.target.x, tz = controls.target.z;
    var R = camDist * 0.55, R2 = R * R, keepR2 = R2 * 1.69; // 1.3x hysteresis
    var best = {};
    for (var j = 0; j < labels.length; j++) {
      var l = labels[j];
      if (l[3] === 2 ? !showLocal : !showMajor) continue;
      // Stable anchor: keep showing the same point for this street while
      // it's still reasonably close, instead of jumping anchor to anchor.
      var kj = streetAnchorIdx[l[0]];
      if (kj !== undefined && labels[kj] && labels[kj][0] === l[0] &&
          (labels[kj][3] === 2 ? showLocal : showMajor)) {
        var kdx = labels[kj][1] - tx, kdz = labels[kj][2] - tz;
        var kd2 = kdx * kdx + kdz * kdz;
        if (kd2 < keepR2 && !best[l[0]]) {
          best[l[0]] = { d2: kd2, l: labels[kj], j: kj };
          continue;
        }
      }
      var dx = l[1] - tx, dz = l[2] - tz;
      var d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;
      var e = best[l[0]];
      if (!e || d2 < e.d2) best[l[0]] = { d2: d2, l: l, j: j };
    }
    var arr = [];
    for (var k in best) arr.push(best[k]);
    // Stable order: streets already on screen keep their slots; newcomers
    // fill by distance. Kills the reshuffle when the camera drifts.
    var prevPos = {};
    for (var pi = 0; pi < prevStreetNames.length; pi++) prevPos[prevStreetNames[pi]] = pi;
    arr.sort(function (a, b) {
      var pa = (a.l[0] in prevPos) ? prevPos[a.l[0]] : 1e9;
      var pb = (b.l[0] in prevPos) ? prevPos[b.l[0]] : 1e9;
      if (pa !== pb) return pa - pb;
      return a.d2 - b.d2;
    });
    // Nearest-first placement with screen-space collision: no overlapping labels.
    var placed = [];
    // Project 21: the stop-label pass ran first this frame and
    // published its placed rects — street labels yield that space.
    for (var sr = 0; sr < stopLabelRects.length; sr++) placed.push(stopLabelRects[sr]);
    var h = camDist * 0.02;
    var rw = renderer.domElement.clientWidth, rh = renderer.domElement.clientHeight;
    var pxPerM = rh / (2 * camDist * Math.tan(camera.fov * 0.5 * DEG));
    clearLabels();
    var shown = 0;
    for (var q = 0; q < arr.length && shown < MAX_STREET_LABELS; q++) {
      var lt = streetLabelTexture(arr[q].l[0]);
      var lw = h * lt.aspect * pxPerM, lh = h * pxPerM;
      _p3.set(arr[q].l[1], 34, arr[q].l[2]).project(camera);
      if (_p3.z > 1 || _p3.z < -1) continue;
      var cxp = (_p3.x * 0.5 + 0.5) * rw, cyp = (-_p3.y * 0.5 + 0.5) * rh;
      var clash = false;
      for (var c = 0; c < placed.length; c++) {
        var pr = placed[c];
        if (Math.abs(cxp - pr.x) < (lw + pr.w) / 2 + 10 &&
            Math.abs(cyp - pr.y) < (lh + pr.h) / 2 + 8) { clash = true; break; }
      }
      if (clash) continue;
      placed.push({ x: cxp, y: cyp, w: lw, h: lh });
      var sp = streetLabelPool[shown++];
      if (sp.material.map !== lt.tex) { sp.material.map = lt.tex; sp.material.needsUpdate = true; }
      sp.scale.set(h * lt.aspect, h, 1);
      sp.position.set(arr[q].l[1], 34, arr[q].l[2]);
      sp.visible = true;
      // Remember what's on screen so the next pass prefers stability.
      prevStreetNames.push(arr[q].l[0]);
      streetAnchorIdx[arr[q].l[0]] = arr[q].j;
    }
  }
  pillarMeshes.forEach(function (im) {
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.count = 0;
    im.frustumCulled = false;
    scene.add(im);
  });

  // True-scale bus geometry (shared; detail groups built lazily for busMode).
  var busBodyGeo = new THREE.BoxGeometry(1, 1, 1);
  var busWinGeo = new THREE.BoxGeometry(1, 1, 1);
  var wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.4, 12);
  var busWinMat = new THREE.MeshBasicMaterial({ color: 0x151515 });
  var wheelMat = new THREE.MeshBasicMaterial({ color: 0x05070a });

  var detailPool = [];
  function getDetail(i) {
    if (!detailPool[i]) {
      var g = new THREE.Group();
      var body = new THREE.Mesh(busBodyGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }));
      var wins = new THREE.Mesh(busWinGeo, busWinMat);
      var wheels = [];
      for (var k = 0; k < 4; k++) {
        var wh = new THREE.Mesh(wheelGeo, wheelMat);
        wh.rotation.x = Math.PI / 2;
        wheels.push(wh);
        g.add(wh);
      }
      g.add(body); g.add(wins);
      g.visible = false;
      body.userData.detail = null; // set below
      scene.add(g);
      var d = { group: g, body: body, wins: wins, wheels: wheels, vehicle: null };
      body.userData.detail = d;
      detailPool[i] = d;
    }
    return detailPool[i];
  }

  // busSlots[i]: one entry per currently visible bus (index == instance id).
  var busSlots = [];
  var selectedVehicleId = null; // tapped bus; its indicator renders expanded
  // Product Defect Reconciliation, candidate C3: while a ride is
  // boarded and the boarded vehicle's route is gate-hidden, its
  // reconciled slot lives here instead of busSlots — session state
  // only. It is never rendered, counted, or offered for picking;
  // the ride's own consumers (the vehicle seam, the 5 s position
  // push, camera follow) read it so the ride keeps the same live
  // position quality the visible set gets. Null at all other times.
  var rideShadowSlot = null;

  var _m4 = new THREE.Matrix4();
  var _p3 = new THREE.Vector3();
  var _q3 = new THREE.Quaternion();
  var _s3 = new THREE.Vector3(1, 1, 1);
  var _ringQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

  function markColorsDirty() {
    pillarMeshes.forEach(function (im) {
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    });
  }

  // Pulse rate shared with the user-location ring: 1 + 0.22*sin(t/420).
  function busPulse() { return 1 + 0.22 * Math.sin(performance.now() / 420); }

  function writeBusMatrices(k, b, pulse) {
    var isSel = !!selectedVehicleId && b.vehicle.vehicle_id === selectedVehicleId;
    var exz = (isSel ? 1.55 : 1) * (isSel ? pulse : 1); // selected bus expands + pulses
    var topY = PILLAR_H * pillarYS;
    _p3.set(b.x, topY / 2, b.z);
    _q3.identity();
    _s3.set(exz, pillarYS, exz);
    _m4.compose(_p3, _q3, _s3);
    pillarGlowIM.setMatrixAt(k, _m4);
    pillarCoreIM.setMatrixAt(k, _m4);
    _p3.set(b.x, topY + 24, b.z);
    _m4.compose(_p3, _q3, _s3);
    pillarBeaconIM.setMatrixAt(k, _m4);
    _p3.set(b.x, 4, b.z);
    // Position Integrity item 2: in the stale treatment the ground
    // ring is the marker's ground statement (the halo disc is gone —
    // see below), so it renders larger than the fresh base ring.
    var ringK = exz * (b.staleFx ? 2.0 : 1.35);
    _s3.set(ringK, ringK, 1);
    _m4.compose(_p3, _ringQ, _s3);
    pillarRingIM.setMatrixAt(k, _m4);
    // Uncertainty halo: flat disc at y=8, scaled to the 3σ radius.
    // Halo honesty (Position Integrity item 2): a STALE marker carries
    // no disc at all — no disc may imply a bound the data does not
    // support. The ring above replaces it.
    var hr = b.staleFx ? 0 : (b.haloR || 15);
    _p3.set(b.x, 8, b.z);
    _q3.identity();
    _s3.set(hr, hr, 1);
    _m4.compose(_p3, _ringQ, _s3);
    haloIM.setMatrixAt(k, _m4);
  }

  function renderBusInstances() {
    var n = busSlots.length;
    if (busMode) {
      pillarMeshes.forEach(function (im) { im.visible = false; });
      var dn = Math.min(n, DETAIL_MAX);
      for (var i = 0; i < DETAIL_MAX; i++) {
        var d = getDetail(i);
        if (i < dn) {
          var s = busSlots[i];
          var fi = fleetLookup(s.vehicle.vehicle_id);
          d.group.position.set(s.x, 0, s.z);
          d.group.rotation.y = s.rotY;
          d.body.scale.set(fi.length_m, fi.height_m, fi.width_m);
          d.body.position.y = fi.height_m / 2 + 0.35;
          d.body.material.color.copy(busMarkerColor(s));
          var isSelD = !!selectedVehicleId && s.vehicle.vehicle_id === selectedVehicleId;
          var dsc = isSelD ? 1.45 : 1; // selected bus expands
          d.group.scale.set(dsc, dsc, dsc);
          d.wins.scale.set(fi.length_m * 0.88, fi.height_m * 0.32, fi.width_m * 1.02);
          d.wins.position.y = fi.height_m * 0.72 + 0.35;
          var wx = fi.length_m * 0.32, wz = fi.width_m / 2;
          d.wheels[0].position.set(wx, 0.55, wz);
          d.wheels[1].position.set(wx, 0.55, -wz);
          d.wheels[2].position.set(-wx, 0.55, wz);
          d.wheels[3].position.set(-wx, 0.55, -wz);
          d.vehicle = s.vehicle;
          d.group.visible = true;
        } else {
          d.group.visible = false;
          d.vehicle = null;
        }
      }
      updateBusBadges(n, 430);
      return;
    }
    // Pillar mode: hide detail models, fill instances.
    for (var j = 0; j < DETAIL_MAX; j++) {
      if (detailPool[j]) { detailPool[j].group.visible = false; detailPool[j].vehicle = null; }
    }
    pillarMeshes.forEach(function (im) { im.visible = true; });
    for (var k = 0; k < n; k++) {
      var b = busSlots[k];
      writeBusMatrices(k, b, 1);
      // Itinerary focus: darken pillars for routes not in the active trip.
      var pc = busMarkerColor(b);
      if (itineraryDims(b.vehicle.route_id)) {
        pc = pc.clone().multiplyScalar(0.25);
      }
      pillarGlowIM.setColorAt(k, pc);
      pillarCoreIM.setColorAt(k, pc);
      pillarBeaconIM.setColorAt(k, pc);
      pillarRingIM.setColorAt(k, pc);
    }
    pillarMeshes.forEach(function (im) {
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
    });
    markColorsDirty();
    updateBusBadges(n, PILLAR_H * pillarYS + 80);
  }

  // Per-bus route badges: one sprite per bus, shown only at close street-level zooms.
  // Badge size tracks zoom (constant screen presence) via smoothBadges, called every frame.
  function badgeHeight() {
    var camDist = camera.position.distanceTo(controls.target);
    var h = Math.max(60, Math.min(170, camDist * 0.045));
    // Close-zoom ease: below ~6 km badges shrink toward 55% so dense
    // downtown clusters stop stacking into a wall of chips. Wide-out
    // presence is unchanged.
    if (camDist < 6000) {
      var t = Math.max(0, (camDist - 2600) / (6000 - 2600));
      h *= 0.55 + 0.45 * t;
    }
    return h;
  }
  function updateBusBadges(n, yBase) {
    var show = camera.position.distanceTo(controls.target) < 7000;
    var h = badgeHeight();
    for (var bi = 0; bi < BUS_MAX; bi++) {
      var sp = badgePool[bi];
      if (bi < n && show) {
        var bs = busSlots[bi];
        // The selected bus is identified by the card, the info sprite, and
        // the selection pulse: its route badge would be a second floating
        // label tracking the same bus. Hide it for visual clarity.
        if (selectedVehicleId && bs.vehicle && bs.vehicle.vehicle_id === selectedVehicleId) {
          sp.visible = false;
          continue;
        }
        var bt = markerStale(bs, performance.now()) ? staleBadgeTexture(bs) : routeBadgeTexture(bs.vehicle.route_id);
        if (sp.material.map !== bt.tex) { sp.material.map = bt.tex; sp.material.needsUpdate = true; }
        sp.userData.aspect = bt.aspect;
        sp.userData.slot = bi;
        sp.userData.pri = (selectedVehicleId && bs.vehicle.vehicle_id === selectedVehicleId) ? 0 : 1;
        sp.scale.set(h * bt.aspect, h, 1);
        sp.position.set(bs.x, yBase, bs.z);
        // Itinerary focus: dim badges for routes not in the active trip.
        sp.material.opacity = itineraryDims(bs.vehicle.route_id) ? 0.2 : 1;
        sp.visible = true;
      } else {
        sp.visible = false;
      }
    }
  }
  // Guaranteed badge decluttering: greedy screen-space insertion, selected
  // bus first, then stable slot order. Each badge tests its anchor against
  // placed rects; on overlap it spirals through 24 candidate offsets and
  // takes the first non-overlapping slot. Separation is guaranteed by
  // construction — badges never stack into a wall. Runs in smoothBadges.
  var _dcV = new THREE.Vector3(), _dcR = new THREE.Vector3(), _dcU = new THREE.Vector3();
  function declutterBadges() {
    var cw = renderer.domElement.clientWidth || 1, ch = renderer.domElement.clientHeight || 1;
    var items = [];
    for (var i = 0; i < badgePool.length; i++) {
      var sp = badgePool[i];
      if (!sp.visible || !sp.userData.aspect) continue;
      items.push(sp);
    }
    if (items.length < 2) {
      // Still anchor single badges at their yBase (set by smoothBadges caller).
      return;
    }
    items.sort(function (a, b) { return (a.userData.pri - b.userData.pri) || (a.userData.slot - b.userData.slot); });
    camera.updateMatrixWorld();
    _dcR.setFromMatrixColumn(camera.matrix, 0);
    _dcU.setFromMatrixColumn(camera.matrix, 1);
    var placed = []; // {x,y,w,h} in screen px
    for (var k = 0; k < items.length; k++) {
      var s2 = items[k];
      var bw = s2.scale.x, bh = s2.scale.y;
      // anchor screen pos
      _dcV.copy(s2.position).project(camera);
      var ax = (_dcV.x * 0.5 + 0.5) * cw, ay = (-_dcV.y * 0.5 + 0.5) * ch;
      // badge world-to-px at anchor depth for offset conversion
      var dist = camera.position.distanceTo(s2.position);
      var wpp = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / ch;
      var found = null;
      outer:
      for (var ring = 0; ring <= 2; ring++) {
        var rad = ring * Math.max(bw, bh) * 0.75 / Math.max(wpp, 1e-6); // world units
        var steps = ring === 0 ? 1 : 8;
        for (var st = 0; st < steps; st++) {
          var ang = (st / steps) * Math.PI * 2 + ring * 0.4;
          var ox = ring === 0 ? 0 : Math.cos(ang) * rad;
          var oy = ring === 0 ? 0 : Math.sin(ang) * rad;
          // candidate world pos = anchor + right*ox + up*oy
          _dcV.copy(s2.position).addScaledVector(_dcR, ox).addScaledVector(_dcU, oy).project(camera);
          var cx = (_dcV.x * 0.5 + 0.5) * cw, cy = (-_dcV.y * 0.5 + 0.5) * ch;
          // screen-space badge rect (scale is world units; convert)
          var pxW = bw / Math.max(wpp, 1e-6), pxH = bh / Math.max(wpp, 1e-6);
          var ok = true;
          for (var p = 0; p < placed.length; p++) {
            var r = placed[p];
            if (Math.abs(cx - r.x) < (pxW + r.w) / 2 && Math.abs(cy - r.y) < (pxH + r.h) / 2) { ok = false; break; }
          }
          if (ok) { found = { x: cx, y: cy, w: pxW, h: pxH, ox: ox, oy: oy }; break outer; }
        }
      }
      if (!found) {
        // Fallback (shouldn't happen): stack above anchor.
        found = { x: ax, y: ay - placed.length * bh / Math.max(wpp, 1e-6), w: bw / wpp, h: bh / wpp, ox: 0, oy: placed.length * bh };
      }
      placed.push(found);
      s2.position.addScaledVector(_dcR, found.ox).addScaledVector(_dcU, found.oy);
    }
  }
  // Per-frame badge smoothing: scale and anchor track the live zoom every
  // frame, so badges glide with the pillars instead of stepping on a timer.
  // Visibility/texture assignment stays in updateBusBadges (data updates).
  function smoothBadges() {
    var h = badgeHeight();
    var yBase = busMode ? 150 : PILLAR_H * pillarYS + 80;
    for (var i = 0; i < badgePool.length; i++) {
      var sp = badgePool[i];
      if (!sp.visible || !sp.userData.aspect) continue;
      sp.scale.set(h * sp.userData.aspect, h, 1);
      // Reset to anchor before decluttering (declutter adds offsets).
      var bs = busSlots[sp.userData.slot];
      if (bs) sp.position.set(bs.x, yBase, bs.z);
    }
    declutterBadges();
  }

  // Zoom LOD: wide view shows the symbolic pillars; zoomed in past ~2.6 km
  // the markers resolve into true-scale bus models. Hysteresis avoids flicker.
  var busMode = false;
  function updateLOD() {
    var d = camera.position.distanceTo(controls.target);
    if (!busMode && d < 2600) busMode = true;
    else if (busMode && d > 3400) busMode = false;
  }

  // --- street view: the max-zoom experience --------------------------------
  // Pinch-zooming past STREET_ENTER_DIST hands off to a street-level view:
  // the camera glides (never cuts) to an oblique vantage over the nearest
  // stop, stop name labels fade in, and a camera floor keeps the lens out of
  // the geometry. Zooming back out past STREET_EXIT_DIST restores the orbit
  // view. Hysteresis on both ends so the handoff never flickers mid-pinch.
  var streetView = false;
  var STREET_ENTER_DIST = 1500, STREET_EXIT_DIST = 2600;
  var STREET_MIN_Y = 45;    // camera never dips into street-level geometry
  var streetTween = null;   // {t0, dur, fromPos, toPos, fromTgt, toTgt}
  var _svDir = new THREE.Vector3();

  function nearestStopTo(x, z, maxR) {
    var best = null, bd2 = maxR * maxR;
    // Product Defect Reconciliation (project 13): the governed pick
    // list is the ONLY source — an empty list means every stop is
    // switched off, never "fall back to all stops". The old stopData
    // fallback resurrected hidden stops whenever the governed set
    // was legitimately empty (all routes off; near-me with none near).
    var list = stopPickList || [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var dx = s.x - x, dz = s.z - z, d2 = dx * dx + dz * dz;
      if (d2 < bd2) { bd2 = d2; best = s; }
    }
    // People Mover stations are stop-class anchors too — while the
    // PM layer is on (its own toggle governs it, as in pickPMStation).
    for (var p = 0; pmVisible && p < pmStations.length; p++) {
      var q = pmStations[p];
      var qdx = q.x - x, qdz = q.z - z, qd2 = qdx * qdx + qdz * qdz;
      if (qd2 < bd2) { bd2 = qd2; best = q; }
    }
    return best;
  }
  // Eased camera flight: position + target glide together over ~1.4 s.
  // The user's grab always wins — pointerdown cancels the flight instantly.
  // --- DisplayBounds: device-specific visible-map framing --------------------
  // The map canvas (#live-map) is full-viewport with UI chrome overlaid. This
  // module measures the actually-visible map region ("safe frame") by
  // subtracting the screen rects of visible chrome elements. Phase 2's
  // transition engine will frame subjects inside the safe frame so the camera
  // never lands a subject under a card or panel.
  //
  // Phase 1: measurement only. Nothing consumes the safe frame yet. The API
  // is exposed as window.__db() for verification.
  var DisplayBounds = (function () {
    'use strict';
    var MOBILE_MAX_W = 768;

    function isShown(el) {
      if (!el || el.hidden) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    // Registry: chrome element -> viewport edge it docks to per device class.
    // 'modal' = centered overlay; when any modal is open the safe frame is
    // degenerate and callers must dismiss it before transitioning.
    var registry = [
      { sel: 'header.nav', edge: { mobile: 'top', desktop: 'top' }, visible: isShown },
      { id: 'bus-card', edge: { mobile: 'bottom', desktop: 'left' }, visible: isShown },
      { id: 'stop-card', edge: { mobile: 'bottom', desktop: 'left' }, visible: isShown },
      { id: 'trip-card', edge: { mobile: 'bottom', desktop: 'left' }, visible: isShown },
      { id: 'trip-planner', edge: { mobile: 'bottom', desktop: 'right' }, visible: isShown },
      { id: 'filter-panel', edge: { mobile: 'right', desktop: 'right' }, visible: isShown },
      { id: 'browse-panel', edge: { mobile: 'modal', desktop: 'modal' }, visible: isShown },
      { id: 'nav-overlay', edge: { mobile: 'modal', desktop: 'modal' }, visible: isShown },
      { id: 'map-hint', edge: { mobile: 'bottom', desktop: 'bottom' }, visible: isShown },
      { id: 'zoom-in', edge: { mobile: 'right', desktop: 'right' }, visible: isShown },
      { id: 'zoom-out', edge: { mobile: 'right', desktop: 'right' }, visible: isShown },
      { id: 'view-locate', edge: { mobile: 'right', desktop: 'right' }, visible: isShown },
      { id: 'view-reset', edge: { mobile: 'right', desktop: 'right' }, visible: isShown },
      { id: 'view-full', edge: { mobile: 'right', desktop: 'right' }, visible: isShown },
      { id: 'browse-toggle', edge: { mobile: 'right', desktop: 'right' }, visible: isShown },
      { id: 'map-bar', edge: { mobile: 'top', desktop: 'top' }, visible: isShown },
      { id: 'filter-btn', edge: { mobile: 'top', desktop: 'top' }, visible: isShown },
      { id: 'trip-btn', edge: { mobile: 'top', desktop: 'top' }, visible: isShown }
    ];

    function get() {
      var vw = window.innerWidth, vh = window.innerHeight;
      var dc = vw < MOBILE_MAX_W ? 'mobile' : 'desktop';
      var insets = { top: 0, left: 0, right: 0, bottom: 0 };
      var modalOpen = false;
      var parts = [];
      for (var i = 0; i < registry.length; i++) {
        var e = registry[i];
        var el = e.id ? document.getElementById(e.id) : document.querySelector(e.sel);
        if (!el || !e.visible(el)) continue;
        var r = el.getBoundingClientRect();
        var edge = e.edge[dc];
        if (edge === 'modal') { modalOpen = true; parts.push({ id: e.id || e.sel, edge: 'modal' }); continue; }
        var extent = edge === 'top' ? r.bottom
          : edge === 'left' ? r.right
          : edge === 'right' ? vw - r.left
          : vh - r.top; // bottom
        extent = Math.max(0, Math.round(extent));
        if (extent > insets[edge]) insets[edge] = extent;
        parts.push({ id: e.id || e.sel, edge: edge, extent: extent });
      }
      var sf = {
        x: insets.left, y: insets.top,
        w: Math.max(0, vw - insets.left - insets.right),
        h: Math.max(0, vh - insets.top - insets.bottom)
      };
      return {
        vw: vw, vh: vh, deviceClass: dc,
        insets: insets, modalOpen: modalOpen,
        safeFrame: sf,
        center: { x: Math.round(sf.x + sf.w / 2), y: Math.round(sf.y + sf.h / 2) },
        _parts: parts
      };
    }

    return { get: get, MOBILE_MAX_W: MOBILE_MAX_W };
  })();
  // Verification hook (Phase 1): window.__db() returns the live measurement.
  window.__db = function () { return DisplayBounds.get(); };
  // STAGING-ONLY debug readout: ?dbdebug=1 renders the live DisplayBounds
  // measurement into the DOM so script-less verification can read it.
  // Hostname-gated: never activates on production (2026-10-06).
  if (/[?&]dbdebug=1/.test(location.search) &&
      /smit4786\.github\.io|localhost/.test(location.hostname)) {
    (function () {
      var pre = document.createElement('pre');
      pre.id = 'db-debug';
      pre.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;max-width:92vw;max-height:40vh;overflow:auto;background:rgba(0,0,0,.85);color:#B6B6B6;font:11px/1.4 monospace;padding:8px;white-space:pre-wrap;';
      document.body.appendChild(pre);
      setInterval(function () {
        try {
          var d = DisplayBounds.get();
          d.cam = [Math.round(camera.position.x), Math.round(camera.position.y), Math.round(camera.position.z)];
          d.tgt = [Math.round(controls.target.x), Math.round(controls.target.y), Math.round(controls.target.z)];
          d.follow = followVId;
          d.selectedBus = selectedVehicleId;
          pre.textContent = JSON.stringify(d, null, 1);
        } catch (e) { /* keep last */ }
      }, 500);
    })();
  }

  function glideTo(pos, tgt, dur, onDone) {
    // Reduced motion (C-10): the glide completes in place — the camera
    // lands on the destination framing and the completion directive
    // runs, exactly the state a finished tween leaves behind.
    if ((typeof reducedMotion !== 'undefined') && reducedMotion) {
      streetTween = null;
      camera.position.copy(pos);
      controls.target.copy(tgt);
      if (!(typeof tripFly !== 'undefined' && tripFly)) controls.enabled = true;
      if (typeof onDone === 'function') { try { onDone(); } catch (err) {} }
      return;
    }
    streetTween = {
      t0: performance.now(), dur: dur || 1400,
      fromPos: camera.position.clone(), toPos: pos.clone(),
      fromTgt: controls.target.clone(), toTgt: tgt.clone(),
      onDone: (typeof onDone === 'function') ? onDone : null
    };
    controls.enabled = false;
  }
  function stepStreetTween(now) {
    if (!streetTween) return;
    var t = Math.min(1, (now - streetTween.t0) / streetTween.dur);
    // Minimum-jerk profile (Flash & Hogan): minimizes ∫jerk², the provably
    // smoothest rest-to-rest trajectory and the one human motor control uses.
    // Closed-form quintic; replaces easeInOutCubic. Interruption, follow-on-
    // complete, and safe-frame offset behavior unchanged.
    var e = t * t * t * (t * (t * 6 - 15) + 10);
    camera.position.lerpVectors(streetTween.fromPos, streetTween.toPos, e);
    controls.target.lerpVectors(streetTween.fromTgt, streetTween.toTgt, e);
    if (t >= 1) {
      var done = streetTween.onDone;
      streetTween = null;
      if (!tripFly) controls.enabled = true;
      // Only a naturally completed glide runs its follow directive; a
      // cancelled glide (pointerdown / programmatic move) never does.
      if (done) { try { done(); } catch (err) {} }
    }
  }
  // Programmatic camera moves (reset, locate) cancel any in-flight glide so
  // they don't fight over the camera.
  function cancelStreetTween() {
    if (streetTween) { streetTween = null; if (!tripFly) controls.enabled = true; }
    setFollow(null); // any programmatic move also ends bus tracking (restores zoomToCursor)
  }
  renderer.domElement.addEventListener('pointerdown', function () {
    if (streetTween) { streetTween = null; if (!tripFly) controls.enabled = true; }
    setFollow(null); // user takes the camera: stop tracking the bus
  });

  // --- Camera memory (2026-10-15) ---------------------------------------
  // Opening a card flies the camera to the card's subject (bus, stop,
  // place); the rider's own framing — where they were looking, at their
  // zoom — is otherwise lost, and closing the card strands the camera at
  // the subject. One snapshot repairs that: it is taken on the transition
  // INTO a card session (the first card opened while no card session is
  // active — showBus / showStop / setRideMode(true) / setTripMode(true)
  // call camMemTake) and restored by camMemOnSettled, which exclRestore
  // calls once a close leaves nothing showing. Chained cards never
  // overwrite it: when a covering card closes, the exclusion stack
  // restores the covered card and the session (and its snapshot) simply
  // continues; the revert fires only when the LAST card closes. The
  // snapshot lives in a variable only — never persisted.
  //
  // Rules around the snapshot:
  // - A framing gliding INTO place counts at its destination: if a glide
  //   is in flight when the snapshot is taken or refreshed, the glide's
  //   target framing is the rider's framing, not a mid-flight point.
  // - Manual camera moves while a card is open (drag, wheel, the rail's
  //   zoom buttons) never touch the snapshot: closing the card reverts
  //   them, per the directed behavior.
  // - Explicit camera actions are not card opens and are never reverted:
  //   Home/Reset and a successful locate REDEFINE the preserved framing
  //   (camMemRefresh, called by resetView and onLocated) — if a card is
  //   open over them, closing it returns to the framing they chose.
  // - A follow session is live-driven: engaging follow under a held
  //   snapshot marks it follow-owned. A card close that leaves follow
  //   running (the ride card) does NOT restore — follow owns the camera
  //   and the snapshot stays held; the bus card's close ends follow
  //   first (hideBus), so its restore fires normally, back to the fixed
  //   pre-follow framing however far the bus has since travelled. If
  //   follow instead ends with no card showing (the bus left the set,
  //   the rider grabbed the camera), the snapshot is dropped
  //   unrestored: the session that preserved it is over, and the camera
  //   stays where the rider's hands or the bus left it.
  // - Restore clamps the preserved distance into the controls' CURRENT
  //   limits (street view widens minDistance while it is active, so a
  //   framing preserved inside street view must not be restored past
  //   the limit in force at close). A card that never moved the camera
  //   (planner open, ride open without boarding) restores as a no-op.
  var camMem = null; // {pos, tgt, followOwned}
  function camMemFraming() {
    if (streetTween) return { pos: streetTween.toPos.clone(), tgt: streetTween.toTgt.clone() };
    return { pos: camera.position.clone(), tgt: controls.target.clone() };
  }
  function camMemTake() {
    if (camMem) return;
    if (typeof tripFly !== 'undefined' && tripFly) return; // the cinematic owns the camera
    var cur = visibleSurface();
    if (cur === 'stop' || cur === 'bus' || cur === 'trip' || cur === 'ride') return;
    var f = camMemFraming();
    camMem = { pos: f.pos, tgt: f.tgt, followOwned: !!followVId };
  }
  function camMemRefresh() {
    if (!camMem) return;
    var f = camMemFraming();
    camMem.pos = f.pos;
    camMem.tgt = f.tgt;
  }
  function camMemOnSettled() {
    if (!camMem) return;
    if (visibleSurface()) return;
    if (followVId) return; // follow owns the camera; the snapshot stays held
    if (typeof tripFly !== 'undefined' && tripFly) return; // cinematic owns the camera
    var mem = camMem;
    camMem = null;
    var off = mem.pos.clone().sub(mem.tgt);
    var len = off.length();
    var cl = Math.max(controls.minDistance, Math.min(controls.maxDistance, len));
    var pos = (len > 0 && cl !== len) ? mem.tgt.clone().add(off.setLength(cl)) : mem.pos;
    if (pos.distanceTo(camera.position) < 0.5 && mem.tgt.distanceTo(controls.target) < 0.5) return;
    var dist = camera.position.distanceTo(pos);
    glideTo(pos, mem.tgt, Math.min(1600, Math.max(600, dist * 0.35)));
  }
  // --- TransitionEngine (Phase 2) -----------------------------------------
  // After-touch camera transitions: every selection intent flows through one
  // path that frames the subject at the DisplayBounds safe-frame center
  // (not the viewport center), animates position + target with the existing
  // interruptible glide, and applies the intent's follow directive only on
  // natural completion. A cancelled intent never engages follow.
  var TransitionEngine = (function () {
    function worldPerPixel(dist) {
      var vFov = THREE.MathUtils.degToRad(camera.fov);
      var h = renderer.domElement.clientHeight || 1;
      return (2 * dist * Math.tan(vFov / 2)) / h;
    }
    // Shift pos/tgt so the subject renders at the safe-frame center instead
    // of the viewport center. Uses the camera's right/up basis at the
    // subject's depth; no-ops when the safe frame is already centered.
    function applySafeFrameOffset(pos, tgt) {
      var b = DisplayBounds.get();
      var sx = b.center.x - b.vw / 2, sy = b.center.y - b.vh / 2;
      if (Math.abs(sx) < 1 && Math.abs(sy) < 1) return { pos: pos, tgt: tgt };
      var wpp = worldPerPixel(pos.distanceTo(tgt));
      camera.updateMatrixWorld();
      var right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      var up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      var off = new THREE.Vector3()
        .addScaledVector(right, -sx * wpp)
        .addScaledVector(up, sy * wpp);
      return { pos: pos.clone().add(off), tgt: tgt.clone().add(off) };
    }
    // 32° elevated vantage for a bus at (bx, bz); keeps the current azimuth
    // so buildings don't occlude the subject. Distance respects the active
    // zoom limit so the per-frame clamp can't snap back mid-glide.
    function vantageForBus(bx, bz) {
      var bd = Math.max(controls.minDistance * 1.3, 900);
      _svDir.copy(camera.position).sub(controls.target); _svDir.y = 0;
      if (_svDir.lengthSq() < 1e-6) _svDir.set(1, 0, 0);
      _svDir.normalize();
      return {
        pos: new THREE.Vector3(bx + _svDir.x * bd, bd * 0.65, bz + _svDir.z * bd),
        tgt: new THREE.Vector3(bx, 40, bz)
      };
    }
    // 32° elevated vantage for a stop at (sx, sy, sz); keeps the current
    // azimuth. Closer than the bus vantage (stops are smaller targets).
    function vantageForStop(sx, sy, sz) {
      var sd = Math.max(controls.minDistance * 1.1, 700);
      _svDir.copy(camera.position).sub(controls.target); _svDir.y = 0;
      if (_svDir.lengthSq() < 1e-6) _svDir.set(1, 0, 0);
      _svDir.normalize();
      return {
        pos: new THREE.Vector3(sx + _svDir.x * sd, sy + sd * 0.65, sz + _svDir.z * sd),
        tgt: new THREE.Vector3(sx, sy, sz)
      };
    }
    // intent: { vantage:{pos,tgt}, follow:'engage'|'hold', vehicleId, slot }
    function go(intent) {
      if (typeof tripFly !== 'undefined' && tripFly) return; // D4a: cinematic owns the camera
      var framed = applySafeFrameOffset(intent.vantage.pos, intent.vantage.tgt);
      var dist = camera.position.distanceTo(framed.pos);
      var dur = Math.min(1600, Math.max(600, dist * 0.35));
      glideTo(framed.pos, framed.tgt, dur, function () {
        if (intent.follow === 'engage' && intent.vehicleId) setFollow(intent.vehicleId, intent.slot);
        else refreshFollowBtn();
      });
    }
    // Frame a ground point at a given camera distance: 40-degree
    // elevation (the home framing's angle) along the rider's current
    // azimuth, shifted into the DisplayBounds safe frame, moved with
    // the same interruptible glide as every other intent.
    function frameBounds(cx, cz, dist) {
      if (typeof tripFly !== 'undefined' && tripFly) return; // D4a: cinematic owns the camera
      _svDir.copy(camera.position).sub(controls.target); _svDir.y = 0;
      if (_svDir.lengthSq() < 1e-6) _svDir.set(0, 0, 1);
      _svDir.normalize();
      var el = 40 * Math.PI / 180;
      var pos = new THREE.Vector3(
        cx + _svDir.x * dist * Math.cos(el),
        dist * Math.sin(el),
        cz + _svDir.z * dist * Math.cos(el));
      var tgt = new THREE.Vector3(cx, 0, cz);
      var framed = applySafeFrameOffset(pos, tgt);
      var d = camera.position.distanceTo(framed.pos);
      glideTo(framed.pos, framed.tgt, Math.min(1600, Math.max(600, d * 0.35)));
    }
    return { go: go, vantageForBus: vantageForBus, vantageForStop: vantageForStop, frameBounds: frameBounds };
  })();
  // Vantage for a stop anchor: keep the user's current azimuth, pull back to
  // an oblique street-level framing. Works for DDOT stops (ground) and
  // People Mover stations (elevated deck).
  function streetVantageFor(st) {
    var ax = st.x, az = st.z, ay = st.pm ? PM_DECK_Y : STOP_BASE_Y;
    _svDir.copy(camera.position).sub(controls.target); _svDir.y = 0;
    if (_svDir.lengthSq() < 1e-6) _svDir.set(1, 0, 0);
    _svDir.normalize();
    return {
      pos: new THREE.Vector3(ax + _svDir.x * 620, ay + 250, az + _svDir.z * 620),
      tgt: new THREE.Vector3(ax, ay, az)
    };
  }
  function enterStreetView() {
    var anchor = nearestStopTo(controls.target.x, controls.target.z, 900);
    var st = anchor || { x: controls.target.x, z: controls.target.z };
    var v = streetVantageFor(st);
    controls.minDistance = 150;   // street view owns the close range
    camera.near = 10; camera.updateProjectionMatrix();
    streetView = true;
    streetGuideFadeTarget = 0.07; // guideways recede; stops + buses take over
    glideTo(v.pos, v.tgt, 1400);
  }
  function exitStreetView() {
    streetView = false;
    controls.minDistance = 1200;  // restore the orbit constraint
    camera.near = 100; camera.updateProjectionMatrix();
    streetGuideFadeTarget = 1;    // guideways glide back
    // No forced camera move: the user is already zooming out.
  }
  // Stop name labels: the "individual stops" legibility layer. Only in
  // street view, nearest few within ~1 km of the target.
  var stopLabelCache = {};
  var stopLabelOrder = [];
  var STOP_LABEL_CACHE_MAX = 512;
  function stopLabelTex(name) {
    var hit = stopLabelCache[name];
    if (hit) {
      var hi = stopLabelOrder.indexOf(name);
      if (hi >= 0) { stopLabelOrder.splice(hi, 1); stopLabelOrder.push(name); }
      return hit;
    }
    var c = document.createElement('canvas');
    var x = c.getContext('2d');
    x.font = '500 30px system-ui, -apple-system, sans-serif';
    var w = Math.ceil(x.measureText(name).width) + 44;
    c.width = w; c.height = 56;
    var g = x; // redraw after resize (resizing clears the context state)
    g.fillStyle = 'rgba(10,14,18,0.85)';
    g.beginPath();
    if (g.roundRect) g.roundRect(0, 0, c.width, c.height, 14); else g.rect(0, 0, c.width, c.height);
    g.fill();
    g.font = '500 30px system-ui, -apple-system, sans-serif';
    g.fillStyle = '#F2F2F2'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name, c.width / 2, c.height / 2 + 1);
    var t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    var o = { tex: t, aspect: c.width / c.height };
    stopLabelCache[name] = o;
    stopLabelOrder.push(name);
    // LRU eviction (2026-10-16, crash fix F3): same unbounded-retention
    // defect as the street label cache; see streetLabelTexture.
    while (stopLabelOrder.length > STOP_LABEL_CACHE_MAX) {
      var evictStop = stopLabelOrder.shift();
      var evictStopEntry = stopLabelCache[evictStop];
      if (evictStopEntry) {
        if (evictStopEntry.tex) evictStopEntry.tex.dispose();
        delete stopLabelCache[evictStop];
      }
    }
    return o;
  }
  var stopLabelPool = [];
  // Project 21: the pool grows 8 -> 14 sprites — street view keeps its
  // shipped cap of 8 placements; the orbit tier below caps at 12.
  for (var _svi = 0; _svi < 14; _svi++) {
    var _svl = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }));
    _svl.visible = false;
    _svl.renderOrder = 36;
    scene.add(_svl);
    stopLabelPool.push(_svl);
  }
  // Screen rects of the stop labels placed by the most recent stop-label
  // pass (either view). updateStreetLabels runs after this pass in the
  // frame loop and seeds its collision set with these: street names
  // yield screen space to stop names (project 21's hierarchy).
  var stopLabelRects = [];
  // Project 21: prominent-stop selection for the ORBIT view (the
  // street-view selection in updateStopLabels keeps its shipped
  // nearest-8-within-1 km behavior). Pure function of its inputs so the
  // gate can assert tier membership from the shipped code: candidates
  // are the governed stops (stopPickList — prominence changes
  // presentation, never membership) plus People Mover stations when
  // the PM layer is on. Weight W per stop = max(own visible routes,
  // facility union from buildFacilityCounts). Tiers: 0 anchors
  // (W >= 4, and every PM station), 1 transfer points (W 2-3),
  // 2 live single-route stops (a serving visible route has a live
  // bus), 3 the remaining governed stops. Distance bands decide which
  // tiers may speak: > 13,000 m tiers 0-1 (city view — the default
  // zoom), 7,000-13,000 m tiers 0-2, <= 7,000 m all tiers (the
  // neighborhood fill, nearest first). Order: tier; within tier 0,
  // facility weight first (landmark nodes before nearer ordinary
  // crossings), then distance; other tiers nearest-first. Candidates
  // within 0.62 x camDist; the caller places up to
  // PROMINENT_LABEL_CAP with screen-space collision.
  var PROMINENT_LABEL_CAP = 12;
  function prominentStopPick(list, pmList, camDist, tx, tz, liveCounts, facCounts, onFn) {
    var maxTier = camDist > 13000 ? 1 : (camDist > 7000 ? 2 : 3);
    var R = camDist * 0.62, R2 = R * R;
    var scored = [];
    function consider(st, isPm) {
      if (!st.n) return;
      var dx = st.x - tx, dz = st.z - tz;
      var d2 = dx * dx + dz * dz;
      if (d2 > R2) return;
      var tier;
      if (isPm) {
        tier = 0;
      } else {
        var own = 0, live = false;
        (st.r || []).forEach(function (rid) {
          if (onFn && !onFn(rid)) return;
          own++;
          if (liveCounts && liveCounts[rid] > 0) live = true;
        });
        var fac = facCounts ? (facCounts.get(st) || 0) : 0;
        var w = Math.max(own, fac);
        tier = w >= 4 ? 0 : (w >= 2 ? 1 : (live ? 2 : 3));
      }
      if (tier > maxTier) return;
      scored.push({ stop: st, tier: tier, d2: d2, w: isPm ? 4 : w });
    }
    for (var i = 0; i < list.length; i++) consider(list[i], false);
    if (pmList) for (var p = 0; p < pmList.length; p++) consider(pmList[p], true);
    scored.sort(function (a, b) {
      if (a.tier !== b.tier) return a.tier - b.tier;
      // Within the anchor tier, the biggest nodes speak first (facility
      // weight, then distance): at city scale the region's landmark
      // stops — the transit centers — must not lose the budget to a
      // dozen nearer ordinary crossings. Other tiers are nearest-first:
      // they are local texture, and proximity is their meaning.
      if (a.tier === 0 && a.w !== b.w) return b.w - a.w;
      return a.d2 - b.d2;
    });
    // One label per name stem per place: direction pairs and terminal
    // bays share a stem, and printing the same name twice side by side
    // spends the budget without adding information — the nearest
    // carrier holds the name; a same-stem stop 600+ m away (a
    // different place that happens to share the name) still earns
    // its own.
    var out = [], carried = [];
    for (var q = 0; q < scored.length && out.length < PROMINENT_LABEL_CAP; q++) {
      var cand = scored[q], stem = facilityStem(cand.stop.n), dup = false;
      for (var c = 0; c < carried.length; c++) {
        if (carried[c].stem !== stem) continue;
        var cdx = carried[c].x - cand.stop.x, cdz = carried[c].z - cand.stop.z;
        if (cdx * cdx + cdz * cdz <= 600 * 600) { dup = true; break; }
      }
      if (dup) continue;
      carried.push({ stem: stem, x: cand.stop.x, z: cand.stop.z });
      out.push(cand);
    }
    return out;
  }
  var lastStopLabelUpdate = 0;
  function updateStopLabels() {
    var now = performance.now();
    if (now - lastStopLabelUpdate < 500) return;
    lastStopLabelUpdate = now;
    var i;
    if (!streetView) {
      // Project 21: orbit-view prominent-stop labels (selection:
      // prominentStopPick above). Constant-screen-size pills a step
      // above the street labels (world height camDist x 0.0215 vs the
      // streets' 0.02), anchored at the pylon top, placed with the
      // same screen-space collision discipline as the street-view
      // path. Placed rects publish to stopLabelRects so the street
      // pass, which runs after this one, yields them the space.
      stopLabelRects = [];
      if (!stopGroup || !stopGroup.visible) {
        for (i = 0; i < stopLabelPool.length; i++) stopLabelPool[i].visible = false;
        return;
      }
      var otx = controls.target.x, otz = controls.target.z;
      var ocamDist = camera.position.distanceTo(controls.target);
      var picks = prominentStopPick(stopPickList || [],
        pmVisible ? pmStations : null, ocamDist, otx, otz,
        liveCounts, stopFacilityCounts,
        function (rid) { return routeIsOn(rid); });
      var orw = renderer.domElement.clientWidth, orh = renderer.domElement.clientHeight;
      var opxPerM = orh / (2 * ocamDist * Math.tan(camera.fov * 0.5 * DEG));
      var oh = ocamDist * 0.0215;
      var on2 = 0;
      for (i = 0; i < picks.length && on2 < stopLabelPool.length; i++) {
        var ost = picks[i].stop;
        var oo = stopLabelTex(ost.n);
        var oly = (ost.pm ? PM_DECK_Y : STOP_BASE_Y) + stopHeight((ost.r || []).length) * stopYS + 40;
        _p3.set(ost.x, oly, ost.z).project(camera);
        if (_p3.z > 1 || _p3.z < -1) continue;
        var ocxp = (_p3.x * 0.5 + 0.5) * orw, ocyp = (-_p3.y * 0.5 + 0.5) * orh;
        var olw = oh * oo.aspect * opxPerM, olh = oh * opxPerM;
        var oclash = false;
        for (var oc = 0; oc < stopLabelRects.length; oc++) {
          var opr = stopLabelRects[oc];
          if (Math.abs(ocxp - opr.x) < (olw + opr.w) / 2 + 8 &&
              Math.abs(ocyp - opr.y) < (olh + opr.h) / 2 + 6) { oclash = true; break; }
        }
        if (oclash) continue;
        stopLabelRects.push({ x: ocxp, y: ocyp, w: olw, h: olh });
        var osp = stopLabelPool[on2++];
        if (osp.userData.tex !== oo.tex) { osp.material.map = oo.tex; osp.userData.tex = oo.tex; osp.material.needsUpdate = true; }
        osp.scale.set(oh * oo.aspect, oh, 1);
        osp.position.set(ost.x, oly, ost.z);
        osp.visible = true;
      }
      for (i = on2; i < stopLabelPool.length; i++) stopLabelPool[i].visible = false;
      return;
    }
    var tx = controls.target.x, tz = controls.target.z;
    var scored = [];
    // Project 13: labels name exactly the governed stops (see
    // nearestStopTo) — no all-stops fallback when the set is empty.
    var list = stopPickList || [];
    for (i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s.n) continue;
      var d2 = (s.x - tx) * (s.x - tx) + (s.z - tz) * (s.z - tz);
      if (d2 < 1000 * 1000) scored.push([d2, s]);
    }
    for (var p = 0; pmVisible && p < pmStations.length; p++) {
      var q = pmStations[p];
      var qd2 = (q.x - tx) * (q.x - tx) + (q.z - tz) * (q.z - tz);
      if (qd2 < 1000 * 1000) scored.push([qd2, q]);
    }
    scored.sort(function (a, b) { return a[0] - b[0]; });
    // Nearest-first placement with screen-space collision: no overlapping
    // stop labels (2026-10-06: production screenshot showed stop names
    // stacking into unreadable piles at street zoom).
    var placed = [];
    var rw = renderer.domElement.clientWidth, rh = renderer.domElement.clientHeight;
    var camDist = camera.position.distanceTo(controls.target);
    var pxPerM = rh / (2 * camDist * Math.tan(camera.fov * 0.5 * DEG));
    var n = 0;
    for (i = 0; i < scored.length && n < 8; i++) {
      var st = scored[i][1];
      var o = stopLabelTex(st.n);
      var ly = (st.pm ? PM_DECK_Y : STOP_BASE_Y) + stopHeight((st.r || []).length) * stopYS + 40;
      _p3.set(st.x, ly, st.z).project(camera);
      if (_p3.z > 1 || _p3.z < -1) continue;
      var cxp = (_p3.x * 0.5 + 0.5) * rw, cyp = (-_p3.y * 0.5 + 0.5) * rh;
      var lw = 44 * o.aspect * pxPerM, lh = 44 * pxPerM;
      var clash = false;
      for (var c = 0; c < placed.length; c++) {
        var pr = placed[c];
        if (Math.abs(cxp - pr.x) < (lw + pr.w) / 2 + 8 &&
            Math.abs(cyp - pr.y) < (lh + pr.h) / 2 + 6) { clash = true; break; }
      }
      if (clash) continue;
      placed.push({ x: cxp, y: cyp, w: lw, h: lh });
      var sp = stopLabelPool[n++];
      if (sp.userData.tex !== o.tex) { sp.material.map = o.tex; sp.userData.tex = o.tex; sp.material.needsUpdate = true; }
      sp.scale.set(44 * o.aspect, 44, 1);
      sp.position.set(st.x, ly, st.z);
      sp.visible = true;
    }
    // Project 21: street names yield to these rects too (same seeding
    // as the orbit path).
    stopLabelRects = placed;
    for (i = n; i < stopLabelPool.length; i++) stopLabelPool[i].visible = false;
  }

  // Zoom-coupled pillar scale, eased every frame toward the zoom target so
  // markers glide instead of stepping. Rewrites instance matrices only while
  // the eased value is still moving; badge anchors follow the pillar tops.
  function easePillarScale(camDist) {
    if (busMode) return; // true-scale models need no pillar scaling
    var target = pillarScaleFor(camDist);
    var d = target - pillarYS;
    if (Math.abs(d) < 0.003) {
      if (pillarYS === target) return;
      pillarYS = target;
    } else {
      pillarYS += d * 0.16;
    }
    for (var k = 0; k < busSlots.length; k++) writeBusMatrices(k, busSlots[k], 1);
    pillarMeshes.forEach(function (im) { im.instanceMatrix.needsUpdate = true; });
    updateBusBadges(busSlots.length, PILLAR_H * pillarYS + 80);
  }

  // Zoom-coupled stop scale, eased every frame like the pillars.
  // Phase 2: easing writes the uStopScale uniform only — no matrix
  // rewrite, so instance colors (and the selection highlight painted in
  // them) are never disturbed and need no re-application. People Mover
  // pins follow the same scale so all stop-class markers behave as one
  // family.
  function easeStopScale(camDist) {
    var target = stopScaleFor(camDist);
    var d = target - stopYS;
    var xzTarget = stopXZFor(camDist);
    var dxz = xzTarget - stopXZS;
    if (Math.abs(d) < 0.003 && Math.abs(dxz) < 0.003) {
      if (stopYS === target && stopXZS === xzTarget) return;
      stopYS = target;
      stopXZS = xzTarget;
    } else {
      if (Math.abs(d) >= 0.003) stopYS += d * 0.16; else stopYS = target;
      if (Math.abs(dxz) >= 0.003) stopXZS += dxz * 0.16; else stopXZS = xzTarget;
    }
    stopXZU.value = stopXZS;
    syncStopScaleU();
    for (var p = 0; p < pmPins.length; p++) {
      var pin = pmPins[p];
      pin.scale.y = stopYS;
      pin.position.y = PM_DECK_Y + (300 * stopYS) / 2;
    }
    if (typeof mogoRescale === 'function') mogoRescale();
    if (typeof placesRescale === 'function') placesRescale();
    // NOTE 2026-10-06: stop distance-fade (opacity easing) reverted — it
    // correlated with renderer crashes in testing. Stops stay fully opaque
    // until a safer quieting mechanism is validated.
  }

  var raycaster = new THREE.Raycaster();
  var pointerNDC = new THREE.Vector2();
  var downPos = null;
  // Touch Accuracy (project 10, 2026-10-17): the badge is an aim point
  // too. In bus mode the badge is the only reliably visible part of the
  // bus — the true-scale body sits behind its route's ribbon draw
  // (measured occluded from side aspects at every working distance) —
  // and it renders ~110 m above the ground anchor, which put badge taps
  // outside every radius at close zoom (battery on 2151: badge aims
  // resolved 16% bus / 82% nothing in bus mode).
  // Candidates are scored by EDGE distance — distance to the aim point
  // minus the aim's own screen radius — so a fat target (a stop pylon,
  // ~16 m radius) and a compact one (a bus body, a badge) compete on
  // how deep inside their visible extent the tap landed, not on whose
  // center happens to be nearer. Returns { vehicle, d, score } for the
  // best bus within maxD px of an aim point, or null.
  function busSlotAim(s, i, cx, cy, r, cap) {
    var best = null;
    function consider(px, py, wpp, radiusWorld) {
      var ddx = px - cx, ddy = py - cy;
      var d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (cap != null && d > cap) return;
      var score = d - (wpp > 0 ? radiusWorld / wpp : 0);
      if (!best || score < best.score) best = { d: d, score: score };
    }
    if (busMode) {
      // Anchor at the detail body's own center height: the shipped
      // y=40 anchor projected ~44 px above the visible body at close
      // zoom, so taps ON the body measured near or past the radius
      // edge (battery: body aims 71% on 2151).
      _p3.set(s.x, 2, s.z);
      var distB = camera.position.distanceTo(_p3);
      _p3.project(camera);
      if (_p3.z <= 1 && _p3.z >= -1) {
        var wppB = (2 * distB *
          Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / r.height;
        consider((_p3.x * 0.5 + 0.5) * r.width + r.left,
                 (-_p3.y * 0.5 + 0.5) * r.height + r.top, wppB, 6.7);
      }
    } else {
      _p3.set(s.x, 0, s.z).project(camera);
      if (_p3.z <= 1 && _p3.z >= -1) {
        var ax = (_p3.x * 0.5 + 0.5) * r.width + r.left;
        var ay = (-_p3.y * 0.5 + 0.5) * r.height + r.top;
        _p3.set(s.x, PILLAR_H * pillarYS + 48, s.z);
        var distP = camera.position.distanceTo(_p3);
        _p3.project(camera);
        if (_p3.z <= 1 && _p3.z >= -1) {
          var bx = (_p3.x * 0.5 + 0.5) * r.width + r.left;
          var by = (-_p3.y * 0.5 + 0.5) * r.height + r.top;
          var vx = bx - ax, vy = by - ay;
          var len2 = vx * vx + vy * vy;
          var tt = len2 ? ((cx - ax) * vx + (cy - ay) * vy) / len2 : 0;
          tt = tt < 0 ? 0 : (tt > 1 ? 1 : tt);
          var qx = ax + tt * vx, qy = ay + tt * vy;
          var wppP = (2 * distP *
            Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / r.height;
          consider(qx, qy, wppP, 14);
        }
      }
    }
    var sp = badgePool[i];
    if (sp && sp.visible) {
      var distG = camera.position.distanceTo(sp.position);
      _p3.copy(sp.position).project(camera);
      if (_p3.z <= 1 && _p3.z >= -1) {
        var wppG = (2 * distG *
          Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / r.height;
        consider((_p3.x * 0.5 + 0.5) * r.width + r.left,
                 (-_p3.y * 0.5 + 0.5) * r.height + r.top,
                 wppG, sp.scale.y / 2);
      }
    }
    return best;
  }
  function pickNearestScreenD(cx, cy, r, maxD) {
    var cap = (maxD != null ? maxD : 48);
    var best = null, bestScore = Infinity;
    for (var i = 0; i < busSlots.length; i++) {
      var aim = busSlotAim(busSlots[i], i, cx, cy, r, cap);
      if (aim && aim.score < bestScore) {
        bestScore = aim.score;
        best = { vehicle: busSlots[i].vehicle, d: aim.d, score: aim.score };
      }
    }
    return best;
  }
  function pickNearestScreen(cx, cy, r) {
    var hit = pickNearestScreenD(cx, cy, r, 48);
    return hit ? hit.vehicle : null;
  }
  // The aim of one specific bus (the raycast winner, in a contest).
  function busScreenAim(veh, cx, cy, r, cap) {
    for (var i = 0; i < busSlots.length; i++) {
      if (busSlots[i].vehicle === veh) return busSlotAim(busSlots[i], i, cx, cy, r, cap);
    }
    return null;
  }
  // Tap a stop pylon: raycast the instanced markers, report name + routes.
  // Touch gets a 44px screen-space nearest fallback so finger taps are
  // forgiving at far zooms (mirrors the bus pillar fallback).
  var _stopV3 = null;
  // Touch fallback: nearest stop center on screen within 44px. Split out so
  // the tap handler can try the depth-ordered raycast first.
  function pickStopScreenD(cx, cy, r, maxD) {
    if (!_stopV3) _stopV3 = new THREE.Vector3();
    var sx = cx - r.left, sy = cy - r.top;
    var best = null, bestScore = Infinity;
    for (var i = 0; i < stopPickList.length; i++) {
      var s = stopPickList[i];
      _stopV3.set(s.x, STOP_BASE_Y + stopHeight(s.r.length) * stopYS / 2, s.z);
      var distS = camera.position.distanceTo(_stopV3);
      _stopV3.project(camera);
      if (_stopV3.z > 1) continue;
      var px = (_stopV3.x * 0.5 + 0.5) * r.width;
      var py = (-_stopV3.y * 0.5 + 0.5) * r.height;
      var d = Math.hypot(px - sx, py - sy);
      if (d > (maxD != null ? maxD : 44)) continue;
      var wppS = (2 * distS * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / r.height;
      var score = d - (wppS > 0 ? stopAimRadiusM() / wppS : 0);
      if (score < bestScore) { bestScore = score; best = { stop: s, d: d, score: score }; }
    }
    return best;
  }
  function pickStopScreen(cx, cy, r) {
    var hit = pickStopScreenD(cx, cy, r, 44);
    return hit ? hit.stop : null;
  }
  // The aim of one specific stop (its pylon center, projected exactly
  // as pickStopScreen projects it), scored the same edge-distance way.
  // Touch Accuracy arbitration measures a contested raycast hit
  // against the other class with this.
  function stopScreenAim(st, cx, cy, r) {
    if (!_stopV3) _stopV3 = new THREE.Vector3();
    _stopV3.set(st.x, STOP_BASE_Y + stopHeight(st.r.length) * stopYS / 2, st.z);
    var distS = camera.position.distanceTo(_stopV3);
    _stopV3.project(camera);
    if (_stopV3.z > 1) return null;
    var px = (_stopV3.x * 0.5 + 0.5) * r.width;
    var py = (-_stopV3.y * 0.5 + 0.5) * r.height;
    var d = Math.hypot(px - (cx - r.left), py - (cy - r.top));
    var wppS = (2 * distS * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / r.height;
    return { d: d, score: d - (wppS > 0 ? stopAimRadiusM() / wppS : 0) };
  }
  // Render-engine refactor Phase 3 (project 15): stop picking reads a
  // uniform grid over stopPickList instead of raycasting the whole
  // InstancedMesh (three tests every one of the 10,583 instances per
  // pick — 5.70 ms measured in the project-15 research; the grid query
  // class measured <0.01 ms). The grid only ENUMERATES candidates; the
  // intersection test itself is the exact per-instance triangle raycast
  // three performs, run on a scratch mesh with the candidate's own
  // instance matrix, so the winner — and every arbitration outcome
  // downstream under project 10's rules, which are untouched — is the
  // same by construction. Completeness: a ray can only hit a pylon
  // whose base lies within the pylon radius (18 m) of the ray's XZ
  // trace through the height band the pylons occupy; the walk samples
  // that trace every half cell and unions the 3 x 3 cell blocks, which
  // covers an 18 m halo around the trace with margin.
  var STOP_GRID_CELL = 64;
  var stopGrid = null, stopGridFor = null, stopGridLen = -1;
  var stopGridFirst = null, stopGridLast = null;
  function buildStopGrid() {
    stopGrid = new Map();
    for (var i = 0; i < stopPickList.length; i++) {
      var s = stopPickList[i];
      var key = Math.floor(s.x / STOP_GRID_CELL) + ',' + Math.floor(s.z / STOP_GRID_CELL);
      var cell = stopGrid.get(key);
      if (!cell) { cell = []; stopGrid.set(key, cell); }
      cell.push(i);
    }
    stopGridFor = stopPickList;
    stopGridLen = stopPickList.length;
    stopGridFirst = stopPickList[0] || null;
    stopGridLast = stopPickList[stopPickList.length - 1] || null;
  }
  function ensureStopGrid() {
    if (stopGridFor !== stopPickList || stopGridLen !== stopPickList.length ||
        stopGridFirst !== (stopPickList[0] || null) ||
        stopGridLast !== (stopPickList[stopPickList.length - 1] || null)) buildStopGrid();
  }
  var _gridScratch = null, _gridM4 = null;
  function gridStopHit(raycaster) {
    if (!stopPickList.length) return null;
    // Same matrix/visual sync Phase 2's override guarded: the scratch
    // tests read instance matrices, which bake stopBakedYS, while the
    // shader draws stopYS. A pick that arrives after the scale moved
    // re-bakes first — a discrete-event cost, off the frame path.
    if (stopBakedYS !== stopYS) writeStopMatrices(stopPickList, false);
    ensureStopGrid();
    if (!_gridScratch) {
      _gridScratch = new THREE.Mesh(stopIM.geometry, stopIM.material);
      _gridScratch.matrixAutoUpdate = false;
      _gridScratch.matrixWorldAutoUpdate = false;
      _gridM4 = new THREE.Matrix4();
    }
    var o = raycaster.ray.origin, d = raycaster.ray.direction;
    var maxTop = 0;
    for (var i = 0; i < stopPickList.length; i++) {
      var hh = STOP_BASE_Y + stopHeight(stopPickList[i].r.length) * stopYS;
      if (hh > maxTop) maxTop = hh;
    }
    // The ray's parameter span while its Y is inside [0, maxTop].
    var t0 = 0, t1 = 60000;
    if (Math.abs(d.y) > 1e-9) {
      var ta = (0 - o.y) / d.y, tb = (maxTop - o.y) / d.y;
      t0 = Math.max(0, Math.min(ta, tb));
      t1 = Math.max(ta, tb);
      if (t1 < 0) return null;
      if (t1 > 60000) t1 = 60000;
    } else if (o.y < 0 || o.y > maxTop) return null;
    if (t1 < t0) return null;
    var cand = new Set();
    var steps = Math.max(1, Math.ceil((t1 - t0) / (STOP_GRID_CELL * 0.5)));
    for (var k = 0; k <= steps; k++) {
      var t = t0 + (t1 - t0) * (k / steps);
      var cx = Math.floor((o.x + d.x * t) / STOP_GRID_CELL);
      var cz = Math.floor((o.z + d.z * t) / STOP_GRID_CELL);
      for (var gx = cx - 1; gx <= cx + 1; gx++) {
        for (var gz = cz - 1; gz <= cz + 1; gz++) {
          var cell = stopGrid.get(gx + ',' + gz);
          if (cell) for (var j = 0; j < cell.length; j++) cand.add(cell[j]);
        }
      }
    }
    var best = null;
    cand.forEach(function (idx) {
      stopIM.getMatrixAt(idx, _gridM4);
      _gridScratch.matrix.copy(_gridM4);
      _gridScratch.matrixWorld.copy(_gridM4);
      var hits = [];
      _gridScratch.raycast(raycaster, hits);
      if (hits.length && (!best || hits[0].distance < best.distance)) {
        hits[0].instanceId = idx;
        best = hits[0];
      }
    });
    return best;
  }
  function pickStop(cx, cy, isTouch) {
    if (!stopGroup || !stopGroup.visible || !stopPickList.length) return null;
    var r = renderer.domElement.getBoundingClientRect();
    pointerNDC.set(
      ((cx - r.left) / r.width) * 2 - 1,
      -(((cy - r.top) / r.height) * 2 - 1)
    );
    raycaster.setFromCamera(pointerNDC, camera);
    var hit = gridStopHit(raycaster);
    if (hit) {
      return stopPickList[hit.instanceId] || null;
    }
    if (!isTouch) return null;
    return pickStopScreen(cx, cy, r);
  }
  // Depth-ordered tap pick: buses and stops in ONE raycast so the visually
  // frontmost marker wins. Previously buses were tested first and always won,
  // even when a stop stood in front of the pillar (2026-10-06: tapping a stop
  // overlapping a bus pillar could not select the stop).
  function pickTopHit(cx, cy) {
    var r = renderer.domElement.getBoundingClientRect();
    pointerNDC.set(
      ((cx - r.left) / r.width) * 2 - 1,
      -(((cy - r.top) / r.height) * 2 - 1)
    );
    raycaster.setFromCamera(pointerNDC, camera);
    var targets = [];
    var busMeshCount = 0;
    if (busMode) {
      for (var i = 0; i < DETAIL_MAX; i++) {
        var d = detailPool[i];
        if (d && d.group.visible) { targets.push(d.body); busMeshCount++; }
      }
    } else {
      targets.push(pillarBeaconIM, pillarGlowIM, pillarCoreIM);
      busMeshCount = 3;
    }
    var hits = raycaster.intersectObjects(targets);
    var h = hits.length ? hits[0] : null;
    // Phase 3: the stop contestant comes from gridStopHit (identical
    // intersection math over a candidate subset) and merges with the
    // bus raycast by distance — a tie keeps the bus, exactly as the
    // combined intersectObjects order did (stopIM sorted last).
    if (stopGroup && stopGroup.visible && stopPickList.length) {
      var sHit = gridStopHit(raycaster);
      if (sHit && (!h || sHit.distance < h.distance)) {
        var st = stopPickList[sHit.instanceId] || null;
        return st ? { kind: 'stop', stop: st } : null;
      }
    }
    if (!h) return null;
    if (busMode) {
      var veh = (h.object.userData.detail) ? h.object.userData.detail.vehicle : null;
      return veh ? { kind: 'bus', vehicle: veh } : null;
    }
    var slot = (h.instanceId != null) ? busSlots[h.instanceId] : null;
    return (slot && slot.vehicle) ? { kind: 'bus', vehicle: slot.vehicle } : null;
  }
  function pickBus(cx, cy, touchSlop) {
    var r = renderer.domElement.getBoundingClientRect();
    pointerNDC.set(
      ((cx - r.left) / r.width) * 2 - 1,
      -((cy - r.top) / r.height) * 2 + 1
    );
    raycaster.setFromCamera(pointerNDC, camera);
    if (busMode) {
      var bodies = [];
      for (var i = 0; i < DETAIL_MAX; i++) {
        var d = detailPool[i];
        if (d && d.group.visible) bodies.push(d.body);
      }
      var hits = raycaster.intersectObjects(bodies);
      if (hits.length) return hits[0].object.userData.detail.vehicle;
    } else {
      // Beacon heads, the visible glow column, then thin cores.
      var ih = raycaster.intersectObjects([pillarBeaconIM, pillarGlowIM, pillarCoreIM]);
      if (ih.length && ih[0].instanceId != null && busSlots[ih[0].instanceId]) {
        return busSlots[ih[0].instanceId].vehicle;
      }
    }
    if (touchSlop) return pickNearestScreen(cx, cy, r);
    return null;
  }
  renderer.domElement.addEventListener('pointerdown', function (e) {
    downPos = [e.clientX, e.clientY];
  });
  // Tapping the info pill dismisses it (the × is the affordance; the
  // whole pill is the target — fingers are imprecise).
  function tapHitsBusInfo(cx, cy) {
    if (!busInfoSprite.visible) return false;
    var r = renderer.domElement.getBoundingClientRect();
    pointerNDC.set(
      ((cx - r.left) / r.width) * 2 - 1,
      -(((cy - r.top) / r.height) * 2 - 1)
    );
    raycaster.setFromCamera(pointerNDC, camera);
    return raycaster.intersectObject(busInfoSprite).length > 0;
  }
  renderer.domElement.addEventListener('pointerup', function (e) {
    if (!downPos) return;
    var dx = e.clientX - downPos[0], dy = e.clientY - downPos[1];
    downPos = null;
    var isTouch = e.pointerType === 'touch';
    if (dx * dx + dy * dy > (isTouch ? 169 : 36)) return; // was a drag (13px touch slop)
    if (tapHitsBusInfo(e.clientX, e.clientY)) { hideBus(); return; }
    // Touch Accuracy (project 10): ONE pick-resolution rule for touch
    // and mouse. The depth-ordered raycast runs first, but its winner
    // is CONTESTED by the other class: candidates are scored by edge
    // distance (aim distance minus the aim's screen radius), and the
    // other class takes the tap when its score beats the winner's by
    // more than 6 px. The battery on 2151 showed both theft
    // directions: stop-front taps on a bus resolving to the stop pylon
    // whose front surface won the depth race, and taps on a stop
    // standing inside a bus pillar's glow resolving to the bus. A tap
    // deep inside the winner's own extent (its aim ~0 px away) can
    // never be stolen, so a stop in front of a bus stays selectable
    // (2026-10-06) and a tap on the bus body stays a bus.
    var hit = pickTopHit(e.clientX, e.clientY);
    if (hit && hit.kind === 'bus') {
      var _crB = renderer.domElement.getBoundingClientRect();
      var _ba = busScreenAim(hit.vehicle, e.clientX, e.clientY, _crB, isTouch ? 48 : 26);
      var _stB = (_ba && stopGroup && stopGroup.visible)
        ? pickStopScreenD(e.clientX, e.clientY, _crB, isTouch ? 44 : 22) : null;
      if (_stB && _stB.score < _ba.score - 6) { showStop(_stB.stop); return; }
      showBus(hit.vehicle); return;
    }
    if (hit && hit.kind === 'stop') {
      var _cr = renderer.domElement.getBoundingClientRect();
      var _sa = stopScreenAim(hit.stop, e.clientX, e.clientY, _cr);
      var _cb = pickNearestScreenD(e.clientX, e.clientY, _cr, isTouch ? 48 : 26);
      if (_cb && _sa && _cb.score < _sa.score - 6) { showBus(_cb.vehicle); return; }
      showStop(hit.stop); return;
    }
    // People Mover stations first: their elevated pins were losing taps to the
    // dense downtown DDOT stops beneath them. (No-op while the PM layer is off.)
    var pm = pickPMStation(e.clientX, e.clientY, isTouch);
    if (pm) { showStop(pm); return; }
    // MoGo bikeshare stations: same direct-pick precedence as the
    // People Mover pins. (No-op while the layer is off or feed down.)
    var mg = (typeof pickMogoStation === 'function') ? pickMogoStation(e.clientX, e.clientY, isTouch) : null;
    if (mg) { showStop(mg); return; }
    // Places (Starbucks / Planet Fitness): same direct-pick precedence,
    // after MoGo. (No-op while both brand toggles are off.)
    var pl = (typeof pickPlace === 'function') ? pickPlace(e.clientX, e.clientY, isTouch) : null;
    if (pl) { showStop(pl); return; }
    // Raycast missed everything: unified screen-space arbitration
    // (Touch Accuracy, project 10) on the same edge-distance scores.
    // Radii — touch 48/44 as shipped; mouse 26/22: a precise pointer
    // gets a smaller net, but it previously got none at all (battery
    // on 2151: 7% of mouse clicks on a co-located bus resolved). The
    // bus wins a <= 6 px tie (it is the moving, tracked target).
    var _r = renderer.domElement.getBoundingClientRect();
    var _nb = pickNearestScreenD(e.clientX, e.clientY, _r, isTouch ? 48 : 26);
    var _ns = pickStopScreenD(e.clientX, e.clientY, _r, isTouch ? 44 : 22);
    if (_nb && (!_ns || _nb.score <= _ns.score + 6)) { showBus(_nb.vehicle); return; }
    if (_ns) { showStop(_ns.stop); return; }
    // Route pick (2026-11-05): a tap no bus or stop claimed can still
    // land on a route — its label, or its guideway line. Sparse
    // corridors (Downriver 160) have nothing else to answer a tap.
    if (!(typeof tripMode !== 'undefined' && tripMode) && !rideMode) {
      var _rp = pickRouteLabel(e.clientX, e.clientY, isTouch) || pickRouteLine(e.clientX, e.clientY, isTouch);
      if (_rp) { showRoute(_rp); return; }
    }
    if (selectedRoute) clearRouteSelection();
    hideBus(); hideStop();
  });
  renderer.domElement.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse' || downPos) return;
    var hov = pickBus(e.clientX, e.clientY);
    if (!hov) {
      // Hover parity (project 10): the cursor tells the truth over a
      // badge too, not only over pickable geometry.
      var _hb = pickNearestScreenD(e.clientX, e.clientY, renderer.domElement.getBoundingClientRect(), 26);
      hov = _hb ? _hb.vehicle : null;
    }
    renderer.domElement.style.cursor = hov ? 'pointer' : 'grab';
  });

  function compass(bearing) {
    if (bearing == null || isNaN(bearing)) return '–';
    return COMPASS[Math.round(bearing / 45) % 8] + ' (' + Math.round(bearing) + '°)';
  }

  function tapBuzz() { try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) {} }
  // Selected-bus follow: the one-time glide in showBus lands on the bus's
  // position at select time, but dead reckoning moves every bus each frame and
  // polls re-match it — without tracking, the bus drives out of the static
  // view. While a bus is selected, followTick translates the whole camera rig
  // with the bus's live slot position, so the selection stays on screen.
  // Any canvas pointerdown hands the camera back to the user.
  var followVId = null;
  var followSuppressed = false; // user explicitly toggled follow OFF for this selection
  var _followPrev = new THREE.Vector3();
  // Single mutation point for follow state: keeps the Follow button label in
  // sync wherever tracking starts or stops.
  function setFollow(vid, slot) {
    followVId = vid || null;
    // Camera memory: follow engaged under a held snapshot marks the
    // session follow-owned; follow ending with no card showing drops a
    // follow-owned snapshot unrestored (see the camera-memory block).
    if (followVId) { if (camMem) camMem.followOwned = true; }
    else if (camMem && camMem.followOwned && !visibleSurface()) camMem = null;
    // Cursor-anchored zoom re-anchors the orbit target to the cursor ray on
    // every wheel tick, which fights followTick's bus-anchored target and
    // teleports the camera off the bus. Track-centered zoom while following.
    if (typeof controls !== 'undefined') controls.zoomToCursor = !followVId;
    if (followVId && slot) _followPrev.set(slot.x, 0, slot.z);
    refreshFollowBtn();
  }
  function followTick() {
    if (!followVId) return;
    var sl = null;
    for (var i = 0; i < busSlots.length; i++) {
      if (busSlots[i].vehicle && busSlots[i].vehicle.vehicle_id === followVId) { sl = busSlots[i]; break; }
    }
    // Candidate C3: the followed bus is the boarded vehicle of an
    // active ride and its route is gate-hidden — follow continues
    // against the shadow slot. The ride session owns this camera;
    // a plain selection gets no such exemption and stops below.
    if (!sl && rideShadowSlot && rideWidget && rideWidget.currentVehicleId === followVId &&
        rideShadowSlot.vehicle && rideShadowSlot.vehicle.vehicle_id === followVId) {
      sl = rideShadowSlot;
    }
    if (!sl) { setFollow(null); return; } // bus left the visible set: stop
    if (streetTween || (typeof tripFly !== 'undefined' && tripFly)) {
      _followPrev.set(sl.x, 0, sl.z); // a glide owns the camera: keep the seed fresh
      return;
    }
    var dx = sl.x - _followPrev.x, dz = sl.z - _followPrev.z;
    if (dx || dz) {
      camera.position.x += dx; camera.position.z += dz;
      controls.target.x += dx; controls.target.z += dz;
      _followPrev.set(sl.x, 0, sl.z);
    }
  }
  /* === DIRECTION C — ONE SURFACE AT A TIME (mutual exclusion) =========
     The stop card, bus card, trip card, ride card, routes panel and
     browse panel share one screen slot. Opening any of them covers
     whichever is open; closing the covering surface restores the covered
     one. Covering hides the element ONLY — selection and mode state are
     never cleared by exclusion, so the covered surface returns exactly
     as it was (the stop card you were reading is still there when the
     Routes panel closes). Hard closes keep their existing semantics and
     live in the surfaces' own close paths (hideBus / hideStop /
     setTripMode(false) / setRideMode(false) / togglePanel(false) /
     setBrowse(false)); each of those calls exclRestore() when it
     finishes. The one deliberate exception: stop taps while the trip
     planner is open are planner inputs (tripStopTapped) and never open
     the stop card over the planner. ================================ */
  var _coveredStack = []; // surface names hidden by exclusion, state intact
  var _exclBusy = false;   // reentrancy guard while exclusion wiring runs
  function _surfaceElId(name) {
    return name === 'filter' ? 'filter-panel'
      : name === 'browse' ? 'browse-panel' : name + '-card';
  }
  function visibleSurface() {
    var names = ['stop', 'bus', 'trip', 'ride', 'filter', 'browse', 'route'];
    for (var i = 0; i < names.length; i++) {
      var el = $(_surfaceElId(names[i]));
      if (el && !el.hidden) return names[i];
    }
    return null;
  }
  function _hideSurfaceEl(name) {
    var el = $(_surfaceElId(name));
    if (el) el.hidden = true;
    if (name === 'filter') $('filter-btn').setAttribute('aria-expanded', 'false');
    if (name === 'browse') $('browse-toggle').setAttribute('aria-expanded', 'false');
  }
  function _showSurfaceEl(name) {
    var el = $(_surfaceElId(name));
    if (el) el.hidden = false;
    if (name === 'filter') $('filter-btn').setAttribute('aria-expanded', 'true');
    if (name === 'browse') $('browse-toggle').setAttribute('aria-expanded', 'true');
  }
  function _surfaceStillValid(name) {
    if (name === 'stop') return !!selectedStop;
    if (name === 'bus') return !!selectedVehicleId;
    if (name === 'trip') return typeof tripMode !== 'undefined' && !!tripMode;
    if (name === 'ride') return !!rideMode;
    if (name === 'route') return !!selectedRoute;
    return false;
  }
  // Called at the top of every surface's own open path (the opener then
  // unhides itself). Closes panels outright, hard-closes the other mode
  // when a mode opens, and covers any card with its state intact.
  function exclCover(name) {
    // First-view sheet: any exclusion surface opening occludes the
    // launcher (transiently — the rider's persisted open/collapsed
    // preference is untouched; exclRestore un-occludes).
    fvSetOccluded(true);
    _coveredStack = _coveredStack.filter(function (n) { return n !== name; });
    var cur = visibleSurface();
    if (!cur || cur === name) return;
    _exclBusy = true;
    try {
      if (cur === 'filter') togglePanel(false);
      else if (cur === 'browse') setBrowse(false);
      else if ((cur === 'trip' || cur === 'ride') && (name === 'trip' || name === 'ride')) {
        // Planner Bus Focus (project 9): a leg tap opens the ride
        // tile OVER the planner. The plan is the rider's working
        // state and the focus is a look at one of its legs, so while
        // focusCoverArmed the trip card takes the cover path (state
        // intact, restored on tile close) instead of the hard close
        // an ordinary mode switch performs.
        if (cur === 'trip' && name === 'ride' && focusCoverArmed) {
          _hideSurfaceEl(cur);
          _coveredStack.push(cur);
        }
        else if (cur === 'trip') setTripMode(false); else setRideMode(false);
      } else {
        _hideSurfaceEl(cur);
        _coveredStack.push(cur);
      }
    } finally { _exclBusy = false; }
  }
  // Called at the end of every surface's own close path: if nothing is
  // showing, bring back the most recently covered surface whose state is
  // still live. Entries whose state was hard-cleared meanwhile are
  // dropped silently.
  function exclRestore() {
    if (_exclBusy) return;
    if (visibleSurface()) return;
    while (_coveredStack.length) {
      var name = _coveredStack.pop();
      if (!_surfaceStillValid(name)) continue;
      _showSurfaceEl(name);
      if (name === 'stop' && typeof renderStopLive === 'function') renderStopLive();
      return;
    }
    fvSetOccluded(false);
    camMemOnSettled();
  }

  var _busReturnFocus = null;
  var _stopReturnFocus = null;
  // === POSITION INTEGRITY — FIX AGE (project 6, item 1) ===================
  // Principle (files/position-integrity/analysis-2026-10-16.md §2): a
  // rendered position is a claim with an age. The slot's tracker already
  // anchors the fix's own instant (fixObsT, project 12), so the age below
  // is computed from the same anchor the prediction loop uses — one age,
  // every surface. Classes: FRESH < 75 s; AGING 75–150 s; STALE > 150 s
  // (PREDICT_HORIZON_S — past it the marker no longer advances on this
  // fix). Item 1 surfaces the age on the bus cards only; the marker's
  // stale treatment is item 2, which consumes fixAgeClass/fixAgeOfSlot.
  // S6 discipline, mirroring the SMART freshness graft: the age is text,
  // never appearance alone; where the source carries no measured fix
  // time there is no age claim at all (the line hides rather than read
  // "0 s old"). Format follows the filed examples: "fix 20 s old",
  // "fix 10 min old — 3:50 PM" — the fix's clock time joins the sentence
  // once the fix is STALE, and rides the stale chip as well.
  function fixAgeClass(ageS) {
    if (ageS > 150) return 'stale';
    if (ageS >= 75) return 'aging';
    return 'fresh';
  }
  function fixAgeOfSlot(slot, nowPerfMs, nowWallMs) {
    if (!slot || !slot.tracker || !slot.vehicle) return null;
    var stampMs = slot.vehicle.updated_at ? new Date(slot.vehicle.updated_at).getTime() : NaN;
    if (isNaN(stampMs)) return null; // no measured fix time: no age claim (S6)
    var tr = slot.tracker;
    var fixPerf = (tr.fixObsT != null ? tr.fixObsT : tr.fixT);
    if (!fixPerf) return null;
    var ageMs = Math.max(0, nowPerfMs - fixPerf);
    var ageS = ageMs / 1000;
    return { ageS: ageS, cls: fixAgeClass(ageS), fixWallMs: nowWallMs - ageMs };
  }
  function formatFixAge(ageS, fixWallMs) {
    var s = Math.max(0, ageS);
    var txt;
    if (s < 59.5) {
      txt = 'fix ' + Math.round(s) + ' s old';
    } else {
      var rm = Math.round(s / 60);
      if (rm < 60) {
        txt = 'fix ' + rm + ' min old';
      } else {
        var hh = Math.floor(rm / 60), mm = rm - hh * 60;
        txt = 'fix ' + hh + ' h' + (mm ? ' ' + mm + ' min' : '') + ' old';
      }
    }
    if (s > 150 && fixWallMs) txt += ' \u2014 ' + formatClock12(fixWallMs);
    return txt;
  }
  // Re-renders the open bus card's fix-age line (and, when the fix is
  // STALE, its stale chip) from the selected bus's slot. Called on
  // selection, on every poll, and on the 30 s between-polls tick that
  // mirrors the stop card's — a rider watching the card watches the
  // claim age in real time.
  function refreshBusFixAge() {
    var line = $('bus-fixline');
    if (!line) return;
    var info = null;
    if (selectedVehicleId) {
      var sl = null;
      for (var i = 0; i < busSlots.length; i++) {
        if (busSlots[i].vehicle && busSlots[i].vehicle.vehicle_id === selectedVehicleId) { sl = busSlots[i]; break; }
      }
      if (!sl && rideShadowSlot && rideShadowSlot.vehicle && rideShadowSlot.vehicle.vehicle_id === selectedVehicleId) sl = rideShadowSlot;
      if (sl) info = fixAgeOfSlot(sl, performance.now(), Date.now());
    }
    if (!info) { line.hidden = true; return; }
    line.hidden = false;
    line.className = 'bus-fixline ' + info.cls;
    $('bus-fix-age').textContent = formatFixAge(info.ageS, info.fixWallMs);
    var chip = $('bus-stale-chip');
    if (info.cls === 'stale') {
      chip.hidden = false;
      chip.textContent = 'Stale fix \u2014 ' + formatClock12(info.fixWallMs);
    } else {
      chip.hidden = true;
    }
  }
  function showBus(v) {
    if (!v) return;
    camMemTake();
    exclCover('bus');
    var isReselect = (v.vehicle_id === selectedVehicleId);
    tapBuzz();
    // Return (project 11): a selection that boards in the ride
    // widget replaces the tile's state — capture that state before
    // the selection (and everything it drives) mutates.
    if (rideMode && rideWidget && v.vehicle_id !== rideWidget.currentVehicleId) {
      _tilePushPre = captureTileState();
    }
    selectedVehicleId = v.vehicle_id;
    renderBusInstances(); // expand the selected indicator
    var sn = v.route_id;
    var dest = displayDest(v);
    var chipBg = routeColors[sn] ? '#' + routeColors[sn].getHexString() : '#F2F2F2';
    $('bus-chip').style.background = chipBg;
    var chipC = $('bus-chip-c'); // compact bar (staging Phase 2 HTML); guard for HTML without it
    if (chipC) chipC.style.background = chipBg;
    var compactTitle = routeLabel(sn) + (dest ? ' → ' + dest : '');
    $('bus-title').textContent = compactTitle;
    var cTitle = $('bus-compact-title');
    if (cTitle) cTitle.textContent = compactTitle;
    var cId = $('bus-compact-id');
    if (cId) cId.textContent = 'Vehicle ' + (v.vehicle_id || '–');
    $('bus-id').textContent = v.vehicle_id || '–';
    $('bus-dest').textContent = dest || '–';
    $('bus-speed').textContent = (v.speed_mph != null && !isNaN(v.speed_mph)) ? Math.round(v.speed_mph) + ' mph' : '–';
    $('bus-heading').textContent = compass(v.bearing);
    var fi = fleetLookup(v.vehicle_id);
    $('bus-model').textContent = fi.model + ' · ' + fi.detail;
    $('bus-cap').textContent = (fi.seats != null ? fi.seats + ' seats · ' : '') + fi.length_m.toFixed(1) + ' m long';
    var when = v.updated_at ? new Date(v.updated_at) : null;
    $('bus-card-updated').textContent = (when && !isNaN(when)) ? when.toLocaleTimeString() : '–';
    $('bus-card').hidden = false;
    refreshBusFixAge(); // Position Integrity item 1: the card opens with its fix age stated
    // Ride Along: while ride mode is on, a bus selection from any surface
    // (map tap, Browse list, arrow keys — all funnel through showBus)
    // boards that bus in the widget, so the rider's-seat view follows the
    // selection instead of waiting for the card's own dropdown.
    var rideBoarded = false;
    if (rideMode && rideWidget) rideBoarded = boardRideBus(v.vehicle_id, false);
    // Dialog focus: remember the opener only on a fresh open, then move
    // focus into the card. Arrow-key cycling re-enters showBus with the
    // card already focused, so the original opener is preserved.
    if (_busReturnFocus === null && document.activeElement && !$('bus-card').contains(document.activeElement)) _busReturnFocus = document.activeElement;
    $('bus-card').focus();
    announceSr('Bus details opened. ' + compactTitle + '. Vehicle ' + (v.vehicle_id || 'unknown') + '.');
    // D1a: on mobile the card opens as a compact route/vehicle bar; tap to expand.
    setBusCardCompact(DisplayBounds.get().deviceClass === 'mobile');
    refreshBusInfo(); // in-scene label beside the bus
    if (typeof renderBetaTiles === 'function') renderBetaTiles();
    // After-touch transition: one engine path frames the bus at the
    // safe-frame center (not the viewport center), so the card never covers
    // it. D2b: on mobile the selection frames and holds; the explicit Follow
    // button starts tracking. Desktop keeps the existing auto-follow.
    if (typeof tripFly === 'undefined' || !tripFly) {
      var _bs = null;
      for (var _bi = 0; _bi < busSlots.length; _bi++) {
        if (busSlots[_bi].vehicle && busSlots[_bi].vehicle.vehicle_id === v.vehicle_id) { _bs = busSlots[_bi]; break; }
      }
      if (_bs) {
        TransitionEngine.go({
          vantage: TransitionEngine.vantageForBus(_bs.x, _bs.z),
          // A bus boarded for Ride Along is an explicit ride intent: the
          // camera centers on it and follow engages on every device class
          // (overriding the mobile hold), unless the rider explicitly
          // toggled follow OFF for this same selection.
          follow: (rideBoarded && !(isReselect && followSuppressed)) ? 'engage'
            : (isReselect && followSuppressed) ? 'hold'
            : (DisplayBounds.get().deviceClass === 'mobile' ? 'hold' : 'engage'),
          vehicleId: v.vehicle_id,
          slot: _bs
        });
      }
    } else if (rideBoarded) {
      // The trip cinematic owns the camera right now; followTick defers to
      // it frame-by-frame, so engaging follow here is safe and takes over
      // framing when the fly-through ends.
      var _fs = null;
      for (var _fi = 0; _fi < busSlots.length; _fi++) {
        if (busSlots[_fi].vehicle && busSlots[_fi].vehicle.vehicle_id === v.vehicle_id) { _fs = busSlots[_fi]; break; }
      }
      if (_fs) setFollow(v.vehicle_id, _fs);
    }
  }
  function hideBus() {
    var _hadFocus = $('bus-card').contains(document.activeElement);
    selectedVehicleId = null;
    ridePendingVid = null;
    followSuppressed = false;
    setFollow(null); // stop tracking
    $('bus-card').hidden = true;
    // Return focus to the opener when focus was inside the dialog.
    if (_hadFocus && _busReturnFocus && _busReturnFocus !== document.body && document.contains(_busReturnFocus)) _busReturnFocus.focus();
    _busReturnFocus = null;
    busInfoSprite.visible = false;
    renderBusInstances(); // shrink the indicator back
    exclRestore();
  }
  $('bus-close').addEventListener('click', hideBus);
  $('bus-card').addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); hideBus(); } });
  // Product Defect Reconciliation, candidate C1: the bus card
  // obeys the same gate as the vehicles layer it presents.
  // applyFilters — the single reconciliation entry — calls this
  // after the rebuild: when the selected vehicle's route closes
  // (chip or group toggle, near-me, hide-idle), the card
  // reconciles away through hideBus, exactly as rebuildStops
  // closes the stop card in the same pass. Poll absence alone
  // never closes it — the vehicle must be unpresentable because
  // its ROUTE is gate-closed — so selection persistence across
  // polls (the 1542 behavior) holds while the route is shown.
  function reconcileBusCard() {
    if (!selectedVehicleId || !lastVehicles) return;
    for (var i = 0; i < lastVehicles.length; i++) {
      if (lastVehicles[i].vehicle_id === selectedVehicleId) {
        if (routeShown(lastVehicles[i].route_id)) return;
        var vid = selectedVehicleId;
        hideBus();
        // The card is presentation and closes; an active RIDE on
        // this bus is a session (candidate C3) — hideBus stopped
        // the selection's follow, so re-engage the ride's follow
        // against the shadow slot the same pass maintained.
        if (rideMode && rideWidget && rideWidget.currentVehicleId === vid && rideShadowSlot) {
          setFollow(vid, rideShadowSlot);
        }
        return;
      }
    }
  }
  // --- D1a compact bar + D2b Follow button ---------------------------------
  // On mobile the bus card opens collapsed to a route/vehicle bar; tapping
  // the bar expands the full details. The Follow button toggles tracking on
  // every device class (on mobile it is the only way tracking starts).
  function setBusCardCompact(compact) {
    $('bus-card').classList.toggle('compact', !!compact);
  }
  var _followBtnLabel = null;
  function refreshFollowBtn() {
    var label = followVId ? 'Following' : 'Follow';
    if (label === _followBtnLabel) return;
    _followBtnLabel = label;
    var btns = document.querySelectorAll('.bus-follow-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].textContent = label;
      btns[i].setAttribute('aria-pressed', followVId ? 'true' : 'false');
    }
  }
  function toggleFollow() {
    if (followVId) { setFollow(null); followSuppressed = true; return; }
    followSuppressed = false;
    var sl = null;
    for (var i = 0; i < busSlots.length; i++) {
      if (busSlots[i].vehicle && busSlots[i].vehicle.vehicle_id === selectedVehicleId) { sl = busSlots[i]; break; }
    }
    if (sl) setFollow(selectedVehicleId, sl);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.bus-follow-btn'), function (b) {
    b.addEventListener('click', toggleFollow);
  });
  var _busExpand = $('bus-expand'); // compact bar (staging Phase 2 HTML); guard for HTML without it
  if (_busExpand) _busExpand.addEventListener('click', function () { setBusCardCompact(false); });

  // --- Accessible browse panel: list-based alternative to canvas tapping ---
  // Every tappable 3D object (stop pylon, bus pillar) is also reachable as a
  // real <button> with a 44px minimum target, keyboard-focusable and
  // screen-reader labeled. Selection flows through the same showStop/showBus
  // paths as canvas taps, so behavior is identical.
  var browseBusIds = '';
  function setBrowse(open) {
    var p = $('browse-panel'); if (!p) return;
    var wasOpen = !p.hidden;
    if (open && !wasOpen) exclCover('browse');
    p.hidden = !open;
    $('browse-toggle').setAttribute('aria-expanded', String(open));
    if (open) {
      togglePanel(false); // mutually exclusive with the routes panel
      buildBrowseStops();
      refreshBrowseBuses(true);
      // Move focus into the dialog so keyboard users land on the tabs.
      var selTab = document.querySelector('#browse-panel .browse-tabs [aria-selected="true"]');
      (selTab || $('browse-tab-buses')).focus();
    } else if (p.contains(document.activeElement)) {
      $('browse-toggle').focus(); // return focus to the toggle on close
    }
    if (!open && wasOpen) exclRestore();
  }
  $('browse-toggle').addEventListener('click', function () {
    setBrowse($('browse-panel').hidden);
  });
  $('browse-close').addEventListener('click', function () { setBrowse(false); });
  function browseTab(which) {
    var tabs = { buses: $('browse-tab-buses'), stops: $('browse-tab-stops'), passes: $('browse-tab-passes') };
    var panes = { buses: $('browse-buses-pane'), stops: $('browse-stops-pane'), passes: $('browse-passes-pane') };
    Object.keys(tabs).forEach(function (k) {
      var on = k === which;
      tabs[k].setAttribute('aria-selected', String(on));
      tabs[k].tabIndex = on ? 0 : -1;
      panes[k].hidden = !on;
    });
    if (which === 'buses') refreshBrowseBuses(true);
  }
  // Passes (project 24 deep-link floor): open the browse panel on the
  // Passes tab — the hand-off surface the trip-detail line points at.
  function openPasses() {
    setBrowse(true);
    browseTab('passes');
  }
  $('browse-tab-stops').addEventListener('click', function () { browseTab('stops'); });
  $('browse-tab-buses').addEventListener('click', function () { browseTab('buses'); });
  $('browse-tab-passes').addEventListener('click', function () { browseTab('passes'); });
  // WAI-ARIA tab keyboard support: Arrow keys / Home / End move focus between
  // tabs with automatic activation. Roving tabindex keeps the inactive tab out
  // of the Tab order, so the arrow keys are its only keyboard path.
  document.querySelector('#browse-panel .browse-tabs').addEventListener('keydown', function (e) {
    var tabs = [$('browse-tab-buses'), $('browse-tab-stops'), $('browse-tab-passes')];
    var i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    var j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j === null || j === i) return;
    e.preventDefault();
    tabs[j].focus();
    browseTab(tabs[j].id.replace('browse-tab-', ''));
  });
  function browseStopRow(st) {
    var li = document.createElement('li');
    var b = document.createElement('button');
    var n = (st.r || []).length;
    b.setAttribute('aria-label', 'Stop ' + (st.n || 'unnamed') + ', served by ' + n + (n === 1 ? ' route' : ' routes'));
    var dot = document.createElement('i'); dot.className = 'b-dot';
    var rc = routeColors[(st.r || [])[0]];
    dot.style.background = rc ? '#' + rc.getHexString() : '#9F9F9F';
    var main = document.createElement('span'); main.className = 'b-main';
    var name = document.createElement('b'); name.textContent = st.n || 'Stop';
    var sub = document.createElement('span');
    sub.textContent = n + (n === 1 ? ' route' : ' routes') + (st.id ? ' · ID ' + st.id : '');
    main.appendChild(name); main.appendChild(sub);
    if (typeof alertsForStop === 'function' && typeof alertFx === 'function' && alertsState.ok) {
      var mine = alertsForStop(st.id);
      var pool = mine;
      if (!pool.length) {
        pool = [];
        (st.r || []).forEach(function (r) { alertsForRoute(r).forEach(function (a) { pool.push(a); }); });
      }
      if (pool.length) {
        var wEff = alertWorstEffect(pool);
        var wFx = alertFx({ effect: wEff });
        var sAdv = document.createElement('span');
        sAdv.className = 'b-adv' + (wEff === 'NO_SERVICE' ? ' severe' : '');
        sAdv.textContent = wFx.glyph + ' ' + wFx.label.toLowerCase() + (mine.length ? ' at this stop' : ' on a serving route');
        main.appendChild(sAdv);
      }
    }
    b.appendChild(dot); b.appendChild(main);
    b.addEventListener('click', function () { setBrowse(false); showStop(st); });
    li.appendChild(b);
    return li;
  }
  function buildBrowseStops() {
    var list = $('browse-stop-list'); if (!list) return;
    var q = ($('browse-stop-search').value || '').toLowerCase();
    var all = (typeof stopPickList !== 'undefined' && stopPickList) || [];
    var stops = all.slice().sort(function (a, b) { return (a.n || '').localeCompare(b.n || ''); });
    if (q) stops = stops.filter(function (st) { return (st.n || '').toLowerCase().indexOf(q) >= 0; });
    list.innerHTML = '';
    if (!stops.length) {
      var li = document.createElement('li');
      li.className = 'browse-empty';
      li.textContent = all.length ? 'No stops match.' : 'Stops still loading…';
      list.appendChild(li); return;
    }
    stops.slice(0, 200).forEach(function (st) { list.appendChild(browseStopRow(st)); });
    if (stops.length > 200) {
      var more = document.createElement('li'); more.className = 'browse-empty';
      more.textContent = 'Showing 200 of ' + stops.length + ' — refine your search.';
      list.appendChild(more);
    }
  }
  $('browse-stop-search').addEventListener('input', buildBrowseStops);
  function browseBusRow(slot) {
    var v = slot.vehicle;
    var li = document.createElement('li');
    var b = document.createElement('button');
    var dest = displayDest(v);
    b.setAttribute('aria-label', 'Bus ' + (v.vehicle_id || '') + ', ' + routeLabel(v.route_id) + (dest ? ', to ' + dest : ''));
    var dot = document.createElement('i'); dot.className = 'b-dot';
    var rc = routeColors[v.route_id];
    dot.style.background = rc ? '#' + rc.getHexString() : '#F2F2F2';
    var main = document.createElement('span'); main.className = 'b-main';
    var name = document.createElement('b');
    name.textContent = routeLabel(v.route_id) + ' · Bus ' + (v.vehicle_id || '');
    var sub = document.createElement('span');
    sub.textContent = dest ? 'to ' + dest : (routeNames[v.route_id] || 'DDOT');
    main.appendChild(name); main.appendChild(sub);
    if (typeof alertsForRoute === 'function' && typeof alertFx === 'function' && alertsState.ok && alertsForRoute(v.route_id).length) {
      var rList = alertsForRoute(v.route_id);
      var rEff = alertWorstEffect(rList);
      var rFx = alertFx({ effect: rEff });
      var bAdv = document.createElement('span');
      bAdv.className = 'b-adv' + (rEff === 'NO_SERVICE' ? ' severe' : '');
      bAdv.textContent = rFx.glyph + ' ' + rFx.label.toLowerCase() + ' on this route';
      main.appendChild(bAdv);
    }
    b.appendChild(dot); b.appendChild(main);
    b.addEventListener('click', function () { setBrowse(false); showBus(v); });
    li.appendChild(b);
    return li;
  }
  function refreshBrowseBuses(force) {
    var list = $('browse-bus-list'); if (!list) return;
    var q = ($('browse-bus-search').value || '').toLowerCase();
    var slots = busSlots;
    if (q) slots = slots.filter(function (s) {
      var v = s.vehicle;
      var hay = (v.route_id + ' ' + (v.vehicle_id || '') + ' ' + (routeNames[v.route_id] || '') + ' ' + (displayDest(v) || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    var ids = slots.map(function (s) { return s.vehicle.vehicle_id; }).join(',');
    if (!force && ids === browseBusIds && !q) return; // no change: keep focus/scroll
    browseBusIds = q ? '' : ids; // searching bypasses the change cache
    var n = slots.length;
    $('browse-bus-count').textContent = n ? '(' + n + ')' : '';
    list.innerHTML = '';
    if (!n) {
      var li = document.createElement('li'); li.className = 'browse-empty';
      li.textContent = q ? 'No buses match.' : 'No buses on the visible routes right now.';
      list.appendChild(li); return;
    }
    // Numerical order: routes ascending numerically, then vehicle numbers
    // ascending numerically (lexicographic fallback for non-numeric ids).
    function numKey(x) { var n = parseInt(x, 10); return isNaN(n) ? null : n; }
    slots.slice().sort(function (a, b) {
      // Route lists sort alphabetically by route name (convention,
      // settled 2026-10-11): "Greenfield - 10" files under G, ahead
      // of "Vernor - 1"; vehicles within a route stay numeric below.
      var rc = routeLabel(a.vehicle.route_id).localeCompare(routeLabel(b.vehicle.route_id));
      if (rc !== 0) return rc;
      var av = numKey(a.vehicle.vehicle_id), bv = numKey(b.vehicle.vehicle_id);
      if (av !== null && bv !== null && av !== bv) return av - bv;
      return String(a.vehicle.vehicle_id).localeCompare(String(b.vehicle.vehicle_id));
    }).forEach(function (s) { list.appendChild(browseBusRow(s)); });
  }
  $('browse-bus-search').addEventListener('input', function () { refreshBrowseBuses(true); });

  // --- map navigation tools ----------------------------------------------------
  function zoomStep(dir) {
    if (typeof noteZoomStep === 'function') noteZoomStep();
    var off = camera.position.clone().sub(controls.target);
    var len = off.length() * (dir > 0 ? 0.8 : 1.25);
    len = Math.max(controls.minDistance, Math.min(controls.maxDistance, len));
    off.setLength(len);
    camera.position.copy(controls.target).add(off);
  }
  // Anchored dolly (project 28): the ground point under a screen
  // position, from the same raycaster the pick machinery uses,
  // intersected with the ground plane. Null when the ray runs parallel
  // to the ground or the intersection falls behind the camera.
  function screenGroundPoint(cx, cy) {
    var r = renderer.domElement.getBoundingClientRect();
    pointerNDC.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointerNDC, camera);
    var o = raycaster.ray.origin, d = raycaster.ray.direction;
    if (Math.abs(d.y) < 1e-9) return null;
    var t = -o.y / d.y;
    if (!(t > 0)) return null;
    return new THREE.Vector3(o.x + d.x * t, 0, o.z + d.z * t);
  }
  // Dolly by factor (< 1 in, > 1 out) holding the ground point under
  // (cx, cy) fixed on screen — the zoomToCursor anchoring OrbitControls
  // gives the wheel path, extended to the gesture bridge and the
  // double-click step. Distance clamps match zoomStep. With no usable
  // anchor the dolly falls back to the orbit target (a plain dolly).
  function dollyAroundPoint(cx, cy, factor) {
    var dist = camera.position.distanceTo(controls.target);
    if (!(dist > 0) || !(factor > 0) || factor === 1) return;
    var nd = Math.max(controls.minDistance, Math.min(controls.maxDistance, dist * factor));
    var f = nd / dist;
    if (f === 1) return;
    var p = (typeof cx === 'number' && typeof cy === 'number') ? screenGroundPoint(cx, cy) : null;
    if (!p) p = controls.target;
    camera.position.sub(p).multiplyScalar(f).add(p);
    if (p !== controls.target) controls.target.sub(p).multiplyScalar(f).add(p);
    if (typeof controls.update === 'function') controls.update();
  }
  // Keyboard tilt (project 28, C-10): rotate the camera offset around
  // the horizontal axis through the orbit target by one 6-degree step,
  // clamped to the polar range OrbitControls enforces. dir > 0 (PageUp)
  // raises the camera toward overhead; dir < 0 (PageDown) lowers it
  // toward the horizon.
  function tiltStep(dir) {
    var off = camera.position.clone().sub(controls.target);
    var len = off.length();
    if (!(len > 0)) return;
    var polar = Math.acos(Math.max(-1, Math.min(1, off.y / len)));
    var want = polar + (dir > 0 ? -1 : 1) * (Math.PI / 30);
    want = Math.max(0.1, Math.min(controls.maxPolarAngle, want));
    if (Math.abs(want - polar) < 1e-9) return;
    var fwd = new THREE.Vector3(-off.x, 0, -off.z);
    if (fwd.lengthSq() === 0) return;
    fwd.normalize();
    var right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    off.applyAxisAngle(right, want - polar);
    camera.position.copy(controls.target).add(off);
    if (typeof controls.update === 'function') controls.update();
  }
  function resetView() {
    cancelStreetTween();
    camera.position.copy(homePos);
    controls.target.copy(homeTarget);
    camMemRefresh();
  }
  $('zoom-in').addEventListener('click', function () { zoomStep(1); });
  $('zoom-out').addEventListener('click', function () { zoomStep(-1); });
  $('view-reset').addEventListener('click', resetView);
  // Double-click / double-tap zoom (project 28, P-7): one anchored step
  // at the pointer, the 0.8 / 1.25 factors of the rail buttons (Shift = out).
  // A double-tap that lands on anything pickable is a pick, not a zoom —
  // the pointerup handler has already resolved it through the contested
  // arbitration — so the zoom stands down wherever the pick machinery
  // finds a candidate at the point (the wider touch aim radii as the
  // net, for every pointer type).
  renderer.domElement.addEventListener('dblclick', function (e) {
    if (tapHitsBusInfo(e.clientX, e.clientY)) return;
    if (pickTopHit(e.clientX, e.clientY)) return;
    var r = renderer.domElement.getBoundingClientRect();
    if (pickNearestScreenD(e.clientX, e.clientY, r, 48)) return;
    if (pickStopScreenD(e.clientX, e.clientY, r, 44)) return;
    if (pickRouteLabel(e.clientX, e.clientY, true) || pickRouteLine(e.clientX, e.clientY, true)) return;
    dollyAroundPoint(e.clientX, e.clientY, e.shiftKey ? 1.25 : 0.8);
    e.preventDefault();
  });
  // Keyboard camera (defect keyboard-camera): arrow keys pan and +/-
  // zoom when #live-map has focus (tabindex="0" in the HTML; the canvas
  // is its only child, so keydown events from the map reach this listener
  // and events from overlay controls, which are siblings, do not).
  // ArrowLeft/ArrowRight yield to the existing bus/stop cycling handler
  // (the document keydown handler below) while a card selection is
  // active, so the two bindings never act on the same keypress.
  container.addEventListener('keydown', function (e) {
    if (e.key === '+' || e.key === '=') { zoomStep(1); e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === '-' || e.key === '_') { zoomStep(-1); e.preventDefault(); e.stopPropagation(); return; }
    // Tilt and reset keys (project 28, C-10/C-13): PageUp/PageDown tilt,
    // Home is Reset view (the rail control), under the same focus gate as every camera
    // key here. iPad hardware keyboards reach all three via Fn + arrows.
    if (e.key === 'PageUp') { tiltStep(1); e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'PageDown') { tiltStep(-1); e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'Home') { resetView(); e.preventDefault(); e.stopPropagation(); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (selectedVehicleId || selectedStop)) return;
    var dist = camera.position.distanceTo(controls.target);
    var step = Math.max(50, dist * 0.12);
    var fwd = new THREE.Vector3();
    fwd.subVectors(controls.target, camera.position); fwd.y = 0;
    if (fwd.lengthSq() === 0) return;
    fwd.normalize();
    var right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    var move = new THREE.Vector3();
    if (e.key === 'ArrowUp') move.addScaledVector(fwd, step);
    else if (e.key === 'ArrowDown') move.addScaledVector(fwd, -step);
    else if (e.key === 'ArrowRight') move.addScaledVector(right, step);
    else move.addScaledVector(right, -step);
    camera.position.add(move);
    controls.target.add(move);
    if (typeof controls.update === 'function') controls.update();
    e.preventDefault();
    e.stopPropagation();
  });
  if (isTouch) {
    var hint = document.querySelector('.map-hint');
    if (hint) {
      hint.innerHTML = 'drag&nbsp;·&nbsp;move&nbsp;&nbsp;&nbsp;pinch&nbsp;·&nbsp;zoom&nbsp;&nbsp;&nbsp;tap bus or stop&nbsp;·&nbsp;details';
      hint.classList.add('touch');
    }
  }

  // --- navigation tutorial overlay ---------------------------------------------
  var ICO_FINDME = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
  var ICO_FULL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
  var NAV_STEPS_TOUCH = [
    ['\u2194', 'Drag', 'Move around the city. The map is a true-scale 3D model of Detroit — every street, every route corridor, every stop is where it actually is.'],
    ['+', 'Pinch', 'Zoom in and out. Zoom close enough and the glowing pillars resolve into true-scale 3D bus models with windows and wheels.'],
    ['\u27F3', 'Two-finger twist', 'Rotate the view. Tilt to see the elevated route guideways — each route floats at its own height so crossings read as clean overpasses.'],
    ['\u25CF', 'Tap a bus', 'Opens the bus card: vehicle number, route, destination, speed, heading, and how fresh the position reading is. Tap Follow to track it.'],
    ['\u25A0', 'Bus badges', 'Each bus carries a bus-shaped badge showing its route number, bordered in the route\u2019s color. Badges declutter automatically when buses cluster.'],
    ['\u29E9', 'Routes', 'Filter by group (DDOT, SMART, QLINE, People Mover) or individual route. Routes with no live buses are dimmed or hidden automatically.'],
    ['\u25C8', 'Plan trip', 'Enter two points and get a transit itinerary with real routes, transfers, and walking legs — built on the same schedule data as the map.'],
    ['\u25C9', 'Ride along', 'Pick any live bus and see its upcoming stops from the rider\u2019s seat, ordered by travel direction. If a bus is already selected it rides that bus; selecting a bus on the map while Ride along is open rides it too, and the camera follows it.'],
    [ICO_FINDME, 'Find me', 'Center the map on your location. "Routes near me" then shows only routes with a stop within 1,250 m of you.'],
    [ICO_FULL, 'Fullscreen', 'Fill the screen with the map.'],
    ['\u2328', 'Keyboard', 'Click the map to focus it, then: arrow keys move, + / \u2212 zoom, Page Up / Page Down tilt, Home resets the view. While a bus or stop card is open, Left / Right cycle buses and stops instead.'],
    ['\u2302', 'Reset view', 'Return to the full-system view.']
  ];
  var NAV_STEPS_DESK = [
    ['\u27F3', 'Drag', 'Orbit the view. The map is a true-scale 3D model of Detroit — every street, every route corridor, every stop is where it actually is.'],
    ['+', 'Scroll', 'Zoom in and out. Zoom close enough and the glowing pillars resolve into true-scale 3D bus models with windows and wheels.'],
    ['\u2194', 'Right-drag', 'Pan across the city. Tilt to see the elevated route guideways — each route floats at its own height so crossings read as clean overpasses.'],
    ['\u25CF', 'Click a bus', 'Opens the bus card: vehicle number, route, destination, speed, heading, and how fresh the position reading is. Click Follow to track it.'],
    ['\u25A0', 'Bus badges', 'Each bus carries a bus-shaped badge showing its route number, bordered in the route\u2019s color. Badges declutter automatically when buses cluster.'],
    ['\u29E9', 'Routes', 'Filter by group (DDOT, SMART, QLINE, People Mover) or individual route. Routes with no live buses are dimmed or hidden automatically.'],
    ['\u25C8', 'Plan trip', 'Enter two points and get a transit itinerary with real routes, transfers, and walking legs — built on the same schedule data as the map.'],
    ['\u25C9', 'Ride along', 'Pick any live bus and see its upcoming stops from the rider\u2019s seat, ordered by travel direction. If a bus is already selected it rides that bus; selecting a bus on the map while Ride along is open rides it too, and the camera follows it.'],
    [ICO_FINDME, 'Find me', 'Center the map on your location. "Routes near me" then shows only routes with a stop within 1,250 m of you.'],
    [ICO_FULL, 'Fullscreen', 'Fill the screen with the map.'],
    ['\u2328', 'Keyboard', 'Click the map to focus it, then: arrow keys move, + / \u2212 zoom, Page Up / Page Down tilt, Home resets the view. While a bus or stop card is open, Left / Right cycle buses and stops instead.'],
    ['\u2302', 'Reset view', 'Return to the full-system view.']
  ];
  function buildNavOverlay() {
    var host = $('nav-steps');
    host.innerHTML = '';
    (isTouch ? NAV_STEPS_TOUCH : NAV_STEPS_DESK).forEach(function (s) {
      var d = document.createElement('div');
      d.className = 'nav-step';
      d.innerHTML = '<span class="ico">' + s[0] + '</span><div><b>' + s[1] + '</b><span>' + s[2] + '</span></div>';
      host.appendChild(d);
    });
  }
  function toggleNavOverlay(force) {
    var ov = $('nav-overlay');
    var show = (typeof force === 'boolean') ? force : ov.hidden;
    if (show) buildNavOverlay();
    ov.hidden = !show;
    $('nav-help').setAttribute('aria-expanded', String(show));
  }
  $('nav-help').addEventListener('click', function () { toggleNavOverlay(); });
  $('nav-close').addEventListener('click', function () { toggleNavOverlay(false); });
  $('nav-overlay').addEventListener('click', function (e) { if (e.target === this) toggleNavOverlay(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') toggleNavOverlay(false); });

  // --- routes panel: minimize + resize -----------------------------------------
  var panel = $('filter-panel');
  var PANEL_MIN_W = 240, PANEL_MAX_W = 560, PANEL_MIN_H = 140;
  function panelMaxH() { return Math.max(220, window.innerHeight - 140); }
  function setPanelMin(min) {
    panel.classList.toggle('minimized', min);
    var b = $('panel-min');
    b.textContent = min ? '+' : '\u2013';
    b.setAttribute('aria-label', min ? 'Expand routes panel' : 'Minimize routes panel');
    b.setAttribute('aria-expanded', String(!min));
    try { localStorage.setItem('lt-panel-min', min ? '1' : '0'); } catch (e) {}
  }
  (function applyPanelPrefs() {
    if (window.innerWidth <= 640) return;
    try {
      var w = parseInt(localStorage.getItem('lt-panel-w'), 10);
      var h = parseInt(localStorage.getItem('lt-panel-h'), 10);
      if (w >= PANEL_MIN_W && w <= PANEL_MAX_W) panel.style.width = w + 'px';
      if (h >= PANEL_MIN_H && h <= panelMaxH()) { panel.style.height = h + 'px'; panel.style.maxHeight = 'none'; }
      if (localStorage.getItem('lt-panel-min') === '1') setPanelMin(true);
    } catch (e) {}
  })();
  $('panel-min').addEventListener('click', function () { setPanelMin(!panel.classList.contains('minimized')); });
  var grip = $('panel-resize'), rsz = null;
  grip.addEventListener('pointerdown', function (e) {
    if (window.innerWidth <= 640) return;
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch (err) {}
    rsz = { x: e.clientX, y: e.clientY, w: panel.offsetWidth, h: panel.offsetHeight };
  });
  grip.addEventListener('pointermove', function (e) {
    if (!rsz) return;
    var w = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, rsz.w + (rsz.x - e.clientX)));
    var h = Math.min(panelMaxH(), Math.max(PANEL_MIN_H, rsz.h + (e.clientY - rsz.y)));
    panel.style.width = w + 'px';
    panel.style.height = h + 'px';
    panel.style.maxHeight = 'none';
  });
  function endResize(save) {
    if (!rsz) return;
    if (save) {
      try {
        localStorage.setItem('lt-panel-w', String(panel.offsetWidth));
        localStorage.setItem('lt-panel-h', String(panel.offsetHeight));
      } catch (e) {}
    }
    rsz = null;
  }
  grip.addEventListener('pointerup', function () { endResize(true); });
  grip.addEventListener('pointercancel', function () { endResize(false); });

  // --- map tools rail: minimize toggle (Direction C) -------------------
  // The rail rests collapsed on mobile (locate + this toggle only) and
  // expanded on desktop. The toggle flips it manually; the choice
  // persists for the session only (sessionStorage), matching the
  // session-only precedent of the layer toggles.
  var toolsRail = document.querySelector('.map-tools');
  function setToolsMin(min, persist) {
    if (!toolsRail) return;
    toolsRail.classList.toggle('collapsed', !!min);
    var b = $('tools-toggle');
    if (b) {
      b.setAttribute('aria-expanded', String(!min));
      b.setAttribute('aria-label', min ? 'Expand map tools' : 'Minimize map tools');
    }
    if (persist) {
      try { sessionStorage.setItem('lt-tools-min', min ? '1' : '0'); } catch (e) {}
    }
  }
  (function initToolsRail() {
    if (!toolsRail || !$('tools-toggle')) return;
    var stored = null;
    try { stored = sessionStorage.getItem('lt-tools-min'); } catch (e) {}
    setToolsMin(stored != null ? stored === '1' : window.innerWidth <= 640, false);
    $('tools-toggle').addEventListener('click', function () {
      setToolsMin(!toolsRail.classList.contains('collapsed'), true);
    });
  })();

  // --- independent chrome controls (Direction C substrate) ---------------
  // Every chrome element is governed by exactly one control, and no
  // control touches another element's state, so the minimalist design
  // iterations can show, hide, or collapse each element independently:
  //   bar  -> chromeHide('bar', h)   (body.chrome-no-bar; display only —
  //          the bar's buttons keep their state and their panels)
  //   rail -> collapse: setToolsMin(min, persist) / #tools-toggle;
  //          full hide: chromeHide('rail', h) (body.chrome-no-rail)
  //   hint -> chromeHide('hint', h)  (body.chrome-no-hint)
  //   each surface -> its own open/close function (togglePanel,
  //   setBrowse, setTripMode, setRideMode, showStop/hideStop,
  //   showBus/hideBus); the exclusion block coordinates them without
  //   coupling their state. Nothing in Direction C calls chromeHide —
  //   the default chrome is fully visible; the control exists so a
  //   variant can drive it without rework.
  function chromeHide(name, hide) {
    document.body.classList.toggle('chrome-no-' + name, !!hide);
  }
  function chromeHidden(name) {
    return document.body.classList.contains('chrome-no-' + name);
  }

  // --- app lock (route-filters-missing fix, stamp 20261015-1437) --------
  // While the app script is running, the document itself does not
  // scroll. The page carries real content below the stage, so the
  // document is taller than the viewport; an uncovered scroll vector
  // (a drag on the help overlay's backdrop, which has no touch-action
  // anywhere in its ancestor chain, or a wheel scroll over non-canvas
  // chrome) could scroll the document until the whole .map-bar sat
  // above the visible area — and with it the only entry to the route
  // filter panel (togglePanel is called from #filter-btn alone), the
  // planner, ride-along, and the home link — while every contained
  // surface refuses to scroll it back. The lock reuses the max-mode
  // presentation lock's mechanism (the html/body .app-lock rules in
  // the HTML mirror html/body.pseudo-full-lock), set here by the app
  // script at boot: with the script absent the classes are never set
  // and the static page scrolls as before. setMaxMode composes
  // unchanged — its saved scroll offset is 0 under the lock, and its
  // own lock classes are added and removed alongside. Subset stopgap:
  // the app-borders shell carries the same semantics (document height
  // = viewport height in the app view) and subsumes these rules when
  // it lands. Trace: files/route-filters-missing/trace.md.
  document.documentElement.classList.add('app-lock');
  document.body.classList.add('app-lock');

  // --- fullscreen toggle (native API where offered; maximized view where not) ---
  // Behavior contract (files/fullscreen-fix/fullscreen-fix.md):
  //   states: off | native (the stage element in the Fullscreen API) |
  //   max (the stage pinned to the shell frame, document locked).
  //   The button never claims a state that did not occur: the pressed
  //   state and the label are written only by the fullscreenchange
  //   events and by the max-mode transitions — never synchronously
  //   after a request is issued — and where the element API does not
  //   exist (iPhone Safari) the control is labeled "expanded view",
  //   not fullscreen. Capability is detected on the stage element
  //   itself: document.*FullscreenEnabled is true on iPhone (it
  //   reflects video fullscreen) and must not be trusted for page
  //   elements. Frame discipline (S5): the toggle owns no frame
  //   geometry — native mode presents the stage's existing frame, max
  //   mode pins it to the shell frame values in the CSS above, and
  //   camera framing is untouched (a resize notification is all that
  //   fires on a transition).
  var stage = document.querySelector('.map-stage');
  var fullBtn = $('view-full');
  var FS_REQ_NAMES = ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen'];
  function fsRequestName() {
    for (var i = 0; i < FS_REQ_NAMES.length; i++) {
      if (stage && typeof stage[FS_REQ_NAMES[i]] === 'function') return FS_REQ_NAMES[i];
    }
    return null;
  }
  var fsNativeCapable = !!fsRequestName();
  function nativeFsEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function maxActive() { return stage.classList.contains('pseudo-full'); }
  function fsActive() { return !!nativeFsEl() || maxActive(); }
  function setFsBtn() {
    var on = fsActive();
    fullBtn.setAttribute('aria-pressed', String(on));
    fullBtn.setAttribute('aria-label', on
      ? (nativeFsEl() ? 'Exit fullscreen' : 'Exit expanded view')
      : (fsNativeCapable ? 'Enter fullscreen' : 'Enter expanded view'));
  }
  function notifyMapResize() {
    try { window.dispatchEvent(new Event('resize')); } catch (e) {}
  }
  function syncFsLock() { document.body.classList.toggle('fs-lock', fsActive()); }

  // Max mode. The scroll lock: iOS Safari does not honor
  // overflow:hidden on body as a scroll lock, so the body is also
  // position:fixed at the saved scroll offset (the .pseudo-full-lock
  // rules in the HTML) and the offset is restored on exit. fs-lock
  // rides along via syncFsLock, composing with the permanent gesture
  // containment deployed 20261015-1130: no touch-action is set here,
  // and nothing is set on an ancestor of a scrollable panel.
  var maxScrollY = 0;
  var fsFallbackNote = false; // set when max mode is a failed-native fallback
  function setMaxMode(on) {
    if (on === maxActive()) { setFsBtn(); syncFsLock(); return; }
    if (on) {
      maxScrollY = window.scrollY || window.pageYOffset || 0;
      stage.classList.add('pseudo-full');
      document.documentElement.classList.add('pseudo-full-lock');
      document.body.classList.add('pseudo-full-lock');
      document.body.style.top = (-maxScrollY) + 'px';
    } else {
      stage.classList.remove('pseudo-full');
      document.documentElement.classList.remove('pseudo-full-lock');
      document.body.classList.remove('pseudo-full-lock');
      document.body.style.top = '';
      window.scrollTo(0, maxScrollY);
    }
    setFsBtn();
    syncFsLock();
    notifyMapResize();
    if (on && fsFallbackNote) announceSr('Fullscreen unavailable. Expanded view on.');
    else announceSr(on ? 'Expanded view on.' : 'Expanded view off.');
    fsFallbackNote = false;
  }
  function enterNative() {
    var name = fsRequestName();
    if (!name) { setMaxMode(true); return; }
    var p;
    try {
      // navigationUI:'hide' asks Chrome-class browsers to keep their
      // own UI out of the presentation; an engine that rejects the
      // options argument falls through to the no-argument call.
      p = (name === 'requestFullscreen') ? stage[name]({ navigationUI: 'hide' }) : stage[name]();
    } catch (e) {
      try { p = stage[name](); } catch (e2) { fsFallbackNote = true; setMaxMode(true); return; }
    }
    if (p && p.catch) p.catch(function () { if (!fsActive()) { fsFallbackNote = true; setMaxMode(true); } });
    // No state is written here: fullscreenchange confirms the transition.
  }
  function exitNative() {
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (!exit) return;
    try { var p = exit.call(document); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  }
  fullBtn.addEventListener('click', function () {
    if (nativeFsEl()) { exitNative(); return; }
    if (maxActive()) { setMaxMode(false); return; }
    if (fsNativeCapable) enterNative(); else setMaxMode(true);
  });
  var fsWasNative = false;
  function onFsChange() {
    var isNative = !!nativeFsEl();
    setFsBtn(); syncFsLock(); notifyMapResize();
    if (isNative !== fsWasNative) {
      fsWasNative = isNative;
      announceSr(isNative ? 'Fullscreen on.' : 'Fullscreen off.');
    }
  }
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  function onFsError() { if (!fsActive()) { fsFallbackNote = true; setMaxMode(true); } }
  document.addEventListener('fullscreenerror', onFsError);
  document.addEventListener('webkitfullscreenerror', onFsError);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && maxActive()) setMaxMode(false);
  });
  setFsBtn();
  // Zoom defense (2026-10-16): the touch-action containment set covers
  // the stage subtree, but a pinch that starts on a scrollable panel
  // (touch-action: pan-y by design, so panels can scroll) can still
  // engage iOS Safari's page zoom. A zoomed visual viewport renders the
  // layout-anchored chrome (top bar, tools rail) off the visible edge,
  // and no in-page state can undo a zoom once applied — prevention is
  // the only defense. gesturestart/gesturechange are the events iOS
  // Safari honors for this; blocking them document-wide keeps the app
  // at scale 1 without touching panel scrolling (a gesture event is
  // not a scroll) and without a user-scalable viewport switch, which
  // stays out on accessibility grounds.
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener('gesturechange', function (e) { e.preventDefault(); }, { passive: false });
  // Keyboard selection: arrows cycle buses/stops when a card is open,
  // Escape clears. (OrbitControls doesn't bind arrows — no conflict.)
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    if (e.key === 'Escape') { hideBus(); hideStop(); hideRoute(); return; }
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    var dir = e.key === 'ArrowRight' ? 1 : -1;
    if (selectedVehicleId && busSlots.length) {
      var bi = -1;
      for (var i = 0; i < busSlots.length; i++) {
        if (busSlots[i].vehicle && busSlots[i].vehicle.vehicle_id === selectedVehicleId) { bi = i; break; }
      }
      var nb = busSlots[(bi + dir + busSlots.length) % busSlots.length];
      if (nb && nb.vehicle) { showBus(nb.vehicle); e.preventDefault(); }
    } else if (selectedStop && stopPickList.length && selectedStopIndex >= 0) {
      var ns = stopPickList[(selectedStopIndex + dir + stopPickList.length) % stopPickList.length];
      if (ns) { showStop(ns); e.preventDefault(); }
    }
  });

  // === Global camera keys (project 28 item 4, register C-13(ii)) =====
  // The keyboard map is focus-gated on #live-map: a rider who clicks
  // the map gets it, but once focus has fallen back to the page body
  // (a click on non-focusable chrome, a card closed) the same presses
  // reach nothing — the arrows scroll the page instead. This fallback
  // answers camera keys at body level under yield rules audited to be
  // exhaustive; wherever a rule yields, the key keeps its legacy
  // behavior exactly:
  //   - modifier chords (Ctrl / Meta / Alt) belong to the browser;
  //   - form fields and buttons own their keys — the yield the
  //     document selection handler above already applies, extended
  //     here to SELECT elements and contenteditable surfaces;
  //   - a press inside a card, a panel, the Help overlay, the service
  //     notice, the toast, or the trip planner/results belongs to
  //     that surface (its scrolling, its own handlers);
  //   - the Help overlay being open yields every camera key, focused
  //     or not — a reading surface is up;
  //   - ArrowLeft / ArrowRight yield while a bus or stop selection is
  //     active: the cycling handler owns them, the same arrangement
  //     the container handler makes;
  //   - focus on #live-map never reaches this handler at all (the
  //     container handler stops propagation), so the two paths
  //     cannot double-act on one press.
  // The arrow pan math mirrors the container handler line for line.
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key;
    var isZoomK = (k === '+' || k === '=' || k === '-' || k === '_');
    var isTiltK = (k === 'PageUp' || k === 'PageDown');
    var isArrowK = (k === 'ArrowUp' || k === 'ArrowDown' ||
                    k === 'ArrowLeft' || k === 'ArrowRight');
    if (!isZoomK && !isTiltK && !isArrowK && k !== 'Home') return;
    var t = e.target;
    var tag = (t && t.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        tag === 'BUTTON') return;
    if (t && t.isContentEditable) return;
    if (t && t.closest && t.closest('.bus-card, .filter-panel, ' +
      '.browse-panel, .nav-card, .svc-notice, .map-toast, ' +
      '#nav-overlay, #trip-planner, #trip-results')) return;
    var navOv = $('nav-overlay');
    if (navOv && !navOv.hidden) return;
    if (isArrowK && (selectedVehicleId || selectedStop)) return;
    if (isZoomK) { zoomStep((k === '+' || k === '=') ? 1 : -1); e.preventDefault(); return; }
    if (isTiltK) { tiltStep(k === 'PageUp' ? 1 : -1); e.preventDefault(); return; }
    if (k === 'Home') { resetView(); e.preventDefault(); return; }
    var dist = camera.position.distanceTo(controls.target);
    var step = Math.max(50, dist * 0.12);
    var fwd = new THREE.Vector3();
    fwd.subVectors(controls.target, camera.position); fwd.y = 0;
    if (fwd.lengthSq() === 0) return;
    fwd.normalize();
    var right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    var move = new THREE.Vector3();
    if (k === 'ArrowUp') move.addScaledVector(fwd, step);
    else if (k === 'ArrowDown') move.addScaledVector(fwd, -step);
    else if (k === 'ArrowRight') move.addScaledVector(right, step);
    else move.addScaledVector(right, -step);
    camera.position.add(move);
    controls.target.add(move);
    if (typeof controls.update === 'function') controls.update();
    e.preventDefault();
  });
  // === GLOBAL-KEYS-END ===

  // --- location services ---------------------------------------------------------
  // Coverage = the Detroit street mosaic bounds (DDOT's service area),
  // extended to the full mosaic while the SMART group is displayed.
  function inCoverage(lat, lon) {
    if (lat <= STREET_BOUNDS.latN && lat >= STREET_BOUNDS.latS &&
        lon >= STREET_BOUNDS.lonW && lon <= STREET_BOUNDS.lonE) return true;
    // SMART suburbs: covered only while the SMART group is displayed, so
    // "routes near you" and other location features work in the suburbs
    // with SMART enabled and stay Detroit-scoped when it is off. The
    // bounds are MOSAIC_BOUNDS — the street mosaic's declared bbox,
    // and the values this branch used before the SMART removal, under
    // the name the removal's rename gave them.
    try {
      if (groupSelState('smart') !== 'none' &&
          lat <= MOSAIC_BOUNDS.latN && lat >= MOSAIC_BOUNDS.latS &&
          lon >= MOSAIC_BOUNDS.lonW && lon <= MOSAIC_BOUNDS.lonE) return true;
    } catch (e) {}
    return false;
  }
  // --- 3D user representation (scaffold) -----------------------------------------
  // Branded "you are here" marker: Forge Orange beam + floating Forge D badge.
  // Built to extend: heading wedge, accuracy disc, and label hooks live here.
  var YOU_BADGE_Y = 1250, YOU_BADGE_BOB = 70;
  var youMarker = (function () {
    var g = new THREE.Group();

    var beam = new THREE.Mesh(
      new THREE.CylinderGeometry(30, 30, 1000, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x767676, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    beam.position.y = 500;
    g.add(beam);

    var ring = new THREE.Mesh(
      new THREE.RingGeometry(120, 170, 40),
      new THREE.MeshBasicMaterial({ color: 0x767676, transparent: true, opacity: 0.65, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 40;
    g.add(ring);

    var accDisc = new THREE.Mesh(
      new THREE.CircleGeometry(200, 40),
      new THREE.MeshBasicMaterial({ color: 0x767676, transparent: true, opacity: 0.12, depthWrite: false })
    );
    accDisc.rotation.x = -Math.PI / 2;
    accDisc.position.y = 30;
    g.add(accDisc);

    var badge = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
    badge.scale.set(760, 760, 1);
    badge.position.y = YOU_BADGE_Y;
    g.add(badge);

    g.visible = false;
    scene.add(g);

    // Paint the Forge D badge; falls back to a serif "D" if the logo can't load.
    function paintBadge(img) {
      var S = 256, c = document.createElement('canvas');
      c.width = c.height = S;
      var x = c.getContext('2d');
      x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 4, 0, Math.PI * 2);
      x.fillStyle = '#101010'; x.fill();
      x.save();
      x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 16, 0, Math.PI * 2); x.clip();
      if (img) { x.drawImage(img, 0, 0, S, S); }
      else {
        x.fillStyle = '#767676';
        x.font = '700 150px Georgia, "Times New Roman", serif';
        x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText('D', S / 2, S / 2 + 10);
      }
      x.restore();
      x.lineWidth = 10; x.strokeStyle = '#767676';
      x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 10, 0, Math.PI * 2); x.stroke();
      var tex = new THREE.CanvasTexture(c);
      tex.anisotropy = 4;
      badge.material.map = tex;
      badge.material.needsUpdate = true;
    }
    var logoImg = new Image();
    logoImg.onload = function () { paintBadge(logoImg); };
    logoImg.onerror = function () { paintBadge(null); };
    logoImg.src = 'assets/logo.webp?v=' + STAMP;

    return {
      group: g, badge: badge, ring: ring, beam: beam,
      setAccuracy: function (meters) {
        var r = Math.max(60, Math.min(2000, meters || 200));
        accDisc.scale.set(r / 200, r / 200, 1);
      }
    };
  })();
  // --- Logo fade (2026-10-15; Option 3 build 2026-10-21) -----------------------
  // Justin's directive: "fade all artifacts behind logo". The you-are-here
  // badge above is the DAA logo disc (assets/logo.webp painted into a
  // 256 px canvas: dark disc, orange ring). It is a world-space sprite
  // with depthTest:false at renderOrder 0, and every label/badge sprite
  // layer is drawn AFTER it -- street labels (35), stop labels (36),
  // the Belle Isle and People Mover labels (36), places badges (35)
  // and glows (34), MoGo badges (35), alert glyphs (6), bus badges
  // (40), the bus info label (41), route labels (0, depth-sorted
  // after) -- so those artifacts paint at full strength straight
  // across the disc's face (Justin's 2026-10-15 iPad screenshot:
  // "Lysander St" and "Lincoln St" at full opacity on the disc).
  // Scene geometry needs no treatment: streets, route lines, pylons
  // and bus models render before the badge and the painted disc is
  // opaque, so the badge already occludes them.
  //
  // The pass runs once per frame, immediately before render, after
  // every owner update for the frame. For each visible treated sprite
  // it computes the screen-space distance from the badge centre and
  // multiplies the sprite's OWN base opacity by a fade factor:
  // LOGO_FADE_MIN deep inside the disc, rising smoothly (smoothstep)
  // back to 1 across a soft band straddling the rim -- a fade, not a
  // clip. The logo itself is never touched, and artifacts outside the
  // footprint keep their exact base opacity. A sprite's own half-width
  // counts toward the distance, so a label whose centre sits just
  // outside the rim but whose pill crosses it still fades. Base
  // opacities are owner-written (bus badges dim to 0.2 off-itinerary,
  // places glows sit at 0.5): the pass adopts any value it did not
  // write itself as the sprite's new base and never compounds its own
  // writes. When the badge is hidden, behind the camera, or
  // negligible on screen, every treated sprite is restored to its
  // base; when it is closer than LOGO_FADE_NEAR it fills the frame
  // and every visible treated sprite fades uniformly. DOM overlays
  // (cards, panels, the bar) are outside this pass by design.
  //
  // Option 3 (2026-10-21): the badge is clamped at close zoom (see
  // the animation loop), so its scale is no longer a constant 760.
  // The disc radius below is therefore derived from the badge's LIVE
  // scale every frame: LOGO_DISC_R is the radius at scale 760, and
  // logoDiscR() scales it -- the footprint this pass fades is the
  // painted disc's real one at every badge size.
  var LOGO_FADE_MIN = 0.15;
  var LOGO_DISC_R = 368; // world units at badge scale 760: painted disc radius is 124/128 of the half-size
  // (The 2026-10-15 build's LOGO_FADE_NEAR depth constant is retired:
  // the uniform regime is size-measured under Option 3; see applyLogoFade.)
  var logoFadeGlyphs = []; // alert glyph sprites register here (they live in per-route overlay groups)
  var logoFadeActive = false; // a restore sweep is owed only after a fade ran
  var _lfC = new THREE.Vector3(), _lfV = new THREE.Vector3(), _lfD = new THREE.Vector3();
  var _badgeClampV = new THREE.Vector3(); // Option 3 clamp temp (animation loop)
  function logoDiscR() { return LOGO_DISC_R * (youMarker.badge.scale.x / 760); }
  function logoFadeBase(sp) {
    // Adopt owner writes: any opacity the pass did not write is the base.
    var ud = sp.userData;
    if (ud._lfWrote === undefined || sp.material.opacity !== ud._lfWrote) ud._lfBase = sp.material.opacity;
    return ud._lfBase;
  }
  function logoFadeWrite(sp, f) {
    var target = logoFadeBase(sp) * f;
    sp.material.opacity = target;
    sp.userData._lfWrote = target;
  }
  function logoFadeOne(sp, cx, cy, rPx, rw, rh, discR) {
    if (!sp || !sp.visible || !sp.material) return;
    sp.getWorldPosition(_lfV).project(camera);
    if (_lfV.z > 1 || _lfV.z < -1) return;
    var dx = (_lfV.x * 0.5 + 0.5) * rw - cx;
    var dy = (-_lfV.y * 0.5 + 0.5) * rh - cy;
    // Distance from the sprite's nearest edge to the badge centre: the
    // sprite's own half-width (at the badge's pixel scale) counts, so a
    // pill that merely crosses the rim still fades.
    var d = Math.sqrt(dx * dx + dy * dy) - sp.scale.x * 0.5 * (rPx / discR);
    var rIn = rPx * 0.8, rOut = rPx * 1.2, f;
    if (d <= rIn) f = LOGO_FADE_MIN;
    else if (d >= rOut) f = 1;
    else { var t = (d - rIn) / (rOut - rIn); f = LOGO_FADE_MIN + (1 - LOGO_FADE_MIN) * (t * t * (3 - 2 * t)); }
    logoFadeWrite(sp, f);
  }
  function logoFadeRestoreOne(sp) {
    if (!sp || !sp.material) return;
    var ud = sp.userData;
    if (ud._lfWrote !== undefined && sp.material.opacity === ud._lfWrote) {
      sp.material.opacity = ud._lfBase;
      ud._lfWrote = ud._lfBase;
    }
  }
  function logoFadeEach(fn) {
    var i;
    for (i = 0; i < badgePool.length; i++) fn(badgePool[i]);
    for (i = 0; i < streetLabelPool.length; i++) fn(streetLabelPool[i]);
    for (i = 0; i < stopLabelPool.length; i++) fn(stopLabelPool[i]);
    for (i = 0; i < labelSprites.length; i++) fn(labelSprites[i].sprite);
    for (i = 0; i < placesBadges.length; i++) fn(placesBadges[i]);
    for (i = 0; i < placesGlows.length; i++) fn(placesGlows[i]);
    for (i = 0; i < mogoBadges.length; i++) fn(mogoBadges[i]);
    fn(busInfoSprite);
    if (belleIsleLabel) fn(belleIsleLabel);
    if (pmLabel) fn(pmLabel);
    // Alert glyphs: prune sprites whose overlay group left the scene
    // (alert overlays are rebuilt on refresh), fade the live ones.
    for (i = logoFadeGlyphs.length - 1; i >= 0; i--) {
      var g = logoFadeGlyphs[i], live = false, n = g;
      while (n) { if (n === scene) { live = true; break; } n = n.parent; }
      if (!live) { logoFadeGlyphs.splice(i, 1); continue; }
      fn(g);
    }
  }
  function applyLogoFade() {
    if (!youMarker.group.visible) {
      if (logoFadeActive) { logoFadeEach(logoFadeRestoreOne); logoFadeActive = false; }
      return;
    }
    youMarker.badge.getWorldPosition(_lfC);
    // Badge depth along the view axis, before any projection is
    // trusted. project() is only meaningful for a badge genuinely in
    // front of the camera: beside or behind the camera plane --
    // routine at street-view distances, where the badge floats ~1250
    // units over the rider and the camera works ~1250 units away --
    // it returns a mirrored, exploded screen position with an
    // in-range z, and any footprint built from it is fiction. A badge
    // behind the camera is not on screen at all: nothing sits behind
    // it, so the restore path applies.
    _lfD.copy(_lfC).sub(camera.position);
    _lfV.setFromMatrixColumn(camera.matrixWorld, 2); // camera backward axis
    var badgeDepth = -_lfV.dot(_lfD);
    if (badgeDepth <= 0) {
      if (logoFadeActive) { logoFadeEach(logoFadeRestoreOne); logoFadeActive = false; }
      return;
    }
    _lfV.copy(_lfC).project(camera);
    if (_lfV.z > 1 || _lfV.z < -1) {
      if (logoFadeActive) { logoFadeEach(logoFadeRestoreOne); logoFadeActive = false; }
      return;
    }
    var rw = renderer.domElement.clientWidth, rh = renderer.domElement.clientHeight;
    if (!(rw > 0) || !(rh > 0)) return;
    var cx = (_lfV.x * 0.5 + 0.5) * rw, cy = (-_lfV.y * 0.5 + 0.5) * rh;
    // Disc radius in px: project a point one (live) disc radius along camera-right.
    var discR = logoDiscR();
    _lfV.setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(discR).add(_lfC).project(camera);
    var rPx = Math.abs((_lfV.x * 0.5 + 0.5) * rw - cx);
    if (!(rPx > 4)) {
      if (logoFadeActive) { logoFadeEach(logoFadeRestoreOne); logoFadeActive = false; }
      return;
    }
    // Uniform regime, measured rather than assumed (Option 3,
    // 2026-10-21): the 2026-10-15 candidate fired this branch on
    // view-axis depth < 400 because at the fixed 760 scale a badge
    // that close spans more than the viewport height, so everything
    // visible is behind the logo. Under the Option 3 clamp the disc
    // is capped at 25% of viewport height and NEVER spans the frame,
    // however close the badge gets -- a depth-only trigger would wash
    // every label on screen to 15% during ordinary street-view use
    // near the rider's own position, fading artifacts that are not
    // behind the logo at all. The branch therefore fires on the
    // measured disc size (diameter >= viewport height), which is the
    // original premise stated in pixels: it reproduces the 2026-10-15
    // behavior at the unclamped scale and stays inert under the clamp,
    // where the footprint regime below is the correct treatment at
    // every distance.
    if (rPx * 2 >= rh) {
      logoFadeActive = true;
      logoFadeEach(function (sp) { if (sp && sp.visible && sp.material) logoFadeWrite(sp, LOGO_FADE_MIN); });
      return;
    }
    logoFadeActive = true;
    logoFadeEach(function (sp) { logoFadeOne(sp, cx, cy, rPx, rw, rh, discR); });
  }
  var toastTimer = null;
  function hideToast() { $('map-toast').hidden = true; clearTimeout(toastTimer); }
  function showToast(msg, sticky) {
    var t = $('map-toast');
    t.innerHTML = '';
    var s = document.createElement('span');
    s.textContent = msg;
    t.appendChild(s);
    if (sticky) {
      var x = document.createElement('button');
      x.id = 'toast-x';
      x.setAttribute('aria-label', 'Dismiss');
      x.textContent = '\u00D7';
      x.addEventListener('click', function (e) { e.stopPropagation(); hideToast(); });
      t.appendChild(x);
    } else {
      clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, 4500);
    }
    t.hidden = false;
  }
  $('map-toast').addEventListener('click', hideToast);
  // === Adaptive input hint (project 28 item 4, register C-11(i)) ======
  // A withheld-modality session has a detectable local signature: a
  // hardware pointer is active (mouse/pen pointerdowns), the wheel has
  // never delivered a single event, and the rider is zooming through
  // the fallback paths (rail buttons, keyboard steps) instead. That is
  // the Chrome-on-iPadOS shape from the founding session, where the
  // browser withholds the wheel class from web content. Detection is
  // local only: counters live in this closure, nothing is persisted,
  // and nothing leaves the device — the telemetry beacon stays dormant,
  // because collection is a legal-instrument decision (C-11(ii)), not
  // an engineering one. The hint fires at most once per session through
  // the standing toast (auto-hiding, click to dismiss), and its
  // wording is conditional, so a rider whose wheel works and who
  // simply prefers the buttons is told nothing false.
  var hintPtrActive = 0;   // mouse/pen pointerdowns this session
  var hintWheelSeen = 0;   // wheel events delivered this session
  var hintZoomSteps = 0;   // zoomStep calls this session
  var hintShown = false;
  window.addEventListener('pointerdown', function (e) {
    if (e && (e.pointerType === 'mouse' || e.pointerType === 'pen')) hintPtrActive++;
  }, { passive: true, capture: true });
  window.addEventListener('wheel', function () {
    hintWheelSeen++;
  }, { passive: true, capture: true });
  function noteZoomStep() {
    hintZoomSteps++;
    if (hintShown || !isTouch) return;
    if (hintWheelSeen > 0 || hintPtrActive < 2 || hintZoomSteps < 2) return;
    hintShown = true;
    showToast('Zoom tip: if the scroll wheel does not zoom in this ' +
      'browser, double-click the map or use the + / \u2212 buttons.');
  }
  // === ADAPTIVE-HINT-END ===
  var locateBtn = $('view-locate'), locating = false;
  function onLocated(lat, lon, accMeters) {
    if (!proj) { showToast('Map is still loading — try again in a moment.'); return; }
    if (!inCoverage(lat, lon)) {
      youMarker.group.visible = false;
      locateBtn.setAttribute('aria-pressed', 'false');
      showToast('Out of bounds — you are outside DDOT\u2019s Detroit coverage area.', true);
      return;
    }
    hideToast();
    var p = project(lat, lon);
    userXZ = p;
    cancelStreetTween();
    youMarker.group.position.set(p[0], 0, p[1]);
    // Zoom-on-enable (2026-10-15, Justin's priority): enabling location
    // flies the camera SMOOTHLY to street level over the rider, so the
    // buses, stops, and routes around the rider are individually
    // tappable and selectable. The framing is the app's own bus vantage
    // (TransitionEngine.vantageForBus): a 32-degree-elevated view at
    // horizontal offset max(controls.minDistance * 1.3, 900) — 1,560 m
    // at the normal-mode minDistance of 1,200 m — for a total camera
    // distance of ~1,840 m. Derivation: the home framing (~12.5 km
    // since the 2026-10-18 Project 16 overhaul, Option A) is far too
    // wide to pick out one bus; the street-view vantage
    // (~670 m) sits below controls.minDistance in normal mode, so
    // OrbitControls would snap the camera back out on the next
    // interaction (vantageForBus's own comment documents that
    // constraint); at ~1,840 m stopScaleFor() is at its close-zoom
    // floor (<= 2,800 m), so stops and buses render at full street
    // scale. The move reuses TransitionEngine.go -> glideTo, the
    // existing minimum-jerk fly-to — no second animation system. While
    // a trip fly-through owns the camera, TransitionEngine.go defers
    // and would drop the move entirely, so that case keeps the legacy
    // instant recenter. Denied or unavailable location never reaches
    // this code: the error path and the settled home framing are
    // unchanged.
    if (typeof tripFly !== 'undefined' && tripFly) {
      var off = camera.position.clone().sub(controls.target);
      controls.target.set(p[0], 0, p[1]);
      camera.position.copy(controls.target).add(off);
    } else {
      TransitionEngine.go({ vantage: TransitionEngine.vantageForBus(p[0], p[1]) });
    }
    // Camera memory (R6): a successful locate redefines the preserved
    // framing — camMemFraming counts the in-flight glide at its
    // destination; the tripFly branch above has already landed.
    camMemRefresh();
    youMarker.setAccuracy(accMeters);
    youMarker.group.visible = true;
    locateBtn.setAttribute('aria-pressed', 'true');
    if (pendingNearMe) {
      setNearMe(true);
    } else if (filterState.nearMe) {
      computeNearMe();
      applyFilters();
      syncFilterUI();
      refreshFilterCounts();
    }
  }
  locateBtn.addEventListener('click', function () {
    if (!('geolocation' in navigator)) { showToast('Location services are not available on this device.'); return; }
    if (locating) return;
    locating = true;
    showToast('Locating\u2026');
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        locating = false;
        onLocated(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      },
      function (err) {
        locating = false;
        pendingNearMe = false;
        if (err && err.code === 1) showToast('Location access denied — allow it in your browser settings to use this.');
        else showToast('Could not get your location — please try again.');
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  });

  // Boot location prompt DELETED (first-view launcher, Concept 3 —
  // Justin's pick 2026-10-23): nothing asks for location at load, in
  // any form. The only location offer is the launcher sheet's Near me
  // tile (fvShowNearChoice, in the first-view section below), which is
  // inline, optional, and carries a no-permission map-center fallback.
  // The map-tools locate button's own behavior above is unchanged.

  // --- Engine/asset pairing guard (Board 47 item 7, G5 step 1) --------
  // A service_model: "set" timetable under an engine without set
  // resolution (no servicesFor) would be planned silently as a subset:
  // the legacy resolver keeps one service per feed per date and drops
  // every concurrent service. Refuse loudly instead — never plan a
  // subset. On the legacy pairing (no marker) this is a no-op.
  function ltAssertPairing(R, tt) {
    var model = (tt && tt.meta && tt.meta.service_model) || null;
    if (model === 'set' && (!R || typeof R.servicesFor !== 'function')) {
      var msg = 'PAIRING FAILURE: service_model "set" timetable under a legacy engine \u2014 ' +
        'the legacy resolver would keep one service per feed per date and silently drop ' +
        'every concurrent service. Refusing to load.';
      if (typeof console !== 'undefined' && console.error) console.error(msg);
      throw new Error(msg);
    }
  }

  // --- Ride-along stop times (2026-10-15) ---------------------------------
  // Supplies Ride Along's upcoming-stops list with per-stop times from
  // the best source the data supports, per agency (ARCHITECTURE.md):
  // DDOT — the vehicle's matched timetable trip via the delay engine.
  // QLINE — no stop times published to this view:
  // sequence only, named. Coverage boundaries are stated in the view,
  // never presented as a generic empty state (S4).
  //
  // The timetable engine (raptor.js + the DDOT timetable) normally
  // loads with the first planner use. Ride Along needs its
  // vehicle-to-trip matching (updateLiveDelays) as soon as a rider
  // boards, so opening Ride Along loads it quietly (setRideMode).
  // Planner state is shared: when the planner later opens it finds
  // tripTT/tripRaptor already set.
  var rideEngineLoading = false;
  function ensureTripEngine() {
    if ((tripTT && tripRaptor) || rideEngineLoading) return;
    rideEngineLoading = true;
    var loadR = tripRaptor ? Promise.resolve(tripRaptor)
      : import('./raptor-v2.js?v=' + STAMP).then(function (m) { tripRaptor = m.default || m; return tripRaptor; });
    loadR.then(function (R) {
      if (tripTT || !R || !R.loadTimetable) return;
      return R.loadTimetable('https://www.detroitautomationacademy.com/planner-timetable-S1000182-S1000147.json?v=' + STAMP).then(function (tt) { ltAssertPairing(R, tt); tripTT = tt; });
    }).catch(function () { /* engine unavailable: times degrade to the named notes (S4) */ })
      .then(function () { rideEngineLoading = false; if (rideWidget) rideWidget.refresh(); if (selectedStop) renderStopLive(); });
  }

  // Ride Along stop-times provider (the widget's setTimesProvider).
  // Returns { byStop: { gtfsStopId: label }, onlyIds: { gtfsStopId:
  // true } | null, note }. DDOT source: the vehicle's matched timetable
  // trip (the delay engine's tripDelayState) — the trip's remaining
  // stops are the sequence filter, and its arrival times — empirically
  // adjusted (arrL2) when the timing cells have substituted them, else
  // scheduled (arr) — are shifted by the vehicle's measured delay.
  // Route Reverse (project 18): the route's pattern termini (first and
  // last stops of every pattern), as stopData indices per route id.
  var rrTerminalsByRoute = null;
  function rrTerminalAt(v) {
    if (!v || v.x == null || v.z == null || !tripTT || !stopData) return null;
    var spd = parseFloat(v.speed_mph);
    if (!isNaN(spd) && spd > 2) return null;
    if (v.updated_at) {
      var age = Date.now() - new Date(v.updated_at).getTime();
      if (!(age <= 300000)) return null;
    }
    if (!rrTerminalsByRoute) {
      rrTerminalsByRoute = {};
      for (var pi = 0; pi < tripTT.patterns.length; pi++) {
        var pat = tripTT.patterns[pi];
        var rid = tripTT.routes[pat.route] && String(tripTT.routes[pat.route].id);
        if (!rid || !pat.trips.length) continue;
        var set = rrTerminalsByRoute[rid] || (rrTerminalsByRoute[rid] = {});
        for (var ti = 0; ti < pat.trips.length; ti++) {
          var stops = pat.trips[ti].stops;
          set[stops[0]] = true;
          set[stops[stops.length - 1]] = true;
        }
      }
    }
    var terms = rrTerminalsByRoute[String(v.route_id)];
    if (!terms) return null;
    for (var idx in terms) {
      var sObj = stopData[idx];
      if (sObj && Math.hypot(v.x - sObj.x, v.z - sObj.z) <= 200) return sObj.n || null;
    }
    return null;
  }
  // Rank 5 (project 4, audit-2026-10-16 rec 5): downstream projection
  // factor. tripDelayState's delaySec is the MEASURED delay (0.5 EMA of
  // position-lag measurements); it is never stored scaled. But a delay
  // measured at the bus's current position does not persist in full to
  // downstream stops — buses recover time (dwell and schedule slack read
  // as lag but do not propagate 1:1), so projecting the measurement flat
  // overstated every downstream ETA (fused median bias -49 s / -56 s on
  // the two replay days). Every surface that projects the measurement
  // onto a stop time applies DELAY_PROJECTION instead: rideTimesFor and
  // computeStopArrivals here, liveLegTime in the Phase 2c block, and
  // depA/arrA/buildJourney in raptor.js (same constant, same value).
  // The factor is declared at the top of each consuming function rather
  // than once at file scope: the standing test rigs extract these
  // functions standalone, and the value must travel with the function. 
  // Two-day crossing replay (tune Fri 2026-10-16, validate Wed
  // 2026-10-14; 52,492 / 46,509 non-disrupted crossings): fused MAE
  // 82.4 -> 60.7 and 79.4 -> 56.7, median bias -49 -> +1 and -56 -> -2.
  // Full grid + gate record:
  // files/compute-accuracy/rank5-delivery-note-2026-10-18.md.
  function rideTimesFor(v) {
    var DELAY_PROJECTION = 0.6; // rank 5 — record above this function
    if (!v) return null;
    if (v.agency === 'qline') {
      return { byStop: {}, onlyIds: null, note: 'QLINE stop times are not published to this view. Stops are listed in order.' };
    }
    if (v.agency === 'smart') {
      // Restored with the reactivation (and now literally true): SMART
      // publishes live positions to this view, never stop times.
      return { byStop: {}, onlyIds: null, note: 'SMART stop times are not published to this view. Stops are listed in order.' };
    }
    if (v.agency !== 'ddot') return null;
    if (!tripTT) {
      return { byStop: {}, onlyIds: null, note: 'Stop times load with the trip engine; they appear here once it is ready.' };
    }
    var found = null;
    tripDelayState.forEach(function (st, trip) { if (st.vehicleId === v.vehicle_id) found = { st: st, trip: trip }; });
    if (!found) {
      // Route Reverse S3: an unbound bus dwelling at one of its route's
      // termini is at the end of its run — a defined state with its own
      // words, not the generic unmatched line wearing a geometric
      // sequence (specification section 2.3).
      var termName = rrTerminalAt(v);
      if (termName) {
        return { byStop: {}, onlyIds: null, atTerminal: termName,
          note: 'This bus has reached the end of its run. Its next trip has not been assigned yet, so stop times are not shown.' };
      }
      return { byStop: {}, onlyIds: null, note: 'This bus is not matched to a scheduled trip yet, so stop times are not shown. Matching runs every minute while the bus reports a current position.' };
    }
    var trip = found.trip, st = found.st;
    var arr = trip.arrL2 || trip.arr;
    // The binding's service frame: after-midnight trips evaluate
    // against service-day seconds, not calendar seconds.
    var nowSec = detroitParts(Date.now()).sec + (st.frameShift || 0);
    var byStop = {}, onlyIds = {}, seqIds = [];
    for (var j = 0; j < trip.stops.length; j++) {
      var eta = arr[j] + (st.disrupted ? 0 : st.delaySec * DELAY_PROJECTION);
      if (eta < nowSec - 30) continue; // already served (30 s grace for the stop the bus is standing at)
      var sObj = stopData && stopData[trip.stops[j]];
      if (!sObj || sObj.id == null) continue;
      var gid = String(sObj.id);
      onlyIds[gid] = true;
      seqIds.push({ id: gid, name: sObj.n || '' });
      var dSec = eta - nowSec;
      byStop[gid] = dSec < 45 ? 'now' : (dSec <= 5400 ? Math.round(dSec / 60) + ' min' : tripClock(eta));
    }
    if (st.layover) {
      var oStop = stopData && stopData[trip.stops[0]];
      return { byStop: byStop, onlyIds: onlyIds, seqIds: seqIds,
        layover: { terminal: oStop ? (oStop.n || '') : '',
          originId: oStop && oStop.id != null ? String(oStop.id) : null,
          departClock: tripClock((trip.depL2 || trip.dep)[0]),
          headsign: formatDest(v.route_id, trip.h) },
        note: 'This bus is between trips at the terminal. Times are its scheduled times for the next trip.' };
    }
    var note = st.disrupted
      ? 'This bus is off its schedule pattern; the times shown are its scheduled times.'
      : (trip.arrL2
        ? 'Times are live estimates for this bus: typical running times for its trip, adjusted by its measured delay.'
        : 'Times are live estimates for this bus: its scheduled trip times, adjusted by its measured delay.');
    return { byStop: byStop, onlyIds: onlyIds, seqIds: seqIds, note: note };
  }

  // --- stops ---------------------------------------------------------------
  // Stops follow individual route filters (not groups). Single-route stops
  // take their route's color; multi-route stops ("hubs") draw paper-white
  // and larger so transfer points read at a glance. Two draw calls total.
  var stopGroup = new THREE.Group();
  stopGroup.visible = false; // LOD-gated in the animation loop
  scene.add(stopGroup);
  var STOP_LOD_DIST = 26000; // Project 21 (2026-10-17): set above the
  // home distance so stops render — and pick — on load at the default
  // zoom (the earlier 20,000 value's premise no longer matched the
  // shipped framing, so stops were switched off at the default view).
  // The home distance is 12,500 m since the 2026-10-18 Project 16
  // overhaul (Option A; it was 20,500 m when this was set), so the
  // headroom is now 13,500 m. The value stands: any future home
  // distance must stay below it.

  // Stop markers: one instanced pylon per stop. Height encodes importance:
  // 75m + 28m per serving route, so a 13-route mega-hub towers over a
  // single-route stop the way it should. Single-route pylons take their
  // route's color; multi-route hubs draw paper-white. One draw call.
  var STOP_MAX = 16384; // merged registry capacity: DDOT stops + SMART stops + QLINE stops (10,583) plus headroom
  // Render-engine refactor Phase 2 (project 15): the zoom-coupled stop
  // scale lives in ONE shader uniform instead of the instance matrices.
  // Matrices are written at governed-list changes (rebuildStops) with the
  // then-current stopYS baked in (stopBakedYS); the vertex shader scales
  // world Y about STOP_BASE_Y by uStopScale = stopYS / stopBakedYS, so
  // the per-frame easing rewrite of all 10,583 matrices (0.44-2.23 ms +
  // a 661 KB buffer re-upload per frame, measured in the project-15
  // research) disappears — easing is now one uniform write per frame.
  // Normals stay at the baked scale (the pre-Phase-2 matrices distorted
  // them the same way). Raycast exactness is kept by the raycast
  // override below: a pick that arrives mid-ease first re-bakes the
  // matrices at the current stopYS — picks are discrete events, so the
  // rewrite cost moved off the frame path entirely.
  var stopScaleU = { value: 1 };
  var stopXZU = { value: 1 };
  var stopBakedYS = 1;
  var stopMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  stopMat.onBeforeCompile = function (sh) {
    sh.uniforms.uStopScale = stopScaleU;
    sh.uniforms.uStopXZ = stopXZU;
    sh.vertexShader = 'uniform float uStopScale;\nuniform float uStopXZ;\n' + sh.vertexShader.replace(
      '#include <project_vertex>',
      ['vec4 mvPosition = vec4( transformed.x * uStopXZ, transformed.y, transformed.z * uStopXZ, 1.0 );',
       '#ifdef USE_INSTANCING',
       '\tmvPosition = instanceMatrix * mvPosition;',
       '#endif',
       '\tmvPosition = modelMatrix * mvPosition;',
       '\tmvPosition.y = ' + STOP_BASE_Y + '.0 + (mvPosition.y - ' +
         STOP_BASE_Y + '.0) * uStopScale;',
       '\tmvPosition = viewMatrix * mvPosition;',
       '\tgl_Position = projectionMatrix * mvPosition;'].join('\n'));
  };
  stopMat.customProgramCacheKey = function () { return 'stopScaleXZ'; };
  var stopIM = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(14, 18, 1, 8), stopMat, STOP_MAX);
  stopIM.frustumCulled = false;
  stopIM.count = 0;
  stopIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Phase 3 note: Phase 2's stopIM.raycast override (re-bake matrices
  // before a whole-mesh raycast) is removed with the raycast itself —
  // the pick paths below no longer raycast stopIM. gridStopHit performs
  // the same re-bake before testing candidates against the matrices.
  function syncStopScaleU() {
    stopScaleU.value = stopBakedYS ? stopYS / stopBakedYS : 1;
  }
  stopGroup.add(stopIM);
  var stopPickList = [];
  // Project 21: per-stop facility route counts for the prominent-stop
  // label tier, recomputed by rebuildStops (see buildFacilityCounts).
  var stopFacilityCounts = new Map();
  var STOP_BASE_Y = 18; // street level: above the street lines, below casing

  var lastStopSig = null;
  var _stopTmpColor = new THREE.Color();
  function stopHeight(nRoutes) { return 75 + 28 * nRoutes; }
  // Zoom-coupled stop scale: the importance-encoded heights read well wide
  // out but tower over downtown at street zoom. Gentler than the bus-pillar
  // curve — stops are wayfinding anchors and must stay findable.
  var stopYS = 1;
  function stopScaleFor(d) {
    // In street view the stops are the subject: they ease a touch taller
    // than the plain close-zoom floor so individual markers read clearly.
    var lo = streetView ? 0.55 : 0.35;
    if (d >= 8000) return 1;
    if (d <= 2800) return lo;
    var t = (d - 2800) / (8000 - 2800);
    t = t * t * (3 - 2 * t);
    return lo + (1 - lo) * t;
  }
  // Project 21: footprint (XZ) prominence at city distances, through the
  // uStopXZ shader uniform — the constant-screen-size pattern the street
  // labels and places discs already use. True scale at and below
  // 8,000 m (stopScaleFor's own full-height point); above it the pylon
  // footprint grows in proportion to distance, holding ~4.3 px of screen
  // width out to the 26,000 m LOD edge. Eased in easeStopScale exactly
  // like stopYS: uniform writes only, never a matrix rewrite.
  var stopXZS = 1;
  function stopXZFor(d) {
    if (d <= 8000) return 1;
    return Math.min(d / 8000, 3.25);
  }
  // The pick aim credit is the RENDERED pylon radius: the shipped 16 m
  // mean radius grown by the same XZ scale the shader applies — 16 m
  // exactly wherever the scale is 1, so close-zoom scoring is unchanged.
  function stopAimRadiusM() { return 16 * stopXZS; }
  function writeStopMatrices(list, withColors) {
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var h = stopHeight(s.r.length) * stopYS;
      _p3.set(s.x, STOP_BASE_Y + h / 2, s.z);
      _q3.identity();
      _s3.set(1, h, 1);
      _m4.compose(_p3, _q3, _s3);
      stopIM.setMatrixAt(i, _m4);
      if (withColors) {
        if (s.r.length > 1) {
          _stopTmpColor.set(0xf2f2f2);
        } else {
          var rc = routeColors[s.r[0]];
          if (rc) _stopTmpColor.copy(rc); else _stopTmpColor.set(0xf2f2f2);
        }
        stopIM.setColorAt(i, _stopTmpColor);
      }
    }
    stopIM.count = list.length;
    stopIM.instanceMatrix.needsUpdate = true;
    if (withColors && stopIM.instanceColor) {
      stopIM.instanceColor.setUsage(THREE.DynamicDrawUsage);
      stopIM.instanceColor.needsUpdate = true;
    }
    // Phase 2: matrices now bake the current stopYS; the shader ratio
    // returns to 1 until the ease moves stopYS away again.
    stopBakedYS = stopYS;
    syncStopScaleU();
  }
  // Project 21: facility weight for the prominent-stop tier. Terminals
  // are modeled as per-bay stops ("Rosa Parks Transit Center - Bay 4" —
  // one route each), so a route-count rule alone misses the city's
  // biggest boarding points. A stop's facility count is the union of
  // visible routes across governed stops that share its name stem
  // (name minus bay/direction suffix) within 500 m. Computed once per
  // governed-list rebuild — never per frame, never per label pass.
  function facilityStem(n) {
    return String(n || '').replace(/ - (Bay \d+|Northbound|Southbound|Eastbound|Westbound)$/, '');
  }
  function buildFacilityCounts(list, onFn) {
    var counts = new Map();
    var byStem = {};
    for (var i = 0; i < list.length; i++) {
      var k = facilityStem(list[i].n);
      (byStem[k] || (byStem[k] = [])).push(list[i]);
    }
    for (var k2 in byStem) {
      var grp = byStem[k2];
      if (grp.length > 64) { // pathological stem: own counts stand
        for (var g0 = 0; g0 < grp.length; g0++) counts.set(grp[g0], 0);
        continue;
      }
      for (var a = 0; a < grp.length; a++) {
        var set = {};
        for (var b = 0; b < grp.length; b++) {
          var dx = grp[a].x - grp[b].x, dz = grp[a].z - grp[b].z;
          if (dx * dx + dz * dz <= 500 * 500) {
            (grp[b].r || []).forEach(function (rid) { if (onFn(rid)) set[rid] = 1; });
          }
        }
        counts.set(grp[a], Object.keys(set).length);
      }
    }
    return counts;
  }
  function rebuildStops() {
    // Stops only depend on route toggles: skip the full rebuild when the
    // visible route set hasn't changed (e.g. polls that only flip dimming).
    var sig = routeOrder.map(function (rid) { return routeIsOn(rid) ? '1' : '0'; }).join('') +
      '|nm:' + (filterState.nearMe ? Object.keys(nearMeSet || {}).sort().join(',') : 'off');
    if (sig === lastStopSig) return;
    lastStopSig = sig;
    var list = [];
    if (stopData && stopData.length) {
      stopData.forEach(function (s) {
        if (!s.r || !s.r.length) return;
        var on = s.r.some(function (rid) { return routeIsOn(rid) && routeNearOk(rid); });
        if (!on) return;
        list.push(s);
      });
    }
    stopPickList = list;
    writeStopMatrices(list, true);
    // Project 21: the label tier's facility weights follow the governed
    // list (visible routes only — prominence never invents service).
    stopFacilityCounts = buildFacilityCounts(list, function (rid) { return routeIsOn(rid); });
    // Rebuilds recolor every instance: re-apply the selection highlight.
    selectedStopIndex = selectedStop ? list.indexOf(selectedStop) : -1;
    if (selectedStopIndex < 0 && selectedStop) hideStop();
    else setStopSelectedColor(selectedStopIndex, true);
  }

  // Selected-stop highlight: a narrow pulsing ring hugging the pylon base
  // plus the pylon itself painted white — unambiguous at any zoom.
  var selectedStop = null;
  var selectedStopIndex = -1;
  var stopHighlight = new THREE.Mesh(
    new THREE.RingGeometry(30, 52, 40),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false })
  );
  stopHighlight.rotation.x = -Math.PI / 2;
  stopHighlight.visible = false;
  scene.add(stopHighlight);

  // Paint the selected pylon white (restore its route/paper color after).
  // Called on select, deselect, and rebuild (toggles recolor everything).
  function setStopSelectedColor(idx, on) {
    if (idx < 0 || idx >= stopPickList.length || !stopIM.instanceColor) return;
    var s = stopPickList[idx];
    if (on) {
      _stopTmpColor.set(0xffffff);
    } else if (s.r.length > 1) {
      _stopTmpColor.set(0xf2f2f2);
    } else {
      var rc = routeColors[s.r[0]];
      if (rc) _stopTmpColor.copy(rc); else _stopTmpColor.set(0xf2f2f2);
    }
    stopIM.setColorAt(idx, _stopTmpColor);
    // Phase 2: range-limited upload — one instance's color, not the
    // whole 10,583-instance buffer (r186 BufferAttribute update ranges;
    // guarded so the call shape stays safe if the API is absent).
    var ic = stopIM.instanceColor;
    if (typeof ic.addUpdateRange === 'function') {
      if (typeof ic.clearUpdateRanges === 'function') ic.clearUpdateRanges();
      ic.addUpdateRange(idx * 4, 4);
    }
    ic.needsUpdate = true;
  }
  // Stop-card route presentation (Product Defect Reconciliation,
  // project 13): the card presents only the routes the stops layer
  // itself would present — routeIsOn && routeNearOk, the
  // rebuildStops predicate. A route the rider has switched off is
  // not chipped, not badged with its alerts, and not counted here.
  // PM stops are exempt (the DPM pseudo-route lives outside
  // filterState). If every route gates closed the full set is kept:
  // rebuildStops closes map-opened cards before that state can
  // arise, so the fallback only guards directory-opened records.
  function stopCardRoutes(st) {
    var all = st.r || [];
    if (st.pm || !all.length) return all;
    var open = all.filter(function (rid) { return routeIsOn(rid) && routeNearOk(rid); });
    return open.length ? open : all;
  }
  function renderStopChips(st) {
    if (!st) return;
    var rids = stopCardRoutes(st);
    $('stop-nroutes').textContent = rids.length + (rids.length === 1 ? ' route' : ' routes');
    var host = $('stop-routes');
    if (!host) return;
    host.innerHTML = '';
    rids.forEach(function (rid) {
      var chip = document.createElement('span');
      chip.className = 'stop-route';
      var dot = document.createElement('i');
      var rc = routeColors[rid];
      dot.style.background = rc ? '#' + rc.getHexString() : '#F2F2F2';
      chip.appendChild(dot);
      var b = document.createElement('b');
      b.textContent = routeLabel(rid);
      chip.appendChild(b);
      if (typeof alertsForRoute === 'function' && typeof alertFx === 'function' && alertsForRoute(rid).length) {
        var cFx = alertFx({ effect: alertWorstEffect(alertsForRoute(rid)) });
        var adv = document.createElement('span');
        adv.className = 'adv-tag fx-' + cFx.cls;
        adv.textContent = cFx.glyph;
        adv.title = cFx.label + ' — active service alert on this route';
        chip.appendChild(adv);
      }
      host.appendChild(chip);
    });
  }
  function showStop(st) {
    if (!st) return;
    setFollow(null); // a stop selection ends bus tracking
    if (typeof tripMode !== 'undefined' && tripMode) { tripStopTapped(st); return; }
    camMemTake();
    exclCover('stop');
    tapBuzz();
    setStopSelectedColor(selectedStopIndex, false);
    selectedStop = st;
    selectedStopIndex = stopPickList.indexOf(st);
    setStopSelectedColor(selectedStopIndex, true);
    $('stop-title').textContent = st.n || 'Stop';
    $('stop-id').textContent = st.id || '–';
    renderStopChips(st);
    if (typeof renderStopAlerts === 'function') renderStopAlerts(st);
    if (typeof renderStopMogo === 'function') renderStopMogo(st);
    if (typeof renderStopPlace === 'function') renderStopPlace(st);
    $('stop-card').hidden = false;
    // Dialog focus: same pattern as showBus above.
    if (_stopReturnFocus === null && document.activeElement && !$('stop-card').contains(document.activeElement)) _stopReturnFocus = document.activeElement;
    $('stop-card').focus();
    if (st.place && typeof placesCardText === 'function') {
      announceSr(placesCardText(st));
    } else if (st.mogo && st.station) {
      announceSr('Bikeshare station details opened. ' + (st.n || 'Station') + '. ' +
        (typeof mogoCardModel === 'function' ? mogoCardModel(st.station, Date.now()).bikesLine + '. ' : '') +
        (typeof mogoStatusSentence === 'function' ? mogoStatusSentence(st.station) : ''));
    } else {
      announceSr('Stop details opened. ' + (st.n || 'Stop') + '. ' + (st.r || []).length + ((st.r || []).length === 1 ? ' route serves this stop.' : ' routes serve this stop.'));
    }
    // Selection ring hugs the ground for DDOT stops, the guideway deck for
    // People Mover stations (their pins stand on the elevated loop).
    stopHighlight.position.set(st.x, st.pm ? PM_DECK_Y + 4 : 20, st.z);
    stopHighlight.visible = true;
    if (typeof ensureTripEngine === 'function') ensureTripEngine();
    renderStopLive();
    // Stop selection glides the camera (Phase 2 stop intent): frame the stop
    // at the safe-frame center. No follow — stops don't move. Skipped in
    // street view (its own glide above), trip modes, and the cinematic.
    if (!streetView && !tripFly && !(typeof tripMode !== 'undefined' && tripMode)) {
      var _sy = st.pm ? PM_DECK_Y : 20;
      TransitionEngine.go({
        vantage: TransitionEngine.vantageForStop(st.x, _sy, st.z),
        follow: 'hold'
      });
    }
    // In street view, tapping a stop glides the camera to center it —
    // the max-zoom way of walking down the street stop by stop.
    if (streetView && !tripFly && !(typeof tripMode !== 'undefined' && tripMode)) {
      var _sv = streetVantageFor(st);
      glideTo(_sv.pos, _sv.tgt, 1100);
    }
  }
  // Next arrivals at the selected stop (2026-10-16). The stop card's
  // other live section lists vehicles on the serving routes with their
  // ping ages — which tells a waiting rider nothing about when a bus
  // reaches THIS stop. This section answers that question from the two
  // sources the data supports, in the app's honesty order: a vehicle
  // matched to a trip by the delay engine makes the row live (the trip's
  // time at this stop — empirically substituted arrL2 when present,
  // else scheduled arr — shifted by the vehicle's measured delay, the
  // same formula rideTimesFor uses, so a bus carries one consistent ETA
  // across surfaces); every other trip serving the stop today is a
  // scheduled row. Since U7 Phase B the planner timetable also
  // carries SMART scheduled trips; this card's contract is unchanged
  // (DDOT departures only), so stops whose patterns are all SMART are
  // fenced to the same named boundary they had when they sat beyond
  // the timetable's stop count (S4): SMART, QLINE, and People Mover
  // stops get the named boundary, never a fabricated time. Exception (deployed 2026-10-17): SMART
  // stops render live times from the Swiftly trip-updates payload when
  // a fresh one covers them — see the 'na' branch in renderStopArrivals
  // and the SMART TRIP UPDATES section. That payload is display-only
  // and is never an input to this function or the planner.
  function computeStopArrivals(idx, nowMs) {
    var DELAY_PROJECTION = 0.6; // rank 5 — record above rideTimesFor
    var out = { state: 'ready', rows: [] };
    if (!tripTT || !tripRaptor || !tripRaptor.serviceFor) { out.state = 'loading'; return out; }
    if (idx == null || idx < 0 || idx >= tripTT.nStops) { out.state = 'na'; return out; }
    var dp = detroitParts(nowMs);
    var dpPrev = detroitParts(nowMs - 86400000);
    var svc = tripRaptor.serviceFor(tripTT, dp.ymd, dp.dow);
    var prevSvc = tripRaptor.serviceFor(tripTT, dpPrev.ymd, dpPrev.dow);
    if (svc < 0 && prevSvc < 0) { out.state = 'nosvc'; return out; }
    var nowSec = dp.sec;
    var pats = tripTT.stopPat[idx] || [];
    // U7 Phase B fence: a stop served only by SMART patterns is out
    // of this function's coverage — return 'na' so the card renders
    // its SMART live-times rows / boundary note exactly as before the
    // merge, instead of an empty 'ready'. (Legacy timetables carry no
    // agency tags; an untagged route counts as DDOT coverage.)
    if (pats.length && tripTT.routes) {
      var anyDdot = false;
      for (var fq = 0; fq < pats.length; fq++) {
        var frec = tripTT.routes[tripTT.patterns[pats[fq][0]].route];
        if (!frec || frec.ag !== 'SMART') { anyDdot = true; break; }
      }
      if (!anyDdot) { out.state = 'na'; return out; }
    }
    var rows = [];
    for (var q = 0; q < pats.length; q++) {
      var pat = tripTT.patterns[pats[q][0]];
      var pos = pats[q][1];
      for (var ti = 0; ti < pat.trips.length; ti++) {
        var t = pat.trips[ti];
        var shift = 0;
        if (t.s !== svc) { if (t.s !== prevSvc) continue; shift = -86400; }
        var arr = t.arrL2 || t.arr;
        var eta = arr[pos] + shift;
        if (eta < nowSec - 30 || eta > nowSec + 3 * 3600) continue;
        var dstate = (typeof tripDelayState !== 'undefined') ? tripDelayState.get(t) : null;
        var isLive = !!(dstate && dstate.vehicleId && !dstate.disrupted);
        if (isLive) {
          eta += dstate.delaySec * DELAY_PROJECTION;
          if (eta < nowSec - 30) continue;
        }
        var head = t.h || '';
        if (!head && pat.stops && pat.stops.length) {
          var term = stopData && stopData[pat.stops[pat.stops.length - 1]];
          head = term ? (term.n || '') : '';
        }
        var routeRec = tripTT.routes ? tripTT.routes[pat.route] : null;
        var rowRid = routeRec ? routeRec.id : pat.route;
        // Project 13: the card presents only gate-open routes (the
        // stops layer's predicate) — a switched-off route's departures
        // do not list here, live-fused or scheduled.
        if (!routeIsOn(rowRid) || !routeNearOk(rowRid)) continue;
        rows.push({ rid: rowRid, head: head, eta: eta, live: isLive, bus: isLive ? dstate.vehicleId : null });
      }
    }
    rows.sort(function (a, b) { return a.eta - b.eta; });
    out.rows = rows.slice(0, 5);
    return out;
  }
  function renderStopArrivals() {
    var host = $('stop-arrivals'), list = $('stop-arrivals-list'), note = $('stop-arrivals-note');
    if (!host || !list || !note) return;
    if (!selectedStop) { host.hidden = true; return; }
    host.hidden = false;
    list.innerHTML = '';
    note.hidden = true;
    var idx = (stopData && selectedStop) ? stopData.indexOf(selectedStop) : -1;
    if (selectedStop.pm) {
      note.textContent = 'Arrival times are published for DDOT stops. The People Mover, SMART, and QLINE publish live positions only — see the live vehicles below.';
      note.hidden = false;
      return;
    }
    var res = computeStopArrivals(idx, Date.now());
    if (res.state === 'loading') {
      note.textContent = 'Arrival times are loading…';
      note.hidden = false;
      return;
    }
    if (res.state === 'na') {
      // Deployed 2026-10-17: a SMART stop with a fresh trip-updates
      // payload renders its live times here, replacing the boundary
      // note. Any other 'na' stop (QLINE, unknown) keeps the note.
      var tuRows = smartTuRowsForStop(selectedStop, Date.now());
      if (tuRows) {
        if (!tuRows.length) {
          note.textContent = 'SMART live times are published when a bus is on its way; no SMART trip is reporting times for this stop right now — see the live vehicles below.';
          note.hidden = false;
          return;
        }
        var nowSecTu = Date.now() / 1000;
        tuRows.forEach(function (r) {
          var row = document.createElement('div');
          row.className = 'stop-live-row';
          var dot = document.createElement('i');
          var rc = routeColors[r.rid];
          dot.style.background = rc ? '#' + rc.getHexString() : '#F2F2F2';
          row.appendChild(dot);
          var b = document.createElement('b');
          b.textContent = routeLabel(r.rid);
          row.appendChild(b);
          var tag = document.createElement('span');
          tag.className = 'arr-tag live';
          tag.textContent = 'Live';
          row.appendChild(tag);
          var t = document.createElement('span');
          var dSec = r.time - nowSecTu;
          t.textContent = dSec < 45 ? 'now' : (dSec <= 5400 ? 'in ' + Math.round(dSec / 60) + 'm' : formatClock12(r.time * 1000));
          t.title = 'Live trip update from Swiftly' + (r.bus ? ' — bus ' + r.bus : '') +
            (r.delay != null && Math.abs(r.delay) >= 45 ? ' — running ' + Math.round(Math.abs(r.delay) / 60) + ' min ' + (r.delay > 0 ? 'late' : 'early') : '');
          row.appendChild(t);
          list.appendChild(row);
        });
        note.textContent = 'Live times from SMART trip updates (Swiftly); the feed rebuilds every few minutes.';
        note.hidden = false;
        return;
      }
      note.textContent = 'Arrival times are published for DDOT stops. SMART and QLINE publish live positions only — see the live vehicles below.';
      note.hidden = false;
      return;
    }
    if (res.state === 'nosvc') {
      note.textContent = 'No DDOT service is scheduled today.';
      note.hidden = false;
      return;
    }
    if (!res.rows.length) {
      note.textContent = 'No more buses are scheduled at this stop today.';
      note.hidden = false;
      return;
    }
    var nowSec = detroitParts(Date.now()).sec;
    var anyLive = false;
    res.rows.forEach(function (r) {
      if (r.live) anyLive = true;
      var row = document.createElement('div');
      row.className = 'stop-live-row';
      var dot = document.createElement('i');
      var rc = routeColors[r.rid];
      dot.style.background = rc ? '#' + rc.getHexString() : '#F2F2F2';
      row.appendChild(dot);
      var b = document.createElement('b');
      b.textContent = routeLabel(r.rid) + (r.head ? ' · ' + r.head : '');
      row.appendChild(b);
      var tag = document.createElement('span');
      tag.className = 'arr-tag' + (r.live ? ' live' : '');
      tag.textContent = r.live ? 'Live' : 'Scheduled';
      row.appendChild(tag);
      var t = document.createElement('span');
      var dSec = r.eta - nowSec;
      t.textContent = dSec < 45 ? 'now' : (dSec <= 5400 ? 'in ' + Math.round(dSec / 60) + 'm' : tripClock(r.eta));
      t.title = 'Scheduled arrival ' + tripClock(r.eta) + (r.live ? ' — live estimate for bus ' + r.bus : '');
      row.appendChild(t);
      list.appendChild(row);
    });
    if (!anyLive) {
      note.textContent = 'Scheduled times — a live estimate replaces a row when the bus on that trip reports.';
      note.hidden = false;
    }
  }
  // Ride Along entry from the stop card's live rows (project 7,
  // Justin's order 2026-10-19): select the row's vehicle through
  // showBus — the same funnel a map tap and the Browse list use —
  // then open Ride Along, which boards the selected bus (or holds
  // the intent pending until the widget knows it, the standing
  // ridePendingVid path). No parallel boarding path. The stop card
  // is covered, not closed, so closing the ride returns through the
  // bus card to this card, exactly as the two-step flow does. A
  // stale fix changes nothing here: the ride surface carries the
  // standing STALE treatment (project 6), and the bus card's fix-age
  // line states the age (project 6, item 1).
  function rideFromStopLiveRow(v) {
    if (!v) return;
    showBus(v);
    setRideMode(true);
    var rcEl = $('ride-card');
    if (rcEl && rcEl.focus) rcEl.focus();
  }
  // Stop-card Option A (Justin's decision, 2026-10-21): distance from
  // the selected stop to a vehicle, in the map's projected meters —
  // the same projection the bus slots are placed with. Presentation
  // only: it orders the grouped live rows and names the nearest bus;
  // it is never an ETA and never leaves this card.
  function stopVehicleDistM(st, v) {
    if (!st || !v || v.lat == null || v.lon == null || !proj) return null;
    var p = project(v.lat, v.lon);
    var dx = p[0] - st.x, dz = p[1] - st.z;
    return Math.sqrt(dx * dx + dz * dz);
  }
  function formatStopDistM(d) {
    if (d == null || isNaN(d)) return '';
    if (d < 1000) return Math.max(10, Math.round(d / 10) * 10) + ' m';
    return (d / 1609.344).toFixed(1) + ' mi';
  }
  // Live arrivals on the selected stop's routes, refreshed on every poll.
  function renderStopLive() {
    // Project 13: an open card reconciles its chips on every refresh,
    // so toggling a serving route off while the card is open drops
    // that route's chip on the same applyFilters pass.
    if (selectedStop) renderStopChips(selectedStop);
    renderStopArrivals();
    var host = $('stop-live'), list = $('stop-live-list');
    if (!host || !list) return;
    renderStopSmartNote();
    if (!selectedStop || !lastVehicles || !lastVehicles.length) {
      host.hidden = true; return;
    }
    var rows = [];
    for (var i = 0; i < lastVehicles.length; i++) {
      var v = lastVehicles[i];
      // Project 13: live rows obey the same gate as the chips — a
      // bus on a switched-off route is not presented here either
      // (the map does not draw it; the card must not name it).
      if (selectedStop.r.indexOf(v.route_id) >= 0 &&
          routeIsOn(v.route_id) && routeNearOk(v.route_id)) rows.push(v);
    }
    if (!rows.length) { host.hidden = true; return; }
    host.hidden = false;
    list.innerHTML = '';
    var now = Date.now();
    // Stop-card Option A (Justin's decision, 2026-10-21): the live
    // rows group by route + headsign — one row per direction instead
    // of one row per vehicle. DDOT destinations come from the vehicle
    // record (via displayDest, as before); SMART destinations resolve
    // through the GTFS headsign join (smartHeadSignFor) and are empty
    // until the map lands, grouping those rows by route alone. The
    // row label is the settled name - number style with the headsign
    // as the name ("Mack / Moross - 730"); a group whose headsign is
    // unresolved falls back to routeLabel (itself name - number).
    // Groups order by their nearest bus; a group's row carries its
    // bus count and the nearest bus's distance from this stop.
    var groups = [], groupByKey = {};
    rows.forEach(function (v) {
      var dest = v.agency === 'smart' ? smartHeadSignFor(v) : displayDest(v);
      if (dest && dest === String(v.route_id)) dest = '';
      var key = v.route_id + '|' + dest;
      var g = groupByKey[key];
      if (!g) { g = groupByKey[key] = { route_id: v.route_id, dest: dest, vehicles: [], nearest: null, nearestD: null }; groups.push(g); }
      g.vehicles.push(v);
      var d = stopVehicleDistM(selectedStop, v);
      if (d != null && (g.nearestD == null || d < g.nearestD)) { g.nearestD = d; g.nearest = v; }
    });
    groups.forEach(function (g) { if (!g.nearest) g.nearest = g.vehicles[0]; });
    groups.sort(function (a, b) {
      var da = a.nearestD == null ? Infinity : a.nearestD;
      var db = b.nearestD == null ? Infinity : b.nearestD;
      if (da !== db) return da - db;
      return String(a.route_id).localeCompare(String(b.route_id), undefined, { numeric: true });
    });
    groups.slice(0, 5).forEach(function (g) {
      // Project 7 (2026-10-19), as amended by Option A: the row is a
      // real button — selecting it rides the group's NEAREST vehicle
      // through the same showBus funnel (see rideFromStopLiveRow).
      var v = g.nearest;
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'stop-live-row stop-live-btn';
      var dot = document.createElement('i');
      var rc = routeColors[v.route_id];
      dot.style.background = rc ? '#' + rc.getHexString() : '#F2F2F2';
      row.appendChild(dot);
      var b = document.createElement('b');
      var slDest = g.dest;
      b.textContent = slDest ? (slDest + ' - ' + g.route_id) : routeLabel(g.route_id);
      row.appendChild(b);
      // Stop tiles: the serving vehicle's number, so a rider can match
      // the row to the bus they can see. Gate: stopTilesOn.
      if (typeof stopTilesOn !== 'undefined' && stopTilesOn && v.vehicle_id) {
        var bn = document.createElement('span');
        bn.className = 'stop-live-bus';
        bn.textContent = 'Bus ' + v.vehicle_id;
        row.appendChild(bn);
      }
      var t = document.createElement('span');
      var when = v.updated_at ? new Date(v.updated_at) : null;
      var mins = (when && !isNaN(when)) ? Math.max(0, Math.round((now - when.getTime()) / 60000)) : null;
      var dTxt = formatStopDistM(g.nearestD);
      var parts = [];
      if (g.vehicles.length > 1) parts.push(g.vehicles.length + ' buses');
      if (dTxt) parts.push(dTxt);
      if (!parts.length) parts.push(mins == null ? '' : (mins < 1 ? 'just now' : mins + 'm ago'));
      t.textContent = parts.join(' · ');
      t.title = 'Nearest bus ' + (v.vehicle_id || '') +
        (mins == null ? '' : ' — ping ' + (mins < 1 ? 'just now' : mins + 'm ago'));
      row.appendChild(t);
      var go = document.createElement('span');
      go.className = 'stop-live-go';
      go.setAttribute('aria-hidden', 'true');
      go.textContent = '›';
      row.appendChild(go);
      row.setAttribute('aria-label', 'Ride along — ' + b.textContent +
        ', ' + g.vehicles.length + (g.vehicles.length === 1 ? ' bus' : ' buses') +
        (v.vehicle_id ? ', nearest bus ' + v.vehicle_id : '') + (dTxt ? ', ' + dTxt + ' away' : ''));
      row.addEventListener('click', function () { rideFromStopLiveRow(v); });
      list.appendChild(row);
    });
  }
  // A rider watching the stop card counts down in real time: refresh the
  // open card's relative times (arrival countdowns, live ping ages)
  // every 30 s between vehicle polls — visible tab and open card only,
  // no network traffic (renders from the last poll's state).
  setInterval(function () {
    if (document.hidden || !selectedStop) return;
    var card = $('stop-card');
    if (card && !card.hidden) renderStopLive();
  }, 30000);
  // Position Integrity (project 6, item 1): the same discipline for the
  // bus card — a rider watching the card watches its fix age advance
  // between polls (visible tab and open card only, no network traffic).
  setInterval(function () {
    if (document.hidden || !selectedVehicleId) return;
    var bcard = $('bus-card');
    if (bcard && !bcard.hidden) refreshBusFixAge();
  }, 30000);
  function hideStop() {
    var _hadFocus = $('stop-card').contains(document.activeElement);
    setStopSelectedColor(selectedStopIndex, false);
    selectedStopIndex = -1;
    selectedStop = null;
    $('stop-card').hidden = true;
    // Return focus to the opener when focus was inside the dialog.
    if (_hadFocus && _stopReturnFocus && _stopReturnFocus !== document.body && document.contains(_stopReturnFocus)) _stopReturnFocus.focus();
    _stopReturnFocus = null;
    stopHighlight.visible = false;
    // Restore the generic row labels now, not on the next open: the MoGo
    // path relabels them ("Station ID"/"Bikes"), and renderStopMogo's
    // non-MoGo branch is the existing restore path.
    if (typeof renderStopMogo === 'function') renderStopMogo(null);
    if (typeof renderStopPlace === 'function') renderStopPlace(null);
    exclRestore();
  }
  $('stop-close').addEventListener('click', hideStop);
  $('stop-card').addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); hideStop(); } });

  // --- trip planning (RAPTOR, scheduled times) -------------------------------
  // Phase 1: client-side RAPTOR over the compact timetable
  // (planner-timetable-<ddot>-<smart>.json: the DDOT timetable built by
  // build-timetable.py from DDOT GTFS, merged with SMART scheduled
  // service from SMART's own published GTFS — U7 Phase B).
  // Lazily imported only when the rider opens the planner; origin and
  // destination never leave the device. Every result is labeled scheduled.
  //
  // Phase 2 scaffold: live-fusion.js annotates scheduled journeys with live
  // vehicle context (per-route live counts now; delay propagation designed
  // next — see that module). Phase 3 (multimodal) is scoped in
  // raptor-concept.md; the leg model already supports it: a new leg type
  // only needs a renderer in renderTripDetail() and legPoints3D().
  var tripMode = false;
  var tripFrom = null;      // {kind:'stop', idx} | {kind:'loc', x, z}
  var tripTo = null;        // {kind:'stop', idx}
  var tripMapPick = null;   // 'from' | 'to' — the next map tap sets this field
  var tripView = 'planner'; // 'planner' | 'search'
  var tripSearchFor = 'from';
  var tripLeaveMode = 'now';// 'now' | 'at'
  var tripLeaveTime = '';
  var tripTT = null, tripRaptor = null, tripFusion = null;
  var tripJourneys = [], tripSel = -1, tripLoading = false;
  var tripLastRes = null; // last successful plan result (error-handling step 3 rollback)
  var tripAutoMinimized = false; // mobile: collapse card on first results render
  var tripFly = null;
  var tripGroup = new THREE.Group();
  tripGroup.visible = false;
  scene.add(tripGroup);
  var tripMats = []; // highlight materials, pulsed at the shared rate
  var _flyUp = new THREE.Vector3(0, 550, 0);
  var _flyDir = new THREE.Vector3();
  var SVC_NAMES = { '1': 'Sunday', '2': 'Saturday', '3': 'Weekday' };
  function tripEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function tripClock(sec) {
    sec = Math.floor(sec) % 86400;
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    var ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
  }
  function tripStopName(idx) {
    if (idx === -1) return 'Your location';
    var s = stopData && stopData[idx];
    return s ? (s.n || 'Stop ' + (s.id || '')) : 'Stop';
  }
  function tripMarker(color) {
    var m = new THREE.Mesh(
      new THREE.RingGeometry(34, 58, 40),
      new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
    );
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    scene.add(m);
    return m;
  }
  var tripOriginMark = tripMarker(0xb4b4b4); // Amber = origin
  var tripDestMark = tripMarker(0xffffff);   // Paper = destination
  var HINT_DEFAULT = 'drag&nbsp;·&nbsp;orbit&nbsp;&nbsp;&nbsp;scroll&nbsp;·&nbsp;zoom&nbsp;&nbsp;&nbsp;tap bus or stop&nbsp;·&nbsp;details&nbsp;&nbsp;&nbsp;Tab to Browse for keyboard bus search · +/− buttons zoom';

  function setTripMode(on) {
    tripMode = on;
    $('trip-btn').setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) {
      camMemTake();
      exclCover('trip');
      cancelTripFly();
      $('trip-card').classList.remove('min');
      $('trip-mini').hidden = true;
      tripAutoMinimized = false;
      // Default origin: your location when known — the standard pattern.
      if (!tripFrom && typeof userXZ !== 'undefined' && userXZ) {
        tripFrom = { kind: 'loc', x: userXZ[0], z: userXZ[1] };
      }
      showTripView('planner');
      $('trip-card').hidden = false;
      if (typeof renderBetaTiles === 'function') renderBetaTiles();
      renderTripFields();
      updateTripMarkers();
      maybeReplan();
    } else {
      cancelTripFly();
      clearPlannerFocus('planner-closed');
      clearTrip();
      exclRestore();
    }
  }
  function clearTripHighlight() {
    for (var i = tripGroup.children.length - 1; i >= 0; i--) {
      var c = tripGroup.children[i];
      tripGroup.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
    tripMats.length = 0;
    tripGroup.visible = false;
    // Clear itinerary focus: restore full opacity to all routes.
    itineraryRoutes = {};
    if (typeof applyFilters === 'function') applyFilters();
  }
  // Routes in the currently selected trip itinerary. Empty object = no trip
  // active, no dimming. Populated by highlightJourney from the journey legs.
  var itineraryRoutes = {};
  function itineraryActive() {
    return Object.keys(itineraryRoutes).length > 0;
  }
  function itineraryDims(rid) {
    return itineraryActive() && !itineraryRoutes[rid];
  }
  function clearTrip() {
    tripFrom = null; tripTo = null;
    tripMapPick = null;
    tripJourneys = []; tripSel = -1;
    tripOriginMark.visible = false;
    tripDestMark.visible = false;
    clearTripHighlight();
    $('trip-card').hidden = true;
    $('map-hint').innerHTML = HINT_DEFAULT;
  }
  function cancelTripFly() {
    if (tripFly) { tripFly = null; controls.enabled = true; }
  }
  // Map taps in trip mode: an explicit "choose on map" target wins;
  // otherwise first tap = origin, second = destination, third restarts.
  function tripStopTapped(st) {
    var idx = stopData ? stopData.indexOf(st) : -1;
    if (idx < 0) return;
    tapBuzz();
    cancelTripFly();
    if (tripMapPick === 'to' || (!tripMapPick && tripFrom && !tripTo)) {
      setTripTo({ kind: 'stop', idx: idx });
    } else {
      setTripFrom({ kind: 'stop', idx: idx });
      if (!tripMapPick) tripTo = null;
    }
    tripMapPick = null;
    if (tripView === 'search') showTripView('planner');
    else { renderTripFields(); updateTripMarkers(); }
    maybeReplan();
  }
  function setTripFrom(f) {
    tripFrom = f;
    renderTripFields();
    updateTripMarkers();
  }
  function setTripTo(t) {
    tripTo = t;
    renderTripFields();
    updateTripMarkers();
  }

  // --- Deep-link trip prefill (P0 tranche T1, 2026-10-19) ----------------
  // Contract (delivery note: t1-planner-prefill-delivery-note-2026-10-19):
  //   live-transit.html?plan&to=<lat>,<lon>&label=<text>
  //     Opens the trip planner with the destination composed. Planner
  //     destinations are stops, so the stop nearest the given coordinates
  //     becomes the destination; planArgs applies its usual coverage
  //     mapping at plan time. The label, when given, is what the
  //     destination field shows (e.g. an early vote center's name).
  //   &from=<lat>,<lon>  optional origin as a virtual location (the
  //     "Your location" model: nearest stops within 400 m seed the plan)
  //   &fromlabel=<text>  optional origin label (default "Your location")
  // Malformed or unusable params are ignored piece by piece; with no
  // usable param the load is the normal one. Without ?plan this block
  // never runs and the page behaves exactly as before.
  function planParam(name) {
    var m = new RegExp('[?&]' + name + '(=([^&#]*)|&|#|$)').exec(location.search);
    if (!m || m[2] == null) return null;
    try { return decodeURIComponent(m[2].replace(/\+/g, ' ')); } catch (e) { return null; }
  }
  function parsePlanLatLon(v) {
    if (!v) return null;
    var p = String(v).split(',');
    if (p.length !== 2) return null;
    var lat = parseFloat(p[0]), lon = parseFloat(p[1]);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return [lat, lon];
  }
  function planLabel(v) {
    if (!v) return null;
    var t = String(v).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    return t || null;
  }
  function nearestStopIdx(x, z) {
    var best = -1, bd = Infinity;
    for (var i = 0; i < stopData.length; i++) {
      var st = stopData[i];
      if (!st || st.x == null || st.z == null) continue;
      var d = Math.hypot(st.x - x, st.z - z);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function applyPlanDeepLink() {
    if (!/(^|[?&])plan(&|=|#|$)/.test(location.search)) return;
    if (!stopData || !proj) return;
    var toLL = parsePlanLatLon(planParam('to'));
    var fromLL = parsePlanLatLon(planParam('from'));
    var dest = null;
    if (toLL) {
      var tp = project(toLL[0], toLL[1]);
      var ti = nearestStopIdx(tp[0], tp[1]);
      if (ti >= 0) {
        dest = { kind: 'stop', idx: ti };
        var lb = planLabel(planParam('label'));
        if (lb) dest.label = lb;
      }
    }
    var fromObj = null;
    if (fromLL) {
      var fp = project(fromLL[0], fromLL[1]);
      fromObj = { kind: 'loc', x: fp[0], z: fp[1] };
      var fl = planLabel(planParam('fromlabel'));
      if (fl) fromObj.label = fl;
    }
    if (!dest && !fromObj) return;
    setTripMode(true);
    if (fromObj) setTripFrom(fromObj);
    if (dest) setTripTo(dest);
    renderTripFields();
    updateTripMarkers();
    maybeReplan();
  }
  function updateTripMarkers() {
    if (tripFrom) {
      var p = tripFrom.kind === 'stop' ? stopData[tripFrom.idx] : tripFrom;
      if (p) { tripOriginMark.position.set(p.x, 20, p.z); tripOriginMark.visible = true; }
      else tripOriginMark.visible = false;
    } else tripOriginMark.visible = false;
    if (tripTo && tripTo.kind === 'stop' && stopData[tripTo.idx]) {
      var s = stopData[tripTo.idx];
      tripDestMark.position.set(s.x, 20, s.z);
      tripDestMark.visible = true;
    } else tripDestMark.visible = false;
  }
  function renderTripFields() {
    $('trip-from-label').textContent = tripFrom
      ? (tripFrom.kind === 'loc' ? (tripFrom.label || 'Your location') : tripStopName(tripFrom.idx)) : 'From';
    $('trip-from-label').classList.toggle('placeholder', !tripFrom);
    $('trip-to-label').textContent = tripTo ? (tripTo.label || tripStopName(tripTo.idx)) : 'Where to?';
    $('trip-to-label').classList.toggle('placeholder', !tripTo);
    $('trip-now-btn').setAttribute('aria-pressed', tripLeaveMode === 'now' ? 'true' : 'false');
    if (tripLeaveMode === 'now') $('trip-time-input').value = '';
  }
  function showTripView(v) {
    tripView = v;
    $('trip-planner').hidden = v !== 'planner';
    $('trip-search').hidden = v !== 'search';
    if (v === 'search') {
      var inp = $('trip-search-input');
      inp.value = '';
      renderTripSearchOpts();
      renderTripSearchResults('');
      setTimeout(function () { inp.focus(); }, 50);
    }
  }
  function openTripSearch(forField) {
    tripSearchFor = forField;
    tapBuzz();
    showTripView('search');
  }
  function renderTripSearchOpts() {
    var host = $('trip-search-opts');
    host.innerHTML = '';
    if (tripSearchFor === 'from') {
      var loc = document.createElement('button');
      loc.className = 'trip-search-opt';
      var hasLoc = (typeof userXZ !== 'undefined' && userXZ);
      loc.innerHTML = '<b>' + (hasLoc ? 'Use my location' : 'Locate me') + '</b><span>' +
        (hasLoc ? 'nearest stops within a short walk' : 'finds your position first') + '</span>';
      loc.addEventListener('click', function () {
        if (typeof userXZ !== 'undefined' && userXZ) {
          setTripFrom({ kind: 'loc', x: userXZ[0], z: userXZ[1] });
          showTripView('planner');
          renderTripFields(); updateTripMarkers(); maybeReplan();
        } else {
          var lb = $('view-locate');
          if (lb) lb.click();
          showToast('Locating… tap "Use my location" again once found.');
        }
      });
      host.appendChild(loc);
    }
    var map = document.createElement('button');
    map.className = 'trip-search-opt';
    map.innerHTML = '<b>Choose on map</b><span>tap a stop in the 3D view</span>';
    map.addEventListener('click', function () {
      tripMapPick = tripSearchFor;
      showTripView('planner');
      renderTripFields();
      $('map-hint').innerHTML = 'tap a stop for <b>' +
        (tripSearchFor === 'from' ? 'origin' : 'destination') + '</b>';
    });
    host.appendChild(map);
  }
  function searchStops(q) {
    q = (q || '').trim().toLowerCase();
    if (q.length < 2 || !stopData) return [];
    var seen = {}, out = [];
    for (var i = 0; i < stopData.length; i++) {
      var s = stopData[i];
      var n = (s.n || '').toLowerCase();
      if (n.indexOf(q) < 0) continue;
      var e = seen[n];
      if (e) {
        e.count++;
        if ((s.r || []).length > (e.stop.r || []).length) { e.stop = s; e.idx = i; }
        continue;
      }
      e = { stop: s, idx: i, count: 1, prefix: n.indexOf(q) === 0 };
      seen[n] = e;
      out.push(e);
    }
    out.sort(function (a, b) {
      return (b.prefix - a.prefix) || (b.count - a.count) || ((b.stop.r || []).length - (a.stop.r || []).length);
    });
    return out.slice(0, 8);
  }
  function renderTripSearchResults(q) {
    var host = $('trip-search-results');
    host.innerHTML = '';
    var hits = searchStops(q);
    if (!hits.length) {
      if ((q || '').trim().length >= 2) {
        host.innerHTML = '<p class="trip-note">No stops match. Try a street or landmark name.</p>';
      }
      return;
    }
    hits.forEach(function (h) {
      var b = document.createElement('button');
      b.className = 'trip-search-hit';
      var t = document.createElement('b');
      t.textContent = h.stop.n || 'Stop';
      b.appendChild(t);
      var r = document.createElement('span');
      r.textContent = (h.stop.r || []).slice(0, 4).map(routeLabel).join(' · ') + ((h.stop.r || []).length > 4 ? ' +' + ((h.stop.r || []).length - 4) : '');
      b.appendChild(r);
      b.addEventListener('click', function () {
        tapBuzz();
        var val = { kind: 'stop', idx: h.idx };
        if (tripSearchFor === 'from') setTripFrom(val); else setTripTo(val);
        showTripView('planner');
        renderTripFields(); updateTripMarkers(); maybeReplan();
      });
      host.appendChild(b);
    });
  }
  function tripSeeds() {
    if (!tripFrom) return [];
    if (tripFrom.kind === 'stop') return [{ stop: tripFrom.idx, walk: 0 }];
    // Virtual origin: nearest stops within a 400 m walk of your position.
    var seeds = [];
    for (var i = 0; i < stopData.length; i++) {
      var s = stopData[i];
      var d = Math.hypot(s.x - tripFrom.x, s.z - tripFrom.z);
      if (d <= 400) seeds.push({ stop: i, walk: Math.max(60, Math.round(d / 1.4)) });
    }
    seeds.sort(function (a, b) { return a.walk - b.walk; });
    return seeds.slice(0, 12);
  }
  // The scheduled timetable covers only the DDOT segment of the merged
  // stop registry: buildIndex derives tt.nStops from the timetable
  // (5,116) while the registry carries 10,583 records (DDOT stops, the
  // SMART tombstone segment, then QLINE stops). A QLINE stop can
  // therefore never be a planner endpoint as-is, and plan() fails
  // silently for one. Map an out-of-coverage stop to the nearest
  // covered stop within 400 m — stops at one intersection sit metres
  // apart — or return -1 when no covered stop is that close.
  function coveredStopIdx(idx, tt) {
    if (idx == null || idx < 0) return -1;
    if (!tt || idx < tt.nStops) return idx;
    var s = stopData && stopData[idx];
    if (!s) return -1;
    var best = -1, bd = 400;
    for (var i = 0; i < tt.nStops; i++) {
      var t = stopData[i];
      if (!t) continue;
      var d = Math.hypot(t.x - s.x, t.z - s.z);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  // Planner arguments with endpoint coverage applied. Returns null when
  // an endpoint is out of coverage with no covered stop within 400 m.
  function planArgs(tt) {
    var dest = coveredStopIdx(tripTo.idx, tt);
    if (dest < 0) return null;
    var seeds;
    if (tripFrom.kind === 'stop') {
      var o = coveredStopIdx(tripFrom.idx, tt);
      if (o < 0) return null;
      var w = 0;
      if (o !== tripFrom.idx) {
        var a = stopData[tripFrom.idx], b = stopData[o];
        w = Math.max(60, Math.round(Math.hypot(a.x - b.x, a.z - b.z) / 1.4));
      }
      seeds = [{ stop: o, walk: w }];
    } else {
      seeds = tripSeeds();
    }
    return { seeds: seeds, dest: dest };
  }
  function renderTripUncovered() {
    var host = $('trip-results');
    host.innerHTML = '';
    var none = document.createElement('p');
    none.className = 'trip-note';
    none.textContent = 'One of these stops is not on a DDOT or SMART route, and no covered stop is within a short walk of it. The scheduled planner covers DDOT and SMART scheduled routes; QLINE stops share the map and the stop search.';
    host.appendChild(none);
    announceSr(none.textContent);
  }
  function tripWhen() {
    if (tripLeaveMode === 'at' && tripLeaveTime) {
      var p = tripLeaveTime.split(':');
      var d = new Date();
      d.setHours(parseInt(p[0], 10) || 0, parseInt(p[1], 10) || 0, 0, 0);
      return d;
    }
    return new Date();
  }
  function maybeReplan() {
    if (tripMode && tripFrom && tripTo && !tripLoading) runTripPlan();
    else if (tripMode && (!tripFrom || !tripTo)) {
      tripJourneys = []; tripSel = -1;
      clearTripHighlight();
      renderTripEmpty();
    }
  }
  function renderTripEmpty() {
    var host = $('trip-results');
    host.innerHTML = '<p class="trip-note">Pick an origin and destination to see scheduled trips.</p>';
  }
  function mergeWalkLegs(legs) {
    var out = [];
    legs.forEach(function (l) {
      var p = out[out.length - 1];
      if (l.type === 'walk' && p && p.type === 'walk') { p.to = l.to; p.secs += l.secs; }
      else out.push(Object.assign({}, l));
    });
    return out;
  }
  function runTripPlan() {
    if (tripLoading) return;
    tripLoading = true;
    tapBuzz();
    cancelTripFly();
    $('trip-prov').textContent = 'scheduled';
    var host = $('trip-results');
    host.innerHTML = '<p class="trip-note">Planning…</p>';
    // Error-handling step 3 (§4.3): snapshot the planner's commit state
    // before planning. On failure or budget exhaustion the snapshot is
    // restored and the previous results re-rendered — a failed plan
    // never blanks the card or wedges tripLoading.
    var snap = {
      journeys: tripJourneys, sel: tripSel, res: tripLastRes,
      dismissedSig: guidanceDismissedSig
    };
    function rollbackPlan() {
      tripJourneys = snap.journeys;
      tripSel = snap.sel;
      guidanceDismissedSig = snap.dismissedSig;
    }
    function rollbackNote(innerHtml) {
      rollbackPlan();
      if (snap.res && snap.journeys.length) {
        renderTripResults(snap.res);
        var p = document.createElement('p');
        p.className = 'trip-note';
        p.innerHTML = innerHtml;
        host.insertBefore(p, host.firstChild);
      } else {
        host.innerHTML = '<p class="trip-note">' + innerHtml + '</p>';
      }
    }
    var go = function (R) {
      tripRaptor = R;
      var loaded = tripTT ? Promise.resolve(tripTT)
        : R.loadTimetable('https://www.detroitautomationacademy.com/planner-timetable-S1000182-S1000147.json?v=' + STAMP).then(function (tt) { ltAssertPairing(R, tt); tripTT = tt; return tt; });
      var when = tripWhen();
      var oF = tripFrom, oT = tripTo; // capture; ignore if the user moved on
      return loaded.then(function (tt) {
        if (oF !== tripFrom || oT !== tripTo) return; // stale
        var args = planArgs(tt);
        if (!args) {
          tripJourneys = []; tripSel = -1;
          clearTripHighlight();
          renderTripUncovered();
          return;
        }
        var res = R.plan(tt, args.seeds, args.dest, when, { budgetMs: 750 });
        if (oF !== tripFrom || oT !== tripTo) return; // stale
        if (res.meta && res.meta.reason === 'budget') {
          // Budget exhausted (§4.3): restore the previous results and say
          // so — never present an empty plan as if none existed.
          errLog('planner', 'user plan budget exhausted (750 ms)');
          rollbackNote('That trip is taking too long to plan. ' +
            'Try a nearer destination, or check your connection and try again.');
          return;
        }
        tripJourneys = res.journeys;
        tripSel = tripJourneys.length ? 0 : -1;
        applyTripFusion();
        renderTripResults(res);
        tripLastRes = res;
        unpausePlanner(); // a successful user plan lifts the step-2 pause
        scrollTripDetailIntoView();
        if (tripSel >= 0) { highlightJourney(tripJourneys[0]); frameJourney(tripJourneys[0]); }
        else clearTripHighlight();
      });
    };
    var boot = (tripRaptor && tripFusion) ? Promise.resolve({ R: tripRaptor, F: tripFusion })
      : Promise.all([
          tripRaptor ? Promise.resolve(tripRaptor) : import('./raptor-v2.js?v=' + STAMP),
          tripFusion ? Promise.resolve(tripFusion) : import('./live-fusion.js?v=' + STAMP)
        ]).then(function (ms) { return { R: ms[0].default || ms[0], F: ms[1].default || ms[1] }; })
        .then(function (m) { tripFusion = m.F; return m; });
    // Note: raptor.js uses named exports; the .default fallback keeps this
    // working if the module shape ever changes.
    boot.then(function (m) { return go(m.R); }).catch(function (err) {
      // Step 3 rollback: a failed plan restores the previous results
      // instead of leaving the card blank behind the error note.
      errLog('planner', 'user plan failed: ' + ((err && err.message) || String(err)), err);
      rollbackNote('Could not plan the trip (' +
        tripEsc((err && err.message) || String(err)) + '). Check your connection and try again.');
    }).finally(function () { tripLoading = false; });
  }
  function applyTripFusion() {
    if (!tripFusion || !tripJourneys.length) return;
    try { tripFusion.fuseJourneys(tripJourneys, (typeof lastVehicles !== 'undefined' && lastVehicles) || []); }
    catch (e) { /* fusion never breaks planning */ }
  }
  // Called from the vehicle poll so live counts stay fresh while a trip is open.
  function refreshTripFusion() {
    if (!tripMode || !tripJourneys.length || !tripFusion) return;
    applyTripFusion();
    if (tripSel >= 0) renderTripDetail();
  }
  // Phase 2b-i: quietly re-plan "leave now" queries each poll so the card
  // reflects fresh delays. "Depart at" queries are fixed in time and keep
  // their original plan. Selection is preserved when the option survives.
  function replanLive() {
    if (!tripMode || !tripJourneys.length || !tripRaptor || !tripTT || tripLoading) return;
    try {
      var args = planArgs(tripTT);
      if (!args) return; // endpoint out of coverage: keep the current results
      var res = tripRaptor.plan(tripTT, args.seeds, args.dest, new Date(), { budgetMs: 250 });
      if (res.meta && res.meta.reason === 'budget') {
        // Step 3 (§4.3): a background re-plan that exhausts its budget
        // keeps the current results silently — never blanks the card.
        errLog('planner', 'background re-plan budget exhausted (250 ms)');
        return;
      }
      var sig = tripSel >= 0 && tripJourneys[tripSel] ? journeySig(tripJourneys[tripSel]) : null;
      tripJourneys = res.journeys;
      tripSel = -1;
      if (sig) {
        for (var i = 0; i < tripJourneys.length; i++) {
          if (journeySig(tripJourneys[i]) === sig) { tripSel = i; break; }
        }
      }
      if (tripSel < 0) tripSel = tripJourneys.length ? 0 : -1;
      applyTripFusion();
      renderTripResults(res);
      tripLastRes = res;
      if (tripSel >= 0) highlightJourney(tripJourneys[tripSel]); else clearTripHighlight();
    } catch (e) { notePlannerFault(e, 'replan'); /* live refresh never breaks the card — and now it reports */ }
  }
  function journeySig(j) {
    return j.legs.map(function (l) {
      return l.type === 'bus' ? ('b' + l.routeId + '@' + l.board + '>' + l.alight) : 'w';
    }).join('|');
  }
  // --- Phase 2c: active ride guidance -----------------------------------------
  // Advisory banners driven by the selected journey + live vehicle positions.
  // Framed around the BUS (what we can see), never the rider (what we can't).
  // Triggers: "board soon" (bus ≤2 min from boarding stop), "alight next"
  // (1 stop out), missed transfer → auto-replan from the live position.
  var guidanceDismissedSig = null;
  var missedCooldownUntil = 0;

  function guidanceVehicle(leg) {
    if (!leg.tripRef) return null;
    var st = tripDelayState.get(leg.tripRef);
    if (!st || st.disrupted) return null;
    var tr = busTrackers[st.vehicleId];
    if (!tr || !tr.arc || !tr.vehicle) return null;
    return tr;
  }
  function stopsToAlight(leg, tr, arcMap) {
    var trip = leg.tripRef;
    var pts = [];
    for (var k = 0; k < trip.stops.length; k++) {
      var sk = arcMap[ttStopId(trip.stops[k])];
      if (sk != null) pts.push({ stop: String(trip.stops[k]), s: sk });
    }
    var vi = -1, ai = -1;
    for (var q = 0; q < pts.length; q++) {
      if (pts[q].s <= tr.s + 30) vi = q;
      if (pts[q].stop === String(leg.alight)) ai = q;
    }
    if (vi < 0 || ai < 0) return -1;
    return ai - vi;
  }
  function fmtEta(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + 's';
    var m = Math.round(sec / 60);
    return m + ' min';
  }
  // Live-adjusted leg time: refresh the plan-time delay with the current one.
  function liveLegTime(leg, which) {
    var DELAY_PROJECTION = 0.6; // rank 5 — record above rideTimesFor
    var base = which === 'board' ? leg.boardSec : leg.alightSec;
    if (!leg.tripRef) return base;
    var st = tripDelayState.get(leg.tripRef);
    if (st && !st.disrupted) return base - (leg.delaySec || 0) * DELAY_PROJECTION + st.delaySec * DELAY_PROJECTION;
    return base;
  }
  function guidanceForLeg(leg) {
    var tr = guidanceVehicle(leg);
    if (!tr) return null;
    // Route Reverse: a layover-bound leg's bus is standing at the
    // terminal — guidance names the departure it will make, not a
    // moving approach (specification section 2.6).
    var lst = leg.tripRef ? tripDelayState.get(leg.tripRef) : null;
    if (lst && lst.layover) {
      var ltrip = leg.tripRef;
      var lterm = stopData && stopData[ltrip.stops[0]];
      return { kind: 'board', text: 'Route ' + routeLabel(leg.routeId) + ' \u2014 your bus is at ' +
        (lterm ? (lterm.n || 'the terminal') : 'the terminal') + ' and leaves at ' +
        tripClock((ltrip.depL2 || ltrip.dep)[0]) + '.' };
    } // no live bus on this trip: no guidance, no fiction
    var arcMap = stopArcMap(leg.routeId, tr.pathIdx);
    var sBoard = arcMap[ttStopId(leg.board)], sAlight = arcMap[ttStopId(leg.alight)];
    if (sBoard == null || sAlight == null) return null;
    var speed = Math.max(tr.speedMps, 1.5);
    if (tr.s < sBoard - 50) {
      var eta = (sBoard - tr.s) / speed;
      if (eta <= 150) {
        return { kind: 'board', text: 'Route ' + routeLabel(leg.routeId) + ' reaches ' +
          tripStopName(leg.board) + ' in ~' + fmtEta(eta) + ' — be ready to board.' };
      }
      return null;
    }
    var left = stopsToAlight(leg, tr, arcMap);
    if (left < 0) return null;
    if (left === 0) return 'passed';
    if (left === 1) {
      return { kind: 'alight', urgent: true, text: 'Route ' + routeLabel(leg.routeId) +
        ' arriving at ' + tripStopName(leg.alight) + ' — get off at the next stop.' };
    }
    return { kind: 'riding', text: 'Route ' + routeLabel(leg.routeId) + ' — ' + left +
      ' stops to ' + tripStopName(leg.alight) + '.' };
  }
  function checkMissedTransfer(j, busLegs) {
    for (var i = 0; i + 1 < busLegs.length; i++) {
      var leg1 = busLegs[i], leg2 = busLegs[i + 1];
      var alight1 = liveLegTime(leg1, 'alight');
      var board2 = liveLegTime(leg2, 'board');
      // Walk between the legs comes from the journey's own walk legs.
      var walkSec = 0, inWalk = false;
      for (var k = 0; k < j.legs.length; k++) {
        var l = j.legs[k];
        if (l === leg1) { inWalk = true; continue; }
        if (l === leg2) break;
        if (inWalk && l.type === 'walk') walkSec += l.secs || 0;
      }
      if (board2 < alight1 + walkSec + 60) {
        return { leg1: leg1, leg2: leg2, alightStop: leg1.alight };
      }
    }
    return null;
  }
  function showGuidanceBanner(kind, text, urgent, done) {
    var banner = $('trip-guidance');
    if (!banner) return;
    banner.innerHTML = '';
    banner.className = urgent ? 'urgent' : (done ? 'done' : '');
    banner.hidden = false;
    // Urgent guidance (alight-next) must be seen: expand a minimized card.
    // A rider must not miss their stop because the card was collapsed.
    if (urgent) {
      var tc = $('trip-card');
      if (tc && tc.classList.contains('min')) {
        tc.classList.remove('min');
        $('trip-mini').hidden = true;
      }
    }
    var dot = document.createElement('b');
    dot.textContent = kind === 'alight' ? '◉' : (kind === 'missed' ? '⚠' : '●');
    dot.style.color = urgent ? '#8A8A8A' : '#B4B4B4';
    banner.appendChild(dot);
    var sp = document.createElement('span');
    sp.textContent = text;
    banner.appendChild(sp);
    var x = document.createElement('button');
    x.textContent = '×';
    x.setAttribute('aria-label', 'Dismiss guidance');
    x.addEventListener('click', function () {
      if (tripSel >= 0 && tripJourneys[tripSel]) guidanceDismissedSig = journeySig(tripJourneys[tripSel]);
      banner.hidden = true;
    });
    banner.appendChild(x);
  }
  function hideGuidanceBanner() {
    var banner = $('trip-guidance');
    if (banner) { banner.hidden = true; }
  }
  // Replan from the rider's live position: the bus they're on, else GPS,
  // else the missed leg's alighting stop.
  function replanFromLive(missed) {
    var tr = guidanceVehicle(missed.leg1);
    if (tr && tr.vehicle && tr.vehicle.x != null) {
      tripFrom = { kind: 'loc', x: tr.vehicle.x, z: tr.vehicle.z };
    } else if (youMarker.group.visible) {
      tripFrom = { kind: 'loc', x: youMarker.group.position.x, z: youMarker.group.position.z };
    } else {
      var sd = stopData[missed.alightStop];
      tripFrom = sd ? { kind: 'stop', idx: missed.alightStop } : tripFrom;
    }
    renderTripFields();
    updateTripMarkers();
    runTripPlan();
  }
  function updateGuidance() {
    if (!tripMode || !tripJourneys.length || tripSel < 0) { hideGuidanceBanner(); return; }
    if (tripLeaveMode === 'at' && tripLeaveTime) { hideGuidanceBanner(); return; }
    var j = tripJourneys[tripSel];
    var sig = journeySig(j);
    var dismissed = (guidanceDismissedSig === sig);
    var busLegs = j.legs.filter(function (l) { return l.type === 'bus'; });
    if (!busLegs.length) { hideGuidanceBanner(); return; }
    var finalPassed = false; // step 2 (§4.4): set when the FINAL leg reports 'passed'
    // Missed transfer: highest priority.
    var missed = checkMissedTransfer(j, busLegs);
    if (missed && Date.now() > missedCooldownUntil) {
      missedCooldownUntil = Date.now() + 5 * 60 * 1000;
      guidanceDismissedSig = null;
      showGuidanceBanner('missed',
        'Missed the Route ' + routeLabel(missed.leg2.routeId) + ' connection — replanned from your current position.',
        true, false);
      replanFromLive(missed);
      return;
    }
    for (var i = 0; i < busLegs.length; i++) {
      var g = guidanceForLeg(busLegs[i]);
      if (g === 'passed') { if (i === busLegs.length - 1) finalPassed = true; continue; }
      // Urgent guidance (get off at the next stop) always shows: a dismissal
      // must never suppress a safety-critical banner. Dismissal only quiets
      // non-urgent guidance for this journey.
      if (g) {
        if (dismissed && !g.urgent) { hideGuidanceBanner(); return; }
        showGuidanceBanner(g.kind, g.text, !!g.urgent, false);
        return;
      }
    }
    if (dismissed) { hideGuidanceBanner(); return; }
    // Step 2 (§4.4, guidance honesty): "arrived" requires positive
    // evidence — the final leg's bus passed the alight stop, or the
    // live-adjusted alight time is more than 120 s in the past. The
    // previous bytes fell through to 'You have arrived.' whenever no
    // leg yielded live guidance, which is how a 6:51 PM departure wore
    // an arrival banner at 6:52 PM (2026-10-16 18:52 freeze report).
    // No guidance is no information; the honest surface is silence.
    var arrived = finalPassed;
    if (!arrived) {
      var lastLeg = busLegs[busLegs.length - 1];
      if (detroitParts(Date.now()).sec > liveLegTime(lastLeg, 'alight') + 120) arrived = true;
    }
    if (arrived) showGuidanceBanner('done', 'You have arrived.', false, true);
    else hideGuidanceBanner();
  }
  // Bring the selected journey's step list into view inside the results
  // panel (2026-10-16): the detail renders BELOW the option cards, so on
  // a phone it began under the panel's fold — a rider who planned or
  // tapped an option saw cards, not directions, and had to discover the
  // scroll. Called only on user-initiated renders and option taps, never
  // on the background live re-plan, which must not move the panel under
  // the reader.
  function scrollTripDetailIntoView() {
    var det = $('trip-detail');
    if (det && det.scrollIntoView) {
      try { det.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* no-op */ }
    }
  }
  function renderTripResults(res) {
    var host = $('trip-results');
    host.innerHTML = '';
    refreshTripMini();
    // Small screens: default to the minimized bar on the first results render
    // so the map stays usable. Never re-collapse after the user expanded it.
    if (!tripAutoMinimized && tripJourneys.length &&
        window.matchMedia('(max-width: 640px)').matches) {
      tripAutoMinimized = true;
      $('trip-mini-label').textContent = tripMiniLabel();
      $('trip-mini').hidden = false;
      $('trip-card').classList.add('min');
    }
    var meta = document.createElement('p');
    meta.className = 'trip-note';
    var svcName = res.meta.service && SVC_NAMES[res.meta.service] ? SVC_NAMES[res.meta.service] : 'DDOT';
    var whenLbl = tripLeaveMode === 'at' && tripLeaveTime ? 'depart ' + tripLeaveTime : 'leave now';
    var provMode = 'scheduled';
    tripJourneys.forEach(function (j) {
      j.legs.forEach(function (l) {
        if (l.type !== 'bus') return;
        if (l.provenance === 'live') provMode = 'live';
        else if (l.provenance === 'empirical' && provMode === 'scheduled') provMode = 'empirical';
      });
    });
    var provLbl = provMode === 'live' ? 'Live delays' : (provMode === 'empirical' ? 'Typical times' : 'Scheduled times');
    meta.textContent = provLbl + ' · ' + svcName + ' service · ' + whenLbl + ' · feed ' + (res.meta.feedVersion || '');
    var provEl = $('trip-prov');
    if (provEl) provEl.textContent = provMode === 'live' ? 'live' : (provMode === 'empirical' ? 'typical' : 'scheduled');
    host.appendChild(meta);
    if (!tripJourneys.length) {
      var none = document.createElement('p');
      none.className = 'trip-note';
      none.textContent = res.meta.reason === 'no-service'
        ? 'No scheduled service at this time.'
        : res.meta.reason === 'no-origin'
          ? 'No DDOT or SMART stop is within a short walk of the start point. The scheduled planner covers DDOT and SMART scheduled routes.'
          : 'No scheduled trip found between these stops right now. Try a different pair or time.';
      host.appendChild(none);
      announceSr(none.textContent);
      return;
    }
    var list = document.createElement('div');
    list.id = 'trip-opt-list';
    tripJourneys.forEach(function (j, i) { list.appendChild(tripOptionEl(j, i)); });
    host.appendChild(list);
    var det = document.createElement('div');
    det.id = 'trip-detail';
    host.appendChild(det);
    renderTripDetail();
    announceSr(tripJourneys.length + (tripJourneys.length === 1 ? ' scheduled trip' : ' scheduled trips') + ' found. First trip: ' + tripJourneys[0].durationMin + ' minutes, ' + tripJourneys[0].departClock + ' to ' + tripJourneys[0].arriveClock + '.');
  }
  function tripOptionEl(j, i) {
    var b = document.createElement('button');
    b.className = 'trip-opt' + (i === tripSel ? ' sel' : '');
    b.setAttribute('aria-pressed', i === tripSel ? 'true' : 'false');
    var top = document.createElement('div');
    top.className = 'trip-opt-top';
    var mins = document.createElement('b');
    mins.textContent = j.durationMin + ' min';
    top.appendChild(mins);
    var times = document.createElement('span');
    times.textContent = j.departClock + ' → ' + j.arriveClock;
    top.appendChild(times);
    b.appendChild(top);
    var sub = document.createElement('div');
    sub.className = 'trip-opt-sub';
    var liveN = j.legs.reduce(function (n, l) { return n + (l.liveVehicles || 0); }, 0);
    var jProv = 'scheduled';
    j.legs.forEach(function (l) {
      if (l.type !== 'bus') return;
      if (l.provenance === 'live') jProv = 'live';
      else if (l.provenance === 'empirical' && jProv === 'scheduled') jProv = 'empirical';
    });
    var jProvLbl = jProv === 'live' ? 'live delays' : (jProv === 'empirical' ? 'typical times' : 'scheduled');
    if (j.legs.some(function (l) { return l.disrupted; })) jProvLbl += ' · disrupted';
    sub.textContent = (j.nBus === 0 ? 'Walk' : (j.transfers === 0 ? 'Direct' : j.transfers + (j.transfers === 1 ? ' transfer' : ' transfers'))) +
      ' · ' + j.walkMin + ' min walk' + (liveN > 0 ? ' · ' + liveN + ' live' : '') + ' · ' + jProvLbl;
    b.appendChild(sub);
    var legs = document.createElement('div');
    legs.className = 'trip-legs';
    var clockSec = (typeof j.departSec === 'number') ? j.departSec : null;
    mergeWalkLegs(j.legs).forEach(function (l) {
      if (l.type === 'bus' && clockSec !== null && typeof l.boardSec === 'number') {
        var waitMin = Math.round((l.boardSec - clockSec) / 60);
        if (waitMin >= 1) {
          var wchip = document.createElement('span');
          wchip.className = 'trip-leg-chip';
          var wb = document.createElement('b');
          wb.className = 'walk';
          wb.textContent = 'wait ' + waitMin + 'm';
          wchip.appendChild(wb);
          legs.appendChild(wchip);
        }
      }
      var chip = document.createElement('span');
      chip.className = 'trip-leg-chip';
      if (l.type === 'bus') {
        var dot = document.createElement('i');
        dot.style.background = l.color || '#F2F2F2';
        chip.appendChild(dot);
        var lbl = document.createElement('b');
        lbl.textContent = l.agency === 'SMART' ? 'SMART ' + l.routeId : routeLabel(l.routeId);
        chip.appendChild(lbl);
      } else {
        var w = document.createElement('b');
        w.className = 'walk';
        w.textContent = 'walk ' + Math.max(1, Math.round(l.secs / 60)) + 'm';
        chip.appendChild(w);
      }
      legs.appendChild(chip);
      if (clockSec !== null) {
        clockSec = (l.type === 'bus' && typeof l.alightSec === 'number')
          ? l.alightSec : clockSec + (l.secs || 0);
      }
    });
    b.appendChild(legs);
    b.addEventListener('click', function () {
      tripSel = i;
      tapBuzz();
      var opts = document.querySelectorAll('#trip-opt-list .trip-opt');
      for (var k = 0; k < opts.length; k++) {
        opts[k].classList.toggle('sel', k === tripSel);
        opts[k].setAttribute('aria-pressed', k === tripSel ? 'true' : 'false');
      }
      renderTripDetail();
      scrollTripDetailIntoView();
      highlightJourney(tripJourneys[i]);
      flyJourney(tripJourneys[i]); // the perspective is the interface
    });
    return b;
  }
  // Phase 2b-i: human-readable provenance for a bus leg.
  function tripProvLabel(l) {
    if (l.disrupted) return 'disrupted · times as scheduled';
    if (l.provenance === 'live') {
      var dMin = Math.round(l.delaySec / 60);
      var dTxt = Math.abs(l.delaySec) <= 60 ? 'on time'
        : (dMin > 0 ? '+' + dMin + ' min late' : dMin + ' min early');
      // Age is the vehicle's GPS fix age (falls back to the delay computation
      // time when the fix stamp is unavailable).
      var ageMs = l.delayFixStamp || l.delayStamp || Date.now();
      var ageS = Math.max(0, Math.round((Date.now() - ageMs) / 1000));
      var ageTxt = ageS < 90 ? ageS + 's' : Math.round(ageS / 60) + ' min';
      return dTxt + ' · live ' + ageTxt + ' old';
    }
    if (l.provenance === 'empirical') return 'typical time';
    return 'scheduled';
  }
  function renderTripDetail() {
    var det = $('trip-detail');
    if (!det) return;
    det.innerHTML = '';
    if (tripSel < 0 || !tripJourneys[tripSel]) return;
    // Service alerts (Map-Native): a NO_SERVICE effect on any leg's route
    // is stated at the top of the itinerary; every alert on a leg's route
    // also gets a "What changed" line on the leg itself, and the leg row
    // takes the vocabulary's left-border treatment. The planner informs —
    // it never silently reroutes around an alert.
    if (typeof alertsForRoute === 'function') {
      var topAlert = null, topRid = null;
      mergeWalkLegs(tripJourneys[tripSel].legs).forEach(function (l0) {
        if (l0.type !== 'bus' || topAlert) return;
        alertsForRoute(l0.routeId).forEach(function (a) {
          if (!topAlert && a.effect === 'NO_SERVICE') { topAlert = a; topRid = l0.routeId; }
        });
      });
      if (topAlert) {
        var ban = document.createElement('div');
        ban.className = 'trip-alert-top';
        ban.textContent = '✕ No service on ' + routeLabel(topRid) + ': ' + topAlert.header +
          (topAlert.kind === 'planned' ? ' (planned notice)' : '') +
          ' — this itinerary uses that route; the leg below states what changed.';
        det.appendChild(ban);
      }
    }
    // Passes (project 24 deep-link floor): a journey with a DDOT or SMART
    // bus leg is covered by a Dart pass — one line at the top of the
    // itinerary pointing at the Passes section. No price claim, no
    // purchase claim; the section carries the verified catalog.
    var dartCovered = mergeWalkLegs(tripJourneys[tripSel].legs).some(function (l) {
      if (l.type !== 'bus' || !l.routeId) return false;
      var r = (typeof routeById !== 'undefined') ? routeById[l.routeId] : null;
      return !!r && r.group !== 'qline';
    });
    if (dartCovered) {
      var passLine = document.createElement('div');
      passLine.className = 'trip-pass-line';
      passLine.textContent = 'This trip is covered by a Dart pass \u2014 ';
      var passBtn = document.createElement('button');
      passBtn.type = 'button';
      passBtn.className = 'trip-pass-link';
      passBtn.textContent = 'see Passes';
      passBtn.addEventListener('click', function () { openPasses(); });
      passLine.appendChild(passBtn);
      det.appendChild(passLine);
    }
    mergeWalkLegs(tripJourneys[tripSel].legs).forEach(function (l) {
      var row = document.createElement('div');
      row.className = 'trip-leg-row';
      var dot = document.createElement('i');
      var body = document.createElement('div');
      if (l.type === 'bus') {
        dot.style.background = l.color || '#F2F2F2';
        var t = document.createElement('b');
        t.textContent = (l.agency === 'SMART' ? 'SMART ' + l.routeId : routeLabel(l.routeId)) + (l.headsign ? ' · ' + l.headsign : '');
        body.appendChild(t);
        var s = document.createElement('span');
        s.textContent = tripStopName(l.board) + ' → ' + tripStopName(l.alight);
        body.appendChild(s);
        var tm = document.createElement('span');
        tm.className = 'trip-leg-time';
        tm.textContent = tripClock(l.boardSec) + ' → ' + tripClock(l.alightSec) + ' · ' + tripProvLabel(l) +
          (l.interp ? ' · estimated' : '') + (l.liveVehicles > 0 ? ' · ' + l.liveVehicles + ' live' : '');
        body.appendChild(tm);
        if (l.provenance === 'live' || l.disrupted) {
          var badge = document.createElement('span');
          badge.className = l.disrupted ? 'trip-disrupted-badge' : 'trip-live-badge';
          badge.textContent = l.disrupted ? 'Disrupted' : 'Live';
          body.appendChild(badge);
        }
        if (typeof alertsForRoute === 'function' && typeof alertWhatChanged === 'function') {
          var legAlerts = alertsForRoute(l.routeId);
          if (legAlerts.length) {
            row.classList.add('alerted');
            if (alertWorstEffect(legAlerts) === 'NO_SERVICE') row.classList.add('severe');
          }
          legAlerts.forEach(function (a) {
            var fx = alertFx(a);
            var aw = document.createElement('span');
            aw.className = 'trip-leg-alert';
            var lead = document.createElement('b');
            lead.className = 'fx fx-' + fx.cls;
            lead.textContent = fx.glyph + ' What changed: ';
            aw.appendChild(lead);
            var txt = alertWhatChanged(a);
            // Stop precision the feed actually supports: when the alert
            // names this leg's boarding stop, say so in words.
            var bs = (typeof stopData !== 'undefined' && stopData) ? stopData[l.board] : null;
            if (bs && (a.stops || []).indexOf(String(bs.id)) >= 0 &&
                (a.effect === 'DETOUR' || a.effect === 'NO_SERVICE' || a.effect === 'STOP_MOVED')) {
              txt += ' Your boarding stop, ' + (bs.n || ('stop ' + bs.id)) + ', is one of the stops this alert names.';
            }
            aw.appendChild(document.createTextNode(txt));
            body.appendChild(aw);
          });
        }
        // Planner Bus Focus (project 9): the leg is selectable — the
        // tap resolves it to its live bus (or its scheduled form) and
        // opens the Ride Along tile on it. The label is recomputed on
        // every render, and the detail re-renders per poll, so it
        // cannot promise a live bus that has stopped resolving.
        var vb = document.createElement('button');
        vb.type = 'button';
        vb.className = 'trip-leg-view';
        vb.textContent = guidanceVehicle(l) ? 'View live bus' : 'View trip';
        vb.addEventListener('click', function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          focusPlannerLeg(l);
        });
        body.appendChild(vb);
        row.classList.add('focusable');
        row.addEventListener('click', function () { focusPlannerLeg(l); });
      } else {
        dot.className = 'walk';
        var wt = document.createElement('b');
        wt.textContent = 'Walk ' + Math.max(1, Math.round(l.secs / 60)) + ' min';
        body.appendChild(wt);
        var ws = document.createElement('span');
        ws.textContent = tripStopName(l.from) + ' → ' + tripStopName(l.to);
        body.appendChild(ws);
      }
      row.appendChild(dot);
      row.appendChild(body);
      det.appendChild(row);
    });
  }
  function nearestOnPath(path, x, z) {
    var bi = 0, bd = Infinity;
    for (var i = 0; i < path.length; i++) {
      var dx = path[i][0] - x, dz = path[i][1] - z;
      var d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  }
  // Slice of a route's guideway between two stops, for highlight + fly-through.
  function busLegSlice(leg) {
    var route = routeById[leg.routeId];
    if (!route || !route.paths || !route.paths.length) return null;
    var ri = routeOrder.indexOf(leg.routeId);
    var y = 66 + ri * 1.2 + 3; // just above this route's deck
    var a = stopData[leg.board], b = stopData[leg.alight];
    if (!a || !b) return null;
    var best = null;
    route.paths.forEach(function (path) {
      if (!path || path.length < 2) return;
      var ia = nearestOnPath(path, a.x, a.z), ib = nearestOnPath(path, b.x, b.z);
      var d = Math.pow(path[ia][0] - a.x, 2) + Math.pow(path[ia][1] - a.z, 2) +
              Math.pow(path[ib][0] - b.x, 2) + Math.pow(path[ib][1] - b.z, 2);
      if (!best || d < best.d) best = { path: path, ia: ia, ib: ib, d: d };
    });
    if (!best) return null;
    var i0 = Math.min(best.ia, best.ib), i1 = Math.max(best.ia, best.ib);
    if (i1 - i0 < 1) return null;
    return { pts: best.path.slice(i0, i1 + 1), y: y };
  }
  function legPoints3D(leg) {
    if (leg.type === 'walk') {
      var a = leg.fromLoc ? { x: tripFrom.x, z: tripFrom.z } : stopData[leg.from];
      var b = stopData[leg.to];
      if (!a || !b) return [];
      return [new THREE.Vector3(a.x, 80, a.z), new THREE.Vector3(b.x, 80, b.z)];
    }
    var sl = busLegSlice(leg);
    if (!sl) return [];
    return sl.pts.map(function (p) { return new THREE.Vector3(p[0], sl.y, p[1]); });
  }
  function highlightJourney(j) {
    clearTripHighlight();
    if (!j) return;
    // Populate itinerary focus: routes in this journey stay bright, others dim.
    itineraryRoutes = {};
    mergeWalkLegs(j.legs).forEach(function (leg) {
      if (leg.type === 'bus' && leg.routeId) itineraryRoutes[leg.routeId] = true;
    });
    if (typeof applyFilters === 'function') applyFilters();
    mergeWalkLegs(j.legs).forEach(function (leg) {
      if (leg.type === 'bus') {
        var sl = busLegSlice(leg);
        if (!sl) return;
        var mat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(leg.color || '#F2F2F2'), transparent: true,
          opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
        });
        mat.userData.baseOpacity = 0.85;
        tripGroup.add(new THREE.Mesh(ribbonGeometry(sl.pts, 46, sl.y), mat));
        tripMats.push(mat);
      } else {
        var pts3 = legPoints3D(leg);
        if (pts3.length < 2) return;
        pts3[0].y = 30; pts3[1].y = 30;
        var g = new THREE.BufferGeometry().setFromPoints(pts3);
        var wm = new THREE.LineDashedMaterial({ color: 0xf2f2f2, transparent: true, opacity: 0.8, dashSize: 60, gapSize: 40 });
        var line = new THREE.Line(g, wm);
        line.computeLineDistances();
        wm.userData.baseOpacity = 0.8;
        tripGroup.add(line);
        tripMats.push(wm);
      }
    });
    tripGroup.visible = true;
  }
  // Frame the whole selected journey: bounds over the same leg points
  // the highlight draws (legPoints3D), distance from the spans against
  // the camera's fov, moved through the TransitionEngine's owned path.
  // Plan completion is the one moment the planner itself owns the
  // framing; background re-plans never call this — by then the camera
  // is the rider's.
  function frameJourney(j) {
    if (!j || (typeof tripFly !== 'undefined' && tripFly)) return;
    var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, n = 0;
    mergeWalkLegs(j.legs).forEach(function (leg) {
      legPoints3D(leg).forEach(function (p) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
        n++;
      });
    });
    if (!n) return;
    var cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    var vFov = THREE.MathUtils.degToRad(camera.fov) / 2;
    var hFov = Math.atan(Math.tan(vFov) * camera.aspect);
    var dist = 1.12 * Math.max(
      ((maxX - minX) / 2 + 250) / Math.tan(hFov),
      ((maxZ - minZ) / 2 + 250) / Math.tan(vFov));
    dist = Math.max(1400, Math.min(48000, dist));
    TransitionEngine.frameBounds(cx, cz, dist);
  }
  // Cinematic fly-through of the selected journey: the perspective is the
  // interface. Chase-cam along the journey path; any pointerdown hands
  // control straight back to the rider.
  function flyJourney(j) {
    if (!j) return;
    var pts = [];
    mergeWalkLegs(j.legs).forEach(function (leg) {
      var lp = legPoints3D(leg);
      for (var i = 0; i < lp.length; i++) {
        if (pts.length && i === 0) continue;
        pts.push(lp[i]);
      }
    });
    if (pts.length < 2) return;
    if (pts.length > 80) {
      var step = (pts.length - 1) / 79, dp = [];
      for (var k = 0; k < 80; k++) dp.push(pts[Math.round(k * step)]);
      pts = dp;
    }
    tripFly = {
      curve: new THREE.CatmullRomCurve3(pts),
      t0: performance.now(),
      // Reduced motion (C-10): a 1 ms duration makes the first flight
      // step land on the final framing through the normal completion
      // path — no separate instant-frame code to drift from it.
      dur: ((typeof reducedMotion !== 'undefined') && reducedMotion)
        ? 1 : Math.min(6500, 2600 + pts.length * 45)
    };
    controls.enabled = false;
  }
  function stepTripFly(now) {
    if (!tripFly) return;
    var t = Math.min(1, (now - tripFly.t0) / tripFly.dur);
    var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    var pos = tripFly.curve.getPoint(e);
    var ahead = tripFly.curve.getPoint(Math.min(1, e + 0.03));
    _flyDir.copy(ahead).sub(pos);
    if (_flyDir.lengthSq() > 1e-6) _flyDir.normalize();
    camera.position.copy(pos).addScaledVector(_flyDir, -450).add(_flyUp);
    controls.target.copy(ahead);
    if (t >= 1) { tripFly = null; controls.enabled = true; }
  }
  $('trip-btn').addEventListener('click', function () { tapBuzz(); setTripMode(!tripMode); });
  $('trip-close').addEventListener('click', function () { setTripMode(false); });

  // Ride Along widget wiring.
  var rideWidget = null, rideMode = false;
  // Put the camera on a ridden bus: glide to its vantage and engage the
  // follow loop, so the bus stays centered as it moves. Boarding is an
  // explicit ride intent, so it clears any follow suppression left over
  // from the plain selection flow. While a trip fly-through owns the
  // camera, follow is engaged directly — followTick defers to the
  // cinematic frame-by-frame and takes over framing when it ends.
  function rideFollowBus(vid) {
    var sl = null;
    for (var i = 0; i < busSlots.length; i++) {
      if (busSlots[i].vehicle && busSlots[i].vehicle.vehicle_id === vid) { sl = busSlots[i]; break; }
    }
    if (!sl) { refreshFollowBtn(); return; }
    followSuppressed = false;
    if (typeof tripFly !== 'undefined' && tripFly) { setFollow(vid, sl); return; }
    // Engage follow immediately; do not leave it solely to the glide's
    // completion directive. glideTo() replaces any in-flight glide, and
    // a replaced glide's onDone never runs — so an engage deferred to
    // completion is silently lost when another glide (e.g. the stop
    // card's, issued moments earlier in the select-bus -> stop -> Ride
    // along sequence) or a programmatic camera move intervenes, and the
    // ride then never tracks. followTick defers to an active glide
    // frame-by-frame and keeps its seed fresh, so engaging now is safe;
    // the glide below still centers the camera on the bus, and its
    // completion directive re-applies this same follow.
    setFollow(vid, sl);
    TransitionEngine.go({
      vantage: TransitionEngine.vantageForBus(sl.x, sl.z),
      follow: 'engage',
      vehicleId: vid,
      slot: sl
    });
  }
  var _rideBoardMute = false; // board() fires onBoard; boardRideBus does its own camera work
  // Board a bus in the ride widget. Returns false (no-op) when the widget
  // does not know the vehicle — never board a bus the picker cannot show.
  function boardRideBus(vid, engageCamera) {
    if (!rideWidget || !vid) return false;
    // A snapshot pre-captured by showBus belongs to this board call
    // alone; consume it whatever the outcome.
    var pre = _tilePushPre; _tilePushPre = null;
    var known = false;
    for (var i = 0; i < rideWidget.vehicles.length; i++) {
      if (rideWidget.vehicles[i].vehicle_id === vid) { known = true; break; }
    }
    if (!known) return false;
    var prevVid = rideWidget.currentVehicleId;
    // Return (project 11, WS1): a rider-facing board that changes the
    // boarded bus pushes the state it replaced — captured NOW, before
    // the board and its camera work mutate anything. Machinery
    // boards (planner focus poll, Return's own restore) run under
    // tilePushMute and never push. showBus may substitute its own
    // earlier pre-capture (it mutates the selection first).
    var preState = null;
    if (!tilePushMute && prevVid !== vid) preState = pre || captureTileState(prevVid);
    _rideBoardMute = true;
    try { rideWidget.board(vid); } finally { _rideBoardMute = false; }
    if (engageCamera) rideFollowBus(vid);
    if (preState) pushTileState(preState);
    syncRidePickLabels();
    return true;
  }
  function boardRideBusMuted(vid, engageCamera) {
    tilePushMute++;
    try { return boardRideBus(vid, engageCamera); }
    finally { tilePushMute--; }
  }
  // --- Ride Along Return (project 11, WS1) -------------------------
  // The tile's exits used to abandon its previous state: any board
  // change — the activation auto-board, a map tap, a dropdown
  // switch, a planner leg focus — destroyed the prior boarded state
  // irrecoverably. The stack below is captured BEFORE rider-facing
  // tile-state changes and restored by the tile's Return control.
  // Return ≠ Get off: Get off ends the ride (and empties the stack);
  // Return restores the captured state exactly — boarded bus or
  // scheduled focus, follow target, camera framing, selection, and
  // the card's scroll offset. Design of record:
  // goals/forge-line-live-transit-layer/files/
  // ride-along-return-endpoints/audit-and-design.md.
  var tileReturnStack = [];
  var tilePushMute = 0;    // >0 while machinery moves the tile (focus poll, restore)
  var _tilePushPre = null; // snapshot pre-captured by showBus before it mutates selection
  function captureTileState(vidOverride) {
    var f = camMemFraming();
    return {
      vid: vidOverride !== undefined ? vidOverride
        : (rideWidget ? rideWidget.currentVehicleId : null),
      sched: rideWidget ? rideWidget.scheduledSpec : null,
      focus: plannerFocus ? { vid: plannerFocus.vid, trip: plannerFocus.trip, spec: plannerFocus.spec } : null,
      missing: rideWidget ? !!rideWidget.boardedMissing : false,
      rideMode: rideMode,
      followVId: followVId,
      camPos: f.pos, camTgt: f.tgt,
      scrollTop: $('ride-card') ? $('ride-card').scrollTop : 0,
      selVid: selectedVehicleId
    };
  }
  function tileReturnLabelFor(s) {
    if (!s) return null;
    if (!s.rideMode) return 'Return to your trip plan';
    if (s.focus) return 'Return to ' + (s.vid ? 'Bus ' + s.vid : 'your scheduled trip') + ' · your trip';
    if (s.vid) return 'Return to Bus ' + s.vid;
    return 'Return to choosing a bus';
  }
  function syncRideReturnUI() {
    if (!rideWidget || !rideWidget.setReturnLabel) return;
    var top = tileReturnStack.length ? tileReturnStack[tileReturnStack.length - 1] : null;
    try { rideWidget.setReturnLabel(tileReturnLabelFor(top)); } catch (e) {}
  }
  function pushTileState(pre) {
    tileReturnStack.push(pre || captureTileState());
    if (tileReturnStack.length > 6) tileReturnStack.shift();
    syncRideReturnUI();
  }
  function clearTileReturnStack() {
    if (!tileReturnStack.length) return;
    tileReturnStack = [];
    syncRideReturnUI();
  }
  function rideReturn() {
    if (!rideWidget || !tileReturnStack.length) return;
    var s = tileReturnStack.pop();
    syncRideReturnUI();
    tilePushMute++;
    try {
      if (!s.rideMode) {
        // The state before a planner leg focus: the tile was closed
        // and the planner was in front. Closing the tile IS the
        // restore — the armed cover returns the planner verbatim.
        clearPlannerFocus('return');
        setRideMode(false);
        return;
      }
      if (s.focus) {
        clearPlannerFocus('return');
        plannerFocus = { vid: s.focus.vid, trip: s.focus.trip, spec: s.focus.spec,
                         missingPolls: 0, degraded: !!s.missing, awaitBoard: false };
        rideWidget.setFocusSpec(s.focus.spec);
        if (s.focus.vid) {
          if (!boardRideBus(s.focus.vid, false)) ridePendingVid = s.focus.vid;
          if (s.missing) rideWidget.setBoardedMissing(true);
        } else if (s.sched) {
          rideWidget.showScheduled(s.sched);
        }
      } else if (s.vid) {
        if (plannerFocus) clearPlannerFocus('return');
        if (!boardRideBus(s.vid, false)) {
          // The bus is gone: degrade honestly — land in the choose
          // state and say so. The popped state is consumed.
          if (rideWidget.currentVehicleId) rideWidget.alight();
          showToast('Bus ' + s.vid + ' is no longer reporting — can\u2019t return to it.', false);
        }
      } else {
        if (plannerFocus) clearPlannerFocus('return');
        if (rideWidget.currentVehicleId) rideWidget.alight();
        else if (rideWidget.scheduledSpec) rideWidget.clearScheduled();
        if (s.sched) rideWidget.showScheduled(s.sched);
      }
      // Selection: the variable and its in-scene indicator only —
      // never open the bus card over the tile.
      selectedVehicleId = s.selVid;
      renderBusInstances();
      if (typeof refreshBusInfo === 'function') refreshBusInfo();
      // Follow + camera: when the snapshot's follow rode its own
      // bus, re-engaging follow restores the framing (the camMem
      // followOwned rule). Otherwise restore follow to its target
      // when that bus is still tracked, else release it, and glide
      // to the captured framing.
      if (s.vid && s.followVId === s.vid) {
        rideFollowBus(s.vid);
      } else {
        var followRestored = false;
        if (s.followVId) {
          for (var i = 0; i < busSlots.length; i++) {
            if (busSlots[i].vehicle && busSlots[i].vehicle.vehicle_id === s.followVId) {
              setFollow(s.followVId, busSlots[i]); followRestored = true; break;
            }
          }
        }
        if (!followRestored) {
          if (followVId) setFollow(null);
          glideTo(s.camPos, s.camTgt, 900);
        }
      }
      var card = $('ride-card');
      if (card) card.scrollTop = s.scrollTop;
    } catch (e) { errLog('ride', 'return: ' + (e && e.message || e), e); }
    finally { tilePushMute--; }
    syncRideReturnUI();
    syncRidePickLabels();
  }
  // --- Ride Along endpoint indication on the map (project 11, WS2) --
  // While the tile is in the choose state, the candidate endpoints —
  // the activation reframe's set: nearest ≤ 6 within 1600 m of the
  // rider (or of the camera target without a fix) — carry a label at
  // their badge naming the terminal they are traveling toward and
  // their distance, so two same-route buses in one frame read as two
  // different trips. depthTest is off and the render order sits
  // above the badges, so the indication survives the route ribbon
  // draw (the occlusion Touch Accuracy case 2 filed). Positions are
  // the rendered slot positions, updated per frame in ridePickTick;
  // textures rebuild only when the set or a label's text changes
  // (syncRidePickLabels runs on each vehicle push and tile change).
  var ridePickGroup = null;
  var ridePickSprites = {}; // vid -> { sprite, key }
  // Project 23: the pick label's world height follows the camera so
  // its SCREEN height holds at ~3x the prominent stop labels' across
  // the pick working range — stop labels ride camDist x 0.0215
  // (updateStopLabels), so three of those is camDist x 0.0645, the
  // same distance-compensation discipline badgeHeight() applies to
  // the bus badges and placeBusInfo to the selected-bus sprite. Past
  // 7,000 m the height caps and the label shrinks with the world, as
  // a world-fixed sprite does; the previous fixed H = 210 m stood
  // ~10x every other label in the scene at pick zooms and grew
  // without bound zooming in (founding case, 2026-10-17 23:59).
  function ridePickHeight() {
    if (typeof camera === 'undefined' || typeof controls === 'undefined' || !camera || !controls) return 210;
    var camDist = camera.position.distanceTo(controls.target);
    return Math.min(camDist * 0.0645, 7000 * 0.0645);
  }
  // Project 23: a candidate bus at its terminal — layover-bound (S2)
  // or at-terminal unbound (S3) — is not traveling toward the headsign
  // its next trip will carry, so its pick label names where the bus
  // IS, in the tile's own words (the S2 view's "At {terminal}", the
  // picker's "· at terminal"), never an arrow at the next trip's
  // destination over the rider's distance to the bus: the founding
  // frame read "→ Michigan / 0.3 mi" for a bus dwelling AT
  // Providence, 13.47 route-miles from Michigan. The name comes from
  // the layover binding's origin stop — the tile S2 view's own
  // source — else from rrTerminalAt's geometric test; a layover bus
  // whose name neither resolves is still terminal (''). Returns null
  // for an en-route candidate. The name shortens past 24 chars in
  // formatDest's house pattern; the state word "at" never drops.
  function ridePickTerminalName(v) {
    if (v.layover) {
      var b = tripBindingFor(v.vehicle_id);
      var oStop = (b && typeof stopData !== 'undefined' && stopData) ? stopData[b.trip.stops[0]] : null;
      if (oStop && oStop.n) return oStop.n.length > 24 ? oStop.n.slice(0, 23) + '\u2026' : oStop.n;
      var g = rrTerminalAt(v);
      if (g) return g.length > 24 ? g.slice(0, 23) + '\u2026' : g;
      return '';
    }
    var t = rrTerminalAt(v);
    if (t && t.length > 24) return t.slice(0, 23) + '\u2026';
    return t;
  }
  function makeRidePickSprite(text, sub, colorHex) {
    var c = document.createElement('canvas');
    var mx = c.getContext('2d');
    mx.font = '600 44px "Space Grotesk", sans-serif';
    var tw = Math.ceil(mx.measureText(text).width);
    if (sub) {
      mx.font = '500 36px "Space Grotesk", sans-serif';
      tw = Math.max(tw, Math.ceil(mx.measureText(sub).width));
    }
    c.width = Math.max(200, tw + 44);
    c.height = sub ? 132 : 96;
    var x = c.getContext('2d');
    x.fillStyle = 'rgba(16,16,16,0.88)';
    x.beginPath();
    if (x.roundRect) x.roundRect(4, 4, c.width - 8, c.height - 8, 26); else x.rect(4, 4, c.width - 8, c.height - 8);
    x.fill();
    x.strokeStyle = colorHex; x.lineWidth = 3; x.stroke();
    x.fillStyle = '#F2F2F2'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = '600 44px "Space Grotesk", sans-serif';
    x.fillText(text, c.width / 2, sub ? 40 : c.height / 2);
    if (sub) {
      x.fillStyle = 'rgba(242,242,242,0.75)';
      x.font = '500 36px "Space Grotesk", sans-serif';
      x.fillText(sub, c.width / 2, 94);
    }
    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    sp.userData.aspect = c.width / c.height;
    var H = ridePickHeight();
    sp.scale.set(H * sp.userData.aspect, H, 1);
    sp.renderOrder = 30;
    return sp;
  }
  function ridePickCandidates() {
    if (!rideMode || !rideWidget) return [];
    if (rideWidget.currentVehicleId || rideWidget.scheduledSpec || plannerFocus) return [];
    if (typeof streetView !== 'undefined' && streetView) return [];
    var hasLoc = (typeof userXZ !== 'undefined' && !!userXZ);
    var ax = hasLoc ? userXZ[0] : controls.target.x;
    var az = hasLoc ? userXZ[1] : controls.target.z;
    var vs = [];
    for (var i = 0; i < rideWidget.vehicles.length; i++) {
      var v = rideWidget.vehicles[i];
      if (v.x == null || v.z == null) continue;
      var dx = v.x - ax, dz = v.z - az;
      var d2 = dx * dx + dz * dz;
      if (d2 <= 1600 * 1600) vs.push({ v: v, d2: d2 });
    }
    vs.sort(function (a, b) { return a.d2 - b.d2; });
    return vs.slice(0, 6).map(function (e) { return e.v; });
  }
  function syncRidePickLabels() {
    if (typeof THREE === 'undefined' || typeof scene === 'undefined') return;
    if (!ridePickGroup) { ridePickGroup = new THREE.Group(); scene.add(ridePickGroup); }
    var cands = ridePickCandidates();
    var seen = {};
    for (var i = 0; i < cands.length; i++) {
      var v = cands[i];
      seen[v.vehicle_id] = true;
      var termName = ridePickTerminalName(v);
      var text;
      if (termName != null) {
        text = routeLabel(v.route_id) + ' \u00b7 at ' + (termName || 'terminal');
      } else {
        var dest = displayDest(v);
        text = dest ? '\u2192 ' + dest : routeLabel(v.route_id);
      }
      var sub = '';
      if (typeof userXZ !== 'undefined' && userXZ && v.x != null && v.z != null) {
        sub = rideFmtDist(Math.hypot(v.x - userXZ[0], v.z - userXZ[1]));
      }
      var key = text + '|' + sub;
      var cur = ridePickSprites[v.vehicle_id];
      if (!cur || cur.key !== key) {
        if (cur) {
          ridePickGroup.remove(cur.sprite);
          if (cur.sprite.material.map) cur.sprite.material.map.dispose();
          cur.sprite.material.dispose();
        }
        var col = routeColors[v.route_id] ? '#' + routeColors[v.route_id].getHexString() : '#F2F2F2';
        var sp = makeRidePickSprite(text, sub, col);
        ridePickGroup.add(sp);
        ridePickSprites[v.vehicle_id] = { sprite: sp, key: key };
      }
    }
    for (var vid in ridePickSprites) {
      if (!seen[vid]) {
        var e = ridePickSprites[vid];
        ridePickGroup.remove(e.sprite);
        if (e.sprite.material.map) e.sprite.material.map.dispose();
        e.sprite.material.dispose();
        delete ridePickSprites[vid];
      }
    }
    ridePickGroup.visible = !!cands.length;
  }
  function ridePickTick() {
    if (!ridePickGroup || !ridePickGroup.visible) return;
    var H = ridePickHeight();
    for (var vid in ridePickSprites) {
      for (var i = 0; i < busSlots.length; i++) {
        var sl = busSlots[i];
        if (sl.vehicle && sl.vehicle.vehicle_id === vid) {
          var sp2 = ridePickSprites[vid].sprite;
          if (sp2.userData.aspect) sp2.scale.set(H * sp2.userData.aspect, H, 1);
          // The anchor lift rides the same screen discipline: the
          // sprite's center sits 0.68 x its height above the badge
          // anchor, so its lower edge clears the badge by a fixed
          // ~12 px at every distance in the band (previously a fixed
          // +200 m, which let the label swallow its own bus zoomed in).
          sp2.position.set(sl.x,
            (busMode ? 150 : PILLAR_H * pillarYS + 80) + H * 0.68, sl.z);
          break;
        }
      }
    }
  }
  // A board intent that lost a feed race (2026-10-16): the selected bus
  // was absent from the widget's vehicle snapshot at open time — a GPS
  // gap in one build cycle is enough — and the single-shot board in
  // setRideMode failed silently, leaving "-- choose a bus --" while a
  // bus stood selected on the map. The intent is kept here and honored
  // by __setRideVehicles the first poll the bus appears in.
  var ridePendingVid = null;
  // Approach class of a vehicle relative to a rider point, from the
  // rendered positions and the vehicle's bearing: 'here' within
  // 20 m; else 'approaching' when its heading carries it toward the
  // point; else 'passed' (heading away — it has gone by the rider,
  // or travels the opposite direction). cls is null when the
  // bearing is unknown. The ride widget classifies with the same
  // formula for its picker indication (project 11, WS2). Travel
  // vector for a compass bearing in scene coords: (sin b, -cos b).
  function rideApproachClass(v, rx, rz) {
    if (!v || v.x == null || v.z == null) return null;
    var dx = rx - v.x, dz = rz - v.z;
    var dist = Math.sqrt(dx * dx + dz * dz);
    if (dist <= 20) return { cls: 'here', dist: dist };
    // Route Reverse: a layover-bound bus is at the endpoint — never
    // 'approaching', never 'passed' (project 11 honesty, spec 4).
    if (v.layover) return { cls: 'terminal', dist: dist };
    if (v.bearing == null || isNaN(v.bearing)) return { cls: null, dist: dist };
    var br = v.bearing * Math.PI / 180;
    var dot = (Math.sin(br) * dx - Math.cos(br) * dz) / dist;
    return { cls: dot >= 0 ? 'approaching' : 'passed', dist: dist };
  }
  // Rider-facing distance: feet under 1000 ft, else miles to one
  // decimal. Twin of fmtDistM in ride-along.js.
  function rideFmtDist(m) {
    var ft = m * 3.28084;
    if (ft < 1000) return Math.round(ft / 10) * 10 + ' ft';
    return (m / 1609.344).toFixed(1) + ' mi';
  }
  // The rider's own bus when nothing is selected: with a location fix,
  // the live bus within boarding distance (75 m in projected units) is
  // the one the rider is on or standing at. Beyond that distance the
  // picker stays empty rather than guessing at a bus across the street.
  // Direction-aware (project 11): a bus that has passed the rider —
  // heading away, the opposite direction's bus at a stop pair is the
  // standing example — is never the silent default. 'here',
  // 'approaching', and bearing-unknown buses are eligible and the
  // nearest wins, as before; when only passed buses are in range the
  // tile stays in the choose state, where the picker and the map
  // indicate both endpoints and the rider picks explicitly.
  function nearestRideVehicleVid() {
    if (!rideWidget || typeof userXZ === 'undefined' || !userXZ) return null;
    var best = null, bestD2 = 75 * 75;
    for (var i = 0; i < rideWidget.vehicles.length; i++) {
      var v = rideWidget.vehicles[i];
      if (v.x == null || v.z == null) continue;
      var dx = v.x - userXZ[0], dz = v.z - userXZ[1];
      var d2 = dx * dx + dz * dz;
      if (d2 >= bestD2) continue;
      var ac = rideApproachClass(v, userXZ[0], userXZ[1]);
      if (ac && ac.cls === 'passed') continue;
      bestD2 = d2; best = v.vehicle_id;
    }
    return best;
  }
  // Touch Accuracy requirement (project 10, filed 2026-10-16 21:26):
  // Ride Along ACTIVATION alters the view when it opens in the
  // choose-a-bus state — nothing boarded, nothing pending — so the
  // candidate endpoints are easy to select. The camera glides (the
  // standing TransitionEngine machinery; no board, no follow) to a
  // 32-degree framing of the rider and the nearest live buses, at a
  // distance inside the badge-visibility range where badges measure
  // tappable size. Closing the tile restores the pre-open framing
  // through camera memory (camMemTake ran at open) — the restore path
  // project 11's Return workstream builds on. Skipped when the view
  // already serves selection (>= 2 candidate badges on screen at a
  // non-grazing elevation), in street view, while a follow owns the
  // camera, or when no vehicle positions are known.
  function rideChooseReframe() {
    if (!rideWidget || !rideWidget.vehicles || !rideWidget.vehicles.length) return;
    if (typeof streetView !== 'undefined' && streetView) return;
    if (followVId) return;
    var hasLoc = (typeof userXZ !== 'undefined' && !!userXZ);
    var ax = hasLoc ? userXZ[0] : controls.target.x;
    var az = hasLoc ? userXZ[1] : controls.target.z;
    var vs = [];
    for (var i = 0; i < rideWidget.vehicles.length; i++) {
      var v = rideWidget.vehicles[i];
      if (v.x == null || v.z == null) continue;
      var dx = v.x - ax, dz = v.z - az;
      vs.push({ x: v.x, z: v.z, d2: dx * dx + dz * dz });
    }
    if (!vs.length) return;
    vs.sort(function (a, b) { return a.d2 - b.d2; });
    var cand = [];
    for (var j = 0; j < vs.length && cand.length < 6; j++) {
      if (vs[j].d2 <= 1600 * 1600) cand.push(vs[j]);
    }
    if (!cand.length) cand = vs.slice(0, 3);
    var dist0 = camera.position.distanceTo(controls.target);
    var el0 = dist0 > 0 ? Math.asin(Math.max(-1, Math.min(1,
      (camera.position.y - controls.target.y) / dist0))) : 0;
    if (el0 >= 20 * Math.PI / 180) {
      var onScreen = 0;
      for (var k = 0; k < cand.length; k++) {
        _p3.set(cand[k].x, busMode ? 150 : PILLAR_H * pillarYS + 80, cand[k].z).project(camera);
        if (_p3.z <= 1 && Math.abs(_p3.x) <= 0.92 && Math.abs(_p3.y) <= 0.92) onScreen++;
      }
      if (onScreen >= 2) return;
    }
    var cxp = ax, czp = az;
    cand.forEach(function (c) { cxp += c.x; czp += c.z; });
    cxp /= (cand.length + 1); czp /= (cand.length + 1);
    var rad = Math.hypot(ax - cxp, az - czp);
    cand.forEach(function (c) { rad = Math.max(rad, Math.hypot(c.x - cxp, c.z - czp)); });
    var vFov = THREE.MathUtils.degToRad(camera.fov) / 2;
    var hFov = Math.atan(Math.tan(vFov) * camera.aspect);
    var fit = (rad + 120) / Math.tan(Math.min(vFov, hFov));
    var dist = Math.max(1100, Math.min(6400, fit));
    _svDir.copy(camera.position).sub(controls.target); _svDir.y = 0;
    if (_svDir.lengthSq() < 1e-6) _svDir.set(1, 0, 0);
    _svDir.normalize();
    var el = 32 * Math.PI / 180;
    var pos = new THREE.Vector3(
      cxp + _svDir.x * dist * Math.cos(el),
      dist * Math.sin(el),
      czp + _svDir.z * dist * Math.cos(el));
    TransitionEngine.go({ vantage: { pos: pos, tgt: new THREE.Vector3(cxp, 0, czp) } });
  }
  // --- Planner Bus Focus (project 9) --------------------------------
  // A bus leg in the itinerary detail is selectable: the tap resolves
  // the leg to its live vehicle, snaps the camera to it, and opens the
  // Ride Along tile bound to it. Design of record:
  // goals/forge-line-live-transit-layer/files/planner-bus-focus/
  // architecture.md. The focus record binds to the vehicle id and the
  // trip OBJECT — legs are rebuilt and cloned by every plan, while
  // trip objects are stable timetable records and tripDelayState is
  // keyed by them, so background re-plans never disturb a focus.
  var plannerFocus = null;
  // While a leg tap opens the ride surface, setRideMode's own
  // auto-board (selected bus / nearest bus) must not fire first and be
  // immediately retargeted — the focus boards explicitly.
  var rideAutoBoardMute = false;
  // While a leg tap opens the ride surface, exclCover covers the trip
  // card with its state intact instead of hard-closing the planner
  // (see the trip/ride branch of exclCover).
  var focusCoverArmed = false;

  function focusVehicleForLeg(leg) {
    // The one leg -> vehicle resolution: guidanceVehicle walks
    // leg.tripRef -> tripDelayState -> busTrackers, the same path the
    // guidance banners use (renderTripDetail's button label calls
    // guidanceVehicle directly — it is the same function). Null when
    // there is no state entry, the trip is disrupted, or the tracker
    // has no map-matched arc.
    return guidanceVehicle(leg);
  }

  function legScheduledSpec(leg) {
    // The scheduled form of a leg (architecture §3): the trip's own
    // stops from board to alight with the trip's own times, on the
    // same basis the ride tile's times provider uses — dep for the
    // boarding stop, arr for the rest, from arrL2/arr and depL2/dep.
    // Degrades to the two endpoints if the stops are not found in the
    // trip (data drift) — never to nothing.
    if (!leg || !leg.tripRef) return null;
    var trip = leg.tripRef;
    var arr = trip.arrL2 || trip.arr || [], dep = trip.depL2 || trip.dep || [];
    var rows = [];
    var bi = trip.stops.indexOf(leg.board), ai = trip.stops.indexOf(leg.alight);
    if (bi >= 0 && ai >= bi) {
      for (var j = bi; j <= ai; j++) {
        var sj = stopData[trip.stops[j]];
        rows.push({ id: sj ? sj.id : null, name: tripStopName(trip.stops[j]),
                    label: tripClock(j === bi ? dep[j] : arr[j]) });
      }
    }
    if (!rows.length) {
      var sb = stopData[leg.board], sa = stopData[leg.alight];
      rows.push({ id: sb ? sb.id : null, name: tripStopName(leg.board), label: tripClock(leg.boardSec) });
      rows.push({ id: sa ? sa.id : null, name: tripStopName(leg.alight), label: tripClock(leg.alightSec) });
    }
    return { routeId: leg.routeId, headsign: leg.headsign || trip.h || '',
             basis: (trip.arrL2 || trip.depL2) ? 'typical' : 'scheduled', stops: rows };
  }

  function plannerTileVisible() { return rideMode && !$('ride-card').hidden; }

  function focusPlannerLeg(leg) {
    if (!leg || leg.type !== 'bus') return;
    if (typeof RideAlong === 'undefined') {
      errLog('planner', 'focus: ride tile unavailable', null);
      showToast('Ride view unavailable on this device.', false);
      return;
    }
    tapBuzz();
    cancelTripFly(); // a fresh rider intent supersedes the cinematic
    var spec = legScheduledSpec(leg);
    var tr = focusVehicleForLeg(leg);
    var vid = tr ? (tripDelayState.get(leg.tripRef) || {}).vehicleId : null;
    // Open the surface FIRST, with the auto-board muted and the trip
    // cover armed, and only then record the focus: a surface-mode
    // transition fires the planner-closed teardown hook, and the
    // record must not exist yet while it runs.
    // Return (project 11): the focus replaces the tile's state, so
    // the state it replaces is pushed first — the snapshot records
    // rideMode as it stands, so a Return from the focus closes the
    // tile back to the planner the cover is holding.
    pushTileState();
    tilePushMute++;
    rideAutoBoardMute = true;
    focusCoverArmed = true;
    try { setRideMode(true); } finally { rideAutoBoardMute = false; focusCoverArmed = false; }
    if (!rideWidget) { tilePushMute--; return; }
    plannerFocus = { vid: vid || null, trip: leg.tripRef, spec: spec,
                     missingPolls: 0, degraded: false, awaitBoard: false };
    rideWidget.setFocusSpec(spec);
    if (vid) {
      if (!boardRideBus(vid, true)) ridePendingVid = vid;
    } else {
      // No live vehicle: the tile answers in scheduled form and the
      // camera goes to the boarding stop — never a silent no-op,
      // never a fabricated live position.
      rideWidget.showScheduled(spec);
      var bs = stopData[leg.board];
      if (bs) TransitionEngine.go({ vantage: TransitionEngine.vantageForStop(bs.x, 0, bs.z) });
    }
    tilePushMute--;
  }

  function clearPlannerFocus(src) {
    if (!plannerFocus) return;
    var f = plannerFocus;
    plannerFocus = null; // null first: the widget's onAlight re-enters here
    if (rideWidget) {
      try {
        rideWidget.setFocusSpec(null);
        rideWidget.setBoardedMissing(false);
        if (f.vid && rideWidget.currentVehicleId === f.vid) rideWidget.alight();
        else if (rideWidget.scheduledSpec) rideWidget.clearScheduled();
      } catch (e) { errLog('planner', 'focus-clear: ' + (e && e.message || e), e); }
    }
    syncRidePickLabels();
  }

  function plannerFocusPoll() {
    if (!plannerFocus || !rideWidget) return;
    var f = plannerFocus;
    // Invariant (architecture §5): the focused trip must still be a
    // bus leg of the selected journey. Background re-plans replace
    // the journeys but carry the same trip objects, so this fires
    // only on a genuine user re-plan or an option change that drops
    // the trip.
    var j = tripJourneys[tripSel], inJourney = false;
    if (j) for (var i = 0; i < j.legs.length; i++) {
      if (j.legs[i].type === 'bus' && j.legs[i].tripRef === f.trip) { inJourney = true; break; }
    }
    if (!inJourney) { clearPlannerFocus('journey-changed'); return; }
    if (!f.vid) {
      // Scheduled focus: upgrade when the shared resolution binds a
      // bus to the trip. The camera moves only if the tile is what
      // the rider is looking at; otherwise the board lands silently
      // (awaitBoard) and is announced when it does.
      var tr = f.trip ? focusVehicleForLeg({ tripRef: f.trip }) : null;
      if (!tr) return;
      f.vid = (tripDelayState.get(f.trip) || {}).vehicleId || null;
      if (!f.vid) return;
      f.missingPolls = 0;
      if (boardRideBusMuted(f.vid, plannerTileVisible())) {
        showToast('Bus ' + f.vid + ' is now reporting live.', false);
      } else if (plannerTileVisible()) {
        ridePendingVid = f.vid;
        showToast('Bus ' + f.vid + ' is now reporting live.', false);
      } else {
        f.awaitBoard = true;
      }
      return;
    }
    if (f.awaitBoard) {
      if (boardRideBusMuted(f.vid, false)) {
        f.awaitBoard = false;
        showToast('Bus ' + f.vid + ' is now reporting live.', false);
      } else if (!(busTrackers[f.vid] && busTrackers[f.vid].vehicle) && ++f.missingPolls >= 2) {
        // The bus stopped reporting before the silent board landed:
        // fall back to the scheduled focus rather than binding a tile
        // to a vehicle that is no longer there.
        f.vid = null; f.awaitBoard = false; f.missingPolls = 0;
      }
      return;
    }
    var present = !!(busTrackers[f.vid] && busTrackers[f.vid].vehicle);
    if (present) {
      f.missingPolls = 0;
      if (f.degraded) {
        f.degraded = false;
        rideWidget.setBoardedMissing(false);
        // The tile re-renders live from the fresh position on its
        // own; follow re-engages with a glide only while the rider
        // is looking at the tile.
        if (plannerTileVisible() && !boardRideBusMuted(f.vid, true)) ridePendingVid = f.vid;
        showToast('Bus ' + f.vid + ' is now reporting live.', false);
      }
    } else if (++f.missingPolls >= 2 && !f.degraded) {
      // Two consecutive absent polls (~2 min at the feed cadence):
      // one absent poll is a GPS gap, not a loss.
      f.degraded = true;
      rideWidget.setBoardedMissing(true);
    }
  }
  function setRideMode(on) {
    rideMode = on;
    if (on) { camMemTake(); exclCover('ride'); }
    $('ride-btn').setAttribute('aria-pressed', on ? 'true' : 'false');
    $('ride-card').hidden = !on;
    if (on && !rideWidget && typeof RideAlong !== 'undefined') {
      rideWidget = RideAlong.create($('ride-along-mount'));
      // Camera hooks: boarding from the card's own dropdown also puts the
      // camera on the bus; getting off releases a follow this engagement
      // started.
      rideWidget.onBoard = function (vid, prevVid) {
        if (_rideBoardMute) return;
        // Return (project 11): a board from the tile's own picker
        // replaces the tile's state — push the replaced state.
        // prevVid names the widget side; the host fields captured
        // here are still pre-transition, because onBoard fires
        // inside board(), before the camera work below runs.
        if (prevVid !== vid) pushTileState(captureTileState(prevVid));
        // A manual board inside the tile retargets any planner focus.
        if (plannerFocus && plannerFocus.vid !== vid) clearPlannerFocus('retargeted');
        rideFollowBus(vid);
      };
      rideWidget.onAlight = function (vid) {
        if (followVId === vid) setFollow(null);
        if (plannerFocus && plannerFocus.vid === vid) clearPlannerFocus('alight');
        // Get off ends the ride: there is nothing to return to
        // inside it. Machinery alights (focus clear, Return's own
        // restore) run muted and keep the stack.
        if (!tilePushMute) clearTileReturnStack();
        syncRidePickLabels();
      };
      rideWidget.onReturnRequest = function () { rideReturn(); };
      rideWidget.onScheduledClose = function () { clearPlannerFocus('scheduled-closed'); };
      // Feed cached route/stop data if already loaded.
      if (typeof routeById !== 'undefined' && typeof stopData !== 'undefined') {
        var rts = Object.keys(routeById).map(function (id) { return routeById[id]; });
        rideWidget.setData({ routes: rts, stops: stopData });
      }
      if (typeof lastVehicles !== 'undefined' && lastVehicles) {
        window.__setRideVehicles(lastVehicles);
      }
    }
    if (on && rideWidget) {
      // Ride along (2026-10-15): stop times for the ride view, and the
      // timetable engine a boarded bus's matching needs.
      if (rideWidget.setTimesProvider) rideWidget.setTimesProvider(rideTimesFor);
      ensureTripEngine();
      rideWidget.refresh();
    }
    // Respect the in-focus bus: if a bus is already selected when Ride
    // Along is switched on, ride THAT bus — no second selection in the
    // card's dropdown. (The selected bus survives a stop selection, so
    // this also covers select bus -> tap a stop -> Ride along.) If the
    // widget does not know that bus yet, keep the intent pending (see
    // ridePendingVid). With no selection at all, fall back to the bus at
    // the rider's own location — the bus they are on — when one is
    // within boarding distance.
    if (on && rideWidget && !rideAutoBoardMute) {
      var rideBoardedNow = false;
      if (selectedVehicleId) {
        rideBoardedNow = boardRideBus(selectedVehicleId, true);
        ridePendingVid = rideBoardedNow ? null : selectedVehicleId;
      }
      if (!rideBoardedNow && !selectedVehicleId && !rideWidget.currentVehicleId) {
        var nearVid = nearestRideVehicleVid();
        if (nearVid) boardRideBus(nearVid, true);
      }
    }
    // Choose-state activation reframe (project 10): opening Ride Along
    // with nothing to board alters the view for endpoint selection.
    if (on && rideWidget && !rideAutoBoardMute && !plannerFocus &&
        !rideWidget.currentVehicleId && !ridePendingVid) {
      try { rideChooseReframe(); }
      catch (e) { errLog('ride', 'choose-reframe: ' + (e && e.message || e), e); }
    }
    if (!on) { ridePendingVid = null; clearPlannerFocus('tile-closed'); clearTileReturnStack(); exclRestore(); }
    if (on) syncRideReturnUI();
    syncRidePickLabels();
  }
  $('ride-btn').addEventListener('click', function () { tapBuzz(); setRideMode(!rideMode); });
  $('ride-close').addEventListener('click', function () { setRideMode(false); });
  // Expose for the vehicle poll to push updates.
  window.__rideWidget = function () { return rideWidget; };
  window.__setRideData = function (routes, stops) {
    if (rideWidget) rideWidget.setData({ routes: routes, stops: stops });
  };
  window.__setRideVehicles = function (vehicles) {
    if (!rideWidget) return;
    // The proxy feed carries lat/lon; the Ride Along widget works in
    // projected x/z (its data contract). Merge the projection onto a copy
    // of each record — the raw feed objects are shared with the map
    // renderer and must not be mutated. Speed arrives as speed_mph.
    // Real-time ride view (2026-10-15): the position handed to the
    // widget is the bus slot's CURRENT position — updateBusMotion
    // dead-reckons it from the Kalman state every frame — not the raw
    // fix the feed last reported. A DDOT fix can be a minute or more
    // old on arrival and the poll cadence is 60 s; projecting the raw
    // fix left the ride view's upcoming-stops list minutes behind the
    // bus (passed stops lingering, times stale). The slot position is
    // the same estimate the map renders. A vehicle without a slot (not
    // yet tracked) falls back to the raw fix projection.
    var slotById = {};
    for (var s = 0; s < busSlots.length; s++) {
      if (busSlots[s].vehicle) slotById[busSlots[s].vehicle.vehicle_id] = busSlots[s];
    }
    // Candidate C3: the boarded vehicle's shadow slot (its route is
    // gate-hidden mid-ride) supplies the same slot-quality position
    // the visible set gets — the seam prefers it over the raw fix,
    // so the ride view never falls back to stale-fix positions.
    if (rideShadowSlot && rideShadowSlot.vehicle) slotById[rideShadowSlot.vehicle.vehicle_id] = rideShadowSlot;
    var mapped = (vehicles || []).map(function (v) {
      var sl = slotById[v.vehicle_id];
      if (sl) {
        var out = {};
        for (var k in v) out[k] = v[k];
        out.x = sl.x; out.z = sl.z;
        if (out.speed == null && v.speed_mph != null) out.speed = v.speed_mph;
        return out;
      }
      if (v.lat == null || v.lon == null || !proj || typeof project !== 'function') return v;
      var p = project(v.lat, v.lon);
      var out2 = {};
      for (var k2 in v) out2[k2] = v[k2];
      out2.x = p[0]; out2.z = p[1];
      if (out2.speed == null && v.speed_mph != null) out2.speed = v.speed_mph;
      return out2;
    });
    // Product Defect Reconciliation (project 13): the widget's
    // selection surfaces — picker, activation default, choose-state
    // reframe, map pick labels — all consume this list, so it
    // carries only vehicles the map itself shows: routeShown, the
    // predicate updateBuses applies. Exempt are the live commitments
    // a mid-ride filter change must not strand: the boarded vehicle,
    // a planner-focus vehicle, and a pending board intent (which the
    // block below then completes against this same list).
    var rideVehicles = mapped.filter(function (v) {
      if (typeof routeShown !== 'function' || routeShown(v.route_id)) return true;
      if (rideWidget.currentVehicleId && v.vehicle_id === rideWidget.currentVehicleId) return true;
      if (typeof plannerFocus !== 'undefined' && plannerFocus && v.vehicle_id === plannerFocus.vid) return true;
      if (typeof ridePendingVid !== 'undefined' && ridePendingVid && v.vehicle_id === ridePendingVid) return true;
      return false;
    });
    // Route Reverse: the seam is where the widget's records get the
    // governed direction label — a bound vehicle's destination becomes
    // its trip's headsign, and a layover binding is flagged so the
    // widget's approach test can answer 'terminal'.
    for (var ai = 0; ai < rideVehicles.length; ai++) {
      var ab = tripBindingFor(rideVehicles[ai].vehicle_id);
      if (ab) {
        if (ab.trip.h) rideVehicles[ai].destination = ab.trip.h;
        if (ab.st.layover) rideVehicles[ai].layover = true;
      }
      // Candidate C3: an exempt vehicle whose route the gate has
      // closed is marked, so the tile can state the divergence —
      // the ride continues, but never in silence.
      if (typeof routeShown === 'function' && !routeShown(rideVehicles[ai].route_id)) rideVehicles[ai].gateClosed = true;
    }
    rideWidget.setVehicles(rideVehicles);
    // The rider's own position, for the picker's endpoint indication
    // (distance + approach) — the same fix the location default uses.
    if (rideWidget.setRiderPos) {
      if (typeof userXZ !== 'undefined' && userXZ) rideWidget.setRiderPos(userXZ[0], userXZ[1]);
      else rideWidget.setRiderPos(null);
    }
    syncRidePickLabels();
    // Honor a pending board intent the first time the bus appears.
    // A pending FOCUS board is machinery (its state push happened at
    // the leg tap); the activation path's pending board is the
    // rider's own intent completing, and pushes normally.
    if (ridePendingVid && rideMode) {
      var pendFocus = !!(plannerFocus && plannerFocus.vid === ridePendingVid);
      var pendOk = pendFocus ? boardRideBusMuted(ridePendingVid, true)
                             : boardRideBus(ridePendingVid, true);
      if (pendOk) ridePendingVid = null;
    }
  };
  // Real-time ride view (2026-10-15): while a bus is boarded, push its
  // tracker-predicted position to the widget every 5 s. The poll alone
  // refreshes the ride view once a minute; between polls the bus keeps
  // moving and its upcoming-stops list must advance with it. The widget
  // recomputes the vehicle's progress along its trip's stop sequence
  // from the pushed position on every push (RideAlong.updateVehicle ->
  // refresh): stops the bus has passed drop off, the next stop is
  // promoted, and the stop times are re-derived from the times
  // provider. No user interaction is involved. The guard makes the
  // interval a no-op unless a bus is boarded in Ride Along.
  // Candidate C3: advance the shadow slot's tracker between polls
  // with the same constant-velocity Kalman predict updateBusMotion
  // runs per frame for visible slots — same empirical velocity
  // prior, same horizon rule. The shadow renders nothing, so only
  // the position state advances; the covariance is carried so the
  // next poll's update starts from the predicted state, exactly as
  // it does for a visible bus. Step time accumulates on the slot
  // record (_predT) from the poll that reconciled it.
  function predictRideShadow(now) {
    var sl = rideShadowSlot, tr = sl && sl.tracker;
    if (!tr || !tr.arc || !tr.kInit) return;
    var dt = sl._predT ? Math.min(6, (now - sl._predT) / 1000) : 0;
    sl._predT = now;
    if (dt <= 0) return;
    var ageS = (now - (tr.fixObsT != null ? tr.fixObsT : tr.fixT)) / 1000;
    if (ageS >= PREDICT_HORIZON_S) {
      // Position Integrity item 2: past the horizon the shadow claims
      // the map-matched fix, not the frozen extrapolation — the same
      // rule the visible marker lives by (staleMarkerStep). Nothing
      // renders here, so the placement is direct, no ease.
      var stalePt = staleFixPoint(tr);
      if (stalePt) { sl.x = stalePt.x; sl.z = stalePt.z; }
      return;
    }
    if (!tr.seg || tr.segPath !== tr.pathIdx || tr.kS < tr.seg.s0 || tr.kS > tr.seg.s1) {
      tr.seg = segmentAt(tr.routeId, tr.pathIdx, tr.kS);
      tr.segPath = tr.pathIdx;
    }
    var v0 = tr.speedMps;
    var vEmp = empiricalSpeed(tr.routeId, tr.seg);
    var vPrior = (vEmp != null && vEmp < v0) ? vEmp : v0;
    tr.kV += (vPrior - tr.kV) * (1 - Math.exp(-dt / REVERT_TAU_S));
    tr.kS += tr.kV * dt;
    var p00 = tr.kP, p01 = tr.kPvS, p11 = tr.kPv;
    tr.kP = p00 + 2 * dt * p01 + dt * dt * p11 + KALMAN_Q_POS * dt;
    tr.kPvS = p01 + dt * p11;
    tr.kPv = p11 + KALMAN_Q_VEL * dt;
    if (Math.abs(tr.kV) > 0.3 || tr.kP > KALMAN_R * 4) {
      tr.s = Math.max(0, Math.min(tr.arc.len, tr.kS));
      var pt = pointAt(tr.arc, tr.s);
      sl.x = pt.x; sl.z = pt.z;
    }
  }

  function pushRidePosition() {
    if (!rideMode || !rideWidget || !rideWidget.currentVehicleId) return;
    var vid = rideWidget.currentVehicleId;
    for (var i = 0; i < busSlots.length; i++) {
      var sl = busSlots[i];
      if (sl.vehicle && sl.vehicle.vehicle_id === vid) {
        var rec = {};
        for (var k in sl.vehicle) rec[k] = sl.vehicle[k];
        rec.x = sl.x; rec.z = sl.z;
        if (rec.speed == null && sl.vehicle.speed_mph != null) rec.speed = sl.vehicle.speed_mph;
        rideWidget.updateVehicle(rec);
        return;
      }
    }
    // Candidate C3: no visible slot — the boarded bus's route is
    // gate-hidden and its position lives in the shadow slot.
    // Advance it and push exactly as the visible path does, so the
    // ride view's 5 s cadence survives the toggle-off.
    if (rideShadowSlot && rideShadowSlot.vehicle && rideShadowSlot.vehicle.vehicle_id === vid) {
      predictRideShadow(performance.now());
      var sv = rideShadowSlot.vehicle;
      var srec = {};
      for (var sk in sv) srec[sk] = sv[sk];
      srec.x = rideShadowSlot.x; srec.z = rideShadowSlot.z;
      if (srec.speed == null && sv.speed_mph != null) srec.speed = sv.speed_mph;
      rideWidget.updateVehicle(srec);
    }
  }
  setInterval(function () { pushRidePosition(); }, 5000);

  function tripMiniLabel() {
    if (typeof tripJourneys !== 'undefined' && tripJourneys.length && tripJourneys[tripSel]) {
      var j = tripJourneys[tripSel];
      return j.durationMin + ' min · ' + j.departClock + ' → ' + j.arriveClock;
    }
    return 'Trip planner';
  }
  function refreshTripMini() {
    if ($('trip-card').classList.contains('min')) {
      $('trip-mini-label').textContent = tripMiniLabel();
    }
  }
  $('trip-min').addEventListener('click', function () {
    tapBuzz();
    $('trip-mini-label').textContent = tripMiniLabel();
    $('trip-mini').hidden = false;
    $('trip-card').classList.add('min');
  });
  $('trip-expand').addEventListener('click', function (e) {
    e.stopPropagation();
    tapBuzz();
    $('trip-card').classList.remove('min');
    $('trip-mini').hidden = true;
  });
  // The whole mini bar is tappable — easier to hit on a moving bus.
  $('trip-mini').addEventListener('click', function () {
    tapBuzz();
    $('trip-card').classList.remove('min');
    $('trip-mini').hidden = true;
  });
  $('trip-from-btn').addEventListener('click', function () { openTripSearch('from'); });
  $('trip-to-btn').addEventListener('click', function () { openTripSearch('to'); });
  $('trip-search-back').addEventListener('click', function () { showTripView('planner'); renderTripFields(); });
  $('trip-search-input').addEventListener('input', function (e) { renderTripSearchResults(e.target.value); });
  $('trip-swap').addEventListener('click', function () {
    tapBuzz();
    cancelTripFly();
    var f = tripFrom, t = tripTo;
    // A location origin can't become a destination; it yields its slot.
    tripFrom = (t && t.kind === 'stop') ? t : null;
    tripTo = (f && f.kind === 'stop') ? f : null;
    renderTripFields(); updateTripMarkers(); maybeReplan();
  });
  $('trip-now-btn').addEventListener('click', function () {
    tripLeaveMode = 'now'; tripLeaveTime = '';
    renderTripFields(); maybeReplan();
  });
  $('trip-time-input').addEventListener('change', function (e) {
    if (e.target.value) { tripLeaveMode = 'at'; tripLeaveTime = e.target.value; }
    else { tripLeaveMode = 'now'; tripLeaveTime = ''; }
    renderTripFields(); maybeReplan();
  });
  renderer.domElement.addEventListener('pointerdown', function () { cancelTripFly(); });

  // --- filters ---------------------------------------------------------------
  // filterState.routes[rid] is the ONLY visibility gate: any route can be
  // toggled on its own, no group header required. Group headers are bulk
  // setters (all on / all off); they never gate individual routes.
  // filterState.hideIdle (default ON): fully hide routes confirmed not-running.
  // filterState.nearMe: only routes with a stop within NEAR_ME_M of you.
  var filterState = { groups: {}, routes: {}, hideIdle: true, nearMe: false };
  var NEAR_ME_M = 1250;
  var nearMeSet = null;   // rid -> true, rebuilt when you move or toggle
  var userXZ = null;      // your projected position, set by onLocated
  var pendingNearMe = false;

  // True when the near-me filter lets this route through (or is off).
  function routeNearOk(rid) {
    return !filterState.nearMe || !!(nearMeSet && nearMeSet[rid]);
  }

  function routeIsOn(rid) {
    var r = routeById[rid];
    return !!(r && filterState.routes[rid]);
  }

  // 'all' | 'none' | 'mixed' — derived from the routes, never stored.
  function groupSelState(gid) {
    var rids = groupRoutes[gid] || [];
    if (!rids.length) return 'none';
    var on = 0;
    rids.forEach(function (rid) { if (filterState.routes[rid]) on++; });
    if (on === 0) return 'none';
    if (on === rids.length) return 'all';
    return 'mixed';
  }

  // Smart disabling: non-running routes are hidden when hideIdle is on,
  // dimmed when it is off. 'unknown' (pre-first-poll) never hides.
  function routeShown(rid) {
    if (!routeIsOn(rid)) return false;
    if (!routeNearOk(rid)) return false;
    // QLINE is exempt from hideIdle: the streetcar geometry should be visible
    // even when no streetcars are running (overnight, Sundays). The route
    // has a live feed; it just doesn't run 24/7.
    if (rid !== 'QLINE' && filterState.hideIdle && runningState[rid] === 'not-running') return false;
    return true;
  }

  function computeNearMe() {
    nearMeSet = {};
    if (!userXZ || !stopData) return;
    var r2 = NEAR_ME_M * NEAR_ME_M;
    for (var i = 0; i < stopData.length; i++) {
      var s = stopData[i];
      var dx = s.x - userXZ[0], dz = s.z - userXZ[1];
      if (dx * dx + dz * dz > r2) continue;
      for (var j = 0; j < s.r.length; j++) nearMeSet[s.r[j]] = true;
    }
    // Foundational rule: proximity wins. A route near the user is always
    // enabled — its group/route filter is switched on so near-me results are
    // actually drawn, not silently suppressed by an off toggle. Auto-enables
    // are tracked in nearMeAdded and reverted when near-me disengages, so a
    // temporary mode never permanently mutates the user's filter choices.
    Object.keys(nearMeSet).forEach(function (rid) {
      if (!filterState.routes[rid]) { filterState.routes[rid] = true; nearMeAdded[rid] = true; }
    });
  }

  var nearMeSnapshot = null; // filterState.routes copy taken when near-me engages
  var nearMeAdded = {};      // rids whose on-state is attributable to near-me

  function setNearMe(on) {
    filterState.nearMe = on;
    pendingNearMe = false;
    var t = $('nearme-toggle');
    if (t) t.setAttribute('aria-pressed', String(on));
    if (on) {
      nearMeSnapshot = {};
      routeOrder.forEach(function (rid) { nearMeSnapshot[rid] = !!filterState.routes[rid]; });
      nearMeAdded = {};
      computeNearMe();
    } else if (nearMeSnapshot) {
      Object.keys(nearMeAdded).forEach(function (rid) {
        filterState.routes[rid] = !!nearMeSnapshot[rid];
      });
      nearMeSnapshot = null;
      nearMeAdded = {};
    }
    applyFilters();
    syncFilterUI();
    refreshFilterCounts();
    if (on) {
      var n = nearMeSet ? Object.keys(nearMeSet).length : 0;
      showToast(n ? n + ' routes within ' + NEAR_ME_M + ' m of you.' : 'No routes within ' + NEAR_ME_M + ' m of you.', !n);
    } else {
      hideToast();
    }
  }

  // --- route selection (owner directive 2026-11-05) -------------------
  // Route labels and guideway lines are pick targets: a tap that no bus
  // or stop claims resolves to a route (label first, then the line
  // under the tap), which highlights the route (every other shown route
  // dims through applyDim) and opens its details card. Before this,
  // canvas taps resolved only to buses and stops, so a tap on a route
  // label in a sparse corridor — Downriver 160 is the reported case —
  // produced no feedback at all: at district zoom the corridor's stops
  // are not drawn and no bus sits within the arbitration radii. Dense
  // routes masked the gap because their labels sit on top of pickable
  // buses and stops. (The data files' geometry_pending flag is never
  // read by this code; it gates nothing.)
  var selectedRoute = null;
  var _routeStopsCache = {};
  var _routeLenCache = {};
  function routeStopsCount(rid) {
    if (_routeStopsCache[rid] != null) return _routeStopsCache[rid];
    var n = 0;
    if (stopData) for (var i = 0; i < stopData.length; i++) {
      if ((stopData[i].r || []).indexOf(rid) >= 0) n++;
    }
    _routeStopsCache[rid] = n;
    return n;
  }
  function routeLengthKm(rid) {
    if (_routeLenCache[rid] != null) return _routeLenCache[rid];
    var r = routeById[rid], best = 0;
    if (r && r.paths) r.paths.forEach(function (p) {
      var len = 0;
      for (var i = 1; i < p.length; i++) len += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      if (len > best) best = len;
    });
    _routeLenCache[rid] = best / 1000;
    return _routeLenCache[rid];
  }
  var _routeV3 = null;
  function pickRouteLabel(cx, cy, isTouch) {
    var r = renderer.domElement.getBoundingClientRect();
    if (!_routeV3) _routeV3 = new THREE.Vector3();
    var best = null, bestScore = Infinity;
    for (var i = 0; i < labelSprites.length; i++) {
      var L = labelSprites[i];
      if (!L.sprite.visible) continue;
      var grp = routeGroups[L.routeId];
      if (!grp || !grp.visible) continue;
      _routeV3.copy(L.sprite.position);
      var dist = camera.position.distanceTo(_routeV3);
      _routeV3.project(camera);
      if (_routeV3.z > 1 || _routeV3.z < -1) continue;
      var px = (_routeV3.x * 0.5 + 0.5) * r.width;
      var py = (-_routeV3.y * 0.5 + 0.5) * r.height;
      var wpp = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / r.height;
      if (!(wpp > 0)) continue;
      var halfW = (L.sprite.scale.x / 2) / wpp + (isTouch ? 10 : 4);
      var halfH = (L.sprite.scale.y / 2) / wpp + (isTouch ? 10 : 4);
      var dx = Math.abs(px - (cx - r.left)), dy = Math.abs(py - (cy - r.top));
      if (dx <= halfW && dy <= halfH) {
        var score = Math.max(dx / halfW, dy / halfH);
        if (score < bestScore) { bestScore = score; best = L.routeId; }
      }
    }
    return best;
  }
  function pickRouteLine(cx, cy, isTouch) {
    var r = renderer.domElement.getBoundingClientRect();
    pointerNDC.set(((cx - r.left) / r.width) * 2 - 1, -(((cy - r.top) / r.height) * 2 - 1));
    raycaster.setFromCamera(pointerNDC, camera);
    var o = raycaster.ray.origin, d = raycaster.ray.direction;
    if (Math.abs(d.y) < 1e-9) return null;
    var best = null, bestD = Infinity;
    for (var ri = 0; ri < routeOrder.length; ri++) {
      var rid = routeOrder[ri];
      if (!routeShown(rid)) continue;
      var rec = routeById[rid];
      if (!rec || !rec.paths) continue;
      // Deck-plane accuracy (camera pass, 2026-11-05): each route's
      // guideway deck floats at its own level (66 + route index x 1.2 in
      // buildRouteGroup's layer cake), so the tap ray meets THIS route's
      // deck plane and the pixel allowance is measured at that point. A
      // single shared plane misplaces the tap by the height difference
      // x tan(polar) — up to ~90 m for the highest decks at max tilt.
      var rIdx = routeIndexById[rid];
      var yDeck = 66 + (typeof rIdx === 'number' ? rIdx : 0) * 1.2 + 0.6;
      var t = (yDeck - o.y) / d.y;
      if (t < 0) continue;
      var px = o.x + d.x * t, pz = o.z + d.z * t;
      var distC = Math.sqrt((camera.position.x - px) * (camera.position.x - px) +
        (camera.position.y - yDeck) * (camera.position.y - yDeck) +
        (camera.position.z - pz) * (camera.position.z - pz));
      var wpp = (2 * distC * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / r.height;
      var thresh = 36 + (isTouch ? 26 : 14) * (wpp > 0 ? wpp : 0);
      for (var pi = 0; pi < rec.paths.length; pi++) {
        var p = rec.paths[pi];
        for (var si = 1; si < p.length; si++) {
          var ax = p[si - 1][0], az = p[si - 1][1], bx = p[si][0], bz = p[si][1];
          var abx = bx - ax, abz = bz - az;
          var l2 = abx * abx + abz * abz;
          var u = l2 ? ((px - ax) * abx + (pz - az) * abz) / l2 : 0;
          u = u < 0 ? 0 : (u > 1 ? 1 : u);
          var qx = ax + abx * u - px, qz = az + abz * u - pz;
          var dd = Math.sqrt(qx * qx + qz * qz);
          if (dd <= thresh && dd < bestD) { bestD = dd; best = rid; }
        }
      }
    }
    return best;
  }
  function renderRouteCard(rid) {
    var rec = routeById[rid];
    if (!rec) return;
    $('route-title').textContent = routeLabel(rid);
    var st = runningState[rid];
    $('route-status').textContent = st === 'running' ? 'Running now'
      : st === 'not-running' ? 'Not running now' : 'Awaiting live data';
    var n = (typeof liveCounts !== 'undefined' && liveCounts && liveCounts[rid]) || 0;
    $('route-live').textContent = n + (n === 1 ? ' bus' : ' buses') + ' on the road now';
    $('route-stops').textContent = routeStopsCount(rid) + ' stops';
    var km = routeLengthKm(rid);
    $('route-len').textContent = km ? km.toFixed(1) + ' km' : '–';
    var al = (typeof alertsForRoute === 'function') ? alertsForRoute(rid) : [];
    var aEl = $('route-alerts');
    if (aEl) {
      if (al.length) {
        aEl.hidden = false;
        aEl.textContent = al.length + (al.length === 1 ? ' active service alert' : ' active service alerts') + ' on this route.';
      } else aEl.hidden = true;
    }
  }
  function showRoute(rid) {
    if (!routeById[rid]) return;
    setFollow(null);
    exclCover('route');
    tapBuzz();
    selectedRoute = rid;
    routeOrder.forEach(applyDim);
    renderRouteCard(rid);
    $('route-card').hidden = false;
    if (document.activeElement && !$('route-card').contains(document.activeElement)) $('route-card').focus();
    announceSr('Route details opened. ' + routeLabel(rid) + '.');
  }
  function clearRouteSelection() {
    var c = $('route-card');
    if (!selectedRoute) { if (c) c.hidden = true; return; }
    selectedRoute = null;
    routeOrder.forEach(applyDim);
    if (c) c.hidden = true;
  }
  function hideRoute() {
    clearRouteSelection();
    exclRestore();
  }
  $('route-close').addEventListener('click', hideRoute);
  flStateProvider = function () {
    try {
      return { cam: camera.position.toArray(), tgt: controls.target.toArray(), route: selectedRoute || null };
    } catch (e) { return null; }
  };
  $('route-card').addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); hideRoute(); } });

  function applyDim(rid) {
    var g = routeGroups[rid];
    if (!g) return;
    // Honest rendering: only a route with a live bus on it right now renders
    // bright. 'unknown' (not yet confirmed by the feed) and 'not-running'
    // both dim — the map never implies a route is active before live data
    // proves it. ('not-running' is additionally hidden when hideIdle is on.)
    // Opacity composes with the street-view guideway fade (dimmed x faded).
    // Phase 1: the dim state lands in the merged guideways' per-route
    // alpha uniform — same rule, same composition, no material to touch
    // (the pre-merge code flipped per-route materials here, and a
    // material touch forced a shader recompile).
    var dim = rid !== selectedRoute &&
      ((runningState[rid] !== 'running' && g.visible) || itineraryDims(rid) || !!selectedRoute);
    if (routeDimmed[rid] === dim) return; // unchanged: never rewrite the uniform
    routeDimmed[rid] = dim;
    refreshRouteAlpha(rid);
  }
  // Street-view guideway fade: the elevated layer cake (decks + solid skirts
  // + casing + ground glow) reads as walls at street level and buries the
  // stops and true-scale buses. In street view it eases to a whisper so the
  // street grid, stops, and buses carry the scene. The fade multiplies with
  // the running-state dimming; transparency flips only on real state changes
  // (shader recompiles are never per-frame).
  var streetGuideFade = 1, streetGuideFadeTarget = 1;
  var streetGlowMats = []; // per-route ground-glow materials (not dimmed by running state)
  // Project 22 (Neon Vector) dynamics clock: seconds, advanced by
  // easeGuideFade only while the reduced-motion preference is off
  // (P28 C-10 posture: the dynamics still, values at base). The water
  // band material's uTime uniform is written from it in the same
  // function; the glow breathing reads it there too. Uniform/property
  // writes only — zero per-frame CPU geometry work (P15 economics).
  var neonT = 0, neonLastNow = 0;
  var neonWaterTimeU = { value: 0 };
  var neonShoreTexU = { value: null };
  var neonShoreBoundsU = { value: new THREE.Vector4(0, 0, 1, 1) };
  // Phase 1: guideEntryOpacity / syncGuideEntry are gone with the
  // per-route materials they served. Per-route guide alpha now lives in
  // routeAlphaU (see refreshRouteAlpha / applyDim); the composition rule
  // is unchanged: (dimmed ? DIM_OPACITY : 1) x streetGuideFade.
  function easeGuideFade() {
    var d = streetGuideFadeTarget - streetGuideFade;
    var settled = false;
    if (Math.abs(d) < 0.005) {
      if (streetGuideFade === streetGuideFadeTarget) settled = true;
      streetGuideFade = streetGuideFadeTarget;
    } else {
      streetGuideFade += d * 0.12;
    }
    if (!settled) {
      for (var ri = 0; ri < routeOrder.length; ri++) refreshRouteAlpha(routeOrder[ri]);
    }
    // Project 22 (Neon Vector): advance the dynamics clock (frozen
    // under reduced motion, P28 C-10) and write the water uTime.
    var neonNow = performance.now();
    if (neonLastNow) {
      var neonDt = Math.min(0.1, (neonNow - neonLastNow) / 1000);
      if (!((typeof reducedMotion !== 'undefined') && reducedMotion)) neonT += neonDt;
    }
    neonLastNow = neonNow;
    var rmNow = (typeof reducedMotion !== 'undefined') && reducedMotion;
    neonWaterTimeU.value = rmNow ? 0 : neonT;
    // Shared casing + ground glows answer only to the street fade.
    // The glow ribbon breathes 0.20 +/- 0.03 on a 12 s sine (cabinet
    // idle life); under reduced motion it sits at the 0.20 base.
    var glowBase = rmNow ? 0.20 : 0.20 + 0.03 * Math.sin(neonT * (Math.PI * 2 / 12));
    if (typeof casingMat !== 'undefined' && casingMat) {
      casingMat.opacity = 0.95 * streetGuideFade;
    }
    for (var gi = 0; gi < streetGlowMats.length; gi++) {
      streetGlowMats[gi].opacity = glowBase * streetGuideFade;
    }
  }

  // --- Street extension tier --------------------------------------------------
  // Street segments outside STREET_BOUNDS (Downriver, western suburbs) live
  // in streetExt, displayed only while the SMART filter group is displayed
  // (restored with the SMART reactivation, 2026-10-15).
  var streetExt = null;          // THREE.Group (assigned in buildStreets)
  var streetExtLocal = null;     // extension local tier (own LOD rule)
  var streetExtMats = [];        // {mat, baseOpacity} faded together
  var streetExtFade = 0, streetExtFadeTarget = 0;
  var streetExtFadeFrom = 0, streetExtFadeT0 = 0, streetExtFadeDur = 1;
  var STREET_EXT_FADE_MS = 900;
  // Called from applyFilters: starts (or reverses) the fade when the SMART
  // group's displayed state changes. Reversing mid-fade continues from the
  // current opacity — never a snap.
  function syncStreetExt() {
    if (!streetExt) return;
    var on = false;
    try { on = groupSelState('smart') !== 'none'; } catch (e) {}
    var target = on ? 1 : 0;
    if (target === streetExtFadeTarget) return;
    streetExtFadeFrom = streetExtFade;
    streetExtFadeTarget = target;
    streetExtFadeT0 = performance.now();
    // Duration scales with remaining distance: a full fade takes 900 ms,
    // a mid-fade reversal covers only what's left.
    streetExtFadeDur = Math.max(1, STREET_EXT_FADE_MS * Math.abs(target - streetExtFadeFrom));
    if (target === 1) streetExt.visible = true;
  }
  function stepStreetExtFade(now) {
    if (!streetExt || streetExtFade === streetExtFadeTarget) return;
    var t = Math.min(1, (now - streetExtFadeT0) / streetExtFadeDur);
    // Minimum-jerk easing: the same rest-to-rest profile as the camera glide.
    var e = t * t * t * (t * (t * 6 - 15) + 10);
    streetExtFade = streetExtFadeFrom + (streetExtFadeTarget - streetExtFadeFrom) * e;
    for (var i = 0; i < streetExtMats.length; i++) {
      var m = streetExtMats[i];
      m.mat.opacity = m.baseOpacity * streetExtFade;
    }
    if (t >= 1) {
      streetExtFade = streetExtFadeTarget;
      // Perf: fully faded-out geometry leaves the render path entirely.
      if (streetExtFadeTarget === 0) streetExt.visible = false;
    }
  }

  function applyFilters() {
    if (selectedRoute && !routeIsOn(selectedRoute)) clearRouteSelection();
    routeOrder.forEach(function (rid) {
      if (routeGroups[rid]) routeGroups[rid].visible = routeShown(rid);
      // Phase 1: the merged guideways read the same gate result from the
      // visibility uniform — one rule, two render paths (group children
      // via .visible, merged geometry via uRouteVis discard).
      var _rIdx = routeIndexById[rid];
      if (_rIdx != null) routeVisU.value[_rIdx] = routeShown(rid) ? 1 : 0;
      applyDim(rid);
    });
    groupOrder.forEach(function (gid) {
      if (groupObjs[gid]) groupObjs[gid].visible = groupSelState(gid) !== 'none';
    });
    rebuildStops();
    if (lastVehicles) updateBuses(lastVehicles);
    reconcileBusCard(); // candidate C1: an open bus card obeys the gate
    refreshHeaderCount();
    syncStreetExt();
    // Announce filter changes through #sr-status, but only when the number
    // of shown routes actually changes — applyFilters also runs on every
    // live poll, and repeating an unchanged count would spam screen readers.
    // The first call just records the baseline shown count.
    var _shownNow = 0;
    routeOrder.forEach(function (rid) { if (routeShown(rid)) _shownNow++; });
    if (_srFilterShown !== null && _shownNow !== _srFilterShown) {
      announceSr(_shownNow + (_shownNow === 1 ? ' route' : ' routes') + ' shown on the map.');
    }
    _srFilterShown = _shownNow;
  }

  function syncFilterUI() {
    groupOrder.forEach(function (gid) {
      var st = groupSelState(gid);
      var check = document.querySelector('.f-group-head[data-group="' + gid + '"] .f-check');
      var sec = document.querySelector('.f-group[data-group="' + gid + '"]');
      if (check) check.setAttribute('aria-pressed', st === 'mixed' ? 'mixed' : String(st === 'all'));
      if (sec) sec.classList.toggle('off', st === 'none');
    });
    routeOrder.forEach(function (rid) {
      var b = document.querySelector('.f-chip[data-route="' + rid + '"]');
      if (b) b.setAttribute('aria-pressed', String(!!filterState.routes[rid]));
    });
    var idle = $('hide-idle-toggle');
    if (idle) idle.setAttribute('aria-pressed', String(!!filterState.hideIdle));
    var pmT = $('pm-toggle');
    if (pmT) pmT.setAttribute('aria-pressed', String(!!pmVisible));
    var mgT = $('mogo-toggle');
    if (mgT && typeof mogoVisible !== 'undefined') mgT.setAttribute('aria-pressed', String(mogoVisible));
  }

  function buildFilterPanel(groups) {
    var host = $('filter-groups');
    host.innerHTML = '';
    groups.forEach(function (g) {
      // Calm default: only the ConnectTen core network is on. The panel
      // opens as an accordion (3 rows); route chips expand per group.
      var gOn = (g.id === 'connect-ten');
      var gLabel = g.name;
      // SMART (reactivated 2026-10-15; production uplift 2026-10-15):
      // default ON like DDOT/QLINE. A stored visitor preference still
      // wins: lt-smart-on '0' keeps SMART off, '1' keeps it on; only
      // a fresh profile (no stored value) starts ON.
      if (g.id === 'smart') {
        try { gOn = localStorage.getItem('lt-smart-on') !== '0'; } catch (e) { gOn = true; }
      }
      filterState.groups[g.id] = gOn;
      var sec = document.createElement('div');
      sec.className = 'f-group';
      sec.dataset.group = g.id;
      var head = document.createElement('div');
      head.className = 'f-group-head';
      head.dataset.group = g.id;
      var check = document.createElement('button');
      check.className = 'f-check';
      check.setAttribute('aria-label', 'Toggle all ' + gLabel + ' routes');
      check.innerHTML = '<span class="f-box"></span>';
      check.addEventListener('click', function () {
        var on = groupSelState(g.id) !== 'all'; // all-on -> switch off; else switch on
        filterState.groups[g.id] = on;
        if (g.id === 'smart') { try { localStorage.setItem('lt-smart-on', on ? '1' : '0'); } catch (e) {} }
        g.routes.forEach(function (rid) { filterState.routes[rid] = on; delete nearMeAdded[rid]; });
        applyFilters();
        syncFilterUI();
      });
      var label = document.createElement('button');
      label.className = 'f-label';
      label.setAttribute('aria-expanded', 'false');
      label.setAttribute('aria-label', 'Expand ' + gLabel + ' routes');
      // Built with DOM nodes, not innerHTML (security remediation R7,
      // 2026-10-23): gLabel and the group id are data-file values, and
      // feed-derived strings never enter innerHTML in this app.
      var lb = document.createElement('b');
      lb.textContent = gLabel;
      label.appendChild(lb);
      if (g.id === 'smart') {
        var sa = document.createElement('span');
        sa.className = 'f-count'; sa.id = 'smart-age-label';
        label.appendChild(sa);
      }
      var fc = document.createElement('span');
      fc.className = 'f-count'; fc.id = 'fgc-' + g.id; fc.textContent = '–';
      label.appendChild(fc);
      var chv = document.createElement('span');
      chv.className = 'f-chev'; chv.textContent = '▾';
      label.appendChild(chv);
      label.addEventListener('click', function () {
        var open = sec.classList.toggle('open');
        label.setAttribute('aria-expanded', String(open));
      });
      head.appendChild(check);
      head.appendChild(label);
      var list = document.createElement('div');
      list.className = 'f-routes';
      g.routes.slice().sort(function (a, b) {
        // Name-alphabetical within the group (convention, 2026-10-11);
        // the data files list routes in numeric order.
        return routeLabel(a).localeCompare(routeLabel(b));
      }).forEach(function (rid) {
        var route = routeById[rid];
        if (!route) return;
        filterState.routes[rid] = gOn;
        var b = document.createElement('button');
        b.className = 'route-chip f-chip';
        b.setAttribute('aria-pressed', 'true');
        b.dataset.route = rid;
        // Route display name: "name - number" unless they're identical (QLINE).
        var chipName = routeLabel(rid);
        // DOM nodes, not innerHTML (R7, as above): route.color and
        // chipName are feed-derived values.
        var dot = document.createElement('i');
        dot.style.background = route.color;
        b.appendChild(dot);
        var bn = document.createElement('b');
        bn.textContent = chipName;
        b.appendChild(bn);
        var cnt = document.createElement('span');
        cnt.className = 'cnt'; cnt.id = 'cnt-' + rid; cnt.textContent = '–';
        b.appendChild(cnt);
        var idle = document.createElement('span');
        idle.className = 'idle-tag'; idle.id = 'idle-' + rid; idle.hidden = true;
        idle.textContent = 'not running';
        b.appendChild(idle);
        b.addEventListener('click', function () {
          filterState.routes[rid] = !filterState.routes[rid];
          delete nearMeAdded[rid]; // user's explicit choice now owns this route
          applyFilters();
          syncFilterUI();
        });
        list.appendChild(b);
      });
      sec.appendChild(head);
      sec.appendChild(list);
      if (g.id === 'smart') {
        // S6/S9: the group note carries the derived route count and
        // the live source; the freshness sentence (smart-age-note) is set
        // by applySmartAgeUI and stays empty while the feed is fresh.
        var smartNote = document.createElement('p');
        smartNote.className = 'f-smart-note';
        smartNote.textContent = 'All ' + g.routes.length + ' routes have map lines. Vehicle positions via Swiftly GTFS-Realtime.';
        var smartAgeNote = document.createElement('span');
        smartAgeNote.id = 'smart-age-note';
        smartNote.appendChild(smartAgeNote);
        sec.appendChild(smartNote);
      }
      host.appendChild(sec);
    });
    applySmartAgeUI();
    $('filter-all').addEventListener('click', function () {
      // "Show all" means all: the near-me proximity restriction must not
      // override it, so near-me is switched off first.
      if (filterState.nearMe) setNearMe(false);
      groupOrder.forEach(function (gid) { filterState.groups[gid] = true; });
      routeOrder.forEach(function (rid) { filterState.routes[rid] = true; });
      try { localStorage.setItem('lt-smart-on', '1'); } catch (e) {}
      applyFilters();
      syncFilterUI();
    });
    $('filter-none').addEventListener('click', function () {
      // Symmetric case: "All off" must not be undone by the near-me
      // auto-enable on the next location update.
      if (filterState.nearMe) setNearMe(false);
      groupOrder.forEach(function (gid) { filterState.groups[gid] = false; });
      routeOrder.forEach(function (rid) { filterState.routes[rid] = false; });
      try { localStorage.setItem('lt-smart-on', '0'); } catch (e) {}
      applyFilters();
      syncFilterUI();
    });
    $('hide-idle-toggle').addEventListener('click', function () {
      filterState.hideIdle = !filterState.hideIdle;
      applyFilters();
      syncFilterUI();
    });
    $('nearme-toggle').addEventListener('click', function () {
      if (filterState.nearMe) { setNearMe(false); return; }
      if (userXZ) { setNearMe(true); return; }
      // No fix yet: run the locate flow; it enables near-me on success.
      pendingNearMe = true;
      locateBtn.click();
    });
    // People Mover static layer: independent of the DDOT route filters —
    // "Show all"/"All off" and near-me never touch it. Own toggle, own state.
    var pmT = $('pm-toggle');
    if (pmT) pmT.addEventListener('click', function () {
      pmVisible = !pmVisible;
      if (pmGroup) pmGroup.visible = pmVisible;
      pmT.setAttribute('aria-pressed', String(pmVisible));
      if (!pmVisible && selectedStop && selectedStop.pm) hideStop();
    });
  }

  // --- People Mover: stations + downtown loop (static) -------------------------
  // Source: Detroit People Mover GTFS static (agency permalink), projected
  // with the same lat0/lon0 as ddot-routes-3d.json so geometry aligns.
  // Visual language: Concrete #9F9F9F deck (reads as infrastructure, distinct
  // from the saturated live-route colors), paper-white station pins, narrow
  // 14 m single-track guideway (automated, one direction — not a bus corridor).
  // Elevated at PM_DECK_Y with open air beneath: no continuous skirt, pillars
  // only at stations, so ground-level stops, buses and buildings stay visible.
  // Off by default; the pm-toggle enables it. Nothing here implies
  // live vehicles: no beacons, no "LIVE" marker, and the filter-panel note
  // states the static provenance outright.
  function buildPeopleMover(pm) {
    // Pseudo-route registration so the shared stop card renders a proper
    // chip ("DPM · Detroit People Mover"). Kept OUT of routeOrder: the
    // DDOT filter/dim/near-me machinery must never touch this layer.
    routeColors['DPM'] = new THREE.Color(0x9F9F9F);
    routeNames['DPM'] = 'Detroit People Mover';

    pmGroup = new THREE.Group();
    pmGroup.name = 'people-mover';
    var concrete = new THREE.Color(0x9F9F9F);
    var deckMat = new THREE.MeshLambertMaterial({ color: concrete, side: THREE.DoubleSide });
    var skirtMat = new THREE.MeshLambertMaterial({ color: concrete.clone().multiplyScalar(0.35), side: THREE.DoubleSide });
    var loop = pm.loop.slice();
    // Single-track elevated guideway, 14 m wide: narrow enough that street-level
    // endpoints (stops, buses, buildings) stay visible beneath it. No continuous
    // skirt — the solid wall obscured ground objects. Support pillars render
    // ONLY at station locations (the known points), not as invented infill.
    pmGroup.add(new THREE.Mesh(ribbonGeometry(loop, 14, PM_DECK_Y), deckMat));
    var pillarGeo = new THREE.CylinderGeometry(6, 9, PM_DECK_Y, 10);
    var pillarMat = new THREE.MeshLambertMaterial({ color: concrete.clone().multiplyScalar(0.55) });

    var pinGeo = new THREE.CylinderGeometry(24, 32, 300, 12);
    var pinMat = new THREE.MeshLambertMaterial({ color: 0xF2F2F2 });
    var ringGeo = new THREE.RingGeometry(40, 64, 32);
    var ringMat = new THREE.MeshBasicMaterial({ color: 0xF2F2F2, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
    pmStations = pm.stations.map(function (s) {
      var pin = new THREE.Mesh(pinGeo, pinMat);
      pin.position.set(s.x, PM_DECK_Y + 150, s.z);
      pmGroup.add(pin);
      pmPins.push(pin);
      var pillar = new THREE.Mesh(pillarGeo, pillarMat);
      pillar.position.set(s.x, PM_DECK_Y / 2, s.z);
      pmGroup.add(pillar);
      var ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(s.x, PM_DECK_Y + 3, s.z);
      pmGroup.add(ring);
      return { id: s.id, n: s.name, x: s.x, z: s.z, r: ['DPM'], pm: true };
    });

    var mid = loop[Math.floor(loop.length / 2)];
    pmLabel = makeLabel('People Mover · Downtown Loop', '#9F9F9F');
    pmLabel.position.set(mid[0], 1050, mid[1]);
    pmGroup.add(pmLabel);
    pmTether = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(mid[0], PM_DECK_Y, mid[1]),
        new THREE.Vector3(mid[0], 980, mid[1])
      ]),
      new THREE.LineBasicMaterial({ color: 0x9F9F9F, transparent: true, opacity: 0.45 })
    );
    pmGroup.add(pmTether);
    pmGroup.visible = pmVisible;
    scene.add(pmGroup);
  }

  // Belle Isle landmass: true-form OSM island outline (assets/belle-isle.json).
  // Route 12 serves the island, but the uniform dark ground rendered no island
  // at all. Filled polygon at y=3 (above ground, below the street tiers),
  // dark park-green with a shoreline stroke, plus a floating place label.
  // Optional layer: absent file = no island, map otherwise unaffected.
  function buildBelleIsle(B) {
    if (!B || !B.polygon || B.polygon.length < 3) return;
    var contour = [];
    for (var i = 0; i < B.polygon.length; i++) {
      contour.push(new THREE.Vector2(B.polygon[i][0], B.polygon[i][1]));
    }
    var faces = THREE.ShapeUtils.triangulateShape(contour, []);
    var pos = [];
    for (var f = 0; f < faces.length; f++) {
      for (var k = 0; k < 3; k++) {
        var v = contour[faces[f][k]];
        pos.push(v.x, 0, v.y);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    var island = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x101010 }));
    island.position.y = 3;
    island.renderOrder = 1;
    scene.add(island);
    var shorePts = [];
    for (var s = 0; s < B.polygon.length; s++) {
      shorePts.push(new THREE.Vector3(B.polygon[s][0], 4, B.polygon[s][1]));
    }
    var shore = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(shorePts),
      new THREE.LineBasicMaterial({ color: 0x434343, transparent: true, opacity: 0.9 })
    );
    shore.renderOrder = 2;
    scene.add(shore);
    var lx = B.label ? B.label.x : 14015, lz = B.label ? B.label.z : 4478;
    belleIsleLabel = makeLabel('Belle Isle', '#B0B0B0');
    belleIsleLabel.position.set(lx, 560, lz);
    belleIsleLabel.renderOrder = 36;
    scene.add(belleIsleLabel);
    belleIsleTether = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(lx, 4, lz),
        new THREE.Vector3(lx, 490, lz)
      ]),
      new THREE.LineBasicMaterial({ color: 0xb0b0b0, transparent: true, opacity: 0.4 })
    );
    scene.add(belleIsleTether);
  }

  // Belle Isle topography (HD upgrade, 2026-11-05): USGS NED 1/3
  // arc-second elevations on a 60 m grid (assets/belle-isle-topo.json),
  // drawn as a monochrome relief mesh over the flat island fill —
  // vertex grays from height + slope, heights exaggerated 4x (the
  // island's true relief is ~5.6 m over 4.3 km; at true scale it would
  // read as flat) — plus 1 m contour lines, the 176 m line doubling as
  // the surveyed waterline. Optional layer: absent file = the flat
  // island exactly as before. Static geography: never a pick target.
  var BELLE_EXAG = 4, BELLE_BASE_Y = 3.15, BELLE_WATER = 174.9;
  function belleY(h) { return BELLE_BASE_Y + (h - BELLE_WATER) * BELLE_EXAG; }
  function buildBelleIsleTopo(T, B) {
    if (!T || !T.grid || !B || !B.polygon) return;
    var G = T.grid, nx = G.nx, nz = G.nz, step = G.step, H = G.heights;
    if (!H || H.length < nx * nz) return;
    var poly = B.polygon;
    function inside(x, z) {
      var c = false;
      for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        var xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
        if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
      }
      return c;
    }
    function hAt(i, j) { return H[j * nx + i]; }
    var pos = [], col = [];
    function vert(i, j) {
      var x = G.x0 + i * step, z = G.z0 + j * step, h = hAt(i, j);
      pos.push(x, belleY(h), z);
      var gx = (hAt(Math.min(i + 1, nx - 1), j) - hAt(Math.max(i - 1, 0), j)) / (2 * step);
      var gz = (hAt(i, Math.min(j + 1, nz - 1)) - hAt(i, Math.max(j - 1, 0))) / (2 * step);
      var ramp = Math.max(0, Math.min(1, (h - BELLE_WATER) / 5.6));
      var shade = Math.max(-1, Math.min(1, (gx - gz) * 6));
      var g = 0.075 + ramp * 0.075 + shade * 0.028;
      col.push(g, g, g);
    }
    for (var cj = 0; cj < nz - 1; cj++) {
      for (var ci = 0; ci < nx - 1; ci++) {
        var cx = G.x0 + (ci + 0.5) * step, cz = G.z0 + (cj + 0.5) * step;
        if (!inside(cx, cz)) continue;
        vert(ci, cj); vert(ci + 1, cj); vert(ci, cj + 1);
        vert(ci + 1, cj); vert(ci + 1, cj + 1); vert(ci, cj + 1);
      }
    }
    if (pos.length) {
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.computeVertexNormals();
      var mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true }));
      mesh.renderOrder = 1;
      scene.add(mesh);
    }
    if (T.contours) {
      var cpos = [];
      Object.keys(T.contours).forEach(function (lv) {
        var y = belleY(+lv) + 0.3;
        T.contours[lv].forEach(function (s) {
          cpos.push(s[0][0], y, s[0][1], s[1][0], y, s[1][1]);
        });
      });
      if (cpos.length) {
        var cg = new THREE.BufferGeometry();
        cg.setAttribute('position', new THREE.Float32BufferAttribute(cpos, 3));
        var lines = new THREE.LineSegments(cg, new THREE.LineBasicMaterial({
          color: 0x2b2b2b, transparent: true, opacity: 0.8
        }));
        lines.renderOrder = 2;
        scene.add(lines);
      }
    }
  }

  // Project 16 (Default View Uplift): static water + far-shore layer.
  // Geometry: assets/detroit-water.json — TIGER/Line 2025 areawater and
  // OSM natural=water unioned, clipped to MOSAIC_BOUNDS, simplified at
  // 3 m, pre-projected to scene meters by dvu-build/build_water.py
  // (authoritative sources only; never hand-drawn). Draw calls: main
  // fill at y=2 (above the ground plane, below the Belle Isle landmass
  // fill at y=3 and the street tiers), Belle Isle interior fill at
  // y=4.5 (above the island fill, so its canals and lakes read),
  // far-shore landmass tint at y=1 (the Windsor shore: geometry and a
  // label, deliberately unmapped — no streets or routes exist in this
  // map's data for it), and one merged shoreline stroke tracing every
  // ring. Static geography: meshes join the scene only, NEVER any pick
  // target list — tap resolution is unchanged by construction.
  function buildWater(W) {
    if (!W || !W.polygons) return;
    function triGeo(entries) {
      var pos = [];
      var bad = 0;
      entries.forEach(function (e) {
        if (!e.rings || !e.rings.length || e.rings[0].length < 3) return;
        try {
          var contour = e.rings[0].map(function (p) { return new THREE.Vector2(p[0], p[1]); });
          var holes = [];
          var all = contour.slice();
          for (var h = 1; h < e.rings.length; h++) {
            var hole = e.rings[h].map(function (p) { return new THREE.Vector2(p[0], p[1]); });
            holes.push(hole);
            all = all.concat(hole);
          }
          var faces = THREE.ShapeUtils.triangulateShape(contour, holes);
          for (var f = 0; f < faces.length; f++) {
            for (var k = 0; k < 3; k++) {
              var v = all[faces[f][k]];
              pos.push(v.x, 0, v.y);
            }
          }
        } catch (err) { bad++; }
      });
      if (bad) console.warn('buildWater: skipped ' + bad + ' degenerate polygons');
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      return g;
    }
    function fillMesh(entries, y, color) {
      var m = new THREE.Mesh(triGeo(entries),
        new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide }));
      m.position.y = y;
      m.renderOrder = 1;
      scene.add(m);
      return m;
    }
    // Project 22, Treatment 1 (Neon Vector): the water fills draw hard
    // indigo bands from a baked shore-distance field — deep 0x101010
    // (>= 300 m from shore), mid 0x1f1f1f (60-300 m), shore accent
    // 0x222222 (< 60 m, shimmering +/-4% via uTime). The mid band
    // carries Project 16 Option A's governing water value 0x1f1f1f
    // (A owns water luminance; the band structure, thresholds, and
    // the deep and shore-accent values are Neon Vector's): A's value
    // sits between the deep band and the shore accent on the
    // luminance scale, so it takes the mid band — as the deep band
    // it would invert the shore-brightening order. The far shore
    // fill below is A's 0x141414 for the same reason. The field is baked
    // ONCE at load into a single-channel texture: the water mask is
    // scanline-rasterized from the same rings triGeo renders, and a
    // two-pass chamfer distance transform gives every cell its
    // distance to the nearest shoreline (the gate prototypes were
    // painted by exactly this distance-transform method). A per-vertex
    // attribute cannot carry the field on this geometry — earcut
    // emits only ring vertices, all at distance 0 — and subdividing
    // to resolve the bands measured 410k triangles / ~21.6 s of load
    // time on the real data, so the bake lives in the texture and the
    // rendered geometry is byte-identical to the flat fill it
    // replaces. One shared patched material (one new shader program)
    // serves both water fills. Zero per-frame CPU: the frame loop
    // writes the uTime uniform only.
    var waterBandMat = null;
    function getWaterBandMat() {
      if (waterBandMat) return waterBandMat;
      var m = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
      m.onBeforeCompile = function (sh) {
        sh.uniforms.uTime = neonWaterTimeU;
        sh.uniforms.uShoreTex = neonShoreTexU;
        sh.uniforms.uShoreBounds = neonShoreBoundsU;
        sh.vertexShader = 'varying vec2 vWPos;\n' +
          sh.vertexShader.replace('#include <begin_vertex>',
            '#include <begin_vertex>\n\tvWPos = (modelMatrix * vec4(transformed, 1.0)).xz;');
        sh.fragmentShader = ('uniform float uTime;\nuniform sampler2D uShoreTex;\n' +
          'uniform vec4 uShoreBounds;\nvarying vec2 vWPos;\n') +
          sh.fragmentShader.replace('#include <color_fragment>',
            ['#include <color_fragment>',
             '\tvec2 shoreUv = (vWPos - uShoreBounds.xy) / uShoreBounds.zw;',
             '\tfloat shoreD = texture2D(uShoreTex, shoreUv).r * 650.0;',
             '\tvec3 waterCol = vec3(0.12157, 0.12157, 0.12157);',
             '\tif (shoreD < 300.0) waterCol = vec3(0.14510, 0.14510, 0.14510);',
             '\tif (shoreD < 60.0) waterCol = vec3(0.17647, 0.17647, 0.17647) * (1.0 + 0.04 * sin(uTime * 0.35));',
             '\tdiffuseColor.rgb = waterCol;'].join('\n'));
      };
      m.customProgramCacheKey = function () { return 'waterBand'; };
      waterBandMat = m;
      return m;
    }
    function bakeShoreField(entries) {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      entries.forEach(function (e) {
        if (!e.rings) return;
        e.rings.forEach(function (ring) {
          ring.forEach(function (p) {
            if (p[0] < minX) minX = p[0];
            if (p[0] > maxX) maxX = p[0];
            if (p[1] < minY) minY = p[1];
            if (p[1] > maxY) maxY = p[1];
          });
        });
      });
      var CELL = 20;
      var gw = Math.max(1, Math.ceil((maxX - minX) / CELL));
      var gh = Math.max(1, Math.ceil((maxY - minY) / CELL));
      var mask = new Uint8Array(gw * gh);
      entries.forEach(function (e) {
        if (!e.rings || !e.rings.length) return;
        var edges = [];
        e.rings.forEach(function (ring) {
          for (var i = 0; i < ring.length; i++) {
            var a = ring[i], b = ring[(i + 1) % ring.length];
            edges.push(a[0], a[1], b[0], b[1]);
          }
        });
        var yLo = Infinity, yHi = -Infinity;
        for (var q = 1; q < edges.length; q += 2) {
          if (edges[q] < yLo) yLo = edges[q];
          if (edges[q] > yHi) yHi = edges[q];
        }
        var r0 = Math.max(0, Math.floor((yLo - minY) / CELL));
        var r1 = Math.min(gh - 1, Math.floor((yHi - minY) / CELL));
        for (var r = r0; r <= r1; r++) {
          var wy = minY + (r + 0.5) * CELL;
          var xs = [];
          for (var ei = 0; ei < edges.length; ei += 4) {
            var x1 = edges[ei], y1 = edges[ei + 1], x2 = edges[ei + 2], y2 = edges[ei + 3];
            if ((y1 <= wy && y2 > wy) || (y2 <= wy && y1 > wy)) {
              xs.push(x1 + (wy - y1) * (x2 - x1) / (y2 - y1));
            }
          }
          if (xs.length < 2) continue;
          xs.sort(function (a, b) { return a - b; });
          for (var xi = 0; xi + 1 < xs.length; xi += 2) {
            var c0 = Math.max(0, Math.floor((xs[xi] - minX) / CELL));
            var c1 = Math.min(gw - 1, Math.floor((xs[xi + 1] - minX) / CELL));
            for (var c = c0; c <= c1; c++) mask[r * gw + c] = 1;
          }
        }
      });
      var dt = new Float32Array(gw * gh);
      var INF = 1e9, SQ2 = Math.SQRT2;
      for (var i = 0; i < dt.length; i++) dt[i] = mask[i] ? INF : 0;
      var x, y, idx, v;
      for (y = 0; y < gh; y++) {
        for (x = 0; x < gw; x++) {
          idx = y * gw + x;
          if (!mask[idx]) continue;
          v = dt[idx];
          if (x > 0) v = Math.min(v, dt[idx - 1] + 1);
          if (y > 0) {
            v = Math.min(v, dt[idx - gw] + 1);
            if (x > 0) v = Math.min(v, dt[idx - gw - 1] + SQ2);
            if (x < gw - 1) v = Math.min(v, dt[idx - gw + 1] + SQ2);
          }
          dt[idx] = v;
        }
      }
      for (y = gh - 1; y >= 0; y--) {
        for (x = gw - 1; x >= 0; x--) {
          idx = y * gw + x;
          if (!mask[idx]) continue;
          v = dt[idx];
          if (x < gw - 1) v = Math.min(v, dt[idx + 1] + 1);
          if (y < gh - 1) {
            v = Math.min(v, dt[idx + gw] + 1);
            if (x < gw - 1) v = Math.min(v, dt[idx + gw + 1] + SQ2);
            if (x > 0) v = Math.min(v, dt[idx + gw - 1] + SQ2);
          }
          dt[idx] = v;
        }
      }
      var data = new Uint8Array(gw * gh);
      for (var k = 0; k < dt.length; k++) {
        var dm = dt[k] * CELL + CELL * 0.5;
        data[k] = dm >= 650 ? 255 : Math.round(dm / 650 * 255);
      }
      var tex = new THREE.DataTexture(data, gw, gh, THREE.RedFormat);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      console.info('buildWater: shore field baked, ' + gw + 'x' + gh + ' cells at ' + CELL + ' m');
      return { tex: tex, bounds: new THREE.Vector4(minX, minY, gw * CELL, gh * CELL) };
    }
    function fillWater(entries, y) {
      var m = new THREE.Mesh(triGeo(entries), getWaterBandMat());
      m.position.y = y;
      m.renderOrder = 1;
      scene.add(m);
      return m;
    }
    if (W.farShore && W.farShore.rings) fillMesh([W.farShore], 1, 0x141414);
    var shoreField = bakeShoreField(W.islePolygons ? W.polygons.concat(W.islePolygons) : W.polygons);
    neonShoreTexU.value = shoreField.tex;
    neonShoreBoundsU.value.copy(shoreField.bounds);
    fillWater(W.polygons, 2);
    if (W.islePolygons && W.islePolygons.length) fillWater(W.islePolygons, 4.5);
    // Merged shoreline stroke: every ring of both water sets, seated
    // just above its fill so the water's edge is drawn, not implied.
    var seg = [];
    function strokeSet(entries, y) {
      entries.forEach(function (e) {
        e.rings.forEach(function (ring) {
          for (var i = 0; i < ring.length; i++) {
            var a = ring[i], b = ring[(i + 1) % ring.length];
            seg.push(a[0], y, a[1], b[0], y, b[1]);
          }
        });
      });
    }
    strokeSet(W.polygons, 2.6);
    if (W.islePolygons) strokeSet(W.islePolygons, 5.1);
    var sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    var stroke = new THREE.LineSegments(sg,
      new THREE.LineBasicMaterial({ color: 0xb6b6b6, transparent: true, opacity: 0.9 }));
    stroke.renderOrder = 2;
    scene.add(stroke);
    // Place labels join the Belle Isle / People Mover static-geography
    // family (pill + tether, visible when camDist > 7000; the frame
    // loop applies the rule). Anchor points verified inside the built
    // geometry: river point in the river polygon, lake point on the
    // lake's in-frame water, Windsor point inside the far-shore tint.
    function waterLabel(text, color, x, z) {
      var s = makeLabel(text, color);
      s.position.set(x, 560, z);
      s.renderOrder = 36;
      scene.add(s);
      var t = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(x, 3, z),
          new THREE.Vector3(x, 490, z)
        ]),
        new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.4 })
      );
      scene.add(t);
      waterLabels.push({ sprite: s, tether: t });
    }
    waterLabel('Detroit River', '#A8A8A8', 8700, 6200);
    waterLabel('Windsor', '#9F9F9F', 9336, 7532);
    waterLabel('Lake St. Clair', '#A8A8A8', 19605, 1111);
  }

  // Screen-space nearest station (mirrors the stop touch fallback: forgiving
  // at far zooms, tighter for mouse). The pins are small; raycasting them
  // would be fiddly, so proximity picking is the primary path for both.
  var _pmV3 = new THREE.Vector3();
  function pickPMStation(cx, cy, isTouch) {
    if (!pmGroup || !pmGroup.visible || !pmStations.length) return null;
    var r = renderer.domElement.getBoundingClientRect();
    var sx = cx - r.left, sy = cy - r.top;
    var best = null, bestD = isTouch ? 48 : 26;
    for (var i = 0; i < pmStations.length; i++) {
      var s = pmStations[i];
      _pmV3.set(s.x, PM_DECK_Y + 150, s.z).project(camera);
      if (_pmV3.z > 1) continue;
      var px = (_pmV3.x * 0.5 + 0.5) * r.width;
      var py = (-_pmV3.y * 0.5 + 0.5) * r.height;
      var d = Math.hypot(px - sx, py - sy);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  var _filterReturnFocus = null;
  function togglePanel(force) {
    var panel = $('filter-panel');
    var btn = $('filter-btn');
    var show = (typeof force === 'boolean') ? force : panel.hidden;
    var wasHidden = panel.hidden;
    if (show && wasHidden) exclCover('filter');
    panel.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
    if (show && wasHidden) {
      // Move focus into the panel on open: remember the opener, then
      // focus the first control (Show all).
      if (document.activeElement && !panel.contains(document.activeElement)) _filterReturnFocus = document.activeElement;
      var first = $('filter-all');
      if (first) first.focus();
    } else if (!show && !wasHidden) {
      // Return focus to the opener on close when focus was inside the
      // panel (Escape via the document handler calls togglePanel(false));
      // fall back to the Routes button so focus is not lost to <body>.
      var hadFocus = panel.contains(document.activeElement);
      if (hadFocus && _filterReturnFocus && _filterReturnFocus !== document.body && document.contains(_filterReturnFocus)) _filterReturnFocus.focus();
      else if (hadFocus) btn.focus();
      _filterReturnFocus = null;
      exclRestore();
    }
  }

  // --- header badge ------------------------------------------------------------
  var liveEverOk = false;
  var historyOk = false;
  var lastTotal = null;

  function fmtTime(when) {
    return (when && !isNaN(when)) ? when.toLocaleTimeString() : '–';
  }

  var lastHeaderText = '', lastHeaderWarn = false;
  function setHeader(total, text, warn) {
    lastHeaderText = text; lastHeaderWarn = !!warn;
    $('bus-total').textContent = (total != null) ? total : '–';
    var el = $('bus-updated');
    el.textContent = text;
    el.title = text || '';
    el.className = warn ? 'feed-warn' : '';
    fvRefreshProofs();
  }
  // The header count must follow filters immediately — a toggle that
  // empties the map while the header still claims "13 buses" is a lie.
  function refreshHeaderCount() {
    if (!lastVehicles) return;
    setHeader(busSlots.length, lastHeaderText, lastHeaderWarn);
  }

  function updateCounts() {
    routeOrder.forEach(function (rid) {
      var el = $('cnt-' + rid);
      if (el) el.textContent = String(liveCounts[rid] || 0);
      var nr = runningState[rid] === 'not-running';
      var chip = document.querySelector('.f-chip[data-route="' + rid + '"]');
      if (chip) chip.classList.toggle('not-running', nr);
      var tag = $('idle-' + rid);
      if (tag) tag.hidden = !nr;
    });
    groupOrder.forEach(function (gid) {
      var el = $('fgc-' + gid);
      if (!el) return;
      if (!liveEverOk) { el.textContent = '–'; return; }
      var run = 0, shownNear = 0, nearTot = 0;
      var tot = (groupRoutes[gid] || []).length;
      (groupRoutes[gid] || []).forEach(function (rid) {
        if (runningState[rid] === 'running') run++;
        if (filterState.nearMe && nearMeSet && nearMeSet[rid]) {
          nearTot++;
          if (routeShown(rid)) shownNear++;
        }
      });
      // When near-me is on, say what is actually on the map — the global
      // "N of M running" no longer describes the view.
      el.textContent = filterState.nearMe
        ? shownNear + ' of ' + tot + ' shown near you'
        : run + ' of ' + tot + ' running';
    });
  }

  // Near-me scope label on the toggle itself, kept fresh wherever the
  // near set changes (toggle, locate, poll).
  function refreshFilterCounts() {
    updateCounts();
    var sub = $('nearme-sub');
    if (sub) {
      var n = (filterState.nearMe && nearMeSet) ? Object.keys(nearMeSet).length : 0;
      sub.textContent = NEAR_ME_M + ' m' + (filterState.nearMe ? ' · ' + n + ' near you' : '');
    }
  }

  var groupRoutes = {}; // gid -> [route ids]
  var lastVehicles = null;

  // Recompute per-route running state from the latest live counts.
  // Returns true if any route flipped between running/not-running.
  // Running-state engine. Asymmetric by design: a visible bus means
  // 'running' immediately (certain); a disappearance needs 3 quiet polls
  // (~3 minutes — uncertain, could be a feed gap or a between-buses lull).
  // A route is never assumed dead on load: with zero buses seen it stays
  // 'unknown' (which never hides or dims) until 3 consecutive polls come
  // back empty. Burying a scheduled route on a single empty snapshot —
  // e.g. page loaded between buses — was the old first-poll shortcut.
  function updateRunningState() {
    var changed = false;
    routeOrder.forEach(function (rid) {
      var buses = liveCounts[rid] || 0;
      if (buses > 0) {
        quietStreak[rid] = 0;
        if (runningState[rid] !== 'running') { runningState[rid] = 'running'; changed = true; }
      } else {
        quietStreak[rid] = (quietStreak[rid] || 0) + 1;
        if (quietStreak[rid] >= 3 && runningState[rid] !== 'not-running') {
          runningState[rid] = 'not-running'; changed = true;
        }
      }
    });
    return changed;
  }

  // Raw per-route bus counts from the live feed, BEFORE any visibility
  // filtering. The running-state engine must see the street, not the render:
  // counting only visible routes meant a hidden route could never recover,
  // and user filtering ("All off") falsely marked running routes not-running.
  function countByRoute(vehicles) {
    var m = {};
    for (var i = 0; i < vehicles.length; i++) {
      var v = vehicles[i];
      if (v.lat == null || v.lon == null) continue;
      if (!routeById[v.route_id]) continue;
      m[v.route_id] = (m[v.route_id] || 0) + 1;
    }
    return m;
  }

  // --- per-vehicle motion prediction -----------------------------------------
  // The feed polls every 60 s; between polls each bus dead-reckons along its
  // route's GTFS shape using the feed's own speed_mph, map-matched per fix.
  // Deterministic inputs: poll fixes, reported speed, reported bearing, and
  // the shape geometry (buses can't leave their path). Small fix divergences
  // ease in over ~2 s; teleports (>200 m) snap. Honest limits: no public
  // Detroit traffic-signal feed exists — a red light reads as speed 0 (hold,
  // never drift); arterial congestion is already encoded in the bus's own
  // reported speed, so no second feed is fused. A fix >150 m off every shape
  // is rendered raw (detour) with prediction suspended until it re-matches.
  var busTrackers = {};   // vehicle_id -> tracker (persists across polls)
  var shapeArcCache = {}; // route_id -> [{pts, cum, len}]
  var lastPollT = 0;      // performance.now() of the previous poll (for observations)
  var pollSeq = 0;        // increments per poll; trackers record their birth poll
  var MPH_TO_MPS = 0.44704;
  var PREDICT_HORIZON_S = 150; // never dead-reckon on a fix older than this
  var SNAP_DIST_M = 200;       // along-track divergence above this = teleport
  var OFFSHAPE_M = 150;        // cross-track beyond this = detour, render raw
  // Kalman filter noise model. R = GPS measurement variance (15m sigma).
  // Q_* are process-noise densities; replaced by Bayesian timing-cell
  // posteriors when telemetry-math/bayesian_cells.py lands in the pipeline.
  var KALMAN_R = 225, KALMAN_Q_POS = 2.0, KALMAN_Q_VEL = 0.5;

  function shapeArcs(routeId) {
    var hit = shapeArcCache[routeId];
    if (hit !== undefined) return hit;
    var r = routeById[routeId];
    var arcs = [];
    if (r && r.paths) {
      for (var pi = 0; pi < r.paths.length; pi++) {
        var pts = r.paths[pi];
        if (!pts || pts.length < 2) continue;
        var cum = [0];
        for (var i = 1; i < pts.length; i++) {
          cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        }
        arcs.push({ pts: pts, cum: cum, len: cum[cum.length - 1] });
      }
    }
    shapeArcCache[routeId] = arcs.length ? arcs : null;
    return shapeArcCache[routeId];
  }

  function pointAt(arc, s) {
    s = Math.max(0, Math.min(arc.len, s));
    var cum = arc.cum, pts = arc.pts;
    var lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    var segLen = (cum[hi] - cum[lo]) || 1;
    var t = (s - cum[lo]) / segLen;
    var ax = pts[lo][0], az = pts[lo][1];
    var dx = pts[hi][0] - ax, dz = pts[hi][1] - az;
    var dl = Math.hypot(dx, dz) || 1;
    return { x: ax + dx * t, z: az + dz * t, dx: dx / dl, dz: dz / dl };
  }

  // Nearest point on one arc: arc-length, cross-track distance, direction.
  function nearestOnArc(arc, x, z) {
    var pts = arc.pts, cum = arc.cum;
    var bDist = Infinity, bS = 0, bDx = 1, bDz = 0;
    for (var i = 0; i < pts.length - 1; i++) {
      var ax = pts[i][0], az = pts[i][1];
      var dx = pts[i + 1][0] - ax, dz = pts[i + 1][1] - az;
      var l2 = dx * dx + dz * dz;
      var t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      var d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
      if (d < bDist) {
        bDist = d; bS = cum[i] + Math.sqrt(l2) * t;
        var dl = Math.sqrt(l2) || 1; bDx = dx / dl; bDz = dz / dl;
      }
    }
    return { s: bS, dist: bDist, dx: bDx, dz: bDz };
  }

  // Map-match a fix to (path, arc-length). Bearing disambiguates overlapping
  // outbound/inbound paths; the previous match lends continuity.
  function matchFix(routeId, x, z, bearingDeg, prev) {
    var arcs = shapeArcs(routeId);
    if (!arcs) return null;
    var bwx = 0, bwz = 0;
    var hasB = (bearingDeg != null && !isNaN(bearingDeg));
    if (hasB) {
      var br = bearingDeg * DEG;
      bwx = Math.sin(br) * proj.mLon; bwz = -Math.cos(br) * proj.mLat;
      var bl = Math.hypot(bwx, bwz) || 1; bwx /= bl; bwz /= bl;
    }
    var best = null;
    for (var pi = 0; pi < arcs.length; pi++) {
      var nb = nearestOnArc(arcs[pi], x, z);
      var dot = hasB ? (bwx * nb.dx + bwz * nb.dz) : 0;
      var score = nb.dist - 80 * Math.max(0, dot);
      if (prev && prev.pathIdx === pi && Math.abs(nb.s - prev.s) < 400) score -= 50;
      if (!best || score < best.score) {
        best = { score: score, pathIdx: pi, s: nb.s, dist: nb.dist, arc: arcs[pi] };
      }
    }
    return best;
  }

  // === POSITION INTEGRITY — STALE MARKER (project 6, item 2) ============
  // Spec: files/position-integrity/analysis-2026-10-16.md §2 points 2–3.
  // Past PREDICT_HORIZON_S the prediction stops — and before this item
  // the marker simply froze wherever the extrapolation had carried it
  // (up to ~1 km past the fix in the founding sample, ~2.7 km from the
  // truth), still wearing its 150 m-clamped σ halo. The stale rule:
  // the marker EASES BACK to the map-matched fix position — the last
  // truth — and renders in the stale treatment (desaturated, ground
  // ring instead of halo, fix time on its badge chip). The rendered
  // claim becomes "last seen here at 3:50 PM".
  //
  // The ease speaks the page's own motion language: the minimum-jerk
  // quintic stepStreetTween glides the camera with, over 2000 ms —
  // the prediction module's own ease-in scale ("small fix divergences
  // ease in over ~2 s"). It runs along the route arc when the fix is
  // map-matched (the marker retraces its path, never cuts a corner),
  // straight-line for a raw (detour) fix. A fresh fix takes over
  // cleanly: the poll rebuilds the slot from the Kalman state — which
  // the ease never touches — and the ease state is dropped, so the
  // predictor and the ease never fight. A poll that lands mid-ease
  // cannot move the marker either: the ease restarts from the last
  // RENDERED position (tr.renderS/renderX/renderZ), not from wherever
  // the poll's reconcile placed the new slot, so the first frame after
  // the poll continues the curve instead of jumping.
  var STALE_EASE_MS = 2000;   // ease-back duration (see above)
  var STALE_DESAT = 0.65;     // stale desaturation: lerp toward luminance gray
  function minJerk(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  // One age for the marker surfaces: the prediction loop's own anchor
  // rule (fixObsT, else fixT) against the horizon. Item 1's
  // fixAgeOfSlot governs the card's text claim; the two agree wherever
  // the source carries a measured stamp.
  function markerStale(slot, nowPerf) {
    if (typeof slot.staleFx === 'boolean') return slot.staleFx;
    var tr = slot.tracker;
    if (!tr) return false;
    var anchor = (tr.fixObsT != null ? tr.fixObsT : tr.fixT);
    if (!anchor) return false;
    return (nowPerf - anchor) / 1000 > PREDICT_HORIZON_S;
  }
  // The map-matched fix position: the last truth. On-arc when the last
  // fix matched (tr.matchS on the current arc), else the raw fix.
  function staleFixPoint(tr) {
    if (!tr) return null;
    if (tr.arc && tr.matchS != null && tr.matchPath === tr.pathIdx) {
      var pt = pointAt(tr.arc, tr.matchS);
      return { x: pt.x, z: pt.z, s: tr.matchS };
    }
    if (tr.lastX != null && tr.lastZ != null) return { x: tr.lastX, z: tr.lastZ, s: null };
    return null;
  }
  function desatCopy(c) {
    var g = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    return new THREE.Color(
      c.r + (g - c.r) * STALE_DESAT,
      c.g + (g - c.g) * STALE_DESAT,
      c.b + (g - c.b) * STALE_DESAT);
  }
  // The color a marker surface should show for this slot right now.
  function busMarkerColor(slot) {
    return markerStale(slot, performance.now()) ? desatCopy(slot.color) : slot.color;
  }
  // Re-apply the stale treatment (or its removal) to a slot's rendered
  // colors after a class flip between polls: pillar instance colors in
  // pillar mode, the detail body in bus mode. Mirrors the color logic
  // renderBusInstances applies at poll time, itinerary dim included.
  function applyMarkerTreatment(i, sl, isStale) {
    var col = isStale ? desatCopy(sl.color) : sl.color;
    if (busMode) {
      var d = detailPool[i];
      if (d) d.body.material.color.copy(col);
    } else {
      var pc = col;
      if (itineraryDims(sl.vehicle.route_id)) pc = col.clone().multiplyScalar(0.25);
      pillarGlowIM.setColorAt(i, pc);
      pillarCoreIM.setColorAt(i, pc);
      pillarBeaconIM.setColorAt(i, pc);
      pillarRingIM.setColorAt(i, pc);
      markColorsDirty();
    }
  }
  // The stale badge chip: the route badge's own silhouette, stroke in
  // the desaturated route color, the route number shifted up and the
  // fix's clock time under it in the site amber — the same amber the
  // card's stale chip (item 1) wears. Drawn on demand; cached per
  // route + fix minute (the text cannot go staler than a minute
  // without a redraw, and a new fix minute is a new key).
  var staleBadgeTexCache = {};
  function staleBadgeTexture(slot) {
    var info = fixAgeOfSlot(slot, performance.now(), Date.now());
    if (!info) return routeBadgeTexture(slot.vehicle.route_id);
    var rid = slot.vehicle.route_id;
    var key = rid + '@' + Math.floor(info.fixWallMs / 60000);
    var t = staleBadgeTexCache[key];
    if (t) return t;
    var rc = routeColors[rid];
    var col = '#' + (rc ? desatCopy(rc).getHexString() : '9aa0a6');
    var label = String(rid);
    var c = document.createElement('canvas');
    var W = 168, H = 84;
    c.width = W; c.height = H;
    var x = c.getContext('2d');
    x.fillStyle = 'rgba(5,7,10,0.95)';
    x.fillRect(18, 0, 16, 10);
    x.fillRect(W - 34, 0, 16, 10);
    x.fillRect(18, H - 10, 16, 10);
    x.fillRect(W - 34, H - 10, 16, 10);
    x.fillStyle = 'rgba(9,13,17,0.88)';
    x.beginPath();
    if (x.roundRect) x.roundRect(8, 6, W - 16, H - 12, 14); else x.rect(8, 6, W - 16, H - 12);
    x.fill();
    x.lineWidth = 4; x.strokeStyle = col; x.stroke();
    x.fillStyle = 'rgba(197,197,197,0.35)';
    x.fillRect(20, 14, W - 40, 10);
    x.fillStyle = '#ffffff';
    x.font = '700 26px system-ui, -apple-system, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    var tw = x.measureText(label).width;
    if (tw > W - 48) {
      x.font = '700 ' + Math.floor(26 * (W - 48) / tw) + 'px system-ui, -apple-system, sans-serif';
    }
    x.fillText(label, W / 2, H / 2 - 2);
    x.fillStyle = '#B4B4B4';
    x.font = '600 19px system-ui, -apple-system, sans-serif';
    x.fillText(formatClock12(info.fixWallMs), W / 2, H / 2 + 22);
    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    t = { tex: tex, aspect: c.width / c.height };
    staleBadgeTexCache[key] = t;
    return t;
  }
  // Per-frame stale step for one slot. Returns 0 (nothing), 1 (the
  // marker moved / its ground statement changed — rewrite it), 2 (the
  // slot flipped INTO the stale class), or 3 (it flipped OUT — a fresh
  // fix took over). Flips ask the caller to re-apply the treatment and
  // refresh the badge chip. The ease state lives on the tracker; the
  // Kalman state (kS/kV/kP) is never touched here — prediction owns it.
  function staleMarkerStep(sl, tr, ageS, now) {
    var isStale = ageS > PREDICT_HORIZON_S;
    var code = 0;
    if ((sl.staleFx === true) !== isStale) {
      sl.staleFx = isStale;
      code = isStale ? 2 : 3;
    } else if (typeof sl.staleFx !== 'boolean') {
      sl.staleFx = isStale; // normalize silently: no flip, no treatment change
    }
    if (!isStale) {
      if (tr.ease) { tr.ease = null; tr.renderS = null; tr.renderX = null; tr.renderZ = null; }
      return code;
    }
    sl.haloR = 0; // halo honesty: no disc in the stale class
    var fp = staleFixPoint(tr);
    if (!fp) return code;
    var stamp = (tr.fixObsT != null ? tr.fixObsT : tr.fixT);
    var ez = tr.ease;
    if (!ez || ez.stamp !== stamp) {
      // (Re)start from the last RENDERED position — a poll that landed
      // mid-ease rebuilt the slot from the reconcile, and the marker
      // must not jump to meet it.
      ez = tr.ease = {
        stamp: stamp, t0: now,
        // Reduced motion (C-10): the ease starts already done, so the
        // marker renders at the fix — the same end state, no travel.
        done: ((typeof reducedMotion !== 'undefined') && reducedMotion),
        fromS: (fp.s != null ? (tr.renderS != null ? tr.renderS : tr.s) : null),
        fromX: (tr.renderX != null ? tr.renderX : sl.x),
        fromZ: (tr.renderZ != null ? tr.renderZ : sl.z)
      };
    }
    if (fp.s != null && ez.fromS != null) {
      // On-arc ease: retrace the route to the matched fix.
      var sNow;
      if (ez.done) {
        sNow = fp.s;
      } else {
        var pA = Math.min(1, (now - ez.t0) / STALE_EASE_MS);
        sNow = ez.fromS + (fp.s - ez.fromS) * minJerk(pA);
        if (pA >= 1) { sNow = fp.s; ez.done = true; }
      }
      var ptA = pointAt(tr.arc, sNow);
      if (Math.abs(sNow - tr.s) > 0.001 || Math.abs(ptA.x - sl.x) > 0.01 || Math.abs(ptA.z - sl.z) > 0.01) {
        tr.s = sNow;
        code = code || 1;
      }
      tr.renderS = sNow;
      return code;
    }
    // Raw fix (detour / unmatched): straight-line ease in scene space.
    var nx, nz;
    if (ez.done) {
      nx = fp.x; nz = fp.z;
    } else {
      var pB = Math.min(1, (now - ez.t0) / STALE_EASE_MS);
      var eB = minJerk(pB);
      nx = ez.fromX + (fp.x - ez.fromX) * eB;
      nz = ez.fromZ + (fp.z - ez.fromZ) * eB;
      if (pB >= 1) { nx = fp.x; nz = fp.z; ez.done = true; }
    }
    if (Math.abs(nx - sl.x) > 0.01 || Math.abs(nz - sl.z) > 0.01) {
      sl.x = nx; sl.z = nz;
      code = code || 1;
    }
    tr.renderX = nx; tr.renderZ = nz;
    return code;
  }

  // Advance every tracker's dead reckoning and push the predicted positions
  // into slots, badges, and true-scale models. Runs every frame; cheap.
  var lastMotionT = 0;
  function updateBusMotion(now) {
    if (!busSlots.length) return;
    var dt = lastMotionT ? Math.min(0.1, (now - lastMotionT) / 1000) : 0;
    lastMotionT = now;
    if (dt <= 0) return;
    var anyMoved = false;
    var badgeDirty = false;
    for (var i = 0; i < busSlots.length; i++) {
      var sl = busSlots[i], tr = sl.tracker;
      if (!tr) continue;
      var moved = false;
      var ageS = (now - (tr.fixObsT != null ? tr.fixObsT : tr.fixT)) / 1000;
      // Position Integrity item 2: horizon lapse — ease back to the
      // fix and wear the stale treatment (staleMarkerStep). Runs for
      // arc-less (detour) trackers too: their position is already the
      // raw fix, but the treatment still flips with the class.
      var stCode = staleMarkerStep(sl, tr, ageS, now);
      if (stCode) {
        moved = true;
        anyMoved = true;
        if (stCode >= 2) { applyMarkerTreatment(i, sl, stCode === 2); badgeDirty = true; }
      }
      if (!tr.arc) continue;
      if (ageS < PREDICT_HORIZON_S && tr.kInit) {
        // Kalman predict: constant-velocity model, F = [[1,dt],[0,1]].
        // The empirical segment speed enters as a velocity prior (the old
        // mean-reversion, now inside the filter instead of beside it).
        if (!tr.seg || tr.segPath !== tr.pathIdx || tr.kS < tr.seg.s0 || tr.kS > tr.seg.s1) {
          tr.seg = segmentAt(tr.routeId, tr.pathIdx, tr.kS);
          tr.segPath = tr.pathIdx;
        }
        var v0 = tr.speedMps;
        var vEmp = empiricalSpeed(tr.routeId, tr.seg);
        var vPrior = (vEmp != null && vEmp < v0) ? vEmp : v0;
        // Ease the velocity state toward the prior (never invent accel).
        tr.kV += (vPrior - tr.kV) * (1 - Math.exp(-dt / REVERT_TAU_S));
        tr.kS += tr.kV * dt;
        // Covariance predict: P = F*P*F' + Q*dt.
        var p00 = tr.kP, p01 = tr.kPvS, p11 = tr.kPv;
        tr.kP = p00 + 2 * dt * p01 + dt * dt * p11 + KALMAN_Q_POS * dt;
        tr.kPvS = p01 + dt * p11;
        tr.kPv = p11 + KALMAN_Q_VEL * dt;
        if (Math.abs(tr.kV) > 0.3 || tr.kP > KALMAN_R * 4) {
          tr.s = Math.max(0, Math.min(tr.arc.len, tr.kS));
          moved = true;
        }
      }
      if (moved) {
        anyMoved = true;
        var pt = pointAt(tr.arc, tr.s);
        sl.x = pt.x; sl.z = pt.z;
        sl.rotY = Math.atan2(-pt.dz, pt.dx);
        var sp = badgePool[i];
        if (sp && sp.visible) { sp.position.x = pt.x; sp.position.z = pt.z; }
        // Uncertainty halo: radius = 3σ of the position variance, clamped.
        // Grows between fixes, collapses on the Kalman update — the honest
        // rendering of "we're less sure where this bus is." A stale
        // marker carries no disc (item 2): the guard keeps this block
        // from resurrecting one when it repositions an easing marker.
        sl.haloR = sl.staleFx ? 0 : Math.max(15, Math.min(150, 3 * Math.sqrt(Math.max(tr.kP, 1))));
      }
    }
    if (badgeDirty) {
      // A class flip changes which chip a bus wears (route badge vs
      // stale badge with the fix time) — refresh textures now, not at
      // the next poll.
      updateBusBadges(busSlots.length, busMode ? 430 : PILLAR_H * pillarYS + 80);
    }
    if (!anyMoved) return;
    if (!busMode) {
      for (var m = 0; m < busSlots.length; m++) writeBusMatrices(m, busSlots[m], 1);
      pillarMeshes.forEach(function (im) { im.instanceMatrix.needsUpdate = true; });
    } else {
      var dn = Math.min(busSlots.length, DETAIL_MAX);
      for (var di = 0; di < dn; di++) {
        var d = detailPool[di];
        if (d && d.group.visible) {
          d.group.position.set(busSlots[di].x, 0, busSlots[di].z);
          d.group.rotation.y = busSlots[di].rotY;
        }
      }
    }
  }

  // --- empirical motion prior ------------------------------------------------
  // Teaches the predictor which segments habitually run slow, so it stops
  // overshooting into red lights and dwells. One key space —
  // route|from_stop|to_stop — fed by two sources:
  //   1. Telemetry timing cells (canonical, multi-day aggregates), fetched
  //      hourly from the telemetry repo. No-ops until cells mature.
  //   2. Local speed map: learned live from the 60 s poll stream, EMA per
  //      segment, persisted to localStorage. Works today.
  // The predictor only ever revises DOWNWARD toward the empirical speed: a
  // cruising bus keeps its reported speed; a fast-reported bus entering a
  // habitually slow segment decays toward the segment mean. Never invents
  // acceleration — the worst case stays a smaller overshoot, never a phantom.
  var REVERT_TAU_S = 45;      // reported speed's trust half-life, seconds
  var LOCAL_FRESH_MS = 2 * 3600 * 1000; // local observations older than this are ignored
  var segTableCache = {};     // routeId -> [{from, to, s0, s1, pathIdx}]
  var stopsByRouteCache = {};
  var localSegs = {};         // "route|from|to" -> {v, t, n}
  var timingCells = null;     // telemetry segments.json (null until fetched)
  var speedmapSaveT = 0;

  function stopsByRoute(routeId) {
    var hit = stopsByRouteCache[routeId];
    if (hit) return hit;
    var out = [];
    for (var i = 0; i < stopData.length; i++) {
      var st = stopData[i];
      if (st.r && st.r.indexOf(routeId) !== -1) out.push(st);
    }
    stopsByRouteCache[routeId] = out;
    return out;
  }

  // Order each route's stops along its shape arcs -> stop-pair segments.
  function routeSegments(routeId) {
    var hit = segTableCache[routeId];
    if (hit) return hit;
    var segs = [];
    var arcs = shapeArcs(routeId);
    var stops = stopsByRoute(routeId);
    if (arcs && stops.length) {
      var perPath = arcs.map(function () { return []; });
      stops.forEach(function (st) {
        var best = null;
        for (var pi = 0; pi < arcs.length; pi++) {
          var nb = nearestOnArc(arcs[pi], st.x, st.z);
          if (nb.dist < 120 && (!best || nb.dist < best.dist)) {
            best = { pathIdx: pi, s: nb.s, dist: nb.dist };
          }
        }
        if (best) perPath[best.pathIdx].push({ id: st.id, s: best.s });
      });
      perPath.forEach(function (list, pi) {
        list.sort(function (a, b) { return a.s - b.s; });
        for (var i = 0; i + 1 < list.length; i++) {
          if (list[i + 1].s - list[i].s < 5) continue;
          segs.push({ from: list[i].id, to: list[i + 1].id, s0: list[i].s, s1: list[i + 1].s, pathIdx: pi });
        }
      });
    }
    segTableCache[routeId] = segs;
    return segs;
  }

  function segmentAt(routeId, pathIdx, s) {
    var segs = routeSegments(routeId);
    for (var i = 0; i < segs.length; i++) {
      var g = segs[i];
      if (g.pathIdx === pathIdx && s >= g.s0 && s <= g.s1) return g;
    }
    var best = null; // past the last stop: nearest upcoming segment
    for (var j = 0; j < segs.length; j++) {
      var h = segs[j];
      if (h.pathIdx !== pathIdx || h.s1 < s) continue;
      if (!best || h.s0 < best.s0) best = h;
    }
    return best;
  }

  function observeSegment(routeId, seg, obsV) {
    var key = routeId + '|' + seg.from + '|' + seg.to;
    var e = localSegs[key];
    var nowMs = Date.now();
    if (!e) localSegs[key] = { v: obsV, t: nowMs, n: 1 };
    else { e.v = e.v * 0.85 + obsV * 0.15; e.t = nowMs; e.n++; }
    if (nowMs - speedmapSaveT > 5 * 60 * 1000) {
      speedmapSaveT = nowMs;
      try { localStorage.setItem('fl-speedmap-v1', JSON.stringify(localSegs)); } catch (err) {}
    }
  }

  function loadSpeedmap() {
    try {
      var raw = localStorage.getItem('fl-speedmap-v1');
      if (raw) {
        var d = JSON.parse(raw);
        if (d && typeof d === 'object') localSegs = d;
      }
    } catch (err) {}
  }

  var flBucketMemo = { key: null, val: null };
  function detroitBucket(d) {
    d = d || new Date();
    // Rank 7 (2026-10-18, project 4): the bucket is a pure function of the
    // Detroit weekday + hour, constant within any absolute hour (US DST
    // transitions fall on absolute-hour boundaries), so it is memoized by
    // absolute hour. This runs inside empiricalSpeed, which the frame loop
    // calls once per tracked vehicle per frame; the unmemoized body built
    // an Intl.DateTimeFormat + formatToParts on every call (measured
    // 7.1 us of the call's 7.7 us on the audit VM). Value-identical to the
    // unmemoized function — verified over a full year of timestamps
    // including both DST transitions. Record:
    // files/compute-accuracy/rank7-assessment-2026-10-18.md.
    var ck = Math.floor(d.getTime() / 3600000);
    if (flBucketMemo.key === ck) return flBucketMemo.val;
    var wd = null, hr = null;
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Detroit', weekday: 'short', hour: 'numeric', hourCycle: 'h23'
    }).formatToParts(d).forEach(function (p) {
      if (p.type === 'weekday') wd = p.value;
      if (p.type === 'hour') hr = parseInt(p.value, 10);
    });
    var b;
    if (wd === 'Sat') b = 'sat';
    else if (wd === 'Sun') b = 'sun';
    else if (hr >= 6 && hr < 9) b = 'wkd_am';
    else if (hr >= 9 && hr < 15) b = 'wkd_mid';
    else if (hr >= 15 && hr < 19) b = 'wkd_pm';
    else if (hr >= 19 && hr < 24) b = 'wkd_eve';
    else b = 'wkd_night';
    flBucketMemo.key = ck; flBucketMemo.val = b;
    return b;
  }

  function fetchTimingCells() {
    fetch('https://raw.githubusercontent.com/smit4786/forge-line-transit-data/main/data/timing/segments.json',
      { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (d) {
        // segments.json is a document envelope {schema, built_at, cells, segments};
        // the flat cell map lives under `segments`.
        timingCells = (d && d.segments && typeof d.segments === 'object') ? d.segments : null;
      })
      .catch(function () { /* keep the previous cache; the local map covers */ });
  }

  // Empirical speed (m/s) for a route segment, or null when unknown.
  // Telemetry cells (mature, bucketed) outrank the local map (recent, EMA).
  function empiricalSpeed(routeId, seg) {
    if (!seg) return null;
    var base = routeId + '|' + seg.from + '|' + seg.to;
    if (timingCells) {
      var cell = timingCells[base + '|' + detroitBucket()];
      if (cell && cell.n >= 3 && cell.mean_s > 0 && cell.dist_m > 0) {
        return cell.dist_m / cell.mean_s;
      }
    }
    var loc = localSegs[base];
    if (loc && loc.v > 0.2 && (Date.now() - loc.t) < LOCAL_FRESH_MS) return loc.v;
    return null;
  }

  // --- Phase 2b-i: live delay propagation --------------------------------------
  // Per poll, match live vehicles to scheduled trips and measure delays.
  // Client-side, honest: a clear margin or no match. Matched trips get their
  // remaining times shifted (clamped); disrupted trips are flagged, never
  // shifted. Three quiet polls and the match reverts to scheduled.
  var tripDelayState = new Map(); // trip object -> {delaySec, vehicleId, misses, disrupted}
  // --- Rank 8: matcher instrumentation (project 4, 2026-10-18) --------------
  // Per-poll outcome counters for updateLiveDelays, read back via
  // window.__flMatcherStats (the __flErrLog pattern). The telemetry archive
  // cannot report production match rates or rejection classes — the rank-4
  // evaluation had to reconstruct them by offline replay; these counters
  // make the matcher observable in place. Classes mirror the replay tally:
  // matched / gate / score / margin / noExpected / shadowed / disrupted,
  // plus candidate-level gate sides (candGateEarly / candGateLate /
  // candAdmitted) and the matched-delay distribution. On-device only:
  // nothing is transmitted, no fetch, no beacon (the owner.js telemetry
  // endpoint stays null). Counting never touches control flow — the proof
  // is in files/compute-accuracy/rank8-delivery-note-2026-10-18.md.
  var flMatchLast = null;     // most recent completed poll's counters
  var flMatchCum = null;      // cumulative counters; t = first poll's time
  function flMatchZero() {
    return { t: 0, fixes: 0, ghostRoute: 0, noCandidates: 0, noExpected: 0,
      gate: 0, score: 0, margin: 0, shadowed: 0, matched: 0, disrupted: 0,
      candGateEarly: 0, candGateLate: 0, candAdmitted: 0,
      delayN: 0, delaySum: 0, delayHist: [0, 0, 0, 0, 0, 0, 0, 0],
      tripsLive: 0, tripsDisrupted: 0, tripsLayover: 0 };
  }
  function flMatchCopy(o) {
    if (!o) return null;
    var c = {};
    for (var k in o) c[k] = (k === 'delayHist') ? o[k].slice() : o[k];
    return c;
  }
  // Read-back hook for support/diagnostics (read-only copies). delayHist
  // buckets, matched non-disrupted delaySec:
  // [-300,-120) [-120,-30) [-30,30) [30,120) [120,300) [300,600)
  // [600,1200) [1200,1800]
  window.__flMatcherStats = function () {
    return { last: flMatchCopy(flMatchLast), cum: flMatchCopy(flMatchCum) };
  };
  var rrLayCache = { key: null, byRoute: null }; // Route Reverse layover candidates, per service-day pair
  var stopArcCache = {};          // routeId|pathIdx -> {stopId: arc s}
  var ttRouteIdxById = null;      // built per timetable
  var lastEmpiricalRun = 0;

  function detroitParts(whenMs) {
    var o = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Detroit', year: 'numeric', month: 'numeric', day: 'numeric',
      weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23'
    }).formatToParts(new Date(whenMs)).forEach(function (p) { o[p.type] = p.value; });
    return {
      ymd: o.year + String(o.month).padStart(2, '0') + String(o.day).padStart(2, '0'),
      dow: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[o.weekday],
      sec: (+o.hour) * 3600 + (+o.minute) * 60 + (+o.second)
    };
  }

  function stopArcMap(routeId, pathIdx) {
    var key = routeId + '|' + pathIdx;
    var hit = stopArcCache[key];
    if (hit) return hit;
    var m = {};
    routeSegments(routeId).forEach(function (g) {
      if (g.pathIdx !== pathIdx) return;
      if (!(g.from in m)) m[g.from] = g.s0;
      m[g.to] = g.s1;
    });
    stopArcCache[key] = m;
    return m;
  }

  // Where a scheduled trip should be (arc s) at nowSec, via its stops mapped
  // onto the shape. Returns null when the trip isn't on this path / is over.
  function tripExpected(trip, stopS, nowSec) {
    var pts = [];
    // Measure against the empirical baseline when 2b-ii substituted it;
    // measuring a typically-late bus against the raw schedule would
    // double-count the lateness (empirical shift + delay vs raw).
    var dep = trip.depL2 || trip.dep, arr = trip.arrL2 || trip.arr;
    for (var j = 0; j < trip.stops.length; j++) {
      // ttStopId translates the timetable's page index to the GTFS stop
      // id stopArcMap is keyed by — the same translation
      // applyEmpiricalBaseline performs. Without it the lookup misses
      // for nearly every stop and tripExpected returns null, so the
      // matcher evaluates nothing (compute-accuracy audit, rank 1;
      // delivered inside project 18 — the rollover procedure is
      // vacuous without a working matcher).
      var s = stopS[ttStopId(trip.stops[j])];
      if (s == null) continue;
      pts.push({ s: s, dep: dep[j], arr: arr[j] });
    }
    if (pts.length < 2) return null;
    for (var k = 1; k < pts.length; k++) if (pts[k].s <= pts[k - 1].s) return null;
    var first = pts[0], last = pts[pts.length - 1];
    function vref(a, b) {
      var dt = b.dep - a.dep, ds = b.s - a.s;
      return (dt > 0 && ds > 0) ? ds / dt : 8;
    }
    // expIdx: last stop the trip should have served by nowSec
    var expIdx = -1;
    for (var e = 0; e < pts.length; e++) if (pts[e].dep <= nowSec) expIdx = e;
    if (nowSec < first.dep) return { sE: first.s, vRef: vref(first, pts[1]), pts: pts, expIdx: -1 };
    if (nowSec > last.arr) return null;
    for (var m = 0; m + 1 < pts.length; m++) {
      var a = pts[m], b = pts[m + 1];
      if (nowSec >= a.dep && nowSec <= b.dep) {
        var f = (b.dep > a.dep) ? (nowSec - a.dep) / (b.dep - a.dep) : 0;
        return { sE: a.s + f * (b.s - a.s), vRef: vref(a, b), pts: pts, expIdx: expIdx };
      }
    }
    return { sE: last.s, vRef: vref(pts[pts.length - 2], last), pts: pts, expIdx: expIdx };
  }

  function headsignMatch(dest, h) {
    if (!dest || !h) return false;
    function norm(x) { return String(x).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
    var d = norm(dest), hh = norm(h);
    if (!d || !hh) return false;
    if (hh.indexOf(d) >= 0 || d.indexOf(hh) >= 0) return true;
    return d.split(' ')[0] === hh.split(' ')[0];
  }

  function candidateTrips(tt, ridx, svc, prevSvc, nowSec) {
    var out = [];
    for (var pi = 0; pi < tt.patterns.length; pi++) {
      var pat = tt.patterns[pi];
      if (pat.route !== ridx) continue;
      for (var ti = 0; ti < pat.trips.length; ti++) {
        var t = pat.trips[ti];
        // Route Reverse (project 18): each trip is evaluated in its own
        // service frame — today's service at calendar seconds,
        // yesterday's at +86400 s, the shift the planner and the stop
        // card already apply. As shipped, calendar seconds were used
        // for both frames, so any trip whose service-day times pass
        // midnight went invisible at 00:00, and trips departing at
        // 24:30 or later could never match at all.
        var frames = null;
        if (t.s === svc && t.s === prevSvc) frames = [nowSec, nowSec + 86400];
        else if (t.s === svc) frames = [nowSec];
        else if (t.s === prevSvc) frames = [nowSec + 86400];
        else continue;
        for (var fi = 0; fi < frames.length; fi++) {
          var nf = frames[fi];
          if (nf >= t.dep[0] - 1800 && nf <= t.arr[t.arr.length - 1] + 300) {
            out.push({ trip: t, nowEff: nf });
            break;
          }
        }
      }
    }
    return out;
  }

  function updateLiveDelays() {
    if (!tripTT || !tripRaptor || !tripRaptor.setLiveDelays) return;
    var tt = tripTT;
    // Phase 2b-ii (dormant): empirical baseline substitution, hourly.
    var nowMs = Date.now();
    if (nowMs - lastEmpiricalRun > 3600000) {
      lastEmpiricalRun = nowMs;
      applyEmpiricalBaseline();
    }
    var mstat = flMatchZero(); // rank 8: this poll's matcher outcome counters
    mstat.t = nowMs;
    if (!ttRouteIdxById) {
      ttRouteIdxById = {};
      tt.routes.forEach(function (r, i) { ttRouteIdxById[String(r.id)] = i; });
    }
    var dp = detroitParts(nowMs);
    var dpPrev = detroitParts(nowMs - 86400000);
    var svc = tripRaptor.serviceFor(tt, dp.ymd, dp.dow);
    var prevSvc = tripRaptor.serviceFor(tt, dpPrev.ymd, dpPrev.dow);
    var nowSec = dp.sec;
    // Candidate trips per route, once per poll.
    var candsByRoute = {};
    function candsFor(ridx) {
      if (!candsByRoute[ridx]) candsByRoute[ridx] = candidateTrips(tt, ridx, svc, prevSvc, nowSec);
      return candsByRoute[ridx];
    }
    var matches = []; // {trip, vehicleId, delaySec, disrupted, score}
    var nowPerf = performance.now();
    for (var vid in busTrackers) {
      var tr = busTrackers[vid];
      if (!tr || !tr.arc || !tr.vehicle) continue;
      if (pollSeq - tr.bornSeq < 2) continue; // just appeared / changed routes
      if (nowPerf - tr.fixT > 180000) continue; // vanished from feed
      var v = tr.vehicle;
      // Gate on the vehicle's GPS fix age, not poll receipt: a frozen feed
      // must not keep feeding delay measurements. 150s matches the
      // dead-reckoning horizon (PREDICT_HORIZON_S).
      var fixAgeMs = v.updated_at ? (Date.now() - new Date(v.updated_at).getTime()) : 0;
      if (fixAgeMs > 150000) continue; // GPS fix too old to measure delay
      mstat.fixes++;
      var routeStr = String(v.route_id);
      var ridx = ttRouteIdxById[routeStr];
      if (ridx == null) { mstat.ghostRoute++; continue; } // ghost route: nothing to match against
      var stopS = stopArcMap(routeStr, tr.pathIdx);
      var cands = candsFor(ridx);
      if (!cands.length) { mstat.noCandidates++; continue; }
      var best = null, second = null, anyExp = false;
      for (var ci = 0; ci < cands.length; ci++) {
        var trip = cands[ci].trip;
        var exp = tripExpected(trip, stopS, cands[ci].nowEff);
        if (!exp) continue;
        anyExp = true;
        // Stop-index gate (rank 4, dual form): a candidate is rejected
        // only when the index gate AND the position-implied delay agree
        // it is implausible. tImp is the delaySec estimator (computed
        // after selection below) moved above the gate: the bus must be
        // 2+ stops early AND more than 300 s ahead of its expected
        // position, or 9+ stops late AND more than 1800 s behind it.
        // Either witness alone is survivable, so a bus 10+ minutes late
        // — a median 11 stops behind its interpolated expectation —
        // is measured instead of falling off the index cliff alone.
        // Gate record: files/compute-accuracy/rank4-retest-delivery-note-2026-10-18.md
        var vIdx = -1;
        for (var q = 0; q < exp.pts.length; q++) {
          if (exp.pts[q].s <= tr.s + 30) vIdx = q; else break;
        }
        var gate = vIdx - exp.expIdx;
        var tImp = -(tr.s - exp.sE) / Math.max(exp.vRef, 2);
        if ((gate > 1 && tImp < -300) || (gate < -8 && tImp > 1800)) {
          if (gate > 1 && tImp < -300) mstat.candGateEarly++; else mstat.candGateLate++;
          continue;
        }
        mstat.candAdmitted++;
        var score = Math.abs(tr.s - exp.sE) - (headsignMatch(v.destination, trip.h) ? 500 : 0);
        if (!best || score < best.score) { second = best; best = { trip: trip, score: score, exp: exp, frameShift: cands[ci].nowEff - nowSec }; }
        else if (!second || score < second.score) { second = { trip: trip, score: score }; }
      }
      // Rank 8: classify this fix's outcome (counters only — the checks
      // below decide control flow exactly as before).
      if (!anyExp) mstat.noExpected++;
      else if (!best) mstat.gate++;
      else if (best.score >= 4000) mstat.score++;
      else if (second && (second.score - best.score) <= 300) mstat.margin++;
      // Clear margin or no match. 4000 m bound: beyond that the residual is
      // not a credible delay measurement.
      if (!best || best.score >= 4000) continue;
      if (second && (second.score - best.score) <= 300) continue;
      var ds = tr.s - best.exp.sE;
      var vRef = Math.max(best.exp.vRef, 2);
      var delaySec = Math.round(-ds / vRef);
      var disrupted = delaySec < -300 || delaySec > 1800;
      matches.push({
        trip: best.trip, vehicleId: v.vehicle_id,
        delaySec: disrupted ? 0 : delaySec, disrupted: disrupted, score: best.score,
        frameShift: best.frameShift || 0,
        fixStamp: v.updated_at ? new Date(v.updated_at).getTime() : 0
      });
    }
    // One vehicle per trip: best score wins (bus bunching).
    var byTrip = new Map();
    matches.forEach(function (m) {
      var cur = byTrip.get(m.trip);
      if (!cur || m.score < cur.score) byTrip.set(m.trip, m);
    });
    mstat.shadowed += matches.length - byTrip.size; // rank 8
    var matchedTrips = new Set(byTrip.keys());
    byTrip.forEach(function (m, trip) {
      // Rank 8: matched outcome + delay distribution (instantaneous
      // measured delay, the replay tally's delayInst).
      mstat.matched++;
      if (m.disrupted) mstat.disrupted++;
      else {
        mstat.delayN++;
        mstat.delaySum += m.delaySec;
        var mdb = m.delaySec;
        mstat.delayHist[mdb < -120 ? 0 : mdb < -30 ? 1 : mdb < 30 ? 2 : mdb < 120 ? 3 : mdb < 300 ? 4 : mdb < 600 ? 5 : mdb < 1200 ? 6 : 7]++;
      }
      var st = tripDelayState.get(trip);
      if (m.disrupted) {
        tripDelayState.set(trip, { delaySec: 0, vehicleId: m.vehicleId, misses: 0, disrupted: true, fixStamp: m.fixStamp, frameShift: m.frameShift || 0 });
      } else if (!st || st.vehicleId !== m.vehicleId || st.disrupted || st.layover) {
        tripDelayState.set(trip, { delaySec: m.delaySec, vehicleId: m.vehicleId, misses: 0, disrupted: false, fixStamp: m.fixStamp, frameShift: m.frameShift || 0 });
      } else {
        st.delaySec = Math.round(st.delaySec * 0.5 + m.delaySec * 0.5);
        st.fixStamp = m.fixStamp;
        st.misses = 0;
        st.frameShift = m.frameShift || 0;
      }
    });
    tripDelayState.forEach(function (st, trip) {
      if (!matchedTrips.has(trip)) {
        st.misses++;
        if (st.misses >= 3) tripDelayState.delete(trip); // quiet: revert to scheduled
      }
    });
    // ---- Route Reverse (project 18): the layover rule ----
    // A DDOT vehicle with no live binding that is dwelling at a trip's
    // origin inside that trip's assignment window binds to the trip —
    // identity only: delaySec stays 0 and the entry is flagged layover,
    // so no surface presents it as a measured delay and no delay is
    // ever computed from it. The en-route matcher supersedes the
    // binding the moment the bus departs and measures, and clears the
    // flag when it binds the same trip. Specification section 3.3.
    // The layover candidate set per route is cached across polls,
    // keyed by the service-day pair: the underlying trip list changes
    // only when the service day rolls over, so the patterns scan runs
    // twice a day, not once per route per poll (project 15's measured
    // costs are not regressed by this pass).
    var layKey3 = svc + '|' + prevSvc;
    if (rrLayCache.key !== layKey3) {
      var byRoute3 = {};
      for (var pi3 = 0; pi3 < tt.patterns.length; pi3++) {
        var pat3 = tt.patterns[pi3];
        var lst3 = byRoute3[pat3.route] || (byRoute3[pat3.route] = []);
        for (var ti3 = 0; ti3 < pat3.trips.length; ti3++) {
          var t3 = pat3.trips[ti3];
          if (t3.s === svc) lst3.push({ trip: t3, shift: 0 });
          if (t3.s === prevSvc) lst3.push({ trip: t3, shift: 86400 });
        }
      }
      rrLayCache.key = layKey3;
      rrLayCache.byRoute = byRoute3;
    }
    function layTripsFor(ridx3) {
      var all3 = (rrLayCache.byRoute && rrLayCache.byRoute[ridx3]) || [];
      var out3 = [];
      for (var li3 = 0; li3 < all3.length; li3++) {
        var nf3 = nowSec + all3[li3].shift;
        var t33 = all3[li3].trip;
        if (nf3 >= t33.dep[0] - 1800 && nf3 <= t33.dep[0] + 900) {
          out3.push({ trip: t33, nowEff: nf3 });
        }
      }
      return out3;
    }
    function layoverHolds(trip4, st4) {
      var tr4 = busTrackers[st4.vehicleId];
      if (!tr4 || !tr4.vehicle || tr4.lastX == null) return false;
      var o4 = stopData && stopData[trip4.stops[0]];
      if (!o4) return false;
      if (Math.hypot(tr4.lastX - o4.x, tr4.lastZ - o4.z) > 250) return false;
      return nowSec + (st4.frameShift || 0) <= trip4.dep[0] + 1800;
    }
    // Confirm live layover entries the decay loop just charged a miss.
    tripDelayState.forEach(function (st5, trip5) {
      if (st5.layover && layoverHolds(trip5, st5)) st5.misses = 0;
    });
    for (var vid6 in busTrackers) {
      var tr6 = busTrackers[vid6];
      if (!tr6 || !tr6.vehicle || tr6.lastX == null) continue;
      var v6 = tr6.vehicle;
      var ridx6 = ttRouteIdxById[String(v6.route_id)];
      if (ridx6 == null) continue;
      var heldBy6 = false;
      tripDelayState.forEach(function (st6) { if (st6.vehicleId === v6.vehicle_id) heldBy6 = true; });
      if (heldBy6) continue;
      var fixAge6 = v6.updated_at ? (Date.now() - new Date(v6.updated_at).getTime()) : Infinity;
      if (!(fixAge6 <= 300000)) continue;
      var spd6 = parseFloat(v6.speed_mph);
      if (isNaN(spd6)) spd6 = tr6.speedMps != null ? tr6.speedMps * 2.23694 : 99;
      if (spd6 > 2) continue;
      var lc6 = layTripsFor(ridx6).slice().sort(function (a7, b7) { return a7.trip.dep[0] - b7.trip.dep[0]; });
      for (var li6 = 0; li6 < lc6.length; li6++) {
        var cand6 = lc6[li6], t6 = cand6.trip;
        if (tripDelayState.has(t6)) continue;
        var o6 = stopData && stopData[t6.stops[0]];
        if (!o6) continue;
        if (Math.hypot(tr6.lastX - o6.x, tr6.lastZ - o6.z) > 200) continue;
        tripDelayState.set(t6, { delaySec: 0, vehicleId: v6.vehicle_id, misses: 0,
          disrupted: false, layover: true, frameShift: cand6.nowEff - nowSec,
          fixStamp: v6.updated_at ? new Date(v6.updated_at).getTime() : 0 });
        break;
      }
    }
    var delayMap = new Map();
    tripDelayState.forEach(function (st, trip) {
      if (st.disrupted) mstat.tripsDisrupted++; // rank 8: state census
      if (st.layover) mstat.tripsLayover++;
      delayMap.set(trip, { delaySec: st.delaySec, disrupted: st.disrupted, vehicleId: st.vehicleId, fixStamp: st.fixStamp || 0 });
    });
    mstat.tripsLive = tripDelayState.size;
    tripRaptor.setLiveDelays(tt, delayMap, nowMs);
    // Rank 8: publish this poll's matcher counters (window.__flMatcherStats).
    flMatchLast = mstat;
    if (!flMatchCum) { flMatchCum = flMatchZero(); flMatchCum.t = mstat.t; }
    for (var mk8 in mstat) {
      if (mk8 === 't' || mk8 === 'delayHist' || mk8 === 'tripsLive' ||
          mk8 === 'tripsDisrupted' || mk8 === 'tripsLayover') continue;
      flMatchCum[mk8] += mstat[mk8];
    }
    for (var hb8 = 0; hb8 < 8; hb8++) flMatchCum.delayHist[hb8] += mstat.delayHist[hb8];
    flMatchCum.tripsLive = mstat.tripsLive;
    flMatchCum.tripsDisrupted = mstat.tripsDisrupted;
    flMatchCum.tripsLayover = mstat.tripsLayover;
    // Keep the open trip card live: re-plan "leave now" queries per poll.
    // Both planner-path calls are contained (step 2, §4.2): a fault here
    // is logged as a planner fault and quarantined for this poll — it
    // must never propagate into poll's .catch and be reported to the
    // rider as a feed failure, as the previous bytes allowed.
    if (tripMode && tripJourneys.length && !(tripLeaveMode === 'at' && tripLeaveTime) && !plannerPaused) replanLive();
    if (!plannerPaused) {
      try { updateGuidance(); } // Phase 2c: board/alight/missed-transfer banners
      catch (e) { notePlannerFault(e, 'guidance'); hideGuidanceBanner(); }
    }
  }

  // --- Phase 2b-ii: empirical timetable substitution ---------------------------
  // Replaces scheduled segment times with mature timing-cell means. The timing
  // builder emits observed anchor-switch pairs, which can span several
  // scheduled stops, so each adjacent pair first tries its exact cell key and
  // then falls back to the tightest observed span covering it. A spanning
  // cell's measured total is apportioned across its scheduled intervals by
  // scheduled-time share (uniform split if the schedule gives no times), so
  // the measured total is always preserved. No-ops until cells mature.
  // The delay layer measures against this baseline when present, else against
  // the raw schedule.
  // Rank 3 (2026-10-18, project 4): substitution into rider-facing times
  // is DISABLED. The 2026-10-16 compute-accuracy audit found the L2 shifts
  // overstate lateness ~4-5x, and the rank-3 held-out replay (Friday
  // 2026-10-16, cells fit only from days <= Oct 15; 52,494 stop crossings)
  // confirmed no recalibration passes the audit's gate: scheduled-only
  // crossing MAE 109.5 s vs mean_s 392.0, p50_s 436.1, p50_s with the
  // 13 m/s implied-speed filter 477.0, and the n>=10 maturity floor
  // 151.3-159.3. applyEmpiricalBaseline therefore leaves depL2/arrL2 null
  // and every surface (planner, Ride Along, stop cards, and the matcher
  // expectation) presents and measures against scheduled times. The
  // timing cells still load: empiricalSpeed's motion prior consumes them
  // and is display-only, unaffected by this disablement. Record:
  // files/compute-accuracy/rank3-delivery-note-2026-10-18.md.
  // Timetable stop entries are page indices into ddot-routes-3d.json;
  // timing cells are keyed by GTFS stop_id. Translate before lookup —
  // the numeric spaces overlap but are not the same (e.g. page 741 is
  // GTFS 846).
  function ttStopId(pageIdx) {
    var s = stopData && stopData[pageIdx];
    return (s && s.id != null) ? String(s.id) : String(pageIdx);
  }

  function applyEmpiricalBaseline() {
    if (!tripTT) return 0;
    // Disabled 2026-10-18 (rank 3, project 4): no empirical candidate
    // beat the scheduled-only gate on the held-out day — see the Phase
    // 2b-ii header note above. depL2/arrL2 stay null so every consumer
    // (planner, Ride Along, stop cards, matcher expectation) falls back
    // to scheduled times; the explicit null assignment keeps the
    // post-call invariant the substituting implementation maintained.
    var tt = tripTT;
    tt.patterns.forEach(function (pat) {
      pat.trips.forEach(function (t) { t.depL2 = null; t.arrL2 = null; });
    });
    return 0;
  }

  // Step 2 (§4.2): the planner path inside the poll is contained at
  // this call site. poll's .catch fires only for genuine feed failures.
  // Re-entry guard (2026-10-16, stack-overflow fix): the planner path
  // must never re-enter itself. Its render tail reaches back into
  // updateBuses synchronously — replanLive -> highlightJourney (and
  // clearTripHighlight) -> applyFilters -> updateBuses — so a nested
  // poll path re-plans on top of the outer one until the stack
  // overflows (production, build 20261016-1906: 'replan:' /
  // 'poll-path:' Maximum call stack size exceeded under live-delay
  // state). The nested updateBuses still reconciles and renders
  // vehicles; only the nested planner path is skipped — the outer
  // run already holds this poll's delay state.
  function runPlannerPollPath() {
    if (plannerPollActive) return;
    plannerPollActive = true;
    try {
      plannerFaultThisPoll = false;
      try { updateLiveDelays(); }
      catch (e) { notePlannerFault(e, 'poll-path'); }
      if (!plannerFaultThisPoll) plannerFaultStreak = 0;
    } finally { plannerPollActive = false; }
  }

  function updateBuses(vehicles) {
    var now = performance.now();
    var seen = {};
    busSlots = [];
    for (var i = 0; i < vehicles.length && busSlots.length < BUS_MAX; i++) {
      var v = vehicles[i];
      if (v.lat == null || v.lon == null) continue;
      var grp = routeGroups[v.route_id];
      // Candidate C3: a gate-hidden vehicle is skipped — unless it
      // is the boarded vehicle of an active ride. The ride is a
      // session, not a presentation surface: its tracker keeps
      // reconciling below and the resulting slot is held in
      // rideShadowSlot (never busSlots), so the map, the header
      // count, and every pick surface stay gate-clean while the
      // ride keeps its live position.
      var gateHidden = !grp || !grp.visible;
      if (gateHidden && !(rideWidget && rideWidget.currentVehicleId === v.vehicle_id)) continue; // unknown or filtered route: skip
      var p = project(v.lat, v.lon);
      // Reconcile the per-vehicle tracker: new buses start one, existing
      // ones get their fix map-matched and their speed refreshed.
      var tr = busTrackers[v.vehicle_id];
      if (!tr || tr.routeId !== v.route_id) {
        tr = busTrackers[v.vehicle_id] = {
          id: v.vehicle_id, routeId: v.route_id,
          arc: null, pathIdx: -1, s: 0, sCorr: 0,
          speedMps: 0, fixT: 0, fixObsT: 0, lastX: null, lastZ: null, init: false,
          bornSeq: pollSeq, vehicle: null,
          // Kalman state: [kS arc-pos, kV velocity]; kP/kPv/kPvS covariance.
          // Replaces the ad-hoc sCorr easing with optimal gains; snap logic
          // below stays as the outlier gate. Q_* defaults until the Bayesian
          // timing cells land (telemetry-math/bayesian_cells.py).
          kS: 0, kV: 0, kP: 225, kPv: 25, kPvS: 0, kInit: false
        };
      }
      tr.vehicle = v; // fresh record each poll (destination, updated_at)
      var spMph0 = parseFloat(v.speed_mph);
      var inst0 = (!isNaN(spMph0) && spMph0 >= 0) ? spMph0 * MPH_TO_MPS : null;
      var m = matchFix(v.route_id, p[0], p[1], v.bearing, tr.arc ? tr : null);
      if (m && m.dist <= OFFSHAPE_M) {
        if (tr.arc && tr.pathIdx === m.pathIdx && tr.kInit) {
          var delta = m.s - tr.kS;
          if (Math.abs(delta) > SNAP_DIST_M) {
            // Outlier gate: snap and reinit the filter (a plain Kalman
            // filter is not robust to GPS jumps; the gate keeps it honest).
            tr.kS = m.s; tr.kV = (inst0 != null ? inst0 : tr.speedMps); tr.kP = KALMAN_R; tr.kPv = 25; tr.kPvS = 0;
          } else {
            // Kalman update: H = [1, 0], R = GPS variance. Optimal gain —
            // replaces the old sCorr easing with the MMSE correction.
            var Sk = tr.kP + KALMAN_R;
            var kk0 = tr.kP / Sk, kk1 = tr.kPvS / Sk;
            tr.kS += kk0 * delta;
            tr.kV += kk1 * delta;
            var nkP = tr.kP - kk0 * tr.kP;
            var nkPvS = tr.kPvS - kk0 * tr.kPvS;
            tr.kPv = tr.kPv - kk1 * tr.kPvS;
            tr.kP = nkP; tr.kPvS = nkPvS;
          }
          // Keep the filtered state on the arc.
          if (tr.arc) tr.kS = Math.max(0, Math.min(tr.arc.len, tr.kS));
          tr.s = tr.kS; tr.sCorr = 0; // render from the filtered state
        } else {
          tr.kS = m.s; tr.kV = (inst0 != null ? inst0 : tr.speedMps); tr.kP = KALMAN_R; tr.kPv = 25; tr.kPvS = 0;
          tr.kInit = true;
          tr.s = m.s; tr.sCorr = 0; // new / re-matched path: snap
        }
        tr.arc = m.arc; tr.pathIdx = m.pathIdx;
      } else {
        tr.arc = null; // detour or no shape: render the raw fix, hold still
      }
      // Learn: observed along-track speed between consecutive matched polls
      // feeds the local segment speed map (the empirical motion prior).
      if (m && m.dist <= OFFSHAPE_M && tr.matchS != null && tr.matchPath === m.pathIdx && lastPollT) {
        var dtP = (now - lastPollT) / 1000;
        if (dtP > 20 && dtP < 150) {
          var obsV = (m.s - tr.matchS) / dtP;
          if (Math.abs(obsV) < 31.3) { // 70 mph sanity: GPS jumps don't teach
            var segMid = segmentAt(v.route_id, m.pathIdx, (m.s + tr.matchS) / 2);
            if (segMid) observeSegment(v.route_id, segMid, Math.max(0, obsV));
          }
        }
      }
      tr.matchS = m ? m.s : null;
      tr.matchPath = m ? m.pathIdx : -1;
      // Speed: prefer the feed's own number; derive from fixes when absent.
      var spMph = parseFloat(v.speed_mph);
      var inst = (!isNaN(spMph) && spMph >= 0) ? spMph * MPH_TO_MPS : null;
      if (inst == null && tr.lastX != null && tr.fixT) {
        var dtF = (now - tr.fixT) / 1000;
        if (dtF > 5) inst = Math.hypot(p[0] - tr.lastX, p[1] - tr.lastZ) / dtF;
      }
      if (inst != null) {
        tr.speedMps = tr.init ? tr.speedMps * 0.4 + inst * 0.6 : inst;
        tr.init = true;
      }
      var fixStampMs = v.updated_at ? new Date(v.updated_at).getTime() : NaN;
      var stampAgeMs = isNaN(fixStampMs) ? 0 : Math.max(0, Math.min(1800000, Date.now() - fixStampMs));
      tr.fixObsT = now - stampAgeMs;
      tr.fixT = now; tr.lastX = p[0]; tr.lastZ = p[1];
      // Render state: matched arc position, else the raw fix.
      var pt = tr.arc ? pointAt(tr.arc, tr.s) : null;
      var rotY = (v.bearing != null && !isNaN(v.bearing))
        ? (90 - v.bearing) * DEG
        : (pt ? Math.atan2(-pt.dz, pt.dx) : 0);
      var slotRec = {
        vehicle: v,
        x: pt ? pt.x : p[0], z: pt ? pt.z : p[1],
        rotY: rotY,
        color: routeColors[v.route_id] || new THREE.Color(0xf2f2f2),
        tracker: tr
      };
      if (gateHidden) rideShadowSlot = slotRec; else busSlots.push(slotRec);
      seen[v.vehicle_id] = true;
    }
    // The shadow lives exactly one poll past its last reconcile:
    // the boarded bus leaving the feed, the rider alighting or
    // boarding another bus (it is no longer the boarded vehicle,
    // so it is neither refreshed nor seen), or the route's gate
    // reopening (a real slot exists again) all retire it here.
    if (rideShadowSlot) {
      var _shVid = rideShadowSlot.vehicle.vehicle_id;
      var _shSlotted = false;
      for (var _si = 0; _si < busSlots.length; _si++) {
        if (busSlots[_si].vehicle && busSlots[_si].vehicle.vehicle_id === _shVid) { _shSlotted = true; break; }
      }
      if (_shSlotted || !seen[_shVid]) rideShadowSlot = null;
    }
    for (var id in busTrackers) if (!seen[id]) delete busTrackers[id];
    lastPollT = now;
    pollSeq++;
    runPlannerPollPath(); // Phase 2b-i delays + planner path (contained, step 2)
    renderBusInstances();
    if (typeof refreshBrowseBuses === 'function') {
      var bp = document.getElementById('browse-panel');
      if (bp && !bp.hidden) refreshBrowseBuses(false);
    }
    if (selectedStop) renderStopLive();
    if (typeof renderBetaTiles === 'function') renderBetaTiles(); // beta tiles track live positions
    if (typeof refreshTripFusion === 'function') refreshTripFusion(); // live counts on trip legs
    // Planner Bus Focus (project 9): per-poll focus lifecycle —
    // scheduled upgrade, loss, return. Contained like the rest of the
    // poll path: a focus fault is logged under its own class, never
    // through the planner-fault accounting, and this block calls no
    // planner function, so it cannot re-enter the poll path.
    if (typeof plannerFocusPoll === 'function') {
      try { plannerFocusPoll(); } catch (e) { errLog('planner', 'focus-poll: ' + (e && e.message || e), e); }
    }
    if (selectedVehicleId) refreshBusInfo(); // tapped bus moved / new data
    if (selectedVehicleId) refreshBusFixAge(); // Position Integrity item 1: age tracks the new fix
    return busSlots.length;
  }

  // SMART display payload (reactivation, 2026-10-15): the builder
  // publishes SMART vehicles separately (live-data/smart-display.json)
  // because the Swiftly license is display-only — SMART vehicles are
  // never part of the vehicles.json contract. Fetched on the same poll
  // cycle as the main envelope; resolves null on any failure so a SMART
  // outage can never fail or delay-mark the DDOT/QLINE poll.
  function fetchSmartDisplay(proxy) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 8000);
    return fetch(proxy + '/smart-display.json', { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); return r.ok ? r.json() : null; },
            function () { clearTimeout(timer); return null; });
  }
  // SMART trip-updates payload (deployed 2026-10-17): fetched
  // on the same poll cycle as the display payload; resolves null on
  // any failure so a trip-updates outage can never fail the poll.
  function fetchSmartTripUpdates(proxy) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 8000);
    return fetch(proxy + '/smart-trip-updates.json', { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); return r.ok ? r.json() : null; },
            function () { clearTimeout(timer); return null; });
  }
  function poll() {
    var proxy = (window.FORGE_LIVE_DATA_URL || '').replace(/\/$/, '');
    if (!proxy) { setHeader(null, 'connecting…', false); return; }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 20000);
    fetch(proxy + '/vehicles.json', { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error('http ' + r.status); return r.json(); },
            function (e) { clearTimeout(timer); throw e; })
      .then(function (d) {
        if (!d || !Array.isArray(d.vehicles)) throw new Error('bad payload');
        // SMART (reactivated 2026-10-15) joins here: the display
        // payload's vehicles merge into this poll's live set before
        // every fan-out below (map, counts, ride-along, follow, tiles,
        // delay matching). smartDisplayVehicles drops the payload
        // entirely when it is missing, malformed, or stale, so SMART
        // can only ever add current positions. The envelope itself
        // (sources, generated_at) is untouched: the degradation notice
        // reads it exactly as before and never reads sources.smart.
        return fetchSmartDisplay(proxy).then(function (s) {
          smartAge = computeSmartAge(s, Date.now());
          ensureSmartHeadsigns(proxy);
          var sv = smartDisplayVehicles(s, Date.now());
          if (sv.length) d.vehicles = d.vehicles.concat(sv);
          // SMART trip updates ride the same cycle (deployed
          // 2026-10-17). Display-only ingest for SMART stop cards;
          // the result is never merged into d.vehicles or any state
          // the planner reads.
          return fetchSmartTripUpdates(proxy).then(function (t) {
            ingestSmartTripUpdates(t, Date.now());
            return d;
          });
        });
      })
      .then(function (d) {
        lastVehicles = d.vehicles;
        liveEverOk = true;
        if (typeof window.__setRideVehicles === 'function') window.__setRideVehicles(d.vehicles);
        liveCounts = countByRoute(d.vehicles); // raw counts first: filters must not starve the state engine
        var n = updateBuses(d.vehicles);
        if (updateRunningState()) {
          applyFilters();   // re-applies visibility + dimming, re-renders buses
          syncFilterUI();
        }
        refreshFilterCounts();
        if (selectedRoute) renderRouteCard(selectedRoute);
        lastTotal = n;
        setHeader(n, 'updated ' + fmtTime(d.generated_at ? new Date(d.generated_at) : null), false);
        svcFeedOk(d); // service degradation notice: evaluate source states + freshness
        // SMART freshness surfaces track every successful poll (S6).
        applySmartAgeUI();
      })
      .catch(function () {
        var text = liveEverOk
          ? 'live feed retrying…'
          : (historyOk ? 'showing last logged positions · live feed retrying…' : 'live feed retrying…');
        setHeader(lastTotal, text, true);
        svcFeedFail(); // service degradation notice: feed unreachable
      });
  }

  // === SVC-NOTICE-BEGIN ===
  // --- service degradation notice -------------------------------------------
  // Fail-safe rider notice for live-data degradation (staged candidate;
  // record: files/service-notice/service-notice.md). Detection uses only
  // data the vehicles poll already receives: the envelope's per-agency
  // source states (sources.ddot / sources.qline), the envelope's
  // generated_at age, and the poll's own success or failure. No new
  // fetches, no new endpoints. sources.smart is never read here: it
  // reports the SMART display leg (SMART reactivated 2026-10-15), whose
  // freshness is labelled by the SMART freshness graft on its own
  // surfaces (S6); a SMART state change is not a degradation of the
  // DDOT/QLINE envelope this notice guards. A source reporting ok
  // with zero vehicles is NOT a degradation — overnight truth is zero
  // vehicles — so vehicle counts are never a signal. S6: the notice
  // claims only the freshness and source state the envelope measures,
  // and names the data's age whenever positions may be old.
  // Position Integrity item 3 (analysis-2026-10-16 §2 point 4): the
  // stale-feed state fires at 12 minutes — past the feed's measured
  // practical cadence (~10 min between builds in the founding stall),
  // ahead of the hourly production check's ~20 min ops flag — so a
  // stalled pipeline surfaces to riders while the positions on screen
  // are still young. Supersedes the 2026-10-15 record's 15 min
  // (3 build cycles), under which the founding stall never tripped
  // this notice at all.
  var SVC_STALE_MS = 12 * 60 * 1000;
  var svcAttempted = false;   // at least one poll attempt has completed
  var svcLastOk = false;      // the most recent poll attempt succeeded
  var svcLastPayload = null;  // last successfully parsed vehicles envelope
  var svcDismissedSig = null; // signature of the dismissed condition set
  var svcShownSig = null;     // signature currently rendered (null = hidden)
  var svcExpanded = false;

  var SVC_SHORT = {
    'stale': 'live positions delayed',
    'ddot-not-configured': 'DDOT positions not connected',
    'ddot-down': 'DDOT positions unavailable',
    'ddot-partial': 'DDOT positions incomplete',
    'qline-down': 'QLINE positions unavailable'
  };
  var SVC_TAIL = 'What still works: the map, all stop and route information, and the trip planner are unaffected. The planner computes journeys from the published DDOT timetable (DDOT schedule data current through February 7, 2027), not from live positions. While live positions are degraded, scheduled times are the reliable basis for planning a trip. This notice concerns the live data feed only. Bus and streetcar service is not cancelled, and this page does not announce service cancellations.';

  function svcConditions() {
    var out = [];
    if (!svcAttempted) return out;
    if (!svcLastOk) { out.push({ key: 'unreachable' }); return out; }
    var d = svcLastPayload;
    if (!d) return out;
    var genT = Date.parse(d.generated_at || '');
    if (!isNaN(genT)) {
      var ageMs = Date.now() - genT;
      if (ageMs > SVC_STALE_MS) {
        out.push({ key: 'stale', genAt: d.generated_at, ageMin: Math.floor(ageMs / 60000) });
      }
    }
    var src = d.sources || {};
    var dd = src.ddot;
    if (dd) {
      if (dd.ok === false && dd.configured === false) {
        out.push({ key: 'ddot-not-configured' });
      } else if (dd.ok === false) {
        out.push({ key: 'ddot-down' });
      } else {
        // The builder reports ok:true for the DDOT leg whenever the leg
        // ran; a leg whose every route-group request failed is visible
        // only in the batch counters, so the counters are the signal.
        var bo = Number(dd.batches_ok), bf = Number(dd.batches_failed);
        if (isFinite(bo) && isFinite(bf) && (bo + bf) > 0) {
          if (bo === 0) out.push({ key: 'ddot-down' });
          else if (bf > 0) out.push({ key: 'ddot-partial', ok: bo, total: bo + bf });
        }
      }
    }
    var ql = src.qline;
    if (ql && ql.ok === false) out.push({ key: 'qline-down' });
    return out;
  }

  function svcHeadline(c) {
    switch (c.key) {
      case 'unreachable':
        return 'Live vehicle positions unavailable. The live feed cannot be reached.';
      case 'stale':
        return 'Live positions delayed — last update ' +
          fmtTime(new Date(c.genAt)) + ', ' + c.ageMin +
          (c.ageMin === 1 ? ' minute' : ' minutes') + ' ago.';
      case 'ddot-not-configured':
        return 'DDOT live positions are not available on this map.';
      case 'ddot-down':
        return 'DDOT live positions unavailable. The DDOT feed is not reporting.';
      case 'ddot-partial':
        return 'DDOT live positions are incomplete. Some DDOT routes are not reporting.';
      case 'qline-down':
        return 'QLINE live positions unavailable. The QLINE feed is not reporting.';
    }
    return '';
  }

  function svcDetailText(c) {
    switch (c.key) {
      case 'unreachable':
        if (typeof liveEverOk !== 'undefined' && liveEverOk && svcLastPayload) {
          return 'The live data file this page reads could not be loaded. The vehicle positions on the map are from the last successful update (' +
            fmtTime(new Date(svcLastPayload.generated_at)) + ') and are not being refreshed.';
        }
        if (typeof historyOk !== 'undefined' && historyOk) {
          return 'The live data file this page reads could not be loaded. Any vehicle positions shown come from the most recent logged snapshot. They are not current positions and are not being refreshed.';
        }
        return 'The live data file this page reads could not be loaded, and no live update has been received yet. No live vehicle positions are shown.';
      case 'stale':
        return 'The live feed is rebuilt every five minutes. The newest file available is from ' +
          fmtTime(new Date(c.genAt)) + ' (' + c.ageMin + ' minutes old). The positions on the map are exactly the positions in that file. They are not advanced or estimated between updates.';
      case 'ddot-not-configured':
        return 'The DDOT live position feed is not connected to this map in its current configuration, so DDOT vehicles do not appear. This is a data connection state. It is not a change to DDOT service, and it does not affect QLINE positions, the map, or the trip planner.';
      case 'ddot-down':
        return 'The DDOT position source returned no data for the most recent update. DDOT vehicles are removed from the map while the source is not reporting, and they return when the source resumes. A source outage is not a service suspension. DDOT buses continue to run on their published schedules.';
      case 'ddot-partial':
        return 'The DDOT position source returned data for ' + c.ok + ' of ' + c.total +
          ' route groups in the most recent update. Vehicles on the remaining routes do not appear in this update. Routes that are reporting are shown at their measured positions.';
      case 'qline-down':
        return 'The QLINE position source returned no data for the most recent update. QLINE streetcars are removed from the map while the source is not reporting, and they return when the source resumes. A source outage is not a service suspension.';
    }
    return '';
  }

  function svcSig(conds) {
    return conds.map(function (c) {
      return c.key +
        (c.key === 'stale' ? '@' + c.genAt : '') +
        (c.key === 'ddot-partial' ? ':' + c.ok + '/' + c.total : '');
    }).join('|');
  }

  function svcRender() {
    var box = $('svc-notice');
    if (!box) return;
    var conds = svcConditions();
    if (!conds.length) {
      box.hidden = true;
      svcShownSig = null;
      svcDismissedSig = null; // a cleared condition re-arms the notice
      svcExpanded = false;
      return;
    }
    var sig = svcSig(conds);
    if (sig === svcDismissedSig) {
      box.hidden = true;
      svcShownSig = null;
      return;
    }
    var head = svcHeadline(conds[0]);
    if (conds.length > 1) {
      head += ' Also: ' + conds.slice(1).map(function (c) { return SVC_SHORT[c.key]; }).join('; ') + '.';
    }
    if (!box.hidden && svcShownSig === sig && $('svc-headline').textContent === head) return;
    $('svc-headline').textContent = head;
    var det = $('svc-details');
    det.innerHTML = '';
    conds.forEach(function (c) {
      var p = document.createElement('p');
      p.textContent = svcDetailText(c);
      det.appendChild(p);
    });
    var tail = document.createElement('p');
    tail.textContent = SVC_TAIL;
    det.appendChild(tail);
    det.hidden = !svcExpanded;
    $('svc-details-btn').setAttribute('aria-expanded', svcExpanded ? 'true' : 'false');
    box.hidden = false;
    svcShownSig = sig;
  }

  // Poll hooks: called from poll()'s success and failure paths only.
  function svcFeedOk(d) {
    svcAttempted = true;
    svcLastOk = true;
    svcLastPayload = d;
    svcRender();
  }
  function svcFeedFail() {
    svcAttempted = true;
    svcLastOk = false;
    svcRender();
  }

  (function svcWire() {
    var btn = $('svc-details-btn'), dis = $('svc-dismiss');
    if (btn) btn.addEventListener('click', function () {
      svcExpanded = !svcExpanded;
      $('svc-details').hidden = !svcExpanded;
      btn.setAttribute('aria-expanded', svcExpanded ? 'true' : 'false');
    });
    if (dis) dis.addEventListener('click', function () {
      if (svcShownSig != null) svcDismissedSig = svcShownSig;
      var box = $('svc-notice');
      if (box) box.hidden = true;
      svcShownSig = null;
    });
    // Re-evaluate between polls so a stale condition surfaces (and its
    // stated age stays current) without waiting for the next 60 s poll.
    // Renders from stored state only; this timer never fetches.
    setInterval(function () { svcRender(); }, 30000);
  })();
  // === SVC-NOTICE-END ===

  // --- service alerts (phase 1) — presentation: Map-Native (concept B) ------
  // Consumes the proxy's /api/alerts (DDOT BusTime bulletins, kind
  // 'realtime'). Presentation
  // follows concept B as selected 2026-10-14: there is NO global strip.
  // Alerts live where they apply — severity badges on route chips, alert
  // bands in the stop card, "what changed" lines in the planner, and
  // glyph + dashed overlays on the 3D map itself. Planned (bulletin-board)
  // alerts tint ONLY the chip: they never draw map geometry, because the
  // board carries no stop- or path-level precision. Zero-state is absence:
  // no badges, no bands, no overlays. Every treatment pairs color with a
  // glyph and words (see ALERT_FX and the help card's vocabulary list);
  // nothing is carried by color alone. Feature-detect by design: the
  // endpoint does not exist on the proxy until phase 1 deploys, and every
  // failure path here degrades silently, so the map behaves as before.
  var alertsState = { ok: false, alerts: [], sources: [], misses: {} };
  var ALERT_EFFECT_RANK = {
    NO_SERVICE: 5, REDUCED_SERVICE: 4, SIGNIFICANT_DELAYS: 3, DETOUR: 3,
    ACCESSIBILITY_ISSUE: 2, STOP_MOVED: 2, MODIFIED_SERVICE: 2,
    ADDITIONAL_SERVICE: 1, OTHER_EFFECT: 1, UNKNOWN_EFFECT: 0, NO_EFFECT: 0
  };
  var ALERT_AGENCY = { ddot: 'DDOT', qline: 'QLINE' };
  // The five-effect vocabulary (design samples, shared table). cls keys
  // the CSS treatments; css is the glyph color used on map sprites.
  var ALERT_FX = {
    NO_SERVICE: { glyph: '✕', label: 'No service', cls: 'nostop', css: '#A2A2A2' },
    DETOUR: { glyph: '↪', label: 'Detour', cls: 'detour', css: '#A2A2A2' },
    REDUCED_SERVICE: { glyph: '◑', label: 'Reduced service', cls: 'reduced', css: '#B4B4B4' },
    STOP_MOVED: { glyph: '⇄', label: 'Stop moved', cls: 'moved', css: '#8E8E8E' },
    INFO: { glyph: 'ℹ', label: 'Notice', cls: 'info', css: '#9F9F9F' }
  };
  var ALERT_FX_FALLBACK = { glyph: '⚠', label: 'Service alert', cls: 'detour', css: '#A2A2A2' };
  function alertFx(a) {
    var e = a && a.effect;
    if (e && ALERT_FX[e]) return ALERT_FX[e];
    if (e === 'SIGNIFICANT_DELAYS') return { glyph: '⚠', label: 'Significant delays', cls: 'detour', css: '#A2A2A2' };
    if (e === 'MODIFIED_SERVICE') return { glyph: '⚠', label: 'Modified service', cls: 'detour', css: '#A2A2A2' };
    if (e === 'ACCESSIBILITY_ISSUE') return { glyph: '⚠', label: 'Accessibility issue', cls: 'detour', css: '#A2A2A2' };
    if (e === 'ADDITIONAL_SERVICE') return { glyph: 'ℹ', label: 'Additional service', cls: 'info', css: '#9F9F9F' };
    if (e) return { glyph: '⚠', label: e.replace(/_/g, ' ').toLowerCase(), cls: 'detour', css: '#A2A2A2' };
    return ALERT_FX_FALLBACK;
  }
  function alertParseT(s) { var t = s ? Date.parse(s) : NaN; return isNaN(t) ? null : t; }
  function alertIsActive(a, nowMs) {
    if (!a) return false;
    var p = a.active_period || {};
    var st = alertParseT(p.start), en = alertParseT(p.end);
    if (st !== null && nowMs < st) return false;   // not yet in force
    if (en !== null && nowMs > en) return false;   // period ended
    return true;
  }
  function activeAlerts() {
    var n = Date.now();
    return alertsState.alerts.filter(function (a) { return alertIsActive(a, n); });
  }
  function alertsForRoute(rid) {
    if (!rid) return [];
    var id = String(rid);
    return activeAlerts().filter(function (a) { return (a.routes || []).indexOf(id) >= 0; });
  }
  function alertsForStop(stid) {
    if (stid === null || stid === undefined || stid === '') return [];
    var id = String(stid);
    return activeAlerts().filter(function (a) { return (a.stops || []).indexOf(id) >= 0; });
  }
  function alertWorstEffect(list) {
    var w = null, wr = -1;
    (list || []).forEach(function (a) {
      var r = ALERT_EFFECT_RANK[a.effect] || 0;
      if (r > wr) { wr = r; w = a.effect; }
    });
    return w;
  }
  function alertWindowText(a) {
    var p = a.active_period || {};
    var st = alertParseT(p.start), en = alertParseT(p.end);
    if (st === null && en === null) return '';
    var f = function (t) { return fmtTime(new Date(t)); };
    if (st !== null && en !== null) return f(st) + ' – ' + f(en);
    if (st !== null) return 'from ' + f(st);
    return 'until ' + f(en);
  }
  // Plain-language "what changed" sentence for one alert — the words that
  // accompany every glyph, in the planner, the stop card, and the
  // screen-reader list. Built only from fields the feed actually carries.
  function alertWhatChanged(a) {
    var fx = alertFx(a);
    var s = fx.label + ' — ' + (a.header || 'Service alert');
    var bits = [ALERT_AGENCY[a.agency] || a.agency || '',
      a.kind === 'planned' ? 'planned notice' : 'live'];
    var win = alertWindowText(a);
    if (win) bits.push(win);
    s += ' (' + bits.filter(Boolean).join(' · ') + ')';
    if (a.description) s += ' ' + a.description;
    return s;
  }
  function alertSrText(a) {
    var fx = alertFx(a);
    var s = fx.label + ': ' + (a.header || 'Service alert') + ' — ' +
      (ALERT_AGENCY[a.agency] || a.agency || '') + ', ' +
      (a.kind === 'planned' ? 'planned notice' : 'live alert');
    if (a.routes && a.routes.length) s += ', route' + (a.routes.length === 1 ? ' ' : 's ') + a.routes.map(routeLabel).join(', ');
    if (a.stops && a.stops.length) s += ', stop' + (a.stops.length === 1 ? ' ' : 's ') + a.stops.join(', ');
    var win = alertWindowText(a);
    if (win) s += ', ' + win;
    if (a.description) s += '. ' + a.description;
    return s;
  }
  // Retire an alert only after it is absent from two consecutive fetches
  // (design rule) — a single flaky fetch never flickers the UI.
  function mergeAlerts(fresh) {
    var seen = {};
    (fresh || []).forEach(function (a) {
      if (a && a.id) { seen[a.id] = true; alertsState.misses[a.id] = 0; }
    });
    var kept = (fresh || []).slice();
    alertsState.alerts.forEach(function (old) {
      if (old.id && !seen[old.id]) {
        alertsState.misses[old.id] = (alertsState.misses[old.id] || 0) + 1;
        if (alertsState.misses[old.id] < 2) kept.push(old);
        else delete alertsState.misses[old.id];
      }
    });
    alertsState.alerts = kept;
  }

  // --- accessible text equivalent -------------------------------------------
  // #alerts-sr is a visually-hidden list naming every active alert in
  // words, rebuilt by this same render path whenever the alert set
  // changes; #alerts-live announces only set changes (never the 120 s
  // re-poll), so screen-reader users get the alerts without the noise.
  var alertsSrSig = '', alertsLiveIds = null;
  function renderAlertSr() {
    var list = $('alerts-sr-list');
    if (!list) return;
    var act = alertsState.ok ? activeAlerts() : [];
    var sig = (alertsState.ok ? 'ok' : 'down') + '|' + act.map(function (a) {
      return a.id + ':' + (a.effect || '') + ':' + (a.header || '');
    }).join(';;');
    if (sig !== alertsSrSig) {
      alertsSrSig = sig;
      list.innerHTML = '';
      act.forEach(function (a) {
        var li = document.createElement('li');
        li.textContent = alertSrText(a);
        list.appendChild(li);
      });
      var src = $('alerts-sr-sources');
      if (src) {
        src.textContent = alertsState.sources.map(function (s) {
          var name = (ALERT_AGENCY[s.agency] || s.agency || '').toUpperCase();
          if (!s.ok) return name + ' alerts unavailable';
          return name + ' updated ' + fmtTime(s.fetched_at ? new Date(s.fetched_at) : null) +
            (s.kind === 'planned' ? ' · bulletin board (planned notices)' : ' · live feed');
        }).join(' · ');
      }
      var ids = act.map(function (a) { return a.id; }).sort().join(',');
      if (alertsLiveIds !== null && ids !== alertsLiveIds) {
        var lv = $('alerts-live');
        if (lv) {
          lv.textContent = act.length
            ? 'Service alerts updated: ' + act.length + ' active. Most severe: ' +
              alertFx({ effect: alertWorstEffect(act) }).label.toLowerCase() + '.'
            : 'All service alerts have cleared.';
        }
      }
      alertsLiveIds = ids;
    }
  }

  // --- route chip badges ------------------------------------------------------
  // Per the samples: a red ✕ badge when any alert on the route is
  // NO_SERVICE; an amber count badge for live alerts; a hollow "P" when
  // the route carries only planned notices. The badge glyph is
  // aria-hidden — the same information is written into the chip's
  // aria-label and title, so the chip never speaks in color alone.
  function renderChipBadges() {
    var chips = document.querySelectorAll('.f-chip[data-route]');
    for (var i = 0; i < chips.length; i++) {
      var chip = chips[i], rid = chip.getAttribute('data-route');
      var list = (alertsState.ok && rid) ? alertsForRoute(rid) : [];
      var olds = chip.querySelectorAll('.alert-badge');
      for (var j = olds.length - 1; j >= 0; j--) olds[j].remove();
      chip.classList.toggle('has-alert', list.length > 0);
      var worst = list.length ? alertWorstEffect(list) : null;
      chip.classList.toggle('alert-severe', worst === 'NO_SERVICE');
      if (!list.length) {
        chip.removeAttribute('aria-label');
        chip.removeAttribute('title');
        continue;
      }
      var live = list.filter(function (a) { return a.kind !== 'planned'; });
      var badge = document.createElement('span');
      badge.className = 'alert-badge';
      badge.setAttribute('aria-hidden', 'true');
      if (worst === 'NO_SERVICE') { badge.classList.add('ab-nostop'); badge.textContent = '✕'; }
      else if (live.length) { badge.classList.add('ab-live'); badge.textContent = String(live.length); }
      else { badge.classList.add('ab-planned'); badge.textContent = 'P'; }
      chip.appendChild(badge);
      var fx = alertFx({ effect: worst });
      var nameEl = chip.querySelector('b');
      var nm = nameEl ? nameEl.textContent : ('Route ' + rid);
      chip.setAttribute('aria-label', nm + ' — service alert: ' + fx.label.toLowerCase() +
        (list.length > 1 ? ', ' + list.length + ' alerts active' : '') +
        (!live.length ? ' (planned notice)' : ''));
      chip.title = 'Service alert: ' + fx.label + (!live.length ? ' (planned notice)' : '');
    }
  }

  // --- map overlays (3D) ------------------------------------------------------
  // Treatments, per the vocabulary: NO_SERVICE — the affected span is
  // muted by a dark fade ribbon and overdrawn with a red-white dashed
  // ribbon (never amber: route 4's own color IS #B4B4B4) plus a ✕ sprite;
  // DETOUR — the same red-white dashed ribbon over the affected span plus
  // a ↪ sprite, and pulsing amber rings on the bypassed stops the
  // bulletin names; REDUCED_SERVICE — a dim ribbon over the route;
  // STOP_MOVED — a hollow blue ring and ⇄ sprite at the named stop (the
  // feed carries no replacement-stop coordinates, so no new boarding
  // point is drawn — the words live in the stop card); INFO — none.
  // Spans come from the alert's own stop list snapped to the route path;
  // a route-wide alert with no stops spans the whole route. The bulletin
  // carries no detour path geometry, so no diversion line is invented.
  // Overlays are children of the route's own group, so route/group
  // filter toggles hide them with their route.
  var alertOverlaySubs = {};   // rid -> THREE.Group child of routeGroups[rid]
  var alertPulseRings = [];    // ring meshes animated by alertPulseTick
  var alertPulseRaf = 0;
  var alertDashTex = null;
  var alertReducedMotion = (typeof window !== 'undefined' && window.matchMedia)
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
  var alertStopById = null, alertStopDataRef = null;
  function alertStopsById() {
    if (typeof stopData === 'undefined' || !stopData) return {};
    if (alertStopById && alertStopDataRef === stopData) return alertStopById;
    var m = {};
    stopData.forEach(function (s) { if (s && s.id !== undefined && s.id !== null) m[String(s.id)] = s; });
    alertStopById = m; alertStopDataRef = stopData;
    return m;
  }
  function alertStopsForRoute(a, rid) {
    var byId = alertStopsById(), out = [];
    (a.stops || []).forEach(function (sid) {
      var st = byId[String(sid)];
      if (st && (st.r || []).indexOf(rid) >= 0) out.push(st);
    });
    return out;
  }
  function alertSpanFor(route, a, rid) {
    var stops = alertStopsForRoute(a, rid);
    if (!stops.length || typeof nearestOnPath !== 'function') return route.paths || [];
    var best = null;
    (route.paths || []).forEach(function (path) {
      if (!path || path.length < 2) return;
      var idx = [];
      stops.forEach(function (st) {
        var i = nearestOnPath(path, st.x, st.z);
        var dx = path[i][0] - st.x, dz = path[i][1] - st.z;
        if (dx * dx + dz * dz <= 600 * 600) idx.push(i);
      });
      if (idx.length && (!best || idx.length > best.idx.length)) best = { path: path, idx: idx };
    });
    if (!best) return route.paths || [];
    var lo = Math.min.apply(null, best.idx), hi = Math.max.apply(null, best.idx);
    lo = Math.max(0, lo - 1); hi = Math.min(best.path.length - 1, hi + 1);
    if (hi - lo < 1) { lo = Math.max(0, lo - 1); hi = Math.min(best.path.length - 1, hi + 1); }
    return [best.path.slice(lo, hi + 1)];
  }
  function alertDashTexture() {
    if (alertDashTex) return alertDashTex;
    var c = document.createElement('canvas');
    c.width = 256; c.height = 16;
    var x = c.getContext('2d');
    x.fillStyle = '#434343'; x.fillRect(0, 0, 128, 16);   // red dash
    x.fillStyle = '#F2F2F2'; x.fillRect(128, 0, 42, 16);  // white dash
    // remainder transparent: the route deck shows through the gap
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    alertDashTex = tex;
    return tex;
  }
  function alertDashRibbon(pts, y) {
    var g = ribbonGeometry(pts, 78, y);
    var pos = g.getAttribute('position');
    var pairs = pos.count / 2;
    var len = 0;
    for (var i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    var reps = Math.max(2, Math.round(len / 300));
    var uv = new Float32Array(pos.count * 2);
    for (var k = 0; k < pairs; k++) {
      var u = pairs > 1 ? (k / (pairs - 1)) * reps : 0;
      uv[k * 4] = u; uv[k * 4 + 1] = 0; uv[k * 4 + 2] = u; uv[k * 4 + 3] = 1;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  }
  function alertGlyphSprite(glyph, colorCss, scale) {
    var c = document.createElement('canvas');
    c.width = 192; c.height = 192;
    var x = c.getContext('2d');
    x.font = '700 124px "Inter", sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineWidth = 16; x.strokeStyle = 'rgba(16,16,16,.92)';
    x.strokeText(glyph, 96, 102);
    x.fillStyle = colorCss;
    x.fillText(glyph, 96, 102);
    var tex = new THREE.CanvasTexture(c);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(scale, scale, 1);
    sp.renderOrder = 6;
    logoFadeGlyphs.push(sp);
    return sp;
  }
  function addAlertPulseRing(parent, st) {
    var ring = new THREE.Mesh(
      new THREE.RingGeometry(34, 58, 40),
      new THREE.MeshBasicMaterial({ color: 0xb4b4b4, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(st.x, 22, st.z);
    ring.userData.phase = Math.random() * Math.PI * 2;
    parent.add(ring);
    alertPulseRings.push(ring);
  }
  function alertPulseTick() {
    if (!alertPulseRings.length) { alertPulseRaf = 0; return; }
    var t = performance.now() / 420;
    for (var i = 0; i < alertPulseRings.length; i++) {
      var r = alertPulseRings[i];
      var s = 1 + 0.3 * Math.sin(t + r.userData.phase);
      r.scale.set(s, s, 1);
      r.material.opacity = 0.95 - 0.4 * (0.5 + 0.5 * Math.sin(t + r.userData.phase));
    }
    alertPulseRaf = requestAnimationFrame(alertPulseTick);
  }
  function disposeAlertSub(sub) {
    sub.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();  // disposes the material only; the shared dash texture survives
    });
  }
  function renderAlertMap() {
    if (typeof THREE === 'undefined' || typeof scene === 'undefined' ||
        typeof routeById === 'undefined' || typeof routeGroups === 'undefined') return;
    Object.keys(alertOverlaySubs).forEach(function (rid) {
      var sub = alertOverlaySubs[rid];
      if (sub.parent) sub.parent.remove(sub);
      disposeAlertSub(sub);
      delete alertOverlaySubs[rid];
    });
    alertPulseRings = [];
    if (alertPulseRaf) { cancelAnimationFrame(alertPulseRaf); alertPulseRaf = 0; }
    if (!alertsState.ok) return;
    activeAlerts().forEach(function (a) {
      if (a.kind === 'planned') return;  // planned: chip tint only, never geometry
      (a.routes || []).forEach(function (rid) {
        var route = routeById[rid];
        var host = routeGroups[rid];
        if (!route || !route.paths || !host) return;
        var ri = routeOrder.indexOf(rid);
        var y = 66 + (ri < 0 ? 0 : ri) * 1.2 + 3;
        var fx = alertFx(a);
        var sub = alertOverlaySubs[rid];
        if (!sub) { sub = new THREE.Group(); sub.name = 'alert-overlay'; host.add(sub); alertOverlaySubs[rid] = sub; }
        if (a.effect === 'NO_SERVICE' || a.effect === 'DETOUR') {
          alertSpanFor(route, a, rid).forEach(function (span) {
            if (!span || span.length < 2) return;
            if (a.effect === 'NO_SERVICE') {
              sub.add(new THREE.Mesh(ribbonGeometry(span, 78, y),
                new THREE.MeshBasicMaterial({ color: 0x05070a, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false })));
            }
            sub.add(new THREE.Mesh(alertDashRibbon(span, y + 0.7),
              new THREE.MeshBasicMaterial({ map: alertDashTexture(), transparent: true, side: THREE.DoubleSide, depthWrite: false })));
            var mid = span[Math.floor(span.length / 2)];
            var spr = alertGlyphSprite(fx.glyph, fx.css, 160);
            spr.position.set(mid[0], y + 130, mid[1]);
            sub.add(spr);
          });
          alertStopsForRoute(a, rid).forEach(function (st) { addAlertPulseRing(sub, st); });
        } else if (a.effect === 'REDUCED_SERVICE') {
          (route.paths || []).forEach(function (p) {
            if (!p || p.length < 2) return;
            sub.add(new THREE.Mesh(ribbonGeometry(p, 78, y),
              new THREE.MeshBasicMaterial({ color: 0x05070a, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false })));
          });
        } else if (a.effect === 'STOP_MOVED') {
          alertStopsForRoute(a, rid).forEach(function (st) {
            var ring = new THREE.Mesh(
              new THREE.RingGeometry(26, 42, 32),
              new THREE.MeshBasicMaterial({ color: 0x8e8e8e, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false })
            );
            ring.rotation.x = -Math.PI / 2;
            ring.position.set(st.x, 22, st.z);
            sub.add(ring);
            var spr2 = alertGlyphSprite(fx.glyph, fx.css, 120);
            spr2.position.set(st.x, y + 100, st.z);
            sub.add(spr2);
          });
        }
        // INFO and unlisted effects: no map geometry (vocabulary rule).
      });
    });
    if (alertPulseRings.length && !alertReducedMotion && !alertPulseRaf) {
      alertPulseRaf = requestAnimationFrame(alertPulseTick);
    }
  }

  // --- stop card bands ---------------------------------------------------------
  // One band per alert scoped to this stop: glyph, a bold plain-language
  // first line, then the alert's own words with agency + kind. Route-level
  // alerts that do not name this stop are NOT shown here — the stop card
  // never claims stop precision the feed does not have.
  function renderStopAlerts(st) {
    var box = $('stop-alerts'), list = $('stop-alerts-list');
    if (!box || !list) return;
    var mine = (st && alertsState.ok) ? alertsForStop(st.id) : [];
    if (!mine.length) { box.hidden = true; list.innerHTML = ''; return; }
    box.hidden = false;
    list.innerHTML = '';
    mine.forEach(function (a) {
      var fx = alertFx(a);
      var band = document.createElement('div');
      band.className = 'sa-band' + (a.effect === 'NO_SERVICE' ? ' severe' : '') +
        (a.effect === 'STOP_MOVED' ? ' moved' : '');
      var ico = document.createElement('span');
      ico.className = 'sa-ico';
      ico.setAttribute('aria-hidden', 'true');
      ico.textContent = fx.glyph;
      band.appendChild(ico);
      var p = document.createElement('p');
      var lead = document.createElement('b');
      var win = alertWindowText(a);
      lead.textContent =
        a.effect === 'DETOUR' ? 'This stop is bypassed' + (win ? ' ' + win : '') + '.'
        : a.effect === 'NO_SERVICE' ? 'No service at this stop' + (win ? ' ' + win : '') + '.'
        : a.effect === 'STOP_MOVED' ? 'Boarding point moved from this stop' + (win ? ' ' + win : '') + '.'
        : fx.label + ' at this stop' + (win ? ' ' + win : '') + '.';
      p.appendChild(lead);
      var rest = document.createElement('span');
      rest.textContent = ' ' + (a.header || 'Service alert') +
        ' (' + (ALERT_AGENCY[a.agency] || a.agency || '') + ' · ' +
        (a.kind === 'planned' ? 'planned notice' : 'live') + ')' +
        (a.description ? ' ' + a.description : '');
      p.appendChild(rest);
      band.appendChild(p);
      list.appendChild(band);
    });
  }
  function refreshAlertSurfaces() {
    fvAlertsChecked = true;
    renderAlertSr();
    renderChipBadges();
    try { renderAlertMap(); } catch (e) { /* overlay failure must never mark the feed down */ }
    if (typeof selectedStop !== 'undefined' && selectedStop) {
      var sc = $('stop-card');
      if (sc && !sc.hidden) renderStopAlerts(selectedStop);
    }
    if (typeof tripJourneys !== 'undefined' && tripJourneys && tripJourneys.length &&
        typeof tripSel !== 'undefined' && tripSel >= 0 && typeof renderTripDetail === 'function') {
      renderTripDetail();
    }
    var bp = $('browse-panel');
    if (bp && !bp.hidden) {
      if (typeof buildBrowseStops === 'function') buildBrowseStops();
      if (typeof refreshBrowseBuses === 'function') refreshBrowseBuses(true);
    }
    fvRefreshProofs();
  }
  function pollAlerts() {
    var proxy = (window.FORGE_LIVE_DATA_URL || '').replace(/\/$/, '');
    if (!proxy) return;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 15000);
    fetch(proxy + '/alerts.json', { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error('http ' + r.status); return r.json(); },
            function (e) { clearTimeout(timer); throw e; })
      .then(function (d) {
        if (!d || !Array.isArray(d.alerts)) throw new Error('bad payload');
        // SMART service alerts are not published to this feed: the
        // Swiftly grant does not enable service alerts, and no SMART
        // alerts design exists. Any SMART record is dropped at ingest,
        // with its source line, as a standing guard.
        mergeAlerts(d.alerts.filter(function (a) { return a && a.agency !== 'smart'; }));
        alertsState.sources = (Array.isArray(d.sources) ? d.sources : [])
          .filter(function (s) { return s && s.agency !== 'smart'; });
        alertsState.ok = true;
        try { refreshAlertSurfaces(); } catch (e) { /* UI refresh must never mark the feed down */ }
      })
      .catch(function () {
        // Endpoint absent (proxy not yet deployed) or fetch failed:
        // silent degradation — badges, bands and overlays all clear.
        alertsState.ok = false;
        try { refreshAlertSurfaces(); } catch (e) { /* never throw from the poll */ }
      });
  }
  function startAlertsPoll() {
    pollAlerts();
    setInterval(function () { if (!document.hidden) pollAlerts(); }, 120000);
  }

  // --- first-view use-case launcher sheet (Concept 3) ----------------------
  // Justin's pick at the first-view decision gate, 2026-10-23 (the gate
  // recommended Concept 1; the pick stands as decided). A bottom sheet
  // over the live map: greeting + six use-case tiles, each carrying a
  // live fragment refreshed from the same state the header and the
  // alerts module already maintain (fvRefreshProofs is called from
  // setHeader and refreshAlertSurfaces — no second data path). Tiles
  // call the EXISTING entry functions only (setTripMode / setRideMode /
  // togglePanel / setNearMe / showStop / the alerts text path) — there
  // is no parallel navigation system. The sheet collapses to the
  // persistent "Explore" handle; open/collapsed is the rider's own
  // persisted preference in localStorage 'lt-fv-sheet' (alongside, never
  // replacing, the existing lt-* keys), defaulting to open only when
  // the key is absent. Opening any exclusion surface occludes the
  // launcher transiently (exclCover / exclRestore above) without
  // touching that preference. Location is offered ONLY here, inline:
  // the boot prompt is deleted, and Near me always offers the
  // no-permission map-center fallback beside the location request.
  var FV_SHEET_KEY = 'lt-fv-sheet';
  var fvSheetInit = false;
  var fvSheetOpen = false;     // the rider's persisted preference, rendered
  var fvSheetOccluded = false; // transient: an exclusion surface is up
  var fvAlertsChecked = false; // set by refreshAlertSurfaces on first run
  var fvCenterRoutes = null;   // route count from a map-center Near me use
  var fvDrag = null;           // header drag state { y0, dy, moved }

  function fvRenderSheet() {
    var sheet = $('fv-sheet'), handle = $('fv-explore');
    if (!sheet || !handle) return;
    var showSheet = fvSheetOpen && !fvSheetOccluded;
    sheet.hidden = !showSheet;
    handle.hidden = !(!fvSheetOpen && !fvSheetOccluded);
    sheet.style.transform = '';
    sheet.classList.remove('fv-dragging');
    var grab = $('fv-collapse');
    if (grab) grab.setAttribute('aria-expanded', String(fvSheetOpen));
    handle.setAttribute('aria-expanded', String(fvSheetOpen));
  }
  function fvSetOccluded(occluded) {
    occluded = !!occluded;
    if (fvSheetOccluded === occluded) return;
    fvSheetOccluded = occluded;
    fvRenderSheet();
  }
  function fvSetSheet(open, opts) {
    opts = opts || {};
    fvSheetOpen = !!open;
    if (opts.persist) {
      try { localStorage.setItem(FV_SHEET_KEY, fvSheetOpen ? 'open' : 'collapsed'); } catch (e) {}
    }
    fvRenderSheet();
    if (!fvSheetOpen && opts.focusHandle !== false) {
      var active = document.activeElement;
      var sheet = $('fv-sheet');
      if (active && sheet && sheet.contains(active)) $('fv-explore').focus();
    }
    if (fvSheetOpen && opts.focusFirst) {
      var first = document.querySelector('#fv-grid .fv-tile');
      if (first) first.focus();
    }
  }
  function fvRefreshProofs() {
    var live = $('fv-proof-live');
    if (!live) return;
    var totalText = $('bus-total') ? String($('bus-total').textContent || '').trim() : '';
    var total = /^\d+$/.test(totalText) ? parseInt(totalText, 10) : null;
    var ride = $('fv-proof-ride');
    if (total === null) {
      live.textContent = 'Connecting…';
      if (ride) ride.textContent = 'Follow a live bus';
    } else if (total === 0) {
      // Overnight / degenerate state: say so plainly, never a stale count.
      live.textContent = 'No vehicles live right now';
      if (ride) ride.textContent = 'No live buses to follow right now';
    } else {
      live.textContent = total + (total === 1 ? ' vehicle live now' : ' vehicles live now');
      if (ride) ride.textContent = 'Follow a live bus';
    }
    var routes = $('fv-proof-routes');
    if (routes && typeof routeOrder !== 'undefined' && routeOrder && routeOrder.length) {
      routes.textContent = routeOrder.length + ' routes on the map';
    }
    var near = $('fv-proof-near');
    if (near) {
      if (typeof filterState !== 'undefined' && filterState.nearMe) {
        var n = (typeof nearMeSet !== 'undefined' && nearMeSet) ? Object.keys(nearMeSet).length : 0;
        near.textContent = n ? n + (n === 1 ? ' route' : ' routes') + ' near you' : 'Near me is on';
      } else if (fvCenterRoutes !== null) {
        near.textContent = fvCenterRoutes + (fvCenterRoutes === 1 ? ' route' : ' routes') + ' around the map center';
      } else if (typeof userXZ !== 'undefined' && userXZ) {
        near.textContent = 'Location is on';
      } else {
        near.textContent = 'Stops around you';
      }
    }
    var alerts = $('fv-proof-alerts');
    if (alerts) {
      if (!fvAlertsChecked) alerts.textContent = 'Checking…';
      else if (!alertsState.ok) alerts.textContent = 'Alert feed unavailable';
      else {
        var count = activeAlerts().length;
        alerts.textContent = count === 0 ? 'No active alerts'
          : count + (count === 1 ? ' active alert' : ' active alerts');
      }
    }
  }
  function fvShowNearChoice() {
    $('fv-grid').hidden = true;
    $('fv-near').hidden = false;
    var b = $('fv-near-location');
    if (b) b.focus();
  }
  function fvShowTiles() {
    $('fv-near').hidden = true;
    $('fv-grid').hidden = false;
    var tile = document.querySelector('#fv-grid [data-fv-action="near"]');
    if (tile) tile.focus();
  }
  function fvNearLocation() {
    if (filterState.nearMe) {
      fvSetSheet(false, { persist: true });
      showToast('Routes near you are on.', false);
      return;
    }
    fvCenterRoutes = null;
    if (userXZ) {
      setNearMe(true);
      fvSetSheet(false, { persist: true });
      return;
    }
    // No fix yet: the existing locate flow enables near-me on success
    // (pendingNearMe is consumed by onLocated). Permission is requested
    // only here, in context, from this tap — never at boot.
    pendingNearMe = true;
    fvSetSheet(false, { persist: true });
    locateBtn.click();
  }
  function fvNearCenter() {
    // No-permission fallback: the governed stop nearest the map center,
    // through the existing nearest-stop computation and stop card.
    if (!controls || typeof nearestStopTo !== 'function') return;
    var cx = controls.target.x, cz = controls.target.z;
    if (stopData) {
      var seen = {}, count = 0, r2 = NEAR_ME_M * NEAR_ME_M;
      for (var i = 0; i < stopData.length; i++) {
        var s = stopData[i];
        var dx = s.x - cx, dz = s.z - cz;
        if (dx * dx + dz * dz > r2) continue;
        for (var j = 0; j < (s.r || []).length; j++) {
          if (!seen[s.r[j]]) { seen[s.r[j]] = true; count++; }
        }
      }
      fvCenterRoutes = count;
    }
    var st = nearestStopTo(cx, cz, NEAR_ME_M);
    if (!st) {
      showToast('No stops within 1,250 m of the map center.', true);
      return;
    }
    fvSetSheet(false, { persist: true, focusHandle: false });
    fvRefreshProofs();
    showStop(st);
  }
  function fvShowAlerts() {
    // The alerts surfaces are the existing ones: the alert text path
    // (alertWhatChanged, the same words the planner and stop cards use)
    // announced through the shared toast + screen-reader channel.
    if (!fvAlertsChecked || !alertsState.ok) {
      showToast('Service alerts are unavailable right now.', false);
      announceSr('Service alerts are unavailable right now.');
      return;
    }
    var act = activeAlerts();
    if (!act.length) {
      showToast('No active service alerts.', false);
      announceSr('No active service alerts.');
      return;
    }
    var msg = alertWhatChanged(act[0]);
    if (act.length > 1) msg += ' (+' + (act.length - 1) + ' more active ' + (act.length === 2 ? 'alert' : 'alerts') + ')';
    showToast(msg, true);
    announceSr(msg);
  }
  function fvTileAction(action) {
    tapBuzz();
    if (action === 'live') {
      fvSetSheet(false, { persist: true });
      try { container.focus({ preventScroll: true }); } catch (e) { try { container.focus(); } catch (e2) {} }
      return;
    }
    if (action === 'near') { fvShowNearChoice(); return; }
    fvSetSheet(false, { persist: true, focusHandle: false });
    if (action === 'plan') { if (!tripMode) setTripMode(true); }
    else if (action === 'ride') { if (!rideMode) setRideMode(true); }
    else if (action === 'routes') { setBrowse(false); togglePanel(true); }
    else if (action === 'alerts') { fvShowAlerts(); }
  }
  function fvInitFirstView() {
    if (fvSheetInit) return;
    var sheet = $('fv-sheet'), handle = $('fv-explore'), head = $('fv-head');
    if (!sheet || !handle || !head) return;
    fvSheetInit = true;
    var stored = null;
    try { stored = localStorage.getItem(FV_SHEET_KEY); } catch (e) {}
    // Absent key = first view = open. Only an explicit 'collapsed'
    // starts a returning rider at the handle.
    fvSheetOpen = stored !== 'collapsed';
    fvRenderSheet();
    fvRefreshProofs();
    handle.addEventListener('click', function () {
      fvShowTilesReset();
      fvSetSheet(true, { persist: true, focusFirst: true });
    });
    function fvShowTilesReset() {
      var near = $('fv-near'), grid = $('fv-grid');
      if (near) near.hidden = true;
      if (grid) grid.hidden = false;
    }
    $('fv-collapse').addEventListener('click', function () {
      fvSetSheet(false, { persist: true });
    });
    $('fv-just-map').addEventListener('click', function () {
      fvSetSheet(false, { persist: true });
    });
    Array.prototype.forEach.call(sheet.querySelectorAll('[data-fv-action]'), function (tile) {
      tile.addEventListener('click', function () { fvTileAction(tile.getAttribute('data-fv-action')); });
    });
    $('fv-near-location').addEventListener('click', fvNearLocation);
    $('fv-near-center').addEventListener('click', fvNearCenter);
    $('fv-near-back').addEventListener('click', fvShowTiles);
    sheet.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        fvSetSheet(false, { persist: true });
      }
    });
    // Header drag: a downward drag past the threshold collapses the
    // sheet; a tap on the header (not on its buttons) collapses too.
    // The header owns this gesture (touch-action: none in CSS); the
    // sheet body keeps pan-y for its own scrolling, and nothing here
    // touches gestures that start on the map.
    head.addEventListener('pointerdown', function (e) {
      fvDrag = { y0: e.clientY, dy: 0, moved: false };
      try { head.setPointerCapture(e.pointerId); } catch (err) {}
    });
    head.addEventListener('pointermove', function (e) {
      if (!fvDrag) return;
      fvDrag.dy = Math.max(0, e.clientY - fvDrag.y0);
      if (fvDrag.dy > 8) {
        fvDrag.moved = true;
        sheet.classList.add('fv-dragging');
        sheet.style.transform = 'translateX(-50%) translateY(' + fvDrag.dy + 'px)';
      }
    });
    function fvDragEnd() {
      if (!fvDrag) return;
      var moved = fvDrag.moved, dy = fvDrag.dy;
      fvDrag = null;
      sheet.classList.remove('fv-dragging');
      sheet.style.transform = '';
      if (moved && dy > 64) fvSetSheet(false, { persist: true });
    }
    head.addEventListener('pointerup', fvDragEnd);
    head.addEventListener('pointercancel', fvDragEnd);
    head.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('#fv-collapse, #fv-just-map')) return;
      fvSetSheet(false, { persist: true });
    });
  }

  // --- beta tiles (filed 2026-10-09; approved 2026-10-14) ------------------
  // Three live-help surfaces, each with its own named opt-in toggle in
  // the filter panel (Justin's direction 2026-10-15: the umbrella "Beta
  // tiles" gate was ambiguous, so the features are named and switched
  // individually). Each defaults OFF until the rider opts in, and each
  // choice persists in its own localStorage key ('lt-stop-tiles',
  // 'lt-upcoming-stops', 'lt-suggest-transfer'). Migration: the retired
  // umbrella key 'lt-beta-tiles' is read once on first load \u2014 a feature
  // with no stored key of its own starts from the umbrella value, which
  // is then persisted under the feature's own key, and the umbrella key
  // is removed. (1) Stop tiles: the stop card's live rows add the bus
  // number (renderStopLive, above). (2) Upcoming stops: the bus card
  // lists the selected bus's next stops with time estimates from its
  // matched arc position and the empirical segment speeds. (3) Suggest
  // transfer: a tile in the trip planner ranks live buses approaching
  // stops near the trip origin by walk + wait, recomputed from live
  // positions on every poll \u2014 dynamic rerouting from real-time
  // intersecting-route ETAs, not scheduled times.
  var stopTilesOn = false, upcomingStopsOn = false, suggestTransferOn = false;
  try {
    var _tileUmbrella = localStorage.getItem('lt-beta-tiles');
    var _tileInit = function (key) {
      var v = localStorage.getItem(key);
      if (v === null) {
        v = _tileUmbrella === '1' ? '1' : '0';
        try { localStorage.setItem(key, v); } catch (e) {}
      }
      return v === '1';
    };
    stopTilesOn = _tileInit('lt-stop-tiles');
    upcomingStopsOn = _tileInit('lt-upcoming-stops');
    suggestTransferOn = _tileInit('lt-suggest-transfer');
    if (_tileUmbrella !== null) { try { localStorage.removeItem('lt-beta-tiles'); } catch (e) {} }
  } catch (e) {}
  var BETA_WALK_MPS = 1.4;      // the timetable's walk speed (build-timetable.py)
  var BETA_RADIUS_M = 1250;     // NEAR_ME_M \u2014 the "routes near me" radius
  var BETA_FALLBACK_MPS = 8.9;  // ~20 mph when no empirical speed is known

  // Seconds to ride along pathIdx from arc s0 to s1 (s1 > s0), summing
  // per-segment times at empirical speeds; the stretch past the last
  // mapped segment rides at the fallback speed. null when there is no
  // segment coverage and no fallback speed to ride at.
  function betaRideSecs(routeId, pathIdx, s0, s1, fallbackMps) {
    if (s1 <= s0) return 0;
    var segs = routeSegments(routeId), covered = 0, secs = 0;
    for (var i = 0; i < segs.length; i++) {
      var g = segs[i];
      if (g.pathIdx !== pathIdx) continue;
      var a = Math.max(s0, g.s0), b = Math.min(s1, g.s1);
      if (b <= a) continue;
      var v = empiricalSpeed(routeId, g) || fallbackMps || BETA_FALLBACK_MPS;
      secs += (b - a) / v; covered += (b - a);
    }
    var fb = fallbackMps || BETA_FALLBACK_MPS;
    if (!covered && !fb) return null;
    if (covered < (s1 - s0) - 1) secs += ((s1 - s0) - covered) / fb;
    return secs;
  }

  function betaMins(secs) {
    if (secs == null) return '\u2014';
    var m = Math.round(secs / 60);
    return m < 1 ? '<1 min' : m + ' min';
  }

  function betaNoteRow(list, text) {
    var p = document.createElement('p');
    p.className = 'beta-note';
    p.textContent = text;
    list.appendChild(p);
  }

  // (2) Upcoming stops for the selected bus: stops ahead of the bus's
  // filtered arc position on its current path, in order, with cumulative
  // time estimates. Honest states: unmatched (off the mapped shape) and
  // terminus (no stops ahead) say so in words instead of listing nothing.
  function betaUpcoming(v) {
    // Route Reverse: a layover-bound bus is between trips — say so,
    // with its next departure, instead of listing the return trip's
    // stops as if they were this run's.
    var bb = tripBindingFor(v.vehicle_id);
    if (bb && bb.st.layover) {
      return { state: 'layover', clock: tripClock((bb.trip.depL2 || bb.trip.dep)[0]) };
    }
    var tr = busTrackers[v.vehicle_id];
    if (!tr || !tr.arc || tr.pathIdx < 0) return { state: 'unmatched' };
    var smap = stopArcMap(v.route_id, tr.pathIdx);
    var byId = {};
    stopsByRoute(v.route_id).forEach(function (st) { byId[st.id] = st; });
    var ups = [];
    for (var sid in smap) {
      if (smap[sid] > tr.s + 25 && byId[sid]) ups.push({ stop: byId[sid], s: smap[sid] });
    }
    ups.sort(function (a, b) { return a.s - b.s; });
    if (!ups.length) return { state: 'terminus' };
    var fb = tr.speedMps > 0.5 ? tr.speedMps : null;
    var out = [], cum = 0, prev = tr.s, ok = true;
    ups.slice(0, 6).forEach(function (u) {
      var leg = betaRideSecs(v.route_id, tr.pathIdx, prev, u.s, fb);
      if (leg == null) ok = false; else cum += leg;
      out.push({ name: u.stop.n || 'Stop', secs: ok ? cum : null });
      prev = u.s;
    });
    return { state: 'ok', stops: out };
  }

  function renderBusUpcoming() {
    var host = $('bus-upcoming'), list = $('bus-upcoming-list');
    if (!host || !list) return;
    var v = null;
    if (upcomingStopsOn && selectedVehicleId && lastVehicles) {
      for (var i = 0; i < lastVehicles.length; i++) {
        if (lastVehicles[i].vehicle_id === selectedVehicleId) { v = lastVehicles[i]; break; }
      }
    }
    if (!v) { host.hidden = true; return; }
    var r = betaUpcoming(v);
    host.hidden = false;
    list.innerHTML = '';
    if (r.state !== 'ok') {
      betaNoteRow(list, r.state === 'terminus'
        ? 'This bus is at the end of its trip \u2014 no more stops on this run.'
        : (r.state === 'layover'
          ? 'This bus is at the terminal between trips \u2014 its next trip leaves at ' + r.clock + '.'
          : 'This bus is off its mapped route right now, so its upcoming stops cannot be estimated.'));
      return;
    }
    r.stops.forEach(function (u, i) {
      var row = document.createElement('div');
      row.className = 'beta-row';
      var b = document.createElement('b');
      b.textContent = (i === 0 ? 'Next: ' : '') + u.name;
      row.appendChild(b);
      var t = document.createElement('span');
      t.textContent = '~' + betaMins(u.secs);
      row.appendChild(t);
      list.appendChild(row);
    });
  }

  // (3) Suggest transfer: from the trip origin (the From point, else the
  // rider's located position), take each route's nearest stop, find the
  // soonest live bus still approaching that stop, and rank routes by
  // walk time + wait. A bus that has already passed the stop is excluded
  // \u2014 the suggestion must be catchable, which is the filed point of
  // the tile: efficient transfers despite schedule deviations.
  function betaOrigin() {
    if (tripFrom) {
      if (tripFrom.kind === 'stop') {
        var st = stopData && stopData[tripFrom.idx];
        if (st) return { x: st.x, z: st.z };
      }
      if (tripFrom.kind === 'loc') return { x: tripFrom.x, z: tripFrom.z };
    }
    if (typeof userXZ !== 'undefined' && userXZ) return { x: userXZ[0], z: userXZ[1] };
    return null;
  }

  function betaSuggest() {
    var o = betaOrigin();
    if (!o) return { state: 'no-origin' };
    if (!stopData || !lastVehicles) return { state: 'no-data' };
    var near = {}; // rid -> [{stop, dist}...] nearest first: the tile
    // boards at the nearest stop a live bus is still approaching (the
    // nearest stop overall may already have been served by that bus).
    for (var i = 0; i < stopData.length; i++) {
      var st = stopData[i];
      var d = Math.hypot(st.x - o.x, st.z - o.z);
      if (d > BETA_RADIUS_M) continue;
      (st.r || []).forEach(function (rid) {
        (near[rid] = near[rid] || []).push({ stop: st, dist: d });
      });
    }
    for (var r0 in near) near[r0].sort(function (a, b) { return a.dist - b.dist; });
    // Optional signal: routes that also stop within the radius of the
    // trip destination \u2014 proximity only, stated as proximity.
    var destNear = {};
    if (tripTo && tripTo.kind === 'stop' && stopData[tripTo.idx]) {
      var ds = stopData[tripTo.idx];
      for (var j = 0; j < stopData.length; j++) {
        var s2 = stopData[j];
        if (Math.hypot(s2.x - ds.x, s2.z - ds.z) > BETA_RADIUS_M) continue;
        (s2.r || []).forEach(function (rid) { destNear[rid] = true; });
      }
    }
    var out = [];
    for (var rid in near) {
      var best = null;
      for (var ci = 0; ci < near[rid].length && !best; ci++) {
        var cand = near[rid][ci];
        for (var k = 0; k < lastVehicles.length; k++) {
          var v = lastVehicles[k];
          if (v.route_id !== rid) continue;
          var tr = busTrackers[v.vehicle_id];
          if (!tr || !tr.arc || tr.pathIdx < 0) continue;
          var ss = stopArcMap(rid, tr.pathIdx)[cand.stop.id];
          if (ss == null || ss <= tr.s + 10) continue; // already passed this stop
          var eta = betaRideSecs(rid, tr.pathIdx, tr.s, ss, tr.speedMps > 0.5 ? tr.speedMps : null);
          if (eta == null) continue;
          var total = cand.dist / BETA_WALK_MPS + eta;
          if (!best || total < best.total) best = { v: v, eta: eta, total: total, stop: cand.stop, walk: cand.dist / BETA_WALK_MPS };
        }
      }
      if (best) out.push({ rid: rid, stop: best.stop, walk: best.walk, eta: best.eta, bus: best.v.vehicle_id, nearDest: !!destNear[rid] });
    }
    out.sort(function (a, b) { return a.total - b.total; });
    return { state: 'ok', options: out.slice(0, 4) };
  }

  function renderSuggest() {
    var host = $('suggest-tile'), list = $('suggest-list'), note = $('suggest-note');
    if (!host || !list) return;
    if (!suggestTransferOn || !tripMode) { host.hidden = true; return; }
    var r = betaSuggest();
    host.hidden = false;
    list.innerHTML = '';
    if (note) note.textContent = 'Live estimates from bus positions right now. The planner above uses scheduled times.';
    if (r.state === 'no-origin') { betaNoteRow(list, 'Set a From point \u2014 or tap Locate \u2014 so this tile can work from where you are.'); return; }
    if (r.state !== 'ok' || !r.options.length) { betaNoteRow(list, 'No live buses are approaching stops near the start point right now.'); return; }
    r.options.forEach(function (op) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'beta-row beta-suggest-row';
      row.setAttribute('aria-label', 'Begin trip: board ' + routeLabel(op.rid) + ' bus ' + op.bus + ' at ' + (op.stop.n || 'stop'));
      var b = document.createElement('b');
      b.textContent = routeLabel(op.rid) + ' · Bus ' + op.bus + ' at ' + (op.stop.n || 'stop');
      row.appendChild(b);
      var t = document.createElement('span');
      t.textContent = 'bus ~' + betaMins(op.eta) + ' \u00b7 ' + betaMins(op.walk) + ' walk';
      row.appendChild(t);
      // Begin trip: the suggestion names a specific catchable bus at a
      // specific stop, so tapping it starts the trip from that stop —
      // the same origin path as tapping the stop on the map (setTripFrom
      // + replan), keeping the rider inside the planner. The bus card is
      // deliberately not opened here: showBus() covers the trip card
      // (exclCover), which would hide the plan the rider just started.
      row.addEventListener('click', function () {
        tapBuzz();
        var idx = stopData ? stopData.indexOf(op.stop) : -1;
        if (idx < 0) return;
        setTripFrom({ kind: 'stop', idx: idx });
        renderTripFields();
        updateTripMarkers();
        maybeReplan();
        announceSr('Trip origin set to ' + (op.stop.n || 'stop') + '. Board ' + routeLabel(op.rid) + ' bus ' + op.bus + ' there.');
      });
      list.appendChild(row);
      if (op.nearDest) {
        var s = document.createElement('div');
        s.className = 'beta-sub';
        s.textContent = 'Route ' + routeLabel(op.rid) + ' also stops near your destination.';
        list.appendChild(s);
      }
    });
  }

  function renderBetaTiles() {
    renderBusUpcoming();
    renderSuggest();
  }

  // Toggle wiring \u2014 one aria-pressed toggle per feature in the
  // filter panel, each persisting its own key.
  (function wireTileToggles() {
    var defs = [
      { id: 'stop-tiles-toggle', key: 'lt-stop-tiles',
        get: function () { return stopTilesOn; }, set: function (v) { stopTilesOn = v; } },
      { id: 'upcoming-stops-toggle', key: 'lt-upcoming-stops',
        get: function () { return upcomingStopsOn; }, set: function (v) { upcomingStopsOn = v; } },
      { id: 'suggest-transfer-toggle', key: 'lt-suggest-transfer',
        get: function () { return suggestTransferOn; }, set: function (v) { suggestTransferOn = v; } }
    ];
    defs.forEach(function (d) {
      var btn = $(d.id);
      if (!btn) return;
      var sync = function () { btn.setAttribute('aria-pressed', String(d.get())); };
      btn.addEventListener('click', function () {
        d.set(!d.get());
        try { localStorage.setItem(d.key, d.get() ? '1' : '0'); } catch (e) {}
        sync();
        if (selectedStop) renderStopLive();
        renderBetaTiles();
      });
      sync();
    });
  })();

  // --- MoGo bikeshare station layer ---------------------------------------
  // Live station availability from MoGo's public GBFS v3.0 feed
  // (detroit.publicbikesystem.net), rendered as its own THREE group with
  // its own filter-panel toggle — the People Mover layer's pattern, except
  // this feed is live: station_status polls every 60 s on the bus cadence.
  //
  // Transport: DIRECT client-side fetch, no proxy. Verified 2026-10-14:
  // GET station_information / station_status with an Origin header for
  // this site returns 200 with `Access-Control-Allow-Origin: *`; the feed
  // is no-auth and the request is a simple GET (no preflight), so the
  // browser can read it itself. Client-side also holds the privacy bar:
  // nothing about the rider leaves the device. (A curl HEAD probe from a
  // shell returned 403 — a probe artifact; the GET evidence governs.)
  //
  // Data rules (recon 2026-10-05, enforced by the station-layer suite):
  // canonical availability is the v3.0 vehicle count + per-type rows; the
  // deprecated v2.x availability field is zero everywhere upstream and is
  // never read. Stations whose last_reported is over 5 minutes old (or
  // which are not installed) are QUARANTINED: grey, flattened markers,
  // excluded from planner bike legs, and their cards say so in words.
  // Zero-bike stations stay visible, dimmed and shortened — a rider's
  // corner station reading empty is information, not noise. Stations that
  // can neither rent nor return are not rendered.
  //
  // Nothing is carried by color alone: marker HEIGHT encodes state
  // (full = bikes available, half = empty, low = stale), an e-assist ring
  // circles stations with an EFIT available, a count badge ("🚲 N", or
  // the word "stale") appears at close zoom, the stop card states bikes,
  // docks and status in words, and #mogo-sr names every shown station's
  // state in text for screen readers. Feed failure is an honest state,
  // not a silent one: markers clear, the toggle reads "unavailable", and
  // the SR note says the feed could not be loaded. No toast on the map.
  var MOGO_GBFS_BASE = 'https://detroit.publicbikesystem.net/customer/gbfs/v3.0';
  var MOGO_POLL_MS = 60000;
  var MOGO_INFO_RECHECK_MS = 60 * 60 * 1000;
  var MOGO_FETCH_TIMEOUT_MS = 20000;
  var MOGO_STALE_MS = 5 * 60 * 1000;
  var MOGO_LIVE_TYPES = ['ICONIC', 'EFIT'];
  var MOGO_DOT_COLORS = { green: '#A4A4A4', amber: '#ADADAD', red: '#6A6A6A', grey: '#8F8F8F' };
  var MOGO_BASE_H = 75; // same base height as a single-route stop pylon
  var mogoState = { ok: false, layer: null, fetchedAtMs: 0 };
  var mogoVisible = false; // default OFF per Justin 2026-10-14 (design of record was ON, design 2026-10-05)
  var mogoInfoCache = null, mogoInfoFetchedAtMs = 0;
  var mogoGroup = null, mogoIM = null, mogoRingIM = null;
  var mogoBadges = [];     // one THREE.Sprite per rendered station
  var mogoPickList = [];   // {id, n, x, z, r:[], mogo:true, station}
  var mogoBadgeTexCache = {};
  var _mogoM4 = null, _mogoP3 = null, _mogoQ = null, _mogoS3 = null, _mogoCol = null, _mogoV3 = null;

  // --- data layer: ES5 port of hidden_files/mogo/station-layer/lib/mogo.js
  // (the suite-tested module; the client harness re-verifies equivalence
  // against it on the pinned fixtures — do not let the two drift).
  function mogoEnName(localized) {
    if (typeof localized === 'string') return localized;
    if (!Array.isArray(localized)) return '';
    var en = null, i;
    for (i = 0; i < localized.length; i++) {
      if (localized[i] && localized[i].language === 'en') { en = localized[i]; break; }
    }
    var pick = en || localized[0];
    return (pick && pick.text) || '';
  }
  function mogoTypeCounts(vehicleTypesAvailable) {
    var counts = {};
    (vehicleTypesAvailable || []).forEach(function (row) {
      if (row && row.vehicle_type_id) counts[row.vehicle_type_id] = Number(row.count) || 0;
    });
    return counts;
  }
  function mogoBuildStation(info, status, nowMs) {
    var st = status || {};
    var reported = st.last_reported ? new Date(st.last_reported).getTime() : NaN;
    var stale = !isFinite(reported) || (nowMs - reported) > MOGO_STALE_MS;
    var installed = st.is_installed === true;
    var renting = st.is_renting === true;
    var returning = st.is_returning === true;
    var vehiclesTotal = Number(st.num_vehicles_available) || 0;
    var docksTotal = Number(st.num_docks_available) || 0;
    var counts = mogoTypeCounts(st.vehicle_types_available);
    var iconic = counts.ICONIC || 0;
    var efit = counts.EFIT || 0;
    var retiredNonzero = {};
    Object.keys(counts).forEach(function (t) {
      if (MOGO_LIVE_TYPES.indexOf(t) < 0 && counts[t] > 0) retiredNonzero[t] = counts[t];
    });
    return {
      id: String(info.station_id),
      name: mogoEnName(info.name),
      lat: Number(info.lat),
      lon: Number(info.lon),
      address: info.address || '',
      capacity: Number(info.capacity) || 0,
      installed: installed, renting: renting, returning: returning, stale: stale,
      vehiclesTotal: vehiclesTotal, docksTotal: docksTotal,
      iconic: iconic, efit: efit, otherNonzero: retiredNonzero,
      vehicleDocksAvailable: st.vehicle_docks_available || [],
      eligiblePickup: installed && renting && vehiclesTotal >= 1 && !stale,
      eligibleDropoff: installed && returning && docksTotal >= 1 && !stale,
      statusClass: (!installed || stale) ? 'quarantined'
        : vehiclesTotal >= 5 ? 'plenty' : vehiclesTotal >= 1 ? 'low' : 'empty',
      statusHue: (!installed || stale) ? 'grey'
        : vehiclesTotal >= 5 ? 'green' : vehiclesTotal >= 1 ? 'amber' : 'red',
      efitRing: efit >= 1,
      visible: installed && (renting || returning),
      lastReported: st.last_reported || null,
      updatedAgeMs: isFinite(reported) ? Math.max(0, nowMs - reported) : null
    };
  }
  function mogoBuildLayer(infoPayload, statusPayload, nowMs) {
    var infos = (infoPayload && infoPayload.data && infoPayload.data.stations) || [];
    var statusById = {};
    ((statusPayload && statusPayload.data && statusPayload.data.stations) || []).forEach(function (s) {
      statusById[String(s.station_id)] = s;
    });
    var stations = infos.map(function (info) {
      return mogoBuildStation(info, statusById[String(info.station_id)], nowMs);
    });
    var byId = {};
    stations.forEach(function (s) { byId[s.id] = s; });
    function sum(f) { return stations.reduce(function (a, s) { return a + f(s); }, 0); }
    function cnt(f) { return stations.filter(f).length; }
    var summary = {
      stationCount: stations.length,
      visible: cnt(function (s) { return s.visible; }),
      renting: cnt(function (s) { return s.renting && s.installed; }),
      withVehicles: cnt(function (s) { return s.vehiclesTotal >= 1; }),
      totalVehicles: sum(function (s) { return s.vehiclesTotal; }),
      totalIconic: sum(function (s) { return s.iconic; }),
      totalEfit: sum(function (s) { return s.efit; }),
      totalDocks: sum(function (s) { return s.docksTotal; }),
      quarantined: cnt(function (s) { return s.stale || !s.installed; }),
      pickupEligible: cnt(function (s) { return s.eligiblePickup; }),
      dropoffEligible: cnt(function (s) { return s.eligibleDropoff; })
    };
    return { stations: stations, byId: byId, summary: summary };
  }
  function mogoPanelTally(summary) {
    var v = summary ? summary.totalVehicles : 0;
    var s = summary ? summary.withVehicles : 0;
    return v + ' bike' + (v === 1 ? '' : 's') + ' · ' + s + ' station' + (s === 1 ? '' : 's') + ' live';
  }
  // Plain-language status sentence — the words that accompany every
  // marker treatment, in the card, the SR list, and the toggle note.
  function mogoStatusSentence(st) {
    if (!st.installed) return 'This station is not installed.';
    if (st.stale) return 'This station\u2019s feed reports are stale \u2014 its counts may be out of date, and it is excluded from trip-planner bike legs.';
    if (st.renting && st.returning) return 'Renting and accepting returns.';
    if (st.renting) return 'Renting only \u2014 returns are not accepted here.';
    if (st.returning) return 'Returns only \u2014 no rentals here.';
    return 'Not renting or accepting returns.';
  }
  function mogoSrText(st) {
    var s = st.name + ': ';
    if (!st.installed) return s + 'not installed.';
    if (st.stale) return s + 'station reports are stale; availability may be out of date.';
    if (st.vehiclesTotal === 0) s += 'no bikes available';
    else {
      s += st.vehiclesTotal + (st.vehiclesTotal === 1 ? ' bike' : ' bikes') + ' available';
      var parts = [];
      if (st.iconic > 0) parts.push(st.iconic + ' standard');
      if (st.efit > 0) parts.push(st.efit + ' e-assist');
      if (parts.length) s += ' (' + parts.join(', ') + ')';
    }
    s += ', ' + st.docksTotal + (st.docksTotal === 1 ? ' dock' : ' docks') + ' available.';
    return s;
  }
  function mogoBadgeText(st) {
    if (!st.installed || st.stale) return 'stale';
    return '\uD83D\uDEB2 ' + st.vehiclesTotal; // "🚲 N" — count text, not color alone
  }
  // Stop-card model: mirrors lib buildStationCard; zero rows for vehicle
  // types are omitted (retired fleets are noise), the total is always
  // stated in the card's Bikes line by the caller.
  function mogoCardModel(station, nowMs) {
    if (!station) return null;
    var lines = [];
    if (station.iconic > 0) lines.push({ label: 'Standard bikes', value: String(station.iconic) });
    if (station.efit > 0) lines.push({ label: 'E-assist bikes', value: String(station.efit) });
    Object.keys(station.otherNonzero || {}).forEach(function (t) {
      if (station.otherNonzero[t] > 0) lines.push({ label: t, value: String(station.otherNonzero[t]) });
    });
    lines.push({ label: 'Docks available', value: String(station.docksTotal) });
    var ageMs = station.updatedAgeMs;
    var updated = (station.stale || ageMs === null || ageMs === undefined) ? 'stale'
      : ageMs < 60000 ? 'updated just now'
      : 'updated ' + Math.round(ageMs / 60000) + ' min ago';
    return {
      title: station.name,
      address: station.address || '',
      bikesLine: station.stale ? 'Counts may be out of date'
        : station.vehiclesTotal === 0 ? 'No bikes available'
        : station.vehiclesTotal + (station.vehiclesTotal === 1 ? ' bike available' : ' bikes available'),
      lines: lines,
      status: mogoStatusSentence(station),
      updated: updated,
      pickupEligible: station.eligiblePickup,
      dropoffEligible: station.eligibleDropoff
    };
  }

  // --- rendering ------------------------------------------------------------
  function mogoEnsureMeshes() {
    if (mogoGroup) return;
    _mogoM4 = new THREE.Matrix4(); _mogoP3 = new THREE.Vector3();
    _mogoQ = new THREE.Quaternion(); _mogoS3 = new THREE.Vector3();
    _mogoCol = new THREE.Color(); _mogoV3 = new THREE.Vector3();
    mogoGroup = new THREE.Group();
    mogoGroup.name = 'mogo-bikeshare';
    mogoIM = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(16, 20, 1, 10),
      new THREE.MeshLambertMaterial({ color: 0xffffff }), 96);
    mogoIM.frustumCulled = false;
    mogoIM.count = 0;
    mogoGroup.add(mogoIM);
    var ringGeo = new THREE.RingGeometry(30, 44, 28);
    if (ringGeo.rotateX) ringGeo.rotateX(-Math.PI / 2);
    mogoRingIM = new THREE.InstancedMesh(ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xF2F2F2, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }), 96);
    mogoRingIM.frustumCulled = false;
    mogoRingIM.count = 0;
    mogoGroup.add(mogoRingIM);
    mogoGroup.visible = false;
    scene.add(mogoGroup);
  }
  function mogoHeightFor(st) {
    // Height encodes state alongside color: full = bikes available,
    // half = empty, low = quarantined (stale / not installed).
    if (st.statusClass === 'quarantined') return 22;
    if (st.vehiclesTotal === 0) return 40;
    return MOGO_BASE_H;
  }
  function mogoBadgeTexture(text) {
    var hit = mogoBadgeTexCache[text];
    if (hit) return hit;
    var c = document.createElement('canvas');
    var x = c.getContext('2d');
    x.font = '600 30px system-ui, -apple-system, sans-serif';
    var w = Math.ceil(x.measureText(text).width) + 40;
    c.width = w; c.height = 54;
    var g = x;
    g.fillStyle = 'rgba(10,14,18,0.85)';
    g.beginPath();
    if (g.roundRect) g.roundRect(0, 0, c.width, c.height, 13); else g.rect(0, 0, c.width, c.height);
    g.fill();
    g.font = '600 30px system-ui, -apple-system, sans-serif';
    g.fillStyle = '#F2F2F2'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, c.width / 2, c.height / 2 + 1);
    var t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    var o = { tex: t, aspect: c.width / c.height };
    mogoBadgeTexCache[text] = o;
    return o;
  }
  function mogoWriteMarkers() {
    mogoEnsureMeshes();
    var layer = mogoState.layer;
    var list = layer ? layer.stations.filter(function (s) { return s.visible; }) : [];
    mogoPickList = [];
    var ringIdx = 0;
    for (var i = 0; i < list.length; i++) {
      var st = list[i];
      var xy = project(st.lat, st.lon);
      var h = mogoHeightFor(st) * stopYS;
      _mogoP3.set(xy[0], STOP_BASE_Y + h / 2, xy[1]);
      _mogoQ.identity();
      _mogoS3.set(1, h, 1);
      _mogoM4.compose(_mogoP3, _mogoQ, _mogoS3);
      mogoIM.setMatrixAt(i, _mogoM4);
      _mogoCol.set(MOGO_DOT_COLORS[st.statusHue] || MOGO_DOT_COLORS.grey);
      if (st.statusClass === 'quarantined') _mogoCol.multiplyScalar(0.6);
      else if (st.vehiclesTotal === 0) _mogoCol.multiplyScalar(0.5);
      mogoIM.setColorAt(i, _mogoCol);
      if (st.efitRing) {
        _mogoP3.set(xy[0], STOP_BASE_Y + 4, xy[1]);
        _mogoS3.set(1, 1, 1);
        _mogoM4.compose(_mogoP3, _mogoQ, _mogoS3);
        mogoRingIM.setMatrixAt(ringIdx++, _mogoM4);
      }
      var rec = { id: st.id, n: st.name, x: xy[0], z: xy[1], r: [], mogo: true, station: st };
      mogoPickList.push(rec);
      var badge = mogoBadges[i];
      if (!badge) {
        badge = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }));
        badge.renderOrder = 35;
        badge.visible = false;
        mogoGroup.add(badge);
        mogoBadges[i] = badge;
      }
      var bt = mogoBadgeText(st);
      if (badge.userData.text !== bt) {
        var o = mogoBadgeTexture(bt);
        badge.material.map = o.tex;
        badge.material.needsUpdate = true;
        badge.userData.text = bt;
        badge.userData.aspect = o.aspect;
      }
      badge.scale.set(46 * (badge.userData.aspect || 1), 46, 1);
      badge.position.set(xy[0], STOP_BASE_Y + h + 48, xy[1]);
    }
    mogoIM.count = list.length;
    mogoIM.instanceMatrix.needsUpdate = true;
    if (mogoIM.instanceColor) mogoIM.instanceColor.needsUpdate = true;
    mogoRingIM.count = ringIdx;
    mogoRingIM.instanceMatrix.needsUpdate = true;
    for (var j = list.length; j < mogoBadges.length; j++) {
      if (mogoBadges[j]) mogoBadges[j].visible = false;
    }
    mogoGroup.visible = !!(mogoVisible && mogoState.ok && list.length);
  }
  // Zoom-coupled rescale, called from easeStopScale: station markers are
  // the stop family, so they ride the same eased scale.
  function mogoRescale() {
    if (!mogoGroup || !mogoState.layer) return;
    mogoWriteMarkers();
  }
  // Per-frame hook from the animate loop: count badges follow the
  // street-zoom declutter rule — visible at close zoom only, never all
  // 81 citywide at once.
  function mogoFrameTick(camDist) {
    if (!mogoGroup) return;
    var show = mogoGroup.visible && camDist < 9000;
    for (var i = 0; i < mogoPickList.length; i++) {
      var b = mogoBadges[i];
      if (b && b.visible !== show) b.visible = show;
    }
  }
  // Screen-space nearest station (mirrors pickPMStation: proximity, not
  // raycast — the markers are small and raycasting them would be fiddly).
  function pickMogoStation(cx, cy, isTouch) {
    if (!mogoGroup || !mogoGroup.visible || !mogoPickList.length) return null;
    var r = renderer.domElement.getBoundingClientRect();
    var sx = cx - r.left, sy = cy - r.top;
    var best = null, bestD = isTouch ? 48 : 26;
    for (var i = 0; i < mogoPickList.length; i++) {
      var s = mogoPickList[i];
      _mogoV3.set(s.x, STOP_BASE_Y + 40, s.z).project(camera);
      if (_mogoV3.z > 1 || _mogoV3.z < -1) continue;
      var px = (_mogoV3.x * 0.5 + 0.5) * r.width, py = (-_mogoV3.y * 0.5 + 0.5) * r.height;
      var d = Math.hypot(px - sx, py - sy);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  // --- stop-card section ------------------------------------------------------
  // The stop card is the shared detail surface (People Mover stations use
  // it too). For a MoGo record, renderStopMogo fills the bikeshare section
  // and relabels the two generic rows; for any other stop it hides the
  // section and restores the labels.
  function renderStopMogo(st) {
    var sec = $('stop-mogo');
    if (!sec) return;
    var idDt = $('stop-id-dt'), srvDt = $('stop-nroutes-dt');
    if (!st || !st.mogo || !st.station) {
      sec.hidden = true;
      if (idDt) idDt.textContent = 'Stop ID';
      if (srvDt) srvDt.textContent = 'Serving';
      return;
    }
    var m = mogoCardModel(st.station, Date.now());
    if (idDt) idDt.textContent = 'Station ID';
    if (srvDt) srvDt.textContent = 'Bikes';
    $('stop-id').textContent = st.station.id;
    $('stop-nroutes').textContent = m.bikesLine;
    var dl = $('stop-mogo-dl');
    dl.innerHTML = '';
    m.lines.forEach(function (ln) {
      var dt = document.createElement('dt'); dt.textContent = ln.label;
      var dd = document.createElement('dd'); dd.textContent = ln.value;
      dl.appendChild(dt); dl.appendChild(dd);
    });
    var note = $('stop-mogo-note');
    var bits = [];
    // Address bit: this feed's address field duplicates the station name
    // for nearly every station (74 of 81 in the pinned 2026-10-14
    // snapshot; most of the rest differ only by the feed's leading '*'
    // marker), so printing it verbatim put a garbled name-duplicate —
    // asterisk included — ahead of the status sentence, directly under
    // the Docks row. Show the address only when it says something the
    // card title does not.
    var addrBit = (m.address || '').replace(/^\*\s*/, '');
    var nameBit = (m.title || '').replace(/^\*\s*/, '');
    if (addrBit && addrBit !== nameBit) bits.push(addrBit);
    bits.push(m.status);
    bits.push('Availability ' + m.updated + '.');
    note.textContent = bits.join(' ');
    sec.hidden = false;
  }

  // --- screen-reader surface --------------------------------------------------
  // #mogo-sr names every shown station's state in words (signature-gated,
  // like #alerts-sr); #mogo-live announces only availability transitions,
  // never the 60 s re-poll.
  var mogoSrSig = '', mogoLiveOk = null;
  function renderMogoSr() {
    var list = $('mogo-sr-list');
    if (!list) return;
    var layer = mogoState.layer;
    var shown = (mogoState.ok && layer) ? layer.stations.filter(function (s) { return s.visible; }) : [];
    var sig = (mogoState.ok ? 'ok' : 'down') + '|' + shown.map(function (s) {
      return s.id + ':' + s.vehiclesTotal + ':' + s.docksTotal + ':' + s.statusClass;
    }).join(',');
    if (sig !== mogoSrSig) {
      mogoSrSig = sig;
      list.innerHTML = '';
      shown.forEach(function (st) {
        var li = document.createElement('li');
        li.textContent = mogoSrText(st);
        list.appendChild(li);
      });
      var src = $('mogo-sr-note');
      if (src) {
        src.textContent = !mogoState.ok
          ? 'MoGo bikeshare availability is unavailable \u2014 the GBFS feed could not be loaded.'
          : 'MoGo GBFS feed: ' + layer.summary.stationCount + ' stations, ' + shown.length + ' shown, ' +
            layer.summary.quarantined + ' with stale reports.';
      }
    }
    if (mogoLiveOk !== mogoState.ok) {
      var live = $('mogo-live');
      if (live && mogoLiveOk !== null) {
        live.textContent = mogoState.ok
          ? 'MoGo bikeshare availability loaded: ' + mogoPanelTally(mogoState.layer.summary) + '.'
          : 'MoGo bikeshare availability is unavailable right now.';
      }
      mogoLiveOk = mogoState.ok;
    }
  }

  // --- toggle -----------------------------------------------------------------
  function mogoSyncToggle() {
    var t = $('mogo-toggle');
    if (!t) return;
    t.setAttribute('aria-pressed', String(mogoVisible));
    var c = $('mogo-count');
    if (c) {
      c.textContent = !mogoState.ok ? 'unavailable'
        : mogoState.layer ? mogoPanelTally(mogoState.layer.summary) : 'loading';
    }
  }
  var mogoToggleEl = $('mogo-toggle');
  if (mogoToggleEl && mogoToggleEl.addEventListener) {
    mogoToggleEl.addEventListener('click', function () {
      mogoVisible = !mogoVisible;
      if (mogoGroup) mogoGroup.visible = !!(mogoVisible && mogoState.ok && mogoPickList.length);
      mogoSyncToggle();
      if (!mogoVisible && typeof selectedStop !== 'undefined' && selectedStop && selectedStop.mogo &&
          typeof hideStop === 'function') hideStop();
    });
  }

  // --- poll -------------------------------------------------------------------
  function mogoFetchJson(url) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, MOGO_FETCH_TIMEOUT_MS);
    return fetch(url, { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('gbfs http ' + r.status);
        return r.json();
      }, function (e) { clearTimeout(timer); throw e; });
  }
  // station_information geometry moves slowly: re-fetch on a slow
  // cadence, replace the cache only when the feed's last_updated changes.
  function mogoRefreshInfo(force) {
    var t = Date.now();
    if (mogoInfoCache && !force && (t - mogoInfoFetchedAtMs) < MOGO_INFO_RECHECK_MS) {
      return Promise.resolve(mogoInfoCache);
    }
    return mogoFetchJson(MOGO_GBFS_BASE + '/station_information.json').then(function (payload) {
      mogoInfoFetchedAtMs = t;
      if (!mogoInfoCache || payload.last_updated !== mogoInfoCache.last_updated) {
        mogoInfoCache = payload;
      }
      return mogoInfoCache;
    });
  }
  function mogoSetLayer(layer, ok) {
    mogoState.ok = !!ok;
    if (layer) { mogoState.layer = layer; mogoState.fetchedAtMs = Date.now(); }
    // On failure the last layer is kept for the card/SR bookkeeping, but
    try { mogoWriteMarkers(); } catch (e) { /* marker failure must never break the poll */ }
    try { renderMogoSr(); } catch (e) { /* SR failure must never break the poll */ }
    try { mogoSyncToggle(); } catch (e) { /* toggle failure must never break the poll */ }
    if (typeof selectedStop !== 'undefined' && selectedStop && selectedStop.mogo &&
        typeof renderStopMogo === 'function') {
      var fresh = mogoState.layer && mogoState.layer.byId[selectedStop.id];
      if (fresh) { selectedStop.station = fresh; renderStopMogo(selectedStop); }
    }
  }
  function pollMogo() {
    mogoRefreshInfo(false)
      .then(function (info) {
        return mogoFetchJson(MOGO_GBFS_BASE + '/station_status.json').then(function (status) {
          mogoSetLayer(mogoBuildLayer(info, status, Date.now()), true);
        });
      })
      .catch(function () {
        // Feed down: honest unavailable state — markers clear (group hides
        // on ok=false), the toggle reads "unavailable", the SR note says
        // the feed could not be loaded. The next tick retries.
        mogoSetLayer(null, false);
      });
  }
  function startMogoPoll() {
    pollMogo();
    setInterval(function () { if (!document.hidden) pollMogo(); }, MOGO_POLL_MS);
  }
  // Boot: the projection arrives with the route data — start polling as
  // soon as it exists so markers can be placed.
  var mogoBootTimer = setInterval(function () {
    if (typeof proj !== 'undefined' && proj) {
      clearInterval(mogoBootTimer);
      startMogoPoll();
    }
  }, 500);

  // --- Places layer: Starbucks + Planet Fitness ------------------------------
  // Coffee shops and gyms as a static layer over the same street map, on the
  // MoGo layer's pattern: its own THREE group, its own filter-panel toggle,
  // details in the shared stop card, screen-reader text surfaces. Unlike
  // MoGo there is no live feed and no staleness: the dataset is baked at
  // build time into places.json (repo root) and fetched lazily the first
  // time the toggle is enabled.
  //
  // Source data: OpenStreetMap, via the Overpass API (© OpenStreetMap
  // contributors, ODbL — attribution ships in the dataset, the filter-panel
  // note, and every place card). Query: amenity=cafe / leisure=fitness_centre
  // with brand or name matching Starbucks / Planet Fitness. "Within map
  // boundaries" = inside the street-mosaic extent in
  // assets/detroit-streets.json (lat 42.178–42.47997522924901,
  // lon −83.385–−82.8992288); the extent declared in the removed SMART dataset
  // was stale and was not used. Raw pull 118 elements, 44 inside the
  // boundary, 2 building-way/node duplicate pairs deduplicated to a final
  // 42 locations: 31 Starbucks, 11 Planet Fitness. Baking record and the
  // coverage spot checks (OSM reads ~85–88% of in-boundary storefronts;
  // licensed counters inside other stores are the likeliest gaps) live in
  // the places-layer build report.
  //
  // Visual identity: a flat disc, wider and flatter than every pylon on the
  // map (stops and MoGo stations are cylinders on the stop family's height
  // scale; a place is a puck 16 units tall and 64–72 across), colored per
  // brand AND lettered — a canvas badge reading "S" or "PF" appears at
  // close zoom on the same declutter rule as the MoGo count badges, so
  // identity is never carried by color alone. The card and the SR list
  // state brand and address in words wherever the data carries them.
  //
  // Height and glow (2026-10-15, Justin's direction: "Add visual height
  // and glow to POIs for easier identification"): a slim pillar rises
  // from each disc and the letter badge rides at its top, and a soft
  // brand-tinted halo surrounds each marker at every zoom. The pillar is
  // 48 units tall on the stop family's height scale (rides stopYS like
  // the disc height), so the whole marker tops out at (16 + 48) * stopYS
  // = 64 * stopYS — below the stop family's own 75-unit base height
  // before per-route additions (a single-route stop pylon is 103 *
  // stopYS, a bus pillar 220): a place reads as a pin, never as a
  // second skyline, at every zoom, because pillar and stops scale
  // together. The pillar height is deliberately NOT distance-scaled
  // like the footprint: subordination is a world-space property, and
  // far-zoom identification is the glow's job — a distance-growing
  // pillar stacked on the distance-growing disc would rebuild the
  // skyline the height cap exists to prevent. The glow is an
  // additive-blended radial-gradient sprite, diameter 2.2x the disc's,
  // so it tracks the footprint's distance scaling and carries brand
  // identity at the default and city-wide distances where the letter
  // badges are decluttered away. Fair use unchanged: brand colors and
  // letter badges only — no logos or trademarked artwork.
  var PLACES_DATA_URL = 'places.json?v=' + STAMP;
  var PLACES_DISC_H = 16;   // place puck height before the stop family's zoom scale
  var PLACES_PILLAR_H = 48; // pillar height above the disc top, before stopYS
  var PLACES_PILLAR_R = 5;  // pillar radius at the footprint floor; scales with the footprint (~disc diameter / 13)
  var PLACES_GLOW_K = 2.2;  // glow sprite diameter as a multiple of the disc diameter
  var PLACES_GLOW_OPACITY = 0.5; // additive halo strength — a glow, not a blob
  var PLACES_DISC_BASE_D = 64;  // disc diameter at the close-zoom floor (the geometry's own width)
  // Distance-scaling coefficient (2026-10-15 legibility fix): beyond the
  // floor the disc diameter grows in proportion to camera distance —
  // diameter = camDist * K — the street labels' constant-screen-size
  // idiom, so a disc holds ≈16 px on an 844 px-high viewport at every
  // wider zoom. At the pre-fix fixed 64 units a disc projected to
  // ≈3.8 px wide at the default camera distance (18.5k) and ≈1.3 px at
  // maximum zoom-out, which is why enabling the layer produced no
  // visible change on the map. The coefficient matches the POI v2
  // candidate's treatment (files/places-layer/v2/) so the two agree
  // where they overlap.
  var PLACES_DISC_K = 0.0146;
  var placesDiscScaleV = 1;     // current eased disc footprint scale (1 = base diameter)
  var PLACES_BRANDS = {
    starbucks:     { name: 'Starbucks',      kind: 'Coffee shop',    badge: 'S',  color: '#555555' },
    planetfitness: { name: 'Planet Fitness', kind: 'Fitness centre', badge: 'PF', color: '#393939' }
  };
  var placesData = null;          // parsed places.json once loaded
  var placesLoadState = 'idle';   // idle | loading | ok | error
  var placesOn = { starbucks: false, planetfitness: false }; // DEFAULT OFF, session-only (no localStorage) — Justin's MoGo rulings, 2026-10-14
  var placesGroup = null, placesDiscIM = null, placesPillarIM = null;
  var placesBadges = [];          // one THREE.Sprite per rendered place
  var placesGlows = [];           // one additive halo sprite per rendered place
  var placesGlowTex = null;       // shared radial-gradient texture (brand tint is per-sprite)
  var placesPickList = [];        // {id, n, x, z, r: [], place: true, pdata}
  var placesBadgeTexCache = {};
  var _placesM4 = null, _placesP3 = null, _placesQ = null, _placesS3 = null, _placesCol = null, _placesV3 = null;

  function placesEnabledPlaces() {
    if (!placesData || !Array.isArray(placesData.places)) return [];
    return placesData.places.filter(function (p) { return !!placesOn[p.brand]; });
  }

  // --- data -------------------------------------------------------------------
  // Static site file, fetched once, lazily, on the first enable of the
  // toggle (the MoGo layer fetches on enable too — there the feed is
  // live; here the fetch is the whole load). Failure is an honest state:
  // toggles read "unavailable", the SR note says the data could not be
  // loaded, and the next enable retries.
  function placesEnsureData() {
    if (placesData || placesLoadState === 'loading') return;
    placesLoadState = 'loading';
    placesSyncToggles();
    fetch(PLACES_DATA_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('places http ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (!d || !Array.isArray(d.places)) throw new Error('bad places payload');
        placesData = d;
        placesLoadState = 'ok';
        try { placesWriteMarkers(); } catch (e) { /* marker failure must not break the load */ }
        try { renderPlacesSr(); } catch (e) { /* SR failure must not break the load */ }
        try { placesSyncToggles(); } catch (e) { /* toggle failure must not break the load */ }
      })
      .catch(function () {
        placesLoadState = 'error';
        try { renderPlacesSr(); } catch (e) { /* SR failure must not break the load */ }
        try { placesSyncToggles(); } catch (e) { /* toggle failure must not break the load */ }
        placesAnnounce('Points of interest data could not be loaded.');
      });
  }

  // --- rendering ---------------------------------------------------------------
  // Disc diameter for a camera distance, in world units: the geometry's
  // own 64 below camDist ≈ 4400, distance-proportional beyond it.
  function placesDiscDiamFor(camDist) {
    return Math.max(PLACES_DISC_BASE_D, camDist * PLACES_DISC_K);
  }
  // Rendered disc diameter in CSS pixels (the page's own pixel measure:
  // viewport height over the frustum height at the target distance).
  // Exposed for verification of the legibility fix.
  function placesDiscPx(camDist, viewportH) {
    return placesDiscDiamFor(camDist) * viewportH / (2 * camDist * Math.tan(camera.fov * 0.5 * DEG));
  }
  // Glow diameter for a camera distance, in world units: the disc's
  // distance-scaled diameter times the glow multiple, so the halo holds
  // the same screen size as the disc at every wider zoom.
  function placesGlowDiamFor(camDist) {
    return placesDiscDiamFor(camDist) * PLACES_GLOW_K;
  }
  // Rendered glow diameter in CSS pixels. Exposed for verification of
  // the height-and-glow build, like placesDiscPx.
  function placesGlowPx(camDist, viewportH) {
    return placesGlowDiamFor(camDist) * viewportH / (2 * camDist * Math.tan(camera.fov * 0.5 * DEG));
  }
  function placesEnsureMeshes() {
    if (placesGroup) return;
    _placesM4 = new THREE.Matrix4(); _placesP3 = new THREE.Vector3();
    _placesQ = new THREE.Quaternion(); _placesS3 = new THREE.Vector3();
    _placesCol = new THREE.Color(); _placesV3 = new THREE.Vector3();
    placesGroup = new THREE.Group();
    placesGroup.name = 'places';
    placesDiscIM = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(32, 36, 1, 20),
      new THREE.MeshLambertMaterial({ color: 0xffffff }), 64);
    placesDiscIM.frustumCulled = false;
    placesDiscIM.count = 0;
    placesGroup.add(placesDiscIM);
    // Pillar: unit cylinder with the stop family's taper (14/18 ≈ 1/1.25),
    // instanced like the disc; per-instance scale carries the radius
    // (footprint-coupled) and the height (stopYS-coupled).
    placesPillarIM = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1.25, 1, 10),
      new THREE.MeshLambertMaterial({ color: 0xffffff }), 64);
    placesPillarIM.frustumCulled = false;
    placesPillarIM.count = 0;
    placesGroup.add(placesPillarIM);
    placesGroup.visible = false;
    scene.add(placesGroup);
  }
  // Shared radial-gradient texture for the glow sprites: a white core
  // falling to transparency, tinted per sprite by the material color.
  // One texture for all places — the brand lives in the tint, so no
  // per-brand canvas work is needed.
  function placesGlowTexture() {
    if (placesGlowTex) return placesGlowTex;
    var c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.32)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    placesGlowTex = new THREE.CanvasTexture(c);
    return placesGlowTex;
  }
  function placesBadgeTexture(text) {
    var hit = placesBadgeTexCache[text];
    if (hit) return hit;
    var c = document.createElement('canvas');
    var x = c.getContext('2d');
    x.font = '700 34px system-ui, -apple-system, sans-serif';
    var w = Math.ceil(x.measureText(text).width) + 36;
    c.width = w; c.height = 54;
    var g = x;
    g.fillStyle = 'rgba(10,14,18,0.85)';
    g.beginPath();
    if (g.roundRect) g.roundRect(0, 0, c.width, c.height, 13); else g.rect(0, 0, c.width, c.height);
    g.fill();
    g.font = '700 34px system-ui, -apple-system, sans-serif';
    g.fillStyle = '#F2F2F2'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, c.width / 2, c.height / 2 + 1);
    var t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    var o = { tex: t, aspect: c.width / c.height };
    placesBadgeTexCache[text] = o;
    return o;
  }
  // Disc instance matrices from the pick list, at the current eased
  // footprint scale and the stop family's height scale. Split out of
  // placesWriteMarkers so the per-frame hook can re-scale the discs as
  // the camera distance changes without rebuilding the pick list.
  function placesWriteDiscInstances() {
    if (!placesDiscIM) return;
    var h = PLACES_DISC_H * stopYS;
    for (var i = 0; i < placesPickList.length; i++) {
      var s = placesPickList[i];
      _placesP3.set(s.x, STOP_BASE_Y + h / 2, s.z);
      _placesQ.identity();
      _placesS3.set(placesDiscScaleV, h, placesDiscScaleV);
      _placesM4.compose(_placesP3, _placesQ, _placesS3);
      placesDiscIM.setMatrixAt(i, _placesM4);
    }
    placesDiscIM.count = placesPickList.length;
    placesDiscIM.instanceMatrix.needsUpdate = true;
  }
  // Pillar instance matrices from the pick list: the radius rides the
  // eased footprint scale (a pillar stays ~1/13 of its disc's width at
  // every zoom) and the height rides stopYS (the stop family's scale),
  // so the writer runs wherever the disc writer runs.
  function placesWritePillarInstances() {
    if (!placesPillarIM) return;
    var dh = PLACES_DISC_H * stopYS, ph = PLACES_PILLAR_H * stopYS;
    var r = PLACES_PILLAR_R * placesDiscScaleV;
    for (var i = 0; i < placesPickList.length; i++) {
      var s = placesPickList[i];
      _placesP3.set(s.x, STOP_BASE_Y + dh + ph / 2, s.z);
      _placesQ.identity();
      _placesS3.set(r, ph, r);
      _placesM4.compose(_placesP3, _placesQ, _placesS3);
      placesPillarIM.setMatrixAt(i, _placesM4);
    }
    placesPillarIM.count = placesPickList.length;
    placesPillarIM.instanceMatrix.needsUpdate = true;
  }
  // Glow sprite placement: centered on the marker's vertical span, with
  // the diameter tracking the eased footprint scale. Sprites have no
  // instance buffer, so this is a plain per-sprite loop over at most 42
  // entries; it runs on marker writes and on the per-frame hook (the
  // diameter eases with the footprint).
  function placesSyncGlows() {
    var diam = PLACES_DISC_BASE_D * placesDiscScaleV * PLACES_GLOW_K;
    var cy = STOP_BASE_Y + (PLACES_DISC_H + PLACES_PILLAR_H) * stopYS / 2;
    for (var i = 0; i < placesPickList.length; i++) {
      var glow = placesGlows[i];
      if (!glow) continue;
      var s = placesPickList[i];
      glow.position.set(s.x, cy, s.z);
      glow.scale.set(diam, diam, 1);
      glow.visible = !!(placesGroup && placesGroup.visible);
    }
    for (var j = placesPickList.length; j < placesGlows.length; j++) {
      if (placesGlows[j]) placesGlows[j].visible = false;
    }
  }
  // Static geometry: instance buffers are rebuilt only when the enabled
  // brand set or the zoom scale changes — nothing is allocated per frame.
  function placesWriteMarkers() {
    placesEnsureMeshes();
    var list = placesEnabledPlaces();
    placesPickList = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var b = PLACES_BRANDS[p.brand];
      var xy = project(p.lat, p.lon);
      var h = PLACES_DISC_H * stopYS;
      _placesCol.set(b ? b.color : '#8F8F8F');
      placesDiscIM.setColorAt(i, _placesCol);
      placesPillarIM.setColorAt(i, _placesCol);
      placesPickList.push({ id: p.id, n: p.n, x: xy[0], z: xy[1], r: [], place: true, pdata: p });
      var badge = placesBadges[i];
      if (!badge) {
        badge = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }));
        badge.renderOrder = 35;
        badge.visible = false;
        placesGroup.add(badge);
        placesBadges[i] = badge;
      }
      var bt = b ? b.badge : '?';
      if (badge.userData.text !== bt) {
        var o = placesBadgeTexture(bt);
        badge.material.map = o.tex;
        badge.material.needsUpdate = true;
        badge.userData.text = bt;
        badge.userData.aspect = o.aspect;
      }
      badge.scale.set(40 * (badge.userData.aspect || 1), 40, 1);
      // The badge rides at the pillar's top (disc top + pillar height),
      // with its center one badge-radius and a small gap above it.
      badge.position.set(xy[0], STOP_BASE_Y + h + PLACES_PILLAR_H * stopYS + 26, xy[1]);
      var glow = placesGlows[i];
      if (!glow) {
        glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: placesGlowTexture(), color: new THREE.Color(b ? b.color : '#8F8F8F'),
          blending: THREE.AdditiveBlending, depthWrite: false,
          transparent: true, opacity: PLACES_GLOW_OPACITY }));
        glow.renderOrder = 34; // under the letter badges (35)
        glow.visible = false;
        placesGroup.add(glow);
        placesGlows[i] = glow;
      }
      if (glow.userData.brand !== p.brand) {
        glow.material.color.set(b ? b.color : '#8F8F8F');
        glow.userData.brand = p.brand;
      }
    }
    placesWriteDiscInstances();
    placesWritePillarInstances();
    if (placesDiscIM.instanceColor) placesDiscIM.instanceColor.needsUpdate = true;
    if (placesPillarIM.instanceColor) placesPillarIM.instanceColor.needsUpdate = true;
    for (var j = list.length; j < placesBadges.length; j++) {
      if (placesBadges[j]) placesBadges[j].visible = false;
    }
    placesGroup.visible = !!(placesData && placesLoadState === 'ok' && list.length &&
      (placesOn.starbucks || placesOn.planetfitness));
    // Glows sync last: visibility reads the group's final state.
    placesSyncGlows();
  }
  // Zoom-coupled rescale, called from easeStopScale: place pucks are flat
  // members of the ground-marker family and ride the same eased scale.
  function placesRescale() {
    if (!placesGroup || !placesData) return;
    placesWriteMarkers();
  }
  // Per-frame hook from the animate loop: the disc footprint scale
  // eases toward the distance-proportional target (the easeStopScale
  // idiom), and letter badges follow the street-zoom declutter rule —
  // visible at close zoom only (camDist < 9000, the MoGo badge
  // threshold), never all 42 citywide at once.
  function placesFrameTick(camDist) {
    if (!placesGroup) return;
    var target = placesDiscDiamFor(camDist) / PLACES_DISC_BASE_D;
    var dS = target - placesDiscScaleV;
    // The pillar radius and the glow diameter ride the same eased
    // footprint scale, so both are rewritten wherever the discs are.
    if (Math.abs(dS) > 0.003) {
      placesDiscScaleV += dS * 0.16;
      try { placesWriteDiscInstances(); placesWritePillarInstances(); placesSyncGlows(); } catch (e) { /* a failed rewrite retries next frame */ }
    } else if (placesDiscScaleV !== target) {
      placesDiscScaleV = target;
      try { placesWriteDiscInstances(); placesWritePillarInstances(); placesSyncGlows(); } catch (e) { /* a failed rewrite retries next frame */ }
    }
    var show = placesGroup.visible && camDist < 9000;
    for (var i = 0; i < placesPickList.length; i++) {
      var b = placesBadges[i];
      if (b && b.visible !== show) b.visible = show;
    }
  }
  // Screen-space nearest place (mirrors pickMogoStation: proximity, not
  // raycast — the pucks are low and raycasting them would be fiddly).
  function pickPlace(cx, cy, isTouch) {
    if (!placesGroup || !placesGroup.visible || !placesPickList.length) return null;
    var r = renderer.domElement.getBoundingClientRect();
    var sx = cx - r.left, sy = cy - r.top;
    var best = null, bestD = isTouch ? 48 : 26;
    for (var i = 0; i < placesPickList.length; i++) {
      var s = placesPickList[i];
      // Anchor at the pillar's mid-height: the visible column runs from
      // the ground to the pillar top, so the pick target sits mid-column
      // (the bus pillars' idiom — a tap anywhere along the column is
      // closest to its middle). The existing radii (26 px mouse, 48 px
      // touch) already cover the glow at distance-scaled zooms, whose
      // radius is ≈18 px at the default and city-wide distances.
      _placesV3.set(s.x, STOP_BASE_Y + (PLACES_DISC_H + PLACES_PILLAR_H) * stopYS / 2, s.z).project(camera);
      if (_placesV3.z > 1 || _placesV3.z < -1) continue;
      var px = (_placesV3.x * 0.5 + 0.5) * r.width, py = (-_placesV3.y * 0.5 + 0.5) * r.height;
      var d = Math.hypot(px - sx, py - sy);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  // --- stop-card section ---------------------------------------------------------
  // The stop card is the shared detail surface. For a place record,
  // renderStopPlace fills the PLACE section and relabels the two generic
  // rows (Type / Address); the section DL carries the Brand row plus the
  // enrichment rows the record has (Hours / Phone / Website — only rows
  // that have data). For any other record it hides the section, and
  // restores the labels only when a place card was the one showing (the
  // restore is flag-gated so the MoGo branch's labels are never clobbered —
  // showStop calls renderStopMogo first, then this).
  var placeCardActive = false;
  function placesCardModel(p) {
    if (!p) return null;
    var b = PLACES_BRANDS[p.brand] || { name: p.brand || 'Place', kind: 'Place' };
    return {
      title: p.n || b.name,
      brandName: b.name,
      kind: b.kind,
      address: p.addr || null,
      hours: p.hours || null,
      phone: p.phone || null,
      website: p.website || null,
      note: b.name + ' ' + b.kind.toLowerCase() + '. Location from OpenStreetMap ' +
        '(\u00A9 OpenStreetMap contributors, ODbL) \u2014 community map data, which may not list every location.'
    };
  }
  // Screen-reader announcement text for a place card (showStop calls this
  // in place of its generic "routes serve this stop" sentence).
  function placesCardText(st) {
    if (!st || !st.pdata) return 'Place details opened.';
    var m = placesCardModel(st.pdata);
    return 'Place details opened. ' + m.title + '. ' + m.kind +
      (m.address ? '. ' + m.address : '. Address not listed') + '.';
  }
  function placesDlRow(dl, label, value) {
    var dt = document.createElement('dt'); dt.textContent = label;
    var dd = document.createElement('dd'); dd.textContent = value;
    dl.appendChild(dt); dl.appendChild(dd);
  }
  function placesDlLinkRow(dl, label, url) {
    var dt = document.createElement('dt'); dt.textContent = label;
    var dd = document.createElement('dd');
    if (/^https?:\/\//i.test(url)) {
      var a = document.createElement('a');
      a.href = url;
      a.textContent = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      dd.appendChild(a);
    } else {
      dd.textContent = url;
    }
    dl.appendChild(dt); dl.appendChild(dd);
  }
  function renderStopPlace(st) {
    var sec = $('stop-place');
    if (!sec) return;
    var idDt = $('stop-id-dt'), srvDt = $('stop-nroutes-dt');
    if (!st || !st.place || !st.pdata) {
      sec.hidden = true;
      if (placeCardActive) {
        if (idDt) idDt.textContent = 'Stop ID';
        if (srvDt) srvDt.textContent = 'Serving';
        placeCardActive = false;
      }
      return;
    }
    var m = placesCardModel(st.pdata);
    if (idDt) idDt.textContent = 'Type';
    if (srvDt) srvDt.textContent = 'Address';
    $('stop-id').textContent = m.kind;
    $('stop-nroutes').textContent = m.address || 'Not listed in OpenStreetMap';
    var dl = $('stop-place-dl');
    dl.innerHTML = '';
    placesDlRow(dl, 'Brand', m.brandName);
    if (m.hours) placesDlRow(dl, 'Hours', m.hours);
    if (m.phone) placesDlRow(dl, 'Phone', m.phone);
    if (m.website) placesDlLinkRow(dl, 'Website', m.website);
    $('stop-place-note').textContent = m.note;
    sec.hidden = false;
    placeCardActive = true;
  }

  // --- screen-reader surface -----------------------------------------------------
  // #places-sr names every shown place in words (signature-gated, like
  // #mogo-sr); #places-live announces toggle changes and load failure only —
  // the dataset is static, so there is nothing else to announce.
  var placesSrSig = '';
  function placesSrText(p) {
    var b = PLACES_BRANDS[p.brand];
    return (p.n || (b ? b.name : 'Place')) + (p.addr ? ', ' + p.addr : ' \u2014 address not listed') + '.';
  }
  function renderPlacesSr() {
    var list = $('places-sr-list');
    if (!list) return;
    var shown = placesEnabledPlaces();
    var sig = placesLoadState + '|' + shown.map(function (p) { return p.id; }).join(',');
    if (sig === placesSrSig) return;
    placesSrSig = sig;
    list.innerHTML = '';
    shown.forEach(function (p) {
      var li = document.createElement('li');
      li.textContent = placesSrText(p);
      list.appendChild(li);
    });
    var note = $('places-sr-note');
    if (note) {
      note.textContent = placesLoadState === 'error'
        ? 'Points of interest data is unavailable \u2014 places.json could not be loaded.'
        : placesLoadState === 'ok'
          ? 'Points of interest from OpenStreetMap (\u00A9 OpenStreetMap contributors, ODbL): ' +
            (placesData.meta && placesData.meta.counts ? placesData.meta.counts.total : placesData.places.length) +
            ' points of interest in the dataset, ' + shown.length + ' shown.' +
            (shown.length ? ' Sponsored: the Starbucks and Planet Fitness layers are partnership placements.' : '')
          : 'Points of interest are off. Enable Points of interest in the filter panel to list them here.';
    }
  }
  function placesAnnounce(msg) {
    var live = $('places-live');
    if (live) live.textContent = msg;
  }

  // --- toggle ----------------------------------------------------------------------
  // One "Points of interest" switch in the filter panel drives both
  // brands together, with the group's baked dataset tally. Justin's
  // direction, 2026-10-15: a single toggle for the whole group — the
  // two per-brand sub-toggles were removed; the per-brand distinction
  // lives on the map (disc colors and the S/PF letter badges) and in
  // the dataset, not in panel controls. Default OFF and session-only,
  // matching Justin's MoGo rulings of 2026-10-14: nothing is written
  // to localStorage.
  function placesAllOn() { return !!(placesOn.starbucks && placesOn.planetfitness); }
  function placesSyncToggles() {
    var t = $('places-toggle');
    if (t) t.setAttribute('aria-pressed', String(placesAllOn()));
    // Gate 5 labeling (2026-10-18): both brands in this group are
    // partnership placements (inventory: PLACES-SB / PLACES-PF in
    // commercial-posture-audit/places-inventory-2026-10-18.md), so the
    // "Sponsored" tag on the toggle row and the legend line in the
    // layer's note follow the layer state exactly — visible whenever
    // the layer is enabled, absent when it is off, and removable by
    // no control while it is on. Labeling only: this block reads
    // layer state and touches nothing about ranking, ordering, or
    // prominence of any transit information (editorial firewall).
    var sponsored = placesAllOn();
    var stag = $('places-sponsored-tag');
    if (stag) stag.hidden = !sponsored;
    var snote = $('places-sponsored-note');
    if (snote) snote.hidden = !sponsored;
    var err = placesLoadState === 'error';
    var counts = (placesData && placesData.meta && placesData.meta.counts) || null;
    var allC = $('places-count');
    if (err) {
      if (allC) allC.textContent = 'unavailable';
    } else if (counts) {
      if (allC) allC.textContent = String(counts.total || 0) + ' points of interest';
    }
  }
  (function placesWireToggle() {
    var t = $('places-toggle');
    if (t && t.addEventListener) {
      t.addEventListener('click', function () {
        var on = !placesAllOn();
        placesOn.starbucks = on;
        placesOn.planetfitness = on;
        if (on) placesEnsureData();
        try { placesWriteMarkers(); } catch (e) { /* marker failure must not break the toggle */ }
        placesSyncToggles();
        renderPlacesSr();
        var n = (placesData && placesData.meta && placesData.meta.counts && placesData.meta.counts.total) || 0;
        // On the first enable the lazy fetch has not resolved yet, so the
        // tally is announced only when the dataset is already in hand.
        placesAnnounce(on ? (n ? 'Points of interest shown: ' + n + ' points of interest.' : 'Points of interest shown.') : 'Points of interest hidden.');
        if (!on && typeof selectedStop !== 'undefined' && selectedStop && selectedStop.place &&
            typeof hideStop === 'function') hideStop();
      });
    }
  })();
  placesSyncToggles();
  renderPlacesSr();
  // --- instant paint from logged history ---------------------------------------
  var historyRendered = false;
  function maybeRenderHistory() {
    if (historyRendered || !proj || !historyVehicles) return;
    if (liveEverOk) return; // live data already won the race
    historyRendered = true;
    lastVehicles = historyVehicles;
    var n = updateBuses(historyVehicles);
    historyOk = true;
    lastTotal = n;
    setHeader(n, 'last logged ' + fmtTime(historyAt ? new Date(historyAt) : null) + ' — connecting live…', false);
  }
  var historyVehicles = null;
  var historyAt = null;
  function fetchHistory() {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 10000);
    fetch(HISTORY_URL, { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error('http ' + r.status); return r.json(); },
            function (e) { clearTimeout(timer); throw e; })
      .then(function (d) {
        if (!d || !Array.isArray(d.vehicles)) throw new Error('bad history payload');
        historyVehicles = d.vehicles;
        historyAt = d.polled_at ? new Date(d.polled_at) : null;
        maybeRenderHistory();
      })
      .catch(function () { /* history is a bonus; live poll proceeds regardless */ });
  }

  // --- boot --------------------------------------------------------------------
  function resize() {
    var w = container.clientWidth || 800;
    var h = container.clientHeight || 540;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  Promise.all([
    fetch('ddot-routes-3d.json?v=' + STAMP)
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }),
    fetch('ddot-fleet.json?v=' + STAMP)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }),
    fetch('assets/detroit-streets.json?v=' + STAMP)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }),
    fetch('assets/detroit-street-names.json?v=' + STAMP)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }),
    fetch('peoplemover-3d.json?v=' + STAMP)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }), // static layer is optional: map works without it
    fetch('smart-routes-3d.json?v=' + STAMP)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }), // SMART layer is optional: map works without it, see the merge below
    fetch('qline-3d.json?v=' + STAMP)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }) // QLINE layer is optional
  ])
    .then(function (all) {
      var data = all[0];
      fleetData = all[1];
      streetData = all[2];
      streetNameData = all[3];
      var pmData = all[4];
      var smartData = all[5];
      var qlineData = all[6];
      // SMART REACTIVATED 2026-10-15 (Justin's direction): the segment
      // the removal tombstoned is live again. The routes file was never
      // modified (it stayed in the repo as the rollback substrate), so
      // the pre-removal merge returns verbatim and every registry index
      // is again the pre-removal index (S1): DDOT 0-5123, SMART
      // 5124-10560, QLINE 10561-10582. SMART routes are recolored
      // uniformly to SMART red, as before the removal. If the fetch
      // failed, the map runs DDOT+QLINE only (the pre-removal failure
      // mode); smart-tombstones.json is no longer fetched or served.
      if (smartData && Array.isArray(smartData.routes) && smartData.routes.length) {
        data.groups = (data.groups || []).concat(smartData.groups || []);
        smartData.routes.forEach(function (r) { r.color = '#313131'; });
        data.routes = (data.routes || []).concat(smartData.routes);
        data.stops = (data.stops || []).concat(smartData.stops || []);
      }
      // QLINE streetcar: merged in the same pattern. The proxy serves QLINE vehicle
      // positions on the same /api/vehicles feed with agency='qline' and
      // route_id='QLINE'. Absent file: the map runs without QLINE, no errors.
      if (qlineData && Array.isArray(qlineData.routes) && qlineData.routes.length) {
        data.groups = (data.groups || []).concat(qlineData.groups || []);
        data.routes = (data.routes || []).concat(qlineData.routes);
        data.stops = (data.stops || []).concat(qlineData.stops || []);
      }
      proj = {
        lat0: data.projection.lat0,
        lon0: data.projection.lon0,
        mLat: 111320,
        mLon: 111320 * Math.cos(data.projection.lat0 * DEG)
      };

      // Vector street map, drawn ourselves: dark ground + tiered Census
      // TIGER/Line highway geometry. Crisp at every zoom; no raster tiles.
      // The mosaic spans MOSAIC_BOUNDS; segments inside STREET_BOUNDS render
      // always, segments outside live in streetExt, displayed only while
      // the SMART group is displayed (see syncStreetExt).
      var streetLocal = null;
      (function buildStreets() {
        // Ground covers the full mosaic bbox permanently. #0C0C0C against the
        // #010103 scene background is near-identical, so the larger ground is
        // visually a no-op while the extension is hidden.
        var gnw = project(MOSAIC_BOUNDS.latN, MOSAIC_BOUNDS.lonW);
        var gse = project(MOSAIC_BOUNDS.latS, MOSAIC_BOUNDS.lonE);
        var gw = gse[0] - gnw[0], gh = gse[1] - gnw[1];
        var ground = new THREE.Mesh(
          new THREE.PlaneGeometry(gw, gh),
          new THREE.MeshBasicMaterial({ color: 0x0c0c0c })
        );
        ground.rotation.x = -Math.PI / 2;
        ground.position.set(gnw[0] + gw / 2, 0, gnw[1] + gh / 2);
        scene.add(ground);
        // Core bounds in meters for the partition test (midpoint-in-core).
        var cnw = project(STREET_BOUNDS.latN, STREET_BOUNDS.lonW);
        var cse = project(STREET_BOUNDS.latS, STREET_BOUNDS.lonE);
        var cx0 = cnw[0], cx1 = cse[0], cz0 = cnw[1], cz1 = cse[1];
        // Safe-zone border: dashed amber perimeter at the coverage bounds so the
        // edge of the mapped area stays visible while panning/scrolling. Floats
        // at y=20 — above the street tiers (14-16), below the route decks (~66).
        // Brand: Amber #B4B4B4, the academy's signal accent.
        (function addBoundsBorder() {
          var x0 = cx0, x1 = cx1, z0 = cz0, z1 = cz1, yB = 20;
          var g = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(x0, yB, z0),
            new THREE.Vector3(x1, yB, z0),
            new THREE.Vector3(x1, yB, z1),
            new THREE.Vector3(x0, yB, z1)
          ]);
          var border = new THREE.LineLoop(g, new THREE.LineDashedMaterial({
            color: 0xB4B4B4, dashSize: 220, gapSize: 140,
            transparent: true, opacity: 0.55, depthWrite: false
          }));
          border.computeLineDistances();
          border.renderOrder = 5;
          border.name = 'safe-zone-border';
          scene.add(border);
        })();
        // Extension group: permanently hidden since the SMART removal.
        streetExt = new THREE.Group();
        streetExt.visible = false;
        scene.add(streetExt);
        // Expanded-bounds border: same amber language at the mosaic bounds,
        // faded with the extension group so both states read correctly.
        (function addExtBorder() {
          var x0 = gnw[0], x1 = gse[0], z0 = gnw[1], z1 = gse[1], yB = 20;
          var g = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(x0, yB, z0),
            new THREE.Vector3(x1, yB, z0),
            new THREE.Vector3(x1, yB, z1),
            new THREE.Vector3(x0, yB, z1)
          ]);
          var mat = new THREE.LineDashedMaterial({
            color: 0xB4B4B4, dashSize: 220, gapSize: 140,
            transparent: true, opacity: 0, depthWrite: false
          });
          var border = new THREE.LineLoop(g, mat);
          border.computeLineDistances();
          border.renderOrder = 5;
          border.name = 'safe-zone-border-ext';
          streetExt.add(border);
          streetExtMats.push({ mat: mat, baseOpacity: 0.55 });
        })();
        if (!streetData) return; // ground still renders; streets absent
        function splitTier(arr) {
          var core = [], ext = [];
          for (var i = 0; i < arr.length; i += 4) {
            var mx = (arr[i] + arr[i + 2]) / 2, mz = (arr[i + 1] + arr[i + 3]) / 2;
            ((mx >= cx0 && mx <= cx1 && mz >= cz0 && mz <= cz1) ? core : ext)
              .push(arr[i], arr[i + 1], arr[i + 2], arr[i + 3]);
          }
          return { core: core, ext: ext };
        }
        function addTier(arr, color, opacity, y, parent) {
          if (!arr || !arr.length) return null;
          var n = arr.length / 4;
          var pos = new Float32Array(n * 6);
          for (var i = 0; i < n; i++) {
            pos[i * 6]     = arr[i * 4];
            pos[i * 6 + 1] = y;
            pos[i * 6 + 2] = arr[i * 4 + 1];
            pos[i * 6 + 3] = arr[i * 4 + 2];
            pos[i * 6 + 4] = y;
            pos[i * 6 + 5] = arr[i * 4 + 3];
          }
          var g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          var mat = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: opacity });
          var lines = new THREE.LineSegments(g, mat);
          lines.frustumCulled = false;
          parent.add(lines);
          if (parent === streetExt) streetExtMats.push({ mat: mat, baseOpacity: opacity });
          return lines;
        }
        var fw = splitTier(streetData.freeway);
        addTier(fw.core, 0x404040, 0.95, 16, scene);
        addTier(fw.ext, 0x404040, 0.95, 16, streetExt);
        var ar = splitTier(streetData.arterial);
        addTier(ar.core, 0x2b2b2b, 0.9, 15, scene);
        addTier(ar.ext, 0x2b2b2b, 0.9, 15, streetExt);
        var lo = splitTier(streetData.local);
        streetLocal = addTier(lo.core, 0x181818, 0.8, 14, scene);
        streetExtLocal = addTier(lo.ext, 0x181818, 0.8, 14, streetExt);
      })();

      var casingMat = routeShader(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.95, side: THREE.DoubleSide }), false);

      // Per-group containers (stops clouds toggle with the group filter).
      groupOrder = data.groups.map(function (g) { return g.id; });
      data.groups.forEach(function (g) {
        groupRoutes[g.id] = g.routes.slice();
        var gr = new THREE.Group();
        scene.add(gr);
        groupObjs[g.id] = gr;
      });

      // Phase 1 merged guideway materials: one per class across all
      // routes. Deck/skirt carry per-route alpha (dim x fade) and are
      // transparent so per-route alpha can compose; depthWrite stays on,
      // so crossings still resolve by the per-route deck heights.
      var deckMatAll = routeShader(new THREE.MeshLambertMaterial({
        color: 0xffffff, vertexColors: true, side: THREE.DoubleSide, transparent: true }), true);
      var skirtMatAll = routeShader(new THREE.MeshLambertMaterial({
        color: 0xffffff, vertexColors: true, side: THREE.DoubleSide, transparent: true }), true);
      var glowMatAll = routeShader(new THREE.MeshBasicMaterial({
        color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.20,
        depthWrite: false, side: THREE.DoubleSide }), false);
      // Ribbon splintering repair, class 2(c): the glow used to blend
      // additively, so corridor stacks summed past full white (six
      // covering routes at Woodward & Warren summed to 1.20 -- the
      // blown white/pink streaks). Normal blending caps any stack at
      // the material opacity no matter how many routes cover a point:
      // a lone route's halo is unchanged (Normal vs Additive differ
      // only where fragments overlap), and stacked corridors now
      // saturate at one halo's strength instead of blowing out.
      streetGlowMats.push(glowMatAll);
      var mergedGlow = [], mergedCase = [], mergedDeck = [], mergedSkirt = [];
      data.routes.forEach(function (route, ri) {
        var color = new THREE.Color(route.color);
        routeColors[route.id] = color;
        routeNames[route.id] = route.name;
        routeById[route.id] = route;
        routeOrder.push(route.id);
        var grp = new THREE.Group();
        // Stagger ribbon heights per route: coplanar overlapping guideways
        // at crossings z-fight and flicker; a few meters of separation is
        // invisible but kills the shimmer.
        // Deliberate layer cake (meters): every route owns a unique level —
        // 37 routes, no shared slots, so crossing/overlapping decks can never
        // z-fight. Crossings read as clean overpasses, higher route over lower.
        var yDeck = 66 + ri * 1.2;
        var yGlow = 2 + ri * 0.25;
        var yCase = 24 + ri * 0.15;
        // Elevated guideway: the ribbon deck floats at y=66 with solid
        // skirts to the ground, so routes read as 3D structures. Lambert
        // materials let the directional light shade deck vs. sides.
        // Phase 1: this route's geometry joins the merged per-class
        // meshes after the loop, tagged with its route index and baked
        // vertex color (deck/glow: the route color; skirt: color x 0.38,
        // the pre-merge skirt material's shade). The group itself keeps
        // only the label + tether; dimming is applyDim -> routeAlphaU.
        var routeIdx = routeIndexById[route.id] = Object.keys(routeIndexById).length;
        var skirtColor = color.clone().multiplyScalar(0.38);
        var longest = null;
        var glowGeos = [], caseGeos = [], deckGeos = [], skirtGeos = [];
        route.paths.forEach(function (path, pi) {
          if (path.length < 2) return;
          // Ribbon splintering repair, class 2(a): sibling paths of a
          // route shared the route's one deck level exactly, so
          // direction pairs and branch variants drew coplanar over
          // ~80% of path-km -- a depth-equal patchwork that no
          // between-route height step could fix. Each path now takes
          // a sub-meter slot inside its route's 1.2 m band (a
          // golden-ratio spread of the path index: distinct slots at
          // any path count, max 1.19 m), so no two guideway surfaces
          // in the corpus share a height, while route order at
          // crossings -- and the overpass read -- is unchanged. The
          // glow takes the slot too (its stack is capped separately,
          // at the material below) but not the fold lift: a 230 m
          // additive haze has no fan to separate.
          var slot = (pi * 0.6180339887 % 1) * 1.19;
          glowGeos.push(ribbonGeometry(path, 230, yGlow, { repair: true, lift: false, slot: slot }));
          caseGeos.push(ribbonGeometry(path, 95, yCase, { repair: true, slot: slot }));
          deckGeos.push(ribbonGeometry(path, 72, yDeck, { repair: true, slot: slot }));
          skirtGeos.push(skirtGeometry(path, 72, yDeck, { repair: true, slot: slot }));
          if (!longest || path.length > longest.length) longest = path;
        });
        if (glowGeos.length) mergedGlow.push(tagRouteGeom(mergeGeoms(glowGeos), routeIdx, color));
        if (caseGeos.length) mergedCase.push(tagRouteGeom(mergeGeoms(caseGeos), routeIdx, null));
        if (deckGeos.length) mergedDeck.push(tagRouteGeom(mergeGeoms(deckGeos), routeIdx, color));
        if (skirtGeos.length) mergedSkirt.push(tagRouteGeom(mergeGeoms(skirtGeos), routeIdx, skirtColor));
        if (longest) {
          var mid = longest[Math.floor(longest.length / 2)];
          // Route display name: "name - number" unless they're identical (QLINE).
          var displayName = routeLabel(route.id);
          var label = makeLabel(displayName, route.color);
          label.position.set(mid[0], 1050, mid[1]);
          grp.add(label);
          var tetherGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(mid[0], yDeck, mid[1]),
            new THREE.Vector3(mid[0], 980, mid[1])
          ]);
          var tether = new THREE.Line(tetherGeo, new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.45 }));
          grp.add(tether);
          labelSprites.push({ sprite: label, routeId: route.id, tether: tether });
        }
        scene.add(grp);
        routeGroups[route.id] = grp;
      });
      // Phase 1: the four merged guideway meshes (was: four meshes per
      // route, ~332 draw calls; now four total). Deck normals are
      // computed on the merged geometry — routes share no vertices, so
      // the result equals the pre-merge per-route computation.
      if (mergedGlow.length) {
        var glowMesh = new THREE.Mesh(mergeGeoms(mergedGlow), glowMatAll);
        glowMesh.frustumCulled = false;
        scene.add(glowMesh);
      }
      if (mergedCase.length) {
        var caseMesh = new THREE.Mesh(mergeGeoms(mergedCase), casingMat);
        caseMesh.frustumCulled = false;
        scene.add(caseMesh);
      }
      if (mergedDeck.length) {
        var deckGeoAll = windingSplitNormals(mergeGeoms(mergedDeck));
        // (Ribbon splintering repair, class 1 -- normal discipline.
        // Plain computeVertexNormals on the merged deck averages face
        // normals across every fold, splitting vertices into +Y/-Y
        // populations; triangles whose winding and dominant normal
        // population disagree shade at ~0.06 luminance against ~1.42
        // lit -- the near-black starburst shards. windingSplitNormals
        // duplicates vertices at winding boundaries so each leg keeps
        // its own population. Uniform up normals were built, measured
        // and rejected during this repair: under the deck's DoubleSide
        // material they flip to down on the downward-winding runs and
        // blacken the whole deck, straight paths included.)
        var deckMesh = new THREE.Mesh(deckGeoAll, deckMatAll);
        deckMesh.frustumCulled = false;
        scene.add(deckMesh);
      }
      if (mergedSkirt.length) {
        var skirtMesh = new THREE.Mesh(mergeGeoms(mergedSkirt), skirtMatAll);
        skirtMesh.frustumCulled = false;
        scene.add(skirtMesh);
      }

      // Stops are rebuilt from stopData by rebuildStops() (per-route colors,
      // paper-white hubs) whenever filters change; see the stops section.
      stopData = data.stops || [];
      try { applyPlanDeepLink(); } catch (e) { errLog('planner', 'deep-link prefill failed: ' + ((e && e.message) || e)); }
      if (typeof window.__setRideData === 'function') {
        window.__setRideData(data.routes || [], stopData);
      }

      // People Mover static layer: built once, toggled independently of the
      // DDOT route filters. Absent (fetch failed) the map simply has no PM layer.
      if (pmData && pmData.loop && pmData.stations) buildPeopleMover(pmData);

      // Belle Isle static layer: built once from the OSM island outline.
      // Absent (fetch failed) the map simply has no island landmass.
      fetch('assets/belle-isle.json?v=' + STAMP)
        .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
        .then(function (B) {
          buildBelleIsle(B);
          // HD topography rides the same optional-layer discipline.
          fetch('assets/belle-isle-topo.json?v=' + STAMP)
            .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
            .then(function (T) { buildBelleIsleTopo(T, B); })
            .catch(function () { /* flat island stands without it */ });
        })
        .catch(function () { /* island is a bonus; map works without it */ });

      // Water + far-shore static layer (project 16): built once from
      // TIGER+OSM geometry. Absent (fetch failed) the map simply has
      // no water layer.
      fetch('assets/detroit-water.json?v=' + STAMP)
        .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
        .then(function (W) { buildWater(W); })
        .catch(function () { /* water is a bonus; map works without it */ });

      /* LANDMARK-MASSING-BEGIN v20261006-1700 — staging-only Phase A.
         True-form OSM landmark massing (single merged mesh, 1 draw call).
         Geometry: /tmp/build_landmarks.py. Revert: delete this block and
         landmarks.json. */
      (function () {
        if (window.__landmarksA) return; window.__landmarksA = true;
        fetch('landmarks.json?v=' + STAMP)
          .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
          .then(function (L) {
            var g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(L.positions, 3));
            g.setIndex(L.index);
            g.computeVertexNormals();
            var mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x484848 }));
            mesh.frustumCulled = false;
            scene.add(mesh);
          })
          .catch(function (e) { console.warn('[landmarks] ' + e.message); });
      })();
      /* LANDMARK-MASSING-END */

      // Alphabetize route lists by route name.
      routeOrder.sort(function (a, b) {
        return (routeNames[a] || '').localeCompare(routeNames[b] || '');
      });
      buildFilterPanel(data.groups);
      applyFilters();
      syncFilterUI();
      rebuildStops();
      // First-view launcher sheet (Concept 3): shown once the map's
      // data has landed, in its persisted open/collapsed state. There
      // is no boot location prompt in any form (deleted above).
      fvInitFirstView();
      $('filter-btn').addEventListener('click', function () { togglePanel(); setBrowse(false); });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') togglePanel(false);
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setBrowse(false); });

      resize();
      setHeader(null, 'connecting…', false);
      fetchHistory();
      maybeRenderHistory();
      poll();
      startAlertsPoll();
      // Hidden-tab backoff (credit saver): while the tab is hidden, skip the
      // 60 s vehicle poll and re-check every 10 min instead. On return to
      // visible, poll immediately and resume the normal cadence.
      var HIDDEN_POLL_MS = 600000;
      var pollTimer = null;
      function schedulePoll() {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(function () {
          pollTimer = null;
          if (!document.hidden) poll();
          schedulePoll();
        }, document.hidden ? HIDDEN_POLL_MS : POLL_MS);
      }
      schedulePoll();
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) { poll(); schedulePoll(); }
      });
      // Empirical motion prior: restore the local speed map, fetch the
      // telemetry timing cells now and hourly; persist the map on hide.
      loadSpeedmap();
      fetchTimingCells();
      setInterval(fetchTimingCells, 3600000);
      window.addEventListener('pagehide', function () {
        try { localStorage.setItem('fl-speedmap-v1', JSON.stringify(localSegs)); } catch (err) {}
      });
      var lastBusMode = null;
      var lastFrameAt = performance.now();
      var wdDeferStreak = 0;
      var ehStuckSince = 0; // step 4a: when the stuck-interaction condition began
      var frameErrStreak = 0;
      var frameErrLogged = false;
      renderer.setAnimationLoop(function () {
        try {
        controls.update();
        // Camera floor: the zoom-to-cursor dolly walks the lens down the
        // pointer ray, and a large wheel/pinch delta can tunnel it straight
        // through the ground plane before the target re-anchors (radius is
        // clamped to the target, not to the terrain). A hard floor keeps the
        // camera out of the geometry on every device and gesture. Placed
        // before the trip fly-through, which drives the camera itself and
        // is unaffected.
        if (camera.position.y < 30) camera.position.y = 30;
        updateLOD();
        if (typeof stepTripFly === 'function') stepTripFly(performance.now());
        stepStreetTween(performance.now());
        stepStreetExtFade(performance.now());
        // Street-view handoff with hysteresis. The trip fly-through owns the
        // camera while active, so street view yields to it.
        var svDist = camera.position.distanceTo(controls.target);
        if (tripFly && streetView) exitStreetView();
        else if (!streetView && !streetTween && !tripFly && svDist < STREET_ENTER_DIST) enterStreetView();
        else if (streetView && !streetTween && !tripFly && svDist > STREET_EXIT_DIST) exitStreetView();
        if (streetView && !tripFly && camera.position.y < STREET_MIN_Y) camera.position.y = STREET_MIN_Y;
        // Per-vehicle motion prediction: buses glide along their shapes
        // between polls instead of jumping every 60 s.
        updateBusMotion(performance.now());
        followTick(); // selected bus stays on screen as it moves
        ridePickTick(); // endpoint labels track their buses (project 11)
        if (youMarker.group.visible) {
          var t = performance.now();
          var s = 1 + 0.22 * Math.sin(t / 420);
          youMarker.ring.scale.set(s, s, s);
          youMarker.badge.position.y = YOU_BADGE_Y +
            (((typeof reducedMotion !== 'undefined') && reducedMotion)
              ? 0 : YOU_BADGE_BOB * Math.sin(t / 650));
          // Logo gate Option 3 (2026-10-21): close-zoom badge clamp.
          // World-true 760 beyond ~3,800 units; nearer than that the
          // badge's apparent size is capped at 25% of viewport height
          // (0.19819 = 0.25 x 2 x tan(21 deg) x 760/736 -- the painted
          // disc is 736 of the 760 sprite, the camera's vertical FOV
          // is 42 deg). The clamp keys on the badge's view-axis DEPTH,
          // not its euclidean distance: apparent size follows depth,
          // so a euclidean key under-caps an off-axis badge by
          // 1/cos(angle off axis) -- the Option 3 harness's S8 case
          // measured the disc at 36-39% of viewport height in strongly
          // off-axis close framings under the euclidean key. On-axis
          // the two keys are identical, so the gate's vantage table
          // is unchanged. The fade pass reads the badge's live scale,
          // so the footprint it fades stays the disc's real one.
          youMarker.badge.getWorldPosition(_badgeClampV);
          _badgeClampV.sub(camera.position);
          _lfD.setFromMatrixColumn(camera.matrixWorld, 2);
          var badgeDepthNow = -_lfD.dot(_badgeClampV);
          var badgeScale = badgeDepthNow > 0
            ? Math.min(760, 0.19819 * badgeDepthNow) : 760;
          if (Math.abs(youMarker.badge.scale.x - badgeScale) > 0.5) {
            youMarker.badge.scale.set(badgeScale, badgeScale, 1);
          }
        }
        // Selected bus pulses at the same rate as the user-location ring.
        // Trip-journey highlight breathes at the same shared rate.
        if (tripGroup.visible && tripMats.length) {
          var tp = 0.72 + 0.28 * Math.sin(performance.now() / 420);
          for (var tmi = 0; tmi < tripMats.length; tmi++) {
            tripMats[tmi].opacity = tripMats[tmi].userData.baseOpacity * tp;
          }
        }
        if (selectedVehicleId) {
          placeBusInfo(); // info label tracks the bus every frame
          var pulse = busPulse();
          if (busMode) {
            for (var pi = 0; pi < DETAIL_MAX; pi++) {
              var pd = detailPool[pi];
              if (pd && pd.group.visible && pd.vehicle && pd.vehicle.vehicle_id === selectedVehicleId) {
                pd.group.scale.set(1.45 * pulse, 1.45 * pulse, 1.45 * pulse);
              }
            }
          } else {
            for (var si = 0; si < busSlots.length; si++) {
              if (busSlots[si].vehicle.vehicle_id === selectedVehicleId) {
                writeBusMatrices(si, busSlots[si], pulse);
                break;
              }
            }
            pillarMeshes.forEach(function (im) { im.instanceMatrix.needsUpdate = true; });
          }
        }
        if (busMode !== lastBusMode) {
          lastBusMode = busMode;
          // Leaving busMode: snap the pillar scale to the current zoom before
          // the rewrite, so wide-out pillars don't flash at street-zoom height.
          if (!busMode) pillarYS = pillarScaleFor(camera.position.distanceTo(controls.target));
          renderBusInstances();
        }
        // Label rule: route enabled, not confirmed not-running, AND (live buses
        // on the route with a bus running). Midpoint labels hide at street zoom
        // (< 7 km) where bus badges and street names take over.
        // Project 16 first-load label-density rule: the map labels what is
        // alive and what orients you, nothing else. A route chip therefore
        // shows only while its route has a live bus, at every distance —
        // the former camDist > 15000 clause lit all 45 route chips in the
        // founding frame, most of them naming routes with nothing running.
        var camDist = camera.position.distanceTo(controls.target);
        // LOD: local streets and stops declutter at city-scale zooms.
        // The 22,000 m ceiling is also the standing bound on any home
        // distance (Project 16): home is 12,500 m since the 2026-10-18
        // overhaul (Option A), which keeps local streets on at home
        // with 9,500 m of headroom; a home distance at or above this
        // ceiling would lose them and must re-set it in the same build.
        if (streetLocal) streetLocal.visible = camDist < 22000;
        // Extension local tier obeys the same declutter rule (group
        // visibility still gates whether it renders at all).
        if (streetExtLocal) streetExtLocal.visible = camDist < 22000;
        if (stopGroup) stopGroup.visible = camDist < STOP_LOD_DIST;
        for (var i = 0; i < labelSprites.length; i++) {
          var L = labelSprites[i];
          var lvis = runningState[L.routeId] !== 'not-running' &&
            (liveCounts[L.routeId] > 0) && camDist > 7000 &&
            routeNearOk(L.routeId);
          L.sprite.visible = lvis;
          if (L.tether) L.tether.visible = lvis;
        }
        // People Mover label: static layer, so its visibility follows only
        // the layer toggle and the street-zoom declutter rule — never the
        // live-running state, which must not imply vehicles exist.
        if (pmLabel) {
          var pmLvis = pmGroup.visible && camDist > 7000;
          pmLabel.visible = pmLvis;
          if (pmTether) pmTether.visible = pmLvis;
        }
        // Belle Isle place label: static geography, so visibility follows only
        // the street-zoom declutter rule — hidden at street zoom where street
        // names take over, same as the People Mover label.
        if (belleIsleLabel) {
          var biLvis = camDist > 7000;
          belleIsleLabel.visible = biLvis;
          if (belleIsleTether) belleIsleTether.visible = biLvis;
        }
        // Project 16 water / far-shore place labels: same static-geography
        // family rule as the Belle Isle label above.
        for (var wi = 0; wi < waterLabels.length; wi++) {
          var wvis = camDist > 7000;
          waterLabels[wi].sprite.visible = wvis;
          if (waterLabels[wi].tether) waterLabels[wi].tether.visible = wvis;
        }
        // MoGo bikeshare: count badges appear at close zoom only
        // (declutter rule, same family as the route labels above).
        if (typeof mogoFrameTick === 'function') mogoFrameTick(camDist);
        if (typeof placesFrameTick === 'function') placesFrameTick(camDist);
        if (stopHighlight.visible) {
          var shp = busPulse();
          // Project 21: the ring hugs the pylon base — the base now
          // carries the XZ prominence scale at city distances.
          var shx = shp * stopXZS;
          stopHighlight.scale.set(shx, shx, 1);
        }
        // Project 21: stop labels place before street labels so the
        // street pass can yield them screen space (stopLabelRects).
        updateStopLabels();
        updateStreetLabels();
        easePillarScale(camDist);
        easeStopScale(camDist);
        easeGuideFade();
        smoothBadges();
        applyLogoFade();
        renderer.render(scene, camera);
        lastFrameAt = performance.now();
        flFrameAt = lastFrameAt; // step 1/4: snapshot mirror + supervisors
        ehFrameTick(lastFrameAt);
        frameErrStreak = 0;
        } catch (frameErr) {
          // Frame guard (2026-10-16, crash fix F2): before this, the loop
          // body had no try/catch at any level — one throwing frame
          // froze the last picture silently, forever. A throw now costs
          // one frame; 120 consecutive thrown frames hand over to the
          // same recovery path as a lost context.
          frameErrStreak++;
          if (!frameErrLogged) { frameErrLogged = true; errLog('render', 'frame error: ' + ((frameErr && frameErr.message) || String(frameErr)), frameErr); }
          if (frameErrStreak >= 120) ladderReload('frames');
        }
      });
      // Restore the camera + route selection a recovery reload saved
      // (2026-11-05): one-shot, 10-minute freshness window.
      try {
        var flSaved = sessionStorage.getItem('fl-state');
        if (flSaved) {
          sessionStorage.removeItem('fl-state');
          var flSs = JSON.parse(flSaved);
          if (flSs && Date.now() - (flSs.at || 0) < 600000) {
            if (flSs.cam && flSs.tgt) {
              camera.position.fromArray(flSs.cam);
              controls.target.fromArray(flSs.tgt);
              controls.update();
            }
            if (flSs.route && routeById[flSs.route] && routeShown(routeById[flSs.route])) showRoute(routeById[flSs.route]);
          }
        }
      } catch (e) {}
      // Frame watchdog (2026-10-16, crash fix F2): covers what the
      // context listener and the frame guard cannot — a context lost
      // without an event, or a loop that stopped producing frames.
      // Hidden time never counts as staleness (the browser suspends the
      // loop legitimately), and becoming visible resets the clock.
      setInterval(function () {
        if (document.hidden || recovering) return;
        var gl = null;
        try { gl = renderer.getContext(); } catch (e) {}
        if (gl && gl.isContextLost()) { ladderReload('watchdog'); return; }
        if (lastFrameAt && performance.now() - lastFrameAt <= 5000) wdDeferStreak = 0;
        if (lastFrameAt && performance.now() - lastFrameAt > 5000) {
          // Interaction guard (2026-11-05, owner directive): a frame gap
          // during or just after active input is jank under the rider's
          // hand, not a dead loop — defer the reload and hand the loop a
          // fresh window. Four consecutive deferrals (a >20 s gap with
          // fresh input) still reload: genuine-hang recovery is intact,
          // and any reload that does fire now restores camera+selection.
          if (performance.now() - lastInputAt < 10000 && wdDeferStreak < 4) {
            wdDeferStreak++;
            lastFrameAt = performance.now();
            errLog('watchdog', 'frame-gap reload deferred during interaction (#' + wdDeferStreak + ')');
            return;
          }
          ladderReload('watchdog'); return;
        }
        // Step 4a: stuck-interaction detector. Frames are fresh (the
        // checks above passed) yet controls are disabled with no
        // animation owning the camera, held for > 10 s: a path disabled
        // the controls and never completed. Gentle reset (ladder L1) —
        // the app simply responds again; no reload, no surface unless
        // the ladder escalates.
        var animOwner = tripFly || streetTween;
        if (controls && controls.enabled === false && !animOwner) {
          if (!ehStuckSince) ehStuckSince = performance.now();
          else if (performance.now() - ehStuckSince > 10000) {
            ehStuckSince = 0;
            ladderFire('interaction', function () {
              cancelTripFly();
              cancelStreetTween();
              controls.enabled = true;
            });
          }
        } else {
          ehStuckSince = 0;
          if (ladderCounts.interaction > 0 && ladderLastFire.interaction &&
              Date.now() - ladderLastFire.interaction > 60000) ladderCounts.interaction = 0;
        }
      }, 2000);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) lastFrameAt = performance.now();
      });
    })
    .catch(function () {
      fail('Could not load route data. Please check your connection and reload.');
    });

  resize();
})();