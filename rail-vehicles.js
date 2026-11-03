/* Detroit Automation Academy — rail vehicles.
 *
 * Classic IIFE; exposes window.DAARailVehicles = { init: function(THREE, scene, opts) }.
 * init returns { update: function(dt), setReduced: function(b), vehicleCount, getState: function() }.
 * opts = { reduced: bool } — when true, vehicles park at their first station and never move.
 *
 * Three services traverse the authoritative track geometry from railways.js
 * (Forge Line C-loop, Michigan Ave Line, intercity corridor). Motion model: arc-length-parameterized polylines (0.5 m resample), smooth
 * accel/decel, station dwell (4 s), terminus pause (2 s) then reverse.
 *
 * NOTE: R3 INTERCITY is a CONCEPT service. Its track is the in-scene
 * PROPOSED intercity corridor (chicago-hsr.js + the S2 viaduct stub); no
 * opening dates, no operator names. The R1/R2 services run on the operating
 * Forge Line identity.
 *
 * Units: meters; x = east, z = south, y = up. Deterministic: no Math.random.
 */
(function () {
  'use strict';

  // Forge palette + the in-scene dark/glass convention (vehicles.js) and the
  // in-scene intercity steel-blue identity (railways.js mAccent 0xbbbbbb).
  var ORANGE = 0x7F7F7F;
  var AMBER = 0xB4B4B4;
  var PAPER = 0xF2F2F2;
  var CONCRETE = 0x9F9F9F;
  var DARK = 0x171717;
  var GLASS = 0x222222;
  var STEELBLUE = 0xbbbbbb;

  var RESAMPLE_STEP = 0.5; // m
  var ACCEL = 1.0;         // m/s^2
  var DECEL = 1.3;         // m/s^2
  var DWELL_S = 4.0;       // station dwell
  var TERMINUS_PAUSE_S = 2.0;

  // ---------------- path utilities ----------------

  // Resample a polyline [[x,z],...] to arc-length-parameterized points.
  function resample(pts, step) {
    var xs = [pts[0][0]], zs = [pts[0][1]], cum = [0];
    var emitted = 0, segStart = 0, next = step;
    for (var i = 0; i < pts.length - 1; i++) {
      var ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
      var dx = bx - ax, dz = bz - az, len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-9) { continue; }
      var ux = dx / len, uz = dz / len;
      var segEnd = segStart + len;
      while (next < segEnd - 1e-9) {
        var t = next - segStart;
        xs.push(ax + ux * t); zs.push(az + uz * t); cum.push(next);
        emitted = next; next += step;
      }
      segStart = segEnd;
    }
    var lx = pts[pts.length - 1][0], lz = pts[pts.length - 1][1];
    if (Math.abs(xs[xs.length - 1] - lx) > 1e-9 || Math.abs(zs[zs.length - 1] - lz) > 1e-9) {
      xs.push(lx); zs.push(lz); cum.push(segStart);
    }
    return { xs: xs, zs: zs, cum: cum, L: segStart };
  }

  function pointAt(p, s) {
    var n = p.cum.length;
    if (s <= 0) return { x: p.xs[0], z: p.zs[0] };
    if (s >= p.L) return { x: p.xs[n - 1], z: p.zs[n - 1] };
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (p.cum[mid] <= s) lo = mid; else hi = mid;
    }
    var c0 = p.cum[lo], c1 = p.cum[hi];
    var t = (s - c0) / Math.max(1e-9, c1 - c0);
    return { x: p.xs[lo] + (p.xs[hi] - p.xs[lo]) * t,
             z: p.zs[lo] + (p.zs[hi] - p.zs[lo]) * t };
  }

  function tangentAt(p, s) {
    var e = 0.75;
    var a = pointAt(p, Math.max(0, s - e));
    var b = pointAt(p, Math.min(p.L, s + e));
    var dx = b.x - a.x, dz = b.z - a.z;
    var l = Math.sqrt(dx * dx + dz * dz) || 1;
    return { x: dx / l, z: dz / l };
  }

  // Project (x,z) onto the resampled path: nearest sample -> along-track s.
  function projectOnto(p, x, z) {
    var best = Infinity, bi = 0;
    for (var i = 0; i < p.xs.length; i++) {
      var dx = x - p.xs[i], dz = z - p.zs[i], d = dx * dx + dz * dz;
      if (d < best) { best = d; bi = i; }
    }
    return { s: p.cum[bi], x: p.xs[bi], z: p.zs[bi], dist: Math.sqrt(best) };
  }

  // ---------------- small build helpers ----------------

  function std(THREE, o) { return new THREE.MeshStandardMaterial(o); }

  function box(g, THREE, M, w, h, d, x, y, z, rx, ry) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M);
    m.position.set(x, y, z);
    if (rx) m.rotation.x = rx;
    if (ry) m.rotation.y = ry;
    m.castShadow = true;
    g.add(m);
    return m;
  }

  function wheelX(g, THREE, M, r, wdt, x, y, z) {
    var m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, wdt, 16), M);
    m.rotation.z = Math.PI / 2;
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  }

  // ---- R2 vehicle: Forge Pod capsule (orange/amber), forward = +z ----
  function buildPod(THREE) {
    var g = new THREE.Group();
    var M = {
      orange: std(THREE, { color: ORANGE, roughness: 0.55, metalness: 0.2 }),
      amber: std(THREE, { color: AMBER, emissive: AMBER, emissiveIntensity: 0.9, roughness: 0.4 }),
      dark: std(THREE, { color: DARK, roughness: 0.85 }),
      glass: std(THREE, { color: GLASS, roughness: 0.15, metalness: 0.65 }),
      lampW: std(THREE, { color: 0xf5f5f5, emissive: 0xe3e3e3, emissiveIntensity: 1.2, roughness: 0.3 })
    };
    [1.6, -1.6].forEach(function (bz) {                       // bogies
      box(g, THREE, M.dark, 1.5, 0.35, 1.4, 0, 0.4, bz);
      [-0.45, 0.45].forEach(function (dz) {
        [-0.8, 0.8].forEach(function (sx) { wheelX(g, THREE, M.dark, 0.22, 0.14, sx, 0.22, bz + dz); });
      });
    });
    box(g, THREE, M.dark, 1.7, 0.3, 4.0, 0, 0.6, 0);          // skirt
    box(g, THREE, M.orange, 2.0, 1.1, 4.6, 0, 1.2, 0);        // hull
    var nose = new THREE.Mesh(new THREE.SphereGeometry(1.0, 20, 14), M.orange);
    nose.scale.set(1, 0.55, 0.6); nose.position.set(0, 1.2, 2.3);
    nose.castShadow = true; g.add(nose);                       // rounded nose
    box(g, THREE, M.glass, 2.04, 0.5, 3.4, 0, 1.5, -0.2);     // window band
    box(g, THREE, M.dark, 1.9, 0.14, 4.0, 0, 1.82, -0.2);     // roof
    box(g, THREE, M.amber, 2.02, 0.14, 4.62, 0, 0.78, 0);      // amber stripe
    box(g, THREE, M.lampW, 0.9, 0.16, 0.08, 0, 1.15, 2.86);   // headlight
    box(g, THREE, M.amber, 0.9, 0.16, 0.08, 0, 1.15, -2.32);  // taillight
    var beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.12, 12), M.amber);
    beacon.position.set(0, 1.95, -1.8); beacon.castShadow = true; g.add(beacon);
    return g;
  }

  // ---- R3 vehicle: sleek 2-car intercity trainset (steel-blue/amber), forward = +z ----
  function buildTrainset(THREE) {
    var g = new THREE.Group();
    var M = {
      blue: std(THREE, { color: STEELBLUE, roughness: 0.4, metalness: 0.45 }),
      amber: std(THREE, { color: AMBER, emissive: AMBER, emissiveIntensity: 0.9, roughness: 0.4 }),
      dark: std(THREE, { color: DARK, roughness: 0.85 }),
      glass: std(THREE, { color: GLASS, roughness: 0.15, metalness: 0.65 }),
      conc: std(THREE, { color: CONCRETE, roughness: 0.8 }),
      lampW: std(THREE, { color: 0xf5f5f5, emissive: 0xe3e3e3, emissiveIntensity: 1.4, roughness: 0.3 })
    };
    function car(cz, isFront) {
      box(g, THREE, M.blue, 2.6, 1.9, 6.2, 0, 1.55, cz);       // body
      box(g, THREE, M.glass, 2.64, 0.6, 5.4, 0, 1.85, cz);     // window band
      box(g, THREE, M.dark, 2.5, 0.16, 6.0, 0, 2.58, cz);      // roof
      box(g, THREE, M.dark, 2.3, 0.4, 5.9, 0, 0.5, cz);        // skirt
      box(g, THREE, M.amber, 2.62, 0.16, 6.24, 0, 0.92, cz);   // amber stripe
      [cz - 2.2, cz + 2.2].forEach(function (bz) {             // bogies + wheels
        box(g, THREE, M.dark, 1.8, 0.32, 1.7, 0, 0.42, bz);
        [-0.6, 0.6].forEach(function (dz) {
          [-0.8, 0.8].forEach(function (sx) { wheelX(g, THREE, M.dark, 0.32, 0.14, sx, 0.32, bz + dz); });
        });
      });
      box(g, THREE, M.conc, 1.2, 0.25, 2.0, 0, 2.78, cz);      // roof AC pod
      if (isFront) {
        var nose = new THREE.Mesh(new THREE.SphereGeometry(1.3, 24, 16), M.blue);
        nose.scale.set(1, 0.75, 0.9); nose.position.set(0, 1.55, cz + 3.1);
        nose.castShadow = true; g.add(nose);                   // sleek nose
        box(g, THREE, M.glass, 2.0, 0.55, 0.1, 0, 1.95, cz + 3.75, -0.3, 0); // windshield
        box(g, THREE, M.lampW, 0.3, 0.18, 0.1, 0.7, 1.25, cz + 3.95);  // headlights
        box(g, THREE, M.lampW, 0.3, 0.18, 0.1, -0.7, 1.25, cz + 3.95);
      } else {
        box(g, THREE, M.amber, 0.3, 0.18, 0.1, 0.7, 1.5, cz - 3.13);   // taillights
        box(g, THREE, M.amber, 0.3, 0.18, 0.1, -0.7, 1.5, cz - 3.13);
      }
    }
    car(3.35, true);
    car(-3.35, false);
    box(g, THREE, M.dark, 2.2, 1.7, 0.6, 0, 1.5, 0);          // gangway bellows
    return g;
  }

  // Minimal fallback car if the heritage build is unavailable.
  function fallbackCar(THREE) {
    var g = new THREE.Group();
    var M = {
      orange: std(THREE, { color: ORANGE, roughness: 0.6 }),
      dark: std(THREE, { color: DARK, roughness: 0.85 })
    };
    box(g, THREE, M.orange, 2.4, 2.2, 8.0, 0, 1.9, 0);
    box(g, THREE, M.dark, 2.2, 0.5, 8.4, 0, 0.65, 0);
    [2.6, -2.6].forEach(function (zc) {
      [-0.8, 0.8].forEach(function (sx) { wheelX(g, THREE, M.dark, 0.34, 0.12, sx, 0.34, zc); });
    });
    return g;
  }

  // ---------------- service ----------------

  function placeOnTrack(v) {
    var p = pointAt(v.path, v.s);
    v.group.position.set(p.x, v.railTopY, p.z);
    var t = tangentAt(v.path, v.s);
    v.group.rotation.y = Math.atan2(t.x * v.dir, t.z * v.dir);
    v.px = p.x; v.pz = p.z; v.yaw = v.group.rotation.y;
  }

  function makeService(THREE, scene, cfg) {
    var group = new THREE.Group();
    var vehicle = null;
    try {
      vehicle = cfg.build(THREE);
    } catch (e) { vehicle = null; }
    if (!vehicle) {
      try { vehicle = fallbackCar(THREE); } catch (e2) { vehicle = new THREE.Group(); }
    }
    group.add(vehicle);

    var railTopY = cfg.deckY + 0.14;
    var path = resample(cfg.polyline, RESAMPLE_STEP);
    var stops = cfg.stations.map(function (st) {
      var pr = projectOnto(path, st.x, st.z);
      return { name: st.name, s: pr.s, px: pr.x, pz: pr.z, dist: pr.dist, sx: st.x, sz: st.z };
    });
    var firstS = stops.length ? stops[0].s : path.L / 2;
    stops.sort(function (a, b) { return a.s - b.s; });

    var sMin = cfg.halfLen + cfg.endMargin;
    var sMax = path.L - cfg.halfLen - cfg.endMargin;
    if (sMax < sMin) { var mid = path.L / 2; sMin = mid; sMax = mid; }

    var v = {
      name: cfg.name, group: group, path: path, stops: stops,
      sMin: sMin, sMax: sMax, railTopY: railTopY, vmax: cfg.vmax,
      s: Math.max(sMin, Math.min(sMax, firstS)), v: 0, dir: 1,
      state: 'dwell', t: 1.0, px: 0, pz: 0, yaw: 0
    };
    placeOnTrack(v);
    scene.add(group);
    return v;
  }

  function stepVehicle(v, dt) {
    if (v.state === 'parked' || dt <= 0) return;
    if (v.state === 'dwell' || v.state === 'pause') {
      v.t -= dt;
      if (v.t <= 0) {
        if (v.state === 'pause') v.dir *= -1; // terminus: reverse
        v.state = 'run';
      }
      placeOnTrack(v);
      return;
    }
    // Next stop ahead, else the terminus in the direction of travel.
    var target = v.dir > 0 ? v.sMax : v.sMin, isTerminus = true;
    for (var i = 0; i < v.stops.length; i++) {
      var ss = v.stops[i].s;
      if (v.dir > 0 && ss > v.s + 0.6 && ss < target) { target = ss; isTerminus = false; }
      if (v.dir < 0 && ss < v.s - 0.6 && ss > target) { target = ss; isTerminus = false; }
    }
    var dist = Math.abs(target - v.s);
    var vAllow = Math.sqrt(2 * DECEL * dist);
    v.v = Math.min(v.v + ACCEL * dt, vAllow, v.vmax);
    var sNew = v.s + v.dir * v.v * dt;
    var crossed = (v.dir > 0 && sNew >= target) || (v.dir < 0 && sNew <= target);
    if (crossed || (dist <= 0.25 && v.v <= 0.6)) {
      v.s = target; v.v = 0;
      v.state = isTerminus ? 'pause' : 'dwell';
      v.t = isTerminus ? TERMINUS_PAUSE_S : DWELL_S;
    } else {
      v.s = Math.max(v.sMin, Math.min(v.sMax, sNew));
    }
    placeOnTrack(v);
  }

  // ---------------- service definitions ----------------
  // Polylines + decks quoted from railways.js (S1 audit, C1, S3/chicago-hsr.js).
  function serviceDefs(THREE) {
    return [
      {
        name: 'R1 HERITAGE SHUTTLE',
        polyline: [[22.5, -8], [22.5, 22], [17.5, 27], [-20.6, 27], [-25.6, 22],
                   [-25.6, -50.5], [-23.0, -56.5], [17.5, -56.5], [22.5, -56.5]],
        deckY: 7.5, vmax: 8, halfLen: 4.8, endMargin: 1.5,
        stations: [
          { name: 'THINKABIT LAB', x: -23.35, z: 3 },
          { name: 'UM INNOVATION', x: -23.35, z: -30 },
          { name: 'RIVERFRONT', x: 0, z: 24.1 },
          { name: 'ACADEMY HQ', x: 19.6, z: 0 }
        ],
        build: function (T) {
          if (typeof window !== 'undefined' && window.DAAHeritageCar &&
              window.DAAHeritageCar.buildHeritageCar) {
            return window.DAAHeritageCar.buildHeritageCar(T);
          }
          return fallbackCar(T);
        }
      },
      {
        name: 'R2 FORGE POD SHUTTLE',
        polyline: [[-25.6, -30], [-128, -30]],
        deckY: 7.47, vmax: 8, halfLen: 2.95, endMargin: 1.0,
        stations: [
          { name: 'MICHIGAN AVE · 14TH ST', x: -94, z: -33.6 },
          { name: 'MICHIGAN AVE WEST TERMINUS', x: -120, z: -33.6 }
        ],
        build: buildPod
      },
      {
        name: 'R3 INTERCITY CONCEPT',
        polyline: [[-218, 32], [-144, 32], [-132, 25.5], [-68, 25.5],
                   [-56, 32], [18.45, 32], [64, 32]],
        deckY: 12, vmax: 16, halfLen: 7.7, endMargin: 1.5,
        stations: [
          { name: 'CHICAGO', x: -200, z: 28.6 },
          { name: 'DEARBORN', x: -150, z: 28.6 },
          { name: 'AMTRAK INTERCITY', x: 30, z: 28.6 }
        ],
        build: buildTrainset
      }
    ];
  }

  // ---------------- public API ----------------

  function init(THREE, scene, opts) {
    var api = {
      update: function () {},
      setReduced: function () {},
      vehicleCount: 0,
      getState: function () { return []; }
    };
    try {
      if (!THREE || !THREE.Group || !scene || typeof scene.add !== 'function') return api;
      var reduced = !!(opts && opts.reduced);
      var defs = serviceDefs(THREE);
      var services = [];
      for (var i = 0; i < defs.length; i++) {
        var v = makeService(THREE, scene, defs[i]);
        if (reduced) {
          v.state = 'parked';
          v.v = 0;
          placeOnTrack(v);
        }
        services.push(v);
      }
      api.vehicleCount = services.length;
      api.update = function (dt) {
        for (var i = 0; i < services.length; i++) {
          try { stepVehicle(services[i], dt); }
          catch (e) { /* one bad vehicle never breaks the frame */ }
        }
      };
      api.setReduced = function (b) {
        for (var i = 0; i < services.length; i++) {
          var v = services[i];
          if (b) { v.state = 'parked'; v.v = 0; }
          else if (v.state === 'parked') { v.state = 'dwell'; v.t = 1.0; }
          placeOnTrack(v);
        }
      };
      api.getState = function () {
        return services.map(function (v) {
          return { name: v.name, s: v.s, v: v.v, dir: v.dir, state: v.state,
                   x: v.px, y: v.railTopY, z: v.pz, yaw: v.yaw,
                   sMin: v.sMin, sMax: v.sMax, pathL: v.path.L,
                   stops: v.stops.map(function (st) {
                     return { name: st.name, s: st.s, dist: st.dist };
                   }) };
        });
      };
      // Debug handle for validation / wiring (read-only use).
      api._services = services;
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[rail-vehicles] init failed:', e && e.message);
      }
    }
    return api;
  }

  if (typeof window !== 'undefined') {
    window.DAARailVehicles = { init: init };
  }
})();
