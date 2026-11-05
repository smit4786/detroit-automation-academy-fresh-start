/**
 * LTD rebuild — the platform module (Tranche T8, M2).
 *
 * The error-handling architecture of record (P-70, steps 1–5),
 * minus the two pieces earlier tranches already landed: the
 * frame guard + watchdog DETECTION is the renderer's (T3 — it
 * reports through its onRecovery hook) and the first-view sheet
 * state is the sheet's own (T6). What lands here:
 *
 *   Error log + capture (step 1–2): a bounded on-device log —
 *   50 entries, 64 KB serialized, surviving sessions through
 *   injected storage — exposed as `window.__flErrLog` by
 *   `install`, fed by global error / unhandledrejection capture.
 *   A corrupt stored log starts empty; the log never throws.
 *
 *   Recovery ladder (step 5): recovery events arrive from the
 *   renderer (frame-guard, watchdog), the camera supervisor,
 *   the context-loss guard and the stuck-interaction detector.
 *   Fires inside the window escalate: first fire L1 (reset the
 *   interaction/transient state), second L2 (rebuild the scene
 *   layers), third fire escalates to reload. Every action is
 *   emitted for the assembly to execute and counted in a ledger
 *   — the reload count is the F-07 UAT row, readable at
 *   `ladder.stats()`.
 *
 *   WebGL context loss: a loss asks for a restore; a second loss
 *   within 30 s of a restore is a loop, not a coincidence — it
 *   escalates through the ladder instead of restoring again.
 *
 *   Camera sanity supervisor (step 4): samples are checked for
 *   finiteness and plausible distance; three consecutive bad
 *   samples (the debounce of record) fire one recovery event
 *   per bad streak.
 *
 *   Planner fault accounting (step 3): the planner host fires
 *   its onFault intent per fault (T7 left the accounting here);
 *   three consecutive faults pause planning with a note. A
 *   success resets the count.
 *
 *   Input heartbeat + stuck interaction (step 2/5): input
 *   activity stamps a heartbeat; an interaction left open more
 *   than 10 s is stuck and raises an L1 reset, once per
 *   interaction.
 *
 *   Toasts (P-72): 4.5 s auto-hide, or sticky with a dismiss
 *   control; nodes + textContent only (R-44). The adaptive
 *   input hint is a local-only model: after repeated pointer
 *   interaction with no wheel event ever observed, the hint may
 *   show — at most once per session, nothing leaves the device.
 */

export const ERRLOG_MAX_ENTRIES = 50;
export const ERRLOG_MAX_BYTES = 65_536;
export const ERRLOG_STORAGE_KEY = "fl-err-log-v1";
export const LADDER_WINDOW_MS = 60_000;
export const CONTEXT_LOOP_GUARD_MS = 30_000;
export const CAMERA_BAD_LIMIT = 3;
export const PLANNER_FAULT_LIMIT = 3;
export const STUCK_INTERACTION_MS = 10_000;
export const TOAST_HIDE_MS = 4_500;

/* ------------------------------ error log ------------------------------ */

export function createErrorLog({
  storage = null,
  key = ERRLOG_STORAGE_KEY,
  now = () => Date.now(),
} = {}) {
  let entries = [];
  try {
    const raw = storage?.getItem?.(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed.slice(-ERRLOG_MAX_ENTRIES);
    }
  } catch { entries = []; }

  function persist() {
    try {
      let out = JSON.stringify(entries);
      while (out.length > ERRLOG_MAX_BYTES && entries.length > 1) {
        entries.shift();
        out = JSON.stringify(entries);
      }
      if (out.length > ERRLOG_MAX_BYTES && entries.length === 1) {
        // A single oversized entry: truncate its message to fit.
        const e = { ...entries[0] };
        const over = out.length - ERRLOG_MAX_BYTES;
        e.message = String(e.message ?? "").slice(0, Math.max(0, String(e.message ?? "").length - over));
        entries = [e];
        out = JSON.stringify(entries);
      }
      storage?.setItem?.(key, out);
    } catch { /* the log never throws */ }
  }

  const api = {
    record(kind, message, extra = {}) {
      entries.push({
        at: now(),
        kind: String(kind ?? "error"),
        message: String(message ?? ""),
        ...extra,
      });
      while (entries.length > ERRLOG_MAX_ENTRIES) entries.shift();
      persist();
      return entries.length;
    },
    entries: () => entries.slice(),
    count: () => entries.length,
    clear() {
      entries = [];
      try { storage?.removeItem?.(key); } catch { /* never throws */ }
    },
    /** Expose as window.__flErrLog (the name of record). */
    install(target) {
      if (target) target.__flErrLog = api;
      return api;
    },
  };
  return api;
}

