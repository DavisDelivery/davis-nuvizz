// lib/routing-driver-resolve-core.mts — WHO DRIVES A LOAD CALLED "VICTOR", AND WHAT TRUCK.
//
// Chad, on the Plan-onto list defaulting his empty VICTOR shell to a 26ft box: "why does the
// system not know victor is a tractor trailer, it should know this from the engine data."
//
// It did know. The MarginIQ employees roster carries vehicleType per driver, the routing
// engine joins every warehouse route to that class through the NuVizz alias, and the Draft
// box resolves a typed "victor" to VICTOR's key and truck class through resolveDraftDriver.
// The Plan-onto list was the one route-building path that never asked: the day's roster rows
// carry a load id, a name, a status and a trip count and nothing else (lib/nuvizz-loads.mts),
// so the client defaulted each load's vehicle from a regex on the NAME — "trailer", "trl" or
// "53" meant tractor, everything else meant box — and an empty shell was sent to the engine
// with no driver at all, so it was sized from fleet averages instead of Victor's own days.
//
// This module answers the question the list should have asked, using the SAME resolver the
// Draft box uses, so a load named VICTOR and a driver typed as "victor" can never disagree
// about who that is or what he drives. PURE: no Firestore, no NuVizz. The endpoint
// (routing-driver-resolve.mts) loads the two inputs and hands them in.
//
// THE RULES, because each is a freight decision and not a string-matching one:
//
//   • A load name is a DRIVER name only when it matches a person exactly — the NuVizz alias,
//     full name, first or last name, or a listed alias — after the trailing load number is
//     dropped ("BEN 2" asks about BEN). Route codes (SUW, ATL, ALPHA) match nobody and are
//     left to the caller's fallback.
//   • NO prefix matching. The Draft box lets Chad type "vic" for Victor; a route code is not a
//     name cut short, and a unique prefix hit ("AL" → ALBERT) would silently size the load to
//     Albert's truck and pin his learned envelope on freight that is not his.
//   • Two people who both answer to the name is NO ANSWER, never the first one found. A
//     second Ben means "BEN 2" keeps the plain fallback and the dispatcher picks the truck,
//     which is the cheap mistake; a 53-footer's capacity put on a box driver's shell is the
//     expensive one.
//   • Truck class comes from the employees roster first, then the engine's hardcoded pin for
//     drivers without a card, then the class the warehouse last saw the driver run — the
//     exact chain the engine's own drafts and shadow plans use (routing-plan-core resolveClass).

import { resolveDraftDriver } from './routing-draft-core.mts';

export type LoadDriverClass = 'tractor' | 'box_truck';

export interface LoadDriverResolution {
  /** the load name as the caller sent it */
  name: string;
  /** what was actually looked up — the name minus its trailing load number */
  query: string;
  driver_key: string;
  driver_user_name: string | null;
  driver_name: string | null;
  truck_class: LoadDriverClass;
  /** driver-days the warehouse holds for this driver before the date asked about */
  observed_days: number;
}

export interface LoadDriverResolveResult {
  /** lower-cased load name → resolution; ABSENT (not null) when the name resolved to nobody */
  resolved: Record<string, LoadDriverResolution>;
  /** lower-cased load name → why it did not resolve (ambiguous / no match / supervisor) */
  reasons: Record<string, string>;
}

/** Bounds. A day's roster is ~100 loads; NuVizz caps a route name at 20 characters. */
export const RESOLVE_MAX_NAMES = 400;
export const RESOLVE_MAX_NAME_LEN = 60;

const keyOf = (name: string) => String(name ?? '').trim().toLowerCase();

/**
 * The driver name a LOAD name is asking about. "BEN 2" → "BEN", "SUW 3" → "SUW",
 * "TRAILER 6" → "TRAILER", "VICTOR" → "VICTOR". A bare number or a load-number-shaped
 * name ("DAVIS000198197", a 24-hex id) asks about nobody and returns ''.
 */
export function loadNameToDriverQuery(name: any): string {
  let s = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  if (/^[a-f0-9]{24}$/i.test(s)) return '';                   // an object id, never a name
  if (/^[A-Z]{2,8}\d{6,}$/i.test(s)) return '';                // a load number (DAVIS000198197)
  // A trailing load ordinal: "BEN 2", "SUW-3", "ALPHA #2", "MITCHELL 02".
  s = s.replace(/\s*[-#]?\s*\d{1,3}$/, '').trim();
  if (!s || /^\d+$/.test(s)) return '';
  return s;
}

const asClass = (v: any): LoadDriverClass => (String(v || '') === 'tractor' ? 'tractor' : 'box_truck');

/**
 * Resolve every load name to a driver + truck class, or say why it could not be.
 * Names are de-duplicated case-insensitively; the result is keyed by the lower-cased name
 * exactly as the client keys its own maps.
 */
export function resolveLoadNames(
  names: any[], employees: any[], driverDaysBefore: any[], asOfDate: string,
): LoadDriverResolveResult {
  const resolved: Record<string, LoadDriverResolution> = {};
  const reasons: Record<string, string> = {};
  const seen = new Set<string>();
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw ?? '').trim();
    const k = keyOf(name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const query = loadNameToDriverQuery(name);
    if (!query) { reasons[k] = 'not a name'; continue; }
    const r = resolveDraftDriver(query, employees || [], driverDaysBefore || [], asOfDate, { allowPrefix: false });
    if (!r.ok) {
      // resolveDraftDriver's errors are written for a typed name ("use the full name");
      // keep the fact, drop the instruction — nobody is typing here.
      reasons[k] = /ambiguous|matches \d+ recent/.test(r.error) ? 'ambiguous' : (/supervisor/.test(r.error) ? 'supervisor' : 'no match');
      continue;
    }
    resolved[k] = {
      name,
      query,
      driver_key: r.driver.driver_key,
      driver_user_name: r.driver.driver_user_name,
      driver_name: r.driver.driver_name,
      truck_class: asClass(r.driver.truck_class),
      observed_days: r.driver.observed_days,
    };
  }
  return { resolved, reasons };
}
