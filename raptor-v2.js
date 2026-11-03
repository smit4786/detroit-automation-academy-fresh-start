/* raptor.js — client-side RAPTOR trip planner for Live Transit.
 *
 * SET-RESOLUTION COPY (Board 47 item 7, implementation tranche 1,
 * 2026-10-22): a working copy of the served production engine
 * (inputs/raptor-v2.js, MD5 b325eb67b8a8839b52d243c76ac54262) with
 * service resolution generalized per
 * engine-generalization-design-2026-10-22.md section 1: servicesFor()
 * returns the active service SET for (feed, date) — (calendar set
 * minus removals) union additions — plan()/planRange()/planArriveBy()
 * admit trips by set membership, and serviceFor() is retained as the
 * first-element compatibility shim for its three-argument callers.
 * Every other line is the served engine's, byte for byte. LOCAL ONLY:
 * this copy is never deployed.
 *
 * Data: planner-timetable-<ddot>-<smart>.json — the DDOT timetable
 * (built by build-timetable.py from DDOT GTFS) merged with SMART
 * scheduled service built from SMART's own published GTFS (U7 Phase B,
 * 2026-10-20; provenance in the asset's meta.feeds). Lazily imported
 * only when the rider opens trip planning; the map's first load is
 * untouched. Services carry a feed tag (0 = DDOT, 1 = SMART) and the
 * service resolution below is per-feed: a single-feed timetable (the
 * DDOT-only asset the Departure Board loads) resolves exactly as it
 * did before the merge — every service is feed 0 there.
 *
 * Honesty: Phase 1 runs on scheduled times only. Phase 2b-i adds the live
 * adjusted timetable: per poll, matched vehicles produce per-trip delays
 * (setLiveDelays); plan() reads times through depA/arrA, which apply the
 * L2 empirical baseline (when mature) and the L3 live delay shift. Legs
 * carry provenance 'live'/'empirical'/'scheduled' plus delay metadata.
 * No live feed → scheduled planner, exactly as Phase 1. RAPTOR itself
 * (the rounds) is unchanged; it just sees adjusted times.
 */
var TT = null;
var K_ROUNDS = 3; // max trips per journey => at most 2 transfers
var INF = 1e15;
var LIVE_FRESH_MS = 30 * 60 * 1000; // live delays only apply to near-term queries
// Rank 5 (project 4): downstream projection factor — the measured delay
// is projected onto downstream stop times at 0.6 persistence (buses
// recover time downstream; flat projection carried a -49/-56 s fused
// median bias on the two replay days). Same constant as live-transit.js
// DELAY_PROJECTION; the stored delaySec stays the measured value.
// Record: files/compute-accuracy/rank5-delivery-note-2026-10-18.md.
var DELAY_PROJECTION = 0.6;

export async function loadTimetable(url) {
  if (TT && TT.url === url) return TT;
  var res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('timetable fetch failed: HTTP ' + res.status);
  var data = await res.json();
  TT = buildIndex(data);
  TT.url = url;
  TT.meta = data.meta;
  return TT;
}

function buildIndex(data) {
  var patterns = [];
  var pkey = new Map();
  var trips = data.trips;
  for (var ti = 0; ti < trips.length; ti++) {
    var t = trips[ti];
    var key = t.r + '|' + t.stops.join(',');
    var pi = pkey.get(key);
    if (pi === undefined) {
      pi = patterns.length;
      pkey.set(key, pi);
      patterns.push({ route: t.r, stops: t.stops, trips: [] });
    }
    patterns[pi].trips.push(t);
  }
  for (var p = 0; p < patterns.length; p++) {
    patterns[p].trips.sort(function (a, b) { return a.dep[0] - b.dep[0]; });
  }
  var nStops = 0, i, s;
  for (i = 0; i < trips.length; i++) {
    var st = trips[i].stops;
    for (var j = 0; j < st.length; j++) if (st[j] + 1 > nStops) nStops = st[j] + 1;
  }
  for (i = 0; i < data.transfers.length; i++) {
    var tr = data.transfers[i];
    if (tr[0] + 1 > nStops) nStops = tr[0] + 1;
    if (tr[1] + 1 > nStops) nStops = tr[1] + 1;
  }
  var stopPat = new Array(nStops);
  patterns.forEach(function (pat, pi) {
    for (var pos = 0; pos < pat.stops.length; pos++) {
      s = pat.stops[pos];
      (stopPat[s] || (stopPat[s] = [])).push([pi, pos]);
    }
  });
  var adj = new Array(nStops);
  for (i = 0; i < data.transfers.length; i++) {
    var a = data.transfers[i][0], b = data.transfers[i][1], w = data.transfers[i][2];
    (adj[a] || (adj[a] = [])).push([b, w]);
    (adj[b] || (adj[b] = [])).push([a, w]);
  }
  return {
    meta: data.meta, routes: data.routes, services: data.services,
    exceptions: data.service_exceptions || [],
    patterns: patterns, stopPat: stopPat, adj: adj, nStops: nStops
  };
}

function fmtYMD(d) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate() + '';
}

function servicesFor(tt, ymd, dow, feed) {
  var mi = (dow + 6) % 7; // mask is Mon..Sun
  // Per-feed resolution: services carry a feed tag (0 = DDOT,
  // 1 = SMART); an untagged service is feed 0. The default feed is 0,
  // matching serviceFor's legacy default.
  var effFeed = (feed === undefined || feed === null) ? 0 : feed;
  function feedOf(s) { return s.feed || 0; }
  // The calendar set: every service of this feed whose window covers
  // the date and whose mask matches the day. Unlike the legacy
  // resolver there is no single winner — concurrent services are the
  // normal case on multi-service feeds (SEPTA runs 7-27 per date).
  var set = new Set(), i;
  for (i = 0; i < tt.services.length; i++) {
    var s = tt.services[i];
    if (feedOf(s) !== effFeed) continue;
    if (ymd >= s.start && ymd <= s.end && s.mask[mi]) set.add(i);
  }
  // GTFS calendar_dates exceptions, applied to the set as published:
  // added: 1 joins the set, added: 2 leaves it — (calendar set minus
  // removals) union additions, the GTFS-true reading. The exception's
  // service is matched by id within this feed, as in the legacy code.
  // The value is tested, never truthiness (2 is truthy).
  for (i = 0; i < tt.exceptions.length; i++) {
    var e = tt.exceptions[i];
    if (e.date !== ymd) continue;
    var si = -1;
    for (var j = 0; j < tt.services.length; j++) {
      if (tt.services[j].id === e.service && feedOf(tt.services[j]) === effFeed) { si = j; break; }
    }
    if (si < 0) continue;
    if (e.added === 1) set.add(si);
    else if (e.added === 2) set.delete(si);
  }
  return Array.from(set).sort(function (a, b) { return a - b; });
}

