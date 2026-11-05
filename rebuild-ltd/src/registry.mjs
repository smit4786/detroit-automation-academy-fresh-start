/**
 * LTD rebuild — stop registry and data-plane loader.
 *
 * The registry is the settled stop universe: every stop the feeds
 * have ever published in the registry's lifetime, in a fixed index
 * order. The index is a contract — the runtime timetable names stops
 * by it — so records are never deleted: a stop dropped by a feed
 * refresh stays, flagged `recon_status: 'phantom'`, and stops new in
 * a refresh append after the index space with `timetable_linked:
 * false`. All index translation between stop ids and timetable
 * indices happens in this module and nowhere else.
 *
 * Data enters two ways: `createRegistry` takes already-parsed data
 * (tests, tooling); `loadDataPlane` fetches the three data files
 * from a caller-supplied base URL (the app passes its own asset
 * base; nothing here hardcodes a path).
 */

export const SEGMENTS = ["ddot", "smart", "qline"];

export function createRegistry({ routes, stops, tokens }) {
  const stopList = stops.stops;
  const byId = new Map();
  const byCode = new Map();
  for (const stop of stopList) {
    byId.set(stop.stop_id, stop);
    if (stop.stop_code) {
      const key = String(stop.stop_code);
      if (!byCode.has(key)) byCode.set(key, []);
      byCode.get(key).push(stop);
    }
  }

  const routeList = [];
  const routeById = new Map();
  const groups = {};
  for (const seg of SEGMENTS) {
    const segment = routes.segments[seg];
    groups[seg] = segment.groups;
    for (const route of segment.routes) {
      routeList.push(route);
      routeById.set(route.id, route);
    }
  }
  const tokenByRoute = tokens ? tokens.tokens : {};

  const registry = {
    count: stopList.length,
    routeCount: routeList.length,
    projection: stops.projection,

    /** The stop at a timetable/registry index. */
    stopAt(idx) {
      return stopList[idx] ?? null;
    },

    /** The registry index of a stop id — the only id->index door. */
    stopIndexFor(stopId) {
      const stop = byId.get(String(stopId));
      return stop ? stop.idx : -1;
    },

    /** The stop id at a registry index — the only index->id door. */
    stopIdAt(idx) {
      const stop = stopList[idx];
      return stop ? stop.stop_id : null;
    },

    stopById(stopId) {
      return byId.get(String(stopId)) ?? null;
    },

    /**
     * Dual-key resolution, the field-defect D-2 contract: a query is
     * a stop_id or the pole-printed stop_code. stop_id wins. When an
     * id match exists but the same string is also another stop's
     * pole code, those stops are surfaced in `code_also` — a code
     * naming a different stop is never silent. Code matches return
     * the first carrier with the rest in `code_also`.
     */
    resolveStop(query) {
      const q = String(query).trim();
      if (!q) return null;
      const idHit = byId.get(q);
      const codeHits = byCode.get(q) ?? [];
      if (idHit) {
        return {
          stop: idHit,
          matched_by: "stop_id",
          code_also: codeHits.filter((s) => s !== idHit),
        };
      }
      if (codeHits.length) {
        return { stop: codeHits[0], matched_by: "stop_code", code_also: codeHits.slice(1) };
      }
      return null;
    },

    /** Stops sharing this stop's facility (bay-cluster siblings). */
    facilitySiblings(stop) {
      return (stop.facility_siblings ?? []).map((id) => byId.get(id)).filter(Boolean);
    },

    /** Stops across the same intersection (token-set siblings). */
    intersectionSiblings(stop) {
      return (stop.intersection_siblings ?? []).map((id) => byId.get(id)).filter(Boolean);
    },

    /**
     * Boarding detail for the intersection twins: which stop across
     * the intersection serves what, and where it stands. Every entry
     * carries `boarding_stop: false` for the twin itself — a leg
     * that boards here must name this stop, never the bare corner.
     */
    intersectionDetail(stop) {
      return stop.intersection_sibling_detail ?? [];
    },

    routeById(routeId) {
      return routeById.get(String(routeId)) ?? null;
    },

    routesInGroup(segment, group) {
      // The asset's groups are arrays of { id, name, routes } objects
      // (T10 amendment DV-T6-1: resolve the group object by id — the
      // original indexing treated the array as an id-keyed map and
      // returned [] / threw).
      const entry = (groups[segment] ?? []).find((g) => g && g.id === group);
      if (!entry) return [];
      const members = new Set((entry.routes ?? []).map(String));
      return routeList.filter((r) => members.has(String(r.id)));
    },

    /** The monochrome token for a route (null for pseudo-routes). */
    tokenFor(routeId) {
      return tokenByRoute[String(routeId)] ?? null;
    },

    /** Every stop served by a route, in registry order. */
    stopsForRoute(routeId) {
      const rid = String(routeId);
      return stopList.filter((s) => s.routes.includes(rid));
    },
  };
  return registry;
}

/**
 * Fetch the data plane from `baseUrl` (no trailing slash). Paths are
 * relative to the caller's base — the module holds no root-absolute
 * reference of its own.
 */
export async function loadDataPlane(baseUrl, fetchImpl = fetch) {
  const read = async (name) => {
    const res = await fetchImpl(`${baseUrl}/${name}`);
    if (!res.ok) throw new Error(`data plane: ${name} -> HTTP ${res.status}`);
    return res.json();
  };
  const [routes, stops, tokens] = await Promise.all([
    read("routes-3d.json"),
    read("stops-registry.json"),
    read("route-tokens.json"),
  ]);
  return createRegistry({ routes, stops, tokens });
}
