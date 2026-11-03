// Detroit Automation Academy — groundwork kit.
//
// Ground-realism pass over the district core (|x| <= 65, |z| <= 65):
//  1. terrain undulation in open grass (displaced patches, amplitude <= 0.15 m)
//  2. painted transition overlays (grass -> worn path) along desire lines
//  3. Detroit River water detail: wave/glint surface, riprap shoreline,
//     two wooden docks (piles + deck planks + mooring bollards)
//  4. grounding decals: soft dark radial gradients at each building base
//     (design-standard item 5)
//  5. grass tuft planting in open areas, clear of roads and structures
//
// Units meters; three.js x = east, z = south, y = up. Base ground top y = 0,
// road/plaza pad top y = 0.35 (see streetscape.js). Classic IIFE script,
// 'use strict', no imports. Exposes window.DAAGroundwork.
(function () {
  'use strict';

  var CORE = 65;       // district core half-extent handled by this module
  var GROUND_Y = 0;    // top of the base ground plane
  var PAD_Y = 0.35;    // top of the road / plaza pad surfaces
  var CLEAR = 0.015;   // minimum overlay separation to avoid z-fighting

  // deterministic PRNG so textures and scatter are stable across loads
  function rnd(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function cv(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(w));
    c.height = Math.max(2, Math.round(h));
    return [c, c.getContext('2d')];
  }

  function shade(rgb, f) {
    var r = Math.max(0, Math.min(255, Math.round(rgb[0] * f)));
    var g = Math.max(0, Math.min(255, Math.round(rgb[1] * f)));
    var b = Math.max(0, Math.min(255, Math.round(rgb[2] * f)));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function tex(THREE, canvas, rx, ry) {
    var t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (rx) t.repeat.set(rx, ry == null ? rx : ry);
    return t;
  }

  // Building footprints measured from the district builders: [x0, x1, z0, z1].
  // Grounding decals sit UNDER these footprints, never overlapping walls.
  var BUILDINGS = [
    [-13.3, 13.3, -10.3, 11.7],   // workshop
    [-17.4, 17.4, -12.4, 16.1],   // academy HQ
    [27.3, 64.4, -45.2, 22.0],    // corktown rowhouses
    [-22.0, 28.8, -53.3, -10.0],  // UMCI
    [-58.5, -29.3, -8.1, 14.0],   // thinkabit lab
    [-17.0, 17.0, 31.0, 52.6]     // riverfront pavilion
  ];

  var ROADS = [ // road corridors [x0, x1, z0, z1]
    [-4, 4, -65, -17],  // north spoke
    [-4, 4, 17, 65],    // south spoke
    [17, 65, -4, 4],    // east spoke
    [-65, -17, -4, 4]   // west spoke
  ];
  var PLAZA = [-17, 17, -17, 17]; // 34x34 central pad

  // Forge Line guideway centerline and intercity viaduct centerline (x, z).
  var GUIDE = [
    [22.5, -8], [22.5, 22], [17.5, 27], [-20.6, 27], [-25.6, 22],
    [-25.6, -50.5], [-23.0, -56.5], [17.5, -56.5], [22.5, -56.5]
  ];
  var VIADUCT = [[64, 32], [20, 32]];

  function inRect(x, z, r, pad) {
    return x > r[0] - pad && x < r[1] + pad && z > r[2] - pad && z < r[3] + pad;
  }

  function distPtSeg(px, pz, ax, az, bx, bz) {
    var dx = bx - ax, dz = bz - az;
    var len2 = dx * dx + dz * dz;
    var t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    var cx = ax + t * dx - px, cz = az + t * dz - pz;
    return Math.sqrt(cx * cx + cz * cz);
  }

  function distToPoly(px, pz, poly) {
    var d = Infinity, i;
    for (i = 0; i < poly.length - 1; i++) {
      d = Math.min(d, distPtSeg(px, pz, poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1]));
    }
    return d;
  }

  // ---- canvas textures -------------------------------------------------

  // mottled grass: muted green base, speckle, a few bare-earth patches
  function grassCanvas(seed) {
    var p = cv(256, 256), c = p[0], x = p[1], W = c.width, H = c.height;
    var R = rnd(seed), i;
    x.fillStyle = '#3f3f3f';
    x.fillRect(0, 0, W, H);
    for (i = 0; i < 2600; i++) {
      x.fillStyle = shade([46, 74, 51], 0.72 + R() * 0.55);
      var s = 1 + R() * 2;
      x.fillRect(R() * W, R() * H, s, s);
    }
    for (i = 0; i < 9; i++) { // worn bare patches
      x.fillStyle = 'rgba(106,106,106,0.45)';
      x.beginPath();
      x.arc(R() * W, R() * H, 6 + R() * 16, 0, 6.2832);
      x.fill();
    }
    return c;
  }

  // worn dirt path: tan band along local Y with soft alpha falloff at edges
  function pathCanvas() {
    var p = cv(128, 256), c = p[0], x = p[1], W = c.width, H = c.height;
    var R = rnd(5150), ix, iy;
    for (ix = 0; ix < W; ix++) {
      var edge = Math.abs(ix / W - 0.5) * 2;      // 0 center -> 1 edge
      var a = Math.max(0, 1 - edge * edge * 1.6); // soft falloff
      for (iy = 0; iy < H; iy += 2) {
        if (R() < a) {
          x.fillStyle = shade([138, 122, 92], 0.8 + R() * 0.4);
          x.globalAlpha = 0.25 + a * 0.55;
          x.fillRect(ix, iy, 1, 2);
        }
      }
    }
    x.globalAlpha = 1;
    return c;
  }

  // river surface: deep teal, horizontal wave streaks, sun-glint speckle
  function waterCanvas() {
    var p = cv(512, 512), c = p[0], x = p[1], W = c.width, H = c.height;
    var R = rnd(4101), i;
    x.fillStyle = '#565656';
    x.fillRect(0, 0, W, H);
    for (i = 0; i < 220; i++) {
      x.fillStyle = shade([29, 106, 134], 0.85 + R() * 0.5);
      x.globalAlpha = 0.25 + R() * 0.25;
      x.fillRect(R() * W - 80, R() * H, 40 + R() * 160, 1 + R() * 3);
    }
    x.globalAlpha = 1;
    for (i = 0; i < 130; i++) { // glints
      x.fillStyle = 'rgba(243,243,243,' + (0.25 + R() * 0.5).toFixed(2) + ')';
      var s = 1 + R() * 2;
      x.fillRect(R() * W, R() * H, s, s);
    }
    return c;
  }

  // soft dark radial gradient for grounding decals (shared by all decals)
  function decalCanvas() {
    var p = cv(256, 256), c = p[0], x = p[1];
    var g = x.createRadialGradient(128, 128, 8, 128, 128, 128);
    g.addColorStop(0, 'rgba(0,0,0,0.42)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 256, 256);
    return c;
  }

  // grass tuft sprite: vertical blades on transparency
  function tuftCanvas() {
    var p = cv(64, 64), c = p[0], x = p[1];
    var R = rnd(777), i;
    for (i = 0; i < 46; i++) {
      var bx = 6 + R() * 52, h = 20 + R() * 40;
      x.fillStyle = shade([58, 112, 66], 0.75 + R() * 0.5);
      x.fillRect(bx, 64 - h, 2, h);
    }
    return c;
  }

  // ---- terrain ---------------------------------------------------------

  // gentle analytic undulation; |h| <= 0.15 everywhere by construction
  function groundH(x, z) {
    return 0.15 * (0.6 * Math.sin(0.35 * x + 1.7) * Math.sin(0.30 * z + 0.6) +
                   0.4 * Math.sin(0.90 * x + 0.5) * Math.sin(0.80 * z + 2.1));
  }

  // smooth cosine falloff to zero within 3 m of the patch border
  function falloff(x, z, r) {
    var e = Math.min(x - r[0], r[1] - x, z - r[2], r[3] - z, 3) / 3;
    e = Math.max(0, Math.min(1, e));
    return e * e * (3 - 2 * e);
  }

  // open-grass patches, each verified clear of roads, plaza, buildings,
  // guideway/viaduct corridors and water: [x0, x1, z0, z1]
  var PATCHES = [
    [30, 64, -65, -52],   // NE corner grass, north of the rowhouse block
    [42, 64, 41, 51.5],   // east riverfront grass, south of the viaduct
    [-65, -32, -65, -12], // west-north grass, west of the guideway
    [-65, -32, 18, 50]    // south-west grass, west of the guideway corridor
  ];

  // ---- grounding decals ------------------------------------------------
  // [x0, x1, z0, z1, y]: ~1.15x footprints, split where a road corridor or
  // the plaza-pad edge passes under them. y = 0.37 on the pad (0.35 top),
  // 0.02 on grass. All pieces stay under the walls they darken.
  var DECALS = [
    [-15.30, 15.30, -11.95, 13.35, 0.37],   // workshop (plaza pad)
    [-16.90, 16.90, -14.54, 16.90, 0.37],   // academy HQ (pad; clamped inside pad edge)
    [24.52, 65.00, -50.24, -4.20, 0.02],    // corktown, north of the E road
    [24.52, 65.00, 4.20, 27.04, 0.02],      // corktown, south of the E road
    [-25.81, -4.20, -56.55, -17.00, 0.02],  // UMCI, north grass west of N road
    [4.20, 32.61, -56.55, -17.00, 0.02],    // UMCI, north grass east of N road
    [-25.81, -17.00, -17.00, -6.75, 0.02],  // UMCI, west grass strip
    [-17.00, 17.00, -17.00, -6.75, 0.37],   // UMCI, on the plaza pad
    [17.00, 32.61, -17.00, -6.75, 0.02],    // UMCI, east grass strip
    [-60.69, -27.11, -9.76, -4.20, 0.02],   // thinkabit, north of the W road
    [-60.69, -27.11, 4.20, 15.66, 0.02],    // thinkabit, south of the W road
    [-19.55, -4.20, 29.38, 52.90, 0.02],    // pavilion, west of the S road
    [4.20, 19.55, 29.38, 52.90, 0.02]       // pavilion, east of the S road
  ];

  // ---- desire-line paths -----------------------------------------------
  // [x0, x1, z0, z1] painted worn-path overlays on grass, y = 0.04
  var PATHS = [
    [7, 10, 17, 31],      // plaza SE -> pavilion north, beside the S sidewalk
    [-29, -17, 7, 13],    // thinkabit east -> plaza west
    [40, 44, 27, 40.5],   // corktown -> riverfront, passing under the viaduct
    [-19, -15, 17, 29],   // plaza SW -> pavilion west
    [30, 60, -52, -46]    // along the north side of the rowhouse block
  ];

  // ---- planting zones --------------------------------------------------
  // open-grass tuft zones [x0, x1, z0, z1]; every sample is re-checked
  // against roads, plaza, footprints, patches and corridors before placing
  var ZONES = [
    [-30, -20, -60, -40],
    [6, 16, -64, -62],
    [-16, -6, -64, -62],
    [36, 64, -52, -46],
    [-18, -6, 20, 30],
    [36, 52, -50, -47],   // north of the rowhouse block, east of the UMCI decal
    [20, 26, 40.5, 50]    // grass between the S road corridor and the viaduct
  ];

  function buildGroundwork(THREE) {
    var g = new THREE.Group();
    var i, j;

    function flatMesh(w, d, mat, x, y, z, kind, baseY) {
      var m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
      m.geometry.rotateX(-Math.PI / 2);
      m.position.set(x, y, z);
      m.receiveShadow = true;
      m.userData.kind = kind;
      m.userData.groundDecal = true; // flat paint: exempt from the >0.5 m building check
      m.userData.baseY = baseY;
      g.add(m);
      return m;
    }

    // ---- 1. terrain undulation ----------------------------------------
    var grassC = grassCanvas(9001);
    PATCHES.forEach(function (r, pi) {
      var w = r[1] - r[0], d = r[3] - r[2];
      var cx = (r[0] + r[1]) / 2, cz = (r[2] + r[3]) / 2;
      var geo = new THREE.PlaneGeometry(w, d, Math.round(w), Math.round(d));
      var pos = geo.attributes.position;
      var mn = Infinity, mx = -Infinity;
      for (i = 0; i < pos.count; i++) {
        var wx = cx + pos.getX(i), wz = cz - pos.getY(i);
        var h = 0.02 + groundH(wx, wz) * falloff(wx, wz, r);
        pos.setZ(i, h);
        if (h < mn) mn = h;
        if (h > mx) mx = h;
      }
      geo.computeVertexNormals();
      geo.rotateX(-Math.PI / 2);
      var t = tex(THREE, grassC, w / 6, d / 6);
      var mat = new THREE.MeshStandardMaterial({
        map: t, roughness: 1, metalness: 0,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
      });
      var m = new THREE.Mesh(geo, mat);
      m.position.set(cx, 0, cz);
      m.receiveShadow = true;
      m.userData.kind = 'terrain';
      m.userData.groundDecal = true;
      m.userData.baseY = GROUND_Y;
      m.userData.yRange = [mn, mx]; // world y extents (position.y == 0)
      g.add(m);
    });

    // ---- 2. river water surface ---------------------------------------
    var wtex = tex(THREE, waterCanvas(), 8, 1);
    var mWater = new THREE.MeshStandardMaterial({
      map: wtex, roughness: 0.4, metalness: 0.05,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
    flatMesh(130, 12, mWater, 0, 0.02, 59, 'water', GROUND_Y);

    // ---- 3. riprap shoreline ------------------------------------------
    // irregular gray stones along z ~= 53; skipped where the S road meets
    // the water, along the pavilion waterfront, and at the two dock gaps
    var R = rnd(31337);
    var stoneGeo = new THREE.DodecahedronGeometry(0.5, 0);
    var stoneMat = new THREE.MeshStandardMaterial({
      color: 0x8c8c8c, roughness: 0.95, metalness: 0, flatShading: true
    });
    var spots = [];
    for (var sx = -65; sx <= 65; sx += 1.7) {
      for (j = 0; j < 2; j++) {
        var px = sx + (R() - 0.5) * 1.1 + j * 0.8;
        if (px < -CORE || px > CORE) continue;
        if (px > -18 && px < 18) continue;                    // S road + pavilion waterfront
        if (px > -41.5 && px < -38.5) continue;               // west dock gap
        if (px > 43.5 && px < 46.5) continue;                 // east dock gap
        var pz = 53.1 + R() * 1.2 + j * 0.55;
        var ss = 0.7 + R() * 0.6;
        spots.push({ x: px, z: pz, s: ss });
      }
    }
    var rip = new THREE.InstancedMesh(stoneGeo, stoneMat, spots.length);
    var m4 = new THREE.Matrix4();
    var inst = [];
    spots.forEach(function (s, k) {
      m4.makeTranslation(s.x, -0.18 * s.s, s.z);
      m4.scale(new THREE.Vector3(s.s, s.s * 0.8, s.s));
      rip.setMatrixAt(k, m4);
      inst.push({ x: s.x, y: -0.18 * s.s, z: s.z, sx: s.s, sy: s.s * 0.8, sz: s.s });
    });
    rip.userData.kind = 'riprap';
    rip.userData.instances = inst;
    rip.receiveShadow = true;
    rip.castShadow = true;
    g.add(rip);

    // ---- 4. docks ------------------------------------------------------
    var mDeck = new THREE.MeshStandardMaterial({ color: 0x717171, roughness: 0.9 });
    var mPile = new THREE.MeshStandardMaterial({ color: 0x4f4f4f, roughness: 0.95 });
    var mBoll = new THREE.MeshStandardMaterial({ color: 0x303030, roughness: 0.6, metalness: 0.4 });

    function dock(dx) {
      var parts = [];
      var k;
      for (k = 0; k < 32; k++) { // deck planks, 8 m run z = 53.15..60.9
        var plank = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.06, 0.19), mDeck);
        plank.position.set(dx, 0.90, 53.15 + k * 0.25);
        parts.push(plank);
      }
      [-0.9, 0.9].forEach(function (ox) { // stringers under the deck
        var st = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.15, 7.9), mPile);
        st.position.set(dx + ox, 0.78, 57.02);
        parts.push(st);
      });
      [53.6, 57.0, 60.4].forEach(function (pz) { // piles, sunk into the riverbed
        [-1.0, 1.0].forEach(function (ox) {
          // the z=57 pair lands under the promenade boardwalk (deck y 0.1..0.5):
          // keep it short so it doesn't pierce the deck.
          var underBoardwalk = Math.abs(pz - 57.0) < 1e-9;
          var ph = underBoardwalk ? 0.85 : 1.8, py = underBoardwalk ? -0.375 : 0.1;
          var pile = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, ph, 7), mPile);
          pile.position.set(dx + ox, py, pz);
          parts.push(pile);
        });
      });
      [-0.8, 0.8].forEach(function (ox) { // mooring bollards
        var b = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.35, 10), mBoll);
        b.position.set(dx + ox, 1.105, 60.5);
        parts.push(b);
      });
      parts.forEach(function (m) {
        m.castShadow = true;
        m.receiveShadow = true;
        m.userData.kind = 'dock';
        m.userData.dockX = dx;
        g.add(m);
      });
    }
    dock(-40);
    dock(45);

    // ---- 5. grounding decals (design-standard item 5) ------------------
    var dtex = tex(THREE, decalCanvas());
    var mDecal = new THREE.MeshBasicMaterial({
      map: dtex, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
    DECALS.forEach(function (d) {
      var w = d[1] - d[0], dep = d[3] - d[2];
      flatMesh(w, dep, mDecal, (d[0] + d[1]) / 2, d[4], (d[2] + d[3]) / 2,
               'decal', d[4] > 0.3 ? PAD_Y : GROUND_Y);
    });

    // ---- 6. desire-line path overlays ----------------------------------
    var ptex = tex(THREE, pathCanvas());
    PATHS.forEach(function (r) {
      var w = r[1] - r[0], len = r[3] - r[2];
      var t = ptex.clone();
      t.needsUpdate = true;
      t.repeat.set(1, len / 5);
      var mat = new THREE.MeshStandardMaterial({
        map: t, transparent: true, roughness: 1, metalness: 0, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
      });
      flatMesh(w, len, mat, (r[0] + r[1]) / 2, 0.04, (r[2] + r[3]) / 2, 'path', GROUND_Y);
    });

    // ---- 7. grass tufts -------------------------------------------------
    function tuftOK(x, z) {
      var k;
      if (z > 52) return false;                    // river
      for (k = 0; k < ROADS.length; k++) {
        if (inRect(x, z, ROADS[k], 1)) return false;
      }
      if (inRect(x, z, PLAZA, 1.5)) return false;
      for (k = 0; k < BUILDINGS.length; k++) {
        if (inRect(x, z, BUILDINGS[k], 1.5)) return false;
      }
      for (k = 0; k < PATCHES.length; k++) {
        if (inRect(x, z, PATCHES[k], 0.5)) return false;
      }
      if (distToPoly(x, z, GUIDE) < 5.5) return false;   // guideway + pylon clearance
      if (distToPoly(x, z, VIADUCT) < 8) return false;   // viaduct corridor
      return true;
    }

    var tuftTex = tex(THREE, tuftCanvas());
    var tuftGeoA = new THREE.PlaneGeometry(0.9, 0.6);
    var tuftGeoB = new THREE.PlaneGeometry(0.9, 0.6);
    var mTuft = new THREE.MeshStandardMaterial({
      map: tuftTex, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 1, metalness: 0
    });
    var RT = rnd(20260930);
    var tuftsPerZone = [];
    ZONES.forEach(function (zn) {
      var placed = 0, tries = 0;
      while (placed < 7 && tries < 400) {
        tries++;
        var tx = zn[0] + RT() * (zn[1] - zn[0]);
        var tz = zn[2] + RT() * (zn[3] - zn[2]);
        if (!tuftOK(tx, tz)) continue;
        var s = 0.7 + RT() * 0.6;
        var rot = RT() * Math.PI;
        [tuftGeoA, tuftGeoB].forEach(function (geo, gi) {
          var m = new THREE.Mesh(geo, mTuft);
          m.position.set(tx, 0.03 + 0.3 * s, tz);
          m.rotation.y = rot + gi * Math.PI / 2;
          m.scale.set(s, s, s);
          m.userData.kind = 'tuft';
          g.add(m);
        });
        placed++;
      }
      tuftsPerZone.push(placed);
    });
    g.userData.tuftsPerZone = tuftsPerZone;

    return g;
  }

  window.DAAGroundwork = { buildGroundwork: buildGroundwork };
})();
