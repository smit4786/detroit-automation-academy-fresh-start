/**
 * LTD rebuild — the MoGo bikeshare layer (Tranche T6; P-65).
 *
 * Live station availability from MoGo's public GBFS v3.0 feed
 * (detroit.publicbikesystem.net), fetched DIRECTLY by the client
 * — no proxy, no key (verified 2026-10-14: ACAO * on a simple GET;
 * client-side also holds the privacy bar: nothing about the rider
 * leaves the device). Its own filter-panel toggle, OFF by default
 * (Justin's ruling, 2026-10-14). station_status polls on the
 * 60 s bus cadence; station_information re-checks hourly and is
 * replaced only when the feed's last_updated changes.
 *
 * Data rules (recon 2026-10-05, of record):
 *   - Canonical availability is the v3.0 vehicle count +
 *     per-type rows; the deprecated v2.x availability field is
 *     zero everywhere upstream and is NEVER read.
 *   - QUARANTINE: last_reported over 5 minutes old, or not
 *     installed — gray, flattened markers, excluded from planner
 *     bike legs (the eligibility flags below), and the card says
 *     so in words.
 *   - Zero-bike stations stay visible, dimmed and shortened — a
 *     rider's corner station reading empty is information.
 *   - Stations that can neither rent nor return are not rendered.
 *   - Nothing is carried by color alone: marker HEIGHT encodes
 *     state (75 full · 40 empty · 22 quarantined, on the stop
 *     family's base scale), an e-assist ring circles stations
 *     with an EFIT available, a count badge ("🚲 N", or the word
 *     "stale") appears below 9,000 m, the card states bikes,
 *     docks and status in words, and the SR surface names every
 *     shown station's state.
 *   - Feed failure is an honest state, never silent: markers
 *     clear, the toggle reads "unavailable", the SR note says
 *     the feed could not be loaded. The last good layer is kept
 *     for card/SR bookkeeping; the next tick retries.
 */

import { STOP_BASE_Y } from "./geometry.mjs";
import { cylinderBuffers, ringBuffers } from "./marker-geometry.mjs";
import { mergeBuffers } from "./geometry.mjs";
import { toWorld } from "./projection.mjs";

export const MOGO_GBFS_BASE = "https://detroit.publicbikesystem.net/customer/gbfs/v3.0";
export const MOGO_POLL_MS = 60_000;
export const MOGO_INFO_RECHECK_MS = 60 * 60 * 1000;
export const MOGO_FETCH_TIMEOUT_MS = 20_000;
export const MOGO_STALE_MS = 5 * 60 * 1000;
export const MOGO_LIVE_TYPES = ["ICONIC", "EFIT"];
export const MOGO_DOT_COLORS = { green: "#A4A4A4", amber: "#ADADAD", red: "#6A6A6A", grey: "#8F8F8F" };
export const MOGO_BASE_H = 75; // the single-route stop pylon's base height
export const MOGO_BADGE_MAX_DIST_M = 9000;
export const MOGO_SR_DOWN_TEXT = "MoGo bikeshare availability is unavailable — the GBFS feed could not be loaded.";

/* ---- data layer (pure) ---- */

export function mogoEnName(localized) {
  if (typeof localized === "string") return localized;
  if (!Array.isArray(localized)) return "";
  const en = localized.find((row) => row && row.language === "en");
  const pick = en || localized[0];
  return (pick && pick.text) || "";
}

export function mogoTypeCounts(vehicleTypesAvailable) {
  const counts = {};
  for (const row of vehicleTypesAvailable || []) {
    if (row && row.vehicle_type_id) counts[row.vehicle_type_id] = Number(row.count) || 0;
  }
  return counts;
}

