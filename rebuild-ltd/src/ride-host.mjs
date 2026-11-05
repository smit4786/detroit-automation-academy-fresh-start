/**
 * M10 host — the wiring between the ride tile and the live stack
 * (clean-room rebuild, Tranche T7).
 *
 * Owns: the ride bindings (matcher state by trip and by vehicle,
 * extended with the layover binding T6 assigned to this tranche —
 * the matcher carries no layover field, so the host derives it: a
 * matched bus whose trip has not yet left its origin in its
 * service frame, sitting at the origin's arc); the stop-times
 * provider (P-53: live estimates are the trip's scheduled times
 * shifted by the measured delay at the 0.6 projection, R-20;
 * QLINE and SMART publish no times to this view, R-29 — their
 * stops list in order); the vehicle seam (predicted slots over raw
 * fixes, P-18; filter-gated with the live commitments exempt —
 * boarded, planner-focused, pending — and the exempt-but-closed
 * marked gateClosed for the tile's gate note, P-57); Planner Bus
 * Focus (P-47); the return stack (P-56, R-35: cap 6, captured
 * before the change it undoes, machinery never pushes, Get off is
 * not Return); the shadow slot (the boarded gate-closed bus keeps
 * its tracker prediction while its map slot is filtered away);
 * pick labels and the nearest-bus default (P-58); and ride
 * activation (P-59).
 */

import { formatClock, DELAY_PROJECTION } from "./engine.mjs";
import { formatDest } from "./bus-card.mjs";

export const QLINE_TIMES_NOTE =
  "QLINE stop times are not published to this view. Stops are listed in order.";
export const SMART_TIMES_NOTE =
  "SMART stop times are not published to this view. Stops are listed in order.";
export const END_OF_RUN_NOTE =
  "This bus has reached the end of its run. Its next trip has not been assigned yet, so stop times are not shown.";
export const UNMATCHED_NOTE =
  "This bus is not matched to a scheduled trip yet, so stop times are not shown. Matching runs every minute while the bus reports a current position.";
export const LAYOVER_NOTE =
  "This bus is between trips at the terminal. Times are its scheduled times for the next trip.";
export const DISRUPTED_NOTE =
  "This bus is off its schedule pattern; the times shown are its scheduled times.";
export const LIVE_TIMES_NOTE =
  "Times are live estimates for this bus: its scheduled trip times, adjusted by its measured delay.";
export const EMPIRICAL_TIMES_NOTE =
  "Times are live estimates for this bus: typical running times for its trip, adjusted by its measured delay.";

export const RETURN_STACK_CAP = 6;
export const PICK_RADIUS_M = 1600;
export const PICK_MAX = 6;
export const NEAREST_DEFAULT_M = 75;
export const TERMINAL_RADIUS_M = 200;
export const TERMINAL_FIX_MAX_AGE_MS = 300000;

/* ---------------------------------------------------------------- */
/* Bindings                                                          */
/* ---------------------------------------------------------------- */

/**
 * createRideBindings({ matcher, tracker, registry, bound })
 * refresh(nowMs) rebuilds the by-trip / by-vehicle maps from the
 * matcher's delay hand-off. A binding is { trip, routeId, state,
 * vehicleId, vehicleKey, frame, frameNowSec, layover } — the
 * { trip, state } core is the shape T6's card and tiles consume;
 * layover is { terminal, originId, departClock, clock, headsign }
 * or null (beta reads layover.clock).
 */
