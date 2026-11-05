/**
 * LTD rebuild — timetable binding.
 *
 * The timetable is a runtime dependency, consumed by URL and never
 * vendored into the application: it is republished as feeds refresh,
 * and the build must not freeze it. This module is the whole of the
 * binding contract:
 *
 *   - fetch + shape validation (`loadTimetable`);
 *   - the pairing guard: a timetable whose meta declares
 *     `service_model: "set"` is only ever handed out together with
 *     the service-set resolver below — `bindTimetable` refuses to
 *     pair a set-model timetable with a registry unless the resolver
 *     is attached, and refuses indices the registry cannot name;
 *   - service-set resolution (`servicesFor`): for a feed and a civil
 *     date, the active service ids are (calendar set for that
 *     weekday − exceptions marked removed) ∪ (exceptions marked
 *     added). Exception marks are INTEGERS — 1 means added, 2 means
 *     removed. The legacy bug read the mark for truthiness, and 2 is
 *     truthy: weekday service "returned" on Labor Day, Thanksgiving,
 *     Christmas and New Year. The comparisons here are strict
 *     integer equality, and the tests pin all four dates.
 */

const DATE_RE = /^(\d{4})-?(\d{2})-?(\d{2})$/;

export function parseYmd(ymd) {
  const m = DATE_RE.exec(String(ymd));
  if (!m) throw new Error(`timetable: bad date ${ymd}`);
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

export function formatYmd({ y, mo, d }) {
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(y, 4)}${p(mo, 2)}${p(d, 2)}`;
}

/** Days from civil (Howard Hinnant's algorithm) — timezone-free. */
export function daysFromCivil(y, mo, d) {
  const yy = mo <= 2 ? y - 1 : y;
  const era = Math.floor((yy >= 0 ? yy : yy - 399) / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (mo > 2 ? mo - 3 : mo + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Weekday as a mask index: Monday 0 … Sunday 6 (the feeds' mask order). */
export function weekdayIndex(ymd) {
  const { y, mo, d } = parseYmd(ymd);
  const days = daysFromCivil(y, mo, d);
  // 1970-01-01 (day 0) was a Thursday: Mon-first index 3.
  return (((days + 3) % 7) + 7) % 7;
}

export function validateTimetable(tt) {
  if (!tt || typeof tt !== "object") throw new Error("timetable: not an object");
  for (const key of ["meta", "services", "routes", "trips"]) {
    if (!(key in tt)) throw new Error(`timetable: missing ${key}`);
  }
  if (tt.meta.service_model === "set") {
    if (!Array.isArray(tt.services) || !Array.isArray(tt.service_exceptions)) {
      throw new Error(
        "timetable: service_model 'set' requires services + service_exceptions; " +
          "refusing to vend an unresolvable timetable",
      );
    }
  }
  return tt;
}

export async function loadTimetable(url, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`timetable: ${url} -> HTTP ${res.status}`);
  return validateTimetable(await res.json());
}

/**
 * Active service ids for one feed on one civil date.
 * `feedIndex` selects the feed's services (service.feed in the data).
 */
export function servicesFor(tt, feedIndex, ymd) {
  const day = weekdayIndex(ymd);
  const key = formatYmd(parseYmd(ymd));
  const active = new Set();
  for (const svc of tt.services) {
    if (svc.feed !== feedIndex) continue;
    if (Array.isArray(svc.mask) && svc.mask[day]) active.add(svc.id);
  }
  for (const ex of tt.service_exceptions ?? []) {
    if (formatYmd(parseYmd(ex.date)) !== key) continue;
    const svc = tt.services.find((s) => s.id === ex.service);
    if (!svc || svc.feed !== feedIndex) continue;
    if (ex.added === 1) active.add(ex.service);
    else if (ex.added === 2) active.delete(ex.service);
  }
  return active;
}

/** Active service ids for every feed on one date: Map feed -> Set. */
export function activeServices(tt, ymd) {
  const feeds = [...new Set(tt.services.map((s) => s.feed))].sort();
  return new Map(feeds.map((f) => [f, servicesFor(tt, f, ymd)]));
}

/**
 * Pair a timetable with a registry. The pair is the only supported
 * way to turn a trip's stop entries (registry indices) into stops:
 * indices are validated against the registry's size up front, and
 * `stopForIndex` is the single translation door (the R-04 rule —
 * timetable stop references are page indices, never stop ids; 0 of
 * the registry's feed stops have id == index).
 */
export function bindTimetable(tt, registry) {
  validateTimetable(tt);
  let maxIndex = -1;
  for (const trip of tt.trips) {
    for (const idx of trip.stops) if (idx > maxIndex) maxIndex = idx;
  }
  if (maxIndex >= registry.count) {
    throw new Error(
      `timetable: stop index ${maxIndex} out of range for registry of ${registry.count}`,
    );
  }
  return {
    timetable: tt,
    registry,
    servicesFor: (feedIndex, ymd) => servicesFor(tt, feedIndex, ymd),
    activeServices: (ymd) => activeServices(tt, ymd),
    stopForIndex: (idx) => registry.stopAt(idx),
    routeForTrip: (trip) => tt.routes[trip.r] ?? null,
  };
}
