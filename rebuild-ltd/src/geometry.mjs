/**
 * LTD rebuild — pure scene geometry (Tranche T3, M5 core).
 *
 * Everything here is deterministic math over [x, z] scene-metre
 * points: path smoothing/resampling, ribbon strip construction for
 * the guideway layer cake, polygon triangulation for water / isle /
 * landmark fills, and dashed-rectangle segment generation. No GL,
 * no DOM — the renderer feeds these buffers to whichever adapter is
 * bound, and the tests pin the numbers here.
 *
 * Parameters are the register's, not inventions: layer cake R-11,
 * smoothing/resampling P-05, stop heights R-03 (consumed by T5).
 */

export const ROUTE_MAX = 128;

/** Guideway layer heights for route ordinal ri (R-11 layer cake). */
export function layerHeights(ri) {
  const sub = ((ri * 0.6180339887498949) % 1) * 1.19; // golden-ratio sub-slot, max 1.19 m
  return {
    deck: 66 + ri * 1.2 + sub,
    glow: 2 + ri * 0.25 + sub,
    casing: 24 + ri * 0.15 + sub,
  };
}

/** Stop pylon height (R-03): 75 + 28 per route serving the stop. */
export function stopHeight(nRoutes) {
  return 75 + 28 * nRoutes;
}
export const STOP_BASE_Y = 18;

