/**
 * LTD rebuild — the vehicle tracker (Tranche T4, M6).
 *
 * One entry per reporting vehicle, reconciled in arc space: each
 * fix is map-matched onto its route's path (the atlas), a 1-D
 * Kalman filter smooths the arc position and estimates speed, and
 * between polls the vehicle dead-reckons along its arc — the
 * surfaces and the Ride Along widget receive predicted slot
 * positions, never raw fixes (P-18).
 *
 * Freshness is the Position Integrity contract (P-19/P-20):
 *   FRESH < 75 s · AGING 75–150 s · STALE > 150 s, and 150 s is
 *   also the prediction horizon. Past it, the marker eases back
 *   along its arc to the map-matched fix (2,000 ms minimum-jerk),
 *   desaturates 0.65 toward luminance gray, loses its halo, and
 *   its badge gains the fix's clock time — the badge clock is the
 *   vehicle's last GPS fix time, never a next departure.
 *
 * The halo is the filter's own uncertainty: radius 3σ clamped to
 * 15–150 m (P-17).
 */

import { minimumJerk } from "./camera.mjs";

export const FIX_BANDS = { freshMs: 75_000, agingMs: 150_000 };
export const PREDICTION_HORIZON_MS = 150_000;
export const STALE_EASE_MS = 2_000;
export const STALE_DESATURATE = 0.65;
export const HALO_MIN_M = 15;
export const HALO_MAX_M = 150;
export const BORN_POLLS = 2; // matcher eligibility: alive ≥2 poll cycles

const MEAS_NOISE_M = 25;      // GPS + map-match noise on an arc fix
const PROCESS_NOISE = 0.05;   // m/s² velocity diffusion (60 s poll cadence)
const MAX_SPEED_MPS = 30;

/** Fix-age band (P-19): 'fresh' | 'aging' | 'stale'. */
export function fixBand(ageMs) {
  if (ageMs < FIX_BANDS.freshMs) return "fresh";
  if (ageMs <= FIX_BANDS.agingMs) return "aging";
  return "stale";
}

function kfInit(arc) {
  return { pos: arc, vel: 0, p00: 30 * 30, p01: 0, p11: 10 * 10, atMs: null };
}

function kfPredict(kf, dtS) {
  if (dtS <= 0) return;
  kf.pos += kf.vel * dtS;
  const { p00, p01, p11 } = kf;
  kf.p00 = p00 + 2 * dtS * p01 + dtS * dtS * p11 + 0.25 * PROCESS_NOISE ** 2 * dtS ** 4;
  kf.p01 = p01 + dtS * p11 + 0.5 * PROCESS_NOISE ** 2 * dtS ** 3;
  kf.p11 = p11 + PROCESS_NOISE ** 2 * dtS * dtS;
}

function kfUpdate(kf, meas) {
  const r = MEAS_NOISE_M * MEAS_NOISE_M;
  const s = kf.p00 + r;
  const k0 = kf.p00 / s, k1 = kf.p01 / s;
  const innov = meas - kf.pos;
  kf.pos += k0 * innov;
  kf.vel += k1 * innov;
  kf.vel = Math.max(-MAX_SPEED_MPS, Math.min(MAX_SPEED_MPS, kf.vel));
  const { p00, p01, p11 } = kf;
  kf.p00 = (1 - k0) * p00;
  kf.p01 = (1 - k0) * p01;
  kf.p11 = p11 - k1 * p01;
}

