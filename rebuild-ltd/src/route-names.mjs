/**
 * LTD rebuild — route naming (Tranche T6, R-17).
 *
 * The naming convention of record (settled 2026-10-11): every
 * surface that names a route goes through ONE formatter —
 *
 *   "Name - Number"   ("Greenfield - 10", "Fast Michigan - 261")
 *   name only         when the name equals the id (QLINE — never
 *                     "QLINE - QLINE"), when the id is non-numeric
 *                     (the code-registered People Mover pseudo-route
 *                     carries no route number), or as the fallback
 *                     the bare id when no name is registered.
 *
 * Names come from the registry; code-registered pseudo-routes
 * (DPM) register here, never in the registry — the filter, dim,
 * and near-me machinery must never see them (P-70).
 */

export function createRouteNames(registry) {
  const pseudo = new Map(); // id -> name (code-registered, P-70)

  function name(routeId) {
    const id = String(routeId);
    if (pseudo.has(id)) return pseudo.get(id);
    return registry.routeById(id)?.name ?? null;
  }

  function label(routeId) {
    const id = String(routeId);
    const n = name(id);
    if (!n) return id;
    if (n === id) return n;
    if (/^\d+$/.test(id)) return `${n} - ${id}`;
    return n;
  }

  return {
    name,
    label,
    /** Register a code-only pseudo-route (DPM). Not a registry route. */
    registerPseudoRoute(routeId, routeName) {
      pseudo.set(String(routeId), routeName);
    },
    isPseudoRoute(routeId) {
      return pseudo.has(String(routeId));
    },
  };
}
