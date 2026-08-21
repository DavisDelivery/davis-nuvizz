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
//                     the 26s cap for the unplanned scan — not for normal use)

import fixture from '../../test/fixtures/nuvizz-today-stops.json' with { type: 'json' };
import { scanDate, normalizeStop } from './lib/nuvizz-scan.mts';
import { isFirestoreEnabled, readStops, readCallStats, readCircuit, etDayString, readScanMetrics, readScanConfig, readActiveUnplannedSet, readCarryoverRetired } from './lib/firestore.mts';
import { summarizeScanMetrics } from './lib/scan-metrics.mts';
import { filterFinishedPriorDay } from './lib/nuvizz-list.mts';
import { breakerMode, reportedDailyCeiling } from './lib/nuvizz-request.mts';

const TENANT = 'davis';

// LEAN MAP FEED (issue: cold load blocked ~5-6s on a 6.9 MB payload; 747 stops × 67 fields).
// The map + bottom grid only read ~15-20 fields; ~55% of the payload is the raw NuVizz object
// (`raw`, 3.8 MB) plus a few fields nothing in the client reads (markfor/origin/billTo/the
// top-level orderInstructions dup). We serve ONLY the field paths below (a Firestore field
// mask on the read — so the bytes never leave Firestore), which halves the payload and the
// server time with ZERO client change: everything the markers, status, grid, selection,
// detail panel, print, texting, and auto-scanner touch is kept. The three `raw.*` slices
// preserve the only load-bearing bits of `raw` (status fallback, route/load id, print origin).
// The stored docs are untouched — history/engine/freight still read every field directly.
// KILL SWITCH: `?full=1` on the request OR env MAP_FEED_FULL=1 returns the ORIGINAL full
// payload (no mask), so this is instantly reversible without a code change.
// Derived from normalizeStop's schema (nuvizz-scan.mts) ∪ the enrichment/list-path fields, so
// a field that's null/absent on a given day is still served on days it appears. Keep in sync
// if the stored stop shape gains a NEW field the client needs (or just flip the kill switch).
const LEAN_STOP_FIELDS = [
  'addr1', 'addr2', 'allComments', 'boardDate', 'board_write_at', 'board_write_planned',
  'bol', 'businessName', 'carryover', 'cartons', 'city', 'contact',
  'custRef', 'customerAccount', 'deliveredDTTM', 'driverId', 'driverName', 'driverUserName',
  'enriched', 'enriched_at', 'estimatedDurationMin', 'isAttempt', 'isPlanned', 'isTerminal',
  'isUnplanned', 'itemsSummary', 'lat', 'listUpdatedDTTM', 'lng', 'loadId',
  'loadNbr', 'loadStopSeq', 'normalizedStatus', 'orderNbr', 'pallets', 'plannedDistanceToNextStop',
  'plannedDurationToNextStop', 'plannedEtaDTTM', 'poRef', 'podDocs', 'primaryPro', 'pro',
  'proCount', 'proNbr', 'pros', 'requestedDate', 'routeName', 'routeSeq',
  'orderInstructions', 'notes_refreshed_at',
  'scheduledDate', 'scheduledFrom', 'scheduledTo', 'shipmentNbr', 'signalSources', 'source',
  'state', 'status', 'stopDetails', 'stopDistance', 'stopId', 'stopNbr',
  'stopType', 'terms', 'timeConstraint', 'volume', 'warehouse', 'weight',
  'zip', 'raw.stopExecutionInfo', 'raw.load', 'raw.stop.from',
];

