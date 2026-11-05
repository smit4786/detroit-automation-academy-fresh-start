/**
 * LTD rebuild — the bus card + fleet binding (Tranche T6; P-19,
 * R-02's card family, Position Integrity item 1).
 *
 * The card's claims, exactly as placed:
 *
 *   - Route/destination: the bound trip's headsign wins over the
 *     feed's sign (Route Reverse — one rule on every direction
 *     surface). The destination is formatted once: the route
 *     prefix BusTime repeats ("10 to Fairlane") is stripped,
 *     title-cased, truncated at 24 characters.
 *   - Vehicle facts: id, speed (rounded mph, '–' when unmeasured),
 *     heading as compass + degrees, and the fleet lookup — model
 *     and capacity from the published roster's number ranges;
 *     an unmatched number reads as the assumed 40-ft bus and says
 *     so ("model assumed"). The roster is a published artifact
 *     (CPTDB Wiki roster, accessed 2026-10-02), consumed by URL
 *     like the timetable — never vendored (DV-T4-3's closure).
 *   - Fix age (Position Integrity item 1): a rendered position is
 *     a claim with an age. FRESH < 75 s · AGING 75–150 s · STALE
 *     > 150 s (the tracker's bands, tracker.mjs FIX_BANDS). Text:
 *     "fix 20 s old" · "fix 10 min old — 3:50 PM" (the fix's own
 *     clock joins once STALE, and rides the stale chip:
 *     "Stale fix — 3:50 PM"). No measured fix time → NO age claim
 *     at all: the line hides rather than read "0 s old".
 *   - The card OBEYS the map's gate (candidate C1): applyFilters'
 *     reconciliation closes it when the selected vehicle's route
 *     gates closed — and ONLY then. Poll absence alone never
 *     closes it, so selection persists across polls while the
 *     route is shown.
 *   - D1a: on mobile the card opens as a compact route/vehicle
 *     bar; tapping the bar expands the full details.
 *
 * Surfaces receive tracker predictions, never raw fixes
 * (contract 10): the fix age derives from the fix's own instant.
 */

export const FLEET_FALLBACK = {
  model: "40-ft transit bus", detail: "model assumed",
  length_m: 12.19, width_m: 2.59, height_m: 3.3, seats: null, assumed: true,
};

/** Range lookup over the published roster; leading digits of the id. */
export function fleetLookup(fleetData, vehicleId) {
  if (!fleetData || !Array.isArray(fleetData.ranges)) return { ...FLEET_FALLBACK };
  const m = String(vehicleId ?? "").match(/^(\d+)/);
  if (!m) return { ...FLEET_FALLBACK };
  const num = parseInt(m[1], 10);
  for (const r of fleetData.ranges) {
    if (num >= r.from && num <= r.to) {
      return {
        model: r.model,
        detail: r.year + (r.note ? ` · ${r.note}` : ""),
        length_m: r.length_m, width_m: r.width_m, height_m: r.height_m,
        seats: r.seats, assumed: false,
      };
    }
  }
  return { ...FLEET_FALLBACK };
}

export async function loadFleet(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`fleet: ${url} -> HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.ranges)) throw new Error("fleet: bad payload");
  return data;
}

export function titleCase(s) {
  return String(s || "").toLowerCase().replace(/(?:^|\s)\S/g, (m) => m.toUpperCase());
}

/** BusTime signs repeat the route ("10 to Fairlane") — strip it. */
export function formatDest(routeId, dest) {
  if (!dest) return "";
  const raw = String(dest).trim().replace(new RegExp(`^${routeId}\\s*(to\\s+)?`, "i"), "");
  let out = titleCase(raw);
  if (out.length > 24) out = out.slice(0, 23) + "…";
  return out;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export function compass(bearing) {
  if (bearing === null || bearing === undefined || Number.isNaN(bearing)) return "–";
  return `${COMPASS[Math.round(bearing / 45) % 8]} (${Math.round(bearing)}°)`;
}

export function formatClock12(ms) {
  const d = new Date(ms);
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${ap}`;
}

