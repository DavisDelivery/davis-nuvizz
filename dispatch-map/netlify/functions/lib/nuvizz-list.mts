// lib/nuvizz-list.mts
//
// The NuVizz "stop list" (VizzonStop filterdata) — the same list the portal UI
// renders, reachable with the Basic creds we already use. This is the single source
// of list logic shared by:
//   • the interactive explorer endpoint (nuvizz-stop-explorer.mts), and
//   • the scheduled scanner's list-discovery path (refresh-stops-core), which uses
//     it as the PRIMARY source instead of number-probing /load/info & /stop/info.
//
// What it provides: which stops exist for a delivery-date window, status, load
// membership, address, special instructions. What it lacks (filled elsewhere):
// lat/lng (geocoded — see lib/geocode.mts) and per-line freight detail.

import { getNuvizzRequester } from './nuvizz-request.mts';
import { getCreds, basicAuthHeader } from './nuvizz-scan.mts';
import { etDayString } from './firestore.mts';

const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';
export const OPENAPI_BASE = NUVIZZ_BASE.replace(/\/v7\/?$/, ''); // → .../deliverit/openapi
const STOP_LISTDEF = Number(process.env.NUVIZZ_STOP_LISTDEF) || 35824; // saved stop-list columns

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Some columns arrive as a JSON "link" object string carrying the real value.
export function linkVal(x: any): any {
  if (typeof x === 'string' && x.startsWith('{')) {
    try { return JSON.parse(x).columnValue ?? ''; } catch { return ''; }
  }
  return x;
}
const numOrNull = (x: any) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
// Only allow the period grammar NuVizz uses (digits, d, +, -, /) so nothing odd is injected.
export const cleanPeriod = (p: any) => { const s = String(p || '0d'); return /^[+\-/0-9d]{1,8}$/.test(s) ? s : '0d'; };

export function buildBody(period: string, statusCsv: string, page: number, pageSize: number) {
  const f = (sequence: number, value: any) => ({ sequence, value });
  return {
    filterList: [
      f(1, '-1'), f(2, statusCsv || '-1'), f(3, '-1'), f(4, '-1'), f(5, '-1'),
      f(6, '-1'), f(7, '-1'), f(8, '-1'), f(9, '-1'),
      f(10, JSON.stringify({ period })), f(11, '-1'), f(12, JSON.stringify({ period: '' })),
    ],
    listDefId: '', customListDefId: STOP_LISTDEF, userDefaultFilter: false,
    currentPageSize: 0, canDelete: false, canEdit: false, canShow: false, canSelect: true,
    page, maxResult: pageSize, defaultSize: pageSize, filterArgsJson: {}, filterValues: [],
  };
}

