// nuvizz-pull-today-stops.mts  (M5.2)
//
// Map data feed. Reads the pre-scanned Firestore stop index
// (nuvizz_stop_index/{tenant}__{date}) and returns instantly (<2s) — the heavy
// NuVizz number-space scan runs in nuvizz-refresh-stops-background.mts, NOT here.
//
// Why: NuVizz v7 has no bulk "stops for a date" endpoint (verified live), so the
// only way to get a day's stops (esp. UNPLANNED status-10 orders) is to scan the
// number space. Inline that scan is >22s and 502s past the 26s request cap. So
// we serve cached, pre-scanned data and surface its freshness to the UI.
//
// Query params:
//   date=YYYY-MM-DD   optional, defaults to today UTC
//   mock=1            return the bundled fixture (no Firestore/NuVizz)
//   carryDays=N       also fold in still-UNPLANNED stops from the prior N days
//                     (orders scheduled earlier that were never delivered). These
//                     come from the already-scanned per-day indexes — no extra
//                     NuVizz traffic — and are flagged carryover:true. Capped at 14.
//   live=1            DEBUG: bypass the index and scan NuVizz live (may exceed
//                     the 26s cap for the unplanned scan — not for normal use).
//                     ADMIN-gated (the board read itself is viewer) and additionally
//                     behind NUVIZZ_LIVE_READ_ENABLED=on: it is a ~3,000-call cold
//                     number probe, not a read.

import fixture from '../../test/fixtures/nuvizz-today-stops.json' with { type: 'json' };
import { scanDate, normalizeStop } from './lib/nuvizz-scan.mts';
import { isFirestoreEnabled, readStops, readCallStats, readCircuit, etDayString, readScanMetrics, readScanConfig, readActiveUnplannedSet, readCarryoverRetired, readScanRefusal, readActivePool , readScanRuns } from './lib/firestore.mts';
import { type ActivePool } from './lib/active-pool.mts';
import { foldCarryover, carryPriorDates } from './lib/carryover-fold.mts';
import { summarizeScanMetrics } from './lib/scan-metrics.mts';
import { filterFinishedPriorDay } from './lib/nuvizz-list.mts';
import { LEAN_STOP_FIELDS } from './lib/board-fields.mts';
import { dropCancelledEnabled, dropCancelledStops } from '../../src/lib/stop-cancelled.js';
import { breakerMode, reportedDailyCeiling, circuitStillBinding } from './lib/nuvizz-request.mts';
import { requireUser } from './lib/require-user.mts';
import { readPlanningMode, planningView } from './lib/uat-planning-mode.mts';

const TENANT = 'davis';

// The Map feed's lean projection — the field set every screen reads, now shared with the
// Routing date window (see lib/board-fields.mts for why it moved out of this file).
// KILL SWITCH: `?full=1` on the request OR env MAP_FEED_FULL=1 returns the ORIGINAL full
// payload (no mask), so this is instantly reversible without a code change.

// How old a refused "Scan now" may be and still be worth putting in front of the dispatcher.
// Longer than the gap between pressing the button and looking back at the board; shorter than
// a shift, so last night's refusal never lands on this morning's screen.
const REFUSAL_MAX_AGE_MIN = 360;

// Fold still-unplanned stops from the prior `carryDays` days into `stops`,
// deduped by stopNbr, flagged carryover + scheduledDate. Reads only existing per-day indexes
// (cheap). Those indexes are FROZEN snapshots from when each day was last scanned, so a stop that
// was unplanned then but has since been DELIVERED/PLANNED still reads unplanned — which inflated
// the carry-over (issue #253). Guard: cross-check each candidate against the scan's live
// active-unplanned snapshot; if the day is within that snapshot's window and the stop is no longer
// in it, it's been closed since — skip it. Best-effort: no snapshot ⇒ legacy behaviour.
// `lastUnplannedScanAt` is the served board's own orders-scan stamp — the snapshot-trust rule
// below compares the two to detect a snapshot the scanner stopped refreshing.
// Exported for tests with the reads + clock injectable (io defaults to the real Firestore
// readers and Date.now, so the handler's call is byte-identical in behavior).
export type { CarryoverStats } from './lib/carryover-fold.mts';

