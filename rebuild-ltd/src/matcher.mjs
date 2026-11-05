/**
 * LTD rebuild — the trip matcher (Tranche T4, M6; Phase 2b-i).
 *
 * Per poll, each eligible DDOT vehicle is matched to the scheduled
 * trip it is most plausibly running; the match yields a measured
 * delay that the host hands to the engine (`setLiveDelays`) and
 * that arrivals / ride-times consumers read as trip state. The
 * gates are the audited constants of record (compute-accuracy
 * audit 2026-10-16 §2b, as shipped after the rank-1 fix) — they
 * are not re-tuned here:
 *
 *   tracker alive ≥ 2 poll cycles · GPS fix age ≤ 150 s ·
 *   map-match ≤ 150 m off-shape · candidate window
 *   dep[0]−1800 s … arr[last]+300 s on today's or the previous
 *   service · tripExpected must map ≥ 2 of the trip's stops onto
 *   the vehicle's path with strictly increasing arc positions ·
 *   stop-index gate −8 … +1 · score (arc residual − 500 m
 *   headsign bonus) < 4000 · best beats second by > 300 ·
 *   |delay| outside [−300 s, +1800 s] marks the trip disrupted,
 *   never shifted · EMA 0.5 on repeat matches · one vehicle per
 *   trip · 3 quiet polls revert a trip to scheduled.
 *
 * Two fences ride with this module:
 *   H-04 (matcher half, the fix of record, applied here):
 *   candidateTrips/tripExpected evaluate previous-service trips
 *   in their own day frame — a 25:00 trip on yesterday's service
 *   is matchable at 01:00 today. Without the shift, 284 trips
 *   (4.7%) are unmatchable 00:00–04:30. The engine half landed
 *   in T2; the gate is the 00:00–05:00 slice replay.
 *   H-03 stays OPEN behind its gate: the stop-index gate ships
 *   as-is (−8 … +1). Widening it needs replay evidence the
 *   counters below now collect (H-05 rank 8: per-poll outcome
 *   counters — the matcher is instrumented from birth here).
 *
 * SMART vehicles are never matched (display-only, R-26/R-29);
 * QLINE has no timetable to match against (P-23).
 */

export const MATCH_GATES = {
  bornPolls: 2,
  fixMaxAgeS: 150,
  offShapeMaxM: 150,
  candidatePreS: 1800,
  candidatePostS: 300,
  minMappedStops: 2,
  stopGateMin: -8,
  stopGateMax: 1,
  scoreMax: 4000,
  marginMin: 300,
  headsignBonusM: 500,
  delayMinS: -300,
  delayMaxS: 1800,
  emaAlpha: 0.5,
  quietPollsRevert: 3,
};

const DAY_MS = 86_400_000;

