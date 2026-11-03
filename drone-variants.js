/* Detroit Automation Academy — autonomous drone variants (prototype track)
 *
 * Builds two procedural quadcopter variants in the Forge palette for the
 * autonomous fleet (see drone-autonomy.js). The training drone in world3d.js
 * is a separate aircraft and is untouched by this module.
 *
 * Conventions: classic IIFE, 'use strict', THREE passed as a parameter,
 * meters, x = east, z = south, y = up. Forward = -z (matches the training
 * drone's convention). Seeded PRNG only — no Math.random. Palette tokens
 * only: Forge Orange #7F7F7F, Midnight #101010, Amber #B4B4B4 (Tier 1);
 * steel-dark #1b1b1b (Tier 2, drone dark parts) per DESIGN-SOP.md §7.2.
 */
(function () {
  'use strict';

  var FORGE = 0x7F7F7F;    // Tier 1: Forge Orange
  var MIDNIGHT = 0x101010; // Tier 1: Midnight
  var AMBER = 0xB4B4B4;    // Tier 1: Amber
  var STEEL = 0x1b1b1b;    // Tier 2: steel-dark

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function stdMat(THREE, color, roughness, metalness, extra) {
    var p = { color: color, roughness: roughness, metalness: metalness };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) { p[k] = extra[k]; }
      }
    }
    return new THREE.MeshStandardMaterial(p);
  }

  /* Bee drone — a nod to the academy's BIOBUZZ bee-drone build series.
   * Quadcopter base + amber/midnight striped abdomen, translucent flapping
   * wings, stinger cone, large amber sensor eyes, pollen baskets.
   * Origin at center, forward = -z. ~30 meshes. */
  function buildBeeDrone(THREE) {
    var rng = mulberry32(0xC5C5C5);
    var g = new THREE.Group();

    var orange = stdMat(THREE, FORGE, 0.5, 0.35);
    var dark = stdMat(THREE, STEEL, 0.6, 0.45);
    var amber = stdMat(THREE, AMBER, 0.45, 0.2);
    var eyeMat = stdMat(THREE, AMBER, 0.35, 0.1, { emissive: AMBER, emissiveIntensity: 2.0 });
    var wingMat = stdMat(THREE, AMBER, 0.6, 0.0, {
      transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false
    });

    function M(geo, mat, x, y, z) {
      var m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      g.add(m);
      return m;
    }

    // thorax core (orange airframe)
    M(new THREE.BoxGeometry(0.62, 0.22, 0.62), orange, 0, 0, 0);

    // striped abdomen: amber with midnight bands (rear = +z)
    var abdomen = M(new THREE.SphereGeometry(0.30, 18, 14), amber, 0, -0.02, 0.38);
    abdomen.scale.set(0.85, 0.75, 1.25);
    var stripeGeo = new THREE.TorusGeometry(0.245, 0.035, 10, 28);
    for (var si = 0; si < 2; si++) {
      var bandZ = 0.30 + si * 0.18 + (rng() - 0.5) * 0.03;
      var band = M(stripeGeo, dark, 0, -0.02, bandZ);
      band.scale.set(0.85, 0.75, 1);
    }

    // head + large sensor eyes (front = -z)
    M(new THREE.BoxGeometry(0.34, 0.24, 0.22), dark, 0, 0.02, -0.38);
    var eyeGeo = new THREE.SphereGeometry(0.075, 14, 12);
    M(eyeGeo, eyeMat, -0.10, 0.06, -0.46);
    M(eyeGeo, eyeMat, 0.10, 0.06, -0.46);

    // stinger cone (rear)
    var sting = M(new THREE.ConeGeometry(0.06, 0.22, 10), dark, 0, -0.02, 0.80);
    sting.rotation.x = Math.PI / 2;

    // translucent wings on flap pivots (geometry root at the inner edge)
    var span = 0.55 + rng() * 0.06;
    function wingGeo(sign) {
      var wg = new THREE.PlaneGeometry(span, 0.30, 1, 1);
      wg.rotateX(-Math.PI / 2);            // lie flat in XZ
      wg.translate(sign * span / 2, 0, 0); // root at the pivot
      return wg;
    }
    var wings = [];
    var sides = [1, -1];
    for (var wi = 0; wi < 2; wi++) {
      var pivot = new THREE.Group();
      pivot.position.set(0.26 * sides[wi], 0.16, 0.05);
      var wmesh = new THREE.Mesh(wingGeo(sides[wi]), wingMat);
      wmesh.castShadow = false;
      pivot.add(wmesh);
      g.add(pivot);
      wings.push(pivot);
    }

    // pollen baskets (amber, under the thorax)
    var basketGeo = new THREE.BoxGeometry(0.12, 0.08, 0.16);
    M(basketGeo, amber, -0.24, -0.18, 0.10);
    M(basketGeo, amber, 0.24, -0.18, 0.10);

    // landing skids (rail bottoms at y = -0.385)
    var skidGeo = new THREE.BoxGeometry(0.05, 0.05, 0.60);
    M(skidGeo, dark, -0.22, -0.36, 0.02);
    M(skidGeo, dark, 0.22, -0.36, 0.02);

    // X arms, motors, props
    var props = [];
    var armGeo = new THREE.BoxGeometry(0.55, 0.06, 0.11);
    var motorGeo = new THREE.CylinderGeometry(0.07, 0.085, 0.10, 12);
    var bladeGeo = new THREE.BoxGeometry(0.48, 0.012, 0.05);
    var dirs = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (var ai = 0; ai < 4; ai++) {
      var ax = dirs[ai][0], az = dirs[ai][1];
      var arm = M(armGeo, dark, ax * 0.26, 0.04, az * 0.26);
      arm.rotation.y = Math.atan2(-az, ax);
      var mx = ax * 0.46, mz = az * 0.46;
      M(motorGeo, dark, mx, 0.10, mz);
      var prop = new THREE.Group();
      prop.position.set(mx, 0.17, mz);
      var b1 = new THREE.Mesh(bladeGeo, dark);
      var b2 = new THREE.Mesh(bladeGeo, dark);
      b2.rotation.y = Math.PI / 2;
      prop.add(b1);
      prop.add(b2);
      g.add(prop);
      props.push(prop);
    }

    g.userData = {
      kind: 'bee',
      props: props,   // 4 rotor groups to spin
      wings: wings,   // 2 flap pivots (rotation.z drives the flap)
      mats: { orange: orange, dark: dark, amber: amber, eye: eyeMat, wing: wingMat },
      restOffset: 0.64 // origin height above a pad top when parked
    };
    return g;
  }

  /* Scout drone — smaller quadcopter in Forge livery: orange frame,
   * amber sensor eyes, amber rear LED. Origin at center, forward = -z.
   * ~15 meshes. */
  function buildScoutDrone(THREE) {
    var g = new THREE.Group();

    var orange = stdMat(THREE, FORGE, 0.5, 0.35);
    var dark = stdMat(THREE, STEEL, 0.6, 0.45);
    var eyeMat = stdMat(THREE, AMBER, 0.35, 0.1, { emissive: AMBER, emissiveIntensity: 2.0 });

    function M(geo, mat, x, y, z) {
      var m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      g.add(m);
      return m;
    }

    // orange frame + dark sensor dome
    M(new THREE.BoxGeometry(0.50, 0.16, 0.50), orange, 0, 0, 0);
    var dome = M(new THREE.SphereGeometry(0.16, 16, 12), dark, 0, 0.10, 0);
    dome.scale.set(1, 0.5, 1);

    // sensor eyes (front = -z) and amber status LED (rear)
    var eyeGeo = new THREE.SphereGeometry(0.045, 12, 10);
    M(eyeGeo, eyeMat, -0.09, 0.02, -0.24);
    M(eyeGeo, eyeMat, 0.09, 0.02, -0.24);
    M(new THREE.SphereGeometry(0.03, 10, 8), eyeMat, 0, 0.02, 0.26);

    // X arms as two diagonal bars
    var armGeo = new THREE.BoxGeometry(0.78, 0.05, 0.09);
    var a1 = M(armGeo, dark, 0, 0.02, 0);
    a1.rotation.y = Math.PI / 4;
    var a2 = M(armGeo, dark, 0, 0.02, 0);
    a2.rotation.y = -Math.PI / 4;

    // motors + single-blade props (spin fast; reads as blur)
    var props = [];
    var motorGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.09, 10);
    var bladeGeo = new THREE.BoxGeometry(0.44, 0.01, 0.045);
    var ends = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (var mi = 0; mi < 4; mi++) {
      var ex = ends[mi][0] * 0.276, ez = ends[mi][1] * 0.276;
      M(motorGeo, dark, ex, 0.06, ez);
      var prop = new THREE.Group();
      prop.position.set(ex, 0.12, ez);
      var blade = new THREE.Mesh(bladeGeo, dark);
      blade.castShadow = false;
      prop.add(blade);
      g.add(prop);
      props.push(prop);
    }

    g.userData = {
      kind: 'scout',
      props: props, // 4 rotor groups to spin
      wings: [],
      mats: { orange: orange, dark: dark, eye: eyeMat },
      restOffset: 0.33 // origin height above a pad top when parked (belly rest)
    };
    return g;
  }

  var W = (typeof window !== 'undefined') ? window : undefined;
  if (W) {
    W.DAADroneVariants = {
      buildBeeDrone: buildBeeDrone,
      buildScoutDrone: buildScoutDrone
    };
  }
})();
