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
import { getCreds, basicAuthHeader, isAttemptShipment } from './nuvizz-scan.mts';
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
// Blank/whitespace → null, NOT 0: Number('') is 0, which would turn an empty cell
// (a missing weight, or an unsequenced stop's blank ShipTo-Display-Seq) into a real 0 —
// sorting a blank-seq stop to the FRONT of the route. Treat empty as "unknown" = null.
const numOrNull = (x: any) => { if (x == null || String(x).trim() === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };
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

// One-time warning if the saved-search columns carry NO shipment-number column — that
// would make the ATT attempt-marker detection silently inert (zero calls, but zero
// attempts ever found). Module-level so it logs once per warm instance, not per row.
let __warnedNoShipmentKey = false;
let __warnedNoDisplaySeq = false;

// True for a bare DB identifier (Mongo ObjectId / long hex / 25+-char token) — i.e. NOT a human
// name. Used to keep a driverId from ever being shown as a driver name (#254).
export function isHashLikeId(v: any): boolean {
  const s = String(v ?? '').trim();
  if (!s || /\s/.test(s)) return false;                 // human names are short words or have spaces
  if (/^[0-9a-f]{24}$/i.test(s)) return true;           // Mongo ObjectId
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;          // long hex token
  if (/^[A-Za-z0-9_-]{20,}$/.test(s) && /\d/.test(s)) return true; // long id-ish token containing a digit
  return false;
}
// First argument that is a real (non-blank, non-hash) human name; '' if none.
function firstNonHashName(...vals: any[]): string {
  for (const v of vals) {
    const s = String(v ?? '').trim();
    if (s && !isHashLikeId(s)) return s;
  }
  return '';
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
  // The SHIPMENT number column (distinct from stopNbr). Customer service prepends "ATT" to
  // a failed delivery's shipment number, so this is the authoritative re-attempt marker.
  // Found by pattern (dotted key varies by list def); exclude any "stop" key so it can never
  // alias onto stopNbr. The usual key is vizzonInfo.shipmentInfo.shipmentNbr.
  const shipmentKey =
    (idx['vizzonInfo.shipmentInfo.shipmentNbr'] != null ? 'vizzonInfo.shipmentInfo.shipmentNbr' : null) ||
    cols.find((k) => /shipment/i.test(k) && /(nbr|number)/i.test(k) && !/stop/i.test(k)) || null;
  if (!shipmentKey && cols.length && !__warnedNoShipmentKey) {
    __warnedNoShipmentKey = true;
    console.warn(`[nuvizz-list] no shipment-number column in saved-search results — ATT attempt detection is INERT until a shipment column is present. cols=${JSON.stringify(cols).slice(0, 600)}`);
  }
  // The "ShipTo - Display Seq" column — NuVizz's authoritative delivery ORDER of each stop within
  // its load (1..N). Found by PATTERN against BOTH the dotted column key AND its display name
  // (`columnName`), because NuVizz may key the column by an opaque internal path while only the
  // human label reads "ShipTo - Display Seq". Surfaced as routeSeq so the board/Compare panel
  // sequences stops in the real delivery order off the cheap list feed — no per-stop enrichment
  // needed (mirrors the Estimated-Arrival column add).
  const colDefs: Record<string, any> = (j && j.filterData && j.filterData[0]) || {};
  const colHay = (k: string) => `${k} ${String(colDefs[k]?.columnName ?? '')}`.toLowerCase();
  const displaySeqKey =
    cols.find((k) => /display/.test(colHay(k)) && /seq/.test(colHay(k))) ||
    cols.find((k) => /ship.?to/.test(colHay(k)) && /seq/.test(colHay(k))) ||
    cols.find((k) => /(destination|deliver)/.test(colHay(k)) && /seq/.test(colHay(k))) || null;
  // The stop's internal NuVizz id (the RWB validate/add/leg id) — found by PATTERN like the
  // columns above, so adding a "Stop Id" column to the saved search lights this up with no
  // code change. This is what lets a Save skip the one-/stop/info-per-added-stop id lookup
  // (24 calls for a 14-stop build) and run at the portal's own ~7-call cost: the id rides the
  // cheap list scan instead. Guarded downstream by isHashLikeId so a column that actually
  // carries the stop NUMBER (digits) can never masquerade as an id.
  const stopIdKey =
    cols.find((k) => /(^|\.)stopid$/i.test(k)) ||
    cols.find((k) => /stop.?id\b/.test(colHay(k)) && !/(nbr|number|seq|load|route|driver)/.test(colHay(k))) || null;
  if (!displaySeqKey && cols.length && !__warnedNoDisplaySeq) {
    __warnedNoDisplaySeq = true;
    console.warn(`[nuvizz-list] no ShipTo-Display-Seq column found — in-load delivery order falls back to a geographic guess. cols=${JSON.stringify(cols).slice(0, 800)}`);
  }
  return ((j && j.values) || []).map((row: any[]) => ({
    stopNbr: String(g(row, 'vizzonInfo.shipmentInfo.stopNbr') ?? ''),
    shipmentNbr: shipmentKey ? String(g(row, shipmentKey) ?? '') : '',
    statusCode: String(g(row, 'default_vizzonInfo.shipmentInfo.status') ?? ''),
    statusText: g(row, 'vizzonInfo.shipmentInfo.status') ?? '',
    businessName: g(row, 'vizzonInfo.destination.address.name') ?? '',
    addr1: g(row, 'vizzonInfo.destination.address.line1') ?? '',
    addr2: g(row, 'vizzonInfo.destination.address.line2') ?? '',
    city: g(row, 'vizzonInfo.destination.address.city') ?? '',
    zip: g(row, 'vizzonInfo.destination.address.zipCode') ?? '',
    routeName: g(row, 'route.name') ?? '',
    routeSeq: displaySeqKey ? numOrNull(g(row, displaySeqKey)) : null,   // ShipTo Display Seq = delivery order
    nvStopId: stopIdKey ? String(g(row, stopIdKey) ?? '').trim() : '',   // internal stop id (RWB planning id)
    // The driver column is unreliable: in some saved searches route.driver.driverId carries the
    // human name ("DENIS"), in others it comes through as a bare ObjectId — which rendered as
    // "jibberish" on the board (#254). So gather every likely name field (route.driver.name etc.)
    // PLUS route.driver.driverId and take the first that doesn't look like a hash/id; a bare
    // ObjectId is never treated as a name. Keep the raw id separately for grouping/fallback. This
    // also means adding a real driver-name column to 77128 later lights up with no code change.
    driverName: firstNonHashName(g(row, 'route.driver.name'), g(row, 'route.driver.driverName'), g(row, 'route.driver.fullName'), g(row, 'loadAssignment.driverName'), g(row, 'route.driver.driverId')),
    driverId: String(g(row, 'route.driver.driverId') ?? '').trim(),
    cartons: numOrNull(g(row, 'vizzonInfo.shipmentInfo.cartons')),
    volume: numOrNull(g(row, 'vizzonInfo.shipmentInfo.volume')),   // loose-piece count
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
    // The internal NuVizz stop id (RWB planning id), free from the list when the saved search
    // exposes a Stop-Id column. isHashLikeId guards against a mislabeled column carrying the
    // stop NUMBER — only an id-shaped value ever lands here. This is the same field enrichment
    // fills, so the client's Save payload picks it up board-wide with no other change.
    stopId: isHashLikeId(r.nvStopId) ? String(r.nvStopId) : null,
    // Shipment number (usually equals stopNbr). Customer service prepends "ATT" to a failed
    // delivery's shipment number, so this carries the re-delivery-attempt marker; surfaced
    // FREE from the list every scan so the attempts feature reads it from the board index
    // (zero extra NuVizz calls) instead of re-probing each stop via /stop/info.
    shipmentNbr: r.shipmentNbr || null,
    isAttempt: isAttemptShipment(r.shipmentNbr),
    // The PRO IS the stop number (see nuvizz-scan: pros = [stopNbr]). The list carries it for
    // EVERY stop, so surface it here — the board's PRO column reads pro/pros and would otherwise
    // show "—" on every un-enriched stop (enrichment is one capped /stop/info per new PRO, so
    // with hundreds of stops most never catch up). Free from the list, shown immediately.
    pro: r.stopNbr || null,
    pros: r.stopNbr ? [r.stopNbr] : [],
    primaryPro: r.stopNbr || null,
    loadNbr: hasRoute ? r.routeName : null,
    routeName: r.routeName || null,
    routeSeq: typeof r.routeSeq === 'number' ? r.routeSeq : null,   // delivery order within the load (ShipTo Display Seq)
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
    volume: r.volume,
    weight: r.weight,
    // normalize() already resolves driverName via firstNonHashName — it is a REAL name or '' here,
    // never an ObjectId (#254). So just pass it through (null when blank). driverId carries the raw
    // id so the UI can still show "Driver assigned" when a load has a driver but no resolvable name.
    driverName: r.driverName || null,
    driverUserName: r.driverName || null,
    driverId: r.driverId || null,
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
// PURE: the single board day (YYYY-MM-DD) a stop belongs on — Estimated Arrival, then
// Requested Date, then scheduled — with the live-route clamp described above. Returns
// null when no day can be determined. This is the ONE authority for "which day is this
// stop's board"; both bucketByDate (initial filing) AND the two-scan carry-forward guard
// (refresh-stops-core) call it, so a stop can never be filed one way and carried another
// — which is exactly how today's board was bleeding wholesale onto tomorrow's.
export function boardDayFor(s: any, today: string = etDayString()): string | null {
  let d = s.boardDate || s.requestedDate || s.scheduledDate || null;
  const finished = s.normalizedStatus === 'DELIVERED' || s.normalizedStatus === 'EXCEPTION';
  const onRoute = !!s.loadNbr;
  if (!finished && onRoute && (!d || d < today)) d = today; // live route work → today, not the past
  // A DATELESS open order is live work too — NuVizz's "-1" re-delivery duplicates arrive with
  // no Estimated Arrival and no Requested Date, and returning null here made bucketByDate drop
  // them from EVERY day's board (007143917-1 / 007143998-1: sitting in the portal's unplanned
  // view, invisible in ours). File them on today; only finished dateless rows stay dropped.
  if (!finished && !d) d = today;
  return d || null;
}

export function bucketByDate(stops: any[], today: string = etDayString()): Map<string, any[]> {
  const m = new Map<string, any[]>();
  for (const s of stops) {
    const d = boardDayFor(s, today);
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

// ── Explicit calendar range → relative period (+ exact row filter) ───────────
//
// NuVizz's list filter only speaks RELATIVE periods ("0d", "+/-7d", "+Nd"); it has no
// absolute from/to. So a user-picked calendar range (the bottom grid's "Custom range")
// is served by pulling the smallest SYMMETRIC "+/-Nd" window that covers both endpoints
// and then filtering the returned rows to the exact range (rowInRange). One cheap list
// pull regardless of range width — same 2-call cost as any window.

// Smallest "+/-Nd" that covers [from,to] around NuVizz's ET "today". Padded by one day so
// an ET/local off-by-one at the client can't clip an edge day, and capped at maxDays so a
// stray/huge range can't request an enormous window. Returns the period PLUS the calendar
// span it actually covers and whether the cap CLAMPED it (requested days — or the drift
// pad — fall outside the window): the caller must surface a clamped pull as PARTIAL, never
// as an exact result. PURE — unit-tested.
export function coveringWindowForRange(
  from: string, to: string, etToday: string = etDayString(), maxDays = 60,
): { period: string; from: string; to: string; clamped: boolean } {
  const dayMs = (s: string) => Date.parse(String(s) + 'T00:00:00Z');
  const addDays = (iso: string, d: number) => new Date(dayMs(iso) + d * 86400000).toISOString().slice(0, 10);
  const t = dayMs(etToday);
  const spread = [from, to].map((d) => Math.abs(Math.round((dayMs(d) - t) / 86400000))).filter((n) => Number.isFinite(n));
  const want = Math.max(1, (spread.length ? Math.max(...spread) : 1) + 1); // spread + 1 day pad
  const n = Math.min(maxDays, want);
  return { period: `+/-${n}d`, from: addDays(etToday, -n), to: addDays(etToday, n), clamped: n < want };
}

// Back-compat convenience: just the period string.
export function coveringPeriodForRange(from: string, to: string, etToday: string = etDayString(), maxDays = 60): string {
  return coveringWindowForRange(from, to, etToday, maxDays).period;
}

// The delivery day (YYYY-MM-DD) of an intermediate list row — Estimated Arrival, then
// Requested Date (mirrors toBoardStop's boardDate, WITHOUT the live-route clamp so the
// explorer shows a stop on its real scheduled day). Null when neither is parseable.
export function rowDay(r: any): string | null {
  const s = parseSchedDate(r?.scheduledArrival);
  return (s ? s.date : null) || parseReqDate(r?.requestedArrival) || null;
}

// PURE: is an intermediate row's delivery day within [from,to] (inclusive)? Undated rows
// are excluded (they can't be placed in a calendar range). Exported for tests.
export function rowInRange(r: any, from: string, to: string): boolean {
  const d = rowDay(r);
  return !!d && d >= from && d <= to;
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

// PURE: from a windowed list pull, keep the rows that belong on `targetDate`'s board.
// The saved/list search returns a multi-day window, so it can include PRIOR-day stops
// that are already FINISHED (delivered / unable-to-deliver) — those belong to their OWN
// day's board, not today. Dropping them stops yesterday's completed deliveries from
// bleeding onto today (the ~2× board). Everything else (today's stops, still-open work,
// and undated rows) keeps the "we queried this exact day" stamp. Exported for tests.
export function keepForBoardDate(stops: any[], targetDate: string): any[] {
  const out: any[] = [];
  for (const s of stops) {
    // Each stop's OWN day — same resolution bucketByDate uses (Estimated Arrival, then
    // Requested Date, then scheduled), so the single-scan path agrees with the two-scan path.
    const own = s.boardDate || s.requestedDate || s.scheduledDate;
    const finished = s.normalizedStatus === 'DELIVERED' || s.normalizedStatus === 'EXCEPTION';
    if (own && own < targetDate && finished) continue; // prior-day completed → its own day, not today
    // authoritative: we queried this exact day, so pin both the scheduled and board day to it.
    s.scheduledDate = targetDate;
    s.boardDate = targetDate;
    out.push(s);
  }
  return out;
}

// PURE: a stop's OWN board day with NO live-route clamp — Estimated Arrival, then Requested,
// then scheduled. Used to detect a prior-day FINISHED stop that doesn't belong on a board.
export function ownBoardDay(s: any): string | null {
  return s.boardDate || s.requestedDate || s.scheduledDate || null;
}

// PURE: the READ-time safety net. Drop FINISHED (delivered / exception) stops whose own day is
// BEFORE the board date being served — the same rule keepForBoardDate enforces at WRITE time,
// applied again on read so a mis-keyed prior-day bleed (e.g. the ET/UTC drift that filed Friday's
// deliveries onto Saturday's doc) is never SHOWN, even if it already slipped into storage and the
// day is in a scan-blackout that can't re-prune it. Open / undated / same-or-later-day stops are
// kept untouched, so live work and normal same-day boards are unaffected. Exported for tests.
export function filterFinishedPriorDay(stops: any[], date: string): any[] {
  return stops.filter((s) => {
    const finished = s.normalizedStatus === 'DELIVERED' || s.normalizedStatus === 'EXCEPTION';
    const own = ownBoardDay(s);
    return !(finished && own && own < date);
  });
}

// Board stops for a specific target UTC date (the doc key the scanner writes). The
// period is ET-adjusted so it matches the number-probe's "today" board. Prior-day
// completed stops in the window are filed to their own day (keepForBoardDate), not here.
export async function listScanForDate(targetDateUTC: string): Promise<any[]> {
  const stops = fromRows(await fetchListRows(periodForDate(targetDateUTC)));
  return keepForBoardDate(stops, targetDateUTC);
}

// ── Two saved-search scans (the live board's source) ─────────────────────────
//
// Davis drives the board off TWO of the portal's saved searches (captured in the
// "Nuvizz_New_Filters" HAR) instead of one ad-hoc query:
//   • ACTIVE    (customListDefId 77128, "Dispatch Map Planned Unplanned") — status
//     20,10,40,50, Estimated-Arrival within +/-7d. The open work + in-flight
//     (out-for-delivery / arrived) stops so they never fall off the board mid-run.
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
// 40 = OUT_FOR_DELIVERY and 50 = ARRIVED are MID-FLIGHT: a stop that has left the
// depot but isn't delivered yet matched NEITHER saved search (active was 20,10;
// completed is 90,91,80,99), so it vanished from every pull the moment the driver
// rolled and only survived on the board via the two-scan carry-forward — which drops it
// if it was never captured earlier as 20 or its board-day drifted (why an out-for-
// delivery PRO could be missing from search). Pulling 40,50 in the ACTIVE search keeps
// them on the board directly, same as adding 99 fixed cancelled orders below. No extra
// NuVizz cost — the active search is ONE pull regardless of status count, and these PROs
// were already enriched as 20 so they never re-enrich.
const ACTIVE_STATUS = process.env.NUVIZZ_ACTIVE_STATUS || '20,10,40,50';
// 99 = CANCELLED is included with the terminal statuses: a cancelled order matches NEITHER
// saved search otherwise (active = 20,10), so it silently vanished from the pulls and the
// carry-forward kept re-adding its last OPEN snapshot — the board froze it as live work a
// dispatcher could still route. With 99 in the completed pull it flips to EXCEPTION.
const COMPLETED_STATUS = process.env.NUVIZZ_COMPLETED_STATUS || '90,91,80,99';
const ACTIVE_ARRIVAL = cleanPeriod(process.env.NUVIZZ_ACTIVE_ARRIVAL || '+/-7d');
const COMPLETED_ARRIVAL = cleanPeriod(process.env.NUVIZZ_COMPLETED_ARRIVAL || '+/-7d');
const COMPLETED_UPDATED = cleanPeriod(process.env.NUVIZZ_COMPLETED_UPDATED || '0d');
// ATTEMPTS saved search — a re-delivery attempt is a stop whose SHIPMENT number now starts
// with "ATT" (customer service prepends it on a failed delivery). Neither the active
// (20,10) nor completed (90,91,80) search reliably returns these, so attempts have their
// OWN portal filter. Captured verbatim from the portal HAR (customListDefId 77203, 11
// sequences): seq7 = Shipment Number "starts with" att, seq9 = Estimated Arrival = today
// (0d). All other sequences unfiltered. IDs/values env-overridable for portal retunes.
const ATT_SHIPMENT_PREFIX = process.env.NUVIZZ_ATT_SHIPMENT_PREFIX || 'att';
const ATT_ARRIVAL = cleanPeriod(process.env.NUVIZZ_ATT_ARRIVAL || '0d');
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
  attempts: {
    customListDefId: Number(process.env.NUVIZZ_LISTDEF_ATTEMPTS) || 77203,
    // seq7=Shipment Number "starts with" att, seq9=Estimated Arrival (today), seq10=blank.
    filterList: filterListOf(11, {
      7: ATT_SHIPMENT_PREFIX,
      9: JSON.stringify({ period: ATT_ARRIVAL }),
      10: JSON.stringify({ period: '' }),
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

// DIAGNOSTIC (read-only): pull one saved search and return its RAW column-def keys plus a few
// raw value rows. Lets us see exactly which columns a saved search exposes (e.g. a route-stop
// sequence or a real sequenced ETA) without guessing — used by the stop-explorer's debug path.
export async function fetchSavedSearchRaw(
  def: { customListDefId: number; filterList: any[] }, sampleRows: number = 3, pageSize: number = 50,
): Promise<{ cols: string[]; rows: any[][] }> {
  const { companyCode } = getCreds();
  const hdr = { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json' };
  const reqr = getNuvizzRequester();
  const url = `${OPENAPI_BASE}/entity/filterdata/VizzonStop/${companyCode}`;
  const body = JSON.stringify(buildSavedBody(def, pageSize));
  const resp = await reqr.request(url, { method: 'POST', headers: hdr, body }, { route: '/entity/filterdata', tenant: companyCode });
  if (!resp.ok) throw new Error(`saved-search ${def.customListDefId} filterdata ${resp.status}`);
  const j: any = await resp.json();
  const cols = Object.keys((j && j.filterData && j.filterData[0]) || {});
  const rows = ((j && j.values) || []).slice(0, sampleRows);
  return { cols, rows };
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
  'loadNbr', 'routeName', 'driverName', 'driverUserName', 'driverId',
  'scheduledDate', 'requestedDate', 'boardDate', 'listUpdatedDTTM', 'source',
  // Shipment number + its derived attempt flag are LIVE: the "ATT" marker appears DURING the
  // day, so it must refresh every scan from the list (never frozen by an earlier enrichment).
  'shipmentNbr', 'isAttempt',
  // stopNbr is LIVE = it is the authoritative key from the LIST and must NEVER be overwritten
  // by a /stop/info result during mergeEnrich. The /stop/info payload can return the stop
  // number in a different format (e.g. without leading zeros); if mergeEnrich copied that over
  // the board stop, the per-PRO registry would be WRITTEN under the drifted key but READ under
  // the list key next day → a permanent miss → that PRO re-enriched forever. Pinning stopNbr to
  // the list value keeps the registry read/write key identical across days.
  'stopNbr',
];
// Copy ALL non-live fields from src (a /stop/info-normalized stop, or a prior enriched
// index doc) onto target, then mark it enriched. Never overwrites a real value with a
// null/blank, so list-derived values survive when a detail field is sparse.
export function mergeEnrich(target: any, src: any): any {
  if (!src || typeof src !== 'object') return target;
  // The ShipTo-Display-Seq delivery order arrives FREE & authoritative on every list scan
  // (toBoardStop → routeSeq). It must WIN over any carried-forward / enriched value: the
  // enrichment path's routeSeq is the PHYSICAL stop.to.seq (nuvizz-scan: numOrNull(primary.seq))
  // — a different number, and exactly the wrong order the Display-Seq column was added to
  // replace. routeSeq is a non-live field, so without this guard mergeEnrich would copy the
  // stale enriched seq over the fresh list value on every carry-forward, and a re-scan would
  // never actually re-order the route (#292). We still let src BACKFILL when the list row
  // carried no Display-Seq (target.routeSeq null).
  const listRouteSeq = typeof target.routeSeq === 'number' ? target.routeSeq : null;
  // Same list-wins rule for the stop id: the list's Stop-Id column (when present) is the
  // CURRENT instance's id refreshed every scan; a carried-forward enrichment id could be a
  // stale instance of a recurring reference PRO. Not a LIVE field though — when the saved
  // search has no id column the list value is null and the enriched id must survive.
  const listStopId = (typeof target.stopId === 'string' && target.stopId) ? target.stopId : null;
  for (const [k, v] of Object.entries(src)) {
    if (LIVE_LIST_FIELDS.includes(k) || k === 'enriched' || k === 'last_scanned_at' || k === '_id') continue;
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    target[k] = v;
  }
  if (listRouteSeq != null) target.routeSeq = listRouteSeq;  // list Display-Seq is authoritative
  if (listStopId) target.stopId = listStopId;                // list stop id is authoritative
  target.enriched = true;
  return target;
}

// ── Board write-through grace (issue #361) ───────────────────────────────────
//
// After a CONFIRMED live Save, patchBoardPlan stamps the affected cache docs with
// board_write_at + the confirmed plan fields. NuVizz's saved-search list can LAG that
// confirmed reality by minutes (it's a reporting index over an async worker), so the very
// next scan would read the stale rows and revert the board to "unplanned" — the exact
// contradiction the write-through exists to kill. This PURE helper holds a recent confirmed
// write over a DISAGREEING fresh list row, and releases the moment the list catches up
// (agreement) or the grace expires (the write claim goes stale — list wins again).
// 20 → 60 (Jul 10): NuVizz's saved-search index lagged an ACCEPTED planning-mode save by
// 30+ minutes on an undispatched load (OWUSU 1) — the 20-min grace expired mid-lag and the
// stale list wiped the confirmed plan. The demotion verify's load corroboration is the real
// guard past expiry; the longer grace just avoids burning verify reads on ordinary lag.
export const BOARD_WRITE_GRACE_MIN = 60;
export function applyBoardWriteGrace(fresh: any, prior: any, nowMs: number, graceMin = BOARD_WRITE_GRACE_MIN): boolean {
  const at = prior?.board_write_at ? Date.parse(prior.board_write_at) : NaN;
  if (!Number.isFinite(at)) return false;
  const withinGrace = nowMs - at < graceMin * 60_000;
  const disagrees = fresh.isPlanned !== prior.isPlanned
    // …or a cross-load move the list hasn't caught up on (both planned, different load).
    || (prior.isPlanned === true && String(fresh.loadNbr ?? '') !== String(prior.loadNbr ?? ''));
  if (!withinGrace || !disagrees) return false;   // stamp NOT carried forward → list authoritative again
  for (const k of ['status', 'normalizedStatus', 'isPlanned', 'isUnplanned', 'loadNbr', 'routeName', 'routeSeq', 'driverName', 'driverUserName']) {
    fresh[k] = prior[k] ?? null;
  }
  fresh.board_write_at = prior.board_write_at;           // keep holding within the window
  fresh.board_write_planned = prior.board_write_planned;
  return true;
}

// ── Demotion verify (Jul 9 SEAAGRI) ──────────────────────────────────────────
//
// Past the write-grace window the list used to win UNCONDITIONALLY — but NuVizz's saved-search
// index can stay wrong for HOURS about a stop the portal itself shows planned (the half-applied
// DAWSONVILLE edit left 007144188 listed un-planned while the load held it, so the board dropped
// it off Leroy's route with the truck already rolling, and every rescan re-dropped it). So a
// fresh list row may NOT flip a previously-PLANNED row to unplanned on the list's word alone:
// `lookup` asks NuVizz's own stop record (one /stop/info) whether the stop is still assigned.
//   lookup → true   the list is WRONG → keep the prior plan fields (re-check next scan)
//   lookup → false  a real portal unplan → the demotion stands
//   lookup → null   read failed → HOLD the prior plan this cycle (never drop a stop off a live
//                   route on a failed read); the next scan retries
// Flips beyond `max` are HELD unverified — a mass flip looks like a feed hiccup, and holding one
// tick is cheaper than wiping live routes. max<=0 disables (legacy list-wins). Checks mutate the
// fresh rows in place, exactly like applyBoardWriteGrace.
export const PLAN_FIELDS = ['status', 'normalizedStatus', 'isPlanned', 'isUnplanned', 'loadNbr', 'routeName', 'routeSeq', 'driverName', 'driverUserName'] as const;
// Verdict for one demotion-verify /stop/info read: true = record still assigned (keep the
// plan), false = confirmed off-route/terminal (the demotion stands), null = unknown (hold one
// cycle). PURE — unit-tested; refresh-stops wires lookupStopByPro into it.
//  • ANY failed read (429/5xx/network — and 404/not_found too) → null. A 404 here means the
//    LIST still names a stop whose record read failed: an inconsistent/transient vendor state,
//    and dropping a live-route stop on one bad read re-opens a narrower SEAAGRI hole. A truly
//    deleted stop leaves the saved-search list as well, so it never re-enters demoteChecks —
//    holding cannot pin a zombie.
//  • terminal record (DELIVERED / EXCEPTION / CANCELLED) → false: finished work must never be
//    resurrected as live SCHEDULED (keepPlan would overwrite the fresh terminal status).
//  • else → assigned iff the record shows isPlanned + a load.
export function demotionLookupVerdict(r: { ok: boolean; reason?: string; stop?: any } | null | undefined): boolean | null {
  if (!r?.ok) return null;
  const s: any = r.stop || {};
  const st = String(s.normalizedStatus ?? '').toUpperCase();
  if (st === 'DELIVERED' || st === 'EXCEPTION' || st === 'CANCELLED') return false;
  return !!(s.isPlanned && s.loadNbr);
}

export async function applyDemotionVerify(
  checks: Array<{ s: any; p: any }>,
  opts: { max: number; scannedAt: string; lookup: (stopNbr: string) => Promise<boolean | null> },
): Promise<{ kept: number; held: number; dropped: number }> {
  let kept = 0, held = 0, dropped = 0;
  if (!checks.length) return { kept, held, dropped };
  if (!(opts.max > 0)) return { kept, held, dropped: checks.length };   // disabled → list wins
  const keepPlan = (s: any, p: any) => {
    for (const k of PLAN_FIELDS) s[k] = p[k] ?? null;
    if (p.board_write_at) { s.board_write_at = p.board_write_at; s.board_write_planned = p.board_write_planned; }
  };
  const cap = Math.min(checks.length, opts.max);
  for (const { s, p } of checks.slice(0, cap)) {
    let stillPlanned: boolean | null = null;
    try { stillPlanned = await opts.lookup(String(s.stopNbr)); } catch { /* read failed → hold */ }
    if (stillPlanned === false) { dropped++; continue; }               // real unplan — list wins
    keepPlan(s, p);
    if (stillPlanned === true) { s.plan_verified_at = opts.scannedAt; kept++; }
    else held++;
  }
  for (const { s, p } of checks.slice(cap)) { keepPlan(s, p); held++; }
  return { kept, held, dropped };
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
