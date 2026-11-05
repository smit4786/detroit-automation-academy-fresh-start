/**
 * LTD rebuild — stop arrivals (Tranche T5, M7 core).
 *
 * The board behind the stop card (P-33): an honesty order —
 * live-matched rows first (scheduled time fused with the measured
 * delay projected at DELAY_PROJECTION 0.6, the engine's constant),
 * then scheduled rows. A disrupted trip is never shifted and never
 * wears a LIVE tag. Three-hour window, top 5 rows, grouped by
 * route + headsign; live groups order by their nearest bus, and a
 * vehicle's distance is presentation only, never an ETA. States:
 * loading (no timetable bound yet) / na (the stop has no timetable
 * service — QLINE stops land here with their positions-only note,
 * P-23) / nosvc (served, but nothing in the window) / ok. The
 * computation is pure over current state, so the card's 30 s
 * refresh costs no network traffic (P-33).
 *
 * SMART trip-update rows render INSIDE the same board (P-34) from
 * the published smart-trip-updates.json: a payload older than
 * 15 minutes is dropped whole, rows obey the same route toggles as
 * the map (R-27), and TU trip ids live in Swiftly's id space — the
 * timetable carries no GTFS trip id, so TU rows are their own row
 * class, never joined onto timetable trips. TU stop ids resolve to
 * registry stops exactly -> SMARTGTFS:-prefixed -> the smart
 * segment's bare-id crosswalk; an id with no registry counterpart
 * (the settlement's cross-feed bare-id collisions) is skipped and
 * counted, never guessed.
 *
 * The headsign join (R-26, P-35) is display-only and lives here:
 * exact on trip_id, route + direction dominant fallback. Nothing
 * in the planner or the matcher imports this module.
 */

import { DELAY_PROJECTION } from "./engine.mjs";
import { parseYmd } from "./timetable.mjs";

export const ARRIVALS_WINDOW_S = 3 * 3600;
export const ARRIVALS_MAX_ROWS = 5;
export const TU_STALE_MS = 15 * 60_000; // P-34 15-minute stale drop
export const TU_FILES = { tripUpdates: "smart-trip-updates.json", headsigns: "smart-headsigns.json" };

/* ---- headsign join (R-26) ---- */

/**
 * Accepts the published map in either of its packagings:
 * `{ trips: {tripId: headsign}, routeDir: {"<route>|<dir>": headsign} }`
 * or a flat `{ tripId: headsign }` object (treated as trips-only).
 */
export function createHeadsignJoin(data) {
  const trips = new Map();
  const routeDir = new Map();
  if (data && typeof data === "object") {
    const t = data.trips && typeof data.trips === "object" ? data.trips : data;
    for (const [k, v] of Object.entries(t)) if (typeof v === "string") trips.set(String(k), v);
    const rd = data.routeDir ?? data.route_dir ?? {};
    if (rd && typeof rd === "object") {
      for (const [k, v] of Object.entries(rd)) if (typeof v === "string") routeDir.set(String(k), v);
    }
  }
  return {
    size: () => trips.size + routeDir.size,
    /** Exact trip match wins; route + direction is the dominant fallback. */
    forTrip(tripId, routeId, directionId) {
      if (tripId !== null && tripId !== undefined && trips.has(String(tripId))) {
        return trips.get(String(tripId));
      }
      if (routeId !== null && routeId !== undefined && directionId !== null && directionId !== undefined) {
        return routeDir.get(`${routeId}|${directionId}`) ?? null;
      }
      return null;
    },
  };
}

/* ---- TU stop resolution ---- */