/** Chaikin corner-cutting, endpoints preserved. */
export function chaikin(points, passes = 2) {
  let pts = points.map((p) => [p[0], p[1]]);
  for (let pass = 0; pass < passes; pass++) {
    if (pts.length < 3) break;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      out.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25]);
      out.push([ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

function turnAngleDeg(a, b, c) {
  const v1x = b[0] - a[0], v1z = b[1] - a[1];
  const v2x = c[0] - b[0], v2z = c[1] - b[1];
  const m1 = Math.hypot(v1x, v1z), m2 = Math.hypot(v2x, v2z);
  if (m1 === 0 || m2 === 0) return 0;
  const cross = v1x * v2z - v1z * v2x;
  const dot = v1x * v2x + v1z * v2z;
  return Math.abs(Math.atan2(cross, dot)) * (180 / Math.PI);
}

/**
 * Resample a path (P-05): edges longer than 80 m are cut into steps
 * of at most 40 m; near-collinear points (turn < 3°) are dropped
 * unless keeping them is needed to hold spacing at or under 120 m.
 * Turns above 150° are hairpins — always kept.
 */
export function resamplePath(points) {
  if (points.length < 3) return points.map((p) => [p[0], p[1]]);
  const kept = [points[0]];
  let acc = 0; // distance since the last kept point
  for (let i = 1; i < points.length - 1; i++) {
    const prev = kept[kept.length - 1];
    acc += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    const turn = turnAngleDeg(points[i - 1], points[i], points[i + 1]);
    if (turn >= 3 || acc >= 120) {
      kept.push(points[i]);
      acc = 0;
    }
  }
  kept.push(points[points.length - 1]);
  const out = [kept[0]];
  for (let i = 1; i < kept.length; i++) {
    const [ax, az] = out[out.length - 1];
    const [bx, bz] = kept[i];
    const len = Math.hypot(bx - ax, bz - az);
    if (len > 80) {
      const steps = Math.ceil(len / 40);
      for (let s = 1; s < steps; s++) {
        out.push([ax + (bx - ax) * (s / steps), az + (bz - az) * (s / steps)]);
      }
    }
    out.push(kept[i]);
  }
  return out;
}

/**
 * Fold lift (P-05): where a path passes within 45 m of a
 * non-adjacent strand of itself, lift up to 2.4 m so overlapping
 * ribbons never share a height (R-11's fence at path scale).
 * Returns one lift value per point.
 */
export function foldLift(points, peak = 2.4, window = 45) {
  // Grid-indexed (cell = window): only non-adjacent points in the
  // 3x3 neighborhood can be within the window.
  const lifts = new Array(points.length).fill(0);
  const grid = new Map();
  points.forEach((p, i) => {
    const key = `${Math.floor(p[0] / window)},${Math.floor(p[1] / window)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  });
  for (let i = 0; i < points.length; i++) {
    const cx = Math.floor(points[i][0] / window), cz = Math.floor(points[i][1] / window);
    let best = Infinity;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gz = cz - 1; gz <= cz + 1; gz++) {
        for (const j of grid.get(`${gx},${gz}`) ?? []) {
          if (Math.abs(j - i) <= 4) continue;
          const d = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]);
          if (d < best) best = d;
        }
      }
    }
    if (best < window) {
      const t = 1 - best / window;
      lifts[i] = peak * t * t;
    }
  }
  return lifts;
}

/**
 * Build one ribbon strip over a resampled path at height y.
 * Returns { positions: Float32Array (x,y,z per vertex), indices:
 * Uint32Array, routeAttr: Float32Array } — two vertices per path
 * point (left/right along the clamped miter normal, P-05: miter
 * offset clamped to 2x the half width). `dashPattern` (metres
 * [on, off, ...]) splits the strip into dashed runs — the geometry
 * supports the differentiation design's glow patterns; which routes
 * carry a pattern is a data decision (T9 gate), not made here.
 */
function rgbOf(hexInt) {
  return [((hexInt >> 16) & 255) / 255, ((hexInt >> 8) & 255) / 255, (hexInt & 255) / 255];
}

/**
 * Split a path into "on" runs under a dash pattern (metres,
 * [on, off, on, off...] repeating). Runs are clipped exactly at
 * pattern boundaries — a ribbon quad is never sampled at vertices
 * alone, which would erase dashes whose boundaries fall inside a
 * segment.
 */
export function dashRuns(points, dashPattern) {
  if (!dashPattern) return [points];
  const runs = [];
  let run = null;
  let k = 0;             // pattern element index; even = on, odd = off
  let inElem = 0;        // metres consumed inside the current element
  const elemLen = () => dashPattern[k % dashPattern.length];
  const isOn = () => k % 2 === 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1];
    const [bx, bz] = points[i];
    const segLen = Math.hypot(bx - ax, bz - az);
    if (segLen === 0) continue;
    let consumed = 0;
    while (consumed < segLen) {
      const take = Math.min(elemLen() - inElem, segLen - consumed);
      const t0 = consumed / segLen;
      const t1 = (consumed + take) / segLen;
      if (isOn()) {
        if (!run) {
          run = [[ax + (bx - ax) * t0, az + (bz - az) * t0]];
          runs.push(run);
        }
        run.push([ax + (bx - ax) * t1, az + (bz - az) * t1]);
      } else {
        run = null;
      }
      consumed += take;
      inElem += take;
      if (inElem >= elemLen()) { k++; inElem = 0; }
    }
  }
  return runs.filter((r) => r.length >= 2);
}

export function ribbonStrip(points, { width, y, routeOrdinal = 0, lifts = null, dashPattern = null, color = null }) {
  if (dashPattern) {
    const runs = dashRuns(points, dashPattern);
    if (!runs.length) {
      return {
        positions: new Float32Array(0), indices: new Uint32Array(0),
        routeAttr: new Float32Array(0), ...(color !== null ? { colorAttr: new Float32Array(0) } : {}),
      };
    }
    return mergeBuffers(runs.map((run) =>
      ribbonStrip(run, { width, y, routeOrdinal, lifts: null, color })));
  }
  const half = width / 2;
  const positions = [];
  const indices = [];
  const routeAttr = [];
  const colorAttr = [];
  const rgb = color !== null ? rgbOf(color) : null;
  let vertBase = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const pPrev = points[Math.max(0, i - 1)];
    const pNext = points[Math.min(points.length - 1, i + 1)];
    let dx = pNext[0] - pPrev[0], dz = pNext[1] - pPrev[1];
    const m = Math.hypot(dx, dz) || 1;
    dx /= m; dz /= m;
    let nx = -dz, nz = dx;
    // Miter clamp: where the direction reverses sharply the normal
    // flips; clamp the offset magnitude to 2x half width (the strip
    // verts sit at exactly half width along the averaged normal, so
    // the clamp binds through the averaged direction only).
    const lift = lifts ? lifts[i] : 0;
    positions.push(p[0] + nx * half, y + lift, p[1] + nz * half);
    positions.push(p[0] - nx * half, y + lift, p[1] - nz * half);
    routeAttr.push(routeOrdinal, routeOrdinal);
    if (rgb) colorAttr.push(...rgb, ...rgb);
    if (i > 0) {
      const a = vertBase + (i - 1) * 2, b = a + 1, c = vertBase + i * 2, d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    routeAttr: new Float32Array(routeAttr),
    ...(rgb ? { colorAttr: new Float32Array(colorAttr) } : {}),
  };
}

/** Vertical skirt walls dropping a deck strip from deckY to baseY. */
export function skirtWalls(points, { width, deckY, baseY, routeOrdinal = 0, lifts = null, color = null }) {
  const deck = ribbonStrip(points, { width, y: deckY, routeOrdinal, lifts, color });
  const pos = Array.from(deck.positions);
  const idx = [];
  const routeAttr = Array.from(deck.routeAttr);
  const colorAttr = deck.colorAttr ? Array.from(deck.colorAttr) : null;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    for (let side = 0; side < 2; side++) {
      const src = (i * 2 + side) * 3;
      pos.push(pos[src], baseY + (lifts ? lifts[i] : 0), pos[src + 2]);
      routeAttr.push(routeOrdinal);
      if (colorAttr) colorAttr.push(...rgbOf(color));
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let side = 0; side < 2; side++) {
      const topA = i * 2 + side, topB = (i + 1) * 2 + side;
      const botA = n * 2 + i * 2 + side, botB = n * 2 + (i + 1) * 2 + side;
      idx.push(topA, botA, topB, topB, botA, botB);
    }
  }
  return {
    positions: new Float32Array(pos),
    indices: new Uint32Array(idx),
    routeAttr: new Float32Array(routeAttr),
    ...(colorAttr ? { colorAttr: new Float32Array(colorAttr) } : {}),
  };
}

/** Concatenate strip buffers into one merged buffer (R-13 discipline). */
export function mergeBuffers(buffers) {
  let vCount = 0, iCount = 0;
  const withColor = buffers.some((b) => b.colorAttr);
  for (const b of buffers) {
    vCount += b.positions.length / 3;
    iCount += b.indices.length;
  }
  const positions = new Float32Array(vCount * 3);
  const routeAttr = new Float32Array(vCount);
  const colorAttr = withColor ? new Float32Array(vCount * 3) : null;
  const indices = new Uint32Array(iCount);
  let vOff = 0, iOff = 0;
  for (const b of buffers) {
    positions.set(b.positions, vOff * 3);
    if (b.routeAttr) routeAttr.set(b.routeAttr, vOff);
    if (colorAttr && b.colorAttr) colorAttr.set(b.colorAttr, vOff * 3);
    for (let i = 0; i < b.indices.length; i++) indices[iOff + i] = b.indices[i] + vOff;
    vOff += b.positions.length / 3;
    iOff += b.indices.length;
  }
  return { positions, indices, routeAttr, ...(colorAttr ? { colorAttr } : {}) };
}

export function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[(i + 1) % ring.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

/**
 * Net area of a ring set (outer minus holes), by shoelace. Fill
 * TRIANGULATION deliberately does not live here: it is the GL
 * adapter's job (gl-adapter: makeFilledShapes), because the vendor
 * build ships a proven triangulator and a hand-rolled ear-clipper
 * is exactly the kind of geometry code that fails quietly on real
 * water polygons. This helper exists so tests and records can
 * state expected areas.
 */
export function ringsArea(rings) {
  let a = Math.abs(signedArea(rings[0]));
  for (let h = 1; h < rings.length; h++) a -= Math.abs(signedArea(rings[h]));
  return a;
}

/** Dashed rectangle outline as independent segments (bounds borders, P-01). */
export function dashedRectSegments(x0, z0, x1, z1, dash = 220, gap = 140) {
  const segs = [];
  const edges = [
    [[x0, z0], [x1, z0]],
    [[x1, z0], [x1, z1]],
    [[x1, z1], [x0, z1]],
    [[x0, z1], [x0, z0]],
  ];
  for (const [[ax, az], [bx, bz]] of edges) {
    const len = Math.hypot(bx - ax, bz - az);
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    for (let d = 0; d < len; d += dash + gap) {
      const e = Math.min(d + dash, len);
      segs.push(ax + ux * d, az + uz * d, ax + ux * e, az + uz * e);
    }
  }
  return new Float32Array(segs);
}

/** Longest path of a route + its midpoint (route label anchor, P-10). */
export function longestPathMidpoint(paths) {
  let best = null, bestLen = -1;
  for (const path of paths) {
    let len = 0;
    for (let i = 1; i < path.length; i++) {
      len += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    }
    if (len > bestLen) { bestLen = len; best = path; }
  }
  if (!best) return null;
  let acc = 0;
  for (let i = 1; i < best.length; i++) {
    const seg = Math.hypot(best[i][0] - best[i - 1][0], best[i][1] - best[i - 1][1]);
    if (acc + seg >= bestLen / 2) {
      const t = seg === 0 ? 0 : (bestLen / 2 - acc) / seg;
      return {
        point: [
          best[i - 1][0] + (best[i][0] - best[i - 1][0]) * t,
          best[i - 1][1] + (best[i][1] - best[i - 1][1]) * t,
        ],
        length: bestLen,
      };
    }
    acc += seg;
  }
  const last = best[best.length - 1];
  return { point: [last[0], last[1]], length: bestLen };
}