function ymdOf(date) {
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(date.getFullYear(), 4)}${p(date.getMonth() + 1, 2)}${p(date.getDate(), 2)}`;
}

function localMidnightMs(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function tripKey(trip) {
  return `${trip.r}|${trip.s}|${trip.dep[0]}|${trip.stops.join(",")}`;
}

function headsignMatches(destination, headsign) {
  if (!destination || !headsign) return false;
  const a = String(destination).trim().toLowerCase();
  const b = String(headsign).trim().toLowerCase();
  return a !== "" && b !== "" && (a === b || a.includes(b) || b.includes(a));
}

export function createMatcher({ bound, atlas }) {
  const tt = bound.timetable;

  // Service composition mirrors the engine's (T2 record §1):
  // the binding's mask+exceptions set, the engine's validity
  // window, expressed as timetable service-array indices.
  const serviceIndex = new Map();
  tt.services.forEach((svc, i) => {
    const key = `${svc.feed ?? 0}|${svc.id}`;
    if (!serviceIndex.has(key)) serviceIndex.set(key, i);
  });
  function serviceSetIndices(feed, ymd) {
    const out = new Set();
    for (const id of bound.servicesFor(feed, ymd)) {
      const i = serviceIndex.get(`${feed}|${id}`);
      if (i === undefined) continue;
      const svc = tt.services[i];
      if (ymd >= svc.start && ymd <= svc.end) out.add(i);
    }
    return out;
  }

  // DDOT trips by route id (SMART trips exist in the artifact and
  // are planned from static schedule; they are never matched).
  const tripsByRoute = new Map();
  for (const trip of tt.trips) {
    const route = tt.routes[trip.r];
    if (!route || route.ag !== "DDOT") continue;
    const rid = String(route.id);
    if (!tripsByRoute.has(rid)) tripsByRoute.set(rid, []);
    tripsByRoute.get(rid).push(trip);
  }

  const state = new Map(); // tripKey -> { trip, delaySec, disrupted, vehicleKey, misses }
  const cumulative = freshCounters();

  function freshCounters() {
    return {
      polls: 0, fixes: 0, eligible: 0, matched: 0, disrupted: 0,
      rejected: {
        unborn: 0, fixStale: 0, offShape: 0, noCandidates: 0,
        expectedInvalid: 0, stopGate: 0, score: 0, margin: 0, shadowed: 0,
      },
      candidateRejections: { expectedInvalid: 0, stopGateEarly: 0, stopGateLate: 0, score: 0 },
    };
  }

  /**
   * The day's two frames for a poll instant: today's service set
   * with today's midnight, yesterday's with yesterday's. A trip
   * in today's set runs in today's frame; else a trip in
   * yesterday's set runs in yesterday's frame (H-04).
   */
  function framesFor(pollDate) {
    const today = new Date(pollDate.getTime());
    const yesterday = new Date(pollDate.getTime() - DAY_MS);
    return [
      { dayStartMs: localMidnightMs(today), services: serviceSetIndices(0, ymdOf(today)) },
      { dayStartMs: localMidnightMs(yesterday), services: serviceSetIndices(0, ymdOf(yesterday)) },
    ];
  }

  function frameFor(trip, frames) {
    for (const frame of frames) {
      if (frame.services.has(trip.s)) return frame;
    }
    return null;
  }

  /**
   * Candidate trips for a fix: the route's trips whose service
   * runs in one of the two frames and whose absolute run window
   * [dep[0]−1800, arr[last]+300] contains the fix time.
   */
  function candidateTrips(routeId, fixAtMs, frames) {
    const out = [];
    for (const trip of tripsByRoute.get(String(routeId)) ?? []) {
      const frame = frameFor(trip, frames);
      if (!frame) continue;
      const depAbs = (frame.dayStartMs + trip.dep[0] * 1000) / 1000;
      const arrAbs = (frame.dayStartMs + trip.arr[trip.arr.length - 1] * 1000) / 1000;
      const fixS = fixAtMs / 1000;
      if (fixS < depAbs - MATCH_GATES.candidatePreS) continue;
      if (fixS > arrAbs + MATCH_GATES.candidatePostS) continue;
      out.push({ trip, frame, depAbs, arrAbs });
    }
    return out;
  }

  /**
   * The trip's expected progress along the vehicle's path.
   * Maps the trip's stops onto the path's arc (the R-04 rule:
   * stop references are registry indices, translated only
   * through the registry/atlas doors — never raw ids), and
   * interpolates the expected arc at an absolute time from the
   * scheduled stop times. Valid only with ≥2 mapped stops at
   * strictly increasing arcs.
   */
  function tripExpected(trip, frame, routeId, pathIdx) {
    const arcMap = atlas.stopArcMap(routeId, pathIdx);
    if (!arcMap) return null;
    const dayStartS = frame.dayStartMs / 1000;
    const mapped = [];
    for (let j = 0; j < trip.stops.length; j++) {
      const arc = arcMap.get(trip.stops[j]);
      if (arc === undefined) continue;
      const t = dayStartS + (j === trip.stops.length - 1 ? trip.arr[j] : trip.dep[j]);
      mapped.push({ j, arc, t });
    }
    if (mapped.length < MATCH_GATES.minMappedStops) return null;
    for (let i = 1; i < mapped.length; i++) {
      if (!(mapped[i].arc > mapped[i - 1].arc)) return null;
    }
    const first = mapped[0], last = mapped[mapped.length - 1];
    return {
      mapped,
      /**
       * Expected arc + stop ordinal at an absolute second. The
       * ordinal is the last stop whose scheduled time has passed
       * (-1 before the first departure: the bus is at its
       * terminal, expected arc = the first stop's).
       */
      at(absS) {
        if (absS < first.t) return { arc: first.arc, ord: -1 };
        let m = 0;
        for (let i = 0; i < mapped.length; i++) if (mapped[i].t <= absS) m = i;
        if (m === mapped.length - 1) return { arc: last.arc, ord: m };
        const a = mapped[m], b = mapped[m + 1];
        const f = b.t > a.t ? (absS - a.t) / (b.t - a.t) : 0;
        return { arc: a.arc + (b.arc - a.arc) * f, ord: m };
      },
      /** Stop ordinal of an arc position on this trip. */
      ordinalOfArc(arc) {
        let ord = -1;
        for (let i = 0; i < mapped.length; i++) if (mapped[i].arc <= arc) ord = i;
        return ord;
      },
      /** Scheduled speed (m/s) of the segment bracketing an ordinal. */
      segmentSpeed(ord) {
        const i = Math.max(0, Math.min(mapped.length - 2, ord));
        const a = mapped[i], b = mapped[i + 1];
        if (!a || !b || b.t <= a.t || b.arc <= a.arc) return null;
        return (b.arc - a.arc) / (b.t - a.t);
      },
      averageSpeed() {
        const dt = last.t - first.t, da = last.arc - first.arc;
        return dt > 0 && da > 0 ? da / dt : null;
      },
    };
  }

  /** Evaluate one tracked vehicle against its candidates. */
  function evaluate(entry, frames, counters) {
    const fixS = entry.fixAtMs / 1000;
    const cands = candidateTrips(entry.routeId, entry.fixAtMs, frames);
    if (!cands.length) return { reason: "noCandidates" };
    let best = null, second = null;
    let sawExpected = false, sawGate = false;
    for (const cand of cands) {
      const exp = tripExpected(cand.trip, cand.frame, entry.routeId, entry.pathIdx);
      if (!exp) { counters.candidateRejections.expectedInvalid++; continue; }
      sawExpected = true;
      const expected = exp.at(fixS);
      const vehOrd = exp.ordinalOfArc(entry.fixArc);
      const gateDiff = vehOrd - expected.ord;
      if (gateDiff < MATCH_GATES.stopGateMin || gateDiff > MATCH_GATES.stopGateMax) {
        counters.candidateRejections[gateDiff > MATCH_GATES.stopGateMax ? "stopGateEarly" : "stopGateLate"]++;
        sawGate = true;
        continue;
      }
      const residual = expected.arc - entry.fixArc;
      const speed = exp.segmentSpeed(vehOrd) ?? exp.averageSpeed();
      if (!speed) { counters.candidateRejections.expectedInvalid++; continue; }
      const delaySec = residual / speed;
      const score = Math.abs(residual) - (headsignMatches(entry.destination, cand.trip.h) ? MATCH_GATES.headsignBonusM : 0);
      if (score >= MATCH_GATES.scoreMax) { counters.candidateRejections.score++; continue; }
      const rec = { trip: cand.trip, score, delaySec, residual };
      if (!best || score < best.score) { second = best; best = rec; }
      else if (!second || score < second.score) { second = rec; }
    }
    if (!best) {
      if (!sawExpected) return { reason: "expectedInvalid" };
      if (sawGate) return { reason: "stopGate" };
      return { reason: "score" };
    }
    if (second && second.trip !== best.trip && second.score - best.score <= MATCH_GATES.marginMin) {
      return { reason: "margin" };
    }
    return { best };
  }

  /**
   * Run one poll: tracker entries in, delay state + counters out.
   * `tracker` is the T4 tracker (entries carry the map-matched
   * fix); pollAtMs is the poll's own instant.
   */
  function matchPoll(tracker, pollAtMs) {
    const counters = freshCounters();
    counters.polls = 1;
    const frames = framesFor(new Date(pollAtMs));
    const proposals = [];

    for (const entry of tracker.entries()) {
      if (entry.agency !== "ddot") continue;
      counters.fixes++;
      if (entry.pollsSeen < MATCH_GATES.bornPolls) { counters.rejected.unborn++; continue; }
      if (entry.fixAtMs === null) { counters.rejected.fixStale++; continue; }
      const ageS = Math.max(0, (pollAtMs - entry.fixAtMs) / 1000);
      if (ageS > MATCH_GATES.fixMaxAgeS) { counters.rejected.fixStale++; continue; }
      if (entry.pathIdx === null || entry.fixArc === null || entry.offShapeM === null || entry.offShapeM > MATCH_GATES.offShapeMaxM) {
        counters.rejected.offShape++;
        continue;
      }
      counters.eligible++;
      const result = evaluate(entry, frames, counters);
      if (!result.best) { counters.rejected[result.reason]++; continue; }
      proposals.push({ entry, ...result.best });
    }

    // One vehicle per trip: the lowest score keeps the trip.
    const byTrip = new Map();
    for (const p of proposals) {
      const key = tripKey(p.trip);
      if (!byTrip.has(key)) byTrip.set(key, []);
      byTrip.get(key).push(p);
    }
    const matchedKeys = new Set();
    for (const [key, ps] of byTrip) {
      ps.sort((a, b) => a.score - b.score);
      const winner = ps[0];
      for (let i = 1; i < ps.length; i++) counters.rejected.shadowed++;
      const disrupted = winner.delaySec < MATCH_GATES.delayMinS || winner.delaySec > MATCH_GATES.delayMaxS;
      const prev = state.get(key);
      let delaySec = winner.delaySec;
      if (prev && prev.vehicleKey === winner.entry.key && !disrupted && !prev.disrupted) {
        delaySec = MATCH_GATES.emaAlpha * prev.delaySec + (1 - MATCH_GATES.emaAlpha) * winner.delaySec;
      }
      state.set(key, {
        trip: winner.trip, delaySec, disrupted,
        vehicleKey: winner.entry.key, vehicleId: winner.entry.vehicleId ?? null,
        fixStamp: winner.entry.fixAtMs, misses: 0,
      });
      matchedKeys.add(key);
      counters.matched++;
      if (disrupted) counters.disrupted++;
    }

    // Quiet polls age unmatched trips out (3 → revert to scheduled).
    for (const [key, st] of state) {
      if (matchedKeys.has(key)) continue;
      st.misses++;
      if (st.misses >= MATCH_GATES.quietPollsRevert) state.delete(key);
    }

    for (const k of Object.keys(counters.rejected)) cumulative.rejected[k] += counters.rejected[k];
    for (const k of Object.keys(counters.candidateRejections)) cumulative.candidateRejections[k] += counters.candidateRejections[k];
    cumulative.polls += 1; cumulative.fixes += counters.fixes;
    cumulative.eligible += counters.eligible; cumulative.matched += counters.matched;
    cumulative.disrupted += counters.disrupted;

    return { counters, matched: matchedKeys.size };
  }

  /** The engine hand-off: Map trip -> { delaySec, disrupted, vehicleId, fixStamp }. */
  function delayMap() {
    const out = new Map();
    for (const st of state.values()) {
      out.set(st.trip, {
        delaySec: st.delaySec, disrupted: st.disrupted,
        vehicleId: st.vehicleId, fixStamp: st.fixStamp ?? 0,
      });
    }
    return out;
  }

  return {
    matchPoll,
    delayMap,
    candidateTrips,
    tripExpected,
    framesFor,
    tripState: (trip) => state.get(tripKey(trip)) ?? null,
    stateSize: () => state.size,
    counters: () => cumulative,
  };
}