// Compatibility shim (design section 1.2): the legacy single-pick
// contract, defined as the first element of the resolved set (or -1
// when the set is empty). On any feed whose active set is a
// singleton — Detroit on every date — this returns exactly what the
// legacy resolver returned, so the three-argument callers (stop
// cards, the delay matcher, the Departure Board) are unaffected.
function serviceFor(tt, ymd, dow, feed) {
  var set = servicesFor(tt, ymd, dow, feed);
  return set.length ? set[0] : -1;
}

var MAX_WALK_SECS = 1800; // 30 min cumulative walk per round: transfers and
// last-mile walks are minutes; anything longer is not a transit itinerary.

// Cooperative compute budget (2026-10-16, error-handling step 3;
// architectural review §4.3). plan() is bounded by construction
// (K_ROUNDS, the reconstruction guard, the walk cap) but was unbudgeted:
// its worst case on a phone CPU is uninterruptible mid-call, on the main
// thread, inside the rider's tap or the 60 s poll. Callers may pass
// opts.budgetMs (750 user-initiated, 250 background); plan() then checks
// the clock at round boundaries and, via planTick(), at coarse intervals
// inside the trip scan and the walk relaxation, and on exhaustion
// returns { journeys: [], meta: { reason: 'budget' } } — an explicit
// result, never a hang. Without opts, behavior is exactly as before.
var BUDGET_HIT = { budgetSentinel: true };
var planDeadline = 0; // performance.now() deadline; 0 = unbudgeted
var planTickN = 0;
function planTick() {
  if (!planDeadline) return;
  if ((++planTickN & 511) === 0 && performance.now() > planDeadline) throw BUDGET_HIT;
}
function planClockCheck() {
  if (planDeadline && performance.now() > planDeadline) throw BUDGET_HIT;
}

function relaxWalk(tt, arr, wpar, wsec, seeds) {
  var improved = new Set();
  var q = seeds.slice(), inQ = new Set(seeds);
  while (q.length) {
    planTick();
    var s = q.shift(); inQ.delete(s);
    if (wsec[s] >= MAX_WALK_SECS) continue;
    var edges = tt.adj[s];
    if (!edges) continue;
    for (var i = 0; i < edges.length; i++) {
      var t = edges[i][0], w = edges[i][1];
      var nw = wsec[s] + w;
      if (nw > MAX_WALK_SECS) continue;
      var na = arr[s] + w;
      if (na < arr[t]) {
        arr[t] = na; wpar[t] = s; wsec[t] = nw; improved.add(t);
        if (!inQ.has(t)) { q.push(t); inQ.add(t); }
      }
    }
  }
  return improved;
}

function fmtClock(sec) {
  sec = Math.floor(sec) % 86400;
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  var ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
}

export function plan(tt, fromSeeds, toIdx, when, opts) {
  planDeadline = (opts && opts.budgetMs) ? performance.now() + opts.budgetMs : 0;
  planTickN = 0;
  try {
    return planImpl(tt, fromSeeds, toIdx, when);
  } catch (e) {
    if (e === BUDGET_HIT) return { journeys: [], meta: { reason: 'budget', when: when } };
    throw e;
  } finally {
    planDeadline = 0;
  }
}