/** Global error / unhandledrejection capture into the log (step 2). */
export function installErrorCapture({ target, log } = {}) {
  if (!target || typeof target.addEventListener !== "function" || !log) {
    return () => {};
  }
  const onError = (ev) => {
    log.record("error", ev?.message ?? ev?.error?.message ?? "unknown error");
  };
  const onRejection = (ev) => {
    const r = ev?.reason;
    log.record("unhandledrejection", r?.message ?? String(r ?? "unhandled rejection"));
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener?.("error", onError);
    target.removeEventListener?.("unhandledrejection", onRejection);
  };
}

/* ---------------------------- recovery ladder --------------------------- */

export function createRecoveryLadder({ onAction = null, now = () => Date.now() } = {}) {
  let fires = [];        // fire times inside the window
  let reloads = 0;
  let totalFires = 0;
  const listeners = new Set();
  if (onAction) listeners.add(onAction);

  function fire(kind, detail = {}) {
    const t = now();
    fires = fires.filter((f) => t - f <= LADDER_WINDOW_MS);
    fires.push(t);
    totalFires++;
    const n = fires.length;
    let action;
    if (n >= 3) {
      // The third fire escalates to reload (P-70/R-16).
      action = { level: 5, action: "reload", kind, detail };
      reloads++;
      fires = []; // the reload resets the ladder's world
    } else if (n === 2) {
      action = { level: 2, action: "rebuild-layers", kind, detail };
    } else {
      action = { level: 1, action: "reset-interaction", kind, detail };
    }
    for (const fn of listeners) fn(action);
    return action;
  }

  return {
    fire,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** F-07: the reload count is a UAT row — read it here. */
    stats: () => ({ totalFires, reloads, firesInWindow: fires.length }),
  };
}

/**
 * WebGL context-loss guard: restore on loss, but a loss within
 * 30 s of a restore is a loop — escalate through the ladder
 * (30 s loop guard, P-70/R-16).
 */
export function createContextGuard({ ladder, now = () => Date.now() } = {}) {
  let lastRestoreAtMs = null;
  return {
    noteContextLost() {
      const t = now();
      if (lastRestoreAtMs !== null && t - lastRestoreAtMs < CONTEXT_LOOP_GUARD_MS) {
        return { action: "escalate", ladder: ladder?.fire("context-loss-loop", { gapMs: t - lastRestoreAtMs }) ?? null };
      }
      return { action: "restore" };
    },
    noteContextRestored() {
      lastRestoreAtMs = now();
      return lastRestoreAtMs;
    },
  };
}

/* --------------------------- camera supervisor -------------------------- */

export function cameraSampleSane(sample) {
  if (!sample) return false;
  const vals = [sample.px, sample.py, sample.pz, sample.tx, sample.ty, sample.tz, sample.distance];
  if (!vals.every((v) => Number.isFinite(v))) return false;
  // Plausible distance: the rig's own bounds are 150 m (street)
  // to 55,000 m (P-03); the sanity band stands wider than both.
  if (sample.distance < 100 || sample.distance > 60_000) return false;
  return true;
}

export function createCameraSupervisor({ onRecovery = null, ladder = null } = {}) {
  let badStreak = 0;
  let firedThisStreak = false;
  return {
    check(sample) {
      if (cameraSampleSane(sample)) {
        badStreak = 0;
        firedThisStreak = false;
        return { sane: true, badStreak: 0, fired: false };
      }
      badStreak++;
      let fired = false;
      if (badStreak >= CAMERA_BAD_LIMIT && !firedThisStreak) {
        firedThisStreak = true;
        fired = true;
        const detail = { badStreak, sample };
        if (onRecovery) onRecovery("camera-sanity", detail);
        ladder?.fire("camera-sanity", detail);
      }
      return { sane: false, badStreak, fired };
    },
    badStreak: () => badStreak,
  };
}

/* -------------------------- planner fault count ------------------------- */

export const PLANNER_PAUSE_NOTE =
  "Trip planning is paused after repeated errors. Reload the page to try again.";

