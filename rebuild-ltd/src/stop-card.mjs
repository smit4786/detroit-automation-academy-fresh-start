/**
 * LTD rebuild — the stop card (Tranche T5, M7 core, P-32).
 *
 * The card is a pure model plus a DOM builder. The model carries
 * every section as data: header (name, Stop ID, pole code), Serving
 * route chips with live counts, the arrivals board (arrivals.mjs),
 * the departure-board link, Live on these routes, the intersection
 * twin named as NOT this stop (the boarding-specificity contract —
 * a leg that boards here names this stop, never the bare corner),
 * the facility union (P-37), and the honest notes (QLINE
 * positions-only, SMART display-only + freshness, phantom stops).
 * Alert bands, the MoGo section, and the Place section render from
 * host providers — their data planes land at T8 (alerts) and T6
 * (GBFS / Places); the card owns the slots, not their feeds.
 *
 * The DOM builder uses DOM nodes and textContent only: a feed
 * string never enters innerHTML anywhere (R-44). The refresh
 * controller re-runs the model on the 30 s tick and rebuilds the
 * DOM only when the content signature changes — unchanged content
 * never rebuilds (the R-35 discipline, applied to the card).
 */

import { baseName } from "./stops.mjs";

export const CARD_TICK_MS = 30_000; // P-33 refresh cadence

/* ---- facility awareness (P-37) ---- */

const stemIndexCache = new WeakMap();

function stemIndex(registry) {
  let index = stemIndexCache.get(registry);
  if (index) return index;
  index = new Map();
  for (let i = 0; i < registry.count; i++) {
    const stop = registry.stopAt(i);
    if (!stop) continue;
    const stem = baseName(stop.name);
    if (!index.has(stem)) index.set(stem, []);
    index.get(stem).push(stop);
  }
  stemIndexCache.set(registry, index);
  return index;
}

/**
 * Facility union: same-stem stops within 500 m (this stop included)
 * and the union of the routes they serve — counts read across the
 * whole facility, not just this pole.
 */
export function facilityUnion(registry, stop, { radiusM = 500, visibleRoutes = null } = {}) {
  const stem = baseName(stop.name);
  const peers = (stemIndex(registry).get(stem) ?? []).filter(
    (s) => Math.hypot(s.x - stop.x, s.z - stop.z) <= radiusM,
  );
  const routes = new Set();
  for (const s of peers) {
    for (const r of s.routes ?? []) {
      if (visibleRoutes === null || visibleRoutes.has(r)) routes.add(r);
    }
  }
  return { stops: peers, routes: [...routes].sort() };
}

/* ---- model ---- */

