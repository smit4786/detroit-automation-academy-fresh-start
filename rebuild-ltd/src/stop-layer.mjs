/**
 * LTD rebuild — the stop layer over the T3 adapter (Tranche T5).
 *
 * One merged mesh of pylons for the GOVERNED stop set (the host's
 * filter state decides the set; an empty set renders nothing and
 * picks nothing — never a fallback to all stops, P-36). Rebuilds
 * are discrete events, in the placed discipline (P-79): the
 * governed set changing, the selection changing, or the zoom scale
 * crossing a quantized band. Nothing rebuilds per frame.
 *
 * The selection ground ring pulses (opacity oscillation) unless
 * reduced motion is set, when it holds steady (P-80: the one flag
 * governs all motion). The layer hides as a whole at and beyond
 * the 26,000 m stop LOD edge (P-79). Opacity is never applied to
 * the pylon mesh — stops are opaque at all distances (R-12).
 */

import { buildStopBuffers, buildRingBuffers, stopScale, STOP_LOD_M } from "./stops.mjs";

export const SCALE_BAND_STEP = 0.05;

export function scaleBand(camDist, mode = "orbit") {
  return Math.round(stopScale(camDist, mode) / SCALE_BAND_STEP);
}

export function createStopLayer(gl, scene, registry, { reducedMotion = false } = {}) {
  let mesh = null;
  let ring = null;
  let governed = [];
  let selectedIdx = null;
  let band = null;
  let lodVisible = true;
  let builds = 0;

  function rebuild() {
    if (!governed.length) {
      if (mesh) gl.setNodeVisible(mesh, false);
      if (ring) gl.setNodeVisible(ring, false);
      mesh = null;
      ring = null;
      return;
    }
    const scale = band === null ? 1 : band * SCALE_BAND_STEP;
    const node = gl.makeMesh(
      buildStopBuffers(registry, governed, { scale, selectedIdx }),
      { color: 0xffffff, vertexColors: true },
    );
    gl.addToScene(scene, node);
    if (mesh) gl.setNodeVisible(mesh, false);
    mesh = node;
    gl.setNodeVisible(mesh, lodVisible);
    builds++;
    updateRing();
  }

  function updateRing() {
    const stop = selectedIdx === null ? null : governed.find((s) => s.idx === selectedIdx);
    if (!stop) {
      if (ring) gl.setNodeVisible(ring, false);
      ring = null;
      return;
    }
    const node = gl.makeMesh(buildRingBuffers(stop), {
      color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.85,
    });
    gl.addToScene(scene, node);
    if (ring) gl.setNodeVisible(ring, false);
    ring = node;
    gl.setNodeVisible(ring, lodVisible);
  }

  return {
    /** Replace the governed set (stop records). Rebuilds. */
    setGoverned(stops) {
      governed = stops ?? [];
      rebuild();
    },
    governedCount: () => governed.length,
    buildCount: () => builds,
    mesh: () => mesh,
    ring: () => ring,

    /** Paint a stop selected (white + ground ring); null clears. */
    setSelected(idx) {
      if (idx === selectedIdx) return;
      selectedIdx = idx;
      rebuild();
    },
    selected: () => selectedIdx,

    /**
     * Per-frame distance discipline: LOD visibility + scale-band
     * rebuilds. Returns what changed so callers can assert the
     * discrete-event behavior.
     */
    setDistance(camDist, mode = "orbit") {
      const visible = camDist < STOP_LOD_M;
      let changed = false;
      if (visible !== lodVisible) {
        lodVisible = visible;
        if (mesh) gl.setNodeVisible(mesh, visible);
        if (ring) gl.setNodeVisible(ring, visible && !!ring);
        changed = true;
      }
      const nextBand = scaleBand(camDist, mode);
      if (band === null) {
        band = nextBand;
      } else if (nextBand !== band) {
        band = nextBand;
        if (governed.length) rebuild();
        changed = true;
      }
      return changed;
    },

    /** Ring pulse; registered on a frame stage by the host. */
    tick(nowMs) {
      if (!ring || !lodVisible) return;
      if (reducedMotion) {
        gl.setNodeOpacity(ring, 0.85);
        return;
      }
      const phase = (nowMs % 1600) / 1600;
      gl.setNodeOpacity(ring, 0.55 + 0.35 * Math.sin(phase * Math.PI * 2));
    },
  };
}

/** Wire the layer's pulse into the renderer's frame loop. */
export function registerStopLayerStages(rendererApi, layer) {
  rendererApi.onStage("eases", (ctx) => layer.tick(ctx.now));
}