function planImpl(tt, fromSeeds, toIdx, when) {
  // fromSeeds: [{stop, walk}] — one tapped stop, or several nearby stops when
  // the origin is the rider's location. A virtual walk leg is prepended for
  // location origins so the journey always starts at the rider.
  var seeds = (Array.isArray(fromSeeds) ? fromSeeds : [{ stop: fromSeeds, walk: 0 }])
    .filter(function (fs) { return fs && fs.stop >= 0 && fs.stop < tt.nStops; });
  var nS = tt.nStops;
  var ymd = fmtYMD(when), dow = when.getDay();
  var pd = new Date(when.getTime() - 86400000);
  // Per-feed service resolution (U7 Phase B): each feed's calendar
  // decides its own services; a trip is judged against its own feed's
  // pair. On a single-feed timetable this is exactly the legacy pair.
  var feeds = [];
  tt.services.forEach(function (s) {
    var f = s.feed || 0;
    if (feeds.indexOf(f) < 0) feeds.push(f);
  });
  var svcByFeed = {}, prevByFeed = {}, anySvc = false;
  var svcSetByFeed = {}, prevSetByFeed = {};
  feeds.forEach(function (f) {
    svcByFeed[f] = serviceFor(tt, ymd, dow, f);
    prevByFeed[f] = serviceFor(tt, fmtYMD(pd), pd.getDay(), f);
    svcSetByFeed[f] = new Set(servicesFor(tt, ymd, dow, f));
    prevSetByFeed[f] = new Set(servicesFor(tt, fmtYMD(pd), pd.getDay(), f));
    if (svcByFeed[f] >= 0 || prevByFeed[f] >= 0) anySvc = true;
  });
  var svc = (svcByFeed[0] === undefined) ? -1 : svcByFeed[0];
  var nowSec = when.getHours() * 3600 + when.getMinutes() * 60 + when.getSeconds();
  if (!anySvc) {
    return { journeys: [], meta: { reason: 'no-service', when: when } };
  }
  if (!seeds.length) {
    return { journeys: [], meta: { reason: 'no-origin', when: when } };
  }
  if (seeds.some(function (fs) { return fs.stop === toIdx && !(fs.walk > 0); })) {
    return { journeys: [], meta: { reason: 'same-stop', when: when } };
  }

  var seedOf = {}; // stop -> walk seconds from the origin point
  var arrR = [], alight = [], walkPar = [];
  // Phase 2b-i adjusted timetable: live delays apply only to near-term
  // queries — a delay measured now says nothing about a trip planned for 8pm.
  // Without fresh delays this is exactly the Phase 1 scheduled planner.
  var liveDelays = tt.liveDelays || null;
  var liveStamp = tt.liveStamp || 0;
  var useLive = !!(liveDelays && liveStamp && Math.abs(when.getTime() - liveStamp) < LIVE_FRESH_MS);
  var liveCtx = useLive ? { delays: liveDelays, stamp: liveStamp } : null;
  function depA(t, pos) {
    var d = (t.depL2 ? t.depL2[pos] : t.dep[pos]);
    if (liveCtx) {
      var ld = liveDelays.get(t);
      if (ld && !ld.disrupted && ld.delaySec) d += ld.delaySec * DELAY_PROJECTION;
    }
    return d;
  }
  function arrA(t, pos) {
    var a = (t.arrL2 ? t.arrL2[pos] : t.arr[pos]);
    if (liveCtx) {
      var ld = liveDelays.get(t);
      if (ld && !ld.disrupted && ld.delaySec) a += ld.delaySec * DELAY_PROJECTION;
    }
    return a;
  }
  // round 0: origin seeds + walking
  var arr0 = new Float64Array(nS).fill(INF);
  var seedList = [];
  seeds.forEach(function (fs) {
    var t = nowSec + (fs.walk || 0);
    if (t < arr0[fs.stop]) { arr0[fs.stop] = t; seedOf[fs.stop] = fs.walk || 0; }
    seedList.push(fs.stop);
  });
  var w0 = new Array(nS).fill(null);
  var ws0 = new Float64Array(nS).fill(INF);
  seeds.forEach(function (fs) {
    var w = fs.walk || 0;
    if (w < ws0[fs.stop]) ws0[fs.stop] = w;
  });
  var imp0 = relaxWalk(tt, arr0, w0, ws0, seedList);
  seedList.forEach(function (s) { imp0.add(s); });
  arrR[0] = arr0; walkPar[0] = w0;
  var markedPrev = imp0;

  for (var k = 1; k <= K_ROUNDS; k++) {
    planClockCheck(); // budget: round boundary
    var prevArr = arrR[k - 1];
    var arr = Float64Array.from(prevArr);
    var wpar = new Array(nS).fill(null);
    var ali = new Array(nS).fill(null);
    var improved = new Set();
    markedPrev.forEach(function (p) {
      var sps = tt.stopPat[p];
      if (!sps) return;
      for (var q = 0; q < sps.length; q++) {
        var pi = sps[q][0], pos = sps[q][1];
        var pat = tt.patterns[pi];
        var trips = pat.trips;
        for (var ti = 0; ti < trips.length; ti++) {
          planTick(); // budget: coarse sampling inside the trip scan
          var t = trips[ti];
          // A previous-service-day trip runs into the query day only
          // past midnight: feed times are service-day seconds, so map
          // them into the query day's frame (-86400) before comparing.
          // A previous-day trip ending before midnight maps entirely
          // into yesterday and can never be caught — it does not run
          // today, and must not be planned at face value.
          var shift = 0;
          var tFeed = (tt.services[t.s] && tt.services[t.s].feed) || 0;
          if (!svcSetByFeed[tFeed].has(t.s)) {
            if (!prevSetByFeed[tFeed].has(t.s)) continue;
            shift = -86400;
          }
          if (depA(t, pos) + shift < prevArr[p]) continue; // cannot catch
          for (var j = pos + 1; j < pat.stops.length; j++) {
            planTick(); // budget: coarse sampling inside the stop scan
            var s = pat.stops[j];
            var aA = arrA(t, j) + shift;
            if (aA < arr[s]) {
              arr[s] = aA;
              ali[s] = { trip: t, board: p, boardPos: pos, alightPos: j, shift: shift };
              improved.add(s);
            } else if (aA === arr[s] && ali[s] && ali[s].trip === t && tFeed !== 0 &&
                       prevArr[p] < prevArr[ali[s].board]) {
              // Same bus, same arrival, but this boarding point was
              // reached with less travel: keep the earlier boarding.
              // Scoped to non-legacy feeds (U7 Phase B): SMART
              // itineraries are new in this build and have no legacy
              // reconstruction to preserve, while feed-0 (DDOT)
              // reconstruction is byte-frozen by the Phase B control —
              // its walk-first tie artifact is part of the shipped
              // behavior the control pins. (Effect here: the 851
              // boards at Woodward & Warren rather than one stop down
              // Woodward after a walk to the same bus.)
              ali[s] = { trip: t, board: p, boardPos: pos, alightPos: j, shift: shift };
            }
          }
        }
      }
    });
    var ws = new Float64Array(nS).fill(INF);
    improved.forEach(function (s) { ws[s] = 0; });
    var wImp = relaxWalk(tt, arr, wpar, ws, Array.from(improved));
    // A stop reached faster on foot was not reached by bus: drop the stale
    // bus leg so the reconstruction follows the walk that actually won.
    wImp.forEach(function (s) { improved.add(s); ali[s] = null; });
    arrR[k] = arr; alight[k] = ali; walkPar[k] = wpar;
    markedPrev = improved;
  }

  // reconstruct up to 3 journeys (best arrival per transfer count)
  var journeys = [], seen = new Set();
  for (var kk = 1; kk <= K_ROUNDS; kk++) {
    if (arrR[kk][toIdx] >= INF / 2) continue;
    var legs = buildJourney(tt, kk, toIdx, seedOf, alight, walkPar, liveCtx);
    if (!legs || !legs.length) continue;
    var nBus = legs.filter(function (l) { return l.type === 'bus'; }).length;
    var key = Math.round(arrR[kk][toIdx]) + '|' + nBus;
    if (seen.has(key)) continue;
    seen.add(key);
    journeys.push(summarize(tt, legs, nowSec, arrR[kk][toIdx]));
    if (journeys.length >= 3) break;
  }
  // meta.service names the day type for the results header: feed 0's
  // resolved service when it has one, else the first resolved feed's
  // (both feeds use the same day-type ids — 1 Sunday, 2 Saturday,
  // 3 Weekday — so the label stays truthful on a SMART-only day).
  var metaSvc = svc;
  if (metaSvc < 0) {
    for (var fi = 0; fi < feeds.length; fi++) {
      if (svcByFeed[feeds[fi]] >= 0) { metaSvc = svcByFeed[feeds[fi]]; break; }
    }
  }
  return {
    journeys: journeys,
    meta: {
      when: when, service: metaSvc >= 0 ? tt.services[metaSvc].id : null,
      feedVersion: tt.meta.feed_version, nowSec: nowSec
    }
  };
}

function walkSecs(tt, a, b) {
  var edges = tt.adj[a] || [];
  for (var i = 0; i < edges.length; i++) {
    if (edges[i][0] === b) return edges[i][1];
  }
  return null;
}

