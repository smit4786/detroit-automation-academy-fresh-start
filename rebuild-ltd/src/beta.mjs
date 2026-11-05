/**
 * LTD rebuild — the beta tiles (Tranche T6; P-72, P-73, P-74;
 * filed 2026-10-09, approved 2026-10-14, named toggles per
 * Justin's direction 2026-10-15).
 *
 * Three live-help features, each with its OWN named opt-in toggle
 * in the filter panel — the umbrella "Beta tiles" gate was
 * ambiguous, so the features are named and switched individually.
 * Each defaults OFF until the rider opts in; each choice persists
 * in its own key ('lt-stop-tiles', 'lt-upcoming-stops',
 * 'lt-suggest-transfer'). Migration: the retired umbrella key
 * 'lt-beta-tiles' is read once on first load — a feature with no
 * stored key of its own starts from the umbrella value, which is
 * then persisted under the feature's own key, and the umbrella
 * key is removed.
 *
 *   (1) Stop tiles: the stop card's live rows add the bus number.
 *     The rows already carry the vehicle id (arrivals.mjs); the
 *     suffix below is the whole feature. (T5's card model drops
 *     the id before rendering — carrying it through is the named
 *     one-field correction, DV-T6-2.)
 *   (2) Upcoming stops: the bus card lists the selected bus's
 *     next ≤ 6 stops with cumulative estimates from its matched
 *     arc position and the empirical segment speeds. Honest
 *     states in words: layover ("at the terminal between trips —
 *     its next trip leaves at {clock}"), unmatched ("off its
 *     mapped route right now"), terminus ("at the end of its
 *     trip — no more stops on this run"). Stops count as ahead
 *     only past the bus's arc + 25 m.
 *   (3) Suggest transfer: a planner tile ranking live buses still
 *     approaching stops near the trip origin by walk + wait,
 *     recomputed from live positions on every poll — dynamic
 *     rerouting from real-time intersecting-route ETAs, not
 *     scheduled times. A bus that has already passed the stop
 *     (stop arc ≤ bus arc + 10 m) is excluded by construction —
 *     the suggestion must be catchable. Origin = the From point,
 *     else the rider's located position. Top 4; a route that
 *     also stops within the radius of the destination is flagged
 *     as proximity — stated as proximity.
 *
 * Segment speeds ride the empirical-baseline provider seam
 * (H-02): `speedFor(routeId, seg)` returns m/s or null. No
 * baseline ships installed in this tranche — with no provider,
 * segments ride the tracker's own speed, then the 8.9 m/s
 * (~20 mph) fallback, exactly as placed. Walk speed 1.4 m/s is
 * the timetable's; the radius is NEAR_ME_M (1,250 m).
 */

export const BETA_KEYS = {
  stopTiles: "lt-stop-tiles",
  upcomingStops: "lt-upcoming-stops",
  suggestTransfer: "lt-suggest-transfer",
};
export const BETA_UMBRELLA_KEY = "lt-beta-tiles";
export const BETA_WALK_MPS = 1.4;
export const BETA_RADIUS_M = 1250;
export const BETA_FALLBACK_MPS = 8.9;
export const UPCOMING_AHEAD_EPS_M = 25;
export const UPCOMING_MAX = 6;
export const SUGGEST_PASSED_EPS_M = 10;
export const SUGGEST_MAX = 4;
export const SUGGEST_NOTE = "Live estimates from bus positions right now. The planner above uses scheduled times.";

function storageGet(storage, key) {
  try { return storage ? storage.getItem(key) : null; } catch { return null; }
}
function storageSet(storage, key, value) {
  try { if (storage) storage.setItem(key, value); } catch { /* session state stands */ }
}
function storageRemove(storage, key) {
  try { if (storage) storage.removeItem(key); } catch { /* nothing to remove */ }
}

