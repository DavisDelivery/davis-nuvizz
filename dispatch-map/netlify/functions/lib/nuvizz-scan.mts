// lib/nuvizz-scan.mts
//
// Shared NuVizz scan + normalization logic. Extracted from
// nuvizz-pull-today-stops.mts (M5.2) so it can be reused by the scheduled
// background writer (nuvizz-refresh-stops-background.mts) and any debug path.
//
// NuVizz v7 has NO bulk "list stops for a date" endpoint — every list-style
// endpoint demands a per-record id (verified live 2026-05-26: /stop/eventinfo
// → 400 needs stopNbr, /stop/info/customer → 400 needs custAccNbr,
// /event/eventactivity → 400 needs entityId, /load/static/info → 501). So the
// only way to discover a day's stops is to scan the number space:
//   • PLANNED stops: probe a load-number range via /load/info and flatten stops.
//   • UNPLANNED stops (status-10, not yet routed): probe the /stop/info number
//     space, since unplanned orders never appear under any load.
// This is why the scan must run in a 15-min background function, not inline
// (inline load+unplanned scan = >22s, exceeds the 26s request cap → 502).
//
// Phase 4: every probe routes through the shared request wrapper
// (getNuvizzRequester) so it is counted against the fleet-wide daily ceiling and
// short-circuited by the circuit breaker.

import { getNuvizzRequester } from './nuvizz-request.mts';

const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';

export interface SignalSources {
  addressLine2: string | null;
  orderInstructions: string | null;
}

export interface NormalizedStop {
  pro: string | null;
  pros: string[];
  primaryPro: string | null;
  proCount: number;
  stopNbr: string | null;
  loadNbr: string | null;
  loadStopSeq: number | null;
  stopType: string | null;
  status: string | null;
  businessName: string | null;
  addr1: string | null;
  addr2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  scheduledFrom: string | null;
  scheduledTo: string | null;
  cartons: number | null;
  pallets: number | null;
  weight: number | null;
  itemsSummary: string;
  customerAccount: string | null;
  driverName: string | null;
  routeName: string | null;         // M5.2.1 — human-readable route name (e.g. "DULUTH"). From loadHeader.routeName.
  driverUserName: string | null;
  isTerminal: boolean;
  isUnplanned: boolean;
  isPlanned: boolean;     // M5.2 — came from a load scan (routed) vs the unplanned number-space scan.
  normalizedStatus: StopStatusKind; // M5.1 — execution-lifecycle bucket for marker/sidebar.
  arrivalDTTM: string | null;       // M5.1 — actual on-site time, when present.
  deliveredDTTM: string | null;     // M5.1 — actual completion time, when present.
  plannedEtaDTTM: string | null;    // M5.2 — canonical delivery-order timestamp for route polylines.
  // ── Phase 2 (routing engine) ADDITIVE fields. Surfaced for the solver; all
  // nullable, raw preserved. Existing callers (live cache, Phase 1 derive) ignore
  // them. None of the fields above are renamed or removed.
  stopDetails: StopLineItem[];      // P2 — per-line freight (SKU, qty, weight, dims, L flag).
  timeConstraint: string | null;    // P2 — STRICT vs soft delivery window.
  estimatedDurationMin: number | null; // P2 — NuVizz dwell estimate; UNRELIABLE (flat ~20m).
  plannedDistanceToNextStop: number | null; // P2 — NuVizz routing baseline.
  plannedDurationToNextStop: number | null; // P2 — NuVizz routing baseline.
  stopDistance: number | null;      // P2 — NuVizz per-stop distance.
  contact: StopContact;             // P2 — destination contact.
  origin: StopOrigin | null;        // P2 — pickup/depot origin address.
  markfor: unknown;                 // P2 — NuVizz mark-for, when present (raw).
  signalSources: SignalSources;
  raw: unknown;
}

// P2 — normalized freight line item (additive). Mirrors NuVizz StopDetail fields
// the routing geometry derivation needs; productCategory 'L' is NuVizz's own
// oversize/long flag, criticalDimension/length feed linear-foot estimation.
export interface StopLineItem {
  product: string | null;
  productIdentifier: unknown;       // SKU (may be object); preserved as-is.
  sku: string | null;              // best-effort string form of productIdentifier.
  quantity: number | null;
  quantityUOM: string | null;
  weight: number | null;
  weightUOM: string | null;
  productCategory: string | null;   // 'S' standard / 'L' long-oversize.
  length: number | null;
  lengthUOM: string | null;
  width: number | null;
  widthUOM: string | null;
  height: number | null;
  heightUOM: string | null;
  criticalDimension: number | null;
  criticalDimensionUOM: string | null;
}

