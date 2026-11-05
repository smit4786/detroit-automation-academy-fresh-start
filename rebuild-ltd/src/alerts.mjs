/**
 * LTD rebuild — the alert service (Tranche T8, M11 alerts half).
 *
 * Owns the alerts data plane and every alert treatment model:
 *
 *   Ingest (P-61/R-28): alerts.json polled every 120 s from the
 *   same static live-data binding as the vehicles (R-07). SMART
 *   alert records are dropped at ingest — the Swiftly grant does
 *   not enable service alerts — and each drop is kept with its
 *   source line in `droppedSmart()` for the record. Nothing else
 *   is interpreted at ingest; normalization is a pure function
 *   the queries share.
 *
 *   Treatments (P-62, Map-Native Concept B): the raw GTFS effect
 *   maps onto the five-effect vocabulary — no-stop / moved /
 *   detour / reduced / info — and `kind: "planned"` rides as a
 *   modifier, never an effect. Every treatment carries a glyph
 *   AND a word, never color alone. Planned alerts tint chips
 *   only: they never enter the map overlay model.
 *
 *   Merge hysteresis (P-63): an alert retires only after TWO
 *   consecutive successful fetches omit it. A failed fetch ticks
 *   nothing. The screen-reader list names every active alert in
 *   words; the live-region announcement fires only when the
 *   active set changes.
 *
 *   Provider surfaces, exactly as the earlier tranches' slots
 *   consume them: the planner's `forRoute(routeId)` (T7 — the
 *   records carry the raw effect, the header, the planned kind,
 *   glyph/cls/text and the named stop ids), the stop card's
 *   `alertsFor(stop)` bands (T5 — feed-precision lead sentences:
 *   "No service at this stop", "Boarding point moved from this
 *   stop", "This stop is bypassed"), the browse/filter chip
 *   severity badge (P-26), the first-view proof state
 *   { checked, ok, count, firstText } (T6), and the map overlay
 *   model for the alert layer.
 *
 *   Scoping calls (named, this tranche's): an alert naming no
 *   routes and no stops is system-wide — it reaches forRoute,
 *   the stop-card bands and the SR list, but it does NOT badge
 *   every chip (the badge is a per-route signal). A stop-scoped
 *   alert (stops, no routes) reaches the cards that name those
 *   stops; it reaches the planner only through a route that
 *   lists it explicitly.
 *
 * Alert text is feed-derived: every DOM surface in this module
 * builds with nodes + textContent only (R-44). The alert help
 * copy this module emits describes the GRAYSCALE treatments
 * (R-46) — the treatments govern, never the old color words.
 */

import { parseFeedTime } from "./vehicles.mjs";

export const ALERT_POLL_MS = 120_000;
export const ALERT_ABORT_MS = 20_000;
export const RETIRE_AFTER_ABSENT = 2;

/** The five-effect vocabulary (P-62): glyph + word, never color alone. */
export const TREATMENTS = {
  "no-service": { glyph: "✕", word: "No service", severity: 5 },
  moved: { glyph: "⇄", word: "Stop moved", severity: 4 },
  detour: { glyph: "⤨", word: "Detour", severity: 3 },
  reduced: { glyph: "◐", word: "Reduced service", severity: 2 },
  info: { glyph: "ℹ", word: "Service note", severity: 1 },
};

/** Treatment help lines in the grayscale words (R-46). */
export const TREATMENT_HELP = [
  { glyph: "✕", text: "No service — the route or stop is not served while this alert is active. Marked with a ✕ badge and a dashed overlay on the map." },
  { glyph: "⇄", text: "Stop moved — boarding has moved from this stop. The stop is ringed on the map with a ⇄ marker; no replacement point is drawn, because the alert names none." },
  { glyph: "⤨", text: "Detour — buses follow a different path. Marked with a ⤨ badge and a dashed overlay on the affected route." },
  { glyph: "◐", text: "Reduced service — fewer buses than scheduled. Marked with a ◐ badge." },
  { glyph: "ℹ", text: "Service note — information from the agency, marked with a ℹ badge. Planned notices tint route chips only and never draw on the map." },
];

export function treatmentFor(effect) {
  switch (String(effect ?? "").toUpperCase()) {
    case "NO_SERVICE": return "no-service";
    case "STOP_MOVED": return "moved";
    case "DETOUR": return "detour";
    case "REDUCED_SERVICE":
    case "SIGNIFICANT_DELAYS": return "reduced";
    default: return "info";
  }
}

const strList = (v) => (Array.isArray(v) ? v.map((x) => String(x)) : []);

