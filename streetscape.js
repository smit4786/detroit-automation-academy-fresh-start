// Detroit Automation Academy — streetscape kit.
// Curbs, sidewalks, lane paint, crosswalks, and the central plaza treatment.
// Units meters; three.js x = east, z = south, y = up.
// Road / plaza pad surface top y = 0.35, ground top y = 0.
// Classic script; exposes window.DAAStreetscape.
(function () {
  'use strict';

  var PXM = 64;        // texture pixels per meter
  var ROAD_TOP = 0.35; // top of the road and plaza pad surfaces

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

  function tex(THREE, canvas, srgb) {
    var t = new THREE.CanvasTexture(canvas);
    if (srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
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

  // neutral cast concrete with fine speckle and sawn joints; 4 m x 2.5 m tile
  function concreteCanvas(seed, base) {
    var p = cv(4, 2.5), c = p[0], x = p[1], W = c.width, H = c.height;
    var R = rnd(seed), i;
    x.fillStyle = shade(base, 1);
    x.fillRect(0, 0, W, H);
    for (i = 0; i < 1400; i++) {
      x.fillStyle = shade(base, 0.8 + R() * 0.4);
      x.fillRect(R() * W, R() * H, 2, 2);
    }
    x.fillStyle = 'rgba(0,0,0,0.22)';
    for (i = 1; i < 4; i++) x.fillRect(0, Math.round(i * H / 4) - 1, W, 2);
    return c;
  }

  // dark paver band with 0.5 m joints; 4 m x 1.5 m tile
  function paverCanvas(seed, base) {
    var p = cv(4, 1.5), c = p[0], x = p[1], W = c.width, H = c.height;
    var R = rnd(seed);
    var jw = 0.5 * PXM, jx, jy;
    x.fillStyle = shade(base, 0.6);
    x.fillRect(0, 0, W, H);
    for (jx = 0; jx < W; jx += jw) {
      for (jy = 0; jy < H; jy += jw) {
        x.fillStyle = shade(base, 0.85 + R() * 0.3);
        x.fillRect(jx + 1, jy + 1, jw - 2, jw - 2);
      }
    }
    return c;
  }

  // 2.4 m corner medallion: dark pavers with an amber inlay frame
  function medallionCanvas() {
    var p = cv(2.4, 2.4), c = p[0], x = p[1], W = c.width, H = c.height;
    var R = rnd(77);
    var base = [58, 61, 66];
    var jw = 0.4 * PXM, jx, jy;
    x.fillStyle = shade(base, 0.6);
    x.fillRect(0, 0, W, H);
    for (jx = 0; jx < W; jx += jw) {
      for (jy = 0; jy < H; jy += jw) {
        x.fillStyle = shade(base, 0.85 + R() * 0.3);
        x.fillRect(jx + 1, jy + 1, jw - 2, jw - 2);
      }
    }
    x.strokeStyle = '#B4B4B4';
    x.lineWidth = Math.round(0.12 * PXM);
    var m = 0.28 * PXM;
    x.strokeRect(m, m, W - 2 * m, H - 2 * m);
    return c;
  }

  function buildStreetscape(THREE) {
    var g = new THREE.Group();

    var walkCanvas = concreteCanvas(301, [178, 174, 164]);
    var borderCanvas = paverCanvas(302, [64, 67, 72]);
    var medCanvas = medallionCanvas();

    var mCurb = new THREE.MeshStandardMaterial({ color: 0xb5b5b5, roughness: 0.95 });
    var mAmber = new THREE.MeshStandardMaterial({ color: 0xa0a0a0, roughness: 0.7 });
    var mWhite = new THREE.MeshStandardMaterial({ color: 0xe7e7e7, roughness: 0.7 });
    var mMedal = std(THREE, tex(THREE, medCanvas), 0.9);

    function walkMaterial(lenM) {
      var t = tex(THREE, walkCanvas);
      t.repeat.set(lenM / 4, 1);
      return std(THREE, t, 0.95);
    }
    function borderMaterial(lenM) {
      var t = tex(THREE, borderCanvas);
      t.repeat.set(lenM / 4, 1);
      return std(THREE, t, 0.95);
    }

    // axis 'x': strip runs along x at fixed z = c, from x = a to x = b.
    // axis 'z': strip runs along z at fixed x = c, from z = a to z = b.
    // w is the across-axis width, y0 the base height, h the thickness.
    function strip(axis, c, a, b, w, y0, h, mat, cast) {
      var len = b - a;
      if (!(len > 0.05)) return null;
      var mid = (a + b) / 2;
      var geo = axis === 'x'
        ? new THREE.BoxGeometry(len, h, w)
        : new THREE.BoxGeometry(w, h, len);
      var mesh = new THREE.Mesh(geo, mat);
      if (axis === 'x') mesh.position.set(mid, y0 + h / 2, c);
      else mesh.position.set(c, y0 + h / 2, mid);
      mesh.castShadow = !!cast;
      mesh.receiveShadow = true;
      g.add(mesh);
      return mesh;
    }

    function curbSeg(axis, c, a, b) {
      strip(axis, c, a, b, 0.35, ROAD_TOP, 0.16, mCurb, true);
    }
    function walkSeg(axis, c, a, b) {
      strip(axis, c, a, b, 2.5, ROAD_TOP, 0.12, walkMaterial(Math.abs(b - a)), true);
    }
    // paint sits 0.015 above the road surface; no shadow casting
    function markSeg(axis, c, a, b, w, mat) {
      strip(axis, c, a, b, w, 0.365, 0.02, mat, false);
    }
    function dash(axis, perp, at) {
      markSeg(axis, perp, at - 1.5, at + 1.5, 0.15, mAmber);
    }
    // 8 zebra stripes: 0.5 m along-road, 3.2 m across, 0.85 m spacing
    function crosswalk(axis, at) {
      for (var i = 0; i < 8; i++) {
        var off = (i - 3.5) * 0.85;
        markSeg(axis, 0, at + off - 0.25, at + off + 0.25, 3.2, mWhite);
      }
    }

    // Per-spoke segment tables. Segments are [perpCenter, from, to].
    // Curb/sidewalk runs are gapped where the spoke passes a building
    // footprint (north/south spokes) or the true occupied rects measured
    // from the arch-kit builders (east/west spokes); curbs also skip the
    // 8 m flush transition where each spoke meets the plaza.
    var spokes = [
      { // north spoke: road x[-4,4], z[-65,-17]
        axis: 'z',
        curbs: [[4.175, -65, -54.3], [-4.175, -65, -54.3]],
        walks: [[5.6, -65, -54.3], [-5.6, -65, -54.3]],
        dashes: [-62, -56],
        edges: [[3.6, -65, -54.3], [-3.6, -65, -54.3]],
        cross: 0 // omitted: the z~=20 band sits inside the UMCI footprint
      },
      { // south spoke: road x[-4,4], z[17,65]
        axis: 'z',
        curbs: [[4.175, 25, 30], [4.175, 53.6, 65],
                [-4.175, 25, 30], [-4.175, 53.6, 65]],
        walks: [[5.6, 17, 30], [5.6, 53.6, 65],
                [-5.6, 17, 30], [-5.6, 53.6, 65]],
        dashes: [26, 56, 62],
        edges: [[3.6, 17, 30], [3.6, 53.6, 65],
                [-3.6, 17, 30], [-3.6, 53.6, 65]],
        cross: 20.5
      },
      { // east spoke: road z[-4,4], x[17,65]
        axis: 'x',
        curbs: [[-4.175, 25, 30], [4.175, 25, 65]],
        walks: [[-5.6, 17, 22.05], [-5.6, 22.95, 30], [5.6, 17, 27], [5.6, 61, 65]],
        dashes: [26, 32, 38, 44, 50, 56, 62],
        edges: [[-3.6, 17, 22.05], [-3.6, 22.95, 30], [3.6, 17, 65]],
        cross: 20.5
      },
      { // west spoke: road z[-4,4], x[-65,-17]
        axis: 'x',
        curbs: [[-4.175, -65, -57.15], [-4.175, -30.85, -25],
                [4.175, -65, -57.15], [4.175, -30.85, -26.2]],
        walks: [[-5.6, -65, -57.15], [-5.6, -30.85, -17],
                [5.6, -65, -57.15], [5.6, -30.85, -17]],
        dashes: [-62, -26],
        edges: [[-3.6, -65, -57.15], [-3.6, -30.85, -17],
                [3.6, -65, -57.15], [3.6, -30.85, -26.05], [3.6, -25.15, -17]],
        cross: -20.5
      }
    ];

    spokes.forEach(function (sp) {
      sp.curbs.forEach(function (s) { curbSeg(sp.axis, s[0], s[1], s[2]); });
      sp.walks.forEach(function (s) { walkSeg(sp.axis, s[0], s[1], s[2]); });
      sp.dashes.forEach(function (d) { dash(sp.axis, 0, d); });
      sp.edges.forEach(function (s) { markSeg(sp.axis, s[0], s[1], s[2], 0.12, mWhite); });
      if (sp.cross) crosswalk(sp.axis, sp.cross);
    });

    // ---- central plaza: 1.5 m darker paver border frame just inside the
    // 34x34 pad perimeter, plus 2.4 m corner medallions at (+-13.5, +-13.5)
    var B0 = 16.95, B1 = 15.45; // border outer / inner half-extent
    var bc = (B0 + B1) / 2, bw = B0 - B1;
    strip('x', -bc, -B0, B0, bw, ROAD_TOP, 0.04, borderMaterial(2 * B0), true);
    strip('x', bc, -B0, B0, bw, ROAD_TOP, 0.04, borderMaterial(2 * B0), true);
    strip('z', -bc, -B1, B1, bw, ROAD_TOP, 0.04, borderMaterial(2 * B1), true);
    strip('z', bc, -B1, B1, bw, ROAD_TOP, 0.04, borderMaterial(2 * B1), true);
    [[13.5, 13.5], [-13.5, 13.5], [13.5, -13.5], [-13.5, -13.5]].forEach(function (p) {
      var mesh = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.04, 2.4), mMedal);
      mesh.position.set(p[0], ROAD_TOP + 0.02, p[1]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
    });

    return g;
  }

  window.DAAStreetscape = { buildStreetscape: buildStreetscape };
})();
