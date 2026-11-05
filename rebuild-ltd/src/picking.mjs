/**
 * LTD rebuild — stop picking (Tranche T3, R-41 / P-36).
 *
 * Stops are picked through a 64 m uniform grid: a pick query walks
 * only the cells its radius touches and runs the exact distance
 * test on those candidates — never a full-registry scan (the placed
 * fix took picks from 5.70 ms to <0.01 ms; a rebuild that
 * reintroduces full scans regresses it).
 *
 * The grid is built over the GOVERNED stop list the host passes in.
 * An empty governed list picks nothing — it never falls back to
 * all stops (P-36).
 */

export const PICK_CELL_M = 64;
export const PICK_RADII = { touch: 48, mouse: 26, stopTouch: 44, stopMouse: 22 };
export const CONTEST_MARGIN_PX = 6;

export class StopPickGrid {
  /** stops: [{ idx, x, z }] in scene metres. */
  constructor(stops) {
    this.cells = new Map();
    this.stops = stops;
    for (const s of stops) {
      const key = `${Math.floor(s.x / PICK_CELL_M)},${Math.floor(s.z / PICK_CELL_M)}`;
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key).push(s);
    }
  }

  get size() { return this.stops.length; }

  /** Candidate stops within radiusM of (x, z) — grid cells only. */
  candidates(x, z, radiusM) {
    const out = [];
    const cx0 = Math.floor((x - radiusM) / PICK_CELL_M);
    const cx1 = Math.floor((x + radiusM) / PICK_CELL_M);
    const cz0 = Math.floor((z - radiusM) / PICK_CELL_M);
    const cz1 = Math.floor((z + radiusM) / PICK_CELL_M);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const cell = this.cells.get(`${cx},${cz}`);
        if (cell) out.push(...cell);
      }
    }
    return out;
  }

  /**
   * Exact pick: the nearest governed stop within radiusM of the
   * ground point, or null. Distance is the exact point distance —
   * the grid only narrows the candidate set.
   */
  pick(x, z, radiusM) {
    let best = null, bestD = Infinity;
    for (const s of this.candidates(x, z, radiusM)) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d <= radiusM && d < bestD) { best = s; bestD = d; }
    }
    return best ? { stop: best, distanceM: bestD } : null;
  }
}

/**
 * Screen-space contest arbitration (P-36): candidates carry a
 * pixel distance to the tap point; a challenger must beat the
 * incumbent by the 6 px contest margin to take the pick, and ties
 * keep the incumbent (placed: ties keep the bus). Depth order is
 * the caller's input order among equals.
 */
export function arbitratePick(candidates) {
  if (!candidates.length) return null;
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.px < best.px - CONTEST_MARGIN_PX) best = c;
  }
  return best;
}