export function createRideBindings({ matcher, tracker, registry, bound }) {
  // Terminal stops per route: the first and last stop of every
  // trip of the route (the pattern set's terminals, read off the
  // trips themselves — the bound pair is the door, per R-24).
  const terminalsByRoute = new Map();
  for (const trip of bound.timetable.trips) {
    if (!trip.stops.length) continue;
    const routeId = bound.routeForTrip(trip)?.id;
    if (routeId == null) continue;
    const list = terminalsByRoute.get(routeId) || [];
    for (const idx of [trip.stops[0], trip.stops[trip.stops.length - 1]]) {
      if (!list.some((t) => t.idx === idx)) {
        const s = registry.stopAt(idx);
        if (s) list.push({ idx, x: s.x, z: s.z, name: s.name });
      }
    }
    terminalsByRoute.set(routeId, list);
  }

  let byTrip = new Map();
  let byVehicle = new Map();

  function refresh(nowMs) {
    byTrip = new Map();
    byVehicle = new Map();
    const frames = matcher.framesFor(new Date(nowMs));
    for (const [trip, e] of matcher.delayMap()) {
      const st = matcher.tripState(trip);
      if (!st || !st.vehicleKey) continue;
      const routeId = bound.routeForTrip(trip)?.id;
      const binding = {
        trip,
        routeId,
        state: { delaySec: e.delaySec, disrupted: e.disrupted, fixStamp: e.fixStamp },
        vehicleId: String(e.vehicleId),
        vehicleKey: st.vehicleKey,
        frame: null,
        frameNowSec: null,
        layover: null,
      };
      const frame = frames.find((f) => f.services.has(trip.s)) || null;
      if (frame) {
        binding.frame = frame;
        binding.frameNowSec = (nowMs - frame.dayStartMs) / 1000;
        if (binding.frameNowSec < trip.dep[0]) {
          const pred = tracker.predict(st.vehicleKey, nowMs);
          if (pred && pred.pathIdx != null && pred.arc != null) {
            const exp = matcher.tripExpected(trip, frame, routeId, pred.pathIdx);
            const firstArc = exp && exp.mapped.length ? exp.mapped[0].arc : null;
            if (firstArc != null && pred.arc <= firstArc + 30) {
              const clock = formatClock(trip.dep[0]);
              binding.layover = {
                terminal: registry.stopAt(trip.stops[0])?.name ?? "the terminal",
                originId: registry.stopIdAt(trip.stops[0]),
                departClock: clock,
                clock,
                headsign: trip.h || "",
              };
            }
          }
        }
      }
      byTrip.set(trip, binding);
      byVehicle.set(binding.vehicleId, binding);
    }
  }

  /**
   * The end-of-run test: a slow bus with a fresh fix standing
   * within 200 m of one of its route's terminal stops.
   */
  function terminalAt(vehicle, nowMs) {
    if (vehicle.speedMph != null && vehicle.speedMph > 2) return null;
    if (vehicle.fixAtMs && nowMs - vehicle.fixAtMs > TERMINAL_FIX_MAX_AGE_MS) return null;
    const terms = terminalsByRoute.get(String(vehicle.routeId));
    if (!terms) return null;
    for (const t of terms) {
      if (Math.hypot(vehicle.x - t.x, vehicle.z - t.z) <= TERMINAL_RADIUS_M) return t.name;
    }
    return null;
  }

  return {
    refresh,
    bindingForTrip: (trip) => byTrip.get(trip) ?? null,
    bindingForVehicle: (vehicleId) => byVehicle.get(String(vehicleId)) ?? null,
    terminalAt,
    terminalsOf: (routeId) => terminalsByRoute.get(String(routeId)) ?? [],
  };
}

/* ---------------------------------------------------------------- */
/* Stop-times provider (P-53)                                        */
/* ---------------------------------------------------------------- */

/**
 * createTimesProvider({ bindings, registry }) -> (vehicle, nowMs)
 * vehicle is the vehicles-service record { vehicleId, agency,
 * routeId, speedMph, fixAtMs, x, z }. Returns the provider result
 * the widget consumes, or null for an agency this view never
 * speaks for. Frame discipline: estimates live in the trip's
 * service frame; a stop whose estimate is more than 30 s gone is
 * not listed (the 30 s grace covers the stop the bus stands at).
 */
