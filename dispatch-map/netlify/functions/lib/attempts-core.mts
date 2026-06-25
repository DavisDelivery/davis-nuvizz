// lib/attempts-core.mts
//
// Shared core for the delivery-ATTEMPTS feature. Two scheduled jobs + a join:
//
//   1. PLAN SNAPSHOT (~8:30am ET) — capturePlanSnapshot(date)
//      Davis routing is finalized by ~8:30am, so every delivery is PLANNED onto a
//      driver. We freeze that: stopNbr → {driver, load, route, customer}. This is
//      the authoritative "who had it" record for the day, captured BEFORE any
//      failed stop gets the ATT marker + unplanned later in the day.
//
//   2. ATTEMPT SCAN (~8:00pm ET) — runAttemptScan(date)
//      By evening, a delivery the driver couldn't complete has had "ATT" prepended
//      to its SHIPMENT number by customer service and been unplanned. We re-probe
//      each stop from the morning snapshot LIVE (the ATT marker is added during the
//      day, so the morning index can't show it), keep the ones now carrying the ATT
//      marker, and JOIN each back to its morning driver by stopNbr (which never
//      changes — the ATT prefix lands on shipmentNbr only). The result is a per-day
//      attempts list answering "who had this delivery when it was attempted".
//
// WHY re-probe the morning stops instead of a fresh full scan: an attempt is, by
// Davis's workflow, a delivery that was on a truck this morning, so the morning
// snapshot IS the candidate set. Re-probing each by its exact stop number reads its
// current shipmentNbr regardless of its current status or scheduled date — robust
// to however NuVizz reshuffles a stop when it is unplanned (a full number-space
// scan's status-10 descent could miss an attempt parked at a different status).
//
// DST: the crons fire on fixed UTC instants; everything date/hour here is computed
// off the America/New_York clock (nowET / etDayString), so the spring/fall flips
// need no code change. Each job uses TWO UTC candidate fires + an ET-hour gate so
// exactly one lands in the target ET window year-round (see the wrappers).

import { nowET } from './scan-schedule.mts';
import { etDayString, isFirestoreEnabled, readStops } from './firestore.mts';
import { scanDate, lookupStopByPro, isAttemptShipment } from './nuvizz-scan.mts';
import { driverKeyFor, stopMatchKey } from './history-derive.mts';
import {
  getPlanMeta, setPlanMeta, listPlanStops, upsertPlanStops,
  getAttemptsManifest, setAttemptsManifest, upsertAttemptItems,
} from './attempts-store.mts';

const TENANT = 'davis';

// How many /stop/info re-probes fire in parallel during the 8pm scan. Low by default
// so the once-a-day re-probe SPREADS its calls rather than bursting the vendor.
const ATT_PROBE_CONCURRENCY = Number(process.env.NUVIZZ_ATT_PROBE_CONCURRENCY) || 8;

// Master kill switch for the attempts jobs (independent of NUVIZZ_SCANS_ENABLED).
// Only the literal string "false" disables, so a missing/blank var never kills it.
export function attEnabled(env: Record<string, any> = process.env): boolean {
  return String(env.NUVIZZ_ATT_ENABLED ?? '').trim().toLowerCase() !== 'false';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ?date=YYYY-MM-DD → an explicit (manual) run for that ET day, which BYPASSES the
// schedule gate (for backfill / re-runs). No query string → the scheduled default:
// the current America/New_York calendar day. The 8pm scan fires at 00:00–01:00 UTC,
// which is the NEXT UTC date but still the SAME ET day (8–9pm ET) — etDayString gets
// that right, where todayUTC() would wrongly roll to tomorrow.
export function resolveAttemptDate(req: Request): { date: string; isManual: boolean } {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get('date');
    if (date && DATE_RE.test(date)) return { date, isManual: true };
  } catch { /* fall through to scheduled default */ }
  return { date: etDayString(), isManual: false };
}

export interface AttemptFireDecision {
  act: boolean;
  etHour: number;
  etMin: number;
  reason: string;
}

