/**
 * LTD rebuild — service status (Tranche T8, M11 status half).
 *
 * Three surfaces, one state — the first-view sheet's proof lines
 * read this same state (R-38: no second data path):
 *
 *   Header (P-67): the live count and the updated line. Normal:
 *   the merged vehicle count + "updated {time}" from the feed's
 *   own generated_at. Polls failing before any live win: "live
 *   feed retrying…", or "showing last logged positions · live
 *   feed retrying…" while the map still shows the telemetry
 *   history seed.
 *
 *   The degradation notice (P-68, vocabulary R-10): conditions
 *   are detected ONLY from the vehicle envelope's source states,
 *   its generated_at age, and poll success/failure. This module
 *   never reads `sources.smart` — the destructure below names
 *   ddot and qline and nothing else (R-28). Zero vehicles with
 *   an ok source is never a degradation (R-08/R-32). Stale fires
 *   at 12 minutes. Unreachable means: polls attempted and
 *   failing with no successful payload this session — once a
 *   payload has landed, later failures age into stale instead,
 *   so the two words never conflate. Dismissal is by condition
 *   signature: dismissing hides the notice until the signature
 *   changes. A 30 s timer re-renders from stored state only —
 *   the passage of time alone can raise the stale notice.
 *
 *   SMART freshness labeling (P-69/R-25): a surface SEPARATE
 *   from the notice — the two never merge. It fills the filter
 *   panel's SMART age slots (T6 rendered them empty for this
 *   module) and the live-count pill's SMART segment, from the
 *   vehicle service's own payload-internal band (fresh ≤ 7.5
 *   min / aging ≤ 15 min / stale > 15 min, computed upstream
 *   skew-proof — this module only words it).
 *
 * Headlines for unreachable and stale are the placed words,
 * verbatim (R-10). The detail tail states what P-68 requires —
 * the planner runs on the published timetable (DDOT schedule
 * data current through February 7, 2027), service is not
 * cancelled, the notice concerns the feed only. Headlines for
 * the source-state conditions are this tranche's constructions
 * in the same register, named in the delivery record.
 */

import { parseFeedTime } from "./vehicles.mjs";

export const STALE_MS = 12 * 60_000; // R-10: stale fires at 12 minutes
export const RERENDER_MS = 30_000;   // P-68: re-render from stored state
export const SCHEDULE_THROUGH = "February 7, 2027";

export const HEADLINE_UNREACHABLE = "Live vehicle positions unavailable. The live feed cannot be reached.";
export const DETAIL_TAIL =
  `Trip planning runs on the published timetable (DDOT schedule data current through ${SCHEDULE_THROUGH}). ` +
  "Bus service is not cancelled — this notice concerns the live feed only.";

export function staleHeadline(generatedAtMs, nowMs) {
  const mins = Math.max(1, Math.floor((nowMs - generatedAtMs) / 60_000));
  return `Live positions delayed — last update ${formatClock(generatedAtMs)}, ${mins} minute${mins === 1 ? "" : "s"} ago.`;
}

