/**
 * LTD rebuild — stop labels (Tranche T5, P-31).
 *
 * Prominence tiers: 0 = anchors, 1 = transfer points, 2 = live
 * single-route stops, 3 = the remaining governed stops. A stop's
 * weight is the number of routes serving it — the only weight the
 * registry data carries: tier 0 at weight >= 4, plus every People
 * Mover station (the station set is host-supplied; the rebuild's
 * data plane carries no People Mover asset yet — see the T5
 * record); tier 1 at weight 2–3 (routes meet = a transfer point);
 * tier 2 is dynamic, a single-route stop whose route has a live
 * vehicle right now.
 *
 * Distance bands: beyond 13,000 m only tier 0 shows; 7,000–13,000 m
 * adds tier 1; at or below 7,000 m all tiers show. Cap 12. One
 * label per name stem per place: a kept label suppresses any
 * same-stem stop within 600 m. Pill world height is
 * camDist x 0.0215. In street view the set changes character: the
 * nearest 8 stops within 1 km, at height 44 m, with screen-space
 * collision — collided labels drop in priority order.
 *
 * Textures live in an LRU capped at 512 (R-15). The selection math
 * is pure; sprite anchoring belongs to the assembly, the same
 * split T3/T4 use. `rectsFor` produces the screen rectangles the
 * street-label system consumes as collision input (labels.mjs).
 */

import { LruCache, STOP_LABEL_TEXTURE_CAP } from "./labels.mjs";
import { baseName, labelAnchorY, stopScale } from "./stops.mjs";

export const STOP_LABEL_MAX = 12;
export const STOP_LABEL_FAR_M = 13000;
export const STOP_LABEL_MID_M = 7000;
export const PILL_HEIGHT_RATE = 0.0215;
export const STEM_DEDUPE_M = 600;
export const STREET_VIEW_SET_COUNT = 8;
export const STREET_VIEW_SET_RADIUS_M = 1000;
export const STREET_VIEW_LABEL_Y = 44;

export function tierSetFor(camDist) {
  if (camDist > STOP_LABEL_FAR_M) return new Set([0]);
  if (camDist > STOP_LABEL_MID_M) return new Set([0, 1]);
  return new Set([0, 1, 2, 3]);
}

export function stopTier(stop, { pmStations = new Set(), liveRoutes = new Set() } = {}) {
  const routes = stop.routes ?? [];
  if (routes.length >= 4 || pmStations.has(stop.stop_id)) return 0;
  if (routes.length >= 2) return 1;
  if (routes.length === 1 && liveRoutes.has(routes[0])) return 2;
  return 3;
}

export class StopLabels {
  /** stops: governed stop records (registry shape: x, z, name, routes). */
  constructor(stops, { pmStations = new Set() } = {}) {
    this.stops = stops;
    this.pmStations = pmStations;
    this.textures = new LruCache(STOP_LABEL_TEXTURE_CAP);
  }

  select({ camX, camZ, camDist, mode = "orbit", liveRoutes = new Set() }) {
    const tiers = tierSetFor(camDist);
    const scale = stopScale(camDist, mode);
    const scored = [];
    for (const stop of this.stops) {
      const tier = stopTier(stop, { pmStations: this.pmStations, liveRoutes });
      if (!tiers.has(tier)) continue;
      scored.push({ stop, tier, d: Math.hypot(stop.x - camX, stop.z - camZ) });
    }
    scored.sort((a, b) => (a.tier - b.tier) || (a.d - b.d) || (a.stop.idx - b.stop.idx));
    const kept = [];
    for (const cand of scored) {
      if (kept.length >= STOP_LABEL_MAX) break;
      const stem = baseName(cand.stop.name);
      const clash = kept.some(
        (k) => baseName(k.stop.name) === stem
          && Math.hypot(k.stop.x - cand.stop.x, k.stop.z - cand.stop.z) <= STEM_DEDUPE_M,
      );
      if (clash) continue;
      kept.push(cand);
    }
    return kept.map(({ stop, tier }) => ({
      stop,
      tier,
      anchorY: labelAnchorY(stop, scale),
      pillHeightM: camDist * PILL_HEIGHT_RATE,
    }));
  }

  /**
   * Street-view set: the nearest stops within 1 km, at height
   * 44 m, at most 8, screen-collided when a projector is supplied.
   * `sizeOf(name)` returns the label's pixel size.
   */
  selectStreetView({ camX, camZ, project = null, sizeOf = () => ({ w: 120, h: 28 }) }) {
    const near = this.stops
      .map((stop) => ({ stop, d: Math.hypot(stop.x - camX, stop.z - camZ) }))
      .filter(({ d }) => d <= STREET_VIEW_SET_RADIUS_M)
      .sort((a, b) => (a.d - b.d) || (a.stop.idx - b.stop.idx));
    const kept = [];
    const rects = [];
    for (const { stop } of near) {
      if (kept.length >= STREET_VIEW_SET_COUNT) break;
      let rect = null;
      if (project) {
        const pt = project([stop.x, STREET_VIEW_LABEL_Y, stop.z]);
        if (!pt || pt.behind) continue;
        const { w, h } = sizeOf(stop.name);
        rect = { x: pt.x - w / 2, y: pt.y - h / 2, width: w, height: h };
        const hit = rects.some(
          (r) => rect.x < r.x + r.width && rect.x + rect.width > r.x
            && rect.y < r.y + r.height && rect.y + rect.height > r.y,
        );
        if (hit) continue;
        rects.push(rect);
      }
      kept.push({ stop, heightM: STREET_VIEW_LABEL_Y, rect });
    }
    return kept;
  }

  /** Screen rectangles for a shown set — the street-label collision input. */
  rectsFor(shown, project, sizeOf = () => ({ w: 120, h: 28 })) {
    const rects = [];
    for (const { stop, anchorY } of shown) {
      const pt = project([stop.x, anchorY, stop.z]);
      if (!pt || pt.behind) continue;
      const { w, h } = sizeOf(stop.name);
      rects.push({ x: pt.x - w / 2, y: pt.y - h / 2, width: w, height: h });
    }
    return rects;
  }
}

/** Wire stop-label selection into the renderer's frame loop (P-81: stopLabels stage). */
export function registerStopLabelStages(rendererApi, { onStopLabels }) {
  rendererApi.onStage("stopLabels", (ctx) => { if (onStopLabels) onStopLabels(ctx); });
}