function bare(id) {
  const s = String(id);
  const i = s.indexOf(":");
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Registry door for a TU (SMART GTFS) stop id; null when unresolvable.
 * Only smart-segment stops can ever match: a bare numeric TU id that
 * collides with a DDOT stop id is the settlement's cross-feed
 * collision class and resolves to nothing, never to the DDOT stop. */
export function resolveTuStop(registry, tuStopId) {
  const id = String(tuStopId);
  const exact = registry.stopById(id);
  if (exact && exact.segment === "smart") return exact;
  const prefixed = registry.stopById(`SMARTGTFS:${id}`);
  if (prefixed) return prefixed;
  for (let i = 0; i < registry.count; i++) {
    const stop = registry.stopAt(i);
    if (stop && stop.segment === "smart" && bare(stop.stop_id) === id) return stop;
  }
  return null;
}

/* ---- TU source (data-plane pattern: failure-isolated, never throws) ---- */

export function createTuSource({ baseUrl, fetchImpl = fetch } = {}) {
  let tuPayload = null;
  let headsignData = null;
  async function read(name) {
    const res = await fetchImpl(`${baseUrl}/${name}`);
    if (!res.ok) throw new Error(`${name} -> HTTP ${res.status}`);
    return res.json();
  }
  /** Payload age from its own generated_at stamp (skew-proof, R-25 pattern). */
  function ageMs(nowMs) {
    if (!tuPayload?.generated_at) return Infinity;
    const gen = Date.parse(tuPayload.generated_at);
    return Number.isFinite(gen) ? nowMs - gen : Infinity;
  }
  return {
    /** Refresh both files; each failure keeps the last good copy. */
    async refresh() {
      const out = { tu: false, headsigns: false };
      try { tuPayload = await read(TU_FILES.tripUpdates); out.tu = true; } catch { /* keep last good */ }
      try { headsignData = await read(TU_FILES.headsigns); out.headsigns = true; } catch { /* keep last good */ }
      return out;
    },
    payload: () => tuPayload,
    headsigns: () => headsignData,
    join: () => createHeadsignJoin(headsignData),
    ageMs,
    isFresh: (nowMs) => tuPayload !== null && ageMs(nowMs) <= TU_STALE_MS,
  };
}

/* ---- arrivals ---- */

function midnightEpochSec(ymd) {
  const { y, mo, d } = parseYmd(ymd);
  return new Date(y, mo - 1, d).getTime() / 1000;
}

export function createArrivals({
  bound = null,
  registry,
  matcher = null,
  tuSource = null,
  routeVisible = () => true,
  baselineFor = null,
  distanceProvider = null,
}) {
  // Index timetable trips by registry stop index, once.
  const byStop = new Map();
  if (bound) {
    for (const trip of bound.timetable.trips) {
      trip.stops.forEach((stopIdx, pos) => {
        if (!byStop.has(stopIdx)) byStop.set(stopIdx, []);
        byStop.get(stopIdx).push({ trip, pos });
      });
    }
  }
  const countersState = { tuUnresolved: 0, tuSkipped: 0 };

  function scheduledRows(stop, { ymd, yesterdayYmd, secOfDay }) {
    const rows = [];
    const entries = byStop.get(stop.idx) ?? [];
    // Service admission follows the engine exactly: the binding's
    // set by id, mapped to service indices, windowed by each
    // service's validity span (T2's serviceSetFor).
    const tt = bound.timetable;
    const svcIndex = new Map();
    tt.services.forEach((svc, i) => {
      const key = `${svc.feed ?? 0}|${svc.id}`;
      if (!svcIndex.has(key)) svcIndex.set(key, i);
    });
    const setCache = new Map();
    const digits = (s) => String(s).replace(/\D/g, ""); // windows are YYYYMMDD in the artifact
    const setFor = (feed, day) => {
      const cacheKey = `${feed}|${day}`;
      if (!setCache.has(cacheKey)) {
        const out = new Set();
        for (const id of bound.servicesFor(feed, day)) {
          const i = svcIndex.get(`${feed}|${id}`);
          if (i === undefined) continue;
          const svc = tt.services[i];
          if (digits(day) >= digits(svc.start) && digits(day) <= digits(svc.end)) out.add(i);
        }
        setCache.set(cacheKey, out);
      }
      return setCache.get(cacheKey);
    };
    const feedOf = (trip) => tt.services[trip.s]?.feed ?? 0;
    for (const { trip, pos } of entries) {
      const feed = feedOf(trip);
      let frame = null;
      if (setFor(feed, ymd).has(trip.s)) frame = 0;
      else if (setFor(feed, yesterdayYmd).has(trip.s)) frame = -86400;
      if (frame === null) continue;
      const l2 = baselineFor ? baselineFor(trip) : null;
      const dep = (l2 ? l2.dep[pos] : trip.dep[pos]) + frame;
      if (dep < secOfDay || dep > secOfDay + ARRIVALS_WINDOW_S) continue;
      const route = bound.routeForTrip(trip);
      const routeId = route ? String(route.id) : null;
      if (routeId !== null && !routeVisible(routeId)) continue;
      const row = {
        kind: "scheduled",
        routeId,
        headsign: trip.h || "",
        timeSec: dep,
        tag: l2 ? "typical" : "scheduled",
        trip,
        distanceM: null,
        vehicleId: null,
      };
      const st = matcher ? matcher.tripState(trip) : null;
      if (st && !st.disrupted) {
        row.timeSec = dep + st.delaySec * DELAY_PROJECTION;
        row.tag = "live";
        row.kind = "live";
        row.vehicleId = st.vehicleId ?? null;
        row.distanceM = distanceProvider ? distanceProvider({ state: st, trip, stop }) : null;
        if (row.timeSec < secOfDay - 60) continue; // fused time already gone
      }
      rows.push(row);
    }
    return rows;
  }

  function tuRows(stop, { ymd, secOfDay, nowMs }) {
    if (!tuSource || !tuSource.isFresh(nowMs)) return [];
    const payload = tuSource.payload();
    const join = tuSource.join();
    const midnight = midnightEpochSec(ymd);
    const rows = [];
    for (const tuTrip of payload.trips ?? []) {
      const routeId = tuTrip.route_id !== null && tuTrip.route_id !== undefined ? String(tuTrip.route_id) : null;
      if (routeId !== null && !routeVisible(routeId)) continue;
      for (const stu of tuTrip.stop_time_updates ?? []) {
        const resolved = resolveTuStop(registry, stu.stop_id);
        if (!resolved) { countersState.tuUnresolved++; continue; }
        if (resolved.stop_id !== stop.stop_id) continue;
        if (stu.schedule_relationship === "SKIPPED") { countersState.tuSkipped++; continue; }
        const epoch = stu.departure_time ?? stu.arrival_time;
        if (epoch === null || epoch === undefined) continue;
        const timeSec = epoch - midnight;
        if (timeSec < secOfDay || timeSec > secOfDay + ARRIVALS_WINDOW_S) continue;
        rows.push({
          kind: "tu",
          routeId,
          headsign: join.forTrip(tuTrip.trip_id, routeId, tuTrip.direction_id) ?? "",
          timeSec,
          tag: "tu",
          trip: null,
          distanceM: null,
          vehicleId: tuTrip.vehicle_id ?? null,
        });
      }
    }
    return rows;
  }

  return {
    counters: () => ({ ...countersState }),

    /**
     * The board for one stop. ctx carries the civil frame the host
     * owns: { ymd, yesterdayYmd, secOfDay, nowMs }.
     */
    forStop(stop, ctx) {
      if (!bound) return { state: "loading", stop, rows: [], groups: [] };
      const served = (byStop.get(stop.idx) ?? []).length > 0;
      if (!served) {
        return {
          state: "na",
          stop,
          rows: [],
          groups: [],
          note: stop.segment === "qline" ? "positions-only" : "not-in-timetable",
        };
      }
      const rows = [
        ...scheduledRows(stop, ctx),
        ...(stop.segment === "smart" ? tuRows(stop, ctx) : []),
      ];
      rows.sort((a, b) => (a.timeSec - b.timeSec) || String(a.routeId).localeCompare(String(b.routeId)));
      // Group by route + headsign; live groups lead, ordered by
      // their nearest bus; the rest follow by earliest row.
      const groups = new Map();
      for (const row of rows) {
        const key = `${row.routeId}|${row.headsign}`;
        if (!groups.has(key)) groups.set(key, { key, routeId: row.routeId, headsign: row.headsign, rows: [] });
        groups.get(key).rows.push(row);
      }
      const groupList = [...groups.values()].map((g) => ({
        ...g,
        hasLive: g.rows.some((r) => r.tag === "live"),
        nearestBusM: Math.min(...g.rows.map((r) => (r.distanceM === null ? Infinity : r.distanceM))),
        firstSec: Math.min(...g.rows.map((r) => r.timeSec)),
      }));
      groupList.sort((a, b) => {
        if (a.hasLive !== b.hasLive) return a.hasLive ? -1 : 1;
        if (a.hasLive && b.hasLive) return a.nearestBusM - b.nearestBusM;
        return a.firstSec - b.firstSec;
      });
      const capped = [];
      for (const g of groupList) {
        for (const row of g.rows) {
          if (capped.length >= ARRIVALS_MAX_ROWS) break;
          capped.push(row);
        }
        if (capped.length >= ARRIVALS_MAX_ROWS) break;
      }
      return {
        state: capped.length ? "ok" : "nosvc",
        stop,
        rows: capped,
        groups: groupList,
      };
    },
  };
}
