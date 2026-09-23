// WHAT KIND OF PLACE A STOP IS, AND WHAT THAT SAYS ABOUT THE TRUCK.
//
// Two sources answer "what kind of place is this": a dispatcher, through the new Building
// type control on the customer's notes (customer_notes.building_type), and — while Chad trials
// it — Shiplify's location database (shiplify_locations). The dispatcher always wins, in both
// directions: a type they set shows even with the Shiplify switch off, and 'none' hides
// whatever Shiplify says.
//
// ONE PLACE MARK PER PIN — house, school, church or government — and the three that are not a
// house carry a truck rule: a school car line, a church lot and a courthouse are not places a
// 53-footer turns around in, so a stop wearing one counts as NO TRACTOR TRAILER. That rule is
// deliberately NOT written into equipment_restrictions: those keys draw the restriction icon,
// feed the trailer-blocker checks and tractorPaintAllowed, and drive truck matching. A building
// type changes none of that. Its one tractor effect is the board flag (board-flags.js R7b) and
// the stop panel line, and the place mark on the pin is the signal.
//
// The rule is lifted where the evidence says a trailer fits: the dispatcher has set Vehicle to
// "Tractor-trailer OK" (VEHICLE_ELIGIBILITY_OPTIONS 'tractor', whose own description already
// says it drops auto-detected trailer warnings), or a tractor has already delivered there
// (tractor_locations, by match key or by street + ZIP under another name).
//
// PURE. The map, the stop panel, the legend and the flag engine all ask these functions, so
// none of them can answer the question a different way.

import { normalizePlaceKey } from './matchKey.js';

// Tariff codes seen in the test, in words for the stop panel. An unknown code is shown as
// itself rather than dropped — the one nobody has a word for is the one worth seeing.
// (Here rather than in shiplify-import.js so that module can read the place-mark rules below
// without the two importing each other.)
export const TARIFF_WORDS = { RES: 'Residential', LIM: 'Limited access', GROC: 'Grocery' };

// ── the vocabulary ───────────────────────────────────────────────────────────

// What a dispatcher can set. Absent (or anything unrecognised) is AUTO: follow Shiplify.
export const BUILDING_TYPES = ['residential', 'school', 'church', 'government', 'none'];
// What a pin can wear. Order is the precedence when Shiplify lists several (12 test rows are
// Place of Worship|School — a church school is a school at 3pm, whatever else it is).
export const PLACE_MARKS = ['school', 'church', 'government', 'residential'];
export const NO_TRACTOR_PLACE_MARKS = new Set(['school', 'church', 'government']);

export const PLACE_MARK_LABEL = {
  residential: 'Residential', school: 'School', church: 'Church', government: 'Government',
};
export const BUILDING_TYPE_LABEL = { ...PLACE_MARK_LABEL, none: 'None' };

// Shiplify's all_location_types vocabulary, as it appears in the test file.
export const SCHOOL_TYPES = ['School', 'University', 'Day Care / Preschool'];
export const CHURCH_TYPES = ['Place of Worship'];
export const GOVERNMENT_TYPES = [
  'Courthouse', 'Police Station', 'Fire Station', 'Prison / Detention Center', 'Military Base', 'Public Library',
];

/** The dispatcher's stored value, or null for Auto. Never throws on a malformed note. */
export function normalizeBuildingType(v) {
  const t = String(v ?? '').trim().toLowerCase();
  return BUILDING_TYPES.includes(t) ? t : null;
}

/** What Shiplify's record says this place is, by the precedence above. null = nothing. */
export function shiplifyPlaceMark(rec) {
  if (!rec) return null;
  const types = new Set((rec.location_types || []).map((t) => String(t).trim()));
  const has = (list) => list.some((t) => types.has(t));
  if (has(SCHOOL_TYPES)) return 'school';
  if (has(CHURCH_TYPES)) return 'church';
  if (has(GOVERNMENT_TYPES)) return 'government';
  if ((rec.tariff_items || []).map((t) => String(t).toUpperCase()).includes('RES')) return 'residential';
  return null;
}

/**
 * THE ONE PLACE MARK THIS STOP WEARS, and who said so.
 *   buildingType  customer_notes.building_type (raw; normalised here)
 *   shiplify      the stop's Shiplify record, or null
 *   shiplifyOn    THIS TAB's Shiplify switch
 * → { mark: 'residential'|'school'|'church'|'government'|null, source: 'dispatcher'|'shiplify'|null,
 *     shiplifyMark: what Shiplify alone would say (for the editor's "Auto: School" hint) }
 */
