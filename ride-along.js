/* Ride Along widget — upcoming stops from a bus rider's perspective.
 *
 * Data contracts (matches live-transit.js):
 *   routes: [{ id, name, color, paths: [[[x, z], ...], ...] }]
 *   stops:  [{ id, n (name), x, z, r: [routeId, ...] }]
 *   vehicle: { vehicle_id, route_id, destination, x, z, bearing, speed }
 *
 * Usage:
 *   var widget = RideAlong.create(document.getElementById('ride-along-mount'));
 *   widget.setData({ routes: [...], stops: [...] });
 *   widget.setVehicles([...]);          // live vehicle list
 *   widget.board(vehicleId);            // pick a bus to ride
 *   widget.updateVehicle(vehicle);      // refresh position each poll
 *
 * Optional callbacks (assigned by the host page):
 *   widget.onBoard(vehicleId)  — fired by board(), from any surface.
 *   widget.onAlight(vehicleId) — fired by alight() with the bus left.
 */

(function (global) {
  'use strict';

  // ---- geometry helpers ----

  function dist2(ax, az, bx, bz) {
    var dx = ax - bx, dz = az - bz;
    return dx * dx + dz * dz;
  }

  // Project point (px, pz) onto segment (ax,az)-(bx,bz).
  // Returns { x, z, t, d2 } where t is 0..1 along the segment.
  function projectSegment(px, pz, ax, az, bx, bz) {
    var dx = bx - ax, dz = bz - az;
    var len2 = dx * dx + dz * dz;
    var t = len2 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    var x = ax + t * dx, z = az + t * dz;
    return { x: x, z: z, t: t, d2: dist2(px, pz, x, z) };
  }

  // Flatten a route's paths into one ordered point list with cumulative
  // arc-length. Returns { pts: [[x,z]...], cum: [meters...], total }.
  function flattenPath(route) {
    var pts = [];
    (route.paths || []).forEach(function (path) {
      path.forEach(function (p) { pts.push(p); });
    });
    var cum = [0];
    for (var i = 1; i < pts.length; i++) {
      var dx = pts[i][0] - pts[i - 1][0], dz = pts[i][1] - pts[i - 1][1];
      cum.push(cum[i - 1] + Math.sqrt(dx * dx + dz * dz));
    }
    return { pts: pts, cum: cum, total: cum[cum.length - 1] || 0 };
  }

  // Find the bus's position along the flattened path.
  // Returns { segIndex, arcLen, x, z, pathBearing }.
  function locateOnPath(flat, bx, bz) {
    var best = null;
    for (var i = 0; i < flat.pts.length - 1; i++) {
      var p = projectSegment(bx, bz,
        flat.pts[i][0], flat.pts[i][1],
        flat.pts[i + 1][0], flat.pts[i + 1][1]);
      if (!best || p.d2 < best.d2) {
        var segLen = flat.cum[i + 1] - flat.cum[i];
        best = {
          segIndex: i, d2: p.d2,
          arcLen: flat.cum[i] + p.t * segLen,
          x: p.x, z: p.z,
          dx: flat.pts[i + 1][0] - flat.pts[i][0],
          dz: flat.pts[i + 1][1] - flat.pts[i][1]
        };
      }
    }
    if (best) {
      // Bearing of path direction at this segment (degrees, 0 = north).
      best.pathBearing = (Math.atan2(best.dx, -best.dz) * 180 / Math.PI + 360) % 360;
    }
    return best;
  }

  // Bearing difference in degrees, signed -180..180.
  function bearingDiff(a, b) {
    var d = ((a - b + 540) % 360) - 180;
    return d;
  }

  // ---- stop ordering ----

  // For each stop on the route, compute its arc-length position on the path.
  // Returns [{ stop, arcLen }] sorted by arcLen.
  function stopsAlongPath(flat, stops, routeId) {
    var out = [];
    stops.forEach(function (s) {
      if (!s.r || s.r.indexOf(routeId) < 0) return;
      var loc = locateOnPath(flat, s.x, s.z);
      if (loc) out.push({ stop: s, arcLen: loc.arcLen, x: loc.x, z: loc.z });
    });
    out.sort(function (a, b) { return a.arcLen - b.arcLen; });
    return out;
  }

  // Upcoming stops from the bus's position, in travel direction.
  // direction: +1 = forward along path, -1 = backward.
  function upcomingStops(stopsOnPath, busArcLen, direction, limit) {
    var out = [];
    if (direction > 0) {
      for (var i = 0; i < stopsOnPath.length && out.length < limit; i++) {
        if (stopsOnPath[i].arcLen > busArcLen + 5) out.push(stopsOnPath[i]);
      }
    } else {
      for (var j = stopsOnPath.length - 1; j >= 0 && out.length < limit; j--) {
        if (stopsOnPath[j].arcLen < busArcLen - 5) out.push(stopsOnPath[j]);
      }
    }
    return out;
  }

  // ---- endpoint indication (project 11, WS2) ----
  // Distance + approach state of a vehicle relative to the rider,
  // from the rendered positions and the vehicle's bearing — the
  // same formula the host uses for its direction-aware location
  // default. 'here' within 20 m; else 'approaching' when the bus's
  // heading carries it toward the rider, else 'passed' (heading
  // away — it has gone by, or travels the other way). cls is null
  // when the bearing is unknown. Returns null without a rider fix
  // or a vehicle position.
  function fmtDistM(m) {
    var ft = m * 3.28084;
    if (ft < 1000) return Math.round(ft / 10) * 10 + ' ft';
    return (m / 1609.344).toFixed(1) + ' mi';
  }

  function approachInfo(v, rp) {
    if (!rp || !v || v.x == null || v.z == null) return null;
    var dx = rp.x - v.x, dz = rp.z - v.z;
    var dist = Math.sqrt(dx * dx + dz * dz);
    if (dist <= 20) return { cls: 'here', dist: dist };
    // Route Reverse: a layover-bound bus is at the endpoint.
    if (v.layover) return { cls: 'terminal', dist: dist };
    if (v.bearing == null || isNaN(v.bearing)) return { cls: null, dist: dist };
    // Travel vector for a compass bearing in scene coords (the
    // convention locateOnPath's pathBearing uses): (sin b, -cos b).
    var br = v.bearing * Math.PI / 180;
    var dot = (Math.sin(br) * dx - Math.cos(br) * dz) / dist;
    return { cls: dot >= 0 ? 'approaching' : 'passed', dist: dist };
  }

  // ---- intersections ----

  // Extract street names from a stop name like "Manchester & Woodward".
  // Returns array of street names, or [] if the name is not an intersection.
  function streetsFromStopName(name) {
    if (!name || name.indexOf('&') < 0) return [];
    return name.split('&').map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  // Intersections the bus will pass, derived from upcoming stop names.
  // Returns [{ streets: [...], stopName, arcLen }] deduplicated.
  function upcomingIntersections(upcoming) {
    var seen = {}, out = [];
    upcoming.forEach(function (u) {
      var streets = streetsFromStopName(u.stop.n);
      if (!streets.length) return;
      var key = streets.slice().sort().join('|').toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push({ streets: streets, stopName: u.stop.n, arcLen: u.arcLen });
    });
    return out;
  }

  // ---- widget ----

  // Route identity label — the naming convention (settled 2026-10-11):
  // "Name - Number" ("Greenfield - 10"); when the name equals the id
  // (QLINE) or the id is not numeric, the name stands alone — never
  // "QLINE - QLINE". Twin of routeLabel() in live-transit.js.
  function routeLabel(route) {
    if (!route) return '';
    var name = route.name || route.id;
    if (name === route.id) return name;
    if (/^\d+$/.test(route.id)) return name + ' - ' + route.id;
    return name;
  }

  function RideAlong(mount) {
    this.mount = mount;
    this.routes = [];
    this.stops = [];
    this.vehicles = [];
    this.routeById = {};
    this.flatById = {};
    this.currentVehicleId = null;
    this.timesProvider = null;
    this._bodySig = null;
    // Planner Bus Focus (project 9) host-supplied state. All three are
    // null/false for ordinary Ride Along use; only a planner leg focus
    // sets them. scheduledSpec: the timetable form of a leg with no
    // live bus. focusSpec: the same spec, kept so a lost bus's tile
    // can show its trip's scheduled stops. boardedMissing: the host
    // has declared the boarded bus lost (it owns the threshold).
    // _boardedRec: the last record seen for the boarded vehicle —
    // identity and fix age for the missing view.
    this.scheduledSpec = null;
    this.focusSpec = null;
    this.boardedMissing = false;
    this._boardedRec = null;
    this.onScheduledClose = null;
    // Return & endpoint selection (project 11). returnLabel /
    // onReturnRequest: the host owns the tile-state stack; it sets
    // the label naming the state Return restores (null = no Return
    // control) and receives the tap. riderPos: the rider's rendered
    // position {x, z}, host-supplied for picker distance/approach
    // indication; null without a location fix.
    this.returnLabel = null;
    this.onReturnRequest = null;
    this.riderPos = null;
    this.render();
  }

  RideAlong.prototype.setData = function (data) {
    this.routes = data.routes || [];
    this.stops = data.stops || [];
    var self = this;
    this.routeById = {};
    this.flatById = {};
    this.routes.forEach(function (r) {
      self.routeById[r.id] = r;
      self.flatById[r.id] = flattenPath(r);
    });
    this.renderPicker();
  };

  RideAlong.prototype.setVehicles = function (vehicles) {
    this.vehicles = vehicles || [];
    var cur = this.currentVehicle();
    if (cur) this._boardedRec = cur;
    this.renderPicker();
    if (this.currentVehicleId) this.refresh();
  };

  // Optional host hook: fn(vehicle) -> { byStop, onlyIds, note } | null.
  // Supplies per-stop times for the ride view and — when the host has
  // matched the vehicle to its scheduled trip — the trip's remaining
  // stop ids (onlyIds), so the list is the trip's own remaining
  // sequence. Absent or null-returning: the view renders as before.
  RideAlong.prototype.setTimesProvider = function (fn) {
    this.timesProvider = fn || null;
  };

  // Host-supplied rider position (rendered/projected coords), for
  // the picker's distance + approach indication. Null clears it.
  // The picker re-renders so the indication tracks the fix.
  RideAlong.prototype.setRiderPos = function (x, z) {
    this.riderPos = (x == null || z == null) ? null : { x: x, z: z };
    this.renderPicker();
  };

  // The host's Return stack names its top state here; the ride,
  // missing, and scheduled views render the control while a label
  // is set. Re-rendering goes through refresh(), whose signature
  // gate leaves the DOM untouched when nothing visible changed.
  RideAlong.prototype.setReturnLabel = function (text) {
    var t = text || null;
    if (this.returnLabel === t) return;
    this.returnLabel = t;
    if (this.currentVehicleId || this.boardedMissing || this.scheduledSpec) this.refresh();
  };

  RideAlong.prototype._returnBtn = function () {
    if (!this.returnLabel) return null;
    var self = this;
    var b = el('button', 'ra-return', '\u21A9 ' + this.returnLabel);
    b.type = 'button';
    b.addEventListener('click', function () {
      if (typeof self.onReturnRequest === 'function') {
        try { self.onReturnRequest(); } catch (e) {}
      }
    });
    return b;
  };

  // Transfer routes serving a stop, as display labels. Reads the stop
  // record's r[] — the registry record at the stop's index (S1).
  RideAlong.prototype.transferLabels = function (stop, currentRouteId) {
    if (!stop || !stop.r) return [];
    var seen = {}, routes = [];
    for (var i = 0; i < stop.r.length; i++) {
      var rid = stop.r[i];
      if (rid === currentRouteId || seen[rid]) continue;
      var route = this.routeById[rid];
      if (!route) continue;
      seen[rid] = true;
      routes.push(route);
    }
    routes.sort(function (a, b) {
      var an = a.name || a.id, bn = b.name || b.id;
      if (an !== bn) return an < bn ? -1 : 1;
      var ai = parseFloat(a.id), bi = parseFloat(b.id);
      if (!isNaN(ai) && !isNaN(bi)) return ai - bi;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
    return routes.map(routeLabel);
  };

  RideAlong.prototype.board = function (vehicleId) {
    var prevVid = this.currentVehicleId;
    this.currentVehicleId = vehicleId;
    // A real board supersedes any planner-focus scheduled view.
    this.scheduledSpec = null;
    this.boardedMissing = false;
    var rec = this.currentVehicle();
    if (rec) this._boardedRec = rec;
    this.refresh();
    // Rebuild the picker so the <select> shows the boarded bus. refresh()
    // renders only the ride body; without this, a programmatic board
    // (the host's selection state, not the dropdown) leaves the select
    // displaying "-- choose a bus --" until the next setVehicles
    // re-render — the widget looks un-boarded while it is riding.
    this.renderPicker();
    if (typeof this.onBoard === 'function') {
      // prevVid: the board this one replaced (project 11 — the host's
      // Return stack is built from it).
      try { this.onBoard(vehicleId, prevVid); } catch (e) {}
    }
  };

  RideAlong.prototype.alight = function () {
    var prev = this.currentVehicleId;
    this.currentVehicleId = null;
    this.scheduledSpec = null;
    this.focusSpec = null;
    this.boardedMissing = false;
    this._boardedRec = null;
    this.render();
    this.renderPicker();
    if (prev && typeof this.onAlight === 'function') {
      try { this.onAlight(prev); } catch (e) {}
    }
  };

  RideAlong.prototype.updateVehicle = function (vehicle) {
    var i = this.vehicles.findIndex(function (v) {
      return v.vehicle_id === vehicle.vehicle_id;
    });
    if (i >= 0) {
      // Host annotations ride the seam's copies, not the raw feed
      // records the position push carries: keep the last asserted
      // gate state (candidate C3) and binding label across a push,
      // or the tile's statements flicker on the 5 s cadence. The
      // next poll's setVehicles re-asserts them from the seam.
      var prev = this.vehicles[i];
      if (prev.gateClosed && vehicle.gateClosed == null) vehicle.gateClosed = true;
      if (prev.destination && vehicle.destination == null) vehicle.destination = prev.destination;
      if (prev.layover && vehicle.layover == null) vehicle.layover = true;
      this.vehicles[i] = vehicle;
    }
    else this.vehicles.push(vehicle);
    if (vehicle.vehicle_id === this.currentVehicleId) {
      this._boardedRec = vehicle;
      this.refresh();
    }
  };

  RideAlong.prototype.currentVehicle = function () {
    var id = this.currentVehicleId;
    return this.vehicles.find(function (v) { return v.vehicle_id === id; }) || null;
  };

  RideAlong.prototype.refresh = function () {
    var v = this.currentVehicle();
    if (!v) {
      // Planner Bus Focus states take precedence over the bare
      // picker: a boarded bus the host has declared lost keeps its
      // identity and its trip's scheduled stops; a scheduled focus
      // with nothing boarded keeps its timetable view. Ordinary use
      // (neither set) renders the picker exactly as before.
      if (this.currentVehicleId && this.boardedMissing) { this.renderMissing(); return; }
      if (!this.currentVehicleId && this.scheduledSpec) { this.renderScheduled(); return; }
      this.render(); return;
    }
    var route = this.routeById[v.route_id];
    var flat = this.flatById[v.route_id];
    if (!route || !flat || !flat.pts.length) { this.renderEmpty(v); return; }

    var loc = locateOnPath(flat, v.x, v.z);
    if (!loc) { this.renderEmpty(v); return; }

    // Travel direction: compare vehicle bearing to path bearing.
    var direction = 1;
    if (v.bearing != null && !isNaN(v.bearing)) {
      direction = Math.abs(bearingDiff(v.bearing, loc.pathBearing)) <= 90 ? 1 : -1;
    }

    var onPath = stopsAlongPath(flat, this.stops, v.route_id);
    var upcoming = upcomingStops(onPath, loc.arcLen, direction, 12);
    // The stop the bus most recently passed (or is standing at), so
    // the rider's own position along the sequence can be marked.
    var prevStop = null;
    if (direction > 0) {
      for (var pi = 0; pi < onPath.length; pi++) {
        if (onPath[pi].arcLen <= loc.arcLen + 5) prevStop = onPath[pi]; else break;
      }
    } else {
      for (var pj = 0; pj < onPath.length; pj++) {
        if (onPath[pj].arcLen >= loc.arcLen - 5) { prevStop = onPath[pj]; break; }
      }
    }
    // Host stop times: when the provider returns the matched trip's
    // remaining stop ids, the upcoming list becomes exactly that
    // sequence. A filter that would empty the list is ignored — an id
    // space mismatch must never blank the rider's stops.
    var tp = null;
    if (this.timesProvider) { try { tp = this.timesProvider(v); } catch (e) { tp = null; } }
    // Route Reverse terminal states (specification sections 2.2-2.3):
    // a layover tile and an at-terminal tile are their own views, not
    // the en-route view wearing a geometric sequence.
    if (tp && tp.layover) { this.renderLayover(v, route, tp); return; }
    if (tp && tp.atTerminal) { this.renderTerminal(v, route, tp); return; }
    if (tp && tp.seqIds && tp.seqIds.length) {
      // Bound tile: the sequence is the trip's own remaining stops, in
      // trip order — in a terminal loop the geometric order and the
      // trip order disagree, which is the founding defect. Any stop
      // the registry lacks falls back to the id filter below.
      var byStopId = {};
      onPath.forEach(function (u) { byStopId[String(u.stop.id)] = u; });
      var seqd = [];
      for (var si = 0; si < tp.seqIds.length; si++) {
        var su = byStopId[String(tp.seqIds[si].id)];
        if (!su) { seqd = null; break; }
        seqd.push(su);
      }
      if (seqd && seqd.length) upcoming = seqd;
      else if (tp.onlyIds) {
        var filtered2 = upcoming.filter(function (u) { return tp.onlyIds[String(u.stop.id)]; });
        if (filtered2.length) upcoming = filtered2;
      }
    } else if (tp && tp.onlyIds) {
      var filtered = upcoming.filter(function (u) { return tp.onlyIds[String(u.stop.id)]; });
      if (filtered.length) upcoming = filtered;
    }
    var intersections = upcomingIntersections(upcoming);
    this.renderRide(v, route, upcoming, intersections, direction, prevStop, loc.arcLen, tp);
  };

  // ---- rendering ----

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Candidate C3 (project 13): the host marks the boarded
  // vehicle's record gateClosed when the rider's own filters have
  // switched its route off mid-ride. The ride keeps tracking —
  // the session is the rider's, not the filter's — but the
  // divergence is stated in the tile, with the remedy named,
  // never left silent.
  function gateNoteEl(v) {
    if (!v || !v.gateClosed) return null;
    return el('p', 'ra-note',
      'This route is off in your filters, so the bus and its stops are hidden on the map. ' +
      'Your ride keeps tracking; turn the route on in Filters to see it on the map again.');
  }

  // ---- Planner Bus Focus (project 9): scheduled + missing views ----
  // A spec is the host's scheduled form of one planner leg:
  // { routeId, headsign, basis: 'scheduled'|'typical',
  //   stops: [{ id, name, label }] } with stop times pre-formatted by
  // the host — the widget stays clock-agnostic for stop times, as
  // with the times provider's labels.

  function fmtClock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
  }

  // The spec's stop sequence: optionally a next-card for the first
  // stop (the boarding stop of a scheduled focus), then the list —
  // the last stop is the rider's alight stop and says so.
  function appendSpecStops(wrap, spec, boardFirst, secTitle) {
    if (!spec || !spec.stops || !spec.stops.length) return;
    var stops = spec.stops;
    if (boardFirst) {
      var first = stops[0];
      var card = el('div', 'ra-next');
      card.appendChild(el('div', 'ra-next-kicker', 'Board here'));
      card.appendChild(el('div', 'ra-next-name', first.name));
      if (first.label) card.appendChild(el('div', 'ra-next-time', first.label));
      wrap.appendChild(card);
      stops = stops.slice(1);
      if (!stops.length) return;
    }
    var sec = el('div', 'ra-sec');
    sec.appendChild(el('div', 'ra-sec-h', secTitle));
    var list = el('div', 'ra-stops');
    stops.forEach(function (s, i) {
      var last = i === stops.length - 1;
      var row = el('div', 'ra-stop');
      row.appendChild(el('span', 'ra-stop-dot' + (last ? ' end' : '')));
      row.appendChild(el('span', 'ra-stop-name', s.name + (last ? ' · get off' : '')));
      if (s.label) row.appendChild(el('span', 'ra-time', s.label));
      list.appendChild(row);
    });
    sec.appendChild(list);
    wrap.appendChild(sec);
  }

  RideAlong.prototype.setFocusSpec = function (spec) {
    this.focusSpec = spec || null;
    if (this.boardedMissing) this.refresh();
  };

  RideAlong.prototype.setBoardedMissing = function (on) {
    this.boardedMissing = !!on;
    if (this.currentVehicleId) this.refresh();
  };

  RideAlong.prototype.showScheduled = function (spec) {
    if (!spec) { this.clearScheduled(); return; }
    this.scheduledSpec = spec;
    this.currentVehicleId = null;
    this.boardedMissing = false;
    this.render();
    this.renderScheduled();
  };

  RideAlong.prototype.clearScheduled = function () {
    if (!this.scheduledSpec) return;
    this.scheduledSpec = null;
    this.render();
    this.renderPicker();
  };

  // The timetable form of a focused leg: headed Scheduled, the stops
  // the rider will pass, no live position claimed anywhere. Built and
  // committed exactly like renderRide — a fragment whose textContent
  // is the signature _commitBody gates on.
  RideAlong.prototype.renderScheduled = function () {
    var host = this.mount.querySelector('#ra-body');
    if (!host || !this.scheduledSpec) return;
    var spec = this.scheduledSpec;
    var route = spec.routeId ? this.routeById[spec.routeId] : null;
    var title = (route ? routeLabel(route) : ('Route ' + spec.routeId)) +
      (spec.headsign ? ' · ' + spec.headsign : '');
    var self = this;
    var frag = document.createElement('div');
    var head = el('div', 'ra-head');
    var dot = el('i', 'ra-dot');
    dot.style.background = (route && route.color) || '#9F9F9F';
    head.appendChild(dot);
    head.appendChild(el('b', 'ra-route', title));
    frag.appendChild(head);
    frag.appendChild(el('p', 'ra-bus', 'Scheduled'));
    frag.appendChild(el('p', 'ra-note',
      'No live bus is on this trip yet. These are the ' +
      (spec.basis === 'typical' ? 'typical' : 'scheduled') +
      ' stops for your trip; the view switches to the live bus when it starts reporting.'));
    appendSpecStops(frag, spec, true, 'Upcoming stops');
    var rBtnS = this._returnBtn();
    if (rBtnS) frag.appendChild(rBtnS);
    var close = el('button', 'ra-leave', 'Close view');
    close.type = 'button';
    close.addEventListener('click', function () {
      self.clearScheduled();
      if (typeof self.onScheduledClose === 'function') {
        try { self.onScheduledClose(); } catch (e) {}
      }
    });
    frag.appendChild(close);
    this._commitBody(host, frag);
  };

  // The boarded bus has stopped reporting: keep its identity, state
  // the fact and the age of the last report, and keep the rider's
  // stops in view in their scheduled form. Nothing here extrapolates
  // a position the bus never reported.
  RideAlong.prototype.renderMissing = function () {
    var host = this.mount.querySelector('#ra-body');
    if (!host) return;
    var rec = this._boardedRec || {};
    var route = rec.route_id ? this.routeById[rec.route_id] : null;
    var title = route ? routeLabel(route) : (rec.route_id ? 'Route ' + rec.route_id : 'Bus');
    var ageMin = null, when = '';
    if (rec.updated_at) {
      var ageMs = Date.now() - new Date(rec.updated_at).getTime();
      if (isFinite(ageMs) && ageMs >= 0) ageMin = Math.floor(ageMs / 60000);
      when = fmtClock(rec.updated_at);
    }
    var ageTxt = ageMin == null ? '' : (ageMin < 1 ? 'just now' :
      (ageMin === 1 ? '1 min ago' : ageMin + ' min ago'));
    var self = this;
    var frag = document.createElement('div');
    var head = el('div', 'ra-head');
    var dot = el('i', 'ra-dot');
    dot.style.background = (route && route.color) || '#9F9F9F';
    head.appendChild(dot);
    head.appendChild(el('b', 'ra-route', title));
    frag.appendChild(head);
    frag.appendChild(el('p', 'ra-bus', 'Bus ' + this.currentVehicleId));
    var gnM = gateNoteEl(rec);
    if (gnM) frag.appendChild(gnM);
    frag.appendChild(el('p', 'ra-note',
      'This bus has stopped reporting.' +
      (when ? ' Last reported ' + when + (ageTxt ? ' · ' + ageTxt : '') + '.' : '')));
    if (this.focusSpec) appendSpecStops(frag, this.focusSpec, false, 'Scheduled stops for its trip');
    var rBtnM = this._returnBtn();
    if (rBtnM) frag.appendChild(rBtnM);
    var leave = el('button', 'ra-leave', 'Get off this bus');
    leave.type = 'button';
    leave.addEventListener('click', function () { self.alight(); });
    frag.appendChild(leave);
    this._commitBody(host, frag);
  };

  RideAlong.prototype.render = function () {
    this._bodySig = null;
    this.mount.innerHTML = '';
    var wrap = el('div', 'ra-wrap');
    wrap.appendChild(el('h3', 'ra-title', 'Ride Along'));
    wrap.appendChild(el('p', 'ra-hint', 'Pick a bus to see upcoming stops from the rider\u2019s seat.'));
    var picker = el('div', 'ra-picker'); picker.id = 'ra-picker';
    wrap.appendChild(picker);
    var body = el('div', 'ra-body'); body.id = 'ra-body';
    wrap.appendChild(body);
    this.mount.appendChild(wrap);
    this.renderPicker();
  };

  // Route Reverse S2 — the layover view: the bus has arrived, its
  // next trip is assigned, and the tile says exactly that.
  RideAlong.prototype.renderLayover = function (v, route, tp) {
    var host = this.mount.querySelector('#ra-body');
    if (!host) return;
    var lay = tp.layover;
    var body = document.createElement('div');
    var head = el('div', 'ra-head');
    var dot = el('i', 'ra-dot');
    dot.style.background = route.color || '#9F9F9F';
    head.appendChild(dot);
    head.appendChild(el('b', 'ra-route', routeLabel(route)));
    if (v.destination) head.appendChild(el('span', 'ra-dest', '\u2192 ' + v.destination));
    body.appendChild(head);
    body.appendChild(el('p', 'ra-bus', 'Bus ' + v.vehicle_id));
    var gnL = gateNoteEl(v);
    if (gnL) body.appendChild(gnL);
    body.appendChild(el('p', 'ra-here', 'At ' + lay.terminal + ' \u00b7 end of the line'));
    var card = el('div', 'ra-next');
    card.appendChild(el('p', 'ra-next-kicker', 'Next departure'));
    card.appendChild(el('p', 'ra-next-name', lay.terminal));
    var streets = streetsFromStopName(lay.terminal);
    if (streets.length > 1) {
      card.appendChild(el('p', 'ra-next-x', 'Intersection of ' + streets.join(' and ')));
    }
    card.appendChild(el('p', 'ra-next-time',
      lay.departClock + (lay.headsign ? ' \u00b7 toward ' + lay.headsign : '')));
    body.appendChild(card);
    var rest = [];
    if (tp.seqIds) {
      for (var i = 0; i < tp.seqIds.length; i++) {
        if (lay.originId && String(tp.seqIds[i].id) === String(lay.originId)) continue;
        rest.push(tp.seqIds[i]);
      }
    }
    if (rest.length) {
      body.appendChild(el('h4', 'ra-sub', 'Next trip \u2014 upcoming stops'));
      var list = el('ol', 'ra-stops');
      rest.slice(0, 11).forEach(function (s) {
        var li = el('li', 'ra-stop', s.name);
        var t = tp.byStop ? tp.byStop[String(s.id)] : null;
        if (t) li.appendChild(el('span', 'ra-time', ' \u00b7 ' + t));
        list.appendChild(li);
      });
      body.appendChild(list);
    }
    if (tp.note) body.appendChild(el('p', 'ra-note', tp.note));
    var rBtnL = this._returnBtn();
    if (rBtnL) body.appendChild(rBtnL);
    var leaveL = el('button', 'ra-leave', 'Get off this bus');
    leaveL.type = 'button';
    var selfL = this;
    leaveL.addEventListener('click', function () { selfL.alight(); });
    body.appendChild(leaveL);
    this._commitBody(host, body);
  };
  // Route Reverse S3 — at the terminal, unbound: the bus has reached
  // the end of its run and no next trip is assigned. No sequence is
  // invented for it.
  RideAlong.prototype.renderTerminal = function (v, route, tp) {
    var host = this.mount.querySelector('#ra-body');
    if (!host) return;
    var body = document.createElement('div');
    var head = el('div', 'ra-head');
    var dot = el('i', 'ra-dot');
    dot.style.background = route.color || '#9F9F9F';
    head.appendChild(dot);
    head.appendChild(el('b', 'ra-route', routeLabel(route)));
    if (v.destination) head.appendChild(el('span', 'ra-dest', '\u2192 ' + v.destination));
    body.appendChild(head);
    body.appendChild(el('p', 'ra-bus', 'Bus ' + v.vehicle_id));
    var gnT = gateNoteEl(v);
    if (gnT) body.appendChild(gnT);
    body.appendChild(el('p', 'ra-here', 'At ' + tp.atTerminal + ' \u00b7 end of the line'));
    if (tp.note) body.appendChild(el('p', 'ra-note', tp.note));
    var rBtnT = this._returnBtn();
    if (rBtnT) body.appendChild(rBtnT);
    var leaveT = el('button', 'ra-leave', 'Get off this bus');
    leaveT.type = 'button';
    var selfT = this;
    leaveT.addEventListener('click', function () { selfT.alight(); });
    body.appendChild(leaveT);
    this._commitBody(host, body);
  };
  RideAlong.prototype.renderPicker = function () {
    var picker = this.mount.querySelector('#ra-picker');
    if (!picker) return;
    picker.innerHTML = '';
    if (!this.vehicles.length) {
      picker.appendChild(el('p', 'ra-empty', 'No buses reporting right now.'));
      return;
    }
    var sel = el('select', 'ra-select');
    sel.setAttribute('aria-label', 'Choose a bus to ride');
    sel.appendChild(el('option', '', '-- choose a bus --'));
    var self = this;
    // Endpoint indication (project 11, WS2): with a rider fix, each
    // option also names how far the bus is and whether it is
    // approaching or heading away — the two directions of a route
    // stop being identical strings — and buses within 1600 m lead
    // the list nearest-first, so the nearby endpoints the choice is
    // actually among come first. Without a fix, labels and order
    // are exactly the long-standing label sort.
    var labeled = this.vehicles.map(function (v) {
      var route = self.routeById[v.route_id];
      var ai = approachInfo(v, self.riderPos);
      var label = (route ? routeLabel(route) : v.route_id) +
        ' · Bus ' + v.vehicle_id +
        (v.destination ? ' → ' + v.destination : '');
      if (ai) {
        label += ' · ' + fmtDistM(ai.dist);
        if (ai.cls === 'approaching') label += ' · approaching';
        else if (ai.cls === 'passed') label += ' · heading away';
        else if (ai.cls === 'terminal') label += ' · at terminal';
      }
      return { v: v, label: label, dist: ai ? ai.dist : null };
    });
    // Sort by the displayed label with numeric-aware natural ordering, so
    // route numbers order 4, 7, 9, 10, 16 (and 200 before 210) instead of
    // lexicographic 10, 16, 4, 7, 9. Vehicle id is the final tiebreak.
    // The nearby group (dist known, ≤ 1600 m) sorts ahead of it by
    // distance, with the label order as its own tiebreak.
    function labelCmp(a, b) {
      return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }) ||
        String(a.v.vehicle_id).localeCompare(String(b.v.vehicle_id), undefined, { numeric: true });
    }
    labeled.sort(function (a, b) {
      var an = a.dist != null && a.dist <= 1600, bn = b.dist != null && b.dist <= 1600;
      if (an && bn) return (a.dist - b.dist) || labelCmp(a, b);
      if (an) return -1;
      if (bn) return 1;
      return labelCmp(a, b);
    });
    labeled.forEach(function (item) {
      var v = item.v;
      var opt = el('option', '', item.label);
      opt.value = v.vehicle_id;
      if (v.vehicle_id === self.currentVehicleId) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      if (sel.value) self.board(sel.value);
      else self.alight();
    });
    picker.appendChild(sel);
  };

  // Swap a freshly built ride body into #ra-body — but only when the
  // content actually changed. refresh() runs on every poll and on the
  // host's 5 s tracker push; rebuilding unconditionally destroyed the
  // DOM under the rider's finger: scroll gestures died mid-drag when
  // their target nodes were removed, and the card's scroll position
  // reset on every rebuild (field report 2026-10-16, "Ride along tile
  // scroll broken"). An unchanged content signature leaves the DOM,
  // the scroll offset, and any in-flight gesture untouched; a changed
  // one swaps with the card's scrollTop preserved (the browser clamps
  // it to the new content height).
  RideAlong.prototype._commitBody = function (host, frag) {
    var sig = frag.textContent;
    if (this._bodySig === sig && host.childNodes.length) return;
    this._bodySig = sig;
    var card = null;
    if (this.mount && this.mount.closest) {
      try { card = this.mount.closest('.bus-card'); } catch (e) {}
    }
    var prevTop = card ? card.scrollTop : null;
    host.innerHTML = '';
    while (frag.childNodes.length) host.appendChild(frag.childNodes[0]);
    if (card && prevTop != null) card.scrollTop = prevTop;
  };

  RideAlong.prototype.renderEmpty = function (v) {
    var body = this.mount.querySelector('#ra-body');
    if (!body) return;
    var frag = document.createElement('div');
    frag.appendChild(el('p', 'ra-empty',
      'Bus ' + v.vehicle_id + ' is on route ' + (this.routeById[v.route_id] ? routeLabel(this.routeById[v.route_id]) : v.route_id) +
      ', but the route path is not loaded yet.'));
    // Return (project 11): this boarded state has no Get off (the
    // bus cannot be placed on its path), so Return is the rider's
    // way back to the replaced state — render it like every other
    // boarded view. Caught by the 0342 production drive: a boarded
    // off-path bus showed neither control.
    var rBtnX = this._returnBtn();
    if (rBtnX) frag.appendChild(rBtnX);
    this._commitBody(body, frag);
  };

  RideAlong.prototype.renderRide = function (v, route, upcoming, intersections, direction, prevStop, busArcLen, tp) {
    var host = this.mount.querySelector('#ra-body');
    if (!host) return;
    var body = document.createElement('div');

    var head = el('div', 'ra-head');
    var dot = el('i', 'ra-dot');
    dot.style.background = route.color || '#9F9F9F';
    head.appendChild(dot);
    head.appendChild(el('b', 'ra-route', routeLabel(route)));
    if (v.destination) head.appendChild(el('span', 'ra-dest', '→ ' + v.destination));
    body.appendChild(head);
    body.appendChild(el('p', 'ra-bus', 'Bus ' + v.vehicle_id +
      (v.speed != null ? ' · ' + Math.round(v.speed) + ' mph' : '')));
    var gn = gateNoteEl(v);
    if (gn) body.appendChild(gn);

    // The rider's position along the sequence: the bus is the rider's
    // vehicle, so its place on the path is the rider's place.
    if (prevStop) {
      body.appendChild(el('p', 'ra-here', Math.abs(busArcLen - prevStop.arcLen) <= 25
        ? 'You are here · at ' + prevStop.stop.n
        : 'You are here · just past ' + prevStop.stop.n));
    }

    if (!upcoming.length) {
      body.appendChild(el('p', 'ra-empty', 'No further stops ahead on this run.'));
      var rBtnE = this._returnBtn();
      if (rBtnE) body.appendChild(rBtnE);
      this._commitBody(host, body);
      return;
    }

    // Next stop card.
    var next = upcoming[0];
    var nextCard = el('div', 'ra-next');
    nextCard.appendChild(el('p', 'ra-next-kicker', 'Next stop'));
    nextCard.appendChild(el('p', 'ra-next-name', next.stop.n));
    var streets = streetsFromStopName(next.stop.n);
    if (streets.length > 1) {
      nextCard.appendChild(el('p', 'ra-next-x',
        'Intersection of ' + streets.join(' and ')));
    }
    var nextTime = tp && tp.byStop ? tp.byStop[String(next.stop.id)] : null;
    if (nextTime) nextCard.appendChild(el('p', 'ra-next-time', nextTime));
    var nextXfer = this.transferLabels(next.stop, v.route_id);
    if (nextXfer.length) nextCard.appendChild(el('p', 'ra-xfer', 'Transfers · ' + nextXfer.join(' · ')));
    body.appendChild(nextCard);

    // Upcoming stops list.
    body.appendChild(el('h4', 'ra-sub', 'Upcoming stops'));
    var list = el('ol', 'ra-stops');
    for (var i = 1; i < upcoming.length; i++) {
      var li = el('li', 'ra-stop', upcoming[i].stop.n);
      var st = streetsFromStopName(upcoming[i].stop.n);
      if (st.length > 1) li.title = 'Intersection of ' + st.join(' and ');
      var rowTime = tp && tp.byStop ? tp.byStop[String(upcoming[i].stop.id)] : null;
      if (rowTime) li.appendChild(el('span', 'ra-time', ' · ' + rowTime));
      var rowXfer = this.transferLabels(upcoming[i].stop, v.route_id);
      if (rowXfer.length) li.appendChild(el('span', 'ra-xfer', 'Transfers · ' + rowXfer.join(' · ')));
      list.appendChild(li);
    }
    body.appendChild(list);

    // No separate intersections list (removed 2026-10-16): it was
    // derived from the upcoming stops' own names (upcomingIntersections
    // reads streetsFromStopName over the same rows), so it repeated the
    // stops list verbatim as street pairs. Every stop row above already
    // carries its full intersection name.

    if (tp && tp.note) body.appendChild(el('p', 'ra-note', tp.note));

    var rBtn = this._returnBtn();
    if (rBtn) body.appendChild(rBtn);
    var leave = el('button', 'ra-leave', 'Get off this bus');
    var self = this;
    leave.addEventListener('click', function () { self.alight(); });
    body.appendChild(leave);
    this._commitBody(host, body);
  };

  global.RideAlong = {
    create: function (mount) { return new RideAlong(mount); },
    // Exposed for unit testing.
    _flattenPath: flattenPath,
    _locateOnPath: locateOnPath,
    _stopsAlongPath: stopsAlongPath,
    _upcomingStops: upcomingStops,
    _streetsFromStopName: streetsFromStopName,
    _upcomingIntersections: upcomingIntersections,
    _approachInfo: approachInfo,
    _fmtDistM: fmtDistM
  };

})(typeof window !== 'undefined' ? window : this);
