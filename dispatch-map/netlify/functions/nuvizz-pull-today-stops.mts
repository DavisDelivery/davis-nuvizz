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
import { isFirestoreEnabled, readStops, readCallStats, readCircuit, etDayString, readScanMetrics, readScanConfig, readActiveUnplannedSet } from './lib/firestore.mts';
import { summarizeScanMetrics } from './lib/scan-metrics.mts';
import { filterFinishedPriorDay } from './lib/nuvizz-list.mts';
import { breakerMode } from './lib/nuvizz-request.mts';

const TENANT = 'davis';

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
async function mergeCarryover(stops: any[], date: string, carryDays: number): Promise<number> {
  const seen = new Set(stops.map((s) => String(s.stopNbr)));
  const priorDates = Array.from({ length: carryDays }, (_, i) => addDaysUTC(date, -(i + 1)));
  const live = await readActiveUnplannedSet(TENANT).catch(() => null);
  // FRESHNESS GUARD: only prune against the live set when the snapshot is recent. A stale snapshot
  // (after a weekend/breaker scan blackout, or one left behind if TWO_SCAN is turned off) no longer
  // reflects what's open, so trusting it could prune stops that are STILL unplanned — under-counting
  // the board, which for a dispatch app is worse than the over-count #253 set out to fix. When the
  // snapshot is stale/missing we fall back to legacy behaviour (fold everything in, prune nothing).
  const STALE_SNAPSHOT_MS = 18 * 60 * 60 * 1000;   // ~18h: survives an overnight gap, not a weekend
  const snapshotAgeMs = live?.at ? (Date.now() - new Date(live.at).getTime()) : Infinity;
  const fresh = Number.isFinite(snapshotAgeMs) && snapshotAgeMs >= 0 && snapshotAgeMs <= STALE_SNAPSHOT_MS;
  const liveOk = !!(live && live.stopNbrs.size && live.windowStart && fresh);
  if (live && live.stopNbrs.size && live.windowStart && !fresh) {
    console.log(`[carryover] ${date}: live unplanned snapshot is stale (age ${Number.isFinite(snapshotAgeMs) ? Math.round(snapshotAgeMs / 3.6e6) + 'h' : 'n/a'}) — skipping prune, folding all carry-over`);
  }
  const reads = await Promise.all(
    priorDates.map((d) => readStops(TENANT, d).then((r) => ({ d, stops: r.stops })).catch(() => ({ d, stops: [] as any[] }))),
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
        && s.board_write_at && (Date.now() - Date.parse(s.board_write_at)) <= STAMP_FRESH_MS;
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
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  try {
    let stops: any[];
    let source: 'firestore' | 'fixture' | 'live-scan' | 'index-empty' = 'firestore';
    let lastScannedAt: string | null = null;
    let lastLoadScanAt: string | null = null;
    let lastUnplannedScanAt: string | null = null;
    let scanState: { halted: boolean; reason: string; since: string } | null = null;

    if (useMock) {
      stops = ((fixture as any).stops || []).map(normalizeStop);
      source = 'fixture';
    } else if (live) {
      // DEBUG path — scan NuVizz directly. May time out on the unplanned scan.
      const scan = await scanDate(date);
      stops = scan.stops;
      lastScannedAt = scan.scannedAt;
      lastLoadScanAt = scan.scannedAt;
      lastUnplannedScanAt = scan.scannedAt;
      source = 'live-scan';
    } else if (isFirestoreEnabled()) {
      const { meta, stops: indexed } = await readStops(TENANT, date);
      // READ-time board-day guard: never SHOW a prior-day FINISHED stop on this date's board.
      // The scanner keys boards by ET day so this is normally a no-op, but a board written under
      // the old UTC anchor (which filed Friday's deliveries onto Saturday's doc) sits in a weekend
      // scan-blackout that can't re-prune it — this strips that stale bleed at serve time.
      stops = filterFinishedPriorDay(indexed, date);
      lastScannedAt = meta?.last_scanned_at ?? null;
      lastLoadScanAt = meta?.lastLoadScanAt ?? meta?.last_scanned_at ?? null;
      lastUnplannedScanAt = meta?.lastUnplannedScanAt ?? null;
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
      try { carryoverCount = await mergeCarryover(stops, date, carryDays); } catch { /* keep base stops */ }
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
          // Effective spend cap: the live UI-configured ceiling wins over the env default.
          ceiling: (typeof (scanCfg as any)?.dailyCeiling === 'number' ? (scanCfg as any).dailyCeiling : (Number(process.env.NUVIZZ_DAILY_CEILING) || 12000)),
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
      scanState,
      count: stops.length,
      unplannedCount,
      carryoverCount,
      carryDays,
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
