/**
 * LTD rebuild — scene projection (contract constants).
 *
 * The map world is a local tangent plane in metres anchored at the
 * origin every estate asset shares (measured off the settled
 * assets in T1; the same constants live in lib/proj.py for the
 * derivation pipeline). x grows east, z grows south.
 */

export const LAT0 = 42.381161;
export const LON0 = -83.148531;
export const M_LAT = 111320.0;
export const M_LON = M_LAT * Math.cos((LAT0 * Math.PI) / 180);

export function toWorld(lat, lon) {
  return [(lon - LON0) * M_LON, (LAT0 - lat) * M_LAT];
}

export function toGeodetic(x, z) {
  return [LAT0 - z / M_LAT, LON0 + x / M_LON];
}

/** R-01 bounds of record. */
export const STREET_BOUNDS = { lonW: -83.3431083, lonE: -82.8992288, latS: 42.25539743550126, latN: 42.47997522924901 };
export const MOSAIC_BOUNDS = { lonW: -83.385, lonE: -82.8992288, latS: 42.178, latN: 42.47997522924901 };

export function boundsRect({ lonW, lonE, latS, latN }) {
  const [x0, z0] = toWorld(latN, lonW);
  const [x1, z1] = toWorld(latS, lonE);
  return { x0, z0, x1, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, width: x1 - x0, depth: z1 - z0 };
}