function buildJourney(tt, k, target, seedOf, alight, walkPar, liveCtx) {
  var legs = [], cur = target, kk = k, guard = 0;
  while ((seedOf[cur] === undefined) && guard++ < 200) {
    var a = (alight[kk] || [])[cur];
    if (a) {
      var t = a.trip, r = tt.routes[t.r];
      var interp = t.interp.indexOf(a.boardPos) >= 0 || t.interp.indexOf(a.alightPos) >= 0;
      var ld = liveCtx ? liveCtx.delays.get(t) : null;
      var hasL2 = !!(t.depL2 && t.arrL2);
      // Times as planned (adjusted when live/empirical). Provenance follows
      // the strongest signal: live delay > empirical baseline > scheduled.
      var bSec = (hasL2 ? t.depL2[a.boardPos] : t.dep[a.boardPos]);
      var aSec = (hasL2 ? t.arrL2[a.alightPos] : t.arr[a.alightPos]);
      if (ld && !ld.disrupted && ld.delaySec) { bSec += ld.delaySec * DELAY_PROJECTION; aSec += ld.delaySec * DELAY_PROJECTION; }
      if (a.shift) { bSec += a.shift; aSec += a.shift; }
      legs.unshift({
        type: 'bus', routeId: r.id, routeName: r.name, color: r.color,
        agency: (r && r.ag) || null,
        board: a.board, alight: cur,
        boardSec: bSec, alightSec: aSec,
        headsign: t.h || '', interp: interp,
        provenance: (ld && !ld.disrupted) ? 'live' : (hasL2 ? 'empirical' : 'scheduled'),
        delaySec: (ld && !ld.disrupted) ? ld.delaySec : 0,
        delayStamp: (ld && !ld.disrupted) ? liveCtx.stamp : 0,
        delayFixStamp: (ld && !ld.disrupted) ? (ld.fixStamp || 0) : 0,
        disrupted: !!(ld && ld.disrupted),
        tripRef: t // Phase 2c: identity key into the live delay/matcher state
      });
      cur = a.board; kk--;
      if (kk < 0) return null;
      continue;
    }
    var w = (walkPar[kk] || [])[cur];
    if (w !== null && w !== undefined) {
      legs.unshift({ type: 'walk', from: w, to: cur, secs: walkSecs(tt, w, cur) || 0 });
      cur = w;
      continue;
    }
    if (kk > 0) { kk--; continue; }
    return null;
  }
  if (guard >= 200) return null;
  // Prepend the virtual walk from the origin point (tapped stop: 0s and
  // usually absorbed; your-location: the real first-mile walk).
  if (seedOf[cur] !== undefined && seedOf[cur] > 0) {
    legs.unshift({ type: 'walk', from: -1, to: cur, secs: seedOf[cur], fromLoc: true });
  }
  return legs;
}

function summarize(tt, legs, nowSec, arriveSec) {
  var busLegs = legs.filter(function (l) { return l.type === 'bus'; });
  var walkSecs = legs.reduce(function (s, l) { return s + (l.type === 'walk' ? l.secs : 0); }, 0);
  var interp = busLegs.some(function (l) { return l.interp; });
  return {
    legs: legs,
    nBus: busLegs.length,
    departSec: nowSec,
    arriveSec: arriveSec,
    durationMin: Math.max(1, Math.round((arriveSec - nowSec) / 60)),
    transfers: Math.max(0, busLegs.length - 1),
    walkMin: Math.round(walkSecs / 60),
    hasInterp: interp,
    departClock: fmtClock(nowSec),
    arriveClock: fmtClock(arriveSec)
  };
}

export function fmtClockSec(sec) { return fmtClock(sec); }

// Phase 2b-i: the live adjusted timetable. delayMap: Map(trip -> {delaySec,
// disrupted, vehicleId}). Delays shift a trip's remaining times; disrupted
// trips are never shifted. Stored on the tt object; plan() applies them.
export function setLiveDelays(tt, delayMap, stampMs) {
  tt.liveDelays = delayMap;
  tt.liveStamp = stampMs;
}

// Exported for the client-side trip matcher (Phase 2b-i).
export { serviceFor, servicesFor };

/* ------------------------------------------------------------------ *
 * Tranche A (Project 39, RAPTOR Engine v2) — multi-criteria results.
 *
 * The plan (raptor-v2-plan-2026-10-20.md §2 option A, §5 sequencing)
 * defines tranche A in its presentation form: the search above is NOT
 * modified — plan() keeps returning the best arrival per transfer
 * count, bit-identical to v1 — and the multi-criteria layer works on
 * the returned set. From the journeys' own figures it names the
 * per-criterion winners the results stack labels:
 *
 *   earliest        — minimum arriveSec
 *   fewestTransfers — minimum transfers
 *   leastWalking    — minimum total walking (summed from the walk
 *                     legs' own secs; the printed figure is the
 *                     journey's walkMin, which summarize() derives
 *                     from the same sum)
 *
 * Ties break toward the rider's next concern, deterministically:
 * earliest breaks on (transfers, walk); fewestTransfers on (arrival,
 * walk); leastWalking on (arrival, transfers); any remaining tie keeps
 * plan()'s own order. A journey may win several criteria; it is
 * labeled with all of them and appears once in the stack.
 *
 * Presentation contract (plan §2A): a labeled card stack — Earliest
 * arrival, Fewest transfers, Least walking — each card printing its
 * real trade-offs (arrival clock, transfers, walk minutes). The stack
 * order is: criterion winners in that criterion order, then any
 * returned journey that won nothing, by earliest arrival. Returned
 * journeys that win no criterion are still part of the result set —
 * the stack presents the set, it does not filter it.
 *
 * planMulti() is the v2 entry point: it calls plan() unchanged and
 * annotates COPIES (plan()'s own result objects are never mutated —
 * legs are shared by reference). On an explicit empty result
 * (no-service / budget / same-stop) the criteria are all null and the
 * meta passes through untouched: the empty states stay explicit.
 * ------------------------------------------------------------------ */

function walkSecondsOf(j) {
  var s = 0;
  for (var i = 0; i < j.legs.length; i++) {
    if (j.legs[i].type === 'walk') s += j.legs[i].secs;
  }
  return s;
}

var CRITERIA_ORDER = ['earliest', 'fewestTransfers', 'leastWalking'];
var CRITERIA_COMPARATORS = {
  earliest: ['arriveSec', 'transfers', 'walkSec'],
  fewestTransfers: ['transfers', 'arriveSec', 'walkSec'],
  leastWalking: ['walkSec', 'arriveSec', 'transfers']
};

export function criteriaFor(journeys) {
  var enriched = journeys.map(function (j, index) {
    return { index: index, arriveSec: j.arriveSec, arriveClock: j.arriveClock,
             transfers: j.transfers, walkSec: walkSecondsOf(j), walkMin: j.walkMin };
  });
  var winners = { earliest: null, fewestTransfers: null, leastWalking: null };
  CRITERIA_ORDER.forEach(function (crit) {
    var keys = CRITERIA_COMPARATORS[crit];
    var best = null;
    enriched.forEach(function (e) {
      if (!best) { best = e; return; }
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (e[k] < best[k]) { best = e; return; }
        if (e[k] > best[k]) return;
      }
      // full tie on the criterion's key chain: keep plan()'s order
      // (the earlier index, already held by `best`).
    });
    winners[crit] = best;
  });
  return winners;
}

