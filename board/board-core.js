/* board-core.js — Departure Board computation core (Project 29 successor,
 * web first slice). Pure functions, no DOM: the page (index.html) renders
 * what this module computes, and the verification harness imports the same
 * module in Node.
 *
 * Parity contract (design note §4): DDOT departures are a line-for-line
 * port of computeStopArrivals in live-transit.js (build 20261019-2200),
 * with the two Project-13 UI gates omitted (a fresh app profile passes
 * every route through both) and the live-delay shift behind the
 * delayState parameter — null in this slice, because tripDelayState is
 * produced only inside the map's 3D polling loop and is published
 * nowhere (design note §6). serviceFor / the timetable index come from
 * the app's own raptor.js, injected as R — imported, never re-implemented.
 */

export function detroitParts(whenMs) {
  var o = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Detroit', year: 'numeric', month: 'numeric', day: 'numeric',
    weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23'
  }).formatToParts(new Date(whenMs)).forEach(function (p) { o[p.type] = p.value; });
  return {
    ymd: o.year + String(o.month).padStart(2, '0') + String(o.day).padStart(2, '0'),
    dow: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[o.weekday],
    sec: (+o.hour) * 3600 + (+o.minute) * 60 + (+o.second)
  };
}

/* The app's projection (live-transit.js project()): meters about the
 * shared origin carried identically by all three registry files. */
export function makeProj(projection) {
  var DEG = Math.PI / 180;
  return {
    lat0: projection.lat0, lon0: projection.lon0,
    mLat: 111320, mLon: 111320 * Math.cos(projection.lat0 * DEG)
  };
}
export function projectLatLon(proj, lat, lon) {
  return [(lon - proj.lon0) * proj.mLon, -(lat - proj.lat0) * proj.mLat];
}
export function unproject(proj, x, z) {
  return { lat: proj.lat0 - z / proj.mLat, lon: proj.lon0 + x / proj.mLon };
}

/* The merged stop registry, built exactly as the app's boot merge:
 * DDOT stops, then SMART, then QLINE (indices are load-bearing — the
 * timetable's stop index space is the DDOT segment). SMART routes are
 * recolored uniformly to SMART #808080, as the app's merge does. */
export function buildRegistry(ddot, smart, qline) {
  var stops = [], routesById = {}, routeNames = {}, smartRouteIds = {};
  function addRoutes(data, seg) {
    (data.routes || []).forEach(function (r) {
      var rec = { id: String(r.id), name: r.name || String(r.id),
                  color: seg === 'smart' ? '#313131' : (r.color || '#f2f2f2'), seg: seg };
      routesById[rec.id] = rec;
      routeNames[rec.id] = rec.name;
      if (seg === 'smart') smartRouteIds[rec.id] = true;
    });
  }
  function addStops(data, seg) {
    (data.stops || []).forEach(function (s) {
      var rec = { id: s.id, n: s.n || '', x: s.x, z: s.z, r: (s.r || []).map(String),
                  pm: !!s.pm, seg: seg, idx: stops.length };
      stops.push(rec);
    });
  }
  addRoutes(ddot, 'ddot'); addStops(ddot, 'ddot');
  if (smart && Array.isArray(smart.routes) && smart.routes.length) { addRoutes(smart, 'smart'); addStops(smart, 'smart'); }
  if (qline && Array.isArray(qline.routes) && qline.routes.length) { addRoutes(qline, 'qline'); addStops(qline, 'qline'); }
  return { stops: stops, routesById: routesById, routeNames: routeNames, smartRouteIds: smartRouteIds };
}

/* routeLabel, transcribed from live-transit.js. */
export function routeLabel(routeNames, rid) {
  var name = routeNames[rid];
  if (!name) return String(rid);
  if (name === rid) return name;
  if (/^\d+$/.test(rid)) return name + ' - ' + rid;
  return name;
}

