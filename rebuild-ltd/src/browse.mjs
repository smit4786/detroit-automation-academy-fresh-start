/**
 * LTD rebuild — the browse panel + passes (Tranche T6; P-25, P-26,
 * and the Project 24 deep-link floor).
 *
 * Three tabs — Buses / Stops / Passes — with WAI-ARIA tab
 * semantics: roving tabindex, Arrow/Home/End keys with automatic
 * activation. Every tappable 3D object is also a real button here:
 * selection flows through the same showStop/showBus paths as
 * canvas taps (the host wires the row actions).
 *
 *   - Bus rows: "{Route label} · Bus {id}" / "to {destination}",
 *     sorted routes ascending numerically then vehicle numbers
 *     ascending numerically (lexicographic fallback), searched
 *     over route id + vehicle id + route name + destination. The
 *     list holds buses on the VISIBLE routes only — the host
 *     passes the gate-filtered slot set.
 *   - Stop rows: name-sorted, dot = the first serving route's
 *     token, "{n} routes · ID {id}", capped at 200 with the
 *     refine-your-search line.
 *   - Alert advisories ride both row kinds from a host provider
 *     (the alert fx computation is the status module's, T8):
 *     "{glyph} {label} at this stop" / "on a serving route" /
 *     "on this route", severe-styled for NO_SERVICE.
 *   - Passes: the pane of record — Dart passes are sold by DDOT
 *     and SMART through their apps and stores; Live Transit does
 *     not sell passes. `openPasses()` is the deep-link floor: the
 *     hand-off surface the trip-detail Dart line points at.
 */

export const BROWSE_STOP_CAP = 200;

export const PASSES = {
  note: "Dart passes are sold by DDOT and SMART through their apps and stores. Live Transit does not sell passes.",
  rows: [
    { name: "Dart Regional — 4 Hour", price: "$2 · $0.50 reduced", buyLabel: "Buy in Token Transit", href: "https://tokentransit.com/app" },
    { name: "Dart Regional — 24 Hour", price: "$5 · $2 reduced", buyLabel: "Buy in Token Transit", href: "https://tokentransit.com/app" },
    { name: "Dart Regional — 7 Day", price: "$22 · $10 reduced", buyLabel: "Buy in Token Transit", href: "https://tokentransit.com/app" },
    { name: "Dart Regional — 31 Day", price: "$70 · $29 reduced", buyLabel: "Buy in Token Transit", href: "https://tokentransit.com/app" },
    { name: "SMART — 31 Day (SMART only)", price: "$66 · $17 reduced", buyLabel: "Buy from SMART", href: "https://www.smartbus.org/Fares/Buy-Passes" },
  ],
  pricesNote: "Prices as published by SMART/DDOT. Reduced fares: seniors 65+, people with disabilities, Medicare cardholders, and students with school ID.",
  otherWays: [
    { label: "Buy in Transit app", href: "https://transitapp.com/download.html" },
    { label: "SMART Buy Passes page", href: "https://www.smartbus.org/Fares/Buy-Passes" },
    { label: "DDOT fares page", href: "https://detroitmi.gov/departments/detroit-department-transportation/transportation-fares" },
  ],
};

/** Project 24 deep-link floor: open the panel on the Passes tab. */
export function openPassesIntent() {
  return { openPanel: true, tab: "passes" };
}

export function createBrowseTabs(initial = "buses") {
  let active = initial;
  const order = ["buses", "stops", "passes"];
  return {
    active: () => active,
    select(tab) { if (order.includes(tab)) active = tab; return active; },
    /** Arrow/Home/End navigation with automatic activation. */
    key(keyName, current) {
      const i = order.indexOf(current ?? active);
      if (i < 0) return null;
      let j = null;
      if (keyName === "ArrowRight") j = (i + 1) % order.length;
      else if (keyName === "ArrowLeft") j = (i - 1 + order.length) % order.length;
      else if (keyName === "Home") j = 0;
      else if (keyName === "End") j = order.length - 1;
      if (j === null || j === i) return null;
      active = order[j];
      return active;
    },
    tabState() {
      return order.map((id) => ({
        id, selected: id === active, tabIndex: id === active ? 0 : -1, paneHidden: id !== active,
      }));
    },
  };
}

function numKey(x) {
  const n = parseInt(x, 10);
  return Number.isNaN(n) ? null : n;
}
function numCmp(a, b) {
  const na = numKey(a), nb = numKey(b);
  if (na !== null && nb !== null) return na - nb;
  if (na !== null) return -1;
  if (nb !== null) return 1;
  return String(a).localeCompare(String(b));
}

/**
 * Bus rows from the visible-route slot set. `destFor(vehicle)`
 * applies Route Reverse (bus-card.mjs's displayDest).
 * `advisoryForRoute(rid)` -> { glyph, label, severe } | null (T8).
 */