export function planMulti(tt, fromSeeds, toIdx, when, opts) {
  var res = plan(tt, fromSeeds, toIdx, when, opts);
  var winners = criteriaFor(res.journeys);
  var labels = res.journeys.map(function () { return []; });
  CRITERIA_ORDER.forEach(function (crit) {
    if (winners[crit]) labels[winners[crit].index].push(crit);
  });
  var annotated = res.journeys.map(function (j, i) {
    var copy = Object.assign({}, j);
    copy.walkSec = walkSecondsOf(j);
    copy.criteria = labels[i];
    return copy;
  });
  var inStack = new Set(), stack = [];
  CRITERIA_ORDER.forEach(function (crit) {
    if (winners[crit] && !inStack.has(winners[crit].index)) {
      inStack.add(winners[crit].index);
      stack.push(annotated[winners[crit].index]);
    }
  });
  annotated.forEach(function (j, i) { if (!inStack.has(i)) { inStack.add(i); stack.push(j); } });
  // Remaining (non-winning) journeys follow the winners, earliest first:
  // the stack array after the winners is re-sorted by the earliest key
  // chain so the presentation order is fully deterministic.
  var head = stack.slice(0, new Set(CRITERIA_ORDER.map(function (c) { return winners[c] && winners[c].index; })).size);
  var tail = stack.slice(head.length).sort(function (a, b) {
    return (a.arriveSec - b.arriveSec) || (a.transfers - b.transfers) ||
           (a.walkSec - b.walkSec);
  });
  return {
    journeys: annotated,
    stack: head.concat(tail),
    criteria: winners,
    meta: res.meta
  };
}

/* ------------------------------------------------------------------ *
 * Tranche B (Project 39, RAPTOR Engine v2) — range + arrive-by.
 *
 * The plan (raptor-v2-plan-2026-10-20.md §2 option B) defines this
 * tranche: departure-window (range) queries and arrive-by queries.
 * The search above and tranche A's criteria layer are NOT modified —
 * plan()/planMulti() stay bit-identical to the staged tranche-A
 * engine. Two entry points are added:
 *
 *   planRange(tt, fromSeeds, toIdx, startWhen, endWhen, opts)
 *     The departure strip: every distinct first-boarding departure in
 *     the window with the best journey(s) plan() returns for it —
 *     "next departures that get you there," each entry carrying its
 *     own leave-by figure (first boarding minus the walk that reaches
 *     it). Computed by iterating the verified plan() over the
 *     window's first-boarding events: each non-empty call records all
 *     its journeys (deduplicated on legs + boarding + arrival) and
 *     advances the query instant past the earliest boarding it
 *     returned; each empty call advances to the next scheduled
 *     departure out of the origin's walk-reachable stops, computed
 *     from the same index and the same per-feed service resolution
 *     (previous-day tails included, so a window crossing midnight
 *     enumerates both days' frames). Under the FIFO property of the
 *     timetable, the best journey for any instant in the window is
 *     the next recorded event's — the strip is the window's profile.
 *     opts.maxCalls (default 240 plan() calls) and opts.maxEntries
 *     (default 48) bound the work; meta.truncated says so when a
 *     bound binds.
 *
 *   planArriveBy(tt, fromSeeds, toIdx, arriveBy, opts)
 *     The reverse search: rounds run backward from the destination.
 *     latest[s] = the latest time the rider can be at stop s and
 *     still reach toIdx by the target (query-frame seconds). Round 0
 *     walk-relaxes the destination label backward over the same
 *     adjacency and the same per-round cumulative cap
 *     (MAX_WALK_SECS) as plan(); each reverse round scans, from the
 *     stops improved in the previous phase, every pattern and trip
 *     whose adjusted arrival at the marked stop is no later than its
 *     label, and raises each boarding stop's label to that trip's
 *     adjusted departure — the mirror of plan()'s catch test, with
 *     the same per-feed service resolution and the same -86400
 *     previous-day frame shift (a boarding whose shifted departure
 *     falls before the query frame's midnight is outside the frame,
 *     exactly as plan() cannot catch it). One label per stop (v1's
 *     label discipline, mirrored); a stop's continuation record is
 *     replaced only by a strictly later label, and a walk improvement
 *     inside a round replaces that round's bus record — plan()'s
 *     stale-leg rule, mirrored. The search runs once per leg cap
 *     (1..K_ROUNDS) and returns the latest-departure journey per cap,
 *     deduplicated, latest first — plan()'s best-per-transfer-count
 *     presentation, in reverse. Explicit empty results keep plan()'s
 *     reasons ('no-service' / 'no-origin' / 'same-stop' / 'budget'),
 *     plus 'no-journey' when no chain reaches the target in frame.
 *
 *   stripLatestFor(departures, arriveByMs)
 *     The "leave by" reading of a range strip: the entry with the
 *     latest leave time among those arriving by the given instant
 *     (absolute ms), or null.
 *
 * Adjusted times: the reverse search and the departure-candidate
 * scan read times through depB/arrB below, which replicate plan()'s
 * depA/arrA exactly (L2 baseline arrays, then the L3 live delay at
 * DELAY_PROJECTION when the delay stamp is within LIVE_FRESH_MS of
 * the reference instant — the arrive-by target, or the candidate's
 * service day). planRange delegates every search to plan() itself,
 * so its adjustments are plan()'s own. Provenance is inherited:
 * legs built by the reverse search carry the same provenance /
 * delay / interp fields buildJourney emits, from the same state.
 * SMART participates only as scheduled GTFS service; no Swiftly
 * data, no external routing output, origin/destination on-device.
 * ------------------------------------------------------------------ */

function fmtClockWrap(sec) {
  var s = Math.floor(sec) % 86400;
  if (s < 0) s += 86400;
  return fmtClock(s);
}

function liveCtxFor(tt, when) {
  var liveDelays = tt.liveDelays || null;
  var liveStamp = tt.liveStamp || 0;
  var useLive = !!(liveDelays && liveStamp &&
    Math.abs(when.getTime() - liveStamp) < LIVE_FRESH_MS);
  return useLive ? { delays: liveDelays, stamp: liveStamp } : null;
}

function depB(t, pos, liveCtx) {
  var d = (t.depL2 ? t.depL2[pos] : t.dep[pos]);
  if (liveCtx) {
    var ld = liveCtx.delays.get(t);
    if (ld && !ld.disrupted && ld.delaySec) d += ld.delaySec * DELAY_PROJECTION;
  }
  return d;
}

