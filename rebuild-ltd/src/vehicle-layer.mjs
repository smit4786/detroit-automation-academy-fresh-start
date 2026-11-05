/**
 * LTD rebuild — the vehicle layer (Tranche T4, M6 rendering half).
 *
 * Turns tracker predictions into what the map draws (P-17):
 *   pillars 220 m in merged meshes · Kalman 3σ halo discs
 *   (15–150 m) · true-scale bus models below 2,600 m camera
 *   distance, pillars above 3,400 m (LOD hysteresis band between)
 *   · route badges (route + the last-fix clock once stale),
 *   decluttered in screen space by spiral placement with
 *   guaranteed separation, hidden beyond 7,000 m.
 *
 * Colors are the T1 token table consumed as shipped — one gray
 * per route, QLINE #FFFFFF (R-05). The stale treatment's
 * desaturation (0.65 toward luminance gray, P-20) is applied as a
 * color lerp; on the shipped achromatic tokens luminance equals
 * value, so the visible stale signals are the ease-back, the
 * halo's removal, and the badge clock — the lerp is kept honest
 * for any token set.
 *
 * Follow (P-21): while a bus is followed the camera rig translates
 * with it (desktop auto-follows; mobile frames once and holds;
 * the Follow toggle works on every device class), and
 * zoomToCursor stands down. The ride shadow slot is a selection
 * concern of the host — this controller follows the vehicle key
 * it is given, including a gate-closed boarded bus.
 *
 * The layer speaks the T3 adapter contract only. Merged meshes
 * rebuild on change (membership, or any vehicle moved > 2 m),
 * throttled per class — the adapter has no instancing primitive;
 * that contract question is named in the T4 record.
 */

import { mergeBuffers } from "./geometry.mjs";
import { LruCache } from "./labels.mjs";
import { formatClock } from "./engine.mjs";

export const PILLAR_HEIGHT_M = 220;
export const PILLAR_FOOTPRINT_M = 6;
export const MODEL_BELOW_M = 2600;
export const PILLAR_ABOVE_M = 3400;
export const BADGE_HIDE_DIST_M = 7000;
export const BADGE_TEXTURE_CAP = 256; // R-15 discipline
export const REBUILD_MIN_INTERVAL_MS = 250;
export const REBUILD_MOVE_EPS_M = 2;

/** LOD with hysteresis: models below 2600, pillars above 3400. */
export function lodClass(prev, camDistM) {
  if (prev === "model") return camDistM > PILLAR_ABOVE_M ? "pillar" : "model";
  return camDistM < MODEL_BELOW_M ? "model" : "pillar";
}

function rgbOf(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

function hexOf(rgb) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (c(rgb[0]) << 16) | (c(rgb[1]) << 8) | c(rgb[2]);
}

/** Desaturate toward luminance gray by `amount` (P-20: 0.65). */
export function desaturate(hex, amount) {
  const [r, g, b] = rgbOf(hex);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return hexOf([r + (lum - r) * amount, g + (lum - g) * amount, b + (lum - b) * amount]);
}

function parseHex(hexStr) {
  if (typeof hexStr !== "string") return 0xbfbfbf;
  const n = parseInt(hexStr.replace("#", ""), 16);
  return Number.isNaN(n) ? 0xbfbfbf : n;
}

function clockText(fixAtMs) {
  const d = new Date(fixAtMs);
  return formatClock(d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds());
}

/**
 * Per-vehicle render descriptors at an instant. `camDistM` is the
 * rig's distance (the LOD gate is a scene-distance gate, as with
 * route labels); `lodState` carries the hysteresis between calls.
 */
export function buildDescriptors({ tracker, registry, nowMs, camDistM, lodState }) {
  const lod = lodClass(lodState.current, camDistM);
  lodState.current = lod;
  const out = [];
  for (const entry of tracker.entries()) {
    const p = tracker.predict(entry.key, nowMs);
    if (!p) continue;
    const token = entry.routeId !== null ? registry.tokenFor(entry.routeId) : null;
    let color = token ? parseHex(token.hex) : 0xbfbfbf;
    if (p.desaturate) color = desaturate(color, p.desaturate);
    out.push({
      key: entry.key,
      vehicleId: entry.vehicleId,
      agency: entry.agency,
      routeId: entry.routeId,
      x: p.x, z: p.z, headingDeg: p.headingDeg ?? 0,
      lod: p.mode === "stale" ? "pillar" : lod,
      haloRadiusM: p.haloRadiusM,
      color,
      band: p.band,
      stale: p.mode === "stale",
      badgeText: entry.routeId ?? "",
      badgeClock: p.mode === "stale" && p.fixAtMs !== null ? clockText(p.fixAtMs) : null,
      badgesVisible: camDistM <= BADGE_HIDE_DIST_M,
      fixAtMs: p.fixAtMs,
    });
  }
  return out;
}

