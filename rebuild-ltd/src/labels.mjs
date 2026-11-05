/**
 * LTD rebuild — label systems (Tranche T3, M5 labels).
 *
 * Street labels (P-09): a pooled set of sprites, at most 6 shown,
 * distance classes by tier with the CODE values (R-47: major
 * <10,000 m / local <5,000 m), 1.3x hysteresis, stable order,
 * collision-tested against externally supplied rectangles (stop
 * labels, T5). Textures live in an LRU capped at 256 (R-15).
 *
 * Route labels (P-10): name pills at the midpoint of each route's
 * longest path, y 1050, tethered to the deck; shown only while the
 * route has a live bus, at camera distance > 7,000 m, and passing
 * near-me gating. Live state arrives from T4 via setRouteLive —
 * this module owns placement and the gate, not the feed.
 */

export class LruCache {
  constructor(cap) {
    this.cap = cap;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
  has(key) { return this.map.has(key); }
  get size() { return this.map.size; }
}

export const STREET_LABEL_TEXTURE_CAP = 256; // R-15
export const STOP_LABEL_TEXTURE_CAP = 512; // R-15 (consumed by T5)
export const STREET_LABEL_POOL = 14;
export const STREET_LABEL_MAX_SHOWN = 6;
export const STREET_LABEL_BANDS = { major: 10000, local: 5000 }; // R-47 code values
export const HYSTERESIS = 1.3;

export class StreetLabels {
  /**
   * anchors: [{ name, x, z, tier }] — tier 0/1 = major, 2 = local
   * (the T1 street-names derivation's tier ranks).
   */
  constructor(anchors) {
    this.anchors = anchors;
    this.shown = new Set(); // anchor indices currently displayed
    this.textures = new LruCache(STREET_LABEL_TEXTURE_CAP);
  }

  bandFor(anchor) {
    return anchor.tier <= 1 ? STREET_LABEL_BANDS.major : STREET_LABEL_BANDS.local;
  }

  /** Distance from a point to an anchor, in the ground plane. */
  static dist(anchor, cx, cz) {
    return Math.hypot(anchor.x - cx, anchor.z - cz);
  }

  /**
   * Choose the shown set. Stable order: already-shown labels keep
   * priority (they hold until distance x 1.3 past their band), then
   * nearest first by tier. Collision rects (screen-space, supplied
   * by the caller from stop labels) veto an anchor whose projected
   * point falls inside one.
   */
  select({ camX, camZ, camDist, project = null, avoidRects = [] }) {
    const scored = this.anchors.map((a, i) => ({
      i, a, d: StreetLabels.dist(a, camX, camZ),
    }));
    const eligible = scored.filter(({ i, a, d }) => {
      const band = this.bandFor(a);
      const limit = this.shown.has(i) ? band * HYSTERESIS : band;
      return camDist < limit && d < limit;
    });
    // Priority is proximity (nearest first); tier breaks ties.
    // A far major must not evict the street the rider is looking at.
    eligible.sort((p, q) => (p.d - q.d) || (p.a.tier - q.a.tier) || (p.i - q.i));
    const next = new Set();
    for (const { i, a } of eligible) {
      if (next.size >= STREET_LABEL_MAX_SHOWN) break;
      if (project) {
        const pt = project([a.x, 60, a.z]);
        if (pt && !pt.behind && avoidRects.some((r) =>
          pt.x >= r.x && pt.x <= r.x + r.width && pt.y >= r.y && pt.y <= r.y + r.height)) {
          continue;
        }
      }
      next.add(i);
    }
    this.shown = next;
    return [...next].map((i) => this.anchors[i]);
  }
}

export const ROUTE_LABEL_Y = 1050;
export const ROUTE_LABEL_MIN_DIST = 7000;

/** The P-10 gate, exactly: live bus + distance + near-me gating. */
export function routeLabelVisible({ hasLiveBus, camDist, nearMePasses }) {
  return !!hasLiveBus && camDist > ROUTE_LABEL_MIN_DIST && !!nearMePasses;
}
