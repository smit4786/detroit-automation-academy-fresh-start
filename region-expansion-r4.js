/* region-expansion-r4.js
 * Round-4 overnight build (2026-10-01, local only): expands the district to
 * 1+ sq mi by adding the far-field fabric around the existing core.
 *
 * The round-3 kit (painters, roof builders, building archetypes, roadSeg,
 * trees, signs, makeShared) is embedded verbatim below (region-expansion.js
 * lines 52-980); the round-4 additions and the layout assembly follow.
 *
 * window.DAARegionExpansionR4.buildRegionExpansionR4(THREE) -> THREE.Group
 */
(function () {
  'use strict';

  var PXM = 64;        // texture pixels per meter
  var ROAD_TOP = 0.35; // top of road surfaces

  function cv(wM, hM) {
    var c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(wM * PXM));
    c.height = Math.max(2, Math.round(hM * PXM));
    return [c, c.getContext('2d')];
  }

  // deterministic PRNG so textures are stable across loads
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

  // canvas y for a height measured in meters from the wall base
  function Y(hM, yFromBase) { return (hM - yFromBase) * PXM; }

  function tex(THREE, canvas) {
    var t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }

  function std(THREE, map, roughness, metalness) {
    return new THREE.MeshStandardMaterial({
      map: map,
      roughness: roughness == null ? 0.9 : roughness,
      metalness: metalness || 0
    });
  }

  function box(THREE, g, w, h, d, mat, x, y, z, cast) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = cast !== false;
    m.userData.noCast = (cast === false);
    m.receiveShadow = true;
    g.add(m);
    return m;
  }

  // ---- facade painters -------------------------------------------------

  function paintBrick(g, W, H, seed, base) {
    var R = rnd(seed);
    var bh = 0.075 * PXM, bw = 0.23 * PXM;
    var y, x, row = 0;
    g.fillStyle = shade(base, 0.55);
    g.fillRect(0, 0, W, H);
    for (y = 0; y < H; y += bh, row++) {
      var off = (row % 2) * bw / 2;
      for (x = -bw; x < W + bw; x += bw) {
        g.fillStyle = shade(base, 0.82 + R() * 0.36);
        g.fillRect(x + off + 1, y + 1, bw - 2, bh - 2);
      }
    }
  }

  // xPx: left edge in px; yTopPx: top edge in px; wM/hM: size in meters.
  function paintWindow(g, xPx, yTopPx, wM, hM) {
    var w = wM * PXM, h = hM * PXM;
    g.fillStyle = 'rgba(0,0,0,0.30)';
    g.fillRect(xPx - 4, yTopPx - 8, w + 8, 8);           // soldier header
    g.fillStyle = '#c2c2c2';
    g.fillRect(xPx - 4, yTopPx + h, w + 8, 7);           // stone sill
    g.fillStyle = '#252525';
    g.fillRect(xPx, yTopPx, w, h);                      // steel sash
    var cols = wM > 1.8 ? 3 : 2, rows = hM > 2 ? 4 : 3, m = 3;
    var pw = (w - m * (cols + 1)) / cols, ph = (h - m * (rows + 1)) / rows;
    for (var c = 0; c < cols; c++) {
      for (var r = 0; r < rows; r++) {
        var px = xPx + m + c * (pw + m), py = yTopPx + m + r * (ph + m);
        var gr = g.createLinearGradient(px, py, px, py + ph);
        gr.addColorStop(0, '#bcbcbc');
        gr.addColorStop(0.55, '#8e8e8e');
        gr.addColorStop(1, '#626262');
        g.fillStyle = gr;
        g.fillRect(px, py, pw, ph);
      }
    }
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.beginPath();
    g.moveTo(xPx, yTopPx + h);
    g.lineTo(xPx + w * 0.45, yTopPx);
    g.lineTo(xPx + w * 0.7, yTopPx);
    g.lineTo(xPx + w * 0.25, yTopPx + h);
    g.closePath();
    g.fill();
  }

  function paintBase(g, W, H) {
    var wt = 0.9 * PXM;
    g.fillStyle = 'rgba(13,13,13,0.45)';
    g.fillRect(0, H - wt, W, wt);                       // water table shadow
    g.fillStyle = '#b0b0b0';
    g.fillRect(0, H - wt - 8, W, 8);                     // concrete cap
    var gr = g.createLinearGradient(0, H - 2 * PXM, 0, H);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, 'rgba(0,0,0,0.35)');
    g.fillStyle = gr;
    g.fillRect(0, H - 2 * PXM, W, 2 * PXM);              // grime at grade
  }

  function paintTopBand(g, W, bandM, color) {
    g.fillStyle = color;
    g.fillRect(0, 0, W, bandM * PXM);                    // cornice bed / coping
  }

  // Industrial brick wall with pilasters, high steel-sash band, optional
  // loading doors (doors: array of x positions in meters, or null).
  function warehouseCanvas(wM, hM, seed, base, doors) {
    var p = cv(wM, hM), c = p[0], g = p[1], W = c.width, H = c.height;
    paintBrick(g, W, H, seed, base);
    var R = rnd(seed + 9);
    var x;
    for (x = 2; x < wM - 1; x += 4) {                    // pilasters
      g.fillStyle = shade(base, 1.14);
      g.fillRect(x * PXM, 0, 0.5 * PXM, H);
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.fillRect(x * PXM + 0.5 * PXM - 3, 0, 3, H);
    }
    var sill = hM * 0.55, ww = 2.2, wh = Math.min(2.6, hM - sill - 1.2);
    for (x = 3.1; x + ww <= wM - 2; x += 4) {           // high sash band
      if (R() < 0.18) continue;
      paintWindow(g, x * PXM, Y(hM, sill + wh), ww, wh);
    }
    if (hM > 7) {                                       // low square windows
      for (x = 5.1; x + 1.2 <= wM - 4; x += 8) {
        paintWindow(g, x * PXM, Y(hM, 3.2 + 1.2), 1.2, 1.2);
      }
    }
    if (doors) {                                        // loading doors
      for (var d = 0; d < doors.length; d++) {
        var dx = doors[d] * PXM, dw = 3.2 * PXM, dh = 3.6 * PXM;
        var dy = H - 0.9 * PXM - dh;
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillRect(dx - 6, dy - 6, dw + 12, dh + 6);
        g.fillStyle = '#4d4d4d';
        g.fillRect(dx, dy, dw, dh);
        g.fillStyle = 'rgba(255,255,255,0.12)';
        for (var ly = dy + 8; ly < dy + dh; ly += 14) g.fillRect(dx + 2, ly, dw - 4, 2);
        g.fillStyle = '#c2c2c2';
        g.fillRect(dx - 6, dy - 14, dw + 12, 8);
      }
    }
    paintTopBand(g, W, 0.45, '#b2b2b2');
    paintBase(g, W, H);
    return c;
  }

  // Walk-up apartment wall: per-floor window rhythm, entry door on ground.
  function apartmentCanvas(wM, hM, seed, base, doorX) {
    var p = cv(wM, hM), c = p[0], g = p[1], W = c.width, H = c.height;
    paintBrick(g, W, H, seed, base);
    var floors = Math.max(2, Math.round(hM / 3.2));
    var fh = hM / floors;
    for (var f = 0; f < floors; f++) {
      var sill = f * fh + 1.0, wh = Math.min(1.9, fh - 1.5);
      for (var x = 1.8; x + 1.5 <= wM - 1.2; x += 3.0) {
        if (f === 0 && doorX != null && Math.abs(x + 0.75 - doorX) < 1.6) continue;
        paintWindow(g, x * PXM, Y(hM, sill + wh), 1.5, wh);
      }
      g.fillStyle = 'rgba(0,0,0,0.12)';                 // floor shadow line
      g.fillRect(0, Y(hM, (f + 1) * fh) - 3, W, 6);
    }
    if (doorX != null) {
      var dx = doorX * PXM, dw = 1.3 * PXM, dh = 2.4 * PXM;
      var dy = H - 0.9 * PXM - dh;
      g.fillStyle = '#323232';
      g.fillRect(dx - dw / 2, dy, dw, dh);
      g.fillStyle = '#c2c2c2';
      g.fillRect(dx - dw / 2 - 6, dy - 8, dw + 12, 8);
      g.fillStyle = 'rgba(195,195,195,0.5)';
      g.fillRect(dx - dw / 2 + 6, dy + 6, dw - 12, dh - 12);
    }
    paintTopBand(g, W, 0.5, '#c8c8c8');
    paintBase(g, W, H);
    return c;
  }

  // Corner commercial: glazed storefront + sign band at grade, flats above.
  function storefrontCanvas(wM, hM, seed, base, signText) {
    var p = cv(wM, hM), c = p[0], g = p[1], W = c.width, H = c.height;
    var gh = 4.2;                                       // ground floor height
    paintBrick(g, W, H, seed, base);
    var x;
    for (x = 0; x <= wM; x += 4) {                      // brick piers
      g.fillStyle = shade(base, 0.95);
      g.fillRect(x * PXM - 0.3 * PXM, Y(hM, gh), 0.6 * PXM, gh * PXM);
    }
    var yG0 = Y(hM, 3.1), yG1 = Y(hM, 0.9);
    for (x = 0.3; x + 3.4 <= wM; x += 4) {              // storefront glass
      var gx = x * PXM, gw = 3.4 * PXM;
      var gr = g.createLinearGradient(0, yG0, 0, yG1);
      gr.addColorStop(0, '#393939');
      gr.addColorStop(1, '#1b1b1b');
      g.fillStyle = gr;
      g.fillRect(gx, yG0, gw, yG1 - yG0);
      g.fillStyle = '#202020';                          // mullions
      for (var mx = gx; mx < gx + gw; mx += gw / 3) g.fillRect(mx - 2, yG0, 4, yG1 - yG0);
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(gx, yG0, gw, (yG1 - yG0) * 0.35);
      if (x < 2) {                                      // entry door
        g.fillStyle = '#252525';
        g.fillRect(gx + gw / 2 - 0.55 * PXM, yG0 + 4, 1.1 * PXM, yG1 - yG0 - 8);
      }
    }
    g.fillStyle = shade(base, 0.7);                     // bulkhead
    g.fillRect(0, Y(hM, 0.9), W, H - Y(hM, 0.9));
    var sbY = Y(hM, 4.1), sbH = 0.9 * PXM;              // sign band
    g.fillStyle = '#262626';
    g.fillRect(0, sbY, W, sbH);
    g.fillStyle = '#e2e2e2';
    g.font = 'bold ' + Math.round(0.55 * PXM) + 'px Georgia,serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(signText, W / 2, sbY + sbH / 2);
    var floors = Math.max(1, Math.round((hM - gh) / 3.2));
    var ufh = (hM - gh) / floors;
    for (var f = 0; f < floors; f++) {                  // flats above
      var sill = gh + 0.4 + f * ufh, wh = 1.8;
      if (sill + wh > hM - 0.8) continue;
      for (x = 1.8; x + 1.5 <= wM - 1.2; x += 3.0) {
        paintWindow(g, x * PXM, Y(hM, sill + wh), 1.5, wh);
      }
    }
    paintTopBand(g, W, 0.5, '#c8c8c8');
    paintBase(g, W, H);
    return c;
  }

  // ---- roof painters ---------------------------------------------------

  function membraneCanvas(seed) {
    var p = cv(4, 4), c = p[0], g = p[1], W = c.width, H = c.height;
    var R = rnd(seed);
    g.fillStyle = '#3f3f3f';
    g.fillRect(0, 0, W, H);
    for (var i = 0; i < 900; i++) {
      g.fillStyle = shade([60, 63, 68], 0.8 + R() * 0.4);
      g.fillRect(R() * W, R() * H, 3, 3);
    }
    g.fillStyle = 'rgba(0,0,0,0.25)';                    // membrane seams
    for (i = 0; i <= 4; i++) {
      g.fillRect(0, Math.round(i * H / 4) - 1, W, 2);
      g.fillRect(Math.round(i * W / 4) - 1, 0, 2, H);
    }
    return c;
  }

  function tileCanvas(seed) {                           // red clay tile
    var p = cv(4, 3), c = p[0], g = p[1], W = c.width, H = c.height;
    var R = rnd(seed);
    var ch = 0.3 * PXM, tw = 0.35 * PXM;
    g.fillStyle = shade([148, 74, 52], 0.6);
    g.fillRect(0, 0, W, H);
    for (var y = 0; y < H; y += ch) {
      for (var x = -tw; x < W + tw; x += tw) {
        g.fillStyle = shade([148, 74, 52], 0.85 + R() * 0.3);
        g.beginPath();
        g.arc(x + tw / 2 + ((y / ch) % 2) * tw / 4, y + ch / 2, tw / 2 - 1, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(0, y, W, 2);
    }
    return c;
  }

  function shingleCanvas(seed) {                        // dark mansard shingles
    var p = cv(4, 3), c = p[0], g = p[1], W = c.width, H = c.height;
    var R = rnd(seed);
    var ch = 0.28 * PXM, tw = 0.4 * PXM;
    g.fillStyle = shade([74, 72, 78], 0.6);
    g.fillRect(0, 0, W, H);
    for (var y = 0, row = 0; y < H; y += ch, row++) {
      var off = (row % 2) * tw / 2;
      for (var x = -tw; x < W + tw; x += tw) {
        g.fillStyle = shade([74, 72, 78], 0.85 + R() * 0.3);
        g.fillRect(x + off + 1, y + 1, tw - 2, ch - 2);
      }
    }
    return c;
  }

  function glassGridCanvas() {                          // sawtooth glazing
    var p = cv(4, 2.2), c = p[0], g = p[1], W = c.width, H = c.height;
    var gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, '#c9c9c9');
    gr.addColorStop(1, '#7e7e7e');
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#272727';
    for (var x = 0; x <= W; x += W / 6) g.fillRect(x - 2, 0, 4, H);
    for (var y = 0; y <= H; y += H / 3) g.fillRect(0, y - 2, W, 4);
    return c;
  }

  function parapetCanvas(seed) {
    var p = cv(2, 1), c = p[0], g = p[1], W = c.width, H = c.height;
    paintBrick(g, W, H, seed, [122, 62, 44]);
    g.fillStyle = '#c8c8c8';                            // coping
    g.fillRect(0, 0, W, 0.12 * PXM);
    return c;
  }

  // ---- roof builders ---------------------------------------------------
  // All take the building group b (local origin at wall base center),
  // footprint w (x) by d (z), wall top y.

  function acUnit(THREE, S, b, x, y, z) {
    box(THREE, b, 1.4, 0.9, 1.1, S.M.ac, x, y + 0.45, z);
    var f = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.14, 12), S.M.vent);
    f.position.set(x, y + 0.97, z);
    f.castShadow = true; f.receiveShadow = true;
    b.add(f);
  }

  function ventPipe(THREE, S, b, x, y, z) {
    var v = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 1.1, 10), S.M.vent);
    v.position.set(x, y + 0.55, z);
    v.castShadow = true; v.receiveShadow = true;
    b.add(v);
    var cap = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.22, 10), S.M.vent);
    cap.position.set(x, y + 1.2, z);
    cap.castShadow = true;
    b.add(cap);
  }

  function parapet(THREE, S, b, w, d, y) {
    var pt = 0.25, ph = 0.9;
    box(THREE, b, w, ph, pt, S.M.parapet, 0, y + ph / 2, d / 2 - pt / 2);
    box(THREE, b, w, ph, pt, S.M.parapet, 0, y + ph / 2, -d / 2 + pt / 2);
    box(THREE, b, pt, ph, d - 2 * pt, S.M.parapet, w / 2 - pt / 2, y + ph / 2, 0);
    box(THREE, b, pt, ph, d - 2 * pt, S.M.parapet, -w / 2 + pt / 2, y + ph / 2, 0);
  }

  function flatRoof(THREE, S, b, w, d, y, seed) {
    box(THREE, b, w - 0.2, 0.14, d - 0.2, S.M.membrane, 0, y + 0.07, 0);
    parapet(THREE, S, b, w, d, y);
    var R = rnd(seed);
    var n = 2 + Math.floor(R() * 2);
    for (var i = 0; i < n; i++) {
      acUnit(THREE, S, b, (R() - 0.5) * (w - 5), y + 0.14, (R() - 0.5) * (d - 5));
    }
    ventPipe(THREE, S, b, (R() - 0.5) * (w - 4), y + 0.14, (R() - 0.5) * (d - 4));
    ventPipe(THREE, S, b, (R() - 0.5) * (w - 4), y + 0.14, (R() - 0.5) * (d - 4));
  }

  function waterTower(THREE, S, b, x, y, z) {
    for (var i = 0; i < 4; i++) {                       // legs
      var lx = x + (i % 2 ? 1.1 : -1.1), lz = z + (i < 2 ? 1.1 : -1.1);
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 3.4, 8), S.M.steel);
      leg.position.set(lx, y + 1.7, lz);
      leg.castShadow = true;
      b.add(leg);
    }
    var tank = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 3.0, 14), S.M.tank);
    tank.position.set(x, y + 4.9, z);
    tank.castShadow = true; tank.receiveShadow = true;
    b.add(tank);
    var roof = new THREE.Mesh(new THREE.ConeGeometry(1.85, 0.9, 14), S.M.tankRoof);
    roof.position.set(x, y + 6.85, z);
    roof.castShadow = true;
    b.add(roof);
  }

  function hippedRoof(THREE, S, b, w, d, y, seed) {
    box(THREE, b, w + 0.4, 0.15, d + 0.4, S.M.eave, 0, y + 0.07, 0); // eave
    var r = new THREE.Mesh(new THREE.ConeGeometry(1, 2.6, 4), S.M.tile);
    r.rotation.y = Math.PI / 4;
    r.scale.set(w / 1.4142, 1, d / 1.4142);
    r.position.set(0, y + 0.15 + 1.3, 0);
    r.castShadow = true; r.receiveShadow = true;
    b.add(r);
  }

  function mansardRoof(THREE, S, b, w, d, y, seed) {
    var rTop = 1 - 3.2 / Math.min(w, d);
    var f = new THREE.Mesh(new THREE.CylinderGeometry(rTop, 1, 2.6, 4, 1), S.M.shingle);
    f.rotation.y = Math.PI / 4;
    f.scale.set(w / 1.4142, 1, d / 1.4142);
    f.position.set(0, y + 1.3, 0);
    f.castShadow = true; f.receiveShadow = true;
    b.add(f);
    box(THREE, b, rTop * w - 0.2, 0.14, rTop * d - 0.2, S.M.membrane, 0, y + 2.67, 0);
    for (var s = -1; s <= 1; s += 2) {                  // dormers on both slopes
      for (var i = 0; i < 2; i++) {
        var dx = -w / 4 + i * w / 2;
        box(THREE, b, 1.6, 1.4, 1.2, S.M.dormer, dx, y + 1.15, s * (d / 2 - 1.0));
        var win = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.9), S.M.glass);
        win.position.set(dx, y + 1.15, s * (d / 2 - 0.38));
        if (s < 0) win.rotation.y = Math.PI;
        b.add(win);
      }
    }
  }

  // Monitors run along x; glazing faces north (-z, correct for daylighting).
  function sawtoothRoof(THREE, S, b, w, d, y, n, seed) {
    var bayW = d / n;
    var slopeLen = Math.sqrt(bayW * bayW + 2.2 * 2.2);
    var ang = Math.atan2(2.2, bayW);
    for (var i = 0; i < n; i++) {
      var z0 = -d / 2 + i * bayW, zc = z0 + bayW / 2;
      var slope = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, slopeLen + 0.15), S.M.sawRoof);
      slope.position.set(0, y + 1.1, zc);
      slope.rotation.x = ang;                           // high at -z, low at +z
      slope.castShadow = true; slope.receiveShadow = true;
      b.add(slope);
      box(THREE, b, w, 2.2, 0.12, S.M.sawGlass, 0, y + 1.1, z0 + 0.06);
      var sh = new THREE.Shape();                       // end caps
      sh.moveTo(0, 0); sh.lineTo(bayW, 0); sh.lineTo(0, 2.2); sh.closePath();
      var capG = new THREE.ShapeGeometry(sh);
      var c1 = new THREE.Mesh(capG, S.M.sawRoofDS);
      c1.rotation.y = Math.PI / 2;
      c1.position.set(w / 2, y, z0 + bayW);
      b.add(c1);
      var c2 = new THREE.Mesh(capG, S.M.sawRoofDS);
      c2.rotation.y = -Math.PI / 2;
      c2.position.set(-w / 2, y, z0);
      b.add(c2);
    }
  }

  function gabledRoof(THREE, S, b, w, d, y, seed, wallMat) {
    var rise = 2.4, run = d / 2;
    var slopeLen = Math.sqrt(run * run + rise * rise) + 0.3;
    var ang = Math.atan2(rise, run);
    for (var s = -1; s <= 1; s += 2) {
      var p = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.15, slopeLen), S.M.tile);
      p.position.set(0, y + rise / 2, s * d / 4);
      p.rotation.x = s * ang;
      p.castShadow = true; p.receiveShadow = true;
      b.add(p);
    }
    box(THREE, b, w + 0.34, 0.18, 0.3, S.M.tile, 0, y + rise + 0.05, 0); // ridge
    var sh = new THREE.Shape();                         // gable ends
    sh.moveTo(0, 0); sh.lineTo(d, 0); sh.lineTo(d / 2, rise); sh.closePath();
    var capG = new THREE.ShapeGeometry(sh);
    var g1 = new THREE.Mesh(capG, wallMat);
    g1.rotation.y = Math.PI / 2;
    g1.position.set(w / 2, y, d / 2);
    g1.castShadow = true;
    b.add(g1);
    var g2 = new THREE.Mesh(capG, wallMat);
    g2.rotation.y = -Math.PI / 2;
    g2.position.set(-w / 2, y, -d / 2);
    g2.castShadow = true;
    b.add(g2);
  }

  // ---- ground / road textures ------------------------------------------

  function groundCanvas() {
    var p = cv(8, 8), c = p[0], g = p[1], W = c.width, H = c.height;
    var R = rnd(5001), i;
    g.fillStyle = '#8b8b8b';
    g.fillRect(0, 0, W, H);
    for (i = 0; i < 3000; i++) {
      g.fillStyle = shade([143, 139, 128], 0.85 + R() * 0.3);
      g.fillRect(R() * W, R() * H, 3, 2);
    }
    for (i = 0; i < 10; i++) {
      g.fillStyle = R() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.04)';
      var s = (1 + R() * 2.5) * PXM;
      g.fillRect(R() * W, R() * H, s, s * 0.7);
    }
    g.fillStyle = 'rgba(0,0,0,0.10)';
    g.fillRect(0, H / 2 - 1, W, 2);
    g.fillRect(W / 2 - 1, 0, 2, H);
    return c;
  }

  function grassCanvas() {
    var p = cv(8, 8), c = p[0], g = p[1], W = c.width, H = c.height;
    var R = rnd(6001), i;
    g.fillStyle = '#6b6b6b';
    g.fillRect(0, 0, W, H);
    for (i = 0; i < 2600; i++) {
      g.fillStyle = shade([93, 122, 67], 0.8 + R() * 0.4);
      g.fillRect(R() * W, R() * H, 3, 3);
    }
    for (i = 0; i < 8; i++) {
      g.fillStyle = R() < 0.5 ? 'rgba(41,41,41,0.18)' : 'rgba(152,152,152,0.15)';
      var s = (0.8 + R() * 2) * PXM;
      g.fillRect(R() * W, R() * H, s, s * 0.7);
    }
    return c;
  }

  function sidewalkCanvas() {
    var p = cv(4, 2.5), c = p[0], g = p[1], W = c.width, H = c.height;
    var R = rnd(7001), i;
    g.fillStyle = '#acacac';
    g.fillRect(0, 0, W, H);
    for (i = 0; i < 1400; i++) {
      g.fillStyle = shade([178, 172, 160], 0.85 + R() * 0.3);
      g.fillRect(R() * W, R() * H, 2, 2);
    }
    g.fillStyle = 'rgba(0,0,0,0.22)';
    for (i = 1; i < 4; i++) g.fillRect(0, Math.round(i * H / 4) - 1, W, 2);
    return c;
  }

  // tile: pavedW x 8 m. opts: dashes, edge (white line offset from center).
  // (Parking-lane paint is 12 m-only in this kit; 8 m streets skip it.)
  function asphaltCanvas(pavedW, seed, opts) {
    var p = cv(pavedW, 8), c = p[0], g = p[1], W = c.width, H = c.height;
    var R = rnd(seed), i;
    g.fillStyle = '#363636';
    g.fillRect(0, 0, W, H);
    for (i = 0; i < 2200; i++) {
      g.fillStyle = shade([51, 54, 59], 0.8 + R() * 0.4);
      g.fillRect(R() * W, R() * H, 2, 2);
    }
    for (i = 0; i < 6; i++) {
      g.fillStyle = 'rgba(0,0,0,' + (0.04 + R() * 0.06).toFixed(3) + ')';
      g.fillRect(R() * W, R() * H, (1 + R() * 3) * PXM, (1 + R() * 2) * PXM);
    }
    var cx = W / 2;
    if (opts.dashes) {                                  // amber center dashes
      g.fillStyle = '#a0a0a0';
      g.fillRect(cx - 0.075 * PXM, 2.5 * PXM, 0.15 * PXM, 3 * PXM);
    }
    if (opts.edge) {                                    // white lane lines
      g.fillStyle = 'rgba(231,231,231,0.85)';
      var ex = opts.edge * PXM;
      g.fillRect(cx - ex - 3, 0, 6, H);
      g.fillRect(cx + ex - 3, 0, 6, H);
    }
    return c;
  }

  // 12 m arterial tile with parking-lane stall ticks (Michigan Ave, Wabash).
  function arterialCanvas(seed) {
    var p = cv(12, 8), c = p[0], g = p[1], W = c.width, H = c.height;
    var R = rnd(seed), i;
    g.fillStyle = '#363636';
    g.fillRect(0, 0, W, H);
    for (i = 0; i < 2200; i++) {
      g.fillStyle = shade([51, 54, 59], 0.8 + R() * 0.4);
      g.fillRect(R() * W, R() * H, 2, 2);
    }
    var cx = W / 2;
    g.fillStyle = '#a0a0a0';                            // amber center dashes
    g.fillRect(cx - 0.075 * PXM, 2.5 * PXM, 0.15 * PXM, 3 * PXM);
    g.fillStyle = 'rgba(231,231,231,0.85)';              // white lane lines
    var ex = 3.5 * PXM;
    g.fillRect(cx - ex - 3, 0, 6, H);
    g.fillRect(cx + ex - 3, 0, 6, H);
    g.fillStyle = 'rgba(231,231,231,0.8)';               // parking stall ticks
    for (var ty = 0.5; ty < 8; ty += 3) {
      var yy = ty * PXM;
      g.fillRect((12 / 2 + 3.6) * PXM, yy, 2.3 * PXM, 4);
      g.fillRect((12 / 2 - 5.9) * PXM, yy, 2.3 * PXM, 4);
    }
    return c;
  }

  function parkingCanvas() {                            // surface lot: stalls
    var p = cv(12, 8), c = p[0], g = p[1], W = c.width, H = c.height;
    var R = rnd(8001), i;
    g.fillStyle = '#363636';
    g.fillRect(0, 0, W, H);
    for (i = 0; i < 1600; i++) {
      g.fillStyle = shade([51, 54, 59], 0.8 + R() * 0.4);
      g.fillRect(R() * W, R() * H, 2, 2);
    }
    g.fillStyle = 'rgba(231,231,231,0.75)';
    for (var x = 0; x <= W; x += 2.75 * PXM) {           // stall dividers
      g.fillRect(x - 2, H * 0.08, 4, H * 0.3);
      g.fillRect(x - 2, H * 0.62, 4, H * 0.3);
    }
    g.fillStyle = 'rgba(160,160,160,0.7)';               // drive aisle
    g.fillRect(0, H * 0.44, W, 5);
    g.fillRect(0, H * 0.52, W, 5);
    return c;
  }

  // ---- road / sidewalk construction ------------------------------------

  // axis 'x': road runs along x at fixed z = c, from x = a to x = b.
  // axis 'z': road runs along z at fixed x = c, from z = a to z = b.
  // opts.skipWalk: 'pos' | 'neg' — omit one sidewalk (map-edge streets and
  // the E-spoke east extension, whose south walk would z-fight Wabash St's
  // north walk exactly as round 2's segments already do).
  function roadSeg(THREE, S, g, axis, c, a, b, pavedW, surfCanvas, opts) {
    var len = b - a;
    if (!(len > 0.05)) return;
    var mid = (a + b) / 2;
    var t = tex(THREE, surfCanvas);
    if (axis === 'x') t.repeat.set(len / 8, 1);
    else t.repeat.set(1, len / 8);
    var surf = new THREE.Mesh(
      axis === 'x' ? new THREE.BoxGeometry(len, ROAD_TOP, pavedW)
                   : new THREE.BoxGeometry(pavedW, ROAD_TOP, len),
      std(THREE, t, 0.95));
    if (axis === 'x') surf.position.set(mid, ROAD_TOP / 2, c);
    else surf.position.set(c, ROAD_TOP / 2, mid);
    surf.receiveShadow = true;
    surf.userData.noCast = true;
    g.add(surf);

    function strip(w, y0, h, mat, off, cast) {
      var m = new THREE.Mesh(
        axis === 'x' ? new THREE.BoxGeometry(len, h, w)
                     : new THREE.BoxGeometry(w, h, len), mat);
      if (axis === 'x') m.position.set(mid, y0 + h / 2, c + off);
      else m.position.set(c + off, y0 + h / 2, mid);
      m.castShadow = cast !== false;
      m.userData.noCast = (cast === false);
      m.receiveShadow = true;
      g.add(m);
    }
    var wt = tex(THREE, S.walkCanvas);                  // sidewalk texture
    if (axis === 'x') wt.repeat.set(len / 4, 1);
    else wt.repeat.set(1, len / 4);
    var walkMat = std(THREE, wt, 0.95);
    var skip = (opts && opts.skipWalk) || null;
    var co = pavedW / 2 + 0.175, wo = pavedW / 2 + 0.35 + 1.25;
    strip(0.35, ROAD_TOP, 0.16, S.M.curb, co, true);     // curbs
    strip(0.35, ROAD_TOP, 0.16, S.M.curb, -co, true);
    if (skip !== 'pos') strip(2.5, ROAD_TOP, 0.12, walkMat, wo, false);
    if (skip !== 'neg') strip(2.5, ROAD_TOP, 0.12, walkMat, -wo, false);
  }

  function crosswalkX(THREE, S, g, atX, zc, roadW) {
    for (var i = 0; i < 6; i++) {                       // transverse bars
      box(THREE, g, 0.6, 0.02, roadW - 1.5, S.M.paint,
          atX + (i - 2.5) * 1.1, ROAD_TOP + 0.015, zc, false);
    }
  }

  function crosswalkZ(THREE, S, g, xc, atZ, roadW) {
    for (var i = 0; i < 6; i++) {
      box(THREE, g, roadW - 1.5, 0.02, 0.6, S.M.paint,
          xc, ROAD_TOP + 0.015, atZ + (i - 2.5) * 1.1, false);
    }
  }

  // ---- building archetypes ---------------------------------------------

  function buildWalls(THREE, b, w, d, h, mats) {
    function face(w2, mat, px, pz, ry) {
      var m = new THREE.Mesh(new THREE.PlaneGeometry(w2, h), mat);
      m.position.set(px, h / 2, pz);
      m.rotation.y = ry;
      m.castShadow = true;
      m.receiveShadow = true;
      b.add(m);
    }
    face(w, mats.pz, 0, d / 2, 0);
    face(w, mats.nz, 0, -d / 2, Math.PI);
    face(d, mats.px, w / 2, 0, Math.PI / 2);
    face(d, mats.nx, -w / 2, 0, -Math.PI / 2);
  }

  function wallMats(THREE, mk, list) {
    return { pz: mk(list[0]), nz: mk(list[1]), px: mk(list[2]), nx: mk(list[3]) };
  }

  function warehouse(THREE, S, g, cx, cz, w, d, h, seed, base, roof, doors, nMon) {
    var b = new THREE.Group();
    var mk = function (c) { return std(THREE, tex(THREE, c)); };
    buildWalls(THREE, b, w, d, h, wallMats(THREE, mk, [
      warehouseCanvas(w, h, seed, base, doors),
      warehouseCanvas(w, h, seed + 1, base, doors),
      warehouseCanvas(d, h, seed + 2, base, null),
      warehouseCanvas(d, h, seed + 3, base, null)
    ]));
    if (roof === 'sawtooth') sawtoothRoof(THREE, S, b, w, d, h, nMon || 3, seed);
    else if (roof === 'gable') gabledRoof(THREE, S, b, w, d, h, seed, mk(parapetCanvas(seed + 40)));
    else flatRoof(THREE, S, b, w, d, h, seed);
    b.position.set(cx, 0, cz);
    g.add(b);
    return b;
  }

  function walkup(THREE, S, g, cx, cz, w, d, h, seed, base, roof, doorX) {
    var b = new THREE.Group();
    var mk = function (c) { return std(THREE, tex(THREE, c)); };
    buildWalls(THREE, b, w, d, h, wallMats(THREE, mk, [
      apartmentCanvas(w, h, seed, base, doorX == null ? w / 2 : doorX),
      apartmentCanvas(w, h, seed + 1, base, null),
      apartmentCanvas(d, h, seed + 2, base, null),
      apartmentCanvas(d, h, seed + 3, base, null)
    ]));
    if (roof === 'hipped') hippedRoof(THREE, S, b, w, d, h, seed);
    else if (roof === 'gable') gabledRoof(THREE, S, b, w, d, h, seed, mk(parapetCanvas(seed + 40)));
    else flatRoof(THREE, S, b, w, d, h, seed);
    b.position.set(cx, 0, cz);
    g.add(b);
    return b;
  }

  // 4-story walk-up with the top floor set back (massing variety).
  function walkupSetback(THREE, S, g, cx, cz, w, d, seed, base) {
    var b = walkup(THREE, S, g, cx, cz, w, d, 9.6, seed, base, 'flat', w / 2);
    var up = new THREE.Group();
    var mk = function (c) { return std(THREE, tex(THREE, c)); };
    buildWalls(THREE, up, w - 4, d - 4, 3.2, wallMats(THREE, mk, [
      apartmentCanvas(w - 4, 3.2, seed + 10, base, null),
      apartmentCanvas(w - 4, 3.2, seed + 11, base, null),
      apartmentCanvas(d - 4, 3.2, seed + 12, base, null),
      apartmentCanvas(d - 4, 3.2, seed + 13, base, null)
    ]));
    up.position.set(0, 9.6, 0);
    b.add(up);
    flatRoof(THREE, S, up, w - 4, d - 4, 3.2, seed + 20);
    return b;                                           // total height 12.8 m
  }

  function commercial(THREE, S, g, cx, cz, w, d, h, seed, base, signText) {
    var b = new THREE.Group();
    var mk = function (c) { return std(THREE, tex(THREE, c)); };
    buildWalls(THREE, b, w, d, h, wallMats(THREE, mk, [
      storefrontCanvas(w, h, seed, base, signText),
      storefrontCanvas(w, h, seed + 1, base, signText),
      apartmentCanvas(d, h, seed + 2, base, null),
      apartmentCanvas(d, h, seed + 3, base, null)
    ]));
    flatRoof(THREE, S, b, w, d, h, seed);
    b.position.set(cx, 0, cz);
    g.add(b);
    return b;
  }

  // Landmark variant: storefront walls on all four faces + mansard roof.
  function commercialMansard(THREE, S, g, cx, cz, w, d, h, seed, base, signText) {
    var b = new THREE.Group();
    var mk = function (c) { return std(THREE, tex(THREE, c)); };
    buildWalls(THREE, b, w, d, h, wallMats(THREE, mk, [
      storefrontCanvas(w, h, seed, base, signText),
      storefrontCanvas(w, h, seed + 1, base, signText),
      storefrontCanvas(d, h, seed + 2, base, signText),
      storefrontCanvas(d, h, seed + 3, base, signText)
    ]));
    mansardRoof(THREE, S, b, w, d, h, seed);
    b.position.set(cx, 0, cz);
    g.add(b);
    return b;                                           // total height h + 2.6
  }

  // ---- trees, tufts, signs, lots ---------------------------------------
  // Street trees are collected as spots and baked into two InstancedMeshes
  // (trunks + canopies) so ~300 trees cost 2 meshes. Canopy color varies
  // per instance between two greens. Overall height 6.8 - 8.5 m.

  function addTreeSpot(S, x, z, y0, seed) {
    S.treeSpots.push({ x: x, z: z, y0: y0, seed: seed });
  }

  function buildTrees(THREE, S, g) {
    var spots = S.treeSpots, n = spots.length;
    if (!n) return;
    var up = new THREE.Vector3(0, 1, 0);
    var trunk = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.14, 0.2, 3.0, 8), S.M.trunk, n);
    var canopy = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(2.1, 1), S.M.leaf, n);
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    var p = new THREE.Vector3(), s = new THREE.Vector3();
    var cA = new THREE.Color(0x646464), cB = new THREE.Color(0x707070);
    for (var i = 0; i < n; i++) {
      var t = spots[i];
      var sc = 1.0 + (t.seed % 7) * 0.04;
      q.setFromAxisAngle(up, (t.seed * 1.7) % (Math.PI * 2));
      p.set(t.x, t.y0 + 1.5 * sc, t.z);
      s.set(sc, sc, sc);
      m4.compose(p, q, s);
      trunk.setMatrixAt(i, m4);
      p.set(t.x, t.y0 + 4.1 * sc, t.z);
      s.set(1.15 * sc, 1.3 * sc, 1.15 * sc);
      m4.compose(p, q, s);
      canopy.setMatrixAt(i, m4);
      canopy.setColorAt(i, (t.seed % 2 === 0) ? cA : cB);
    }
    trunk.instanceMatrix.needsUpdate = true;
    canopy.instanceMatrix.needsUpdate = true;
    if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
    g.add(trunk);
    g.add(canopy);
  }

  function buildTufts(THREE, S, g) {
    var spots = S.tuftSpots, n = spots.length;
    if (!n) return;
    var up = new THREE.Vector3(0, 1, 0);
    var tuft = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.16, 0.55, 5), S.M.tuft, n);
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    var p = new THREE.Vector3(), s = new THREE.Vector3();
    for (var i = 0; i < n; i++) {
      var t = spots[i];
      var sc = 0.7 + (t.seed % 5) * 0.15;
      q.setFromAxisAngle(up, (t.seed * 2.3) % (Math.PI * 2));
      p.set(t.x, 0.06 + 0.27 * sc, t.z);
      s.set(sc, sc, sc);
      m4.compose(p, q, s);
      tuft.setMatrixAt(i, m4);
    }
    tuft.instanceMatrix.needsUpdate = true;
    tuft.userData.noCast = true;
    g.add(tuft);
  }

  function signCanvas(text) {
    var c = document.createElement('canvas');
    c.width = 512; c.height = 144;
    var g = c.getContext('2d');
    g.fillStyle = '#3b3b3b';
    g.fillRect(0, 0, 512, 144);
    g.strokeStyle = '#e8e8e8';
    g.lineWidth = 6;
    g.strokeRect(8, 8, 496, 128);
    g.fillStyle = '#f2f2f2';
    g.font = 'bold 64px Arial,sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 256, 76);
    return c;
  }

  // Small pole-mounted blade sign with two crossed street-name blades.
  // All names are real Detroit street names (verifiable on any street map).
  function bladeSign(THREE, S, g, x, z, nameA, nameB) {
    var y0 = 0.47;                                      // sidewalk top
    var sg = new THREE.Group();
    var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 3.6, 8), S.M.pole);
    pole.position.y = 1.8;
    pole.castShadow = true;
    sg.add(pole);
    function blade(text, ry, by) {
      var tm = std(THREE, tex(THREE, signCanvas(text)), 0.6);
      var mats = [S.M.edge, S.M.edge, S.M.edge, S.M.edge, tm, tm];
      var m = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.24, 0.03), mats);
      m.rotation.y = ry;
      m.position.y = by;
      m.castShadow = true;
      sg.add(m);
    }
    blade(nameA, 0, 3.15);
    blade(nameB, Math.PI / 2, 2.8);
    sg.position.set(x, y0, z);
    g.add(sg);
  }

  function grassSlab(THREE, S, g, x0, x1, z0, z1, seed, tuftCount) {
    var t = tex(THREE, S.grassCanvas);
    t.repeat.set((x1 - x0) / 8, (z1 - z0) / 8);
    box(THREE, g, x1 - x0, 0.12, z1 - z0, std(THREE, t, 1),
        (x0 + x1) / 2, 0, (z0 + z1) / 2, false);
    var R = rnd(seed);
    for (var i = 0; i < tuftCount; i++) {
      S.tuftSpots.push({
        x: x0 + 1 + R() * (x1 - x0 - 2),
        z: z0 + 1 + R() * (z1 - z0 - 2),
        seed: Math.floor(R() * 1000)
      });
    }
  }

  function bench(THREE, S, g, x, z, ry) {
    var b = new THREE.Group();
    box(THREE, b, 1.8, 0.09, 0.5, S.M.benchWood, 0, 0.45, 0);
    box(THREE, b, 1.8, 0.5, 0.08, S.M.benchWood, 0, 0.75, -0.24);
    box(THREE, b, 0.08, 0.45, 0.45, S.M.benchIron, -0.8, 0.225, 0);
    box(THREE, b, 0.08, 0.45, 0.45, S.M.benchIron, 0.8, 0.225, 0);
    b.position.set(x, 0.06, z);
    b.rotation.y = ry || 0;
    g.add(b);
  }

  // ---- shared materials --------------------------------------------------

  function makeShared(THREE) {
    var S = { M: {}, treeSpots: [], tuftSpots: [] };
    var M = S.M;
    M.curb = new THREE.MeshStandardMaterial({ color: 0xb5b5b5, roughness: 0.95 });
    M.paint = new THREE.MeshStandardMaterial({ color: 0xe7e7e7, roughness: 0.7 });
    M.asphaltPad = std(THREE, tex(THREE, asphaltCanvas(8, 39001, {})), 0.95);
    M.glass = new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 0.25, metalness: 0.5 });
    M.membrane = std(THREE, tex(THREE, membraneCanvas(39101)), 0.95);
    M.membrane.map.repeat.set(3, 3);
    M.tile = std(THREE, tex(THREE, tileCanvas(39102)), 0.9);
    M.shingle = std(THREE, tex(THREE, shingleCanvas(39103)), 0.9);
    M.shingle.map.repeat.set(6, 2);
    M.sawRoof = new THREE.MeshStandardMaterial({ color: 0x6e6e6e, roughness: 0.8 });
    M.sawRoofDS = new THREE.MeshStandardMaterial({ color: 0x6e6e6e, roughness: 0.8, side: THREE.DoubleSide });
    M.sawGlass = std(THREE, tex(THREE, glassGridCanvas()), 0.3, 0.4);
    M.parapet = std(THREE, tex(THREE, parapetCanvas(39104)), 0.9);
    M.ac = new THREE.MeshStandardMaterial({ color: 0x9f9f9f, roughness: 0.7, metalness: 0.3 });
    M.vent = new THREE.MeshStandardMaterial({ color: 0x7d7d7d, roughness: 0.6, metalness: 0.4 });
    M.steel = new THREE.MeshStandardMaterial({ color: 0x3e3e3e, roughness: 0.5, metalness: 0.6 });
    M.tank = new THREE.MeshStandardMaterial({ color: 0x717171, roughness: 0.85 });
    M.tankRoof = new THREE.MeshStandardMaterial({ color: 0x4d4d4d, roughness: 0.9 });
    M.eave = new THREE.MeshStandardMaterial({ color: 0x4d4d4d, roughness: 0.9 });
    M.dormer = new THREE.MeshStandardMaterial({ color: 0x828282, roughness: 0.9 });
    M.trunk = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 1 });
    M.leaf = new THREE.MeshStandardMaterial({ color: 0x646464, roughness: 1 });
    M.tuft = new THREE.MeshStandardMaterial({ color: 0x7a7a7a, roughness: 1 });
    M.pole = new THREE.MeshStandardMaterial({ color: 0x2e2e2e, roughness: 0.6, metalness: 0.5 });
    M.edge = new THREE.MeshStandardMaterial({ color: 0x2e2e2e, roughness: 0.6 });
    M.benchWood = new THREE.MeshStandardMaterial({ color: 0x626262, roughness: 0.9 });
    M.benchIron = new THREE.MeshStandardMaterial({ color: 0x2e2e2e, roughness: 0.6, metalness: 0.4 });
    M.ground = std(THREE, tex(THREE, groundCanvas()), 1);
    M.ground.map.repeat.set(32, 16);
    S.walkCanvas = sidewalkCanvas();
    S.grassCanvas = grassCanvas();
    S.spokeCanvas = asphaltCanvas(8, 39201, { dashes: true, edge: 3.6 });
    S.streetCanvas = arterialCanvas(39202);
    S.aveCanvas = asphaltCanvas(7, 39203, { dashes: true, edge: 3.1 });
    return S;
  }

  // ---- round-4 additions ---------------------------------------------------
  // New kit pieces for the far-field build. Everything below lives inside
  // the same IIFE and reuses the round-3 kit above (painters, roof builders,
  // archetypes, roadSeg, trees, signs, makeShared).

  // roadSegY: roadSeg with a vertical shift for crossing layering.
  // Convention in this module: N-S avenues sit 0.02 m BELOW E-W streets so
  // continuous pavements never z-fight at intersections.
  function roadSegY(THREE, S, g, axis, c, a, b, pavedW, surfCanvas, opts, yOff) {
    var before = g.children.length;
    roadSeg(THREE, S, g, axis, c, a, b, pavedW, surfCanvas, opts);
    if (yOff) {
      for (var i = before; i < g.children.length; i++) {
        g.children[i].position.y += yOff;
      }
    }
  }

  // roadSegLite: one-mesh asphalt for minor streets (no curbs/sidewalks).
  // Far-field residential fabric; intersections handled by the yOff layering.
  function roadSegLite(THREE, S, g, axis, c, a, b, pavedW, canvas, yOff) {
    var len = b - a;
    if (!(len > 0.05)) return;
    var mid = (a + b) / 2;
    var t = tex(THREE, canvas);
    if (axis === 'x') t.repeat.set(len / 8, 1);
    else t.repeat.set(1, len / 8);
    var m = new THREE.Mesh(
      axis === 'x' ? new THREE.BoxGeometry(len, ROAD_TOP, pavedW)
                   : new THREE.BoxGeometry(pavedW, ROAD_TOP, len),
      std(THREE, t, 0.95));
    if (axis === 'x') m.position.set(mid, ROAD_TOP / 2 + (yOff || 0), c);
    else m.position.set(c, ROAD_TOP / 2 + (yOff || 0), mid);
    m.receiveShadow = true;
    m.userData.noCast = true;
    g.add(m);
  }

  // curtainCanvas: glass curtain wall with horizontal floor banding
  // (SimCity-3000 bar: material change between floors on every facade).
  function curtainCanvas(wM, hM, seed) {
    var p = cv(wM, hM), c = p[0], g = p[1], W = c.width, H = c.height;
    var R = rnd(seed);
    var floors = Math.max(2, Math.round(hM / 3.2));
    var fh = hM / floors;
    for (var f = 0; f < floors; f++) {
      var yTop = Y(hM, (f + 1) * fh), yBot = Y(hM, f * fh + 0.55);
      var gr = g.createLinearGradient(0, yTop, 0, yBot);
      var tint = 0.85 + R() * 0.3;
      gr.addColorStop(0, shade([150, 175, 190], tint));
      gr.addColorStop(1, shade([90, 110, 125], tint));
      g.fillStyle = gr;
      g.fillRect(0, yTop, W, yBot - yTop);
      g.fillStyle = 'rgba(34,34,34,0.85)';               // mullions
      for (var x = 0; x <= W; x += 1.2 * PXM) g.fillRect(x - 2, yTop, 4, yBot - yTop);
      g.fillStyle = '#d2d2d2';                          // slab edge
      g.fillRect(0, yBot, W, 0.28 * PXM);
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.fillRect(0, yBot + 0.28 * PXM, W, 0.12 * PXM);
    }
    paintBase(g, W, H);
    return c;
  }

  // officeTower: curtain-wall mid-rise with a set-back crown floor,
  // parapets and rooftop plant. Stays subordinate to the Academy HQ.
  function officeTower(THREE, S, g, cx, cz, w, d, floors, seed, signText) {
    var h = floors * 3.2;
    var b = new THREE.Group();
    var mk = function (c) { return std(THREE, tex(THREE, c), 0.35, 0.35); };
    buildWalls(THREE, b, w, d, h, wallMats(THREE, mk, [
      curtainCanvas(w, h, seed), curtainCanvas(w, h, seed + 1),
      curtainCanvas(d, h, seed + 2), curtainCanvas(d, h, seed + 3)
    ]));
    var cw = w * 0.68, cd = d * 0.68, ch = 3.0;         // crown floor
    var up = new THREE.Group();
    buildWalls(THREE, up, cw, cd, ch, wallMats(THREE, mk, [
      curtainCanvas(cw, ch, seed + 10), curtainCanvas(cw, ch, seed + 11),
      curtainCanvas(cd, ch, seed + 12), curtainCanvas(cd, ch, seed + 13)
    ]));
    up.position.set(0, h, 0);
    b.add(up);
    parapet(THREE, S, up, cw, cd, ch);
    flatRoof(THREE, S, b, w, d, h, seed + 20);          // membrane + plant ring
    if (signText) {                                     // rooftop sign board
      var sc = signCanvas(signText);
      var tm = std(THREE, tex(THREE, sc), 0.6);
      var board = new THREE.Mesh(new THREE.BoxGeometry(10, 1.1, 0.25),
        [S.M.edge, S.M.edge, S.M.edge, S.M.edge, tm, tm]);
      board.position.set(0, h + ch + 1.4, cd / 2 + 0.4);
      board.castShadow = true;
      b.add(board);
      var legL = new THREE.Mesh(new THREE.BoxGeometry(0.25, 1.6, 0.25), S.M.edge);
      legL.position.set(-4, h + ch + 0.4, cd / 2 + 0.4);
      b.add(legL);
      var legR = legL.clone();
      legR.position.x = 4;
      b.add(legR);
    }
    b.position.set(cx, 0, cz);
    g.add(b);
    return b;                                           // total height h + ch
  }

  // houseCanvas: light clapboard/brick worker cottage, painted for an
  // 8 x 5.5 m face. Kept light so per-instance color tints read.
  function houseCanvas(seed) {
    var wM = 8, hM = 5.5;
    var p = cv(wM, hM), c = p[0], g = p[1], W = c.width, H = c.height;
    var R = rnd(seed);
    if (R() < 0.5) {                                    // clapboard siding
      g.fillStyle = '#c9c9c9';
      g.fillRect(0, 0, W, H);
      for (var y = 0; y < H; y += 0.25 * PXM) {
        g.fillStyle = 'rgba(0,0,0,0.07)';
        g.fillRect(0, y, W, 2);
      }
    } else {                                            // pale brick
      paintBrick(g, W, H, seed + 5, [196, 170, 148]);
    }
    paintWindow(g, 1.1 * PXM, Y(hM, 3.7), 1.4, 1.7);
    paintWindow(g, 5.5 * PXM, Y(hM, 3.7), 1.4, 1.7);
    var dx = 3.5 * PXM, dw = 1.0 * PXM, dh = 2.2 * PXM;
    var dy = H - 0.15 * PXM - dh;
    g.fillStyle = '#3f3f3f';                            // door
    g.fillRect(dx, dy, dw, dh);
    g.fillStyle = '#828282';
    g.fillRect(dx - 5, dy - 6, dw + 10, 6);
    g.fillStyle = '#666666';                            // stoop
    g.fillRect(dx - 8, H - 0.15 * PXM, dw + 16, 0.15 * PXM);
    paintBase(g, W, H);
    return c;
  }

  // cornerStoreCanvas: one textured face for instanced corner stores
  // (10 x 7 m). Three sign variants so repeats don't read as copies.
  function cornerStoreCanvas(signText, seed) {
    var wM = 10, hM = 7;
    var p = cv(wM, hM), c = p[0], g = p[1], W = c.width, H = c.height;
    paintBrick(g, W, H, seed, [150, 110, 88]);
    var gh = 3.6;
    for (var x = 0.4; x + 2.6 <= wM; x += 3.0) {        // storefront glass
      var gx = x * PXM, gw = 2.6 * PXM;
      var yG0 = Y(hM, 2.9), yG1 = Y(hM, 0.7);
      var gr = g.createLinearGradient(0, yG0, 0, yG1);
      gr.addColorStop(0, '#393939');
      gr.addColorStop(1, '#1b1b1b');
      g.fillStyle = gr;
      g.fillRect(gx, yG0, gw, yG1 - yG0);
      g.fillStyle = '#202020';
      g.fillRect(gx + gw / 2 - 2, yG0, 4, yG1 - yG0);
    }
    var sbY = Y(hM, 3.6), sbH = 0.85 * PXM;             // sign band
    g.fillStyle = '#262626';
    g.fillRect(0, sbY, W, sbH);
    g.fillStyle = '#e2e2e2';
    g.font = 'bold ' + Math.round(0.5 * PXM) + 'px Georgia,serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(signText, W / 2, sbY + sbH / 2);
    for (x = 1.6; x + 1.4 <= wM - 1.2; x += 2.8) {       // flat windows above
      paintWindow(g, x * PXM, Y(hM, 6.0), 1.4, 1.6);
    }
    paintTopBand(g, W, 0.45, '#c8c8c8');
    paintBase(g, W, H);
    return c;
  }

  // buildHouses: bake collected house spots into two InstancedMeshes
  // (painted bodies + hip roofs). Thousands of homes, two draw calls.
  function buildHouses(THREE, S, g) {
    var spots = S.houseSpots, n = spots.length;
    if (!n) return;
    var bodyGeo = new THREE.BoxGeometry(1, 1, 1);
    var bodies = new THREE.InstancedMesh(bodyGeo,
      std(THREE, tex(THREE, houseCanvas(51001)), 0.9), n);
    bodies.userData.kind = 'house';
    var roofGeo = new THREE.ConeGeometry(1, 1, 4);
    roofGeo.rotateY(Math.PI / 4);                       // faces to the axes
    var roofs = new THREE.InstancedMesh(roofGeo,
      new THREE.MeshStandardMaterial({ color: 0x4d4d4d, roughness: 0.9 }), n);
    roofs.userData.kind = 'house-roof';
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    var p = new THREE.Vector3(), s = new THREE.Vector3();
    var palette = [0xbcbcbc, 0xacacac, 0xa3a3a3, 0xc2c2c2, 0x9b9b9b, 0xa7a7a7, 0xcacaca];
    for (var i = 0; i < n; i++) {
      var t = spots[i];
      p.set(t.x, t.h / 2, t.z);
      s.set(t.w, t.h, t.d);
      m4.compose(p, q, s);
      bodies.setMatrixAt(i, m4);
      bodies.setColorAt(i, new THREE.Color(palette[t.seed % palette.length]));
      p.set(t.x, t.h + 1.05, t.z);                      // hip roof, 6% overhang
      s.set(t.w * 1.12 / Math.SQRT2, 2.1, t.d * 1.12 / Math.SQRT2);
      m4.compose(p, q, s);
      roofs.setMatrixAt(i, m4);
    }
    bodies.instanceMatrix.needsUpdate = true;
    roofs.instanceMatrix.needsUpdate = true;
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    bodies.castShadow = true; bodies.receiveShadow = true;
    roofs.castShadow = true; roofs.receiveShadow = true;
    g.add(bodies);
    g.add(roofs);
  }

  // buildStores: corner stores as three InstancedMeshes (sign variants).
  function buildStores(THREE, S, g) {
    var variants = S.storeSpots;                        // [ [spots], [spots], [spots] ]
    var signs = ['MARKET', 'DELI', 'CAFE'];
    for (var v = 0; v < 3; v++) {
      var spots = variants[v], n = spots.length;
      if (!n) continue;
      var geo = new THREE.BoxGeometry(1, 1, 1);
      var mat = std(THREE, tex(THREE, cornerStoreCanvas(signs[v], 52001 + v)), 0.9);
      var im = new THREE.InstancedMesh(geo, mat, n);
      im.userData.kind = 'store';
      var m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
      var p = new THREE.Vector3(), s = new THREE.Vector3();
      for (var i = 0; i < n; i++) {
        var t = spots[i];
        p.set(t.x, 3.5, t.z);
        s.set(10, 7, 8);
        m4.compose(p, q, s);
        im.setMatrixAt(i, m4);
      }
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = true; im.receiveShadow = true;
      g.add(im);
    }
  }

  // ---- round-4 main assembly -------------------------------------------------
  // Footprint: x in [-1150,1150], z in [-1100,53] (new ground) abutting the
  // existing district x[-224.5,220] z[-222,53]. Combined bounding footprint:
  // 2300 x 1153 m = 2,651,900 m^2 = 2.6519 km^2 = 1.0239 sq mi.
  //
  // Layout (inherits round 3's street positions at the seams):
  //   mid ring   |x| 230..520: dense 20 m avenue pitch, articulated masses
  //   far field  |x| 520..1150: 100 m grid, instanced house fabric
  //   north strip |x| < 224.5, z -1100..-222: avenues extended, house fabric
  // E-W named arterials extended: Michigan Ave (-30), Vernor Hwy (-70),
  // Bagley St (-150), Porter St (-185), Fort St (+45, gap kept over the
  // riverfront/rail zone x[-220,230]). Vernor keeps a gap x[-130,130] where
  // the older core's road network is unknown (no double-build, no z-fight).
  // Minor E-W streets (8 m, geometry only, unsigned) every 100 m from -260.
  // Named N-S arterials: Rosa Parks Blvd (x=+600), Trumbull Ave (x=+800),
  // 12 m. Coarse numbered avenues (8 m, signed): 24th-34th St west.
  // N-S avenues sit 0.02 m below E-W streets: continuous pavements, no gaps,
  // no pads, no z-fighting. Curb/sidewalk strips on full arterials cross
  // minor avenues (reads as continuous curb at this scale; documented).

  function buildRegionExpansionR4(THREE) {
    var g = new THREE.Group();
    var S = makeShared(THREE);
    S.houseSpots = [];
    S.storeSpots = [[], [], []];
    S.massRects = [];
    S.ave8Canvas = asphaltCanvas(8, 39204, { dashes: true, edge: 3.6 });
    var stats = { module: 'region-expansion-r4', buildings: 0, masses: [],
                  houses: 0, stores: 0, trees: 0 };

    function noteMass(label, cx, cz, w, d, h) {
      stats.masses.push({ label: label, cx: cx, cz: cz, w: w, d: d, h: h });
      S.massRects.push([cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2]);
      stats.buildings++;
    }
    function inMassRect(x, z, pad) {
      for (var i = 0; i < S.massRects.length; i++) {
        var r = S.massRects[i];
        if (x > r[0] - pad && x < r[1] + pad && z > r[2] - pad && z < r[3] + pad) return true;
      }
      return false;
    }

    // 1. ground slabs (top y = 0), abutting existing slabs exactly at the
    //    seams (x = -224.5 / 220, z = -222). Nothing in the water band z > 53.
    var slabs = [
      [-1150, -224.5, -1100, 53],  // west far field
      [220, 1150, -1100, 53],      // east far field
      [-224.5, 220, -1100, -222]   // north strip
    ];
    slabs.forEach(function (s) {
      var w = s[1] - s[0], d = s[3] - s[2];
      var t = tex(THREE, S.M.ground.map.image);
      t.repeat.set(w / 8, d / 8);
      var m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.5, d), std(THREE, t, 1));
      m.position.set((s[0] + s[1]) / 2, -0.25, (s[2] + s[3]) / 2);
      m.receiveShadow = true;
      m.userData.noCast = true;
      m.userData.groundSlab = true;
      m.userData.slabRect = s;
      g.add(m);
    });

    // 2. E-W named arterials (full section: curbs + sidewalks).
    roadSeg(THREE, S, g, 'x', -30, -1150, -220, 12, S.streetCanvas); // Michigan W
    roadSeg(THREE, S, g, 'x', -30, 220, 1150, 12, S.streetCanvas);   // Michigan E
    roadSeg(THREE, S, g, 'x', -70, -1150, -220, 8, S.spokeCanvas);   // Vernor W
    roadSeg(THREE, S, g, 'x', -70, 130, 1150, 8, S.spokeCanvas);     // Vernor E
    roadSeg(THREE, S, g, 'x', -150, -1150, -220, 8, S.spokeCanvas);  // Bagley W
    roadSeg(THREE, S, g, 'x', -150, 130, 1150, 8, S.spokeCanvas);    // Bagley E
    roadSeg(THREE, S, g, 'x', -185, -1150, -220, 8, S.spokeCanvas);  // Porter W
    roadSeg(THREE, S, g, 'x', -185, 130, 1150, 8, S.spokeCanvas);    // Porter E
    roadSeg(THREE, S, g, 'x', 45, -1150, -220, 8, S.spokeCanvas);    // Fort W
    roadSeg(THREE, S, g, 'x', 45, 230, 1150, 8, S.spokeCanvas);      // Fort E

    // 3. E-W minor streets (lite, geometry only, unsigned), 100 m pitch.
    var minorZ = [-260, -360, -460, -560, -660, -760, -860, -960, -1060];
    minorZ.forEach(function (zc) {
      roadSegLite(THREE, S, g, 'x', zc, -1150, -224.5, 8, S.ave8Canvas, 0);
      roadSegLite(THREE, S, g, 'x', zc, -224.5, 220, 8, S.ave8Canvas, 0);
      roadSegLite(THREE, S, g, 'x', zc, 220, 1150, 8, S.ave8Canvas, 0);
    });

    // 4. N-S avenues (lite, 0.02 below E-W).
    //    dense 20 m pitch: mid-ring fabric, z in [-560, 38]
    var denseW = [], denseE = [];
    for (var di = 0; di <= 13; di++) {
      denseW.push(-240 - 20 * di);
      denseE.push(240 + 20 * di);
    }
    denseW.concat(denseE).forEach(function (xc) {
      roadSegLite(THREE, S, g, 'z', xc, -560, 38, 7, S.aveCanvas, -0.02);
    });
    //    coarse 100 m pitch: far field, z in [-1060, 38]
    var coarseW = [-600, -700, -800, -900, -1000, -1100];
    var coarseE = [700, 900, 1100];
    coarseW.concat(coarseE).forEach(function (xc) {
      roadSegLite(THREE, S, g, 'z', xc, -1060, 38, 8, S.ave8Canvas, -0.02);
    });
    //    named N-S arterials east (full section, sunk 0.02 like other N-S)
    roadSegY(THREE, S, g, 'z', 600, -1060, 38, 12, S.streetCanvas, null, -0.02); // Rosa Parks Blvd
    roadSegY(THREE, S, g, 'z', 800, -1060, 38, 12, S.streetCanvas, null, -0.02); // Trumbull Ave
    //    north strip: 14th / N spoke / 15th extended to z = -1060
    [-95, 0, 95].forEach(function (xc) {
      roadSegLite(THREE, S, g, 'z', xc, -1060, -222, 7, S.aveCanvas, -0.02);
    });

    // Avenue registry for clearance tests: {x, z0, z1}.
    var avenues = [];
    denseW.concat(denseE).forEach(function (xc) { avenues.push({ x: xc, z0: -560, z1: 38 }); });
    coarseW.concat(coarseE).forEach(function (xc) { avenues.push({ x: xc, z0: -1060, z1: 38 }); });
    avenues.push({ x: 600, z0: -1060, z1: 38 });
    avenues.push({ x: 800, z0: -1060, z1: 38 });
    [-95, 0, 95].forEach(function (xc) { avenues.push({ x: xc, z0: -1060, z1: -222 }); });
    function nearAvenue(x, z, pad) {
      for (var i = 0; i < avenues.length; i++) {
        var a = avenues[i];
        // 12 m named arterials (Rosa Parks Blvd, Trumbull Ave) need a wider
        // pad: house half-width up to 5 m + 6 m ROW half-width.
        var p = (a.x === 600 || a.x === 800) ? 11 : pad;
        if (z >= a.z0 - 1 && z <= a.z1 + 1 && Math.abs(x - a.x) < p) return true;
      }
      return false;
    }

    // 5. mid-ring articulated buildings (23 masses + 3 landmarks).
    // West mid ring (Michigan/Vernor/Bagley/Porter corridors)
    commercial(THREE, S, g, -270, -11, 5.5, 13, 11, 50001, [150, 110, 88], 'BAKERY');
    noteMass('MW1 corner commercial, Michigan Ave & 21st St', -270, -11, 5.5, 13, 11);
    walkup(THREE, S, g, -310, -51, 5.5, 14, 10.4, 50002, [168, 140, 112], 'flat', 2.75);
    noteMass('MW2 walk-up row, Vernor Hwy frontage', -310, -51, 5.5, 14, 10.4);
    walkupSetback(THREE, S, g, -350, -51, 5.5, 14, 50003, [130, 95, 70]);
    noteMass('MW3 walk-up, set-back top floor (12.8 m)', -350, -51, 5.5, 14, 12.8);
    warehouse(THREE, S, g, -390, -110, 5.5, 24, 7, 50004, [118, 60, 42], 'sawtooth', [1.15], 3);
    noteMass('MW4 sawtooth warehouse, Vernor-Bagley block', -390, -110, 5.5, 24, 7);
    commercial(THREE, S, g, -430, -167.5, 5.5, 12, 8.4, 50005, [122, 62, 44], 'TACOS');
    noteMass('MW5 corner commercial, Bagley-Porter block', -430, -167.5, 5.5, 12, 8.4);
    walkup(THREE, S, g, -470, -206, 5.5, 18, 10.5, 50006, [150, 110, 88], 'gable', 2.75);
    noteMass('MW6 walk-up, gabled roof, north of Porter St', -470, -206, 5.5, 18, 10.5);
    warehouse(THREE, S, g, -270, -300, 10, 30, 8, 50007, [110, 58, 42], 'flat', [3, 9], 0);
    noteMass('MW7 flat-roof warehouse', -270, -300, 10, 30, 8);
    walkup(THREE, S, g, -310, -420, 10, 24, 10.4, 50008, [140, 100, 76], 'flat', 5);
    noteMass('MW8 walk-up row', -310, -420, 10, 24, 10.4);
    commercial(THREE, S, g, -350, -300, 8, 16, 8.4, 50009, [130, 95, 70], 'LAUNDRY');
    noteMass('MW9 corner commercial', -350, -300, 8, 16, 8.4);
    warehouse(THREE, S, g, -390, -500, 12, 28, 9, 50010, [160, 130, 105], 'gable', [4, 10], 0);
    noteMass('MW10 gabled warehouse', -390, -500, 12, 28, 9);
    // East mid ring
    commercial(THREE, S, g, 270, -11, 5.5, 13, 11, 50011, [150, 118, 90], 'BOOKS');
    noteMass('ME1 corner commercial, Michigan Ave', 270, -11, 5.5, 13, 11);
    walkup(THREE, S, g, 310, -51, 5.5, 14, 10.4, 50012, [168, 140, 112], 'flat', 2.75);
    noteMass('ME2 walk-up row, Vernor Hwy frontage', 310, -51, 5.5, 14, 10.4);
    walkupSetback(THREE, S, g, 350, -110, 5.5, 14, 50013, [130, 95, 70]);
    noteMass('ME3 walk-up, set-back top floor (12.8 m)', 350, -110, 5.5, 14, 12.8);
    warehouse(THREE, S, g, 390, -167.5, 5.5, 22, 7, 50014, [118, 60, 42], 'sawtooth', [1.15], 3);
    noteMass('ME4 sawtooth warehouse, Bagley-Porter block', 390, -167.5, 5.5, 22, 7);
    commercial(THREE, S, g, 430, -206, 5.5, 12, 8.4, 50015, [122, 62, 44], 'PHARMACY');
    noteMass('ME5 corner commercial, north of Porter St', 430, -206, 5.5, 12, 8.4);
    walkup(THREE, S, g, 470, -300, 10, 24, 10.4, 50016, [150, 110, 88], 'flat', 5);
    noteMass('ME6 walk-up row', 470, -300, 10, 24, 10.4);
    warehouse(THREE, S, g, 270, -420, 12, 30, 8, 50017, [110, 58, 42], 'flat', [3, 9], 0);
    noteMass('ME7 flat-roof warehouse', 270, -420, 12, 30, 8);
    commercial(THREE, S, g, 310, -500, 8, 16, 8.4, 50018, [140, 100, 76], 'CAFE');
    noteMass('ME8 corner commercial', 310, -500, 8, 16, 8.4);
    walkup(THREE, S, g, 350, -11, 5.5, 14, 10.4, 50019, [122, 62, 44], 'flat', 2.75);
    noteMass('ME9 walk-up row, Michigan Ave frontage', 350, -11, 5.5, 14, 10.4);
    warehouse(THREE, S, g, 390, -390, 12, 28, 9, 50020, [130, 70, 48], 'gable', [3, 9], 0);
    noteMass('ME10 gabled warehouse', 390, -390, 12, 28, 9);
    // North strip
    walkup(THREE, S, g, -120, -300, 12, 20, 10.4, 50021, [150, 118, 90], 'flat', 6);
    noteMass('MN1 walk-up row, 14th St', -120, -300, 12, 20, 10.4);
    warehouse(THREE, S, g, 120, -420, 16, 30, 8, 50022, [118, 60, 42], 'sawtooth', [4, 12], 3);
    noteMass('MN2 sawtooth warehouse, 15th St', 120, -420, 16, 30, 8);
    commercial(THREE, S, g, 40, -320, 10, 14, 8.4, 50023, [130, 95, 70], 'DELI');
    noteMass('MN3 corner commercial, N spoke', 40, -320, 10, 14, 8.4);
    // Landmarks (SimCity-3000 bar: one or two signature buildings per district)
    commercialMansard(THREE, S, g, -730, -110, 30, 20, 12, 50024, [150, 130, 110], 'CIVIC HALL');
    noteMass('L1 LANDMARK civic hall, mansard roof, Michigan Ave & 26th St', -730, -110, 30, 20, 14.6);
    commercialMansard(THREE, S, g, 650, -110, 36, 24, 9, 50025, [140, 110, 85], 'MARKET HALL');
    noteMass('L2 LANDMARK market hall, mansard roof, Michigan Ave & Rosa Parks Blvd', 650, -110, 36, 24, 11.6);
    officeTower(THREE, S, g, 650, -300, 24, 18, 6, 50026, 'MERIDIAN HOUSE');
    noteMass('L3 LANDMARK curtain-wall office, 6 floors + crown (22.2 m)', 650, -300, 24, 18, 22.2);

    // Landmark exclusion rects for the house placer (x0,x1,z0,z1).
    var landmarkRects = [
      [-745, -715, -120, -100],
      [632, 668, -122, -98],
      [638, 662, -309, -291]
    ];
    function inLandmark(x, z, pad) {
      for (var i = 0; i < landmarkRects.length; i++) {
        var r = landmarkRects[i];
        if (x > r[0] - pad && x < r[1] + pad && z > r[2] - pad && z < r[3] + pad) return true;
      }
      return false;
    }

    // 6. corner stores (36, instanced, 3 sign variants) at named intersections.
    var storeDefs = [];
    [-600, -700, -800, -900, -1000, -1100].forEach(function (ax) {
      [-30, -70, -150, -185].forEach(function (sz) {
        storeDefs.push([ax - 14, sz - 14]);
      });
    });
    [600, 800].forEach(function (ax) {
      [-30, -70, -150, -185].forEach(function (sz) {
        storeDefs.push([ax - 14, sz - 14]);
      });
    });
    [[-109, -274], [-81, -274], [81, -274], [109, -274]].forEach(function (p) {
      storeDefs.push(p);
    });
    var storeRects = [];
    storeDefs.forEach(function (p, i) {
      S.storeSpots[i % 3].push({ x: p[0], z: p[1], seed: 53000 + i });
      storeRects.push([p[0] - 8, p[0] + 8, p[1] - 7, p[1] + 7]);
      noteMass('S' + (i + 1) + ' corner store', p[0], p[1], 10, 8, 7);
    });
    function inStore(x, z) {
      for (var i = 0; i < storeRects.length; i++) {
        var r = storeRects[i];
        if (x > r[0] && x < r[1] && z > r[2] && z < r[3]) return true;
      }
      return false;
    }

    // 7. far-field house fabric (instanced). Bands between E-W streets with
    //    depth >= 70 m; two rows per band. North strip only below z = -240
    //    (round 3 owns the ground north of -222 there).
    var bands = [[-150, -70], [-260, -185], [-360, -260], [-460, -360],
                 [-560, -460], [-660, -560], [-760, -660], [-860, -760],
                 [-960, -860], [-1060, -960]];
    var R = rnd(54001);
    bands.forEach(function (bd, bi) {
      var z0 = bd[0], z1 = bd[1];
      [-1, 1].forEach(function (side, ri) {
        var rz = (ri === 0) ? z0 + 12 : z1 - 12;
        var ranges = [[-1140, -235], [235, 1140]];
        if (z1 <= -240) ranges.push([-215, 215]);      // north strip
        ranges.forEach(function (rg) {
          for (var x = rg[0]; x <= rg[1]; x += 14) {
            var jx = x + (R() - 0.5) * 2;             // jitter +-1: min pitch 12 m > max roof 11.2 m
            if (nearAvenue(jx, rz, 9)) continue;
            if (inLandmark(jx, rz, 7)) continue;
            if (inMassRect(jx, rz, 3)) continue;
            if (inStore(jx, rz)) continue;
            if (R() < 0.08) continue;                 // vacant lots read real
            S.houseSpots.push({
              x: Math.round(jx * 10) / 10, z: rz,
              w: 7 + R() * 3, d: 6 + R() * 2.5, h: 5.0 + R() * 1.0,
              seed: 54000 + bi * 1000 + Math.floor(R() * 900)
            });
          }
        });
      });
    });
    stats.houses = S.houseSpots.length;
    stats.stores = storeDefs.length;
    buildHouses(THREE, S, g);
    buildStores(THREE, S, g);

    // 8. grass lots with tufts + trees (far-field green).
    grassSlab(THREE, S, g, -900, -820, -700, -620, 55001, 50);
    grassSlab(THREE, S, g, 700, 780, -700, -620, 55002, 50);
    grassSlab(THREE, S, g, -100, -20, -900, -820, 55003, 50);
    [[-880, -660], [-840, -640], [-860, -680], [720, -660], [760, -640],
     [740, -680], [-80, -860], [-40, -840], [-60, -880]].forEach(function (p, i) {
      addTreeSpot(S, p[0], p[1], 0.06, 55100 + i);
    });

    // 9. street trees (instanced) along the new arterials.
    var ti = 56000;
    function treeRowXr(zc, x0, x1, y0) {
      for (var x = x0; x <= x1 + 0.01; x += 12) {
        if (nearAvenue(x, zc, 8)) continue;
        addTreeSpot(S, x, zc, y0, ti++);
      }
    }
    function treeRowZr(xc, z0, z1, y0) {
      for (var z = z0; z <= z1 + 0.01; z += 12) {
        if (z > -38 && z < -22) continue;             // Michigan Ave crossing
        if (z > -78 && z < -62) continue;             // Vernor Hwy crossing
        if (z > -158 && z < -142) continue;           // Bagley St crossing
        if (z > -193 && z < -177) continue;           // Porter St crossing
        if (z > 37 && z < 53) continue;               // Fort St crossing
        addTreeSpot(S, xc, z, y0, ti++);
      }
    }
    // Michigan Ave (12 m: walks at +-7.6)
    [-37.6, -22.4].forEach(function (zc) {
      treeRowXr(zc, -1144, -226, 0.47);
      treeRowXr(zc, 226, 1144, 0.47);
    });
    // Vernor / Bagley / Porter (8 m: walks at +-5.6)
    [[-75.6, -64.4], [-155.6, -144.4], [-190.6, -179.4]].forEach(function (zz) {
      zz.forEach(function (zc) {
        treeRowXr(zc, -1144, -226, 0.47);
        treeRowXr(zc, 136, 1144, 0.47);
      });
    });
    // Fort St (8 m), west + east of the riverfront gap
    [39.4, 50.6].forEach(function (zc) {
      treeRowXr(zc, -1144, -226, 0.47);
      treeRowXr(zc, 236, 1144, 0.47);
    });
    // Rosa Parks Blvd / Trumbull Ave (12 m: walks at +-7.6)
    [592.4, 607.6, 792.4, 807.6].forEach(function (xc) {
      treeRowZr(xc, -1054, 30, 0.47);
    });
    buildTrees(THREE, S, g);
    buildTufts(THREE, S, g);
    stats.trees = S.treeSpots.length;

    // 10. crosswalks on Michigan Ave far field + blade signs (real names).
    crosswalkX(THREE, S, g, -700, -30, 12);
    crosswalkX(THREE, S, g, 600, -30, 12);
    crosswalkX(THREE, S, g, 800, -30, 12);
    bladeSign(THREE, S, g, -610, -22.4, 'Michigan Ave', '24th St');
    bladeSign(THREE, S, g, -710, -22.4, 'Michigan Ave', '26th St');
    bladeSign(THREE, S, g, -810, -22.4, 'Michigan Ave', '28th St');
    bladeSign(THREE, S, g, -910, -22.4, 'Michigan Ave', '30th St');
    bladeSign(THREE, S, g, -1010, -22.4, 'Michigan Ave', '32nd St');
    bladeSign(THREE, S, g, -1110, -22.4, 'Michigan Ave', '34th St');
    bladeSign(THREE, S, g, 590, -22.4, 'Michigan Ave', 'Rosa Parks Blvd');
    bladeSign(THREE, S, g, 790, -22.4, 'Michigan Ave', 'Trumbull Ave');
    bladeSign(THREE, S, g, -910, -64.4, 'Vernor Hwy', '30th St');
    bladeSign(THREE, S, g, -710, 50.6, 'Fort St', '26th St');
    bladeSign(THREE, S, g, -810, -144.4, 'Bagley St', '28th St');
    bladeSign(THREE, S, g, 590, -179.4, 'Porter St', 'Rosa Parks Blvd');

    // shadows: cast on everything solid; ground/road/paint/tufts receive only
    g.traverse(function (o) {
      if (o.isMesh) {
        o.receiveShadow = true;
        if (!o.userData.noCast) o.castShadow = true;
      }
    });
    g.userData.stats = stats;
    return g;
  }

  window.DAARegionExpansionR4 = { buildRegionExpansionR4: buildRegionExpansionR4 };
})();