export interface StopContact {
  name: string | null;
  phone: string | null;
  sms: string | null;
  email: string | null;
}

export interface StopOrigin {
  name: string | null;
  addr1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
}

function numOrNull(v: any): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// P2 — additive: normalize a single NuVizz StopDetail line item.
export function normalizeStopDetail(d: any): StopLineItem {
  const pid = d?.productIdentifier ?? null;
  const sku = pid == null ? null
    : typeof pid === 'string' ? pid
    : (pid.value || pid.id || pid.code || pid.productIdentifier || null);
  return {
    product: d?.product ?? null,
    productIdentifier: pid,
    sku: sku != null ? String(sku) : null,
    quantity: numOrNull(d?.quantity),
    quantityUOM: d?.quantityUOM ?? null,
    weight: numOrNull(d?.weight),
    weightUOM: d?.weightUOM ?? null,
    productCategory: d?.productCategory ?? null,
    length: numOrNull(d?.length),
    lengthUOM: d?.lengthUOM ?? null,
    width: numOrNull(d?.width),
    widthUOM: d?.widthUOM ?? null,
    height: numOrNull(d?.height),
    heightUOM: d?.heightUOM ?? null,
    criticalDimension: numOrNull(d?.criticalDimension),
    criticalDimensionUOM: d?.criticalDimensionUOM ?? null,
  };
}

// M5.1 — canonical stop-status buckets driving marker visuals + sidebar badge.
export type StopStatusKind =
  | 'UNPLANNED'
  | 'SCHEDULED'
  | 'OUT_FOR_DEL'
  | 'ARRIVED'
  | 'DELIVERED'
  | 'EXCEPTION';

// Actual-execution timestamps. Field names VERIFIED against live delivered stops
// (2026-05-27): arrival is exec.to.arrivalDTTM; delivery confirmation is
// exec.to.confirmedDTTM (mirrored at exec.receiveDTTM). The earlier guesses
// (completionDTTM/confirmDTTM/etc.) never matched, so deliveredDTTM came back null
// and the sidebar showed no delivery time — keep them as fallbacks but probe the
// real fields first.
export function execArrivalDTTM(exec: any): string | null {
  return (
    exec?.to?.arrivalDTTM || exec?.to?.arrivalDttm ||
    exec?.arrivalDTTM || exec?.arrivalDttm || exec?.arrivedDttm || null
  );
}
export function execDeliveredDTTM(exec: any): string | null {
  return (
    exec?.to?.confirmedDTTM || exec?.receiveDTTM ||
    exec?.confirmedDTTM || exec?.completionDTTM || exec?.completedDttm ||
    exec?.completionDttm || exec?.confirmDTTM || exec?.to?.completionDTTM || null
  );
}

// True ONLY when NuVizz recorded a real failure on the stop. Parent-app precedent
// (normalize.js:80-89): status===50 with empty exceptions[] AND exceptionPresent=false
// is JUST a paperwork issue (driver arrived but didn't tap Complete) — NOT a real
// exception. So we require an authoritative signal: NuVizz's own exceptionPresent
// flag, an actual cancellation timestamp, or a non-empty exceptions[] entry. A bare
// status 50/80 code alone is NOT enough — many "50" stops are just unfinished
// paperwork on a driver-arrived stop, which should classify as ARRIVED, not EXCEPTION.
export function hasExceptionSignal(exec: any): boolean {
  if (exec?.exceptionPresent === true) return true;
  if (Array.isArray(exec?.exceptions) && exec.exceptions.length > 0) return true;
  const c = exec?.cancellation;
  return !!(c && c.cancelDTTM);
}

