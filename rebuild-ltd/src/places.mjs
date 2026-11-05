/**
 * LTD rebuild — the Places layer (Tranche T6; P-66, Gate 5).
 *
 * Starbucks + Planet Fitness as a static layer, on the MoGo
 * layer's pattern: its own toggle, details in the shared stop
 * card, screen-reader surfaces. No live feed and no staleness —
 * the dataset is baked from OpenStreetMap via Overpass
 * (© OpenStreetMap contributors, ODbL; the attribution ships in
 * the dataset, the panel note, and every place card) and fetched
 * lazily the first time the toggle is enabled. The dataset is a
 * published artifact consumed by URL, never vendored — 42
 * locations (31 Starbucks, 11 Planet Fitness) inside the street
 * mosaic's extent; OSM reads ~85–88% of in-boundary storefronts,
 * and the card note says the data may not list every location.
 *
 * Identity is never carried by color alone: a flat puck (16 tall,
 * wider and flatter than every pylon), a slim pillar (48) with
 * the letter badge ("S" / "PF") at its top at close zoom, and a
 * soft brand-tinted halo (2.2× the disc, opacity 0.5) at every
 * zoom. The whole marker tops out at 64 on the stop family's
 * scale — below a single-route stop pylon's 103 — a pin, never a
 * second skyline. Disc diameter is distance-scaled past
 * ≈4,400 m (diameter = camDist × 0.0146) so a disc holds ≈16 px
 * on an 844 px viewport at every wider zoom. Brand colors and
 * letter badges only — no logos or trademarked artwork.
 *
 * Gate 5 labeling: both brands are partnership placements, so the
 * "Sponsored" tag on the toggle row and the legend line in the
 * SR note follow the layer state exactly — visible whenever the
 * layer is enabled, absent when it is off, removable by no
 * control while it is on. Labeling only: nothing here touches
 * ranking, ordering, or prominence of any transit information.
 *
 * One toggle drives both brands (Justin's direction 2026-10-15;
 * the per-brand distinction lives on the map and in the dataset,
 * not in panel controls). Default OFF, session-only — nothing is
 * written to storage (Justin's MoGo rulings, 2026-10-14).
 * Load failure is honest: toggles read "unavailable", the SR
 * note says the data could not be loaded, the next enable
 * retries.
 */

import { STOP_BASE_Y } from "./geometry.mjs";
import { cylinderBuffers } from "./marker-geometry.mjs";
import { mergeBuffers } from "./geometry.mjs";

export const PLACES_BRANDS = {
  starbucks: { name: "Starbucks", kind: "Coffee shop", badge: "S", color: "#555555" },
  planetfitness: { name: "Planet Fitness", kind: "Fitness centre", badge: "PF", color: "#393939" },
};
export const PLACES_DISC_H = 16;
export const PLACES_PILLAR_H = 48;
export const PLACES_PILLAR_R = 5;
export const PLACES_GLOW_K = 2.2;
export const PLACES_GLOW_OPACITY = 0.5;
export const PLACES_DISC_BASE_D = 64;
export const PLACES_DISC_K = 0.0146;
export const PLACES_BADGE_MAX_DIST_M = 9000;
export const PLACES_LOAD_FAIL_TEXT = "Points of interest data could not be loaded.";
export const PLACES_SR_DOWN_TEXT = "Points of interest data is unavailable — places.json could not be loaded.";
export const PLACES_SR_OFF_TEXT = "Points of interest are off. Enable Points of interest in the filter panel to list them here.";
export const PLACES_SPONSORED_SR = " Sponsored: the Starbucks and Planet Fitness layers are partnership placements.";

/** Disc diameter for a camera distance: the base below ≈4,400 m, proportional beyond. */
export function placesDiscDiamFor(camDistM) {
  return Math.max(PLACES_DISC_BASE_D, camDistM * PLACES_DISC_K);
}
export function placesGlowDiamFor(camDistM) {
  return placesDiscDiamFor(camDistM) * PLACES_GLOW_K;
}

export function placesCardModel(p) {
  if (!p) return null;
  const b = PLACES_BRANDS[p.brand] || { name: p.brand || "Place", kind: "Place" };
  return {
    title: p.n || b.name,
    brandName: b.name,
    kind: b.kind,
    address: p.addr || null,
    hours: p.hours || null,
    phone: p.phone || null,
    website: p.website || null,
    note: `${b.name} ${b.kind.toLowerCase()}. Location from OpenStreetMap ` +
      `(© OpenStreetMap contributors, ODbL) — community map data, which may not list every location.`,
  };
}

export function placesCardText(record) {
  if (!record || !record.pdata) return "Place details opened.";
  const m = placesCardModel(record.pdata);
  return `Place details opened. ${m.title}. ${m.kind}${m.address ? `. ${m.address}` : ". Address not listed"}.`;
}

export function placesSrText(p) {
  const b = PLACES_BRANDS[p.brand];
  return `${p.n || (b ? b.name : "Place")}${p.addr ? `, ${p.addr}` : " — address not listed"}.`;
}

