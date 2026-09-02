// src/lib/uline-forecast-lane.js
//
// ── FROM A READ SPREADSHEET TO ONE FORECAST VERSION ─────────────────────────
//
// readUlineForecast (netlify/functions/lib/uline-forecast.mts) turns bytes into rows and says
// which rows it could not read. This layer turns those rows into the thing the app stores and
// scores: the Georgia / Davis lane only, keyed by ship date, with every row that did NOT make
// it counted under a reason — because a forecast that is quietly shorter than the file Uline
// sent is the failure this whole feature exists to prevent, one level down.
//
// PURE. No I/O, no clock: the version's send date comes from the email that carried it and the
// caller passes it in. The content digest is computed by the caller (node:crypto is a server
// concern); this file supplies the canonical string it hashes, so identity is defined here and
// tested here.

/** The lane this app runs. Uline's file has always carried both codes on every row. */
export const LANE = { warehouse: 'G', via: 'DA' };
/** A Georgia warehouse code as Uline writes it. "G" in the forecast spreadsheet; "G1" and "G6"
 *  on the nightly manifest — the same freight, two spellings from one shipper. */
export const GEORGIA_WHS_RE = /^G\d*$/;
/** The ones actually seen. A new Georgia building is counted and warned about, not dropped. */
export const KNOWN_WAREHOUSES = new Set(['G', 'G1', 'G6']);
/** Fewer kept rows than this is a snippet or a stray sheet, not a 12-month forecast. */
export const MIN_LANE_ROWS = 20;
/** More rejected rows than this share of the file is a file whose date or number column
 *  half-misread — refuse it (kept as evidence) rather than adopt a half-empty forecast. */
export const MAX_REJECT_RATIO = 0.05;
/** A ship date this far outside the send date is a misread (a 1926 forecast), not a plan. */
export const WINDOW_BACK_DAYS = 60;
export const WINDOW_FORWARD_DAYS = 400;

const ET_TZ = 'America/New_York';

/** The ET calendar day an epoch-ms instant falls on. A forecast received 23:30 ET on the 3rd
 *  (03:30 UTC on the 4th) is the 3rd's version. */