export function resolvePlaceMark({ buildingType = null, shiplify = null, shiplifyOn = true } = {}) {
  const bt = normalizeBuildingType(buildingType);
  const shiplifyMark = shiplifyOn ? shiplifyPlaceMark(shiplify) : null;
  if (bt === 'none') return { mark: null, source: 'dispatcher', shiplifyMark };
  if (bt) return { mark: bt, source: 'dispatcher', shiplifyMark };
  if (shiplifyMark) return { mark: shiplifyMark, source: 'shiplify', shiplifyMark };
  return { mark: null, source: null, shiplifyMark };
}

/**
 * DOES THE NO-TRACTOR-TRAILER RULE APPLY TO THIS STOP?
 *   mark          resolvePlaceMark(...).mark
 *   eligibility   note.vehicle_eligibility ('tractor' lifts it)
 *   tractorSeen   a tractor has delivered here — by match key OR by street + ZIP
 * → { applies, lifted: 'tractor_ok' | 'tractor_seen' | null }
 * Residential is never part of it; "Box truck only" is untouched and keeps working as today.
 */
export function placeNoTractor({ mark = null, eligibility = null, tractorSeen = false } = {}) {
  if (!NO_TRACTOR_PLACE_MARKS.has(mark)) return { applies: false, lifted: null };
  if (eligibility === 'tractor') return { applies: false, lifted: 'tractor_ok' };
  if (tractorSeen) return { applies: false, lifted: 'tractor_seen' };
  return { applies: true, lifted: null };
}

/** The flag's own reason, e.g. "School: no tractor trailer unless Vehicle is Tractor-trailer OK". */
export function placeNoTractorReason(mark) {
  const label = PLACE_MARK_LABEL[mark] || 'This place';
  return `${label}: no tractor trailer unless Vehicle is Tractor-trailer OK`;
}

/** The stop panel line while the rule applies. */
export function placeNoTractorLine(mark) {
  const label = PLACE_MARK_LABEL[mark] || 'This place';
  return `No tractor trailer: ${label}. Set Vehicle to Tractor-trailer OK if a trailer fits.`;
}

// ── lookups ──────────────────────────────────────────────────────────────────

const RANK = { yes: 3, partial: 2, no: 1, '': 0 };
const TRI_FIELDS = ['dock_access', 'forklift', 'lumper', 'gated_access', 'security_hut', 'call_box', 'appointment_required'];
function bestTri(values) {
  let best = '';
  for (const v of values) if ((RANK[v || ''] ?? 0) > (RANK[best] ?? 0)) best = v;
  return best;
}

/**
 * Several Shiplify locations at ONE street + ZIP (different customer names at one building)
 * → one record, by the same "a present feature beats an absent one" rule the import merges
 * rows with. Only used for the street + ZIP fallback; a match-key hit is always the record
 * itself.
 */