/** One feed record -> the treatment record every surface shares. */
export function normalizeAlert(raw) {
  if (!raw || raw.id === null || raw.id === undefined) return null;
  const effect = raw.effect === null || raw.effect === undefined || raw.effect === ""
    ? null : String(raw.effect).toUpperCase();
  const treatment = treatmentFor(effect);
  const t = TREATMENTS[treatment];
  const planned = String(raw.kind ?? "").toLowerCase() === "planned";
  const header = raw.header != null ? String(raw.header) : "";
  const description = raw.description != null ? String(raw.description) : "";
  return {
    id: String(raw.id),
    agency: String(raw.agency ?? "ddot").toLowerCase(),
    source: raw.source ?? null,
    effect,
    treatment,
    glyph: t.glyph,
    word: t.word,
    severity: t.severity,
    kind: planned ? "planned" : "realtime",
    planned,
    cls: `alert-${treatment}${planned ? " alert-planned" : ""}`,
    header,
    text: description || header,
    routeIds: strList(raw.routes),
    stopIds: strList(raw.stops),
    startMs: parseFeedTime(raw.active_period?.start),
    endMs: parseFeedTime(raw.active_period?.end),
  };
}

export function alertActiveAt(a, nowMs) {
  if (a.startMs !== null && nowMs < a.startMs) return false;
  if (a.endMs !== null && nowMs > a.endMs) return false;
  return true;
}

const bySeverity = (a, b) =>
  b.severity - a.severity || a.header.localeCompare(b.header) || a.id.localeCompare(b.id);

