/**
 * LTD rebuild — renderer core (Tranche T3, M5).
 *
 * Builds the static scene from the T1 data plane and owns the
 * frame loop. Everything visual goes through the GL adapter
 * (gl-adapter.mjs); this module holds no library import, so the
 * vendor question stays a one-file decision (gl-three.mjs).
 *
 * Carried here: R-01 footprint/framing + bounds, R-11 layer cake,
 * R-12 (stops never distance-fade — enforced at the T5 seam: this
 * renderer exposes no stop-fade control), R-13 merged draws +
 * per-layer degradation, R-14 (geometry only from the derived
 * authoritative assets), R-15 texture caps (labels.mjs), R-30
 * fs-lock (fullscreen.mjs + shell CSS), P-01 tiers + extension
 * fade, P-04 merged guideways with per-route alpha, P-05 geometry
 * processing (geometry.mjs), P-06 water + far shore, P-07 Belle
 * Isle, P-08 landmarks contract, P-09/P-10 labels, P-11
 * DisplayBounds, P-79 LOD edges, P-81 frame-loop order, P-82
 * per-layer optional degradation.
 *
 * Token application at T3 (named interpretation, of record in the
 * tranche record): deck/glow/skirt/casing COLORS come from the T1
 * token table as shipped (its hex fields). Deck width is the
 * placed constant 72 m, glow is solid, casing is the standard
 * class — the differentiation tuples (weight/dash/casing-lift)
 * apply at the T9 prototype gate, and the geometry builder already
 * accepts them per route, so T9 is a data switch, not a rebuild.
 */

import {
  chaikin, resamplePath, foldLift, ribbonStrip, skirtWalls, mergeBuffers,
  dashedRectSegments, longestPathMidpoint, layerHeights, ROUTE_MAX,
} from "./geometry.mjs";
import { RouteVisibilityTable } from "./gl-adapter.mjs";
import { CameraRig } from "./camera.mjs";
import { StreetLabels, routeLabelVisible, ROUTE_LABEL_Y } from "./labels.mjs";
import { boundsRect, STREET_BOUNDS, MOSAIC_BOUNDS } from "./projection.mjs";

export const STREET_TIERS = [
  { name: "freeway", color: 0x404040, y: 16 },
  { name: "arterial", color: 0x2b2b2b, y: 15 },
  { name: "local", color: 0x181818, y: 14 },
];
export const GROUND_COLOR = 0x0c0c0c;
export const FAR_SHORE_COLOR = 0x141414;
export const WATER_COLOR = 0x131313;
export const BELLE_ISLE_COLOR = 0x181818;
export const LANDMARK_COLOR = 0x484848;
export const DECK_WIDTH_PLACED = 72;
export const EXTENSION_FADE_MS = 900;
export const LOD = { stops: 26000, localStreets: 22000, belleIsle: 7000 };
export const FRAME_STAGES = [
  "controls", "cameraFloor", "lod", "tripFly", "streetTween", "streetViewHandoff",
  "busMotion", "follow", "ridePickLabels", "labelRules", "stopLabels",
  "streetLabels", "eases", "logoFade", "render", "supervisors",
];
const FRAME_GUARD_LIMIT = 120; // R-16: 120 consecutive thrown frames -> recovery
const WATCHDOG_MS = 5000; // R-16: 5 s stale frame -> recovery

function hexToInt(hex) {
  return parseInt(hex.slice(1), 16);
}

