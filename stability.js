// Detroit Automation Academy — stability & adaptive quality for the 3D district.
// Companion to site/world3d.js: device tiering, an adaptive-quality governor,
// WebGL context-loss handling, background-tab pause, a time-sliced task
// runner, and GPU disposal helpers. Loads synchronously (defer) before
// world3d.js; adds no loader step. The scene runs fine without it — every
// hook is guarded. Exposes window.DAAStability.
(function () {
  'use strict';

  // ---- device tiers: conservative first guess, the governor corrects it ----
  function detectTier() {
    try {
      var mem = navigator.deviceMemory || 0; // GB; Chromium-only, 0 = unknown
      var cores = navigator.hardwareConcurrency || 0;
      var coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      var small = Math.min(window.screen.width || 9999, window.screen.height || 9999) < 760;
      if ((mem > 0 && mem <= 4) || (cores > 0 && cores <= 4) || (coarse && small)) return 'low';
      if (coarse || small || (mem > 0 && mem <= 6)) return 'mid';
      return 'high';
    } catch (e) { return 'mid'; }
  }

  // ---- adaptive quality: tier 0 full → tier 3 minimal ----
  // Steps down when the frame-time EMA sits over budget for a sustained
  // window (~1.5 s); steps back up after ~10 s of headroom. Shadow toggling
  // flips a light flag (one shader re-key, no scene rebuild); far-field
  // density hides the single R4 group. All transitions are rare by design.
  // iPadOS: the launch tier is DPR 1 with shadows OFF on every device.
  // Higher fidelity is EARNED — stepUp() only fires after ~10 s of measured
  // frame-time headroom, so a device never pays for pixels or shadow maps
  // it can't afford. Over-budget frames step back down just as fast.
  var TIERS = [
    { dpr: 1,   shadows: false, farField: true  }, // 0 — launch (DPR 1, no shadows)
    { dpr: 1,   shadows: true,  farField: true  }, // 1 — shadows earned
    { dpr: 1.5, shadows: true,  farField: true  }, // 2 — DPR 1.5 earned
    { dpr: 2,   shadows: true,  farField: true  }, // 3 — full fidelity, earned
    { dpr: 1,   shadows: false, farField: false }  // 4 — minimal (sustained over-budget)
  ];
  var OVER_MS = 24, UNDER_MS = 13;      // frame-time EMA thresholds
  var OVER_FRAMES = 90, UNDER_FRAMES = 600;

  function create(opts) {
    opts = opts || {};
    var renderer = opts.renderer, sun = opts.sun, mount = opts.mount;
    var onPause = (typeof opts.onPause === 'function') ? opts.onPause : function () {};
    var tierIndex = 0, farField = null;
    var ema = 16.7, overBudget = 0, underBudget = 0;
    var paused = false, notice = null;

    var deviceTier = detectTier();
    // Every device launches at tier 0 (DPR 1, no shadows): fidelity is
    // earned through measured headroom, never assumed. deviceTier is still
    // reported via deviceTier() for telemetry.
    tierIndex = 0;

    function devicePR() {
      try { return window.devicePixelRatio || 1; } catch (e) { return 1; }
    }
    function applyTier() {
      var t = TIERS[tierIndex];
      try { renderer.setPixelRatio(Math.min(devicePR(), t.dpr)); } catch (e) {}
      if (sun) { try { sun.castShadow = t.shadows; } catch (e) {} }
      if (farField) { try { farField.visible = t.farField; } catch (e) {} }
    }
    function stepDown() {
      if (tierIndex < TIERS.length - 1) {
        tierIndex++; applyTier(); overBudget = 0;
      }
    }
    function stepUp() {
      if (tierIndex > 0) { tierIndex--; applyTier(); underBudget = 0; }
    }
    function sample(dtMs) {
      if (!(dtMs > 0)) return;
      ema += (dtMs - ema) * 0.05;
      if (ema > OVER_MS) { overBudget++; underBudget = 0; }
      else if (ema < UNDER_MS) { underBudget++; overBudget = 0; }
      else { overBudget = 0; underBudget = 0; }
      if (overBudget >= OVER_FRAMES) stepDown();
      else if (underBudget >= UNDER_FRAMES) stepUp();
    }
    function setPaused(p) {
      if (p === paused) return;
      paused = p;
      try { onPause(p); } catch (e) {}
    }

    // ---- WebGL context loss ----
    // three.js re-initializes the GL context on restore itself; we own the
    // user-facing state: pause the loop and show a recoverable message.
    function showNotice(text) {
      hideNotice();
      if (!mount || !mount.appendChild) return;
      var d = document.createElement('div');
      d.className = 'world3d-stability-notice';
      d.textContent = text;
      d.setAttribute('role', 'status');
      d.style.cssText = 'position:absolute;left:50%;top:14px;transform:translateX(-50%);' +
        'z-index:5;max-width:88%;padding:10px 16px;border-radius:999px;' +
        'background:rgba(16,16,16,0.92);border:1px solid #7F7F7F;color:#F2F2F2;' +
        'font:600 0.8rem system-ui,-apple-system,sans-serif;text-align:center;cursor:pointer;';
      d.addEventListener('click', function () { hideNotice(); setPaused(false); });
      mount.appendChild(d);
      notice = d;
    }
    function hideNotice() {
      if (notice && notice.parentNode) {
        try { notice.parentNode.removeChild(notice); } catch (e) {}
      }
      notice = null;
    }
    if (renderer && renderer.domElement) {
      var canvas = renderer.domElement;
      canvas.addEventListener('webglcontextlost', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        showNotice('Graphics paused — tap here to retry.');
        setPaused(true);
      }, false);
      canvas.addEventListener('webglcontextrestored', function () {
        hideNotice();
        setPaused(false);
      }, false);
    }

    // ---- background tab: never burn frames or battery while hidden ----
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        try { setPaused(document.hidden === true); } catch (e) {}
      }, false);
    }

    applyTier();

    return {
      sample: sample,
      setFarField: function (obj) { farField = obj || null; applyTier(); },
      setPaused: setPaused,
      isPaused: function () { return paused; },
      tier: function () { return tierIndex; },
      deviceTier: function () { return deviceTier; },
      frameMs: function () { return Math.round(ema * 10) / 10; },
      // Live telemetry for the iOS command bridge (window.DAAWorld.perf()).
      perf: function () {
        var info = null;
        try { info = renderer.info; } catch (e) {}
        return {
          tier: tierIndex,
          deviceTier: deviceTier,
          frameMs: Math.round(ema * 10) / 10,
          calls: info && info.render ? info.render.calls : -1,
          triangles: info && info.render ? info.render.triangles : -1,
          geometries: info && info.memory ? info.memory.geometries : -1,
          textures: info && info.memory ? info.memory.textures : -1
        };
      }
    };
  }

  // ---- time-sliced task runner ----
  // Runs tasks across animation frames inside a per-frame time budget so a
  // heavy build never blocks first paint with one long task. Failed tasks
  // log and continue; the queue always drains.
  function runSliced(tasks, msBudget, onDone) {
    var queue = (tasks || []).slice(), budget = msBudget || 8;
    function pump() {
      var t0 = 0;
      try { t0 = performance.now(); } catch (e) {}
      while (queue.length) {
        var task = queue.shift();
        try { task(); } catch (e) {
          if (window.console && console.warn) console.warn('[stability] sliced task failed:', e);
        }
        var now = 0;
        try { now = performance.now(); } catch (e) {}
        if (now - t0 > budget) break;
      }
      if (queue.length) {
        if (window.requestAnimationFrame) window.requestAnimationFrame(pump);
        else setTimeout(pump, 0);
      } else if (typeof onDone === 'function') {
        try { onDone(); } catch (e) {}
      }
    }
    pump();
  }

  // ---- GPU disposal: walk an Object3D and release geometries, materials,
  // and textures. For rebuilt overlays — nothing in the scene rebuilds today,
  // but the path exists so a future rebuild cannot leak. ----
  function disposeObject(root) {
    if (!root || !root.traverse) return;
    try {
      root.traverse(function (o) {
        if (o.geometry && typeof o.geometry.dispose === 'function') {
          try { o.geometry.dispose(); } catch (e) {}
        }
        var mats = !o.material ? [] :
          (typeof o.material.length === 'number' ? o.material : [o.material]);
        for (var i = 0; i < mats.length; i++) {
          var m = mats[i];
          if (!m) continue;
          for (var k in m) {
            if (m[k] && m[k].isTexture && typeof m[k].dispose === 'function') {
              try { m[k].dispose(); } catch (e) {}
            }
          }
          if (typeof m.dispose === 'function') { try { m.dispose(); } catch (e) {} }
        }
      });
    } catch (e) {}
  }

  // ---- boot journal: crash telemetry without a server ----
  // The screenshot IS the telemetry: when a tab dies mid-build on iOS there
  // is no error event, no beacon, nothing. So we journal the boot in
  // sessionStorage BEFORE the heavy work starts and clear it after the first
  // successful frame. A journal left behind means the previous boot never
  // reached first frame -> the next boot enters 'safe' mode (reduced
  // district, far-field only on explicit user action) instead of crashing
  // the same way again. A clean pagehide clears the journal so navigating
  // away is never mistaken for a crash.
  var JOURNAL_KEY = 'daa3d_boot_v1';
  var JOURNAL_TTL_MS = 10 * 60 * 1000;
  function readJournal() {
    try {
      var raw = (typeof sessionStorage !== 'undefined') ?
        sessionStorage.getItem(JOURNAL_KEY) : null;
      if (!raw) return null;
      var j = JSON.parse(raw);
      return (j && j.t) ? j : null;
    } catch (e) { return null; }
  }
  function writeJournal(stage, mode) {
    try {
      if (typeof sessionStorage === 'undefined') return;
      sessionStorage.setItem(JOURNAL_KEY, JSON.stringify({
        t: Date.now(), stage: stage || '', mode: mode || ''
      }));
    } catch (e) {}
  }
  function clearJournal() {
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(JOURNAL_KEY);
    } catch (e) {}
  }

  // ---- boot mode: decided BEFORE three.js loads, BEFORE any geometry ----
  // 'full': desktop-class device, no crash history — build everything.
  // 'lite': constrained device (all iPhones land here: WebKit reports
  //   hardwareConcurrency <= 4 and deviceMemory is undefined) — boot the
  //   core district, stream the 1 sq mi surrounding ring after first frame
  //   on idle.
  // 'safe': the journal says the last boot died before first frame — boot
  //   the core district only; the surrounding ring is skipped. Never build
  //   the far field synchronously on a phone.
  function detectBootMode() {
    try {
      var j = readJournal();
      if (j && (Date.now() - j.t) < JOURNAL_TTL_MS) return 'safe';
    } catch (e) {}
    return detectTier() === 'low' ? 'lite' : 'full';
  }

  // ---- idle scheduler: requestIdleCallback is absent in WebKit ----
  function whenIdle(fn, waitMs) {
    var wait = (typeof waitMs === 'number') ? waitMs : 1500;
    try {
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        window.requestIdleCallback(function () { fn(); }, { timeout: 6000 });
        return;
      }
    } catch (e) {}
    setTimeout(fn, wait);
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', function () { clearJournal(); });
  }

  if (typeof window !== 'undefined') {
    window.DAAStability = {
      create: create,
      runSliced: runSliced,
      disposeObject: disposeObject,
      detectTier: detectTier,
      detectBootMode: detectBootMode,
      readJournal: readJournal,
      writeJournal: writeJournal,
      clearJournal: clearJournal,
      whenIdle: whenIdle
    };
  }
})();
