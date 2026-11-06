/* live-fusion.js — Phase 2 scaffold: live context for scheduled journeys.
 *
 * The trip planner (raptor.js) runs on scheduled times. This module fuses
 * live vehicle observations into those scheduled journeys, in two phases:
 *
 * Phase 2a (IMPLEMENTED): annotate every bus leg with the number of live
 * vehicles currently reporting on its route. Honest and useful — "3 live"
 * tells the rider their bus is actually out there — with zero fake ETAs.
 *
 * Phase 2b-i (IMPLEMENTED 2026-10-05): delay propagation. Each poll,
 * live-transit.js matches live vehicles to scheduled trips (clear margin or
 * no match), measures the delay, and hands raptor.js an adjusted timetable
 * via setLiveDelays(). plan() reads times through the delay accessors, so
 * legs carry provenance 'live' with delay + data-age metadata. Disrupted
 * trips are flagged, never shifted. Three quiet polls revert to scheduled.
 * Phase 2b-ii (empirical baseline substitution) ships dormant in
 * live-transit.js and activates as timing cells mature.
 *
 *   1. Trip matching: for each vehicle, candidates = scheduled trips on
 *      its route active in the current service window. Score by
 *      (a) headsign/destination agreement, (b) distance from the vehicle's
 *      map-matched position to the trip's expected position at now
 *      (interpolate between the trip's stop times), (c) recency of the
 *      vehicle's position update. Winner needs a clear margin; otherwise
 *      the vehicle stays unmatched (honesty: no match, no claim).
 *   2. Delay: delay = observed arrival − scheduled arrival at the last
 *      confidently matched stop (HMM/Viterbi map matching from
 *      algorithms-assessment.md, tier 1). Clamp to [−5 min, +30 min];
 *      outside that range the trip is marked disrupted, not shifted.
 *   3. Propagation: apply the delay to the trip's remaining stop times for
 *      journey legs that board after now. Do NOT rewrite history.
 *   4. UI: legs with propagated times render solid (live treatment);
 *      scheduled legs keep the distinct scheduled treatment; the TRIP card
 *      shows per-leg data age ("live · 2 min old").
 *   5. Revert: if the vehicle goes quiet for 3 polls, the trip falls back
 *      to scheduled times (same hysteresis as the running-state logic).
 *
 * Phase 3 (multimodal) will add legs of new types here — the leg model
 * already carries everything a bikeshare or rail leg needs.
 */

export function fuseJourneys(journeys, vehicles) {
  var counts = Object.create(null);
  (vehicles || []).forEach(function (v) {
    if (v && v.route_id != null) {
      var rid = String(v.route_id);
      counts[rid] = (counts[rid] || 0) + 1;
    }
  });
  (journeys || []).forEach(function (j) {
    (j.legs || []).forEach(function (l) {
      if (l.type === 'bus') l.liveVehicles = counts[String(l.routeId)] || 0;
    });
  });
  return journeys;
}

// Phase 2b entry point (scaffold): returns journeys unchanged until the
// delay-propagation design above is implemented.
export function propagateDelays(journeys /* , vehicles, timetable, nowSec */) {
  return journeys;
}
