/**
 * M8 — Journey planner host (clean-room rebuild, Tranche T7).
 *
 * The host around T2's engine: endpoint coverage mapping and
 * location seeding (the API host's seeding of record, P-51 host
 * half), snapshot/rollback run discipline (R-23 host half: a failed
 * or over-budget plan restores the previous results and says why),
 * live re-plans on each vehicle poll that keep the rider's
 * selection and never move the camera (P-45), the results models —
 * provenance lines (P-42), option cards and leg detail (P-44) —
 * plan deep links (P-48), and rider guidance with the R-22 fence:
 * guidance fires only on live evidence, an arrival is declared
 * only when the final leg has actually passed or its live-adjusted
 * time is genuinely gone, and no guidance is silence, never a
 * banner invented from nothing.
 *
 * Owner ordering (standing preference, confirmed 2026-11-03):
 * journeys present by earliest arrival — the optimum leads even at
 * two transfers; transfer count is not a penalty. The DDOT 10
 * preference is carried as an annotation with its time cost shown;
 * it never displaces the optimum from the lead.
 *
 * The engine plans in-process, so the host is synchronous end to
 * end; the engine's own budgets (750 ms user / 250 ms background)
 * still govern every run. Alert content is a provider slot (T8):
 * with no provider the detail model carries no alert lines.
 */

import { formatClock, DELAY_PROJECTION } from "./engine.mjs";
import { applyTripFusion } from "./fusion.mjs";
import { projectLatLon } from "./arc-atlas.mjs";

export const WALK_MPS = 1.4;
export const SEED_RADIUS_M = 400;
export const SEED_CAP = 12;
export const SEED_MIN_WALK_S = 60;
export const BUDGET_USER_MS = 750;
export const BUDGET_BACKGROUND_MS = 250;
export const PREFERRED_ROUTE = "10";

export const SVC_NAMES = { "1": "Sunday", "2": "Saturday", "3": "Weekday" };

export const TEXT_PICK =
  "Pick an origin and destination to see scheduled trips.";
export const TEXT_UNCOVERED =
  "One of these stops is not on a DDOT or SMART route, and no covered stop is within a short walk of it. The scheduled planner covers DDOT and SMART scheduled routes; QLINE stops share the map and the stop search.";
export const TEXT_NO_SERVICE = "No scheduled service at this time.";
export const TEXT_NO_ORIGIN =
  "No DDOT or SMART stop is within a short walk of the start point. The scheduled planner covers DDOT and SMART scheduled routes.";
export const TEXT_NO_TRIP =
  "No scheduled trip found between these stops right now. Try a different pair or time.";
export const TEXT_BUDGET =
  "That trip is taking too long to plan. Try a nearer destination, or check your connection and try again.";
export const MISSED_COOLDOWN_MS = 5 * 60 * 1000;

export function secondsOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

function stopName(registry, idx) {
  const s = registry.stopAt(idx);
  return s ? s.name : "Stop";
}

/* ---------------------------------------------------------------- */
/* Coverage + seeding (P-51 host half)                               */
/* ---------------------------------------------------------------- */

/**
 * Every registry stop within SEED_RADIUS_M of a point, nearest
 * first, capped — the location seed set of record. Walk seconds
 * carry the 60 s floor.
 */
export function seedsForPoint(registry, x, z) {
  const out = [];
  for (let i = 0; i < registry.count; i++) {
    const s = registry.stopAt(i);
    if (!s) continue;
    const d = Math.hypot(s.x - x, s.z - z);
    if (d <= SEED_RADIUS_M) {
      out.push({
        stop: i,
        walk: Math.max(SEED_MIN_WALK_S, Math.round(d / WALK_MPS)),
        dist: d,
      });
    }
  }
  out.sort((a, b) => a.walk - b.walk || a.stop - b.stop);
  return out.slice(0, SEED_CAP).map(({ stop, walk }) => ({ stop, walk }));
}

/**
 * The covered stop for an endpoint stop index: itself when the
 * timetable covers it, else the nearest covered stop strictly
 * within 400 m, else null (uncovered). A covered-through-walk
 * endpoint carries its walk seconds; the stop itself walks 0.
 */
