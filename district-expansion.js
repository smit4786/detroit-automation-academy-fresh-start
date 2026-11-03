// Detroit Automation Academy — district expansion, outer ring (overnight round 2).
// Procedural low-rise Corktown context: ground slabs, street extensions, new
// streets and avenues, context buildings, street trees, blade signs.
// Units meters; x = east, z = south, y = up. Ground top y = 0, road top y = 0.35.
// Classic IIFE script; exposes window.DAADistrictExpansion.buildDistrictExpansion(THREE).
// No external assets, no network. Deterministic seeded PRNG for canvas textures.
//
// Street geography (all new work lives at |x| > 65 or z < -65; nothing in the
// water band z > 53):
//   N spoke extension  x in [-4,4],   z in [-130,-65]   (8 m road)
//   E spoke extension  z in [-4,4],   x in [65,130]     (8 m road)
//   W spoke extension  z in [-4,4],   x in [-130,-65]   (8 m road)
//   E-W streets        z = -30 / +15, x in [65,130] and [-130,-65]
//                      (7 m travel + 2 x 2.5 m parking lanes)
//   N-S avenues        x = +/-95,     z in [-130,40]    (7 m road)
// Blade-sign names used are real Corktown street names (facts, verifiable on
// any Detroit street map): Michigan Ave, 14th St, 15th St, Wabash St,
// Trumbull Ave, Brooklyn St.
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
    var R = rnd(seed);                                  // dormers on both slopes
    for (var s = -1; s <= 1; s += 2) {
      for (var i = 0; i < 2; i++) {
        var dx = -w / 4 + i * w / 2;
        box(THREE, b, 1.6, 1.4, 1.2, S.M.dormer, dx, y + 1.15, s * (d / 2 - 1.0));
        var win = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.9), S.M.glass);
        win.position.set(dx, y + 1.15, s * (d / 2 - 0.38));
        if (s < 0) win.rotation.y = Math.PI;
        b.add(win);
      }
    }
    void R;
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

  // tile: pavedW x 8 m. opts: dashes, edge (white line offset from center),
  // parking (stall ticks in the outer 2.5 m lanes).
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
    if (opts.parking) {                                 // stall ticks
      g.fillStyle = 'rgba(231,231,231,0.8)';
      for (var ty = 0.5; ty < 8; ty += 3) {
        var yy = ty * PXM;
        g.fillRect((pavedW / 2 + 3.6) * PXM, yy, 2.3 * PXM, 4);
        g.fillRect((pavedW / 2 - 5.9) * PXM, yy, 2.3 * PXM, 4);
      }
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
  function roadSeg(THREE, S, g, axis, c, a, b, pavedW, surfCanvas) {
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
    g.add(surf);

    function strip(w, y0, h, mat, off) {
      var m = new THREE.Mesh(
        axis === 'x' ? new THREE.BoxGeometry(len, h, w)
                     : new THREE.BoxGeometry(w, h, len), mat);
      if (axis === 'x') m.position.set(mid, y0 + h / 2, c + off);
      else m.position.set(c + off, y0 + h / 2, mid);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    }
    var wt = tex(THREE, S.walkCanvas);                  // sidewalk texture
    if (axis === 'x') wt.repeat.set(len / 4, 1);
    else wt.repeat.set(1, len / 4);
    var walkMat = std(THREE, wt, 0.95);
    var co = pavedW / 2 + 0.175, wo = pavedW / 2 + 0.35 + 1.25;
    strip(0.35, ROAD_TOP, 0.16, S.M.curb, co);          // curbs
    strip(0.35, ROAD_TOP, 0.16, S.M.curb, -co);
    strip(2.5, ROAD_TOP, 0.12, walkMat, wo);            // sidewalks
    strip(2.5, ROAD_TOP, 0.12, walkMat, -wo);
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

  function mansardLoft(THREE, S, g, cx, cz, w, d, h, seed, base) {
    var b = new THREE.Group();
    var mk = function (c) { return std(THREE, tex(THREE, c)); };
    buildWalls(THREE, b, w, d, h, wallMats(THREE, mk, [
      apartmentCanvas(w, h, seed, base, w / 2),
      apartmentCanvas(w, h, seed + 1, base, null),
      apartmentCanvas(d, h, seed + 2, base, null),
      apartmentCanvas(d, h, seed + 3, base, null)
    ]));
    mansardRoof(THREE, S, b, w, d, h, seed);
    b.position.set(cx, 0, cz);
    g.add(b);
    return b;                                           // total height h + 2.6
  }

  // ---- trees, signs, lots ----------------------------------------------

  function treeParts(THREE, S) {
    if (!S.treeGeo) {
      S.treeGeo = {
        trunk: new THREE.CylinderGeometry(0.14, 0.2, 3.0, 8),
        canopy: new THREE.IcosahedronGeometry(1, 1)
      };
    }
    return S.treeGeo;
  }

  // Procedural street tree, 6-9 m. y0: 0.47 on sidewalks, 0 on grade.
  function addTree(THREE, S, g, x, z, y0, seed) {
    var G = treeParts(THREE, S);
    var t = new THREE.Group();
    var trunk = new THREE.Mesh(G.trunk, S.M.trunk);
    trunk.position.y = 1.1;
    trunk.castShadow = true;
    t.add(trunk);
    var lm = (seed % 2 === 0) ? S.M.leaf : S.M.leaf2;
    [[0, 3.4, 0, 1.7], [0.7, 2.8, 0.3, 1.2], [-0.6, 2.9, -0.3, 1.1]].forEach(function (cb) {
      var m = new THREE.Mesh(G.canopy, lm);
      m.scale.setScalar(cb[3]);
      m.position.set(cb[0], cb[1], cb[2]);
      m.castShadow = true;
      t.add(m);
    });
    var s = 1.3 + (seed % 7) * 0.05;                    // 6.6 - 8.2 m tall
    t.scale.setScalar(s);
    t.rotation.y = (seed * 1.7) % (Math.PI * 2);
    t.position.set(x, y0, z);
    t.userData.kind = 'tree';
    g.add(t);
    return t;
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

  function grassLot(THREE, S, g, x0, x1, z0, z1, seed, treeSpots) {
    var t = tex(THREE, S.grassCanvas);
    t.repeat.set((x1 - x0) / 8, (z1 - z0) / 8);
    box(THREE, g, x1 - x0, 0.12, z1 - z0, std(THREE, t, 1),
        (x0 + x1) / 2, -0.06 + 0.06, (z0 + z1) / 2, false);
    for (var i = 0; i < treeSpots.length; i++) {
      addTree(THREE, S, g, treeSpots[i][0], treeSpots[i][1], 0.06, seed + i);
    }
  }

  // ---- shared materials --------------------------------------------------

  function makeShared(THREE) {
    var S = { M: {}, treeGeo: null };
    var M = S.M;
    M.curb = new THREE.MeshStandardMaterial({ color: 0xb5b5b5, roughness: 0.95 });
    M.paint = new THREE.MeshStandardMaterial({ color: 0xe7e7e7, roughness: 0.7 });
    M.asphaltPad = std(THREE, tex(THREE, asphaltCanvas(8, 9001, {})), 0.95);
    M.glass = new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 0.25, metalness: 0.5 });
    M.membrane = std(THREE, tex(THREE, membraneCanvas(9101)), 0.95);
    M.membrane.map.repeat.set(3, 3);
    M.tile = std(THREE, tex(THREE, tileCanvas(9102)), 0.9);
    M.shingle = std(THREE, tex(THREE, shingleCanvas(9103)), 0.9);
    M.shingle.map.repeat.set(6, 2);
    M.sawRoof = new THREE.MeshStandardMaterial({ color: 0x6e6e6e, roughness: 0.8 });
    M.sawRoofDS = new THREE.MeshStandardMaterial({ color: 0x6e6e6e, roughness: 0.8, side: THREE.DoubleSide });
    M.sawGlass = std(THREE, tex(THREE, glassGridCanvas()), 0.3, 0.4);
    M.parapet = std(THREE, tex(THREE, parapetCanvas(9104)), 0.9);
    M.ac = new THREE.MeshStandardMaterial({ color: 0x9f9f9f, roughness: 0.7, metalness: 0.3 });
    M.vent = new THREE.MeshStandardMaterial({ color: 0x7d7d7d, roughness: 0.6, metalness: 0.4 });
    M.steel = new THREE.MeshStandardMaterial({ color: 0x3e3e3e, roughness: 0.5, metalness: 0.6 });
    M.tank = new THREE.MeshStandardMaterial({ color: 0x717171, roughness: 0.85 });
    M.tankRoof = new THREE.MeshStandardMaterial({ color: 0x4d4d4d, roughness: 0.9 });
    M.eave = new THREE.MeshStandardMaterial({ color: 0x4d4d4d, roughness: 0.9 });
    M.dormer = new THREE.MeshStandardMaterial({ color: 0x828282, roughness: 0.9 });
    M.trunk = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 1 });
    M.leaf = new THREE.MeshStandardMaterial({ color: 0x646464, roughness: 1 });
    M.leaf2 = new THREE.MeshStandardMaterial({ color: 0x707070, roughness: 1 });
    M.pole = new THREE.MeshStandardMaterial({ color: 0x2e2e2e, roughness: 0.6, metalness: 0.5 });
    M.edge = new THREE.MeshStandardMaterial({ color: 0x2e2e2e, roughness: 0.6 });
    M.ground = std(THREE, tex(THREE, groundCanvas()), 1);
    M.ground.map.repeat.set(32, 16);
    S.walkCanvas = sidewalkCanvas();
    S.grassCanvas = grassCanvas();
    S.spokeCanvas = asphaltCanvas(8, 9201, { dashes: true, edge: 3.6 });
    S.streetCanvas = asphaltCanvas(12, 9202, { dashes: true, edge: 3.5, parking: true });
    S.aveCanvas = asphaltCanvas(7, 9203, { dashes: true, edge: 3.1 });
    return S;
  }

  // ---- main assembly -------------------------------------------------------

  function buildDistrictExpansion(THREE) {
    var g = new THREE.Group();
    var S = makeShared(THREE);
    var stats = { trees: 0, buildings: 0 };

    // 1. expansion ring ground slabs (top y = 0), excluding water z > 53
    //    and the core |x| <= 65, |z| <= 65.
    var slabs = [
      [-130, 130, -130, -65],   // north band
      [-130, -65, -65, 65],     // west band
      [65, 130, -65, 53]        // east band
    ];
    slabs.forEach(function (s) {
      var w = s[1] - s[0], d = s[3] - s[2];
      var t = tex(THREE, S.M.ground.map.image);
      t.repeat.set(w / 8, d / 8);
      var m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.5, d), std(THREE, t, 1));
      m.position.set((s[0] + s[1]) / 2, -0.25, (s[2] + s[3]) / 2);
      m.receiveShadow = true;
      g.add(m);
    });

    // 2. streets: extensions + new streets + avenues.
    var segs = [
      { axis: 'z', c: 0, a: -130, b: -65, w: 8, cv: 'spoke' },   // N spoke ext
      { axis: 'x', c: 0, a: 65, b: 130, w: 8, cv: 'spoke' },     // E spoke ext
      { axis: 'x', c: 0, a: -130, b: -65, w: 8, cv: 'spoke' },   // W spoke ext
      { axis: 'x', c: -30, a: 65, b: 130, w: 12, cv: 'street' }, // Michigan Ave E
      { axis: 'x', c: -30, a: -130, b: -65, w: 12, cv: 'street' },// Michigan Ave W
      { axis: 'x', c: 15, a: 65, b: 130, w: 12, cv: 'street' },  // Wabash St E
      { axis: 'x', c: 15, a: -130, b: -65, w: 12, cv: 'street' }, // Wabash St W
      { axis: 'z', c: 95, a: -130, b: -39, w: 7, cv: 'ave' },    // 15th St
      { axis: 'z', c: 95, a: -21, b: -7, w: 7, cv: 'ave' },
      { axis: 'z', c: 95, a: 24, b: 40, w: 7, cv: 'ave' },
      { axis: 'z', c: -95, a: -130, b: -39, w: 7, cv: 'ave' },   // 14th St
      { axis: 'z', c: -95, a: -21, b: -7, w: 7, cv: 'ave' },
      { axis: 'z', c: -95, a: 24, b: 40, w: 7, cv: 'ave' }
    ];
    segs.forEach(function (s) {
      var canvas = s.cv === 'spoke' ? S.spokeCanvas : s.cv === 'street' ? S.streetCanvas : S.aveCanvas;
      roadSeg(THREE, S, g, s.axis, s.c, s.a, s.b, s.w, canvas);
    });

    // intersection pads (plain asphalt, top 0.37, hides the overlap seams)
    [[95, -30, 7, 12], [-95, -30, 7, 12], [95, 15, 7, 12], [-95, 15, 7, 12],
     [95, 0, 7, 8], [-95, 0, 7, 8]].forEach(function (p) {
      box(THREE, g, p[2], 0.04, p[3], S.M.asphaltPad, p[0], ROAD_TOP - 0.02 + 0.02, p[1], false);
    });

    // crosswalks on the approaches
    crosswalkX(THREE, S, g, 103, -30, 12);
    crosswalkX(THREE, S, g, -103, -30, 12);
    crosswalkX(THREE, S, g, 103, 15, 12);
    crosswalkX(THREE, S, g, -103, 15, 12);
    crosswalkZ(THREE, S, g, 95, -22, 7);
    crosswalkZ(THREE, S, g, -95, 5, 7);
    crosswalkZ(THREE, S, g, 0, -70, 8);
    crosswalkX(THREE, S, g, 70, 0, 8);

    // 3. context buildings (12). All set back >= 3 m from street rights-of-way.
    // E1: brick sawtooth warehouse
    warehouse(THREE, S, g, 116, -52, 22, 20, 7, 101, [122, 62, 44], 'sawtooth', [8, 14], 3);
    stats.buildings++;
    // E2: corner commercial, storefronts
    commercial(THREE, S, g, 77, -14, 16, 8, 8.4, 102, [140, 100, 76], 'HARDWARE');
    stats.buildings++;
    // E3: walk-up apartments
    walkup(THREE, S, g, 116, -14, 22, 8, 10.4, 103, [168, 140, 112], 'flat', 11);
    stats.buildings++;
    // E4: mansard loft offices
    mansardLoft(THREE, S, g, 77, 38, 16, 20, 10.5, 104, [140, 90, 70]);
    stats.buildings++;
    // E5: corner commercial, storefronts
    commercial(THREE, S, g, 116, 34, 22, 12, 11, 105, [150, 110, 88], 'BAKERY');
    stats.buildings++;
    // W1: brick warehouse, flat roof + water tower
    var w1 = warehouse(THREE, S, g, -115.5, -51, 21, 18, 9, 106, [110, 58, 42], 'flat', [7, 14], 0);
    waterTower(THREE, S, w1, -4, 9.14, -3);
    stats.buildings++;
    // W2: 4-story walk-up, set-back top floor
    walkupSetback(THREE, S, g, -77, -14, 16, 8, 107, [130, 95, 70]);
    stats.buildings++;
    // W3: gabled brick warehouse
    warehouse(THREE, S, g, -115, 35, 18, 14, 7.5, 108, [130, 70, 48], 'gable', [9], 0);
    stats.buildings++;
    // W4: walk-up apartments, hipped roof
    walkup(THREE, S, g, -77, 34, 16, 12, 10.5, 109, [150, 110, 88], 'hipped', 8);
    stats.buildings++;
    // N1: L-plan warehouse (main + wing)
    warehouse(THREE, S, g, -67, -112, 26, 16, 9, 110, [118, 60, 42], 'flat', [10, 18], 0);
    warehouse(THREE, S, g, -74, -97.05, 12, 14, 7, 111, [118, 60, 42], 'flat', [6], 0);
    stats.buildings += 2;
    // N2a: apartment row
    walkup(THREE, S, g, 24, -113, 24, 10, 10, 112, [122, 62, 44], 'flat', 12);
    stats.buildings++;
    // N2b: small tan-brick warehouse
    warehouse(THREE, S, g, 66, -111, 20, 14, 6.5, 113, [160, 130, 105], 'flat', null, 0);
    stats.buildings++;

    // 4. green lots + surface parking on the empty blocks
    grassLot(THREE, S, g, 66, 87.65, -64, -39.85, 201,
      [[70, -60], [78, -52], [84, -44], [70, -44]]);
    grassLot(THREE, S, g, -87.65, -66, -64, -39.85, 202,
      [[-70, -60], [-78, -52], [-84, -44], [-70, -44]]);
    grassLot(THREE, S, g, -129, -102.35, -129, -66, 203,
      [[-120, -120], [-110, -100], [-115, -75], [-125, -85]]);
    grassLot(THREE, S, g, 102.35, 129, -129, -66, 204,
      [[110, -120], [120, -100], [115, -75], [125, -85]]);
    stats.trees += 16;
    (function parkingLot() {                             // W block C/r2
      var t = tex(THREE, parkingCanvas());
      t.repeat.set(2, 1);
      box(THREE, g, 24.65, 0.08, 10.3, std(THREE, t, 0.95),
          -115.675, 0.04, -14, false);
      addTree(THREE, S, g, -126.5, -10, 0, 205);
      addTree(THREE, S, g, -104.8, -17.5, 0, 206);
      stats.trees += 2;
    })();

    // 5. street trees on the new sidewalks (skipped near intersections)
    var ti = 300;
    function treeRowX(zc, x0, x1, skipX) {
      for (var x = x0; x <= x1; x += 12) {
        var skip = false;
        for (var k = 0; k < skipX.length; k++) {
          if (Math.abs(x - skipX[k]) < 10) { skip = true; break; }
        }
        if (skip) continue;
        addTree(THREE, S, g, x, zc, 0.47, ti++);
        stats.trees++;
      }
    }
    function treeRowZ(xc, z0, z1, skipZ) {
      for (var z = z0; z <= z1; z += 12) {
        var skip = false;
        for (var k = 0; k < skipZ.length; k++) {
          if (Math.abs(z - skipZ[k]) < 10) { skip = true; break; }
        }
        if (skip) continue;
        addTree(THREE, S, g, xc, z, 0.47, ti++);
        stats.trees++;
      }
    }
    // Michigan Ave (z = -30): sidewalks at z = -37.6 / -22.4
    [-37.6, -22.4].forEach(function (zc) {
      treeRowX(zc, 70, 125, [95]);
      treeRowX(zc, -125, -70, [-95]);
    });
    // Wabash St (z = +15): sidewalks at z = 7.4 / 22.6
    [7.4, 22.6].forEach(function (zc) {
      treeRowX(zc, 70, 125, [95]);
      treeRowX(zc, -125, -70, [-95]);
    });
    // 15th / 14th St avenues: sidewalks at x = c +/- 5.1
    [95, -95].forEach(function (xc) {
      treeRowZ(xc - 5.1, -125, 35, [-30, 15, 0]);
      treeRowZ(xc + 5.1, -125, 35, [-30, 15, 0]);
    });
    // spoke extensions
    treeRowZ(-5.6, -125, -70, []);
    treeRowZ(5.6, -125, -70, []);
    treeRowX(-5.6, 70, 125, [95]);
    treeRowX(5.6, 70, 125, [95]);
    treeRowX(-5.6, -125, -70, [-95]);
    treeRowX(5.6, -125, -70, [-95]);

    // 6. blade signs at four intersections (real Corktown street names)
    bladeSign(THREE, S, g, 101, -38.5, '15th St', 'Michigan Ave');
    bladeSign(THREE, S, g, -101, -38.5, '14th St', 'Michigan Ave');
    bladeSign(THREE, S, g, 101, 7, '15th St', 'Wabash St');
    bladeSign(THREE, S, g, -101, 7, '14th St', 'Brooklyn St');

    g.traverse(function (o) {
      if (o.isMesh) o.receiveShadow = true;
    });
    g.userData.stats = stats;
    return g;
  }

  window.DAADistrictExpansion = { buildDistrictExpansion: buildDistrictExpansion };
})();
