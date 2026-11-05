/**
 * LTD rebuild — route filters + near-me (Tranche T6; P-27, P-28,
 * R-31, R-08's gate half).
 *
 * The rules of record, from the placed surface:
 *
 *   - `filterState.routes[rid]` is the ONLY visibility gate; any
 *     route toggles on its own, no group header required. Group
 *     headers are bulk setters (all on / all off) and never gate.
 *   - Group selection state ('all' | 'none' | 'mixed') is DERIVED
 *     from the routes, never stored.
 *   - Defaults are calm: only the ConnectTen core group starts on;
 *     SMART starts on unless the stored preference `lt-smart-on`
 *     is '0' (the stored preference wins; toggling the SMART group
 *     writes it back).
 *   - hideIdle defaults ON: a route confirmed 'not-running' is
 *     fully hidden; with hideIdle off it renders dimmed instead.
 *     QLINE is exempt — its geometry stays visible with no
 *     streetcars running (R-08). 'unknown' never hides.
 *   - Dimming is the same rule for every consumer: a route renders
 *     bright only while its running state is 'running'; 'unknown'
 *     and 'not-running' both dim (guideway alpha 0.22) — the map
 *     never implies a route is active before live data proves it.
 *   - Near-me (R-31): engaging snapshots every route choice;
 *     routes serving a stop within 1,250 m are auto-enabled
 *     (proximity wins — a near route is never silently suppressed
 *     by an off toggle) and the auto-enables are tracked;
 *     disengaging restores exactly the auto-enabled routes from
 *     the snapshot. A rider's explicit toggle during near-me owns
 *     that route and is never restored over.
 *
 * Groups are derived from the routes asset's own group lists —
 * the same input the renderer consumes. (The registry's
 * `routesInGroup` does not survive the asset's group-object
 * shape; see the T6 record, DV-T6-1.)
 */

export const NEAR_ME_M = 1250;
export const DIM_OPACITY = 0.22;
export const SMART_PREF_KEY = "lt-smart-on";

function storageGet(storage, key) {
  try { return storage ? storage.getItem(key) : null; } catch { return null; }
}
function storageSet(storage, key, value) {
  try { if (storage) storage.setItem(key, value); } catch { /* private mode: session state stands */ }
}

/** Group structure from the routes asset: [{ id, name, segment, routes }]. */
export function groupsFromAsset(routesAsset) {
  const groups = [];
  for (const segment of ["ddot", "smart", "qline"]) {
    const seg = routesAsset?.segments?.[segment];
    if (!seg) continue;
    for (const g of seg.groups ?? []) {
      groups.push({ id: g.id, name: g.name, segment, routes: [...(g.routes ?? [])] });
    }
  }
  return groups;
}

