/* Detroit Automation Academy — multilayer rail + maglev prototype (LOCAL ONLY).
 *
 * CONCEPT: the ML2 maglev line is speculative technology. Every maglev sign
 * carries CONCEPT; no opening dates, no operator names. ML1 is drawn in the
 * operating Forge Line identity, consistent with railways.js L1/L2/L3.
 *
 * Classic IIFE; exposes window.DAAMultilevel = { init: function(THREE, scene, opts) }.
 * init returns { update(dt), setReduced(b), vehicleCount, getState() }.
 * opts = { reduced: bool } — parks all vehicles.
 *
 * Units meters; x = east, z = south, y = up. Deterministic: the only PRNG is a
 * seeded mulberry32 (surface stud spacing jitter); zero Math.random.
 * Rail-top convention: rails are 0.14-tall boxes; rail-top y = deckY + 0.14.
 *
 * ---- clearance reasoning (ML2 maglev: deck 13, beam top y = 13, z = -24) ----
 * - Runs 6 m north of the L1 Michigan Ave deck (z = -30): plan gap between the
 *   maglev beam edge (z = -25.2) and the L1 deck edge (z = -28.3) is 3.1 m.
 * - Crosses OVER the L2 14th St Line at (-94,-24): L2 deck top 7.44, R2 pod
 *   roof ~9.6; maglev beam underside 12.3 -> >= 2.7 m clear. Y-piers skip
 *   |x+94| < 3.5 so no pier lands in the L2 deck corridor.
 * - Piers stand on the Michigan Ave north curb line (z = -24); footing base
 *   follows road top (0.35) where the road exists, grade (0) in the core gap.
 *
 * ---- ML1 trench note ----
 * Retaining walls at x = -95.5 / -92.5 (y -5..0), track slab top y = -4.5,
 * rail-top -4.36. At TRENCHWAY the east wall steps out to x = -90.5 over
 * z[134,146] to form a platform bay (platform x[-92.45,-90.75], top -4.36);
 * the pedestrian overpass at z = 140 carries a skylight strip over the track,
 * with a stair descending from the deck to the platform's south end.
 *
 * ---- footprint audit (2026-10-01, node script) ----
 * Corridor x[-100,-88] z[35,175] vs region-expansion-r4.js: replicated the
 * seeded house/store/tree placement loops — 0 intersections (all R4 fabric in
 * this band is at z <= -30 or |x| >= 226). Core district: the 14th St road
 * (district-expansion.js) ends at z = 40 where ML1 begins (abuts, no
 * overlap); its tree rows end at z = 31 (5.8 m clear of the interchange
 * tower); the L2 deck ends at z = 38, ML1 starts at z = 40. Alignment kept
 * exactly as specified.
 *
 * Signage: Forge Line stations use the railways.js visual language (platform,
 * yellow stripe, canopy, totem, bench); maglev stations are CONCEPT-signed in
 * the intercity steel-blue identity (railways.js precedent: the R3 intercity
 * CONCEPT trainset). The removed name never appears in any sign or comment.
 */
