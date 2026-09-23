// THE SHIPLIFY TRIAL FILE, READ ONE WAY IN BOTH PLACES THAT READ IT.
//
// Chad is deciding whether to buy Shiplify. Their test ran our own consignees through their
// location database and sent back one spreadsheet (DavisfileResults.xls): per PRO, a Shipper
// row (always Davis, 943 Gainesville Hwy) and a Consignee row carrying what Shiplify knows
// about the delivery end — is there a dock, a forklift, a gate, what kind of place it is.
//
// The browser parses the file (the import screen shows Chad the counts BEFORE anything is
// written, so he can check them against the file), and the server re-derives every location
// document from the rows it receives. Both run THIS module. A second copy of "which rows are
// consignees" or "dock yes beats no" is how the summary on the screen and the documents in
// Firestore would come to disagree, and a trial is exactly where that disagreement would go
// unnoticed: nobody knows yet what the right numbers look like.
//
// PURE. No Firestore, no DOM, no xlsx — the caller hands in the sheet's rows.

import { normalizeMatchKey, normalizePlaceKey } from './matchKey.js';
// The place-mark rules, so the import summary counts schools, churches and government sites the
// way the maps will mark them (place-mark.js imports nothing from here — no cycle).
import { shiplifyPlaceMark, TARIFF_WORDS } from './place-mark.js';

export { TARIFF_WORDS };

export const SHIPLIFY_SHEET = 'DavisfileResults';

// The file's columns, in the file's order. The raw layer keeps every one of them verbatim;
// this list is what the header check reads.
export const SHIPLIFY_COLUMNS = [
  'shipment_location_id', 'pro_number', 'pickup_date', 'entity', 'name', 'street_address',
  'city', 'state', 'postal_code', 'provider_exemption_count', 'visible_location_types',
  'all_location_types', 'tariff_items', 'dock_access', 'forklift', 'lumper', 'gated_access',
  'security_hut', 'call_box', 'appointment_required',
];

// The columns a location document cannot be built without. A file missing one of these is
// not a Shiplify results file, and importing it anyway would write 8,000 half-documents.
export const SHIPLIFY_REQUIRED_COLUMNS = [
  'pro_number', 'entity', 'name', 'street_address', 'city', 'postal_code',
  'all_location_types', 'tariff_items', 'dock_access', 'forklift',
];


// ── cell cleaning ────────────────────────────────────────────────────────────