export function createFilters({ routesAsset, storage = null } = {}) {
  const groups = groupsFromAsset(routesAsset);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const routeOrder = groups.flatMap((g) => g.routes);

  const groupDefault = (g) => {
    if (g.id === "connect-ten") return true;
    if (g.segment === "smart") return storageGet(storage, SMART_PREF_KEY) !== "0";
    return false;
  };

  const state = {
    groups: {},           // gid -> bool (the last bulk-set value; selection state is derived)
    routes: {},           // rid -> bool — THE visibility gate
    hideIdle: true,
    nearMe: false,
  };
  for (const g of groups) {
    state.groups[g.id] = groupDefault(g);
    for (const rid of g.routes) state.routes[rid] = state.groups[g.id];
  }

  let nearMeSet = null;      // Set<rid> | null
  let nearMeAdded = new Set();
  let nearMeSnapshot = null; // { rid: bool } taken at engage
  let pendingNearMe = false;
  let srBaseline = null;     // last announced shown count

  function computeNearMeSet(userXZ, stops) {
    const set = new Set();
    if (!userXZ) return set;
    const r2 = NEAR_ME_M * NEAR_ME_M;
    for (const s of stops) {
      const dx = s.x - userXZ[0], dz = s.z - userXZ[1];
      if (dx * dx + dz * dz > r2) continue;
      for (const rid of s.routes ?? []) set.add(String(rid));
    }
    return set;
  }

  function autoEnable(set) {
    for (const rid of set) {
      if (!state.routes[rid]) { state.routes[rid] = true; nearMeAdded.add(rid); }
    }
  }

  const api = {
    groups,
    routeOrder,
    state,

    routeOn(rid) { return !!state.routes[String(rid)]; },

    /** Explicit rider toggle: the rider's choice owns the route. */
    toggleRoute(rid) {
      rid = String(rid);
      state.routes[rid] = !state.routes[rid];
      nearMeAdded.delete(rid);
      return state.routes[rid];
    },
    setRoute(rid, on, { explicit = false } = {}) {
      rid = String(rid);
      state.routes[rid] = !!on;
      if (explicit) nearMeAdded.delete(rid);
    },

    groupState(gid) {
      const g = groupById.get(gid);
      if (!g || !g.routes.length) return "none";
      let on = 0;
      for (const rid of g.routes) if (state.routes[rid]) on++;
      if (on === 0) return "none";
      if (on === g.routes.length) return "all";
      return "mixed";
    },

    setGroup(gid, on) {
      const g = groupById.get(gid);
      if (!g) return;
      state.groups[gid] = !!on;
      if (g.segment === "smart") storageSet(storage, SMART_PREF_KEY, on ? "1" : "0");
      for (const rid of g.routes) { state.routes[rid] = !!on; nearMeAdded.delete(rid); }
    },
    /** Header press: all-on switches off; anything else switches on. */
    pressGroupHeader(gid) {
      const on = api.groupState(gid) !== "all";
      api.setGroup(gid, on);
      return on;
    },

    showAll() {
      if (state.nearMe) api.disengageNearMe();
      for (const g of groups) state.groups[g.id] = true;
      for (const rid of routeOrder) state.routes[rid] = true;
      storageSet(storage, SMART_PREF_KEY, "1");
    },
    showNone() {
      if (state.nearMe) api.disengageNearMe();
      for (const g of groups) state.groups[g.id] = false;
      for (const rid of routeOrder) state.routes[rid] = false;
      storageSet(storage, SMART_PREF_KEY, "0");
    },

    setHideIdle(on) { state.hideIdle = !!on; },

    nearOk(rid) { return !state.nearMe || !!(nearMeSet && nearMeSet.has(String(rid))); },

    /** The one gate every render path reads (P-28). */
    routeShown(rid, runningState) {
      rid = String(rid);
      if (!state.routes[rid]) return false;
      if (!api.nearOk(rid)) return false;
      if (rid !== "QLINE" && state.hideIdle && runningState === "not-running") return false;
      return true;
    },
    /** Guideway dim rule: bright only while proven running. */
    dimmed(runningState) { return runningState !== "running"; },
    routeAlpha(rid, runningState, streetFade = 1) {
      if (!api.routeShown(rid, runningState)) return 0;
      return (api.dimmed(runningState) ? DIM_OPACITY : 1) * streetFade;
    },

    shownCount(runningStates = {}) {
      let n = 0;
      for (const rid of routeOrder) if (api.routeShown(rid, runningStates[rid])) n++;
      return n;
    },
    /**
     * Screen-reader announcement discipline: the first call records
     * the baseline and says nothing; later calls announce only when
     * the shown count actually changed (applyFilters also runs on
     * every live poll — an unchanged count must not spam).
     */
    srAnnouncement(runningStates = {}) {
      const n = api.shownCount(runningStates);
      if (srBaseline === null) { srBaseline = n; return null; }
      if (n === srBaseline) return null;
      srBaseline = n;
      return `${n} ${n === 1 ? "route" : "routes"} shown on the map.`;
    },

    /* ---- near-me (R-31) ---- */

    engageNearMe(userXZ, stops) {
      nearMeSnapshot = {};
      for (const rid of routeOrder) nearMeSnapshot[rid] = !!state.routes[rid];
      nearMeAdded = new Set();
      state.nearMe = true;
      pendingNearMe = false;
      nearMeSet = computeNearMeSet(userXZ, stops);
      autoEnable(nearMeSet);
      return { count: nearMeSet.size };
    },
    /** Location moved while near-me is on: rebuild the set, auto-enable anew. */
    recomputeNearMe(userXZ, stops) {
      if (!state.nearMe) return { count: 0 };
      nearMeSet = computeNearMeSet(userXZ, stops);
      autoEnable(nearMeSet);
      return { count: nearMeSet.size };
    },
    disengageNearMe() {
      state.nearMe = false;
      pendingNearMe = false;
      if (nearMeSnapshot) {
        for (const rid of nearMeAdded) state.routes[rid] = !!nearMeSnapshot[rid];
      }
      nearMeSnapshot = null;
      nearMeAdded = new Set();
      nearMeSet = null;
    },
    nearMeCount() { return nearMeSet ? nearMeSet.size : 0; },
    nearMeRoutes() { return nearMeSet ? [...nearMeSet] : []; },
    setPendingNearMe(v) { pendingNearMe = !!v; },
    pendingNearMe() { return pendingNearMe; },
    /** The engage toast, verbatim from the placed surface. */
    nearMeToast() {
      const n = api.nearMeCount();
      return n
        ? { text: `${n} routes within ${NEAR_ME_M} m of you.`, isError: false }
        : { text: `No routes within ${NEAR_ME_M} m of you.`, isError: true };
    },

    /* ---- panel counts (P-27) ---- */

    countsModel({ liveCounts = {}, runningStates = {}, liveEverOk = false } = {}) {
      const perRoute = new Map();
      for (const rid of routeOrder) {
        perRoute.set(rid, {
          count: liveEverOk ? String(liveCounts[rid] || 0) : "–",
          notRunning: runningStates[rid] === "not-running",
        });
      }
      const perGroup = new Map();
      for (const g of groups) {
        if (!liveEverOk) { perGroup.set(g.id, "–"); continue; }
        if (state.nearMe && nearMeSet) {
          let shownNear = 0;
          for (const rid of g.routes) if (nearMeSet.has(rid) && api.routeShown(rid, runningStates[rid])) shownNear++;
          perGroup.set(g.id, `${shownNear} of ${g.routes.length} shown near you`);
        } else {
          let run = 0;
          for (const rid of g.routes) if (runningStates[rid] === "running") run++;
          perGroup.set(g.id, `${run} of ${g.routes.length} running`);
        }
      }
      return {
        perRoute,
        perGroup,
        nearMeSub: `${NEAR_ME_M} m${state.nearMe ? ` · ${api.nearMeCount()} near you` : ""}`,
      };
    },
  };
  return api;
}

