/**
 * M10 — Ride Along tile (clean-room rebuild, Tranche T7).
 *
 * The rider's-seat view of one bus: pick a bus, see where it is on
 * its route, its next stop, and the stops ahead — with times from
 * the host's provider when the bus is bound to a trip (P-52…P-55).
 * The widget fetches nothing and knows nothing about feeds; the
 * host (ride-host.mjs) feeds it routes, stops and vehicle slots
 * through the contract of record (P-60) and answers its callbacks.
 *
 * Geometry follows the widget lineage: flatten the route path with
 * cumulative arc, locate the bus by nearest-segment projection,
 * read travel direction from the bus's bearing against the path's
 * (≤ 90° off the path bearing runs forward), upcoming stops are
 * strictly ahead in travel order, capped at 12. One rebuild
 * adaptation, named: a route carries one path per direction, so
 * the bus is located on the nearest of its route's paths rather
 * than on one flattened concatenation of both.
 *
 * Rendering is nodes + textContent only (R-44), and content is
 * signature-gated (R-35): an unchanged model never rebuilds the
 * DOM; a changed one swaps with the scroll position preserved.
 */

export const GATE_NOTE =
  "This route is off in your filters, so the bus and its stops are hidden on the map. " +
  "Your ride keeps tracking; turn the route on in Filters to see it on the map again.";
export const CHOOSE_HINT = "Pick a bus to see upcoming stops from the rider's seat.";
export const MAX_UPCOMING = 12;
export const AHEAD_EPS_M = 5;
export const AT_STOP_M = 20;

/* ---------------------------------------------------------------- */
/* Geometry (exposed for tests, the lineage's hook pattern)          */
/* ---------------------------------------------------------------- */

