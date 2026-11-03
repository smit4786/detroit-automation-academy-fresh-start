// Detroit Automation Academy — street furniture kit.
// Cobra-head street lamps, plaza benches + planters, perimeter bollards,
// procedural street trees. Classic script; exposes window.DAAFurniture.
// Placement arrays below are the audit survivors: every spot clears the
// measured building footprints by >= 1.5 m and the district approach points
// by >= 3 m. Deferred spec positions (all inside measured footprints) are
// listed in the comment block above each array and in
// overnight-2026-10-01/furniture-validation.txt.
(function () {
  'use strict';

  var BASE_Y = 0.35; // top of paved surfaces (road / sidewalk / plaza)

  // x, z, arm direction (dx, dz) toward the road
  // Deferred (inside measured footprints): N spoke (-5.6,-24/-38/-52) UMCI,
  // S spoke (-5.6,38/52) Riverfront, E spoke (38/52,-5.6) Corktown,
  // W spoke (-38/-52,-5.6) Thinkabit.
  var LAMP_SPOTS = [[-5.6, 24, 1, 0], [24, -5.6, 0, 1], [-24, -5.6, 0, 1]];

  // x, z, rotation.y facing the plaza center
  // Deferred: (14.6,-14.6) and (-14.6,-14.6) inside UMCI.
  var BENCH_SPOTS = [[14.6, 14.6, -2.3562], [-14.6, 14.6, 2.3562]];

  // x, z — 1.2 m square concrete boxes
  // Deferred: (16.2,-13) and (-16.2,-13) inside UMCI.
  var PLANTER_SPOTS = [[16.2, 13], [-16.2, 13]];

  // x, z, scale — riverfront promenade row, pocket-park cluster, plaza corners
  // Deferred: N spoke row (UMCI verge overlap); plaza corners (15.2,-15.2)
  // and (-15.2,-15.2) inside UMCI.
  var TREE_SPOTS = [
    [-30, 48, 1.3], [-25, 48, 1.3], [-20, 48, 1.3],
    [20, 48, 1.3], [25, 48, 1.3], [30, 48, 1.3],
    [35, 12, 1], [41, 12, 1], [47, 12, 1], [53, 12, 1], [56, 12, 1],
    [15.2, 15.2, 1.2], [-15.2, 15.2, 1.2]
  ];

  // x, z — plaza perimeter ring at |coord| = 16.2, spoke crossings skipped
  // Deferred: the z = -16.2 run and (±16.2,-16)/(±16.2,-12), inside UMCI.
  var BOLLARD_SPOTS = [
    [-16, 16.2], [-12, 16.2], [-8, 16.2], [8, 16.2], [12, 16.2], [16, 16.2],
    [16.2, -8], [16.2, 8], [16.2, 12], [16.2, 16],
    [-16.2, -8], [-16.2, 8], [-16.2, 12], [-16.2, 16]
  ];

  function makeMats(THREE) {
    return {
      pole: new THREE.MeshStandardMaterial({ color: 0x3e3e3e, roughness: 0.5, metalness: 0.6 }),
      head: new THREE.MeshStandardMaterial({ color: 0x262626, roughness: 0.6, metalness: 0.4 }),
      lens: new THREE.MeshStandardMaterial({ color: 0xf5f5f5, emissive: 0xececec, emissiveIntensity: 0.35, roughness: 0.4 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x707070, roughness: 0.9 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x2e2e2e, roughness: 0.6, metalness: 0.5 }),
      conc: new THREE.MeshStandardMaterial({ color: 0x9f9f9f, roughness: 0.95 }),
      trunk: new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 1 }),
      leaf: new THREE.MeshStandardMaterial({ color: 0x646464, roughness: 1 }),
      leaf2: new THREE.MeshStandardMaterial({ color: 0x707070, roughness: 1 }),
      amber: new THREE.MeshStandardMaterial({ color: 0x858585, emissive: 0xb4b4b4, emissiveIntensity: 0.55, roughness: 0.3 })
    };
  }

  function makeGeos(THREE) {
    return {
      lampBase: new THREE.CylinderGeometry(0.22, 0.26, 0.14, 10),
      lampPole: new THREE.CylinderGeometry(0.12, 0.14, 7.3, 10),
      strut: new THREE.CylinderGeometry(0.06, 0.07, 1, 8),
      lampHead: new THREE.BoxGeometry(0.75, 0.16, 0.32),
      lampLens: new THREE.BoxGeometry(0.55, 0.04, 0.22),
      benchSeat: new THREE.BoxGeometry(1.8, 0.08, 0.5),
      benchBack: new THREE.BoxGeometry(1.8, 0.5, 0.07),
      benchLeg: new THREE.BoxGeometry(0.08, 0.85, 0.5),
      planter: new THREE.BoxGeometry(1.2, 0.6, 1.2),
      shrub: new THREE.IcosahedronGeometry(1, 1),
      bollard: new THREE.CylinderGeometry(0.09, 0.1, 0.95, 10),
      band: new THREE.CylinderGeometry(0.098, 0.098, 0.12, 10),
      cap: new THREE.SphereGeometry(0.09, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      trunk: new THREE.CylinderGeometry(0.14, 0.2, 3.0, 8),
      canopy: new THREE.IcosahedronGeometry(1, 1)
    };
  }

  var UP = null;
  function strut(THREE, parent, geo, mat, ax, ay, az, bx, by, bz) {
    if (!UP) UP = new THREE.Vector3(0, 1, 0);
    var m = new THREE.Mesh(geo, mat);
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    m.scale.set(1, len, 1);
    m.quaternion.setFromUnitVectors(UP, new THREE.Vector3(dx / len, dy / len, dz / len));
    parent.add(m);
    return m;
  }

  // Cobra-head street lamp, ~7 m: pole, two-segment upswept arm reaching
  // 1.8 m toward the road, head box with a pale emissive lens.
  function lamp(THREE, x, z, dx, dz, M, G) {
    var g = new THREE.Group();
    var base = new THREE.Mesh(G.lampBase, M.conc);
    base.position.y = 0.07; g.add(base);
    var pole = new THREE.Mesh(G.lampPole, M.pole);
    pole.position.y = 3.35; g.add(pole); // spans y -0.3..7.0
    strut(THREE, g, G.strut, M.pole, 0, 6.55, 0, 0.9 * dx, 6.95, 0.9 * dz);
    strut(THREE, g, G.strut, M.pole, 0.9 * dx, 6.95, 0.9 * dz, 1.8 * dx, 6.95, 1.8 * dz);
    var head = new THREE.Mesh(G.lampHead, M.head);
    head.position.set(1.8 * dx, 6.9, 1.8 * dz);
    head.rotation.y = Math.atan2(dx, dz);
    g.add(head);
    var lens = new THREE.Mesh(G.lampLens, M.lens);
    lens.position.set(1.8 * dx, 6.8, 1.8 * dz);
    lens.rotation.y = Math.atan2(dx, dz);
    g.add(lens);
    g.position.set(x, BASE_Y, z);
    return g;
  }

  // Plaza bench: wood slats, steel legs, faces rotation.y.
  function bench(THREE, x, z, theta, M, G) {
    var b = new THREE.Group();
    var seat = new THREE.Mesh(G.benchSeat, M.wood);
    seat.position.y = 0.45; b.add(seat);
    var back = new THREE.Mesh(G.benchBack, M.wood);
    back.position.set(0, 0.75, -0.25); b.add(back);
    [-0.8, 0.8].forEach(function (lx) {
      var leg = new THREE.Mesh(G.benchLeg, M.steel);
      leg.position.set(lx, 0.025, 0); b.add(leg); // spans y -0.4..0.45
    });
    b.position.set(x, BASE_Y, z);
    b.rotation.y = theta;
    return b;
  }

  // Concrete planter box with a small shrub cluster.
  function planter(THREE, x, z, M, G, seed) {
    var p = new THREE.Group();
    var box = new THREE.Mesh(G.planter, M.conc);
    box.position.y = 0.3; p.add(box);
    var lm = (seed % 2 === 0) ? M.leaf : M.leaf2;
    [[0, 0.95, 0, 0.38], [0.3, 1.15, 0.15, 0.3], [-0.28, 0.85, -0.12, 0.26]].forEach(function (sb) {
      var m = new THREE.Mesh(G.shrub, lm);
      m.scale.setScalar(sb[3]);
      m.position.set(sb[0], sb[1], sb[2]);
      p.add(m);
    });
    p.position.set(x, BASE_Y, z);
    return p;
  }

  // Steel bollard with an amber reflective band.
  function bollard(THREE, x, z, M, G) {
    var b = new THREE.Group();
    var post = new THREE.Mesh(G.bollard, M.steel);
    post.position.y = 0.275; b.add(post); // spans y -0.2..0.75
    var band = new THREE.Mesh(G.band, M.amber);
    band.position.y = 0.55; b.add(band);
    var cap = new THREE.Mesh(G.cap, M.steel);
    cap.position.y = 0.75; b.add(cap);
    b.position.set(x, BASE_Y, z);
    return b;
  }

  // Procedural street tree: trunk + three icosahedron canopy blobs.
  // y0 lets the same builder sit on pavement (0.35) or grade (0).
  function tree(THREE, x, z, s, y0, M, G, seed) {
    var t = new THREE.Group();
    var trunk = new THREE.Mesh(G.trunk, M.trunk);
    trunk.position.y = 1.1; t.add(trunk); // spans y -0.4..2.6
    var lm = (seed % 2 === 0) ? M.leaf : M.leaf2;
    [[0, 3.4, 0, 1.7], [0.7, 2.8, 0.3, 1.2], [-0.6, 2.9, -0.3, 1.1]].forEach(function (cb) {
      var m = new THREE.Mesh(G.canopy, lm);
      m.scale.setScalar(cb[3]);
      m.position.set(cb[0], cb[1], cb[2]);
      t.add(m);
    });
    t.scale.setScalar(s);
    t.rotation.y = (seed * 1.7) % (Math.PI * 2);
    t.position.set(x, y0, z);
    return t;
  }

  function buildFurniture(THREE) {
    var g = new THREE.Group();
    var M = makeMats(THREE);
    var G = makeGeos(THREE);
    var i;

    for (i = 0; i < LAMP_SPOTS.length; i++) {
      var lp = LAMP_SPOTS[i];
      g.add(lamp(THREE, lp[0], lp[1], lp[2], lp[3], M, G));
    }
    for (i = 0; i < BENCH_SPOTS.length; i++) {
      var bp = BENCH_SPOTS[i];
      g.add(bench(THREE, bp[0], bp[1], bp[2], M, G));
    }
    for (i = 0; i < PLANTER_SPOTS.length; i++) {
      var pp = PLANTER_SPOTS[i];
      g.add(planter(THREE, pp[0], pp[1], M, G, i));
    }
    for (i = 0; i < BOLLARD_SPOTS.length; i++) {
      var op = BOLLARD_SPOTS[i];
      g.add(bollard(THREE, op[0], op[1], M, G));
    }
    for (i = 0; i < TREE_SPOTS.length; i++) {
      var tp = TREE_SPOTS[i];
      // plaza corner trees sit on paving; promenade and park trees on grade
      var onPaving = Math.abs(tp[0]) < 17 && Math.abs(tp[1]) < 17;
      g.add(tree(THREE, tp[0], tp[1], tp[2], onPaving ? BASE_Y : 0, M, G, i));
    }

    g.traverse(function (o) {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    return g;
  }

  window.DAAFurniture = { buildFurniture: buildFurniture };
})();