/* ---- panel rendering (nodes + textContent only, R-44) ---- */

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}
function on(node, type, fn) {
  if (node && typeof node.addEventListener === "function") node.addEventListener(type, fn);
}

/**
 * Build the filter panel's group sections + the filter-owned rows.
 * Layer toggles owned by other modules (People Mover, MoGo,
 * Places, beta) render their own rows into the same panel at
 * assembly; the SMART freshness sentence slots (age label + age
 * note) are rendered here and filled by the status module (T8).
 */
export function renderFilterPanel({ doc, filters, counts, names, handlers = {} }) {
  const root = el(doc, "div", "filter-groups");
  for (const g of filters.groups) {
    const sec = el(doc, "div", "f-group");
    sec.setAttribute("data-group", g.id);
    if (filters.groupState(g.id) === "none") sec.classList?.add?.("off");

    const head = el(doc, "div", "f-group-head");
    head.setAttribute("data-group", g.id);
    const check = el(doc, "button", "f-check");
    check.setAttribute("aria-label", `Toggle all ${g.name} routes`);
    const st = filters.groupState(g.id);
    check.setAttribute("aria-pressed", st === "mixed" ? "mixed" : String(st === "all"));
    check.appendChild(el(doc, "span", "f-box"));
    on(check, "click", () => handlers.onGroupToggle?.(g.id));
    head.appendChild(check);

    const label = el(doc, "button", "f-label");
    label.setAttribute("aria-expanded", "false");
    label.setAttribute("aria-label", `Expand ${g.name} routes`);
    label.appendChild(el(doc, "b", null, g.name));
    if (g.segment === "smart") {
      const age = el(doc, "span", "f-count");
      age.setAttribute("id", "smart-age-label");
      label.appendChild(age);
    }
    const fc = el(doc, "span", "f-count", counts?.perGroup.get(g.id) ?? "–");
    fc.setAttribute("id", `fgc-${g.id}`);
    label.appendChild(fc);
    label.appendChild(el(doc, "span", "f-chev", "▾"));
    on(label, "click", () => handlers.onGroupExpand?.(g.id, sec, label));
    head.appendChild(label);
    sec.appendChild(head);

    const list = el(doc, "div", "f-routes");
    const chips = g.routes.slice().sort((a, b) =>
      names.label(a).localeCompare(names.label(b)));
    for (const rid of chips) {
      const c = counts?.perRoute.get(rid);
      const b = el(doc, "button", "route-chip f-chip");
      b.setAttribute("data-route", rid);
      b.setAttribute("aria-pressed", String(filters.routeOn(rid)));
      if (c?.notRunning) b.classList?.add?.("not-running");
      const dot = el(doc, "i");
      dot.setAttribute("data-token-dot", rid);
      b.appendChild(dot);
      b.appendChild(el(doc, "b", null, names.label(rid)));
      const cnt = el(doc, "span", "cnt", c?.count ?? "–");
      cnt.setAttribute("id", `cnt-${rid}`);
      b.appendChild(cnt);
      const idle = el(doc, "span", "idle-tag", "not running");
      idle.setAttribute("id", `idle-${rid}`);
      idle.hidden = !c?.notRunning;
      b.appendChild(idle);
      on(b, "click", () => handlers.onRouteToggle?.(rid));
      list.appendChild(b);
    }
    sec.appendChild(list);

    if (g.segment === "smart") {
      const note = el(doc, "p", "f-smart-note",
        `All ${g.routes.length} routes have map lines. Vehicle positions via Swiftly GTFS-Realtime.`);
      const ageNote = el(doc, "span");
      ageNote.setAttribute("id", "smart-age-note");
      note.appendChild(ageNote);
      sec.appendChild(note);
    }
    root.appendChild(sec);
  }

  const near = el(doc, "button", "f-group-head f-near");
  near.setAttribute("id", "nearme-toggle");
  near.setAttribute("aria-pressed", String(filters.state.nearMe));
  near.setAttribute("title", `Show only routes with a stop within ${NEAR_ME_M} m of you`);
  near.appendChild(el(doc, "span", "f-box"));
  near.appendChild(el(doc, "b", null, "Routes near me"));
  const sub = el(doc, "span", "f-count", counts?.nearMeSub ?? `${NEAR_ME_M} m`);
  sub.setAttribute("id", "nearme-sub");
  near.appendChild(sub);
  on(near, "click", () => handlers.onNearMeToggle?.());
  root.appendChild(near);

  const idle = el(doc, "button", "f-group-head");
  idle.setAttribute("id", "hide-idle-toggle");
  idle.setAttribute("aria-pressed", String(filters.state.hideIdle));
  idle.appendChild(el(doc, "span", "f-box"));
  idle.appendChild(el(doc, "b", null, "Hide non-running routes"));
  on(idle, "click", () => handlers.onHideIdleToggle?.());
  root.appendChild(idle);

  const foot = el(doc, "div", "f-foot");
  const all = el(doc, "button", null, "Show all");
  all.setAttribute("id", "filter-all");
  on(all, "click", () => handlers.onShowAll?.());
  const none = el(doc, "button", null, "All off");
  none.setAttribute("id", "filter-none");
  on(none, "click", () => handlers.onShowNone?.());
  foot.appendChild(all);
  foot.appendChild(none);
  root.appendChild(foot);
  return root;
}