export function nearestStop(stops, proj, lat, lon) {
  var p = projectLatLon(proj, lat, lon);
  var best = null, bd = Infinity;
  for (var i = 0; i < stops.length; i++) {
    var s = stops[i];
    if (s.x == null || s.z == null) continue;
    var d = Math.hypot(s.x - p[0], s.z - p[1]);
    if (d < bd) { bd = d; best = s; }
  }
  return best ? { stop: best, distM: bd } : null;
}

export function searchStops(stops, q, limit) {
  q = String(q || '').trim().toLowerCase();
  if (!q) return [];
  var out = [];
  for (var i = 0; i < stops.length && out.length < (limit || 12); i++) {
    var s = stops[i];
    if (String(s.id).toLowerCase() === q || (s.n && s.n.toLowerCase().indexOf(q) >= 0)) out.push(s);
  }
  return out;
}

export function findStopById(stops, id) {
  id = String(id == null ? '' : id);
  for (var i = 0; i < stops.length; i++) if (String(stops[i].id) === id) return stops[i];
  return null;
}

export function stopServedBySmart(smartRouteIds, st) {
  if (!st || !st.r || !st.r.length) return false;
  for (var i = 0; i < st.r.length; i++) if (smartRouteIds[String(st.r[i])]) return true;
  return false;
}

/* DDOT departures at a timetable stop index — the computeStopArrivals
 * port. delayState: a Map(trip -> {delaySec, vehicleId, disrupted}) in
 * the app's shape, or null (this slice: no live shift; design note §6).
 * Returns {state: 'loading'|'na'|'nosvc'|'ready', rows:[{rid, head,
 * eta (Detroit service-day seconds, possibly > 86400-frame shifted
 * into today), live, bus}]} exactly as the app's function shapes them. */
export function computeDdotDepartures(R, tt, stopData, idx, nowMs, delayState) {
  var DELAY_PROJECTION = 0.6; // rank 5 — the app's constant
  var out = { state: 'ready', rows: [] };
  if (!tt || !R || !R.serviceFor) { out.state = 'loading'; return out; }
  if (idx == null || idx < 0 || idx >= tt.nStops) { out.state = 'na'; return out; }
  var dp = detroitParts(nowMs);
  var dpPrev = detroitParts(nowMs - 86400000);
  var svc = R.serviceFor(tt, dp.ymd, dp.dow);
  var prevSvc = R.serviceFor(tt, dpPrev.ymd, dpPrev.dow);
  if (svc < 0 && prevSvc < 0) { out.state = 'nosvc'; return out; }
  var nowSec = dp.sec;
  var pats = tt.stopPat[idx] || [];
  var rows = [];
  for (var q = 0; q < pats.length; q++) {
    var pat = tt.patterns[pats[q][0]];
    var pos = pats[q][1];
    for (var ti = 0; ti < pat.trips.length; ti++) {
      var t = pat.trips[ti];
      var shift = 0;
      if (t.s !== svc) { if (t.s !== prevSvc) continue; shift = -86400; }
      var arr = t.arrL2 || t.arr;
      var eta = arr[pos] + shift;
      if (eta < nowSec - 30 || eta > nowSec + 3 * 3600) continue;
      var dstate = delayState ? delayState.get(t) : null;
      var isLive = !!(dstate && dstate.vehicleId && !dstate.disrupted);
      if (isLive) {
        eta += dstate.delaySec * DELAY_PROJECTION;
        if (eta < nowSec - 30) continue;
      }
      var head = t.h || '';
      if (!head && pat.stops && pat.stops.length) {
        var term = stopData && stopData[pat.stops[pat.stops.length - 1]];
        head = term ? (term.n || '') : '';
      }
      var routeRec = tt.routes ? tt.routes[pat.route] : null;
      var rowRid = routeRec ? routeRec.id : pat.route;
      rows.push({ rid: rowRid, head: head, eta: eta, live: isLive, bus: isLive ? dstate.vehicleId : null });
    }
  }
  rows.sort(function (a, b) { return a.eta - b.eta; });
  out.rows = rows.slice(0, 5);
  return out;
}

