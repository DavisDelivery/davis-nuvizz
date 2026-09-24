// stop-search.js — EVERY STOP AT AN ADDRESS, OR IN A CITY, OVER ANY DATES WE HOLD.
//
// Chad, 2026-09-24: "need to be able to look up stops by address & city as there are times i
// may want to see every delivery done in that city so will need some date ranges as well as
// specific dates date ranges should default to all unless set"
//
// WHAT THE SCREEN DID WITH AN ADDRESS BEFORE THIS. classifyQuery (stop-lookup.js) sends anything
// with a space in it to the customer-NAME search, so "1100 Northside Dr", "Atlanta" and "30318"
// all searched business names, found nothing, and said so. A rep whose caller only knows the
// address had no way in at all.
//
// ── WHY THIS NEEDS ITS OWN INDEX — measured off the code, not guessed ────────────────────────
//
//   • The warehouse is partitioned by DAY (history_days/{tenant}__{date}/stops/…) and nothing in
//     it is keyed by place. "Every stop in Lawrenceville, all dates" is therefore every stop of
//     every captured day: 57,227 documents at the 2026-09-19 backfill (~535 a day), and growing.
//   • stop-lookup runs under a 26-second limit (netlify.toml), and the year view in stop-lookup.js
//     already records that sweeping a year of days "does not finish inside the function's 26
//     seconds". An unbounded all-dates sweep is that, on every search.
//   • So — the answer the year view gave — the work moves to the night. When a day seals, ONE
//     digest document is written for it (history_search/{tenant}__{date}): every stop that day,
//     reduced to the columns a search needs and a result row shows, as tab-separated text. "All
//     dates" is then one read per day we hold (~110 today, ~260 in a working year) instead of one
//     per STOP.
//
// WHY ONE DOCUMENT PER DAY AND NOT ONE PER CITY. A city-keyed index would answer "Atlanta" in a
// handful of reads — and would silently miss every stop whose stored city is not spelled the way
// the rep typed it. In freight that is not rare: the postal city and the town the customer names
// are routinely different (a Sandy Springs building with an ATLANTA mailing address). A day digest
// is scanned in full, so an ADDRESS search never depends on the city field, and a city search can
// report the near-misses it saw ("nothing in SANDY SPRINGS — 212 at that address in ATLANTA")
// instead of a bare zero a rep repeats to the caller. The price is reading every day in the
// range, ~100KB a day. For a screen used by a person on the phone that is the right trade, and it
// is written here so whoever wants to change it knows what they are trading.
//
// ── THE MATCHING RULES, and which way each one errs ──────────────────────────────────────────
//
//   • Street text goes through normStreetOf (matchKey.js) on BOTH sides — the rule the place key
//     and the address log already use — plus the few standard abbreviations that function does not
//     make (Northwest → NW, Building → BLDG, Lane → LN …), applied to both sides for SEARCH ONLY so
//     no stored key anywhere moves.
//   • THE HOUSE NUMBER IS EXACT, AND IT IS THE HOUSE NUMBER. "110 Northside" must not find 1100,
//     and "100 Main" must not find "5100 MAIN ST STE 100" through its suite. When the typed
//     address starts with a number, the stop's street line must start with that same number. A
//     false match here hands a rep the wrong building's proof of delivery.
//   • Every other typed word must appear in the street line (addr1 + addr2) in any order; the last
//     word may be the start of a longer one, so a half-typed street name still lands.
//   • City is exact after case, punctuation and spacing — NEVER a prefix. "Peachtree" is two
//     cities forty miles apart (Peachtree City, Peachtree Corners), and the totals for one must
//     not quietly include the other. Cities that start with what was typed come back as
//     suggestions, with their counts, for the rep to pick.
//   • ZIP compares on five digits, so a ZIP+4 on either side still matches.
//
// PURE. No Firestore, no fetch, no clock — the caller passes `today`. The nightly hook writes the
// digest (netlify/functions/lib/stop-search-store.mts), the endpoint gathers it
// (stop-lookup.mts ?addr= / ?city= / ?zip=), and this decides what the documents MEAN.

