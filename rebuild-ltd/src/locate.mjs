/**
 * LTD rebuild — the locate flow (Tranche T6; P-38, P-39).
 *
 * Coverage: the Detroit street-map bounds (STREET_BOUNDS) are the
 * coverage of record; the wider mosaic bounds count only while
 * the SMART group is displayed — "routes near you" works in the
 * suburbs with SMART enabled and stays Detroit-scoped when it is
 * off. An out-of-coverage fix hides the marker and says so.
 *
 * A successful locate sets the rider's position, shows the
 * you-marker (halo + accuracy ring + "You" badge, badge height
 * 1,250 with a reduced-motion-gated bob), hands the camera move to
 * the host (the bus vantage glide is the camera rig's, T3), and
 * settles near-me: a pending request engages it; an engaged
 * near-me recomputes from the new position (R-31). Denied or
 * unavailable location never reaches this module — the error path
 * and the settled home framing are the host's, unchanged.
 */

import { STREET_BOUNDS, MOSAIC_BOUNDS, toWorld } from "./projection.mjs";

export const YOU_BADGE_Y = 1250;
export const YOU_BADGE_BOB = 70;

export function inCoverage(lat, lon, { smartDisplayed = false } = {}) {
  const inRect = (b) => lat <= b.latN && lat >= b.latS && lon >= b.lonW && lon <= b.lonE;
  if (inRect(STREET_BOUNDS)) return true;
  if (smartDisplayed && inRect(MOSAIC_BOUNDS)) return true;
  return false;
}

export function createLocate({ filters, registry, smartDisplayed = () => false, reducedMotion = () => false }) {
  let userXZ = null;
  let marker = { visible: false, x: null, z: null, accuracyM: null };

  function stopsNearInput() {
    // The registry is the stop source; near-me reads x/z/routes.
    const stops = [];
    for (let i = 0; i < registry.count; i++) {
      const s = registry.stopAt(i);
      if (s) stops.push(s);
    }
    return stops;
  }

  return {
    userXZ: () => userXZ,
    marker: () => ({ ...marker }),
    /** Badge bob offset at time t (ms); zero under reduced motion. */
    badgeBob(tMs) {
      return reducedMotion() ? 0 : YOU_BADGE_BOB * Math.sin(tMs / 650);
    },
    badgeY(tMs) { return YOU_BADGE_Y + this.badgeBob(tMs); },

    /**
     * A fix arrived. Returns the outcome the host executes:
     *   { kind: 'out-of-coverage', toast } — marker hidden, no move
     *   { kind: 'located', x, z, flyTo: true, nearMe: 'engaged' |
     *     'recomputed' | null, toast? }
     */
    located(lat, lon, accuracyM) {
      if (!inCoverage(lat, lon, { smartDisplayed: smartDisplayed() })) {
        marker = { visible: false, x: null, z: null, accuracyM: null };
        return {
          kind: "out-of-coverage",
          toast: { text: "Out of bounds — you are outside DDOT’s Detroit coverage area.", isError: true },
        };
      }
      const [x, z] = toWorld(lat, lon);
      userXZ = [x, z];
      marker = { visible: true, x, z, accuracyM: accuracyM ?? null };
      let nearMe = null;
      let toast = null;
      if (filters.pendingNearMe()) {
        filters.engageNearMe(userXZ, stopsNearInput());
        nearMe = "engaged";
        toast = filters.nearMeToast();
      } else if (filters.state.nearMe) {
        filters.recomputeNearMe(userXZ, stopsNearInput());
        nearMe = "recomputed";
      }
      return { kind: "located", x, z, flyTo: true, nearMe, toast };
    },
  };
}