function arrB(t, pos, liveCtx) {
  var a = (t.arrL2 ? t.arrL2[pos] : t.arr[pos]);
  if (liveCtx) {
    var ld = liveCtx.delays.get(t);
    if (ld && !ld.disrupted && ld.delaySec) a += ld.delaySec * DELAY_PROJECTION;
  }
  return a;
}

// Per-feed service resolution for a query date (plan()'s svcByFeed /
// prevByFeed pair, shared by the tranche B searches).
function feedServices(tt, when) {
  var ymd = fmtYMD(when), dow = when.getDay();
  var pd = new Date(when.getTime() - 86400000);
  var feeds = [];
  tt.services.forEach(function (s) {
    var f = s.feed || 0;
    if (feeds.indexOf(f) < 0) feeds.push(f);
  });
  var svcByFeed = {}, prevByFeed = {}, anySvc = false;
  var svcSetByFeed = {}, prevSetByFeed = {};
  feeds.forEach(function (f) {
    svcByFeed[f] = serviceFor(tt, ymd, dow, f);
    prevByFeed[f] = serviceFor(tt, fmtYMD(pd), pd.getDay(), f);
    svcSetByFeed[f] = new Set(servicesFor(tt, ymd, dow, f));
    prevSetByFeed[f] = new Set(servicesFor(tt, fmtYMD(pd), pd.getDay(), f));
    if (svcByFeed[f] >= 0 || prevByFeed[f] >= 0) anySvc = true;
  });
  return { feeds: feeds, svcByFeed: svcByFeed, prevByFeed: prevByFeed,
           svcSetByFeed: svcSetByFeed, prevSetByFeed: prevSetByFeed,
           anySvc: anySvc };
}

// The frame shift plan() applies to a trip under a resolution pair:
// 0 for the query day's service, -86400 for the previous day's (only
// its post-midnight tail maps into the frame), null when the trip's
// service runs on neither day.
function tripShift(tt, t, svc) {
  var tFeed = (tt.services[t.s] && tt.services[t.s].feed) || 0;
  if (svc.svcSetByFeed) {
    if (svc.svcSetByFeed[tFeed] && svc.svcSetByFeed[tFeed].has(t.s)) return 0;
    if (svc.prevSetByFeed[tFeed] && svc.prevSetByFeed[tFeed].has(t.s)) return -86400;
    return null;
  }
  if (t.s === svc.svcByFeed[tFeed]) return 0;
  if (t.s === svc.prevByFeed[tFeed]) return -86400;
  return null;
}

function metaService(tt, svc) {
  var m = (svc.svcByFeed[0] === undefined) ? -1 : svc.svcByFeed[0];
  if (m < 0) {
    for (var i = 0; i < svc.feeds.length; i++) {
      if (svc.svcByFeed[svc.feeds[i]] >= 0) { m = svc.svcByFeed[svc.feeds[i]]; break; }
    }
  }
  return m >= 0 ? tt.services[m].id : null;
}

function normalizeSeeds(tt, fromSeeds) {
  return (Array.isArray(fromSeeds) ? fromSeeds : [{ stop: fromSeeds, walk: 0 }])
    .filter(function (fs) { return fs && fs.stop >= 0 && fs.stop < tt.nStops; });
}

function seedMapOf(seeds) {
  var seedOf = {};
  seeds.forEach(function (fs) {
    if (seedOf[fs.stop] === undefined || (fs.walk || 0) < seedOf[fs.stop]) {
      seedOf[fs.stop] = fs.walk || 0;
    }
  });
  return seedOf;
}

/* ---------------- arrive-by: the reverse search ---------------- */

// relaxWalk mirrored: labels propagate away from the destination,
// each edge subtracting its walk seconds; the cumulative-walk
// accounting (wsec) and the per-round cap are plan()'s own.
function relaxWalkRev(tt, latest, rec, wsec, seedsList, round) {
  var improved = new Set();
  var q = seedsList.slice(), inQ = new Set(seedsList);
  while (q.length) {
    planTick();
    var s = q.shift(); inQ.delete(s);
    if (wsec[s] >= MAX_WALK_SECS) continue;
    var edges = tt.adj[s];
    if (!edges) continue;
    for (var i = 0; i < edges.length; i++) {
      var t = edges[i][0], w = edges[i][1];
      var nw = wsec[s] + w;
      if (nw > MAX_WALK_SECS) continue;
      var nl = latest[s] - w;
      if (nl > latest[t]) {
        latest[t] = nl;
        rec[t] = { kind: 'walk', next: s, round: round };
        wsec[t] = nw;
        improved.add(t);
        if (!inQ.has(t)) { q.push(t); inQ.add(t); }
      }
    }
  }
  return improved;
}

// One reverse search with at most maxRounds bus legs. Returns the
// label field and the per-stop continuation records.
function arriveBySearch(tt, toIdx, maxRounds, svc, liveCtx, targetSec) {
  var nS = tt.nStops;
  var NEG = -1e15;
  var latest = new Float64Array(nS).fill(NEG);
  var rec = new Array(nS).fill(null);
  latest[toIdx] = targetSec;
  rec[toIdx] = { kind: 'dest', round: 0 };
  var markedPrev = new Set([toIdx]);
  var ws0 = new Float64Array(nS).fill(INF);
  ws0[toIdx] = 0;
  var imp0 = relaxWalkRev(tt, latest, rec, ws0, [toIdx], 0);
  imp0.forEach(function (s) { markedPrev.add(s); });

  for (var k = 1; k <= maxRounds; k++) {
    planClockCheck(); // budget: round boundary, as in plan()
    var cand = new Map();
    markedPrev.forEach(function (p) {
      if (latest[p] <= NEG / 2) return;
      var sps = tt.stopPat[p];
      if (!sps) return;
      for (var q = 0; q < sps.length; q++) {
        var pi = sps[q][0], pos = sps[q][1];
        var pat = tt.patterns[pi];
        var trips = pat.trips;
        for (var ti = 0; ti < trips.length; ti++) {
          planTick();
          var t = trips[ti];
          var shift = tripShift(tt, t, svc);
          if (shift === null) continue;
          var arrAtP = arrB(t, pos, liveCtx) + shift;
          if (arrAtP > latest[p]) continue; // arrives after the deadline at p
          for (var j = pos - 1; j >= 0; j--) {
            var b = depB(t, j, liveCtx) + shift;
            if (b < 0) continue; // boarding maps before the frame: outside it
            var bs = pat.stops[j];
            if (b <= latest[bs]) continue; // cannot improve the label
            var ex = cand.get(bs);
            if (!ex || b > ex.boardSec) {
              cand.set(bs, {
                kind: 'bus', trip: t, boardPos: j, alightPos: pos,
                alight: p, shift: shift, boardSec: b, alightSec: arrAtP,
                round: k
              });
            }
          }
        }
      }
    });
    var busImproved = new Set();
    cand.forEach(function (r, s) {
      if (r.boardSec > latest[s]) {
        latest[s] = r.boardSec; rec[s] = r; busImproved.add(s);
      }
    });
    var ws = new Float64Array(nS).fill(INF);
    busImproved.forEach(function (s) { ws[s] = 0; });
    var wImp = relaxWalkRev(tt, latest, rec, ws, Array.from(busImproved), k);
    var improved = new Set();
    busImproved.forEach(function (s) { improved.add(s); });
    wImp.forEach(function (s) { improved.add(s); });
    markedPrev = improved;
    if (!improved.size) break;
  }
  return { latest: latest, rec: rec };
}

