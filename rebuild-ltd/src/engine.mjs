/**
 * LTD rebuild — journey engine (M9): RAPTOR over the bound timetable.
 *
 * Written from the specification (Tranche 0 parity inventory Area 6,
 * resolved-issues register §C/§D), consuming the T1 binding contract
 * (timetable.mjs): the engine never sees a raw timetable — it is
 * constructed over the object `bindTimetable` returns, and service
 * resolution goes through that binding's set resolver. Times are
 * seconds in the query day's frame: a trip belonging to the previous
 * service day runs into the frame only past midnight, mapped by the
 * −86400 frame shift; a trip belonging to neither day does not run.
 *
 * Carried fences (register):
 *   R-19  service-set resolution per (feed, date) — the engine asks
 *         the binding for the active SET and admits trips by set
 *         membership; it never collapses a feed to one service.
 *   R-20  live delays project downstream at DELAY_PROJECTION = 0.6.
 *   R-21  cumulative chained walking is capped per round at
 *         MAX_WALK_SECS = 1800; when footpath relaxation improves a
 *         stop's arrival, the stale bus-leg record for that stop is
 *         invalidated, so reconstruction traces the path that
 *         produced the best arrival.
 *   R-23  budgets: a caller may bound a plan (750 ms rider-initiated,
 *         250 ms background); exhaustion returns an explicit
 *         { reason: 'budget' } result — the host owns restoring the
 *         previous results (the engine keeps no presentation state).
 *   R-24  pairing guard: constructing an engine over anything that
 *         is not a set-resolving binding throws. A set-model
 *         timetable is never planned by subset.
 *   R-04  stop references inside the timetable are registry indices;
 *         the engine works in index space end to end and never
 *         translates — translation lives in the registry module.
 *
 * Live adjustment (Phase 2b-i semantics): the host matcher hands the
 * engine a per-trip delay map (setLiveDelays). A delay shifts the
 * trip's remaining times at DELAY_PROJECTION; a disrupted trip is
 * never shifted, only flagged on its legs. Delays apply only to
 * queries near the delay stamp (LIVE_FRESH_MS) — a delay measured
 * now says nothing about a trip planned for tonight. The empirical
 * (L2) baseline is an installed provider, consulted per trip; with
 * no provider installed the engine is a scheduled planner and no
 * leg is ever labeled 'empirical' (H-02's gate: the baseline ships
 * behind its calibration gate, not as a settled input).
 *
 * Entry points: plan (best arrival per transfer count, ≤3 journeys),
 * planMulti + criteriaFor (per-criterion winners over plan's set),
 * planRange (the departure strip), planArriveBy (the reverse
 * search). plan's search is the only forward search; the criteria
 * layer annotates copies and never mutates plan's results.
 */

export const K_ROUNDS = 3; // at most 3 bus legs => at most 2 transfers
export const MAX_WALK_SECS = 1800; // 30 min cumulative walk per round
export const DELAY_PROJECTION = 0.6; // R-20, as shipped with replay evidence
export const LIVE_FRESH_MS = 30 * 60 * 1000; // delays apply near-term only

const INF = 1e15;
const DAY_S = 86400;