export function mogoBuildStation(info, status, nowMs) {
  const st = status || {};
  const reported = st.last_reported ? new Date(st.last_reported).getTime() : NaN;
  const stale = !Number.isFinite(reported) || (nowMs - reported) > MOGO_STALE_MS;
  const installed = st.is_installed === true;
  const renting = st.is_renting === true;
  const returning = st.is_returning === true;
  const vehiclesTotal = Number(st.num_vehicles_available) || 0;
  const docksTotal = Number(st.num_docks_available) || 0;
  const counts = mogoTypeCounts(st.vehicle_types_available);
  const iconic = counts.ICONIC || 0;
  const efit = counts.EFIT || 0;
  const retiredNonzero = {};
  for (const t of Object.keys(counts)) {
    if (!MOGO_LIVE_TYPES.includes(t) && counts[t] > 0) retiredNonzero[t] = counts[t];
  }
  return {
    id: String(info.station_id),
    name: mogoEnName(info.name),
    lat: Number(info.lat),
    lon: Number(info.lon),
    address: info.address || "",
    capacity: Number(info.capacity) || 0,
    installed, renting, returning, stale,
    vehiclesTotal, docksTotal,
    iconic, efit, otherNonzero: retiredNonzero,
    vehicleDocksAvailable: st.vehicle_docks_available || [],
    eligiblePickup: installed && renting && vehiclesTotal >= 1 && !stale,
    eligibleDropoff: installed && returning && docksTotal >= 1 && !stale,
    statusClass: (!installed || stale) ? "quarantined"
      : vehiclesTotal >= 5 ? "plenty" : vehiclesTotal >= 1 ? "low" : "empty",
    statusHue: (!installed || stale) ? "grey"
      : vehiclesTotal >= 5 ? "green" : vehiclesTotal >= 1 ? "amber" : "red",
    efitRing: efit >= 1,
    visible: installed && (renting || returning),
    lastReported: st.last_reported || null,
    updatedAgeMs: Number.isFinite(reported) ? Math.max(0, nowMs - reported) : null,
  };
}

export function mogoBuildLayer(infoPayload, statusPayload, nowMs) {
  const infos = (infoPayload && infoPayload.data && infoPayload.data.stations) || [];
  const statusById = {};
  for (const s of (statusPayload && statusPayload.data && statusPayload.data.stations) || []) {
    statusById[String(s.station_id)] = s;
  }
  const stations = infos.map((info) => mogoBuildStation(info, statusById[String(info.station_id)], nowMs));
  const byId = {};
  for (const s of stations) byId[s.id] = s;
  const sum = (f) => stations.reduce((a, s) => a + f(s), 0);
  const cnt = (f) => stations.filter(f).length;
  const summary = {
    stationCount: stations.length,
    visible: cnt((s) => s.visible),
    renting: cnt((s) => s.renting && s.installed),
    withVehicles: cnt((s) => s.vehiclesTotal >= 1),
    totalVehicles: sum((s) => s.vehiclesTotal),
    totalIconic: sum((s) => s.iconic),
    totalEfit: sum((s) => s.efit),
    totalDocks: sum((s) => s.docksTotal),
    quarantined: cnt((s) => s.stale || !s.installed),
    pickupEligible: cnt((s) => s.eligiblePickup),
    dropoffEligible: cnt((s) => s.eligibleDropoff),
  };
  return { stations, byId, summary };
}

export function mogoPanelTally(summary) {
  const v = summary ? summary.totalVehicles : 0;
  const s = summary ? summary.withVehicles : 0;
  return `${v} bike${v === 1 ? "" : "s"} · ${s} station${s === 1 ? "" : "s"} live`;
}

/** The plain-language status sentence — card, SR list, toggle note. */
export function mogoStatusSentence(st) {
  if (!st.installed) return "This station is not installed.";
  if (st.stale) return "This station’s feed reports are stale — its counts may be out of date, and it is excluded from trip-planner bike legs.";
  if (st.renting && st.returning) return "Renting and accepting returns.";
  if (st.renting) return "Renting only — returns are not accepted here.";
  if (st.returning) return "Returns only — no rentals here.";
  return "Not renting or accepting returns.";
}

export function mogoSrText(st) {
  let s = `${st.name}: `;
  if (!st.installed) return s + "not installed.";
  if (st.stale) return s + "station reports are stale; availability may be out of date.";
  if (st.vehiclesTotal === 0) s += "no bikes available";
  else {
    s += `${st.vehiclesTotal} ${st.vehiclesTotal === 1 ? "bike" : "bikes"} available`;
    const parts = [];
    if (st.iconic > 0) parts.push(`${st.iconic} standard`);
    if (st.efit > 0) parts.push(`${st.efit} e-assist`);
    if (parts.length) s += ` (${parts.join(", ")})`;
  }
  s += `, ${st.docksTotal} ${st.docksTotal === 1 ? "dock" : "docks"} available.`;
  return s;
}

export function mogoBadgeText(st) {
  if (!st.installed || st.stale) return "stale";
  return `🚲 ${st.vehiclesTotal}`; // count text, not color alone
}

