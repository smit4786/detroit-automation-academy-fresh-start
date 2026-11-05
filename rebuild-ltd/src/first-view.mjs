/**
 * LTD rebuild — the first-view launcher sheet (Tranche T6; R-38,
 * Concept 3 — Justin's pick at the first-view decision gate,
 * 2026-10-23).
 *
 * A bottom sheet over the live map: greeting ("Detroit, live." /
 * "What do you want to do?") + six use-case tiles, each carrying
 * a live proof line refreshed from the SAME state the header and
 * the alerts module maintain — no second data path. Tiles call
 * the existing entry functions only (the host's entries:
 * plan / ride / routes panel / near-me / alerts / the map
 * itself) — there is no parallel navigation system.
 *
 *   - Open/collapsed is the rider's own persisted preference
 *     (storage key 'lt-fv-sheet', alongside — never replacing —
 *     the other lt-* keys), defaulting to OPEN only when the key
 *     is absent; only an explicit 'collapsed' starts a returning
 *     rider at the "Explore" handle.
 *   - Opening an exclusion surface occludes the launcher
 *     transiently without touching that preference (the host's
 *     cover/restore stack drives `setOccluded`).
 *   - Location is offered ONLY here, inline: there is no boot
 *     prompt, and Near me always offers the no-permission
 *     map-center fallback beside the location request. The
 *     center fallback counts routes within 1,250 m of the map
 *     center and opens the governed stop nearest the center.
 *   - Header drag past 64 px (or a header tap) collapses;
 *     Escape collapses; collapse moves focus to the handle when
 *     focus was inside the sheet.
 *
 * Proof lines, verbatim from the placed surface:
 *   live:   "Connecting…" | "No vehicles live right now" |
 *           "N vehicle(s) live now"
 *   ride:   "Follow a live bus" | "No live buses to follow right now"
 *   plan:   "Door to door, scheduled + live times" (static)
 *   routes: "{routeCount} routes on the map"
 *   near:   "N routes near you" | "Near me is on" |
 *           "N routes around the map center" | "Location is on" |
 *           "Stops around you"
 *   alerts: "Checking…" | "Alert feed unavailable" |
 *           "No active alerts" | "N active alert(s)"
 */

export const FV_SHEET_KEY = "lt-fv-sheet";
export const FV_GREETING = "Detroit, live.";
export const FV_TITLE = "What do you want to do?";
export const FV_DRAG_COLLAPSE_PX = 64;
export const FV_TILES = [
  { action: "live", name: "Live map", proofKey: "live" },
  { action: "plan", name: "Plan a trip", proofKey: "plan" },
  { action: "ride", name: "Ride along", proofKey: "ride" },
  { action: "routes", name: "All routes", proofKey: "routes" },
  { action: "near", name: "Near me", proofKey: "near" },
  { action: "alerts", name: "Alerts", proofKey: "alerts" },
];

function storageGet(storage, key) {
  try { return storage ? storage.getItem(key) : null; } catch { return null; }
}
function storageSet(storage, key, value) {
  try { if (storage) storage.setItem(key, value); } catch { /* session state stands */ }
}

/**
 * The proof lines from shared state. `liveTotal` is the header's
 * own count (null until the first poll lands); `alerts` is the
 * status module's state (T8); `near` is the filters' state plus
 * this sheet's center-fallback memory.
 */
export function fvProofs({ liveTotal = null, routeCount = 0, nearMeOn = false, nearMeCount = 0, centerRoutes = null, located = false, alerts = { checked: false, ok: false, count: 0 } } = {}) {
  const live = liveTotal === null ? "Connecting…"
    : liveTotal === 0 ? "No vehicles live right now"
    : `${liveTotal} ${liveTotal === 1 ? "vehicle live now" : "vehicles live now"}`;
  const ride = liveTotal === 0 ? "No live buses to follow right now" : "Follow a live bus";
  let near;
  if (nearMeOn) near = nearMeCount ? `${nearMeCount} ${nearMeCount === 1 ? "route" : "routes"} near you` : "Near me is on";
  else if (centerRoutes !== null) near = `${centerRoutes} ${centerRoutes === 1 ? "route" : "routes"} around the map center`;
  else if (located) near = "Location is on";
  else near = "Stops around you";
  const alertsLine = !alerts.checked ? "Checking…"
    : !alerts.ok ? "Alert feed unavailable"
    : alerts.count === 0 ? "No active alerts"
    : `${alerts.count} ${alerts.count === 1 ? "active alert" : "active alerts"}`;
  return {
    live, ride,
    plan: "Door to door, scheduled + live times",
    routes: `${routeCount} routes on the map`,
    near, alerts: alertsLine,
  };
}

