/* Detroit Automation Academy — Heritage Car (rail prototype, LOCAL ONLY).
 *
 * Classic IIFE; exposes window.DAAHeritageCar = { buildHeritageCar: function(THREE) }.
 * Returns a THREE.Group with origin at rail-top center (y=0 = top of rail),
 * forward = +z (nose toward +z, matching the traverser's rotation.y = atan2(tx,tz)).
 *
 * Vintage streetcar in Forge livery: rounded clerestory roof (dark), orange body,
 * cream window band with arched windows (canvas texture), brass trolley pole,
 * emissive headlights, bogies + wheels. No external assets, no network,
 * deterministic (no Math.random anywhere). Units: meters.
 */
(function () {
  'use strict';

  // Forge palette + the in-scene dark/glass convention (vehicles.js).
  var ORANGE = 0x7F7F7F;
  var AMBER = 0xB4B4B4;
  var PAPER = 0xF2F2F2;
  var DARK = 0x171717;
  var PXM = 64; // texture px per meter (matches arch-kit / railways.js)

  function canvasTex(THREE, wM, hM, draw) {
    try {
      if (typeof document === 'undefined' || !document.createElement) return null;
      var c = document.createElement('canvas');
      c.width = Math.max(2, Math.round(wM * PXM));
      c.height = Math.max(2, Math.round(hM * PXM));
      var x2 = c.getContext('2d');
      if (!x2) return null;
      draw(x2, c.width, c.height);
      var t = new THREE.CanvasTexture(c);
      if (THREE.SRGBColorSpace !== undefined) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    } catch (e) {
      return null;
    }
  }

  // One arched window: dark glass arch with cream mullions, on a cream field.
  function archWindow(x2, cx, topY, w, h) {
    var r = w / 2;
    x2.fillStyle = '#171717';
    x2.beginPath();
    x2.moveTo(cx - r, topY + h);
    x2.lineTo(cx - r, topY + r);
    x2.arc(cx, topY + r, r, Math.PI, 0);
    x2.lineTo(cx + r, topY + h);
    x2.closePath();
    x2.fill();
    x2.fillStyle = '#f2f2f2'; // mullions
    x2.fillRect(cx - 2, topY + 2, 4, h - 2);
    x2.fillRect(cx - r, topY + r - 2, w, 4);
  }

  function sideTex(THREE) {
    return canvasTex(THREE, 9.0, 1.0, function (x2, W, H) {
      x2.fillStyle = '#f2f2f2';
      x2.fillRect(0, 0, W, H);
      x2.fillStyle = '#7f7f7f'; // thin orange pinstripe top + bottom
      x2.fillRect(0, 0, W, 5);
      x2.fillRect(0, H - 5, W, 5);
      for (var i = 0; i < 7; i++) {
        archWindow(x2, 44 + i * 81, 10, 56, 48);
      }
    });
  }

  function frontTex(THREE) {
    return canvasTex(THREE, 2.4, 1.0, function (x2, W, H) {
      x2.fillStyle = '#f2f2f2';
      x2.fillRect(0, 0, W, H);
      x2.fillStyle = '#171717'; // destination board
      x2.fillRect(27, 6, 100, 20);
      x2.fillStyle = '#f2f2f2';
      x2.font = 'bold 13px sans-serif';
      x2.textAlign = 'center';
      x2.textBaseline = 'middle';
      x2.fillText('FORGE LINE', 77, 17);
      archWindow(x2, 40, 32, 52, 28);
      archWindow(x2, 114, 32, 52, 28);
    });
  }

  function rearTex(THREE) {
    return canvasTex(THREE, 2.4, 1.0, function (x2, W, H) {
      x2.fillStyle = '#f2f2f2';
      x2.fillRect(0, 0, W, H);
      archWindow(x2, 40, 8, 56, 50);
      archWindow(x2, 114, 8, 56, 50);
    });
  }

  function clerestoryTex(THREE) {
    return canvasTex(THREE, 7.4, 0.45, function (x2, W, H) {
      x2.fillStyle = '#171717';
      x2.fillRect(0, 0, W, H);
      x2.fillStyle = '#b4b4b4'; // small amber-lit clerestory windows
      for (var i = 0; i < 10; i++) {
        x2.fillRect(14 + i * 46, 8, 30, 13);
      }
    });
  }

  function mats(THREE) {
    var std = function (o) { return new THREE.MeshStandardMaterial(o); };
    var tSide = sideTex(THREE), tFront = frontTex(THREE),
        tRear = rearTex(THREE), tClere = clerestoryTex(THREE);
    return {
      orange: std({ color: ORANGE, roughness: 0.55, metalness: 0.25 }),
      cream: std({ color: PAPER, roughness: 0.6 }),
      dark: std({ color: DARK, roughness: 0.85 }),
      brass: std({ color: AMBER, roughness: 0.35, metalness: 0.8 }),
      amber: std({ color: AMBER, emissive: AMBER, emissiveIntensity: 0.9, roughness: 0.4 }),
      lampW: std({ color: 0xf5f5f5, emissive: 0xe3e3e3, emissiveIntensity: 1.2, roughness: 0.3 }),
      side: tSide ? std({ map: tSide, roughness: 0.6 }) : std({ color: PAPER, roughness: 0.6 }),
      front: tFront ? std({ map: tFront, roughness: 0.6 }) : std({ color: PAPER, roughness: 0.6 }),
      rear: tRear ? std({ map: tRear, roughness: 0.6 }) : std({ color: PAPER, roughness: 0.6 }),
      clere: tClere ? std({ map: tClere, roughness: 0.7 }) : std({ color: DARK, roughness: 0.85 })
    };
  }

  function box(g, THREE, M, w, h, d, x, y, z, rx, ry) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M);
    m.position.set(x, y, z);
    if (rx) m.rotation.x = rx;
    if (ry) m.rotation.y = ry;
    m.castShadow = true;
    g.add(m);
    return m;
  }

  function cylY(g, THREE, M, rt, rb, h, seg, x, y, z, rx, rz, sz) {
    var m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), M);
    m.position.set(x, y, z);
    if (rx) m.rotation.x = rx;
    if (rz) m.rotation.z = rz;
    if (sz) m.scale.z = sz;
    m.castShadow = true;
    g.add(m);
    return m;
  }

  function plane(g, THREE, M, w, h, x, y, z, ry) {
    var m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), M);
    m.position.set(x, y, z);
    if (ry) m.rotation.y = ry;
    m.castShadow = true;
    g.add(m);
    return m;
  }

  function buildHeritageCar(THREE) {
    var g = new THREE.Group();
    try {
      if (!THREE || !THREE.Group || !THREE.Mesh) return g;
      var M = mats(THREE);

      // ---- running gear: 2 bogies, 8 wheels (rails at local x = +/-0.8) ----
      [2.9, -2.9].forEach(function (zc) {
        box(g, THREE, M.dark, 1.9, 0.3, 2.3, 0, 0.62, zc); // bogie frame
        [-0.85, 0.85].forEach(function (dz) {
          [-0.8, 0.8].forEach(function (sx) {
            cylY(g, THREE, M.dark, 0.34, 0.34, 0.12, 18, sx, 0.34, zc + dz, 0, Math.PI / 2);
          });
        });
      });
      box(g, THREE, M.dark, 2.2, 0.35, 9.4, 0, 1.0, 0); // underframe

      // ---- orange lower body ----
      box(g, THREE, M.orange, 0.1, 1.05, 9.0, 1.15, 1.62, 0);
      box(g, THREE, M.orange, 0.1, 1.05, 9.0, -1.15, 1.62, 0);
      box(g, THREE, M.orange, 2.4, 1.05, 0.1, 0, 1.62, 4.45);
      box(g, THREE, M.orange, 2.4, 1.05, 0.1, 0, 1.62, -4.45);
      box(g, THREE, M.amber, 0.08, 0.12, 9.04, 1.19, 2.2, 0);  // beltline trim
      box(g, THREE, M.amber, 0.08, 0.12, 9.04, -1.19, 2.2, 0);

      // ---- cream window band with arched windows (canvas textures) ----
      box(g, THREE, M.cream, 2.4, 1.0, 9.0, 0, 2.7, 0);
      plane(g, THREE, M.side, 9.0, 1.0, 1.205, 2.7, 0, Math.PI / 2);
      plane(g, THREE, M.side, 9.0, 1.0, -1.205, 2.7, 0, -Math.PI / 2);
      plane(g, THREE, M.front, 2.4, 1.0, 0, 2.7, 4.51, 0);
      plane(g, THREE, M.rear, 2.4, 1.0, 0, 2.7, -4.51, Math.PI);

      // ---- rounded clerestory roof (dark) ----
      cylY(g, THREE, M.dark, 1.35, 1.35, 9.3, 24, 0, 3.2, 0, Math.PI / 2, 0, 0.42);
      box(g, THREE, M.dark, 1.4, 0.5, 7.4, 0, 3.62, 0); // clerestory box
      plane(g, THREE, M.clere, 7.4, 0.45, 0.705, 3.62, 0, Math.PI / 2);
      plane(g, THREE, M.clere, 7.4, 0.45, -0.705, 3.62, 0, -Math.PI / 2);

      // ---- lights ----
      box(g, THREE, M.lampW, 0.24, 0.24, 0.14, 0.7, 1.95, 4.52);  // headlights
      box(g, THREE, M.lampW, 0.24, 0.24, 0.14, -0.7, 1.95, 4.52);
      box(g, THREE, M.amber, 0.24, 0.24, 0.14, 0.7, 1.95, -4.52); // taillights
      box(g, THREE, M.amber, 0.24, 0.24, 0.14, -0.7, 1.95, -4.52);
      box(g, THREE, M.amber, 0.14, 0.1, 0.1, 0.55, 3.55, 4.35);   // roof markers
      box(g, THREE, M.amber, 0.14, 0.1, 0.1, -0.55, 3.55, 4.35);

      // ---- brass trolley pole (leans back, -z) ----
      cylY(g, THREE, M.dark, 0.1, 0.13, 0.3, 10, 0, 3.85, -1.6);
      cylY(g, THREE, M.brass, 0.035, 0.035, 3.4, 8, 0, 5.1, -2.35, -0.5, 0);
      box(g, THREE, M.brass, 0.12, 0.1, 0.3, 0, 6.6, -3.2); // contact shoe

      // ---- pilots, bumper beams, doors, steps, grab rails ----
      box(g, THREE, M.orange, 2.2, 0.55, 0.14, 0, 0.55, 4.62, -0.45, 0);
      box(g, THREE, M.orange, 2.2, 0.55, 0.14, 0, 0.55, -4.62, 0.45, 0);
      box(g, THREE, M.dark, 2.5, 0.22, 0.18, 0, 0.85, 4.58);
      box(g, THREE, M.dark, 2.5, 0.22, 0.18, 0, 0.85, -4.58);
      box(g, THREE, M.dark, 0.07, 1.9, 1.15, 1.2, 1.95, 2.3);   // doors
      box(g, THREE, M.dark, 0.07, 1.9, 1.15, -1.2, 1.95, 2.3);
      box(g, THREE, M.dark, 0.32, 0.08, 1.3, 1.32, 0.82, 2.3);  // step boards
      box(g, THREE, M.dark, 0.32, 0.08, 1.3, -1.32, 0.82, 2.3);
      cylY(g, THREE, M.orange, 0.03, 0.03, 1.7, 8, 1.08, 2.05, 4.56);  // grab rails
      cylY(g, THREE, M.orange, 0.03, 0.03, 1.7, 8, -1.08, 2.05, 4.56);
    } catch (e) {
      // Never break the scene: return whatever built successfully.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[heritage-car] partial build:', e && e.message);
      }
    }
    return g;
  }

  if (typeof window !== 'undefined') {
    window.DAAHeritageCar = { buildHeritageCar: buildHeritageCar };
  }
})();