/** Stop-card model: zero rows for vehicle types are omitted. */
export function mogoCardModel(station, nowMs) {
  if (!station) return null;
  const lines = [];
  if (station.iconic > 0) lines.push({ label: "Standard bikes", value: String(station.iconic) });
  if (station.efit > 0) lines.push({ label: "E-assist bikes", value: String(station.efit) });
  for (const t of Object.keys(station.otherNonzero || {})) {
    if (station.otherNonzero[t] > 0) lines.push({ label: t, value: String(station.otherNonzero[t]) });
  }
  lines.push({ label: "Docks available", value: String(station.docksTotal) });
  const ageMs = station.updatedAgeMs;
  const updated = (station.stale || ageMs === null || ageMs === undefined) ? "stale"
    : ageMs < 60_000 ? "updated just now"
    : `updated ${Math.round(ageMs / 60_000)} min ago`;
  return {
    title: station.name,
    address: station.address || "",
    bikesLine: station.stale ? "Counts may be out of date"
      : station.vehiclesTotal === 0 ? "No bikes available"
      : `${station.vehiclesTotal} ${station.vehiclesTotal === 1 ? "bike available" : "bikes available"}`,
    lines,
    status: mogoStatusSentence(station),
    updated,
    pickupEligible: station.eligiblePickup,
    dropoffEligible: station.eligibleDropoff,
  };
}

/**
 * The card note: the address prints only when it says something
 * the title does not (the feed's address duplicates the station
 * name — asterisk included — for most stations).
 */
export function mogoCardNote(model) {
  const bits = [];
  const addrBit = (model.address || "").replace(/^\*\s*/, "");
  const nameBit = (model.title || "").replace(/^\*\s*/, "");
  if (addrBit && addrBit !== nameBit) bits.push(addrBit);
  bits.push(model.status);
  bits.push(`Availability ${model.updated}.`);
  return bits.join(" ");
}

/** Height encodes state alongside color. */
export function mogoHeightFor(st) {
  if (st.statusClass === "quarantined") return 22;
  if (st.vehiclesTotal === 0) return 40;
  return MOGO_BASE_H;
}

/* ---- poll service ---- */