export function coveredStopIdx(registry, coveredCount, idx) {
  if (idx == null || idx < 0) return null;
  if (idx < coveredCount) return { idx, walkS: 0 };
  const s = registry.stopAt(idx);
  if (!s) return null;
  let best = -1;
  let bd = SEED_RADIUS_M;
  for (let j = 0; j < coveredCount; j++) {
    const c = registry.stopAt(j);
    if (!c) continue;
    const d = Math.hypot(c.x - s.x, c.z - s.z);
    if (d < bd) {
      bd = d;
      best = j;
    }
  }
  if (best < 0) return null;
  return {
    idx: best,
    walkS: Math.max(SEED_MIN_WALK_S, Math.round(bd / WALK_MPS)),
  };
}

/**
 * Engine arguments for an endpoint pair, or null when either end
 * is an uncovered stop (the host then speaks the uncovered text).
 * A location origin with no stops in reach yields an empty seed
 * set — the engine answers 'no-origin', a different sentence.
 */
export function planArgs(registry, coveredCount, from, to) {
  if (!from || !to || to.kind !== "stop") return null;
  const dest = coveredStopIdx(registry, coveredCount, to.idx);
  if (!dest) return null;
  if (from.kind === "loc") {
    return { seeds: seedsForPoint(registry, from.x, from.z), destIdx: dest.idx };
  }
  const cov = coveredStopIdx(registry, coveredCount, from.idx);
  if (!cov) return null;
  return { seeds: [{ stop: cov.idx, walk: cov.walkS }], destIdx: dest.idx };
}

/* ---------------------------------------------------------------- */
/* Journey presentation (P-42, P-44)                                 */
/* ---------------------------------------------------------------- */

/** The re-plan selection key: bus legs by route and stops. */
export function journeySig(j) {
  return j.legs
    .map((l) => (l.type === "bus" ? `b${l.routeId}@${l.board}>${l.alight}` : "w"))
    .join("|");
}

/** Consecutive walk legs merge into one presentation leg. */
export function mergeWalkLegs(legs) {
  const out = [];
  for (const l of legs) {
    const p = out[out.length - 1];
    if (l.type === "walk" && p && p.type === "walk") {
      p.to = l.to;
      p.secs += l.secs;
    } else {
      out.push({ ...l });
    }
  }
  return out;
}

const PROV_RANK = { scheduled: 0, empirical: 1, live: 2 };
export const PROV_WORD = { live: "live", empirical: "typical", scheduled: "scheduled" };
export const PROV_LABEL = {
  live: "Live delays",
  empirical: "Typical times",
  scheduled: "Scheduled times",
};

/** Strongest leg provenance wins the header (live > typical > scheduled). */
export function provenanceOf(journeys) {
  let best = "scheduled";
  for (const j of journeys) {
    for (const l of j.legs) {
      if (l.type === "bus" && PROV_RANK[l.provenance ?? "scheduled"] > PROV_RANK[best]) {
        best = l.provenance;
      }
    }
  }
  return best;
}

/** One leg's provenance sentence for the detail rows. */
export function legProvenanceLabel(leg, nowMs) {
  if (leg.disrupted) return "disrupted · times as scheduled";
  if (leg.provenance === "live") {
    const d = leg.delaySec || 0;
    let dtxt;
    if (Math.abs(d) <= 60) dtxt = "on time";
    else if (Math.round(d / 60) > 0) dtxt = `+${Math.round(d / 60)} min late`;
    else dtxt = `${Math.round(d / 60)} min early`;
    const stamp = leg.delayFixStamp || leg.delayStamp;
    if (stamp) {
      const ageS = Math.max(0, Math.round((nowMs - stamp) / 1000));
      const age = ageS < 90 ? `${ageS}s` : `${Math.round(ageS / 60)} min`;
      return `${dtxt} · live ${age} old`;
    }
    return dtxt;
  }
  if (leg.provenance === "empirical") return "typical time";
  return "scheduled";
}

function walkSecsOf(j) {
  return j.legs.reduce((a, l) => a + (l.type === "walk" ? l.secs : 0), 0);
}

/**
 * Owner ordering: earliest arrival leads; ties break by fewer
 * transfers, then less walking (the engine's criteriaFor earliest
 * chain). Returns a new array; the input is not mutated.
 */