export function createBetaSettings({ storage = null } = {}) {
  const umbrella = storageGet(storage, BETA_UMBRELLA_KEY);
  const init = (key) => {
    let v = storageGet(storage, key);
    if (v === null) {
      v = umbrella === "1" ? "1" : "0";
      storageSet(storage, key, v);
    }
    return v === "1";
  };
  const state = {
    stopTiles: init(BETA_KEYS.stopTiles),
    upcomingStops: init(BETA_KEYS.upcomingStops),
    suggestTransfer: init(BETA_KEYS.suggestTransfer),
  };
  if (umbrella !== null) storageRemove(storage, BETA_UMBRELLA_KEY);

  const api = {
    state: () => ({ ...state }),
    get: (feature) => !!state[feature],
    set(feature, on) {
      state[feature] = !!on;
      storageSet(storage, BETA_KEYS[feature], on ? "1" : "0");
      return state[feature];
    },
    toggle: (feature) => api.set(feature, !state[feature]),
    /** Toggle definitions for the panel: one aria-pressed row per feature. */
    toggleDefs: () => [
      { feature: "stopTiles", id: "stop-tiles-toggle", label: "Stop tiles" },
      { feature: "upcomingStops", id: "upcoming-stops-toggle", label: "Upcoming stops" },
      { feature: "suggestTransfer", id: "suggest-transfer-toggle", label: "Suggest transfer" },
    ],
  };
  return api;
}

/** (1) Stop tiles: the live row's bus-number suffix. */
export function stopTileSuffix(row, on) {
  if (!on || !row || row.tag !== "live" || !row.vehicleId) return "";
  return ` · Bus ${row.vehicleId}`;
}

export function betaMins(secs) {
  if (secs === null || secs === undefined) return "—";
  const m = Math.round(secs / 60);
  return m < 1 ? "<1 min" : `${m} min`;
}

/** Stop-to-stop segments of one path from the atlas's stop arc map. */
export function stopSegments(atlas, routeId, pathIdx) {
  const map = atlas.stopArcMap(routeId, pathIdx);
  if (!map) return [];
  const arcs = [...map.values()].sort((a, b) => a - b);
  const segs = [];
  for (let i = 0; i + 1 < arcs.length; i++) {
    if (arcs[i + 1] > arcs[i]) segs.push({ pathIdx, s0: arcs[i], s1: arcs[i + 1] });
  }
  return segs;
}

/**
 * Seconds to ride from arc s0 to s1 (s1 > s0), summing per-segment
 * times at the provider's empirical speeds; the stretch past the
 * last mapped segment rides at the fallback speed. null when
 * there is no segment coverage and no fallback speed to ride at.
 */
export function rideSecs({ segments = [], speedFor = null, routeId, pathIdx, s0, s1, fallbackMps = null }) {
  if (s1 <= s0) return 0;
  let covered = 0, secs = 0;
  for (const g of segments) {
    if (g.pathIdx !== pathIdx) continue;
    const a = Math.max(s0, g.s0), b = Math.min(s1, g.s1);
    if (b <= a) continue;
    const v = (speedFor ? speedFor(routeId, g) : null) || fallbackMps || BETA_FALLBACK_MPS;
    secs += (b - a) / v;
    covered += (b - a);
  }
  const fb = fallbackMps || BETA_FALLBACK_MPS;
  if (!covered && !fb) return null;
  if (covered < (s1 - s0) - 1) secs += ((s1 - s0) - covered) / fb;
  return secs;
}

/**
 * (2) Upcoming stops for one vehicle. Inputs:
 *   trackerView { arcS, pathIdx, speedMps } | null — the tracker's
 *     predicted arc state (surfaces read predictions, contract 10)
 *   binding { layover: { clock } } | null — the ride host's trip
 *     state (T7); a layover-bound bus is between trips.
 *   stopsByIdx: Map stop idx -> registry stop (for names)
 */
