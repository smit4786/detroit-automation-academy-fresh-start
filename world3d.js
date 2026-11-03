// Detroit Automation Academy — interactive 3D training district.
// Lazy-loaded Three.js viewer. STL geometry is modeled parametrically in
// cad/world.scad (OpenSCAD) and exported per part. Exposes window.DAAWorld
// so the terminal in script.js can drive the 3D bot; if WebGL/CDN fails,
// the caller falls back to the SVG bot and nothing breaks.
(function () {
  'use strict';

  var stage = document.getElementById('demoStage');
  var mount = document.getElementById('world3d');
  if (!stage || !mount) return;

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // three.js coords: x = east, z = south (OpenSCAD +y/north maps to -z).
  // pos values are road-side approach points, kept clear of building
  // footprints so the bot is never occluded inside a mesh.
  var DISTRICT = {
    workshop:   { pos: [0, 24],   name: 'The Workshop',     color: 0x7F7F7F,
      desc: 'Home base. Workbenches, spare servos, the smell of solder.' },
    innovation:   { pos: [0, -16],  name: 'UM Center for Innovation', color: 0x555555,
      desc: 'U-M\u2019s Detroit innovation hub \u2014 six stories of glass leaning into the future.' },
    hq:         { pos: [19, 0],   name: 'Academy HQ', color: 0xbbbbbb,
      desc: 'The new Detroit Automation Academy headquarters in Corktown — glass, brick, and big plans.' },
    riverfront: { pos: [0, 30],   name: 'Detroit Riverfront', color: 0x9F9F9F,
      desc: 'Wind off the water, skyline at your back.' },
    thinkabit:  { pos: [-26, 0],  name: 'Thinkabit Lab',    color: 0xB4B4B4,
      desc: 'A STEM lab buzzing with kits and big questions.' }
  };
  var PARTS = [
    ['ground', 0x151515, 1.0, 0.0], ['roads', 0x3f3f3f, 1.0, 0.0],
    ['water', 0x595959, 0.35, 0.4],
    ['trees', 0x606060, 1.0, 0.0], ['street', 0x6f6f6f, 0.6, 0.4]
  ];
  // NOTE: 'workshop', 'techtown', 'thinkabit' and 'riverfront' are no longer
  // STLs — the procedural SC3K-standard builds from window.DAAArchKit
  // (site/js/arch-kit.js) replace assets/world/workshop.stl,
  // assets/world/techtown.stl, assets/world/thinkabit.stl and
  // assets/world/riverfront.stl.

  // [DRONE-PHYSICS-START]
  // Personal quadcopter flight model — pure math, no THREE or DOM, so the
  // Node harness (overnight-2026-10-01/drone-physics-harness.js) extracts
  // this block verbatim and tests it headless. True-scale SI units throughout
  // (meters, seconds, kilograms). Semi-implicit Euler with substeps (<=1/120 s).
  function DronePhysics() {
    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
    var C = {
      MASS: 1.8, GRAV: 9.81,
      MAX_THRUST: 2.2 * 1.8 * 9.81, // T/W = 2.2 — a sporty personal quadcopter
      DRAG_K: 0.07,                 // quadratic drag coefficient (terminal ~16 m/s)
      MAX_TILT: 25 * Math.PI / 180, // max commanded tilt, radians
      GEAR_H: 0.43,                 // body-center height resting on the skids
      CEILING: 60,                  // max altitude, meters
      BOUND: 126,                   // district half-extent, meters
      RADIUS: 0.8                   // collision radius, meters
    };
    C.WEIGHT = C.MASS * C.GRAV;
    C.HOVER = C.WEIGHT / C.MAX_THRUST; // ≈ 0.4545 — throttle that exactly holds weight
    // Measured building footprints, Oct 2026 (true solids — soft push-out).
    var BUILDINGS = [
      { x0: -13.3, x1: 13.3, z0: -10.3, z1: 11.7, top: 14.8 },  // Workshop
      { x0: -17.4, x1: 17.4, z0: -12.4, z1: 16.1, top: 36.6 },  // Academy HQ
      { x0: 27.3,  x1: 64.4, z0: -45.2, z1: 22.0, top: 36.6 },  // Corktown
      { x0: -22.0, x1: 28.8, z0: -53.3, z1: -10.0, top: 24.3 }, // UMCI
      { x0: -58.5, x1: -29.3, z0: -8.1, z1: 14.0, top: 9.9 },   // Thinkabit
      { x0: -17.0, x1: 17.0, z0: 31.0, z1: 52.6, top: 9.2 }     // Riverfront
    ];

    function create(px, pz) {
      return {
        px: px || 0, py: C.GEAR_H, pz: (pz === undefined ? 24 : pz),
        vx: 0, vy: 0, vz: 0,
        yaw: 0, pitch: 0, roll: 0,
        throttle: 0, mode: 'ground', armed: false, planT: 0,
        turnTarget: null, plan: null,
        gear: 0, gearV: 0 // landing-gear spring compression, meters
      };
    }

    function angDiff(a, b) {
      var d = a - b;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return d;
    }

    function startTakeoff(s) {
      s.armed = true; s.mode = 'takeoff'; s.planT = 0;
    }

    // Ground contact with downward speed: disarm, kill horizontal energy,
    // kick the gear spring. Returns a flight-plan completion callback, if any.
    function touchdown(s, impact) {
      s.mode = 'ground'; s.armed = false;
      s.vx *= 0.15; s.vz *= 0.15;
      s.gearV += Math.min(impact, 4) * 0.35;
      var done = null;
      if (s.plan && s.plan.phase === 'descend') { done = s.plan.done; s.plan = null; }
      return done;
    }

    // 2D segment vs expanded AABB (cruise-altitude planning)
    function segHitsBox(x0, z0, x1, z1, b, pad) {
      for (var i = 0; i <= 24; i++) {
        var t = i / 24, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
        if (x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad) return true;
      }
      return false;
    }

    function cruiseFor(x0, z0, x1, z1) {
      var c = 12;
      for (var i = 0; i < BUILDINGS.length; i++) {
        var b = BUILDINGS[i];
        if (segHitsBox(x0, z0, x1, z1, b, 3) && b.top + 6 > c) c = b.top + 6;
      }
      return Math.min(c, C.CEILING - 5);
    }

    // Flight plan (go <place>) → velocity commands. Called once per frame.
    function updatePlan(s, cmd) {
      var p = s.plan;
      if (!p) return;
      var dx = p.x - s.px, dz = p.z - s.pz;
      var dist = Math.sqrt(dx * dx + dz * dz);
      cmd.cvx = 0; cmd.cvz = 0; cmd.cvy = 0;
      if (p.phase === 'start') {
        if (!s.armed && s.mode === 'ground') startTakeoff(s);
        cmd.cvy = 3;
        s.turnTarget = Math.atan2(-dx, -dz);
        if (s.py >= p.cruise - 0.5) p.phase = 'cruise';
      } else if (p.phase === 'cruise') {
        if (dist < 2.0) { p.phase = 'descend'; return; }
        var sp = Math.min(9, dist * 1.2);
        cmd.cvx = dx / dist * sp; cmd.cvz = dz / dist * sp;
        cmd.cvy = clamp((p.cruise - s.py) * 1.5, -2, 2);
        s.turnTarget = Math.atan2(-dx, -dz);
      } else if (p.phase === 'descend') {
        if (dist > 0.05) {
          var sp2 = Math.min(3, Math.max(0.8, dist));
          cmd.cvx = dx / dist * sp2; cmd.cvz = dz / dist * sp2;
        }
        cmd.cvy = -1.2;
      }
    }

    // Returns a flight-plan completion callback, or null.
    // True when (px, pz, py) is inside any building solid other than index skip.
    function solidAt(px, pz, py, skip) {
      for (var j = 0; j < BUILDINGS.length; j++) {
        if (j === skip) continue;
        var c = BUILDINGS[j];
        if (px > c.x0 && px < c.x1 && pz > c.z0 && pz < c.z1 && py < c.top) return true;
      }
      return false;
    }

    function substep(s, dt, cmd) {
      var planDone = null;
      var airborne = (s.mode !== 'ground');
      // --- attitude: tilt-to-move. Horizontal velocity error → tilt commands;
      // thrust follows the tilted body-up axis, which is what actually moves it.
      if (airborne) {
        var amax = C.GRAV * Math.tan(C.MAX_TILT);
        var kV = 3.0;
        var axc = clamp((cmd.cvx - s.vx) * kV, -amax, amax);
        var azc = clamp((cmd.cvz - s.vz) * kV, -amax, amax);
        var sy = Math.sin(s.yaw), cy = Math.cos(s.yaw);
        var af = -axc * sy - azc * cy; // forward component (+ = forward)
        var ar = axc * cy - azc * sy;  // right component (+ = right)
        var pitchT = clamp(-Math.atan(af / C.GRAV), -C.MAX_TILT, C.MAX_TILT);
        var rollT = clamp(-Math.atan(ar / C.GRAV), -C.MAX_TILT, C.MAX_TILT);
        var ka = Math.min(1, 10 * dt);
        s.pitch += (pitchT - s.pitch) * ka;
        s.roll += (rollT - s.roll) * ka;
      } else {
        var kd = Math.min(1, 8 * dt);
        s.pitch *= (1 - kd); s.roll *= (1 - kd);
      }
      // --- yaw ---
      if (s.turnTarget !== null) {
        var dd = angDiff(s.turnTarget, s.yaw);
        var myaw = 2.5 * dt;
        s.yaw += clamp(dd, -myaw, myaw);
        if (Math.abs(dd) < 0.02) s.turnTarget = null;
      }
      // --- throttle ---
      var thrT = 0;
      if (s.mode === 'takeoff') {
        s.planT += dt;
        thrT = Math.min(0.85, 0.30 + s.planT * 0.30); // spool-up ramp
        if (s.py > C.GEAR_H + 0.5) s.mode = 'air';    // liftoff
      } else if (s.mode === 'air' || s.mode === 'landing') {
        // vertical-velocity P controller around hover throttle (altitude assist)
        thrT = clamp(C.HOVER + (cmd.cvy - s.vy) * 0.10, 0.15, 0.95);
      }
      s.throttle += (thrT - s.throttle) * Math.min(1, 6 * dt);
      // --- forces ---
      if (!airborne) {
        // taxi: kinematic ground slide, no momentum carried
        var spd = 3.0;
        s.px += clamp(cmd.cvx, -spd, spd) * dt;
        s.pz += clamp(cmd.cvz, -spd, spd) * dt;
        s.vx = 0; s.vy = 0; s.vz = 0;
        s.py = C.GEAR_H;
      } else {
        // thrust along the body-up axis (yaw/pitch/roll applied YXZ)
        var sp = Math.sin(s.pitch), cp = Math.cos(s.pitch);
        var sr = Math.sin(s.roll), cr = Math.cos(s.roll);
        var syy = Math.sin(s.yaw), cyy = Math.cos(s.yaw);
        var ux = -sr * cp * cyy + sp * syy;
        var uy = cr * cp;
        var uz = sr * cp * syy + sp * cyy;
        var T = s.throttle * C.MAX_THRUST;
        var fx = ux * T, fy = uy * T - C.WEIGHT, fz = uz * T;
        // quadratic aerodynamic drag
        var vmag = Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz);
        var dk = C.DRAG_K * vmag;
        fx -= dk * s.vx; fy -= dk * s.vy; fz -= dk * s.vz;
        // semi-implicit Euler
        s.vx += fx / C.MASS * dt;
        s.vy += fy / C.MASS * dt;
        s.vz += fz / C.MASS * dt;
        s.vy = clamp(s.vy, -6, 6);
        s.px += s.vx * dt; s.py += s.vy * dt; s.pz += s.vz * dt;
      }
      // --- ground collision (skids) ---
      if (s.py <= C.GEAR_H) {
        s.py = C.GEAR_H;
        var impact = -s.vy;
        s.vy = 0;
        // sitting on the pad during spool-up is normal — no touchdown event
        if (impact > 0.05 && airborne && s.mode !== 'takeoff') planDone = touchdown(s, impact);
      }
      // --- ceiling ---
      if (s.py > C.CEILING) { s.py = C.CEILING; if (s.vy > 0) s.vy = 0; }
      // --- buildings: hard push-out of solids, soft cushion in the margin ---
      // Expanded footprints can overlap (Workshop/UMCI share a 0.3 m seam), so
      // a blind push can land inside a neighbor. The hard rule is only ever
      // "never inside an actual solid"; the margin just kills inbound velocity.
      for (var pass = 0; pass < 2; pass++) {
        var settled = true;
        for (var i = 0; i < BUILDINGS.length; i++) {
          var b = BUILDINGS[i], r = C.RADIUS;
          var inX = s.px > b.x0 - r && s.px < b.x1 + r;
          var inZ = s.pz > b.z0 - r && s.pz < b.z1 + r;
          if (!(inX && inZ && s.py < b.top + r)) continue;
          var solidX = s.px > b.x0 && s.px < b.x1;
          var solidZ = s.pz > b.z0 && s.pz < b.z1;
          if (solidX && solidZ && s.py < b.top) {
            // inside the solid: push out along the min-penetration axis whose
            // landing spot is clear of every other solid (nearest valid first)
            var dxl = s.px - (b.x0 - r), dxr = (b.x1 + r) - s.px;
            var dzl = s.pz - (b.z0 - r), dzr = (b.z1 + r) - s.pz;
            var cands = [
              { x: b.x0 - r, z: s.pz, d: dxl, axis: 'x', neg: true },
              { x: b.x1 + r, z: s.pz, d: dxr, axis: 'x', neg: false },
              { x: s.px, z: b.z0 - r, d: dzl, axis: 'z', neg: true },
              { x: s.px, z: b.z1 + r, d: dzr, axis: 'z', neg: false }
            ];
            cands.sort(function (p, q) { return p.d - q.d; });
            var placed = false;
            for (var k = 0; k < cands.length; k++) {
              var cd = cands[k];
              if (solidAt(cd.x, cd.z, s.py, i)) continue;
              s.px = cd.x; s.pz = cd.z;
              if (cd.axis === 'x' && ((cd.neg && s.vx > 0) || (!cd.neg && s.vx < 0))) s.vx = 0;
              if (cd.axis === 'z' && ((cd.neg && s.vz > 0) || (!cd.neg && s.vz < 0))) s.vz = 0;
              placed = true;
              break;
            }
            if (!placed) { s.vx *= 0.5; s.vz *= 0.5; } // boxed in: bleed energy
            settled = false;
          } else {
            // margin cushion: kill velocity heading into the wall, keep position
            if (inX && s.pz <= b.z0 && s.vz > 0) s.vz = 0; // north of it, moving south
            if (inX && s.pz >= b.z1 && s.vz < 0) s.vz = 0; // south of it, moving north
            if (inZ && s.px <= b.x0 && s.vx > 0) s.vx = 0; // west of it, moving east
            if (inZ && s.px >= b.x1 && s.vx < 0) s.vx = 0; // east of it, moving west
          }
        }
        if (settled) break;
      }
      // --- district bounds ---
      if (s.px < -C.BOUND) { s.px = -C.BOUND; if (s.vx < 0) s.vx = 0; }
      if (s.px > C.BOUND) { s.px = C.BOUND; if (s.vx > 0) s.vx = 0; }
      if (s.pz < -C.BOUND) { s.pz = -C.BOUND; if (s.vz < 0) s.vz = 0; }
      if (s.pz > C.BOUND) { s.pz = C.BOUND; if (s.vz > 0) s.vz = 0; }
      // --- landing-gear spring-damper (visual compression) ---
      var ga = -120 * s.gear - 10 * s.gearV;
      s.gearV += ga * dt;
      s.gear += s.gearV * dt;
      if (s.gear < 0) { s.gear = 0; s.gearV = 0; }
      if (s.gear > 0.15) { s.gear = 0.15; s.gearV = 0; }
      return planDone;
    }

    function step(s, h, cmd) {
      var n = Math.max(1, Math.ceil(h / (1 / 120)));
      var dt = h / n, done = null;
      for (var i = 0; i < n; i++) {
        var r = substep(s, dt, cmd);
        if (r && !done) done = r;
      }
      return done;
    }

    return {
      C: C, BUILDINGS: BUILDINGS, create: create, step: step,
      updatePlan: updatePlan, cruiseFor: cruiseFor,
      startTakeoff: startTakeoff, touchdown: touchdown, clamp: clamp
    };
  }
  // [DRONE-PHYSICS-END]

  function fallback() {
    stage.classList.add('world-fallback');
    // Graceful degradation is a successful outcome, not a crash: a journal
    // left here would wrongly force the next boot into 'safe' mode.
    try { if (window.DAAStability) window.DAAStability.clearJournal(); } catch (e) {}
  }

  // Only boot when the demo scrolls into view; never block page load.
  var booted = false;
  var bootMode = 'full'; // 'full' | 'lite' | 'safe' — decided before three.js loads
  function importMapOK() {
    // Import maps need iOS 16.4+; older WebKit falls back to the 2D SVG.
    try {
      return ('HTMLScriptElement' in window) && ('supports' in HTMLScriptElement) &&
        HTMLScriptElement.supports('importmap');
    } catch (e) { return false; }
  }
  function boot() {
    if (booted) return;
    booted = true;
    var bootT0 = (window.performance && window.performance.now) ? window.performance.now() : 0;
    boot._t0 = bootT0; // picked up by the first-frame block for the boot-time log
    // The boot journal + tier decision happen BEFORE the first byte of
    // geometry: a constrained device (every iPhone) boots a reduced district
    // and streams the surrounding ring later — never the far field up front.
    try {
      if (window.DAAStability && window.DAAStability.detectBootMode) {
        bootMode = window.DAAStability.detectBootMode();
        window.DAAStability.writeJournal('boot', bootMode);
      }
    } catch (e) {}
    if (!importMapOK()) {
      if (window.console && console.warn) console.warn('[world3d] no importmap support; using 2D fallback');
      fallback();
      return;
    }
    Promise.all([
      import('three'),
      import('three/addons/controls/OrbitControls.js'),
      import('three/addons/loaders/STLLoader.js')
    ]).then(function (m) {
        try { if (window.DAAStability) window.DAAStability.writeJournal('three', bootMode); } catch (e) {}
        init(m[0], m[1].OrbitControls, m[2].STLLoader, bootMode);
      })
      .catch(function (e) {
        if (window.console && console.error) console.error('[world3d] init failed:', e);
        fallback();
      });
  }

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { boot(); io.disconnect(); } });
    }, { rootMargin: '400px' });
    io.observe(mount);
  } else {
    boot();
  }

  function init(THREE, OrbitControls, STLLoader, mode) {
    var W = mount.clientWidth || 600, H = mount.clientHeight || 420;
    // 'lite'/'safe': constrained device or a previous crash — reduced
    // district, no MSAA (halves the framebuffer). 'lite' streams the 1 sq mi
    // surrounding ring after first frame on idle; 'safe' skips it entirely.
    var lite = (mode === 'lite' || mode === 'safe');
    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: !lite, alpha: true });
    } catch (e) { fallback(); return; }
    // iPadOS: start at DPR 1. The stability governor (stability.js) owns the
    // pixel ratio after boot and raises it only on measured frame-time
    // headroom — never speculatively.
    renderer.setPixelRatio(1);
    renderer.setSize(W, H);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    var scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x101010, 140, 320);
    var camera = new THREE.PerspectiveCamera(46, W / H, 0.5, 800);
    camera.position.set(58, 52, 58);

    var controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.46;
    controls.minDistance = 18;
    controls.maxDistance = 220;
    controls.target.set(0, 2, 0);

    scene.add(new THREE.HemisphereLight(0xf2f2f2, 0x101010, 0.85));
    var sun = new THREE.DirectionalLight(0xf4f4f4, 1.6);
    sun.position.set(60, 90, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -80; sun.shadow.camera.right = 80;
    sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
    scene.add(sun);

    // Stability: adaptive quality, context-loss handling, background-tab
    // pause. Lives in site/stability.js; the scene runs fine without it.
    var stab = null;
    if (window.DAAStability && window.DAAStability.create) {
      try {
        stab = window.DAAStability.create({
          renderer: renderer, sun: sun, mount: mount,
          onPause: function (p) {
            loopHalted = p;
            if (!p) {
              try { clock.getDelta(); } catch (e) {} // flush the hidden-tab gap
              if (!rafId) tick();
            }
          }
        });
      } catch (e) {
        stab = null;
        if (window.console && console.warn) console.warn('[world3d] stability init failed:', e);
      }
    }

    var manager = new THREE.LoadingManager();
    var loader = new STLLoader(manager);
    // real load progress on the overlay: 5 STL district parts + the bot +
    // the procedural builds (workshop + corktown + innovation + thinkabit +
    // riverfront + guideway via window.DAAArchKit, plus streetscape,
    // furniture, vehicles, district-expansion, groundwork, promenade,
    // region-expansion, chicago-hsr, railways and stations)
    // Rescope (2026-10-01): one square mile. The loader total is computed
    // from the assembled build queue below — the count differs by boot mode,
    // because 'lite' streams the R4 surrounding ring after first frame and
    // 'safe' skips it, instead of building it up front.
    var loadTotal = 0;
    var loadDone = 0;
    var loadCountEl = mount.querySelector('.world3d-count');
    function paintLoadCount(done) {
      if (loadCountEl) loadCountEl.textContent = done + '/' + loadTotal;
    }
    function bumpLoadCount() {
      loadDone += 1;
      paintLoadCount(Math.min(loadDone, loadTotal));
    }
    paintLoadCount(0);
    manager.onProgress = function () { bumpLoadCount(); };

    // ---- sliced construction ----
    // Every module build is one task in a time-sliced queue (8 ms/frame via
    // site/stability.js). The browser paints, runs GC, and keeps the loader
    // honest between modules instead of dying inside one giant synchronous
    // build — the failure mode that killed mobile tabs. A failed module logs
    // and continues; one bad build never strands the district.
    // ---- static geometry merger (2026-10-01 draw-call pass) ----
    // Merges static Meshes by material signature so the sliced build emits
    // far fewer draw calls (iPadOS). material.color is baked into a 'color'
    // vertex attribute under a white base material (bit-exact); meshes whose
    // map textures share one canvas image but use different repeat/offset
    // get the texture uvTransform baked into their UVs and share a single
    // identity-transform texture clone (visually lossless, sub-texel).
    // Animated modules (rail-vehicles, drone-autonomy, rail-multilevel),
    // click targets (hit-discs) and sprites are never passed in.
    // Inline: zero new files, zero new external requests. Deterministic
    // (seeded PRNG only — never Math.random).
    // DAA static-geometry merger (inline, zero new dependencies/requests).
    // mergeStatic(THREE, root) merges static Meshes under root by material
    // signature. Two color/texture strategies keep merged output faithful:
    //  - material.color is baked into a 'color' vertex attribute under a white
    //    base material (bit-exact: color is already in linear working space);
    //  - meshes whose map textures share the same IMAGE but use different
    //    repeat/offset (RepeatWrapping only) get the texture uvTransform baked
    //    into their UVs and share one identity-transform texture clone
    //    (visually lossless: sub-texel <1e-6 UV difference, not bit-exact).
    // Meshes that cannot merge safely are left in place: InstancedMesh/
    // SkinnedMesh, multi-material meshes, non-material materials, morph
    // targets, interleaved attributes. Caller passes only static build-step
    // groups (animated modules are never passed in).
    // Deterministic: no Math.random; Map preserves insertion order.
    var DAA_mergeStatic = (function () {
      var _imgIds = new WeakMap(), _imgNext = 1;
      function imageKey(t) {
        var img = t && t.image;
        if (!img) return 'noimg';
        if (img.src) return 'src:' + img.src;
        var id = _imgIds.get(img);
        if (!id) { id = _imgNext++; _imgIds.set(img, id); }
        return 'cv' + id;
      }
      function texParams(t) {
        return 'w' + t.wrapS + ',' + t.wrapT + 'f' + (t.flipY ? 1 : 0) + 'c' + (t.colorSpace || '');
      }
      function transformKey(t) {
        if (t.matrixAutoUpdate) t.updateMatrix();
        var e = t.matrix.elements;
        return e[0].toFixed(6) + ',' + e[1].toFixed(6) + ',' + e[3].toFixed(6) + ',' +
               e[4].toFixed(6) + ',' + e[6].toFixed(6) + ',' + e[7].toFixed(6);
      }
      return function mergeStatic(THREE, root) {
        var stats = { inMeshes: 0, outMeshes: 0, skipped: 0, buckets: 0, bakedUV: 0, ms: 0 };
        if (!root || !root.traverse) { mergeStatic.stats = stats; return root; }
        var t0 = Date.now();
        root.updateMatrixWorld(true);
        var inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
        var tmpM = new THREE.Matrix4();
        var meshes = [];
        root.traverse(function (o) {
          if (o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh) meshes.push(o);
        });
        stats.inMeshes = meshes.length;
        if (!meshes.length) { mergeStatic.stats = stats; return root; }
        var RepeatW = THREE.RepeatWrapping;
        function sig(m, mesh) {
          var parts = [m.type,
            's' + m.side, 'f' + (m.flatShading ? 1 : 0), 'v' + (m.vertexColors ? 1 : 0),
            'o' + m.opacity, 't' + (m.transparent ? 1 : 0), 'a' + (m.alphaTest || 0),
            'r' + (m.roughness === undefined ? '-' : m.roughness),
            'm' + (m.metalness === undefined ? '-' : m.metalness),
            'e' + (m.emissive ? m.emissive.getHex() : 0),
            'ei' + (m.emissiveIntensity === undefined ? '-' : m.emissiveIntensity),
            'cs' + (mesh.castShadow ? 1 : 0), 'rs' + (mesh.receiveShadow ? 1 : 0),
            'ro' + (mesh.renderOrder || 0), 'vis' + (mesh.visible ? 1 : 0)];
          var bUV = false, emSame = false;
          if (m.map && m.map.isTexture) {
            var tp = texParams(m.map);
            var em = m.emissiveMap;
            if (em && em !== m.map) {
              parts.push('mapimg' + imageKey(m.map) + '|' + tp + '|' + transformKey(m.map));
              parts.push('emapimg' + imageKey(em) + '|' + texParams(em) + '|' + transformKey(em));
            } else {
              emSame = !!em;
              if (m.map.wrapS === RepeatW && m.map.wrapT === RepeatW) {
                parts.push('mapimg' + imageKey(m.map) + '|' + tp + '|BAKE');
                bUV = true;
              } else {
                parts.push('mapimg' + imageKey(m.map) + '|' + tp + '|' + transformKey(m.map));
              }
            }
          } else {
            parts.push('nomap');
            if (m.emissiveMap) parts.push('emaponly' + imageKey(m.emissiveMap));
          }
          return { key: parts.join('|'), bakeUV: bUV, emSame: emSame };
        }
        var buckets = new Map(), order = [];
        var i, mesh, m, g;
        for (i = 0; i < meshes.length; i++) {
          mesh = meshes[i]; m = mesh.material; g = mesh.geometry;
          var okm = m && m.isMaterial && typeof m.clone === 'function' && !Array.isArray(m) &&
            g && g.isBufferGeometry &&
            !(g.morphAttributes && Object.keys(g.morphAttributes).some(function (k) {
              return g.morphAttributes[k] && g.morphAttributes[k].length; }));
          if (okm) {
            for (var an in g.attributes) {
              if (g.attributes[an].isInterleavedBufferAttribute) { okm = false; break; }
            }
            if (okm && m.map && m.map.isTexture && !g.attributes.uv) okm = false;
          }
          if (!okm) { stats.skipped++; continue; }
          var s = sig(m, mesh);
          var k = s.key + '#' + Object.keys(g.attributes).sort().join(',');
          var b = buckets.get(k);
          if (!b) {
            b = { mat: m, bake: !m.vertexColors, bakeUV: s.bakeUV, emSame: s.emSame, items: [] };
            buckets.set(k, b); order.push(k);
          }
          b.items.push(mesh);
        }
        stats.buckets = order.length;
        var WHITE = new THREE.Color(0xffffff);
        for (i = 0; i < order.length; i++) {
          var b2 = buckets.get(order[i]);
          if (b2.items.length < 2) { stats.skipped += b2.items.length; continue; }
          var geoms = [], good = true, gi;
          var sharedTex = null;
          for (gi = 0; gi < b2.items.length; gi++) {
            mesh = b2.items[gi];
            var src = mesh.geometry;
            var ng = src.index ? src.toNonIndexed() : src.clone();
            tmpM.copy(inv).multiply(mesh.matrixWorld);
            ng.applyMatrix4(tmpM);
            if (b2.bakeUV) {
              var tx = mesh.material.map;
              if (tx.matrixAutoUpdate) tx.updateMatrix();
              var e = tx.matrix.elements;
              var uv = ng.attributes.uv, uvs = uv.array;
              for (var q = 0; q < uv.count; q++) {
                var u = uvs[q * 2], vv = uvs[q * 2 + 1];
                uvs[q * 2] = e[0] * u + e[3] * vv + e[6];
                uvs[q * 2 + 1] = e[1] * u + e[4] * vv + e[7];
              }
              if (!sharedTex) {
                sharedTex = tx.clone();
                sharedTex.repeat.set(1, 1); sharedTex.offset.set(0, 0);
                sharedTex.rotation = 0; sharedTex.center.set(0, 0);
                if (sharedTex.matrixAutoUpdate) sharedTex.updateMatrix();
                sharedTex.needsUpdate = true;
              }
            }
            if (b2.bake) {
              var c = (mesh.material && mesh.material.color) || WHITE;
              var n = ng.attributes.position.count;
              var carr = new Float32Array(n * 3);
              for (var v = 0; v < n; v++) { carr[v * 3] = c.r; carr[v * 3 + 1] = c.g; carr[v * 3 + 2] = c.b; }
              ng.setAttribute('color', new THREE.BufferAttribute(carr, 3));
            }
            geoms.push(ng);
          }
          if (b2.bakeUV) stats.bakedUV += b2.items.length;
          var names = Object.keys(geoms[0].attributes);
          var total = 0;
          for (gi = 0; gi < geoms.length; gi++) total += geoms[gi].attributes.position.count;
          var out = new THREE.BufferGeometry();
          for (var ni = 0; ni < names.length && good; ni++) {
            var nm = names[ni], is = geoms[0].attributes[nm].itemSize;
            var arr = new Float32Array(total * is), off = 0;
            for (gi = 0; gi < geoms.length; gi++) {
              var at = geoms[gi].attributes[nm];
              if (!at || at.itemSize !== is) { good = false; break; }
              arr.set(at.array, off); off += at.array.length;
            }
            if (good) out.setAttribute(nm, new THREE.BufferAttribute(arr, is));
          }
          if (!good || !out.attributes.position || !out.attributes.normal) {
            stats.skipped += b2.items.length;
            for (gi = 0; gi < geoms.length; gi++) geoms[gi].dispose();
            continue;
          }
          out.computeBoundingSphere();
          var mm = b2.mat.clone();
          if (b2.bake) { mm.color.set(0xffffff); mm.vertexColors = true; }
          if (sharedTex) {
            mm.map = sharedTex;
            if (b2.emSame) mm.emissiveMap = sharedTex;
          }
          var mo = new THREE.Mesh(out, mm);
          var f = b2.items[0];
          mo.castShadow = f.castShadow; mo.receiveShadow = f.receiveShadow;
          mo.renderOrder = f.renderOrder; mo.visible = f.visible;
          for (gi = 0; gi < b2.items.length; gi++) {
            var p = b2.items[gi].parent;
            if (p) p.remove(b2.items[gi]);
            geoms[gi].dispose();
          }
          root.add(mo);
          stats.outMeshes++;
        }
        stats.ms = Date.now() - t0;
        mergeStatic.stats = stats;
        return root;
      }
      return mergeStatic;
    })();

    var buildTasks = [];
    function buildStep(name, fn) {
      buildTasks.push(function () {
        try { fn(); } catch (e) {
          if (window.console && console.warn) console.warn('[world3d] ' + name + ' build failed:', e);
        }
        bumpLoadCount();
      });
    }

    // ---- surrounding ring: R4 (the 1 sq mi district fabric) ----
    // 'full' mode builds it as a sliced task in the initial queue. 'lite'
    // boots the core district and streams it after first frame on idle;
    // 'safe' (a previous boot died) skips it — the core district alone must
    // load. The R4 group handle feeds the adaptive-quality governor
    // (far-field density step). (Round 5's outer ring was removed in the
    // 2026-10-01 one-square-mile rescope.)
    var farFieldGroup = null;
    function farFieldTasks() {
      var tasks = [];
      tasks.push(function () {
        try {
          if (window.DAARegionExpansionR4 && window.DAARegionExpansionR4.buildRegionExpansionR4) {
            farFieldGroup = window.DAARegionExpansionR4.buildRegionExpansionR4(THREE);
            try { DAA_mergeStatic(THREE, farFieldGroup); } catch (e) {
              if (window.console && console.warn) console.warn('[world3d] r4 merge failed, using unmerged:', e);
            }
            scene.add(farFieldGroup);
          }
        } catch (e) {
          if (window.console && console.warn) console.warn('[world3d] region-expansion-r4 build failed:', e);
        }
        if (stab) { try { stab.setFarField(farFieldGroup); } catch (e) {} }
        bumpLoadCount();
      });
      return tasks;
    }

    // ---- far-field streaming (lite/safe modes) ----
    var farStreamed = false, farStreaming = false;
    function extendLoader(n, label) {
      loadTotal += n;
      var l = mount.querySelector('.world3d-loading');
      if (l) {
        l.style.display = '';
        var t = l.querySelector('.world3d-loadlabel');
        if (t && label) t.textContent = label;
      }
      paintLoadCount(loadDone);
    }
    function hideLoader() {
      var l = mount.querySelector('.world3d-loading');
      if (l) l.style.display = 'none';
    }
    // Stream the surrounding ring after first frame ('lite' mode). The
    // journal entry is written BEFORE the first streamed task runs and
    // 'firstFrame' is marked after it completes: a tab killed mid-stream
    // reboots into 'safe' instead of re-running the same fatal stream.
    function streamFarField() {
      if (farStreamed || farStreaming) return;
      farStreaming = true;
      // Journal the stream: if the tab dies mid-stream, the journal is
      // still present on the next boot and detectBootMode() drops to
      // 'safe' instead of re-running the same fatal stream.
      try { if (window.DAAStability) window.DAAStability.writeJournal('streaming', mode); } catch (e) {}
      var tasks = farFieldTasks();
      extendLoader(tasks.length, 'Streaming the surrounding city');
      function done() {
        farStreaming = false; farStreamed = true;
        try { if (window.DAAStability) window.DAAStability.clearJournal(); } catch (e) {}
        hideLoader();
      }
      try {
        window.DAAStability.runSliced(tasks, 8, done);
      } catch (e) {
        for (var i = 0; i < tasks.length; i++) { try { tasks[i](); } catch (e2) {} }
        done();
      }
    }
    function onFirstFrame() {
      // Draw-call budget (iPadOS): ~80 initial draw calls. One log per
      // boot — a warn, never a crash, when the initial scene exceeds it.
      try {
        var dcalls = renderer.info && renderer.info.render ? renderer.info.render.calls : -1;
        if (window.console && dcalls >= 0) {
          var dmsg = '[world3d] initial draw calls: ' + dcalls + ' (budget ~80)';
          if (dcalls > 80) window.console.warn(dmsg); else window.console.info(dmsg);
        }
      } catch (e) {}
      if (mode === 'lite') {
        // Crash-loop protection: the surrounding ring streams on ONE idle
        // callback after first frame. The stream journals BEFORE it starts
        // (see streamFarField): a tab killed mid-stream reboots into 'safe'
        // instead of re-running the same fatal stream — a crash loop with
        // no escape. 'safe' never streams: the core district alone must load.
        try {
          if (window.DAAStability && window.DAAStability.whenIdle) {
            window.DAAStability.whenIdle(streamFarField);
          } else {
            setTimeout(streamFarField, 1500);
          }
        } catch (e) {}
      }
    }
    var base = 'assets/world/';
    var clickTargets = [];

    PARTS.forEach(function (p) {
      loader.load(base + p[0] + '.stl', function (geo) {
        geo.rotateX(-Math.PI / 2); // OpenSCAD z-up -> three y-up
        geo.computeVertexNormals();
        var mat = new THREE.MeshStandardMaterial({
          color: p[1], roughness: p[2], metalness: p[3]
        });
        var mesh = new THREE.Mesh(geo, mat);
        mesh.receiveShadow = true;
        mesh.castShadow = p[0] !== 'ground' && p[0] !== 'roads' && p[0] !== 'water';
        scene.add(mesh);
      }, undefined, partError(base + p[0] + '.stl'));
    });

    // The Workshop: procedural SC3K-standard build (replaces workshop.stl).
    // Synchronous and local; counts as one step on the loading overlay.
    buildStep('workshop', function () {
      if (window.DAAArchKit && window.DAAArchKit.buildWorkshop) {
        scene.add(DAA_mergeStatic(THREE, window.DAAArchKit.buildWorkshop(THREE)));
      }
    });

    // Corktown: procedural Academy HQ + rowhouses + pocket park
    // (replaces the old station STL). Synchronous and local; one overlay step.
    buildStep('corktown', function () {
      if (window.DAAArchKit && window.DAAArchKit.buildCorktown) {
        scene.add(DAA_mergeStatic(THREE, window.DAAArchKit.buildCorktown(THREE)));
      }
    });

    // UM Center for Innovation: procedural KPF-inspired build
    // (replaces the old techtown STL). Synchronous and local; one overlay step.
    buildStep('innovation', function () {
      if (window.DAAArchKit && window.DAAArchKit.buildInnovation) {
        scene.add(DAA_mergeStatic(THREE, window.DAAArchKit.buildInnovation(THREE)));
      }
    });

    // Thinkabit Lab: procedural makerspace rebuild
    // (replaces the old thinkabit STL). Synchronous and local; one overlay step.
    buildStep('thinkabit', function () {
      if (window.DAAArchKit && window.DAAArchKit.buildThinkabit) {
        scene.add(DAA_mergeStatic(THREE, window.DAAArchKit.buildThinkabit(THREE)));
      }
    });

    // Detroit Riverfront pavilion: procedural butterfly-roof rebuild
    // (replaces the old riverfront STL). Synchronous and local; one overlay step.
    buildStep('riverfront', function () {
      if (window.DAAArchKit && window.DAAArchKit.buildRiverfront) {
        scene.add(DAA_mergeStatic(THREE, window.DAAArchKit.buildRiverfront(THREE)));
      }
    });

    // Forge Line guideway + Amtrak high-speed viaduct: procedural transit build
    // (proposed rails, in-scene). Synchronous and local; one overlay step.
    buildStep('guideway', function () {
      if (window.DAAArchKit && window.DAAArchKit.buildGuideway) {
        scene.add(DAA_mergeStatic(THREE, window.DAAArchKit.buildGuideway(THREE)));
      }
    });

    // Streetscape: curbs, sidewalks, lane markings, crosswalks, plaza pavers.
    // Synchronous and local; one overlay step.
    buildStep('streetscape', function () {
      if (window.DAAStreetscape && window.DAAStreetscape.buildStreetscape) {
        scene.add(DAA_mergeStatic(THREE, window.DAAStreetscape.buildStreetscape(THREE)));
      }
    });

    // Street furniture: lamps, benches, planters, bollards, trees.
    // Synchronous and local; one overlay step.
    buildStep('furniture', function () {
      if (window.DAAFurniture && window.DAAFurniture.buildFurniture) {
        scene.add(DAA_mergeStatic(THREE, window.DAAFurniture.buildFurniture(THREE)));
      }
    });

    // Vehicles: Forge Pod on the guideway, parked Hauler/Tender/sedans.
    // Synchronous and local; one overlay step.
    buildStep('vehicles', function () {
      if (window.DAAVehicles && window.DAAVehicles.buildVehicles) {
        scene.add(DAA_mergeStatic(THREE, window.DAAVehicles.buildVehicles(THREE)));
      }
    });

    // District expansion: outer-ring ground, street extensions, low-rise
    // context buildings, street trees. Synchronous and local; one overlay step.
    buildStep('district-expansion', function () {
      if (window.DAADistrictExpansion && window.DAADistrictExpansion.buildDistrictExpansion) {
        scene.add(DAA_mergeStatic(THREE, window.DAADistrictExpansion.buildDistrictExpansion(THREE)));
      }
    });

    // Groundwork: terrain variation, texture transitions, river detail,
    // building-base grounding decals. Synchronous and local; one overlay step.
    buildStep('groundwork', function () {
      if (window.DAAGroundwork && window.DAAGroundwork.buildGroundwork) {
        scene.add(DAA_mergeStatic(THREE, window.DAAGroundwork.buildGroundwork(THREE)));
      }
    });

    // Promenade: riverfront boardwalk, connectors, pocket-park detailing.
    // Synchronous and local; one overlay step.
    buildStep('promenade', function () {
      if (window.DAAPromenade && window.DAAPromenade.buildPromenade) {
        scene.add(DAA_mergeStatic(THREE, window.DAAPromenade.buildPromenade(THREE)));
      }
    });

    // Round 3 (2026-10-01, overnight): region expansion, Chicago HSR concept,
    // and railway connect/expand modules. Same try/catch overlay pattern;
    // each counts one loader step (see loadTotal above).
    // Region expansion: outer-ring-2 ground, streets, low-rise context
    // buildings, street trees. Synchronous and local; one overlay step.
    buildStep('region-expansion', function () {
      if (window.DAARegionExpansion && window.DAARegionExpansion.buildRegionExpansion) {
        scene.add(DAA_mergeStatic(THREE, window.DAARegionExpansion.buildRegionExpansion(THREE)));
      }
    });

    // Chicago HSR: proposed westward intercity viaduct, Dearborn concept
    // station, Chicago terminus. Synchronous and local; one overlay step.
    buildStep('chicago-hsr', function () {
      if (window.DAAChicagoHSR && window.DAAChicagoHSR.buildChicagoHSR) {
        scene.add(DAA_mergeStatic(THREE, window.DAAChicagoHSR.buildChicagoHSR(THREE)));
      }
    });

    // Railways: Forge Line dead-end termini, intercity transfer, Michigan Ave
    // / 14th St / riverfront spur lines. Synchronous and local; one overlay step.
    buildStep('railways', function () {
      if (window.DAARailways && window.DAARailways.buildRailways) {
        scene.add(DAA_mergeStatic(THREE, window.DAARailways.buildRailways(THREE)));
      }
    });

    // Stations: enclosed station buildings on the four open C-loop
    // platforms, the Central Interchange hall at Academy HQ, and the
    // intercity transfer building completion. Synchronous and local;
    // one overlay step.
    buildStep('stations', function () {
      if (window.DAAStations && window.DAAStations.buildStations) {
        scene.add(DAA_mergeStatic(THREE, window.DAAStations.buildStations(THREE)));
      }
    });

    // Surrounding ring (R4): 'full' mode builds it as a sliced task in the
    // initial queue; 'lite' streams it after first frame (see onFirstFrame);
    // 'safe' skips it. See farFieldTasks() above.
    if (mode === 'full') {
      farFieldTasks().forEach(function (t) { buildTasks.push(t); });
      farStreamed = true;
    }

    // Round 5 (2026-10-01, overnight): rail vehicle prototypes — heritage car,
    // Forge Pod and intercity concept services traversing the railways.js
    // track geometry. One sliced step.
    var railVehicles = null;
    buildStep('rail-vehicles', function () {
      if (window.DAARailVehicles && window.DAARailVehicles.init) {
        railVehicles = window.DAARailVehicles.init(THREE, scene, { reduced: reduced });
      }
    });

    // Round 5 (2026-10-01, overnight): autonomous drone fleet — bee + scout
    // variants with patrol / follow / return-to-pad behaviors. One sliced
    // step. (drone-variants.js is the builder library; no separate step.)
    // getTrainingPos only reads the training drone's physics state; it is
    // invoked from tick(), after st exists.
    var droneAutonomy = null;
    buildStep('drone-autonomy', function () {
      if (window.DAADroneAutonomy && window.DAADroneAutonomy.init) {
        droneAutonomy = window.DAADroneAutonomy.init(THREE, scene, {
          reduced: reduced,
          getTrainingPos: function () { return { x: st.px, y: st.py, z: st.pz }; }
        });
      }
    });

    // Round 5b (2026-10-01, overnight): multilayer rail + maglev prototypes —
    // surface/trench Forge Line extension with the Northside interchange,
    // and the CONCEPT maglev guideway with its interchange tower.
    // One sliced step.
    var railMultilevel = null;
    buildStep('rail-multilevel', function () {
      if (window.DAAMultilevel && window.DAAMultilevel.init) {
        railMultilevel = window.DAAMultilevel.init(THREE, scene, { reduced: reduced });
      }
    });

    // STL load failures: log which asset failed, then engage the 2D fallback.
    function partError(url) {
      return function (err) {
        if (window.console && console.error) console.error('[world3d] STL load failed: ' + url, err);
        fallback();
      };
    }

    // clickable district markers (invisible hit discs at each stop)
    buildStep('hit-discs', function () {
      var hitGeo = new THREE.CylinderGeometry(13, 13, 6, 12);
      Object.keys(DISTRICT).forEach(function (key) {
        var d = DISTRICT[key];
        var hit = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        hit.position.set(d.pos[0], 3, d.pos[1]);
        hit.userData.district = key;
        scene.add(hit);
        clickTargets.push(hit);
      });
    });

    // floating name labels (canvas sprites; positions are building centers
    // in three.js coords: x = east, z = south, y = just above the roofline)
    function makeLabel(text, hWorld) {
      var fs = 44, pad = 34;
      var c = document.createElement('canvas');
      var g = c.getContext('2d');
      g.font = '600 ' + fs + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
      c.width = Math.ceil(g.measureText(text).width) + pad * 2;
      c.height = Math.ceil(fs + pad * 1.5);
      var g2 = c.getContext('2d');
      g2.fillStyle = 'rgba(16,16,16,0.80)';
      g2.beginPath();
      if (g2.roundRect) g2.roundRect(2, 2, c.width - 4, c.height - 4, (c.height - 4) / 2);
      else g2.rect(2, 2, c.width - 4, c.height - 4);
      g2.fill();
      g2.lineWidth = 3;
      g2.strokeStyle = 'rgba(127,127,127,0.95)';
      g2.stroke();
      g2.font = '600 ' + fs + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
      g2.fillStyle = '#F2F2F2';
      g2.textBaseline = 'middle';
      g2.fillText(text, pad, c.height / 2 + 2);
      var tex = new THREE.CanvasTexture(c);
      tex.anisotropy = 4;
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthTest: true
      }));
      var hWorld = hWorld || 3.4;
      sp.scale.set(hWorld * c.width / c.height, hWorld, 1);
      return sp;
    }
    var LABEL_AT = { // [x, z, y] per district, from cad/world.scad
      workshop:   [0, 0, 21], innovation: [0, -38, 27], hq: [47, -20, 42],
      riverfront: [0, 44, 12], thinkabit: [-44, 0, 17]
    };
    buildStep('labels', function () {
      Object.keys(DISTRICT).forEach(function (key) {
        var p = LABEL_AT[key];
        var sp = makeLabel(DISTRICT[key].name);
        sp.position.set(p[0], p[2], p[1]);
        scene.add(sp);
      });
    });

    // the drone — personal quadcopter, built procedurally in the Forge palette.
    // One sliced step on the loading overlay; replaces the progress event
    // the old bot.stl load used to emit.
    var botGroup = new THREE.Group();
    var botMesh = null;      // drone airframe group (the animatable part)
    var droneBodyMat = null; // airframe material, for the charge pulse
    var droneLedMat = null;  // status LED material, for the blink
    var landingLight = null; // downward cone, fades in with altitude
    var props = [];          // {grp, disc, dir, ang}
    // Physics state handle: assigned in onCoreDone, but the drone-autonomy
    // build task (above) closes over it for getTrainingPos — so the binding
    // lives at init scope and is only *read* after the queue drains.
    var st = null;
    buildStep('drone', function () {
      var botTag = makeLabel('TRAINING BOT', 0.55);
      botTag.position.set(0, 1.35, 0);
      botGroup.add(botTag);
      (function buildDrone() {
      var g = new THREE.Group();
      var bodyMat = new THREE.MeshStandardMaterial({ color: 0x7F7F7F, roughness: 0.5, metalness: 0.35 });
      var darkMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.6, metalness: 0.45 });
      var glassMat = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.25, metalness: 0.6 });
      droneBodyMat = bodyMat;
      function M(geo, mat, x, y, z) {
        var m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.castShadow = true;
        g.add(m);
        return m;
      }
      M(new THREE.BoxGeometry(0.86, 0.26, 0.86), bodyMat, 0, 0, 0);      // airframe
      var canopy = M(new THREE.SphereGeometry(0.30, 20, 14), glassMat, 0, 0.16, 0);
      canopy.scale.set(1, 0.55, 1);                                     // sensor canopy
      M(new THREE.BoxGeometry(0.50, 0.08, 0.50), darkMat, 0, -0.16, 0); // belly plate
      // sensor eyes: amber, front, facing -z (the drone's forward)
      var eyeMat = new THREE.MeshStandardMaterial({
        color: 0xB4B4B4, emissive: 0xB4B4B4, emissiveIntensity: 2.2, roughness: 0.4
      });
      var eyeGeo = new THREE.SphereGeometry(0.055, 12, 12);
      M(eyeGeo, eyeMat, -0.14, 0.02, -0.40);
      M(eyeGeo, eyeMat, 0.14, 0.02, -0.40);
      // arms, motors, props — X configuration
      [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(function (d, i) {
        var ax = d[0], az = d[1];
        var arm = M(new THREE.BoxGeometry(0.62, 0.07, 0.13), darkMat, ax * 0.30, 0.02, az * 0.30);
        arm.rotation.y = Math.atan2(-az, ax);
        var mx = ax * 0.52, mz = az * 0.52;
        M(new THREE.CylinderGeometry(0.085, 0.105, 0.12, 14), darkMat, mx, 0.08, mz);
        var prop = new THREE.Group();
        prop.position.set(mx, 0.17, mz);
        var b1 = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.014, 0.055), glassMat);
        var b2 = b1.clone(); b2.rotation.y = Math.PI / 2;
        var hub = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), bodyMat);
        prop.add(b1); prop.add(b2); prop.add(hub);
        var disc = new THREE.Mesh(new THREE.CircleGeometry(0.29, 24),
          new THREE.MeshBasicMaterial({ color: 0x9F9F9F, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
        disc.rotation.x = -Math.PI / 2;
        disc.position.y = 0.012;
        disc.castShadow = false;
        prop.add(disc);
        g.add(prop);
        props.push({ grp: prop, disc: disc, dir: (i % 2 === 0) ? 1 : -1, ang: (i * 2.4) % 6.28 });
      });
      // landing skids (rail bottoms at y = -0.425, so GEAR_H = 0.43)
      [-0.26, 0.26].forEach(function (sx) {
        M(new THREE.BoxGeometry(0.05, 0.05, 0.72), darkMat, sx, -0.40, 0);
        M(new THREE.BoxGeometry(0.04, 0.24, 0.04), darkMat, sx, -0.27, 0.22);
        M(new THREE.BoxGeometry(0.04, 0.24, 0.04), darkMat, sx, -0.27, -0.22);
      });
      // status LED, rear
      droneLedMat = new THREE.MeshStandardMaterial({
        color: 0xB4B4B4, emissive: 0xB4B4B4, emissiveIntensity: 2, roughness: 0.4
      });
      M(new THREE.SphereGeometry(0.035, 10, 8), droneLedMat, 0, 0.02, 0.45);
      botMesh = g;
    })();
    // landing light: downward cone from the belly, opacity follows altitude
    landingLight = new THREE.Mesh(
      new THREE.ConeGeometry(0.55, 2.4, 20, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xf0f0f0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    landingLight.position.y = -1.4; // apex sits just under the belly
    botGroup.add(landingLight);
    botGroup.add(botMesh);
    scene.add(botGroup);
    });

    // ---- post-build: input, physics, loop, API ----
    // Runs after the sliced build queue drains, so every module
    // handle above is assigned before the first frame.
    function onCoreDone() {
      try { if (window.DAAStability) window.DAAStability.writeJournal('core', mode); } catch (e) {}
      // Settled draw calls (iPadOS): the first-frame log fires before the
      // sliced build runs, so it always sees a near-empty scene. Log the
      // real post-build count once, on the next rendered frame — one line
      // per boot, a warn (never a crash) when over the ~80 budget.
      try {
        var _sdc = function () {
          try {
            var _dc = renderer.info && renderer.info.render ? renderer.info.render.calls : -1;
            if (window.console && _dc >= 0) {
              var _m = '[world3d] settled draw calls: ' + _dc + ' (budget ~80)';
              if (_dc > 80) window.console.warn(_m); else window.console.info(_m);
            }
          } catch (e) {}
        };
        if (window.requestAnimationFrame) window.requestAnimationFrame(_sdc);
        else setTimeout(_sdc, 0);
      } catch (e) {}
    // info card
    var card = document.createElement('div');
    card.className = 'world-card';
    card.style.display = 'none';
    mount.appendChild(card);
    function showCard(key) {
      var d = DISTRICT[key];
      card.innerHTML = '<strong>' + d.name + '</strong><span>' + d.desc + '</span>';
      card.style.display = 'block';
      clearTimeout(card._t);
      card._t = setTimeout(function () { card.style.display = 'none'; }, 6000);
    }

    var ray = new THREE.Raycaster();
    var ptr = new THREE.Vector2();
    renderer.domElement.addEventListener('pointerdown', function (e) {
      var r = renderer.domElement.getBoundingClientRect();
      ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(ptr, camera);
      var hits = ray.intersectObjects(clickTargets);
      if (hits.length) {
        var key = hits[0].object.userData.district;
        showCard(key);
        api.goTo(key); // tap a stop and the bot rolls over
      }
    });

    // ---- drone motion ----
    var DRONE = DronePhysics();
    st = DRONE.create(0, 24); // physics state; starts at the workshop approach point
    var cmd = { cvx: 0, cvz: 0, cvy: 0, exp: 0 }; // velocity commands + expiry (ms)
    var anim = null;       // {kind, t0, dur}
    var camTween = null;   // {p0, p1, t} — camera glide for the focus command
    var rideState = null;  // { name } while the camera is aboard a vehicle
    var keys = {};
    var driveArmed = false;
    mount.addEventListener('pointerenter', function () { driveArmed = true; });
    mount.addEventListener('pointerleave', function () { driveArmed = false; keys = {}; });
    window.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      keys[e.key.toLowerCase()] = true;
    });
    window.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = false; });

    function playAnim(kind, dur) {
      if (reduced) return;
      anim = { kind: kind, t0: performance.now(), dur: dur || 1100 };
    }

    // scan radar ring
    var ring = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.24, 40),
      new THREE.MeshBasicMaterial({ color: 0xB4B4B4, transparent: true, opacity: 0, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    scene.add(ring);
    var ringT = -1;

    var clock = new THREE.Clock();
    var _tgtV = new THREE.Vector3(); // reused every frame — never allocate in tick()
    var _inp = { cvx: 0, cvz: 0, cvy: 0 }; // input scratch — reused every frame
    var rafId = 0, loopHalted = false; // background-tab / context-loss pause
    var firstFrameDone = false;
    function tick() {
      rafId = 0;
      if (loopHalted) return;
      rafId = requestAnimationFrame(tick);
      var dt = Math.min(clock.getDelta(), 0.05);
      if (stab) stab.sample(dt * 1000);
      var now = performance.now();

      // ---- drone flight ----
      // Per-frame input: timed velocity commands (nudge/drive/altitude chips),
      // the keyboard, or the active flight plan. The physics core consumes it.
      _inp.cvx = 0; _inp.cvz = 0; _inp.cvy = 0;
      if (now < cmd.exp) { _inp.cvx = cmd.cvx; _inp.cvz = cmd.cvz; _inp.cvy = cmd.cvy; }
      // keyboard drive → velocity command (manual input cancels a flight plan)
      var mx = (keys['d'] || keys['arrowright'] ? 1 : 0) - (keys['a'] || keys['arrowleft'] ? 1 : 0);
      var mz = (keys['s'] || keys['arrowdown'] ? 1 : 0) - (keys['w'] || keys['arrowup'] ? 1 : 0);
      if (driveArmed && (mx || mz)) {
        st.plan = null;
        var kspd = st.armed ? 6.0 : 3.0; // sporty in the air, a calm taxi on the skids
        _inp.cvx = mx * kspd; _inp.cvz = mz * kspd;
      }
      if (st.plan) DRONE.updatePlan(st, _inp);
      else if ((_inp.cvx || _inp.cvz) && st.turnTarget === null && !reduced) {
        st.turnTarget = Math.atan2(-_inp.cvx, -_inp.cvz); // face travel direction
      }
      var planDone = DRONE.step(st, dt, _inp);
      if (planDone) planDone();
      // round-5 prototypes: rail vehicles + autonomous drone fleet (kinematic).
      // A failed update disables its module rather than spamming the console.
      if (railVehicles) {
        try { railVehicles.update(dt); }
        catch (e) { railVehicles = null; if (window.console && console.warn) console.warn('[world3d] rail-vehicles update failed:', e); }
      }
      if (droneAutonomy) {
        try { droneAutonomy.update(dt, now); }
        catch (e) { droneAutonomy = null; if (window.console && console.warn) console.warn('[world3d] drone-autonomy update failed:', e); }
      }
      if (railMultilevel) {
        try { railMultilevel.update(dt); }
        catch (e) { railMultilevel = null; if (window.console && console.warn) console.warn('[world3d] rail-multilevel update failed:', e); }
      }
      // Ride mode: the camera travels with the boarded vehicle. The vehicle
      // list is tiny (3 services), so a per-frame state lookup is fine.
      if (rideState && railVehicles && typeof railVehicles.getState === 'function') {
        try {
          var _rsv = railVehicles.getState(), _cur = null;
          for (var _ri = 0; _ri < _rsv.length; _ri++) {
            if (_rsv[_ri].name === rideState.name) { _cur = _rsv[_ri]; break; }
          }
          if (_cur) {
            var _fx = Math.sin(_cur.yaw), _fz = Math.cos(_cur.yaw);
            camera.position.set(_cur.x - _fx * 5.5, _cur.y + 3.4, _cur.z - _fz * 5.5);
            camera.lookAt(_cur.x + _fx * 9, _cur.y + 1.2, _cur.z + _fz * 9);
            controls.target.set(_cur.x, _cur.y, _cur.z);
          }
        } catch (e) {}
      }
      // physics state → meshes
      botGroup.position.set(st.px, st.py - st.gear * 0.4, st.pz);
      botGroup.rotation.y = st.yaw;
      botMesh.rotation.x = st.pitch;
      botMesh.rotation.z = st.roll;
      // rotors: spin up with throttle, blur discs fade in
      if (!reduced && st.armed) {
        for (var pi = 0; pi < props.length; pi++) {
          var pr = props[pi];
          pr.ang += pr.dir * (6 + st.throttle * 34) * dt;
          pr.grp.rotation.y = pr.ang;
          pr.disc.material.opacity = Math.min(0.4, st.throttle * 0.5);
        }
      } else {
        for (var pj = 0; pj < props.length; pj++) {
          props[pj].disc.material.opacity *= 0.92;
        }
      }
      // status LED blink + landing light follows altitude
      if (droneLedMat && !reduced) {
        droneLedMat.emissiveIntensity = 1.4 + 1.2 * Math.sin(now * 0.008);
      }
      if (landingLight) {
        var altM = st.py - DRONE.C.GEAR_H;
        landingLight.material.opacity = st.armed ? Math.min(0.16, altM / 10 * 0.16) : 0;
      }

      // procedural animations
      if (anim && botMesh) {
        var t = (now - anim.t0) / anim.dur;
        if (t >= 1) { anim = null; botMesh.position.y = 0; botMesh.rotation.set(0, 0, 0); }
        else if (anim.kind === 'dance') {
          botMesh.position.y = Math.abs(Math.sin(t * Math.PI * 6)) * 0.16;
          botMesh.rotation.z = Math.sin(t * Math.PI * 6) * 0.22;
        } else if (anim.kind === 'jump') {
          botMesh.position.y = Math.sin(t * Math.PI) * 0.5;
        } else if (anim.kind === 'spin') {
          botMesh.rotation.y = t * Math.PI * 2;
        } else if (anim.kind === 'wave') {
          botMesh.rotation.z = Math.sin(t * Math.PI * 4) * 0.18;
        } else if (anim.kind === 'charge') {
          var e = 0.25 + 0.55 * Math.abs(Math.sin(t * Math.PI * 3));
          droneBodyMat.emissive.setRGB(e * 0.9, e * 0.45, e * 0.08);
          if (t >= 0.99) droneBodyMat.emissive.setRGB(0, 0, 0);
        }
      }

      // scan ring
      if (ringT >= 0) {
        ringT += dt;
        var rt = ringT / 1.4;
        if (rt >= 1) { ringT = -1; ring.material.opacity = 0; }
        else {
          ring.position.set(st.px, st.py + 0.2, st.pz);
          var s = 0.24 + rt * 2.4;
          ring.scale.set(s / 0.24, s / 0.24, 1);
          ring.material.opacity = 0.5 * (1 - rt);
        }
      }

      // camera focus glide (the "focus" command): ease toward a close vantage
      // on the bot, then hand control back. Any manual orbit cancels it.
      if (camTween) {
        camTween.t = Math.min(1, camTween.t + dt / 0.9);
        var ce = 1 - Math.pow(1 - camTween.t, 3);
        camera.position.lerpVectors(camTween.p0, camTween.p1, ce);
        if (camTween.t >= 1) camTween = null;
      }

      // camera follows the drone loosely (tracks altitude too) — unless the
      // camera is aboard a vehicle (ride mode drives the camera itself)
      if (!rideState) {
        controls.target.lerp(_tgtV.set(st.px, st.py, st.pz), 0.04);
        controls.update();
      }
      try {
        renderer.render(scene, camera);
        if (!firstFrameDone) {
          // The boot journal clears here: reaching first frame proves this
          // boot survived construction. A journal left behind means the tab
          // died mid-build -> next boot enters 'safe' mode.
          firstFrameDone = true;
          try { if (window.DAAStability) window.DAAStability.clearJournal(); } catch (e) {}
          // Boot-time log (iPadOS): first-frame target is ~3 s on iPad-class
          // hardware. One line per boot — measure, don't guess.
          try {
            if (window.console && boot._t0) {
              window.console.info('[world3d] first frame in ' +
                Math.round(window.performance.now() - boot._t0) +
                ' ms (mode ' + mode + ', target ~3000)');
            }
          } catch (e) {}
          onFirstFrame();
        }
      } catch (e) {
        // one bad frame must never kill the loop silently; the ready backstop
        // (installed below, before the first frame) still fires.
        if (!tick._renderLogged && window.console && console.error) {
          tick._renderLogged = true;
          console.error('[world3d] render failed:', e);
        }
      }
    }
    // Ready backstop BEFORE the first frame: even if the render loop throws,
    // init completes and the loading overlay can never strand.
    manager.onLoad = ready;
    setTimeout(ready, 12000); // don't hang on a stalled part
    tick();

    window.addEventListener('resize', function () {
      var w2 = mount.clientWidth || 600, h2 = mount.clientHeight || 420;
      camera.aspect = w2 / h2;
      camera.updateProjectionMatrix();
      renderer.setSize(w2, h2);
    });

    // ---- public API for the terminal ----
    var isReady = false;
    function ready() {
      if (isReady) return;
      isReady = true;
      mount.classList.add('world-on');
      stage.classList.add('world-live'); // hides the SVG fallback
      var l = mount.querySelector('.world3d-loading');
      if (l) l.style.display = 'none';
    }

    var api = {
      goTo: function (key, done) {
        var d = DISTRICT[key];
        if (!d) { if (done) done(); return; }
        showCard(key);
        if (reduced) { // teleport: no animation budget
          st.px = d.pos[0]; st.pz = d.pos[1]; st.py = DRONE.C.GEAR_H;
          st.vx = st.vy = st.vz = 0;
          st.mode = 'ground'; st.armed = false; st.throttle = 0; st.plan = null;
          if (done) done();
          return;
        }
        // flight plan: take off if needed, cruise above the rooftops, land there
        st.plan = {
          x: d.pos[0], z: d.pos[1], phase: 'start',
          cruise: DRONE.cruiseFor(st.px, st.pz, d.pos[0], d.pos[1]),
          done: done || null
        };
        if (st.mode === 'ground' && !st.armed) DRONE.startTakeoff(st);
      },
      nudge: function (dir) { // forward/back relative to facing
        st.plan = null; // manual input overrides a flight plan
        var dx = -Math.sin(st.yaw) * 4 * dir, dz = -Math.cos(st.yaw) * 4 * dir;
        cmd.cvx = dx; cmd.cvz = dz; cmd.cvy = 0;
        cmd.exp = performance.now() + 900;
      },
      drive: function (mx, mz) { // screen-relative velocity command (D-pad), mirrors WASD
        st.plan = null;
        var dspd = st.armed ? 6.0 : 3.0;
        cmd.cvx = mx * dspd; cmd.cvz = mz * dspd; cmd.cvy = 0;
        cmd.exp = performance.now() + 350;
      },
      turn: function (dir) { // -1 = left, +1 = right; smooth 45° yaw
        st.turnTarget = st.yaw + dir * Math.PI / 4;
      },
      takeoff: function () {
        if (reduced || st.mode !== 'ground' || st.armed) return;
        st.plan = null;
        DRONE.startTakeoff(st);
      },
      land: function () {
        if (!st.armed || st.mode === 'ground') return;
        st.plan = null;
        if (st.py <= DRONE.C.GEAR_H + 0.05) {
          st.mode = 'ground'; st.armed = false; st.throttle = 0;
        } else {
          st.mode = 'landing';
          cmd.cvx = 0; cmd.cvz = 0; cmd.cvy = -1.2; // controlled descent
          cmd.exp = performance.now() + 30000;
        }
      },
      altitude: function (dir) { // +1 climb, -1 descend (timed vertical command)
        if (reduced) return;
        st.plan = null;
        if (dir > 0 && !st.armed && st.mode === 'ground') DRONE.startTakeoff(st);
        cmd.cvy = dir * 2.5;
        cmd.exp = performance.now() + 4000;
      },
      isAirborne: function () { return st.mode !== 'ground'; },
      powerDraw: function () { return st.armed ? st.throttle : 0; }, // 0..1 throttle load
      perf: function () { return stab ? stab.perf() : null; }, // draw calls, tris, frame ms, tier
      telemetry: function () {
        return {
          alt: Math.max(0, st.py - DRONE.C.GEAR_H),
          airborne: st.mode !== 'ground',
          throttle: st.throttle
        };
      },
      dance: function () { playAnim('dance', 1300); },
      jump: function () {
        playAnim('jump', 900);
        if (!reduced) {
          if (st.mode === 'ground' && !st.armed) DRONE.startTakeoff(st); // jump = liftoff
          else st.vy += 1.5; // hop while airborne
        }
      },
      spin: function () { playAnim('spin', 950); },
      wave: function () { playAnim('wave', 1200); },
      charge: function () { playAnim('charge', 1700); },
      scan: function () { ringT = 0; },
      look: function (key) { if (key && DISTRICT[key]) showCard(key); },
      focus: function () { // zoom the camera in on the drone, wherever it is
        var dir = new THREE.Vector3(camera.position.x - st.px, 0, camera.position.z - st.pz);
        if (dir.lengthSq() < 0.01) dir.set(1, 0, 1);
        dir.normalize();
        camTween = {
          p0: camera.position.clone(),
          p1: new THREE.Vector3(st.px + dir.x * 13, st.py + 5, st.pz + dir.z * 13),
          t: 0
        };
      },
      patrol: function () { if (droneAutonomy) droneAutonomy.setMode('patrol'); },
      follow: function () { if (droneAutonomy) droneAutonomy.setMode('follow'); },
      rtp: function () { if (droneAutonomy) droneAutonomy.setMode('rtp'); },
      // Ride the Forge Line: boards the Forge Pod — the camera rides with the
      // vehicle until hopoff(). Boarding is explicit (the `ride` command or
      // chip); grabbing the canvas (orbit) also hands the camera back.
      ride: function () {
        if (!railVehicles || typeof railVehicles.getState !== 'function') return 'none';
        var svcs = railVehicles.getState(), pick = null, i;
        for (i = 0; i < svcs.length; i++) {
          if (svcs[i].name.indexOf('FORGE POD') >= 0 && svcs[i].state !== 'parked') { pick = svcs[i]; break; }
        }
        if (!pick) {
          for (i = 0; i < svcs.length; i++) {
            if (svcs[i].state !== 'parked') { pick = svcs[i]; break; }
          }
        }
        if (!pick) return 'parked';
        rideState = { name: pick.name };
        controls.enabled = false;
        return 'riding';
      },
      hopoff: function () {
        if (!rideState) return 'already';
        rideState = null;
        controls.enabled = true;
        return 'off';
      },
      riding: function () { return !!rideState; }
    };
    // a manual orbit always wins over the focus glide — and over ride mode
    renderer.domElement.addEventListener('pointerdown', function () {
      camTween = null;
      if (rideState) api.hopoff();
    });
    window.DAAWorld = api;
  }
  
    // Loader total follows the assembled queue: PARTS.length STL steps plus
    // one step per build task. Far-field streaming extends it later.
    loadTotal = PARTS.length + buildTasks.length;
    paintLoadCount(0);
    try {
      window.DAAStability.runSliced(buildTasks, 8, onCoreDone);
    } catch (e) {
      // runSliced is best-effort; without it, run the queue inline (old behavior).
      for (var bi = 0; bi < buildTasks.length; bi++) { try { buildTasks[bi](); } catch (e2) {} }
      onCoreDone();
    }
  }
})();