export function orderByArrival(journeys) {
  return [...journeys].sort(
    (a, b) =>
      a.arriveSec - b.arriveSec ||
      a.transfers - b.transfers ||
      walkSecsOf(a) - walkSecsOf(b),
  );
}

/**
 * The DDOT 10 preference, annotated not re-ranked: the earliest
 * route-10 journey in the ordered list, with the minutes it costs
 * against the lead (0 when it is the lead or ties it).
 */
export function route10Preference(ordered) {
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].legs.some((l) => l.type === "bus" && l.routeId === PREFERRED_ROUTE)) {
      return {
        journeyIndex: i,
        costMin: Math.max(0, Math.round((ordered[i].arriveSec - ordered[0].arriveSec) / 60)),
        lead: i === 0,
      };
    }
  }
  return null;
}

function chipLabel(names, leg) {
  return leg.agency === "SMART" ? `SMART ${leg.routeId}` : names.label(leg.routeId);
}

/** Option-card chips over the merged legs, waits labeled ≥ 1 min. */
export function optionChips(registry, names, journey) {
  const chips = [];
  let cursor = journey.departSec;
  for (const l of mergeWalkLegs(journey.legs)) {
    if (l.type === "walk") {
      chips.push({ kind: "walk", text: `walk ${Math.max(1, Math.round(l.secs / 60))}m` });
      cursor += l.secs;
    } else {
      const waitMin = Math.round((l.boardSec - cursor) / 60);
      if (waitMin >= 1) chips.push({ kind: "wait", text: `wait ${waitMin}m` });
      chips.push({
        kind: "bus",
        routeId: l.routeId,
        label: chipLabel(names, l),
        color: l.color ?? null,
      });
      cursor = l.alightSec;
    }
  }
  return chips;
}

export function optionModel(registry, names, j, index, selected, preference) {
  const parts = [];
  parts.push(
    j.nBus === 0
      ? "Walk"
      : j.transfers === 0
        ? "Direct"
        : j.transfers === 1
          ? "1 transfer"
          : `${j.transfers} transfers`,
  );
  parts.push(`${j.walkMin} min walk`);
  const live = j.legs.reduce((a, l) => a + (l.liveVehicles || 0), 0);
  if (live > 0) parts.push(`${live} live`);
  parts.push(
    j.legs.some((l) => l.type === "bus" && l.disrupted)
      ? "disrupted"
      : PROV_LABEL[provenanceOf([j])].toLowerCase(),
  );
  return {
    index,
    selected,
    durationMin: j.durationMin,
    departClock: j.departClock,
    arriveClock: j.arriveClock,
    sub: parts.join(" · "),
    chips: optionChips(registry, names, j),
    preference: preference && preference.journeyIndex === index ? preference : null,
  };
}

/* ---------------------------------------------------------------- */
/* Deep links (P-48)                                                 */
/* ---------------------------------------------------------------- */

