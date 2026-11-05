/**
 * LTD rebuild — the vehicle service (Tranche T4, M6 poll + store).
 *
 * Owns the live-vehicle data plane end to end:
 *
 *   Poll fan-out (P-16/P-22): the main poll every 60 s from the
 *   static live-data binding (20 s abort) fetches vehicles.json
 *   (DDOT + QLINE). The SMART display fetch rides the same cycle
 *   (8 s abort), runs concurrently, and can never fail or
 *   delay-mark the main poll — its vehicles merge into the store
 *   when they land, before every fan-out to consumers. Hidden-tab
 *   backoff stretches the cycle to 600 s; returning to visible
 *   polls immediately. Until the first live poll wins, telemetry
 *   history paints instantly ("last logged {time} — connecting
 *   live…") and the store says so.
 *
 *   SMART freshness (R-25): bands fresh ≤ 7.5 min / aging ≤ 15 min
 *   / stale > 15 min, the age computed skew-proof from the
 *   payload's own generated_at vs its oldest vehicle updated_at —
 *   never from the reader's clock. Stale-payload vehicles are
 *   dropped at ingest; the band still surfaces for labeling.
 *   SMART data is display-only (R-29): it is merged for display
 *   and counted, never matched, never planned from.
 *
 *   Running-state (R-08/P-24): per route, an asymmetric engine —
 *   a visible bus marks the route running immediately; not-running
 *   requires 3 consecutive quiet polls; unknown (pre-first-poll)
 *   never hides or dims. Counts read the raw feed before any
 *   visibility filtering (this module is upstream of filters by
 *   construction). QLINE is exempt from hide-idle: its quiet state
 *   never hides or dims it.
 *
 * Feed envelopes pass through with generated_at and sources
 * intact (M3 contract) — the degradation detector (M11/T8) reads
 * them from here; this module interprets none of it.
 */

import { projectLatLon } from "./arc-atlas.mjs";

export const POLL_MS = 60_000;
export const POLL_HIDDEN_MS = 600_000;
export const MAIN_ABORT_MS = 20_000;
export const SMART_ABORT_MS = 8_000;
export const SMART_BANDS = { freshMs: 450_000, agingMs: 900_000 }; // 7.5 / 15 min
export const QUIET_POLLS_NOT_RUNNING = 3;

/**
 * Parse a feed timestamp. ISO with a zone designator parses as
 * given; the DDOT feed's naive "2026-11-04T12:54:00" is Detroit
 * local time and is constructed as such.
 */
export function parseFeedTime(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const s = String(value);
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/.exec(s);
  if (!m) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
  }
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] ?? 0), Number(m[7] ?? 0),
  ).getTime();
}

/** SMART payload freshness (R-25), from the payload's own clocks. */
export function smartFreshness(payload) {
  const genMs = parseFeedTime(payload?.generated_at);
  if (genMs === null) return { band: "stale", internalAgeMs: null, drop: true };
  let oldest = null;
  for (const v of payload.vehicles ?? []) {
    const u = parseFeedTime(v.updated_at);
    if (u !== null && (oldest === null || u < oldest)) oldest = u;
  }
  // No vehicles: the payload's own stamp is the only clock it has.
  const internalAgeMs = oldest === null ? 0 : Math.max(0, genMs - oldest);
  if (internalAgeMs <= SMART_BANDS.freshMs) return { band: "fresh", internalAgeMs, drop: false };
  if (internalAgeMs <= SMART_BANDS.agingMs) return { band: "aging", internalAgeMs, drop: false };
  return { band: "stale", internalAgeMs, drop: true };
}

