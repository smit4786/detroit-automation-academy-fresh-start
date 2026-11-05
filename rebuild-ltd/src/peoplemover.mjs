/**
 * LTD rebuild — the People Mover layer (Tranche T6; P-70, R-14;
 * closes the station-set half of DV-T5-1).
 *
 * A static layer, honest about being static: no live feed exists
 * (verified 2026-10-05), no beacons, no "LIVE" marker — the
 * filter-panel note states the provenance outright ("No live feed
 * exists for the People Mover — stations and the downtown loop
 * are schedule geometry from the agency's GTFS. Positions are
 * real; no vehicles are shown.").
 *
 *   - The DPM pseudo-route registers for naming and stop cards
 *     ("DPM · Detroit People Mover", gray 0x9F9F9F) but stays OUT
 *     of the route order: filter/dim/near-me machinery never
 *     touches this layer (route-names.mjs's pseudo registry).
 *   - Guideway: a narrow 14 m single-track deck at y = 140
 *     (PM_DECK_Y — above the highest DDOT route deck), open air
 *     beneath: NO continuous skirt; support pillars only at
 *     stations. Paper-white station pins (r 24/32, height 300)
 *     and flat rings (40/64, opacity 0.45) at deck level.
 *   - The "People Mover · Downtown Loop" label rides at y 1,050
 *     over the loop midpoint with a tether to the deck.
 *   - OFF by default; the toggle is the layer's only control.
 *     Switching off with a People Mover stop card open closes it
 *     (the host acts on the returned flag).
 *
 * Data: data/peoplemover.json (derive/07_peoplemover.py) — the 13
 * stations settled and projection-verified. The loop polyline is
 * a NAMED GAP in that asset (its `loop` is null; see `loop_gap`):
 * the published bake's point array is not path-ordered, and R-14
 * forbids inventing the circuit. The deck binds `data.loop` when
 * a path-ordered derivation lands — no code change needed; until
 * then the layer renders stations, pins, pillars, rings, and the
 * label (anchored on the station centroid), and says what it is.
 */

import { ribbonStrip, mergeBuffers, chaikin } from "./geometry.mjs";
import { cylinderBuffers, ringBuffers } from "./marker-geometry.mjs";

export const PM_ROUTE_ID = "DPM";
export const PM_ROUTE_NAME = "Detroit People Mover";
export const PM_COLOR = 0x9f9f9f;
export const PM_DECK_Y = 140;
export const PM_DECK_WIDTH_M = 14;
export const PM_LABEL_Y = 1050;
export const PM_PANEL_NOTE = "No live feed exists for the People Mover — stations and the downtown loop are schedule geometry from the agency’s GTFS. Positions are real; no vehicles are shown.";
export const PM_LABEL_TEXT = "People Mover · Downtown Loop";

const PIN_COLOR = 0xf2f2f2;
/** Per-channel shade of the concrete color (the placed pillar tone, × 0.55). */
function shade(hex, f) {
  const r = Math.floor(((hex >> 16) & 0xff) * f);
  const g = Math.floor(((hex >> 8) & 0xff) * f);
  const b = Math.floor((hex & 0xff) * f);
  return (r << 16) | (g << 8) | b;
}
const PILLAR_COLOR = shade(PM_COLOR, 0.55);

export function createPeopleMover({ data, gl, scene, names }) {
  names.registerPseudoRoute(PM_ROUTE_ID, PM_ROUTE_NAME);
  const stations = (data?.stations ?? []).map((s) => ({
    id: String(s.id), n: s.name, name: s.name, x: s.x, z: s.z,
    lat: s.lat, lon: s.lon, r: [PM_ROUTE_ID], routes: [PM_ROUTE_ID], pm: true,
  }));
  const loop = Array.isArray(data?.loop) && data.loop.length >= 2 ? data.loop : null;

  let visible = false; // OFF by default
  const nodes = [];
  let built = false;

  function labelAnchor() {
    if (loop) return loop[Math.floor(loop.length / 2)];
    const cx = stations.reduce((a, s) => a + s.x, 0) / (stations.length || 1);
    const cz = stations.reduce((a, s) => a + s.z, 0) / (stations.length || 1);
    return [cx, cz];
  }

  function build() {
    if (built) return;
    built = true;
    if (loop) {
      const deck = gl.makeMesh(
        ribbonStrip(chaikin(loop, 2), { width: PM_DECK_WIDTH_M, y: PM_DECK_Y }),
        { color: PM_COLOR });
      gl.addToScene(scene, deck);
      nodes.push(deck);
    }
    const pins = [], pillars = [], rings = [];
    for (const s of stations) {
      pins.push(cylinderBuffers({ x: s.x, z: s.z, yBase: PM_DECK_Y, height: 300, rTop: 24, rBase: 32 }));
      pillars.push(cylinderBuffers({ x: s.x, z: s.z, yBase: 0, height: PM_DECK_Y, rTop: 6, rBase: 9 }));
      rings.push(ringBuffers({ x: s.x, z: s.z, y: PM_DECK_Y + 3, rInner: 40, rOuter: 64 }));
    }
    if (stations.length) {
      const pinMesh = gl.makeMesh(mergeBuffers(pins), { color: PIN_COLOR });
      const pillarMesh = gl.makeMesh(mergeBuffers(pillars), { color: PILLAR_COLOR });
      const ringMesh = gl.makeMesh(mergeBuffers(rings), {
        color: PIN_COLOR, transparent: true, opacity: 0.45,
      });
      for (const m of [pinMesh, pillarMesh, ringMesh]) { gl.addToScene(scene, m); nodes.push(m); }
    }
    for (const n of nodes) gl.setNodeVisible(n, visible);
  }

  return {
    stations: () => stations,
    /** Station ids for the stop-label tier rule (P-31 tier 0). */
    stationIdSet: () => new Set(stations.map((s) => s.id)),
    hasLoop: () => !!loop,
    label: () => {
      const [x, z] = labelAnchor();
      return { text: PM_LABEL_TEXT, color: "#9F9F9F", x, z, y: PM_LABEL_Y, tetherToY: PM_DECK_Y, tetherTopY: 980 };
    },
    panelModel: () => ({ pressed: visible, countLabel: "static", note: PM_PANEL_NOTE }),
    build,
    setVisible(on) {
      visible = !!on;
      build();
      for (const n of nodes) gl.setNodeVisible(n, visible);
      return visible;
    },
    visible: () => visible,
    /** Picking includes the stations only while the layer is on. */
    pickRecords: () => (visible ? stations : []),
  };
}
