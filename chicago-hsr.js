// Detroit Automation Academy — Chicago HSR concept viaduct (round 3, overnight).
// Extends the proposed intercity viaduct WESTWARD toward Chicago. Local only.
//
// FACTUAL BASIS (read before treating any of this as real): no true
// high-speed rail exists today between Detroit and Chicago. Current service is
// Amtrak's Wolverine — conventional rail, roughly 5.5 hours. Everything in
// this module is an imagined-future concept: every sign is labeled PROPOSED /
// CONCEPT, there are no opening dates anywhere, and no operator is presented
// as real. (arch-kit.js's east viaduct is the same kind of fiction, toward
// Windsor/Toronto.)
//
// Geometry: z=32 from x=18.45 to x=-56, then a minimal 6.5 m jog south to
// z=25.5 (x -56..-68) to clear district-expansion.js masses W4
// (x[-85,-69] z[28,40], 10.5 m + hipped roof) and W3 (x[-124,-106] z[28,42],
// 7.5 m), straight z=25.5 to x=-132, then a return jog north to z=32
// (x -132..-144), straight z=32 to x=-218. Both stations sit 3.4 m south of
// the local centerline at z=28.6, mirroring the east terminus offset; the
// Dearborn concept station was moved from x=-120 to x=-150 so it stands on
// the straight z=32 segment, clear of W3.
//
// PHASE JOINT (east): arch-kit.js is UNTOUCHED — its west bumper bW sits at
// (18.7, 12.55, 32), west face x=18.45, and its deck ends at x=20. This deck
// starts at x=18.45 (first piece has no east overhang, so nothing z-fights
// the bumper or the existing deck). The ~1.5 m gap between this deck's east
// end (18.45) and the existing deck end (20), with the bumper sitting in it,
// reads as a construction phase joint between the built segment and this
// proposed westward extension.
//
// Pylon grid: nominal 14 m spacing from x=11 westward (11, -3, -17, ...).
// Verified against district-expansion.js and the arch-kit riverfront solid
// (deck x[-13,13] z[37,52.6], paving/promenade to z=31): every pylon base
// lands clear — the z=32 pylons at x=11,-3,-17 sit on the flat riverfront
// promenade paving (not a building mass). The jogged deck clears W4's hip
// roof by 1.9 m (analytic, 2026-10-01 audit); pylon caps are narrowed
// (DECK_W+0.6) so no cap overhangs any building plan. West of x=-130 the
// corridor z[24,40] is the reserved band the second builder keeps mass-free.
// No pylon shifts were needed.
//
// Classic IIFE script; exposes window.DAAChicagoHSR. No external assets, no
// network, deterministic. Units meters; x = east, z = south, y = up.
(function () {
  'use strict';

  var PXM = 64; // texture pixels per meter (matches arch-kit / district-expansion)

  function cv(wM, hM) {
    var c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(wM * PXM));
    c.height = Math.max(2, Math.round(hM * PXM));
    return [c, c.getContext('2d')];
  }

  function tex(THREE, canvas) {
    var t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  // Canvas sign painter — same visual language as arch-kit's signTex:
  // near-black plate, accent border, paper title, accent sub-line.
  function signTex(THREE, title, sub, accent, wM, hM) {
    var p = cv(wM || 3.2, hM || 1.1), c = p[0], x2 = p[1];
    x2.fillStyle = '#131313'; x2.fillRect(0, 0, c.width, c.height);
    x2.strokeStyle = accent; x2.lineWidth = Math.max(4, c.height * 0.08);
    x2.strokeRect(4, 4, c.width - 8, c.height - 8);
    x2.fillStyle = '#f2f2f2'; x2.textAlign = 'center'; x2.textBaseline = 'middle';
    var fs = Math.round(c.height * (sub ? 0.34 : 0.44));
    x2.font = 'bold ' + fs + 'px sans-serif';
    while (x2.measureText(title).width > c.width * 0.86 && fs > 8) {
      fs -= 2; x2.font = 'bold ' + fs + 'px sans-serif';
    }
    x2.fillText(title, c.width / 2, sub ? c.height * 0.36 : c.height / 2);
    if (sub) {
      x2.font = Math.round(c.height * 0.2) + 'px sans-serif'; x2.fillStyle = accent;
      x2.fillText(sub, c.width / 2, c.height * 0.72);
    }
    return tex(THREE, c);
  }

  function buildChicagoHSR(THREE) {
    var g = new THREE.Group();
    var signs = [];

    // ---- materials (match arch-kit HSR palette) ----
    var mDeck = new THREE.MeshStandardMaterial({ color: 0x838383, roughness: 0.85 });
    var mRail = new THREE.MeshStandardMaterial({ color: 0xcdcdcd, roughness: 0.3, metalness: 0.85 });
    var mPylon = new THREE.MeshStandardMaterial({ color: 0x9f9f9f, roughness: 0.95 });
    var mConc = new THREE.MeshStandardMaterial({ color: 0x949494, roughness: 0.9 });
    var mCanopy = new THREE.MeshStandardMaterial({ color: 0x272727, roughness: 0.6, metalness: 0.4 });
    var mPole = new THREE.MeshStandardMaterial({ color: 0x3f3f3f, roughness: 0.6, metalness: 0.5 });
    var mPlat = new THREE.MeshStandardMaterial({ color: 0x6f6f6f, roughness: 0.9 });
    var mLamp = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, emissive: 0xbbbbbb, emissiveIntensity: 1.4 });
    var mStripe = new THREE.MeshStandardMaterial({ color: 0xB4B4B4, emissive: 0xB4B4B4, emissiveIntensity: 0.5 });
    var mBumper = new THREE.MeshStandardMaterial({ color: 0x7F7F7F, roughness: 0.7 });
    var mAccent = new THREE.MeshStandardMaterial({ color: 0xbbbbbb, emissive: 0xbbbbbb, emissiveIntensity: 0.55, roughness: 0.5 });
    var mDark = new THREE.MeshStandardMaterial({ color: 0x171717, roughness: 1 });
    var mWood = new THREE.MeshStandardMaterial({ color: 0x707070, roughness: 0.9 });

    function mesh(geo, mat, x, y, z, ry, kind) {
      var m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      if (ry) m.rotation.y = ry;
      if (kind) m.userData.kind = kind;
      m.castShadow = true; m.receiveShadow = true;
      g.add(m);
      return m;
    }

    // ---- alignment: polyline westward from the phase joint ----
    var DECK_Y = 12, DECK_W = 4.2;
    var segs = [
      { ax: 18.45, az: 32,   bx: -56,  bz: 32   },
      { ax: -56,   az: 32,   bx: -68,  bz: 25.5 },  // jog 1: south around W4/W3
      { ax: -68,   az: 25.5, bx: -132, bz: 25.5 },
      { ax: -132,  az: 25.5, bx: -144, bz: 32   },  // jog 2: back to z=32
      { ax: -144,  az: 32,   bx: -218, bz: 32   }
    ];
    var totalLen = 0;
    segs.forEach(function (s) {
      var dx = s.bx - s.ax, dz = s.bz - s.az;
      s.len = Math.hypot(dx, dz);
      s.ang = Math.atan2(dx, dz);
      s.cx = (s.ax + s.bx) / 2; s.cz = (s.az + s.bz) / 2;
      s.d0 = totalLen; totalLen += s.len;
    });
    function pointAt(d) {
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (d <= s.d0 + s.len + 1e-6) {
          var t = Math.min(1, Math.max(0, (d - s.d0) / s.len));
          return { x: s.ax + (s.bx - s.ax) * t, z: s.az + (s.bz - s.az) * t, ang: s.ang };
        }
      }
      var l = segs[segs.length - 1];
      return { x: l.bx, z: l.bz, ang: l.ang };
    }
    // lateral unit vector (perpendicular to travel), for a signed offset
    function lat(ang, off) { return { x: -Math.cos(ang) * off, z: Math.sin(ang) * off }; }

    // ---- deck, rails, fascia, parapets, walkways ----
    segs.forEach(function (s, si) {
      // First piece: no east overhang — east face lands exactly at x=18.45
      // (phase joint; avoids z-fighting the arch-kit bumper / deck).
      var overE = si === 0 ? 0 : 0.175, overW = 0.175;
      var blen = s.len + overE + overW;
      var ex = s.ax - Math.sin(s.ang) * overE, ez = s.az - Math.cos(s.ang) * overE;
      var wx = s.bx + Math.sin(s.ang) * overW, wz = s.bz + Math.cos(s.ang) * overW;
      mesh(new THREE.BoxGeometry(DECK_W, 0.7, blen), mDeck,
        (ex + wx) / 2, DECK_Y - 0.35, (ez + wz) / 2, s.ang, 'deck');
      [-0.8, 0.8].forEach(function (off) {           // twin rails
        var o = lat(s.ang, off);
        mesh(new THREE.BoxGeometry(0.14, 0.14, s.len), mRail,
          s.cx + o.x, DECK_Y + 0.07, s.cz + o.z, s.ang, 'rail');
      });
      [-1, 1].forEach(function (sd) {                // steel-blue edge fascia
        var o = lat(s.ang, sd * (DECK_W / 2 - 0.04));
        mesh(new THREE.BoxGeometry(0.08, 0.5, s.len), mAccent,
          s.cx + o.x, DECK_Y - 0.45, s.cz + o.z, s.ang, 'fascia');
        var p2 = lat(s.ang, sd * (DECK_W / 2 - 0.06)); // parapet wall
        mesh(new THREE.BoxGeometry(0.12, 1.0, s.len), mConc,
          s.cx + p2.x, DECK_Y + 0.5, s.cz + p2.z, s.ang, 'parapet');
        var w2 = lat(s.ang, sd * 1.55);             // maintenance walkway curb
        mesh(new THREE.BoxGeometry(0.5, 0.06, s.len), mPylon,
          s.cx + w2.x, DECK_Y + 0.03, s.cz + w2.z, s.ang, 'walkway');
      });
    });
    for (var ji = 1; ji < segs.length; ji++) {      // joint drums hide miter seams
      mesh(new THREE.CylinderGeometry(DECK_W / 2, DECK_W / 2, 0.7, 20), mDeck,
        segs[ji].ax, DECK_Y - 0.35, segs[ji].az, 0, 'joint');
    }
    // phase-joint cover plate at the east end (visualizes the joint)
    mesh(new THREE.BoxGeometry(0.5, 0.1, DECK_W), mPole, 18.45, DECK_Y + 0.05, 32, 0, 'phase-plate');

    // ---- pylons: nominal 14 m grid from x=11 westward; z follows the deck ----
    function zAt(x) {
      if (x >= -56) return 32;
      if (x >= -68) return 32 + (x + 56) * 0.541667;
      if (x >= -132) return 25.5;
      if (x >= -144) return 25.5 - (x + 132) * 0.541667;
      return 32;
    }
    function angAt(x) {
      if (x >= -56 || x < -144) return -Math.PI / 2;
      if (x >= -68) return Math.atan2(-12, -6.5);
      if (x >= -132) return -Math.PI / 2;
      return Math.atan2(-12, 6.5);
    }
    var pylonCount = 0, pylonShifts = [];
    for (var px = 11; px >= -213; px -= 14) {
      var pz = zAt(px), pa = angAt(px);
      // Nominal grid verified clear of all masses (see header note); no shifts.
      mesh(new THREE.BoxGeometry(1.6, 0.5, 1.6), mConc, px, 0.25, pz, 0, 'pylon-foot');
      mesh(new THREE.BoxGeometry(0.9, 10.8, 0.9), mPylon, px, 5.4 + 0.5, pz, 0, 'pylon-col');
      mesh(new THREE.BoxGeometry(DECK_W + 0.6, 0.5, 1.4), mPylon, px, DECK_Y - 0.95, pz, pa, 'pylon-cap');
      pylonCount++;
    }

    // ---- edge lights: emissive dots on the parapet tops, every ~8 m ----
    for (var ld = 2; ld < totalLen - 1; ld += 8) {
      var lp = pointAt(ld);
      [-1, 1].forEach(function (sd) {
        var o = lat(lp.ang, sd * (DECK_W / 2 - 0.06));
        mesh(new THREE.BoxGeometry(0.16, 0.14, 0.16), mLamp,
          lp.x + o.x, DECK_Y + 1.07, lp.z + o.z, 0, 'edge-light');
      });
    }

    // ---- block signals (dark heads — line is proposed, not commissioned) ----
    [40, 100, 160, 220].forEach(function (sd2) {
      var sp = pointAt(sd2), so = lat(sp.ang, DECK_W / 2 - 0.3);
      mesh(new THREE.BoxGeometry(0.1, 1.6, 0.1), mPole,
        sp.x + so.x, DECK_Y + 0.8, sp.z + so.z, 0, 'signal-post');
      mesh(new THREE.BoxGeometry(0.34, 0.44, 0.22), mDark,
        sp.x + so.x, DECK_Y + 1.75, sp.z + so.z, sp.ang, 'signal-head');
    });

    // ---- west bumper stop (matches arch-kit bumper style) ----
    mesh(new THREE.BoxGeometry(0.5, 1.1, 3.2), mBumper, -217.5, DECK_Y + 0.55, 32, 0, 'bumper');
    mesh(new THREE.BoxGeometry(0.5, 7.5, 0.5), mPole, -218.5, 3.75, 32, 0, 'bumper-post');
    mesh(new THREE.BoxGeometry(0.5, 7.5, 0.5), mPole, -216.5, 3.75, 32, 0, 'bumper-post');

    // ---- west-end extension board, rotated to face west ----
    var extT = signTex(THREE, 'TO CHICAGO', 'PROPOSED EXTENSION \u2190', '#bbbbbb', 4.8, 1.2);
    signs.push({ title: 'TO CHICAGO', sub: 'PROPOSED EXTENSION \u2190' });
    var extM = new THREE.MeshStandardMaterial({ map: extT, roughness: 0.7 });
    var extB = new THREE.Mesh(new THREE.BoxGeometry(4.8, 1.2, 0.12),
      [mPole, mPole, mPole, mPole, extM, extM]);
    extB.position.set(-213, 14.2, 32);
    extB.rotation.y = Math.PI / 2;                  // textured faces point ±x (west/east)
    extB.castShadow = true; extB.receiveShadow = true;
    extB.userData.kind = 'totem-ext';
    g.add(extB);

    // ---- totem board builder (textured both faces, like arch-kit's hboard) ----
    function totem(title, sub, wM, hM, x, y, z, kind) {
      var t = signTex(THREE, title, sub, '#bbbbbb', wM, hM);
      signs.push({ title: title, sub: sub });
      var fm = new THREE.MeshStandardMaterial({ map: t, roughness: 0.7 });
      var b = new THREE.Mesh(new THREE.BoxGeometry(wM, hM, 0.14),
        [mPole, mPole, mPole, mPole, fm, fm]);
      b.position.set(x, y, z);
      b.castShadow = true; b.receiveShadow = true;
      b.userData.kind = kind;
      g.add(b);
      return b;
    }

    function bench(x, z, y0) {
      mesh(new THREE.BoxGeometry(1.8, 0.08, 0.5), mWood, x, y0 + 0.45, z, 0, 'bench');
      mesh(new THREE.BoxGeometry(0.08, 0.45, 0.5), mPole, x - 0.8, y0 + 0.225, z, 0, 'bench');
      mesh(new THREE.BoxGeometry(0.08, 0.45, 0.5), mPole, x + 0.8, y0 + 0.225, z, 0, 'bench');
      mesh(new THREE.BoxGeometry(1.8, 0.5, 0.08), mWood, x, y0 + 0.75, z - 0.25, 0, 'bench');
    }

    // ---- Dearborn concept station (x=-150, z=28.6, south of the viaduct) ----
    (function dearborn() {
      var sx = -150, sz = 28.6, py = DECK_Y;        // platform top = deck top
      mesh(new THREE.BoxGeometry(8, 0.25, 2.0), mPlat, sx, py - 0.125, sz, 0, 'platform');
      mesh(new THREE.BoxGeometry(8, 0.03, 0.14), mStripe, sx, py + 0.015, sz + 0.82, 0, 'stripe');
      [-3.6, -1.2, 1.2, 3.6].forEach(function (ox) {
        mesh(new THREE.BoxGeometry(0.14, 2.6, 0.14), mPole, sx + ox, py + 1.3, sz, 0, 'canopy-col');
      });
      mesh(new THREE.BoxGeometry(8.8, 0.14, 2.8), mCanopy, sx, py + 2.75, sz, 0, 'canopy');
      mesh(new THREE.BoxGeometry(8, 0.05, 0.12), mLamp, sx, py + 2.66, sz, 0, 'canopy-light');
      totem('DEARBORN', 'PROPOSED \u00B7 CONCEPT STATION', 3.2, 1.1, sx, py + 4.0, sz, 'totem-dearborn');
      mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.0, 8), mPole, sx, py + 3.2, sz, 0, 'totem-mast');
      bench(sx - 2, sz - 0.4, py);
      bench(sx + 2, sz - 0.4, py);
      bench(sx - 2, sz + 0.45, py);
      bench(sx + 2, sz + 0.45, py);
    })();

    // ---- Grand western terminus: CHICAGO (x=-200, z=28.6) ----
    // Taller and grander than the east terminus: 16 m platform, 6 columns,
    // deeper canopy with steel-blue fascia, 6.4 m totem on twin masts.
    (function chicago() {
      var sx = -200, sz = 28.6, py = DECK_Y;
      mesh(new THREE.BoxGeometry(16, 0.25, 2.2), mPlat, sx, py - 0.125, sz, 0, 'platform');
      mesh(new THREE.BoxGeometry(16, 0.03, 0.14), mStripe, sx, py + 0.015, sz + 0.92, 0, 'stripe');
      for (var i = 0; i < 6; i++) {
        mesh(new THREE.BoxGeometry(0.16, 3.6, 0.16), mPole, sx - 6.75 + i * 2.7, py + 1.8, sz, 0, 'canopy-col');
      }
      mesh(new THREE.BoxGeometry(17, 0.16, 3.6), mCanopy, sx, py + 3.68, sz, 0, 'canopy');
      mesh(new THREE.BoxGeometry(17.1, 0.3, 0.12), mAccent, sx, py + 3.45, sz + 1.8, 0, 'fascia');
      mesh(new THREE.BoxGeometry(17.1, 0.3, 0.12), mAccent, sx, py + 3.45, sz - 1.8, 0, 'fascia');
      mesh(new THREE.BoxGeometry(16, 0.05, 0.14),
        new THREE.MeshStandardMaterial({ color: 0xe8e8e8, emissive: 0xbbbbbb, emissiveIntensity: 1.0 }),
        sx, py + 3.58, sz, 0, 'canopy-light');
      totem('CHICAGO', 'PROPOSED \u00B7 DETROIT \u2014 CHICAGO \u00B7 CONCEPT',
        6.4, 1.6, sx, py + 5.6, sz, 'totem-chicago');
      mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.2, 8), mPole, sx - 2.5, py + 4.6, sz, 0, 'totem-mast');
      mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.2, 8), mPole, sx + 2.5, py + 4.6, sz, 0, 'totem-mast');
      for (var b2 = 0; b2 < 5; b2++) bench(sx - 6 + b2 * 3, sz - 0.5, py);
      // hanging platform boards under the canopy (face the platform)
      [-4, 4].forEach(function (ox) {
        var ht = signTex(THREE, 'CHICAGO', 'PROPOSED \u00B7 CONCEPT', '#bbbbbb', 2.4, 0.8);
        signs.push({ title: 'CHICAGO', sub: 'PROPOSED \u00B7 CONCEPT' });
        var hm = new THREE.MeshStandardMaterial({ map: ht, roughness: 0.7 });
        var hb = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.8, 0.08),
          [mPole, mPole, mPole, mPole, hm, hm]);
        hb.position.set(sx + ox, py + 2.9, sz + 0.9);
        hb.rotation.y = Math.PI;
        hb.castShadow = true; hb.receiveShadow = true;
        hb.userData.kind = 'hanging-board';
        g.add(hb);
        mesh(new THREE.BoxGeometry(0.05, 0.7, 0.05), mPole, sx + ox - 1.0, py + 3.55, sz + 0.9, 0, 'hanger');
        mesh(new THREE.BoxGeometry(0.05, 0.7, 0.05), mPole, sx + ox + 1.0, py + 3.55, sz + 0.9, 0, 'hanger');
      });
    })();

    var meshCount = 0;
    g.traverse(function (o) { if (o.isMesh) meshCount++; });
    g.userData.stats = {
      module: 'chicago-hsr',
      deckLengthM: Math.round(totalLen * 100) / 100,
      deckTopY: DECK_Y,
      corridor: 'z=32 x[18.45,-56] -> jog z=25.5 x[-68,-132] -> z=32 x[-144,-218]',
      pylons: pylonCount,
      pylonShifts: pylonShifts,
      stations: [
        { name: 'DEARBORN', x: -150, z: 28.6, note: 'concept station' },
        { name: 'CHICAGO', x: -200, z: 28.6, note: 'grand western terminus' }
      ],
      signs: signs,
      meshes: meshCount
    };
    return g;
  }

  window.DAAChicagoHSR = { buildChicagoHSR: buildChicagoHSR };
})();