/* ---- geometry builders (merged-buffer format of geometry.mjs) ---- */

function boxBuffer(cx, cz, yBase, height, w, d, headingDeg, color) {
  const rad = (headingDeg * Math.PI) / 180;
  const fx = Math.sin(rad), fz = -Math.cos(rad); // forward (north = -z)
  const rx = -fz, rz = fx;                        // right
  const hw = w / 2, hd = d / 2;
  const corner = (sx, sz) => [cx + rx * sx * hw + fx * sz * hd, cz + rz * sx * hw + fz * sz * hd];
  const c = [corner(1, 1), corner(-1, 1), corner(-1, -1), corner(1, -1)];
  const positions = [];
  const indices = [];
  const rgb = rgbOf(color);
  const colorAttr = [];
  const push = (x, y, z) => { positions.push(x, y, z); colorAttr.push(...rgb); };
  // 4 walls + top, outward faces (no bottom: it sits on the ground)
  for (let s = 0; s < 4; s++) {
    const a = c[s], b = c[(s + 1) % 4];
    const base = positions.length / 3;
    push(a[0], yBase, a[1]); push(b[0], yBase, b[1]);
    push(b[0], yBase + height, b[1]); push(a[0], yBase + height, a[1]);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const topBase = positions.length / 3;
  for (const p of c) push(p[0], yBase + height, p[1]);
  indices.push(topBase, topBase + 2, topBase + 1, topBase, topBase + 3, topBase + 2);
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    routeAttr: new Float32Array(positions.length / 3),
    colorAttr: new Float32Array(colorAttr),
  };
}

function discBuffer(cx, cz, y, radius, color, segments = 24) {
  const positions = [cx, y, cz];
  const rgb = rgbOf(color);
  const colorAttr = [...rgb];
  const indices = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    positions.push(cx + Math.cos(a) * radius, y, cz + Math.sin(a) * radius);
    colorAttr.push(...rgb);
  }
  for (let i = 0; i < segments; i++) indices.push(0, 1 + i, 1 + ((i + 1) % segments));
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    routeAttr: new Float32Array(positions.length / 3),
    colorAttr: new Float32Array(colorAttr),
  };
}

export function pillarBuffers(descriptors) {
  return mergeBuffers(descriptors
    .filter((d) => d.lod === "pillar")
    .map((d) => boxBuffer(d.x, d.z, 0, PILLAR_HEIGHT_M, PILLAR_FOOTPRINT_M, PILLAR_FOOTPRINT_M, 0, d.color)));
}

export function modelBuffers(descriptors) {
  return mergeBuffers(descriptors
    .filter((d) => d.lod === "model")
    .map((d) => boxBuffer(d.x, d.z, 0, 3.2, 2.6, 12, d.headingDeg, d.color)));
}

export function haloBuffers(descriptors) {
  return mergeBuffers(descriptors
    .filter((d) => d.haloRadiusM !== null && d.haloRadiusM !== undefined)
    .map((d) => discBuffer(d.x, d.z, 2, d.haloRadiusM, d.color)));
}

/**
 * Badge declutter: greedy spiral placement in priority order.
 * items: [{ key, x, y, w, h, priority }] in screen px (anchor =
 * top-left at x/y). Returns Map key -> { x, y } with no two
 * placed rects overlapping — separation is guaranteed by
 * construction (a badge that finds no slot within the spiral
 * budget keeps its anchor only if that is free, else is hidden).
 */
export function declutterBadges(items, { stepPx = 30, rings = 6 } = {}) {
  const placed = [];
  const out = new Map();
  const overlaps = (r) => placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y);
  const sorted = [...items].sort((a, b) => a.priority - b.priority);
  for (const item of sorted) {
    let spot = null;
    outer: for (let ring = 0; ring <= rings; ring++) {
      const offsets = ring === 0 ? [[0, 0]] : [];
      if (ring > 0) {
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) === ring) offsets.push([dx * stepPx, dy * stepPx]);
          }
        }
      }
      for (const [dx, dy] of offsets) {
        const r = { x: item.x + dx, y: item.y + dy, w: item.w, h: item.h };
        if (!overlaps(r)) { spot = r; break outer; }
      }
    }
    if (spot) { placed.push(spot); out.set(item.key, { x: spot.x, y: spot.y }); }
    else out.set(item.key, null);
  }
  return out;
}

/* ---- the GL layer over the T3 adapter ---- */