export function flattenPath(points) {
  const pts = points.map((p) => ({ x: p[0], z: p[1] }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  return { pts, cum, total: cum[cum.length - 1] || 0 };
}

function segBearingDeg(x1, z1, x2, z2) {
  const deg = (Math.atan2(x2 - x1, -(z2 - z1)) * 180) / Math.PI;
  return (deg + 360) % 360;
}

export function locateOnPath(flat, x, z) {
  let best = null;
  for (let i = 0; i + 1 < flat.pts.length; i++) {
    const a = flat.pts[i];
    const b = flat.pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const dist = Math.hypot(x - px, z - pz);
    if (!best || dist < best.dist) {
      best = {
        arc: flat.cum[i] + Math.sqrt(len2) * t,
        dist,
        segIdx: i,
        px,
        pz,
        pathBearingDeg: segBearingDeg(a.x, a.z, b.x, b.z),
      };
    }
  }
  return best;
}

export function angleDiffDeg(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/** Stops of one route located on a flattened path, arc order. */
export function stopsAlongPath(flat, stops, routeId) {
  const out = [];
  for (const s of stops) {
    if (!s.r || !s.r.includes(routeId)) continue;
    const loc = locateOnPath(flat, s.x, s.z);
    if (loc) out.push({ stop: s, arc: loc.arc });
  }
  out.sort((a, b) => a.arc - b.arc);
  return out;
}

/**
 * Travel-order view of a located bus: direction from bearing vs
 * path bearing, the stops strictly ahead (≤ MAX_UPCOMING), and the
 * reference stop the bus is at / just past.
 */
export function travelView(flat, along, busArc, bearingDeg, pathBearingDeg) {
  const forward =
    bearingDeg == null || angleDiffDeg(bearingDeg, pathBearingDeg) <= 90;
  const sOf = (arc) => (forward ? arc : -arc);
  const busS = sOf(busArc);
  const ordered = [...along].sort((a, b) => sOf(a.arc) - sOf(b.arc));
  const ahead = ordered.filter((e) => sOf(e.arc) > busS + AHEAD_EPS_M).slice(0, MAX_UPCOMING);
  let ref = null;
  for (const e of ordered) {
    if (sOf(e.arc) <= busS + AHEAD_EPS_M) ref = e;
    else break;
  }
  return {
    forward,
    ahead,
    ref,
    refPastM: ref ? busS - sOf(ref.arc) : null,
  };
}

export function streetsFromStopName(name) {
  return String(name)
    .split("&")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function upcomingIntersections(upcomingStops) {
  const seen = new Set();
  const out = [];
  for (const s of upcomingStops) {
    for (const street of streetsFromStopName(s.name)) {
      if (!seen.has(street)) {
        seen.add(street);
        out.push(street);
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------- */
/* The widget                                                        */
/* ---------------------------------------------------------------- */

/**
 * createRideAlong({ doc, mount, now = Date.now })
 * Host contract (P-60): setData / setVehicles / setTimesProvider /
 * setRiderPos / setReturnLabel / setFocusSpec / showScheduled /
 * clearScheduled / setBoardedMissing / board / alight / refresh,
 * with onBoard / onAlight / onReturnRequest / onScheduledClose
 * callbacks assigned by the host. board() returns false when the
 * widget does not know the vehicle — the host's return machinery
 * depends on that honest failure.
 */
export function createRideAlong({ doc, mount, now = () => Date.now() }) {
  let routes = new Map();
  let stops = new Map();
  let stopList = [];
  let vehicles = new Map();
  let lastRecords = new Map();
  let currentVid = null;
  let spec = null;
  let boardedMissing = false;
  let returnLabel = null;
  let timesProvider = null;
  let riderPos = null;
  let lastSig = null;
  let scrollEl = null;

  const widget = {
    onBoard: null,
    onAlight: null,
    onReturnRequest: null,
    onScheduledClose: null,

    setData({ routes: rs, stops: ss }) {
      routes = new Map((rs || []).map((r) => [String(r.id), r]));
      stopList = ss || [];
      stops = new Map(stopList.map((s) => [String(s.id), s]));
      widget.refresh();
    },

    setVehicles(list) {
      vehicles = new Map();
      for (const v of list || []) {
        vehicles.set(String(v.vehicle_id), v);
        lastRecords.set(String(v.vehicle_id), v);
      }
      widget.refresh();
    },

    setTimesProvider(fn) {
      timesProvider = fn;
      widget.refresh();
    },

    setRiderPos(x, z) {
      riderPos = x == null ? null : { x, z };
      widget.refresh();
    },

    setReturnLabel(label) {
      returnLabel = label || null;
      widget.refresh();
    },

    setFocusSpec(s) {
      spec = s || null;
      widget.refresh();
    },

    showScheduled(s) {
      spec = s || null;
      widget.refresh();
    },

    clearScheduled() {
      spec = null;
      widget.refresh();
    },

    setBoardedMissing(b) {
      boardedMissing = !!b;
      widget.refresh();
    },

    board(vehicleId) {
      const vid = String(vehicleId);
      if (!vehicles.has(vid)) return false;
      const prev = currentVid;
      currentVid = vid;
      widget.refresh();
      if (widget.onBoard) widget.onBoard(vid, prev);
      return true;
    },

    alight() {
      const prev = currentVid;
      currentVid = null;
      boardedMissing = false;
      widget.refresh();
      if (prev && widget.onAlight) widget.onAlight(prev);
    },

    refresh() {
      const model = buildModel();
      const sig = JSON.stringify(model);
      if (sig === lastSig) return false;
      const st = scrollEl ? scrollEl.scrollTop : 0;
      render(model);
      if (scrollEl) scrollEl.scrollTop = st;
      lastSig = sig;
      return true;
    },

    scrollTop() {
      return scrollEl ? scrollEl.scrollTop : 0;
    },
    setScrollTop(v) {
      if (scrollEl) scrollEl.scrollTop = v || 0;
    },

    get currentVehicleId() {
      return currentVid;
    },
    get scheduledSpec() {
      return spec;
    },
    get boardedMissing() {
      return boardedMissing;
    },
    get vehicles() {
      return [...vehicles.values()];
    },
    model: buildModel,
  };

  /* --------------------------- model --------------------------- */

  function routeOf(rec) {
    return routes.get(String(rec.route_id)) || null;
  }

  function headerOf(rec) {
    const route = routeOf(rec);
    return {
      color: route ? route.color : null,
      label: route ? route.label : String(rec.route_id),
      destination: rec.destination || "",
      vidLine:
        `Bus ${rec.vehicle_id}` +
        (rec.speed != null && Number.isFinite(rec.speed)
          ? ` · ${Math.round(rec.speed)} mph`
          : ""),
    };
  }

  function providerFor(rec) {
    if (!timesProvider || !rec) return null;
    try {
      return timesProvider(rec) || null;
    } catch {
      return null;
    }
  }

  function geometryFor(rec) {
    const route = routeOf(rec);
    if (!route || !route.paths || !route.paths.length) return { route, missing: true };
    let bestFlat = null;
    let bestLoc = null;
    for (const path of route.paths) {
      const flat = flattenPath(path);
      const loc = locateOnPath(flat, rec.x, rec.z);
      if (loc && (!bestLoc || loc.dist < bestLoc.dist)) {
        bestFlat = flat;
        bestLoc = loc;
      }
    }
    if (!bestLoc) return { route, missing: true };
    const along = stopsAlongPath(bestFlat, stopList, String(rec.route_id));
    const tv = travelView(bestFlat, along, bestLoc.arc, rec.bearing, bestLoc.pathBearingDeg);
    return { route, missing: false, tv };
  }

  function stopRow(stopLike, timeLabel) {
    const s = stops.get(String(stopLike.id));
    return {
      id: String(stopLike.id),
      name: stopLike.name ?? stopLike.n ?? "Stop", // data stops carry n; provider sequences carry name
      timeLabel: timeLabel || null,
      transfers: s
        ? (s.r || [])
            .filter((r) => routes.get(String(r)))
            .map((r) => routes.get(String(r)).label)
        : [],
    };
  }

  function boardedModel(rec) {
    const header = headerOf(rec);
    const prov = providerFor(rec);
    const base = {
      view: "boarded",
      header,
      gateNote: rec.gateClosed ? GATE_NOTE : null,
      returnLabel,
      showGetOff: true,
      note: prov && prov.note ? prov.note : null,
    };
    if (boardedMissing) {
      const ageS = rec.fixAtMs ? Math.max(0, Math.round((now() - rec.fixAtMs) / 1000)) : null;
      let schedStops = [];
      if (spec && spec.stops) {
        schedStops = spec.stops.map((s) => ({ id: s.id, name: s.name, timeLabel: null, transfers: [] }));
      } else if (prov && prov.seqIds) {
        schedStops = prov.seqIds.map((s) => stopRow(s, null));
      } else {
        const g = geometryFor(rec);
        if (!g.missing) schedStops = g.tv.ahead.map((e) => stopRow(e.stop, null));
      }
      return {
        ...base,
        state: "missing",
        ageLine:
          ageS == null
            ? "This bus has stopped reporting."
            : `This bus stopped reporting — last report ${ageS < 90 ? `${ageS}s` : `${Math.round(ageS / 60)} min`} ago.`,
        stops: schedStops,
      };
    }
    if (prov && prov.atTerminal) {
      return { ...base, state: "terminal", terminalName: prov.atTerminal, stops: [] };
    }
    if (prov && prov.layover) {
      const seq = (prov.seqIds || []).slice(0, MAX_UPCOMING);
      return {
        ...base,
        state: "layover",
        terminalName: prov.layover.terminal,
        departLine: `Leaves at ${prov.layover.departClock}${prov.layover.headsign ? ` · ${prov.layover.headsign}` : ""}`,
        stops: seq.map((s) => stopRow(s, prov.byStop ? prov.byStop[s.id] : null)),
      };
    }
    const g = geometryFor(rec);
    if (g.missing) {
      return {
        ...base,
        state: "ride",
        routePathMissing: true,
        routeId: String(rec.route_id),
        stops: [],
      };
    }
    let upcoming;
    if (prov && prov.seqIds) {
      upcoming = prov.seqIds.slice(0, MAX_UPCOMING).map((s) => stopRow(s, prov.byStop[s.id]));
    } else {
      upcoming = g.tv.ahead.map((e) => {
        const row = stopRow(e.stop, prov && prov.byStop ? prov.byStop[e.stop.id] : null);
        row.transfers = row.transfers.filter((t) => t !== header.label);
        return row;
      });
    }
    const next = upcoming.length ? upcoming[0] : null;
    let nextCard = null;
    if (next) {
      const streets = streetsFromStopName(next.name);
      nextCard = {
        name: next.name,
        intersection: streets.length >= 2 ? `Intersection of ${streets.join(" and ")}` : null,
        transfers: next.transfers.filter((t) => t !== header.label),
        timeLabel: next.timeLabel,
      };
    }
    return {
      ...base,
      state: "ride",
      routePathMissing: false,
      youAreHere: g.tv.ref
        ? `You are here · ${g.tv.refPastM != null && g.tv.refPastM > AT_STOP_M ? "just past" : "at"} ${g.tv.ref.stop.n}`
        : null,
      nextStop: nextCard,
      stops: upcoming.slice(1),
      intersections: upcomingIntersections(upcoming),
      noFurther: upcoming.length === 0,
    };
  }

  function buildModel() {
    if (currentVid) {
      const rec = vehicles.get(currentVid) || lastRecords.get(currentVid);
      if (rec) return boardedModel(rec);
    }
    if (spec) {
      const route = routes.get(String(spec.routeId));
      return {
        view: "scheduled",
        label: route ? route.label : String(spec.routeId),
        headsign: spec.headsign || "",
        basisLine: spec.basis === "typical" ? "Typical times" : "Scheduled times",
        stops: (spec.stops || []).map((s) => ({ id: s.id, name: s.name, label: s.label })),
        returnLabel,
        showGetOff: false,
      };
    }
    const opts = [...vehicles.values()]
      .map((v) => {
        const route = routes.get(String(v.route_id));
        const label = route ? route.label : String(v.route_id);
        return {
          vid: String(v.vehicle_id),
          text: `${label} · Bus ${v.vehicle_id}${v.destination ? ` → ${v.destination}` : ""}`,
        };
      })
      .sort((a, b) => a.text.localeCompare(b.text, undefined, { numeric: true }) || a.vid.localeCompare(b.vid, undefined, { numeric: true }));
    return {
      view: "choose",
      title: "Ride Along",
      hint: CHOOSE_HINT,
      options: opts,
      emptyText: opts.length ? null : "No buses reporting right now.",
      returnLabel,
      showGetOff: false,
    };
  }

  /* --------------------------- render ---------------------------- */

  function el(tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clearMount() {
    mount.textContent = "";
    scrollEl = null;
  }

  function chrome(model, parent) {
    if (model.returnLabel) {
      const b = el("button", "ral-return", model.returnLabel);
      b.setAttribute("type", "button");
      b.addEventListener("click", () => {
        if (widget.onReturnRequest) widget.onReturnRequest();
      });
      parent.appendChild(b);
    }
    if (model.showGetOff) {
      const b = el("button", "ral-getoff", "Get off this bus");
      b.setAttribute("type", "button");
      b.addEventListener("click", () => widget.alight());
      parent.appendChild(b);
    }
  }

  function headerBlock(model, parent) {
    const h = el("div", "ral-head");
    if (model.header.color) {
      const dot = el("span", "ral-dot");
      dot.setAttribute("style", `background:${model.header.color}`);
      h.appendChild(dot);
    }
    h.appendChild(el("span", "ral-route", model.header.label));
    if (model.header.destination) h.appendChild(el("span", "ral-dest", `→ ${model.header.destination}`));
    parent.appendChild(h);
    parent.appendChild(el("div", "ral-vid", model.header.vidLine));
  }

  function renderStopList(stops, parent, withLabels) {
    const ul = el("ul", "ral-stops");
    for (const s of stops) {
      const li = el("li", "ral-stop");
      li.appendChild(el("span", "ral-stop-name", s.name));
      const t = withLabels ? s.timeLabel : s.label;
      if (t) li.appendChild(el("span", "ral-stop-time", t));
      ul.appendChild(li);
    }
    parent.appendChild(ul);
  }

  function render(model) {
    clearMount();
    const root = el("div", "ral-root");
    const body = el("div", "ral-scroll");
    scrollEl = body;
    root.appendChild(body);
    mount.appendChild(root);

    if (model.view === "choose") {
      body.appendChild(el("h3", "ral-title", model.title));
      body.appendChild(el("p", "ral-hint", model.hint));
      if (model.emptyText) {
        body.appendChild(el("p", "ral-empty", model.emptyText));
      } else {
        const sel = doc.createElement("select");
        sel.className = "ral-picker";
        sel.setAttribute("aria-label", "Choose a bus to ride");
        const ph = doc.createElement("option");
        ph.textContent = "-- choose a bus --";
        ph.value = "";
        sel.appendChild(ph);
        for (const o of model.options) {
          const opt = doc.createElement("option");
          opt.textContent = o.text;
          opt.value = o.vid;
          sel.appendChild(opt);
        }
        sel.addEventListener("change", () => {
          if (sel.value) widget.board(sel.value);
        });
        body.appendChild(sel);
      }
    } else if (model.view === "scheduled") {
      const h = el("div", "ral-head");
      h.appendChild(el("span", "ral-route", model.label));
      if (model.headsign) h.appendChild(el("span", "ral-dest", `→ ${model.headsign}`));
      body.appendChild(h);
      body.appendChild(el("div", "ral-basis", model.basisLine));
      const close = el("button", "ral-close", "✕");
      close.setAttribute("type", "button");
      close.setAttribute("aria-label", "Close scheduled trip");
      close.addEventListener("click", () => {
        if (widget.onScheduledClose) widget.onScheduledClose();
      });
      body.appendChild(close);
      renderStopList(model.stops, body, false);
    } else {
      headerBlock(model, body);
      if (model.state === "missing") {
        body.appendChild(el("p", "ral-missing", model.ageLine));
        body.appendChild(el("div", "ral-kicker", "Scheduled stops"));
        renderStopList(model.stops, body, true);
      } else if (model.state === "terminal") {
        body.appendChild(el("div", "ral-kicker", "End of the run"));
        body.appendChild(el("div", "ral-big", model.terminalName));
      } else if (model.state === "layover") {
        body.appendChild(el("div", "ral-kicker", "At the terminal"));
        body.appendChild(el("div", "ral-big", model.terminalName));
        body.appendChild(el("div", "ral-depart", model.departLine));
        body.appendChild(el("div", "ral-kicker", "Upcoming stops"));
        renderStopList(model.stops, body, true);
      } else if (model.routePathMissing) {
        body.appendChild(
          el("p", "ral-note", `Bus ${currentVid} is on route ${model.routeId}, but the route path is not loaded yet.`),
        );
      } else {
        if (model.youAreHere) body.appendChild(el("div", "ral-you", model.youAreHere));
        if (model.nextStop) {
          const card = el("div", "ral-next");
          card.appendChild(el("div", "ral-kicker", "Next stop"));
          card.appendChild(el("div", "ral-big", model.nextStop.name));
          if (model.nextStop.intersection) card.appendChild(el("div", "ral-sub", model.nextStop.intersection));
          if (model.nextStop.timeLabel) card.appendChild(el("div", "ral-sub", model.nextStop.timeLabel));
          if (model.nextStop.transfers.length) {
            card.appendChild(el("div", "ral-sub", `Also at this stop: ${model.nextStop.transfers.join(" · ")}`));
          }
          body.appendChild(card);
          body.appendChild(el("div", "ral-kicker", "Upcoming stops"));
          renderStopList(model.stops, body, true);
        }
        if (model.noFurther) body.appendChild(el("p", "ral-note", "No further stops ahead on this run."));
        if (model.intersections.length) {
          body.appendChild(el("div", "ral-kicker", "Intersections ahead"));
          body.appendChild(el("div", "ral-intersections", model.intersections.join(" · ")));
        }
      }
      if (model.note) body.appendChild(el("p", "ral-note", model.note));
      if (model.gateNote) body.appendChild(el("p", "ral-gate", model.gateNote));
    }
    chrome(model, root);
  }

  return widget;
}

createRideAlong._geometry = {
  flattenPath,
  locateOnPath,
  stopsAlongPath,
  travelView,
  streetsFromStopName,
  upcomingIntersections,
  angleDiffDeg,
};
