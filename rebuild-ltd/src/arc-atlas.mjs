/**
 * LTD rebuild — the arc atlas (Tranche T4, M6 substrate).
 *
 * Every live-vehicle computation in the app speaks one language:
 * arc metres along a route's path. This module builds that
 * language from the T1 data plane — per route, per path: the
 * polyline's cumulative arc lengths, point projection (arc +
 * off-path distance), arc→point lookup, and the arc position of
 * every registry stop the path serves. The tracker dead-reckons in
 * arc space; the matcher scores in arc space; neither touches raw
 * lat/lon after ingest.
 *
 * Geometry comes only from the derived assets (GTFS shapes via
 * derive/02_routes.py) — the atlas invents nothing (R-14). A stop
 * counts as mapped onto a path when its perpendicular distance to
 * the polyline is within STOP_MAP_TOLERANCE_M; stops farther off
 * the line are simply not on that path (branch paths carry their
 * own stops).
 */

export const M_PER_DEG = 111320;
export const STOP_MAP_TOLERANCE_M = 75;

/** Project a lat/lon through the registry's tangent plane. */
export function projectLatLon(projection, lat, lon) {
  const { lat0, lon0 } = projection;
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  return [(lon - lon0) * kx, (lat0 - lat) * M_PER_DEG];
}

function pathMetrics(points) {
  const cum = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return { points, cum, length: cum[points.length - 1] ?? 0 };
}

/** Nearest point on one path: { arc, dist, seg, t }. */
function projectOnPath(pm, x, z) {
  const { points, cum } = pm;
  let best = { arc: 0, dist: Infinity, seg: 0, t: 0 };
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[i + 1];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, pz = az + dz * t;
    const dist = Math.hypot(x - px, z - pz);
    if (dist < best.dist) {
      best = { arc: cum[i] + Math.sqrt(len2) * t, dist, seg: i, t };
    }
  }
  return best;
}

/** Point + heading (degrees, 0 = north, clockwise) at an arc. */
function pointOnPath(pm, arc) {
  const { points, cum, length } = pm;
  const a = Math.max(0, Math.min(length, arc));
  let i = 0;
  while (i + 2 < points.length && cum[i + 1] < a) i++;
  if (i + 1 >= points.length) i = points.length - 2;
  const segLen = cum[i + 1] - cum[i];
  const t = segLen > 0 ? (a - cum[i]) / segLen : 0;
  const [ax, az] = points[i];
  const [bx, bz] = points[i + 1];
  const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
  // z grows southward in scene space: heading from the (east, south) vector.
  const heading = (Math.atan2(bx - ax, -(bz - az)) * 180) / Math.PI;
  return { x, z, heading: (heading + 360) % 360 };
}

export function buildArcAtlas(registry, { stopToleranceM = STOP_MAP_TOLERANCE_M } = {}) {
  const routes = new Map(); // routeId -> { paths: [pm], stopArc: [Map idx -> arc] }

  // Registry exposes routes through its own doors; iterate the
  // stops once per route instead of scanning per path.
  const routeIds = new Set();
  for (let i = 0; i < registry.count; i++) {
    const stop = registry.stopAt(i);
    if (stop) for (const rid of stop.routes ?? []) routeIds.add(String(rid));
  }

  for (const rid of routeIds) {
    const route = registry.routeById(rid);
    if (!route || !Array.isArray(route.paths) || !route.paths.length) continue;
    const paths = route.paths.map((pts) => pathMetrics(pts));
    const stops = registry.stopsForRoute(rid);
    const stopArc = paths.map((pm) => {
      const map = new Map();
      for (const stop of stops) {
        const p = projectOnPath(pm, stop.x, stop.z);
        if (p.dist <= stopToleranceM) map.set(stop.idx, p.arc);
      }
      return map;
    });
    routes.set(rid, { paths, stopArc });
  }

  return {
    hasRoute(routeId) {
      return routes.has(String(routeId));
    },
    pathCount(routeId) {
      return routes.get(String(routeId))?.paths.length ?? 0;
    },
    pathLength(routeId, pathIdx) {
      return routes.get(String(routeId))?.paths[pathIdx]?.length ?? 0;
    },
    /** Map-match a scene point onto the route's best path. */
    mapMatch(routeId, x, z) {
      const entry = routes.get(String(routeId));
      if (!entry) return null;
      let best = null;
      entry.paths.forEach((pm, pathIdx) => {
        const p = projectOnPath(pm, x, z);
        if (!best || p.dist < best.dist) best = { pathIdx, arc: p.arc, dist: p.dist };
      });
      return best;
    },
    project(routeId, pathIdx, x, z) {
      const pm = routes.get(String(routeId))?.paths[pathIdx];
      return pm ? projectOnPath(pm, x, z) : null;
    },
    pointAt(routeId, pathIdx, arc) {
      const pm = routes.get(String(routeId))?.paths[pathIdx];
      return pm ? pointOnPath(pm, arc) : null;
    },
    /** Arc of a registry stop on one path; null when not served by it. */
    stopArc(routeId, pathIdx, stopIdx) {
      const map = routes.get(String(routeId))?.stopArc[pathIdx];
      if (!map || !map.has(stopIdx)) return null;
      return map.get(stopIdx);
    },
    stopArcMap(routeId, pathIdx) {
      return routes.get(String(routeId))?.stopArc[pathIdx] ?? null;
    },
  };
}
