/**
 * LTD rebuild — stop geometry and scale model (Tranche T5, M5 seam).
 *
 * Stop rendering of record (P-30, R-03): one merged mesh of pylons,
 * cylinder radii 14 (top) / 18 (base); pylon height is
 * `stopHeight(nRoutes) = 75 + 28 x routes serving` (geometry.mjs),
 * base y = STOP_BASE_Y = 18. A single-route pylon takes its route's
 * token; a multi-route hub is paper-white 0xf2f2f2; the selected
 * stop paints white. Stops are fully opaque at all distances —
 * there is no distance fade anywhere in this module (R-12).
 *
 * The zoom scale (R-03) is a pure function of camera distance:
 * floors 0.35 (orbit) / 0.55 (street view) at <= 2,800 m, a
 * smoothstep up to 1.0 at 8,000 m, and above 8,000 m a linear
 * rise (camDist / 8000) that holds the footprint at ~4.3 px —
 * reaching exactly the 3.25x cap at the 26,000 m LOD edge. The
 * label anchor rides the same scale: base + height x scale + 40.
 * The layer (stop-layer.mjs) applies the scale in quantized bands
 * — picks and buffers re-bake as discrete events, never per frame
 * (P-79 discipline).
 */

import { stopHeight, STOP_BASE_Y } from "./geometry.mjs";

export { stopHeight, STOP_BASE_Y };
export const STOP_RADIUS_TOP = 14;
export const STOP_RADIUS_BOTTOM = 18;
export const STOP_LOD_M = 26000; // renderer LOD.stops, P-79
export const HUB_COLOR = 0xf2f2f2; // multi-route paper-white, P-30
export const SELECTED_COLOR = 0xffffff;
export const SCALE_FLOORS = { orbit: 0.35, street: 0.55 };
export const SCALE_KNEE_M = 2800;
export const SCALE_FULL_M = 8000;
export const SCALE_MAX = 3.25;

function hexToInt(hex) {
  return parseInt(String(hex).slice(1), 16);
}

/** The R-03 zoom scale for a camera distance and view mode. */
export function stopScale(camDist, mode = "orbit") {
  const floor = SCALE_FLOORS[mode] ?? SCALE_FLOORS.orbit;
  if (camDist <= SCALE_KNEE_M) return floor;
  if (camDist < SCALE_FULL_M) {
    const t = (camDist - SCALE_KNEE_M) / (SCALE_FULL_M - SCALE_KNEE_M);
    const s = t * t * (3 - 2 * t); // smoothstep
    return floor + (1 - floor) * s;
  }
  return Math.min(camDist / SCALE_FULL_M, SCALE_MAX);
}

/** Label anchor height for a stop at a given scale (R-03). */
export function labelAnchorY(stop, scale) {
  return STOP_BASE_Y + stopHeight((stop.routes ?? []).length) * scale + 40;
}

/** Pylon color: the route's token for single-route stops, hub white otherwise. */
export function stopColor(registry, stop) {
  const routes = stop.routes ?? [];
  if (routes.length === 1) {
    const token = registry.tokenFor(routes[0]);
    if (token && token.hex) return hexToInt(token.hex);
  }
  return HUB_COLOR;
}

const SIDES = 10;

/**
 * Merged pylon buffers for a set of stops: positions / indices /
 * per-vertex colors in the adapter's makeMesh shape. `scale`
 * applies to the footprint radii (the prominence dimension); the
 * pylon's vertical extent is its identity and does not scale.
 * `selectedIdx` (a registry index) paints its pylon white.
 */
export function buildStopBuffers(registry, stops, { scale = 1, selectedIdx = null } = {}) {
  const positions = [];
  const colors = [];
  const indices = [];
  let vc = 0;
  const push = (x, y, z, rgb) => {
    positions.push(x, y, z);
    colors.push(((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255);
  };
  for (const stop of stops) {
    const rgb = stop.idx === selectedIdx ? SELECTED_COLOR : stopColor(registry, stop);
    const h = stopHeight((stop.routes ?? []).length);
    const y0 = STOP_BASE_Y;
    const y1 = STOP_BASE_Y + h;
    const rT = STOP_RADIUS_TOP * scale;
    const rB = STOP_RADIUS_BOTTOM * scale;
    const base = vc;
    // Bottom ring, top ring, apex (top cap fan center).
    for (let i = 0; i < SIDES; i++) {
      const a = (i / SIDES) * Math.PI * 2;
      push(stop.x + Math.cos(a) * rB, y0, stop.z + Math.sin(a) * rB, rgb);
    }
    for (let i = 0; i < SIDES; i++) {
      const a = (i / SIDES) * Math.PI * 2;
      push(stop.x + Math.cos(a) * rT, y1, stop.z + Math.sin(a) * rT, rgb);
    }
    push(stop.x, y1, stop.z, rgb);
    const apex = base + SIDES * 2;
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES;
      // Side quad: bottom i, bottom j, top j, top i.
      indices.push(base + i, base + j, base + SIDES + j);
      indices.push(base + i, base + SIDES + j, base + SIDES + i);
      // Top cap fan.
      indices.push(base + SIDES + i, base + SIDES + j, apex);
    }
    vc += SIDES * 2 + 1;
  }
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    stopCount: stops.length,
  };
}

/** Flat annulus for the selection ground ring, centered on a stop. */
export function buildRingBuffers(stop, { inner = 26, outer = 38, y = STOP_BASE_Y + 1 } = {}) {
  const positions = [];
  const colors = [];
  const indices = [];
  const SEG = 28;
  for (let i = 0; i < SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    positions.push(stop.x + Math.cos(a) * inner, y, stop.z + Math.sin(a) * inner);
    colors.push(1, 1, 1);
    positions.push(stop.x + Math.cos(a) * outer, y, stop.z + Math.sin(a) * outer);
    colors.push(1, 1, 1);
  }
  for (let i = 0; i < SEG; i++) {
    const j = (i + 1) % SEG;
    indices.push(i * 2, j * 2, j * 2 + 1);
    indices.push(i * 2, j * 2 + 1, i * 2 + 1);
  }
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}

/** Name stem for label dedupe and facility grouping: bay-stripped, lowercased. */
export function baseName(name) {
  return String(name ?? "")
    .replace(/\s*[-–—]?\s*bay\s+\d+\b.*$/i, "")
    .toLowerCase()
    .trim();
}
