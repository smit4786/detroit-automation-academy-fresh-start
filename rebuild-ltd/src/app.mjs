/**
 * LTD rebuild — assembly (Tranche T10).
 *
 * app.mjs is the composition root: it wires every module built in
 * T1–T8 into the generated shell (shell/live-transit.html) so the
 * rebuilt application boots as one product against the live
 * published payloads. It contains no domain logic of its own —
 * every behavior lives in the module that owns it; this file owns
 * only the seams:
 *
 *   - the data plane (registry.mjs loader) + renderer assets,
 *     fetched from the caller's data base, never vendored here;
 *   - the live-data binding (R-07): vehicles / alerts / SMART
 *     display + trip updates from FORGE_LIVE_DATA_URL, and the
 *     planner timetable by its production URL (R-07: by URL,
 *     never vendored);
 *   - the frame-stage registrations the renderer's loop contract
 *     reserves for T4–T8 (busMotion / follow / stopLabels /
 *     eases / ridePickLabels);
 *   - DOM ownership: cards, panels, the planner view, first view,
 *     toasts, the service notice, and the header counts — all
 *     rendered from module models with nodes + textContent only
 *     (R-44: no innerHTML anywhere in the assembly);
 *   - input: pointer orbit/pan, wheel dolly, and tap picking
 *     through picking.mjs arbitration (bus vs stop).
 *
 * createApp(env) is the whole assembly, parameterized so the UAT
 * harness can drive it headlessly (recording adapter + a fake
 * DOM + the live payloads). The browser bootstrap at the bottom
 * supplies the real environment: the three.js adapter (the sole
 * vendor importer, gl-three.mjs), a WebGL canvas in #stage, and
 * window.FORGE_LIVE_DATA_URL.
 */

import { createRegistry, loadDataPlane } from "./registry.mjs";
import { loadTimetable, bindTimetable } from "./timetable.mjs";
import { createEngine } from "./engine.mjs";
import { createRenderer } from "./renderer.mjs";
import { createRouteNames } from "./route-names.mjs";
import { buildArcAtlas } from "./arc-atlas.mjs";
import { createVehicleService, parseFeedTime } from "./vehicles.mjs";
import { createTracker } from "./tracker.mjs";
import { createMatcher } from "./matcher.mjs";
import { createVehicleLayer, buildDescriptors, declutterBadges, createFollow, registerVehicleStages } from "./vehicle-layer.mjs";
import { createStopLayer, registerStopLayerStages } from "./stop-layer.mjs";
import { StopLabels } from "./stop-labels.mjs";
import { StopPickGrid, arbitratePick } from "./picking.mjs";
import { createArrivals, createTuSource, createHeadsignJoin } from "./arrivals.mjs";
import { buildStopCardModel, createStopCardController } from "./stop-card.mjs";
import { loadFleet, buildBusCardModel, createBusCardController } from "./bus-card.mjs";
import { createFilters, createFilterPanel } from "./filters.mjs";
import { createBrowseTabs, browseBusRows, browseStopRows, renderBrowseList, renderPassesPane } from "./browse.mjs";
import { createPlannerHost } from "./planner.mjs";
import { createRideAlong } from "./ride-along.mjs";
import { createRideBindings, createTimesProvider, createRideHost } from "./ride-host.mjs";
import { createAlertService, applyChipBadges } from "./alerts.mjs";
import { createAlertLayer } from "./alert-layer.mjs";
import { createStatusMonitor } from "./status.mjs";
import { createPeopleMover } from "./peoplemover.mjs";
import { createMogoService, createMogoLayer, mogoCardProvider } from "./mogo.mjs";
import { createPlacesService, buildPlacesMeshes, placeCardProvider, placesMarkerDescriptors } from "./places.mjs";
import { createFirstView, renderFirstView } from "./first-view.mjs";
import { createLocate } from "./locate.mjs";
import { createFullscreen } from "./fullscreen.mjs";
import { createBetaSettings, upcomingStops, renderUpcomingStops } from "./beta.mjs";
import {
  createErrorLog, installErrorCapture, createRecoveryLadder, createContextGuard,
  createCameraSupervisor, createPlannerFaults, createInputWatch, installInputHeartbeat,
  createToasts, createWheelHint,
} from "./platform.mjs";

/* ------------------------------------------------------------------ */
/* Small DOM helpers (nodes + textContent only, R-44)                  */
/* ------------------------------------------------------------------ */