/** Short age for the in-scene info label: "20s ago" / "3m ago". */
export function busAgeText(vehicle, nowMs) {
  if (!vehicle || vehicle.fixAtMs === null || vehicle.fixAtMs === undefined) return "–";
  const s = Math.max(0, Math.round((nowMs - vehicle.fixAtMs) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

/** FRESH < 75 s · AGING 75–150 s · STALE > 150 s (tracker bands). */
export function fixAgeClass(ageS) {
  if (ageS > 150) return "stale";
  if (ageS >= 75) return "aging";
  return "fresh";
}

/**
 * The fix-age claim for a vehicle record: { ageS, cls, fixWallMs }
 * or null when there is no measured fix time (no claim at all).
 */
export function fixAgeOf(vehicle, nowMs) {
  if (!vehicle || vehicle.fixAtMs === null || vehicle.fixAtMs === undefined) return null;
  if (!Number.isFinite(vehicle.fixAtMs)) return null;
  const ageS = Math.max(0, (nowMs - vehicle.fixAtMs) / 1000);
  return { ageS, cls: fixAgeClass(ageS), fixWallMs: vehicle.fixAtMs };
}

export function formatFixAge(ageS, fixWallMs) {
  const s = Math.max(0, ageS);
  let txt;
  if (s < 59.5) {
    txt = `fix ${Math.round(s)} s old`;
  } else {
    const rm = Math.round(s / 60);
    if (rm < 60) {
      txt = `fix ${rm} min old`;
    } else {
      const hh = Math.floor(rm / 60), mm = rm - hh * 60;
      txt = `fix ${hh} h${mm ? ` ${mm} min` : ""} old`;
    }
  }
  if (s > 150 && fixWallMs) txt += ` — ${formatClock12(fixWallMs)}`;
  return txt;
}

/** Route Reverse: the bound trip's headsign wins; unbound, the feed's sign. */
export function displayDest(vehicle, bindingFor) {
  if (!vehicle) return "";
  const b = bindingFor ? bindingFor(vehicle.vehicleId) : null;
  return formatDest(vehicle.routeId, (b && b.trip && b.trip.h) ? b.trip.h : vehicle.destination);
}

/** Build a vehicleId -> binding lookup by inverting a matcher delayMap. */
export function bindingIndex(delayMap) {
  const byVehicle = new Map();
  for (const [trip, st] of delayMap ?? []) {
    if (st && st.vehicleId !== null && st.vehicleId !== undefined) {
      byVehicle.set(String(st.vehicleId), { trip, state: st });
    }
  }
  return (vehicleId) => byVehicle.get(String(vehicleId)) ?? null;
}

export function buildBusCardModel({ vehicle, bindingFor = null, fleetData = null, names, nowMs, compact = false, upcoming = null }) {
  if (!vehicle) return null;
  const dest = displayDest(vehicle, bindingFor);
  const fi = fleetLookup(fleetData, vehicle.vehicleId);
  const fix = fixAgeOf(vehicle, nowMs);
  const title = `${names.label(vehicle.routeId)}${dest ? ` → ${dest}` : ""}`;
  return {
    vehicleId: vehicle.vehicleId,
    routeId: vehicle.routeId,
    tokenHex: null, // the host binds the route token's hex (chip ground)
    title,
    dest: dest || "–",
    speed: vehicle.speedMph !== null && vehicle.speedMph !== undefined && !Number.isNaN(vehicle.speedMph)
      ? `${Math.round(vehicle.speedMph)} mph` : "–",
    heading: compass(vehicle.bearingDeg),
    model: `${fi.model} · ${fi.detail}`,
    capacity: `${fi.seats !== null && fi.seats !== undefined ? `${fi.seats} seats · ` : ""}${fi.length_m.toFixed(1)} m long`,
    updated: vehicle.fixAtMs ? formatClock12(vehicle.fixAtMs) : "–",
    fixLine: fix ? { text: formatFixAge(fix.ageS, fix.fixWallMs), cls: fix.cls } : null,
    staleChip: fix && fix.cls === "stale" ? `Stale fix — ${formatClock12(fix.fixWallMs)}` : null,
    infoLine1: title,
    infoLine2: `Bus ${vehicle.vehicleId || "–"} · ${vehicle.speedMph !== null && vehicle.speedMph !== undefined && !Number.isNaN(vehicle.speedMph) ? `${Math.round(vehicle.speedMph)} mph` : "–"} · ${busAgeText(vehicle, nowMs)}`,
    compact,
    compactId: `Vehicle ${vehicle.vehicleId || "–"}`,
    upcoming, // beta upcoming-stops model (beta.mjs) or null
    announce: `Bus details opened. ${title}. Vehicle ${vehicle.vehicleId || "unknown"}.`,
  };
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

export function renderBusCard(model, doc, { onExpand = null, onFollow = null, followState = null, renderUpcoming = null, onClose = null } = {}) {
  const root = el(doc, "div", "bus-card");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Bus details");
  if (model.compact) root.classList?.add?.("compact");

  const bar = el(doc, "button", "bus-compact-bar");
  bar.setAttribute("id", "bus-expand");
  bar.appendChild(el(doc, "span", "bus-compact-title", model.title));
  bar.appendChild(el(doc, "span", "bus-compact-id", model.compactId));
  on(bar, "click", () => onExpand?.());
  root.appendChild(bar);

  const body = el(doc, "div", "bus-body");
  if (onClose) {
    // F-1: the card's visible close control (the shell reserves
    // the 44px .close slot in every card). At T10 the bus card
    // rendered no close affordance; its onClose fired only from
    // route-gate reconciliation, never from a rider tap.
    const closeBtn = el(doc, "button", "close", "✕");
    closeBtn.setAttribute("type", "button");
    closeBtn.setAttribute("aria-label", "Close bus card");
    on(closeBtn, "click", () => onClose());
    body.appendChild(closeBtn);
  }
  body.appendChild(el(doc, "h3", "bus-title", model.title));
  const dl = el(doc, "dl", "bus-dl");
  const rows = [
    ["Vehicle", model.vehicleId || "–"],
    ["Destination", model.dest],
    ["Speed", model.speed],
    ["Heading", model.heading],
    ["Model", model.model],
    ["Capacity", model.capacity],
    ["Updated", model.updated],
  ];
  for (const [k, v] of rows) {
    dl.appendChild(el(doc, "dt", null, k));
    dl.appendChild(el(doc, "dd", null, v));
  }
  body.appendChild(dl);
  if (model.fixLine) {
    const line = el(doc, "p", `bus-fixline ${model.fixLine.cls}`, model.fixLine.text);
    line.setAttribute("id", "bus-fix-age");
    body.appendChild(line);
  }
  if (model.staleChip) {
    body.appendChild(el(doc, "p", "bus-stale-chip", model.staleChip));
  }
  if (model.upcoming && renderUpcoming) {
    body.appendChild(renderUpcoming(model.upcoming, doc));
  }
  const follow = el(doc, "button", "bus-follow-btn", followState?.following ? "Following" : "Follow");
  follow.setAttribute("aria-pressed", String(!!followState?.following));
  on(follow, "click", () => onFollow?.());
  body.appendChild(follow);
  root.appendChild(body);
  return root;
}

/**
 * The card controller: selection, the C1 gate reconciliation, the
 * D1a compact state, and the 30 s fix-age refresh rhythm the stop
 * card set. Follow tracking itself is the vehicle layer's (T4);
 * the card owns the button's label state via the host's followState.
 */
export function createBusCardController({ doc, mount, buildModel, renderUpcoming = null, onClose = null }) {
  let selectedVehicleId = null;
  let compact = false;
  let signature = null;
  let renders = 0;

  function render(nowMs) {
    const model = buildModel(selectedVehicleId, { compact });
    if (!model) { mount.textContent = ""; signature = null; return false; }
    const sig = JSON.stringify(model);
    if (sig === signature) return false;
    signature = sig;
    mount.textContent = "";
    mount.appendChild(renderBusCard(model, doc, {
      renderUpcoming,
      onExpand: () => { compact = false; signature = null; render(nowMs); },
      onClose: onClose ? () => {
        const vid = selectedVehicleId;
        selectedVehicleId = null;
        signature = null;
        mount.textContent = "";
        onClose(vid);
      } : null,
    }));
    renders++;
    return true;
  }

  return {
    open(vehicle, { deviceClass = "desktop", nowMs = Date.now() } = {}) {
      selectedVehicleId = vehicle ? vehicle.vehicleId : null;
      compact = deviceClass === "mobile"; // D1a: mobile opens compact
      signature = null;
      return render(nowMs);
    },
    tick: (nowMs) => (selectedVehicleId ? render(nowMs) : false),
    /**
     * Candidate C1: close ONLY when the selected vehicle is present
     * in the latest poll AND its route's gate is closed. Absence
     * from a poll never closes the card.
     */
    reconcile(vehicles, routeShownFn) {
      if (!selectedVehicleId || !vehicles) return false;
      for (const v of vehicles) {
        if (v.vehicleId === selectedVehicleId) {
          if (routeShownFn(v.routeId)) return false;
          selectedVehicleId = null;
          signature = null;
          mount.textContent = "";
          onClose?.(v.vehicleId);
          return true;
        }
      }
      return false;
    },
    close() {
      selectedVehicleId = null;
      signature = null;
      mount.textContent = "";
    },
    selected: () => selectedVehicleId,
    isCompact: () => compact,
    renderCount: () => renders,
  };
}
