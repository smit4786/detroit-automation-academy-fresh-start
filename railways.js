// Detroit Automation Academy — railways: audit, connections, expansion (round 3, overnight).
// Classic IIFE; exposes window.DAARailways.buildRailways(THREE).
// No external assets, no network, deterministic. Units meters; x = east, z = south, y = up.
//
// ============ STEP 1 — RAIL AUDIT (existing network, read from arch-kit.js / chicago-hsr.js) ============
// S1  Forge Line C-loop (arch-kit buildGuideway): polyline
//     [[22.5,-8],[22.5,22],[17.5,27],[-20.6,27],[-25.6,22],[-25.6,-50.5],[-23.0,-56.5],
//      [17.5,-56.5],[22.5,-56.5]], deck 7.5 m, width 3.4, twin rails, pylons ~12 m,
//     amber edge lights. Bumpers: north bar+poles at (22.5,-6.2); SE bar at (24.3,-56.5).
//     Stations: THINKABIT LAB (-23.35,3), UM INNOVATION (-23.35,-30), RIVERFRONT (0,24.1),
//     ACADEMY HQ (19.6,0, sub 'Interchange'). Forge Pod (static) sits on the east-leg
//     deck at (22.5,7.64,10) — verified on-deck (deck top 7.5).
//     DEAD ENDS: north end (22.5,-8) and SE end (22.5,-56.5) — both raw bumpers-to-nowhere.
// S2  Amtrak/Windsor-Toronto viaduct stub (arch-kit): x[20,64] at z=32, deck 12 m,
//     width 4.2, steel-blue, PROPOSED. Bumpers: east (65.3,12.55,32), west (18.7,12.55,32).
//     Terminus platform+canopy at (30,28.6) signed 'AMTRAK INTERCITY /
//     PROPOSED - DETROIT - WINDSOR - TORONTO'; east board 'TO AMTRAK NETWORK /
//     PROPOSED EXTENSION ->' at (62,32).
//     DEAD END: east bumper at x=65.3 (bumper-to-nowhere, signed as proposed extension).
// S3  Chicago HSR extension (chicago-hsr.js): z=32 x[18.45,-56], jog to z=25.5
//     x[-68,-132], back to z=32 x[-144,-218]; deck 12 m. Stations: DEARBORN concept
//     (-150,28.6), CHICAGO grand terminus (-200,28.6). West bumper (-217.5,32).
//     East end abuts S2 via a phase joint: S2 west bumper (18.7,12.55,32, faces
//     x[18.45,18.95]) sits in the 1.375 m gap between S2 deck end (19.825) and the
//     S3 deck east face (18.45); S3 added a cover plate at (18.45,12.05,32).
//     VERIFIED continuous corridor — this module adds only a small 'PHASE JOINT /
//     PROPOSED - P1 - P2' board on the bumper (B1).
//     DEAD END: none unhandled — west end is a proper terminus (Chicago).
// UNREACHABLE: the whole intercity network (S2+S3) is unreachable from the local
//     Forge Line — no transfer exists. Fixed by the PROPOSED Intercity Transfer
//     hub (section B).
// HERITAGE LOOP: forge-line.html reserves an at-grade heritage loop as Phase 2 —
//     no geometry in the 3D scene; out of scope, left deferred per the morning report.
//
// ============ STEP 2 — CONNECTIONS (design decisions) ============
// C-loop closure: closing the C eastward along x=22.5 is BLOCKED by true UMCI
// solids (upper floor slabs lean +x to x=22.9/24/25.3 at deck height across
// z[-53,-23]); routing east around UMCI is BLOCKED by Academy HQ (x[30,64],
// z[-32,-8], 14 m) and the rowhouses (x[27.5,61], z[-45,-35], ~10 m). So per the
// task's OR-branch: both C ends terminate properly at an expanded
// ACADEMY HQ INTERCHANGE — full terminus stations (platform/canopy/totem/yellow
// stripe/bench) wrap the existing bumpers at (22.5,-8) [north] and (22.5,-56.5)
// [south]; no raw dead-end remains.
// Intercity tie-in: a PROPOSED steel-blue transfer spur (deck 12, twin rails)
// leaves the viaduct's south edge at (28,29.9), runs south at x=28 clear of the
// Forge east leg (gap 2.3 m plan), and terminates on the roof of a new transfer
// hall at (30,-4.5) — proper terminus with bumper + totem. The hall's three
// levels (ground lobby / Forge Line concourse at 7.5 / intercity concourse at 12)
// connect via elevator + stair tower; a bridge at deck 7.5 links the hall to the
// north terminus platform. Intercity <-> local is now reachable.
//
// ============ STEP 3 — EXPANSION (all inside |x|<=130, z>=-65) ============
// L1  MICHIGAN AVE LINE (Forge Line identity, deck 7.5): junctions the Forge west
//     leg at (-25.6,-30) beside UM INNOVATION station, runs west above Michigan Ave
//     (z=-30) to (-128,-30). Stations: MICHIGAN AVE - 14TH ST (-94,-33.6),
//     MICHIGAN AVE West Terminus (-120,-33.6). West end: bumper + terminus.
// L2  14TH ST LINE (Forge Line identity, deck 7.5): junctions L1 at (-94,-30),
//     runs north at x=-94 to (-94,38), passing UNDER the HSR deck at z=25.5
//     (7.5 < 11.3 clear). Stations: WABASH - 14TH ST (-90.4,15), NORTHSIDE
//     terminus (-90.4,33). North end: bumper + terminus.
// L3  RIVERFRONT SPUR (Forge Line identity, deck 7.5): junctions the Forge north
//     leg at (-20.6,27), runs north at x=-20.6 under the HSR deck at z=32 to
//     (-20.6,44). Station: RIVERFRONT PAVILION North Terminus (-23.4,41).
//     (Terminus pulled back from z=48 to clear the furniture.js promenade tree row.)
// Copy rules: Forge Line = operating local line (established convention). Every
// intercity sign carries PROPOSED/CONCEPT; no opening dates; no operator names
// presented as real. Station names use real Corktown street names already present
// in district-expansion.js blade signs (Michigan Ave, 14th St, Wabash St).
(function () {
  'use strict';

  var PXM = 64; // texture px per meter (matches arch-kit / district-expansion)

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

  function buildRailways(THREE) {
    var g = new THREE.Group();
    var signs = [];

    // ---- materials (match arch-kit palette) ----
    var mDeck = new THREE.MeshStandardMaterial({ color: 0x949494, roughness: 0.9 });
    var mDeckHSR = new THREE.MeshStandardMaterial({ color: 0x838383, roughness: 0.85 });
    var mRail = new THREE.MeshStandardMaterial({ color: 0xcdcdcd, roughness: 0.3, metalness: 0.85 });
    var mPylon = new THREE.MeshStandardMaterial({ color: 0x9f9f9f, roughness: 0.95 });
    var mConc = new THREE.MeshStandardMaterial({ color: 0x949494, roughness: 0.9 });
    var mCanopy = new THREE.MeshStandardMaterial({ color: 0x272727, roughness: 0.6, metalness: 0.4 });
    var mPole = new THREE.MeshStandardMaterial({ color: 0x3f3f3f, roughness: 0.6, metalness: 0.5 });
    var mPlat = new THREE.MeshStandardMaterial({ color: 0x6f6f6f, roughness: 0.9 });
    var mLampF = new THREE.MeshStandardMaterial({ color: 0x7F7F7F, emissive: 0x7F7F7F, emissiveIntensity: 1.6 });
    var mLampH = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, emissive: 0xbbbbbb, emissiveIntensity: 1.4 });
    var mStripe = new THREE.MeshStandardMaterial({ color: 0xB4B4B4, emissive: 0xB4B4B4, emissiveIntensity: 0.5 });
    var mStud = new THREE.MeshStandardMaterial({ color: 0xB4B4B4, emissive: 0xB4B4B4, emissiveIntensity: 0.9 });
    var mBumper = new THREE.MeshStandardMaterial({ color: 0x7F7F7F, roughness: 0.7 });
    var mOrange = new THREE.MeshStandardMaterial({ color: 0x7F7F7F, roughness: 0.55, metalness: 0.25 });
    var mAccent = new THREE.MeshStandardMaterial({ color: 0xbbbbbb, emissive: 0xbbbbbb, emissiveIntensity: 0.55, roughness: 0.5 });
    var mCanopyLight = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, emissive: 0xf2f2f2, emissiveIntensity: 1.0 });
    var mGlass = new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 0.25, metalness: 0.5 });
    var mWood = new THREE.MeshStandardMaterial({ color: 0x707070, roughness: 0.9 });
    var mDark = new THREE.MeshStandardMaterial({ color: 0x171717, roughness: 1 });

    function mesh(geo, mat, x, y, z, ry, rx) {
      var m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      if (ry) m.rotation.y = ry;
      if (rx) m.rotation.x = rx;
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      return m;
    }

    // Canvas sign painter — same visual language as arch-kit's signTex:
    // near-black plate, accent border, paper title, accent sub-line.
    function signTex(title, sub, accent, wM, hM, intercity) {
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
      signs.push({ title: title, sub: sub, intercity: !!intercity });
      return tex(THREE, c);
    }

    // Double-faced totem board on a mast rising from baseY to the board.
    function totem(title, sub, accent, wM, hM, x, boardY, z, ry, baseY, intercity) {
      var t = signTex(title, sub, accent, wM, hM, intercity);
      var fm = new THREE.MeshStandardMaterial({ map: t, roughness: 0.7 });
      var b = new THREE.Mesh(new THREE.BoxGeometry(wM, hM, 0.1),
        [mPole, mPole, mPole, mPole, fm, fm]);
      b.position.set(x, boardY, z);
      if (ry) b.rotation.y = ry;
      b.castShadow = true; b.receiveShadow = true;
      g.add(b);
      var mh = boardY - hM / 2 - baseY;
      if (mh > 0.05) mesh(new THREE.CylinderGeometry(0.07, 0.07, mh, 8), mPole, x, baseY + mh / 2, z);
    }

    // Lay deck, rails, fascia, pylons and edge lamps along a polyline [[x,z],...].
    // o: deckY, width, pylonEvery, lightEvery, hsr, overE (start overhang),
    //    overW (end overhang), skipPylon(x,z)->bool.
    function run(pts, o) {
      var deckMat = o.hsr ? mDeckHSR : mDeck;
      var lampMat = o.hsr ? mLampH : mLampF;
      var W = o.width, Y = o.deckY;
      var overE = o.overE == null ? 0.175 : o.overE;
      var overW = o.overW == null ? 0.175 : o.overW;
      var segs = [];
      for (var i = 0; i < pts.length - 1; i++) {
        var ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
        var dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
        var ang = Math.atan2(dx, dz);
        segs.push({ ax: ax, az: az, bx: bx, bz: bz, len: len, ang: ang,
          cx: (ax + bx) / 2, cz: (az + bz) / 2 });
      }
      segs.forEach(function (s, si) {
        var oE = si === 0 ? overE : 0.175, oW = si === segs.length - 1 ? overW : 0.175;
        var blen = s.len + oE + oW;
        var ex = s.ax - Math.sin(s.ang) * oE, ez = s.az - Math.cos(s.ang) * oE;
        var wx = s.bx + Math.sin(s.ang) * oW, wz = s.bz + Math.cos(s.ang) * oW;
        mesh(new THREE.BoxGeometry(W, 0.7, blen), deckMat, (ex + wx) / 2, Y - 0.35, (ez + wz) / 2, s.ang);
        [-0.8, 0.8].forEach(function (off) {
          var px = -Math.cos(s.ang) * off, pz = Math.sin(s.ang) * off;
          mesh(new THREE.BoxGeometry(0.14, 0.14, s.len), mRail, s.cx + px, Y + 0.07, s.cz + pz, s.ang);
        });
        if (o.hsr) { // steel-blue edge fascia on intercity decks
          [-1, 1].forEach(function (sd) {
            var fx = -Math.cos(s.ang) * sd * (W / 2 - 0.04);
            var fz = Math.sin(s.ang) * sd * (W / 2 - 0.04);
            mesh(new THREE.BoxGeometry(0.08, 0.5, s.len), mAccent, s.cx + fx, Y - 0.45, s.cz + fz, s.ang);
          });
        }
      });
      var dist = 0, nextPylon = 4, nextLamp = 2;
      segs.forEach(function (s) {
        var n = Math.max(1, Math.round(s.len / 2));
        for (var k = 0; k <= n; k++) {
          var t = k / n, d = dist + t * s.len;
          var x = s.ax + (s.bx - s.ax) * t, z = s.az + (s.bz - s.az) * t;
          if (d >= nextPylon) {
            nextPylon += o.pylonEvery;
            if (!o.skipPylon || !o.skipPylon(x, z)) {
              var colH = Y - 1.2;
              mesh(new THREE.BoxGeometry(0.9, colH, 0.9), mPylon, x, colH / 2, z);
              mesh(new THREE.BoxGeometry(W + 1.4, 0.5, 1.4), mPylon, x, Y - 0.95, z, s.ang);
            }
          }
          if (d >= nextLamp) {
            nextLamp += o.lightEvery;
            var lx = Math.cos(s.ang) * (W / 2 - 0.12), lz = -Math.sin(s.ang) * (W / 2 - 0.12);
            mesh(new THREE.BoxGeometry(0.16, 0.14, 0.16), lampMat, x + lx, Y + 0.12, z + lz);
            mesh(new THREE.BoxGeometry(0.16, 0.14, 0.16), lampMat, x - lx, Y + 0.12, z - lz);
          }
        }
        dist += s.len;
      });
    }

    // Terminus bumper: orange bar + two posts to the ground. ry=0 blocks z-travel
    // (bar wide in x); ry=Math.PI/2 blocks x-travel.
    function bumper(x, z, ry, deckY) {
      deckY = deckY || 7.5;
      mesh(new THREE.BoxGeometry(2.6, 1.1, 0.5), mBumper, x, deckY + 0.55, z, ry);
      var c = Math.cos(ry || 0), s = Math.sin(ry || 0);
      mesh(new THREE.BoxGeometry(0.4, deckY, 0.4), mPole, x - c * 1.0, deckY / 2, z + s * 1.0);
      mesh(new THREE.BoxGeometry(0.4, deckY, 0.4), mPole, x + c * 1.0, deckY / 2, z - s * 1.0);
    }

    // Forge Line station: side platform + yellow stripe + canopy + orange trim +
    // totem + bench + canopy light + amber edge studs. Mirrors arch-kit station().
    // alongZ=true => platform long axis is z; stripeSide: +1/-1 lateral toward track.
    function station(px, pz, alongZ, title, sub, deckY, accent, stripeSide) {
      var L = 8, Wd = 1.7;
      var w = alongZ ? Wd : L, d = alongZ ? L : Wd;
      mesh(new THREE.BoxGeometry(w, 0.25, d), mPlat, px, deckY - 0.125, pz);
      var so = stripeSide * (Wd / 2 - 0.18);
      mesh(new THREE.BoxGeometry(alongZ ? 0.14 : L, 0.03, alongZ ? L : 0.14), mStripe,
        px + (alongZ ? so : 0), deckY + 0.015, pz + (alongZ ? 0 : so));
      for (var i = -1; i <= 1; i += 2) for (var j = -1; j <= 1; j += 2) {
        mesh(new THREE.BoxGeometry(0.12, 2.6, 0.12), mPole,
          px + (alongZ ? j * (Wd / 2 - 0.2) : i * (L / 2 - 0.4)), deckY + 1.3,
          pz + (alongZ ? i * (L / 2 - 0.4) : j * (Wd / 2 - 0.2)));
      }
      mesh(new THREE.BoxGeometry(alongZ ? Wd + 0.8 : L + 0.6, 0.12, alongZ ? L + 0.6 : Wd + 0.8),
        mCanopy, px, deckY + 2.7, pz);
      mesh(new THREE.BoxGeometry(alongZ ? Wd + 0.85 : L + 0.65, 0.1, 0.1), mOrange,
        px, deckY + 2.62, pz + (alongZ ? (L + 0.6) / 2 : 0));
      mesh(new THREE.BoxGeometry(alongZ ? 0.14 : L - 0.6, 0.05, alongZ ? L - 0.6 : 0.14),
        mCanopyLight, px, deckY + 2.62, pz);
      totem(title, sub, accent, 3.2, 1.1, px, deckY + 3.6, pz, alongZ ? Math.PI / 2 : 0, deckY, false);
      // bench on the away-from-track side
      var bnx = px - (alongZ ? stripeSide * (Wd / 2 - 0.55) : 0);
      var bnz = pz - (alongZ ? 0 : stripeSide * (Wd / 2 - 0.55));
      var bry = alongZ ? Math.PI / 2 : 0;
      mesh(new THREE.BoxGeometry(1.8, 0.08, 0.5), mWood, bnx, deckY + 0.45, bnz, bry);
      mesh(new THREE.BoxGeometry(1.8, 0.5, 0.07), mWood,
        bnx - (alongZ ? stripeSide * 0.25 : 0), deckY + 0.75,
        bnz - (alongZ ? 0 : stripeSide * 0.25), bry);
      mesh(new THREE.BoxGeometry(0.08, 0.45, 0.5), mPole, bnx + (alongZ ? 0 : 0.8), deckY + 0.225, bnz + (alongZ ? 0.8 : 0), bry);
      mesh(new THREE.BoxGeometry(0.08, 0.45, 0.5), mPole, bnx - (alongZ ? 0 : 0.8), deckY + 0.225, bnz - (alongZ ? 0.8 : 0), bry);
      // amber edge studs along the track side
      for (var e = -3; e <= 3; e += 2) {
        mesh(new THREE.BoxGeometry(0.12, 0.06, 0.12), mStud,
          px + (alongZ ? stripeSide * (Wd / 2 - 0.18) : e), deckY + 0.03,
          pz + (alongZ ? e : stripeSide * (Wd / 2 - 0.18)));
      }
    }

    // ---- A. ACADEMY HQ INTERCHANGE: proper termini on both C-loop ends ----
    // North terminus wraps the existing bumper at (22.5,-6.2): platform east of
    // the deck, paired with the existing ACADEMY HQ stop west of the deck.
    station(25.6, -3, true, 'ACADEMY HQ INTERCHANGE', 'North Terminus · Forge Line', 7.5, '#7F7F7F', -1);
    totem('INTERCITY TRANSFER', 'PROPOSED · TRANSFER HALL →', '#bbbbbb',
      3.2, 1.1, 19, 3.9, 6.5, Math.PI / 2, 0, true);
    // South terminus wraps the existing bumper at (24.3,-56.5): platform east of
    // the deck, pulled to z[-63,-53] to clear UMCI's leaning upper floors.
    station(25.6, -58, true, 'ACADEMY HQ INTERCHANGE', 'South Terminus · Forge Line', 7.5, '#7F7F7F', -1);
    totem('INTERCITY TRANSFER', 'PROPOSED · VIA NORTH TERMINUS', '#bbbbbb',
      3.2, 1.1, 25.6, 11.1, -54, Math.PI / 2, 7.5, true);

    // ---- B1. Phase-joint board on the viaduct's west bumper (arch-kit, untouched).
    // The bumper bar (0.5 x 1.1 x 3.2 at (18.7,12.55,32), top y=13.1) sits in the
    // 1.375 m gap between the S2 deck end (x=19.825) and the S3 deck east face
    // (x=18.45): the corridor reads continuous; this board names the joint.
    mesh(new THREE.BoxGeometry(0.1, 1.2, 0.1), mPole, 18.3, 13.7, 31.2);
    mesh(new THREE.BoxGeometry(0.1, 1.2, 0.1), mPole, 19.1, 13.7, 31.2);
    (function phaseBoard() {
      var t = signTex('PHASE JOINT', 'PROPOSED · P1 — P2', '#bbbbbb', 2.4, 0.8, true);
      var fm = new THREE.MeshStandardMaterial({ map: t, roughness: 0.7 });
      var b = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.8, 0.08),
        [mPole, mPole, mPole, mPole, fm, fm]);
      b.position.set(18.7, 14.7, 31.2);
      b.rotation.y = Math.PI; // face south, toward the district
      b.castShadow = true; b.receiveShadow = true;
      g.add(b);
    })();

    // ---- B2. PROPOSED intercity transfer spur + transfer hall ----
    // Steel-blue spur leaves the viaduct's south edge at (28,29.9), deck 12,
    // runs south at x=28 (2.3 m plan-clear of the Forge east leg) to the hall.
    run([[28, 29.9], [28, -1.2]], {
      deckY: 12, width: 3.0, pylonEvery: 14, lightEvery: 8, hsr: true, overE: 0,
      skipPylon: function (x, z) { return x > 27 && x < 33 && z > -8 && z < -1; } // hall carries it
    });
    mesh(new THREE.BoxGeometry(0.5, 0.1, 3.0), mPole, 28, 12.05, 29.9); // joint cover plate
    // dark block signals — line is proposed, not commissioned
    [[28, 18], [28, 4]].forEach(function (sp) {
      mesh(new THREE.BoxGeometry(0.1, 1.6, 0.1), mPole, sp[0] + 1.2, 12.8, sp[1]);
      mesh(new THREE.BoxGeometry(0.34, 0.44, 0.22), mDark, sp[0] + 1.2, 13.75, sp[1]);
    });

    // ---- B3. Intercity Transfer Hall (PROPOSED) at (30,-4.5) ----
    // Three levels: ground lobby, Forge Line concourse (7.5), intercity
    // concourse on the roof (12) where the spur terminates. Glass lobby,
    // elevator + stair tower, bridge to the north terminus platform at deck 7.5.
    var hx = 30, hz = -4.5;
    mesh(new THREE.BoxGeometry(5, 0.3, 6), mConc, hx, 0.15, hz);                 // ground slab
    mesh(new THREE.BoxGeometry(5, 3.6, 0.12), mGlass, hx, 2.1, hz + 2.94);      // lobby walls
    mesh(new THREE.BoxGeometry(5, 3.6, 0.12), mGlass, hx, 2.1, hz - 2.94);
    mesh(new THREE.BoxGeometry(0.12, 3.6, 6), mGlass, hx - 2.44, 2.1, hz);
    mesh(new THREE.BoxGeometry(0.12, 3.6, 6), mGlass, hx + 2.44, 2.1, hz);
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(function (q) {                  // corner posts
      mesh(new THREE.BoxGeometry(0.18, 3.9, 0.18), mPole, hx + q[0] * 2.44, 2.1, hz + q[1] * 2.94);
    });
    mesh(new THREE.BoxGeometry(5.4, 0.3, 6.4), mConc, hx, 7.35, hz);            // Forge concourse
    mesh(new THREE.BoxGeometry(5.4, 0.3, 6.4), mConc, hx, 11.85, hz);           // intercity concourse (roof)
    mesh(new THREE.BoxGeometry(5.5, 0.25, 0.12), mAccent, hx, 11.9, hz + 3.15);  // roof trim
    mesh(new THREE.BoxGeometry(5.5, 0.25, 0.12), mAccent, hx, 11.9, hz - 3.15);
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(function (q) {                 // slab columns
      var cx = hx + q[0] * 1.7, cz = hz + q[1] * 2.3;
      mesh(new THREE.BoxGeometry(0.3, 6.9, 0.3), mPylon, cx, 3.75, cz);
      mesh(new THREE.BoxGeometry(0.25, 4.2, 0.25), mPylon, cx, 9.6, cz);
    });
    // elevator shaft (serves all three levels) + stair tower
    mesh(new THREE.BoxGeometry(1.8, 13, 1.8), mGlass, hx + 1.2, 6.5, hz - 1.7);
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(function (q) {
      mesh(new THREE.BoxGeometry(0.1, 13, 0.1), mPole, hx + 1.2 + q[0] * 0.9, 6.5, hz - 1.7 + q[1] * 0.9);
    });
    mesh(new THREE.BoxGeometry(2, 0.2, 2), mCanopy, hx + 1.2, 13.1, hz - 1.7);
    mesh(new THREE.BoxGeometry(2.5, 7.5, 3), mConc, hx - 1.5, 3.75, hz - 1.5);   // stair tower
    mesh(new THREE.BoxGeometry(2.6, 0.18, 0.2), mAccent, hx - 1.5, 5.2, hz);    // stair tower trim
    // bridge: hall concourse -> north terminus platform, deck 7.5
    mesh(new THREE.BoxGeometry(3, 0.7, 3), mDeck, 26, 7.15, hz);
    mesh(new THREE.BoxGeometry(3, 1.0, 0.08), mPole, 26, 8.0, hz + 1.46);
    mesh(new THREE.BoxGeometry(3, 1.0, 0.08), mPole, 26, 8.0, hz - 1.46);
    mesh(new THREE.BoxGeometry(0.5, 6.8, 0.5), mPylon, 26, 3.4, hz);
    // roof canopy over the intercity terminus
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(function (q) {
      mesh(new THREE.BoxGeometry(0.14, 2.6, 0.14), mPole, hx + q[0] * 2, 13.3, hz + q[1] * 2);
    });
    mesh(new THREE.BoxGeometry(5, 0.14, 5), mCanopy, hx, 14.67, hz);
    mesh(new THREE.BoxGeometry(5.1, 0.2, 0.12), mAccent, hx, 14.5, hz + 2.5);
    // hall totems + roof terminus bumper
    totem('INTERCITY TRANSFER', 'PROPOSED · Intercity ↔ Forge Line', '#bbbbbb',
      3.2, 1.1, hx + 3.8, 3.9, hz, Math.PI / 2, 0, true);
    totem('INTERCITY TRANSFER', 'PROPOSED · Intercity Terminus', '#bbbbbb',
      3.2, 1.1, hx, 14.4, hz - 1, Math.PI / 2, 12, true);
    bumper(28, -2.0, 0, 12);

    // ---- C1. MICHIGAN AVE LINE (Forge Line identity, deck 7.47) ----
    // Junctions the Forge west leg at (-25.6,-30) beside UM INNOVATION station;
    // runs west above Michigan Ave (z=-30). Track at z=-30, platforms south.
    // Deck 3 cm below the existing 7.5 deck so the abutment can't z-fight.
    run([[-25.6, -30], [-128, -30]], {
      deckY: 7.47, width: 3.4, pylonEvery: 12, lightEvery: 7, overE: 0
    });
    mesh(new THREE.BoxGeometry(3.4, 0.1, 0.5), mPole, -25.6, 7.55, -30); // junction cover plate
    bumper(-129.3, -30, Math.PI / 2, 7.47);
    station(-94, -33.6, false, 'MICHIGAN AVE · 14TH ST', 'Forge Line', 7.5, '#7F7F7F', 1);
    station(-120, -33.6, false, 'MICHIGAN AVE', 'West Terminus · Forge Line', 7.5, '#7F7F7F', 1);

    // ---- C2. 14TH ST LINE (Forge Line identity, deck 7.44) ----
    // Junctions the Michigan Ave line at (-94,-30); runs north at x=-94 under
    // the HSR deck at z=25.5 (clear: 7.44 < 11.3). Track west of platforms.
    // Deck 3 cm below the C1 deck for the same reason.
    run([[-94, -30], [-94, 38]], {
      deckY: 7.44, width: 3.4, pylonEvery: 12, lightEvery: 7, overE: 0
    });
    mesh(new THREE.BoxGeometry(0.5, 0.1, 3.4), mPole, -94, 7.52, -30);   // junction cover plate
    mesh(new THREE.BoxGeometry(2, 0.5, 2), mPylon, -94, 0.25, -30);      // junction pier
    mesh(new THREE.BoxGeometry(1.2, 6.3, 1.2), mPylon, -94, 3.4, -30);
    mesh(new THREE.BoxGeometry(4.6, 0.5, 4.6), mPylon, -94, 6.49, -30);
    bumper(-94, 39.3, 0, 7.44);
    station(-90.4, 15, true, 'WABASH · 14TH ST', 'Forge Line', 7.5, '#7F7F7F', -1);
    station(-90.4, 33, true, 'NORTHSIDE', 'Terminus · Forge Line', 7.5, '#7F7F7F', -1);

    // ---- C3. RIVERFRONT SPUR (Forge Line identity, deck 7.47) ----
    // Junctions the Forge north leg at (-20.6,27); runs north under the HSR
    // deck at z=32 to the pavilion. Track east of the platform.
    // Deck 3 cm below the existing 7.5 deck so the abutment can't z-fight.
    run([[-20.6, 27], [-20.6, 44]], {
      deckY: 7.47, width: 3.4, pylonEvery: 12, lightEvery: 7, overE: 0
    });
    mesh(new THREE.BoxGeometry(0.5, 0.1, 3.4), mPole, -20.6, 7.55, 27);  // junction cover plate
    bumper(-20.6, 45.3, 0, 7.47);
    station(-23.4, 41, true, 'RIVERFRONT PAVILION', 'North Terminus · Forge Line', 7.5, '#7F7F7F', 1);

    // ---- stats ----
    var bbox = new THREE.Box3().setFromObject(g);
    g.userData.stats = {
      module: 'railways',
      meshes: g.children.length,
      signs: signs,
      lines: [
        'Forge Line C-loop: both ends terminated at Academy HQ Interchange',
        'Intercity Transfer hub (PROPOSED): viaduct spur x=28 + 3-level hall',
        'Michigan Ave Line (Forge Line): (-25.6,-30) -> (-128,-30)',
        '14th St Line (Forge Line): (-94,-30) -> (-94,38)',
        'Riverfront Spur (Forge Line): (-20.6,27) -> (-20.6,44)'
      ],
      stations: [
        'Academy HQ Interchange — North Terminus (25.6,-3)',
        'Academy HQ Interchange — South Terminus (25.6,-58)',
        'Michigan Ave · 14th St (-94,-33.6)',
        'Michigan Ave — West Terminus (-120,-33.6)',
        'Wabash · 14th St (-90.4,15)',
        'Northside — Terminus (-90.4,33)',
        'Riverfront Pavilion — North Terminus (-23.4,41)',
        'Intercity Transfer — Intercity Terminus (PROPOSED, 30,-5.5 roof)'
      ],
      bbox: { min: bbox.min.toArray(), max: bbox.max.toArray() }
    };
    return g;
  }

  window.DAARailways = { buildRailways: buildRailways };
})();