export function sanitizeLinkLabel(s) {
  if (s == null) return "";
  return String(s)
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function parseLatLon(raw) {
  const parts = String(raw).split(",");
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/**
 * Parse a plan deep link. Only a query carrying the `plan` flag
 * counts; each piece validates on its own and a malformed piece is
 * ignored, never fatal. The destination resolves to the nearest
 * registry stop overall; the origin stays a location. Coordinates
 * never leave the device — this is parsing, not reporting.
 */
export function parsePlanLink(registry, search) {
  const params = new URLSearchParams(search || "");
  if (!params.has("plan")) return null;
  const out = {};
  const toRaw = params.get("to");
  if (toRaw) {
    const ll = parseLatLon(toRaw);
    if (ll) {
      const [x, z] = projectLatLon(registry.projection, ll.lat, ll.lon);
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < registry.count; i++) {
        const s = registry.stopAt(i);
        if (!s) continue;
        const d = (s.x - x) ** 2 + (s.z - z) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      if (best >= 0) {
        const label = sanitizeLinkLabel(params.get("label"));
        out.to = { kind: "stop", idx: best, ...(label ? { label } : {}) };
      }
    }
  }
  const fromRaw = params.get("from");
  if (fromRaw) {
    const ll = parseLatLon(fromRaw);
    if (ll) {
      const [x, z] = projectLatLon(registry.projection, ll.lat, ll.lon);
      const label = sanitizeLinkLabel(params.get("fromlabel"));
      out.from = { kind: "loc", x, z, ...(label ? { label } : {}) };
    }
  }
  return out.from || out.to ? out : null;
}

/* ---------------------------------------------------------------- */
/* The host                                                          */
/* ---------------------------------------------------------------- */

/**
 * createPlannerHost({ engine, registry, names,
 *   getVehicles = null,        // () => normalized vehicle records (fusion + counts)
 *   alerts = null,             // { forRoute(routeId) -> alert[] }  (T8 slot)
 *   live = null,               // { bindings, tracker, atlas }     (guidance)
 *   getRiderPos = null,        // () => { x, z } | null            (missed-transfer replan)
 *   liveForLeg = null,         // (leg) => vehicleId | null        (focus labels)
 *   routeOrder = null,         // [routeId, ...] renderer order    (fly heights)
 *   budgets = null,            // { user, background } ms — defaults are R-23's
 *   intents = {} })            // { onHighlight(j), onFly(model), onCloseDetail(), onFault(err) }
 * The budgets option exists so verification can measure this
 * host's behavior on hardware slower than the discipline assumes;
 * the shipped defaults are the R-23 values, never widened here.
 */
export function createPlannerHost({
  engine,
  registry,
  names,
  getVehicles = null,
  alerts = null,
  live = null,
  getRiderPos = null,
  liveForLeg = null,
  routeOrder = null,
  budgets = null,
  intents = {},
}) {
  const budgetUser = budgets && budgets.user ? budgets.user : BUDGET_USER_MS;
  const budgetBackground =
    budgets && budgets.background ? budgets.background : BUDGET_BACKGROUND_MS;
  const coveredCount = engine.index.stopCount;
  const ordinalOf = (routeId) => {
    if (!routeOrder) return 0;
    const i = routeOrder.indexOf(String(routeId));
    return i < 0 ? 0 : i;
  };

  let from = null;
  let to = null;
  let leaveMode = "now";
  let leaveTime = null; // 'HH:MM' when leaveMode === 'at'
  let journeys = [];
  let sel = -1;
  let lastMeta = null;
  let note = null; // rollback note attached to the current results
  let emptyText = TEXT_PICK;
  let guidanceDismissedSig = null;
  let missedCooldownUntil = 0;
  let banner = null;
  let planning = false;

  const selected = () => (sel >= 0 && sel < journeys.length ? journeys[sel] : null);

  function fuseInPlace(list) {
    if (!getVehicles) return;
    try {
      applyTripFusion({ journeys: list }, getVehicles());
    } catch {
      /* fusion never throws by contract; the guard is belt-and-braces */
    }
  }

  function tripWhen(nowMs) {
    if (leaveMode === "at" && leaveTime) {
      const [h, m] = leaveTime.split(":").map(Number);
      const d = new Date(nowMs);
      d.setHours(h || 0, m || 0, 0, 0);
      return d;
    }
    return new Date(nowMs);
  }

  function commitResults(res, orderedJourneys, nextSel) {
    journeys = orderedJourneys;
    sel = nextSel;
    lastMeta = res.meta;
    note = null;
    banner = null;
  }

  /**
   * Run a plan. User runs roll back with a spoken note on budget or
   * failure; the previous journeys, selection and guidance
   * dismissal survive untouched (the snapshot is simply never
   * committed over).
   */
  function plan(nowMs, { user = true } = {}) {
    if (planning) return { ok: false, reason: "busy" };
    if (!from || !to) {
      journeys = [];
      sel = -1;
      lastMeta = null;
      emptyText = TEXT_PICK;
      return { ok: false, reason: "no-endpoints" };
    }
    const args = planArgs(registry, coveredCount, from, to);
    if (!args) {
      journeys = [];
      sel = -1;
      lastMeta = null;
      emptyText = TEXT_UNCOVERED;
      return { ok: false, reason: "uncovered" };
    }
    planning = true;
    let res;
    try {
      res = engine.plan(args.seeds, args.destIdx, tripWhen(nowMs), {
        budgetMs: user ? budgetUser : budgetBackground,
      });
    } catch (err) {
      planning = false;
      note = `Could not plan the trip (${err && err.message}). Check your connection and try again.`;
      if (intents.onFault) intents.onFault(err);
      return { ok: false, reason: "error", note };
    }
    planning = false;
    if (res.meta && res.meta.reason === "budget") {
      note = TEXT_BUDGET;
      return { ok: false, reason: "budget", note };
    }
    const prevSig = selected() ? journeySig(selected()) : null;
    fuseInPlace(res.journeys);
    const ordered = orderByArrival(res.journeys);
    let nextSel = 0;
    if (!user && prevSig) {
      const k = ordered.findIndex((j) => journeySig(j) === prevSig);
      if (k >= 0) nextSel = k;
    }
    if (!ordered.length) nextSel = -1;
    commitResults(res, ordered, nextSel);
    if (user && selected() && intents.onHighlight) intents.onHighlight(selected());
    return { ok: true, journeys: ordered };
  }

  /**
   * P-45: the per-poll live re-plan. Leave-now queries only;
   * a budget hit, an uncovered endpoint or an engine fault keeps
   * the current results silently. Selection is preserved by
   * journey signature. No camera intent ever fires from here.
   */
  function replanLive(nowMs) {
    if (leaveMode !== "now" || !journeys.length || !from || !to) {
      return { kept: true, reason: "not-live" };
    }
    const args = planArgs(registry, coveredCount, from, to);
    if (!args) return { kept: true, reason: "uncovered" };
    let res;
    try {
      res = engine.plan(args.seeds, args.destIdx, new Date(nowMs), {
        budgetMs: budgetBackground,
      });
    } catch {
      return { kept: true, reason: "error" };
    }
    if (!res || (res.meta && res.meta.reason === "budget")) {
      return { kept: true, reason: "budget" };
    }
    const prevSig = selected() ? journeySig(selected()) : null;
    fuseInPlace(res.journeys);
    const ordered = orderByArrival(res.journeys);
    let nextSel = prevSig ? ordered.findIndex((j) => journeySig(j) === prevSig) : -1;
    if (nextSel < 0) nextSel = ordered.length ? 0 : -1;
    commitResults(res, ordered, nextSel);
    if (selected() && intents.onHighlight) intents.onHighlight(selected());
    return { kept: false, journeys: ordered };
  }

  /* ------------------------- results models ------------------------- */

  function detailModel(j, nowMs) {
    const rows = [];
    let alertTop = null;
    let dart = false;
    for (const leg of j.legs) {
      if (leg.type === "walk") {
        rows.push({
          kind: "walk",
          text: `Walk ${Math.max(1, Math.round(leg.secs / 60))} min`,
          fromName:
            leg.from === -1 || leg.fromLoc
              ? from && from.kind === "loc"
                ? from.label || "Your location"
                : "Your location"
              : stopName(registry, leg.from),
          toName: stopName(registry, leg.to),
        });
        continue;
      }
      const route = registry.routeById(leg.routeId);
      if (!route || route.group !== "qline") dart = true;
      const legAlerts = alerts ? alerts.forRoute(leg.routeId) || [] : [];
      if (!alertTop) {
        const ns = legAlerts.find((a) => a.effect === "NO_SERVICE");
        if (ns) {
          alertTop = {
            routeId: leg.routeId,
            text:
              `✕ No service on ${names.label(leg.routeId)}: ${ns.header}` +
              (ns.kind === "planned" ? " (planned notice)" : "") +
              " — this itinerary uses that route; the leg below states what changed.",
          };
        }
      }
      const alertLines = legAlerts.map((a) => {
        let text = `${a.glyph ?? "ℹ"} What changed: ${a.text}`;
        if (
          ["DETOUR", "NO_SERVICE", "STOP_MOVED"].includes(a.effect) &&
          Array.isArray(a.stopIds) &&
          a.stopIds.includes(registry.stopIdAt(leg.board))
        ) {
          text += ` Your boarding stop, ${stopName(registry, leg.board)}, is one of the stops this alert names.`;
        }
        return { glyph: a.glyph ?? "ℹ", cls: a.cls ?? "", text };
      });
      const liveVid = liveForLeg ? liveForLeg(leg) : null;
      rows.push({
        kind: "bus",
        routeId: leg.routeId,
        label: chipLabel(names, leg),
        headsign: leg.headsign || "",
        boardName: stopName(registry, leg.board),
        alightName: stopName(registry, leg.alight),
        timeText:
          `${formatClock(leg.boardSec)} → ${formatClock(leg.alightSec)} · ` +
          legProvenanceLabel(leg, nowMs) +
          (leg.interp ? " · estimated" : "") +
          (leg.liveVehicles > 0 ? ` · ${leg.liveVehicles} live` : ""),
        badge: leg.disrupted ? "Disrupted" : leg.provenance === "live" ? "Live" : null,
        alertLines,
        focusLabel: liveVid ? "View live bus" : "View trip",
        liveVehicleId: liveVid,
        leg,
      });
    }
    return { alertTop, dartPass: dart, rows };
  }

  function resultsModel(nowMs = Date.now()) {
    if (!journeys.length) {
      if (note) return { kind: "note", text: note };
      let text = emptyText;
      if (lastMeta && lastMeta.reason === "no-service") text = TEXT_NO_SERVICE;
      else if (lastMeta && lastMeta.reason === "no-origin") text = TEXT_NO_ORIGIN;
      else if (lastMeta && !lastMeta.reason) text = TEXT_NO_TRIP;
      return { kind: "empty", text };
    }
    const prov = provenanceOf(journeys);
    const serviceName = (lastMeta && SVC_NAMES[String(lastMeta.service)]) || "DDOT";
    const metaLine =
      `${PROV_LABEL[prov]} · ${serviceName} service · ` +
      (leaveMode === "at" && leaveTime ? `depart ${leaveTime}` : "leave now") +
      ` · feed ${lastMeta ? lastMeta.feedVersion : ""}`;
    const preference = route10Preference(journeys);
    const j = selected();
    return {
      kind: "results",
      headerProv: PROV_WORD[prov],
      metaLine,
      note,
      options: journeys.map((jj, i) => optionModel(registry, names, jj, i, i === sel, preference)),
      detail: j ? detailModel(j, nowMs) : null,
      announce: j
        ? `${journeys.length} scheduled trip${journeys.length === 1 ? "" : "s"} found. First trip: ${journeys[0].durationMin} minutes, ${journeys[0].departClock} to ${journeys[0].arriveClock}.`
        : "",
    };
  }

  /* ------------------------- selection + fly ------------------------ */

  function select(i, { user = true } = {}) {
    if (i < 0 || i >= journeys.length) return null;
    sel = i;
    const j = journeys[sel];
    if (intents.onHighlight) intents.onHighlight(j);
    if (user && intents.onFly) intents.onFly(flyModel(j));
    return j;
  }

  function stopPoint(idx) {
    const s = registry.stopAt(idx);
    return s ? { x: s.x, z: s.z } : null;
  }

  function busLegSlice(leg) {
    const route = registry.routeById(leg.routeId);
    if (!route || !route.paths || !route.paths.length) return [];
    const b = stopPoint(leg.board);
    const a = stopPoint(leg.alight);
    if (!b || !a) return [];
    let best = null;
    for (const path of route.paths) {
      let bi = -1;
      let ai = -1;
      let bd = Infinity;
      let ad = Infinity;
      for (let k = 0; k < path.length; k++) {
        const db = (path[k][0] - b.x) ** 2 + (path[k][1] - b.z) ** 2;
        if (db < bd) {
          bd = db;
          bi = k;
        }
        const da = (path[k][0] - a.x) ** 2 + (path[k][1] - a.z) ** 2;
        if (da < ad) {
          ad = da;
          ai = k;
        }
      }
      const score = bd + ad;
      if (!best || score < best.score) best = { path, bi, ai, score };
    }
    if (!best || best.bi < 0 || best.ai < 0) return [];
    const y = 66 + ordinalOf(leg.routeId) * 1.2 + 3;
    const pts = [];
    const step = best.bi <= best.ai ? 1 : -1;
    for (let k = best.bi; ; k += step) {
      pts.push({ x: best.path[k][0], y, z: best.path[k][1] });
      if (k === best.ai) break;
    }
    return pts;
  }

  /** P-44 completion framing model: the journey's 3D path + bounds. */
  function flyModel(j) {
    if (!j) return null;
    let pts = [];
    for (const leg of j.legs) {
      let lp = [];
      if (leg.type === "walk") {
        const f =
          leg.from === -1 || leg.fromLoc
            ? from && from.kind === "loc"
              ? { x: from.x, z: from.z }
              : stopPoint(leg.to)
            : stopPoint(leg.from);
        const t = stopPoint(leg.to);
        if (f && t) lp = [
          { x: f.x, y: 80, z: f.z },
          { x: t.x, y: 80, z: t.z },
        ];
      } else {
        lp = busLegSlice(leg);
      }
      for (const p of lp) {
        const last = pts[pts.length - 1];
        if (last && last.x === p.x && last.z === p.z) continue;
        pts.push(p);
      }
    }
    if (!pts.length) return null;
    if (pts.length > 80) {
      const sampled = [];
      for (let k = 0; k < 80; k++) sampled.push(pts[Math.round((k * (pts.length - 1)) / 79)]);
      pts = sampled;
    }
    const bounds = {
      minX: Math.min(...pts.map((p) => p.x)),
      maxX: Math.max(...pts.map((p) => p.x)),
      minZ: Math.min(...pts.map((p) => p.z)),
      maxZ: Math.max(...pts.map((p) => p.z)),
    };
    return {
      points: pts,
      bounds,
      durationMs: Math.min(6500, 2600 + pts.length * 45),
    };
  }

  /* --------------------------- guidance ----------------------------- */
  /* P-46 + the R-22 fence. Leave-now mode only.                     */

  function bindingFor(leg) {
    if (!live || !live.bindings) return null;
    return live.bindings.bindingForTrip(leg.tripRef);
  }

  function liveLegTime(leg, which) {
    const base = which === "board" ? leg.boardSec : leg.alightSec;
    const b = bindingFor(leg);
    if (b && b.state && !b.state.disrupted) {
      return base - (leg.delaySec || 0) * DELAY_PROJECTION + b.state.delaySec * DELAY_PROJECTION;
    }
    return base;
  }

  function fmtEta(sec) {
    if (sec < 60) return `${Math.round(sec)}s`;
    return `${Math.round(sec / 60)} min`;
  }

  function guidanceForLeg(leg, nowMs) {
    const b = bindingFor(leg);
    if (!b || !b.state || b.state.disrupted || !b.vehicleKey) return null;
    const pred = live.tracker.predict(b.vehicleKey, nowMs);
    if (!pred || pred.arc == null || pred.pathIdx == null) return null;
    const label = names.label(leg.routeId);
    if (b.layover) {
      return {
        kind: "board",
        text: `Route ${label} — your bus is at ${b.layover.terminal} and leaves at ${b.layover.departClock}.`,
      };
    }
    const arcs = live.atlas.stopArcMap(leg.routeId, pred.pathIdx);
    if (!arcs) return null;
    const boardArc = arcs.get(leg.board);
    const alightArc = arcs.get(leg.alight);
    if (boardArc == null || alightArc == null) return null;
    if (pred.arc < boardArc - 50) {
      const entry = live.tracker.entry(b.vehicleKey);
      const speed = entry ? Math.abs(entry.kf.vel) : 0;
      const eta = (boardArc - pred.arc) / Math.max(speed, 1.5);
      if (eta <= 150) {
        return {
          kind: "board",
          text: `Route ${label} reaches ${stopName(registry, leg.board)} in ~${fmtEta(eta)} — be ready to board.`,
        };
      }
      return null;
    }
    const trip = b.trip || leg.tripRef;
    const mapped = [];
    for (const idx of trip.stops) {
      const arc = arcs.get(idx);
      if (arc != null) mapped.push({ idx, arc });
    }
    let vehOrd = -1;
    for (let q = 0; q < mapped.length; q++) {
      if (mapped[q].arc <= pred.arc + 30) vehOrd = q;
    }
    const alightOrd = mapped.findIndex((m) => m.idx === leg.alight);
    if (vehOrd < 0 || alightOrd < 0) return null;
    const left = alightOrd - vehOrd;
    if (left === 0) return "passed";
    if (left === 1) {
      return {
        kind: "alight",
        urgent: true,
        text: `Route ${label} arriving at ${stopName(registry, leg.alight)} — get off at the next stop.`,
      };
    }
    return {
      kind: "riding",
      text: `Route ${label} — ${left} stops to ${stopName(registry, leg.alight)}.`,
    };
  }

  function missedPair(j) {
    const busIdx = [];
    j.legs.forEach((l, i) => {
      if (l.type === "bus") busIdx.push(i);
    });
    for (let k = 0; k + 1 < busIdx.length; k++) {
      const i1 = busIdx[k];
      const i2 = busIdx[k + 1];
      let walkSec = 0;
      for (let i = i1 + 1; i < i2; i++) {
        if (j.legs[i].type === "walk") walkSec += j.legs[i].secs;
      }
      const leg1 = j.legs[i1];
      const leg2 = j.legs[i2];
      if (liveLegTime(leg2, "board") < liveLegTime(leg1, "alight") + walkSec + 60) {
        return { leg1, leg2 };
      }
    }
    return null;
  }

  function replanOriginFor(leg1, nowMs) {
    const b = bindingFor(leg1);
    if (b && b.vehicleKey) {
      const pred = live.tracker.predict(b.vehicleKey, nowMs);
      if (pred && pred.x != null) return { kind: "loc", x: pred.x, z: pred.z };
    }
    const rp = getRiderPos ? getRiderPos() : null;
    if (rp) return { kind: "loc", x: rp.x, z: rp.z };
    return { kind: "stop", idx: leg1.alight };
  }

  /**
   * One guidance evaluation. Returns the banner model or null —
   * null is the honest surface: no guidance is no information.
   * The R-22 fence: 'done' requires the final leg reported passed
   * by live evidence, or its live-adjusted alight time more than
   * 120 s gone. A bus that merely departed recently proves nothing
   * about arrival.
   */
  function updateGuidance(nowMs) {
    banner = null;
    if (!live || leaveMode !== "now") return null;
    const j = selected();
    if (!j) return null;
    const busLegs = j.legs.filter((l) => l.type === "bus");
    if (!busLegs.length) return null;
    const missed = missedPair(j);
    if (missed && nowMs >= missedCooldownUntil) {
      missedCooldownUntil = nowMs + MISSED_COOLDOWN_MS;
      guidanceDismissedSig = null;
      const missedBanner = {
        kind: "missed",
        urgent: true,
        replanned: true,
        text: `Missed the Route ${names.label(missed.leg2.routeId)} connection — replanned from your current position.`,
      };
      from = replanOriginFor(missed.leg1, nowMs);
      plan(nowMs, { user: true });
      banner = missedBanner; // the re-plan clears the banner slot; the miss is this cycle's word
      return banner;
    }
    let finalPassed = false;
    const sig = journeySig(j);
    for (const leg of busLegs) {
      const g = guidanceForLeg(leg, nowMs);
      if (g === "passed") {
        if (leg === busLegs[busLegs.length - 1]) finalPassed = true;
        continue;
      }
      if (g) {
        if (!g.urgent && sig === guidanceDismissedSig) break;
        banner = g;
        return banner;
      }
    }
    const lastLeg = busLegs[busLegs.length - 1];
    if (finalPassed || secondsOfDay(nowMs) > liveLegTime(lastLeg, "alight") + 120) {
      banner = { kind: "done", text: "You have arrived." };
      return banner;
    }
    return null;
  }

  /* --------------------------- deep links --------------------------- */

  function applyDeepLink(search, nowMs) {
    const link = parsePlanLink(registry, search);
    if (!link) return false;
    if (link.from) from = link.from;
    if (link.to) to = link.to;
    if (from && to) plan(nowMs, { user: true });
    return true;
  }

  return {
    setFrom(ep) {
      from = ep;
    },
    setTo(ep) {
      to = ep;
    },
    setLeave(mode, time = null) {
      leaveMode = mode;
      leaveTime = time;
    },
    endpoints: () => ({ from, to }),
    fieldLabels: () => ({
      fromText: !from
        ? ""
        : from.kind === "loc"
          ? from.label || "Your location"
          : stopName(registry, from.idx),
      fromPlaceholder: "From",
      toText: !to ? "" : to.label || stopName(registry, to.idx),
      toPlaceholder: "Where to?",
    }),
    plan,
    replanLive,
    select,
    selected,
    journeys: () => journeys,
    selection: () => sel,
    resultsModel,
    flyModel,
    updateGuidance,
    guidance: () => banner,
    dismissGuidance() {
      const j = selected();
      if (j) guidanceDismissedSig = journeySig(j);
    },
    applyDeepLink,
    parsePlanLink: (search) => parsePlanLink(registry, search),
  };
}
