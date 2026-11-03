// Detroit Automation Academy — riverfront promenade + pocket-park detailing.
// Boardwalk on piles over the water edge, shore connectors, promenade
// furnishing, a RIVERFRONT blade sign, and detailing for the Corktown pocket
// park (the 32x16 m park built by arch-kit buildCorktown at world (44,14)).
// Classic script, no imports; exposes window.DAAPromenade.
// Units meters; three.js x = east, z = south, y = up.
// Facts-first: the sundial below is a decorative garden ornament, not a
// calibrated timepiece; no historical claims are made about it.
(function () {
  'use strict';

  var PXM = 64; // texture pixels per meter

  // Deterministic PRNG so painted textures are stable across loads.
  function mulberry32(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shade(rgb, f) {
    var r = Math.max(0, Math.min(255, Math.round(rgb[0] * f)));
    var g = Math.max(0, Math.min(255, Math.round(rgb[1] * f)));
    var b = Math.max(0, Math.min(255, Math.round(rgb[2] * f)));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function cv(wM, hM) {
    var c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(wM * PXM));
    c.height = Math.max(2, Math.round(hM * PXM));
    return [c, c.getContext('2d')];
  }

  function tex(THREE, canvas) {
    var t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  }

  // Boardwalk planks: tile covers 4.48 m (32 planks at 0.14 m) by 4.5 m.
  // Planks run along the canvas y axis (the boardwalk z direction).
  function plankCanvas() {
    var p = cv(4.48, 4.5), c = p[0], x = p[1], W = c.width, H = c.height;
    var R = mulberry32(9001);
    var n = 32, pw = W / n, i, px;
    x.fillStyle = '#494949';
    x.fillRect(0, 0, W, H);
    for (i = 0; i < n; i++) {
      px = i * pw;
      x.fillStyle = shade([138, 106, 72], 0.82 + R() * 0.34);
      x.fillRect(px + 1, 0, pw - 2, H);
      // grain streaks
      x.fillStyle = 'rgba(44,44,44,0.25)';
      var g2;
      for (g2 = 0; g2 < 4; g2++) {
        var gx = px + 2 + R() * (pw - 4);
        x.fillRect(gx, 0, 1, H);
      }
      // plank gaps
      x.fillStyle = 'rgba(14,14,14,0.85)';
      x.fillRect(px, 0, 2, H);
      // nail dots near both ends
      x.fillStyle = 'rgba(30,30,30,0.9)';
      x.beginPath(); x.arc(px + pw / 2, 8, 2, 0, Math.PI * 2); x.fill();
      x.beginPath(); x.arc(px + pw / 2, H - 8, 2, 0, Math.PI * 2); x.fill();
    }
    return c;
  }

  // Pavers: 2 m x 2 m tile, 0.5 m pavers with joints.
  function paverCanvas() {
    var p = cv(2, 2), c = p[0], x = p[1], W = c.width, H = c.height;
    var R = mulberry32(9002);
    var base = [168, 160, 146], jw = 0.5 * PXM, jx, jy;
    x.fillStyle = shade(base, 0.55);
    x.fillRect(0, 0, W, H);
    for (jx = 0; jx < W; jx += jw) {
      for (jy = 0; jy < H; jy += jw) {
        x.fillStyle = shade(base, 0.86 + R() * 0.28);
        x.fillRect(jx + 2, jy + 2, jw - 4, jw - 4);
      }
    }
    return c;
  }

  // Ashlar stone: 1.5 m x 1.5 m tile, staggered courses.
  function stoneCanvas() {
    var p = cv(1.5, 1.5), c = p[0], x = p[1], W = c.width, H = c.height;
    var R = mulberry32(9003);
    var base = [150, 144, 132], ch = 0.375 * PXM, row, bx;
    x.fillStyle = shade(base, 0.5);
    x.fillRect(0, 0, W, H);
    for (row = 0; row * ch < H; row++) {
      var off = (row % 2) * 0.375 * PXM;
      for (bx = -1; bx * 0.75 * PXM < W + 0.75 * PXM; bx++) {
        var sx = bx * 0.75 * PXM + off, sy = row * ch;
        x.fillStyle = shade(base, 0.88 + R() * 0.24);
        x.fillRect(sx + 2, sy + 2, 0.75 * PXM - 4, ch - 4);
      }
    }
    return c;
  }

  // Painted blade-sign face. Minimal text, kept legible.
  function signCanvas(text) {
    var p = cv(3.2, 0.9), c = p[0], x = p[1], W = c.width, H = c.height;
    x.fillStyle = '#171717';
    x.fillRect(0, 0, W, H);
    x.strokeStyle = '#B4B4B4';
    x.lineWidth = Math.max(3, H * 0.06);
    x.strokeRect(6, 6, W - 12, H - 12);
    x.fillStyle = '#f2f2f2';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    var fs = Math.round(H * 0.44);
    x.font = 'bold ' + fs + 'px sans-serif';
    while (x.measureText(text).width > W * 0.86 && fs > 8) {
      fs -= 2;
      x.font = 'bold ' + fs + 'px sans-serif';
    }
    x.fillText(text, W / 2, H / 2);
    return c;
  }

  function buildPromenade(THREE) {
    var g = new THREE.Group();
    var anchors = [];
    function anchor(type, x, z) { anchors.push({ type: type, x: x, z: z }); }

    var plankTex = tex(THREE, plankCanvas());
    var paverTex = tex(THREE, paverCanvas());
    var stoneTex = tex(THREE, stoneCanvas());
    var signTex = tex(THREE, signCanvas('RIVERFRONT'));

    var mSteel = new THREE.MeshStandardMaterial({ color: 0x2e2e2e, roughness: 0.6, metalness: 0.5 });
    var mPile = new THREE.MeshStandardMaterial({ color: 0x3d3d3d, roughness: 1 });
    var mDeckSide = new THREE.MeshStandardMaterial({ color: 0x3d3d3d, roughness: 0.95 });
    var mDeckDark = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 1 });
    var mStone = new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 0.95 });
    var mStonePlain = new THREE.MeshStandardMaterial({ color: 0x909090, roughness: 0.95 });
    var mConc = new THREE.MeshStandardMaterial({ color: 0x9f9f9f, roughness: 0.95 });
    var mWood = new THREE.MeshStandardMaterial({ color: 0x707070, roughness: 0.9 });
    var mTrunk = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 1 });
    var mGlobe = new THREE.MeshStandardMaterial({
      color: 0xf2f2f2, emissive: 0xdbdbdb, emissiveIntensity: 0.9, roughness: 0.35
    });
    var mBand = new THREE.MeshStandardMaterial({
      color: 0xd8d8d8, emissive: 0xbbbbbb, emissiveIntensity: 0.5, roughness: 0.3, metalness: 0.2
    });
    var mRingEdge = new THREE.MeshStandardMaterial({ color: 0x3d3d3d, roughness: 0.9 });
    var leafGreens = [0x646464, 0x707070, 0x535353, 0x7f7f7f].map(function (cc) {
      return new THREE.MeshStandardMaterial({ color: cc, roughness: 1 });
    });

    function paverMat(rx, rz) {
      var t = paverTex.clone();
      t.needsUpdate = true;
      t.repeat.set(rx, rz);
      return new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 });
    }
    function stoneMat(rx) {
      var t = stoneTex.clone();
      t.needsUpdate = true;
      t.repeat.set(rx, 1);
      return new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 });
    }
    function plankMat(lenM) {
      var t = plankTex.clone();
      t.needsUpdate = true;
      t.repeat.set(Math.max(1, Math.round(lenM / 4.48)), 1);
      return new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 });
    }

    function mesh(geo, mat, x, y, z, parent) {
      var m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      (parent || g).add(m);
      return m;
    }

    // ================= 1. Boardwalk over the water edge =================
    // Deck z[54,58.5], top y=0.5. Two segments with a clean 9 m gap at
    // x[-4.5,4.5] for the S-spoke road corridor (x +/-4 with curbs).
    var DECK_TOP = 0.5, DZ0 = 54, DZ1 = 58.5, GAP = 4.5;
    var DCZ = (DZ0 + DZ1) / 2, DD = DZ1 - DZ0; // 56.25, 4.5
    var deckSegs = [[-65, -GAP], [GAP, 65]];

    deckSegs.forEach(function (sg, si) {
      var x0 = sg[0], x1 = sg[1], len = x1 - x0, cx = (x0 + x1) / 2;
      var mPlank = plankMat(len);
      var deck = new THREE.Mesh(
        new THREE.BoxGeometry(len, 0.4, DD),
        [mDeckSide, mDeckSide, mPlank, mDeckDark, mDeckSide, mDeckSide]
      );
      deck.position.set(cx, DECK_TOP - 0.2, DCZ); // top y = 0.5
      deck.userData.part = 'deck';
      g.add(deck);
      // rim joist on the gap-facing end; bollards mount on it
      var ex = si === 0 ? x1 : x0;
      mesh(new THREE.BoxGeometry(0.3, 0.42, DD), mDeckSide, ex, DECK_TOP - 0.21, DCZ)
        .userData.part = 'rim';
      // longitudinal stringers under the deck
      [DZ0 + 0.55, DZ1 - 0.55].forEach(function (sz) {
        mesh(new THREE.BoxGeometry(len, 0.3, 0.25), mPile, cx, DECK_TOP - 0.55, sz)
          .userData.part = 'stringer';
      });
    });

    // Pile bents every 4 m: two piles + a cap beam, driven into the water.
    // Water surface is at y=0; piles run from y=-2.5 up under the deck.
    var bentX;
    for (bentX = -64; bentX <= 64; bentX += 4) {
      if (Math.abs(bentX) < GAP + 1) continue; // keep the road gap clean
      [DZ0 + 0.6, DZ1 - 0.6].forEach(function (pz) {
        var pile = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 2.95, 10), mPile);
        pile.position.set(bentX, -1.025, pz); // spans y -2.5 .. 0.45
        pile.userData.part = 'pile';
        g.add(pile);
      });
      var cap = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.35, DD - 0.6), mPile);
      cap.position.set(bentX, -0.05, DCZ);
      cap.userData.part = 'bentcap';
      g.add(cap);
    }

    // Railing along the south (water) edge z=58.2: posts every 2 m,
    // two horizontal rails, 1.1 m tall, dark steel.
    deckSegs.forEach(function (sg) {
      var x0 = sg[0] + 0.4, x1 = sg[1] - 0.4, len = x1 - x0;
      var n = Math.max(2, Math.round(len / 2));
      var i;
      // Railing posts: leave a gap where the two wooden docks (groundwork,
      // x=-40 and x=45, deck y 0.87..0.93) cross the boardwalk line, so the
      // posts don't pierce the dock deck planks.
      var DOCK_XS = [-40, 45];
      for (i = 0; i <= n; i++) {
        var px = x0 + (len * i) / n;
        if (DOCK_XS.some(function (dx) { return Math.abs(px - dx) < 1.6; })) continue;
        mesh(new THREE.BoxGeometry(0.08, 1.1, 0.08), mSteel, px, DECK_TOP + 0.55, DZ1 - 0.3)
          .userData.part = 'railpost';
      }
      [DECK_TOP + 1.1, DECK_TOP + 0.6].forEach(function (ry) {
        mesh(new THREE.BoxGeometry(len, 0.09, 0.07), mSteel, (x0 + x1) / 2, ry, DZ1 - 0.3)
          .userData.part = 'rail';
      });
    });

    // ============ 2. Shore connector paths (pavers, top y=0.37) ============
    // Stubs at x=-30 / x=+30 from the shore to the boardwalk north edge,
    // plus wrap-around paths east/west of the pavilion footprint.
    function connector(cx, z0, z1, w) {
      var len = z1 - z0;
      var m = mesh(new THREE.BoxGeometry(w, 0.12, len),
        paverMat(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(len / 2))),
        cx, 0.31, (z0 + z1) / 2); // top y = 0.37
      m.userData.part = 'connector';
      anchor('connector', cx, (z0 + z1) / 2);
    }
    connector(-30, 50.5, 54.6, 2);
    connector(30, 50.5, 54.6, 2);
    // wraps at x=+-18.5 (1.8 m wide): clear of the pavilion footprint
    // (x<=17), the shore trees at x=+-20 (trunk radius ~0.26 m), and the
    // guideway south leg (ends at x=17.5, deck is elevated at y=7.5).
    // North ends stop at z=28, just south of the elevated guideway.
    connector(-18.5, 28, 54.6, 1.8);
    connector(18.5, 28, 54.6, 1.8);

    // ================= 3. Promenade furnishing =================
    // (All positions are new: furniture.js covers the plaza, the cobra-head
    //  lamp spots, and its own tree/bench/planter/bollard rows.)

    // 6 benches on the boardwalk facing the river (+z).
    function bench(x, y0, z, ry) {
      var b = new THREE.Group();
      var seat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 0.5), mWood);
      seat.position.y = 0.45; b.add(seat);
      var back = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 0.07), mWood);
      back.position.set(0, 0.75, -0.25); b.add(back);
      [-0.8, 0.8].forEach(function (lx) {
        var leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.85, 0.5), mSteel);
        leg.position.set(lx, 0.025, 0); b.add(leg);
      });
      b.position.set(x, y0, z);
      b.rotation.y = ry;
      b.userData.part = 'bench';
      g.add(b);
      anchor('bench', x, z);
      return b;
    }
    // (the -42 slot is moved to -44: the west dock at x=-40 crosses the
    // boardwalk here and its deck (y 0.87..0.93) grazes a bench at -42)
    [-55, -44, -20, 20, 42, 55].forEach(function (bx) {
      bench(bx, DECK_TOP, 56.3, 0); // back on the -z side: faces the water
    });

    // 8 riverside trees in square planters along the shore.
    function planterTree(x, z, seed) {
      var p = new THREE.Group();
      var box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 1.2), mConc);
      box.position.y = 0.3; p.add(box);
      var trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 1.6, 8), mTrunk);
      trunk.position.y = 1.4; p.add(trunk);
      var lm = leafGreens[seed % leafGreens.length];
      [[0, 2.8, 0, 1.1], [0.5, 2.3, 0.2, 0.8], [-0.45, 2.4, -0.15, 0.75]].forEach(function (cb) {
        var m = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), lm);
        m.scale.setScalar(cb[3]);
        m.position.set(cb[0], cb[1], cb[2]);
        p.add(m);
      });
      p.rotation.y = (seed * 2.3) % (Math.PI * 2);
      p.position.set(x, 0, z);
      p.userData.part = 'plantertree';
      g.add(p);
      anchor('plantertree', x, z);
    }
    [-58, -50, -44, -22, 22, 44, 50, 58].forEach(function (tx, i) {
      planterTree(tx, 51.8, i + 3);
    });

    // 5 promenade lamps, 4.5 m class, simpler than the cobra-heads:
    // straight pole, glowing globe, cap.
    function promLamp(x, z) {
      var l = new THREE.Group();
      var base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.15, 10), mConc);
      base.position.y = 0.075; l.add(base);
      var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 4.1, 10), mSteel);
      pole.position.y = 2.2; l.add(pole); // spans y 0.15..4.25
      var globe = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), mGlobe);
      globe.position.y = 4.45; l.add(globe);
      var cap = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.22, 10), mSteel);
      cap.position.y = 4.72; l.add(cap);
      l.position.set(x, 0, z);
      l.userData.part = 'lamp';
      g.add(l);
      anchor('lamp', x, z);
    }
    // x=-6 sits just west of the S-spoke road (x +/-4): the lamp is pushed
    // to z=53.4 so its cap (r=0.3) clears the pavilion face (z<=52.6, measured
    // to 0.1 m) by 0.5 m; it stands at the shoreline on the painted water
    // edge, clear of the boardwalk (z>=54).
    [[-48, 52.2], [-24, 52.2], [-6, 53.4], [24, 52.2], [48, 52.2]].forEach(function (lp) {
      promLamp(lp[0], lp[1]);
    });

    // 10 bollards with a reflective band along the boardwalk gap edges,
    // mounted on the rim joists at x=+-4.5.
    function bollard(x, z, y0) {
      var b = new THREE.Group();
      var post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.95, 10), mSteel);
      post.position.y = 0.475; b.add(post);
      var band = new THREE.Mesh(new THREE.CylinderGeometry(0.098, 0.098, 0.12, 10), mBand);
      band.position.y = 0.7; b.add(band);
      var cap = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), mSteel);
      cap.position.y = 0.95; b.add(cap);
      b.position.set(x, y0, z);
      b.userData.part = 'bollard';
      g.add(b);
      anchor('bollard', x, z);
    }
    [-4.5, 4.5].forEach(function (bx) {
      [54.5, 55.5, 56.5, 57.5, 58.3].forEach(function (bz) {
        bollard(bx, bz, DECK_TOP);
      });
    });

    // ================= 4. RIVERFRONT blade sign =================
    // Two posts + a double-faced painted panel near the x=-30 connector.
    (function bladeSign() {
      var sx = -33, sz = 51.5;
      [-1.2, 1.2].forEach(function (off) {
        var post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.8, 0.14), mSteel);
        post.position.set(sx + off, 1.4, sz);
        post.userData.part = 'signpost';
        g.add(post);
        var foot = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.18, 0.4), mConc);
        foot.position.set(sx + off, 0.09, sz);
        g.add(foot);
      });
      var mSign = new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.6 });
      [-0.035, 0.035].forEach(function (off, i) {
        var face = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.9), mSign);
        face.position.set(sx, 2.25, sz + off);
        if (i === 0) face.rotation.y = Math.PI;
        face.userData.part = 'signface';
        g.add(face);
      });
      var backer = new THREE.Mesh(new THREE.BoxGeometry(3.24, 0.94, 0.05), mSteel);
      backer.position.set(sx, 2.25, sz);
      g.add(backer);
      anchor('sign', sx, sz);
    })();

    // ================= 5. Pocket-park detailing =================
    // The arch-kit pocket park occupies x[28,60], z[6,22] (center (44,14)):
    // lawn, an EW/NS path cross, two tree rows (z=8 and z=20), four benches
    // around the center, and a CORKTOWN sign at (30,7.2). Everything below
    // is placed to clear those, the guideway east leg (x=22.5, z -8..22),
    // and the rowhouse walls (z -45..-35).
    var park = new THREE.Group();
    var PX = 44, PZ = 14; // park center

    // Looping paver path: flat elliptical ring around the center.
    // Benches in the existing park sit at radius ~4.3 m; the ring runs at
    // rx 5.6..7.2 m so it clears them.
    (function loopPath() {
      var RZ = 0.72; // z squash: rz = rx * 0.72
      var edge = new THREE.Mesh(new THREE.RingGeometry(5.45, 7.35, 72), mRingEdge);
      edge.geometry.rotateX(-Math.PI / 2);
      edge.scale.set(1, 1, RZ);
      edge.position.set(PX, 0.148, PZ);
      edge.userData.part = 'pathring';
      park.add(edge);
      var t = paverTex.clone();
      t.needsUpdate = true;
      t.repeat.set(6, 6);
      var ring = new THREE.Mesh(new THREE.RingGeometry(5.6, 7.2, 72),
        new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 }));
      ring.geometry.rotateX(-Math.PI / 2);
      ring.scale.set(1, 1, RZ);
      ring.position.set(PX, 0.158, PZ);
      ring.userData.part = 'pathring';
      park.add(ring);
    })();

    // Central feature: a simple stone sundial plinth. Decorative garden
    // ornament — the dial is not calibrated and tells no accurate time.
    (function sundial() {
      var sx = PX, sz = PZ, baseY = 0.14; // sits on the path cross
      var plinth = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 1.0), stoneMat(1));
      plinth.position.set(sx, baseY + 0.5, sz);
      park.add(plinth);
      var slab = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 1.2), mStonePlain);
      slab.position.set(sx, baseY + 1.05, sz);
      park.add(slab);
      var dial = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 24), mStonePlain);
      dial.position.set(sx, baseY + 1.13, sz);
      park.add(dial);
      // gnomon: a simple tilted blade, angled for looks only
      var gnomon = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.55, 0.5), mSteel);
      gnomon.position.set(sx, baseY + 1.4, sz - 0.08);
      gnomon.rotation.x = -0.73;
      park.add(gnomon);
      anchor('sundial', sx, sz);
    })();

    // 4 planting beds with low shrubs (icosahedron blobs, varied greens).
    var R2 = mulberry32(4242);
    [[36, 10], [52, 10], [36, 18], [52, 18]].forEach(function (bp, bi) {
      var bed = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.35, 1.8), mStone);
      bed.position.set(bp[0], 0.12 + 0.175, bp[1]); // on the lawn (top 0.12)
      bed.userData.part = 'bed';
      park.add(bed);
      var k;
      for (k = 0; k < 4; k++) {
        var s = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1),
          leafGreens[(bi + k) % leafGreens.length]);
        var sr = 0.3 + R2() * 0.18;
        s.scale.set(sr, sr * 0.8, sr);
        s.position.set(
          bp[0] + (R2() - 0.5) * 1.6,
          0.47 + sr * 0.55,
          bp[1] + (R2() - 0.5) * 1.1
        );
        park.add(s);
      }
      anchor('bed', bp[0], bp[1]);
    });

    // Perimeter low stone wall (0.45 m) with two entry gaps aligned to the
    // existing east-west path (z[13,15]) on the west and east sides.
    (function parkWall() {
      var H = 0.45, T = 0.3, y = 0.12 + H / 2;
      function run(x0, x1, z0, z1) {
        var w = Math.max(x1 - x0, T), d = Math.max(z1 - z0, T);
        var m = new THREE.Mesh(new THREE.BoxGeometry(w, H, d), stoneMat(Math.max(1, Math.round(Math.max(w, d) / 1.5))));
        m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
        m.userData.part = 'parkwall';
        park.add(m);
      }
      run(28, 60, 5.85, 6.15);   // north
      run(28, 60, 21.85, 22.15); // south
      run(27.85, 28.15, 6, 13);  // west, north of gap
      run(27.85, 28.15, 15, 22); // west, south of gap
      run(59.85, 60.15, 6, 13);  // east, north of gap
      run(59.85, 60.15, 15, 22); // east, south of gap
    })();

    // 3 park benches facing the sundial; 2 park lamps.
    bench(44, 0.12, 20.8, Math.PI);
    bench(35.5, 0.12, 14, Math.PI / 2);
    bench(52.5, 0.12, 14, -Math.PI / 2);
    // park lamps reuse the promenade lamp builder, mounted on the lawn
    (function parkLamps() {
      [[33, 11.5], [55, 16.5]].forEach(function (lp) {
        var l = new THREE.Group();
        var base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.15, 10), mConc);
        base.position.y = 0.075; l.add(base);
        var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 4.1, 10), mSteel);
        pole.position.y = 2.2; l.add(pole);
        var globe = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), mGlobe);
        globe.position.y = 4.45; l.add(globe);
        var cap = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.22, 10), mSteel);
        cap.position.y = 4.72; l.add(cap);
        l.position.set(lp[0], 0.12, lp[1]);
        l.userData.part = 'parklamp';
        park.add(l);
        anchor('lamp', lp[0], lp[1]);
      });
    })();
    g.add(park);

    g.traverse(function (o) {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    g.userData.anchors = anchors;
    return g;
  }

  window.DAAPromenade = { buildPromenade: buildPromenade };
})();