export function upcomingStops({ vehicle, trackerView, atlas, stopsByIdx, binding = null, speedFor = null }) {
  if (binding && binding.layover) {
    return { state: "layover", clock: binding.layover.clock };
  }
  if (!trackerView || trackerView.pathIdx === null || trackerView.pathIdx === undefined || trackerView.arcS === null) {
    return { state: "unmatched" };
  }
  const { pathIdx } = trackerView;
  const smap = atlas.stopArcMap(vehicle.routeId, pathIdx);
  if (!smap) return { state: "unmatched" };
  const ups = [];
  for (const [idx, s] of smap) {
    if (s > trackerView.arcS + UPCOMING_AHEAD_EPS_M && stopsByIdx.has(idx)) {
      ups.push({ stop: stopsByIdx.get(idx), s });
    }
  }
  ups.sort((a, b) => a.s - b.s);
  if (!ups.length) return { state: "terminus" };
  const fb = trackerView.speedMps > 0.5 ? trackerView.speedMps : null;
  const segments = stopSegments(atlas, vehicle.routeId, pathIdx);
  const out = [];
  let cum = 0, prev = trackerView.arcS, okFlag = true;
  for (const u of ups.slice(0, UPCOMING_MAX)) {
    const leg = rideSecs({ segments, speedFor, routeId: vehicle.routeId, pathIdx, s0: prev, s1: u.s, fallbackMps: fb });
    if (leg === null) okFlag = false; else cum += leg;
    out.push({ name: u.stop.name || "Stop", secs: okFlag ? cum : null });
    prev = u.s;
  }
  return { state: "ok", stops: out };
}

export function upcomingNoteText(model) {
  if (!model) return null;
  switch (model.state) {
    case "terminus": return "This bus is at the end of its trip — no more stops on this run.";
    case "layover": return `This bus is at the terminal between trips — its next trip leaves at ${model.clock}.`;
    case "unmatched": return "This bus is off its mapped route right now, so its upcoming stops cannot be estimated.";
    default: return null;
  }
}

/**
 * (3) Suggest transfer. Inputs:
 *   origin { x, z } | null (From point, else the located position)
 *   destination { x, z } | null (for the near-destination flag)
 *   stops: registry stop records (x, z, routes)
 *   vehicles: normalized vehicle records
 *   trackerViewFor(vehicle) -> { arcS, pathIdx, speedMps } | null
 */
export function suggestTransfers({ origin, destination = null, stops, vehicles, trackerViewFor, atlas, speedFor = null, names }) {
  if (!origin) return { state: "no-origin", options: [] };
  if (!stops || !vehicles) return { state: "no-data", options: [] };

  const near = new Map(); // rid -> [{ stop, dist }] nearest first
  for (const st of stops) {
    const d = Math.hypot(st.x - origin.x, st.z - origin.z);
    if (d > BETA_RADIUS_M) continue;
    for (const rid of st.routes ?? []) {
      const key = String(rid);
      if (!near.has(key)) near.set(key, []);
      near.get(key).push({ stop: st, dist: d });
    }
  }
  for (const list of near.values()) list.sort((a, b) => a.dist - b.dist);

  const destNear = new Set();
  if (destination) {
    for (const st of stops) {
      if (Math.hypot(st.x - destination.x, st.z - destination.z) > BETA_RADIUS_M) continue;
      for (const rid of st.routes ?? []) destNear.add(String(rid));
    }
  }

  const segmentsByRoutePath = new Map();
  const segmentsFor = (rid, pathIdx) => {
    const key = `${rid}|${pathIdx}`;
    if (!segmentsByRoutePath.has(key)) segmentsByRoutePath.set(key, stopSegments(atlas, rid, pathIdx));
    return segmentsByRoutePath.get(key);
  };

  const out = [];
  for (const [rid, cands] of near) {
    let best = null;
    for (const cand of cands) {
      if (best) break; // the tile boards at the nearest stop a live bus still approaches
      for (const v of vehicles) {
        if (String(v.routeId) !== rid) continue;
        const tv = trackerViewFor(v);
        if (!tv || tv.pathIdx === null || tv.pathIdx === undefined) continue;
        const ss = atlas.stopArc(rid, tv.pathIdx, cand.stop.idx);
        if (ss === null || ss <= tv.arcS + SUGGEST_PASSED_EPS_M) continue; // already passed: excluded by construction
        const eta = rideSecs({
          segments: segmentsFor(rid, tv.pathIdx), speedFor,
          routeId: rid, pathIdx: tv.pathIdx, s0: tv.arcS, s1: ss,
          fallbackMps: tv.speedMps > 0.5 ? tv.speedMps : null,
        });
        if (eta === null) continue;
        const walk = cand.dist / BETA_WALK_MPS;
        const total = walk + eta;
        if (!best || total < best.total) {
          best = { v, eta, total, stop: cand.stop, walk };
        }
      }
    }
    if (best) {
      out.push({
        routeId: rid, stop: best.stop, walk: best.walk, eta: best.eta,
        total: best.total, bus: best.v.vehicleId, nearDest: destNear.has(rid),
      });
    }
  }
  out.sort((a, b) => a.total - b.total);
  const options = out.slice(0, SUGGEST_MAX).map((op) => ({
    ...op,
    title: `${names.label(op.routeId)} · Bus ${op.bus} at ${op.stop.name || "stop"}`,
    timesText: `bus ~${betaMins(op.eta)} · ${betaMins(op.walk)} walk`,
    ariaLabel: `Begin trip: board ${names.label(op.routeId)} bus ${op.bus} at ${op.stop.name || "stop"}`,
    nearDestText: op.nearDest ? `Route ${names.label(op.routeId)} also stops near your destination.` : null,
  }));
  return { state: "ok", options };
}