function addDaysUTC(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

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
export async function mergeCarryover(stops: any[], date: string, carryDays: number, io?: {
  readStops?: (tenant: string, dateStr: string, opts?: { mask?: string[] }) => Promise<{ stops: any[] }>;
  readActiveUnplannedSet?: (tenant: string) => Promise<{ at: string | null; windowStart: string | null; stopNbrs: Set<string> } | null>;
  readCarryoverRetired?: (tenant: string) => Promise<Record<string, string>>;
  now?: () => number;
}, mask?: string[], lastUnplannedScanAt: string | null = null): Promise<number> {
  const readStopsFn = io?.readStops ?? readStops;
  const readActiveFn = io?.readActiveUnplannedSet ?? readActiveUnplannedSet;
  const readRetiredFn = io?.readCarryoverRetired ?? readCarryoverRetired;
  const now = io?.now ?? Date.now;
  const seen = new Set(stops.map((s) => String(s.stopNbr)));
  const priorDates = Array.from({ length: carryDays }, (_, i) => addDaysUTC(date, -(i + 1)));
  const live = await readActiveFn(TENANT).catch(() => null);
  // Rows the scan has PROVEN finished against the immutable history warehouse — the only
  // evidence that survives past the live snapshot's ~7-day window. ONE getDoc; {} on failure,
  // which degrades to the old over-count rather than hiding work.
  const retired = await readRetiredFn(TENANT).catch(() => ({} as Record<string, string>));
  // SNAPSHOT TRUST — scan-relative, not wall-clock (the weekend phantom fix, Aug 2). The old
  // guard aged the snapshot against the clock (18h — "survives an overnight gap, not a
  // weekend"), so every weekend scan blackout switched pruning OFF and the board folded EVERY
  // frozen prior-day unplanned row: Aug 2 it showed 127 carry-overs of which 105 were already
  // closed (Chad: "we do not have 127 orders carrying over from last week"). But time alone
  // cannot stale this snapshot — the prior-day boards it judges are frozen by the SAME blackout,
  // so nothing served here is ever newer than the snapshot unless a scan ran after it. So: trust
  // the snapshot until an orders scan SUPERSEDES it without refreshing it (list scans write the
  // board stamp and the snapshot from one shared scannedAt, so a board stamp measurably newer
  // than the snapshot means the snapshot writer is off — the TWO_SCAN-disabled case the old
  // guard actually existed for). A 7-day ceiling stays as an absolute backstop; past it (or when
  // trust fails) we fall back to legacy behaviour: fold everything in, prune nothing —
  // over-counting, never hiding work.
  const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // absolute backstop, not the working rule
  const SUPERSEDE_SLACK_MS = 15 * 60 * 1000;   // same scan ⇒ identical stamps; slack absorbs legacy paths
  const snapAtMs = live?.at ? new Date(live.at).getTime() : NaN;
  const snapshotAgeMs = Number.isFinite(snapAtMs) ? (now() - snapAtMs) : Infinity;
  const boardScanMs = lastUnplannedScanAt ? new Date(lastUnplannedScanAt).getTime() : NaN;
  const superseded = Number.isFinite(snapAtMs) && Number.isFinite(boardScanMs)
    && (boardScanMs - snapAtMs) > SUPERSEDE_SLACK_MS;
  const fresh = Number.isFinite(snapshotAgeMs) && snapshotAgeMs >= 0 && snapshotAgeMs <= SNAPSHOT_MAX_AGE_MS && !superseded;
  const liveOk = !!(live && live.stopNbrs.size && live.windowStart && fresh);
  if (live && live.stopNbrs.size && live.windowStart && !fresh) {
    const why = superseded
      ? `superseded — an orders scan at ${lastUnplannedScanAt} never refreshed the ${live.at} snapshot`
      : `age ${Number.isFinite(snapshotAgeMs) ? Math.round(snapshotAgeMs / 3.6e6) + 'h' : 'n/a'} is past the ${Math.round(SNAPSHOT_MAX_AGE_MS / 3.6e6)}h backstop`;
    console.log(`[carryover] ${date}: live unplanned snapshot not trusted (${why}) — skipping prune, folding all carry-over`);
  }
  const reads = await Promise.all(
    priorDates.map((d) => readStopsFn(TENANT, d, mask ? { mask } : undefined).then((r) => ({ d, stops: r.stops })).catch(() => ({ d, stops: [] as any[] }))),
  );
  let added = 0, pruned = 0, replaced = 0;
  // A confirmed-planned stamp folds only while FRESH (48h): the home-day stamp is frozen
  // forever (prior days are never rescanned), so without the cap a long-DELIVERED old-dated
  // order kept folding back as live SCHEDULED for the full carry window (audit F6).
  const STAMP_FRESH_MS = 48 * 3600 * 1000;
  for (const { d, stops: prior } of reads) {
    for (const s of prior) {
      if (!s || s.isTerminal) continue;                  // real, unfinished stops only
      // Belt on top of isTerminal (audit P4/P7a): the flag is enrichment-set and can be absent
      // on list-only rows — a cancelled order (status 99, no route) read as plain UNPLANNED and
      // folded back as workable whenever the live snapshot was stale, and a DELIVERED row that
      // kept its write stamp would qualify for the confirmed-planned fold. Status is the truth.
      const stTerm = String(s.normalizedStatus ?? '').toUpperCase();
      if (stTerm === 'DELIVERED' || stTerm === 'EXCEPTION' || stTerm === 'CANCELLED') continue;
      // UNPLANNED prior-day rows fold as always. ONE planned exception (NOLAN, OWUSU 1,
      // Jul 10): a prior-day order a CONFIRMED live Save routed onto a load that runs
      // today (board_write_planned — the write-through/rescue stamp) must keep folding,
      // or the order vanishes from the board entirely the moment its Compare card closes
      // — while NuVizz's load holds it. Other planned prior-day rows still never fold
      // (they're that day's own live routes, not today's work).
      const confirmedPlanned = s.isPlanned && s.board_write_planned === true
        && s.board_write_at && (now() - Date.parse(s.board_write_at)) <= STAMP_FRESH_MS;
      if (s.isPlanned && !confirmedPlanned) continue;
      const key = String(s.stopNbr);
      if (!key) continue;
      if (seen.has(key)) {
        // SHADOW FIX (audit F2): a stale-UNPLANNED today row (pre-fix revert residue) must not
        // hide the confirmed plan — replace it in place. A today row that is planned, or that
        // carries its own write stamp, always wins.
        if (confirmedPlanned) {
          const idx = stops.findIndex((t: any) => String(t?.stopNbr) === key);
          const cur = idx >= 0 ? stops[idx] : null;
          if (cur && cur.isPlanned !== true && !cur.board_write_at) {
            stops[idx] = { ...s, carryover: true, scheduledDate: d, boardDate: date };
            replaced++;
          }
        }
        continue;
      }
      // Within the live window but no longer unplanned in the latest scan → delivered/planned
      // since. Applies to the UNPLANNED fold only — a confirmed-planned row is EXPECTED to be
      // absent from the unplanned snapshot (it just got planned; that's not "closed since").
      if (!confirmedPlanned && liveOk && d >= live!.windowStart! && !live!.stopNbrs.has(key)) { pruned++; continue; }
      // OUTSIDE that window the snapshot is not entitled to judge, and prior-day board docs are
      // frozen — which is how rows from a fortnight ago kept folding as UNPLANNED with nothing
      // able to retire them (Chad: "it's showing more than that"). The scan proves those against
      // the IMMUTABLE history warehouse and records the finished ones here, so a row sealed
      // DELIVERED/EXCEPTION/CANCELLED on ANY day retires at any age. Unproven rows are absent
      // from the map and still fold — this can only ever remove a stop history says is done.
      if (!confirmedPlanned && retired[key]) { pruned++; continue; }
      seen.add(key);
      // boardDate pinned to the served day (consistency with the replace path): downstream
      // day-bucketing must file this row under the board it is being served on.
      stops.push({ ...s, carryover: true, scheduledDate: d, boardDate: date });
      added++;
    }
  }
  if (replaced) console.log(`[carryover] ${date}: replaced ${replaced} stale-unplanned row(s) with their confirmed plans`);
  if (pruned) console.log(`[carryover] ${date}: folded ${added}, pruned ${pruned} stale (delivered/planned since last full scan)`);
  return added;
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
    if (carryDays > 0 && !useMock && !live && isFirestoreEnabled()) {
      try { carryoverCount = await mergeCarryover(stops, date, carryDays, undefined, stopMask, lastUnplannedScanAt); } catch { /* keep base stops */ }
    }

    const unplannedCount = stops.filter((s) => s.isUnplanned).length;

    // Fix 5 — surface today's NuVizz call volume. Keyed by the ET (local) day the
    // calls happen, so "calls today" follows a normal midnight-to-midnight ET day
    // (matches the writer in nuvizz-request). Best-effort: never fail the fast
    // read path over ops.
    let ops: any = null;
    if (isFirestoreEnabled()) {
      try {
        const opsDate = etDayString();
        const [stats, circuit, metrics, scanCfg] = await Promise.all([readCallStats(opsDate), readCircuit(), readScanMetrics(), readScanConfig().catch(() => ({}))]);
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
          ceiling: reportedDailyCeiling((scanCfg as any)?.dailyCeiling),
          breaker: circuit.open,
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
      generated: new Date().toISOString(),
      lastScannedAt,
      lastLoadScanAt,
      lastUnplannedScanAt,
      lastCompletedScanAt,
      scanState,
      count: stops.length,
      unplannedCount,
      carryoverCount,
      carryDays,
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
