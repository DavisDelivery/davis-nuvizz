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
  signalSources: SignalSources;
  raw: unknown;
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

// True when NuVizz recorded a real problem on the stop (driver-added exception or
// a cancellation), vs the empty {} / [] placeholders present on healthy stops.
export function hasExceptionSignal(exec: any): boolean {
  if (Array.isArray(exec?.exceptions) && exec.exceptions.length > 0) return true;
  const c = exec?.cancellation;
  return !!(c && (c.cancelDTTM || c.reasonCode));
}

// Most-progressed state wins. UNPLANNED is keyed off isPlanned (board stops keep
// code 10 until routed), NOT a status code. Status codes VERIFIED in live data:
//   10 unplanned/created · 20 planned/assigned · 30 scheduled · 40 out-for-delivery
//   50/80 exception (80 = "Unable to deliver" + cancellation) · 90/91 delivered.
// Delivery + exception are also detected by execution signals (timestamp /
// exceptions[] / cancellation) so an unmapped code still classifies correctly.
export function classifyStopStatus(opts: {
  status: string | null;
  isPlanned: boolean;
  exec?: any;
}): StopStatusKind {
  const code = String(opts.status ?? '').trim();
  const exec = opts.exec || {};
  if (code === '90' || code === '91' || execDeliveredDTTM(exec)) return 'DELIVERED';
  if (code === '50' || code === '80' || hasExceptionSignal(exec)) return 'EXCEPTION';
  if (code === '40') return execArrivalDTTM(exec) ? 'ARRIVED' : 'OUT_FOR_DEL';
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
const LOAD_WINDOW_HALF = 600;

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
      const resp = await fetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } });
      if (!resp.ok) return null;
      const d: any = await resp.json();
      const h = d?.Load?.loadHeader || {};
      const a = d?.Load?.loadAssignment || {};
      const stops = d?.Load?.stops || [];
      const startDate = (h.earliestStartDttm || '').slice(0, 10);
      if (startDate !== dateStr) return null;
      return stops.map((s: any, i: number) => ({
        ...s,
        load: { loadNbr: h.loadNbr, routeName: h.routeName, driverName: a.driverName, driverUserName: a.driverUserName, stopSeq: i },
      }));
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
    const resp = await fetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } });
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
  const maxProbes = opts.maxProbes ?? 6000;
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
}

// Full scan for one date: planned (load scan) + unplanned (number-space scan),
// deduped (load-sourced wins), normalized. Used by the background writer.
export async function scanDate(dateStr: string, opts: { unplanned?: UnplannedScanOpts } = {}): Promise<ScanResult> {
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
  return {
    date: dateStr,
    stops,
    plannedCount: stops.length - unplannedCount,
    unplannedCount,
    scannedAt: new Date().toISOString(),
  };
}