// Map the column-def order (filterData[0]) onto each values[] row, pulling fields BY
// KEY (robust to column reordering) into an intermediate row object.
export function normalize(j: any): any[] {
  const cols = Object.keys((j && j.filterData && j.filterData[0]) || {});
  const idx: Record<string, number> = {};
  cols.forEach((k, i) => { idx[k] = i; });
  // Unwrap "link object" columns ({"colmnLinkId":..,"columnValue":".."}) at read time.
  // NuVizz wraps several text columns this way — load name, driver, PRO, stop #, updated —
  // and adds more over time. linkVal is a no-op on plain values, so unwrapping EVERY column
  // is safe and future-proofs us against NuVizz wrapping additional columns (otherwise the
  // raw JSON leaks straight to the board's Load/Driver/PRO cells).
  const g = (row: any[], key: string) => (idx[key] != null ? linkVal(row[idx[key]]) : undefined);
  // The portal's "Stop Updated Dttm" column — found by PATTERN, not a hardcoded key (the
  // dotted key varies by saved list def). Prefer a stop/shipment-scoped update column so an
  // unrelated "updatedBy/updatedOn" never wins; require an update token + a date/time token.
  const updatedKey =
    cols.find((k) => /updat/i.test(k) && /(dttm|date|time)/i.test(k) && /stop|shipment|vizzon/i.test(k)) ||
    cols.find((k) => /updat/i.test(k) && /(dttm|date|time)/i.test(k)) || null;
  // The portal's "Requested Date & Time" column — the date the order comes over with, found
  // by PATTERN like updatedKey (the dotted key varies by saved list def). This is the date we
  // bucket on (Estimated Arrival / earliestSchTime can be blank on a not-yet-sequenced stop
  // or stale on a rollover, which silently drops/mis-files the stop — see toBoardStop). Prefer
  // a stop/shipment/destination-scoped requested column; never let it collide with earliestSch
  // (that has no "request" token, so it can't match here).
  const requestedKey =
    cols.find((k) => /request/i.test(k) && /(dttm|date|time)/i.test(k) && /stop|shipment|vizzon|destination/i.test(k)) ||
    cols.find((k) => /request/i.test(k) && /(dttm|date|time)/i.test(k)) || null;
  return ((j && j.values) || []).map((row: any[]) => ({
    stopNbr: String(g(row, 'vizzonInfo.shipmentInfo.stopNbr') ?? ''),
    statusCode: String(g(row, 'default_vizzonInfo.shipmentInfo.status') ?? ''),
    statusText: g(row, 'vizzonInfo.shipmentInfo.status') ?? '',
    businessName: g(row, 'vizzonInfo.destination.address.name') ?? '',
    addr1: g(row, 'vizzonInfo.destination.address.line1') ?? '',
    addr2: g(row, 'vizzonInfo.destination.address.line2') ?? '',
    city: g(row, 'vizzonInfo.destination.address.city') ?? '',
    zip: g(row, 'vizzonInfo.destination.address.zipCode') ?? '',
    routeName: g(row, 'route.name') ?? '',
    driverName: g(row, 'route.driver.driverId') ?? '',
    cartons: numOrNull(g(row, 'vizzonInfo.shipmentInfo.cartons')),
    weight: numOrNull(g(row, 'vizzonInfo.shipmentInfo.weight')),
    proNbr: g(row, 'vizzonInfo.shipmentInfo.proNbr') ?? '',
    scheduledArrival: g(row, 'vizzonInfo.destination.earliestSchTime') ?? '',
    requestedArrival: requestedKey ? String(g(row, requestedKey) ?? '') : '',
    createdTime: g(row, 'vizzonInfo.createdTime') ?? '',
    updatedTime: updatedKey ? String(g(row, updatedKey) ?? '') : '',
    comments: g(row, 'comments.commentList.commentText') ?? '',
  }));
}

// NuVizz stop-status code → our board status + planned flag. (10=Un-Planned,
// 20=Planned, 40=In-Transit, 50=Arrived, 90/91=Completed, 99=Cancelled.)
export function statusFromCode(code: any, hasRoute: boolean): { status: string; planned: boolean } {
  switch (String(code)) {
    case '10': return { status: 'UNPLANNED', planned: false };
    case '20': return { status: 'SCHEDULED', planned: true };
    case '40': return { status: 'OUT_FOR_DEL', planned: true };
    case '50': return { status: 'ARRIVED', planned: true };
    case '90': case '91': return { status: 'DELIVERED', planned: true };
    // 80 = "Unable to deliver" — the explicit failure outcome (see nuvizz-scan
    // statusFromInfo). It's a FINISHED stop (the Completed saved search bundles it
    // with 90/91), but it is NOT a delivery, so it must read EXCEPTION here so
    // toBoardStop leaves deliveredDTTM null and on-time analytics never count it.
    case '80': return { status: 'EXCEPTION', planned: true };
    case '99': return { status: 'EXCEPTION', planned: hasRoute };
    default: return hasRoute ? { status: 'SCHEDULED', planned: true } : { status: 'UNPLANNED', planned: false };
  }
}

// Parse NuVizz's "M/D/YY h:mm AM" arrival into { date:'YYYY-MM-DD', iso } (local —
// used for date bucketing + route ordering, not absolute-tz math). Null if unparseable.
export function parseSchedDate(s: any): { date: string; iso: string } | null {
  const m = String(s || '').match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let mo = +m[1], d = +m[2], y = +m[3], hh = +m[4]; const mm = +m[5]; const ap = m[6] && m[6].toUpperCase();
  if (y < 100) y += 2000;
  if (ap === 'PM' && hh < 12) hh += 12;
  if (ap === 'AM' && hh === 12) hh = 0;
  const date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { date, iso: `${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00` };
}

