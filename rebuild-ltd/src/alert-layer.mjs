/**
 * LTD rebuild — the alert map layer (Tranche T8, M11 treatments
 * on the map, P-62).
 *
 * Map-Native Concept B draws two things, both grayscale, both
 * paired with words on their owning surfaces (the treatments are
 * never color alone — the words live on chips, cards and the
 * planner; this layer is geometry only):
 *
 *   - a flat ring at every stop an active, non-planned alert
 *     names. A STOP_MOVED stop's ring is larger and paper-white —
 *     the ring plus the ⇄ label anchor in `movedLabels()` is the
 *     whole treatment: NO replacement point is drawn, because
 *     the alert names none and inventing one is prohibited.
 *   - a dashed ribbon over the longest path of every route an
 *     active DETOUR or NO_SERVICE alert names, floating above
 *     the guideway decks so it reads as an overlay, not a route.
 *
 * Planned alerts never reach this layer (the service's overlay
 * model excludes them — they tint chips only). Rebuilds happen
 * on discrete events only: when the overlay model's signature
 * changes, per the layer discipline of T5/T6 — old meshes are
 * hidden, never removed (the adapter contract has no removal;
 * the MoGo layer's pattern).
 *
 * Heights and sizes are this tranche's constructions, named in
 * the delivery record: rings sit just above the stop base
 * (STOP_BASE_Y + 8); the dashed overlay floats at y 195, above
 * every guideway deck (66 + ordinal × 1.2, max ~165) and below
 * the route labels (1,050).
 */

import { mergeBuffers, ribbonStrip } from "./geometry.mjs";
import { ringBuffers } from "./marker-geometry.mjs";
import { STOP_BASE_Y } from "./geometry.mjs";

export const ALERT_RING_Y = STOP_BASE_Y + 8;
export const ALERT_RING = { rInner: 30, rOuter: 46 };
export const ALERT_RING_MOVED = { rInner: 46, rOuter: 72 };
export const ALERT_OVERLAY_Y = 195;
export const ALERT_OVERLAY_WIDTH_M = 26;
export const ALERT_DASH = [240, 170];
export const ALERT_RING_COLOR = 0xd8d8d8;
export const ALERT_RING_MOVED_COLOR = 0xffffff;
export const ALERT_OVERLAY_COLOR = 0x9a9a9a;

export function createAlertLayer({ gl, scene, registry }) {
  if (!gl) throw new Error("alert-layer: gl adapter is required");
  if (!registry) throw new Error("alert-layer: registry is required");

  let nodes = [];
  let builtSig = null;
  let anchors = [];

  function longestPath(route) {
    let best = null;
    for (const p of route?.paths ?? []) {
      if (!best || p.length > best.length) best = p;
    }
    return best;
  }

  /** Rebuild when the model changed; returns the model signature. */
  function refresh(model) {
    const sig = JSON.stringify([
      model.stopRings.map((r) => [r.stopId, r.treatment]),
      model.routeOverlays.map((r) => [r.routeId, r.treatment]),
    ]);
    if (sig === builtSig) return sig;
    builtSig = sig;
    for (const n of nodes) gl.setNodeVisible(n, false);
    nodes = [];
    anchors = [];

    const plain = [], moved = [];
    for (const ring of model.stopRings) {
      const stop = registry.stopById(ring.stopId);
      if (!stop) continue; // a stop the registry does not hold draws nothing
      const dims = ring.moved ? ALERT_RING_MOVED : ALERT_RING;
      (ring.moved ? moved : plain).push(ringBuffers({
        x: stop.x, z: stop.z, y: ALERT_RING_Y, ...dims,
      }));
      if (ring.moved) anchors.push({ stopId: ring.stopId, glyph: "⇄", x: stop.x, z: stop.z, y: ALERT_RING_Y });
    }
    if (plain.length) {
      const mesh = gl.makeMesh(mergeBuffers(plain), {
        color: ALERT_RING_COLOR, transparent: true, opacity: 0.9,
      });
      gl.addToScene(scene, mesh);
      nodes.push(mesh);
    }
    if (moved.length) {
      const mesh = gl.makeMesh(mergeBuffers(moved), {
        color: ALERT_RING_MOVED_COLOR, transparent: true, opacity: 0.95,
      });
      gl.addToScene(scene, mesh);
      nodes.push(mesh);
    }

    const strips = [];
    for (const ov of model.routeOverlays) {
      const route = registry.routeById(ov.routeId);
      const path = route && longestPath(route);
      if (!path || path.length < 2) continue;
      strips.push(ribbonStrip(path, {
        width: ALERT_OVERLAY_WIDTH_M, y: ALERT_OVERLAY_Y,
        dashPattern: ALERT_DASH, color: ALERT_OVERLAY_COLOR,
      }));
    }
    if (strips.length) {
      const mesh = gl.makeMesh(mergeBuffers(strips), {
        color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.85,
      });
      gl.addToScene(scene, mesh);
      nodes.push(mesh);
    }
    return sig;
  }

  return {
    refresh,
    /** ⇄ label anchors for the assembly's sprite pool (STOP_MOVED). */
    movedLabels: () => anchors.slice(),
    /** Node count of the current build (test/smoke surface). */
    nodeCount: () => nodes.length,
    signature: () => builtSig,
  };
}