export function createPlacesService({ url, fetchImpl = fetch } = {}) {
  let data = null;
  let loadState = "idle"; // idle | loading | ok | error
  const on = { starbucks: false, planetfitness: false };

  async function ensureData() {
    if (data || loadState === "loading") return data;
    loadState = "loading";
    try {
      const r = await fetchImpl(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`places http ${r.status}`);
      const d = await r.json();
      if (!d || !Array.isArray(d.places)) throw new Error("bad places payload");
      data = d;
      loadState = "ok";
    } catch {
      loadState = "error";
    }
    return data;
  }

  const allOn = () => !!(on.starbucks && on.planetfitness);

  return {
    ensureData,
    loadState: () => loadState,
    data: () => data,
    counts: () => (data && data.meta && data.meta.counts) || null,
    allOn,
    /** The single toggle: both brands together. Enabling loads lazily. */
    async setOn(v) {
      on.starbucks = !!v;
      on.planetfitness = !!v;
      if (v) await ensureData();
      return allOn();
    },
    enabledPlaces() {
      if (!data || !Array.isArray(data.places)) return [];
      return data.places.filter((p) => !!on[p.brand]);
    },
    pickRecords() {
      return this.enabledPlaces().map((p) => ({
        id: p.id, n: p.n, name: p.n, x: p.x, z: p.z, r: [], routes: [], place: true, pdata: p,
      }));
    },
    toggleModel() {
      const counts = (data && data.meta && data.meta.counts) || null;
      return {
        pressed: allOn(),
        countText: loadState === "error" ? "unavailable"
          : counts ? `${counts.total || 0} points of interest` : "42 points of interest",
        sponsoredVisible: allOn(), // Gate 5: the tag follows the layer state exactly
      };
    },
    srModel() {
      const shown = this.enabledPlaces();
      let note;
      if (loadState === "error") note = PLACES_SR_DOWN_TEXT;
      else if (loadState === "ok") {
        const total = (data.meta && data.meta.counts) ? data.meta.counts.total : data.places.length;
        note = `Points of interest from OpenStreetMap (© OpenStreetMap contributors, ODbL): ` +
          `${total} points of interest in the dataset, ${shown.length} shown.` +
          (shown.length ? PLACES_SPONSORED_SR : "");
      } else note = PLACES_SR_OFF_TEXT;
      return { note, lines: shown.map((p) => placesSrText(p)) };
    },
    /** Toggle announcements: the tally only when the dataset is in hand. */
    announceText(turningOn) {
      if (!turningOn) return "Points of interest hidden.";
      const counts = (data && data.meta && data.meta.counts) || null;
      const n = counts ? (counts.total || 0) : 0;
      return n ? `Points of interest shown: ${n} points of interest.` : "Points of interest shown.";
    },
  };
}

/* ---- marker descriptors + GL build ---- */

/**
 * Marker descriptors at a camera distance and the stop family's
 * height scale: discs + pillars (merged cylinder buffers in
 * buildPlacesMeshes), glow sprites (2.2× disc, brand tint,
 * additive, opacity 0.5), letter badges below 9,000 m.
 */
export function placesMarkerDescriptors(places, camDistM) {
  const discD = placesDiscDiamFor(camDistM);
  return places.map((p) => {
    const brand = PLACES_BRANDS[p.brand] || { badge: "?", color: "#555555" };
    return {
      id: p.id, x: p.x, z: p.z,
      discDiam: discD, discH: PLACES_DISC_H, pillarH: PLACES_PILLAR_H,
      pillarR: Math.max(PLACES_PILLAR_R, discD / 13),
      color: brand.color, badge: brand.badge,
      glowDiam: placesGlowDiamFor(camDistM), glowOpacity: PLACES_GLOW_OPACITY,
      badgeVisible: camDistM < PLACES_BADGE_MAX_DIST_M,
    };
  });
}

export function buildPlacesMeshes({ gl, scene, descriptors, stopScale = 1 }) {
  const discs = [], pillars = [];
  for (const d of descriptors) {
    discs.push(cylinderBuffers({
      x: d.x, z: d.z, yBase: STOP_BASE_Y, height: d.discH * stopScale,
      rTop: d.discDiam / 2 * (32 / 36), rBase: d.discDiam / 2, segments: 20,
    }));
    pillars.push(cylinderBuffers({
      x: d.x, z: d.z, yBase: STOP_BASE_Y + d.discH * stopScale,
      height: d.pillarH * stopScale, rTop: d.pillarR, rBase: d.pillarR * 1.25, segments: 10,
    }));
  }
  const nodes = [];
  if (descriptors.length) {
    // One color per brand family would split the merge; the disc
    // tint is per-brand, so build one merged mesh per brand color.
    const byColor = new Map();
    descriptors.forEach((d, i) => {
      if (!byColor.has(d.color)) byColor.set(d.color, { discs: [], pillars: [] });
      byColor.get(d.color).discs.push(discs[i]);
      byColor.get(d.color).pillars.push(pillars[i]);
    });
    for (const [color, bufs] of byColor) {
      const hex = parseInt(color.slice(1), 16);
      const dm = gl.makeMesh(mergeBuffers(bufs.discs), { color: hex });
      const pm = gl.makeMesh(mergeBuffers(bufs.pillars), { color: hex });
      gl.addToScene(scene, dm);
      gl.addToScene(scene, pm);
      nodes.push(dm, pm);
    }
  }
  return nodes;
}

/**
 * The stop card's Place provider (T5 slot): a Place pick record
 * renders its card model; any other record gets no section.
 */
export function placeCardProvider() {
  return (record) => {
    if (!record || !record.place || !record.pdata) return null;
    const m = placesCardModel(record.pdata);
    if (!m) return null;
    const bits = [`${m.kind} · ${m.address || "Not listed in OpenStreetMap"}`];
    bits.push(`Brand: ${m.brandName}`);
    if (m.hours) bits.push(`Hours: ${m.hours}`);
    if (m.phone) bits.push(`Phone: ${m.phone}`);
    if (m.website) bits.push(`Website: ${m.website}`);
    bits.push(m.note);
    return { name: m.title, text: bits.join(" · ") };
  };
}