export function formatClock(secOfDay) {
  const s = ((Math.floor(secOfDay) % 86400) + 86400) % 86400;
  const h24 = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function buildStopCardModel({
  registry,
  stop,
  arrivals = null,
  secOfDay = null,
  rawCounts = {},
  smartBand = null,
  providers = {},
}) {
  const routes = stop.routes ?? [];
  const chips = routes.map((routeId) => {
    const token = registry.tokenFor(routeId);
    return {
      routeId,
      tokenHex: token?.hex ?? null,
      liveCount: rawCounts[routeId] ?? 0,
    };
  });

  let board = null;
  if (arrivals) {
    board = {
      state: arrivals.state,
      note: arrivals.note ?? null,
      rows: (arrivals.rows ?? []).map((row) => ({
        routeId: row.routeId,
        headsign: row.headsign,
        timeSec: row.timeSec,
        clock: formatClock(row.timeSec),
        eta: secOfDay === null ? null
          : row.timeSec - secOfDay <= 0 ? "due"
            : row.timeSec - secOfDay < 90 ? "1 min"
              : `${Math.round((row.timeSec - secOfDay) / 60)} min`,
        tag: row.tag,
        distanceM: row.distanceM,
        // T10 amendment DV-T6-2: live rows carry their vehicleId
        // through the card model (the stop-tile bus-number suffix
        // renders from it); scheduled rows carry null.
        vehicleId: row.vehicleId ?? null,
      })),
    };
  }

  const liveOnRoutes = [...new Set(
    (arrivals?.rows ?? []).filter((r) => r.tag === "live").map((r) => r.routeId),
  )];

  const twins = registry.intersectionDetail(stop).map((d) => ({
    stopId: d.stop_id,
    name: d.name,
    poleCode: d.stop_code ?? null,
    distanceM: Math.round(d.distance_m),
    position: d.position,
    serves: d.serves ?? [],
    boardingStop: false, // the twin is never the boarding stop (D-7 contract)
  }));

  const facility = facilityUnion(registry, stop);

  const notes = [];
  if (stop.segment === "qline") {
    notes.push("QLINE publishes live positions only — no stop times for this stop.");
  }
  if (stop.segment === "smart") {
    notes.push("SMART times are scheduled; live SMART positions are display-only.");
    if (smartBand) notes.push(`SMART feed: ${smartBand.band}.`);
  }
  if (stop.recon_status === "phantom") {
    notes.push("This stop is not in the current feeds.");
  }

  const alertBands = providers.alertsFor ? (providers.alertsFor(stop) ?? []) : [];
  const mogo = providers.mogoFor ? providers.mogoFor(stop) : null;
  const place = providers.placeFor ? providers.placeFor(stop) : null;

  return {
    stopId: stop.stop_id,
    name: stop.name,
    poleCode: stop.stop_code ?? null,
    segment: stop.segment,
    chips,
    board,
    boardLink: `board/?stop=${encodeURIComponent(stop.stop_id)}`,
    liveOnRoutes,
    twins,
    facility: {
      stopCount: facility.stops.length,
      routes: facility.routes,
      isFacility: facility.stops.length > 1,
    },
    notes,
    alertBands,
    mogo,
    place,
  };
}

/* ---- DOM (nodes + textContent only, R-44) ---- */

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function renderStopCard(model, doc, { onClose = null } = {}) {
  const root = el(doc, "article", "stop-card");

  const header = el(doc, "header", "sc-head");
  header.appendChild(el(doc, "h3", "sc-name", model.name));
  if (onClose) {
    // F-1: the card's visible close control (the shell reserves
    // the 44px .close slot in every card). At T10 the stop card
    // rendered no close affordance at all.
    const closeBtn = el(doc, "button", "close", "✕");
    closeBtn.setAttribute("type", "button");
    closeBtn.setAttribute("aria-label", "Close stop card");
    if (typeof closeBtn.addEventListener === "function") {
      closeBtn.addEventListener("click", () => onClose());
    }
    header.appendChild(closeBtn);
  }
  const idLine = `Stop ${model.stopId}${model.poleCode ? ` · Pole ${model.poleCode}` : ""}`;
  header.appendChild(el(doc, "p", "sc-id", idLine));
  root.appendChild(header);

  for (const band of model.alertBands) {
    const bandEl = el(doc, "div", "sc-alert-band");
    bandEl.appendChild(el(doc, "strong", "sc-alert-lead", band.lead));
    bandEl.appendChild(el(doc, "span", "sc-alert-text", band.text));
    root.appendChild(bandEl);
  }

  const serving = el(doc, "section", "sc-serving");
  serving.appendChild(el(doc, "h4", null, "Serving"));
  const chipRow = el(doc, "div", "sc-chips");
  for (const chip of model.chips) {
    const chipEl = el(doc, "span", "sc-chip", chip.routeId);
    chipEl.setAttribute("data-route", chip.routeId);
    if (chip.tokenHex) chipEl.setAttribute("data-token", chip.tokenHex);
    if (chip.liveCount > 0) chipEl.setAttribute("data-live", String(chip.liveCount));
    chipRow.appendChild(chipEl);
  }
  serving.appendChild(chipRow);
  root.appendChild(serving);

  const boardSection = el(doc, "section", "sc-board");
  boardSection.appendChild(el(doc, "h4", null, "Next arrivals"));
  if (!model.board || model.board.state === "loading") {
    boardSection.appendChild(el(doc, "p", "sc-state", "Loading arrivals…"));
  } else if (model.board.state === "na") {
    boardSection.appendChild(el(doc, "p", "sc-state",
      model.board.note === "positions-only"
        ? "Live positions only — no stop times published for this stop."
        : "No timetable service at this stop."));
  } else if (model.board.state === "nosvc") {
    boardSection.appendChild(el(doc, "p", "sc-state", "No departures in the next three hours."));
  } else {
    for (const row of model.board.rows) {
      const rowEl = el(doc, "div", "sc-row");
      rowEl.appendChild(el(doc, "span", "sc-row-route", row.routeId));
      rowEl.appendChild(el(doc, "span", "sc-row-headsign", row.headsign));
      rowEl.appendChild(el(doc, "span", "sc-row-time", row.eta ? `${row.clock} · ${row.eta}` : row.clock));
      if (row.tag === "live") rowEl.appendChild(el(doc, "span", "sc-row-live", "LIVE"));
      boardSection.appendChild(rowEl);
    }
  }
  const boardLink = el(doc, "a", "sc-board-link", "Departure board");
  boardLink.setAttribute("href", model.boardLink);
  boardSection.appendChild(boardLink);
  root.appendChild(boardSection);

  if (model.liveOnRoutes.length) {
    const live = el(doc, "section", "sc-live-on");
    live.appendChild(el(doc, "h4", null, "Live on these routes"));
    live.appendChild(el(doc, "p", null, model.liveOnRoutes.join(", ")));
    root.appendChild(live);
  }

  if (model.twins.length) {
    const twinSection = el(doc, "section", "sc-twins");
    twinSection.appendChild(el(doc, "h4", null, "Across the intersection — not this stop"));
    for (const twin of model.twins) {
      const line = `${twin.name} · ${twin.distanceM} m ${twin.position}`
        + `${twin.poleCode ? ` · Pole ${twin.poleCode}` : ""}`
        + ` · serves ${twin.serves.join(", ")}`;
      twinSection.appendChild(el(doc, "p", "sc-twin", line));
    }
    root.appendChild(twinSection);
  }

  if (model.facility.isFacility) {
    const fac = el(doc, "section", "sc-facility");
    fac.appendChild(el(doc, "p", null,
      `This facility: ${model.facility.stopCount} stops · ${model.facility.routes.length} routes (${model.facility.routes.join(", ")}).`));
    root.appendChild(fac);
  }

  if (model.mogo) {
    const mogoSection = el(doc, "section", "sc-mogo");
    mogoSection.appendChild(el(doc, "h4", null, "MoGo"));
    mogoSection.appendChild(el(doc, "p", null, model.mogo.text));
    root.appendChild(mogoSection);
  }
  if (model.place) {
    const placeSection = el(doc, "section", "sc-place");
    placeSection.appendChild(el(doc, "h4", null, model.place.name));
    placeSection.appendChild(el(doc, "p", null, model.place.text));
    root.appendChild(placeSection);
  }

  for (const note of model.notes) {
    root.appendChild(el(doc, "p", "sc-note", note));
  }
  return root;
}

/* ---- refresh controller (30 s tick, signature-gated rebuilds) ---- */

export function createStopCardController({ doc, mount, buildModel, onClose = null }) {
  let signature = null;
  let renders = 0;
  function render(nowMs) {
    const model = buildModel(nowMs);
    const sig = JSON.stringify(model);
    if (sig === signature) return false;
    signature = sig;
    mount.textContent = "";
    mount.appendChild(renderStopCard(model, doc, { onClose }));
    renders++;
    return true;
  }
  return {
    open: (nowMs) => render(nowMs),
    tick: (nowMs) => render(nowMs),
    close() {
      signature = null;
      mount.textContent = "";
    },
    renderCount: () => renders,
  };
}