export function createVehicleLayer(gl, scene, { badgeTextureFactory = (d) => ({ badge: d.badgeText, clock: d.badgeClock }) } = {}) {
  const textures = new LruCache(BADGE_TEXTURE_CAP);
  let meshes = { pillar: null, model: null, halo: null };
  let badgePool = [];
  const lastBuild = { pillar: 0, model: 0, halo: 0 };
  const lastSig = { pillar: "", model: "", halo: "" };

  function signature(descriptors, cls) {
    return descriptors
      .filter((d) => (cls === "halo" ? d.haloRadiusM !== null && d.haloRadiusM !== undefined : d.lod === cls))
      .map((d) => `${d.key}@${Math.round(d.x / REBUILD_MOVE_EPS_M)},${Math.round(d.z / REBUILD_MOVE_EPS_M)},${Math.round((d.haloRadiusM ?? 0) / 5)}`)
      .sort()
      .join("|");
  }

  function rebuild(cls, descriptors, nowMs, build, opts) {
    const sig = signature(descriptors, cls);
    if (sig === lastSig[cls]) return false;
    if (nowMs - lastBuild[cls] < REBUILD_MIN_INTERVAL_MS && meshes[cls]) return false;
    const node = gl.makeMesh(build(descriptors), opts);
    gl.addToScene(scene, node);
    if (meshes[cls]) gl.setNodeVisible(meshes[cls], false);
    meshes[cls] = node;
    lastSig[cls] = sig;
    lastBuild[cls] = nowMs;
    return true;
  }

  return {
    textures,
    meshes: () => meshes,
    /**
     * Refresh the layer for one frame. Badge sprites are pooled
     * and anchored over their vehicles; the screen-space
     * declutter (declutterBadges, above) is applied by the
     * assembly that owns the viewport — the same split T3 uses
     * for street labels (selection logic pure, sprites anchored).
     */
    update(descriptors, nowMs) {
      rebuild("pillar", descriptors, nowMs, pillarBuffers, { color: 0xffffff, vertexColors: true });
      rebuild("model", descriptors, nowMs, modelBuffers, { color: 0xffffff, vertexColors: true });
      rebuild("halo", descriptors, nowMs, haloBuffers, { color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.3 });

      const badged = descriptors.filter((d) => d.badgesVisible);
      while (badgePool.length < badged.length) {
        const s = gl.makeSprite();
        gl.addToScene(scene, s);
        badgePool.push(s);
      }
      badged.forEach((d, i) => {
        const sprite = badgePool[i];
        const tokenKey = `${d.badgeText}|${d.badgeClock ?? ""}|${d.stale ? "s" : ""}`;
        let token = textures.get(tokenKey);
        if (token === undefined) {
          token = badgeTextureFactory(d);
          textures.set(tokenKey, token);
        }
        gl.setSpriteTexture(sprite, token);
        gl.setNodeVisible(sprite, true);
        gl.setNodePosition(sprite, [d.x, PILLAR_HEIGHT_M + 30, d.z]);
      });
      for (let i = badged.length; i < badgePool.length; i++) gl.setNodeVisible(badgePool[i], false);
      return { badged: badged.length };
    },
  };
}

/* ---- follow (P-21) ---- */

export function createFollow({ rig }) {
  let state = { key: null, mode: "off", lastX: null, lastZ: null };
  return {
    state: () => ({ ...state }),
    zoomToCursorEnabled: () => state.mode === "off",
    /** Toggle follow for a vehicle. Mobile frames once and holds. */
    engage(key, { deviceClass = "desktop", pos = null, nowMs = 0 } = {}) {
      if (state.key === key && state.mode !== "off") {
        state = { key: null, mode: "off", lastX: null, lastZ: null };
        return state;
      }
      state = { key, mode: deviceClass === "mobile" ? "framing" : "following", lastX: pos?.x ?? null, lastZ: pos?.z ?? null };
      if (state.mode === "framing" && pos) {
        rig.glideToVantage("bus", [pos.x, 0, pos.z], nowMs);
      }
      return state;
    },
    disengage() {
      state = { key: null, mode: "off", lastX: null, lastZ: null };
      return state;
    },
    /** Per-frame: translate the rig with the followed vehicle. */
    tick(predict) {
      if (state.mode !== "following" || !state.key) return state;
      const p = predict(state.key);
      if (!p) {
        state = { key: null, mode: "off", lastX: null, lastZ: null };
        return state;
      }
      if (state.lastX !== null) rig.panBy(p.x - state.lastX, p.z - state.lastZ);
      state.lastX = p.x; state.lastZ = p.z;
      return state;
    },
  };
}

/**
 * Wire the layer into the renderer's frame loop (P-81 order:
 * busMotion before follow). The host supplies the per-frame
 * descriptor computation and the follow prediction.
 */
export function registerVehicleStages(rendererApi, { onBusMotion, follow, predict }) {
  rendererApi.onStage("busMotion", (ctx) => { if (onBusMotion) onBusMotion(ctx); });
  rendererApi.onStage("follow", () => { if (follow) follow.tick(predict); });
}