export function createPlannerFaults({ onPause = null, limit = PLANNER_FAULT_LIMIT } = {}) {
  let consecutive = 0;
  let paused = false;
  return {
    /** The planner host's onFault intent lands here (T7 seam). */
    noteFault(err) {
      consecutive++;
      if (consecutive >= limit && !paused) {
        paused = true;
        onPause?.({ note: PLANNER_PAUSE_NOTE, error: err ?? null, consecutive });
      }
      return { consecutive, paused };
    },
    noteSuccess() {
      consecutive = 0;
      return { consecutive, paused };
    },
    paused: () => paused,
    note: () => (paused ? PLANNER_PAUSE_NOTE : null),
    consecutive: () => consecutive,
  };
}

/* --------------------- input heartbeat + stuck watch -------------------- */

export function createInputWatch({ now = () => Date.now() } = {}) {
  let lastInputAtMs = null;
  let open = null; // { label, sinceMs, reported }
  return {
    noteInput() {
      lastInputAtMs = now();
      return lastInputAtMs;
    },
    lastInputAt: () => lastInputAtMs,
    beginInteraction(label = "interaction") {
      open = { label, sinceMs: now(), reported: false };
      return open;
    },
    endInteraction() {
      const was = open;
      open = null;
      return was;
    },
    /**
     * >10 s open = stuck (P-70): reported once per interaction;
     * the caller fires the ladder's L1 reset.
     */
    check(nowMs = now()) {
      if (!open || open.reported) return null;
      const openMs = nowMs - open.sinceMs;
      if (openMs > STUCK_INTERACTION_MS) {
        open.reported = true;
        return { stuck: true, label: open.label, openMs };
      }
      return null;
    },
    openInteraction: () => open,
  };
}

/** Wire a DOM-ish target's input events into the heartbeat. */
export function installInputHeartbeat({ target, watch } = {}) {
  if (!target || typeof target.addEventListener !== "function" || !watch) return () => {};
  const types = ["pointerdown", "keydown", "wheel", "touchstart"];
  const fn = () => watch.noteInput();
  for (const t of types) target.addEventListener(t, fn, { passive: true });
  return () => {
    for (const t of types) target.removeEventListener?.(t, fn);
  };
}

/* -------------------------------- toasts -------------------------------- */

export function createToasts({
  doc, mount,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
  hideMs = TOAST_HIDE_MS,
} = {}) {
  if (!doc) throw new Error("toasts: doc is required");
  if (!mount) throw new Error("toasts: mount is required");
  const live = new Set();

  function removeNode(node) {
    if (typeof node.remove === "function") node.remove();
    else if (typeof mount.removeChild === "function") mount.removeChild(node);
    live.delete(node);
  }

  function show(text, { sticky = false, warn = false } = {}) {
    const node = doc.createElement("div");
    node.className = `toast${warn ? " toast-warn" : ""}`;
    node.textContent = String(text);
    let timer = null;
    const dismiss = () => {
      if (timer !== null) { clearTimer(timer); timer = null; }
      removeNode(node);
    };
    if (sticky) {
      const btn = doc.createElement("button");
      btn.className = "toast-dismiss";
      btn.textContent = "Dismiss";
      btn.setAttribute("type", "button");
      btn.setAttribute("aria-label", "Dismiss notification");
      if (typeof btn.addEventListener === "function") btn.addEventListener("click", dismiss);
      node.appendChild(btn);
    } else {
      timer = setTimer(dismiss, hideMs);
    }
    mount.appendChild(node);
    live.add(node);
    return { node, dismiss };
  }

  return {
    show,
    count: () => live.size,
    clear() { for (const n of [...live]) removeNode(n); },
  };
}

/* ------------------------- adaptive input hint -------------------------- */

export const WHEEL_HINT_TEXT = "No scroll wheel detected — zoom with the + and − controls, or pinch.";
export const WHEEL_HINT_SESSION_KEY = "lt-wheel-hint-shown";

/**
 * Local-only (P-72): after several pointer interactions and no
 * wheel event ever, the hint may show — at most once per session
 * (session storage flag). Detection never leaves the device.
 */
export function createWheelHint({ session = null, pointerThreshold = 5 } = {}) {
  let pointers = 0;
  let wheels = 0;
  let shown = false;
  try { shown = session?.getItem?.(WHEEL_HINT_SESSION_KEY) === "1"; } catch { shown = false; }
  return {
    notePointer() { pointers++; },
    noteWheel() { wheels++; },
    shouldShow() {
      return !shown && wheels === 0 && pointers >= pointerThreshold;
    },
    markShown() {
      shown = true;
      try { session?.setItem?.(WHEEL_HINT_SESSION_KEY, "1"); } catch { /* never throws */ }
    },
    text: WHEEL_HINT_TEXT,
  };
}