export function createTimesProvider({ bindings, registry }) {
  return function timesFor(vehicle, nowMs) {
    const agency = String(vehicle.agency || "").toLowerCase();
    if (agency === "qline") return { byStop: {}, onlyIds: null, note: QLINE_TIMES_NOTE };
    if (agency === "smart") return { byStop: {}, onlyIds: null, note: SMART_TIMES_NOTE };
    if (agency !== "ddot") return null;
    const binding = bindings.bindingForVehicle(vehicle.vehicleId);
    if (!binding) {
      const atTerminal = bindings.terminalAt(vehicle, nowMs);
      if (atTerminal) {
        return { byStop: {}, onlyIds: null, atTerminal, note: END_OF_RUN_NOTE };
      }
      return { byStop: {}, onlyIds: null, note: UNMATCHED_NOTE };
    }
    const { trip, state } = binding;
    const frameNowSec = binding.frameNowSec;
    if (frameNowSec == null) return { byStop: {}, onlyIds: null, note: UNMATCHED_NOTE };
    const layover = binding.layover;
    const byStop = {};
    const onlyIds = {};
    const seqIds = [];
    for (let j = 0; j < trip.stops.length; j++) {
      const eta = layover
        ? j === 0
          ? trip.dep[0]
          : trip.arr[j]
        : trip.arr[j] + (state.disrupted ? 0 : state.delaySec * DELAY_PROJECTION);
      if (eta < frameNowSec - 30) continue;
      const id = registry.stopIdAt(trip.stops[j]);
      if (id == null) continue;
      const dSec = eta - frameNowSec;
      byStop[id] =
        dSec < 45 ? "now" : dSec <= 5400 ? `${Math.round(dSec / 60)} min` : formatClock(eta);
      onlyIds[id] = true;
      seqIds.push({ id, name: registry.stopAt(trip.stops[j])?.name ?? "Stop" });
    }
    if (layover) {
      return {
        byStop,
        onlyIds,
        seqIds,
        layover: {
          terminal: layover.terminal,
          originId: layover.originId,
          departClock: layover.departClock,
          headsign: formatDest(binding.routeId, trip.h),
        },
        note: LAYOVER_NOTE,
      };
    }
    return {
      byStop,
      onlyIds,
      seqIds,
      note: state.disrupted
        ? DISRUPTED_NOTE
        : state.basis === "empirical"
          ? EMPIRICAL_TIMES_NOTE
          : LIVE_TIMES_NOTE,
    };
  };
}

/* ---------------------------------------------------------------- */
/* Planner Bus Focus spec (P-47)                                     */
/* ---------------------------------------------------------------- */

/**
 * The scheduled card for a planner leg: the bound trip's stops
 * from boarding to alighting, the boarding row on its departure
 * time and the rest on arrival times. When the leg's stops are
 * not both on the trip, the card degrades to the leg's own two
 * endpoints — never to nothing.
 */
export function legScheduledSpec(leg, { registry }) {
  const trip = leg.tripRef;
  const basis = leg.provenance === "empirical" ? "typical" : "scheduled";
  const mk = (idx, label) => ({
    id: registry.stopIdAt(idx),
    name: registry.stopAt(idx)?.name ?? "Stop",
    label,
  });
  if (trip && Array.isArray(trip.stops)) {
    const b = trip.stops.indexOf(leg.board);
    const a = trip.stops.indexOf(leg.alight);
    if (b >= 0 && a >= b) {
      const stops = [];
      for (let j = b; j <= a; j++) {
        stops.push(mk(trip.stops[j], formatClock(j === b ? trip.dep[j] : trip.arr[j])));
      }
      return { routeId: leg.routeId, headsign: leg.headsign || trip.h || "", basis, stops };
    }
  }
  return {
    routeId: leg.routeId,
    headsign: leg.headsign || (trip ? trip.h || "" : ""),
    basis,
    stops: [mk(leg.board, formatClock(leg.boardSec)), mk(leg.alight, formatClock(leg.alightSec))],
  };
}

/* ---------------------------------------------------------------- */
/* The vehicle seam (P-18, P-57)                                     */
/* ---------------------------------------------------------------- */

/**
 * Widget records for one poll: predicted slot positions preferred
 * over the raw fix; the boarded / focused / pending vehicles ride
 * through a closed route gate, marked gateClosed so the tile can
 * say so; a bound vehicle's destination is its trip's headsign
 * (Route Reverse consistency).
 */
export function buildRideVehicleRecords({ vehicles, tracker, bindings, routeShown, exemptVids, nowMs }) {
  const out = [];
  for (const v of vehicles || []) {
    const vid = String(v.vehicleId);
    const shown = routeShown(v.routeId);
    if (!shown && !exemptVids.has(vid)) continue;
    const pred = tracker.predict(v.key, nowMs);
    const binding = bindings.bindingForVehicle(vid);
    out.push({
      vehicle_id: vid,
      route_id: v.routeId,
      destination: binding ? binding.trip.h || v.destination : v.destination,
      x: pred && pred.x != null ? pred.x : v.x,
      z: pred && pred.z != null ? pred.z : v.z,
      bearing: pred && pred.headingDeg != null ? pred.headingDeg : v.bearingDeg,
      speed: v.speedMph,
      layover: !!(binding && binding.layover),
      gateClosed: !shown || undefined,
      fixAtMs: v.fixAtMs,
      key: v.key,
    });
  }
  return out;
}