// buildJourney mirrored: follow the continuation records forward
// from the origin seed to the destination.
function buildJourneyRev(tt, seedStop, rec, seedOf, liveCtx) {
  var legs = [], cur = seedStop, guard = 0;
  while (guard++ < 200) {
    var r = rec[cur];
    if (!r) return null;
    if (r.kind === 'dest') break;
    if (r.kind === 'walk') {
      legs.push({ type: 'walk', from: cur, to: r.next, secs: walkSecs(tt, cur, r.next) || 0 });
      cur = r.next;
      continue;
    }
    var t = r.trip, rt = tt.routes[t.r];
    var interp = t.interp.indexOf(r.boardPos) >= 0 || t.interp.indexOf(r.alightPos) >= 0;
    var ld = liveCtx ? liveCtx.delays.get(t) : null;
    var hasL2 = !!(t.depL2 && t.arrL2);
    legs.push({
      type: 'bus', routeId: rt.id, routeName: rt.name, color: rt.color,
      agency: (rt && rt.ag) || null,
      board: cur, alight: r.alight,
      boardSec: r.boardSec, alightSec: r.alightSec,
      headsign: t.h || '', interp: interp,
      provenance: (ld && !ld.disrupted) ? 'live' : (hasL2 ? 'empirical' : 'scheduled'),
      delaySec: (ld && !ld.disrupted) ? ld.delaySec : 0,
      delayStamp: (ld && !ld.disrupted) ? liveCtx.stamp : 0,
      delayFixStamp: (ld && !ld.disrupted) ? (ld.fixStamp || 0) : 0,
      disrupted: !!(ld && ld.disrupted),
      tripRef: t
    });
    cur = r.alight;
  }
  if (guard >= 200) return null;
  if (seedOf[seedStop] !== undefined && seedOf[seedStop] > 0) {
    legs.unshift({ type: 'walk', from: -1, to: seedStop, secs: seedOf[seedStop], fromLoc: true });
  }
  return legs;
}

// summarize mirrored: the departure is the leave time at the origin
// point; the arrival is the leg chain replayed to the destination.
function summarizeRev(legs, leaveSec) {
  var clock = leaveSec, busLegs = 0, walkTotal = 0, interp = false;
  for (var i = 0; i < legs.length; i++) {
    var l = legs[i];
    if (l.type === 'walk') { clock += l.secs; walkTotal += l.secs; }
    else {
      busLegs++;
      if (l.interp) interp = true;
      clock = l.alightSec;
    }
  }
  return {
    legs: legs,
    nBus: busLegs,
    departSec: leaveSec,
    arriveSec: clock,
    durationMin: Math.max(1, Math.round((clock - leaveSec) / 60)),
    transfers: Math.max(0, busLegs - 1),
    walkMin: Math.round(walkTotal / 60),
    hasInterp: interp,
    departClock: fmtClockWrap(leaveSec),
    arriveClock: fmtClockWrap(clock)
  };
}

export function planArriveBy(tt, fromSeeds, toIdx, arriveBy, opts) {
  planDeadline = (opts && opts.budgetMs) ? performance.now() + opts.budgetMs : 0;
  planTickN = 0;
  try {
    return arriveByImpl(tt, fromSeeds, toIdx, arriveBy);
  } catch (e) {
    if (e === BUDGET_HIT) return { journeys: [], meta: { reason: 'budget', when: arriveBy } };
    throw e;
  } finally {
    planDeadline = 0;
  }
}

function arriveByImpl(tt, fromSeeds, toIdx, arriveBy) {
  var seeds = normalizeSeeds(tt, fromSeeds);
  var svc = feedServices(tt, arriveBy);
  if (!svc.anySvc) {
    return { journeys: [], meta: { reason: 'no-service', when: arriveBy } };
  }
  if (!seeds.length) {
    return { journeys: [], meta: { reason: 'no-origin', when: arriveBy } };
  }
  if (seeds.some(function (fs) { return fs.stop === toIdx && !(fs.walk > 0); })) {
    return { journeys: [], meta: { reason: 'same-stop', when: arriveBy } };
  }
  var seedOf = seedMapOf(seeds);
  var targetSec = arriveBy.getHours() * 3600 + arriveBy.getMinutes() * 60 + arriveBy.getSeconds();
  var liveCtx = liveCtxFor(tt, arriveBy);
  var bySig = new Map();
  for (var cap = 1; cap <= K_ROUNDS; cap++) {
    var st = arriveBySearch(tt, toIdx, cap, svc, liveCtx, targetSec);
    var best = null;
    seeds.forEach(function (fs) {
      var s = fs.stop;
      if (st.latest[s] <= -1e14) return;
      var legs = buildJourneyRev(tt, s, st.rec, seedOf, liveCtx);
      if (!legs) return;
      var j = summarizeRev(legs, st.latest[s] - (seedOf[s] || 0));
      if (j.arriveSec > targetSec + 0.001) return; // construction guard
      if (!best || j.departSec > best.departSec ||
          (j.departSec === best.departSec &&
           (j.transfers < best.transfers ||
            (j.transfers === best.transfers && j.arriveSec < best.arriveSec)))) {
        best = j;
      }
    });
    if (best) {
      var sig = best.legs.map(function (l) {
        return l.type === 'bus' ? 'B' + l.routeId + '@' + l.boardSec + '>' + l.alightSec
                                : 'W' + l.from + '>' + l.to;
      }).join('|') + '@' + best.departSec;
      if (!bySig.has(sig)) bySig.set(sig, best);
    }
  }
  var journeys = Array.from(bySig.values());
  journeys.sort(function (a, b) {
    return (b.departSec - a.departSec) || (a.transfers - b.transfers) ||
           (a.arriveSec - b.arriveSec);
  });
  var meta = {
    when: arriveBy, mode: 'arrive-by', targetSec: targetSec,
    service: metaService(tt, svc), feedVersion: tt.meta.feed_version,
    nowSec: targetSec
  };
  if (!journeys.length) {
    meta.reason = 'no-journey';
    return { journeys: [], meta: meta };
  }
  return { journeys: journeys, meta: meta };
}