/** Routes serving stops within `radiusM` of a point (the center fallback's count). */
export function routesNearPoint(stops, x, z, radiusM) {
  const seen = new Set();
  const r2 = radiusM * radiusM;
  for (const s of stops) {
    const dx = s.x - x, dz = s.z - z;
    if (dx * dx + dz * dz > r2) continue;
    for (const rid of s.routes ?? []) seen.add(String(rid));
  }
  return seen.size;
}

export function createFirstView({ storage = null, entries } = {}) {
  let open = storageGet(storage, FV_SHEET_KEY) !== "collapsed"; // absent = first view = open
  let occluded = false;
  let view = "tiles"; // 'tiles' | 'near'
  let centerRoutes = null;

  function persist() { storageSet(storage, FV_SHEET_KEY, open ? "open" : "collapsed"); }

  const api = {
    isOpen: () => open,
    isOccluded: () => occluded,
    view: () => view,
    centerRoutes: () => centerRoutes,
    /** Render state: the sheet shows iff open and not occluded; the handle iff neither. */
    renderState() {
      return { sheetVisible: open && !occluded, handleVisible: !open && !occluded };
    },
    setOpen(v, { persist: doPersist = false, focusHandle = true, focusFirst = false } = {}) {
      open = !!v;
      if (doPersist) persist();
      return { ...api.renderState(), focusHandle: !open && focusHandle, focusFirst: open && focusFirst };
    },
    /** Exclusion surfaces occlude transiently; the preference is untouched. */
    setOccluded(v) {
      occluded = !!v;
      return api.renderState();
    },
    /** Header drag: past the threshold collapses (persisted). */
    dragEnd(dy, moved) {
      if (moved && dy > FV_DRAG_COLLAPSE_PX) return api.setOpen(false, { persist: true });
      return null;
    },

    proofs(state) { return fvProofs({ ...state, centerRoutes }); },

    /* ---- tile actions: existing entry functions only ---- */

    tileAction(action, ctx = {}) {
      switch (action) {
        case "live":
          api.setOpen(false, { persist: true });
          return { kind: "live", focusMap: true };
        case "near":
          view = "near";
          return { kind: "near-choice" };
        case "plan":
          api.setOpen(false, { persist: true, focusHandle: false });
          entries.planTrip();
          return { kind: "plan" };
        case "ride":
          api.setOpen(false, { persist: true, focusHandle: false });
          entries.rideAlong();
          return { kind: "ride" };
        case "routes":
          api.setOpen(false, { persist: true, focusHandle: false });
          entries.openRoutes();
          return { kind: "routes" };
        case "alerts":
          api.setOpen(false, { persist: true, focusHandle: false });
          return { kind: "alerts", ...api.alertsAction(ctx.alerts) };
        default:
          return { kind: "none" };
      }
    },
    backToTiles() { view = "tiles"; return { kind: "tiles" }; },

    /**
     * The alerts tile: the existing alert text path announced
     * through the shared toast + screen-reader channel (T8 owns
     * the alert state and the what-changed wording).
     */
    alertsAction(alerts = { checked: false, ok: false, count: 0, firstText: null }) {
      if (!alerts.checked || !alerts.ok) {
        return { toast: "Service alerts are unavailable right now.", toastWarn: false, announce: "Service alerts are unavailable right now." };
      }
      if (!alerts.count) {
        return { toast: "No active service alerts.", toastWarn: false, announce: "No active service alerts." };
      }
      let msg = alerts.firstText || "";
      if (alerts.count > 1) msg += ` (+${alerts.count - 1} more active ${alerts.count === 2 ? "alert" : "alerts"})`;
      return { toast: msg, toastWarn: true, announce: msg };
    },

    /* ---- near-me choice ---- */

    /**
     * "Use my location": already on → say so and collapse; a fix
     * exists → engage and collapse; no fix → the locate flow
     * engages on success (pendingNearMe), permission requested
     * only here, in context, from this tap.
     */
    chooseNearLocation({ filters, hasFix }) {
      if (filters.state.nearMe) {
        api.setOpen(false, { persist: true });
        return { kind: "already-on", toast: { text: "Routes near you are on.", isError: false } };
      }
      centerRoutes = null;
      if (hasFix) {
        api.setOpen(false, { persist: true });
        return { kind: "engage" }; // the host calls filters.engageNearMe(userXZ, stops)
      }
      filters.setPendingNearMe(true);
      api.setOpen(false, { persist: true });
      return { kind: "request-locate" }; // the host runs the locate flow
    },
    /**
     * "Use map center": count the routes around the center, then
     * open the governed stop nearest the center — or say there
     * are none within the radius.
     */
    chooseNearCenter({ stops, center, radiusM, nearestStop }) {
      centerRoutes = routesNearPoint(stops, center.x, center.z, radiusM);
      const st = nearestStop(center.x, center.z, radiusM);
      if (!st) {
        return { kind: "none-near", toast: { text: `No stops within ${radiusM.toLocaleString("en-US")} m of the map center.`, isError: true } };
      }
      api.setOpen(false, { persist: true, focusHandle: false });
      return { kind: "show-stop", stop: st };
    },
  };
  return api;
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

export function renderFirstView({ doc, sheet, proofs, handlers = {} }) {
  const rs = sheet.renderState();
  const frag = el(doc, "div", "fv-root");

  const section = el(doc, "section", "fv-sheet");
  section.setAttribute("id", "fv-sheet");
  section.setAttribute("aria-labelledby", "fv-title");
  section.hidden = !rs.sheetVisible;

  const head = el(doc, "div", "fv-head");
  head.setAttribute("id", "fv-head");
  const grab = el(doc, "button", "fv-grab");
  grab.setAttribute("id", "fv-collapse");
  grab.setAttribute("aria-label", "Collapse the Explore sheet");
  grab.setAttribute("aria-expanded", String(sheet.isOpen()));
  grab.setAttribute("aria-controls", "fv-sheet");
  grab.appendChild(el(doc, "span"));
  on(grab, "click", () => handlers.onCollapse?.());
  head.appendChild(grab);
  const heading = el(doc, "div", "fv-heading");
  heading.appendChild(el(doc, "p", "fv-greeting", FV_GREETING));
  const h2 = el(doc, "h2", null, FV_TITLE);
  h2.setAttribute("id", "fv-title");
  heading.appendChild(h2);
  head.appendChild(heading);
  const justMap = el(doc, "button", "fv-just-map", "Just the map");
  justMap.setAttribute("id", "fv-just-map");
  on(justMap, "click", () => handlers.onCollapse?.());
  head.appendChild(justMap);
  section.appendChild(head);

  const grid = el(doc, "div", "fv-grid");
  grid.setAttribute("id", "fv-grid");
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", "Live Transit use cases");
  grid.hidden = sheet.view() !== "tiles";
  for (const tile of FV_TILES) {
    const b = el(doc, "button", "fv-tile");
    b.setAttribute("data-fv-action", tile.action);
    b.appendChild(el(doc, "span", "fv-tile-name", tile.name));
    b.appendChild(el(doc, "span", "fv-tile-proof", proofs[tile.proofKey]));
    on(b, "click", () => handlers.onTile?.(tile.action));
    grid.appendChild(b);
  }
  section.appendChild(grid);

  const near = el(doc, "div", "fv-near");
  near.setAttribute("id", "fv-near");
  near.hidden = sheet.view() !== "near";
  near.appendChild(el(doc, "h3", null, "Stops near you"));
  near.appendChild(el(doc, "p", null, "Use your location, or use the center of the map — no permission needed."));
  const actions = el(doc, "div", "fv-near-actions");
  const loc = el(doc, "button", "fv-near-primary", "Use my location");
  loc.setAttribute("id", "fv-near-location");
  on(loc, "click", () => handlers.onNearLocation?.());
  const ctr = el(doc, "button", "fv-near-secondary", "Use map center");
  ctr.setAttribute("id", "fv-near-center");
  on(ctr, "click", () => handlers.onNearCenter?.());
  const back = el(doc, "button", "fv-near-back", "Back");
  back.setAttribute("id", "fv-near-back");
  on(back, "click", () => handlers.onNearBack?.());
  actions.appendChild(loc);
  actions.appendChild(ctr);
  actions.appendChild(back);
  near.appendChild(actions);
  section.appendChild(near);
  frag.appendChild(section);

  const handle = el(doc, "button", "fv-handle", "Explore");
  handle.setAttribute("id", "fv-explore");
  handle.setAttribute("aria-expanded", String(sheet.isOpen()));
  handle.hidden = !rs.handleVisible;
  on(handle, "click", () => handlers.onHandle?.());
  frag.appendChild(handle);
  return frag;
}