export function createRenderer({
  gl, registry, data, reducedMotion = false, onRecovery = () => {},
  makeLabelTexture = (text) => ({ text }), glRenderer = null,
}) {
  const scene = gl.createScene();
  const camera = gl.makeCamera({ fov: 50, near: 2, far: 240000 });
  const rig = new CameraRig({ reducedMotion });
  const routeVis = new RouteVisibilityTable(ROUTE_MAX);
  const layers = {};
  const layerStatus = {};
  const stageHooks = new Map(); // T4-T8 register frame stages here

  function degrade(name, err) {
    // R-13: a geometry failure degrades its layer, never the scene.
    layerStatus[name] = `degraded: ${err.message}`;
    return null;
  }

  function addLayer(name, build) {
    try {
      const node = build();
      if (node) {
        gl.addToScene(scene, node);
        layers[name] = node;
        layerStatus[name] = "ok";
      } else {
        layerStatus[name] = "absent";
      }
      return node;
    } catch (err) {
      return degrade(name, err);
    }
  }

  // ---- Ground + bounds (R-01, P-01) ----
  const mosaic = boundsRect(MOSAIC_BOUNDS);
  const core = boundsRect(STREET_BOUNDS);
  addLayer("ground", () => gl.makePlane({
    width: mosaic.width, depth: mosaic.depth, cx: mosaic.cx, cz: mosaic.cz, y: 0, color: GROUND_COLOR,
  }));
  addLayer("boundsBorders", () => {
    const quads = new Float32Array([
      ...dashedRectSegments(core.x0, core.z0, core.x1, core.z1),
      ...dashedRectSegments(mosaic.x0, mosaic.z0, mosaic.x1, mosaic.z1),
    ]);
    return gl.makeLineSegments(quads, { color: 0x333333, y: 18, opacity: 0.8, transparent: true });
  });

  // ---- Streets (P-01): one LineSegments per tier per region = core
  // draws + the SMART-county extension, which fades in only while
  // the SMART group is displayed (900 ms reversible).
  const extension = { shown: false, opacity: 0, nodes: [] };
  function splitByCore(flat) {
    const coreQuads = [], extQuads = [];
    for (let i = 0; i < flat.length; i += 4) {
      const mx = (flat[i] + flat[i + 2]) / 2, mz = (flat[i + 1] + flat[i + 3]) / 2;
      const inside = mx >= core.x0 && mx <= core.x1 && mz >= core.z0 && mz <= core.z1;
      (inside ? coreQuads : extQuads).push(flat[i], flat[i + 1], flat[i + 2], flat[i + 3]);
    }
    return { coreQuads: new Float32Array(coreQuads), extQuads: new Float32Array(extQuads) };
  }
  for (const tier of STREET_TIERS) {
    const flat = data.streets[tier.name];
    if (!flat) { layerStatus[`streets:${tier.name}`] = "absent"; continue; }
    const { coreQuads, extQuads } = splitByCore(flat);
    addLayer(`streets:${tier.name}`, () =>
      gl.makeLineSegments(coreQuads, { color: tier.color, y: tier.y }));
    try {
      const node = gl.makeLineSegments(extQuads, {
        color: tier.color, y: tier.y, opacity: 0, transparent: true,
      });
      gl.addToScene(scene, node);
      extension.nodes.push(node);
      layerStatus[`streets:${tier.name}:extension`] = "ok";
    } catch (err) {
      degrade(`streets:${tier.name}:extension`, err);
    }
  }

  // ---- Water + far shore (P-06): one merged fill each; the
  // adapter triangulates (its triangulator is the proven one).
  addLayer("water", () => gl.makeFilledShapes(
    data.water.polygons.map((poly) => ({ rings: poly.rings, y: 2 })),
    { color: WATER_COLOR }));
  addLayer("farShore", () => {
    if (!data.water.farShore) return null;
    return gl.makeFilledShapes([{ rings: data.water.farShore.rings, y: 1 }], { color: FAR_SHORE_COLOR });
  });

  // ---- Belle Isle (P-07): true-form outline, visible above 7,000 m ----
  const belleIsle = addLayer("belleIsle", () =>
    gl.makeFilledShapes([{ rings: [data.belleIsle.polygon], y: 3 }], { color: BELLE_ISLE_COLOR }));

  // ---- Landmarks (P-08): one merged mesh from the landmarks
  // contract dataset. T1's plane carries no landmarks asset yet —
  // the layer degrades silently until the dataset is derived
  // (P-82). Contract: { buildings: [{ footprint: [[x,z],...], height }] }.
  addLayer("landmarks", () => {
    const buildings = data.landmarks?.buildings;
    if (!buildings || !buildings.length) return null;
    const tops = gl.makeFilledShapes(
      buildings.map((b) => ({ rings: [b.footprint], y: b.height })),
      { color: LANDMARK_COLOR });
    gl.addToScene(scene, tops);
    const buffers = [];
    for (const b of buildings) {
      const n = b.footprint.length;
      for (let i = 0; i < n; i++) {
        const [ax, az] = b.footprint[i];
        const [bx, bz] = b.footprint[(i + 1) % n];
        buffers.push({
          positions: new Float32Array([
            ax, 0, az, bx, 0, bz, ax, b.height, az,
            bx, 0, bz, bx, b.height, bz, ax, b.height, az,
          ]),
          indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
          routeAttr: new Float32Array(6),
        });
      }
    }
    return gl.makeMesh(mergeBuffers(buffers), { color: LANDMARK_COLOR });
  });

  // ---- Guideways (P-04, R-11): four merged draws total — deck,
  // glow, casing, skirt — with per-route alpha (routeVis table)
  // and per-route token colors as vertex colors, taken from the
  // T1 token table as shipped (registry.tokenFor). Route order is
  // the routes asset's own order: ddot segment, smart, qline —
  // the same order the token assignment was computed in.
  const allRoutes = [];
  for (const seg of ["ddot", "smart", "qline"]) {
    for (const route of data.routes.segments[seg].routes) allRoutes.push(route);
  }
  const routeOrder = [];
  const guideway = { deck: null, glow: null, casing: null, skirt: null };
  try {
    const deckB = [], glowB = [], casingB = [], skirtB = [];
    allRoutes.forEach((route, ri) => {
      const token = registry.tokenFor(route.id);
      if (!token) throw new Error(`renderer: no token for route ${route.id}`);
      const heights = layerHeights(ri);
      const colors = {
        deck: hexToInt(token.hex),
        glow: hexToInt(token.glow_hex),
        casing: hexToInt(token.casing_standard_hex),
        skirt: hexToInt(token.skirt_hex),
      };
      for (const rawPath of route.paths) {
        const path = resamplePath(chaikin(rawPath, 2));
        const lifts = foldLift(path);
        deckB.push(ribbonStrip(path, {
          width: DECK_WIDTH_PLACED, y: heights.deck, routeOrdinal: ri, lifts, color: colors.deck,
        }));
        glowB.push(ribbonStrip(path, {
          width: DECK_WIDTH_PLACED * 2.2, y: heights.glow, routeOrdinal: ri, lifts, color: colors.glow,
        }));
        casingB.push(ribbonStrip(path, {
          width: DECK_WIDTH_PLACED + 28, y: heights.casing, routeOrdinal: ri, lifts, color: colors.casing,
        }));
        skirtB.push(skirtWalls(path, {
          width: DECK_WIDTH_PLACED, deckY: heights.deck, baseY: heights.casing,
          routeOrdinal: ri, lifts, color: colors.skirt,
        }));
      }
      routeOrder[ri] = { route, token };
    });
    guideway.deck = addLayer("guideway:deck", () => gl.makeMesh(mergeBuffers(deckB), {
      color: 0xffffff, vertexColors: true, routeVisibility: true,
    }));
    guideway.glow = addLayer("guideway:glow", () => gl.makeMesh(mergeBuffers(glowB), {
      color: 0xffffff, vertexColors: true, routeVisibility: true, transparent: true, opacity: 0.35,
    }));
    guideway.casing = addLayer("guideway:casing", () => gl.makeMesh(mergeBuffers(casingB), {
      color: 0xffffff, vertexColors: true, routeVisibility: true,
    }));
    guideway.skirt = addLayer("guideway:skirt", () => gl.makeMesh(mergeBuffers(skirtB), {
      color: 0xffffff, vertexColors: true, routeVisibility: true,
    }));
  } catch (err) {
    degrade("guideway", err);
  }

  // ---- Labels ----
  const streetLabels = new StreetLabels(data.streetNames?.labels?.map(
    ([name, x, z, tier]) => ({ name, x, z, tier })) ?? []);
  const streetSprites = [];
  for (let i = 0; i < 14; i++) {
    const s = gl.makeSprite();
    gl.addToScene(scene, s);
    streetSprites.push(s);
  }
  const routeLive = new Map();
  function routeLabelAnchor(ri) {
    const { route } = routeOrder[ri];
    const mid = longestPathMidpoint(route.paths);
    return mid ? { x: mid.point[0], z: mid.point[1], y: ROUTE_LABEL_Y } : null;
  }

  // ---- Frame loop (P-81 order is a contract) ----
  const frameState = {
    consecutiveThrows: 0,
    lastFrameAt: null,
    recoveries: 0,
  };

  function runStage(name, ctx) {
    const hook = stageHooks.get(name);
    if (hook) hook(ctx);
  }

  function frame(now) {
    try {
      if (frameState.lastFrameAt !== null && now - frameState.lastFrameAt > WATCHDOG_MS) {
        frameState.recoveries++;
        onRecovery("watchdog", { gapMs: now - frameState.lastFrameAt });
      }
      frameState.lastFrameAt = now;
      const ctx = { now, rig, scene, camera, renderer: api };
      for (const stage of FRAME_STAGES) {
        if (stage === "controls") { rig.advanceGlide(now); rig.update(); }
        else if (stage === "cameraFloor") { rig.apply(gl, camera); }
        else if (stage === "lod") { applyLod(); }
        else if (stage === "streetTween") { advanceExtensionFade(now); }
        else if (stage === "streetViewHandoff") { applyStreetViewFade(); }
        else if (stage === "streetLabels") { refreshStreetLabels(); }
        else if (stage === "render") { gl.render(glRenderer, scene, camera); }
        else runStage(stage, ctx);
      }
      frameState.consecutiveThrows = 0;
    } catch (err) {
      frameState.consecutiveThrows++;
      if (frameState.consecutiveThrows >= FRAME_GUARD_LIMIT) {
        frameState.consecutiveThrows = 0;
        frameState.recoveries++;
        onRecovery("frame-guard", { error: err });
      }
    }
  }

  let lastLod = {};
  function applyLod() {
    const d = rig.spherical.distance;
    const state = {
      localStreets: d < LOD.localStreets,
      belleIsle: d > LOD.belleIsle,
    };
    if (state.localStreets !== lastLod.localStreets && layers["streets:local"]) {
      gl.setNodeVisible(layers["streets:local"], state.localStreets);
    }
    if (state.belleIsle !== lastLod.belleIsle && belleIsle) {
      gl.setNodeVisible(belleIsle, state.belleIsle);
    }
    lastLod = state;
    return state;
  }

  let fadeStart = null;
  function advanceExtensionFade(now) {
    const target = extension.shown ? 1 : 0;
    if (extension.opacity === target) { fadeStart = null; return; }
    if (fadeStart === null) fadeStart = now;
    const t = Math.min(1, (now - fadeStart) / EXTENSION_FADE_MS);
    const from = extension.shown ? 0 : 1;
    extension.opacity = from + (target - from) * t;
    if (t >= 1) { extension.opacity = target; fadeStart = null; }
    for (const node of extension.nodes) gl.setNodeOpacity(node, extension.opacity);
  }

  function applyStreetViewFade() {
    const o = rig.guidewayOpacity();
    for (const key of ["deck", "glow", "casing", "skirt"]) {
      if (guideway[key]) gl.setNodeOpacity(guideway[key], o);
    }
  }

  function refreshStreetLabels() {
    const { position, target } = rig.pose();
    const shown = streetLabels.select({
      camX: target[0], camZ: target[2], camDist: rig.spherical.distance,
    });
    shown.forEach((anchor, i) => {
      const sprite = streetSprites[i];
      const token = streetLabels.textures.get(anchor.name) ?? makeLabelTexture(anchor.name);
      streetLabels.textures.set(anchor.name, token);
      gl.setSpriteTexture(sprite, token);
      gl.setNodeVisible(sprite, true);
      gl.setNodePosition(sprite, [anchor.x, 60, anchor.z]);
    });
    for (let i = shown.length; i < streetSprites.length; i++) {
      gl.setNodeVisible(streetSprites[i], false);
    }
    return shown;
  }

  const api = {
    scene, camera, rig, routeVis, layers, layerStatus, guideway,
    routeOrder, frameState, streetLabels,
    frame,
    onStage(name, fn) { stageHooks.set(name, fn); },
    setRouteVisibility(ordinal, opts) { routeVis.set(ordinal, opts); },
    setSmartExtensionShown(shown) { extension.shown = !!shown; },
    extensionState() { return { ...extension, nodes: undefined }; },
    setRouteLive(ordinal, live) { routeLive.set(ordinal, !!live); },
    routeLabelGate(ordinal, { nearMePasses = true } = {}) {
      return routeLabelVisible({
        hasLiveBus: routeLive.get(ordinal) ?? false,
        camDist: rig.spherical.distance,
        nearMePasses,
      });
    },
    routeLabelAnchor,
    homePose() { return { position: [...rig.pose().position], target: [...rig.pose().target] }; },
    lod() { return lastLod; },
  };
  rig.apply(gl, camera);
  return api;
}