export function createTracker(atlas) {
  const entries = new Map(); // key -> entry

  function ingest(fixes, nowMs) {
    const seen = new Set();
    for (const fix of fixes) {
      seen.add(fix.key);
      let e = entries.get(fix.key);
      if (!e) {
        e = {
          key: fix.key, vehicleId: fix.vehicleId ?? null,
          agency: fix.agency, routeId: fix.routeId ?? null,
          pollsSeen: 0, kf: null, pathIdx: null, offShapeM: null,
          fixAtMs: null, fixArc: null, fixX: null, fixZ: null,
          bearingDeg: null, destination: null, lastIngestMs: null,
        };
        entries.set(fix.key, e);
      }
      e.pollsSeen += 1;
      e.lastIngestMs = nowMs;
      e.agency = fix.agency;
      e.routeId = fix.routeId ?? null;
      e.bearingDeg = fix.bearingDeg ?? e.bearingDeg;
      e.destination = fix.destination ?? e.destination;

      const isNewFix = fix.fixAtMs !== null && fix.fixAtMs !== e.fixAtMs;
      if (!isNewFix) continue;
      e.fixAtMs = fix.fixAtMs;
      e.fixX = fix.x; e.fixZ = fix.z;

      const mm = e.routeId !== null ? atlas.mapMatch(e.routeId, fix.x, fix.z) : null;
      if (mm) {
        e.offShapeM = mm.dist;
        if (!e.kf || e.pathIdx !== mm.pathIdx) {
          e.kf = kfInit(mm.arc);
          e.pathIdx = mm.pathIdx;
        } else {
          kfPredict(e.kf, Math.max(0, (fix.fixAtMs - (e.kf.atMs ?? fix.fixAtMs)) / 1000));
          kfUpdate(e.kf, mm.arc);
        }
        e.kf.atMs = fix.fixAtMs;
        e.fixArc = mm.arc;
      } else {
        e.offShapeM = null;
        e.pathIdx = null;
        e.kf = null;
        e.fixArc = null;
      }
    }
    // The poll's set is authoritative: absent vehicles leave the tracker.
    for (const key of [...entries.keys()]) {
      if (!seen.has(key)) entries.delete(key);
    }
  }

  function predict(key, nowMs) {
    const e = entries.get(key);
    if (!e || e.fixAtMs === null) return null;
    const ageMs = nowMs - e.fixAtMs;
    const band = fixBand(Math.max(0, ageMs));

    if (!e.kf || e.pathIdx === null) {
      // No arc to reckon along: the fix itself is the position.
      return {
        key, x: e.fixX, z: e.fixZ, headingDeg: e.bearingDeg,
        arc: null, pathIdx: null, mode: band === "stale" ? "stale" : "fix",
        band, haloRadiusM: null, desaturate: band === "stale" ? STALE_DESATURATE : 0,
        fixAtMs: e.fixAtMs, offShapeM: e.offShapeM,
      };
    }

    const len = atlas.pathLength(e.routeId, e.pathIdx);
    const horizonArc = (() => {
      const kf = { ...e.kf };
      kfPredict(kf, Math.max(0, (e.fixAtMs + PREDICTION_HORIZON_MS - (e.kf.atMs ?? e.fixAtMs)) / 1000));
      return Math.max(0, Math.min(len, kf.pos));
    })();

    if (ageMs <= PREDICTION_HORIZON_MS) {
      const kf = { ...e.kf };
      kfPredict(kf, Math.max(0, (nowMs - (e.kf.atMs ?? nowMs)) / 1000));
      const arc = Math.max(0, Math.min(len, kf.pos));
      const pt = atlas.pointAt(e.routeId, e.pathIdx, arc);
      const sigma = Math.sqrt(Math.max(0, kf.p00));
      return {
        key, x: pt.x, z: pt.z,
        headingDeg: Math.abs(e.kf.vel) > 0.5 || e.bearingDeg === null ? pt.heading : e.bearingDeg,
        arc, pathIdx: e.pathIdx, mode: "predicted", band,
        haloRadiusM: Math.max(HALO_MIN_M, Math.min(HALO_MAX_M, 3 * sigma)),
        desaturate: 0, fixAtMs: e.fixAtMs, offShapeM: e.offShapeM,
      };
    }

    // Stale: ease from the horizon prediction back to the fix.
    const staleSince = e.fixAtMs + PREDICTION_HORIZON_MS;
    const ease = minimumJerk(Math.min(1, Math.max(0, (nowMs - staleSince) / STALE_EASE_MS)));
    const arc = horizonArc + (e.fixArc - horizonArc) * ease;
    const pt = atlas.pointAt(e.routeId, e.pathIdx, arc);
    return {
      key, x: pt.x, z: pt.z,
      headingDeg: e.bearingDeg ?? pt.heading,
      arc, pathIdx: e.pathIdx, mode: "stale", band,
      haloRadiusM: null, desaturate: STALE_DESATURATE,
      fixAtMs: e.fixAtMs, offShapeM: e.offShapeM,
    };
  }

  return {
    ingest,
    predict,
    entry: (key) => entries.get(key) ?? null,
    entries: () => [...entries.values()],
    keys: () => [...entries.keys()],
    pollsSeen: (key) => entries.get(key)?.pollsSeen ?? 0,
    get size() { return entries.size; },
  };
}
