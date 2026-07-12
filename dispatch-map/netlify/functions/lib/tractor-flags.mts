// lib/tractor-flags.mts
//
// STICKY "a tractor has delivered here" flags per customer location, derived
// entirely from our own Firestore — the MarginIQ `employees` roster (who drives
// a tractor) joined against the immutable history warehouse (who delivered
// where). ZERO NuVizz calls anywhere in this module.
//
// MarginIQ is the single source of truth for the tractor designation: an
// employee doc with vehicleType === 'tractor'. The join key into the warehouse
// is the employee's NuVizz alias (externalIds.nuvizz) — NEVER the display name
// (e.g. roster "Brenton Byrd" runs NuVizz as "Brent Boyd"). Employees with the
// tractor designation but no alias cannot be joined and are skipped (logged).
//
// Layout (flat, mirrors history_customers — single-field auto-indexes only):
//   tractor_locations/{tenant}__{matchKey}
//     { tenant, match_key, business_name, city, first_tractor_date,
//       last_tractor_date, tractor_drivers: [names…], delivery_count,
//       updated_at }
//
// Semantics: STICKY positive. One completed tractor delivery flags the location
// forever; nothing here ever auto-unflags. The rebuild function recomputes every
// doc fresh from the warehouse (idempotent, also the re-tag path when a driver
// gains the Tractor tag later); the daily incremental pass only ever adds.

import { getDoc, setDoc, listDocs } from './firestore.mts';

export const TRACTOR_LOCATIONS_COLLECTION = 'tractor_locations';
const EMPLOYEES_COLLECTION = process.env.MARGINIQ_EMPLOYEES_COLLECTION || 'employees';

export function tractorLocId(tenant: string, matchKey: string): string {
  return `${tenant}__${matchKey}`;
}
export function tractorLocPath(tenant: string, matchKey: string): string {
  return `${TRACTOR_LOCATIONS_COLLECTION}/${tractorLocId(tenant, matchKey)}`;
}