function el(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function clearNode(n) {
  if (!n) return;
  n.textContent = "";
}

function show(n, on = true) {
  if (!n) return;
  n.hidden = !on;
}

/** Civil-date helpers in the rider's timezone (America/Detroit by
 *  process TZ in tests; the browser's local zone in production). */
function ymdOf(ms) {
  const d = new Date(ms);
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function ymdShift(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const p = (v) => String(v).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}
function secOfDayOf(ms) {
  const d = new Date(ms);
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

/**
 * Screen point -> world point on the ground plane (y = 0), from
 * the rig's pose and the camera's fov. Pure math; the picking
 * grid works in world space, so this is the one projection the
 * assembly owns.
 */
export function unprojectGround({ position, target, fovDeg = 50, viewport, px, py }) {
  const w = Math.max(1, viewport.w), h = Math.max(1, viewport.h);
  const ndcX = (px / w) * 2 - 1;
  const ndcY = 1 - (py / h) * 2;
  const fwd = [target[0] - position[0], target[1] - position[1], target[2] - position[2]];
  const fl = Math.hypot(...fwd);
  const f = fwd.map((v) => v / fl);
  const right = [f[2], 0, -f[0]];
  const rl = Math.hypot(...right) || 1;
  const r = right.map((v) => v / rl);
  const up = [
    r[1] * f[2] - r[2] * f[1],
    r[2] * f[0] - r[0] * f[2],
    r[0] * f[1] - r[1] * f[0],
  ];
  const tan = Math.tan((fovDeg * Math.PI) / 360);
  const aspect = w / h;
  const dir = [
    f[0] + r[0] * ndcX * tan * aspect + up[0] * ndcY * tan,
    f[1] + r[1] * ndcX * tan * aspect + up[1] * ndcY * tan,
    f[2] + r[2] * ndcX * tan * aspect + up[2] * ndcY * tan,
  ];
  if (dir[1] >= -1e-9) return null; // ray never meets the ground
  const t = -position[1] / dir[1];
  return { x: position[0] + dir[0] * t, z: position[2] + dir[2] * t };
}

/** World point -> screen point (for badge declutter + label anchors). */
export function projectScreen({ position, target, fovDeg = 50, viewport, x, y = 0, z }) {
  const w = Math.max(1, viewport.w), h = Math.max(1, viewport.h);
  const fwd = [target[0] - position[0], target[1] - position[1], target[2] - position[2]];
  const fl = Math.hypot(...fwd);
  const f = fwd.map((v) => v / fl);
  const right = [f[2], 0, -f[0]];
  const rl = Math.hypot(...right) || 1;
  const r = right.map((v) => v / rl);
  const up = [
    r[1] * f[2] - r[2] * f[1],
    r[2] * f[0] - r[0] * f[2],
    r[0] * f[1] - r[1] * f[0],
  ];
  const v = [x - position[0], y - position[1], z - position[2]];
  const cx = v[0] * r[0] + v[1] * r[1] + v[2] * r[2];
  const cy = v[0] * up[0] + v[1] * up[1] + v[2] * up[2];
  const cz = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
  if (cz <= 0) return null;
  const tan = Math.tan((fovDeg * Math.PI) / 360);
  const aspect = w / h;
  return {
    x: ((cx / (cz * tan * aspect)) + 1) / 2 * w,
    y: (1 - cy / (cz * tan)) / 2 * h,
  };
}

/* ------------------------------------------------------------------ */
/* The assembly                                                        */
/* ------------------------------------------------------------------ */

export async function createApp(env = {}) {
  const doc = env.doc ?? null;
  const mounts = env.mounts ?? {};
  if (!mounts.firstView && mounts.firstViewSheet) mounts.firstView = mounts.firstViewSheet;
  const fetchImpl = env.fetchImpl ?? fetch;
  const now = env.now ?? (() => Date.now());
  const setTimer = env.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = env.clearTimer ?? ((h) => clearTimeout(h));
  const storage = env.storage ?? null;
  const session = env.sessionStorage ?? null;
  const reducedMotion = env.reducedMotion ?? (() => false);
  const liveBase = env.liveBase ?? null;
  const dataBase = env.dataBase ?? null;
  const timetableUrl = env.timetableUrl ?? null;
  const placesUrl = env.placesUrl ?? null;
  const fleetUrl = env.fleetUrl ?? null;
  const viewportOf = env.viewport ?? (() => ({ w: 1280, h: 800 }));

  const state = {
    booted: false,
    bootError: null,
    bound: false,
    plannerReady: false,
    selectedStopIdx: null,
    selectedVehicleKey: null,
    followVehicleKey: null,
    layers: { peoplemover: false, mogo: false, places: false },
    endpoints: { from: null, to: null },
    lastSnapshot: null,
    lastPollAt: null,
    counts: { vehicles: 0, matched: 0 },
  };

  /* ---------- platform (T8): error log, ladder, guards, toasts --- */
  const errLog = createErrorLog({ storage, now });
  installErrorCapture({ target: env.errorTarget ?? globalThis, log: errLog });
  const toasts = doc && mounts.toasts
    ? createToasts({ doc, mount: mounts.toasts, setTimer, clearTimer })
    : { show: () => {}, dismiss: () => {} };
  const ladderActions = [];
  const ladder = createRecoveryLadder({
    now,
    onAction: (action) => {
      // The ladder emits { level, action, kind, detail } objects.
      ladderActions.push(action);
      const name = action?.action ?? action;
      if (name === "reset-interaction") closeAllSurfaces();
      else if (name === "rebuild-layers") refreshLayers(now());
      else if (name === "reload") { if (env.reload) env.reload(); }
    },
  });
  const contextGuard = createContextGuard({ ladder, now });
  const cameraSupervisor = createCameraSupervisor({
    ladder,
    onRecovery: () => { /* pose re-application happens in the frame loop */ },
  });
  const plannerFaults = createPlannerFaults({
    onPause: () => toasts.show("Trip planning paused after repeated faults — the map stays live."),
  });
  const inputWatch = createInputWatch({ now });
  if (doc) installInputHeartbeat({ target: doc, watch: inputWatch });
  const wheelHint = createWheelHint({ session });

  function announce(text) {
    if (mounts.srLive) mounts.srLive.textContent = String(text ?? "");
  }
  function toast(text) { toasts.show(text); }

  /* ---------- data plane + renderer assets ------------------------ */
  if (!dataBase) throw new Error("app: dataBase is required");
  if (!liveBase) throw new Error("app: liveBase (FORGE_LIVE_DATA_URL) is required");
  const readAsset = async (name) => {
    const res = await fetchImpl(`${dataBase}/${name}`);
    if (!res.ok) throw new Error(`app: ${name} -> HTTP ${res.status}`);
    return res.json();
  };
  let registry, names, routesAsset;
  let renderer = null;
  try {
    registry = await loadDataPlane(dataBase, fetchImpl);
    names = createRouteNames(registry);
    routesAsset = await readAsset("routes-3d.json");
    const [streetsRaw, streetNames, water, belleIsle] = await Promise.all([
      readAsset("detroit-streets.json"),
      readAsset("detroit-street-names.json"),
      readAsset("detroit-water.json"),
      readAsset("belle-isle.json"),
    ]);
    let landmarks;
    try { landmarks = await readAsset("landmarks.json"); } catch { landmarks = undefined; }
    const streets = {
      freeway: new Float32Array(streetsRaw.freeway),
      arterial: new Float32Array(streetsRaw.arterial),
      local: new Float32Array(streetsRaw.local),
    };
    const gl = env.gl;
    if (!gl) throw new Error("app: env.gl (adapter) is required");
    renderer = createRenderer({
      gl,
      registry,
      data: { routes: routesAsset, streets, streetNames, water, belleIsle, landmarks },
      reducedMotion: reducedMotion(),
      onRecovery: (kind, info) => {
        errLog.record(`renderer-${kind}`, info?.error ? String(info.error?.message ?? info.error) : String(kind), info ?? {});
        if (kind === "context") contextGuard.fire(now());
        ladder.fire("renderer", now());
      },
      makeLabelTexture: env.makeLabelTexture ?? ((text) => ({ text })),
      glRenderer: env.glRenderer ?? null,
    });
    // Assembly seam (T10): when the caller created the three.js
    // adapter with a RouteVisibilityTable, the adapter's shaders
    // read that table's arrays while the renderer writes its own.
    // Point the renderer's table storage at the shared arrays so
    // setRouteVisibility drives the uniforms. No T3 module changes.
    if (env.routeVisibilityTable) {
      renderer.routeVis.alpha = env.routeVisibilityTable.alpha;
      renderer.routeVis.visible = env.routeVisibilityTable.visible;
    }
  } catch (err) {
    state.bootError = err;
    errLog.record("boot", String(err && err.message || err));
    if (mounts.serviceNotice) {
      mounts.serviceNotice.textContent = "Live Transit Detroit could not load its map data. Check the connection and reload.";
      show(mounts.serviceNotice, true);
    }
    // Minimal failed handle: the full handle references modules
    // that were never constructed on this path.
    return {
      state, failed: true, errLog, registry: null, renderer: null,
      start() { return this; }, stop() {}, stepFrame() {},
      pollLive: async () => null, closeAllSurfaces() {},
    };
  }
  const gl = env.gl;
  const scene = renderer.scene;

  /* ---------- scene layers (T3–T6 surfaces) ----------------------- */
  const stopLayer = createStopLayer(gl, scene, registry, { reducedMotion: reducedMotion() });
  registerStopLayerStages(renderer, stopLayer);
  const vehicleLayer = createVehicleLayer(gl, scene, {
    badgeTextureFactory: env.badgeTextureFactory ?? undefined,
  });
  const alertLayer = createAlertLayer({ gl, scene, registry });
  let peopleMover = null;
  try {
    const pmData = await readAsset("peoplemover.json");
    peopleMover = createPeopleMover({ data: pmData, gl, scene, names });
  } catch { peopleMover = null; }
  const mogoService = createMogoService({ fetchImpl });
  const mogoLayer = createMogoLayer({ gl, scene, service: mogoService });
  const placesService = createPlacesService({ url: placesUrl, fetchImpl });
  let placesMeshes = null;

  const allStops = [];
  for (let i = 0; i < registry.count; i++) {
    const s = registry.stopAt(i);
    if (s) allStops.push(s);
  }
  const pickGrid = new StopPickGrid(allStops);
  const stopLabels = new StopLabels(allStops);
  const stopLabelSprites = [];

  /* ---------- filters + route visibility -------------------------- */
  const filters = createFilters({ routesAsset, storage });
  const routeOrder = renderer.routeOrder.map((r) => r.route.id);
  const ordinalOf = (rid) => routeOrder.indexOf(String(rid));
  let liveCounts = {};
  let runningStates = {};
  let liveEverOk = false;

  function governedStops() {
    // The stop layer's governed set: stops served by at least one
    // currently shown route (T5's governed-set rule).
    const out = [];
    for (const s of allStops) {
      if ((s.routes ?? []).some((rid) => filters.routeShown(rid, runningStates[rid]))) out.push(s);
    }
    return out;
  }

  function applyFilters() {
    for (const rid of routeOrder) {
      const ord = ordinalOf(rid);
      const shown = filters.routeShown(rid, runningStates[rid]);
      renderer.setRouteVisibility(ord, {
        visible: shown,
        alpha: shown ? filters.routeAlpha(rid, runningStates[rid]) : 0,
      });
      renderer.setRouteLive(ord, (liveCounts[rid] ?? 0) > 0);
    }
    renderer.setSmartExtensionShown(filters.routeOn("261") || filters.groupState("smart") !== "none");
    stopLayer.setGoverned(governedStops());
    if (filterPanel) filterPanel.sync();
  }

  const filterPanel = doc && mounts.panelFilter
    ? createFilterPanel({
        doc,
        mount: mounts.panelFilter,
        filters,
        names,
        getCounts: () => filters.countsModel({ liveCounts, runningStates, liveEverOk }),
        handlers: {
          onToggleRoute: (rid) => { filters.toggleRoute(rid); applyFilters(); },
          onPressGroup: (gid) => { filters.pressGroupHeader(gid); applyFilters(); },
          onShowAll: () => { filters.showAll(); applyFilters(); },
          onShowNone: () => { filters.showNone(); applyFilters(); },
          onHideIdle: (on) => { filters.setHideIdle(on); applyFilters(); },
          onLayer: (layer, on) => setLayer(layer, on),
        },
      })
    : null;

  function setLayer(layer, on) {
    state.layers[layer] = !!on;
    if (layer === "peoplemover" && peopleMover) peopleMover.setVisible(on);
    if (layer === "mogo") {
      mogoLayer.setVisible(on);
      if (on) void mogoService.poll().then(() => { mogoLayer.rebuild(); mogoLayer.setVisible(true); });
    }
    if (layer === "places") {
      if (on && !placesMeshes) {
        void placesService.setOn(true).then(() => {
          placesMeshes = buildPlacesMeshes({
            gl, scene,
            descriptors: placesMarkerDescriptors(placesService.enabledPlaces(), renderer.rig.spherical.distance),
            stopScale: 1,
          });
        }).catch(() => { /* load failure surfaces via the card provider */ });
      }
      if (placesMeshes) for (const m of placesMeshes) gl.setNodeVisible(m, on);
    }
  }

  /* ---------- live stack: vehicles -> tracker -> matcher ---------- */
  const atlas = buildArcAtlas(registry);
  const routeUniverse = [];
  for (const [seg, segment] of Object.entries(routesAsset.segments)) {
    for (const r of segment.routes) routeUniverse.push({ routeId: r.id, agency: seg });
  }
  const vehicleService = createVehicleService({
    baseUrl: liveBase,
    projection: registry.projection,
    routeUniverse,
    fetchImpl,
    setTimer,
    clearTimer,
  });
  const tracker = createTracker(atlas);
  let bound = null;
  let engine = null;
  let matcher = null;
  let arrivals = null;
  let planner = null;
  let bindings = null;
  let timesFor = null;
  let rideHost = null;
  const statusMonitor = createStatusMonitor({ setTimer: () => 0, clearTimer: () => {} });
  const alertService = createAlertService({ baseUrl: liveBase, fetchImpl });
  const betaSettings = createBetaSettings({ storage });

  // TU source + headsign join (T5): the join degrades to empty when
  // the published headsign asset is absent (DV-T5-2 stands).
  const tuSource = createTuSource({ baseUrl: liveBase, fetchImpl });
  let headsignJoin = createHeadsignJoin(null);
  fetchImpl(`${liveBase}/smart-headsigns.json`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => { if (data) headsignJoin = createHeadsignJoin(data); })
    .catch(() => { /* empty join by design */ });

  function bindLiveStack(boundTimetable) {
    bound = boundTimetable;
    engine = createEngine(bound);
    matcher = createMatcher({ bound, atlas });
    arrivals = createArrivals({
      bound,
      registry,
      matcher,
      tuSource,
      routeVisible: (rid) => filters.routeShown(rid, runningStates[rid]),
    });
    bindings = createRideBindings({ matcher, tracker, registry, bound });
    timesFor = createTimesProvider({ bindings, registry });
    planner = createPlannerHost({
      engine,
      registry,
      names,
      getVehicles: () => vehicleService.snapshot().vehicles,
      routeOrder,
      intents: {
        onHighlight: () => {},
        onFly: (m) => flyToJourney(m),
      },
    });
    state.bound = true;
    state.plannerReady = true;
    renderPlanner();
  }

  // The timetable binds by URL (R-07), lazy like the placed build:
  // the map boots without it; planner/arrivals light up on arrival.
  if (timetableUrl) {
    loadTimetable(timetableUrl, fetchImpl)
      .then((tt) => bindLiveStack(bindTimetable(tt, registry)))
      .catch((err) => {
        errLog.record("timetable", String(err && err.message || err));
        state.plannerReady = false;
        renderPlanner();
      });
  }

  /* ---------- status header + service notice ---------------------- */
  function renderStatus(nowMs) {
    const header = statusMonitor.header(nowMs);
    if (mounts.liveCount) {
      mounts.liveCount.textContent = header.total > 0 ? `${header.total} live` : "";
    }
    if (mounts.updatedAt) mounts.updatedAt.textContent = header.updatedText ?? "";
    const notice = statusMonitor.notice(nowMs);
    if (mounts.serviceNotice) {
      if (notice) {
        mounts.serviceNotice.textContent = notice.headline ?? notice.text ?? "";
        show(mounts.serviceNotice, true);
      } else if (!state.bootError) {
        show(mounts.serviceNotice, false);
      }
    }
    return header;
  }

  /* ---------- poll loop ------------------------------------------- */
  let pollInFlight = false;
  async function pollLive() {
    if (pollInFlight) return;
    pollInFlight = true;
    const nowMs = now();
    try {
      const snap = await vehicleService.poll(nowMs);
      state.lastSnapshot = snap;
      state.lastPollAt = nowMs;
      liveEverOk = liveEverOk || !!snap.lastPollOk;
      liveCounts = {};
      runningStates = {};
      for (const v of snap.vehicles) {
        if (v.routeId) {
          liveCounts[v.routeId] = (liveCounts[v.routeId] ?? 0) + 1;
          runningStates[v.routeId] = "running";
        }
      }
      for (const rid of routeOrder) if (!(rid in runningStates)) runningStates[rid] = "not-running";
      // The live stack runs on the FEED's clock, not the wall clock
      // (T4's proven pattern): the published payload lags wall time
      // by the Pages deploy lag, and on wall time every fix reads
      // stale and the matcher's gates reject the whole fleet. The
      // status monitor alone keeps wall time — payload age against
      // wall time is exactly what its staleness states measure.
      const feedMs = snap.generatedAt ? parseFeedTime(snap.generatedAt) : null;
      const liveNow = feedMs ?? nowMs;
      tracker.ingest(vehicleService.trackerFixes(), liveNow);
      if (matcher) {
        matcher.matchPoll(tracker, liveNow);
        if (engine) engine.setLiveDelays(matcher.delayMap(), liveNow);
        if (bindings) bindings.refresh(liveNow);
        state.counts.matched = matcher.delayMap().size;
      }
      state.counts.vehicles = snap.vehicles.length;
      statusMonitor.observe(snap, nowMs);
      renderStatus(nowMs);
      applyFilters();
      if (rideHost) rideHost.onPoll(liveNow, snap.vehicles);
      if (stopCardOpen) stopCard.tick(nowMs);
      if (planner && state.endpoints.from && state.endpoints.to) planner.replanLive(nowMs);
    } catch (err) {
      errLog.record("poll", String(err && err.message || err));
    } finally {
      pollInFlight = false;
    }
  }

  async function pollAlerts() {
    const nowMs = now();
    try {
      await alertService.poll(nowMs);
      alertLayer.refresh(alertService.overlayModel(nowMs));
      if (filterPanel && mounts.panelFilter) applyChipBadges(mounts.panelFilter, alertService, nowMs);
      if (stopCardOpen) stopCard.tick(nowMs);
    } catch (err) {
      errLog.record("alerts-poll", String(err && err.message || err));
    }
  }

  /* ---------- cards ------------------------------------------------ */
  const mogoProvider = mogoCardProvider(mogoService);
  const placeProvider = placeCardProvider();
  function nearestOf(list, x, z, maxM) {
    let best = null, bestD = maxM;
    for (const item of list ?? []) {
      if (item.x === undefined || item.z === undefined) continue;
      const d = Math.hypot(item.x - x, item.z - z);
      if (d < bestD) { bestD = d; best = item; }
    }
    return best;
  }
  const cardProviders = {
    alertsFor: (stop) => alertService.alertsFor(stop, now()),
    mogoFor: (stop) => {
      const { layer } = mogoService.state();
      if (!layer) return null;
      const st = nearestOf(layer.stations, stop.x, stop.z, 400);
      return st ? mogoProvider({ mogo: true, station: st }) : null;
    },
    placeFor: (stop) => {
      const p = nearestOf(placesService.enabledPlaces(), stop.x, stop.z, 400);
      return p ? placeProvider({ place: true, pdata: p }) : null;
    },
  };

  let stopCardOpen = false;
  let currentStop = null;
  const stopCard = doc && mounts.cardStop
    ? createStopCardController({
        doc,
        mount: mounts.cardStop,
        buildModel: (nowMs) => {
          if (!currentStop) return null;
          const ctx = {
            ymd: ymdOf(nowMs),
            yesterdayYmd: ymdShift(ymdOf(nowMs), -1),
            secOfDay: secOfDayOf(nowMs),
            nowMs,
          };
          return buildStopCardModel({
            registry,
            stop: currentStop,
            arrivals: arrivals ? arrivals.forStop(currentStop, ctx) : null,
            secOfDay: ctx.secOfDay,
            rawCounts: liveCounts,
            providers: cardProviders,
          });
        },
      })
    : null;

  let fleetData = null;
  if (fleetUrl) {
    loadFleet(fleetUrl, fetchImpl).then((d) => { fleetData = d; }).catch(() => { fleetData = null; });
  }
  let currentVehicle = null;
  const busCard = doc && mounts.cardBus
    ? createBusCardController({
        doc,
        mount: mounts.cardBus,
        buildModel: (vehicleId) => {
          const v = (state.lastSnapshot?.vehicles ?? []).find((x) => x.vehicleId === vehicleId)
            ?? (currentVehicle && currentVehicle.vehicleId === vehicleId ? currentVehicle : null);
          if (!v) return null;
          currentVehicle = v;
          return buildBusCardModel({
            vehicle: v,
            bindingFor: bindings ? (vid) => bindings.bindingForVehicle(vid) : null,
            fleetData,
            names,
            nowMs: now(),
            upcoming: betaSettings.get("upcomingStops")
              ? upcomingStops({
                  vehicle: v,
                  trackerView: tracker,
                  atlas,
                  stopsByIdx: (i) => registry.stopAt(i),
                  binding: bindings ? bindings.bindingForVehicle(v.vehicleId) : null,
                })
              : null,
          });
        },
        renderUpcoming: (model, d) => renderUpcomingStops(model, d),
        onClose: () => { show(mounts.cardBus, false); },
      })
    : null;

  function openStopCard(stop) {
    currentStop = stop;
    state.selectedStopIdx = stop.idx;
    stopLayer.setSelected(stop.idx);
    if (stopCard) { stopCard.open(now()); show(mounts.cardStop, true); }
    stopCardOpen = true;
    announce(`${stop.name}. ${stop.routes?.length ?? 0} routes.`);
  }
  function openBusCard(vehicle) {
    currentVehicle = vehicle;
    state.selectedVehicleKey = vehicle.key;
    if (busCard) { busCard.open(vehicle, { nowMs: now() }); show(mounts.cardBus, true); }
  }
  function closeAllSurfaces() {
    stopCardOpen = false;
    currentStop = null;
    stopLayer.setSelected(null);
    if (stopCard) stopCard.close();
    show(mounts.cardStop, false);
    show(mounts.cardBus, false);
    show(mounts.cardTrip, false);
    show(mounts.cardRide, false);
    show(mounts.panelBrowse, false);
    show(mounts.panelFilter, false);
    show(mounts.planner, false);
  }

  /* ---------- planner view (host models -> DOM) -------------------- */
  function endpointLabel(ep) {
    if (!ep) return "Not set";
    if (ep.kind === "stop") {
      const s = registry.stopAt(ep.idx);
      return s ? s.name : `Stop ${ep.idx}`;
    }
    if (ep.kind === "loc") return ep.label ?? "Map point";
    return "Rider location";
  }
  function setEndpoint(which, ep) {
    state.endpoints[which] = ep;
    if (planner) {
      if (which === "from") planner.setFrom(ep);
      else planner.setTo(ep);
      runPlan();
    }
    renderPlanner();
  }
  function runPlan() {
    if (!planner || !state.endpoints.from || !state.endpoints.to) return;
    const res = planner.plan(now(), { user: true });
    if (!res.ok && res.reason === "fault") plannerFaults.note();
    if (!res.ok && res.reason === "budget") {
      // R-23 discipline: the rollback note is the shipped behavior.
    }
    renderPlanner();
  }
  function flyToJourney(fly) {
    if (!fly || !fly.target) return;
    renderer.rig.glideTo({ target: fly.target, distance: fly.distance ?? 2600 }, now());
  }
  function renderPlanner() {
    const mount = mounts.planner;
    if (!doc || !mount) return;
    clearNode(mount);
    const head = el(doc, "div", "pl-head");
    head.appendChild(el(doc, "span", "pl-title", "Plan a trip"));
    mount.appendChild(head);
    const ends = el(doc, "div", "pl-ends");
    ends.appendChild(el(doc, "div", "pl-end", `From: ${endpointLabel(state.endpoints.from)}`));
    ends.appendChild(el(doc, "div", "pl-end", `To: ${endpointLabel(state.endpoints.to)}`));
    const swap = el(doc, "button", "pl-swap", "Swap");
    swap.setAttribute("type", "button");
    swap.addEventListener("click", () => {
      const { from, to } = state.endpoints;
      state.endpoints = { from: to, to: from };
      if (planner) { planner.setFrom(state.endpoints.from); planner.setTo(state.endpoints.to); }
      runPlan();
      renderPlanner();
    });
    ends.appendChild(swap);
    mount.appendChild(ends);
    if (!planner) {
      mount.appendChild(el(doc, "p", "pl-note",
        state.bound ? "Planner unavailable." : "Loading the timetable…"));
      return;
    }
    const model = planner.resultsModel(now());
    if (model.metaLine) mount.appendChild(el(doc, "p", "pl-meta", model.metaLine));
    if (model.note) mount.appendChild(el(doc, "p", "pl-note", model.note));
    if ((model.kind === "note" || model.kind === "empty") && model.text) {
      mount.appendChild(el(doc, "p", "pl-note", model.text));
    }
    const list = el(doc, "div", "pl-options");
    (model.options ?? []).forEach((opt, i) => {
      const b = el(doc, "button", "pl-option", `${opt.departClock} → ${opt.arriveClock} · ${opt.durationMin} min`);
      b.setAttribute("type", "button");
      b.addEventListener("click", () => { planner.select(i, { user: true }); renderPlanner(); });
      list.appendChild(b);
    });
    mount.appendChild(list);
    if (model.detail) {
      const det = el(doc, "div", "pl-detail");
      for (const row of model.detail.rows ?? []) {
        det.appendChild(el(doc, "div", "pl-row", row.text ?? ""));
      }
      mount.appendChild(det);
    }
    if (model.announce) announce(model.announce);
  }

  /* ---------- ride along ------------------------------------------- */
  const rideWidget = doc && mounts.cardRide
    ? createRideAlong({ doc, mount: mounts.cardRide, now })
    : null;
  if (rideWidget) {
    rideWidget.setData({
      routes: routeUniverse.map(({ routeId }) => {
        const r = registry.routeById(routeId);
        const tok = registry.tokenFor(routeId);
        return {
          id: routeId,
          name: r?.name ?? routeId,
          label: names.label(routeId),
          color: tok ? tok.hex : null,
          paths: r?.paths ?? [],
        };
      }),
      stops: allStops.map((s) => ({ id: s.stop_id, n: s.name, x: s.x, z: s.z, r: s.routes })),
    });
  }
  const follow = createFollow({ rig: renderer.rig });
  function ensureRideHost() {
    if (rideHost || !bindings || !rideWidget) return rideHost;
    rideHost = createRideHost({
      widget: rideWidget,
      bindings,
      tracker,
      registry,
      names,
      routeShown: (rid) => filters.routeShown(rid, runningStates[rid]),
      timesFor,
      intents: {
        toast: (t) => toast(t),
        follow: (vid) => { state.followVehicleKey = vid; },
        openRideCovered: () => show(mounts.cardRide, true),
        closeRide: () => show(mounts.cardRide, false),
      },
    });
    return rideHost;
  }

  /* ---------- browse ------------------------------------------------ */
  const browseTabs = createBrowseTabs("buses");
  function renderBrowse() {
    const mount = mounts.panelBrowse;
    if (!doc || !mount) return;
    clearNode(mount);
    const tabRow = el(doc, "div", "br-tabs");
    for (const t of ["buses", "stops", "passes"]) {
      const b = el(doc, "button", "br-tab", t[0].toUpperCase() + t.slice(1));
      b.setAttribute("type", "button");
      if (browseTabs.active() === t) b.setAttribute("aria-selected", "true");
      b.addEventListener("click", () => { browseTabs.select(t); renderBrowse(); });
      tabRow.appendChild(b);
    }
    mount.appendChild(tabRow);
    const kind = browseTabs.active();
    if (kind === "passes") {
      mount.appendChild(renderPassesPane(doc));
      return;
    }
    let model;
    if (kind === "buses") {
      const slots = (state.lastSnapshot?.vehicles ?? []).map((v) => ({ vehicle: v }));
      model = browseBusRows({
        slots,
        names,
        destFor: (v) => v.destination ?? null,
        advisoryForRoute: null,
      });
    } else {
      model = browseStopRows({ stops: allStops, advisoryForStop: null });
    }
    mount.appendChild(renderBrowseList(doc, {
      kind,
      model,
      onPick: (row) => {
        if (kind === "buses") {
          if (row.vehicle) openBusCard(row.vehicle);
        } else if (row.stop) {
          openStopCard(row.stop);
        }
      },
    }));
  }

  /* ---------- first view, locate, fullscreen, tools ----------------- */
  const firstView = createFirstView({ storage });
  function paintFirstView() {
    const mount = mounts.firstView;
    if (!doc || !mount) return;
    const view = firstView.renderState();
    show(mount, view.sheetVisible);
    if (!view.sheetVisible) return;
    clearNode(mount);
    mount.appendChild(renderFirstView({
      doc,
      sheet: firstView,
      proofs: firstView.proofs({
        liveTotal: state.counts.vehicles || null,
        routeCount: registry.routeCount,
        nearMeOn: !!filters.state.nearMe,
        nearMeCount: filters.nearMeCount(),
        located: !!locateState.position,
        alerts: alertService.fvState(now()),
      }),
      handlers: {
        onTile: (action) => handleFirstViewAction(action),
        onCollapse: () => { firstView.setOpen(false, { persist: true }); paintFirstView(); },
        onHandle: () => { firstView.setOpen(true, { persist: false }); paintFirstView(); },
        onNearLocation: () => { void locateMe(); },
      },
    }));
  }
  function handleFirstViewAction(action) {
    if (!action) return;
    if (action.kind === "plan") { show(mounts.planner, true); renderPlanner(); }
    else if (action.kind === "ride") {
      const host = ensureRideHost();
      if (host) { host.setRideMode(true); show(mounts.cardRide, true); }
    } else if (action.kind === "live") { firstView.setOpen(false, { persist: true }); paintFirstView(); }
    else if (action.kind === "near-choice") { void locateMe(); }
  }

  const locateState = { position: null };
  const locate = createLocate({
    filters,
    registry,
    smartDisplayed: () => filters.groupState("smart") !== "none",
    reducedMotion,
  });
  async function locateMe() {
    if (!env.geolocate) { toast("Location is not available in this context."); return null; }
    try {
      const fix = await env.geolocate();
      if (!fix) return null;
      // The locate module engages near-me itself when the intent is
      // pending (its own stop source + the [x, z] array contract);
      // the assembly only records the intent and applies the result.
      filters.setPendingNearMe(true);
      const res = locate.located(fix.lat, fix.lon, fix.accuracyM ?? 50);
      locateState.position = res;
      if (res && res.kind === "located") {
        applyFilters();
        if (res.flyTo) renderer.rig.glideTo({ target: [res.x, 0, res.z], distance: 3200 }, now());
      }
      if (res && res.toast) toast(typeof res.toast === "string" ? res.toast : (res.toast.text ?? ""));
      paintFirstView();
      return res;
    } catch (err) {
      errLog.record("locate", String(err && err.message || err));
      return null;
    }
  }

  const fullscreen = doc && mounts.stage
    ? createFullscreen({
        doc,
        stage: mounts.stage,
        onLabel: (label) => {
          if (mounts.fullscreenButton) mounts.fullscreenButton.textContent = label;
        },
      })
    : null;
  if (fullscreen && mounts.fullscreenButton) {
    mounts.fullscreenButton.addEventListener("click", () => fullscreen.toggle());
  }

  const TOOLS = [
    { id: "filters", label: "Routes", run: () => { show(mounts.panelFilter, true); if (filterPanel) filterPanel.sync(); } },
    { id: "browse", label: "Browse", run: () => { show(mounts.panelBrowse, true); renderBrowse(); } },
    { id: "plan", label: "Plan", run: () => { show(mounts.planner, true); renderPlanner(); } },
    {
      id: "ride", label: "Ride",
      run: () => {
        const host = ensureRideHost();
        if (host) { host.setRideMode(true); show(mounts.cardRide, true); }
        else toast("Ride Along loads with the timetable.");
      },
    },
    { id: "locate", label: "Near me", run: () => { void locateMe(); } },
  ];
  if (doc && mounts.tools) {
    for (const t of TOOLS) {
      const b = el(doc, "button", "tool", t.label);
      b.setAttribute("type", "button");
      b.setAttribute("data-tool", t.id);
      b.addEventListener("click", t.run);
      mounts.tools.appendChild(b);
    }
    if (fullscreen) {
      const fb = el(doc, "button", "tool", "Expand");
      fb.setAttribute("type", "button");
      fb.setAttribute("data-tool", "fullscreen");
      mounts.fullscreenButton = fb;
      fb.addEventListener("click", () => fullscreen.toggle());
      mounts.tools.appendChild(fb);
    }
  }

  /* ---------- frame stages: vehicles, labels ----------------------- */
  const lodState = { current: "far" };
  let lastDescriptors = [];
  function onBusMotion(ctx) {
    const camDistM = renderer.rig.spherical.distance;
    const descriptors = buildDescriptors({ tracker, registry, nowMs: ctx.now, camDistM, lodState });
    // Screen-space badge declutter (T4): the assembly owns the
    // viewport, so it applies the declutter verdict — a badge whose
    // spiral search finds no free slot is hidden this frame.
    const vp = viewportOf();
    const items = [];
    for (const d of descriptors) {
      if (!d.badgesVisible) continue;
      const p = projectScreen({
        position: renderer.rig.pose().position, target: renderer.rig.pose().target,
        viewport: vp, x: d.x, y: 380, z: d.z,
      });
      if (p) items.push({ key: d.key, x: p.x - 55, y: p.y - 15, w: 110, h: 30, priority: items.length });
    }
    if (items.length) {
      const placed = declutterBadges(items);
      for (const d of descriptors) {
        if (d.badgesVisible && placed.get(d.key) === null) d.badgesVisible = false;
      }
    }
    lastDescriptors = descriptors;
    vehicleLayer.update(descriptors, ctx.now);
  }
  registerVehicleStages(renderer, {
    onBusMotion,
    follow,
    predict: (key) => tracker.predict(key, now()),
  });

  const makeLabelTexture = env.makeLabelTexture ?? ((text) => ({ text }));
  renderer.onStage("stopLabels", (ctx) => {
    const pose = renderer.rig.pose();
    const anchors = stopLabels.select({
      camX: pose.target[0],
      camZ: pose.target[2],
      camDist: renderer.rig.spherical.distance,
      mode: "orbit",
      liveRoutes: new Set(Object.keys(liveCounts)),
    });
    for (let i = 0; i < anchors.length; i++) {
      let node = stopLabelSprites[i];
      if (!node) {
        node = gl.makeSprite();
        gl.addToScene(scene, node);
        stopLabelSprites[i] = node;
      }
      const a = anchors[i];
      const key = `stop:${a.stop.stop_id ?? a.stop.name}`;
      let tex = stopLabels.textures.get(key);
      if (!tex) {
        tex = makeLabelTexture(a.stop.name);
        stopLabels.textures.set(key, tex);
      }
      gl.setSpriteTexture(node, tex);
      gl.setNodePosition(node, [a.stop.x, (a.pillarHeightM ?? 100) + 24, a.stop.z]);
      gl.setNodeVisible(node, true);
    }
    for (let i = anchors.length; i < stopLabelSprites.length; i++) {
      gl.setNodeVisible(stopLabelSprites[i], false);
    }
    stopLayer.setDistance(renderer.rig.spherical.distance, "orbit");
    void ctx;
  });

  function refreshLayers(nowMs) {
    onBusMotion({ now: nowMs });
    stopLayer.tick(nowMs);
    alertLayer.refresh(alertService.overlayModel(nowMs));
    if (state.selectedStopIdx !== null && state.selectedStopIdx !== undefined) {
      stopLayer.setSelected(state.selectedStopIdx);
    }
  }

  /* ---------- picking + camera input -------------------------------- */
  function pickAt(px, py) {
    const vp = viewportOf();
    const pose = renderer.rig.pose();
    const ground = unprojectGround({ position: pose.position, target: pose.target, viewport: vp, px, py });
    const candidates = [];
    if (ground) {
      for (const d of lastDescriptors) {
        const distM = Math.hypot(d.x - ground.x, d.z - ground.z);
        if (distM > 90) continue;
        const p = projectScreen({ position: pose.position, target: pose.target, viewport: vp, x: d.x, y: 60, z: d.z });
        if (!p) continue;
        candidates.push({
          kind: "bus", px: Math.hypot(p.x - px, p.y - py), distM, key: d.key,
        });
      }
      for (const s of pickGrid.candidates(ground.x, ground.z, 90)) {
        const distM = Math.hypot(s.x - ground.x, s.z - ground.z);
        const p = projectScreen({ position: pose.position, target: pose.target, viewport: vp, x: s.x, y: 40, z: s.z });
        if (!p) continue;
        candidates.push({
          kind: "stop", px: Math.hypot(p.x - px, p.y - py), distM, stop: s,
        });
      }
    }
    const winner = arbitratePick(candidates);
    if (!winner) return null;
    if (winner.kind === "bus") {
      const v = (state.lastSnapshot?.vehicles ?? []).find((x) => x.key === winner.key);
      if (v) { openBusCard(v); return { kind: "bus", key: winner.key }; }
      return null;
    }
    openStopCard(winner.stop);
    return { kind: "stop", idx: winner.stop.idx };
  }

  const inputTarget = env.inputTarget ?? mounts.stage;
  if (inputTarget && typeof inputTarget.addEventListener === "function") {
    let drag = null;
    inputTarget.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, moved: false, button: e.button ?? 0 };
      follow.disengage();
    });
    inputTarget.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (!drag.moved) return;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.button === 2 || e.shiftKey) renderer.rig.panBy(-dx * 4, -dy * 4);
      else renderer.rig.orbitBy(dx * 0.005, dy * 0.005);
      inputWatch.activity();
    });
    inputTarget.addEventListener("pointerup", (e) => {
      const wasDrag = drag && drag.moved;
      drag = null;
      if (!wasDrag) pickAt(e.offsetX ?? e.clientX, e.offsetY ?? e.clientY);
    });
    inputTarget.addEventListener("wheel", (e) => {
      if (typeof e.preventDefault === "function") e.preventDefault();
      renderer.rig.dollyBy(Math.exp((e.deltaY ?? 0) * 0.0012));
      wheelHint.onWheel();
      inputWatch.activity();
    }, { passive: false });
  }

  /* ---------- lifecycle ---------------------------------------------- */
  let running = false;
  const chains = [];
  function chain(fn, ms) {
    let id = null;
    let stopped = false;
    const step = async () => {
      if (stopped) return;
      try { await fn(); } catch { /* handlers log their own faults */ }
      if (!stopped) id = setTimer(step, ms);
    };
    id = setTimer(step, 0);
    const handle = { stop() { stopped = true; if (id !== null) clearTimer(id); } };
    chains.push(handle);
    return handle;
  }
  function stepFrame(nowMs) {
    renderer.frame(nowMs);
    const pose = renderer.rig.pose();
    cameraSupervisor.check({
      px: pose.position[0], py: pose.position[1], pz: pose.position[2],
      tx: pose.target[0], ty: pose.target[1], tz: pose.target[2],
      distance: renderer.rig.spherical.distance,
    });
    if (busCard && currentVehicle) busCard.tick(nowMs);
  }
  function start() {
    if (running) return buildHandle();
    running = true;
    state.booted = true;
    applyFilters();
    renderStatus(now());
    paintFirstView();
    if (filterPanel) filterPanel.sync();
    void pollLive();
    chain(pollLive, 60_000);
    alertService.start();
    if (env.raf) {
      const loop = (t) => { if (!running) return; stepFrame(t); env.raf(loop); };
      env.raf(loop);
    }
    return buildHandle();
  }
  function stop() {
    running = false;
    for (const c of chains) c.stop();
    alertService.stop();
    if (typeof vehicleService.stop === "function") vehicleService.stop();
  }

  function buildHandle(failedState = {}) {
    return {
      state,
      failed: !!failedState.failed,
      registry,
      renderer,
      filters,
      vehicleService,
      tracker,
      get matcher() { return matcher; },
      get engine() { return engine; },
      get arrivals() { return arrivals; },
      get planner() { return planner; },
      get bindings() { return bindings; },
      get rideHost() { return ensureRideHost(); },
      rideWidget,
      stopCard,
      busCard,
      stopLayer,
      vehicleLayer,
      alertLayer,
      alertService,
      statusMonitor,
      errLog,
      ladder,
      ladderActions,
      pollLive,
      pollAlerts,
      applyFilters,
      setLayer,
      openStopCard,
      openBusCard,
      closeAllSurfaces,
      pickAt,
      locateMe,
      setEndpoint,
      runPlan,
      renderPlanner,
      renderBrowse,
      renderStatus,
      stepFrame,
      start,
      stop,
    };
  }

  return buildHandle();
}

