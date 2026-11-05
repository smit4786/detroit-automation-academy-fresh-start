/**
 * LTD rebuild — live fusion (the planner's live-context module).
 *
 * The binding itself is the resolved issue (R-06): the planner binds
 * this module; on 2026-11-03 a tree shipped without it and every
 * trip plan failed. It is a required module of the planner surface,
 * never an optional enhancement.
 *
 * Two phases, kept separate exactly as the contract of record
 * frames them:
 *
 *   Phase 2a (implemented here): annotate every bus leg with the
 *   number of live vehicles currently reporting on its route
 *   (leg.liveVehicles). Honest and useful — "3 live" tells the
 *   rider their bus is actually out there — with zero fake ETAs.
 *
 *   Phase 2b-i (NOT here): per poll, the host matches live vehicles
 *   to scheduled trips and hands the engine an adjusted timetable
 *   via engine.setLiveDelays(); plan() reads times through the
 *   delay accessors, so legs carry provenance 'live' with delay
 *   metadata. The matcher's rules of record (clear margin or no
 *   match; delay clamp [-300 s, +1800 s] with out-of-range trips
 *   marked disrupted, never shifted; three quiet polls revert a
 *   trip to scheduled) belong to the matcher, not to this module.
 *   propagateDelays() is the scaffold entry point: it returns
 *   journeys unchanged, because rewriting journey times here would
 *   double-apply what the engine already applied at plan time.
 */

/** Count live vehicles per route id. Pure; ids compared as strings. */
export function countLiveByRoute(vehicles) {
  const counts = Object.create(null);
  for (const v of vehicles || []) {
    if (v && v.route_id != null) {
      const rid = String(v.route_id);
      counts[rid] = (counts[rid] || 0) + 1;
    }
  }
  return counts;
}

/**
 * Phase 2a: annotate every bus leg of every journey with the number
 * of live vehicles currently reporting on its route. Mutates and
 * returns the journeys array — the host calls this on the presented
 * journey records it retains.
 */
export function fuseJourneys(journeys, vehicles) {
  const counts = countLiveByRoute(vehicles);
  for (const j of journeys || []) {
    for (const leg of j.legs || []) {
      if (leg.type === "bus") leg.liveVehicles = counts[String(leg.routeId)] || 0;
    }
  }
  return journeys;
}

/**
 * The host wrapper: fuse a plan result's journeys against the latest
 * vehicle set. Fusion never breaks planning — a malformed input
 * yields the result back unannotated rather than a throw.
 */
export function applyTripFusion(result, vehicles) {
  try {
    if (result && Array.isArray(result.journeys)) fuseJourneys(result.journeys, vehicles);
  } catch {
    /* fusion is annotation only; planning stands */
  }
  return result;
}

/**
 * Phase 2b entry point (scaffold, as shipped in the source module):
 * delay propagation is the engine's, via the host matcher's
 * setLiveDelays() hand-off at plan time — returns journeys unchanged.
 */
export function propagateDelays(journeys) {
  return journeys;
}