// PURE: normalize a driver name/alias for matching — trim, collapse internal
// whitespace, uppercase. Exported for tests.
export function normalizeDriverAlias(s: any): string {
  return String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export interface TractorRoster {
  aliasSet: Set<string>;                       // normalized NuVizz aliases
  aliasToName: Map<string, string>;            // normalized alias → roster display name
  tractorCount: number;                        // employees carrying the tractor designation
  skippedNoAlias: string[];                    // tractor-tagged employees with no NuVizz alias
}

// ── Generalized vehicle roster ───────────────────────────────────────────────
// driver alias → vehicleType (truck class) for EVERY employee, not just
// tractors. The routing engine joins warehouse routes to a truck class through
// this; the tractor roster below is the vehicleType==='tractor' slice of it.

export interface VehicleRoster {
  aliasToVehicle: Map<string, { vehicleType: string; name: string }>; // normalized alias → class + display name
  employeeCount: number;                                              // employees with any vehicleType
  skippedNoAlias: Array<{ name: string; vehicleType: string }>;       // typed employees with no NuVizz alias
}

// PURE: build the full driver → vehicleType roster from raw employee docs.
export function buildVehicleRoster(employees: any[]): VehicleRoster {
  const aliasToVehicle = new Map<string, { vehicleType: string; name: string }>();
  const skippedNoAlias: Array<{ name: string; vehicleType: string }> = [];
  let employeeCount = 0;
  for (const e of employees || []) {
    const vehicleType = String(e?.vehicleType ?? '').trim();
    if (!vehicleType) continue;
    employeeCount++;
    const alias = normalizeDriverAlias(e?.externalIds?.nuvizz);
    const name = String(e?.fullName || '').trim() || '(unnamed)';
    if (!alias) { skippedNoAlias.push({ name, vehicleType }); continue; }
    aliasToVehicle.set(alias, { vehicleType, name });
  }
  return { aliasToVehicle, employeeCount, skippedNoAlias };
}

// PURE: truck class for a warehouse stop's driver — matches BOTH driverName and
// driverUserName, same rule as stopIsTractorDelivery. Null when unknown.
export function vehicleTypeForStop(stop: any, roster: VehicleRoster): string | null {
  if (!roster || !roster.aliasToVehicle.size) return null;
  const byName = normalizeDriverAlias(stop?.driverName);
  if (byName && roster.aliasToVehicle.has(byName)) return roster.aliasToVehicle.get(byName)!.vehicleType;
  const byUser = normalizeDriverAlias(stop?.driverUserName);
  if (byUser && roster.aliasToVehicle.has(byUser)) return roster.aliasToVehicle.get(byUser)!.vehicleType;
  return null;
}

// PURE: the tractor slice of a vehicle roster (behavior identical to the
// original tractor-only builder).
function tractorSlice(full: VehicleRoster): TractorRoster {
  const aliasSet = new Set<string>();
  const aliasToName = new Map<string, string>();
  for (const [alias, v] of full.aliasToVehicle) {
    if (v.vehicleType !== 'tractor') continue;
    aliasSet.add(alias);
    aliasToName.set(alias, v.name);
  }
  const skippedNoAlias = full.skippedNoAlias.filter((s) => s.vehicleType === 'tractor').map((s) => s.name);
  return { aliasSet, aliasToName, tractorCount: aliasSet.size + skippedNoAlias.length, skippedNoAlias };
}

// PURE: build the tractor alias set from raw employee docs. Exported for tests.
export function buildTractorRoster(employees: any[]): TractorRoster {
  return tractorSlice(buildVehicleRoster(employees));
}

// Load rosters from the shared MarginIQ employees collection. Cached briefly
// per function instance — the roster changes rarely. One Firestore list feeds
// both the full vehicle roster and its tractor slice.
const ROSTER_TTL_MS = 10 * 60 * 1000;
let __vehicleRoster: { at: number; roster: VehicleRoster } | null = null;
export async function loadVehicleRoster(force = false): Promise<VehicleRoster> {
  if (!force && __vehicleRoster && Date.now() - __vehicleRoster.at < ROSTER_TTL_MS) return __vehicleRoster.roster;
  const rows = await listDocs(EMPLOYEES_COLLECTION);
  const roster = buildVehicleRoster(rows);
  __vehicleRoster = { at: Date.now(), roster };
  return roster;
}

export async function loadTractorRoster(force = false): Promise<TractorRoster> {
  const roster = tractorSlice(await loadVehicleRoster(force));
  if (roster.skippedNoAlias.length) {
    console.log(`[tractor-flags] ${roster.skippedNoAlias.length} tractor employee(s) skipped — no NuVizz alias: ${roster.skippedNoAlias.join(', ')}`);
  }
  return roster;
}

// PURE: does this warehouse stop record count as a completed tractor delivery?
// Matches BOTH driverName and driverUserName — the warehouse stores both and an
// alias may track either. Exported for tests.
export function stopIsTractorDelivery(stop: any, aliasSet: Set<string>): boolean {
  if (!stop || stop.normalizedStatus !== 'DELIVERED') return false;
  if (!aliasSet || aliasSet.size === 0) return false;
  const byName = normalizeDriverAlias(stop.driverName);
  if (byName && aliasSet.has(byName)) return true;
  const byUser = normalizeDriverAlias(stop.driverUserName);
  return !!byUser && aliasSet.has(byUser);
}

// The matched roster driver name for a counting stop (display name, for the
// tractor_drivers array). Exported for tests.
export function matchedDriverName(stop: any, roster: TractorRoster): string | null {
  const byName = normalizeDriverAlias(stop?.driverName);
  if (byName && roster.aliasSet.has(byName)) return roster.aliasToName.get(byName) || String(stop.driverName).trim();
  const byUser = normalizeDriverAlias(stop?.driverUserName);
  if (byUser && roster.aliasSet.has(byUser)) return roster.aliasToName.get(byUser) || String(stop.driverUserName).trim();
  return null;
}

export interface TractorLocAgg {
  match_key: string;
  business_name: string;
  city: string | null;
  first_tractor_date: string;
  last_tractor_date: string;
  drivers: Set<string>;
  delivery_count: number;
}

// PURE: fold warehouse stop records (any number of days) into per-location
// aggregates using the matching rule. Exported for tests.
export function aggregateTractorStops(
  stops: any[], roster: TractorRoster, into: Map<string, TractorLocAgg> = new Map(),
): Map<string, TractorLocAgg> {
  for (const s of stops || []) {
    if (!stopIsTractorDelivery(s, roster.aliasSet)) continue;
    const mk = s?.customerMatchKey;
    if (!mk) continue;
    const date = String(s?.date || '');
    const driver = matchedDriverName(s, roster);
    let cur = into.get(mk);
    if (!cur) {
      cur = {
        match_key: mk,
        business_name: s?.businessName || '',
        city: s?.city ?? null,
        first_tractor_date: date,
        last_tractor_date: date,
        drivers: new Set<string>(),
        delivery_count: 0,
      };
      into.set(mk, cur);
    }
    if (date && (date < cur.first_tractor_date || !cur.first_tractor_date)) cur.first_tractor_date = date;
    if (date && date > cur.last_tractor_date) {
      cur.last_tractor_date = date;
      // Latest identity wins for display fields.
      cur.business_name = s?.businessName || cur.business_name;
      cur.city = s?.city ?? cur.city;
    }
    if (driver) cur.drivers.add(driver);
    cur.delivery_count++;
  }
  return into;
}

function toDoc(tenant: string, agg: TractorLocAgg): any {
  return {
    tenant,
    match_key: agg.match_key,
    business_name: agg.business_name,
    city: agg.city,
    first_tractor_date: agg.first_tractor_date,
    last_tractor_date: agg.last_tractor_date,
    tractor_drivers: [...agg.drivers].sort(),
    delivery_count: agg.delivery_count,
    updated_at: new Date().toISOString(),
  };
}

// REBUILD write path: each doc is computed fresh from the warehouse, so
// OVERWRITE — no blind accumulation. Bounded concurrency.
export async function writeTractorLocationsFresh(
  tenant: string, aggs: Map<string, TractorLocAgg>, conc = 8,
): Promise<number> {
  const entries = [...aggs.values()];
  let i = 0, written = 0;
  const worker = async () => {
    while (i < entries.length) {
      const agg = entries[i++];
      await setDoc(tractorLocPath(tenant, agg.match_key), toDoc(tenant, agg));
      written++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, entries.length || 1) }, worker));
  return written;
}

