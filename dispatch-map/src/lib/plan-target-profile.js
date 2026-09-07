// src/lib/plan-target-profile.js — WHICH TRUCK A PICKED LOAD DEFAULTS TO (PURE).
//
// Chad, looking at his empty VICTOR shell defaulting to "26ft Box" in Plan onto → My loads:
// "why does the system not know victor is a tractor trailer, it should know this from the
// engine data." The list was defaulting the vehicle from a regex on the load NAME ("trailer",
// "trl", "53" → the tractor profile, anything else → box) because the roster rows it is built
// from carry no driver and no vehicle. The engine knew: the MarginIQ employees roster carries
// vehicleType per driver and every engine path joins through it — except this one.
//
// So the default now has a precedence, and it is a freight precedence, not a code one:
//
//   1. THE DISPATCHER'S PICK on the row's dropdown. A human choosing a truck for a load is the
//      day's fact, whatever the roster usually says — Victor may be on a box today.
//   2. THE DRIVER THE LOAD IS NAMED FOR, resolved by routing-driver-resolve through the same
//      resolver the Draft box uses: an exact-name match to a MarginIQ employee (or the
//      warehouse's history for a driver without a card), and that driver's truck class.
//   3. THE NAME RULE that was here before — "TRAILER 6" is a trailer even though no driver
//      is called Trailer — kept as the fallback for route codes that name nobody.
//   4. The box profile, because unknown reads as the fleet majority; the 53-footer's capacity
//      is the expensive thing to assume.
//
// Pure, so the rule is pinned by test/plan-target-profile.test.mjs rather than by reading the
// Setup panel; the panel only calls planTargetProfile and prints the hint.

const TRAILER_NAME_RE = /(^|\W)(trailer|trl|53)(\W|$)/i;

/** Does the LOAD NAME itself say trailer? "TRAILER 6", "SUW TRL", "53 ATL". */
export function nameSuggestsTrailer(name) {
  return TRAILER_NAME_RE.test(String(name ?? ''));
}

/** The tractor profile among the truck profiles, or null when there is none. */
export function tractorProfileOf(profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  return list.find((p) => p?.capabilities?.tractor)
    || list.find((p) => /53|trailer|tractor/i.test(String(p?.label || p?.id || '')))
    || null;
}

/** The box profile among the truck profiles — the first non-tractor one, else the first. */
export function boxProfileOf(profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  return list.find((p) => !p?.capabilities?.tractor) || list[0] || null;
}

/**
 * The truck class the resolved driver drives, as the engine spells it, or null when the load
 * resolved to nobody. Tolerates the raw employee vocabulary too ('tractor' / 'box_truck').
 */
export function resolvedTruckClass(resolved) {
  const v = String(resolved?.truck_class ?? '').trim().toLowerCase();
  if (v === 'tractor') return 'tractor';
  if (v === 'box_truck' || v === 'box') return 'box_truck';
  return null;
}

/**
 * planTargetProfile({ pickedId, name, resolved, profiles }) → { profile, source }
 *
 *   pickedId  the dispatcher's dropdown choice for this row (profile id), or null
 *   name      the load's display name ("VICTOR", "BEN 2", "TRAILER 6", "SUW 2")
 *   resolved  routing-driver-resolve's entry for this name, or null/undefined
 *   profiles  the truck_profiles list
 *
 * source ∈ 'pick' | 'driver' | 'name' | 'default' says which rule decided, so the panel can
 * say so on the row and a test can pin the precedence rather than the colour of a chip.
 */
export function planTargetProfile({ pickedId = null, name = '', resolved = null, profiles = [] } = {}) {
  const list = Array.isArray(profiles) ? profiles : [];
  if (pickedId != null) {
    const picked = list.find((p) => p?.id === pickedId);
    if (picked) return { profile: picked, source: 'pick' };
  }
  const tractor = tractorProfileOf(list);
  const box = boxProfileOf(list);
  const cls = resolvedTruckClass(resolved);
  if (cls === 'tractor' && tractor) return { profile: tractor, source: 'driver' };
  if (cls === 'box_truck' && box) return { profile: box, source: 'driver' };
  if (nameSuggestsTrailer(name) && tractor) return { profile: tractor, source: 'name' };
  const fallback = box || tractor || list[0] || null;
  return { profile: fallback, source: fallback ? 'default' : 'none' };
}

/**
 * The one-line hint printed after the load name once its driver is known: "· Victor Mendez"
 * (the roster name, else the NuVizz key), plus a title that says where the truck default came
 * from. Null when the load resolved to nobody — a row that says nothing is better than one
 * that says "no driver" ninety times down a roster of route codes.
 */
export function driverHintForLoad(resolved, source = 'driver') {
  if (!resolved) return null;
  const who = String(resolved.driver_name || resolved.driver_user_name || resolved.driver_key || '').trim();
  if (!who) return null;
  const cls = resolvedTruckClass(resolved);
  const truck = cls === 'tractor' ? 'tractor-trailer' : (cls === 'box_truck' ? 'box truck' : 'unknown truck');
  const days = Number(resolved.observed_days) || 0;
  const history = days ? `${days} observed day${days === 1 ? '' : 's'}` : 'no observed days yet';
  const title = source === 'pick'
    ? `${who} drives a ${truck} (driver roster, ${history}) — the vehicle on this row is your pick.`
    : `Vehicle defaulted from the driver roster: ${who} drives a ${truck} (${history}). Change it on the dropdown if today is different.`;
  return { text: who, title };
}

/**
 * The distinct load names worth asking the endpoint about, in roster order. Names are
 * de-duplicated case-insensitively; blanks are skipped. A caller keys the answer by
 * `name.toLowerCase()` — the same key the endpoint uses.
 */
export function loadNamesToResolve(rows) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const name = String(r?.display ?? r?.name ?? '').trim();
    const k = name.toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  return out;
}

/** The lookup key for a load name in a resolve map — one definition, both sides. */
export function resolveKey(name) {
  return String(name ?? '').trim().toLowerCase();
}
