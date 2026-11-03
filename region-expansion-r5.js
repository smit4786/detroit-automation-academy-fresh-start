/* region-expansion-r5.js
 * Round-5 overnight build (2026-10-01, local only): expands the district to
 * ~20 sq mi by adding the outer ring around the round-4 1 sq mi core.
 *
 * Strategy for 20x area without 20x draw calls (LOD tiers):
 *  - Far/mid field: instanced archetype masses (6), instanced houses (2 draw
 *    calls), instanced trees (2), instanced lamps (1). Single-digit draw
 *    calls per category.
 *  - Ground: 3 large slabs with canvas-painted street grid (3 draw calls).
 *  - Near-core accents: 6 articulated landmarks (groups of boxes).
 *  - Fog-friendly: all materials default fog:true so scene fog applies.
 *  - No per-frame allocations: build-time only; deterministic seeded PRNG.
 *
 * window.DAARegionExpansionR5.buildRegionExpansionR5(THREE) -> THREE.Group
 * window.DAARegionExpansionR5.ROWS  -> ROW rects (for the geometry audit)
 * window.DAARegionExpansionR5.stats() -> build counts
 */
(function () {
  'use strict';

  // ---------------- deterministic PRNG ----------------
  function rnd(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function shade(rgb, f) {
    var r = Math.max(0, Math.min(255, Math.round(rgb[0] * f)));
    var g = Math.max(0, Math.min(255, Math.round(rgb[1] * f)));
    var b = Math.max(0, Math.min(255, Math.round(rgb[2] * f)));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  // ---------------- canvas helpers ----------------
  var PXM = 16; // texture pixels per meter for archetype facades (far-field LOD)
  function cv(wPx, hPx) {
    var c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(wPx));
    c.height = Math.max(2, Math.round(hPx));
    return [c, c.getContext('2d')];
  }
  function tex(THREE, canvas) {
    var t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }
  function std(THREE, map, color, roughness) {
    return new THREE.MeshStandardMaterial({
      map: map || null,
      color: color == null ? 0xffffff : color,
      roughness: roughness == null ? 0.92 : roughness,
      metalness: 0
    });
  }

  // ---------------- geography ----------------
  // Units are meters. Water band: z > 53 (Detroit River, south edge).
  // Round-4 core rect (already built, never touched): x[-1150,1150], z[-1100,53].
  var R4 = { x0: -1150, x1: 1150, z0: -1100, z1: 53 };
  var ZONES = [
    { name: 'west',  x0: -3700, x1: -1150, z0: -6950, z1: 53   },
    { name: 'east',  x0: 1150,  x1: 3700,  z0: -6950, z1: 53   },
    { name: 'north', x0: -1150, x1: 1150,  z0: -6950, z1: -1100 }
  ];
  // Total: x[-3700,3700] (7400 m) x z[-6950,53] (7003 m)
  //   = 51,822,200 m^2 = 20.0086 sq mi (1 sq mi = 2,589,988 m^2)

  // E-W streets: {z, hw, name?} — named ones are real Detroit arterials.
  var EW = [
    { z: 45, hw: 9, name: 'Fort St' },
    { z: -30, hw: 9, name: 'Michigan Ave' },
    { z: -70, hw: 9, name: 'Vernor Hwy' },
    { z: -150, hw: 7, name: 'Bagley St' },
    { z: -185, hw: 7, name: 'Porter St' },
    { z: -1400, hw: 9, name: 'W Warren Ave' },
    { z: -3400, hw: 9, name: 'W Davison' },
    { z: -5400, hw: 9, name: 'W McNichols Ave' }
  ];
  // minor E-W grid, 200 m pitch, skipping near named arterials
  (function () {
    for (var z = -600; z >= -6800; z -= 200) {
      var clash = false;
      for (var i = 0; i < EW.length; i++) {
        if (Math.abs(EW[i].z - z) < 40) { clash = true; break; }
      }
      if (!clash) EW.push({ z: z, hw: 5, name: null });
    }
    EW.sort(function (a, b) { return b.z - a.z; });
  })();

  // N-S avenues: {x, hw, name?}
  var NS = [
    { x: -3000, hw: 6, name: 'Wyoming Ave' },
    { x: -2200, hw: 6, name: 'Livernois Ave' },
    { x: -1400, hw: 6, name: 'Dexter Ave' },
    { x: -600, hw: 6, name: 'Linwood Ave' },
    { x: 600, hw: 6, name: 'Rosa Parks Blvd' },
    { x: 800, hw: 6, name: 'Trumbull Ave' }
  ];
  (function () {
    for (var x = -3600; x <= 3600; x += 200) {
      var clash = false;
      for (var i = 0; i < NS.length; i++) {
        if (Math.abs(NS[i].x - x) < 40) { clash = true; break; }
      }
      if (!clash) NS.push({ x: x, hw: 5, name: null });
    }
    NS.sort(function (a, b) { return a.x - b.x; });
  })();

  // ROW rects for the audit: {x0,x1,z0,z1,name}
  var ROWS = [];
  (function () {
    var i;
    for (i = 0; i < EW.length; i++) {
      ROWS.push({ x0: -3700, x1: 3700, z0: EW[i].z - EW[i].hw, z1: EW[i].z + EW[i].hw, name: EW[i].name || 'ew-minor' });
    }
    for (i = 0; i < NS.length; i++) {
      ROWS.push({ x0: NS[i].x - NS[i].hw, x1: NS[i].x + NS[i].hw, z0: -6950, z1: 53, name: NS[i].name || 'ns-minor' });
    }
  })();

  function inR4(x, z) {
    return x >= R4.x0 && x <= R4.x1 && z >= R4.z0 && z <= R4.z1;
  }
  function inZones(x, z) {
    for (var i = 0; i < ZONES.length; i++) {
      var zn = ZONES[i];
      if (x >= zn.x0 && x <= zn.x1 && z >= zn.z0 && z <= zn.z1) return true;
    }
    return false;
  }
  function rectsOverlap(a, b) {
    return a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
  }

  // ---------------- painters ----------------
  // Ground slab texture: paints the street grid for one zone. 2048 px canvas.
  function paintGround(g, W, H, zn, seed) {
    var R = rnd(seed);
    var i;
    // base: muted urban ground with patchiness
    g.fillStyle = '#757575'; g.fillRect(0, 0, W, H);
    for (i = 0; i < 2600; i++) {
      var px = R() * W, py = R() * H, s = 2 + R() * 14;
      var v = 0.85 + R() * 0.35;
      g.fillStyle = shade([111, 122, 104], v);
      g.fillRect(px, py, s, s);
    }
    var wM = zn.x1 - zn.x0, dM = zn.z1 - zn.z0;
    var sx = W / wM, sz = H / dM;
    function X(x) { return (x - zn.x0) * sx; }
    function Z(z) { return (z - zn.z0) * sz; }
    // block interiors: vacant lots / grass / paving variation
    for (i = 0; i < 260; i++) {
      var bx = R() * W, bz = R() * H, bw = (60 + R() * 200) * sx, bh = (60 + R() * 200) * sz;
      var pal = [[104, 116, 96], [128, 128, 120], [96, 104, 92], [140, 136, 124]];
      var c = pal[Math.floor(R() * pal.length)];
      g.fillStyle = shade(c, 0.85 + R() * 0.3);
      g.fillRect(bx, bz, bw, bh);
    }
    // minor streets
    var e, n;
    g.fillStyle = '#404040';
    for (e = 0; e < EW.length; e++) {
      if (EW[e].name) continue;
      var z0 = EW[e].z - EW[e].hw, z1 = EW[e].z + EW[e].hw;
      if (z1 < zn.z0 || z0 > zn.z1) continue;
      g.fillRect(0, Z(Math.max(z0, zn.z0)), W, (Math.min(z1, zn.z1) - Math.max(z0, zn.z0)) * sz);
    }
    for (n = 0; n < NS.length; n++) {
      if (NS[n].name) continue;
      var x0 = NS[n].x - NS[n].hw, x1 = NS[n].x + NS[n].hw;
      if (x1 < zn.x0 || x0 > zn.x1) continue;
      g.fillRect(X(Math.max(x0, zn.x0)), 0, (Math.min(x1, zn.x1) - Math.max(x0, zn.x0)) * sx, H);
    }
    // named arterials: wider, lighter, with edge lines
    for (e = 0; e < EW.length; e++) {
      if (!EW[e].name) continue;
      var az0 = EW[e].z - EW[e].hw, az1 = EW[e].z + EW[e].hw;
      if (az1 < zn.z0 || az0 > zn.z1) continue;
      g.fillStyle = '#4d4d4d';
      g.fillRect(0, Z(Math.max(az0, zn.z0)), W, (Math.min(az1, zn.z1) - Math.max(az0, zn.z0)) * sz);
      g.fillStyle = '#afafaf';
      g.fillRect(0, Z(EW[e].z) - 1, W, 2);
    }
    for (n = 0; n < NS.length; n++) {
      if (!NS[n].name) continue;
      var bx0 = NS[n].x - NS[n].hw, bx1 = NS[n].x + NS[n].hw;
      if (bx1 < zn.x0 || bx0 > zn.x1) continue;
      g.fillStyle = '#4d4d4d';
      g.fillRect(X(Math.max(bx0, zn.x0)), 0, (Math.min(bx1, zn.x1) - Math.max(bx0, zn.x0)) * sx, H);
      g.fillStyle = '#afafaf';
      g.fillRect(X(NS[n].x) - 1, 0, 2, H);
    }
  }

  function paintWindowGrid(g, W, H, seed, opt) {
    // opt: {base:[r,g,b], cols, rows, sill:true}
    var R = rnd(seed);
    var base = opt.base;
    g.fillStyle = shade(base, 0.6); g.fillRect(0, 0, W, H);
    // subtle per-brick/panel noise
    var i;
    for (i = 0; i < 300; i++) {
      g.fillStyle = shade(base, 0.75 + R() * 0.4);
      g.fillRect(R() * W, R() * H, 3 + R() * 8, 3 + R() * 8);
    }
    var cols = opt.cols, rows = opt.rows;
    var cw = W / cols, rh = H / rows;
    for (var c = 0; c < cols; c++) {
      for (var r = 0; r < rows; r++) {
        var x = c * cw + cw * 0.22, y = r * rh + rh * 0.2;
        var w = cw * 0.56, h = rh * 0.6;
        if (opt.sill) { g.fillStyle = '#c2c2c2'; g.fillRect(x - 2, y + h, w + 4, 3); }
        g.fillStyle = '#252525'; g.fillRect(x, y, w, h);
        var gr = g.createLinearGradient(x, y, x, y + h);
        gr.addColorStop(0, '#bcbcbc'); gr.addColorStop(0.55, '#8e8e8e'); gr.addColorStop(1, '#626262');
        g.fillStyle = gr; g.fillRect(x + 2, y + 2, w - 4, h - 4);
      }
    }
    // cornice band at top
    g.fillStyle = shade(base, 0.45); g.fillRect(0, 0, W, Math.max(4, H * 0.03));
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(0, Math.max(4, H * 0.03), W, 2);
  }

  // Six mid-field archetype facades. Each returns a canvas.
  function facadeA1() { // walk-up brick
    var c = cv(512, 512), g = c[1];
    paintWindowGrid(g, 512, 512, 1101, { base: [148, 92, 70], cols: 6, rows: 5, sill: true });
    return c[0];
  }
  function facadeA2() { // warehouse concrete, high small windows + dock doors
    var c = cv(512, 512), g = c[1], R = rnd(2202), i;
    g.fillStyle = '#8c8c8c'; g.fillRect(0, 0, 512, 512);
    for (i = 0; i < 200; i++) { g.fillStyle = shade([141, 141, 136], 0.8 + R() * 0.35); g.fillRect(R() * 512, R() * 512, 4 + R() * 10, 4 + R() * 10); }
    g.fillStyle = '#2e2e2e';
    for (i = 0; i < 8; i++) g.fillRect(30 + i * 60, 60, 34, 26);       // high windows
    for (i = 0; i < 4; i++) {                                          // dock doors
      g.fillStyle = '#4f4f4f'; g.fillRect(40 + i * 120, 330, 90, 150);
      g.fillStyle = '#363636';
      for (var s = 0; s < 6; s++) g.fillRect(40 + i * 120, 340 + s * 24, 90, 3);
    }
    g.fillStyle = '#6e6e6e'; g.fillRect(0, 0, 512, 14);                // parapet cap
    return c[0];
  }
  function facadeA3() { // corner commercial: storefront + 2 office floors
    var c = cv(512, 512), g = c[1], R = rnd(3303), i;
    g.fillStyle = '#8e8e8e'; g.fillRect(0, 0, 512, 512);
    for (i = 0; i < 150; i++) { g.fillStyle = shade([160, 139, 109], 0.8 + R() * 0.35); g.fillRect(R() * 512, R() * 512, 4 + R() * 8, 4 + R() * 8); }
    g.fillStyle = '#232323'; g.fillRect(20, 330, 472, 150);            // storefront glass
    var gr = g.createLinearGradient(0, 330, 0, 480);
    gr.addColorStop(0, '#b0b0b0'); gr.addColorStop(1, '#696969');
    g.fillStyle = gr; g.fillRect(28, 338, 456, 134);
    g.fillStyle = '#a0a0a0'; g.fillRect(20, 312, 472, 16);              // sign band
    paintWindowGrid(g, 512, 300, 3304, { base: [150, 130, 102], cols: 6, rows: 2, sill: true });
    return c[0];
  }
  function facadeA4() { // office slab: full curtain wall
    var c = cv(512, 512), g = c[1];
    g.fillStyle = '#3f3f3f'; g.fillRect(0, 0, 512, 512);
    for (var r = 0; r < 10; r++) {
      for (var col = 0; col < 8; col++) {
        var x = col * 64 + 4, y = r * 51 + 6, w = 56, h = 39;
        var gr = g.createLinearGradient(x, y, x, y + h);
        var sky = (r + col) % 3;
        gr.addColorStop(0, sky === 0 ? '#c9c9c9' : (sky === 1 ? '#a2a2a2' : '#7a7a7a'));
        gr.addColorStop(1, '#4e4e4e');
        g.fillStyle = gr; g.fillRect(x, y, w, h);
      }
    }
    return c[0];
  }
  function facadeA5() { // industrial shed: corrugated metal
    var c = cv(512, 512), g = c[1], R = rnd(5505), i;
    g.fillStyle = '#868686'; g.fillRect(0, 0, 512, 512);
    for (i = 0; i < 512; i += 8) {
      g.fillStyle = i % 16 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.08)';
      g.fillRect(i, 0, 4, 512);
    }
    g.fillStyle = '#2e2e2e';
    for (i = 0; i < 6; i++) g.fillRect(24 + i * 82, 80, 52, 34);
    g.fillStyle = '#646464'; g.fillRect(0, 470, 512, 42);
    return c[0];
  }
  function facadeA6() { // rowhouse block: brick rhythm with doors
    var c = cv(512, 512), g = c[1], R = rnd(6606), i;
    paintWindowGrid(g, 512, 512, 6607, { base: [142, 88, 66], cols: 8, rows: 3, sill: true });
    for (i = 0; i < 4; i++) {                                          // entry doors
      g.fillStyle = '#313131'; g.fillRect(60 + i * 128, 400, 44, 112);
      g.fillStyle = '#c2c2c2'; g.fillRect(54 + i * 128, 392, 56, 10);
    }
    return c[0];
  }

  function facadeHouse() { // detached house body: siding + windows all faces
    var c = cv(256, 256), g = c[1], R = rnd(7707), i;
    var bases = [[168, 160, 142], [150, 170, 178], [178, 150, 130], [160, 158, 150]];
    var base = bases[Math.floor(R() * bases.length)];
    g.fillStyle = shade(base, 0.75); g.fillRect(0, 0, 256, 256);
    for (i = 0; i < 256; i += 6) { g.fillStyle = 'rgba(0,0,0,0.06)'; g.fillRect(0, i, 256, 2); }
    for (i = 0; i < 3; i++) {
      var x = 24 + i * 76, y = 60;
      g.fillStyle = '#252525'; g.fillRect(x, y, 44, 60);
      var gr = g.createLinearGradient(x, y, x, y + 60);
      gr.addColorStop(0, '#bcbcbc'); gr.addColorStop(1, '#626262');
      g.fillStyle = gr; g.fillRect(x + 3, y + 3, 38, 54);
    }
    g.fillStyle = '#404040'; g.fillRect(106, 150, 44, 106);            // door
    return c[0];
  }

  function signTexture(text) {
    var c = cv(512, 128), g = c[1];
    g.fillStyle = '#3b3b3b'; g.fillRect(0, 0, 512, 128);               // green blade
    g.fillStyle = '#f2f2f2'; g.fillRect(8, 8, 496, 112);
    g.fillStyle = '#3b3b3b'; g.fillRect(14, 14, 484, 100);
    g.fillStyle = '#ffffff';
    g.font = 'bold 44px sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 256, 66);
    return c[0];
  }

  // ---------------- materials ----------------
  function makeMats(THREE) {
    var mats = {};
    mats.ground = [];
    var znames = ['west', 'east', 'north'];
    return mats;
  }

  function boxAt(THREE, g, w, h, d, mat, x, y, z, part, ry) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    if (ry) m.rotation.y = ry;
    m.castShadow = false; m.receiveShadow = false;
    if (part) m.userData.part = part;
    g.add(m);
    return m;
  }

  // Six mid-field archetypes: nominal dims (m) + facade painter index.
  // Rendered as ONE InstancedMesh each (unit box, per-instance scale/color).
  var ARCHETYPES = [
    { name: 'walkup',     w: 18, h: 14, d: 14, sw: [14, 24], sh: [10, 18], sd: [12, 18], paint: facadeA1, tint: [0.9, 1.05] },
    { name: 'warehouse',  w: 40, h: 10, d: 25, sw: [30, 60], sh: [8, 12],   sd: [20, 35], paint: facadeA2, tint: [0.85, 1.0] },
    { name: 'commercial', w: 16, h: 11, d: 14, sw: [12, 22], sh: [8, 14],   sd: [12, 18], paint: facadeA3, tint: [0.9, 1.05] },
    { name: 'officeslab', w: 30, h: 26, d: 18, sw: [24, 40], sh: [18, 42],  sd: [16, 24], paint: facadeA4, tint: [0.9, 1.05] },
    { name: 'shed',       w: 45, h: 9,  d: 30, sw: [35, 70], sh: [7, 11],   sd: [25, 40], paint: facadeA5, tint: [0.85, 1.0] },
    { name: 'rowhouse',   w: 36, h: 9,  d: 12, sw: [28, 48], sh: [8, 11],   sd: [10, 14], paint: facadeA6, tint: [0.9, 1.05] }
  ];

  var HOUSE_PALETTE = ['#aaaaaa', '#adadad', '#a2a2a2', '#a7a7a7', '#9f9f9f', '#9c9c9c', '#b5b5b5'];

  // ---------------- ground ----------------
  function buildGround(THREE, group) {
    for (var i = 0; i < ZONES.length; i++) {
      var zn = ZONES[i];
      var c = cv(2048, 2048), g = c[1];
      paintGround(g, 2048, 2048, zn, 5000 + i);
      var m = new THREE.Mesh(
        new THREE.PlaneGeometry(zn.x1 - zn.x0, zn.z1 - zn.z0),
        std(THREE, tex(THREE, c[0]), 0xffffff, 0.96)
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set((zn.x0 + zn.x1) / 2, 0.02, (zn.z0 + zn.z1) / 2);
      m.castShadow = false; m.receiveShadow = false;
      m.userData.part = 'r5-ground';
      m.userData.zone = zn.name;
      group.add(m);
    }
  }

  // ---------------- instanced masses ----------------
  // spots: [{arch, x, z, w, h, d, ry, tint}]
  function buildMasses(THREE, group, spots) {
    var unitBox = new THREE.BoxGeometry(1, 1, 1);
    var byArch = [[], [], [], [], [], []];
    var i;
    for (i = 0; i < spots.length; i++) byArch[spots[i].arch].push(spots[i]);
    var pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(), m4 = new THREE.Matrix4();
    var col = new THREE.Color();
    for (var a = 0; a < 6; a++) {
      var list = byArch[a];
      if (!list.length) continue;
      var mat = std(THREE, tex(THREE, ARCHETYPES[a].paint()), 0xffffff, 0.9);
      var im = new THREE.InstancedMesh(unitBox, mat, list.length);
      im.castShadow = false; im.receiveShadow = false;
      im.userData.part = 'r5-mass';
      im.userData.arch = ARCHETYPES[a].name;
      for (i = 0; i < list.length; i++) {
        var s = list[i];
        pos.set(s.x, s.h / 2, s.z);
        quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.ry);
        scl.set(s.w, s.h, s.d);
        m4.compose(pos, quat, scl);
        im.setMatrixAt(i, m4);
        var t = s.tint;
        col.setRGB(t, t * 0.99, t * 0.97);
        im.setColorAt(i, col);
      }
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      group.add(im);
    }
  }

  // ---------------- instanced houses ----------------
  // spots: [{x, z, ry, tintIdx}]
  function buildHouses(THREE, group, spots) {
    if (!spots.length) return;
    var bodyGeo = new THREE.BoxGeometry(8, 5.5, 7);
    var roofGeo = new THREE.ConeGeometry(1, 2.4, 4);
    roofGeo.rotateY(Math.PI / 4); // square pyramid aligned to body
    var bodyMat = std(THREE, tex(THREE, facadeHouse()), 0xffffff, 0.9);
    var roofMat = std(THREE, null, 0x414141, 0.95);
    var bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, spots.length);
    var roofs = new THREE.InstancedMesh(roofGeo, roofMat, spots.length);
    bodies.castShadow = false; roofs.castShadow = false;
    bodies.receiveShadow = false; roofs.receiveShadow = false;
    bodies.userData.part = 'r5-house'; roofs.userData.part = 'r5-house-roof';
    var pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(), m4 = new THREE.Matrix4();
    var col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    for (var i = 0; i < spots.length; i++) {
      var s = spots[i];
      quat.setFromAxisAngle(up, s.ry);
      pos.set(s.x, 2.75, s.z); scl.set(1, 1, 1);
      m4.compose(pos, quat, scl);
      bodies.setMatrixAt(i, m4);
      col.set(HOUSE_PALETTE[s.tintIdx % HOUSE_PALETTE.length]);
      bodies.setColorAt(i, col);
      pos.set(s.x, 5.5 + 1.2, s.z);
      scl.set(8 / 1.4142 * 1.08, 1, 7 / 1.4142 * 1.08); // cone r=1 -> base 1.4142
      m4.compose(pos, quat, scl);
      roofs.setMatrixAt(i, m4);
    }
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    group.add(bodies); group.add(roofs);
  }

  // ---------------- instanced trees ----------------
  // spots: [{x, z, s}] s = size factor
  function buildTrees(THREE, group, spots) {
    if (!spots.length) return;
    var trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 3.2, 5);
    var canGeo = new THREE.IcosahedronGeometry(2.6, 0);
    var trunkMat = std(THREE, null, 0x4a4a4a, 0.95);
    var canMat = std(THREE, null, 0x5c5c5c, 0.95);
    var trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
    var cans = new THREE.InstancedMesh(canGeo, canMat, spots.length);
    trunks.castShadow = false; cans.castShadow = false;
    trunks.userData.part = 'r5-tree'; cans.userData.part = 'r5-tree-canopy';
    var pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(), m4 = new THREE.Matrix4();
    var col = new THREE.Color();
    for (var i = 0; i < spots.length; i++) {
      var s = spots[i];
      pos.set(s.x, 1.6 * s.s, s.z); scl.set(s.s, s.s, s.s);
      m4.compose(pos, quat, scl);
      trunks.setMatrixAt(i, m4);
      pos.set(s.x, (3.2 + 1.8) * s.s, s.z);
      m4.compose(pos, quat, scl);
      cans.setMatrixAt(i, m4);
      var v = 0.85 + (i % 5) * 0.07;
      col.setRGB(0.29 * v, 0.42 * v, 0.25 * v);
      cans.setColorAt(i, col);
    }
    if (cans.instanceColor) cans.instanceColor.needsUpdate = true;
    group.add(trunks); group.add(cans);
  }

  // ---------------- instanced lamps ----------------
  function buildLamps(THREE, group, spots) {
    if (!spots.length) return;
    var poleGeo = new THREE.CylinderGeometry(0.12, 0.16, 7.5, 6);
    var mat = std(THREE, null, 0x313131, 0.8);
    var im = new THREE.InstancedMesh(poleGeo, mat, spots.length);
    im.castShadow = false;
    im.userData.part = 'r5-lamp';
    var pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(1, 1, 1), m4 = new THREE.Matrix4();
    for (var i = 0; i < spots.length; i++) {
      pos.set(spots[i].x, 3.75, spots[i].z);
      m4.compose(pos, quat, scl);
      im.setMatrixAt(i, m4);
    }
    group.add(im);
  }

  // ---------------- landmarks (articulated, near-core accents) ----------------
  function landmarkMats(THREE) {
    return {
      brick: std(THREE, null, 0x6e6e6e, 0.9),
      concrete: std(THREE, null, 0x999999, 0.9),
      glass: std(THREE, null, 0x727272, 0.4),
      roof: std(THREE, null, 0x3a3a3a, 0.95),
      trim: std(THREE, null, 0xcfcfcf, 0.85),
      steel: std(THREE, null, 0x777777, 0.6)
    };
  }

  function buildLandmarks(THREE, group) {
    var M = landmarkMats(THREE);
    var P = 'r5-landmark';
    // 1. Westside Market Hall (-2400, -1400): hall + wings + monitor roof
    (function () {
      var g = new THREE.Group(); g.position.set(-2280, 0, -1520);
      boxAt(THREE, g, 44, 11, 26, M.brick, 0, 5.5, 0, P);
      boxAt(THREE, g, 46, 2.5, 28, M.roof, 0, 12.2, 0, P);       // monitor roof base
      boxAt(THREE, g, 30, 3.5, 10, M.glass, 0, 15, 0, P);        // glazed monitor
      boxAt(THREE, g, 18, 8, 20, M.concrete, -30, 4, 0, P);      // west wing
      boxAt(THREE, g, 18, 8, 20, M.concrete, 30, 4, 0, P);       // east wing
      boxAt(THREE, g, 46, 1.2, 28, M.trim, 0, 11.4, 0, P);       // cornice
      g.userData.part = P; g.userData.name = 'Westside Market Hall';
      group.add(g);
    })();
    // 2. Grand River Depot (-1400, -2600): trainshed + concourse + clock tower
    (function () {
      var g = new THREE.Group(); g.position.set(-1550, 0, -2720);
      boxAt(THREE, g, 60, 9, 22, M.steel, 0, 4.5, 0, P);        // trainshed
      boxAt(THREE, g, 62, 2, 24, M.roof, 0, 10, 0, P);
      boxAt(THREE, g, 26, 12, 18, M.brick, 0, 6, 22, P);         // concourse
      boxAt(THREE, g, 8, 26, 8, M.concrete, 0, 13, 22, P);       // clock tower
      boxAt(THREE, g, 9, 3, 9, M.roof, 0, 27.5, 22, P);          // tower cap
      boxAt(THREE, g, 26, 1, 18, M.trim, 0, 12.4, 22, P);
      g.userData.part = P; g.userData.name = 'Grand River Depot';
      group.add(g);
    })();
    // 3. North End Civic Center (0, -4000): civic block, mansard + portico
    (function () {
      var g = new THREE.Group(); g.position.set(150, 0, -4120);
      boxAt(THREE, g, 50, 14, 30, M.concrete, 0, 7, 0, P);
      boxAt(THREE, g, 52, 4, 32, M.roof, 0, 16, 0, P);           // mansard mass
      boxAt(THREE, g, 30, 6, 8, M.trim, 0, 3, 19, P);            // portico
      for (var i = -2; i <= 2; i++) boxAt(THREE, g, 1.2, 9, 1.2, M.trim, i * 6, 4.5, 22, P);
      boxAt(THREE, g, 52, 1, 32, M.trim, 0, 14.4, 0, P);
      g.userData.part = P; g.userData.name = 'North End Civic Center';
      group.add(g);
    })();
    // 4. Livernois Maker Works (-2200, -3400): sawtooth factory
    (function () {
      var g = new THREE.Group(); g.position.set(-2500, 0, -3520);
      boxAt(THREE, g, 70, 8, 36, M.brick, 0, 4, 0, P);
      for (var i = -1; i <= 1; i++) {
        boxAt(THREE, g, 16, 3.5, 30, M.glass, i * 22, 9.7, -2, P); // sawtooth monitors
        boxAt(THREE, g, 17, 0.8, 31, M.roof, i * 22, 11.6, -2, P);
      }
      boxAt(THREE, g, 12, 14, 12, M.concrete, 40, 7, 10, P);     // office block
      g.userData.part = P; g.userData.name = 'Livernois Maker Works';
      group.add(g);
    })();
    // 5. McNichols Field House (1400, -5400): field house + gable
    (function () {
      var g = new THREE.Group(); g.position.set(1550, 0, -5520);
      boxAt(THREE, g, 55, 10, 32, M.concrete, 0, 5, 0, P);
      var roofGeo = new THREE.ConeGeometry(1, 6, 4);
      roofGeo.rotateY(Math.PI / 4); // base vertices land exactly on the building corners
      var roof = new THREE.Mesh(roofGeo, M.roof);
      roof.scale.set(55 / 1.4142, 1, 32 / 1.4142);
      roof.position.set(0, 13, 0); roof.castShadow = false;
      roof.userData.part = P; g.add(roof);
      boxAt(THREE, g, 20, 8, 14, M.brick, 0, 4, 23, P);           // entry block
      boxAt(THREE, g, 57, 1, 34, M.trim, 0, 10.4, 0, P);
      g.userData.part = P; g.userData.name = 'McNichols Field House';
      group.add(g);
    })();
    // 6. Davison Intermodal Terminal (-1400, -3400): concourse concept
    (function () {
      var g = new THREE.Group(); g.position.set(-1050, 0, -3520);
      boxAt(THREE, g, 48, 9, 24, M.glass, 0, 4.5, 0, P);         // glazed concourse
      boxAt(THREE, g, 50, 1.5, 26, M.steel, 0, 9.7, 0, P);       // canopy
      boxAt(THREE, g, 10, 20, 10, M.concrete, -28, 10, 0, P);    // tower
      boxAt(THREE, g, 30, 6, 16, M.brick, 28, 3, 4, P);          // service wing
      g.userData.part = P; g.userData.name = 'Davison Intermodal Terminal';
      g.userData.concept = true;
      group.add(g);
    })();
  }

  // ---------------- blade signs (real street names only) ----------------
  var SIGNS = [
    { x: -2191, z: -18, text: 'Michigan Ave' },
    { x: -2991, z: -18, text: 'Michigan Ave' },
    { x: -591, z: -1388, text: 'W Warren Ave' },
    { x: 609, z: -1388, text: 'W Warren Ave' },
    { x: -1391, z: -3388, text: 'W Davison' },
    { x: 809, z: -3388, text: 'W Davison' },
    { x: -2191, z: -5388, text: 'W McNichols Ave' },
    { x: -2991, z: -5388, text: 'W McNichols Ave' }
  ];
  function buildSigns(THREE, group) {
    var poleMat = std(THREE, null, 0x313131, 0.8);
    for (var i = 0; i < SIGNS.length; i++) {
      var s = SIGNS[i];
      var g = new THREE.Group(); g.position.set(s.x, 0, s.z);
      boxAt(THREE, g, 0.3, 6.5, 0.3, poleMat, 0, 3.25, 0, 'r5-sign');
      var blade = new THREE.Mesh(
        new THREE.PlaneGeometry(7, 1.75),
        new THREE.MeshStandardMaterial({
          map: tex(THREE, signTexture(s.text)),
          roughness: 0.7, side: THREE.DoubleSide
        })
      );
      blade.position.set(0, 5.6, 0);
      blade.castShadow = false;
      blade.userData.part = 'r5-sign';
      blade.userData.text = s.text;
      g.add(blade);
      g.userData.part = 'r5-sign';
      group.add(g);
    }
  }

  // Keep-out rects around the six articulated landmarks (plan bounding boxes
  // +6 m margin). Block content (houses/masses/trees) must never intersect them.
  var KEEPOUT = [
    { x0: -2325, x1: -2235, z0: -1539, z1: -1501 }, // Westside Market Hall
    { x0: -1586, x1: -1514, z0: -2737, z1: -2683 }, // Grand River Depot
    { x0: 118,   x1: 182,   z0: -4141, z1: -4091 }, // North End Civic Center
    { x0: -2541, x1: -2448, z0: -3544, z1: -3496 }, // Livernois Maker Works
    { x0: 1516,  x1: 1584,  z0: -5542, z1: -5484 }, // McNichols Field House
    { x0: -1089, x1: -1001, z0: -3538, z1: -3502 }  // Davison Intermodal Terminal
  ];
  function inKeepout(x, z, m) {
    for (var i = 0; i < KEEPOUT.length; i++) {
      var k = KEEPOUT[i];
      if (x > k.x0 - m && x < k.x1 + m && z > k.z0 - m && z < k.z1 + m) return true;
    }
    return false;
  }
  function rectHitsKeepout(x0, z0, x1, z1, m) {
    for (var i = 0; i < KEEPOUT.length; i++) {
      var k = KEEPOUT[i];
      if (x0 < k.x1 + m && x1 > k.x0 - m && z0 < k.z1 + m && z1 > k.z0 - m) return true;
    }
    return false;
  }

  // ---------------- layout ----------------
  var R5SEED = 95001;

  function lerp(a, b, t) { return a + (b - a) * t; }

  // point-in-ROW test with margin (for trees/lamps near intersections)
  function inROW(x, z, margin) {
    for (var i = 0; i < ROWS.length; i++) {
      var r = ROWS[i];
      if (x > r.x0 - margin && x < r.x1 + margin && z > r.z0 - margin && z < r.z1 + margin) return true;
    }
    return false;
  }

  function collectSpots() {
    var R = rnd(R5SEED);
    var houses = [], masses = [], trees = [], lamps = [];
    var ei, ni, zi, k;

    // ---- block fabric ----
    for (ei = 0; ei < EW.length - 1; ei++) {
      var zHi = EW[ei].z - EW[ei].hw - 10;
      var zLo = EW[ei + 1].z + EW[ei + 1].hw + 10;
      if (zHi - zLo < 40) continue;
      for (ni = 0; ni < NS.length - 1; ni++) {
        var xLo = NS[ni].x + NS[ni].hw + 10;
        var xHi = NS[ni + 1].x - NS[ni + 1].hw - 10;
        if (xHi - xLo < 40) continue;
        for (zi = 0; zi < ZONES.length; zi++) {
          var zn = ZONES[zi];
          var bx0 = Math.max(xLo, zn.x0), bx1 = Math.min(xHi, zn.x1);
          var bz0 = Math.max(zLo, zn.z0), bz1 = Math.min(zHi, zn.z1);
          if (bx1 - bx0 < 40 || bz1 - bz0 < 40) continue;
          // zones exclude the R4 rect by construction; double-guard:
          if (bx0 < R4.x1 && bx1 > R4.x0 && bz0 < R4.z1 && bz1 > R4.z0) continue;
          var roll = R();
          if (roll < 0.55) {
            // residential: houses along block edges facing the street
            var per, hx, hz;
            for (per = bx0 + 6; per < bx1 - 6; per += 13) { // south edge (faces +z)
              hx = per + (R() - 0.5) * 3; hz = bz1 - 8;
              if (!inKeepout(hx, hz, 8)) houses.push({ x: hx, z: hz, ry: 0, tintIdx: Math.floor(R() * 7) });
            }
            for (per = bx0 + 6; per < bx1 - 6; per += 13) { // north edge (faces -z)
              hx = per + (R() - 0.5) * 3; hz = bz0 + 8;
              if (!inKeepout(hx, hz, 8)) houses.push({ x: hx, z: hz, ry: Math.PI, tintIdx: Math.floor(R() * 7) });
            }
            for (per = bz0 + 19; per < bz1 - 19; per += 13) { // east edge (faces +x)
              hx = bx1 - 8; hz = per + (R() - 0.5) * 3;
              if (!inKeepout(hx, hz, 8)) houses.push({ x: hx, z: hz, ry: Math.PI / 2, tintIdx: Math.floor(R() * 7) });
            }
            for (per = bz0 + 19; per < bz1 - 19; per += 13) { // west edge (faces -x)
              hx = bx0 + 8; hz = per + (R() - 0.5) * 3;
              if (!inKeepout(hx, hz, 8)) houses.push({ x: hx, z: hz, ry: -Math.PI / 2, tintIdx: Math.floor(R() * 7) });
            }
          } else if (roll < 0.82) {
            // commercial/industrial: instanced archetype masses, rejection-sampled
            var placed = [];
            var want = 2 + Math.floor(R() * 4), tries = 0;
            while (placed.length < want && tries < 60) {
              tries++;
              var a = Math.floor(R() * 6), A = ARCHETYPES[a];
              var w = lerp(A.sw[0], A.sw[1], R()), h = lerp(A.sh[0], A.sh[1], R()), d = lerp(A.sd[0], A.sd[1], R());
              var ry = R() < 0.5 ? 0 : Math.PI / 2;
              var fw = ry ? d : w, fd = ry ? w : d;
              // sample centers so the FULL rotated footprint stays 12 m
              // inside the block (block itself is 10 m off every ROW)
              var ix0 = bx0 + fw / 2 + 12, ix1 = bx1 - fw / 2 - 12;
              var iz0 = bz0 + fd / 2 + 12, iz1 = bz1 - fd / 2 - 12;
              if (ix1 <= ix0 || iz1 <= iz0) continue; // block too small for this mass
              var mx = ix0 + R() * (ix1 - ix0);
              var mz = iz0 + R() * (iz1 - iz0);
              if (rectHitsKeepout(mx - fw / 2, mz - fd / 2, mx + fw / 2, mz + fd / 2, 4)) continue;
              var ok = true;
              for (k = 0; k < placed.length; k++) {
                var p = placed[k];
                if (Math.abs(p.x - mx) < (p.fw + fw) / 2 + 4 && Math.abs(p.z - mz) < (p.fd + fd) / 2 + 4) { ok = false; break; }
              }
              if (!ok) continue;
              var tint = lerp(A.tint[0], A.tint[1], R());
              placed.push({ x: mx, z: mz, fw: fw, fd: fd });
              masses.push({ arch: a, x: mx, z: mz, w: w, h: h, d: d, ry: ry, tint: tint });
            }
          } else {
            // green/vacant: tree grid with jitter
            for (var tx = bx0 + 12; tx < bx1 - 8; tx += 30) {
              for (var tz = bz0 + 12; tz < bz1 - 8; tz += 30) {
                if (R() < 0.25) continue; // vacant patches (Detroit-realistic)
                var jx = tx + (R() - 0.5) * 10, jz = tz + (R() - 0.5) * 10;
                if (inKeepout(jx, jz, 5)) continue;
                trees.push({ x: jx, z: jz, s: 0.8 + R() * 0.7 });
              }
            }
          }
        }
      }
    }

    // ---- arterial street trees + lamps (named streets only) ----
    var e, n, t, side;
    for (e = 0; e < EW.length; e++) {
      if (!EW[e].name) continue;
      for (t = -3700; t <= 3700; t += 25) {
        for (side = -1; side <= 1; side += 2) {
          var tzx = EW[e].z + side * (EW[e].hw + 4);
          if (tzx > 50 || !inZones(t, tzx) || inR4(t, tzx) || inROW(t, tzx, 2) || inKeepout(t, tzx, 5)) continue;
          trees.push({ x: t, z: tzx, s: 0.9 + ((t * 7 + e * 13) % 10) / 22 });
        }
      }
      for (t = -3700, k = 0; t <= 3700; t += 60, k++) {
        side = (k % 2) ? 1 : -1;
        var lz = EW[e].z + side * (EW[e].hw + 2);
        if (lz > 50 || !inZones(t, lz) || inR4(t, lz) || inROW(t, lz, 1.5) || inKeepout(t, lz, 4)) continue;
        lamps.push({ x: t, z: lz });
      }
    }
    for (n = 0; n < NS.length; n++) {
      if (!NS[n].name) continue;
      for (t = -6950; t <= 50; t += 25) {
        for (side = -1; side <= 1; side += 2) {
          var txx = NS[n].x + side * (NS[n].hw + 4);
          if (!inZones(txx, t) || inR4(txx, t) || inROW(txx, t, 2) || inKeepout(txx, t, 5)) continue;
          trees.push({ x: txx, z: t, s: 0.9 + ((t * 3 + n * 17) % 10) / 22 });
        }
      }
      for (t = -6950, k = 0; t <= 50; t += 60, k++) {
        side = (k % 2) ? 1 : -1;
        var lx = NS[n].x + side * (NS[n].hw + 2);
        if (!inZones(lx, t) || inR4(lx, t) || inROW(lx, t, 1.5) || inKeepout(lx, t, 4)) continue;
        lamps.push({ x: lx, z: t });
      }
    }

    return { houses: houses, masses: masses, trees: trees, lamps: lamps };
  }

  // ---------------- main build ----------------
  var STATS = null;

  function buildRegionExpansionR5(THREE) {
    var group = new THREE.Group();
    group.userData.part = 'r5-root';

    buildGround(THREE, group);
    var spots = collectSpots();
    buildMasses(THREE, group, spots.masses);
    buildHouses(THREE, group, spots.houses);
    buildTrees(THREE, group, spots.trees);
    buildLamps(THREE, group, spots.lamps);
    buildLandmarks(THREE, group);
    buildSigns(THREE, group);

    // draw-call estimate: count meshes + instanced meshes (each = 1 draw call)
    var drawCalls = 0;
    group.traverse(function (o) { if (o.isMesh || o.isInstancedMesh) drawCalls++; });

    STATS = {
      houses: spots.houses.length,
      masses: spots.masses.length,
      trees: spots.trees.length,
      lamps: spots.lamps.length,
      landmarks: 6,
      signs: SIGNS.length,
      groundSlabs: 3,
      drawCalls: drawCalls,
      zones: ZONES.map(function (z) { return z.name; })
    };
    return group;
  }

  // Clamp ROW rects to the buildable area (keeps the water-band check clean).
  (function () {
    for (var i = 0; i < ROWS.length; i++) {
      if (ROWS[i].z1 > 53) ROWS[i].z1 = 53;
      if (ROWS[i].z0 < -6950) ROWS[i].z0 = -6950;
    }
  })();

  window.DAARegionExpansionR5 = {
    buildRegionExpansionR5: buildRegionExpansionR5,
    ROWS: ROWS,
    ZONES: ZONES,
    R4RECT: R4,
    stats: function () { return STATS; }
  };
})();