// INCREMENTAL day pass: called from the daily history capture with that day's
// warehouse stop records already in memory (same spot as the customer rollup —
// zero extra reads of the warehouse, zero NuVizz calls). Sticky merge: only ever
// widens dates / adds drivers / adds counts, never removes a flag.
//
// Idempotency note: the nightly capture can re-run for the same date (recapture
// bumps capture_version). delivery_count only accumulates when this date is
// NEWER than what the doc has seen (date > last_tractor_date), so a same-day
// recapture can't double-count. Any drift this approximation leaves gets
// corrected by the rebuild, which recomputes counts from scratch.
// Kill switch for the nightly writes: set TRACTOR_FLAGS=off on the site to
// stop the daily pass without a code change (flags already written stay put and
// keep painting; they just stop advancing). The manual rebuild function ignores
// this switch — invoking it by hand IS the intent.
export function tractorFlagsDisabled(): boolean {
  return String(process.env.TRACTOR_FLAGS || 'on').toLowerCase() === 'off';
}

export async function updateTractorFlagsForDay(
  tenant: string, date: string, stops: any[],
): Promise<{ matched: number; locations: number; written: number; disabled?: boolean }> {
  if (tractorFlagsDisabled()) {
    console.log('[tractor-flags] TRACTOR_FLAGS=off — daily pass skipped');
    return { matched: 0, locations: 0, written: 0, disabled: true };
  }
  const roster = await loadTractorRoster();
  if (!roster.aliasSet.size) return { matched: 0, locations: 0, written: 0 };
  const dayAggs = aggregateTractorStops(stops, roster);
  if (!dayAggs.size) return { matched: 0, locations: 0, written: 0 };
  let written = 0;
  let matched = 0;
  for (const agg of dayAggs.values()) {
    matched += agg.delivery_count;
    const existing = await getDoc(tractorLocPath(tenant, agg.match_key));
    if (!existing) {
      await setDoc(tractorLocPath(tenant, agg.match_key), toDoc(tenant, agg));
      written++;
      continue;
    }
    const alreadyCounted = String(existing.last_tractor_date || '') >= date;
    const drivers = new Set<string>([...(existing.tractor_drivers || []), ...agg.drivers]);
    const merged = {
      tenant,
      match_key: agg.match_key,
      business_name: date >= String(existing.last_tractor_date || '') ? (agg.business_name || existing.business_name) : existing.business_name,
      city: date >= String(existing.last_tractor_date || '') ? (agg.city ?? existing.city) : existing.city,
      first_tractor_date: [existing.first_tractor_date, agg.first_tractor_date].filter(Boolean).sort()[0] || agg.first_tractor_date,
      last_tractor_date: [existing.last_tractor_date, agg.last_tractor_date].filter(Boolean).sort().pop() || agg.last_tractor_date,
      tractor_drivers: [...drivers].sort(),
      delivery_count: (Number(existing.delivery_count) || 0) + (alreadyCounted ? 0 : agg.delivery_count),
      updated_at: new Date().toISOString(),
    };
    await setDoc(tractorLocPath(tenant, agg.match_key), merged);
    written++;
  }
  console.log(`[tractor-flags] ${date}: ${matched} tractor stop(s) → ${dayAggs.size} location(s), ${written} doc(s) upserted`);
  return { matched, locations: dayAggs.size, written };
}