export function createMogoService({
  fetchImpl = fetch,
  baseUrl = MOGO_GBFS_BASE,
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (h) => clearInterval(h),
  isHidden = () => false,
  now = () => Date.now(),
} = {}) {
  let infoCache = null;
  let infoFetchedAtMs = 0;
  let layer = null;
  let ok = null; // null until the first poll settles: the toggle reads "loading", never a premature "unavailable"
  let timer = null;
  const listeners = new Set();

  async function fetchJson(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), MOGO_FETCH_TIMEOUT_MS);
    try {
      const r = await fetchImpl(url, { cache: "no-store", signal: ctrl.signal });
      if (!r.ok) throw new Error(`gbfs http ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function refreshInfo(force = false) {
    const t = now();
    if (infoCache && !force && (t - infoFetchedAtMs) < MOGO_INFO_RECHECK_MS) return infoCache;
    const payload = await fetchJson(`${baseUrl}/station_information.json`);
    infoFetchedAtMs = t;
    if (!infoCache || payload.last_updated !== infoCache.last_updated) infoCache = payload;
    return infoCache;
  }

  function emit() {
    const snapshot = { ok, layer, fetchedAtMs: now() };
    for (const fn of listeners) { try { fn(snapshot); } catch { /* listener failure never breaks the poll */ } }
  }

  async function poll() {
    try {
      const info = await refreshInfo(false);
      const status = await fetchJson(`${baseUrl}/station_status.json`);
      layer = mogoBuildLayer(info, status, now());
      ok = true;
    } catch {
      ok = false; // honest unavailable; last layer kept for bookkeeping
    }
    emit();
    return { ok, layer };
  }

  return {
    poll,
    start() {
      if (timer !== null) return;
      poll();
      timer = setTimer(() => { if (!isHidden()) poll(); }, MOGO_POLL_MS);
    },
    stop() { if (timer !== null) { clearTimer(timer); timer = null; } },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    state: () => ({ ok, layer }),
  };
}

/* ---- layer rendering + surfaces ---- */

function hexToInt(hex) { return parseInt(String(hex).slice(1), 16); }
function shadeInt(hex, f) {
  const n = hexToInt(hex);
  const r = Math.floor(((n >> 16) & 0xff) * f);
  const g = Math.floor(((n >> 8) & 0xff) * f);
  const b = Math.floor((n & 0xff) * f);
  return (r << 16) | (g << 8) | b;
}

export function createMogoLayer({ gl, scene, service }) {
  let visibleWanted = false; // toggle, OFF by default
  let nodes = [];
  let pickList = [];

  function shownStations() {
    const { ok, layer } = service.state();
    if (!ok || !layer) return [];
    return layer.stations.filter((s) => s.visible);
  }

  function rebuild(stopScale = 1) {
    for (const n of nodes) gl.setNodeVisible(n, false);
    nodes = [];
    pickList = [];
    const list = shownStations();
    const byHue = new Map();
    const rings = [];
    for (const st of list) {
      const [x, z] = toWorld(st.lat, st.lon);
      const h = mogoHeightFor(st) * stopScale;
      let color = hexToInt(MOGO_DOT_COLORS[st.statusHue] || MOGO_DOT_COLORS.grey);
      if (st.statusClass === "quarantined") color = shadeInt(MOGO_DOT_COLORS[st.statusHue], 0.6);
      else if (st.vehiclesTotal === 0) color = shadeInt(MOGO_DOT_COLORS[st.statusHue], 0.5);
      if (!byHue.has(color)) byHue.set(color, []);
      byHue.get(color).push(cylinderBuffers({
        x, z, yBase: STOP_BASE_Y, height: h, rTop: 16, rBase: 20, segments: 10,
      }));
      if (st.efitRing) {
        rings.push(ringBuffers({ x, z, y: STOP_BASE_Y + 4, rInner: 30, rOuter: 44 }));
      }
      pickList.push({ id: st.id, n: st.name, name: st.name, x, z, r: [], routes: [], mogo: true, station: st });
    }
    const show = visibleWanted && list.length > 0 && service.state().ok;
    for (const [color, bufs] of byHue) {
      const mesh = gl.makeMesh(mergeBuffers(bufs), { color });
      gl.addToScene(scene, mesh);
      gl.setNodeVisible(mesh, show);
      nodes.push(mesh);
    }
    if (rings.length) {
      const ringMesh = gl.makeMesh(mergeBuffers(rings), {
        color: 0xf2f2f2, transparent: true, opacity: 0.5,
      });
      gl.addToScene(scene, ringMesh);
      gl.setNodeVisible(ringMesh, show);
      nodes.push(ringMesh);
    }
    return pickList;
  }

  return {
    rebuild,
    pickRecords: () => (visibleWanted && service.state().ok ? pickList : []),
    badgeDescriptors(camDistM) {
      if (!visibleWanted || !service.state().ok || camDistM >= MOGO_BADGE_MAX_DIST_M) return [];
      return pickList.map((rec) => ({
        text: mogoBadgeText(rec.station), x: rec.x, z: rec.z,
        y: STOP_BASE_Y + mogoHeightFor(rec.station) + 30,
      }));
    },
    setVisible(on) {
      visibleWanted = !!on;
      const show = visibleWanted && service.state().ok && pickList.length > 0;
      for (const n of nodes) gl.setNodeVisible(n, show);
      return visibleWanted;
    },
    visible: () => visibleWanted,
    toggleModel() {
      const { ok, layer } = service.state();
      return {
        pressed: visibleWanted,
        countText: ok === false ? "unavailable" : layer ? mogoPanelTally(layer.summary) : "loading",
      };
    },
    /** SR surface model: every shown station named in words. */
    srModel() {
      const { ok, layer } = service.state();
      const shown = ok && layer ? layer.stations.filter((s) => s.visible) : [];
      return {
        note: !ok ? MOGO_SR_DOWN_TEXT
          : `MoGo GBFS feed: ${layer.summary.stationCount} stations, ${shown.length} shown, ` +
            `${layer.summary.quarantined} with stale reports.`,
        lines: shown.map((s) => mogoSrText(s)),
      };
    },
    /**
     * Availability-transition announcements only (never the first
     * state): loaded with the panel tally, or unavailable.
     */
    transitionAnnouncement(prevOk) {
      const { ok, layer } = service.state();
      if (prevOk === null || prevOk === undefined || prevOk === ok) return null;
      return ok
        ? `MoGo bikeshare availability loaded: ${mogoPanelTally(layer.summary)}.`
        : "MoGo bikeshare availability is unavailable right now.";
    },
  };
}

/**
 * The stop card's MoGo provider (T5 slot): a MoGo pick record
 * renders its station card; any other record gets no section —
 * the placed behavior (the MoGo card is the station's own card).
 * The text carries the Bikes line, the type rows, the status
 * sentence, and the availability age in words.
 */
export function mogoCardProvider(service) {
  return (record) => {
    if (!record || !record.mogo || !record.station) return null;
    const { layer } = service.state();
    const fresh = layer && layer.byId[record.station.id] ? layer.byId[record.station.id] : record.station;
    const m = mogoCardModel(fresh, Date.now());
    if (!m) return null;
    const rows = m.lines.map((ln) => `${ln.label}: ${ln.value}`).join(" · ");
    return { text: `${m.bikesLine}. ${rows}. ${mogoCardNote(m)}` };
  };
}
