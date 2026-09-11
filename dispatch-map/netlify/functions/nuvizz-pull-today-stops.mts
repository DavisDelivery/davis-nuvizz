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
import { poolUsable, POOL_LIVE_FIELDS, WINDOW_WRITE_GRACE_MS, type ActivePool } from './lib/active-pool.mts';
import { summarizeScanMetrics } from './lib/scan-metrics.mts';
import { filterFinishedPriorDay, unplanStampOvertaken } from './lib/nuvizz-list.mts';
import { LEAN_STOP_FIELDS } from './lib/board-fields.mts';
import { breakerMode, reportedDailyCeiling, circuitStillBinding } from './lib/nuvizz-request.mts';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';

// The Map feed's lean projection — the field set every screen reads, now shared with the
// Routing date window (see lib/board-fields.mts for why it moved out of this file).
// KILL SWITCH: `?full=1` on the request OR env MAP_FEED_FULL=1 returns the ORIGINAL full
// payload (no mask), so this is instantly reversible without a code change.

// How old a refused "Scan now" may be and still be worth putting in front of the dispatcher.
// Longer than the gap between pressing the button and looking back at the board; shorter than
// a shift, so last night's refusal never lands on this morning's screen.
const REFUSAL_MAX_AGE_MIN = 360;

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
export interface CarryoverStats {
  /** what judged the prior-day rows: the scan's open-order pool, the older unplanned snapshot, or nothing */
  basis: 'pool' | 'snapshot' | 'none';
  poolAt: string | null; poolWhy: string | null; snapshotAt: string | null;
  added: number; pruned: number; replaced: number;
  closed: number; moved: number; retired: number; reopened: number; unverified: number; held: number; replanned: number;
  /** the judge was thin — nothing was dropped on its word */
  thin: boolean;
}

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
  const seen = new Set(stops.map((s) => String(s.stopNbr)));
  const priorDates = Array.from({ length: carryDays }, (_, i) => addDaysUTC(date, -(i + 1)));
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
  const poolCheck = poolUsable(pool, { nowMs: now(), newestDocScanAt: lastUnplannedScanAt });
  const poolOk = !!(pool && poolCheck.ok);
  const poolThin = !!(pool && pool.thin === true);
  const poolByNbr = new Map<string, any>();
  if (poolOk) for (const p of pool!.rows) { const k = String(p?.stopNbr ?? '').trim(); if (k && !poolByNbr.has(k)) poolByNbr.set(k, p); }
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
  // over-counting, never hiding work. A THIN snapshot (the scan's own verdict that the pull
  // that built it came back short) is never trusted to prune either.
  const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // absolute backstop, not the working rule
  const SUPERSEDE_SLACK_MS = 15 * 60 * 1000;   // same scan ⇒ identical stamps; slack absorbs legacy paths
  const snapAtMs = live?.at ? new Date(live.at).getTime() : NaN;
  const snapshotAgeMs = Number.isFinite(snapAtMs) ? (now() - snapAtMs) : Infinity;
  const boardScanMs = lastUnplannedScanAt ? new Date(lastUnplannedScanAt).getTime() : NaN;
  const superseded = Number.isFinite(snapAtMs) && Number.isFinite(boardScanMs)
    && (boardScanMs - snapAtMs) > SUPERSEDE_SLACK_MS;
  const fresh = Number.isFinite(snapshotAgeMs) && snapshotAgeMs >= 0 && snapshotAgeMs <= SNAPSHOT_MAX_AGE_MS && !superseded;
  const snapThin = !!(live && (live as any).thin === true);
  const liveOk = !!(live && live.stopNbrs.size && live.windowStart && fresh && !snapThin);
  if (!poolOk && live && live.stopNbrs.size && live.windowStart && !liveOk) {
    const why = snapThin ? `thin — the scan that wrote it judged its own pull short`
      : superseded ? `superseded — an orders scan at ${lastUnplannedScanAt} never refreshed the ${live.at} snapshot`
      : `age ${Number.isFinite(snapshotAgeMs) ? Math.round(snapshotAgeMs / 3.6e6) + 'h' : 'n/a'} is past the ${Math.round(SNAPSHOT_MAX_AGE_MS / 3.6e6)}h backstop`;
    console.log(`[carryover] ${date}: live unplanned snapshot not trusted (${why}) — skipping prune, folding all carry-over`);
  }
  if (pool && !poolOk) console.log(`[carryover] ${date}: open-order pool not used (${poolCheck.why}) — falling back to the unplanned snapshot`);
  const stats: CarryoverStats = {
    basis: poolOk ? 'pool' : (liveOk ? 'snapshot' : 'none'),
    poolAt: pool?.at ?? null, poolWhy: poolCheck.why, snapshotAt: live?.at ?? null,
    added: 0, pruned: 0, replaced: 0, closed: 0, moved: 0, retired: 0, reopened: 0, unverified: 0, held: 0, replanned: 0,
    thin: poolOk ? poolThin : snapThin,
  };
  const reads = await Promise.all(
    priorDates.map((d) => readStopsFn(TENANT, d, mask ? { mask } : undefined).then((r) => ({ d, stops: r.stops })).catch(() => ({ d, stops: [] as any[] }))),
  );
  // A confirmed-planned stamp folds only while FRESH (48h): the home-day stamp is frozen
  // forever (prior days are never rescanned), so without the cap a long-DELIVERED old-dated
  // order kept folding back as live SCHEDULED for the full carry window (audit F6).
  const STAMP_FRESH_MS = 48 * 3600 * 1000;
  // The pool's live fields laid over the frozen copy: status and plan are this scan's, the pin
  // and the customer detail stay the copy's. Same overlay the Routing window applies.
  const overlay = (s: any, p: any) => {
    const m: any = { ...s };
    for (const k of POOL_LIVE_FIELDS) if (p[k] !== undefined) m[k] = p[k];
    m.poolSynced = true;
    return m;
  };
  const fold = (s: any, d: string, extra: Record<string, any> = {}) => {
    seen.add(String(s.stopNbr));
    // boardDate pinned to the served day (consistency with the replace path): downstream
    // day-bucketing must file this row under the board it is being served on.
    stops.push({ ...s, carryover: true, scheduledDate: d, boardDate: date, ...extra });
    stats.added++;
  };
  for (const { d, stops: prior } of reads) {
    for (const s of prior) {
      if (!s) continue;
      const key = String(s.stopNbr ?? '').trim();
      if (!key) continue;
      // `isTerminal` on these rows means "delivers to Davis's own terminal" (detectTerminal in
      // nuvizz-scan.mts), not a terminal status — it used to end this loop for such rows, so a
      // terminal-bound order carried nowhere. Status is the truth (audit P4/P7a): a cancelled
      // order (status 99, no route) read as plain UNPLANNED and folded back as workable whenever
      // the live snapshot was stale, and a DELIVERED row that kept its write stamp would qualify
      // for the confirmed-planned fold.
      const stTerm = String(s.normalizedStatus ?? '').toUpperCase();
      const terminal = stTerm === 'DELIVERED' || stTerm === 'EXCEPTION' || stTerm === 'CANCELLED';
      const p = poolOk ? poolByNbr.get(key) : undefined;
      if (terminal) {
        // RE-OPENED (v0.95.0): the pool lists this number OPEN again on a past day — an ATT
        // re-attempt under the same stop number (HIGHLAND FORGE, refused on TAYLOR 09/02 and
        // re-opened by CS). Before this the frozen finished copy outranked the live open row and
        // the Map never showed freight NuVizz was asking to have planned. The scan heals the copy
        // on its next pass; this fold does not wait for it.
        if (p && p.day < date && !seen.has(key)) { fold(overlay(s, p), d, { reopened: true }); stats.reopened++; }
        continue;                                          // history: never folded
      }
      // UNPLANNED prior-day rows fold as always. ONE planned exception (NOLAN, OWUSU 1,
      // Jul 10): a prior-day order a CONFIRMED live Save routed onto a load that runs
      // today (board_write_planned — the write-through/rescue stamp) must keep folding,
      // or the order vanishes from the board entirely the moment its Compare card closes
      // — while NuVizz's load holds it. Other planned prior-day rows still never fold
      // (they're that day's own live routes, not today's work) — UNLESS the pool now lists
      // the order UNPLANNED on a past day (v0.95.0: un-planned in NuVizz after its day froze,
      // PRIMARY LOGISTICS' 10,000 lb hidden from the pool of work to plan for a weekend).
      const confirmedPlanned = s.isPlanned && s.board_write_planned === true
        && s.board_write_at && (now() - Date.parse(s.board_write_at)) <= STAMP_FRESH_MS;
      if (s.isPlanned && !confirmedPlanned) {
        if (p && p.day < date && p.isPlanned !== true && !seen.has(key)) { fold(overlay(s, p), d); stats.replanned++; }
        continue;
      }
      if (seen.has(key)) {
        // SHADOW FIX (audit F2): a stale-UNPLANNED today row (pre-fix revert residue) must not
        // hide the confirmed plan — replace it in place. A today row that is planned, or that
        // carries its own write stamp, always wins.
        if (confirmedPlanned) {
          const idx = stops.findIndex((t: any) => String(t?.stopNbr) === key);
          const cur = idx >= 0 ? stops[idx] : null;
          if (cur && cur.isPlanned !== true && !cur.board_write_at) {
            stops[idx] = { ...s, carryover: true, scheduledDate: d, boardDate: date };
            stats.replaced++;
          }
        }
        continue;
      }
      if (poolOk) {
        // A confirmed Save outranks the pool while the pool is older than the stamp, or while the
        // stamp is inside the board's write grace and the pool still disagrees — the same hold the
        // Routing window applies, so the two screens cannot disagree about a plan somebody just made.
        const stampAt = Date.parse(String(s.board_write_at || ''));
        const stampNewer = Number.isFinite(stampAt) && stampAt > Date.parse(pool!.at);
        const inGrace = Number.isFinite(stampAt) && now() - stampAt < WINDOW_WRITE_GRACE_MS;
        const agrees = !!p && (s.isPlanned === true) === (p.isPlanned === true);
        // Same discriminator as the scan and the window (v1.8.0): a pool row naming a route this
        // order was not taken off has seen the world after our Save, so the stamp is stale.
        if ((stampNewer || inGrace) && !agrees && !(p && unplanStampOvertaken(s, p))) { fold(s, d); stats.held++; continue; }
        if (p) {
          if (p.day >= date) {
            // NuVizz files it on today or later now: today's own row (already served) or a
            // future day's work. A confirmed plan without a today row keeps folding until the
            // board write that carries it lands.
            if (confirmedPlanned) { fold(s, d); continue; }
            stats.moved++; stats.pruned++; continue;
          }
          fold(overlay(s, p), d); continue;                 // still open on a past day: live state, frozen pin
        }
        const inReach = d >= pool!.windowStart;
        if (!confirmedPlanned) {
          if (inReach && !poolThin) { stats.closed++; stats.pruned++; continue; }   // NuVizz no longer lists it
          if (retired[key]) { stats.retired++; stats.pruned++; continue; }
          if (!inReach) { fold(s, d, { unverified: true }); stats.unverified++; continue; }   // older than any scan can see: served, and SAID so
        }
        fold(s, d); continue;                               // thin pool inside reach, or a confirmed plan: no verdict, folds
      }
      // Within the live window but no longer unplanned in the latest scan → delivered/planned
      // since. Applies to the UNPLANNED fold only — a confirmed-planned row is EXPECTED to be
      // absent from the unplanned snapshot (it just got planned; that's not "closed since").
      if (!confirmedPlanned && liveOk && d >= live!.windowStart! && !live!.stopNbrs.has(key)) { stats.closed++; stats.pruned++; continue; }
      // OUTSIDE that window the snapshot is not entitled to judge, and prior-day board docs are
      // frozen — which is how rows from a fortnight ago kept folding as UNPLANNED with nothing
      // able to retire them (Chad: "it's showing more than that"). The scan proves those against
      // the IMMUTABLE history warehouse and records the finished ones here, so a row sealed
      // DELIVERED/EXCEPTION/CANCELLED on ANY day retires at any age. Unproven rows are absent
      // from the map and still fold — this can only ever remove a stop history says is done.
      if (!confirmedPlanned && retired[key]) { stats.retired++; stats.pruned++; continue; }
      const vouched = confirmedPlanned || (liveOk && d >= live!.windowStart!);
      if (vouched) { fold(s, d); continue; }
      fold(s, d, { unverified: true }); stats.unverified++;
    }
  }
  if (stats.replaced) console.log(`[carryover] ${date}: replaced ${stats.replaced} stale-unplanned row(s) with their confirmed plans`);
  if (stats.pruned || stats.reopened || stats.replanned || stats.held) console.log(`[carryover] ${date}: basis=${stats.basis}${stats.thin ? ' (thin)' : ''} folded ${stats.added}, pruned ${stats.pruned} (closed ${stats.closed}, moved ${stats.moved}, retired ${stats.retired}), reopened ${stats.reopened}, re-planned ${stats.replanned}, held ${stats.held}, unverified ${stats.unverified}`);
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