/* --- SMART live times from the per-route trip-updates derivative ---
 * Mirrors the app's ingestSmartTripUpdates + smartTuRowsForStop over
 * live-data/smart-tu/ files (the derivative carries departure-first
 * epochs and a gen+2h window — design note §4). derivByRoute: Map of
 * route id -> parsed derivative file. Returns null when no usable
 * payload exists (stale gen, the app's SMART_TU_STALE_MS rule), else
 * rows [{rid, trip, bus, time (epoch s), delay}] sorted, max 5. */
export var SMART_TU_STALE_MS = 15 * 60 * 1000;
export function smartStopKey(id) {
  var s = String(id == null ? '' : id);
  var i = s.lastIndexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}
export function smartDepartures(derivByRoute, smartRouteIds, st, indexGenSec, nowMs) {
  if (indexGenSec == null || isNaN(indexGenSec)) return null;
  if (nowMs - indexGenSec * 1000 > SMART_TU_STALE_MS) return null;
  if (!stopServedBySmart(smartRouteIds, st)) return null;
  var key = smartStopKey(st.id);
  var nowSec = nowMs / 1000;
  var rows = [];
  st.r.forEach(function (rid) {
    var f = derivByRoute.get(String(rid));
    if (!f || !Array.isArray(f.trips)) return;
    f.trips.forEach(function (tuple) {
      if (!tuple || tuple[4] === 'CANCELED') return;
      var ups = tuple[3] || [];
      for (var i = 0; i < ups.length; i++) {
        var u = ups[i];
        if (smartStopKey(u[0]) !== key) continue;
        var tm = u[1];
        if (tm == null || tm < nowSec - 30 || tm > nowSec + 3 * 3600) continue;
        rows.push({ rid: String(tuple[1] || rid), trip: tuple[0] || '', bus: null, time: tm, delay: (u[2] != null ? u[2] : null) });
      }
    });
  });
  rows.sort(function (a, b) { return a.time - b.time; });
  return rows.slice(0, 5);
}

/* QLINE live streetcars for a stop: vehicles.json agency 'qline',
 * nearest first, with straight-line distance and fix age. The app
 * publishes no QLINE arrival times; this is positions data, labeled. */
export function qlineStreetcars(vehicles, proj, st, nowMs) {
  var out = [];
  (vehicles || []).forEach(function (v) {
    if (!v || v.agency !== 'qline' || v.lat == null || v.lon == null) return;
    var p = projectLatLon(proj, v.lat, v.lon);
    out.push({
      vehicleId: v.vehicle_id || '', distM: Math.hypot(p[0] - st.x, p[1] - st.z),
      ageS: v.updated_at ? Math.max(0, Math.round((nowMs - new Date(v.updated_at).getTime()) / 1000)) : null,
      destination: v.destination || ''
    });
  });
  out.sort(function (a, b) { return a.distM - b.distM; });
  return out;
}

/* The app's time-text rule (renderStopArrivals / SMART rows):
 * 'now' under 45 s, 'in Nm' through 90 min, else the clock string. */
export function timeText(dSec, clockStr) {
  if (dSec < 45) return 'now';
  if (dSec <= 5400) return 'in ' + Math.round(dSec / 60) + 'm';
  return clockStr;
}

/* formatClock12, transcribed (epoch ms -> viewer's clock; the page
 * pins America/Detroit, the service's own timezone). */
export function formatClock12Detroit(ms) {
  var parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Detroit', hour: 'numeric', minute: '2-digit', hour12: true
  }).formatToParts(new Date(ms));
  var h = '', m = '', ap = '';
  parts.forEach(function (p) {
    if (p.type === 'hour') h = p.value;
    if (p.type === 'minute') m = p.value;
    if (p.type === 'dayPeriod') ap = p.value;
  });
  return h + ':' + m + ' ' + ap;
}