export function sentDateET(ms) {
  // Number(null) is 0 and 0 is a finite instant — 1969-12-31 in ET. The trap CLAUDE.md names.
  if (ms == null || ms === '' || typeof ms === 'boolean') return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(n));
  const get = (t) => p.find((x) => x.type === t)?.value ?? '';
  const d = `${get('year')}-${get('month')}-${get('day')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

export function shiftIso(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const norm = (v) => String(v ?? '').trim().toUpperCase();
const median = (xs) => {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * Keep the lane, count everything else, decide whether the file is usable.
 *
 * @param {object} read   the ForecastRead from readUlineForecast
 * @param {string} sentDate  ISO ET day the email was received (the version's date)
 * @returns {{
 *   ok: boolean, reason: string|null,
 *   days: Record<string,[number, number|null]>,   // ship date -> [estimate, high]
 *   unreadableDates: string[],                     // dates Uline sent a row for that could not be read
 *   rowsTotal: number, rowsUsed: number,
 *   rowsDropped: { otherWarehouse: Record<string,number>, otherVia: Record<string,number>, blankLane: number,
 *                  badDate: number, badNumber: number, negative: number, duplicateDate: number, outOfWindow: number },
 *   seen: { warehouses: string[], vias: string[] },
 *   headers: string[], warnings: string[], from: string|null, to: string|null,
 *   weekdayMeans: Record<string, number|null>, medianBand: number|null,
 * }}
 */
export function laneRows(read, sentDate) {
  const rows = Array.isArray(read?.rows) ? read.rows : [];
  const dropped = Array.isArray(read?.dropped) ? read.dropped : [];
  const cols = read?.cols || {};
  const warnings = [...(Array.isArray(read?.warnings) ? read.warnings : [])];
  const rowsDropped = { otherWarehouse: {}, otherVia: {}, blankLane: 0, badDate: 0, badNumber: 0, negative: 0, duplicateDate: 0, summedAcrossWarehouses: 0, outOfWindow: 0, otherLaneDropped: 0 };
  const lanes = {};
  const hasWarehouseColEarly = cols.warehouse != null; const hasViaColEarly = cols.via != null;
  const ourDrop = (d) => {
    const w = norm(d?.warehouse); const v = norm(d?.via);
    if (hasViaColEarly && v && v !== LANE.via) return false;
    if (hasWarehouseColEarly && w && !GEORGIA_WHS_RE.test(w)) return false;
    return true;
  };
  for (const d of dropped) {
    if (!ourDrop(d)) { rowsDropped.otherLaneDropped += 1; continue; }
    if (d.reason === 'bad_date') rowsDropped.badDate += 1;
    else if (d.reason === 'bad_number') rowsDropped.badNumber += 1;
    else if (d.reason === 'negative') rowsDropped.negative += 1;
    else if (d.reason === 'duplicate') rowsDropped.duplicateDate += 1;
  }
  const seenW = new Set(); const seenV = new Set();
  const hasWarehouseCol = cols.warehouse != null;
  const hasViaCol = cols.via != null;
  const lo = sentDate ? shiftIso(sentDate, -WINDOW_BACK_DAYS) : null;
  const hi = sentDate ? shiftIso(sentDate, WINDOW_FORWARD_DAYS) : null;

  const days = {};
  const bands = [];
  for (const r of rows) {
    const w = norm(r.warehouse); const v = norm(r.via);
    if (w) seenW.add(w); if (v) seenV.add(v);
    // THE LANE. A column that is not in the file at all is a re-export and the row is kept
    // (Uline has never sent a second lane, so an absent column cannot be hiding one). A
    // BLANK cell in a column that IS present is a subtotal or a stray line, not Georgia.
    // GEORGIA, ANY OF ITS BUILDINGS. The nightly manifest — the same freight from the same
    // shipper — writes G1 and G6 and NEVER the bare "G" this spreadsheet uses. An exact match on
    // "G" is therefore a filter on a code Uline does not spell consistently: the day their
    // forecast breaks Georgia out the way their manifest already does, every row would be
    // rejected and the card would go dark. So the test is a GEORGIA code (G, G1, G6, …) on the
    // Davis lane. A warehouse that is not Georgia's is still counted and dropped, never summed
    // in — Chad: "only look at Uline pros for this not anything else."
    if (hasWarehouseCol) {
      if (!w) { rowsDropped.blankLane += 1; continue; }
      if (!GEORGIA_WHS_RE.test(w)) { rowsDropped.otherWarehouse[w] = (rowsDropped.otherWarehouse[w] || 0) + 1; continue; }
    }
    if (hasViaCol) {
      if (!v) { rowsDropped.blankLane += 1; continue; }
      if (v !== LANE.via) { rowsDropped.otherVia[v] = (rowsDropped.otherVia[v] || 0) + 1; continue; }
    }
    if (lo && hi && (r.date < lo || r.date > hi)) { rowsDropped.outOfWindow += 1; continue; }
    const est = Number(r.estimate);
    const up = r.upperEst == null ? null : Number(r.upperEst);
    if (Number.isFinite(up)) bands.push(up - est);
    lanes[`${w || '?'}/${v || '?'}`] = (lanes[`${w || '?'}/${v || '?'}`] || 0) + 1;
    if (days[r.date]) {
      // A SECOND WAREHOUSE ON THE SAME SHIP DATE IS MORE FREIGHT, NOT A DUPLICATE — both
      // buildings' orders land on our dock that night. (The reader has already dropped a repeat
      // of the same date+warehouse+via, so anything reaching here is a different building.) One
      // leg without a high makes the DAY's high unknown rather than a partial ceiling.
      rowsDropped.summedAcrossWarehouses += 1;
      days[r.date][0] += est;
      days[r.date][1] = Number.isFinite(up) && days[r.date][1] != null ? days[r.date][1] + up : null;
      continue;
    }
    days[r.date] = [est, Number.isFinite(up) ? up : null];
  }
  if (!hasWarehouseCol || !hasViaCol) warnings.push(`lane columns absent (${[!hasWarehouseCol && 'warehouse', !hasViaCol && 'via'].filter(Boolean).join(', ')}) — rows kept as ${LANE.warehouse}/${LANE.via}`);
  // A warehouse Davis has never run under is worth a look even though it is counted: the freight
  // is routed to us either way, but it is a change in how Uline writes the file.
  const unfamiliar = Object.keys(lanes).map((k) => k.split('/')[0]).filter((w) => !KNOWN_WAREHOUSES.has(w));
  if (unfamiliar.length) warnings.push(`warehouse${unfamiliar.length === 1 ? '' : 's'} not seen before on the ${LANE.via} lane: ${[...new Set(unfamiliar)].join(', ')} — counted, because the carrier code is ours`);
  if (rowsDropped.summedAcrossWarehouses) warnings.push(`${rowsDropped.summedAcrossWarehouses} ship date${rowsDropped.summedAcrossWarehouses === 1 ? '' : 's'} carried more than one warehouse — the day's estimate is their sum`);

  // Dates Uline sent a row for that could not be read: a day with no NUMBER, which the
  // outlook must never render as a day with no FREIGHT.
  // OURS ONLY. A bad number on somebody else's warehouse is not a hole in Georgia's forecast —
  // it used to paint a day the file states perfectly as "a row that could not be read" and take
  // it out of scoring. A drop with no lane recorded is treated as ours: unattributable, so the
  // cautious reading is the one that does not quietly drop a day.
  const oursDrop = (d) => {
    const w = norm(d?.warehouse); const v = norm(d?.via);
    if (hasViaCol && v && v !== LANE.via) return false;
    if (hasWarehouseCol && w && !GEORGIA_WHS_RE.test(w)) return false;
    return true;
  };
  const unreadableDates = [...new Set(dropped.filter((d) => d.date && (d.reason === 'bad_number' || d.reason === 'negative') && oursDrop(d)).map((d) => d.date))].sort();

  const keys = Object.keys(days).sort();
  const rowsUsed = keys.length;
  const rowsTotal = rows.length + dropped.length;
  const rejected = rowsDropped.badDate + rowsDropped.badNumber + rowsDropped.negative + rowsDropped.outOfWindow;

  const weekdayMeans = {};
  const byWd = {};
  for (const k of keys) { const wd = new Date(`${k}T12:00:00Z`).getUTCDay(); (byWd[wd] = byWd[wd] || []).push(days[k][0]); }
  for (let wd = 0; wd < 7; wd++) weekdayMeans[wd] = byWd[wd] ? Math.round(byWd[wd].reduce((a, b) => a + b, 0) / byWd[wd].length) : null;

  let ok = true; let reason = null;
  if (rowsUsed < MIN_LANE_ROWS) {
    ok = false;
    reason = `${rowsUsed} ${LANE.warehouse}/${LANE.via} row${rowsUsed === 1 ? '' : 's'} (need ${MIN_LANE_ROWS}) — warehouses seen: ${[...seenW].join(', ') || 'none'}; vias seen: ${[...seenV].join(', ') || 'none'}; headers: ${(read?.headers || []).join(', ') || 'none'}`;
  } else if (rowsTotal > 0 && rejected / rowsTotal > MAX_REJECT_RATIO) {
    ok = false;
    reason = `${rejected} of ${rowsTotal} rows could not be read (${(100 * rejected / rowsTotal).toFixed(0)}%) — more than ${Math.round(MAX_REJECT_RATIO * 100)}% means the date or number column did not read`;
  }
  return {
    ok, reason, days, unreadableDates, rowsTotal, rowsUsed, rowsDropped, lanes,
    seen: { warehouses: [...seenW].sort(), vias: [...seenV].sort() },
    headers: Array.isArray(read?.headers) ? read.headers : [],
    warnings,
    from: keys[0] ?? null, to: keys[keys.length - 1] ?? null,
    weekdayMeans, medianBand: median(bands),
  };
}

/**
 * THE STRING THAT IS A VERSION'S IDENTITY. Sorted rows `date|estimate|high`, one per line —
 * the CONTENT, never the bytes: a forward or a re-save changes bytes and must collapse onto
 * the same version; a corrected sheet changes a number and must be a new one.
 */
export function canonicalRows(days) {
  return Object.keys(days || {}).sort().map((d) => `${d}|${days[d][0]}|${days[d][1] ?? ''}`).join('\n');
}

/** Date-first so the ids sort chronologically; the digest prefix makes same-day corrections distinct. */
export function versionIdFor(tenant, sentDate, digest) {
  return `${tenant}__${sentDate}__${String(digest || '').slice(0, 8)}`;
}