// NBSP rides in from the spreadsheet ("SHP 00000.00" has one). Every text cell is read with
// it turned into an ordinary space, so a name with an NBSP and the same name without one key
// the same — the raw layer still keeps the byte-exact original.
export function cleanText(v) {
  if (v == null) return '';
  return String(v).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

// A PRO as the office would type it: NBSP → space, whitespace collapsed. A whole-number cell
// (the 7-digit Uline PROs can arrive as numbers) is printed without a trailing ".0".
export function cleanPro(v) {
  if (v == null) return '';
  if (typeof v === 'number' && Number.isFinite(v)) return Number.isInteger(v) ? String(v) : String(v);
  return cleanText(v);
}

// Pipe-separated list → trimmed, de-duplicated, in the order written. Blank → [].
export function splitPipe(v) {
  const out = [];
  for (const part of cleanText(v).split('|')) {
    const t = part.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// yes / no / blank, and gated's extra "partial". Anything unrecognised is BLANK, never a
// guess: "unknown" and "no" are different claims about a dock, and only one of them can be
// read as "a trailer cannot back in here".
export function triState(v, { partial = false } = {}) {
  const t = cleanText(v).toLowerCase();
  if (t === 'yes' || t === 'y' || t === 'true') return 'yes';
  if (t === 'no' || t === 'n' || t === 'false') return 'no';
  if (partial && t === 'partial') return 'partial';
  return '';
}

// Excel's day 0 is 1899-12-30 (the 1900 leap-year bug folded in), so serial 46251 is
// Aug 17, 2026. Accepts the serial as a number or a numeric string, an ISO date, a US
// M/D/YY(YY) date, or a Date. Anything else is '' — a stop with no date, not a wrong one.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86400000;
function isoOf(y, m, d) {
  if (!(y >= 1900 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
export function excelDateToIso(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    return isoOf(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  }
  const serialOf = (n) => {
    // A date serial is a day count; a time-of-day fraction is dropped, not rounded, so
    // 46251.99 is still the 17th.
    if (!(n > 0 && n < 120000)) return '';
    const dt = new Date(EXCEL_EPOCH_MS + Math.floor(n) * DAY_MS);
    return isoOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  };
  if (typeof v === 'number') return Number.isFinite(v) ? serialOf(v) : '';
  const t = cleanText(v);
  if (/^\d+(\.\d+)?$/.test(t)) return serialOf(Number(t));
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t);
  if (m) return isoOf(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return isoOf(y, Number(m[1]), Number(m[2]));
  }
  return '';
}

// ── the sheet → row objects ──────────────────────────────────────────────────

// Header cells are matched case-insensitively with spaces read as underscores, so a file that
// was re-saved through Excel with "Dock Access" still lines up.
function headerName(h) {
  return cleanText(h).toLowerCase().replace(/[\s-]+/g, '_');
}

// A column's spreadsheet letter: 0 → A, 25 → Z, 26 → AA — how Chad would find it in the file.
export function columnLetter(j) {
  let s = '';
  for (let n = Math.trunc(j) + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/**
 * The sheet as an array of arrays (xlsx sheet_to_json header:1) → one object per data row,
 * keyed by the file's own column names, with the cell values UNTOUCHED — this is the raw
 * layer. Returns { header, rows, missing, duplicate }:
 *
 *   missing    required columns the header does not carry, AND any of the file's own columns
 *              the header names twice (the caller refuses the file when this is non-empty —
 *              with two "name" columns nobody can say which is the consignee's, and guessing
 *              keys every location on the wrong name)
 *   duplicate  those repeated columns, [{ name, columns: ['E', 'U'] }]
 *
 * NOTHING IN THE SHEET IS DROPPED. A column whose header repeats one already seen, a column
 * with a blank header, and a cell past the header's width are kept under `col_<letter>`
 * (e.g. col_U); an empty cell in an unlabelled column adds nothing. A file with none of those
 * produces exactly the objects it always did, so its batch id does not move.
 */
export function rowsFromAoa(aoa) {
  const table = Array.isArray(aoa) ? aoa : [];
  // The header is the first row that names at least three of our columns — a title row above
  // the header ("Davis file results") must not become the header.
  let headerAt = -1;
  for (let i = 0; i < Math.min(table.length, 20); i++) {
    const cells = (table[i] || []).map(headerName);
    if (SHIPLIFY_COLUMNS.filter((c) => cells.includes(c)).length >= 3) { headerAt = i; break; }
  }
  if (headerAt < 0) return { header: [], rows: [], missing: SHIPLIFY_REQUIRED_COLUMNS.slice(), duplicate: [] };
  const header = (table[headerAt] || []).map(headerName);

  // One distinct key per column. The first column of a name keeps it; a repeat, or a blank
  // header, is keyed by its letter. `used` also keeps a real header that happens to read
  // "col_u" from colliding with a letter key.
  const used = new Set();
  const fresh = (k) => { let out = k; while (used.has(out)) out += '_'; used.add(out); return out; };
  const seen = new Map();
  const keys = header.map((h, j) => {
    if (h && SHIPLIFY_COLUMNS.includes(h)) seen.set(h, [...(seen.get(h) || []), columnLetter(j)]);
    return fresh(h && !used.has(h) ? h : `col_${columnLetter(j)}`);
  });
  const overflow = new Map();
  const keyPast = (j) => { if (!overflow.has(j)) overflow.set(j, fresh(`col_${columnLetter(j)}`)); return overflow.get(j); };

  const rows = [];
  for (let i = headerAt + 1; i < table.length; i++) {
    const cells = table[i] || [];
    if (!cells.some((c) => cleanText(c) !== '')) continue;   // blank row: not a row
    const o = {};
    const width = Math.max(header.length, cells.length);
    for (let j = 0; j < width; j++) {
      const c = cells[j];
      if (j < header.length && header[j]) { o[keys[j]] = c === undefined ? '' : c; continue; }
      if (c === undefined || c === null || c === '') continue;   // an empty unlabelled cell
      o[j < header.length ? keys[j] : keyPast(j)] = c;
    }
    rows.push(o);
  }
  const duplicate = [...seen.entries()].filter(([, cols]) => cols.length > 1).map(([name, columns]) => ({ name, columns }));
  const missing = [
    ...SHIPLIFY_REQUIRED_COLUMNS.filter((c) => !header.includes(c)),
    ...duplicate.map((d) => `one "${d.name}" column (${d.columns.length} are headed "${d.name}": ${d.columns.join(', ')})`),
  ];
  return { header, rows, missing, duplicate };
}

// ── one row, normalised ──────────────────────────────────────────────────────

export function entityOf(row) {
  const t = cleanText(row?.entity).toLowerCase();
  if (t === 'consignee') return 'consignee';
  if (t === 'shipper') return 'shipper';
  return t ? 'other' : '';
}

/**
 * One raw row → the normalised fields a location document is built from, plus its keys.
 * The keys are the app's OWN normalizeMatchKey / normalizePlaceKey over the file's own name,
 * street, city and ZIP — the same functions that key customer_notes and tractor_locations,
 * so a Shiplify location and a board stop at the same customer land on the same key without
 * a translation table nobody would maintain.
 */
export function normalizeShiplifyRow(row) {
  const name = cleanText(row?.name);
  const street = cleanText(row?.street_address);
  const city = cleanText(row?.city);
  const state = cleanText(row?.state).toUpperCase();
  const zip = cleanText(row?.postal_code);
  const hasKeyParts = !!(name && street && zip);
  return {
    entity: entityOf(row),
    pro: cleanPro(row?.pro_number),
    pickup_date: excelDateToIso(row?.pickup_date),
    name, street, city, state, zip,
    location_types: splitPipe(row?.all_location_types),
    visible_location_types: splitPipe(row?.visible_location_types),
    tariff_items: splitPipe(row?.tariff_items).map((t) => t.toUpperCase()),
    dock_access: triState(row?.dock_access),
    forklift: triState(row?.forklift),
    lumper: triState(row?.lumper),
    gated_access: triState(row?.gated_access, { partial: true }),
    security_hut: triState(row?.security_hut),
    call_box: triState(row?.call_box),
    appointment_required: triState(row?.appointment_required),
    match_key: hasKeyParts ? normalizeMatchKey(name, street, city, zip) : '',
    place_key: normalizePlaceKey(street, zip),
  };
}

/**
 * Why a row does NOT become (part of) a location. '' means it does. A Shipper row is not an
 * error — it is Davis's own dock on every PRO — but it is never a delivery location, so it is
 * kept in the raw layer and counted here under its own reason rather than mixed into "bad".
 */
export function skipReasonOf(n) {
  if (n.entity === 'shipper') return 'shipper_row';
  if (n.entity !== 'consignee') return n.entity ? 'unknown_entity' : 'no_entity';
  if (!n.name) return 'no_name';
  if (!n.street) return 'no_street';
  if (!n.zip) return 'no_zip';
  if (!n.match_key || !/[a-z0-9]/.test(n.match_key)) return 'no_match_key';
  return '';
}

// ── merging the rows that share one key ─────────────────────────────────────

// Rank for "which answer wins when two PROs to the same place disagree". A present feature
// beats an absent one, and either beats silence: dock yes beats no beats blank, as briefed.
// The same order is used for every yes/no field so the rule has one shape.
const RANK = { yes: 3, partial: 2, no: 1, '': 0 };
const TRI_FIELDS = ['dock_access', 'forklift', 'lumper', 'gated_access', 'security_hut', 'call_box', 'appointment_required'];

export function bestTri(values) {
  let best = '';
  for (const v of values) if ((RANK[v] ?? 0) > (RANK[best] ?? 0)) best = v;
  return best;
}

// The display value for a text field across rows: the most common spelling, ties broken by
// plain string order — never by row order, so the same file always produces the same doc.
function modal(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = '';
  let bestN = 0;
  for (const [v, n] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (n > bestN) { best = v; bestN = n; }
  }
  return best;
}

const sortedUnion = (lists) => [...new Set(lists.flat().filter(Boolean))].sort();

export function residentialKindOf(locationTypes, residential) {
  if (!residential) return null;
  return (locationTypes || []).some((t) => /apartment/i.test(String(t))) ? 'apartment' : 'home';
}

/**
 * Every normalised consignee row of ONE match key → the location document's derived fields
 * (everything except tenant / batch_id / imported_at, which the writer stamps).
 *
 * Deterministic in the rows' CONTENT, not their order: re-importing the same file, or the
 * same rows shuffled, produces byte-identical documents. Lists are sorted unions; text fields
 * take the most common spelling; yes/no fields take the strongest answer and, when the rows
 * genuinely disagreed, say so in `conflicts` so the disagreement is on the record instead of
 * silently resolved.
 */
export function mergeLocationRows(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (!list.length) return null;
  const key = list[0].match_key;
  const conflicts = {};
  const tri = {};
  for (const f of TRI_FIELDS) {
    const seen = [...new Set(list.map((r) => r[f] || '').filter(Boolean))].sort();
    if (seen.length > 1) conflicts[f] = seen;
    tri[f] = bestTri(list.map((r) => r[f] || ''));
  }
  const location_types = sortedUnion(list.map((r) => r.location_types || []));
  const tariff_items = sortedUnion(list.map((r) => r.tariff_items || []));
  const residential = tariff_items.includes('RES');
  const dates = list.map((r) => r.pickup_date).filter(Boolean).sort();
  // Different spellings of the same place collapsing onto one key — the "key collision" the
  // import log counts. Recorded per location so a surprising merge can be traced to its rows.
  const spellings = [...new Set(list.map((r) => [r.name, r.street, r.city, r.zip].join(' | ')))].sort();
  const place_key = modal(list.map((r) => r.place_key));
  return {
    match_key: key,
    place_key,
    name: modal(list.map((r) => r.name)),
    street: modal(list.map((r) => r.street)),
    city: modal(list.map((r) => r.city)),
    state: modal(list.map((r) => r.state)),
    zip: modal(list.map((r) => r.zip)),
    location_types,
    visible_location_types: sortedUnion(list.map((r) => r.visible_location_types || [])),
    tariff_items,
    residential,
    residential_kind: residentialKindOf(location_types, residential),
    ...tri,
    pros: sortedUnion(list.map((r) => (r.pro ? [r.pro] : []))),
    stop_count: list.length,
    first_date: dates[0] || null,
    last_date: dates[dates.length - 1] || null,
    spellings: spellings.length > 1 ? spellings : [],
    conflicts,
  };
}

/**
 * The whole sheet → everything the import writes and everything the summary shows.
 *
 * Returns {
 *   total, byEntity: { consignee, shipper, other },
 *   groups: Map(matchKey → normalised consignee rows),
 *   skipped: [{ index, reason }]   (index is the 0-based data row)
 *   skippedByReason: { reason → n } (shipper_row included — every row is accounted for),
 * }
 */
export function groupShiplifyRows(rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const groups = new Map();
  const skipped = [];
  const skippedByReason = {};
  const byEntity = { consignee: 0, shipper: 0, other: 0 };
  rows.forEach((raw, index) => {
    const n = normalizeShiplifyRow(raw);
    if (n.entity === 'consignee') byEntity.consignee += 1;
    else if (n.entity === 'shipper') byEntity.shipper += 1;
    else byEntity.other += 1;
    const reason = skipReasonOf(n);
    if (reason) {
      skipped.push({ index, reason });
      skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
      return;
    }
    if (!groups.has(n.match_key)) groups.set(n.match_key, []);
    groups.get(n.match_key).push({ ...n, index });
  });
  return { total: rows.length, byEntity, groups, skipped, skippedByReason };
}

/**
 * The numbers Chad checks against the file before anything is written. Counted over
 * CONSIGNEE rows (a Shipper row is Davis's own dock and would add 14,836 copies of one
 * answer to every count).
 */
export function summarizeShiplify(rawRows) {
  const g = groupShiplifyRows(rawRows);
  const s = {
    rows: g.total,
    consignee: g.byEntity.consignee,
    shipper: g.byEntity.shipper,
    other: g.byEntity.other,
    tariffs: { RES: 0, LIM: 0, GROC: 0 },
    otherTariffs: {},
    dock: { yes: 0, no: 0, blank: 0 },
    forkliftNoDock: 0,
    locationsByMatchKey: g.groups.size,
    locationsByPlaceKey: 0,
    collisions: 0,
    conflicts: 0,
    skippedByReason: { ...g.skippedByReason },
    dates: { first: null, last: null },
    // Locations by the place mark the maps will give them (school, then church, then government,
    // then residential) — the counts that decide every Shiplify place mark and no-tractor flag.
    placeMarks: { school: 0, church: 0, government: 0, residential: 0 },
  };
  const places = new Set();
  const dates = [];
  for (const raw of (Array.isArray(rawRows) ? rawRows : [])) {
    const n = normalizeShiplifyRow(raw);
    if (n.entity !== 'consignee') continue;
    for (const t of n.tariff_items) {
      if (t in s.tariffs) s.tariffs[t] += 1;
      else s.otherTariffs[t] = (s.otherTariffs[t] || 0) + 1;
    }
    if (n.dock_access === 'yes') s.dock.yes += 1;
    else if (n.dock_access === 'no') s.dock.no += 1;
    else s.dock.blank += 1;
    if (n.dock_access === 'no' && n.forklift === 'yes') s.forkliftNoDock += 1;
    if (n.pickup_date) dates.push(n.pickup_date);
  }
  for (const list of g.groups.values()) {
    const loc = mergeLocationRows(list);
    if (loc.place_key) places.add(loc.place_key);
    if (loc.spellings.length) s.collisions += 1;
    if (Object.keys(loc.conflicts).length) s.conflicts += 1;
    const mark = shiplifyPlaceMark(loc);
    if (mark) s.placeMarks[mark] += 1;
  }
  s.locationsByPlaceKey = places.size;
  dates.sort();
  s.dates = { first: dates[0] || null, last: dates[dates.length - 1] || null };
  return s;
}

// ── batches ──────────────────────────────────────────────────────────────────

// A stable hash of the rows' content, so the SAME file imported twice gets the SAME batch
// id — and therefore writes the same raw documents and the same location documents, instead
// of a second copy of everything under a new name. FNV-1a over the canonical JSON, twice with
// different seeds for 64 bits: collisions between two different Shiplify files are not a
// realistic concern, and this runs identically in the browser and in Node with no crypto API.
function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
export function canonicalRowsJson(rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  return JSON.stringify(rows.map((r) => {
    const o = {};
    for (const k of Object.keys(r || {}).sort()) o[k] = r[k];
    return o;
  }));
}
export function shiplifyBatchId(rawRows) {
  const s = canonicalRowsJson(rawRows);
  const a = fnv1a(s, 0x811c9dc5).toString(16).padStart(8, '0');
  const b = fnv1a(s, 0x01234567).toString(16).padStart(8, '0');
  return `shp_${a}${b}`;
}

// The same 64-bit content hash, bare (16 hex, no prefix), for ONE raw chunk rather than the
// whole file. The server stamps it on every stored raw chunk so a replayed chunk can be told
// from a different one without comparing a thousand rows, and so the processor can re-check
// on read that what it reads back is what was written. Same rule as the batch id by
// construction: shiplifyBatchId(rows) === 'shp_' + shiplifyContentHash(rows).
export function shiplifyContentHash(rawRows) {
  return shiplifyBatchId(rawRows).slice(4);
}

/** Split a list into chunks of `size` (the last one shorter). */
export function chunk(list, size) {
  const out = [];
  const n = Math.max(1, Number(size) || 1);
  for (let i = 0; i < (list || []).length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * The location groups, in a FIXED order (by match key), cut into chunks that never split a
 * group — every row of one key travels in one request, so the server can merge a location
 * from its complete set of rows without reading anything back. `maxRows` bounds a request.
 */
export function groupChunks(groups, maxRows = 1500) {
  const keys = [...groups.keys()].sort();
  const out = [];
  let cur = [];
  let n = 0;
  for (const k of keys) {
    const rows = groups.get(k);
    if (cur.length && n + rows.length > maxRows) { out.push(cur); cur = []; n = 0; }
    cur.push({ match_key: k, rows });
    n += rows.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ── the compact index the map reads ─────────────────────────────────────────
//
// 8,680 location documents are ~6 MB to stream to a phone on every page load, and the map
// needs eight facts per location. The import writes a compact index beside them (a few
// documents of tab-separated lines) and the map reads that instead; the full documents stay
// the record and the thing verified.

const CODE_OF = { yes: 'y', no: 'n', partial: 'p', '': '-' };
const TRI_OF = { y: 'yes', n: 'no', p: 'partial', '-': '' };
const CODE_FIELDS = ['dock_access', 'forklift', 'lumper', 'gated_access', 'security_hut', 'call_box', 'appointment_required'];

export function encodeIndexLine(loc) {
  const codes = CODE_FIELDS.map((f) => CODE_OF[loc?.[f] || ''] || '-').join('');
  const clean = (s) => String(s ?? '').replace(/[\t\n|]/g, ' ');
  return [
    clean(loc?.match_key), clean(loc?.place_key), codes,
    (loc?.location_types || []).map(clean).join('|'),
    (loc?.tariff_items || []).map(clean).join('|'),
    clean(loc?.batch_id), clean(loc?.last_date || ''),
  ].join('\t');
}

export function decodeIndexLine(line) {
  const parts = String(line || '').split('\t');
  if (parts.length < 5 || !parts[0]) return null;
  const [match_key, place_key, codes, types, tariffs, batch_id = '', last_date = ''] = parts;
  const rec = { match_key, place_key };
  CODE_FIELDS.forEach((f, i) => { rec[f] = TRI_OF[codes[i]] ?? ''; });
  rec.location_types = types ? types.split('|') : [];
  rec.tariff_items = tariffs ? tariffs.split('|') : [];
  rec.residential = rec.tariff_items.includes('RES');
  rec.batch_id = batch_id;
  rec.last_date = last_date || null;
  return rec;
}

// Lines per index document. At ~120 bytes a line, 2,500 lines is ~300 KB — a third of
// Firestore's 1 MiB document cap, so a location with a long list of types cannot tip a chunk
// over it.
export const INDEX_LINES_PER_DOC = 2500;

// ── how the raw rows travel ──────────────────────────────────────────────────

/**
 * Cut the sheet's rows into upload chunks bounded by BOTH a row count and an encoded size.
 *
 * Each chunk is stored as one Firestore document (the raw layer), and a document holds at most
 * 1 MiB — the server refuses a chunk past 900 KB. A fixed 1,000 rows is ~400 KB for this file,
 * but a file with long location-type lists or wide free-text cells could cross the cap, and the
 * import cannot be re-split once its first chunk is stored. So the split is decided here, before
 * `begin`, by measuring. → [{ row_start, rows }] covering every row once, in order.
 */
export function chunkRowsBySize(rows, { maxRows = 1000, maxBytes = 700 * 1024 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const sizeOf = (r) => {
    const s = JSON.stringify(r);
    return enc ? enc.encode(s).length : s.length * 3;
  };
  const out = [];
  let cur = [];
  let bytes = 2;
  let start = 0;
  list.forEach((r, i) => {
    const b = sizeOf(r) + 1;
    if (cur.length && (cur.length >= maxRows || bytes + b > maxBytes)) {
      out.push({ row_start: start, rows: cur });
      cur = []; bytes = 2; start = i;
    }
    cur.push(r);
    bytes += b;
  });
  if (cur.length) out.push({ row_start: start, rows: cur });
  return out;
}