export function browseBusRows({ slots, query = "", names, destFor, advisoryForRoute = null }) {
  let list = [...slots];
  const q = String(query || "").toLowerCase();
  if (q) {
    list = list.filter((s) => {
      const v = s.vehicle;
      const hay = `${v.routeId} ${v.vehicleId || ""} ${names.name(v.routeId) || ""} ${destFor(v) || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }
  list.sort((a, b) =>
    numCmp(a.vehicle.routeId, b.vehicle.routeId) || numCmp(a.vehicle.vehicleId, b.vehicle.vehicleId));
  const rows = list.map((s) => {
    const v = s.vehicle;
    const dest = destFor(v);
    const adv = advisoryForRoute ? advisoryForRoute(v.routeId) : null;
    return {
      vehicle: v,
      title: `${names.label(v.routeId)} · Bus ${v.vehicleId || ""}`,
      sub: dest ? `to ${dest}` : (names.name(v.routeId) || "DDOT"),
      ariaLabel: `Bus ${v.vehicleId || ""}, ${names.label(v.routeId)}${dest ? `, to ${dest}` : ""}`,
      advisory: adv ? { ...adv, text: `${adv.glyph} ${String(adv.label).toLowerCase()} on this route` } : null,
    };
  });
  return {
    rows,
    count: rows.length,
    countLabel: rows.length ? `(${rows.length})` : "",
    emptyText: rows.length ? null : (q ? "No buses match." : "No buses on the visible routes right now."),
  };
}

/**
 * Stop rows from the governed pick set. `advisoryForStop(stop)`
 * -> { glyph, label, severe, scope: 'stop' | 'route' } | null (T8).
 */
export function browseStopRows({ stops, query = "", advisoryForStop = null }) {
  const all = [...stops].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const q = String(query || "").toLowerCase();
  const filtered = q ? all.filter((st) => (st.name || "").toLowerCase().includes(q)) : all;
  const shown = filtered.slice(0, BROWSE_STOP_CAP);
  const rows = shown.map((st) => {
    const n = (st.routes || []).length;
    const adv = advisoryForStop ? advisoryForStop(st) : null;
    return {
      stop: st,
      title: st.name || "Stop",
      sub: `${n} ${n === 1 ? "route" : "routes"}${st.stop_id ? ` · ID ${st.stop_id}` : ""}`,
      ariaLabel: `Stop ${st.name || "unnamed"}, served by ${n} ${n === 1 ? "route" : "routes"}`,
      firstRoute: (st.routes || [])[0] ?? null,
      advisory: adv ? {
        ...adv,
        text: `${adv.glyph} ${String(adv.label).toLowerCase()} ${adv.scope === "stop" ? "at this stop" : "on a serving route"}`,
      } : null,
    };
  });
  return {
    rows,
    total: filtered.length,
    emptyText: rows.length ? null : (all.length ? "No stops match." : "Stops still loading…"),
    moreText: filtered.length > BROWSE_STOP_CAP
      ? `Showing ${BROWSE_STOP_CAP} of ${filtered.length} — refine your search.` : null,
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

export function renderPassesPane(doc) {
  const pane = el(doc, "div", "passes-pane");
  pane.appendChild(el(doc, "p", "passes-note", PASSES.note));
  const ul = el(doc, "ul", "passes-list");
  for (const row of PASSES.rows) {
    const li = el(doc, "li", "pass-row");
    const main = el(doc, "span", "pass-main");
    main.appendChild(el(doc, "b", null, row.name));
    main.appendChild(el(doc, "span", null, row.price));
    li.appendChild(main);
    const a = el(doc, "a", "pass-buy", row.buyLabel);
    a.setAttribute("href", row.href);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener");
    li.appendChild(a);
    ul.appendChild(li);
  }
  pane.appendChild(ul);
  pane.appendChild(el(doc, "p", "passes-note", PASSES.pricesNote));
  const other = el(doc, "p", "passes-note", "Other ways to buy: ");
  PASSES.otherWays.forEach((w, i) => {
    if (i) other.appendChild(el(doc, "span", null, " · "));
    const a = el(doc, "a", null, w.label);
    a.setAttribute("href", w.href);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener");
    other.appendChild(a);
  });
  pane.appendChild(other);
  return pane;
}

export function renderBrowseList(doc, { kind, model, onPick }) {
  const ul = el(doc, "ul", "browse-list");
  if (model.emptyText) {
    ul.appendChild(el(doc, "li", "browse-empty", model.emptyText));
    return ul;
  }
  for (const row of model.rows) {
    const li = el(doc, "li");
    const b = el(doc, "button");
    b.setAttribute("aria-label", row.ariaLabel);
    const dot = el(doc, "i", "b-dot");
    dot.setAttribute("data-token-dot", row.vehicle ? row.vehicle.routeId : (row.firstRoute ?? ""));
    b.appendChild(dot);
    const main = el(doc, "span", "b-main");
    main.appendChild(el(doc, "b", null, row.title));
    main.appendChild(el(doc, "span", null, row.sub));
    if (row.advisory) {
      main.appendChild(el(doc, "span", `b-adv${row.advisory.severe ? " severe" : ""}`, row.advisory.text));
    }
    b.appendChild(main);
    on(b, "click", () => onPick?.(row));
    li.appendChild(b);
    ul.appendChild(li);
  }
  if (model.moreText) ul.appendChild(el(doc, "li", "browse-empty", model.moreText));
  return ul;
}