// PURE schedule gate (unit-tested). A scheduled fire ACTS only when it lands in the
// target ET hour window AND the day's job hasn't already succeeded — so the TWO UTC
// candidate fires collapse to exactly one action per day, and a DROPPED first
// candidate is covered by the second (it still finds the job not-yet-done). A manual
// (?date) run always acts; a disabled job never does.
export function attemptFireDecision(opts: {
  startHour: number;
  endHour: number;
  now?: Date;
  isManual?: boolean;
  alreadyDone?: boolean;
  enabled?: boolean;
}): AttemptFireDecision {
  const { hour, minute } = nowET(opts.now ?? new Date());
  const base = { etHour: hour, etMin: minute };
  if (opts.enabled === false) return { act: false, ...base, reason: 'disabled' };
  if (opts.isManual) return { act: true, ...base, reason: 'manual' };
  if (opts.alreadyDone) return { act: false, ...base, reason: `already-done h=${hour}` };
  if (hour >= opts.startHour && hour < opts.endHour) {
    return { act: true, ...base, reason: `act h=${hour} in[${opts.startHour},${opts.endHour})` };
  }
  return { act: false, ...base, reason: `out-of-window h=${hour} not in[${opts.startHour},${opts.endHour})` };
}

// ── PURE record builders (unit-tested without the network) ────────────────────

// One plan-snapshot doc: who had this delivery while it was routed this morning.
export function buildPlanRecord(s: any, date: string, capturedAt: string): any {
  return {
    tenant: TENANT,
    date,
    capturedAt,
    stopNbr: String(s.stopNbr),
    shipmentNbr: s.shipmentNbr ?? null,
    driverUserName: s.driverUserName ?? null,
    driverName: s.driverName ?? null,
    driverKey: driverKeyFor(s),
    loadNbr: s.loadNbr ?? null,
    routeName: s.routeName ?? null,
    businessName: s.businessName ?? null,
    customerMatchKey: stopMatchKey(s),
    addr1: s.addr1 ?? null,
    city: s.city ?? null,
    state: s.state ?? null,
    zip: s.zip ?? null,
    status: s.status ?? null,
    normalizedStatus: s.normalizedStatus ?? null,
  };
}

// One attempts-list item: a stop now carrying the ATT marker, joined back to the
// morning plan record by stopNbr. `matched` = the morning plan knew a driver for it
// (true for every item produced from the snapshot; the field is kept so a future
// midday-add path can surface unmatched attempts honestly rather than dropping them).
export function buildAttemptItem(plan: any, current: any, date: string, detectedAt: string): any {
  const matched = !!(plan.driverUserName || plan.driverName);
  return {
    tenant: TENANT,
    date,
    detectedAt,
    stopNbr: String(plan.stopNbr),
    shipmentNbr: current?.shipmentNbr ?? null,
    originalDriverUserName: plan.driverUserName ?? null,
    originalDriverName: plan.driverName ?? null,
    originalDriverKey: plan.driverKey ?? null,
    originalLoadNbr: plan.loadNbr ?? null,
    routeName: plan.routeName ?? null,
    businessName: plan.businessName ?? current?.businessName ?? null,
    customerMatchKey: plan.customerMatchKey ?? null,
    addr1: plan.addr1 ?? current?.addr1 ?? null,
    city: plan.city ?? current?.city ?? null,
    state: plan.state ?? current?.state ?? null,
    zip: plan.zip ?? current?.zip ?? null,
    currentStatus: current?.normalizedStatus ?? null,
    currentlyUnplanned: !!current?.isUnplanned,
    matched,
  };
}

// ── 8:30am: freeze the routed plan ────────────────────────────────────────────
export async function capturePlanSnapshot(date: string): Promise<any> {
  // Prefer the already-warm live stop index (the */15 refresh has populated today
  // since ~4am) so the morning freeze costs ZERO NuVizz calls; fall back to a fresh
  // scanDate only when the index is empty (mirrors history-core's lean path).
  let stops: any[];
  let source: 'index' | 'scan';
  const idx = await readStops(TENANT, date);
  if (idx.stops.length) {
    stops = idx.stops;
    source = 'index';
  } else {
    const scan = await scanDate(date);
    stops = scan.stops;
    source = 'scan';
  }
  // The plan = who had each delivery while it was routed: PLANNED stops with a driver.
  const planned = stops.filter((s) => s && s.stopNbr && s.isPlanned && (s.driverUserName || s.driverName));
  const capturedAt = new Date().toISOString();
  const records = planned.map((s) => buildPlanRecord(s, date, capturedAt));
  await upsertPlanStops(TENANT, date, records);
  // Meta LAST (after the stop docs) so a reader/gate never treats a half-written
  // snapshot as complete.
  await setPlanMeta(TENANT, date, {
    tenant: TENANT, date, capturedAt, source,
    plannedCount: records.length, totalStops: stops.length,
  });
  console.log(`[att-plan] date=${date} source=${source} planned=${records.length} total=${stops.length}`);
  return { date, ok: true, source, planned: records.length, totalStops: stops.length };
}