/**
 * Signature-gated panel controller, on the stop card's pattern.
 *
 * `extraRows(doc)` is the assembly's slot (F-2): the layer rows
 * owned by other modules (People Mover, MoGo, Places) render into
 * the same panel through it — the header contract at the top of
 * this file. The controller invokes it on every rebuild and
 * appends the returned nodes after the filter-owned root, so the
 * rows survive the signature-gated re-renders that would wipe
 * anything the host appended to the mount directly. Between
 * rebuilds the rows are live nodes; their owners keep their own
 * pressed/count state current (the panel signature does not cover
 * layer state).
 */
export function createFilterPanel({ doc, mount, filters, names, getCounts, handlers = {}, extraRows = null }) {
  let signature = null;
  let renders = 0;
  // Group expansion is panel state, owned here (F-1): the render
  // rebuilds the DOM on every signature change, so expansion kept
  // only in DOM classes would reset on the next poll. The set
  // survives re-renders; render() re-applies it to the fresh tree.
  const expanded = new Set();
  function applyExpansion(root) {
    for (const sec of root?.children ?? []) {
      if (!sec.className || !String(sec.className).includes("f-group")) continue;
      const gid = typeof sec.getAttribute === "function" ? sec.getAttribute("data-group") : null;
      if (!gid) continue;
      const on = expanded.has(gid);
      if (on) sec.classList?.add?.("open"); else sec.classList?.remove?.("open");
      const head = sec.children?.[0];
      const label = head?.children?.[1];
      if (label && typeof label.setAttribute === "function") {
        label.setAttribute("aria-expanded", String(on));
      }
    }
  }
  const wiredHandlers = {
    ...handlers,
    onGroupExpand: (gid, sec, label) => {
      const on = !expanded.has(gid);
      if (on) expanded.add(gid); else expanded.delete(gid);
      if (sec) {
        if (on) sec.classList?.add?.("open"); else sec.classList?.remove?.("open");
      }
      if (label && typeof label.setAttribute === "function") {
        label.setAttribute("aria-expanded", String(on));
      }
      handlers.onGroupExpand?.(gid, sec, label);
    },
  };
  function render() {
    const counts = getCounts();
    const sig = JSON.stringify({
      routes: filters.state.routes, groups: [...filters.groups].map((g) => filters.groupState(g.id)),
      hideIdle: filters.state.hideIdle, nearMe: filters.state.nearMe,
      counts: [...counts.perRoute.entries()], perGroup: [...counts.perGroup.entries()],
      nearMeSub: counts.nearMeSub,
    });
    if (sig === signature) return false;
    signature = sig;
    mount.textContent = "";
    if (typeof handlers.onClose === "function") {
      const headRow = el(doc, "div", "panel-head");
      headRow.appendChild(el(doc, "span", "panel-title", "Routes"));
      const closeBtn = el(doc, "button", "panel-close", "Close");
      closeBtn.setAttribute("type", "button");
      closeBtn.setAttribute("aria-label", "Close routes panel");
      on(closeBtn, "click", () => handlers.onClose());
      headRow.appendChild(closeBtn);
      mount.appendChild(headRow);
    }
    const root = renderFilterPanel({ doc, filters, counts, names, handlers: wiredHandlers });
    applyExpansion(root);
    mount.appendChild(root);
    if (typeof extraRows === "function") {
      const extra = extraRows(doc);
      for (const n of Array.isArray(extra) ? extra : [extra]) {
        if (n) mount.appendChild(n);
      }
    }
    renders++;
    return true;
  }
  return { sync: render, renderCount: () => renders, expandedGroups: () => [...expanded] };
}