import { normStreetOf } from './matchKey.js';
import { buildCustomerStopRow, summarizeStopRows, driverTally } from './stop-lookup.js';
import { isDateStr, addDays } from './history-range.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const s = (v) => String(v ?? '').trim();
// NOT Number(v): Number('') is 0 and 0 is finite, so an empty digest cell would read as "stop 0"
// and "0 lb". CLAUDE.md records that exact shape shipping a midnight deadline for a stop with no
// deadline at all. Empty is null here, always.
const num = (v) => {
  if (v === null || v === undefined) return null;
  const t = typeof v === 'string' ? v.trim() : v;
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

// ═══════════════════════════════════════════════════════════════════════════
// THE DIGEST — one document per sealed day
// ═══════════════════════════════════════════════════════════════════════════

export const SEARCH_DIGEST_COLLECTION = 'history_search';
export const SEARCH_DIGEST_VERSION = 1;

/**
 * The columns, in the order they are written. The document carries its own copy and the reader
 * maps BY NAME, so adding a column later is forward-compatible in both directions: an old digest
 * lacks it (the cell reads empty) and an old reader ignores it. Removing or renaming one of the
 * REQUIRED columns is the only change that makes a digest unreadable, and the reader refuses it
 * whole rather than guessing — a digest it cannot read is reported as a day not searched.
 */
export const SEARCH_DIGEST_FIELDS = [
  'stopNbr', 'pro', 'proCount', 'status', 'att', 'route', 'seq', 'driver', 'planned',
  'deliveredAt', 'arrivedAt', 'name', 'addr1', 'addr2', 'city', 'state', 'zip',
  'pieces', 'pallets', 'weight', 'pod', 'po',
];
const REQUIRED_FIELDS = ['stopNbr', 'status', 'addr1', 'city', 'zip'];

/** Firestore's document limit is 1 MiB. Refuse well short of it, loudly, rather than lose rows. */
export const SEARCH_DIGEST_MAX_BYTES = 900_000;

// One cell. Tabs and line breaks inside a value would split the row, so they become spaces —
// the only characters this format cannot carry, and none of them mean anything in an address.
const cell = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '1' : '';
  return String(v).replace(/[\t\r\n]+/g, ' ').trim();
};

/**
 * PURE: one sealed (or board) stop → the digest cells, in SEARCH_DIGEST_FIELDS order.
 *
 * Every accessor here is the one buildCustomerStopRow uses, so a row rebuilt from the digest
 * renders exactly as the same stop does in the customer view — driver name before user name,
 * route name before load number, cartons before volume, the raw execution block as the arrival
 * fallback.
 */
export function searchDigestRow(stop) {
  const st = stop || {};
  return [
    s(st.stopNbr),
    s(st.pro) || s(st.primaryPro),
    Array.isArray(st.pros) && st.pros.length ? st.pros.length : num(st.proCount),
    s(st.normalizedStatus),
    st.isAttempt === true || /^ATT/i.test(s(st.shipmentNbr)),
    s(st.routeName) || s(st.loadNbr),
    num(st.loadStopSeq ?? st.routeSeq),
    s(st.driverName) || s(st.driverUserName),
    st.isPlanned === true,
    s(st.deliveredDTTM),
    s(st.arrivalDTTM) || s(st.raw?.stopExecutionInfo?.to?.arrivalDTTM),
    s(st.businessName),
    s(st.addr1), s(st.addr2), s(st.city), s(st.state), s(st.zip),
    num(st.cartons) ?? num(st.volume),
    num(st.pallets),
    num(st.weight),
    Array.isArray(st.podDocs) ? st.podDocs.length : null,
    s(st.poRef),
  ];
}

/**
 * PURE: a day's stops → the digest document. Stops with no stop number and no PRO are skipped —
 * a row nobody can open is not a result — and counted, so the document says how many.
 */
export function encodeSearchDigest(stops, { tenant, date, builtAt } = {}) {
  const lines = [];
  let skipped = 0;
  for (const st of stops || []) {
    if (!st || !(s(st.stopNbr) || s(st.pro) || s(st.primaryPro))) { skipped += 1; continue; }
    lines.push(searchDigestRow(st).map(cell).join('\t'));
  }
  const rows = lines.join('\n');
  return {
    tenant: s(tenant) || null,
    date: s(date) || null,
    v: SEARCH_DIGEST_VERSION,
    fields: SEARCH_DIGEST_FIELDS,
    count: lines.length,
    skipped,
    rows,
    bytes: utf8Bytes(rows),
    built_at: s(builtAt) || null,
    source: 'history_days',
  };
}