/** 12-hour clock for a frame second (wraps into the day). */
export function formatClock(sec) {
  let s = Math.floor(sec) % DAY_S;
  if (s < 0) s += DAY_S;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

function ymdOf(date) {
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(date.getFullYear(), 4)}${p(date.getMonth() + 1, 2)}${p(date.getDate(), 2)}`;
}

function secondsOfDay(date) {
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

/**
 * Index a raw timetable for the searches: trips grouped into
 * patterns (same route, same stop sequence), patterns' trips sorted
 * by first departure, a stop → (pattern, position) map, and the
 * undirected walk adjacency from the transfer list. Trip objects are
 * kept by reference — the delay map and leg tripRefs key on them.
 */
export function indexTimetable(raw) {
  const patterns = [];
  const byKey = new Map();
  for (const trip of raw.trips) {
    const key = `${trip.r}|${trip.stops.join(",")}`;
    let pattern = byKey.get(key);
    if (!pattern) {
      pattern = { route: trip.r, stops: trip.stops, trips: [] };
      byKey.set(key, pattern);
      patterns.push(pattern);
    }
    pattern.trips.push(trip);
  }
  for (const pattern of patterns) {
    pattern.trips.sort((a, b) => a.dep[0] - b.dep[0]);
  }

  let stopCount = 0;
  const grow = (idx) => { if (idx + 1 > stopCount) stopCount = idx + 1; };
  for (const trip of raw.trips) for (const s of trip.stops) grow(s);
  for (const [a, b] of raw.transfers) { grow(a); grow(b); }

  const stopPatterns = new Array(stopCount);
  patterns.forEach((pattern, pi) => {
    pattern.stops.forEach((stop, pos) => {
      (stopPatterns[stop] ??= []).push([pi, pos]);
    });
  });

  const walkAdj = new Array(stopCount);
  const addEdge = (a, b, secs) => { (walkAdj[a] ??= []).push([b, secs]); };
  for (const [a, b, secs] of raw.transfers) { addEdge(a, b, secs); addEdge(b, a, secs); }

  // Service id -> services-array index, per feed (first record wins).
  const serviceIndex = new Map();
  raw.services.forEach((svc, i) => {
    const key = `${svc.feed ?? 0}|${svc.id}`;
    if (!serviceIndex.has(key)) serviceIndex.set(key, i);
  });
  const feeds = [...new Set(raw.services.map((s) => s.feed ?? 0))];

  return {
    raw,
    meta: raw.meta,
    routes: raw.routes,
    services: raw.services,
    patterns,
    stopPatterns,
    walkAdj,
    stopCount,
    serviceIndex,
    feeds,
  };
}

const BUDGET_HIT = Symbol("budget");

/**
 * Construct the engine over a bound timetable (the return value of
 * timetable.mjs `bindTimetable`). Anything else — a raw timetable, a
 * legacy binding without set resolution — throws (R-24).
 */
export function createEngine(bound) {
  if (!bound || typeof bound.servicesFor !== "function" || !bound.timetable) {
    throw new Error(
      "engine: pairing guard — the engine requires a set-resolving timetable " +
        "binding (bindTimetable); refusing to plan a service set by subset",
    );
  }
  const raw = bound.timetable;
  const index = indexTimetable(raw);

  let liveDelays = null; // Map trip -> { delaySec, disrupted, vehicleId?, fixStamp? }
  let liveStamp = 0;
  let baseline = null; // (trip) -> { dep: number[], arr: number[] } | null

  /* ---- service resolution ------------------------------------ */

  // The binding resolves the set by calendar mask + exceptions
  // (R-19); the engine additionally applies each service's validity
  // window, which the timetable artifact carries as start/end — a
  // service outside its window is not in the calendar set at all.
  function serviceSetFor(feed, ymd) {
    const out = new Set();
    for (const id of bound.servicesFor(feed, ymd)) {
      const i = index.serviceIndex.get(`${feed}|${id}`);
      if (i === undefined) continue;
      const svc = raw.services[i];
      if (ymd >= svc.start && ymd <= svc.end) out.add(i);
    }
    return out;
  }

  // Both frames a query touches: the query day's sets and the
  // previous day's (whose post-midnight tails run into the frame).
  function dayFrames(when) {
    const prev = new Date(when.getTime() - DAY_S * 1000);
    const today = new Map(), yesterday = new Map();
    let any = false;
    for (const feed of index.feeds) {
      const t = serviceSetFor(feed, ymdOf(when));
      const y = serviceSetFor(feed, ymdOf(prev));
      today.set(feed, t);
      yesterday.set(feed, y);
      if (t.size || y.size) any = true;
    }
    return { today, yesterday, any };
  }

  // 0 = runs on the query day's service; -DAY_S = previous day's
  // service, tail only; null = does not run in this frame.
  function frameShift(trip, frames) {
    const svc = raw.services[trip.s];
    const feed = svc ? (svc.feed ?? 0) : 0;
    if (frames.today.get(feed)?.has(trip.s)) return 0;
    if (frames.yesterday.get(feed)?.has(trip.s)) return -DAY_S;
    return null;
  }

  function metaService(frames) {
    for (const feed of [0, ...index.feeds]) {
      const set = frames.today.get(feed);
      if (set && set.size) {
        let first = Infinity;
        for (const i of set) if (i < first) first = i;
        return raw.services[first].id;
      }
    }
    return null;
  }

  /* ---- adjusted times ----------------------------------------- */

  function liveContext(when) {
    if (!liveDelays || !liveStamp) return null;
    if (Math.abs(when.getTime() - liveStamp) >= LIVE_FRESH_MS) return null;
    return { delays: liveDelays, stamp: liveStamp };
  }

  function baselineFor(trip) {
    return baseline ? baseline(trip) : null;
  }

  function depAt(trip, pos, ctx) {
    const l2 = baselineFor(trip);
    let t = l2 ? l2.dep[pos] : trip.dep[pos];
    if (ctx) {
      const ld = ctx.delays.get(trip);
      if (ld && !ld.disrupted && ld.delaySec) t += ld.delaySec * DELAY_PROJECTION;
    }
    return t;
  }

  function arrAt(trip, pos, ctx) {
    const l2 = baselineFor(trip);
    let t = l2 ? l2.arr[pos] : trip.arr[pos];
    if (ctx) {
      const ld = ctx.delays.get(trip);
      if (ld && !ld.disrupted && ld.delaySec) t += ld.delaySec * DELAY_PROJECTION;
    }
    return t;
  }

  /* ---- walking ------------------------------------------------- */

  // Footpath relaxation (forward): propagate arrival times over the
  // walk graph from the seed stops, each stop's cumulative walk this
  // round capped at MAX_WALK_SECS. walkFrom records the winning
  // predecessor; walkCum the winning cumulative walk. Returns the
  // stops whose arrival improved, in improvement order.
  function relaxWalk(arr, walkFrom, walkCum, seeds) {
    const improved = new Set();
    const queue = [...seeds];
    const inQueue = new Set(seeds);
    for (let head = 0; head < queue.length; head++) {
      tick();
      const s = queue[head];
      inQueue.delete(s);
      if (walkCum[s] >= MAX_WALK_SECS) continue;
      const edges = index.walkAdj[s];
      if (!edges) continue;
      for (const [t, w] of edges) {
        const nw = walkCum[s] + w;
        if (nw > MAX_WALK_SECS) continue;
        const na = arr[s] + w;
        if (na < arr[t]) {
          arr[t] = na;
          walkFrom[t] = s;
          walkCum[t] = nw;
          improved.add(t);
          if (!inQueue.has(t)) { queue.push(t); inQueue.add(t); }
        }
      }
    }
    return improved;
  }

  // The same relaxation mirrored for the reverse search: labels are
  // latest-at-stop times and propagate away from the destination,
  // each edge subtracting its walk seconds.
  function relaxWalkReverse(latest, rec, walkCum, seeds, round) {
    const improved = new Set();
    const queue = [...seeds];
    const inQueue = new Set(seeds);
    for (let head = 0; head < queue.length; head++) {
      tick();
      const s = queue[head];
      inQueue.delete(s);
      if (walkCum[s] >= MAX_WALK_SECS) continue;
      const edges = index.walkAdj[s];
      if (!edges) continue;
      for (const [t, w] of edges) {
        const nw = walkCum[s] + w;
        if (nw > MAX_WALK_SECS) continue;
        const nl = latest[s] - w;
        if (nl > latest[t]) {
          latest[t] = nl;
          rec[t] = { kind: "walk", next: s, round };
          walkCum[t] = nw;
          improved.add(t);
          if (!inQueue.has(t)) { queue.push(t); inQueue.add(t); }
        }
      }
    }
    return improved;
  }

  function walkSecsBetween(a, b) {
    for (const [t, w] of index.walkAdj[a] ?? []) if (t === b) return w;
    return null;
  }

  /* ---- budget --------------------------------------------------- */

  let deadline = 0;
  let tickCount = 0;
  function tick() {
    if (deadline && (++tickCount & 511) === 0 && performance.now() > deadline) {
      throw BUDGET_HIT;
    }
  }
  function roundCheck() {
    if (deadline && performance.now() > deadline) throw BUDGET_HIT;
  }
  function withBudget(opts, when, run) {
    deadline = opts && opts.budgetMs ? performance.now() + opts.budgetMs : 0;
    tickCount = 0;
    try {
      return run();
    } catch (e) {
      if (e === BUDGET_HIT) return { journeys: [], meta: { reason: "budget", when } };
      throw e;
    } finally {
      deadline = 0;
    }
  }

  /* ---- shared helpers ------------------------------------------- */

  function normalizeSeeds(fromSeeds) {
    const list = Array.isArray(fromSeeds) ? fromSeeds : [{ stop: fromSeeds, walk: 0 }];
    return list.filter((fs) => fs && fs.stop >= 0 && fs.stop < index.stopCount);
  }

  function seedWalkMap(seeds) {
    const map = new Map();
    for (const fs of seeds) {
      const w = fs.walk || 0;
      if (!map.has(fs.stop) || w < map.get(fs.stop)) map.set(fs.stop, w);
    }
    return map;
  }

  function isSameStopQuery(seeds, toIdx) {
    return seeds.some((fs) => fs.stop === toIdx && !(fs.walk > 0));
  }

  function busLeg(trip, board, alight, boardPos, alightPos, shift, ctx) {
    const route = index.routes[trip.r];
    const ld = ctx ? ctx.delays.get(trip) : null;
    const live = !!(ld && !ld.disrupted);
    const l2 = baselineFor(trip);
    let boardSec = l2 ? l2.dep[boardPos] : trip.dep[boardPos];
    let alightSec = l2 ? l2.arr[alightPos] : trip.arr[alightPos];
    if (live && ld.delaySec) {
      boardSec += ld.delaySec * DELAY_PROJECTION;
      alightSec += ld.delaySec * DELAY_PROJECTION;
    }
    if (shift) { boardSec += shift; alightSec += shift; }
    return {
      type: "bus",
      routeId: route.id,
      routeName: route.name,
      color: route.color,
      agency: route.ag ?? null,
      board,
      alight,
      boardSec,
      alightSec,
      headsign: trip.h || "",
      interp: trip.interp.indexOf(boardPos) >= 0 || trip.interp.indexOf(alightPos) >= 0,
      provenance: live ? "live" : l2 ? "empirical" : "scheduled",
      delaySec: live ? ld.delaySec : 0,
      delayStamp: live ? ctx.stamp : 0,
      delayFixStamp: live ? (ld.fixStamp || 0) : 0,
      disrupted: !!(ld && ld.disrupted),
      tripRef: trip,
    };
  }

  function summarize(legs, departSec, arriveSec) {
    const busLegs = legs.filter((l) => l.type === "bus");
    const walkTotal = legs.reduce((s, l) => s + (l.type === "walk" ? l.secs : 0), 0);
    return {
      legs,
      nBus: busLegs.length,
      departSec,
      arriveSec,
      durationMin: Math.max(1, Math.round((arriveSec - departSec) / 60)),
      transfers: Math.max(0, busLegs.length - 1),
      walkMin: Math.round(walkTotal / 60),
      hasInterp: busLegs.some((l) => l.interp),
      departClock: formatClock(departSec),
      arriveClock: formatClock(arriveSec),
    };
  }

  /* ---- forward search ------------------------------------------- */

  function buildJourney(rounds, k, target, seedWalk, ctx) {
    const legs = [];
    let cur = target;
    let kk = k;
    let guard = 0;
    while (!seedWalk.has(cur) && guard++ < 200) {
      const round = rounds[kk];
      const rec = round ? round.boardRec[cur] : null;
      if (rec) {
        legs.unshift(busLeg(rec.trip, rec.boardStop, cur, rec.boardPos, rec.alightPos, rec.shift, ctx));
        cur = rec.boardStop;
        kk--;
        if (kk < 0) return null;
        continue;
      }
      const w = round ? round.walkFrom[cur] : null;
      if (w !== null && w !== undefined) {
        legs.unshift({ type: "walk", from: w, to: cur, secs: walkSecsBetween(w, cur) || 0 });
        cur = w;
        continue;
      }
      if (kk > 0) { kk--; continue; }
      return null;
    }
    if (guard >= 200) return null;
    const seedSecs = seedWalk.get(cur);
    if (seedSecs !== undefined && seedSecs > 0) {
      legs.unshift({ type: "walk", from: -1, to: cur, secs: seedSecs, fromLoc: true });
    }
    return legs;
  }

  function planImpl(fromSeeds, toIdx, when) {
    const seeds = normalizeSeeds(fromSeeds);
    const frames = dayFrames(when);
    if (!frames.any) return { journeys: [], meta: { reason: "no-service", when } };
    if (!seeds.length) return { journeys: [], meta: { reason: "no-origin", when } };
    if (isSameStopQuery(seeds, toIdx)) {
      return { journeys: [], meta: { reason: "same-stop", when } };
    }
    const seedWalk = seedWalkMap(seeds);
    const nowSec = secondsOfDay(when);
    const ctx = liveContext(when);
    const n = index.stopCount;

    // Round 0: origin seeds + walking.
    const arr0 = new Float64Array(n).fill(INF);
    const walkFrom0 = new Array(n).fill(null);
    const walkCum0 = new Float64Array(n).fill(INF);
    for (const fs of seeds) {
      const t = nowSec + (fs.walk || 0);
      if (t < arr0[fs.stop]) arr0[fs.stop] = t;
      if ((fs.walk || 0) < walkCum0[fs.stop]) walkCum0[fs.stop] = fs.walk || 0;
    }
    const seedStops = seeds.map((fs) => fs.stop);
    const improved0 = relaxWalk(arr0, walkFrom0, walkCum0, seedStops);
    for (const s of seedStops) improved0.add(s);
    const rounds = [{ arr: arr0, boardRec: new Array(n).fill(null), walkFrom: walkFrom0 }];
    let marked = improved0;

    for (let k = 1; k <= K_ROUNDS; k++) {
      roundCheck();
      const prevArr = rounds[k - 1].arr;
      const arr = Float64Array.from(prevArr);
      const boardRec = new Array(n).fill(null);
      const walkFrom = new Array(n).fill(null);
      const improved = new Set();
      for (const p of marked) {
        const sps = index.stopPatterns[p];
        if (!sps) continue;
        for (const [pi, pos] of sps) {
          const pattern = index.patterns[pi];
          for (const trip of pattern.trips) {
            tick();
            const shift = frameShift(trip, frames);
            if (shift === null) continue;
            if (depAt(trip, pos, ctx) + shift < prevArr[p]) continue; // cannot catch
            const feed = raw.services[trip.s]?.feed ?? 0;
            for (let j = pos + 1; j < pattern.stops.length; j++) {
              tick();
              const s = pattern.stops[j];
              const a = arrAt(trip, j, ctx) + shift;
              if (a < arr[s]) {
                arr[s] = a;
                boardRec[s] = { trip, boardStop: p, boardPos: pos, alightPos: j, shift };
                improved.add(s);
              } else if (
                a === arr[s] && boardRec[s] && boardRec[s].trip === trip && feed !== 0 &&
                prevArr[p] < prevArr[boardRec[s].boardStop]
              ) {
                // Same bus, same arrival, but this boarding point was
                // reached with less travel: keep the earlier boarding.
                // Scoped to non-DDOT feeds — DDOT reconstruction is
                // frozen (the Phase B control pins its tie behavior).
                boardRec[s] = { trip, boardStop: p, boardPos: pos, alightPos: j, shift };
              }
            }
          }
        }
      }
      const walkCum = new Float64Array(n).fill(INF);
      for (const s of improved) walkCum[s] = 0;
      const walkImproved = relaxWalk(arr, walkFrom, walkCum, [...improved]);
      for (const s of walkImproved) {
        // A stop reached faster on foot was not reached by bus: drop
        // the stale bus leg so reconstruction follows the walk (R-21).
        improved.add(s);
        boardRec[s] = null;
      }
      rounds[k] = { arr, boardRec, walkFrom };
      marked = improved;
    }

    // Reconstruct: best arrival per transfer count, up to 3 journeys.
    const journeys = [];
    const seen = new Set();
    for (let k = 1; k <= K_ROUNDS; k++) {
      const arrive = rounds[k].arr[toIdx];
      if (arrive >= INF / 2) continue;
      const legs = buildJourney(rounds, k, toIdx, seedWalk, ctx);
      if (!legs || !legs.length) continue;
      const nBus = legs.reduce((c, l) => c + (l.type === "bus" ? 1 : 0), 0);
      const key = `${Math.round(arrive)}|${nBus}`;
      if (seen.has(key)) continue;
      seen.add(key);
      journeys.push(summarize(legs, nowSec, arrive));
      if (journeys.length >= 3) break;
    }
    return {
      journeys,
      meta: {
        when,
        service: metaService(frames),
        feedVersion: index.meta.feed_version,
        nowSec,
      },
    };
  }

  function plan(fromSeeds, toIdx, when, opts) {
    return withBudget(opts, when, () => planImpl(fromSeeds, toIdx, when));
  }

  /* ---- criteria layer (over plan's set; plan is not modified) --- */

  function walkSecondsOf(journey) {
    return journey.legs.reduce((s, l) => s + (l.type === "walk" ? l.secs : 0), 0);
  }

  const CRITERIA_ORDER = ["earliest", "fewestTransfers", "leastWalking"];
  const CRITERIA_KEYS = {
    earliest: ["arriveSec", "transfers", "walkSec"],
    fewestTransfers: ["transfers", "arriveSec", "walkSec"],
    leastWalking: ["walkSec", "arriveSec", "transfers"],
  };

  function criteriaFor(journeys) {
    const enriched = journeys.map((j, i) => ({
      index: i,
      arriveSec: j.arriveSec,
      arriveClock: j.arriveClock,
      transfers: j.transfers,
      walkSec: walkSecondsOf(j),
      walkMin: j.walkMin,
    }));
    const winners = { earliest: null, fewestTransfers: null, leastWalking: null };
    for (const crit of CRITERIA_ORDER) {
      const keys = CRITERIA_KEYS[crit];
      let best = null;
      for (const e of enriched) {
        if (!best) { best = e; continue; }
        for (const key of keys) {
          if (e[key] < best[key]) { best = e; break; }
          if (e[key] > best[key]) break;
        }
      }
      winners[crit] = best;
    }
    return winners;
  }

  function planMulti(fromSeeds, toIdx, when, opts) {
    const res = plan(fromSeeds, toIdx, when, opts);
    const winners = criteriaFor(res.journeys);
    const labels = res.journeys.map(() => []);
    for (const crit of CRITERIA_ORDER) {
      if (winners[crit]) labels[winners[crit].index].push(crit);
    }
    const annotated = res.journeys.map((j, i) => ({
      ...j,
      walkSec: walkSecondsOf(j),
      criteria: labels[i],
    }));
    const winnerIdx = new Set(
      CRITERIA_ORDER.map((c) => winners[c] && winners[c].index).filter((i) => i !== false && i !== null),
    );
    const head = [];
    const tail = [];
    annotated.forEach((j, i) => (winnerIdx.has(i) ? head : tail).push(j));
    // Winners lead in criterion order; the rest follow by earliest.
    const orderedHead = [];
    for (const crit of CRITERIA_ORDER) {
      const w = winners[crit];
      if (w && !orderedHead.includes(annotated[w.index])) orderedHead.push(annotated[w.index]);
    }
    tail.sort((a, b) =>
      (a.arriveSec - b.arriveSec) || (a.transfers - b.transfers) || (a.walkSec - b.walkSec));
    return { journeys: annotated, stack: [...orderedHead, ...tail], criteria: winners, meta: res.meta };
  }

  /* ---- arrive-by: the reverse search ---------------------------- */

  function arriveBySearch(toIdx, maxRounds, frames, ctx, targetSec) {
    const n = index.stopCount;
    const NEG = -INF;
    const latest = new Float64Array(n).fill(NEG);
    const rec = new Array(n).fill(null);
    latest[toIdx] = targetSec;
    rec[toIdx] = { kind: "dest", round: 0 };
    const walkCum0 = new Float64Array(n).fill(INF);
    walkCum0[toIdx] = 0;
    // The destination leads the marked set: candidate ties at a
    // boarding stop keep the first record written, and a direct
    // alighting at the destination must win its tie against a
    // walk-tail alighting one stop earlier.
    let marked = new Set([toIdx]);
    for (const s of relaxWalkReverse(latest, rec, walkCum0, [toIdx], 0)) marked.add(s);

    for (let k = 1; k <= maxRounds; k++) {
      roundCheck();
      const candidates = new Map();
      for (const p of marked) {
        if (latest[p] <= NEG / 2) continue;
        const sps = index.stopPatterns[p];
        if (!sps) continue;
        for (const [pi, pos] of sps) {
          const pattern = index.patterns[pi];
          for (const trip of pattern.trips) {
            tick();
            const shift = frameShift(trip, frames);
            if (shift === null) continue;
            const arrAtP = arrAt(trip, pos, ctx) + shift;
            if (arrAtP > latest[p]) continue; // arrives too late at p
            for (let j = pos - 1; j >= 0; j--) {
              const b = depAt(trip, j, ctx) + shift;
              if (b < 0) continue; // boarding maps before the frame
              const bs = pattern.stops[j];
              if (b <= latest[bs]) continue; // cannot improve the label
              const ex = candidates.get(bs);
              if (!ex || b > ex.boardSec) {
                candidates.set(bs, {
                  kind: "bus", trip, boardPos: j, alightPos: pos,
                  alight: p, shift, boardSec: b, alightSec: arrAtP, round: k,
                });
              }
            }
          }
        }
      }
      const busImproved = new Set();
      for (const [s, r] of candidates) {
        if (r.boardSec > latest[s]) {
          latest[s] = r.boardSec;
          rec[s] = r;
          busImproved.add(s);
        }
      }
      const walkCum = new Float64Array(n).fill(INF);
      for (const s of busImproved) walkCum[s] = 0;
      const walkImproved = relaxWalkReverse(latest, rec, walkCum, [...busImproved], k);
      const improved = new Set([...busImproved, ...walkImproved]);
      marked = improved;
      if (!improved.size) break;
    }
    return { latest, rec };
  }

  function buildJourneyReverse(seedStop, rec, seedWalk, ctx) {
    const legs = [];
    let cur = seedStop;
    let guard = 0;
    while (guard++ < 200) {
      const r = rec[cur];
      if (!r) return null;
      if (r.kind === "dest") break;
      if (r.kind === "walk") {
        legs.push({ type: "walk", from: cur, to: r.next, secs: walkSecsBetween(cur, r.next) || 0 });
        cur = r.next;
        continue;
      }
      legs.push(busLeg(r.trip, cur, r.alight, r.boardPos, r.alightPos, r.shift, ctx));
      // The stored record's times are the search's own; keep them
      // authoritative over a recomputation.
      const leg = legs[legs.length - 1];
      leg.boardSec = r.boardSec;
      leg.alightSec = r.alightSec;
      cur = r.alight;
    }
    if (guard >= 200) return null;
    const seedSecs = seedWalk.get(seedStop);
    if (seedSecs !== undefined && seedSecs > 0) {
      legs.unshift({ type: "walk", from: -1, to: seedStop, secs: seedSecs, fromLoc: true });
    }
    return legs;
  }

  function summarizeReverse(legs, leaveSec) {
    let clock = leaveSec;
    let busLegs = 0;
    let walkTotal = 0;
    let interp = false;
    for (const l of legs) {
      if (l.type === "walk") { clock += l.secs; walkTotal += l.secs; }
      else { busLegs++; if (l.interp) interp = true; clock = l.alightSec; }
    }
    return {
      legs,
      nBus: busLegs,
      departSec: leaveSec,
      arriveSec: clock,
      durationMin: Math.max(1, Math.round((clock - leaveSec) / 60)),
      transfers: Math.max(0, busLegs - 1),
      walkMin: Math.round(walkTotal / 60),
      hasInterp: interp,
      departClock: formatClock(leaveSec),
      arriveClock: formatClock(clock),
    };
  }

  function arriveByImpl(fromSeeds, toIdx, arriveBy) {
    const seeds = normalizeSeeds(fromSeeds);
    const frames = dayFrames(arriveBy);
    if (!frames.any) return { journeys: [], meta: { reason: "no-service", when: arriveBy } };
    if (!seeds.length) return { journeys: [], meta: { reason: "no-origin", when: arriveBy } };
    if (isSameStopQuery(seeds, toIdx)) {
      return { journeys: [], meta: { reason: "same-stop", when: arriveBy } };
    }
    const seedWalk = seedWalkMap(seeds);
    const targetSec = secondsOfDay(arriveBy);
    const ctx = liveContext(arriveBy);
    const bySig = new Map();
    for (let cap = 1; cap <= K_ROUNDS; cap++) {
      const { latest, rec } = arriveBySearch(toIdx, cap, frames, ctx, targetSec);
      let best = null;
      for (const fs of seeds) {
        const s = fs.stop;
        if (latest[s] <= -INF / 2) continue;
        const legs = buildJourneyReverse(s, rec, seedWalk, ctx);
        if (!legs) continue;
        const j = summarizeReverse(legs, latest[s] - (seedWalk.get(s) || 0));
        if (j.arriveSec > targetSec + 0.001) continue; // construction guard
        if (!best || j.departSec > best.departSec ||
            (j.departSec === best.departSec &&
             (j.transfers < best.transfers ||
              (j.transfers === best.transfers && j.arriveSec < best.arriveSec)))) {
          best = j;
        }
      }
      if (best) {
        const sig = best.legs.map((l) => l.type === "bus"
          ? `B${l.routeId}@${l.boardSec}>${l.alightSec}`
          : `W${l.from}>${l.to}`).join("|") + `@${best.departSec}`;
        if (!bySig.has(sig)) bySig.set(sig, best);
      }
    }
    const journeys = [...bySig.values()];
    journeys.sort((a, b) =>
      (b.departSec - a.departSec) || (a.transfers - b.transfers) || (a.arriveSec - b.arriveSec));
    const meta = {
      when: arriveBy, mode: "arrive-by", targetSec,
      service: metaService(frames), feedVersion: index.meta.feed_version, nowSec: targetSec,
    };
    if (!journeys.length) {
      meta.reason = "no-journey";
      return { journeys: [], meta };
    }
    return { journeys, meta };
  }

  function planArriveBy(fromSeeds, toIdx, arriveBy, opts) {
    return withBudget(opts, arriveBy, () => arriveByImpl(fromSeeds, toIdx, arriveBy));
  }

  /* ---- range: the departure strip ------------------------------- */

  function walkReachableStops(seeds) {
    const best = new Map();
    const queue = [];
    for (const fs of seeds) {
      const w = fs.walk || 0;
      if (!best.has(fs.stop) || w < best.get(fs.stop)) best.set(fs.stop, w);
      queue.push(fs.stop);
    }
    for (let head = 0; head < queue.length; head++) {
      const s = queue[head];
      const acc = best.get(s);
      if (acc >= MAX_WALK_SECS) continue;
      for (const [t, w] of index.walkAdj[s] ?? []) {
        const nw = acc + w;
        if (nw > MAX_WALK_SECS) continue;
        if (!best.has(t) || nw < best.get(t)) { best.set(t, nw); queue.push(t); }
      }
    }
    return best;
  }

  // The earliest adjusted departure after `after` (and no later than
  // `end`) out of the walk-reachable stops, across the service frames
  // of every day the window touches — or null.
  function nextDepartureAfter(reach, after, end) {
    let best = null;
    const firstDay = new Date(after.getFullYear(), after.getMonth(), after.getDate());
    for (let dOff = 0; dOff <= 4; dOff++) {
      const day = new Date(firstDay.getTime() + dOff * DAY_S * 1000);
      if (day.getTime() > end.getTime() && best !== null) break;
      if (day.getTime() > end.getTime() + DAY_S * 1000) break;
      const frames = dayFrames(day);
      if (!frames.any) continue;
      const ctx = liveContext(day);
      const mid = day.getTime();
      for (const s of reach.keys()) {
        const sps = index.stopPatterns[s];
        if (!sps) continue;
        for (const [pi, pos] of sps) {
          for (const trip of index.patterns[pi].trips) {
            const shift = frameShift(trip, frames);
            if (shift === null) continue;
            const depAbs = mid + (depAt(trip, pos, ctx) + shift) * 1000;
            if (depAbs > after.getTime() && depAbs <= end.getTime() &&
                (best === null || depAbs < best)) {
              best = depAbs;
            }
          }
        }
      }
    }
    return best === null ? null : new Date(best);
  }

  function firstBoardOf(journey) {
    let walkBefore = 0;
    for (const l of journey.legs) {
      if (l.type === "walk") { walkBefore += l.secs; continue; }
      return { boardSec: l.boardSec, walkBefore };
    }
    return null;
  }

  function planRange(fromSeeds, toIdx, startWhen, endWhen, opts = {}) {
    const maxCalls = opts.maxCalls || 240;
    const maxEntries = opts.maxEntries || 48;
    const seeds = normalizeSeeds(fromSeeds);
    const reach = walkReachableStops(seeds);
    const departures = [];
    const seenSig = new Set();
    let t = new Date(startWhen.getTime());
    let calls = 0;
    let truncated = false;
    while (t.getTime() <= endWhen.getTime()) {
      if (calls >= maxCalls || departures.length >= maxEntries) { truncated = true; break; }
      const res = plan(seeds, toIdx, t, opts.budgetMs ? { budgetMs: opts.budgetMs } : undefined);
      calls++;
      const frameMid = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
      const endMs = endWhen.getTime();
      let minBoardAll = Infinity;
      for (const j of res.journeys || []) {
        const fb = firstBoardOf(j);
        if (!fb) continue;
        if (fb.boardSec < minBoardAll) minBoardAll = fb.boardSec;
        const boardMs = frameMid + fb.boardSec * 1000;
        if (boardMs > endMs) continue; // boards after the window closes
        const leaveSec = fb.boardSec - fb.walkBefore;
        const sig = j.legs.map((l) => l.type === "bus"
          ? `B${l.routeId}@${l.boardSec}>${l.alightSec}`
          : `W${l.from}>${l.to}`).join("|");
        if (seenSig.has(sig)) continue;
        seenSig.add(sig);
        departures.push({
          leaveSec, boardSec: fb.boardSec, arriveSec: j.arriveSec,
          leaveMs: frameMid + leaveSec * 1000,
          boardMs,
          arriveMs: frameMid + j.arriveSec * 1000,
          transfers: j.transfers, walkMin: j.walkMin, journey: j,
        });
      }
      if (minBoardAll < Infinity) {
        departures.sort((a, b) => a.boardMs - b.boardMs);
        const nt = new Date(frameMid + (minBoardAll + 1) * 1000);
        if (nt.getTime() <= t.getTime()) break; // safety: always advance
        t = nt;
      } else {
        const nd = nextDepartureAfter(reach, t, endWhen);
        if (!nd || nd.getTime() <= t.getTime()) break;
        t = nd;
      }
    }
    departures.sort((a, b) => a.boardMs - b.boardMs);
    return {
      departures,
      meta: {
        mode: "range", start: startWhen, end: endWhen,
        calls, truncated, feedVersion: index.meta.feed_version,
      },
    };
  }

  /* ---- live state (host hand-offs) ------------------------------ */

  return {
    index,
    bound,
    plan,
    planMulti,
    planRange,
    planArriveBy,
    criteriaFor,
    /** The host matcher's hand-off: per-trip measured delays. */
    setLiveDelays(delayMap, stampMs) {
      liveDelays = delayMap;
      liveStamp = stampMs;
    },
    clearLiveDelays() {
      liveDelays = null;
      liveStamp = 0;
    },
    /**
     * Install the empirical-baseline provider (H-02 gate): a
     * function from trip to its baseline { dep, arr } arrays, or
     * null. The engine ships with none installed.
     */
    setBaselineProvider(fn) {
      baseline = fn || null;
    },
    /** The binding's set resolver, exposed for host surfaces. */
    servicesFor: (feed, ymd) => bound.servicesFor(feed, ymd),
  };
}

/**
 * The "leave by" reading of a range strip: among the entries
 * arriving by the given absolute instant, the one that leaves latest.
 */
export function stripLatestFor(departures, arriveByMs) {
  let best = null;
  for (const d of departures) {
    if (d.arriveMs <= arriveByMs && (!best || d.leaveMs > best.leaveMs)) best = d;
  }
  return best;
}