// Pull just the calendar day (YYYY-MM-DD) out of a Requested Date value. Unlike
// parseSchedDate this is lenient: the column may arrive date-only ("6/24/26"), as a
// window ("6/24/26 8:00 AM - 8:00 PM"), or ISO — we only need the day for bucketing, so
// grab the leading date and ignore any time/range. Null if no date is present.
export function parseReqDate(s: any): string | null {
  const str = String(s || '');
  const iso = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let y = +m[3]; if (y < 100) y += 2000;
  return `${y}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
}

// Intermediate row → board-shaped stop (coords filled later). routeName doubles as
// the load id since the list carries the load NAME, not the numeric loadNbr.
export function toBoardStop(r: any): any {
  const hasRoute = !!String(r.routeName || '').trim();
  const { status, planned } = statusFromCode(r.statusCode, hasRoute);
  const sched = parseSchedDate(r.scheduledArrival);
  const reqDate = parseReqDate(r.requestedArrival);
  const upd = parseSchedDate(r.updatedTime);
  const listUpdatedDTTM = upd ? upd.iso : (r.updatedTime || null);
  return {
    stopNbr: r.stopNbr || null,
    // The PRO IS the stop number (see nuvizz-scan: pros = [stopNbr]). The list carries it for
    // EVERY stop, so surface it here — the board's PRO column reads pro/pros and would otherwise
    // show "—" on every un-enriched stop (enrichment is one capped /stop/info per new PRO, so
    // with hundreds of stops most never catch up). Free from the list, shown immediately.
    pro: r.stopNbr || null,
    pros: r.stopNbr ? [r.stopNbr] : [],
    primaryPro: r.stopNbr || null,
    loadNbr: hasRoute ? r.routeName : null,
    routeName: r.routeName || null,
    stopType: 'DO',
    status: r.statusCode || null,
    businessName: r.businessName || null,
    addr1: r.addr1 || null,
    addr2: r.addr2 || null,
    city: r.city || null,
    state: null,
    zip: r.zip || null,
    lat: null,
    lng: null,
    cartons: r.cartons,
    weight: r.weight,
    driverName: r.driverName || null,
    driverUserName: r.driverName || null,
    isPlanned: planned,
    isUnplanned: !planned,
    normalizedStatus: status,
    plannedEtaDTTM: sched ? sched.iso : null, // drives the planned-route stop ordering
    scheduledFrom: sched ? sched.iso : null,
    scheduledTo: null,
    orderInstructions: r.comments || null,
    proNbr: r.proNbr || null,
    scheduledDate: sched ? sched.date : null,
    // The Requested delivery date — a FALLBACK board day for when Estimated Arrival is blank.
    // (In Davis's saved-search feed this column is usually empty; kept for the case where it
    // is populated and a stop has no arrival yet.)
    requestedDate: reqDate,
    // The intended board day: Estimated Arrival (earliestSchTime), falling back to Requested
    // Date when arrival is blank. NOTE this is only the INTENDED day — it can be stale: a
    // rolled-over stop keeps YESTERDAY's arrival (NuVizz doesn't roll it forward) even though
    // the driver runs it today. bucketByDate clamps such open, route-assigned stops forward to
    // today so live work is never parked on a past day's board.
    boardDate: (sched ? sched.date : null) || reqDate,
    // "Stop Updated Dttm" from the list — when the order last changed (status flips incl.
    // planned→unplanned→planned, edits, delivery). A LIVE field: refreshed every scan, free,
    // no /stop/info call. Drives the "last updated" display + signals when detail is stale.
    listUpdatedDTTM,
    // Delivery time, FREE from the list: the "Stop Updated Dttm" at the scan where the stop
    // first reads DELIVERED is the delivery flip time (accuracy = scan interval). This replaces
    // the per-delivery /stop/info read — the precise execution deliveredDTTM — for the on-time
    // /late analytics. It's a STATIC field (not in LIVE_LIST_FIELDS), so once a prior scan/enrich
    // has set it, carry-forward (mergeEnrich) freezes it at the first-observed flip time rather
    // than letting a later list update drift it. EXCEPTION/cancelled is terminal but NOT a
    // delivery, so it stays null and never counts as on-time/late.
    deliveredDTTM: status === 'DELIVERED' ? listUpdatedDTTM : null,
    source: 'nuvizz-list',
  };
}

// Group board stops by their board day (YYYY-MM-DD). The day is boardDate (Estimated Arrival,
// falling back to Requested Date), with one correction for live work: an OPEN (not delivered
// /exception) stop that's ASSIGNED TO A ROUTE never buckets onto a PAST day. NuVizz does not
// roll a rolled-over stop's Estimated Arrival forward — it keeps yesterday's arrival (or none)
// even though the driver runs it today — which otherwise parks it on yesterday's board, off
// today's route (Mitchell's 007137332 / 007137372). Such stops are clamped forward to `today`
// (ET). Finished stops keep their real day so history/analytics stay accurate; open stops with
// no route are left where they are. Stops with no determinable day are dropped.
export function bucketByDate(stops: any[], today: string = etDayString()): Map<string, any[]> {
  const m = new Map<string, any[]>();
  for (const s of stops) {
    let d = s.boardDate || s.requestedDate || s.scheduledDate;
    const finished = s.normalizedStatus === 'DELIVERED' || s.normalizedStatus === 'EXCEPTION';
    const onRoute = !!s.loadNbr;
    if (!finished && onRoute && (!d || d < today)) d = today; // live route work → today, not the past
    if (!d) continue;
    if (!m.has(d)) m.set(d, []);
    m.get(d)!.push(s);
  }
  return m;
}

// ── Live pull ────────────────────────────────────────────────────────────────

// The entity endpoint's `page` param does NOT paginate (it returns page 1 every
// time), so we pull a whole day in ONE request with a high maxResult. Davis runs
// ~700 stops/day; 5000 is ample headroom (and the response was uncapped at 2000).
export const LIST_MAX_RESULT = Number(process.env.NUVIZZ_LIST_MAX_RESULT) || 5000;
// Status codes to include (seq 2). Default '-1' = all, so the board shows delivered
// /cancelled stops like the number-probe does — per-day scoping keeps OTHER days'
// completed out. Env-overridable to e.g. '10,20,40,50' (active only).
export const LIST_STATUS = process.env.NUVIZZ_LIST_STATUS || '-1';

// Period string for a target UTC date relative to NuVizz's ET "today". Handles the
// ET/UTC drift: at ~10pm ET the UTC date is already +1, so todayUTC → "+1d"; during
// the ET day they align → "0d". Mirrors how the scanner keys docs by UTC date while
// NuVizz's period filter is ET-relative.
export function periodForDate(targetDateUTC: string, etToday: string = etDayString()): string {
  const off = Math.round((Date.parse(targetDateUTC + 'T00:00:00Z') - Date.parse(etToday + 'T00:00:00Z')) / 86400000);
  return off === 0 ? '0d' : (off > 0 ? `+${off}d` : `${off}d`);
}

// Pull all stops for a single Estimated-Arrival day (one request). Rides the shared
// requester so calls count in the dashboard + honor the breaker.
export async function fetchListRows(period: string, statusCsv: string = LIST_STATUS): Promise<any[]> {
  const { companyCode } = getCreds();
  const hdr = { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json' };
  const reqr = getNuvizzRequester();
  const url = `${OPENAPI_BASE}/entity/filterdata/VizzonStop/${companyCode}`;
  const body = JSON.stringify(buildBody(cleanPeriod(period), statusCsv || '-1', 1, LIST_MAX_RESULT));
  const resp = await reqr.request(url, { method: 'POST', headers: hdr, body }, { route: '/entity/filterdata', tenant: companyCode });
  if (!resp.ok) throw new Error(`list filterdata ${resp.status}`);
  return normalize(await resp.json());
}

// Board stops for a specific target UTC date (the doc key the scanner writes). The
// period is ET-adjusted so it matches the number-probe's "today" board.
export async function listScanForDate(targetDateUTC: string): Promise<any[]> {
  const stops = fromRows(await fetchListRows(periodForDate(targetDateUTC)));
  // authoritative: we queried this exact day, so pin both the scheduled and board day to it.
  for (const s of stops) { s.scheduledDate = targetDateUTC; s.boardDate = targetDateUTC; }
  return stops;
}

// ── Two saved-search scans (the live board's source) ─────────────────────────
//
// Davis drives the board off TWO of the portal's saved searches (captured in the
// "Nuvizz_New_Filters" HAR) instead of one ad-hoc query:
//   • ACTIVE    (customListDefId 77128, "Dispatch Map Planned Unplanned") — status
//     20,10, Estimated-Arrival within +/-7d. The open work.
//   • COMPLETED (customListDefId 77131, "Dispatch Map Completed") — status 90,91,80
//     (delivered + unable-to-deliver), Estimated-Arrival +/-7d, AND Stop-Detail-Updated
//     = today (period "0d"). Just-finished stops, kept small by the "updated today" clamp.
//
// Each saved search is its OWN list def with its OWN filter-sequence layout (77128 has
// 12 sequences, 77131 has 11, the legacy 35824 has 13 — the date fields sit at different
// sequences in each), so we send each VERBATIM by customListDefId; we cannot reuse one
// def's sequence map for another. Periods are RELATIVE and server-evaluated against
// NuVizz's ET "today", so "+/-7d"/"0d" always mean the right window whenever we call.
// IDs/status/periods are env-overridable so the saved searches can be retuned in the
// portal without a code change.
const seq = (sequence: number, value: any) => ({ sequence, value });
// Build a filterList of `count` sequences (all "-1") with the given overrides applied.
function filterListOf(count: number, overrides: Record<number, any>): any[] {
  const arr = Array.from({ length: count }, (_, i) => seq(i + 1, '-1'));
  for (const [s, v] of Object.entries(overrides)) arr[Number(s) - 1] = seq(Number(s), v);
  return arr;
}
const ACTIVE_STATUS = process.env.NUVIZZ_ACTIVE_STATUS || '20,10';
const COMPLETED_STATUS = process.env.NUVIZZ_COMPLETED_STATUS || '90,91,80';
const ACTIVE_ARRIVAL = cleanPeriod(process.env.NUVIZZ_ACTIVE_ARRIVAL || '+/-7d');
const COMPLETED_ARRIVAL = cleanPeriod(process.env.NUVIZZ_COMPLETED_ARRIVAL || '+/-7d');
const COMPLETED_UPDATED = cleanPeriod(process.env.NUVIZZ_COMPLETED_UPDATED || '0d');
export const SAVED_SEARCHES = {
  active: {
    customListDefId: Number(process.env.NUVIZZ_LISTDEF_ACTIVE) || 77128,
    // seq2=status, seq10=Estimated Arrival, seq12=Stop Created (unfiltered).
    filterList: filterListOf(12, {
      2: ACTIVE_STATUS,
      10: JSON.stringify({ period: ACTIVE_ARRIVAL }),
      12: JSON.stringify({ period: '' }),
    }),
  },
  completed: {
    customListDefId: Number(process.env.NUVIZZ_LISTDEF_COMPLETED) || 77131,
    // seq2=status, seq10=Estimated Arrival, seq11=Stop Detail Updated (= today).
    filterList: filterListOf(11, {
      2: COMPLETED_STATUS,
      10: JSON.stringify({ period: COMPLETED_ARRIVAL }),
      11: JSON.stringify({ period: COMPLETED_UPDATED }),
    }),
  },
};

// Body for a saved search — exactly the portal's shape (userDefaultFilter:false + an
// explicit filterList), pulling the whole result set in one request via a high maxResult
// (the portal's currentPageSize paging is a UI concern; the API honors maxResult).
function buildSavedBody(def: { customListDefId: number; filterList: any[] }, pageSize: number) {
  return {
    filterList: def.filterList,
    listDefId: '', customListDefId: def.customListDefId, userDefaultFilter: false,
    currentPageSize: 0, canDelete: false, canEdit: false, canShow: false, canSelect: true,
    page: 1, maxResult: pageSize, defaultSize: pageSize, filterArgsJson: {}, filterValues: [],
  };
}

// Pull one saved search's intermediate rows (rides the shared requester → counts in the
// dashboard + honors the breaker, same as fetchListRows).
export async function fetchSavedSearchRows(
  def: { customListDefId: number; filterList: any[] }, pageSize: number = LIST_MAX_RESULT,
): Promise<any[]> {
  const { companyCode } = getCreds();
  const hdr = { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json' };
  const reqr = getNuvizzRequester();
  const url = `${OPENAPI_BASE}/entity/filterdata/VizzonStop/${companyCode}`;
  const body = JSON.stringify(buildSavedBody(def, pageSize));
  const resp = await reqr.request(url, { method: 'POST', headers: hdr, body }, { route: '/entity/filterdata', tenant: companyCode });
  if (!resp.ok) throw new Error(`saved-search ${def.customListDefId} filterdata ${resp.status}`);
  return normalize(await resp.json());
}

// Merge the two pulls into per-scheduled-date board buckets. COMPLETED wins over ACTIVE
// for the same stop (it's the newer state — a stop that flipped to delivered drops out of
// the active search and reappears here). Buckets by each stop's scheduled-arrival date so
// a stop sits on its delivery day's board through its whole lifecycle; stops with no
// parseable arrival date can't be placed and are dropped. PURE — unit-tested.
export function mergeTwoScan(activeRows: any[], completedRows: any[]): Map<string, any[]> {
  const byNbr = new Map<string, any>();
  for (const r of activeRows) { const s = toBoardStop(r); if (s.stopNbr) byNbr.set(s.stopNbr, s); }
  for (const r of completedRows) { const s = toBoardStop(r); if (s.stopNbr) byNbr.set(s.stopNbr, s); }
  return bucketByDate([...byNbr.values()]);
}

// Run both saved searches (in parallel) → per-date board buckets.
export async function twoScanBuckets(): Promise<Map<string, any[]>> {
  const [active, completed] = await Promise.all([
    fetchSavedSearchRows(SAVED_SEARCHES.active),
    fetchSavedSearchRows(SAVED_SEARCHES.completed),
  ]);
  return mergeTwoScan(active, completed);
}

// The saved searches bucket by ET arrival date, but the scanner keys boards by UTC date.
// Map a target UTC date to its ET-equivalent date (same offset from "today" in both
// frames, so todayUTC→etToday handles the late-night ET/UTC drift). PURE — unit-tested.
export function etDateForTargetUTC(targetDateUTC: string, todayUTC: string, etToday: string = etDayString()): string {
  const off = Math.round((Date.parse(targetDateUTC + 'T00:00:00Z') - Date.parse(todayUTC + 'T00:00:00Z')) / 86400000);
  return new Date(Date.parse(etToday + 'T00:00:00Z') + off * 86400000).toISOString().slice(0, 10);
}

// Live fields the LIST owns and refreshes every scan (current planning + status);
// everything ELSE is static detail merged from enrichment (/stop/info) and carried
// forward. So an enriched stop ends up with the FULL old-path field set (PROs,
// pallets, stop sequence, terminal flag, planned distances, line items, contact,
// timestamps, …) while the list keeps status/load/driver current.
export const LIVE_LIST_FIELDS = [
  'status', 'normalizedStatus', 'isPlanned', 'isUnplanned',
  'loadNbr', 'routeName', 'driverName', 'driverUserName',
  'scheduledDate', 'requestedDate', 'boardDate', 'listUpdatedDTTM', 'source',
];
// Copy ALL non-live fields from src (a /stop/info-normalized stop, or a prior enriched
// index doc) onto target, then mark it enriched. Never overwrites a real value with a
// null/blank, so list-derived values survive when a detail field is sparse.
export function mergeEnrich(target: any, src: any): any {
  if (!src || typeof src !== 'object') return target;
  for (const [k, v] of Object.entries(src)) {
    if (LIVE_LIST_FIELDS.includes(k) || k === 'enriched' || k === 'last_scanned_at' || k === '_id') continue;
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    target[k] = v;
  }
  target.enriched = true;
  return target;
}

// Exposed for tests: intermediate rows → board stops (dedup by stopNbr, last wins).
export function fromRows(rows: any[]): any[] {
  const byNbr = new Map<string, any>();
  for (const r of rows) {
    const s = toBoardStop(r);
    if (s.stopNbr) byNbr.set(s.stopNbr, s);
  }
  return [...byNbr.values()];
}