export function mergeShiplifyRecords(recs) {
  const list = (recs || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const sorted = [...list].sort((a, b) => String(a.match_key).localeCompare(String(b.match_key)));
  const out = { ...sorted[0], merged_from: sorted.map((r) => r.match_key) };
  // The dock and the forklift describe the BUILDING, so they merge across everyone at the address.
  for (const f of TRI_FIELDS) out[f] = bestTri(sorted.map((r) => r[f]));
  // What KIND of place it is describes each TENANT. A daycare and a supply house at one street
  // number are two different answers, and a stop for a third customer there must not inherit
  // "school" — that would raise a red no-tractor card on Shiplify's word about somebody else.
  // So the types carry over only when every record at the place says the same kind of place.
  const kinds = new Set(sorted.map((r) => shiplifyPlaceMark(r)));
  if (kinds.size === 1) {
    out.location_types = [...new Set(sorted.flatMap((r) => r.location_types || []))].sort();
    out.tariff_items = [...new Set(sorted.flatMap((r) => r.tariff_items || []))].sort();
  } else {
    out.location_types = [];
    out.tariff_items = [];
    out.mixed_types = true;
  }
  out.residential = out.tariff_items.includes('RES');
  return out;
}

/** Index decoded Shiplify records for per-stop lookup: byKey (match key) and byPlace. */
export function buildShiplifyLookup(records) {
  const byKey = new Map();
  const placeLists = new Map();
  for (const r of (records || [])) {
    if (!r || !r.match_key) continue;
    byKey.set(r.match_key, r);
    if (r.place_key) {
      if (!placeLists.has(r.place_key)) placeLists.set(r.place_key, []);
      placeLists.get(r.place_key).push(r);
    }
  }
  const byPlace = new Map();
  for (const [k, list] of placeLists) byPlace.set(k, mergeShiplifyRecords(list));
  return { byKey, byPlace, size: byKey.size };
}

export const EMPTY_SHIPLIFY_LOOKUP = Object.freeze({ byKey: new Map(), byPlace: new Map(), size: 0 });

/** A board stop's street + ZIP key — the same normalisation placeKeyOfStop uses, no fallback. */
export function stopPlaceKey(stop) {
  return normalizePlaceKey(stop?.addr1, stop?.zip);
}

/**
 * The Shiplify record for a board stop: by stop.matchKey, then by street + ZIP.
 * → { rec, via: 'key' | 'place' } or null.
 */
export function shiplifyRecordFor(lookup, stop) {
  if (!lookup || !stop) return null;
  const k = stop.matchKey;
  if (k && lookup.byKey && lookup.byKey.has(k)) return { rec: lookup.byKey.get(k), via: 'key' };
  const pk = stopPlaceKey(stop);
  if (pk && lookup.byPlace && lookup.byPlace.has(pk)) return { rec: lookup.byPlace.get(pk), via: 'place' };
  return null;
}

/**
 * THE STREET + ZIP HALF OF A MATCH KEY. tractor_locations carries the match key but no
 * address fields, and 153 of 738 first-time lime paints in the test were addresses a tractor
 * had already served under a DIFFERENT customer name — so "has a tractor been here" has to be
 * asked by place as well as by customer.
 *
 * A match key is `${name}__${street}__${city}__${zip5}` (normalizeMatchKey). ZIP and city are
 * read off the right. The name can END in an underscore (a stripped "LLC" leaves one), so the
 * name/street split is the first `__` whose next character is not another underscore — a
 * normalised street never starts with one. The street and ZIP halves are normalised exactly as
 * normalizePlaceKey normalises them, so the result compares equal to a board stop's place key.
 * Returns '' when the key cannot be split; the caller then simply has no place fact, which
 * errs toward showing the pin, never toward hiding a flag.
 */
export function placeKeyFromMatchKey(matchKey) {
  const s = String(matchKey || '');
  // ZIP, then city, off the RIGHT with lastIndexOf — not split('__'): a street that ends in an
  // underscore (a bare "Suite" normalises to "ste_") runs three underscores into the city
  // separator, and a split would hand that underscore to the city and lose it from the street.
  const z = s.lastIndexOf('__');
  if (z < 0) return '';
  const zip = s.slice(z + 2);
  const rest = s.slice(0, z);
  const c = rest.lastIndexOf('__');
  if (c < 0) return '';
  const head = rest.slice(0, c);   // `${name}__${street}`
  let street = '';
  for (let i = 0; i + 2 < head.length; i++) {
    if (head[i] === '_' && head[i + 1] === '_' && head[i + 2] !== '_') { street = head.slice(i + 2); break; }
  }
  if (!/[a-z0-9]/.test(street) || !/[a-z0-9]/.test(zip)) return '';
  return `${street}__${zip}`;
}

/** Place keys of every tractor-delivered location — the street + ZIP half of the lime map. */
export function tractorPlaceKeys(tractorMap) {
  const out = new Set();
  if (!tractorMap || typeof tractorMap.keys !== 'function') return out;
  for (const mk of tractorMap.keys()) {
    const pk = placeKeyFromMatchKey(mk);
    if (pk) out.add(pk);
  }
  return out;
}

/**
 * HAS A TRACTOR DELIVERED AT THIS STOP? By its own match key, or at the same street + ZIP
 * under any name. → { byKey, byPlace, any }
 */
export function tractorSeenAt(stop, tractorMap, tractorPlaces) {
  const byKey = !!(stop?.matchKey && tractorMap && typeof tractorMap.has === 'function' && tractorMap.has(stop.matchKey));
  const pk = stopPlaceKey(stop);
  const byPlace = !!(pk && tractorPlaces && typeof tractorPlaces.has === 'function' && tractorPlaces.has(pk));
  return { byKey, byPlace, any: byKey || byPlace };
}

// ── "Lime as of board date" (trial switch) ──────────────────────────────────

/**
 * The tractor map as it stood on `boardDate`: a location counts only if its first tractor
 * delivery is BEFORE that date. A location with no first date cannot be shown to predate the
 * board, so it does not count. Memoised on (map, date) so every consumer on one tab gets the
 * SAME Map object and a marker effect keyed on it does not rebuild for nothing.
 */
const __asOfCache = new WeakMap();
export function limeAsOf(tractorMap, boardDate) {
  if (!tractorMap || typeof tractorMap.entries !== 'function') return tractorMap;
  const d = String(boardDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return tractorMap;
  let perMap = __asOfCache.get(tractorMap);
  if (!perMap) { perMap = new Map(); __asOfCache.set(tractorMap, perMap); }
  if (perMap.has(d)) return perMap.get(d);
  const out = new Map();
  for (const [k, v] of tractorMap.entries()) {
    const first = String(v?.first || '').slice(0, 10);
    if (first && first < d) out.set(k, v);
  }
  perMap.set(d, out);
  return out;
}

// ── the hollow lime pins ─────────────────────────────────────────────────────

/** What Shiplify's record alone would draw: 'dock' | 'forklift' | null. */
export function shiplifyPinCandidate(rec) {
  if (!rec) return null;
  if (rec.dock_access === 'yes') return 'dock';
  if (rec.dock_access === 'no' && rec.forklift === 'yes') return 'forklift';
  return null;
}

// Only the resting states. Out for delivery, arrived, delivered and exception are what the
// board is watched for all day and keep their colours.
const PIN_STATUSES = new Set(['UNPLANNED', 'SCHEDULED']);

/**
 * WHICH SHIPLIFY PIN, IF ANY, THIS STOP DRAWS: "Shiplify says a trailer could work here, and no
 * tractor has delivered yet." Every existing colour keeps winning — the pin exists only where
 * the stop would otherwise wear its plain default status colour — so every fact that earns a
 * colour, a mark or a cluster of its own suppresses it. Each suppression is its own test.
 *
 * → 'dock' | 'forklift' | null
 */
export function shiplifyPinKind({
  candidate = null, shiplifyOn = false,
  tractorSeen = false, eligibility = null, paintAllowed = true, placeMark = null,
  statusKind = null, dns = false, matched = false, searchMatched = false, inRoute = false,
  plannedMuted = false, priorityFlag = null, addressOff = false, estes = false, restrictionCount = 0,
} = {}) {
  if (!shiplifyOn || (candidate !== 'dock' && candidate !== 'forklift')) return null;
  if (tractorSeen) return null;                           // lime by key or by street + ZIP
  if (eligibility) return null;                           // Tractor-trailer OK or Box truck only
  if (!paintAllowed) return null;                         // a confirmed trailer blocker
  if (NO_TRACTOR_PLACE_MARKS.has(placeMark)) return null; // school / church / government
  if (!PIN_STATUSES.has(statusKind)) return null;         // live statuses keep their colours
  if (dns || matched || searchMatched || inRoute || plannedMuted) return null;
  if (priorityFlag) return null;                          // any flag, the ? flag included
  if (addressOff || estes) return null;                   // amber tint / the Estes ring
  if (Number(restrictionCount) > 0) return null;          // a restriction cluster
  return candidate;
}

// ── the stop panel's Shiplify block ─────────────────────────────────────────

const YN = { yes: 'Yes', no: 'No', partial: 'Partial', '': 'Not given' };

/**
 * The stop panel's "Shiplify test" block as rows of [label, value], so the desktop panel and
 * the phone sheet print the same words. `found` false → the caller prints "Not in the
 * Shiplify test", never a blank block.
 */
export function shiplifyPanelRows(rec) {
  if (!rec) return { found: false, rows: [] };
  const tariffs = (rec.tariff_items || []).map((t) => TARIFF_WORDS[t] || t);
  return {
    found: true,
    rows: [
      ['Dock', YN[rec.dock_access || ''] ?? 'Not given'],
      ['Forklift', YN[rec.forklift || ''] ?? 'Not given'],
      ['Gated', YN[rec.gated_access || ''] ?? 'Not given'],
      ['Security hut', YN[rec.security_hut || ''] ?? 'Not given'],
      ['Call box', YN[rec.call_box || ''] ?? 'Not given'],
      ['Lumper', YN[rec.lumper || ''] ?? 'Not given'],
      ['Appointment', YN[rec.appointment_required || ''] ?? 'Not given'],
      ['Location types', rec.mixed_types
        ? 'Differs by customer at this address'
        : ((rec.location_types || []).join(', ') || 'None listed')],
      ['Tariffs', rec.mixed_types ? 'Differs by customer at this address' : (tariffs.join(', ') || 'None')],
    ],
  };
}

/** A lime (tractor-proven) location where Shiplify says there is no dock: one grey line. */
export function limeNoDockLine(rec, tractorSeen) {
  if (!rec || !tractorSeen || rec.dock_access !== 'no') return null;
  return 'A tractor has delivered here, though Shiplify lists no dock.';
}

// ── the dispatcher's Building type, saved ───────────────────────────────────

/**
 * Did this save change the Building type? Stamps building_type_at / building_type_by exactly the
 * way eligibilityChanged stamps the Vehicle mark — only when the answer actually moved, and
 * clearing it back to Auto (null / absent) is a change like any other.
 */
export function buildingTypeChanged(draft, existing) {
  return normalizeBuildingType(draft?.building_type) !== normalizeBuildingType(existing?.building_type);
}