// Most-progressed state wins, with one inversion: ARRIVED beats a bare-code EXCEPTION
// (v0.11.8 — Chad's call). NuVizz often parks an arrived-but-not-completed stop at
// status 50 with no real exception data; the driver IS at the customer, so classify
// it ARRIVED. A REAL exception (exceptionPresent, cancelDTTM, exceptions[], or the
// explicit "Unable to deliver" code 80) still wins even with an arrival recorded.
// Status codes verified in live data: 10/20/30/40/50/80/90/91.
export function classifyStopStatus(opts: {
  status: string | null;
  isPlanned: boolean;
  exec?: any;
}): StopStatusKind {
  const code = String(opts.status ?? '').trim();
  const exec = opts.exec || {};
  if (code === '90' || code === '91' || execDeliveredDTTM(exec)) return 'DELIVERED';
  // Code 80 ("Unable to deliver") is the explicit failure outcome — EXCEPTION even
  // if an arrival was recorded earlier in the same lifecycle.
  if (code === '80') return 'EXCEPTION';
  // Authoritative exception signals (NuVizz's own flag, cancellation, real exceptions[]).
  if (hasExceptionSignal(exec)) return 'EXCEPTION';
  // Driver-on-site beats bare status 50 paperwork.
  if (execArrivalDTTM(exec)) return 'ARRIVED';
  if (code === '40') return 'OUT_FOR_DEL';
  if (!opts.isPlanned) return 'UNPLANNED';
  return 'SCHEDULED';
}

export function getCreds() {
  return {
    companyCode: (process.env.NUVIZZ_DAVIS_COMPANY_CODE || 'DAVIS').toUpperCase(),
    user: process.env.NUVIZZ_DAVIS_USER,
    pass: process.env.NUVIZZ_DAVIS_PASS,
  };
}