/** UTF-8 length without Buffer (this module also runs in the browser). */
export function utf8Bytes(str) {
  let n = 0;
  for (const ch of String(str ?? '')) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * PURE: a digest document → { date, rows: stop-like objects } — or null when it cannot be read.
 *
 * Null, not an empty list, for a document it does not understand: "this day had no stops at
 * that address" and "this day could not be read" are different sentences, and the endpoint
 * reports the second one as a day NOT searched. A row with the wrong number of cells is dropped
 * and counted in `malformed` for the same reason.
 */
export function decodeSearchDigest(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const date = s(doc.date);
  if (!DAY_RE.test(date)) return null;
  const fields = Array.isArray(doc.fields) ? doc.fields.map((f) => String(f)) : null;
  if (!fields || REQUIRED_FIELDS.some((f) => !fields.includes(f))) return null;
  const at = Object.fromEntries(fields.map((f, i) => [f, i]));
  const text = typeof doc.rows === 'string' ? doc.rows : '';
  const rows = [];
  let malformed = 0;
  for (const line of text ? text.split('\n') : []) {
    if (!line) continue;
    const c = line.split('\t');
    if (c.length !== fields.length) { malformed += 1; continue; }
    const g = (k) => (at[k] === undefined ? '' : c[at[k]]);
    rows.push({
      stopNbr: g('stopNbr') || null,
      pro: g('pro') || null,
      proCount: num(g('proCount')),
      normalizedStatus: g('status') || null,
      isAttempt: g('att') === '1',
      routeName: g('route') || null,
      loadStopSeq: num(g('seq')),
      driverName: g('driver') || null,
      isPlanned: g('planned') === '1',
      deliveredDTTM: g('deliveredAt') || null,
      arrivalDTTM: g('arrivedAt') || null,
      businessName: g('name') || null,
      addr1: g('addr1') || null,
      addr2: g('addr2') || null,
      city: g('city') || null,
      state: g('state') || null,
      zip: g('zip') || null,
      cartons: num(g('pieces')),
      pallets: num(g('pallets')),
      weight: num(g('weight')),
      poRef: g('po') || null,
      // The POD COUNT, carried as a number because the digest holds no documents.
      // placeStopRow applies it; buildCustomerStopRow alone would read 0.
      _pod: num(g('pod')),
    });
  }
  return { date, tenant: s(doc.tenant) || null, count: rows.length, malformed, builtAt: s(doc.built_at) || null, rows };
}

/** PURE: one stop-like record → one result row, the SAME shape the customer view renders. */
export function placeStopRow(st, { date, today, source } = {}) {
  const row = buildCustomerStopRow(st, { date, today, source });
  if (st && st._pod != null) row.pod = st._pod;
  return row;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE QUERY
// ═══════════════════════════════════════════════════════════════════════════

// Standard USPS abbreviations normStreetOf does not make. SEARCH ONLY, both sides — adding them to
// normStreetOf would move the place key, the address log and every customer_notes id built on it.
const SEARCH_ABBREV = {
  northwest: 'nw', northeast: 'ne', southwest: 'sw', southeast: 'se',
  building: 'bldg', lane: 'ln', court: 'ct', circle: 'cir', place: 'pl', terrace: 'ter',
  trail: 'trl', square: 'sq', expressway: 'expy', freeway: 'fwy', floor: 'fl', center: 'ctr',
  centre: 'ctr', crossing: 'xing', point: 'pt', heights: 'hts', junction: 'jct', mountain: 'mtn',
  mount: 'mt', industrial: 'ind', plaza: 'plz',
};

/** PURE: street lines → canonical tokens, e.g. "1100 Northside Drive NW" → [1100, northside, dr, nw]. */
export function addressTokens(...lines) {
  const out = [];
  for (const line of lines) {
    const norm = normStreetOf(line);
    if (!norm) continue;
    for (const t of norm.split('_')) if (t) out.push(SEARCH_ABBREV[t] || t);
  }
  return out;
}

/** PURE: "  sandy   springs. " → "SANDY SPRINGS". Case, punctuation and spacing never decide a match. */
export function cityKey(city) {
  return s(city).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** PURE: a two-letter state, or '' — "ga" → "GA". Anything else is not a state and filters nothing. */
export function stateKey(state) {
  const t = s(state).toUpperCase().replace(/[^A-Z]/g, '');
  return t.length === 2 ? t : '';
}

/** PURE: the five-digit ZIP, or '' — "30318-1234" → "30318". Fewer than five digits is not a ZIP. */
export function zip5(zip) {
  const d = s(zip).replace(/\D/g, '').slice(0, 5);
  return d.length === 5 ? d : '';
}

// ── A PASTED ADDRESS, TAKEN APART ─────────────────────────────────────────────
//
// The most natural thing a rep does with an address in an email is paste the whole line into the
// first box: "1100 Northside Dr, Atlanta, GA 30318". Read as a street, that is six words the street
// line must contain — "atlanta", "ga", "30318" included — and the answer is "no stops at that
// address" about an address we deliver to every week. The same trap in the City box: "Atlanta, GA"
// is a city called ATLANTA GA, which no stop has. So the parts are separated before matching, and
// conservatively, because moving a word that belonged to the street is its own wrong answer:
//
//   • WITH COMMAS, each segment is judged whole: a ZIP is the ZIP, a state code (with or without a
//     ZIP) is the state, a segment with a digit or a unit word ("Suite 210", "Bldg C") stays in the
//     street, and the first segment left over is the city. A field the rep filled in themselves
//     always wins over a pasted part, and a pasted part that disagrees with one is dropped rather
//     than pushed into the street where it would break the match.
//   • WITHOUT COMMAS, only the unambiguous tail moves: a trailing ZIP, and a trailing state code
//     that is not also a street word. NE is Nebraska and north-east; CT is Connecticut and Court;
//     WY, MT and CO are Way, Mount and County often enough — those stay in the street, always.

const US_STATES = new Set(('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV '
  + 'NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR').split(' '));
const STREET_WORD_STATES = new Set(['NE', 'CT', 'WY', 'MT', 'CO']);
const UNIT_RE = /^(suite|ste|unit|apt|bldg|building|dock|door|floor|fl|rm|room|#)\b/i;
const ZIP_RE = /^\d{5}(-?\d{4})?$/;

/** PURE: split pasted parts into their own fields. `moved` names what moved, for the header. */
export function splitPlaceInput({ addr = '', city = '', state = '', zip = '' } = {}) {
  let a = s(addr); let c = s(city); let st = s(state); let z = s(zip);
  const moved = [];
  const setZip = (v) => { if (!z) { z = v; moved.push('zip'); } };
  const setState = (v) => { if (!st) { st = v; moved.push('state'); } };
  // A whole segment that is a state and/or a ZIP. Consumed either way — a pasted part that
  // disagrees with a filled field is dropped, never left where it would break the match.
  const stateZipSegment = (seg) => {
    const t = seg.trim();
    if (ZIP_RE.test(t)) { setZip(t); return true; }
    const m = /^([A-Za-z]{2})(?:\s+(\d{5}(?:-?\d{4})?))?$/.exec(t);
    if (m && US_STATES.has(m[1].toUpperCase())) { setState(m[1]); if (m[2]) setZip(m[2]); return true; }
    return false;
  };
  // The unambiguous tail of a comma-less line: a ZIP, then a state that is not a street word.
  const tail = (words, minLeft) => {
    if (words.length > minLeft && ZIP_RE.test(words[words.length - 1])) setZip(words.pop());
    const last = String(words[words.length - 1] || '').toUpperCase();
    if (words.length > minLeft && US_STATES.has(last) && !STREET_WORD_STATES.has(last)) setState(words.pop());
    return words;
  };

  if (a.includes(',')) {
    const parts = a.split(',').map((x) => x.trim()).filter(Boolean);
    const street = parts.length ? [parts.shift()] : [];
    for (const part of parts) {
      if (stateZipSegment(part)) continue;
      if (/\d/.test(part) || UNIT_RE.test(part)) { street.push(part); continue; }
      if (!c) { c = part; moved.push('city'); }
      // else: the City box was filled by hand and wins; this pasted city is dropped.
    }
    a = street.join(' ');
  } else if (a) {
    // At least a house number and a street word must remain, so "Main St" is never eaten.
    a = tail(a.split(/\s+/).filter(Boolean), 2).join(' ');
  }

  if (c.includes(',')) {
    const parts = c.split(',').map((x) => x.trim()).filter(Boolean);
    const first = parts.shift() || '';
    for (const part of parts) stateZipSegment(part);
    c = first;
  } else if (c) {
    c = tail(c.split(/\s+/).filter(Boolean), 1).join(' ');
  }
  return { addr: a, city: c, state: st, zip: z, moved };
}

/**
 * PURE: what was typed → the normalised query. Never throws; a half-typed form must not blank
 * the screen.
 *
 * ONE READING IS CHANGED, and the result says so: five digits alone in the ADDRESS box, with no
 * ZIP typed, is a ZIP. No street line is a bare five-digit number, and a rep who types the ZIP
 * into the first box they see should get that ZIP rather than "no stops at 30318".
 */
export function placeQuery(input = {}) {
  const { addr, city, state, zip, moved } = splitPlaceInput(input);
  let tokens = addressTokens(addr);
  let z = zip5(zip);
  let reading = moved.length ? 'split' : null;
  if (!z && tokens.length === 1 && /^\d{5}$/.test(tokens[0])) { z = tokens[0]; tokens = []; reading = 'zip-in-address'; }
  const house = tokens.length && /^\d+[a-z]?$/.test(tokens[0]) ? tokens[0] : null;
  const q = {
    addr: tokens.length ? s(addr) : '',
    addrTokens: tokens,
    house,
    city: cityKey(city),
    state: stateKey(state),
    zip: z,
    reading,
    // What moved out of a pasted line, so the header can say the search read it that way.
    split: moved,
  };
  q.label = placeLabel(q);
  return q;
}

/** PURE: is there anything to search by? A state alone is every stop in Georgia — not a search. */
export function placeQueryUsable(q) {
  return !!(q && ((q.addrTokens && q.addrTokens.length) || q.city || q.zip));
}

/** PURE: the header's words for a query — "1100 NORTHSIDE DR · ATLANTA, GA 30318". */
export function placeLabel(q) {
  const where = [q?.city, [q?.state, q?.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [s(q?.addr).toUpperCase(), where].filter(Boolean).join(' · ');
}

/**
 * PURE: does this stop match the query? `ignoreCity` answers "would it have matched in another
 * city" — which is how the view finds the same address filed under a different town.
 */
export function rowMatchesPlace(st, q, { ignoreCity = false } = {}) {
  if (!st || !q) return false;
  if (q.zip && zip5(st.zip) !== q.zip) return false;
  if (q.state && stateKey(st.state) !== q.state) return false;
  if (!ignoreCity && q.city && cityKey(st.city) !== q.city) return false;
  const want = q.addrTokens || [];
  if (!want.length) return true;
  // A cheap refusal before normalising the whole line: a typed house number the street line
  // does not even begin with cannot match. Most rows of most days stop here.
  // Leading punctuation is stripped first ("#4200 MAIN"), because normStreetOf strips it too and
  // a pre-check stricter than the real rule would be a silent false negative.
  if (q.house && !s(st.addr1).toLowerCase().replace(/^[^0-9a-z]+/, '').startsWith(q.house.replace(/[a-z]$/, ''))) return false;
  const have = addressTokens(st.addr1, st.addr2);
  if (q.house && have[0] !== q.house) return false;
  const rest = q.house ? want.slice(1) : want;
  const bag = q.house ? have.slice(1) : have;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (bag.includes(t)) continue;
    const lastWord = i === rest.length - 1 && /^[a-z]{2,}$/.test(t);
    if (lastWord && bag.some((b) => b.startsWith(t))) continue;
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE DATES — all (the default), one day, or a range
// ═══════════════════════════════════════════════════════════════════════════

/**
 * PURE: the selection → the dates to search. `aheadDays` is how far forward the live board
 * reaches (the scan writes three days out), because "is anything coming to this address" is a
 * question a rep asks too.
 *
 * NO WIDTH CAP, unlike history-range.js's 60 days — that cap exists because those screens read a
 * whole board per day. This reads one small document per day, so a wide range costs what "all"
 * costs and there is nothing to protect by refusing it.
 *
 * Kinds: 'all' (the default, and what anything malformed falls back to — Chad: "date ranges
 * should default to all unless set"), 'day', 'range'. `clamped` says when the answer is not
 * exactly what was asked, so the header never describes a window it did not search.
 */
export function placeRange(sel, today, aheadDays = 0) {
  const t = isDateStr(s(today)) ? s(today) : null;
  const ahead = Math.floor(Number(aheadDays));
  const horizon = t ? addDays(t, Number.isFinite(ahead) && ahead > 0 ? ahead : 0) : null;
  const kind = sel?.kind;
  if (kind === 'day') {
    if (!isDateStr(sel.date)) return { kind: 'all', from: null, to: horizon, clamped: 'bad-date' };
    return { kind: 'day', from: sel.date, to: sel.date, clamped: horizon && sel.date > horizon ? 'future' : null };
  }
  if (kind === 'range') {
    if (!isDateStr(sel.from) || !isDateStr(sel.to)) return { kind: 'all', from: null, to: horizon, clamped: 'bad-range' };
    let from = sel.from; let to = sel.to; let clamped = null;
    if (from > to) { const x = from; from = to; to = x; clamped = 'swapped'; }
    if (horizon && to > horizon) { to = horizon < from ? from : horizon; clamped = 'future'; }
    return { kind: 'range', from, to, clamped };
  }
  return { kind: 'all', from: null, to: horizon, clamped: kind && kind !== 'all' ? 'bad-selection' : null };
}

/** PURE: a selection off query params. Nothing given is ALL. */
export function placeSelectionFromParams(get) {
  const from = s(get('from'));
  const to = s(get('to'));
  const date = s(get('date'));
  if (from || to) return { kind: 'range', from: from || to, to: to || from };
  if (date) return { kind: 'day', date };
  return { kind: 'all' };
}

/** PURE: the query string the screen sends. One way to ask, so the two sides cannot drift. */
export function placeParams({ addr, city, state, zip } = {}, sel = { kind: 'all' }) {
  const p = new URLSearchParams();
  if (s(addr)) p.set('addr', s(addr));
  if (s(city)) p.set('city', s(city));
  if (s(state)) p.set('state', s(state));
  if (s(zip)) p.set('zip', s(zip));
  if (sel?.kind === 'day' && isDateStr(sel.date)) p.set('date', sel.date);
  if (sel?.kind === 'range' && isDateStr(sel.from) && isDateStr(sel.to)) { p.set('from', sel.from); p.set('to', sel.to); }
  return p.toString();
}

/** PURE: is a date inside a resolved range? `from: null` is "from the first day we hold". */
export function inPlaceRange(date, range) {
  if (!DAY_RE.test(s(date)) || !range) return false;
  if (range.from && date < range.from) return false;
  if (range.to && date > range.to) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE VIEW
// ═══════════════════════════════════════════════════════════════════════════

export const PLACE_ROWS_MAX = 500;
const TOP_ADDRESSES = 25;
const TOP_DRIVERS = 15;
const TOP_CITIES = 10;
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const rowSort = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)
  || ((a.seq ?? 9999) - (b.seq ?? 9999))
  || String(a.pro).localeCompare(String(b.pro));

const bump = (map, key, make) => { let v = map.get(key); if (!v) { v = make(); map.set(key, v); } return v; };

/**
 * PURE: every day gathered → the answer.
 *
 * `days` is [{ date, source: 'sealed' | 'board', stops }] — stops as decoded from a digest, or
 * straight off the live board for a day not sealed yet. The endpoint never passes a date twice
 * (a sealed day's board copy is not read), so nothing here de-duplicates across sources.
 *
 * EVERY COUNT IS OVER EVERY MATCH; only the ROW LIST is capped. Four thousand rows is not
 * something anybody reads — the totals, the months, the addresses and the drivers are how a
 * person sees "every delivery done in that city". The list is newest-first and cut at a DAY
 * boundary, so a day heading never counts rows the page is not showing, and `hiddenDays` says
 * how many older days were left off.
 */
export function buildPlaceView({ query, range = null, today = '', days = [], cap = PLACE_ROWS_MAX } = {}) {
  const q = query || placeQuery({});
  const rows = [];
  let scanned = 0;
  // The same stop matched on everything EXCEPT the city — the postal-city trap. Only gathered
  // when a city was typed; without one there is no "other city" to report.
  const other = new Map();
  for (const d of days || []) {
    const date = s(d?.date);
    if (!DAY_RE.test(date)) continue;
    const source = d.source === 'board' ? 'board' : 'sealed';
    for (const st of d.stops || []) {
      scanned += 1;
      if (rowMatchesPlace(st, q)) { rows.push(placeStopRow(st, { date, today, source })); continue; }
      if (q.city && rowMatchesPlace(st, q, { ignoreCity: true })) {
        const k = cityKey(st.city);
        if (!k) continue;
        // With an address or ZIP typed, ANY other city is the finding — it is the same place filed
        // under a different town. With only a city typed, every stop "matches except the city",
        // so only the cities that START with what was typed are worth saying.
        const hasPlace = (q.addrTokens && q.addrTokens.length) || q.zip;
        if (!hasPlace && !k.startsWith(q.city)) continue;
        const c = bump(other, k, () => ({ city: k, state: stateKey(st.state) || null, stops: 0 }));
        c.stops += 1;
      }
    }
  }
  rows.sort(rowSort);

  const months = new Map();
  const addrs = new Map();
  const cities = new Map();
  for (const r of rows) {
    const m = r.date.slice(0, 7);
    const mb = bump(months, m, () => ({ month: m, label: `${MONTH[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`, rows: [] }));
    mb.rows.push(r);
    const a = r.address || {};
    const ak = `${addressTokens(a.addr1, a.addr2).join(' ')}|${zip5(a.zip)}`;
    const ab = bump(addrs, ak, () => ({ key: ak, address: a, name: r.name, stops: 0, delivered: 0, firstDate: r.date, lastDate: r.date }));
    ab.stops += 1;
    if (r.outcome === 'delivered') ab.delivered += 1;
    // Rows arrive newest first, so the first one seen carries the most recent spelling and name.
    if (r.date < ab.firstDate) ab.firstDate = r.date;
    const ck = cityKey(a.city);
    if (ck) {
      const cb = bump(cities, ck, () => ({ city: ck, state: stateKey(a.state) || null, stops: 0 }));
      cb.stops += 1;
    }
  }

  // THE ROW LIST: whole days, newest first, until the next day would pass the cap. The first day
  // is always shown whatever its size — an empty list over a non-empty answer would read as none.
  const byDay = new Map();
  for (const r of rows) bump(byDay, r.date, () => []).push(r);
  const shownDays = [];
  let shown = 0;
  for (const [date, list] of byDay) {
    if (shownDays.length && shown + list.length > cap) break;
    shownDays.push({ date, isToday: date === s(today), rows: list, counts: summarizeStopRows(list) });
    shown += list.length;
  }

  const byStops = (a, b) => b.stops - a.stops || String(a.city ?? a.key).localeCompare(String(b.city ?? b.key));
  return {
    query: q,
    label: q.label,
    range,
    today: s(today),
    scanned,
    matched: rows.length,
    shown,
    hiddenDays: byDay.size - shownDays.length,
    totals: summarizeStopRows(rows),
    span: rows.length ? { from: rows[rows.length - 1].date, to: rows[0].date } : null,
    months: [...months.values()]
      .sort((a, b) => (a.month < b.month ? -1 : 1))
      .map(({ rows: list, ...m }) => ({ ...m, ...summarizeStopRows(list) })),
    addresses: [...addrs.values()].sort(byStops).slice(0, TOP_ADDRESSES),
    addressCount: addrs.size,
    cities: [...cities.values()].sort(byStops).slice(0, TOP_CITIES),
    cityCount: cities.size,
    otherCities: [...other.values()].sort(byStops).slice(0, TOP_CITIES),
    drivers: driverTally(rows).slice(0, TOP_DRIVERS),
    driverCount: driverTally(rows).length,
    days: shownDays,
  };
}