export async function mergeCarryover(stops: any[], date: string, carryDays: number, io?: {
  readStops?: (tenant: string, dateStr: string, opts?: { mask?: string[] }) => Promise<{ stops: any[] }>;
  readActiveUnplannedSet?: (tenant: string) => Promise<{ at: string | null; windowStart: string | null; stopNbrs: Set<string>; thin?: boolean } | null>;
  readCarryoverRetired?: (tenant: string) => Promise<Record<string, string>>;
  readActivePool?: (tenant: string) => Promise<ActivePool | null>;
  now?: () => number;
  /** filled with the CarryoverStats of this fold when given — the handler serves it as `carryover` */
  stats?: Record<string, any>;
}, mask?: string[], lastUnplannedScanAt: string | null = null): Promise<number> {
  const readStopsFn = io?.readStops ?? readStops;
  const readActiveFn = io?.readActiveUnplannedSet ?? readActiveUnplannedSet;
  const readRetiredFn = io?.readCarryoverRetired ?? readCarryoverRetired;
  const readPoolFn = io?.readActivePool ?? readActivePool;
  const now = io?.now ?? Date.now;
  const priorDates = carryPriorDates(date, carryDays);
  const [live, retired, pool] = await Promise.all([
    readActiveFn(TENANT).catch(() => null),
    // Rows the scan has PROVEN finished against the immutable history warehouse — the only
    // evidence that survives past the live snapshot's window. ONE getDoc; {} on failure,
    // which degrades to the old over-count rather than hiding work.
    readRetiredFn(TENANT).catch(() => ({} as Record<string, string>)),
    // THE OPEN-ORDER POOL (v0.95.0) — every open row NuVizz listed on the last planned scan,
    // whatever day it was filed under, with the day it is filed under NOW. Written by the scan
    // (lib/active-pool.mts), zero NuVizz calls to read. It is the judge here when it is usable
    // (fresh, not superseded by a board scan that failed to rewrite it); the unplanned snapshot
    // below is the fallback, and with neither the fold folds everything and prunes nothing.
    readPoolFn(TENANT).catch(() => null),
  ]);
  // THE JUDGES' CLOCK, read HERE: after the judges are in and BEFORE the prior-day reads, which is
  // where this feed read it for the pool's and the snapshot's 7-day backstops until v1.77.0 moved
  // the fold into lib/carryover-fold.mts and the read moved with it, to after the reads (audit
  // feed-refactor F2). Read once and passed in; the per-row checks (the 48h stamp, the 60-minute
  // grace) still read `now` while the fold runs, after the reads, as they always did.
  const judgedAtMs = now();
  const reads = await Promise.all(
    priorDates.map((d) => readStopsFn(TENANT, d, mask ? { mask } : undefined).then((r) => ({ d, stops: r.stops })).catch(() => ({ d, stops: [] as any[] }))),
  );
  // THE DECISIONS are lib/carryover-fold.mts (v1.77.0): the same rule, pure, so the Claude shadow's
  // planning area reads carry-over exactly as this board does.
  const stats = foldCarryover(stops, { date, reads, live, retired, pool, nowMs: now, judgedAtMs, lastUnplannedScanAt, log: (m) => console.log(m) });
  if (io?.stats) Object.assign(io.stats, stats);
  return stats.added;
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  // Default to the EASTERN calendar day (matches the board's ET-anchored doc keys and the
  // dispatcher's date picker), not the UTC day — else an after-8pm-ET read with no date param
  // would fetch tomorrow's (empty/forming) board.
  const date = url.searchParams.get('date') || etDayString();
  const useMock = url.searchParams.get('mock') === '1';
  const live = url.searchParams.get('live') === '1';
  const carryDays = Math.max(0, Math.min(14, parseInt(url.searchParams.get('carryDays') || '0', 10) || 0));
  // Lean map projection by default; kill switch → full payload (see LEAN_STOP_FIELDS).
  const full = url.searchParams.get('full') === '1' || process.env.MAP_FEED_FULL === '1';
  const stopMask = full ? undefined : LEAN_STOP_FIELDS;
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  // TWO DOORS, NOT ONE — split the way nuvizz-board-reconcile splits its preview from its run.
  //
  // The board read is gated at viewer: this IS the board — every stop on a day with its
  // customer, address and status, plus the day's NuVizz spend. It is also the busiest endpoint
  // in the app (the map polls it), so the 30-second user-doc cache in lib/require-user.mts is
  // what keeps a gated board from becoming a Firestore read per poll.
  //
  // ?live=1 is gated at ADMIN, because it is a different act wearing the same URL: a cold full
  // number-probe of the NuVizz number space, ~3,000 metered calls, the exact spend CLAUDE.md's
  // hard rule forbids without Chad saying so per request. A viewer is the read-only role — the
  // one role that must never be able to spend the vendor budget — so gating the probe at the
  // same level as the board read was simply the wrong door. NUVIZZ_LIVE_READ_ENABLED below
  // stays the real brake; this is the second lock, not a replacement for it.
  //
  // Both inert until AUTH_REQUIRED=true.
  const gate = live
    ? await requireUser(req, { role: 'admin' })
    : await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;

  // Kicked off HERE, not where it is used, so it overlaps the stop read instead of adding a
  // round trip to it. This is the endpoint whose payload was halved to save 5-6s on a cold
  // load; a serial Firestore hop for one tiny document would be giving part of that back.
  // `.catch` is attached at creation, so a failure can never surface as an unhandled rejection.
  const refusalPromise = isFirestoreEnabled() ? readScanRefusal().catch(() => null) : Promise.resolve(null);
  // UAT PLANNING MODE (lib/uat-planning-mode.mts), read alongside for the same reason. Off a
  // mirror this resolves "off" without touching Firestore, so production's board costs nothing
  // more; it never rejects (a failed read answers "off" and says so).
  const planningPromise = readPlanningMode();

  try {
    let stops: any[];
    let source: 'firestore' | 'fixture' | 'live-scan' | 'index-empty' = 'firestore';
    let lastScannedAt: string | null = null;
    let lastLoadScanAt: string | null = null;
    let lastUnplannedScanAt: string | null = null;
    let lastCompletedScanAt: string | null = null;
    let scanState: { halted: boolean; reason: string; since: string } | null = null;

    if (useMock) {
      stops = ((fixture as any).stops || []).map(normalizeStop);
      source = 'fixture';
    } else if (live) {
      // DEBUG path — scan NuVizz directly. May time out on the unplanned scan.
      // GATED: this is a cold full number-probe (~3,000 metered calls) on an
      // unauthenticated GET, bypassing the cadence/breaker guards — a stray hit
      // must not be able to burn the day's call budget. Requires an explicit env
      // opt-in; use the in-app "Scan now" (cheap list path) for fresh data.
      if ((process.env.NUVIZZ_LIVE_READ_ENABLED || '').toLowerCase() !== 'on') {
        return new Response(JSON.stringify({ ok: false, reason: 'live_read_disabled — ?live=1 runs a ~3,000-call probe scan; set NUVIZZ_LIVE_READ_ENABLED=on to allow it, or use the in-app Scan now (cheap list pull)' }), { status: 403, headers: cors });
      }
      const scan = await scanDate(date);
      stops = scan.stops;
      lastScannedAt = scan.scannedAt;
      lastLoadScanAt = scan.scannedAt;
      lastUnplannedScanAt = scan.scannedAt;
      lastCompletedScanAt = scan.scannedAt;
      source = 'live-scan';
    } else if (isFirestoreEnabled()) {
      const { meta, stops: indexed } = await readStops(TENANT, date, stopMask ? { mask: stopMask } : undefined);
      // READ-time board-day guard: never SHOW a prior-day FINISHED stop on this date's board.
      // The scanner keys boards by ET day so this is normally a no-op, but a board written under
      // the old UTC anchor (which filed Friday's deliveries onto Saturday's doc) sits in a weekend
      // scan-blackout that can't re-prune it — this strips that stale bleed at serve time.
      stops = filterFinishedPriorDay(indexed, date);
      lastScannedAt = meta?.last_scanned_at ?? null;
      lastLoadScanAt = meta?.lastLoadScanAt ?? meta?.last_scanned_at ?? null;
      lastUnplannedScanAt = meta?.lastUnplannedScanAt ?? null;
      // No fallback to last_scanned_at here on purpose. A board written before this field
      // existed has genuinely never recorded a completed pull, and dating one off the general
      // scan stamp would invent freshness the system never observed. Null renders as "—".
      lastCompletedScanAt = meta?.lastCompletedScanAt ?? null;
      scanState = (meta?.scanState as any) ?? null;
      // Empty index (background scan hasn't populated this date yet) is a normal
      // state, not an error — the UI shows an honest "no scan yet" empty state.
      source = indexed.length ? 'firestore' : 'index-empty';
    } else {
      // No Firestore configured (e.g. preview without FIREBASE_SA) → fixture so
      // the UI still renders something in dev/preview.
      stops = ((fixture as any).stops || []).map(normalizeStop);
      source = 'fixture';
    }

    // Fold in prior-day carry-over (Firestore-backed reads only).
    let carryoverCount = 0;
    const carryover: Record<string, any> = {};
    if (carryDays > 0 && !useMock && !live && isFirestoreEnabled()) {
      try { carryoverCount = await mergeCarryover(stops, date, carryDays, { stats: carryover }, stopMask, lastUnplannedScanAt); } catch { /* keep base stops */ }
    }

    // ── A CANCELLED STOP IS NOT FREIGHT ────────────────────────────────────────
    // Chad: "This stop is what is making the map messed up its been canceled and shouldn't be
    // on my map anymore so handle that and it should self heal."
    //
    // AFTER carry-over and BEFORE every count below, so a cancelled row is gone from the
    // board, the tally, the grid and the wall alike — not hidden on one screen while the
    // others still carry it.
    //
    // AT SERVE TIME, WHICH IS WHAT "SELF HEAL" MEANS. Filtering in the scanner would only
    // clean rows written AFTER the change; this one drops rows already sitting in Firestore
    // on the very next 2-minute poll, with no scan, no NuVizz call and nobody pressing
    // anything. Same reasoning as the prior-day guard twenty lines above.
    //
    // The rule and the switch (BOARD_DROP_CANCELLED=off) live in lib/stop-cancelled.js.
    const { stops: liveStops, dropped: cancelledOff } = dropCancelledStops(stops, dropCancelledEnabled(process.env));
    stops = liveStops;

    // ── UAT PLANNING MODE: THE SAME BOARD, AS IF NOBODY HAD PLANNED IT YET ─────────────────
    // After carry-over and the cancelled drop, before every count, so the tally, the map, the
    // Build Panel and the Routes rail all read the one view. Stored rows are not touched — see
    // lib/uat-planning-mode.mts for why this is a view and not a rewrite.
    const planning = await planningPromise;
    if (planning.on) stops = stops.map(planningView);

    const unplannedCount = stops.filter((s) => s.isUnplanned).length;

    // THE SCAN THAT WAS REFUSED, SO THE BUTTON CAN STOP SAYING IT RAN.
    //
    // "Scan now" fires nuvizz-manual-scan-background, which is a *-background* function:
    // Netlify answers 202 the instant the request lands and discards the handler's 401, so
    // resp.ok is TRUE, both client fallbacks are skipped, and the dispatcher is told "Scan
    // running — the board will refresh automatically" while nothing runs. This is the channel
    // that contradicts it — the refusal the gate wrote (nuvizz_ops/scan_refusal), served on the
    // very poll the client is already making, so no extra request and no extra round trip.
    //
    // AGE-CAPPED at six hours. A refusal from a previous shift is history and belongs in
    // nuvizz-scan-config?explain=1, not on this morning's board. `at` is served alongside so
    // the client can do the strict thing and only speak up when the refusal is NEWER than the
    // moment it pressed the button — a poll must never blame this press for the last one.
    //
    // Kept OUT of the ops block below: ops is a Promise.all of four reads, and one of those
    // failing must not be able to swallow the sentence that tells a dispatcher their scan did
    // not happen. A missing or unreadable refusal reads as "none", never as an error.
    // WHAT THE SCANNER IS ACTUALLY DOING, for the press that is waiting on it (2026-09-10).
    //
    // The refusal channel below answers "was this press turned away". It cannot answer the
    // other two ways a press comes to nothing: the scan is still running (a full run measured
    // 41-72s, and one in seven outlasts the button's own patience), or the run STARTED and then
    // died without writing a board — which is what happened at 20:01 when a vendor request with
    // no deadline hung the whole run. Both used to reach the dispatcher as the same sentence,
    // "Scan running — the board will refresh automatically", and one of the two is a lie.
    //
    // ONE getDoc (the ledger is a single document), and only when the caller asks: ?scanRun=1
    // is sent by the manual-scan poll and by nothing else, so the two-minute board poll — the
    // busiest read in the app — costs exactly what it did before.
    //
    // Ages are computed HERE, on the server's clock, and served as durations. A phone a few
    // minutes out would otherwise read its own press as an old run, or miss it entirely.
    let scanRun: any = null;
    if (url.searchParams.get('scanRun') === '1' && isFirestoreEnabled()) {
      try {
        const runs = await readScanRuns();
        const newest = [...runs].sort((a: any, b: any) => String(b?.startedAt || '').localeCompare(String(a?.startedAt || ''))).find((r: any) => r?.startedAt);
        if (newest) {
          const startMs = Date.parse(String(newest.startedAt));
          const endMs = newest.finishedAt ? Date.parse(String(newest.finishedAt)) : NaN;
          scanRun = {
            startedAt: newest.startedAt,
            startedAgeSec: Number.isFinite(startMs) ? Math.max(0, Math.round((Date.now() - startMs) / 1000)) : null,
            finished: !!newest.finishedAt,
            finishedAgeSec: Number.isFinite(endMs) ? Math.max(0, Math.round((Date.now() - endMs) / 1000)) : null,
            trigger: newest.trigger ?? null,
            outcome: newest.outcome ?? null,
            path: newest.path ?? null,
            error: newest.error ?? null,
          };
        }
      } catch { /* a missing ledger means "nothing to say", never an error on the board read */ }
    }

    let lastScanRefusal: any = null;
    const refusal = await refusalPromise;
    const refusedMs = refusal?.at ? Date.parse(refusal.at) : NaN;
    const refusalAgeMin = Number.isFinite(refusedMs) ? Math.round((Date.now() - refusedMs) / 60000) : null;
    if (refusal && refusalAgeMin != null && refusalAgeMin >= 0 && refusalAgeMin <= REFUSAL_MAX_AGE_MIN) {
      lastScanRefusal = {
        at: refusal.at,
        ageMin: refusalAgeMin,
        reason: refusal.reason,
        message: refusal.message,
        job: refusal.job,
        trigger: refusal.trigger ?? null,
      };
    }

    // Fix 5 — surface today's NuVizz call volume. Keyed by the ET (local) day the
    // calls happen, so "calls today" follows a normal midnight-to-midnight ET day
    // (matches the writer in nuvizz-request). Best-effort: never fail the fast
    // read path over ops.
    let ops: any = null;
    if (isFirestoreEnabled()) {
      try {
        const opsDate = etDayString();
        const [stats, circuit, metrics, scanCfg] = await Promise.all([readCallStats(opsDate), readCircuit(), readScanMetrics(), readScanConfig().catch(() => ({}))]);
        const ceiling = reportedDailyCeiling((scanCfg as any)?.dailyCeiling);
        const breakerBinding = circuitStillBinding(circuit.open, stats.count, ceiling);
        ops = {
          dayCount: stats.count,
          byRoute: stats.byRoute,
          byHour: stats.byHour, // per-ET-hour call counts { '00'..'23': n } — surfaces spikes
          byApp: stats.byApp,         // which app made the calls (dispatch-map vs parent)
          byTrigger: stats.byTrigger, // WHY: scheduled-scan | enrichment | attempts | on-demand | …
          bySource: stats.bySource,
          byTenant: stats.byTenant,
          // Effective spend cap: the live UI-configured ceiling wins over the env default, and
          // BOTH are clamped to what the breaker actually enforces. This line used to report
          // whichever number it found — the site's NUVIZZ_DAILY_CEILING is 20,000 — while the
          // breaker trips at 2,000, so the card and the Diagnostics gauge both overstated the
          // remaining headroom tenfold. See reportedDailyCeiling.
          ceiling,
          // BINDING, not merely flagged. Raising the ceiling releases a trip taken at the old
          // number (see circuitStillBinding), and the enforcement path does that on its next
          // call - but this card is what a dispatcher actually looks at, so it must not go on
          // reading "halted" in the meantime. Same predicate the breaker uses, on the count
          // and ceiling this endpoint already has in hand: no extra read, and no chance of
          // the screen and the spend path disagreeing about the word halted.
          breaker: breakerBinding,
          // WHY, AND SINCE WHEN. An open breaker refuses every scan, and "breaker: true" on
          // its own does not tell anyone whether that is today's ceiling doing its job or a
          // flag stuck from another day. It expires with the ET call counter it bounds, so
          // the stamp is the thing that says which.
          breakerReason: breakerBinding ? (circuit.reason ?? null) : null,
          breakerAt: breakerBinding ? (circuit.at ?? null) : null,
          breakerDay: circuit.day ?? null,
          mode: breakerMode(),
          // Learned scan-discovery summary (avg/max new loads/day, worst gap,
          // recommended adaptive-walk stop threshold, any parity misses).
          scanLearning: summarizeScanMetrics(metrics),
        };
      } catch { /* ops is best-effort; leave null */ }
    }

    return new Response(JSON.stringify({
      ok: true,
      date,
      source,
      // WHAT CAME OFF THE BOARD, AND WHY — see lib/stop-cancelled.js. Printed rather than
      // swallowed: the first question when a stop is missing is "did we drop it?", and a
      // rule that removes rows from a dispatcher's board has to be able to answer that
      // without a redeploy. 0 on an ordinary day.
      cancelledDropped: cancelledOff.length,
      cancelledStops: cancelledOff.slice(0, 25),
      generated: new Date().toISOString(),
      lastScannedAt,
      lastLoadScanAt,
      lastUnplannedScanAt,
      lastCompletedScanAt,
      scanState,
      lastScanRefusal,
      scanRun,
      count: stops.length,
      unplannedCount,
      carryoverCount,
      // What judged the folded rows and every decision it made (v0.95.0) — the Map's status
      // card and the explain endpoint read this; a pruning nobody can see is a row that
      // "just vanished".
      carryover: Object.keys(carryover).length ? carryover : null,
      carryDays,
      // Which board this is. true only on the UAT site with planning mode switched on; the mode
      // bar reads it so the screen can never show one mode while the server served the other.
      planningMode: planning.on,
      ...(planning.error ? { planningModeError: planning.error } : {}),
      lean: !full,   // true = lean projection served (see LEAN_STOP_FIELDS); false = ?full=1 / MAP_FEED_FULL
      ops,
      stops,
    }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({
      ok: false,
      error: e.message,
      status: e.status || 500,
      body: e.body,
    }), { status: e.status || 500, headers: cors });
  }
};