function normalizeVehicle(raw, projection) {
  if (!raw || raw.vehicle_id === null || raw.vehicle_id === undefined) return null;
  const lat = Number(raw.lat), lon = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const [x, z] = projectLatLon(projection, lat, lon);
  const agency = String(raw.agency ?? "").toLowerCase();
  return {
    key: `${agency}:${raw.vehicle_id}`,
    vehicleId: String(raw.vehicle_id),
    agency,
    routeId: raw.route_id === null || raw.route_id === undefined || raw.route_id === "" ? null : String(raw.route_id),
    tripId: raw.trip_id ? String(raw.trip_id) : null,
    directionId: raw.direction_id ?? null,
    destination: raw.destination ?? null,
    bearingDeg: raw.bearing !== null && raw.bearing !== undefined ? Number(raw.bearing) : null,
    speedMph: raw.speed_mph !== null && raw.speed_mph !== undefined ? Number(raw.speed_mph) : null,
    x, z, lat, lon,
    fixAtMs: parseFeedTime(raw.updated_at),
  };
}

export function createVehicleService({
  baseUrl,
  projection,
  routeUniverse = [], // [{ routeId, agency }] — the registry's routes, per agency
  fetchImpl = fetch,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
  isHidden = () => false,
} = {}) {
  if (!baseUrl) throw new Error("vehicles: baseUrl is required (the live-data binding, R-07)");
  if (!projection) throw new Error("vehicles: projection is required");

  let mainPayload = null;      // last good vehicles.json envelope
  let mainVehicles = [];       // normalized DDOT + QLINE
  let smartPayload = null;     // last SMART envelope (any band)
  let smartVehicles = [];      // normalized SMART, post freshness gate
  let smartBand = null;        // { band, internalAgeMs, drop } | null
  let history = null;          // { vehicles, generatedAtMs } until first live win
  let liveWon = false;
  let lastPollOk = null;       // bool | null (never polled)
  let lastPollAtMs = null;
  let pollSeq = 0;
  let timer = null;
  let running = false;
  const listeners = new Set();

  // Running-state engine (R-08): routeId -> { state, quiet }.
  // A completed fetch evidences every universe route of its
  // agencies: present → running now; absent → one quiet tick.
  // A failed fetch evidences nothing (its routes do not tick).
  const runningState = new Map();
  const universeByAgency = new Map();
  for (const { routeId, agency } of routeUniverse) {
    if (!universeByAgency.has(agency)) universeByAgency.set(agency, new Set());
    universeByAgency.get(agency).add(String(routeId));
  }
  function tickRunning(agencies, vehicles) {
    const counts = new Map();
    for (const agency of agencies) {
      for (const rid of universeByAgency.get(agency) ?? []) counts.set(rid, 0);
    }
    for (const v of vehicles) {
      if (v.routeId !== null && counts.has(v.routeId)) counts.set(v.routeId, counts.get(v.routeId) + 1);
    }
    for (const [rid, count] of counts) {
      const cur = runningState.get(rid) ?? { state: "unknown", quiet: 0 };
      if (count > 0) { cur.state = "running"; cur.quiet = 0; }
      else {
        cur.quiet += 1;
        if (cur.quiet >= QUIET_POLLS_NOT_RUNNING) cur.state = "not-running";
      }
      runningState.set(rid, cur);
    }
  }

  function mergedVehicles() {
    const live = liveWon || mainVehicles.length ? [...mainVehicles, ...smartVehicles] : [...(history?.vehicles ?? [])];
    return live;
  }

  function snapshot() {
    return {
      vehicles: mergedVehicles(),
      source: liveWon ? "live" : history ? "history" : "none",
      historyGeneratedAtMs: history?.generatedAtMs ?? null,
      generatedAt: mainPayload?.generated_at ?? null,
      sources: mainPayload?.sources ?? null,
      smart: smartPayload ? { generatedAt: smartPayload.generated_at, ...(smartBand ?? {}) } : null,
      lastPollOk, lastPollAtMs, pollSeq,
    };
  }

  function emit() {
    const snap = snapshot();
    for (const fn of listeners) fn(snap);
    return snap;
  }

  async function fetchJson(path, abortMs) {
    const ctrl = new AbortController();
    const killer = setTimer(() => ctrl.abort(), abortMs);
    try {
      const res = await fetchImpl(`${baseUrl}/${path}`, { signal: ctrl.signal, cache: "no-store" });
      if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimer(killer);
    }
  }

  /** One poll cycle. Never throws: outcomes land in the snapshot. */
  async function poll(nowMs = Date.now()) {
    pollSeq++;
    lastPollAtMs = nowMs;
    const mySeq = pollSeq;

    const smartPromise = fetchJson("smart-display.json", SMART_ABORT_MS)
      .then((payload) => {
        if (mySeq !== pollSeq) return; // a newer cycle owns the store
        smartPayload = payload;
        smartBand = smartFreshness(payload);
        smartVehicles = smartBand.drop
          ? []
          : (payload.vehicles ?? []).map((v) => normalizeVehicle(v, projection)).filter(Boolean);
        // Running evidence is the post-gate set: vehicles dropped
        // as stale are not live evidence of a running route.
        tickRunning(["smart"], smartVehicles);
        emit();
      })
      .catch(() => { /* SMART failure is silent here by contract (P-22) */ });

    try {
      const payload = await fetchJson("vehicles.json", MAIN_ABORT_MS);
      mainPayload = payload;
      mainVehicles = (payload.vehicles ?? []).map((v) => normalizeVehicle(v, projection)).filter(Boolean);
      liveWon = true;
      lastPollOk = true;
      tickRunning(["ddot", "qline"], mainVehicles);
    } catch {
      lastPollOk = false; // last good set stands; surfaces read lastPollOk
    }
    emit();
    await smartPromise.catch(() => {});
    return snapshot();
  }

  function scheduleNext() {
    if (!running) return;
    const delay = isHidden() ? POLL_HIDDEN_MS : POLL_MS;
    timer = setTimer(async () => {
      timer = null;
      await poll();
      scheduleNext();
    }, delay);
  }

  return {
    poll,
    start() {
      if (running) return;
      running = true;
      void poll().then(() => scheduleNext());
    },
    stop() {
      running = false;
      if (timer !== null) { clearTimer(timer); timer = null; }
    },
    /** Visibility return: poll now, reschedule on the visible cadence. */
    async visibilityReturned() {
      if (timer !== null) { clearTimer(timer); timer = null; }
      await poll();
      scheduleNext();
    },
    /** Telemetry history seed (P-16): paints until the first live poll wins. */
    seedHistory(rawVehicles, generatedAtMs) {
      if (liveWon) return;
      history = {
        vehicles: (rawVehicles ?? []).map((v) => normalizeVehicle(v, projection)).filter(Boolean),
        generatedAtMs: generatedAtMs ?? null,
      };
      emit();
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    snapshot,
    vehicles: () => mergedVehicles(),
    /** Per-route live counts from the raw merged feed (pre-filter). */
    rawCounts() {
      const counts = Object.create(null);
      for (const v of mergedVehicles()) {
        if (v.routeId !== null) counts[v.routeId] = (counts[v.routeId] || 0) + 1;
      }
      return counts;
    },
    /** Route running state: 'unknown' | 'running' | 'not-running' (R-08). */
    routeState(routeId) {
      return runningState.get(String(routeId))?.state ?? "unknown";
    },
    /** Hide-idle may never hide or dim QLINE (R-08 exemption). */
    idleHidden(routeId) {
      if (String(routeId).toUpperCase() === "QLINE") return false;
      return this.routeState(routeId) === "not-running";
    },
    smartFreshness: () => smartBand,
    trackerFixes() {
      return mergedVehicles().map((v) => ({
        key: v.key, vehicleId: v.vehicleId, agency: v.agency, routeId: v.routeId,
        x: v.x, z: v.z, bearingDeg: v.bearingDeg, destination: v.destination,
        fixAtMs: v.fixAtMs,
      }));
    },
  };
}