(function () {
  'use strict';

  // Tier 1 brand tokens (exact) + Tier 2 library matches + the railways.js
  // steel-blue intercity identity (maglev CONCEPT elements only).
  var ORANGE = 0x7F7F7F, AMBER = 0xB4B4B4, PAPER = 0xF2F2F2,
      CONCRETE1 = 0x9F9F9F, MIDNIGHT = 0x101010;
  var STEELBLUE = 0xbbbbbb;

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  var PXM = 64;

  function init(THREE, scene, opts) {
    var api = {
      update: function () {},
      setReduced: function () {},
      vehicleCount: 0,
      getState: function () { return []; },
      stats: { infra: 0, vehicles: 0, signs: [] }
    };
    try {
      if (!THREE || !THREE.Group || !scene || typeof scene.add !== 'function') return api;
      var reduced = !!(opts && opts.reduced);

      var g = new THREE.Group();
      var infraN = 0;
      var signs = [];

      function std(o) { return new THREE.MeshStandardMaterial(o); }
      var M = {
        conc:   std({ color: 0x949494, roughness: 0.9 }),   // Tier 2 concrete
        plat:   std({ color: 0x6f6f6f, roughness: 0.9 }),   // Tier 2 platform
        wall:   std({ color: CONCRETE1, roughness: 0.95 }), // Tier 1 retaining walls
        rail:   std({ color: 0xcdcdcd, roughness: 0.3, metalness: 0.85 }),
        pole:   std({ color: 0x3f3f3f, roughness: 0.6, metalness: 0.5 }),
        canopy: std({ color: 0x272727, roughness: 0.6, metalness: 0.4 }),
        dark:   std({ color: 0x171717, roughness: 0.85 }),
        glass:  std({ color: 0xb0b0b0, roughness: 0.25, metalness: 0.5 }),
        wood:   std({ color: 0x707070, roughness: 0.9 }),
        orange: std({ color: ORANGE, roughness: 0.55, metalness: 0.25 }),
        amber:  std({ color: AMBER, emissive: AMBER, emissiveIntensity: 0.9, roughness: 0.4 }),
        stripe: std({ color: AMBER, emissive: AMBER, emissiveIntensity: 0.5 }),
        bumper: std({ color: ORANGE, roughness: 0.7 }),
        lampW:  std({ color: 0xf5f5f5, emissive: 0xe3e3e3, emissiveIntensity: 1.2, roughness: 0.3 }),
        canLight: std({ color: 0xe8e8e8, emissive: 0xf2f2f2, emissiveIntensity: 1.0 }),
        sblue:  std({ color: STEELBLUE, emissive: STEELBLUE, emissiveIntensity: 0.55, roughness: 0.5 })
      };

      function B(w, h, d, mat, x, y, z, rx, ry) {
        var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set(x, y, z);
        if (rx) m.rotation.x = rx;
        if (ry) m.rotation.y = ry;
        m.castShadow = true; m.receiveShadow = true;
        g.add(m); infraN++;
        return m;
      }
      function CY(r, h, mat, x, y, z, seg) {
        var m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg || 10), mat);
        m.position.set(x, y, z);
        m.castShadow = true; m.receiveShadow = true;
        g.add(m); infraN++;
        return m;
      }

      // ---- signage (railways.js visual language) ----
      function signTex(title, sub, accent, wM, hM) {
        signs.push({ title: title, sub: sub });
        if (typeof document === 'undefined' || !document.createElement) return null;
        try {
          var c = document.createElement('canvas');
          c.width = Math.max(2, Math.round(wM * PXM));
          c.height = Math.max(2, Math.round(hM * PXM));
          var x2 = c.getContext('2d');
          if (!x2) return null;
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
          var t = new THREE.CanvasTexture(c);
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 4;
          return t;
        } catch (e) { return null; }
      }
      function boardMesh(title, sub, accent, wM, hM, x, y, z, ry) {
        var t = signTex(title, sub, accent, wM, hM);
        var fm = t ? std({ map: t, roughness: 0.7 })
                   : std({ color: 0x131313, roughness: 0.7 });
        var b = new THREE.Mesh(new THREE.BoxGeometry(wM, hM, 0.1),
          [M.pole, M.pole, M.pole, M.pole, fm, fm]);
        b.position.set(x, y, z);
        if (ry) b.rotation.y = ry;
        b.castShadow = true; b.receiveShadow = true;
        g.add(b); infraN++;
        return b;
      }
      // Double-faced totem board on a mast rising from baseY to the board.
      function totem(title, sub, accent, wM, hM, x, boardY, z, ry, baseY) {
        boardMesh(title, sub, accent, wM, hM, x, boardY, z, ry);
        var mh = boardY - hM / 2 - baseY;
        if (mh > 0.05) CY(0.07, mh, M.pole, x, baseY + mh / 2, z, 8);
      }
      // Terminus bumper: bar + two posts. ry=0 blocks z-travel, ry=PI/2 blocks x-travel.
      function bumper(x, z, ry, deckY, baseY) {
        baseY = (baseY == null) ? 0 : baseY;
        B(2.6, 1.1, 0.5, M.bumper, x, deckY + 0.55, z, 0, ry);
        var c = Math.cos(ry || 0), s = Math.sin(ry || 0);
        var ph = deckY + 0.55 - baseY;
        B(0.4, ph, 0.4, M.pole, x - c * 1.0, baseY + ph / 2, z + s * 1.0);
        B(0.4, ph, 0.4, M.pole, x + c * 1.0, baseY + ph / 2, z - s * 1.0);
      }

      // Forge Line station: platform (top at topY) + yellow stripe + canopy +
      // totem + bench + canopy light. alongZ=true => long axis z; stripeSide
      // +1/-1 lateral toward the track. polesMode 'std' (4 poles) or 'west2'.
      function stationForge(px, pz, alongZ, title, sub, topY, stripeSide, polesMode) {
        var L = 8, Wd = 1.7;
        var w = alongZ ? Wd : L, d = alongZ ? L : Wd;
        B(w, 0.25, d, M.plat, px, topY - 0.125, pz);
        var so = stripeSide * (Wd / 2 - 0.18);
        B(alongZ ? 0.14 : L, 0.03, alongZ ? L : 0.14, M.stripe,
          px + (alongZ ? so : 0), topY + 0.015, pz + (alongZ ? 0 : so));
        var poleXs = polesMode === 'west2' ? [-(Wd / 2 - 0.2), -(Wd / 2 - 0.2)]
                                           : [-(Wd / 2 - 0.2), (Wd / 2 - 0.2)];
        for (var i = -1; i <= 1; i += 2) {
          for (var j = 0; j < poleXs.length; j++) {
            B(0.12, 2.6, 0.12, M.pole,
              px + (alongZ ? poleXs[j] : i * (L / 2 - 0.4)), topY + 1.3,
              pz + (alongZ ? i * (L / 2 - 0.4) : poleXs[j]));
          }
        }
        B(alongZ ? Wd + 0.8 : L + 0.6, 0.12, alongZ ? L + 0.6 : Wd + 0.8,
          M.canopy, px, topY + 2.7, pz);
        B(alongZ ? Wd + 0.85 : L + 0.65, 0.1, 0.1, M.orange,
          px, topY + 2.62, pz + (alongZ ? (L + 0.6) / 2 : 0));
        B(alongZ ? 0.14 : L - 0.6, 0.05, alongZ ? L - 0.6 : 0.14,
          M.canLight, px, topY + 2.62, pz);
        totem(title, sub, '#7F7F7F', 3.2, 1.1, px, topY + 3.6, pz,
              alongZ ? Math.PI / 2 : 0, topY);
        var bnx = px - (alongZ ? stripeSide * (Wd / 2 - 0.55) : 0);
        var bnz = pz - (alongZ ? 0 : stripeSide * (Wd / 2 - 0.55));
        var bry = alongZ ? Math.PI / 2 : 0;
        B(1.8, 0.08, 0.5, M.wood, bnx, topY + 0.45, bnz, 0, bry);
        B(1.8, 0.5, 0.07, M.wood, bnx - (alongZ ? stripeSide * 0.25 : 0), topY + 0.75,
          bnz - (alongZ ? 0 : stripeSide * 0.25), 0, bry);
        B(0.08, 0.45, 0.5, M.pole, bnx + (alongZ ? 0 : 0.8), topY + 0.225, bnz + (alongZ ? 0.8 : 0), 0, bry);
        B(0.08, 0.45, 0.5, M.pole, bnx - (alongZ ? 0 : 0.8), topY + 0.225, bnz - (alongZ ? 0.8 : 0), 0, bry);
      }

      // ============ ML1 — NORTHSIDE SURFACE + TRENCH LINE (Forge Line) ============
      var TX = -94; // track centerline x

      // surface: low concrete slab z[38.2,70] (abuts the 14th St road end at z=40),
      // twin rails z[40,70], amber edge studs every ~7 m (seeded jitter).
      B(4.0, 0.5, 31.8, M.conc, TX, -0.25, 54.1);
      [-0.8, 0.8].forEach(function (off) {
        B(0.14, 0.14, 30, M.rail, TX + off, 0.07, 55);
      });
      var jr = mulberry32(7101);
      for (var sk = 0; sk < 4; sk++) {
        var sz = 42.5 + sk * 7 + (jr() - 0.5) * 1.0;
        B(0.16, 0.1, 0.16, M.amber, TX - 1.7, 0.05, sz);
        B(0.16, 0.1, 0.16, M.amber, TX + 1.7, 0.05, sz);
      }
      // ramp z[70,110]: rails + sloped cheek walls (top plane 0.5 -> -4.0)
      var rampAng = Math.atan2(4.5, 40);
      [-0.8, 0.8].forEach(function (off) {
        B(0.14, 0.14, 40.6, M.rail, TX + off, -2.18, 90, rampAng, 0);
      });
      B(0.4, 5.5, 40.6, M.wall, TX - 1.7, -4.5, 90, rampAng, 0);
      B(0.4, 5.5, 40.6, M.wall, TX + 1.7, -4.5, 90, rampAng, 0);
      // trench z[110,170]: track slab (top -4.5), twin rails (top -4.36)
      B(3.0, 0.5, 64, M.conc, TX, -4.75, 140);
      [-0.8, 0.8].forEach(function (off) {
        B(0.14, 0.14, 62, M.rail, TX + off, -4.43, 140);
      });
      // retaining walls y[-5,0]: west full run; east with step-out bay z[134,146]
      B(0.5, 5, 60, M.wall, -95.5, -2.5, 140);
      B(0.5, 5, 24, M.wall, -92.5, -2.5, 122);
      B(0.5, 5, 24, M.wall, -92.5, -2.5, 158);
      B(0.5, 5, 12, M.wall, -90.5, -2.5, 140);
      B(2.5, 5, 0.5, M.wall, -91.5, -2.5, 134);
      B(2.5, 5, 0.5, M.wall, -91.5, -2.5, 146);
      // terminus bumper at (-94,171), posts to the trench floor
      bumper(TX, 171, 0, -4.36, -4.5);

      // ---- ML1 stations ----
      // NORTHSIDE SURFACE: platform east of the surface track, top at rail-top 0.14
      stationForge(-91.5, 52, true, 'NORTHSIDE SURFACE', 'Forge Line', 0.14, -1, 'std');
      // TRENCHWAY: below-grade platform in the step-out bay (top -4.36),
      // 2-pole west canopy (stair occupies the east side), bench at north end.
      (function trenchway() {
        var px = -91.6, pz = 141, topY = -4.36;
        B(1.7, 0.25, 11, M.plat, px, topY - 0.125, pz);
        B(0.14, 0.03, 11, M.stripe, px - (1.7 / 2 - 0.18), topY + 0.015, pz);
        [-4, 4].forEach(function (dz) {
          B(0.12, 2.6, 0.12, M.pole, px - 0.65, topY + 1.3, pz + dz);
        });
        B(2.5, 0.12, 11.6, M.canopy, px, topY + 2.7, pz);
        B(2.55, 0.1, 0.1, M.orange, px, topY + 2.62, pz + 5.8);
        B(0.14, 0.05, 10.4, M.canLight, px, topY + 2.62, pz);
        totem('TRENCHWAY', 'Forge Line', '#7F7F7F', 3.2, 1.1, px, topY + 3.6, pz, Math.PI / 2, topY);
        B(0.5, 0.08, 1.8, M.wood, px + 0.35, topY + 0.45, pz - 3.5, 0, Math.PI / 2);
        B(0.07, 0.5, 1.8, M.wood, px + 0.6, topY + 0.75, pz - 3.5, 0, Math.PI / 2);
        B(0.5, 0.45, 0.08, M.pole, px + 0.35, topY + 0.225, pz - 4.3, 0, Math.PI / 2);
        B(0.5, 0.45, 0.08, M.pole, px + 0.35, topY + 0.225, pz - 2.7, 0, Math.PI / 2);
      })();
      // pedestrian overpass at z=140: deck, skylight strip over the track,
      // railings, stair descending southward to the platform
      (function overpass() {
        B(7, 0.3, 2, M.conc, -93.5, 0.2, 140);
        B(3.5, 0.06, 1, M.glass, -93.75, 0.32, 140); // skylight x[-95.5,-92]
        B(7, 1.1, 0.08, M.pole, -93.5, 0.9, 139.04);
        B(7, 1.1, 0.08, M.pole, -93.5, 0.9, 140.96);
        var sa = Math.atan2(4.71, 7);
        B(1.2, 0.25, 8.5, M.plat, -91.3, -2.005, 143.3, sa, 0);
      })();

      // ---- NORTHSIDE MULTILEVEL INTERCHANGE at (-91.5,38) ----
      // Glass elevator shaft + straight stair flights linking the elevated
      // NORTHSIDE platform (deck 7.44/7.5 at (-90.4,33), platform ends z=37)
      // down to the surface platform. Clears the L2 bumper post at (-93,39.3).
      (function interchangeN() {
        var ix = -91.5, iz = 38;
        B(1.6, 8.2, 1.6, M.glass, ix, 4.1, iz);                 // shaft y[0,8.2]
        [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(function (q) {
          B(0.1, 8.2, 0.1, M.pole, ix + q[0] * 0.8, 4.1, iz + q[1] * 0.8);
        });
        B(2.0, 0.2, 2.0, M.canopy, ix, 8.3, iz);               // shaft cap
        var fa = Math.atan2(3.72, 3.5);
        B(1.5, 0.15, 1.0, M.plat, -90.4, 7.42, 37.4);          // platform link plate
        B(1.5, 0.25, 5.11, M.plat, -90.4, 5.58, 38.95, fa, 0); // flight 1
        B(1.5, 0.2, 1.5, M.plat, -90.4, 3.62, 41.45);          // landing
        B(1.5, 0.25, 5.11, M.plat, -90.4, 1.86, 43.95, fa, 0); // flight 2
        boardMesh('NORTHSIDE INTERCHANGE', 'Elevated <-> Surface', '#7F7F7F',
          3.4, 1.0, ix + 0.85, 5.5, iz, Math.PI / 2);
      })();

      // ============ ML2 — MAGLEV CONCEPT (speculative technology) ============
      // Elevated concrete beam 2.4 m wide, 0.7 m deep, top y = 13 (deck 13),
      // running (-30,-24) -> (-128,-24). Side guidance rails + Y-piers every
      // 18 m (skipped where |x+94| < 3.5: the L2 line passes under at deck 7.44).
      var MGZ = -24, MGTOP = 13;
      (function guideway() {
        var x0 = -30, x1 = -128, segs = 8, segLen = (x0 - x1) / segs;
        for (var i = 0; i < segs; i++) {
          var cx = x0 - segLen * (i + 0.5);
          B(segLen + 0.06, 0.7, 2.4, M.conc, cx, MGTOP - 0.35, MGZ); // beam y[12.3,13]
        }
        [-1.26, 1.26].forEach(function (off) {                      // guidance rails
          B(98, 0.25, 0.12, M.sblue, -79, MGTOP - 0.35, MGZ + off);
        });
        for (var px = -30; px >= -128; px -= 18) {                   // Y-piers
          if (Math.abs(px + 94) < 3.5) continue;                     // L2 corridor skip
          var baseY = (px === -30 || px === -48) ? 0 : 0.35;         // core gap vs road top
          B(1.8, 0.5, 1.8, M.conc, px, baseY + 0.25, MGZ);           // footing
          var colH = (MGTOP - 0.7) - (baseY + 0.5);
          B(0.9, colH, 0.9, M.conc, px, baseY + 0.5 + colH / 2, MGZ); // stem
          B(1.1, 0.5, 3.0, M.conc, px, MGTOP - 0.95, MGZ);           // crosshead
        }
        bumper(-29, MGZ, Math.PI / 2, MGTOP, 0);                     // east terminus
      })();

      // Maglev CONCEPT station: platform (top 13) south of the beam + stripe +
      // canopy + CONCEPT totem + bench + cantilever arms off the beam.
      // alongX=true => long axis x; platform at (px,pz).
      function stationMaglev(px, pz, title, sub) {
        var L = 8, Wd = 1.7;
        B(L, 0.25, Wd, M.plat, px, 13 - 0.125, pz);
        B(L, 0.03, 0.14, M.stripe, px, 13.015, pz - (Wd / 2 - 0.18)); // stripe, track side
        for (var i = -1; i <= 1; i += 2) for (var j = -1; j <= 1; j += 2) {
          B(0.12, 2.6, 0.12, M.pole, px + i * (L / 2 - 0.4), 14.3, pz + j * (Wd / 2 - 0.2));
        }
        B(L + 0.6, 0.12, Wd + 0.8, M.canopy, px, 15.7, pz);
        B(L + 0.65, 0.1, 0.1, M.sblue, px, 15.62, pz + (Wd + 0.8) / 2);
        B(L - 0.6, 0.05, 0.14, M.canLight, px, 15.62, pz);
        totem(title, sub, '#bbbbbb', 3.2, 1.1, px, 16.6, pz, 0, 13);
        var bry = 0;
        B(1.8, 0.08, 0.5, M.wood, px, 13.45, pz + (Wd / 2 - 0.55), 0, bry);
        B(1.8, 0.5, 0.07, M.wood, px, 13.75, pz + (Wd / 2 - 0.55) + 0.25, 0, bry);
        B(0.08, 0.45, 0.5, M.pole, px + 0.8, 13.225, pz + (Wd / 2 - 0.55), 0, bry);
        B(0.08, 0.45, 0.5, M.pole, px - 0.8, 13.225, pz + (Wd / 2 - 0.55), 0, bry);
        [-3, 3].forEach(function (dx) {                              // cantilever arms
          B(0.3, 0.5, 3.4, M.conc, px + dx, 12.6, -22.75);
        });
        for (var e = -2; e <= 2; e++) {                              // amber edge studs
          B(0.12, 0.06, 0.12, M.amber, px + e * 1.6, 13.03, pz - (Wd / 2 - 0.18));
        }
      }
      stationMaglev(-94, -21.5, 'MAGLEV \u00b7 14TH ST', 'CONCEPT \u00b7 Maglev');
      stationMaglev(-120, -21.5, 'MAGLEV WEST', 'CONCEPT \u00b7 Terminus');

      // ---- MAGLEV / FORGE INTERCHANGE at (-94,-27) ----
      // Elevator + switchback stair linking the maglev platform (deck 13) down
      // to the L1 MICHIGAN AVE - 14TH ST platform (deck 7.5 at (-94,-33.6)) via
      // a bridge over the L1 track. Tower stands on a traffic-island pad on
      // the Michigan Ave carriageway (road top 0.35).
      (function interchangeM() {
        var ix = -94, iz = -26.8;
        B(3.8, 0.12, 2.8, M.conc, ix, 0.41, iz);                    // island pad, top 0.47
        B(1.6, 13.43, 1.6, M.glass, ix - 0.6, 7.185, iz);          // shaft y[0.47,13.9]
        [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(function (q) {
          B(0.1, 13.43, 0.1, M.pole, ix - 0.6 + q[0] * 0.8, 7.185, iz + q[1] * 0.8);
        });
        B(2.0, 0.2, 2.0, M.canopy, ix - 0.6, 14.0, iz);            // shaft cap
        var f1 = Math.atan2(7.03, 2.4);
        var len1 = Math.sqrt(2.4 * 2.4 + 7.03 * 7.03);
        var st1 = new THREE.Mesh(new THREE.BoxGeometry(len1, 0.25, 1.2), M.plat);
        st1.position.set(ix - 0.1, 0.47 + 7.03 / 2, iz);
        st1.rotation.z = f1; st1.castShadow = true; st1.receiveShadow = true;
        g.add(st1); infraN++;
        B(1.4, 0.2, 1.4, M.plat, ix + 1.2, 7.4, iz);               // mid landing (L1 level)
        var f2 = Math.atan2(5.5, 2.4);
        var len2 = Math.sqrt(2.4 * 2.4 + 5.5 * 5.5);
        var st2 = new THREE.Mesh(new THREE.BoxGeometry(len2, 0.25, 1.2), M.plat);
        st2.position.set(ix - 0.1, 7.5 + 5.5 / 2, iz);
        st2.rotation.z = -f2; st2.castShadow = true; st2.receiveShadow = true;
        g.add(st2); infraN++;
        B(2.0, 0.2, 5.0, M.plat, ix, 7.85, -30.4);                 // bridge over L1 track
        B(0.25, 7.5, 0.25, M.pole, ix - 0.85, 3.75 + 0.35, -28.2); // bridge posts
        B(0.25, 7.5, 0.25, M.pole, ix + 0.85, 3.75 + 0.35, -32.6);
        B(2.0, 0.25, 0.9, M.plat, ix, 7.62, -28.1);                // steps
        B(2.0, 0.25, 0.9, M.plat, ix, 7.72, -32.9);
        boardMesh('INTERCHANGE', 'Maglev CONCEPT <-> Forge Line', '#bbbbbb',
          3.4, 1.0, ix - 0.6, 10.2, iz + 0.85, 0);
      })();

      api.stats.infra = infraN;
      api.stats.signs = signs;
      scene.add(g);

      // ---------------- vehicles ----------------
      // Local counters keep the vehicle mesh budget auditable.
      function vStd(o) { return new THREE.MeshStandardMaterial(o); }

      // ML1: inline 2-car Forge shuttle, forward = +z, origin at rail top.
      function buildShuttle(THREE) {
        var grp = new THREE.Group(), n = 0;
        var Mv = {
          orange: vStd({ color: ORANGE, roughness: 0.55, metalness: 0.2 }),
          amber: vStd({ color: AMBER, emissive: AMBER, emissiveIntensity: 0.9, roughness: 0.4 }),
          dark: vStd({ color: 0x171717, roughness: 0.85 }),
          glass: vStd({ color: 0x222222, roughness: 0.15, metalness: 0.65 }),
          lampW: vStd({ color: 0xf5f5f5, emissive: 0xe3e3e3, emissiveIntensity: 1.2, roughness: 0.3 })
        };
        function b(w, h, d, mat, x, y, z) {
          var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
          m.position.set(x, y, z); m.castShadow = true; grp.add(m); n++;
          return m;
        }
        function wheel(x, y, z) {
          var m = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.12, 14), Mv.dark);
          m.rotation.z = Math.PI / 2; m.position.set(x, y, z);
          m.castShadow = true; grp.add(m); n++;
        }
        function car(cz, front) {
          b(2.2, 1.7, 6.8, Mv.orange, 0, 1.35, cz);   // body (floor 0.5)
          b(2.24, 0.55, 6.0, Mv.glass, 0, 1.7, cz);   // window band
          b(2.1, 0.12, 6.6, Mv.dark, 0, 2.26, cz);    // roof
          b(2.22, 0.14, 6.82, Mv.amber, 0, 0.95, cz); // amber stripe
          b(2.0, 0.4, 6.4, Mv.dark, 0, 0.55, cz);     // skirt
          [cz - 2.2, cz + 2.2].forEach(function (bz) {
            b(1.6, 0.3, 1.4, Mv.dark, 0, 0.35, bz);   // bogie frame
            wheel(-0.75, 0.3, bz); wheel(0.75, 0.3, bz);
          });
          if (front) b(0.9, 0.16, 0.08, Mv.lampW, 0, 1.15, cz + 3.44);
          else b(0.9, 0.16, 0.08, Mv.amber, 0, 1.15, cz - 3.44);
        }
        car(3.6, true); car(-3.6, false);
        b(2.0, 1.5, 0.8, Mv.dark, 0, 1.3, 0);         // gangway bellows
        return { group: grp, meshes: n };
      }

      // ML2: sleek 2-car maglev CONCEPT. NO wheels: U-shaped undercarriage
      // wraps the guideway beam; the U floor (group origin) rides 0.1 m above
      // the beam top (levitation gap), amber guidance lights on the skirts.
      function buildMaglev(THREE) {
        var grp = new THREE.Group(), n = 0;
        var Mv = {
          blue: vStd({ color: STEELBLUE, roughness: 0.4, metalness: 0.45 }),
          amber: vStd({ color: AMBER, emissive: AMBER, emissiveIntensity: 0.9, roughness: 0.4 }),
          dark: vStd({ color: 0x171717, roughness: 0.85 }),
          glass: vStd({ color: 0x222222, roughness: 0.15, metalness: 0.65 }),
          lampW: vStd({ color: 0xf5f5f5, emissive: 0xe3e3e3, emissiveIntensity: 1.4, roughness: 0.3 }),
          conc: vStd({ color: 0x9F9F9F, roughness: 0.8 })
        };
        function b(w, h, d, mat, x, y, z, rx) {
          var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
          m.position.set(x, y, z);
          if (rx) m.rotation.x = rx;
          m.castShadow = true; grp.add(m); n++;
          return m;
        }
        function car(cz, front) {
          b(2.9, 0.18, 7.0, Mv.dark, 0, 0.09, cz);      // U floor (bottom = origin)
          b(0.12, 0.65, 7.0, Mv.dark, -1.39, -0.235, cz); // skirts wrap the beam
          b(0.12, 0.65, 7.0, Mv.dark, 1.39, -0.235, cz);
          [-1.46, 1.46].forEach(function (sx) {          // guidance lights
            b(0.06, 0.12, 0.5, Mv.amber, sx, -0.2, cz - 2.2);
            b(0.06, 0.12, 0.5, Mv.amber, sx, -0.2, cz + 2.2);
          });
          b(2.4, 1.8, 7.0, Mv.blue, 0, 1.5, cz);        // body (0.6..2.4)
          b(2.44, 0.6, 6.2, Mv.glass, 0, 1.8, cz);      // window band
          b(2.3, 0.14, 6.8, Mv.dark, 0, 2.47, cz);      // roof
          b(2.42, 0.14, 7.02, Mv.amber, 0, 1.0, cz);    // amber stripe
          b(1.1, 0.22, 1.8, Mv.conc, 0, 2.65, cz);      // roof AC pod
          if (front) {
            var nose = new THREE.Mesh(new THREE.SphereGeometry(1.2, 20, 14), Mv.blue);
            nose.scale.set(1, 0.75, 0.9); nose.position.set(0, 1.5, cz + 3.5);
            nose.castShadow = true; grp.add(nose); n++;
            b(2.0, 0.55, 0.1, Mv.glass, 0, 1.9, cz + 3.62, -0.25); // windshield
            b(0.3, 0.18, 0.1, Mv.lampW, 0.7, 1.2, cz + 3.85);      // headlights
            b(0.3, 0.18, 0.1, Mv.lampW, -0.7, 1.2, cz + 3.85);
          } else {
            b(0.3, 0.18, 0.1, Mv.amber, 0.7, 1.45, cz - 3.53);     // taillights
            b(0.3, 0.18, 0.1, Mv.amber, -0.7, 1.45, cz - 3.53);
          }
        }
        car(3.65, true); car(-3.65, false);
        b(2.2, 1.6, 0.7, Mv.dark, 0, 1.45, 0);          // gangway bellows
        return { group: grp, meshes: n };
      }

      // ---------------- 3D motion model (extends rail-vehicles.js) ----------------
      var RESAMPLE_STEP = 0.5;
      var DWELL_S = 4.0, TERMINUS_PAUSE_S = 2.0;

      // Resample [[x,z,yRailTop],...]; y interpolated along 3D arc length.
      function resample3(pts, step) {
        var xs = [pts[0][0]], zs = [pts[0][1]], ys = [pts[0][2]], cum = [0];
        var segStart = 0, next = step;
        for (var i = 0; i < pts.length - 1; i++) {
          var ax = pts[i][0], az = pts[i][1], ay = pts[i][2];
          var bx = pts[i + 1][0], bz = pts[i + 1][1], by = pts[i + 1][2];
          var dx = bx - ax, dz = bz - az, dy = by - ay;
          var len = Math.sqrt(dx * dx + dz * dz + dy * dy);
          if (len < 1e-9) continue;
          var ux = dx / len, uz = dz / len, uy = dy / len;
          var segEnd = segStart + len;
          while (next < segEnd - 1e-9) {
            var t = next - segStart;
            xs.push(ax + ux * t); zs.push(az + uz * t); ys.push(ay + uy * t);
            cum.push(next); next += step;
          }
          segStart = segEnd;
        }
        var l = pts[pts.length - 1];
        if (Math.abs(xs[xs.length - 1] - l[0]) > 1e-9 ||
            Math.abs(zs[zs.length - 1] - l[1]) > 1e-9) {
          xs.push(l[0]); zs.push(l[1]); ys.push(l[2]); cum.push(segStart);
        }
        return { xs: xs, zs: zs, ys: ys, cum: cum, L: segStart };
      }
      function pointAt3(p, s) {
        var n = p.cum.length;
        if (s <= 0) return { x: p.xs[0], y: p.ys[0], z: p.zs[0] };
        if (s >= p.L) return { x: p.xs[n - 1], y: p.ys[n - 1], z: p.zs[n - 1] };
        var lo = 0, hi = n - 1;
        while (hi - lo > 1) {
          var mid = (lo + hi) >> 1;
          if (p.cum[mid] <= s) lo = mid; else hi = mid;
        }
        var c0 = p.cum[lo], c1 = p.cum[hi];
        var t = (s - c0) / Math.max(1e-9, c1 - c0);
        return { x: p.xs[lo] + (p.xs[hi] - p.xs[lo]) * t,
                 y: p.ys[lo] + (p.ys[hi] - p.ys[lo]) * t,
                 z: p.zs[lo] + (p.zs[hi] - p.zs[lo]) * t };
      }
      function tangentH(p, s) {
        var e = 0.75;
        var a = pointAt3(p, Math.max(0, s - e));
        var b = pointAt3(p, Math.min(p.L, s + e));
        var dx = b.x - a.x, dz = b.z - a.z;
        var l = Math.sqrt(dx * dx + dz * dz) || 1;
        return { x: dx / l, z: dz / l };
      }
      function projectOnto(p, x, z) {
        var best = Infinity, bi = 0;
        for (var i = 0; i < p.xs.length; i++) {
          var dx = x - p.xs[i], dz = z - p.zs[i], d = dx * dx + dz * dz;
          if (d < best) { best = d; bi = i; }
        }
        return { s: p.cum[bi], dist: Math.sqrt(best) };
      }
      function placeOnTrack(v) {
        var p = pointAt3(v.path, v.s);
        v.group.position.set(p.x, p.y + v.yOff, p.z);
        var t = tangentH(v.path, v.s);
        v.group.rotation.y = Math.atan2(t.x * v.dir, t.z * v.dir);
        v.px = p.x; v.py = p.y + v.yOff; v.pz = p.z; v.pathY = p.y;
        v.yaw = v.group.rotation.y;
      }
      function makeService(cfg) {
        var built = cfg.build(THREE);
        var group = new THREE.Group();
        group.add(built.group);
        var path = resample3(cfg.polyline, RESAMPLE_STEP);
        var stops = cfg.stations.map(function (st) {
          var pr = projectOnto(path, st.x, st.z);
          return { name: st.name, s: pr.s, dist: pr.dist, sx: st.x, sz: st.z };
        });
        var firstS = stops.length ? stops[0].s : path.L / 2;
        stops.sort(function (a, b) { return a.s - b.s; });
        var sMin = cfg.halfLen + cfg.endMargin;
        var sMax = path.L - cfg.halfLen - cfg.endMargin;
        if (sMax < sMin) { var mid = path.L / 2; sMin = mid; sMax = mid; }
        var bbox = { minX: Infinity, maxX: -Infinity, minZ: Infinity,
                     maxZ: -Infinity, minY: Infinity, maxY: -Infinity };
        cfg.polyline.forEach(function (pt) {
          bbox.minX = Math.min(bbox.minX, pt[0]); bbox.maxX = Math.max(bbox.maxX, pt[0]);
          bbox.minZ = Math.min(bbox.minZ, pt[1]); bbox.maxZ = Math.max(bbox.maxZ, pt[1]);
          bbox.minY = Math.min(bbox.minY, pt[2]); bbox.maxY = Math.max(bbox.maxY, pt[2]);
        });
        var v = {
          name: cfg.name, group: group, path: path, stops: stops, bbox: bbox,
          sMin: sMin, sMax: sMax, yOff: cfg.yOff, vmax: cfg.vmax,
          accel: cfg.accel, decel: cfg.decel,
          s: Math.max(sMin, Math.min(sMax, firstS)), v: 0, dir: 1,
          state: 'dwell', t: 1.0, px: 0, py: 0, pz: 0, pathY: 0, yaw: 0
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
            if (v.state === 'pause') v.dir *= -1;
            v.state = 'run';
          }
          placeOnTrack(v);
          return;
        }
        var target = v.dir > 0 ? v.sMax : v.sMin, isTerminus = true;
        for (var i = 0; i < v.stops.length; i++) {
          var ss = v.stops[i].s;
          if (v.dir > 0 && ss > v.s + 0.6 && ss < target) { target = ss; isTerminus = false; }
          if (v.dir < 0 && ss < v.s - 0.6 && ss > target) { target = ss; isTerminus = false; }
        }
        var dist = Math.abs(target - v.s);
        var vAllow = Math.sqrt(2 * v.decel * dist);
        v.v = Math.min(v.v + v.accel * dt, vAllow, v.vmax);
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

      var defs = [
        {
          name: 'ML1 NORTHSIDE SHUTTLE',
          polyline: [[-94, 40, 0.14], [-94, 70, 0.14], [-94, 110, -4.36], [-94, 170, -4.36]],
          yOff: 0, vmax: 8, accel: 1.0, decel: 1.3, halfLen: 7, endMargin: 1.5,
          stations: [
            { name: 'NORTHSIDE SURFACE', x: -91.5, z: 52 },
            { name: 'TRENCHWAY', x: -91.5, z: 140 }
          ],
          build: buildShuttle
        },
        {
          name: 'ML2 MAGLEV CONCEPT',
          polyline: [[-30, -24, 13], [-128, -24, 13]],
          yOff: 0.1, vmax: 28, accel: 1.2, decel: 1.5, halfLen: 7.0, endMargin: 0.5,
          stations: [
            { name: 'MAGLEV \u00b7 14TH ST', x: -94, z: -21.5 },
            { name: 'MAGLEV WEST', x: -120, z: -21.5 }
          ],
          build: buildMaglev
        }
      ];

      var services = [];
      var vehicleMeshes = 0;
      for (var di = 0; di < defs.length; di++) {
        var svc;
        try { svc = makeService(defs[di]); }
        catch (e) { continue; }
        if (reduced) { svc.state = 'parked'; svc.v = 0; placeOnTrack(svc); }
        services.push(svc);
      }
      // Count vehicle meshes by traversing each service group.
      services.forEach(function (sv) {
        var c = 0;
        sv.group.traverse(function (o) { if (o.isMesh) c++; });
        vehicleMeshes += c;
      });

      api.vehicleCount = services.length;
      api.stats.vehicles = vehicleMeshes;
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
                   x: v.px, y: v.py, z: v.pz, pathY: v.pathY, yOff: v.yOff,
                   yaw: v.yaw, vmax: v.vmax, accel: v.accel, decel: v.decel,
                   sMin: v.sMin, sMax: v.sMax, pathL: v.path.L, bbox: v.bbox,
                   stops: v.stops.map(function (st) {
                     return { name: st.name, s: st.s, dist: st.dist };
                   }) };
        });
      };
      api._services = services;
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[rail-multilevel] init failed:', e && e.message);
      }
    }
    return api;
  }

  if (typeof window !== 'undefined') {
    window.DAAMultilevel = { init: init };
  }
})();