/* ---------------------------------------------------------------- */
/* Pick labels + nearest default (P-58)                              */
/* ---------------------------------------------------------------- */

export function fmtDist(m) {
  const ft = m / 0.3048;
  if (ft < 1000) return `${Math.round(ft / 10) * 10} ft`;
  return `${(m / 1609.344).toFixed(1)} mi`;
}

export function approachClass(rec, ax, az, isTerminal) {
  const dx = rec.x - ax;
  const dz = rec.z - az;
  const dist = Math.hypot(dx, dz);
  if (dist <= 20) return "here";
  if (isTerminal) return "terminal";
  if (rec.bearing == null) return null;
  const b = (rec.bearing * Math.PI) / 180;
  const vx = Math.sin(b);
  const vz = -Math.cos(b);
  const dot = vx * -dx + vz * -dz;
  return dot >= 0 ? "approaching" : "passed";
}

function shortenName(name) {
  return name.length > 24 ? `${name.slice(0, 23)}…` : name;
}

/* ---------------------------------------------------------------- */
/* The host                                                          */
/* ---------------------------------------------------------------- */

/**
 * createRideHost({ widget, bindings, tracker, registry, names,
 *   routeShown, planner = null, timesFor = null,
 *   getRiderPos = null, getCamTarget = null,
 *   intents = {} })
 * intents: { toast(text), follow(vehicleId|null), glideToStop(idx),
 *   glideCamera({position, target, durationMs}), openRideCovered(),
 *   closeRide(), restoreSelection(vehicleId) }
 * The assembly reports camera and selection through noteCamera /
 * noteSelection, tile visibility through setTileVisible, and ride
 * mode through setRideMode; polls arrive through onPoll.
 */