/** "3:50 PM" — the local clock form the placed surfaces use. */
export function formatClock(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

export function createStatusMonitor({
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
  onChange = null,
} = {}) {
  let snap = null;          // last vehicle-service snapshot observed
  let snapAtMs = null;      // when it was observed (reader clock)
  let dismissedSig = null;
  let timer = null;
  let lastEmittedSig = null;
  const listeners = new Set();
  if (onChange) listeners.add(onChange);

  function genMs() {
    return snap ? parseFeedTime(snap.generatedAt) : null;
  }

  /* ------------------------------ header ------------------------------ */

  function header(nowMs = Date.now()) {
    const vehicles = snap?.vehicles ?? [];
    const total = vehicles.length;
    let smart = null;
    const smartCount = vehicles.filter((v) => v.agency === "smart").length;
    if (snap?.smart) {
      smart = { count: smartCount, suffix: snap.smart.band === "stale" ? " (stale)" : "" };
    }
    let updatedText;
    let mode = "live";
    if (!snap || snap.lastPollOk === null || snap.lastPollOk === undefined) {
      updatedText = ""; // nothing attempted yet — the shell's own state stands
      mode = "pending";
    } else if (snap.lastPollOk === false && snap.source !== "live") {
      mode = "retrying";
      updatedText = snap.source === "history"
        ? "showing last logged positions · live feed retrying…"
        : "live feed retrying…";
    } else {
      const g = genMs();
      updatedText = g !== null ? `updated ${formatClock(g)}` : "";
      mode = snap.lastPollOk === false ? "last-good" : "live";
    }
    return { total, smart, updatedText, mode };
  }

  /* --------------------------- the detector --------------------------- */

  function detect(nowMs) {
    if (!snap) return null;
    const sources = snap.sources ?? {};
    // R-28: sources.smart is never read here — ddot and qline only.
    const { ddot, qline } = sources;
    const g = genMs();
    const ageMs = g !== null ? nowMs - g : null;

    let condition = null;
    if (snap.lastPollOk === false && snap.source !== "live" && snap.generatedAt == null) {
      condition = "unreachable";
    } else if (ddot && ddot.configured === false) {
      condition = "ddot-not-configured";
    } else if (ddot && ddot.ok === false) {
      condition = "ddot-down";
    } else if (ageMs !== null && ageMs >= STALE_MS) {
      condition = "stale";
    } else if (ddot && (ddot.batches_failed ?? 0) > 0 && ddot.ok !== false) {
      condition = "ddot-partial";
    } else if (qline && qline.ok === false) {
      condition = "qline-down";
    }
    if (!condition) return null;

    let headline;
    switch (condition) {
      case "unreachable": headline = HEADLINE_UNREACHABLE; break;
      case "stale": headline = staleHeadline(g, nowMs); break;
      case "ddot-not-configured":
        headline = "Live DDOT positions unavailable — the DDOT feed is not configured."; break;
      case "ddot-down":
        headline = "Live DDOT positions unavailable — the DDOT feed is not reporting."; break;
      case "ddot-partial":
        headline = "Live DDOT positions may be incomplete — part of the DDOT feed is not reporting."; break;
      case "qline-down":
        headline = "Live QLINE positions unavailable — the QLINE feed is not reporting."; break;
      default: headline = HEADLINE_UNREACHABLE;
    }
    const signature = [
      condition,
      snap.generatedAt ?? "",
      ddot ? `${ddot.ok}/${ddot.configured}/${ddot.batches_failed ?? 0}` : "-",
      qline ? `${qline.ok}` : "-",
    ].join("|");
    return { condition, headline, detail: DETAIL_TAIL, signature };
  }

  function notice(nowMs = Date.now()) {
    const n = detect(nowMs);
    if (!n) return null;
    if (n.signature === dismissedSig) return null;
    return n;
  }

  function dismiss() {
    const n = detect(Date.now());
    if (n) dismissedSig = n.signature;
    return dismissedSig;
  }

  /* ------------------------- SMART labeling --------------------------- */

  function smartLabel() {
    const s = snap?.smart;
    if (!s) return { ageLabel: "", ageNote: "", pill: null };
    const band = s.band;
    const count = (snap.vehicles ?? []).filter((v) => v.agency === "smart").length;
    let ageNote = "";
    if (band !== "fresh") {
      ageNote = s.internalAgeMs !== null && s.internalAgeMs !== undefined
        ? ` Positions are ${Math.max(1, Math.round(s.internalAgeMs / 60_000))} minute${Math.round(s.internalAgeMs / 60_000) === 1 ? "" : "s"} old.`
        : " The SMART feed's age could not be read.";
    }
    return {
      ageLabel: band === "fresh" ? "" : ` · ${band}`,
      ageNote,
      pill: { count, suffix: band === "stale" ? " (stale)" : "" },
    };
  }

  /* --------------------------- state + timer -------------------------- */

  function models(nowMs = Date.now()) {
    return { header: header(nowMs), notice: notice(nowMs), smart: smartLabel() };
  }

  function emit(nowMs = Date.now()) {
    const m = models(nowMs);
    const sig = JSON.stringify([m.header, m.notice?.signature ?? null, m.smart]);
    if (sig !== lastEmittedSig) {
      lastEmittedSig = sig;
      for (const fn of listeners) fn(m);
    }
    return m;
  }

  /** Observe a vehicle-service snapshot (its subscribe door). */
  function observe(snapshot, nowMs = Date.now()) {
    snap = snapshot;
    snapAtMs = nowMs;
    return emit(nowMs);
  }

  /** The 30 s re-render: stored state only, never a fetch (P-68). */
  function tick(nowMs = Date.now()) {
    if (!snap) return null;
    return emit(nowMs);
  }

  function start() {
    if (timer !== null) return;
    const loop = () => {
      timer = setTimer(() => { tick(); loop(); }, RERENDER_MS);
    };
    loop();
  }

  function stop() {
    if (timer !== null) { clearTimer(timer); timer = null; }
  }

  return {
    observe, tick, start, stop, dismiss,
    header, notice, smartLabel, models,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    observedAt: () => snapAtMs,
  };
}

/* ------------------------- DOM bindings (R-44) ------------------------ */

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/** Fill the shell's header mounts (#live-count, #updated-at). */
export function applyHeader(els, headerModel) {
  if (!els) return;
  if (els.count) {
    els.count.textContent = headerModel.smart
      ? `${headerModel.total} · SMART ${headerModel.smart.count}${headerModel.smart.suffix}`
      : `${headerModel.total}`;
  }
  if (els.updated) els.updated.textContent = headerModel.updatedText;
}

/**
 * Render the notice into the shell's #svc-notice mount: headline,
 * detail tail, and a dismiss button wired to the monitor (the
 * dismissal is by condition signature, in the monitor). A null
 * notice hides the mount and clears it.
 */
export function applyNotice(mount, noticeModel, { doc, onDismiss } = {}) {
  if (!mount) return;
  if (!noticeModel) {
    mount.hidden = true;
    mount.textContent = "";
    return;
  }
  mount.hidden = false;
  mount.textContent = "";
  mount.appendChild(el(doc, "strong", "svc-headline", noticeModel.headline));
  mount.appendChild(el(doc, "p", "svc-detail", noticeModel.detail));
  const btn = el(doc, "button", "svc-dismiss", "Dismiss");
  btn.setAttribute("type", "button");
  btn.setAttribute("aria-label", "Dismiss service notice");
  if (typeof btn.addEventListener === "function") {
    btn.addEventListener("click", () => onDismiss?.());
  }
  mount.appendChild(btn);
}

/** Fill T6's SMART age slots in the filter panel, by element id. */
export function fillSmartAgeSlots(doc, label) {
  if (!doc || typeof doc.getElementById !== "function") return false;
  const age = doc.getElementById("smart-age-label");
  const note = doc.getElementById("smart-age-note");
  if (age) age.textContent = label.ageLabel;
  if (note) note.textContent = label.ageNote;
  return !!(age || note);
}