/* ---------------- range: the departure strip ---------------- */

// Stops reachable on foot from the origin seeds (static walk graph,
// the per-round cap applied to the whole chain — an over-approximation
// of plan()'s reachable set, used only to find candidate departures).
function walkReachableStops(tt, seeds) {
  var seen = new Map();
  var q = [];
  seeds.forEach(function (fs) {
    if (!seen.has(fs.stop) || (fs.walk || 0) < seen.get(fs.stop)) {
      seen.set(fs.stop, fs.walk || 0);
    }
    q.push(fs.stop);
  });
  while (q.length) {
    var s = q.shift();
    var acc = seen.get(s);
    if (acc >= MAX_WALK_SECS) continue;
    var edges = tt.adj[s];
    if (!edges) continue;
    for (var i = 0; i < edges.length; i++) {
      var t = edges[i][0], nw = acc + edges[i][1];
      if (nw > MAX_WALK_SECS) continue;
      if (!seen.has(t) || nw < seen.get(t)) { seen.set(t, nw); q.push(t); }
    }
  }
  return seen;
}

// The earliest scheduled departure after `after` (and no later than
// `end`) out of the walk-reachable stops, across the service frames
// of every day the window touches — or null.
function nextDepartureAfter(tt, reachStops, after, end) {
  var best = null;
  var dayMs = 86400000;
  var firstDay = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  for (var dOff = 0; dOff <= 4; dOff++) {
    var day = new Date(firstDay.getTime() + dOff * dayMs);
    if (day.getTime() > end.getTime() && best !== null) break;
    if (day.getTime() > end.getTime() + dayMs) break;
    var svc = feedServices(tt, day);
    if (!svc.anySvc) continue;
    var liveCtx = liveCtxFor(tt, day);
    var mid = day.getTime();
    reachStops.forEach(function (_, s) {
      var sps = tt.stopPat[s];
      if (!sps) return;
      for (var q = 0; q < sps.length; q++) {
        var pi = sps[q][0], pos = sps[q][1];
        var trips = tt.patterns[pi].trips;
        for (var ti = 0; ti < trips.length; ti++) {
          var t = trips[ti];
          var shift = tripShift(tt, t, svc);
          if (shift === null) continue;
          var depAbs = mid + (depB(t, pos, liveCtx) + shift) * 1000;
          if (depAbs > after.getTime() && depAbs <= end.getTime() &&
              (best === null || depAbs < best)) {
            best = depAbs;
          }
        }
      }
    });
  }
  return best === null ? null : new Date(best);
}

function firstBoardOf(journey) {
  var walkBefore = 0;
  for (var i = 0; i < journey.legs.length; i++) {
    var l = journey.legs[i];
    if (l.type === 'walk') { walkBefore += l.secs; continue; }
    return { boardSec: l.boardSec, walkBefore: walkBefore };
  }
  return null;
}

export function planRange(tt, fromSeeds, toIdx, startWhen, endWhen, opts) {
  opts = opts || {};
  var maxCalls = opts.maxCalls || 240;
  var maxEntries = opts.maxEntries || 48;
  var seeds = normalizeSeeds(tt, fromSeeds);
  var reach = walkReachableStops(tt, seeds);
  var departures = [];
  var seenSig = new Set();
  var t = new Date(startWhen.getTime());
  var calls = 0, truncated = false;
  while (t.getTime() <= endWhen.getTime()) {
    if (calls >= maxCalls || departures.length >= maxEntries) {
      truncated = true;
      break;
    }
    var res = plan(tt, seeds, toIdx, t,
      opts.budgetMs ? { budgetMs: opts.budgetMs } : undefined);
    calls++;
    var frameMid = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
    var endMs = endWhen.getTime();
    var minBoardAll = Infinity, recorded = 0;
    (res.journeys || []).forEach(function (j) {
      var fb = firstBoardOf(j);
      if (!fb) return;
      if (fb.boardSec < minBoardAll) minBoardAll = fb.boardSec;
      var boardMs = frameMid + fb.boardSec * 1000;
      if (boardMs > endMs) return; // boards after the window closes
      var leaveSec = fb.boardSec - fb.walkBefore;
      var sig = j.legs.map(function (l) {
        return l.type === 'bus' ? 'B' + l.routeId + '@' + l.boardSec + '>' + l.alightSec
                                : 'W' + l.from + '>' + l.to;
      }).join('|');
      if (seenSig.has(sig)) return;
      seenSig.add(sig);
      recorded++;
      departures.push({
        leaveSec: leaveSec, boardSec: fb.boardSec, arriveSec: j.arriveSec,
        leaveMs: frameMid + leaveSec * 1000,
        boardMs: boardMs,
        arriveMs: frameMid + j.arriveSec * 1000,
        transfers: j.transfers, walkMin: j.walkMin,
        journey: j
      });
    });
    if (minBoardAll < Infinity) {
      // plan() saw journeys: advance past the earliest boarding among
      // them, recorded or not (duplicates and journeys boarding after
      // the window closes are both behind us at that instant).
      departures.sort(function (a, b) { return a.boardMs - b.boardMs; });
      var nt = new Date(frameMid + (minBoardAll + 1) * 1000);
      if (nt.getTime() <= t.getTime()) break; // safety: always advance
      t = nt;
    } else {
      var nd = nextDepartureAfter(tt, reach, t, endWhen);
      if (!nd || nd.getTime() <= t.getTime()) break;
      t = nd;
    }
  }
  departures.sort(function (a, b) { return a.boardMs - b.boardMs; });
  return {
    departures: departures,
    meta: {
      mode: 'range', start: startWhen, end: endWhen,
      calls: calls, truncated: truncated,
      feedVersion: tt.meta && tt.meta.feed_version
    }
  };
}

// The "leave by" reading of a strip: among the entries arriving by
// the given absolute instant, the one that leaves latest.
export function stripLatestFor(departures, arriveByMs) {
  var best = null;
  for (var i = 0; i < departures.length; i++) {
    var d = departures[i];
    if (d.arriveMs <= arriveByMs && (!best || d.leaveMs > best.leaveMs)) best = d;
  }
  return best;
}