export function createRideHost({
  widget,
  bindings,
  tracker,
  registry,
  names,
  routeShown,
  planner = null,
  timesFor = null,
  getRiderPos = null,
  getCamTarget = null,
  intents = {},
}) {
  let stack = [];
  let muteDepth = 0;
  let focus = null; // { vid, trip, spec }
  let pendingVid = null;
  let pendingFocusVid = null;
  let awaitBoard = false;
  let awaitAbsentPolls = 0;
  let focusMissingPolls = 0;
  let focusDegraded = false;
  let shadow = null;
  let tileVisible = false;
  let rideMode = false;
  let followVid = null;
  let camPos = null;
  let camTgt = null;
  let selVid = null;
  let lastVehicles = [];
  let lastRecords = [];
  let lastNowMs = 0;

  const toast = (t) => intents.toast && intents.toast(t);
  const withMute = (fn) => {
    muteDepth++;
    try {
      return fn();
    } finally {
      muteDepth--;
    }
  };

  if (timesFor) {
    widget.setTimesProvider((rec) => {
      const svc = lastVehicles.find((v) => String(v.vehicleId) === String(rec.vehicle_id));
      return svc ? timesFor(svc, lastNowMs) : null;
    });
  }

  /* ------------------------- return stack ------------------------- */

  function returnLabelFor(s) {
    if (!s) return null;
    if (!s.rideMode) return "Return to your trip plan";
    if (s.focus) {
      return `Return to ${s.focus.vid ? `Bus ${s.focus.vid}` : "your scheduled trip"} · your trip`;
    }
    if (s.vid) return `Return to Bus ${s.vid}`;
    return "Return to choosing a bus";
  }

  function refreshReturnLabel() {
    widget.setReturnLabel(returnLabelFor(stack[stack.length - 1]));
  }

  function pushReturn(vidOverride) {
    const s = {
      vid: vidOverride !== undefined ? vidOverride : widget.currentVehicleId,
      sched: widget.scheduledSpec,
      focus: focus ? { vid: focus.vid, trip: focus.trip, spec: focus.spec } : null,
      missing: focusDegraded,
      rideMode,
      followVId: followVid,
      camPos,
      camTgt,
      scrollTop: widget.scrollTop(),
      selVid,
    };
    stack.push(s);
    if (stack.length > RETURN_STACK_CAP) stack.shift();
    refreshReturnLabel();
    return s;
  }

  function rideReturn() {
    const s = stack.pop();
    refreshReturnLabel();
    if (!s) return false;
    if (!s.rideMode) {
      clearPlannerFocus("return");
      if (intents.closeRide) intents.closeRide();
      return true;
    }
    let failedVid = null;
    withMute(() => {
      clearPlannerFocus("return-restore");
      if (s.focus) {
        focus = { vid: s.focus.vid, trip: s.focus.trip, spec: s.focus.spec };
        widget.setFocusSpec(s.focus.spec);
        if (s.focus.vid) {
          if (!widget.board(s.focus.vid)) pendingFocusVid = s.focus.vid;
          if (s.missing) {
            focusDegraded = true;
            widget.setBoardedMissing(true);
          }
        } else {
          widget.showScheduled(s.focus.spec);
        }
      } else if (s.vid) {
        if (!widget.board(s.vid)) failedVid = s.vid;
      } else {
        if (widget.currentVehicleId) widget.alight();
        widget.clearScheduled();
        if (s.sched) widget.showScheduled(s.sched);
      }
    });
    if (failedVid) {
      withMute(() => widget.alight());
      toast(`Bus ${failedVid} is no longer reporting — can't return to it.`);
    }
    selVid = s.selVid;
    if (intents.restoreSelection) intents.restoreSelection(s.selVid);
    if (s.followVId && s.followVId === s.vid) {
      followVid = s.vid;
      if (intents.follow) intents.follow(s.vid);
    } else if (s.followVId && lastRecords.some((r) => r.vehicle_id === s.followVId)) {
      followVid = s.followVId;
      if (intents.follow) intents.follow(s.followVId);
    } else {
      followVid = null;
      if (intents.follow) intents.follow(null);
      if (s.camPos && s.camTgt && intents.glideCamera) {
        intents.glideCamera({ position: s.camPos, target: s.camTgt, durationMs: 900 });
      }
    }
    widget.setScrollTop(s.scrollTop);
    return true;
  }

  /* --------------------------- focus ------------------------------ */

  function clearPlannerFocus(_source) {
    const focusVid = focus ? focus.vid : null;
    focus = null;
    pendingFocusVid = null;
    awaitBoard = false;
    awaitAbsentPolls = 0;
    focusMissingPolls = 0;
    focusDegraded = false;
    widget.setFocusSpec(null);
    widget.setBoardedMissing(false);
    if (focusVid && widget.currentVehicleId === focusVid) {
      withMute(() => widget.alight());
    } else if (widget.scheduledSpec) {
      widget.clearScheduled();
    }
  }

  function focusPlannerLeg(leg) {
    if (!leg || leg.type !== "bus" || !leg.tripRef) return null;
    const spec = legScheduledSpec(leg, { registry });
    const binding = bindings.bindingForTrip(leg.tripRef);
    const vid = binding ? binding.vehicleId : null;
    pushReturn();
    if (intents.openRideCovered) intents.openRideCovered();
    focus = { vid, trip: leg.tripRef, spec };
    focusMissingPolls = 0;
    focusDegraded = false;
    awaitBoard = false;
    widget.setFocusSpec(spec);
    if (vid) {
      if (widget.vehicles.some((v) => v.vehicle_id === vid)) {
        withMute(() => widget.board(vid));
      } else {
        pendingFocusVid = vid;
      }
    } else {
      widget.showScheduled(spec);
      if (intents.glideToStop) intents.glideToStop(leg.board);
    }
    return { spec, vid };
  }

  function plannerFocusPoll(records) {
    if (!focus) return;
    const j = planner && planner.selected ? planner.selected() : null;
    const stillLeg =
      j && j.legs.some((l) => l.type === "bus" && l.tripRef === focus.trip);
    if (!stillLeg) {
      clearPlannerFocus("journey-changed");
      return;
    }
    if (!focus.vid) {
      const b = bindings.bindingForTrip(focus.trip);
      if (b && b.vehicleId) {
        focus.vid = b.vehicleId;
        if (tileVisible) {
          if (records.some((r) => r.vehicle_id === focus.vid)) {
            withMute(() => widget.board(focus.vid));
          } else {
            pendingFocusVid = focus.vid;
          }
          toast(`Bus ${focus.vid} is now reporting live.`);
        } else {
          awaitBoard = true;
          awaitAbsentPolls = 0;
        }
      }
      return;
    }
    if (awaitBoard) {
      const b = bindings.bindingForTrip(focus.trip);
      if (!b || b.vehicleId !== focus.vid) {
        awaitAbsentPolls++;
        if (awaitAbsentPolls >= 2) {
          focus.vid = null;
          awaitBoard = false;
          awaitAbsentPolls = 0;
        }
      } else {
        awaitAbsentPolls = 0;
      }
      return;
    }
    const present = records.some((r) => r.vehicle_id === focus.vid);
    if (present) {
      focusMissingPolls = 0;
      if (focusDegraded) {
        focusDegraded = false;
        widget.setBoardedMissing(false);
        toast(`Bus ${focus.vid} is reporting again.`);
      }
    } else {
      focusMissingPolls++;
      if (focusMissingPolls >= 2 && !focusDegraded) {
        focusDegraded = true;
        widget.setBoardedMissing(true);
      }
    }
  }

  /* ------------------------ widget callbacks ---------------------- */

  widget.onBoard = (vid, prevVid) => {
    if (muteDepth === 0 && prevVid !== vid) pushReturn(prevVid);
    if (focus && focus.vid !== vid) clearPlannerFocus("manual-board");
    if (muteDepth === 0) {
      followVid = vid;
      if (intents.follow) intents.follow(vid);
    }
  };

  widget.onAlight = (vid) => {
    if (followVid === vid) {
      followVid = null;
      if (intents.follow) intents.follow(null);
    }
    if (focus && focus.vid === vid) clearPlannerFocus("alight");
    if (muteDepth === 0) {
      stack = [];
      widget.setReturnLabel(null);
    }
    updateShadow();
  };

  widget.onReturnRequest = () => rideReturn();
  widget.onScheduledClose = () => clearPlannerFocus("scheduled-closed");

  /* ----------------------------- seam ----------------------------- */

  function exemptVids() {
    const out = new Set();
    if (widget.currentVehicleId) out.add(widget.currentVehicleId);
    if (focus && focus.vid) out.add(focus.vid);
    if (pendingVid) out.add(pendingVid);
    if (pendingFocusVid) out.add(pendingFocusVid);
    return out;
  }

  function seam(nowMs) {
    return buildRideVehicleRecords({
      vehicles: lastVehicles,
      tracker,
      bindings,
      routeShown,
      exemptVids: exemptVids(),
      nowMs,
    });
  }

  function updateShadow() {
    const vid = widget.currentVehicleId;
    if (!vid) {
      shadow = null;
      return;
    }
    const svc = lastVehicles.find((v) => String(v.vehicleId) === vid);
    if (!svc) {
      shadow = null;
      return;
    }
    shadow = !routeShown(svc.routeId) ? svc.key : null;
  }

  function onPoll(nowMs, serviceVehicles) {
    lastNowMs = nowMs;
    lastVehicles = serviceVehicles || [];
    bindings.refresh(nowMs);
    const records = seam(nowMs);
    lastRecords = records;
    widget.setVehicles(records);
    const rp = getRiderPos ? getRiderPos() : null;
    if (rp) widget.setRiderPos(rp.x, rp.z);
    else widget.setRiderPos(null);
    if (pendingVid && records.some((r) => r.vehicle_id === pendingVid)) {
      const vid = pendingVid;
      pendingVid = null;
      widget.board(vid);
    }
    if (pendingFocusVid && records.some((r) => r.vehicle_id === pendingFocusVid)) {
      const vid = pendingFocusVid;
      pendingFocusVid = null;
      withMute(() => widget.board(vid));
    }
    plannerFocusPoll(records);
    updateShadow();
    return records;
  }

  /** The 5 s position push while boarded (P-59): slots only. */
  function pushPositions(nowMs) {
    lastNowMs = nowMs;
    const records = seam(nowMs);
    lastRecords = records;
    widget.setVehicles(records);
    return records;
  }

  /* ------------------------- pick labels -------------------------- */

  function terminalNameFor(rec) {
    const binding = bindings.bindingForVehicle(rec.vehicle_id);
    if (binding && binding.layover) return binding.layover.terminal;
    const svc = lastVehicles.find((v) => String(v.vehicleId) === rec.vehicle_id);
    return svc ? bindings.terminalAt(svc, lastNowMs) : null;
  }

  function pickCandidates(anchor) {
    return lastRecords
      .map((rec) => ({ rec, distM: Math.hypot(rec.x - anchor.x, rec.z - anchor.z) }))
      .filter((c) => c.distM <= PICK_RADIUS_M)
      .sort((a, b) => a.distM - b.distM)
      .slice(0, PICK_MAX);
  }

  function pickLabels() {
    const rp = getRiderPos ? getRiderPos() : null;
    const anchor = rp || (getCamTarget ? getCamTarget() : null);
    if (!anchor) return [];
    return pickCandidates(anchor).map(({ rec, distM }) => {
      const term = terminalNameFor(rec);
      const main = term
        ? `${names.label(rec.route_id)} · at ${shortenName(term)}`
        : rec.destination
          ? `→ ${rec.destination}`
          : names.label(rec.route_id);
      return {
        vehicleId: rec.vehicle_id,
        main,
        sub: rp ? fmtDist(distM) : "",
        cls: approachClass(rec, anchor.x, anchor.z, !!term),
        distM,
      };
    });
  }

  function nearestRideVehicle(anchor) {
    let best = null;
    for (const rec of lastRecords) {
      const distM = Math.hypot(rec.x - anchor.x, rec.z - anchor.z);
      if (distM > NEAREST_DEFAULT_M) continue;
      const cls = approachClass(rec, anchor.x, anchor.z, !!terminalNameFor(rec));
      if (cls === "passed") continue;
      if (!best || distM < best.distM) best = { vehicleId: rec.vehicle_id, distM, cls };
    }
    return best;
  }

  /* -------------------------- activation -------------------------- */

  function chooseFrame(view, anchor) {
    if (view.streetView) return { skip: "street-view" };
    if (view.following) return { skip: "following" };
    if ((view.badgesOnScreen || 0) >= 2 && (view.elevationDeg || 0) >= 20) {
      return { skip: "served" };
    }
    let pts = anchor ? pickCandidates(anchor).map((c) => ({ x: c.rec.x, z: c.rec.z })) : [];
    const rp = getRiderPos ? getRiderPos() : null;
    if (rp) pts.unshift({ x: rp.x, z: rp.z });
    if (!pts.length) {
      const sorted = [...lastRecords]
        .map((r) => ({ r, d: anchor ? Math.hypot(r.x - anchor.x, r.z - anchor.z) : 0 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      pts = sorted.map((s) => ({ x: s.r.x, z: s.r.z }));
    }
    if (!pts.length) return { skip: "no-points" };
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const cz = pts.reduce((a, p) => a + p.z, 0) / pts.length;
    const rad = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.z - cz)));
    const dist = Math.min(6400, Math.max(1100, rad / Math.tan((21 * Math.PI) / 180)));
    return { cx, cz, dist, elevationDeg: 32 };
  }

  function activate({ selectedVehicleId = null, view = {} } = {}) {
    if (selectedVehicleId) {
      const vid = String(selectedVehicleId);
      if (widget.vehicles.some((v) => v.vehicle_id === vid)) {
        widget.board(vid);
        return { action: "board", vid };
      }
      pendingVid = vid;
      return { action: "board-pending", vid };
    }
    const anchor =
      (getRiderPos ? getRiderPos() : null) || (getCamTarget ? getCamTarget() : null);
    const near = anchor ? nearestRideVehicle(anchor) : null;
    if (near) {
      widget.board(near.vehicleId);
      return { action: "board", vid: near.vehicleId };
    }
    return { action: "choose", frame: chooseFrame(view, anchor) };
  }

  function tileShown() {
    tileVisible = true;
    if (awaitBoard && focus && focus.vid) {
      if (lastRecords.some((r) => r.vehicle_id === focus.vid)) {
        withMute(() => widget.board(focus.vid));
      } else {
        pendingFocusVid = focus.vid;
      }
      awaitBoard = false;
      toast(`Bus ${focus.vid} is now reporting live.`);
    }
  }

  return {
    onPoll,
    pushPositions,
    activate,
    focusPlannerLeg,
    clearPlannerFocus,
    rideReturn,
    pickLabels,
    nearestRideVehicle,
    tileShown,
    setTileVisible: (b) => {
      tileVisible = !!b;
    },
    setRideMode: (b) => {
      rideMode = !!b;
    },
    noteCamera: (pos, tgt) => {
      camPos = pos;
      camTgt = tgt;
    },
    noteSelection: (vid) => {
      selVid = vid;
    },
    bindings,
    focus: () => focus,
    stackDepth: () => stack.length,
    stackTop: () => stack[stack.length - 1] || null,
    shadowKey: () => shadow,
    pending: () => ({ vid: pendingVid, focusVid: pendingFocusVid }),
    records: () => lastRecords,
  };
}