export function basicAuthHeader(): string {
  const { user, pass } = getCreds();
  if (!user || !pass) throw new Error('Missing NUVIZZ_DAVIS_USER or NUVIZZ_DAVIS_PASS');
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Runaway-scan kill switch (P0, Jun 2026) ──────────────────────────────────
// Every NuVizz scan path checks this. Set Netlify env NUVIZZ_SCANS_ENABLED=false
// on the site to short-circuit ALL number-space scanning (load + unplanned) without
// a code change — the map/app keep reading the last-written Firestore index, but no
// new NuVizz traffic is generated. Default is ENABLED (only the literal string
// "false" disables) so a missing/blank var never silently kills live data.
export function scansEnabled(): boolean {
  return String(process.env.NUVIZZ_SCANS_ENABLED ?? '').trim().toLowerCase() !== 'false';
}

function extractOrderInstructions(stop: any): string | null {
  const comments = stop?.comments;
  if (!Array.isArray(comments) || !comments.length) return null;
  const lines: string[] = [];
  for (const c of comments) {
    if (!c) continue;
    const desc = typeof c.commentDescription === 'string' ? c.commentDescription : '';
    if (!desc) continue;
    const isOrderInstr = c.cmtType === 'ORD_IN' || desc.startsWith('SPL-INSTR-TEXT:');
    if (isOrderInstr) lines.push(desc);
  }
  return lines.length ? lines.join('\n') : null;
}

function detectTerminal(addr1: string | null, businessName: string | null): boolean {
  const a = (addr1 || '').toUpperCase();
  if (/\b943\b/.test(a) && /GAINESVILLE/.test(a)) return true;
  const b = (businessName || '').toUpperCase();
  if (/^DAVIS\s+DELIVERY(\s+SERVICE)?$/.test(b)) return true;
  return false;
}

export function normalizeStop(raw: any): NormalizedStop {
  const stop = raw.stop || raw;
  const exec = raw.stopExecutionInfo || {};
  const load = raw.load || {};
  const stopType = stop.stopType || raw.stopType || 'DO';
  const primary = stopType === 'PU' ? (stop.from || {}) : (stop.to || stop.from || {});
  const addr = primary.address || stop.address || {};
  const schedule = primary.schedule || {};
  const items = [];
  if (stop.totalPallets) items.push(`${stop.totalPallets} pallets`);
  if (stop.totalCartons) items.push(`${stop.totalCartons} cartons`);
  if (stop.weight) items.push(`${stop.weight} ${stop.weightUOM || 'lbs'}`);
  const stopNbr: string | null = stop.stopNbr ?? null;
  const pros: string[] = stopNbr ? [stopNbr] : [];
  const addr2 = addr.addr2 ?? null;
  const orderInstructions = extractOrderInstructions(stop);
  const businessName = addr.name || stop.custInfo?.custName || null;
  const addr1 = addr.addr1 ?? null;
  const driverUserName = load.driverUserName ?? null;
  const driverName = load.driverName ?? null;
  const loadNbr = load.loadNbr || raw.loadNbr || null;
  const statusCode = exec.stopStatus || stop.status || null;
  const isPlanned = !!loadNbr;
  const arrivalDTTM = execArrivalDTTM(exec);
  const deliveredDTTM = execDeliveredDTTM(exec);
  // M5.2 — plannedEtaDTTM is the canonical "delivery order" timestamp on a planned
  // stop. Exposing it at the top level lets the client sort each load's stops into a
  // real sequential polyline (NuVizz's array order / stopSeq is unreliable).
  const plannedEtaDTTM: string | null = exec?.to?.plannedEtaDTTM || exec?.from?.plannedEtaDTTM || null;
  // P2 (additive) — surface freight + routing-baseline + contact/origin for the engine.
  const rawDetails = Array.isArray(stop.stopDetails) ? stop.stopDetails : [];
  const stopDetails: StopLineItem[] = rawDetails.map(normalizeStopDetail);
  const contactRaw = primary.contact || {};
  const contact: StopContact = {
    name: contactRaw.contactName || contactRaw.name || null,
    phone: contactRaw.phone ?? null,
    sms: contactRaw.sms ?? null,
    email: contactRaw.email ?? null,
  };
  const fromAddr = (stop.from && stop.from.address) || {};
  const origin: StopOrigin | null = fromAddr.addr1 || fromAddr.latitude != null ? {
    name: fromAddr.name ?? null,
    addr1: fromAddr.addr1 ?? null,
    city: fromAddr.city ?? null,
    state: fromAddr.state ?? null,
    zip: fromAddr.zip ?? null,
    lat: fromAddr.latitude != null ? Number(fromAddr.latitude) : null,
    lng: fromAddr.longitude != null ? Number(fromAddr.longitude) : null,
  } : null;
  return {
    pro: stopNbr,
    pros,
    primaryPro: pros[0] ?? null,
    proCount: pros.length,
    stopNbr,
    loadNbr,
    loadStopSeq: typeof load.stopSeq === 'number' ? load.stopSeq : null,
    stopType,
    status: statusCode,
    businessName,
    addr1,
    addr2,
    city: addr.city ?? null,
    state: addr.state ?? null,
    zip: addr.zip ?? null,
    lat: addr.latitude != null ? Number(addr.latitude) : null,
    lng: addr.longitude != null ? Number(addr.longitude) : null,
    scheduledFrom: schedule.timeFrom ?? null,
    scheduledTo: schedule.timeTo ?? null,
    cartons: stop.totalCartons ?? null,
    pallets: stop.totalPallets ?? null,
    weight: stop.weight ?? null,
    itemsSummary: items.join(' · ') || '—',
    customerAccount: stop.accountNumber || stop.custInfo?.custAccNbr || null,
    driverName,
    driverUserName,
    routeName: load.routeName ?? null,
    isTerminal: detectTerminal(addr1, businessName),
    isUnplanned: !driverUserName && !driverName,
    isPlanned,
    normalizedStatus: classifyStopStatus({ status: statusCode, isPlanned, exec }),
    arrivalDTTM,
    deliveredDTTM,
    plannedEtaDTTM,
    stopDetails,
    timeConstraint: schedule.timeConstraint ?? null,
    estimatedDurationMin: numOrNull(schedule.estimatedDuration),
    plannedDistanceToNextStop: numOrNull(exec.plannedDistanceToNextStop),
    plannedDurationToNextStop: numOrNull(exec.plannedDurationToNextStop),
    stopDistance: numOrNull(stop.stopDistance),
    contact,
    origin,
    markfor: stop.markfor ?? null,
    signalSources: { addressLine2: addr2, orderInstructions },
    raw,
  };
}

// ── Load-number range scan (planned stops) ──────────────────────────────────
const ANCHOR_DATE = new Date('2026-04-22T00:00:00Z');
const ANCHOR_LOAD = 192900;
const LOADS_PER_DAY = 80;
// Half-width of the load-number probe window around the date's estimated center.
// MUST exceed a single day's actual load-number SPREAD plus any anchor-estimate
// drift, or the window clips real loads. Regression (v0.11.4, observed 2026-05-27):
// at ±250 the window was [195450,195950] but that day's loads ran 195406–195795,
// so loads 195406–195449 (~340 delivered stops) were sliced off the bottom and
// vanished from the index once they converted from unplanned(10) to delivered(90)
// — the unplanned stop-number scan no longer caught them, and the load scan never
// reached them. ±600 brackets a full day (span ~400) with ample drift margin.
// Out-of-date loads in the wider window are discarded by the startDate filter in
// scanLoadRangeForDate, so widening only costs probes (fine in the background fn),
// never false positives.
//
// P0 (Jun 2026, runaway-volume incident): narrowed 600 → 250. A day's load-number
// SPREAD is ~400 wide but is CENTERED on the anchor estimate, so a ±250 window
// (501 probes) still brackets a full day with drift margin while cutting per-scan
// load probes by ~58% (1201 → 501). Each probe is one NuVizz /load/info call and
// the background refresh runs this for several dates every cron tick, so this
// window directly multiplies our NuVizz call volume. Re-widen only with the anchor
// re-calibrated (see ANCHOR_DATE/ANCHOR_LOAD), never as a blind fix for "missing"
// loads — a stale anchor is the usual cause and widening just hammers NuVizz harder.
const LOAD_WINDOW_HALF = 250;

function estimateLoadRange(dateStr: string): { startNbr: number; endNbr: number } {
  const target = new Date(dateStr + 'T00:00:00Z');
  const daysDiff = Math.round((target.getTime() - ANCHOR_DATE.getTime()) / (1000 * 60 * 60 * 24));
  const center = ANCHOR_LOAD + daysDiff * LOADS_PER_DAY;
  return { startNbr: center - LOAD_WINDOW_HALF, endNbr: center + LOAD_WINDOW_HALF };
}

async function scanLoadRangeForDate(dateStr: string, startNbr: number, endNbr: number, concurrency = 30) {
  const { companyCode } = getCreds();
  const authHeader = basicAuthHeader();
  const prefix = companyCode;

  const probe = async (n: number) => {
    const loadNbr = `${prefix}${String(n).padStart(9, '0')}`;
    const url = `${NUVIZZ_BASE}/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`;
    try {
      const resp = await getNuvizzRequester().request(url, { headers: { Authorization: authHeader, Accept: 'application/json' } }, { route: '/load/info', tenant: companyCode });
      if (!resp.ok) return null;
      const d: any = await resp.json();
      const h = d?.Load?.loadHeader || {};
      const a = d?.Load?.loadAssignment || {};
      const stops = d?.Load?.stops || [];
      const startDate = (h.earliestStartDttm || '').slice(0, 10);
      if (startDate !== dateStr) return null;
      // Phase 4: carry the full load HEADER (not just the 5 stop-linking fields)
      // so the sole scanner can build SITE A's complete nuvizzFleet load cards —
      // vehicleType, origin, pallet/carton/weight — without a second scan.
      const header = {
        loadNbr: h.loadNbr, routeName: h.routeName,
        driverName: a.driverName, driverUserName: a.driverUserName, driverEmail: a.driverEmail ?? null,
        loadId: h.loadId ?? null, vehicleType: h.vehicleType ?? null, startDate,
        totalPallets: h.totalPallets ?? null, totalCartons: h.totalCartons ?? null, weight: h.weight ?? null,
        origin: {
          name: h.originName ?? null, addr1: h.originAddr1 ?? null, city: h.originCity ?? null,
          state: h.originState ?? null, zip: h.originZip ?? null,
          latitude: h.originLatitude ?? null, longitude: h.originLongitude ?? null,
        },
      };
      return stops.map((s: any, i: number) => ({ ...s, load: { ...header, stopSeq: i } }));
    } catch {
      return null;
    }
  };

  const nums: number[] = [];
  for (let n = endNbr; n >= startNbr; n--) nums.push(n);

  const results: any[][] = [];
  let idx = 0;
  const runOne = async () => {
    while (idx < nums.length) {
      const r = await probe(nums[idx++]);
      if (r && r.length) results.push(r);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, runOne));
  return results.flat();
}

// ── Unplanned (status-10) number-space scan ─────────────────────────────────
// Calibrated 2026-05-26: stop 007123931 was the top of the 5/26 block. Stop
// numbers map ~linearly onto the expected-arrival date; unplanned orders are the
// newest imports and cluster at the high end ("frontier"). Recalibrate
// STOP_ANCHOR_* if the estimate drifts off the live frontier.
const STOP_ANCHOR_NBR = 7124000;
const STOP_ANCHOR_DATE = new Date('2026-05-26T00:00:00Z');
const STOPS_PER_DAY = 440;
const UNPLANNED_STATUS = '10';

const CEILING_MARGIN = 40;
const GALLOP_STEP = 200;
const MAX_GALLOP = 6;
const FLOOR_MARGIN = 2500;
const FUTURE_CHUNKS_TO_STOP = 2;
const POST_TARGET_CHUNKS_TO_STOP = 3;

// Self-calibration: highest existing stop number observed this instance.
let observedFrontier = 0;

function estimateStopFrontier(dateStr: string): number {
  const target = new Date(dateStr + 'T00:00:00Z');
  const daysDiff = Math.round((target.getTime() - STOP_ANCHOR_DATE.getTime()) / (1000 * 60 * 60 * 24));
  return STOP_ANCHOR_NBR + daysDiff * STOPS_PER_DAY;
}

interface StopProbe {
  n: number;
  exists: boolean;
  expected?: string | null;
  record?: { stop: any; stopExecutionInfo: any } | null;
}

async function probeStop(n: number, dateStr: string, authHeader: string, companyCode: string): Promise<StopProbe> {
  const stopNbr = String(n).padStart(9, '0');
  const url = `${NUVIZZ_BASE}/stop/info/${encodeURIComponent(stopNbr)}/${encodeURIComponent(companyCode)}`;
  try {
    const resp = await getNuvizzRequester().request(url, { headers: { Authorization: authHeader, Accept: 'application/json' } }, { route: '/stop/info', tenant: companyCode });
    if (!resp.ok) return { n, exists: false };
    const d: any = await resp.json();
    const wrap = d?.Stop || d?.stop || d;
    const stop = wrap?.stop;
    const exec = wrap?.stopExecutionInfo || {};
    if (!stop?.stopNbr) return { n, exists: false };
    const expected = ((stop?.to?.schedule?.timeFrom as string) || '').slice(0, 10) || null;
    const isTarget = exec.stopStatus === UNPLANNED_STATUS && expected === dateStr;
    return { n, exists: true, expected, record: isTarget ? { stop, stopExecutionInfo: exec } : null };
  } catch {
    return { n, exists: false };
  }
}

// Locate a ceiling just above the live frontier (highest existing stop number).
// We bracket the frontier with a doubling gallop (up if the estimate is below it,
// down if above), then binary-search the bracket to pin it. Anchoring on today's
// estimate (not the query date's) keeps the descent start near the real top for
// any date. sampleExists() tolerates single-number gaps by probing 8 in a row.
async function findCeiling(dateStr: string, authHeader: string, companyCode: string): Promise<number> {
  const sampleExists = async (top: number): Promise<boolean> => {
    const sample = Array.from({ length: 8 }, (_, k) => top - k);
    const rs = await Promise.all(sample.map((n) => probeStop(n, dateStr, authHeader, companyCode)));
    return rs.some((r) => r.exists);
  };
  const base = Math.max(estimateStopFrontier(todayUTC()), observedFrontier) + CEILING_MARGIN;

  let lo: number; // a level where stops EXIST (≤ frontier)
  let hi: number; // a level that is EMPTY    (> frontier)
  if (await sampleExists(base)) {
    // Under-estimated: gallop UP until empty.
    lo = base;
    let step = GALLOP_STEP;
    hi = base + step;
    for (let g = 0; g < MAX_GALLOP && (await sampleExists(hi)); g++) {
      lo = hi; step *= 2; hi += step;
    }
    if (await sampleExists(hi)) return hi + CEILING_MARGIN; // never found empty — best effort
  } else {
    // Over-estimated: gallop DOWN until we find existing stops.
    hi = base;
    let step = GALLOP_STEP;
    lo = base - step;
    let g = 0;
    for (; g < MAX_GALLOP && !(await sampleExists(lo)); g++) {
      hi = lo; step *= 2; lo -= step;
    }
    if (!(await sampleExists(lo))) return hi; // no stops found in range
  }

  // Binary-search the [lo exists, hi empty] bracket to converge on the frontier.
  while (hi - lo > 8) {
    const mid = Math.floor((lo + hi) / 2);
    if (await sampleExists(mid)) lo = mid; else hi = mid;
  }
  return lo + CEILING_MARGIN;
}

interface UnplannedScanOpts {
  concurrency?: number;
  timeBudgetMs?: number;
  maxProbes?: number;
}

// Descend the stop-number space for the date, collecting status-10 stops.
// Background callers pass generous budgets (no 26s cap) so the cluster is never
// truncated; the early-stop heuristics keep it from scanning the whole space.
async function scanUnplannedStops(dateStr: string, opts: UnplannedScanOpts = {}) {
  const concurrency = opts.concurrency ?? 40;
  const timeBudgetMs = opts.timeBudgetMs ?? 120_000;
  // P0 (Jun 2026): hard-cap the unplanned number-space descent. 6000 probes/run ×
  // every-date × every-5-min cron was a primary contributor to the NuVizz overage.
  // The early-stop heuristics (futureStreak/postTargetStreak) normally terminate
  // long before this; the cap is the backstop so a calibration miss can't fan out
  // thousands of extra /stop/info calls. Lowered 6000 → 2500.
  const maxProbes = opts.maxProbes ?? 2500;
  const { companyCode } = getCreds();
  const authHeader = basicAuthHeader();
  const ceiling = await findCeiling(dateStr, authHeader, companyCode);
  const floor = estimateStopFrontier(dateStr) - FLOOR_MARGIN;

  const results: any[] = [];
  let n = ceiling;
  let foundTarget = false;
  let futureStreak = 0;
  let postTargetStreak = 0;
  let probes = 0;
  let maxSeen = 0;
  const startedAt = Date.now();

  while (n >= floor && probes < maxProbes && Date.now() - startedAt < timeBudgetMs) {
    const batch: number[] = [];
    for (let i = 0; i < concurrency && n >= floor; i++) batch.push(n--);
    probes += batch.length;
    const rs = await Promise.all(batch.map((m) => probeStop(m, dateStr, authHeader, companyCode)));

    let existing = 0;
    let older = 0;
    let chunkTarget = false;
    for (const r of rs) {
      if (!r.exists) continue;
      existing++;
      if (r.n > maxSeen) maxSeen = r.n;
      if (r.record) { results.push(r.record); foundTarget = true; chunkTarget = true; }
      if (r.expected && r.expected < dateStr) older++;
    }

    if (existing > 0) {
      if (!foundTarget && older === existing) {
        if (++futureStreak >= FUTURE_CHUNKS_TO_STOP) break;
      } else {
        futureStreak = 0;
      }
      if (foundTarget && !chunkTarget) {
        if (++postTargetStreak >= POST_TARGET_CHUNKS_TO_STOP) break;
      } else {
        postTargetStreak = 0;
      }
    }
  }

  if (maxSeen > observedFrontier) observedFrontier = maxSeen;
  return results;
}

export interface ScanResult {
  date: string;
  stops: NormalizedStop[];
  plannedCount: number;
  unplannedCount: number;
  scannedAt: string;
  // Phase 4: per-load header (vehicleType/origin/pallets/…) keyed by loadNbr, so
  // deriveFleetSummary can build SITE A's complete fleet cards. Empty when scans
  // are disabled.
  loadHeaders?: Record<string, any>;
}

// Full scan for one date: planned (load scan) + unplanned (number-space scan),
// deduped (load-sourced wins), normalized. Used by the background writer.
export async function scanDate(dateStr: string, opts: { unplanned?: UnplannedScanOpts } = {}): Promise<ScanResult> {
  // P0 kill switch — when scans are disabled, generate ZERO NuVizz traffic and
  // return an empty result. Callers (background refresh / history snapshot) treat
  // this as "nothing new to write" and leave the existing Firestore index intact.
  if (!scansEnabled()) {
    return { date: dateStr, stops: [], plannedCount: 0, unplannedCount: 0, scannedAt: new Date().toISOString() };
  }
  const { startNbr, endNbr } = estimateLoadRange(dateStr);
  const [loadStops, unplannedStops] = await Promise.all([
    scanLoadRangeForDate(dateStr, startNbr, endNbr),
    scanUnplannedStops(dateStr, opts.unplanned).catch(() => []),
  ]);

  const seen = new Set<string>(loadStops.map((s: any) => s.stopNbr).filter(Boolean));
  const extraUnplanned = unplannedStops.filter((u: any) => {
    const nbr = u?.stop?.stopNbr;
    return nbr && !seen.has(nbr);
  });

  const stops = [...loadStops, ...extraUnplanned].map(normalizeStop);
  const unplannedCount = stops.filter((s) => !s.isPlanned).length;

  // Phase 4: collect the load headers (one per loadNbr) from the raw load-scan
  // rows before normalization drops them. deriveFleetSummary merges these in.
  const loadHeaders: Record<string, any> = {};
  for (const ls of loadStops as any[]) {
    const L = ls?.load;
    if (L?.loadNbr && !loadHeaders[L.loadNbr]) {
      const { stopSeq, ...rest } = L;
      loadHeaders[L.loadNbr] = rest;
    }
  }

  return {
    date: dateStr,
    stops,
    loadHeaders,
    plannedCount: stops.length - unplannedCount,
    unplannedCount,
    scannedAt: new Date().toISOString(),
  };
}

// ── Phase 4: derive the canonical fleet summary from normalized stops ─────────
// SITE A's mobile dashboard needs a load-level view (load list + aggregate +
// driver index). Planned stops carry loadNbr / driverName / routeName /
// normalizedStatus, and scanDate now also returns loadHeaders (vehicleType,
// origin, pallet/carton/weight, loadId), so the sole scanner can derive SITE A's
// COMPLETE nuvizzFleet shape WITHOUT a second scan — that's what lets SITE A stop
// scanning NuVizz and read Firestore instead. Pure + unit-tested.
export interface DerivedLoad {
  loadNbr: string; route: string | null; driver: string | null; driverUserName: string | null;
  driverEmail: string | null; loadId: string | null; vehicleType: string | null; startDate: string | null;
  totalStops: number; delivered: number; inProgress: number; exceptions: number; pctComplete: number;
  totalPallets: number | null; totalCartons: number | null; weight: number | null;
  origin: any;
}
export interface DerivedFleet {
  loads: DerivedLoad[];
  summary: {
    totalLoads: number; assignedLoads: number; unassignedLoads: number;
    totalStops: number; totalDelivered: number; totalInProgress: number;
    totalExceptions: number; uniqueDrivers: number; pctComplete: number;
  };
  driverIndex: Record<string, string[]>;
}

export function deriveFleetSummary(stops: any[], loadHeaders: Record<string, any> = {}): DerivedFleet {
  const byLoad = new Map<string, any[]>();
  for (const s of stops || []) {
    if (!s || !s.isPlanned || !s.loadNbr) continue;
    if (!byLoad.has(s.loadNbr)) byLoad.set(s.loadNbr, []);
    byLoad.get(s.loadNbr)!.push(s);
  }
  const loads: DerivedLoad[] = [];
  const driverIndex: Record<string, string[]> = {};
  let totalStops = 0, totalDelivered = 0, totalInProgress = 0, totalExceptions = 0, assignedLoads = 0;
  const drivers = new Set<string>();
  for (const [loadNbr, ls] of byLoad) {
    const delivered = ls.filter((s) => s.normalizedStatus === 'DELIVERED').length;
    const inProgress = ls.filter((s) => s.normalizedStatus === 'OUT_FOR_DEL' || s.normalizedStatus === 'ARRIVED').length;
    const exceptions = ls.filter((s) => s.normalizedStatus === 'EXCEPTION').length;
    const driverUserName = ls.find((s) => s.driverUserName)?.driverUserName || null;
    const driver = ls.find((s) => s.driverName)?.driverName || null;
    const route = ls.find((s) => s.routeName)?.routeName || null;
    const h = loadHeaders[loadNbr] || {};
    const n = ls.length;
    if (driverUserName) { assignedLoads++; drivers.add(driverUserName); (driverIndex[driverUserName] ||= []).push(loadNbr); }
    totalStops += n; totalDelivered += delivered; totalInProgress += inProgress; totalExceptions += exceptions;
    loads.push({
      loadNbr, route, driver, driverUserName,
      driverEmail: h.driverEmail ?? null, loadId: h.loadId ?? null, vehicleType: h.vehicleType ?? null, startDate: h.startDate ?? null,
      totalStops: n, delivered, inProgress, exceptions, pctComplete: n ? Math.round((delivered / n) * 100) : 0,
      totalPallets: h.totalPallets ?? null, totalCartons: h.totalCartons ?? null, weight: h.weight ?? null,
      origin: h.origin ?? null,
    });
  }
  loads.sort((a, b) => a.loadNbr.localeCompare(b.loadNbr));
  return {
    loads,
    summary: {
      totalLoads: loads.length, assignedLoads, unassignedLoads: loads.length - assignedLoads,
      totalStops, totalDelivered, totalInProgress, totalExceptions,
      uniqueDrivers: drivers.size,
      pctComplete: totalStops ? Math.round((totalDelivered / totalStops) * 100) : 0,
    },
    driverIndex,
  };
}