// ── 8:00pm: find attempts + join back to the morning driver ───────────────────
export async function runAttemptScan(date: string): Promise<any> {
  const [plan, planMeta] = await Promise.all([listPlanStops(TENANT, date), getPlanMeta(TENANT, date)]);
  const detectedAt = new Date().toISOString();
  const items: any[] = [];
  let probed = 0;
  let unprobed = 0;

  // Re-probe each morning stop LIVE through the shared requester (counts toward the
  // daily ceiling, honours the breaker + kill switch) at bounded concurrency.
  let i = 0;
  const worker = async () => {
    while (i < plan.length) {
      const p = plan[i++];
      const r = await lookupStopByPro(String(p.stopNbr));
      if (!r.ok || !r.stop) { unprobed++; continue; }
      probed++;
      if (isAttemptShipment(r.stop.shipmentNbr)) {
        items.push(buildAttemptItem(p, r.stop, date, detectedAt));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ATT_PROBE_CONCURRENCY, plan.length || 1) }, worker));

  const matched = items.filter((it) => it.matched).length;
  await upsertAttemptItems(TENANT, date, items);
  const counts = {
    candidates: plan.length,
    probed,
    unprobed, // morning stops that no longer resolve (cancelled/error) — surfaced, not hidden
    attempts: items.length,
    matched,
    unmatched: items.length - matched,
  };
  // Manifest LAST.
  await setAttemptsManifest(TENANT, date, {
    tenant: TENANT, date, generatedAt: detectedAt,
    planSnapshotAt: planMeta?.capturedAt ?? null,
    planMissing: !planMeta,
    counts, ok: true,
  });
  console.log(`[att-scan] date=${date} ${JSON.stringify(counts)} planMissing=${!planMeta}`);
  return { date, ok: true, ...counts };
}

// ── shared HTTP / scheduled entrypoint (gate → work → JSON) ────────────────────
async function runGated(
  req: Request,
  cfg: { label: string; startHour: number; endHour: number; work: (date: string) => Promise<any>; alreadyDone: (date: string) => Promise<boolean> },
): Promise<Response> {
  const json = (status: number, body: any) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  if (!isFirestoreEnabled()) {
    console.error(`${cfg.label}: FIREBASE_SA not set on this site — cannot run`);
    return json(200, { ok: false, error: 'FIREBASE_SA not set' });
  }
  const { date, isManual } = resolveAttemptDate(req);
  const enabled = attEnabled();
  const alreadyDone = !isManual && enabled ? await cfg.alreadyDone(date).catch(() => false) : false;
  const decision = attemptFireDecision({ startHour: cfg.startHour, endHour: cfg.endHour, isManual, alreadyDone, enabled });
  if (!decision.act) {
    console.log(`[${cfg.label}] skip date=${date} ${decision.reason}`);
    return json(200, { ok: true, acted: false, date, reason: decision.reason, etHour: decision.etHour });
  }
  try {
    const t0 = Date.now();
    const result = await cfg.work(date);
    return json(200, { ok: true, acted: true, date, reason: decision.reason, ms: Date.now() - t0, result });
  } catch (e: any) {
    console.error(`[${cfg.label}] ERROR date=${date}:`, e?.message);
    return json(500, { ok: false, acted: true, date, error: e?.message });
  }
}

export function runPlanSnapshot(req: Request): Promise<Response> {
  // Window [8,12) ET: the snapshot must land after routing settles (~8:30am) and
  // well before any failed delivery is unplanned in the afternoon.
  return runGated(req, {
    label: 'att-plan', startHour: 8, endHour: 12,
    work: capturePlanSnapshot,
    alreadyDone: (date) => getPlanMeta(TENANT, date).then((m) => !!m),
  });
}

export function runAttemptsScan(req: Request): Promise<Response> {
  // Window [20,24) ET: after the day's deliveries are in and CS has marked/unplanned
  // the failures, but the same ET day as the morning snapshot we join against.
  return runGated(req, {
    label: 'att-scan', startHour: 20, endHour: 24,
    work: runAttemptScan,
    alreadyDone: (date) => getAttemptsManifest(TENANT, date).then((m) => !!m),
  });
}
