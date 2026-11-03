/* raptor.js — client-side RAPTOR trip planner for Live Transit.
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

function serviceFor(tt, ymd, dow, feed) {
  var mi = (dow + 6) % 7; // mask is Mon..Sun
  // Per-feed resolution (U7 Phase B): services carry a feed tag
  // (0 = DDOT, 1 = SMART); an untagged service is feed 0, so the
  // legacy single-feed timetable resolves identically. The default
  // feed is 0 — the DDOT service — which is what the three-argument
  // callers (stop cards, the delay matcher, the Departure Board)
  // have always meant.
  var effFeed = (feed === undefined || feed === null) ? 0 : feed;
  function feedOf(s) { return s.feed || 0; }
  var best = -1, i;
  for (i = 0; i < tt.services.length; i++) {
    var s = tt.services[i];
    if (feedOf(s) !== effFeed) continue;
    if (ymd >= s.start && ymd <= s.end && s.mask[mi]) best = i;
  }
  // GTFS calendar_dates exceptions: the builder stores the raw
  // exception_type in `added` (1 = service added, 2 = service removed).
  // Test the value, never the truthiness — 2 is truthy, and processing a
  // removal as an addition made exception dates resolve to the removed
  // service (holidays planned weekday service). Collect the date's
  // exceptions first, then apply them as a set: a removal of the
  // calendar's pick re-scans the calendar for another service that runs
  // this date and was not itself removed; an addition then governs.
  var exRemoved = {}, exAdded = -1;
  for (i = 0; i < tt.exceptions.length; i++) {
    var e = tt.exceptions[i];
    if (e.date === ymd) {
      var si = -1;
      for (var j = 0; j < tt.services.length; j++) {
        if (tt.services[j].id === e.service && feedOf(tt.services[j]) === effFeed) { si = j; break; }
      }
      if (si < 0) continue;
      if (e.added === 1) exAdded = si;
      else if (e.added === 2) exRemoved[si] = true;
    }
  }
  if (best >= 0 && exRemoved[best]) {
    best = -1;
    for (i = 0; i < tt.services.length; i++) {
      var s2 = tt.services[i];
      if (feedOf(s2) !== effFeed) continue;
      if (!exRemoved[i] && ymd >= s2.start && ymd <= s2.end && s2.mask[mi]) best = i;
    }
  }
  if (exAdded >= 0) best = exAdded;
  return best;
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
  feeds.forEach(function (f) {
    svcByFeed[f] = serviceFor(tt, ymd, dow, f);
    prevByFeed[f] = serviceFor(tt, fmtYMD(pd), pd.getDay(), f);
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
          if (t.s !== svcByFeed[tFeed]) {
            if (t.s !== prevByFeed[tFeed]) continue;
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
export { serviceFor };