/* ================================================================== */
/* Browser bootstrap — the ONLY dynamic import of the vendor module.  */
/* ================================================================== */

const LT_BOOTABLE = typeof document !== "undefined"
  && typeof window !== "undefined"
  && !globalThis.__LT_NO_BOOT__
  && document.querySelector('[data-mount="stage"]');

if (LT_BOOTABLE) {
  void (async () => {
    try {
      const [{ createThreeAdapter }, { RouteVisibilityTable }] = await Promise.all([
        import("./gl-three.mjs"),
        import("./gl-adapter.mjs"),
      ]);
      const doc = document;
      const stageEl = doc.querySelector('[data-mount="stage"]');
      const canvas = doc.createElement("canvas");
      canvas.setAttribute("aria-hidden", "true");
      stageEl.appendChild(canvas);
      const gl = createThreeAdapter({ routeVisibility: new RouteVisibilityTable(128) });
      const glRenderer = gl.makeRenderer(canvas);
      const mounts = {};
      for (const m of doc.querySelectorAll("[data-mount]")) {
        mounts[m.getAttribute("data-mount").replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = m;
      }
      const dataBase = new URL("../data", import.meta.url).href.replace(/\/$/, "");
      const ORIGIN = "https://www.detroitautomationacademy.com";
      const app = await createApp({
        doc,
        mounts,
        gl,
        glRenderer,
        // R-07 seam: the shell's boot-config.js sets
        // FORGE_LIVE_DATA_URL; fall back to the same published
        // origin when the seam is undefined, so a config-script
        // failure can never brick the boot on its own (DV-T10-2).
        liveBase: window.FORGE_LIVE_DATA_URL ?? `${ORIGIN}/live-data`,
        dataBase,
        timetableUrl: `${ORIGIN}/planner-timetable-S1000182-S1000147.json`,
        fleetUrl: `${ORIGIN}/ddot-fleet.json`,
        placesUrl: `${ORIGIN}/places.json`,
        storage: window.localStorage,
        sessionStorage: window.sessionStorage,
        errorTarget: window,
        makeLabelTexture: typeof gl.makeTextTexture === "function"
          ? (text) => gl.makeTextTexture([text]) : undefined,
        badgeTextureFactory: typeof gl.makeTextTexture === "function"
          ? (d) => gl.makeTextTexture([d.badgeText, d.badgeClock].filter(Boolean)) : undefined,
        geolocate: () => new Promise((resolve, reject) => {
          if (!navigator.geolocation) { resolve(null); return; }
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracyM: pos.coords.accuracy }),
            reject,
            { timeout: 10_000 },
          );
        }),
        raf: (cb) => window.requestAnimationFrame(cb),
        viewport: () => ({
          w: stageEl.clientWidth || window.innerWidth,
          h: stageEl.clientHeight || window.innerHeight,
        }),
      });
      const fit = () => {
        const w = stageEl.clientWidth || window.innerWidth;
        const h = stageEl.clientHeight || window.innerHeight;
        gl.resize(glRenderer, w, h);
        const cam = app.renderer.camera;
        if (cam) {
          cam.aspect = w / h;
          if (typeof cam.updateProjectionMatrix === "function") cam.updateProjectionMatrix();
        }
      };
      window.addEventListener("resize", fit);
      fit();
      app.start();
      window.__LT_APP__ = app;
    } catch (err) {
      const notice = document.querySelector('[data-mount="service-notice"]');
      if (notice) {
        notice.hidden = false;
        notice.textContent = "Live Transit Detroit could not start. Check the connection and reload.";
      }
      if (window.__flErrLog) window.__flErrLog.push(String(err && err.message || err));
    }
  })();
}