export function suggestNoteText(model) {
  if (!model) return null;
  if (model.state === "no-origin") return "Set a From point — or tap Locate — so this tile can work from where you are.";
  if (model.state !== "ok" || !model.options.length) return "No live buses are approaching stops near the start point right now.";
  return null;
}

/* ---- rendering (nodes + textContent only, R-44) ---- */

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}
function on(node, type, fn) {
  if (node && typeof node.addEventListener === "function") node.addEventListener(type, fn);
}

/** The bus card's upcoming-stops section (renderUpcoming for bus-card.mjs). */
export function renderUpcomingStops(model, doc) {
  const host = el(doc, "div", "bus-upcoming");
  host.setAttribute("id", "bus-upcoming");
  const list = el(doc, "div", "bus-upcoming-list");
  const note = upcomingNoteText(model);
  if (!model || model.state !== "ok") {
    if (note) list.appendChild(el(doc, "p", "beta-note", note));
    host.appendChild(list);
    return host;
  }
  model.stops.forEach((u, i) => {
    const row = el(doc, "div", "beta-row");
    row.appendChild(el(doc, "b", null, `${i === 0 ? "Next: " : ""}${u.name}`));
    row.appendChild(el(doc, "span", null, `~${betaMins(u.secs)}`));
    list.appendChild(row);
  });
  host.appendChild(list);
  return host;
}

/** The planner's suggest-transfer tile; row taps hand the stop back to the host. */
export function renderSuggestTile(model, doc, { onPick = null } = {}) {
  const host = el(doc, "div", "suggest-tile");
  host.setAttribute("id", "suggest-tile");
  host.appendChild(el(doc, "p", "suggest-note", SUGGEST_NOTE));
  const list = el(doc, "div", "suggest-list");
  const note = suggestNoteText(model);
  if (note) {
    list.appendChild(el(doc, "p", "beta-note", note));
    host.appendChild(list);
    return host;
  }
  for (const op of model.options) {
    const row = el(doc, "button", "beta-row beta-suggest-row");
    row.setAttribute("type", "button");
    row.setAttribute("aria-label", op.ariaLabel);
    row.appendChild(el(doc, "b", null, op.title));
    row.appendChild(el(doc, "span", null, op.timesText));
    on(row, "click", () => onPick?.(op));
    list.appendChild(row);
    if (op.nearDestText) list.appendChild(el(doc, "div", "beta-sub", op.nearDestText));
  }
  host.appendChild(list);
  return host;
}