export function createAlertService({
  baseUrl,
  fetchImpl = fetch,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
} = {}) {
  if (!baseUrl) throw new Error("alerts: baseUrl is required (the live-data binding, R-07)");

  const held = new Map();   // id -> { alert, absent }
  const dropped = [];       // SMART records dropped at ingest, with source lines (R-28)
  let checked = false;      // any poll completed (success or failure)
  let lastPollOk = null;
  let lastPollAtMs = null;
  let pollSeq = 0;
  let timer = null;
  let running = false;
  let lastAnnouncedSig = null;
  const listeners = new Set();

  function active(nowMs = Date.now()) {
    return [...held.values()]
      .map((h) => h.alert)
      .filter((a) => alertActiveAt(a, nowMs))
      .sort(bySeverity);
  }

  function signature(nowMs = Date.now()) {
    return active(nowMs).map((a) => a.id).join(",");
  }

  function emit() {
    const snap = { active: active(), checked, ok: lastPollOk };
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

  /** One poll cycle. Never throws: outcomes land in the state. */
  async function poll(nowMs = Date.now()) {
    pollSeq++;
    lastPollAtMs = nowMs;
    const mySeq = pollSeq;
    try {
      const payload = await fetchJson("alerts.json", ALERT_ABORT_MS);
      if (mySeq !== pollSeq) return snapshot();
      const seen = new Set();
      for (const raw of payload.alerts ?? []) {
        const a = normalizeAlert(raw);
        if (!a) continue;
        if (a.agency === "smart") {
          // R-28: dropped at ingest, with its source line kept.
          if (!dropped.some((d) => d.id === a.id)) {
            dropped.push({ id: a.id, agency: a.agency, source: a.source });
          }
          continue;
        }
        seen.add(a.id);
        held.set(a.id, { alert: a, absent: 0 });
      }
      // Hysteresis (P-63): retire only after two consecutive
      // successful fetches omit the alert.
      for (const [id, h] of held) {
        if (!seen.has(id)) {
          h.absent += 1;
          if (h.absent >= RETIRE_AFTER_ABSENT) held.delete(id);
        }
      }
      lastPollOk = true;
    } catch {
      lastPollOk = false; // held set stands; absence ticks nothing
    }
    checked = true;
    emit();
    return snapshot();
  }

  function scheduleNext() {
    if (!running) return;
    timer = setTimer(async () => {
      timer = null;
      await poll();
      scheduleNext();
    }, ALERT_POLL_MS);
  }

  function snapshot() {
    return {
      active: active(),
      checked,
      ok: lastPollOk,
      lastPollAtMs,
      pollSeq,
      droppedSmart: dropped.slice(),
    };
  }

  /* ------------------------- provider surfaces ------------------------- */

  /** T7 planner slot: { forRoute(routeId) -> alert[] }. */
  function forRoute(routeId, nowMs = Date.now()) {
    const rid = String(routeId);
    return active(nowMs).filter((a) =>
      a.routeIds.includes(rid) || (a.routeIds.length === 0 && a.stopIds.length === 0));
  }

  /** Stop-named lead sentences (P-32), feed precision first. */
  function leadFor(a, stopId) {
    if (stopId && a.stopIds.includes(stopId)) {
      if (a.effect === "NO_SERVICE") return "No service at this stop";
      if (a.effect === "STOP_MOVED") return "Boarding point moved from this stop";
      if (a.effect === "DETOUR") return "This stop is bypassed";
    }
    return a.word;
  }

  /** T5 stop-card slot: alertsFor(stop) -> [{ lead, text, ... }]. */
  function alertsFor(stop, nowMs = Date.now()) {
    if (!stop) return [];
    const stopId = String(stop.stop_id ?? "");
    const routes = new Set((stop.routes ?? []).map(String));
    return active(nowMs)
      .filter((a) =>
        a.stopIds.includes(stopId) ||
        a.routeIds.some((r) => routes.has(r)) ||
        (a.routeIds.length === 0 && a.stopIds.length === 0))
      .map((a) => ({
        lead: leadFor(a, stopId),
        text: a.text,
        glyph: a.glyph,
        treatment: a.treatment,
        alertId: a.id,
      }));
  }

  /** P-26 chip severity badge: the worst alert scoped to the route. */
  function chipBadge(routeId, nowMs = Date.now()) {
    const rid = String(routeId);
    const scoped = active(nowMs).filter((a) => a.routeIds.includes(rid));
    if (!scoped.length) return null;
    const a = scoped[0]; // active() is severity-sorted
    return {
      glyph: a.glyph,
      word: a.word,
      cls: a.cls,
      planned: a.planned,
      aria: `${a.word} alert on this route${a.planned ? " (planned notice)" : ""}`,
    };
  }

  /** P-63: every active alert named in words, for the SR list. */
  function srList(nowMs = Date.now()) {
    return active(nowMs).map((a) => `${a.word}: ${a.header || a.text}`);
  }

  /**
   * P-63: the live region announces set changes only. Returns the
   * announcement text when the active set differs from the last
   * announced set, else null. The first successful read announces
   * (the set changed from unknown); silence after that.
   */
  function announcement(nowMs = Date.now()) {
    const sig = signature(nowMs);
    if (sig === lastAnnouncedSig) return null;
    lastAnnouncedSig = sig;
    const list = srList(nowMs);
    if (!list.length) return "No active service alerts.";
    return `Service alerts: ${list.join("; ")}`;
  }

  /** T6 first-view proof state, the exact shape fvProofs consumes. */
  function fvState(nowMs = Date.now()) {
    const act = active(nowMs);
    return {
      checked,
      ok: lastPollOk === true,
      count: act.length,
      firstText: act.length ? (act[0].header || act[0].text) : null,
    };
  }

  /**
   * P-62 map overlay model. Planned alerts never appear here —
   * they tint chips only. STOP_MOVED stops carry the ⇄ anchor;
   * no replacement point is ever invented for them.
   */
  function overlayModel(nowMs = Date.now()) {
    const rings = new Map();   // stopId -> ring (worst severity wins)
    const routes = new Map();  // routeId -> overlay (worst wins)
    for (const a of active(nowMs)) {
      if (a.planned) continue;
      for (const stopId of a.stopIds) {
        const cur = rings.get(stopId);
        if (!cur || a.severity > cur.severity) {
          rings.set(stopId, {
            stopId, treatment: a.treatment, severity: a.severity,
            moved: a.treatment === "moved",
          });
        }
      }
      if (a.treatment === "detour" || a.treatment === "no-service") {
        for (const routeId of a.routeIds) {
          const cur = routes.get(routeId);
          if (!cur || a.severity > cur.severity) {
            routes.set(routeId, { routeId, treatment: a.treatment, severity: a.severity });
          }
        }
      }
    }
    const bySev = (key) => (a, b) => b.severity - a.severity || a[key].localeCompare(b[key]);
    return {
      stopRings: [...rings.values()].sort(bySev("stopId")),
      routeOverlays: [...routes.values()].sort(bySev("routeId")),
      movedAnchors: [...rings.values()].filter((r) => r.moved)
        .map((r) => ({ stopId: r.stopId, glyph: "⇄" })),
    };
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
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    snapshot,
    active,
    signature,
    forRoute,
    alertsFor,
    chipBadge,
    srList,
    announcement,
    fvState,
    overlayModel,
    droppedSmart: () => dropped.slice(),
    /** The provider object in the exact slot shape T5/T7 consume. */
    providers: () => ({
      forRoute: (routeId) => forRoute(routeId),
      alertsFor: (stop) => alertsFor(stop),
    }),
  };
}

/**
 * P-26 DOM binding: paint the severity badge into every route
 * chip under `root` (chips carry `data-route`). One badge span
 * per chip, id `alert-badge-<routeId>`, updated in place and
 * removed when the route clears. Nodes + textContent only.
 */
export function applyChipBadges(root, service, nowMs = Date.now()) {
  if (!root || typeof root.querySelectorAll !== "function") return 0;
  let painted = 0;
  for (const chip of root.querySelectorAll("[data-route]")) {
    const rid = chip.getAttribute("data-route");
    const badge = service.chipBadge(rid, nowMs);
    let el = null;
    for (const c of chip.children ?? []) {
      if (c.getAttribute?.("data-alert-badge") !== null && c.getAttribute?.("data-alert-badge") !== undefined) { el = c; break; }
    }
    if (!badge) {
      if (el) el.remove?.();
      continue;
    }
    if (!el) {
      el = chip.ownerDocument?.createElement?.("span") ?? null;
      if (!el) continue;
      el.setAttribute("data-alert-badge", rid);
      chip.appendChild(el);
    }
    el.className = `alert-badge ${badge.cls}`;
    el.textContent = badge.glyph;
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", badge.aria);
    painted++;
  }
  return painted;
}
