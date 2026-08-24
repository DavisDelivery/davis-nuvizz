// refresh-stops-core.mts
//
// Shared handler for the scheduled stop-index writers. Two thin function
// wrappers (daytime + evening) both delegate here — Netlify allows only ONE
// cron expression per scheduled function, so covering two UTC windows requires
// two function files sharing this one implementation.
//
// Each run scans TODAY + the next 7 calendar days and upserts every normalized
// stop into nuvizz_stop_index/{tenant}__{date}/stops/{stopNbr}, with a meta doc
// carrying last_scanned_at. Future dates are scanned so date-picker selections
// ahead of today aren't empty (see PR caveat).
//
// Scheduling is governed ENTIRELY by the two wrappers' cron expressions (see
// nuvizz-refresh-stops-background.mts) — there is deliberately no UTC-weekday
// skip here, because the Friday-evening ET window lands on Saturday UTC and a
// naive getUTCDay() check would wrongly drop it. Manual HTTP runs always proceed.
//
// The board day is anchored on the EASTERN calendar day (etDayString), not the UTC
// day: after ~8pm ET the UTC date is already tomorrow, so a UTC anchor filed the
// Friday-evening live board under Saturday's doc key — which, with no weekend scan to
// re-derive it, left Friday's deliveries sitting on Saturday's board all weekend.

import { scanDate, scansEnabled, deriveFleetSummary, estimateLoadRange, buildScanState, shadowWouldProbe, selectLoadProbeTargets, groupLoadMembers, estimateStopFrontier, unplannedFloor, FLOOR_MARGIN, loadNbrToInt, stopNbrToInt, shouldDeepSweep, deepSweepGate, lookupStopByPro, lookupLoadStopNbrs } from './nuvizz-scan.mts';
import { loadProbeParity, frontierParity, loadMembershipDelta, dateSliceMismatch } from './scan-parity.mts';
import { isFirestoreEnabled, writeStops, writeFleetIndex, getDoc, markScanState, readCallStats, readCircuit, readScanState, writeScanState, readRecentFrontier, recordScanMetric, etDayString, readScanConfig, readStops, readEnrichedPros, writeEnrichedPros, writeLoadRoster, readLoadRoster, writeActiveUnplannedSet, readBoardDateOverrides, readActiveUnplannedSet, readCarryoverRetired, mergeCarryoverRetired, readScanKindStamps, markScanKinds, applyCompletionPatches, markCompletedScan } from './firestore.mts';
import { listScanForDate, mergeEnrich, twoScanBuckets, completedScanRows, etDateForTargetUTC, boardDayFor, applyBoardWriteGrace, applyDemotionVerify, demotionLookupVerdict, absentPlanDemoteCandidate, isTerminalStatus, isPickupRow } from './nuvizz-list.mts';
import { loadIdsForDate, dropForeignLoadStops, loadRosterForDate } from './nuvizz-loads.mts';
import { getStop } from './history-store.mts';
import { resolveCoords, addrKey } from './geocode.mts';
import { maxConsecutiveGap } from './scan-metrics.mts';
import { notifyMarkedCustomers, pendingNotifyDates } from './cs-notify.mts';
import { breakerTripped, scanIntervalElapsed, breakerMode, setDailyCeilingOverride, setCallTrigger } from './nuvizz-request.mts';
import { scanDecision, isInRoutingWindow, clampScanConfig } from './scan-schedule.mts';
import { clampScanRules, defaultScanRules, dueKinds, overrideCadenceSkip } from './scan-plan.mts';
import { planCompletions } from './scan-completions.mts';

// Reuse the CANONICAL integer parsers from nuvizz-scan so the parity log's
// load/stop numbers are extracted identically to selectLoadProbeTargets /
// buildScanState (a divergent local parser could emit false MISSED_LOADS).
const loadNbrInt = loadNbrToInt;
const stopNbrInt = stopNbrToInt;

const TENANT = 'davis';
// Scheduled runs scan TODAY + the next BUSINESS day — the dispatcher's planning
// horizon. (The original today+next-7 was an 8× multiplier on every cron tick;
// today-only was too tight — it left tomorrow's board frozen, since the map only
// READS Firestore and never scans a future date itself.) Business-day stepping so
// a Friday run covers Monday, not an empty Saturday. Volume stays modest because
// the load-window self-calibrates to each day's actual span (see nuvizz-scan.mts).
const DEFAULT_DAYS = 2; // today + next business day (was 1 = today only)
// LIST-DISCOVERY write horizon: today + the next (N-1) BUSINESS days. The active saved-search
// pull is ALREADY a ±7d window, so writing an extra planning day costs NO extra list call — only
// that day's load roster + first-time enrichment of its new orders. 3 = today + next 2 business
// days, so a SUNDAY scan already builds TUESDAY's board (Uline ships Sunday for Tuesday delivery)
// instead of leaving it empty until Monday's scan reaches it (#251) — and the enrichment lands on
// Sunday, the week's lowest call-volume day, not on busy Monday. Env-overridable; clamped 2..5.
const LIST_HORIZON_DAYS = Math.max(2, Math.min(5, Number(process.env.NUVIZZ_LIST_HORIZON_DAYS) || 3));

function addDaysUTC(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── History-terminal cross-check (fixes the stale-Scheduled appointment stop) ──
// A stop delivered a day or two ago is in NEITHER saved-search pull (out of ACTIVE
// once status 90; out of COMPLETED once it wasn't "updated today"), so the two-scan
// carry-forward re-adds its last OPEN snapshot and it sits Scheduled on the board
// forever (e.g. a ULINE APPT order that delivered early on another route). Before
// re-carrying such an absent-from-pull open row, we consult the IMMUTABLE history
// warehouse: if a recent prior day sealed it DELIVERED/EXCEPTION/CANCELLED, it's
// genuinely finished and we drop the stale open row. Firestore only — ZERO NuVizz.

// PURE: is a warehouse stop record a sealed terminal (finished) state? Exported for tests.
export function isTerminalHistoryStatus(rec: any): boolean {
  const s = String(rec?.normalizedStatus ?? '').toUpperCase();
  return s === 'DELIVERED' || s === 'EXCEPTION' || s === 'CANCELLED';
}

// PURE: the bounded prior-day window to search for a sealed terminal record (yesterday
// back n days from the scan's ET today). Exported for tests.
export function historyLookbackDates(today: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= Math.max(0, n); i++) out.push(addDaysUTC(today, -i));
  return out;
}

// ── Carry-over retirement (the phantom-unplanned fix) ────────────────────────
//
// Chad, on a board reading 548 unplanned against a 650-order Uline day he could not
// reconcile: "it's showing more than that and we need a permanent and correct fix for that
// so I can trust the numbers."
//
// mergeCarryover can only retire a carried row when the live active-unplanned snapshot
// vouches against it, and that snapshot's saved search reaches back ~7 days — so it refuses
// to judge anything older (correctly: absence from a 7-day search is not proof). Prior-day
// board docs are frozen, so nothing else can ever retire those rows either. They fold as
// UNPLANNED forever and the count only grows.
//
// The immutable history warehouse has no such window. This pass asks it, once per scan, about
// exactly the rows the snapshot cannot vouch for, and records the proven-finished ones so the
// read path can drop them in a single getDoc. Bounded and fail-open throughout: an exhausted
// read budget or an unreadable day leaves the row folding (an over-count the dispatcher can
// see beats silently hiding real freight).

/** PURE: which carried rows need a history verdict — still-open rows the live snapshot is
 *  not entitled to judge (older than its window, or no usable snapshot at all). Rows the
 *  snapshot DOES cover are already handled by mergeCarryover's own prune. */
export function carryoverRetirementCandidates(
  priorRows: Array<{ date: string; stops: any[] }>,
  live: { windowStart: string | null; stopNbrs: Set<string> } | null,
  alreadyRetired: Record<string, string>,
): Array<{ nbr: string; date: string }> {
  const out: Array<{ nbr: string; date: string }> = [];
  const seen = new Set<string>();
  const vouchFrom = live?.windowStart || null;
  for (const { date, stops } of priorRows || []) {
    for (const s of stops || []) {
      const nbr = String(s?.stopNbr ?? '');
      if (!nbr || seen.has(nbr)) continue;
      if (alreadyRetired[nbr]) continue;                       // proven once, never re-proved
      if (s?.isPlanned) continue;                              // planned rows fold by their own rule
      const st = String(s?.normalizedStatus ?? '').toUpperCase();
      if (st === 'DELIVERED' || st === 'EXCEPTION' || st === 'CANCELLED') continue;  // never folds anyway
      // Inside the snapshot's window the snapshot is authoritative — leave it alone.
      if (vouchFrom && date >= vouchFrom && live!.stopNbrs.size) continue;
      seen.add(nbr);
      out.push({ nbr, date });
    }
  }
  return out;
}

/** PURE: the days a row's delivery could have been sealed on — its own day forward to
 *  yesterday, newest first (a recent seal is found in one read). Bounded by `cap` days. */
export function retirementSearchDates(rowDate: string, today: string, cap = 21): string[] {
  const out: string[] = [];
  for (let i = 1; i <= cap; i++) {
    const d = addDaysUTC(today, -i);
    if (d < rowDate) break;
    out.push(d);
  }
  return out;
}

// ── Reconsignment detection ───────────────────────────────────────────────────
//
// A stop is enriched (full /stop/info incl. address + geocoded pin) ONCE, when it first
// appears; later scans keep only status/plan live and mergeEnrich carries the old address
// forward. So when NuVizz RECONSIGNS an order (changes the delivery address) after that
// first enrichment, the board froze the OLD address forever. The cheap saved-search list
// DOES carry the current addr1/city/zip every scan, so we compare it against the address we
// carried: if it differs, the order was reconsigned and we re-enrich the stop (fresh address
// + re-geocoded pin + line items) instead of merging the stale detail over it.
//
// CONVERGENCE: compare the list address to the LAST LIST address we saw for this stop — a
// signature we stamp on the board stop and persist — NOT to the /stop/info-derived stored
// address. The saved-search list and /stop/info come from DIFFERENT endpoints and can format
// the same address differently (a leading suite/unit number, a padded ZIP), so comparing
// list↔stored re-fired every scan for those stops and burned a /stop/info each time, never
// converging. list↔list is same-format, so it fires only on a REAL change and then converges
// on the very next scan. The signature is the format-stable parts (5-digit ZIP + street
// number) so trivial drift ("St" vs "Street", casing) is ignored. PURE / exported for tests.
export function addrListSig(stop: any): string {
  const zip5 = String(stop?.zip ?? '').replace(/\D/g, '').slice(0, 5);
  const streetNum = String(stop?.addr1 ?? '').match(/\d+/)?.[0] || '';
  return (zip5 || streetNum) ? `${zip5}|${streetNum}` : '';
}
// ── One-time repair for pickups enriched before the ship-to fix ───────────────
//
// Until v0.65.2 the merge discarded a pickup's real address in favour of the saved search's
// ship-to column (see isPickupRow in nuvizz-list.mts). The enrichment registry stores the
// MERGED row, not the raw /stop/info answer, so the correct pickup address is not in our
// data anywhere and no amount of carrying forward can recover it — it takes one fresh
// /stop/info per affected pickup. This stamp records that the re-read has happened, so the
// repair costs one call per pickup ONCE and can never become a per-scan habit. It is
// written on the strength of the ANSWER, not the attempt: a call that never came back
// leaves the stamp unset and is retried, exactly like any other un-enriched stop.
export const PICKUP_ADDR_HEAL = 1;

// True when the stop's CURRENT list address differs from the signature we last stored for it.
// No stored baseline (first sighting) or no usable current list address → never a change, so a
// fresh field rollout and a momentarily address-less list row both stay quiet (no false re-pull).
export function reconsignedByListSig(priorSig: string | null | undefined, listStop: any): boolean {
  if (!priorSig) return false;
  const cur = addrListSig(listStop);
  if (!cur) return false;
  return cur !== priorSig;
}

// ── Two records, one number (the Estes-0828068215 lesson, Aug 4) ──────────────
//
// /stop/info looks a stop up BY NUMBER, and NuVizz can hold two different orders under one
// number (a rekeyed order next to the original entry). When that read answers with the OTHER
// record, merging it would put the twin's address, coords and line items on the dispatcher's
// card — which is exactly how Jessica's corrected Estes order kept "reverting to the Davis
// entry". The list row carries the internal id of the record the board is actually showing,
// so the merge is only allowed when the identities agree (or either side has no id — the
// guard only ever narrows). PURE / exported for tests.
export function enrichedRecordMatches(listStop: any, fetched: any): boolean {
  const a = String(listStop?.stopId ?? '').trim();
  const b = String(fetched?.stopId ?? '').trim();
  return !a || !b || a === b;
}

// Factory: memoized (per-scan), read-capped lookup of a stop's most-recent sealed
// terminal history record. readStop is injected (getStop over history_days) so the
// window / cap / memoization are unit-testable without Firestore. Returns the terminal
// record or null; caches per stopNbr so a repeated candidate costs no extra reads.
export function makeHistoryTerminalLookup(deps: {
  readStop: (date: string, nbr: string) => Promise<any>;
  dates: string[];
  isTerminal: (rec: any) => boolean;
  readCap: number;
}): { lookup: (nbr: string) => Promise<any | null>; reads: () => number } {
  const cache = new Map<string, any>();
  let reads = 0;
  const lookup = async (nbr: string): Promise<any | null> => {
    if (cache.has(nbr)) return cache.get(nbr);
    let found: any = null;
    for (const d of deps.dates) {
      if (reads >= deps.readCap) break;   // backstop; the miss is held (never a false drop)
      reads++;
      const rec = await deps.readStop(d, nbr).catch(() => null);
      if (rec && deps.isTerminal(rec)) { found = rec; break; }
    }
    cache.set(nbr, found);
    return found;
  };
  return { lookup, reads: () => reads };
}

// ── Demotion lookup (factory; exported for tests) ─────────────────────────────
// The EXACT policy runRefreshStops hands applyDemotionVerify when the list tries to un-plan a
// previously-planned row, with every effectful read injected so the rules are unit-testable:
//  • a fresh TERMINAL row (DELIVERED/EXCEPTION/CANCELLED) never resurrects — demote stands (F5);
//  • the LOAD corroborates first: the board row's route NAME resolves to a load number through
//    the day's cached roster (AMBIGUOUS names never resolve — two same-named loads must not
//    demote each other's stops, F3), one memoized load read covers every check on that load,
//    and only a POSITIVE membership short-circuits (a "not a member" can be the wrong
//    same-named instance — the stop record decides, F3b);
//  • a roster read FAILURE holds every name-resolved check this scan (never guess, F9) — a
//    roster that's merely absent falls through to the stop record;
//  • budgets: at most `loadReadBudget` load reads and `stopReadBudget` stop-record reads per
//    scan; anything past budget verdicts null → held one tick, never demoted on a missing read.
// Verdict semantics match applyDemotionVerify: true = keep plan, false = demote, null = hold.
export function makeDemotionLookup(deps: {
  demoteByNbr: Map<string, { s: any; p: any }>;
  readRoster: () => Promise<{ loads: any[] } | null>;
  readLoadStopNbrs: (loadNbr: string) => Promise<Set<string> | null>;
  readStopRecord: (nbr: string) => Promise<any>;
  verdictFromRecord: (rec: any) => boolean | null;
  loadReadBudget: number;
  stopReadBudget: number;
}): { lookup: (nbr: string) => Promise<boolean | null>; reads: () => { loadReads: number; stopReads: number } } {
  const normNbr = (v: any) => String(v ?? '').trim().toUpperCase().replace(/^0+(?=\d)/, '');
  let rosterNameToNbr: Map<string, string> | null = null;
  let rosterFailed = false;
  const rosterNbrFor = async (routeName: string): Promise<string | null> => {
    if (!rosterNameToNbr) {
      rosterNameToNbr = new Map();
      const ros = await deps.readRoster().catch(() => { rosterFailed = true; return null; });
      // AMBIGUOUS names never resolve (audit F3): two roster loads sharing a name meant
      // first-wins picked one arbitrarily and the OTHER load's freshly-saved stops read
      // "not a member" → actively demoted. Ambiguity falls through to the stop record.
      const counts = new Map<string, number>();
      for (const l of (ros?.loads || [])) {
        const nm = String(l?.name ?? l?.routeName ?? '').trim().toLowerCase();
        if (nm) counts.set(nm, (counts.get(nm) || 0) + 1);
      }
      for (const l of (ros?.loads || [])) {
        const nm = String(l?.name ?? l?.routeName ?? '').trim().toLowerCase();
        const nbr = String(l?.loadNbr ?? '').trim();
        if (nm && nbr && counts.get(nm) === 1) rosterNameToNbr.set(nm, nbr);
      }
    }
    return rosterNameToNbr.get(routeName.trim().toLowerCase()) ?? null;
  };
  const loadMembers = new Map<string, Set<string> | null>();
  let demoteLoadReads = 0, demoteStopReads = 0;
  const lookup = async (nbr: string): Promise<boolean | null> => {
    const chk = deps.demoteByNbr.get(String(nbr));
    const p = chk?.p;
    // Fresh TERMINAL rows never resurrect (audit F5): a CANCELLED/DELIVERED/EXCEPTION
    // list row stands even if the load still lists the stop — the membership path must
    // not lose the record verdict's finished-work rule.
    const stFresh = String(chk?.s?.normalizedStatus ?? '').toUpperCase();
    if (stFresh === 'DELIVERED' || stFresh === 'EXCEPTION' || stFresh === 'CANCELLED') return false;
    const routeName = String(p?.loadNbr ?? p?.routeName ?? '').trim();
    if (routeName) {
      const realNbr = await rosterNbrFor(routeName);
      if (rosterFailed) return null;   // roster unreadable this scan → hold, never guess (F9)
      if (realNbr) {
        if (!loadMembers.has(realNbr)) {
          if (demoteLoadReads >= deps.loadReadBudget) return null;   // over budget → hold
          demoteLoadReads++;
          loadMembers.set(realNbr, await deps.readLoadStopNbrs(realNbr));
        }
        const members = loadMembers.get(realNbr);
        // Only a POSITIVE membership short-circuits. "Not a member" falls through to
        // the stop record: the resolved load can be the WRONG same-named instance
        // (tomorrow's recurring build — audit F3b) and demoting on its word alone
        // un-plans a saved route. The record's verdict (404 holds, terminal drops)
        // decides within its own budget; over budget → held one tick.
        if (members && (members.has(String(nbr)) || members.has(normNbr(nbr)))) return true;
      }
    }
    if (demoteStopReads >= deps.stopReadBudget) return null;              // hold
    demoteStopReads++;
    // Verdict policy (404 holds, terminal statuses drop) lives in demotionLookupVerdict —
    // pure + unit-tested; this closure only supplies the metered read.
    const rec = await deps.readStopRecord(nbr);
    // Wrong-twin guard (the Estes-0828068215 lesson): the by-number record can be the OTHER
    // order sharing this number, and its status must not speak for the row on this board —
    // in either direction (a live twin keeping a truly-removed stop, a finished twin
    // dropping a live routed one). Identity disagreement → hold, re-check next scan.
    const recId = String(rec?.stop?.stopId ?? rec?.stopId ?? '').trim();
    const priorId = String(p?.stopId ?? '').trim();
    if (recId && priorId && recId !== priorId) return null;
    return deps.verdictFromRecord(rec);
  };
  return { lookup, reads: () => ({ loadReads: demoteLoadReads, stopReads: demoteStopReads }) };
}

// The next Mon–Fri date strictly after dateStr (skips Sat/Sun).
export function nextBusinessDayUTC(dateStr: string): string {
  let d = addDaysUTC(dateStr, 1);
  let dow = new Date(d + 'T00:00:00Z').getUTCDay();
  while (dow === 0 || dow === 6) { d = addDaysUTC(d, 1); dow = new Date(d + 'T00:00:00Z').getUTCDay(); }
  return d;
}

// Build the scan date list: today + the next (n-1) BUSINESS days. Exported for tests.
export function scanDatesFrom(today: string, n: number): string[] {
  const dates = [today];
  let cur = today;
  for (let i = 1; i < n; i++) { cur = nextBusinessDayUTC(cur); dates.push(cur); }
  return dates;
}

// Has a FUTURE date's load roster been GOOD-captured today (skip the re-pull)? A capture
// only counts when it was taken THIS ET day, is non-empty, AND at least one row carries a
// real load NUMBER. Tomorrow's load SET is fixed once it exists (per Chad — the shells are
// generated up front, the set doesn't change through the day), so ONE good capture per scan
// day is the whole job. The number check is the guard the once-a-day dedup was missing on
// Jul 1 2026: that morning's capture ran before the Load-Number column/parser fix (#336)
// landed, wrote 102 rows with ZERO numbers, and the "non-empty → done" dedup froze the
// number-less snapshot all day — so every evening reorder/unplan Save was refused ("needs
// a load number"). A number-less capture now reads as NOT captured and keeps re-pulling
// until the numbers come through (parser fixed / column present / NuVizz hiccup passed).
// Exported for tests.
export function futureRosterCaptured(cached: { at?: string; loads?: any[] } | null | undefined, now: Date): boolean {
  if (!cached?.at || (cached.loads?.length ?? 0) === 0) return false;
  const atD = new Date(cached.at);
  if (!Number.isFinite(atD.getTime())) return false;
  if (etDayString(atD) !== etDayString(now)) return false;      // a prior scan-day's capture never counts
  return (cached.loads || []).some((l: any) => l?.loadNbr);     // a number-less capture never counts
}

/**
 * PURE. May this scan PRUNE the planned board, or must it preserve what it did not see?
 *
 * The three reasons a load list is not authoritative, in one place and testable:
 *   • lean targets  — only a chosen subset of load numbers was probed
 *   • forward walk  — only numbers above the frontier were probed
 *   • unanswered probes — the vendor could not be reached for one or more loads
 *
 * The third is the one that was missing, and it is the dangerous one: the other two are
 * deliberate and obvious, while an unanswered probe used to be indistinguishable from an
 * empty answer. Any single unanswered probe makes the list non-authoritative — preserving a
 * few stale rows costs a scan cycle, pruning on a failed scan deletes the day's board.
 */
export function loadsArePartial(opts: {
  includeLoads: boolean;
  loadTargets?: unknown;
  forwardLoad?: unknown;
  loadsComplete?: boolean;
}): boolean {
  if (!opts.includeLoads) return false;          // loads untouched — nothing to prune against
  if (opts.loadTargets || opts.forwardLoad) return true;
  return opts.loadsComplete === false;
}

export async function runRefreshStops(req: Request): Promise<Response> {
  const startedAt = Date.now();
  const now = new Date();
  const url = new URL(req.url);
  const isManual = url.searchParams.get('manual') === '1';
  const dateParam = url.searchParams.get('date');
  const daysParam = url.searchParams.get('days');
  const explicit = !!(dateParam || daysParam); // ops/testing: full forced scan of given dates
  const trigger = isManual ? 'manual' : (explicit ? 'explicit' : 'schedule');
  // Attribute every NuVizz call this run makes (list pulls + enrichment) to the right
  // trigger on the shared counter, so a spike is traceable to the scheduled scanner vs
  // a manual scan vs on-demand. ('scheduled-scan' is the cron path; 'manual' a human scan.)
  setCallTrigger(isManual ? 'manual' : 'scheduled-scan');

  // Anchor the board day on the EASTERN calendar day, NOT the UTC day. They agree all day
  // and diverge only after ~8pm ET (UTC already rolled to tomorrow). The board doc is keyed by
  // this date AND the dispatcher's date picker selects an ET calendar day, so anchoring on UTC
  // made the Friday-evening run write FRIDAY's live board into the SATURDAY-keyed doc — and on a
  // weekend (no follow-up scan) that stale bleed sat on Saturday's board all weekend. ET-anchoring
  // files each day's board under its own ET date (the same fix attempts-core already uses).
  // today + tomorrow drive the number-probe fallback; the LIST path writes the full planning
  // horizon (today + next LIST_HORIZON_DAYS-1 business days) from its single ±7d pull.
  const scanDates = scanDatesFrom(etDayString(), LIST_HORIZON_DAYS);
  const [today, tomorrow] = scanDates;
  const fsOn = isFirestoreEnabled();
  let ceiling = Number(process.env.NUVIZZ_DAILY_CEILING) || 12000;
  // Phase 2 — lean load discovery (known-active + buffer + gap sweep). OFF by
  // default; flip NUVIZZ_LEAN_DISCOVERY=on only AFTER preview stop-set parity is
  // confirmed. Off = the proven wide-window probe, unchanged.
  const LEAN_DISCOVERY = (process.env.NUVIZZ_LEAN_DISCOVERY || '').toLowerCase() === 'on';
  // Adaptive forward discovery (default ON; set NUVIZZ_FORWARD_SCAN=off to revert
  // to the wide-window/lean behavior). Instead of a cold ~601-wide load window +
  // findCeiling order descent, seed from the persisted frontier (carried ACROSS
  // days on a cold/resumption day — e.g. Sunday after the weekend blackout) and
  // walk FORWARD in 25-chunks until nothing new turns up. Nothing changes below the
  // frontier over the weekend, so the Sunday resume is a cheap forward walk, not a
  // big sweep. Takes precedence over lean. The deep sweep (every
  // NUVIZZ_DEEP_SWEEP_HOURS, default 8) stays the periodic full-floor backstop that
  // reconciles below-frontier status changes / out-of-order imports.
  const FORWARD_SCAN = (process.env.NUVIZZ_FORWARD_SCAN || '').toLowerCase() !== 'off';
  // PRIMARY list discovery (NUVIZZ_LIST_DISCOVERY=on): source the board from NuVizz's
  // stop LIST in one windowed pull instead of number-probing /load/info & /stop/info.
  // Coordinates are carried forward from the existing index + geocoded for new
  // addresses. The number-probe below remains the automatic FALLBACK.
  // DEFAULT ON, tolerant parse. This flag used to be opt-IN via the exact string 'on',
  // so an unset/mistyped env value ('true', '1', a typo) silently dropped every scheduled
  // tick into the ~3,000-call number-probe engine — inverting the cost invariant that the
  // probe is reachable only via explicit manual triggers. The cheap list path is now the
  // default; the probe engine on a schedule requires an explicit 'off'.
  const LIST_DISCOVERY = !['off', '0', 'false', 'no'].includes((process.env.NUVIZZ_LIST_DISCOVERY || 'on').toLowerCase());
  // Two-saved-search source (see nuvizz-list SAVED_SEARCHES): one ACTIVE pull
  // (planned+unplanned) + one COMPLETED pull (delivered/unable-to-deliver, updated
  // today), merged and bucketed by date. OFF = the legacy per-day single query.
  const TWO_SCAN = (process.env.NUVIZZ_TWO_SCAN || '').toLowerCase() === 'on';
  // Enrichment: one /stop/info per NEW PRO (the list gives us exact PRO #s, so these
  // are direct calls). Enriched detail (real coords, line items, contact, schedule)
  // is carried forward via the index, so each PRO is enriched ONCE; as orders arrive
  // through the day each scan only enriches the increment, spreading the calls. ON by
  // default; cap is per-scan (default 10000 = no real throttle).
  const ENRICH = (process.env.NUVIZZ_ENRICH || '').toLowerCase() !== 'off';
  // Load-ID anchor (NUVIZZ_LOAD_ANCHOR=on; default OFF): pull the day's authoritative
  // load roster (PkgRoute list, unique per-day loadIds) and drop board stops carrying a
  // loadId that isn't in today's set — a prior-day instance of a recurring route that
  // bled in. Best-effort: a load-list failure is swallowed and the board is unchanged.
  const LOAD_ANCHOR = (process.env.NUVIZZ_LOAD_ANCHOR || '').toLowerCase() === 'on';
  const loadIdCache = new Map<string, Set<string>>();
  // Hard per-scan enrichment cap (backstop against a burst). 250 comfortably covers a
  // real day's incremental new orders (~700/day spread across many */15 scans) while
  // bounding the worst case if the registry is ever cold/unavailable — a cold board just
  // backfills over a few ticks instead of firing thousands of /stop/info at once. Was
  // 10000 (effectively unbounded), which let the registry cold-start spike to ~1,400.
  const ENRICH_MAX = Number(process.env.NUVIZZ_ENRICH_MAX_PER_SCAN) || 250;
  const ENRICH_CONC = Number(process.env.NUVIZZ_ENRICH_CONC) || 8;
  // Demotion verify (Jul 9 SEAAGRI): max planned→unplanned flips VERIFIED per scan via one
  // /stop/info each before the board is allowed to drop a stop off its route. 0 disables.
  // Trimmed, NaN-safe: an empty/garbage value keeps the default (Number('') is 0, which would
  // silently disable the SEAAGRI protection). 0 explicitly disables.
  const demoteRaw = String(process.env.NUVIZZ_DEMOTE_VERIFY_MAX ?? '').trim();
  const DEMOTE_VERIFY_MAX = demoteRaw !== '' && Number.isFinite(Number(demoteRaw)) ? Number(demoteRaw) : 8;
  // Load-corroboration budget: one memoized /load/info covers EVERY demote-check on that
  // load, so a whole just-saved route (16 flips) verifies in a single call.
  const demoteLoadRaw = String(process.env.NUVIZZ_DEMOTE_VERIFY_LOAD_MAX ?? '').trim();
  const DEMOTE_VERIFY_LOAD_MAX = demoteLoadRaw !== '' && Number.isFinite(Number(demoteLoadRaw)) ? Number(demoteLoadRaw) : 4;
  // How whole this scan's pull has to look before a PLANNED stop's ABSENCE from it is worth
  // asking NuVizz about (carry-forward, below). 0.5 = the pull returned at least half of what
  // the prior board held. Under that, "everything vanished" reads as a scan failure and every
  // plan carries forward unquestioned — the behaviour that predates the absent-check entirely.
  // Set 0 to question absences on any pull; set >1 to switch the absent-check off.
  const absentRatioRaw = String(process.env.NUVIZZ_ABSENT_DEMOTE_MIN_RATIO ?? '').trim();
  const ABSENT_DEMOTE_MIN_RATIO = absentRatioRaw !== '' && Number.isFinite(Number(absentRatioRaw)) ? Number(absentRatioRaw) : 0.5;

  // Read today's last LOAD scan time — this is what drives the elapsed-time
  // cadence (Fix 1). Also read the shared call counter + breaker for the log line.
  let lastLoadScanAt: string | null = null;
  let dayCount = 0;
  let byRoute: Record<string, number> = {};
  let breakerState = false;
  const mode = breakerMode();
  const refreshOps = async () => {
    try { const st = await readCallStats(today); dayCount = st.count; byRoute = st.byRoute; } catch { /* best effort */ }
    try { breakerState = (await readCircuit()).open; } catch { /* best effort */ }
  };
  if (fsOn) {
    try {
      const m = (await getDoc(`nuvizz_stop_index/${TENANT}__${today}`)) as any;
      lastLoadScanAt = m?.lastLoadScanAt ?? m?.last_scanned_at ?? null;
    } catch { /* treat as never-scanned */ }
    await refreshOps();
  }

  // Live-editable schedule (Diagnostics UI → nuvizz_ops/scan_config). Best-effort and
  // clamped to safe bounds: an empty/missing doc or a read failure = the proven
  // env/default behavior. Overlaid on defaults inside scanDecision/intervalForHour.
  let scanCfg: Record<string, any> = {};
  if (fsOn) { try { scanCfg = clampScanConfig(await readScanConfig()); } catch { scanCfg = {}; } }
  if (typeof scanCfg.dailyCeiling === 'number') ceiling = scanCfg.dailyCeiling;
  // Apply the configured spend cap to the per-call breaker for THIS invocation.
  setDailyCeilingOverride(typeof scanCfg.dailyCeiling === 'number' ? scanCfg.dailyCeiling : null);

  let decision = scanDecision(now, isManual, lastLoadScanAt, scanCfg);

  // ── THE SCAN PLAN — per saved search, per day, per hour ────────────────────
  //
  // Chad: "part of the day we need to scan more for completed, and part of the day we need to
  // scan more for unplanned and planned." The two searches answer different questions and
  // matter at opposite ends of the day, so they now run on their own clocks.
  //
  // A fire where only `completed` is due takes the OVERLAY path below — one call, and it can
  // only mark existing stops finished. It deliberately does NOT go through the board rebuild,
  // which reads absence as meaning and would see a completed-only pull as every planned stop
  // having vanished. A fire where `planned` is due runs the full scan exactly as before.
  //
  // An empty/missing rules doc falls back to the shipped plan; a manual scan ignores the plan
  // entirely and does the full thing, which is what a dispatcher pressing the button wants.
  const planRules = (() => {
    const stored = clampScanRules((scanCfg as any)?.rules);
    return stored.length ? stored : defaultScanRules();
  })();
  const kindStamps = fsOn ? await readScanKindStamps().catch(() => ({})) : {};
  const due = dueKinds(decision.weekday, decision.etHour, planRules, kindStamps, now.getTime());
  const plannedDue = isManual || due.planned.due;
  const completedDue = isManual || due.completed.due;
  const rosterDue = isManual || due.roster.due;

  // THE PLAN CAN OVERRULE THE LEGACY GATE. `decision` above comes from the single global
  // cadence this per-kind plan replaced (scanDecision/intervalForHour), measured against
  // lastLoadScanAt specifically. The completed-only overlay never touches that stamp, so
  // once a full scan resets it, decision.act stays false for the FULL legacy interval on
  // every 5-minute tick — and while it is false, this whole function returns before ever
  // asking whether completed (or roster) is independently due. Chad, at 10:45am on a
  // delivery day, watching Loads/Orders/Completed all read the identical "22 min ago":
  // "I thought at this time of day we were on 15 min scans." He was right to expect that
  // — done-run is 15 minutes — and this is why it was not happening. Only the 'cadence'
  // skip is overridable; weekend blackout and the hard floor are real safety gates and
  // stay in force. See overrideCadenceSkip in scan-plan.mts.
  decision = overrideCadenceSkip(decision, plannedDue, completedDue, rosterDue);

  // Fix 4 — exactly ONE structured line per invocation, so "why didn't it scan"
  // is answerable from the log. today/tomorrow report the DECISION's feed intent.
  // Now also carries today's NuVizz volume: total, per-route, breaker + mode.
  const fmtEl = (m: number) => (m === Infinity ? 'inf' : String(Math.round(m)));
  const fmtByRoute = (br: Record<string, number>) => {
    const parts = Object.entries(br).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`);
    return parts.length ? parts.join(',') : '-';
  };
  const no = { l: false, u: false };
  const logScan = (skip: string, act: boolean, t: { l: boolean; u: boolean }, m: { l: boolean; u: boolean }, extra = '') => {
    console.log(`[scan] trigger=${trigger} etHour=${decision.etHour} etMin=${decision.etMin} act=${act} today={loads:${t.l},unplanned:${t.u}} tomorrow={loads:${m.l},unplanned:${m.u}} lastLoadScanAt=${lastLoadScanAt || 'null'} elapsedMin=${fmtEl(decision.elapsedMin)} intervalMin=${decision.intervalMin} dayCount=${dayCount} ceiling=${ceiling} mode=${mode} breaker=${breakerState} byRoute=${fmtByRoute(byRoute)} skip=${skip}${extra}`);
  };

  const json = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  // Kill switch (Fix 5: record halted state for the UI banner). Honors BOTH the env
  // kill switch and the UI master toggle (scan_config.scansEnabled === false).
  if (!scansEnabled() || scanCfg.scansEnabled === false) {
    if (fsOn) { try { await markScanState(TENANT, today, { halted: true, reason: 'killswitch', since: now.toISOString() }); } catch { /* */ } }
    logScan('killswitch', false, no, no);
    return json({ ok: true, skipped: 'scans-disabled' });
  }

  if (!fsOn) {
    logScan('error', false, no, no, ' msg=FIREBASE_SA-not-set');
    return json({ ok: false, error: 'FIREBASE_SA not set' });
  }

  // Circuit breaker — daily ceiling reached (Fix 5: record halted state).
  if (await breakerTripped()) {
    try { await markScanState(TENANT, today, { halted: true, reason: 'ceiling', since: now.toISOString() }); } catch { /* */ }
    logScan('ceiling', false, no, no);
    return json({ ok: true, skipped: 'circuit-open' });
  }

  const results: any[] = [];

  // Capture a date's FULL load roster (incl. empty loads not yet filled with orders) into the
  // cache the Loads view reads. A FUTURE date's roster is captured ONCE per scan day — tomorrow's
  // load SET is fixed once it exists (per Chad), so there's nothing to re-pull all day. But the
  // capture only COUNTS when it actually carries load NUMBERS (futureRosterCaptured): the Jul 1
  // 2026 board froze because that morning's capture ran before the Load-Number parser fix (#336),
  // wrote rows with zero numbers, and the old "non-empty → done" dedup kept the number-less
  // snapshot all day (every evening reorder/unplan Save refused "needs a load number"). Empty OR
  // number-less → keep re-pulling each acting cycle until a numbered roster lands, then stop for
  // the day (steady state: 1 cheap PkgRoute list call/day; the manual Refresh button (?live=1)
  // remains the on-demand override). Today's roster refreshes each load-scan as before.
  // Best-effort: a hiccup is logged, never affects the scan.
  const persistLoadRoster = async (date: string, scannedAt: string) => {
    if (!fsOn) return;
    try {
      if (date !== today) {
        const cached = await readLoadRoster(TENANT, date).catch(() => null);
        if (futureRosterCaptured(cached, new Date())) return;
      }
      const roster = await loadRosterForDate(date);
      await writeLoadRoster(TENANT, date, roster, scannedAt);
      console.log(`[scan] load-roster ${date}: cached ${roster.length} load(s)${date !== today ? ' (next-day, once/day once numbered)' : ''}`);
    } catch (e: any) { console.warn(`[scan] load-roster ${date} skipped: ${e?.message}`); }
  };

  // Next-business-day empty-loads roster — captured once per scan day, re-tried each acting
  // cycle only until a NUMBERED roster lands (see persistLoadRoster; steady state 1 cheap
  // PkgRoute list call/day). DECOUPLED from the next-day LOAD *scan*, which is 8pm-gated to
  // avoid the expensive load-number probe — the roster is the cheap list endpoint, so
  // tomorrow's empty/Draft loads (and their real load NUMBERS, which Saves are keyed by) are
  // on the board all day. That is what lets the dispatcher build TOMORROW's routes TODAY.
  // Runs on any acting scan >=6am ET.
  if (decision.act && fsOn && decision.etHour >= 6 && rosterDue) {
    const rosterAt = new Date().toISOString();
    for (const d of scanDates.slice(1)) await persistLoadRoster(d, rosterAt);
    await markScanKinds(['roster'], rosterAt).catch(() => {});
  }

  // scanAndWrite — one date. includeUnplanned gates the order descent; `forced`
  // (manual/explicit) bypasses the per-date min-interval floor; manual caps the
  // unplanned descent lower so the synchronous endpoint finishes in time.
  const scanAndWrite = async (date: string, includeUnplanned: boolean, forced: boolean, includeLoads = true) => {
    const t0 = Date.now();
    try {
      if (!forced) {
        const metaDoc = await getDoc(`nuvizz_stop_index/${TENANT}__${date}`);
        if (metaDoc && !scanIntervalElapsed(metaDoc.last_scanned_at, Date.now())) {
          results.push({ date, ok: true, skipped: 'min-interval', ms: Date.now() - t0 });
          return;
        }
      }
      // Read this date's existing roster ONCE — used for BOTH Phase 2 lean planning
      // (as the current known-active set) and the Phase 1 shadow write below.
      const priorState = (includeLoads || FORWARD_SCAN) ? await readScanState(date, TENANT) : null;

      // Phase 2 (gated by NUVIZZ_LEAN_DISCOVERY=on): probe only known-active loads +
      // forward buffer + periodic gap sweep instead of the ±window. null plan ⇒
      // leave loadTargets undefined ⇒ scanDate falls back to the wide window.
      // R10: a MANUAL scan bypasses lean entirely (wide window + full unplanned
      // floor) so a human "refresh" is always the authoritative full re-scan.
      // FORWARD_SCAN takes precedence over lean (mutually exclusive load strategies).
      let loadTargets: number[] | null = null;
      if (!FORWARD_SCAN && LEAN_DISCOVERY && includeLoads && !isManual) {
        try {
          const plan = selectLoadProbeTargets(priorState, {
            inWindow: isInRoutingWindow(decision.etHour, scanCfg),
            scanCount: priorState?.scanCount || 0,
            fwdIn: 50, fwdOut: 10, gapSweepEvery: 3,
          });
          if (plan) {
            loadTargets = plan.numbers;
            console.log(`[scan-lean] date=${date} mode=${plan.mode} probe=${plan.numbers.length} active=${plan.activeLoads} buffer=${plan.forwardBuffer} gapSweep=${plan.gapSweep}`);
          } else {
            console.log(`[scan-lean] date=${date} mode=cold-fallback (no roster yet) → wide window`);
          }
        } catch (e: any) { console.warn(`[scan-lean] ${date} planning failed, wide window: ${e?.message}`); }
      }

      // Phase 1 (shadow): capture the load-number window THIS cycle is about to
      // probe BEFORE scanDate calibrates the in-memory cache (serverless runs are
      // almost always cold → this is the real ~600-wide window). Only meaningful
      // when NOT using lean targets.
      const preRange = (includeLoads && !loadTargets) ? estimateLoadRange(date) : null;
      // Phase 3 lean unplanned: only on a WARM cycle (we have a roster + high-water);
      // descend only NEW stop numbers above the last high-water. Cold cycles do the
      // full descent (establishes the high-water), same as the wide load fallback.
      const leanUnplanned = LEAN_DISCOVERY && includeUnplanned && !!loadTargets && (priorState?.highWaterUnplannedStopNbr != null);
      const DEEP_SWEEP_HOURS = scanCfg.deepSweepHours ?? (Number(process.env.NUVIZZ_DEEP_SWEEP_HOURS) || 8);
      const DEEP_SWEEP_CHUNKS = Number(process.env.NUVIZZ_DEEP_SWEEP_CHUNKS) || 25;

      // Adaptive forward seeds (NUVIZZ_FORWARD_SCAN). Loads: re-pull today's
      // known-active loads + walk forward from the max known load number. Orders:
      // walk forward from the unplanned high-water. Both seeds carry ACROSS days
      // when today has no roster yet (cold/resumption) so the Sunday post-blackout
      // fire is a cheap forward walk, NOT a cold wide rescan.
      let forwardLoad: { start: number; known?: number[] } | null = null;
      let forwardUnplanned: { start: number } | null = null;
      let resumption = false;
      if (FORWARD_SCAN && !isManual) {
        const carried = await readRecentFrontier(TENANT, date, 4)
          .catch(() => ({ maxLoadNbr: null, maxStopNbr: null, maxUnplannedStopNbr: null, carriedLoadNbrs: [] as number[] }));
        const todayCold = !(priorState && (priorState.knownLoads?.length || 0) > 0);
        resumption = todayCold && (carried.maxLoadNbr != null || carried.maxStopNbr != null || carried.maxUnplannedStopNbr != null);
        if (includeLoads) {
          const start = priorState?.maxLoadNbr ?? carried.maxLoadNbr ?? null;
          if (start != null) {
            const todayKnown = (priorState?.knownLoads || []).filter((k) => !k.allTerminal)
              .map((k) => loadNbrInt(k.loadNbr)).filter((n): n is number => n != null);
            // Also re-pull recent NON-TERMINAL loads from prior days — a carryover /
            // earlier-started route can still deliver stops today; forward-only would
            // miss it (it's below the frontier). probeLoad keeps just its today-stops.
            const known = [...new Set([...todayKnown, ...(carried.carriedLoadNbrs || [])])];
            forwardLoad = { start, known };
          }
        }
        if (includeUnplanned) {
          const ustart = priorState?.highWaterUnplannedStopNbr ?? carried.maxUnplannedStopNbr ?? carried.maxStopNbr ?? null;
          if (ustart != null) forwardUnplanned = { start: ustart };
        }
      }

      // DEEP SWEEP — periodic FULL-floor descent (relaxed early-stop) that catches
      // low advance-order stragglers / date-changed orders the frontier floor or the
      // forward walk skip. Runs in lean OR forward mode, never on a MANUAL run, and
      // never on the cold RESUMPTION fire (that one must stay cheap — and nothing
      // changed below the frontier over the weekend anyway; a due sweep runs on the
      // next warm cycle instead).
      // No-spike morning open: the deep sweep is the only FULL-floor descent (~2k
      // probes), and shouldDeepSweep() returns true on a cold day — so without a guard
      // the very FIRST unplanned cycle (the 10am open, when there are <~100 new orders)
      // would full-sweep and spike. deepSweepGate holds it back to a WARM cycle (today's
      // unplanned high-water already set by the cheap forward walk) at/after an off-peak
      // ET hour (NUVIZZ_DEEP_SWEEP_HOUR, default 13:00), so the open ramps up gently and
      // the one daily reconciliation lands in the afternoon lull.
      const DEEP_SWEEP_HOUR = scanCfg.deepSweepHour ?? (Number(process.env.NUVIZZ_DEEP_SWEEP_HOUR) || 13);
      const deepSweep = (LEAN_DISCOVERY || FORWARD_SCAN) && includeUnplanned && !isManual && !resumption
        && deepSweepGate({
          due: shouldDeepSweep(priorState?.lastDeepSweepAt, Date.now(), DEEP_SWEEP_HOURS * 3600_000),
          todayUnplannedWarm: priorState?.highWaterUnplannedStopNbr != null,
          etHour: decision.etHour,
          offPeakHour: DEEP_SWEEP_HOUR,
        });
      // A deep sweep is the authoritative full re-baseline → drop forward/lean and
      // probe the full load window + full unplanned floor.
      if (deepSweep) { forwardLoad = null; forwardUnplanned = null; loadTargets = null; }

      const unplannedOpts: any = {};
      if (isManual && includeUnplanned) unplannedOpts.maxProbes = 800;
      // Lean frontier floor (bounded on the UNPLANNED high-water) — but NOT on a
      // deep sweep, which must descend the full floor.
      if (leanUnplanned && !deepSweep) unplannedOpts.sinceStopNbr = priorState!.highWaterUnplannedStopNbr;
      if (deepSweep) unplannedOpts.postTargetChunks = DEEP_SWEEP_CHUNKS;
      const scan = await scanDate(date, {
        includeUnplanned,
        includeLoads,
        loadTargets,
        forwardLoad,
        forwardUnplanned,
        unplanned: Object.keys(unplannedOpts).length ? unplannedOpts : undefined,
      });
      // partial* : in lean mode we re-pulled only a SUBSET of each feed — tell
      // writeStops to PRESERVE the stops it didn't re-scan (terminal loads /
      // older still-unplanned orders) so lean never prunes already-known stops.
      // R1: tell writeStops which load NUMBERS we actually re-pulled this lean cycle
      // so it can prune a stop removed from a re-scanned load (vs preserving stops on
      // loads we didn't touch). Only meaningful in lean mode (loadTargets set).
      // partialUnplanned = PRESERVE un-rescanned unplanned (don't prune). True when:
      //  • a lean frontier cycle (we only scanned above the high-water), OR
      //  • the descent was TRUNCATED (cap/budget/breaker) — it didn't reach the
      //    floor, so anything below the truncation point that we DIDN'T see must be
      //    preserved, never pruned (else a truncated full/deep descent would delete
      //    still-valid low unplanned orders). Only a COMPLETE full descent prunes.
      const truncatedDescent = includeUnplanned && scan.descentComplete === false;
      // Forward + lean both re-pulled only a SUBSET → PRESERVE un-rescanned stops
      // (never prune). Only a COMPLETE full descent / deep sweep prunes.
      const partialUnplanned = (leanUnplanned && !deepSweep) || !!forwardUnplanned || truncatedDescent;
      // A LOAD LIST WE COULD NOT FULLY FETCH IS NOT A LOAD LIST WE MAY PRUNE AGAINST.
      //
      // probeLoad used to fold auth/5xx/network failures into the same null it returns for
      // "no such load", so a full scan whose every call failed produced an EMPTY load list
      // that was indistinguishable from a day with no loads — and a full scan (no targets,
      // no forward walk) prunes against exactly that. The result was an authoritative empty
      // planned board, written over a real one, reported as ok:true.
      //
      // The asymmetry decides the threshold, and it is not close. Preserving stops we could
      // not re-verify leaves a few stale rows until the next clean scan. Pruning on a failed
      // scan deletes the day: the dispatchers' board, the flags, the ETAs and the 6:30
      // completion report all go to zero at once, and nothing in the system says why. So ANY
      // unanswered probe makes this scan non-authoritative for loads.
      const loadsUntrustworthy = includeLoads && scan.loadsComplete === false;
      if (loadsUntrustworthy) {
        console.error(`[refresh] date=${date} ${scan.loadProbeFailures} load probe(s) unanswered — treating loads as PARTIAL (preserve, do not prune)`);
      }
      const partialLoads = loadsArePartial({ includeLoads, loadTargets, forwardLoad, loadsComplete: scan.loadsComplete });
      const meta = await writeStops(TENANT, date, scan.stops, scan.scannedAt, { includeUnplanned, includeLoads, partialLoads, partialUnplanned, rescannedLoads: loadTargets || undefined, graceFn: (fresh, ex) => { applyBoardWriteGrace(fresh, ex, Date.now()); } });
      // Only rebuild the fleet (load) index when we actually scanned loads — an
      // unplanned-only run would otherwise wipe the load index with an empty scan.
      // Same reasoning as the prune guard above: the fleet index is REBUILT from this scan,
      // so rebuilding it from a scan that could not reach the vendor replaces the day's load
      // cards with whatever little came back. Skip the rebuild instead — a slightly stale
      // fleet index is recoverable; an emptied one is the same silent hole in a second place.
      if (includeLoads && !loadsUntrustworthy) {
        const fleet = deriveFleetSummary(scan.stops, scan.loadHeaders);
        await writeFleetIndex(TENANT, date, fleet.loads, fleet.summary, fleet.driverIndex, scan.scannedAt);
        // Cache the date's empty-loads roster too (once/day for a future date).
        // THE ROSTER ON ITS OWN CLOCK. It used to be pulled on every acting fire — ~33 calls a
        // day for a list that only changes when somebody creates a load. Hourly is plenty, and
        // that reclaim pays for most of the extra completed sampling.
        if (rosterDue) await persistLoadRoster(date, scan.scannedAt);
      }
      // Phase 1 (shadow mode): persist scan_state + log what lean discovery WOULD
      // probe (known-active loads + buffer) vs the wide window we ACTUALLY probed.
      // NO probing change yet — this de-risks Phase 2. Best-effort; never fails a scan.
      if (includeLoads) {
        try {
          const state = buildScanState(date, scan.stops, priorState, scan.scannedAt, {
            descentComplete: scan.descentComplete,
            observedFrontierStopNbr: scan.observedFrontierStopNbr,
            // Stamp the deep-sweep time whenever a sweep RAN (not gated on
            // completeness): a truncated sweep still covered most of the band, and
            // gating on completeness would loop every cycle into a deep sweep if it
            // kept truncating — a cost blowup. Persistent truncation shows as
            // descentComplete=false in the logs (a tuning signal), not a loop.
            deepSweepRan: deepSweep,
          });
          await writeScanState(date, state, TENANT);
          const inWindow = isInRoutingWindow(decision.etHour, scanCfg);
          const wp = shadowWouldProbe(state, { inWindow, fwdIn: 50, fwdOut: 10 });
          const windowSize = preRange ? (preRange.endNbr - preRange.startNbr + 1) : (loadTargets ? loadTargets.length : null);
          console.log(`[scan-shadow] date=${date} lean=${!!loadTargets} knownLoads=${state.knownLoads.length} active=${wp.activeLoads} terminal=${wp.terminalLoads} routes=${Object.keys(state.routeMap).length} minLoad=${state.minLoadNbr} maxLoad=${state.maxLoadNbr} highWaterStop=${state.highWaterStopNbr} inWindow=${inWindow} WOULD_PROBE_LOADS=${wp.wouldProbe} (active=${wp.activeLoads}+buffer=${wp.forwardBuffer}) PROBED=${windowSize} scanCount=${state.scanCount}`);

          // ── Step 1 parity (SHADOW; logging only — lean/frontier remain OFF) ──
          // Set-membership comparison: what lean WOULD have probed from the PRIOR
          // roster vs what the wide scan actually found. This is the real
          // "would lean miss something?" gate. Self-contained try/catch so a
          // parity bug can never affect the scan or the state write above.
          try {
            const foundLoads = [...new Set(
              scan.stops.filter((s: any) => s.isPlanned && s.loadNbr)
                .map((s: any) => loadNbrInt(s.loadNbr)).filter((n: any): n is number => n != null),
            )];
            const leanPlan = selectLoadProbeTargets(priorState, {
              inWindow, scanCount: priorState?.scanCount || 0, fwdIn: 50, fwdOut: 10, gapSweepEvery: 3,
            });
            const lp = loadProbeParity(leanPlan ? leanPlan.numbers : null, foundLoads);

            const foundUnplanned = scan.includeUnplanned
              ? [...new Set(scan.stops.filter((s: any) => s.isPlanned === false)
                  .map((s: any) => stopNbrInt(s.stopNbr)).filter((n: any): n is number => n != null))]
              : [];
            const hwu = priorState?.highWaterUnplannedStopNbr ?? null;
            const floor = (scan.includeUnplanned && hwu != null)
              ? unplannedFloor(estimateStopFrontier(date) - FLOOR_MARGIN, hwu) : null;
            const fp = frontierParity(floor, foundUnplanned, priorState?.unplannedStopNbrs);

            const mem = loadMembershipDelta(priorState?.loadMembers, groupLoadMembers(scan.stops));
            const dmax = (state.maxLoadNbr != null && priorState?.maxLoadNbr != null)
              ? state.maxLoadNbr - priorState.maxLoadNbr : null;
            const dateAudit = scan.includeUnplanned
              ? dateSliceMismatch(scan.stops.filter((s: any) => s.isPlanned === false).map((s: any) => s.scheduledFrom), date)
              : { mismatch: 0, unauditable: 0 };

            console.log(`[scan-parity] date=${date} loadMode=${lp.mode} foundLoads=${lp.foundCount} leanTargets=${lp.targetCount} MISSED_LOADS=${JSON.stringify(lp.missed)} emptyProbed=${lp.extra.length} | frontierFloor=${fp.floor ?? 'na'} foundUnplanned=${fp.foundCount} BELOW_FLOOR_NEW=${JSON.stringify(fp.belowFloorNew)} belowFloorKnown=${fp.belowFloorKnown.length} | LOAD_REMOVED=${mem.removed.length} LOAD_ADDED=${mem.added.length} | dMaxLoad=${dmax ?? 'na'} dateSliceMismatch=${dateAudit.mismatch} dateUnauditable=${dateAudit.unauditable} descentComplete=${scan.descentComplete ?? 'na'} deepSweep=${deepSweep}`);
            // Learning instrumentation: record this scan's real load delta + worst
            // gap so we can size the adaptive forward-walk from evidence. Today only
            // (the date the dispatcher actually works); best-effort.
            if (date === today) {
              await recordScanMetric({
                date, at: etDayString() + ' ' + new Date().toISOString().slice(11, 16),
                foundLoads: lp.foundCount,
                newLoads: dmax,
                maxGap: maxConsecutiveGap(foundLoads),
                windowProbed: windowSize,
                lean: !!loadTargets,
                missed: lp.missed.length,
              });
            }
            if (lp.missed.length) console.warn(`[scan-parity] date=${date} ⚠ LEAN WOULD MISS LOADS ${JSON.stringify(lp.missed)}`);
            if (fp.belowFloorNew.length) console.warn(`[scan-parity] date=${date} ⚠ FRONTIER WOULD MISS NEW UNPLANNED ${JSON.stringify(fp.belowFloorNew.slice(0, 20))}${fp.belowFloorNew.length > 20 ? ' …' : ''}`);
            if (mem.removed.length) console.log(`[scan-parity] date=${date} off-load removals=${JSON.stringify(mem.removed.slice(0, 20))}`);
          } catch (e: any) { console.warn(`[scan-parity] ${date} failed: ${e?.message}`); }
        } catch (e: any) { console.warn(`[scan-shadow] ${date} failed: ${e?.message}`); }
      }
      // CS notify — email customer service the first time a "notify_cs"-flagged
      // customer appears on this date's board (deduped per delivery date). Fully
      // best-effort; a mail failure never affects the scan.
      try {
        const n = await notifyMarkedCustomers(date, scan.stops);
        if (n.matched) console.log(`[cs-notify] date=${date} matched=${n.matched} sent=${n.sent} failed=${n.failed}${n.skipped ? ` skipped=${n.skipped}` : ''}`);
      } catch (e: any) { console.warn(`[cs-notify] ${date} failed: ${e?.message}`); }
      results.push({ date, ok: true, ms: Date.now() - t0, includeUnplanned, includeLoads, count: meta.count, planned: meta.plannedCount, unplanned: meta.unplannedCount });
    } catch (e: any) {
      results.push({ date, ok: false, ms: Date.now() - t0, error: e?.message });
    }
  };

  // Ops/testing path: ?date=… or ?days=N → full scan (loads + unplanned), forced.
  if (explicit) {
    let dates: string[];
    if (dateParam) dates = [dateParam];
    else { const n = Math.max(1, Math.min(31, parseInt(daysParam || '', 10) || DEFAULT_DAYS)); dates = scanDatesFrom(etDayString(), n); }
    for (const date of dates) await scanAndWrite(date, true, true);
    await refreshOps();
    logScan('none', true, { l: true, u: true }, { l: true, u: true });
    return json({ ok: true, tenant: TENANT, mode: 'explicit', totalMs: Date.now() - startedAt, dates: results });
  }

  // Cadence gate (Fix 1: elapsed-time, not wall-clock minute).
  if (!decision.act) {
    logScan(decision.skip, false, no, no);
    return json({ ok: true, skipped: decision.skip, reason: decision.reason });
  }

  // ── PRIMARY: list-discovery, EXCLUSIVE (no number-probe) ─────────────────────
  // When on, the board is sourced ONLY from NuVizz's stop list (one pull/day), with
  // geocoded/carried-forward coords. The old number-probe NEVER runs here. Safety:
  // an empty/failed pull writes nothing for that date, so the last-good board is
  // preserved (stale, never blank) — per Chad's call we'd just fix-forward if the
  // list endpoint ever changes, rather than fall back to the expensive probe.
  // ── COMPLETED-ONLY FIRE: the overlay ──────────────────────────────────────
  //
  // The plan wants 77131 far more often than 77128 through the delivery day, so most fires in
  // that window land here: ONE NuVizz call, applied to the stored board as a status overlay.
  // It can mark an existing stop finished and nothing else — never creates, never removes,
  // never touches a route, sequence, driver or plan flag. See lib/scan-completions.mts for
  // why this is a separate path rather than a flag on the rebuild.
  if (decision.act && LIST_DISCOVERY && fsOn && !plannedDue && completedDue) {
    const at = new Date().toISOString();
    try {
      const rows = await completedScanRows();
      const prev = await readStops(TENANT, today).catch(() => ({ stops: [] as any[] }));
      const boardByNbr = new Map<string, any>();
      for (const pr of (prev?.stops || [])) boardByNbr.set(String(pr.stopNbr), pr);
      const plan = planCompletions(boardByNbr, rows);
      const applied = await applyCompletionPatches(TENANT, today, plan.patches, at);
      await markScanKinds(['completed'], at);
      // Stamp the DAY INDEX too, not just the ops doc. markScanKinds drives the scheduler's
      // own "is this kind due" arithmetic; the day index is what the board API serves and the
      // status card reads. Only the latter answers Chad's question — "at this time of day
      // shouldn't the completed scan be on a 15 min timer?" — which was unanswerable from the
      // screen because the card had no completed row to look at.
      const stamped = await markCompletedScan(TENANT, today, at);
      console.log(`[scan] completed-overlay ${today}: pulled=${rows.length} changed=${applied.written} unchanged=${plan.unchanged} notOnBoard=${plan.unknown.length} missingDoc=${applied.missing} etHour=${decision.etHour} interval=${due.completed.intervalMin}`);
      return json({
        ok: true, mode: 'completed-overlay', date: today, at,
        pulled: rows.length, changed: applied.written, unchanged: plan.unchanged,
        notOnBoard: plan.unknown.length, nuvizzCalls: 1, stamped,
      });
    } catch (e: any) {
      // A failed overlay leaves the board exactly as it was and costs nothing but the call —
      // the next fire retries. It must NEVER fall through into the full rebuild, which would
      // turn a cheap tick into three calls plus enrichment.
      console.warn(`[scan] completed-overlay ${today} failed: ${e?.message}`);
      return json({ ok: false, mode: 'completed-overlay', error: String(e?.message || e).slice(0, 200) });
    }
  }

  // Nothing due at all this tick — the plan covers this hour but no kind has aged out yet.
  if (decision.act && LIST_DISCOVERY && fsOn && !plannedDue && !completedDue && !rosterDue) {
    logScan('plan-not-due', false, no, no, ` plan={planned:${due.planned.reason},completed:${due.completed.reason},roster:${due.roster.reason}}`);
    return json({ ok: true, skipped: 'plan-not-due' });
  }

  if (LIST_DISCOVERY) {
    try {
      const scannedAt = new Date().toISOString();
      // THE STAMP GOES AFTER THE PULL, NOT BEFORE IT. This ran here, ahead of every NuVizz
      // call in the path — so a 5xx or a throttle recorded a scan that never happened, and
      // dueKinds then held the next attempt off for a FULL interval while the board sat
      // stale. The failure is silent by construction: the outer catch preserves the
      // last-good board, the run reports itself as handled, and the only symptom is a board
      // that quietly stops moving. Stamping a scan is a claim about what the vendor
      // ANSWERED, and this system does not get to report an intent as an outcome.
      //
      // It also claimed `completed` unconditionally. With TWO_SCAN off there is no completed
      // saved-search pull in this path at all — the day-index stamp 450 lines below already
      // refuses to claim one (`includeCompleted: TWO_SCAN`), so the two stamps disagreed
      // about the same run, and the ops doc was the one lying. Stamped once per run, by the
      // first pull that actually came back with rows.
      let kindsStamped = false;
      const stampScanKinds = async () => {
        if (kindsStamped) return;
        kindsStamped = true;
        await markScanKinds(TWO_SCAN ? ['planned', 'completed'] : ['planned'], scannedAt).catch(() => {});
      };
      const targets = [today];
      // Tomorrow + further planning days (LIST_HORIZON_DAYS) — all sliced from the SAME ±7d pull,
      // so e.g. Sunday writes Mon AND Tue. Gated by the same decision so far-day work only runs
      // once the next-day window opens (loads/orders exist by then).
      if (decision.scanTomorrowLoads || decision.scanTomorrowUnplanned) {
        for (const d of scanDates.slice(1)) targets.push(d);
      }
      // Two-scan mode pulls both saved searches ONCE up front (not per target day) and
      // buckets by date; a fetch failure throws → outer catch preserves the last-good board.
      // Dispatcher-set board dates (setStopDate — "the customer doesn't want it until the
      // 30th"). ONE Firestore read for the whole set, zero NuVizz calls. They must reach BOTH
      // the bucketing below AND the carry-forward guard further down: boardDayFor is the single
      // authority for a stop's day, and a stop filed one way but carried another is exactly the
      // snowball that once bled a whole board onto the wrong day.
      const boardDateOverrides = await readBoardDateOverrides(TENANT);
      const overrideCount = Object.keys(boardDateOverrides).length;
      if (overrideCount) console.log(`[scan] honoring ${overrideCount} dispatcher-set board date(s)`);
      const buckets = TWO_SCAN ? await twoScanBuckets(boardDateOverrides) : null;
      // Both saved searches answered. THIS is the moment a scan happened.
      if (TWO_SCAN) await stampScanKinds();

      // ── CS NOTIFY, FIRST THING, ACROSS THE WHOLE PULL (Chad, 8/10) ───────────────
      // "DSV came in on Friday. The moment the scan picked it up on Friday, it should
      // have sent the email. Why is it sending the email today? It's too late."
      //
      // The notify below (inside the write loop) only ever ran for the days this scan
      // WRITES: today, plus the next 1-2 business days and only from 10:00 ET, because
      // scanDecision gates every future day behind scanTomorrow*. So the trigger was
      // never "a scan saw this order" — it was "this order's DELIVERY DATE finally came
      // inside the write horizon". An order for a day past that horizon sat in every
      // pull and was reported by none of them, then went out on the first post-10:00
      // tick of the day its date came into range. That is the 10:16 email.
      //
      // The rows are already here, in `buckets` — the ±7d saved-search pull, filed by
      // day, of which the loop below reads two or three days and drops the rest. So this
      // costs ZERO extra NuVizz calls: same data, plus one Firestore ledger read per day
      // that actually matches a marked customer.
      //
      // It runs HERE, before enrichment and the board writes, because those take the
      // best part of a minute (up to ENRICH_MAX /stop/info at concurrency 8, geocoding,
      // then the writes) and none of it is needed to say "this customer is on Tuesday".
      //
      // Emails off the raw list row, which carries the whole match key
      // (businessName/addr1/city/zip) plus PRO, route and driver via toBoardStop. Two
      // known limits, both fail-safe and both documented rather than papered over:
      //   · If enrichment later rewrites the address into a different match key, this
      //     pass MISSES that customer and the write-day pass catches them exactly as it
      //     does today — late, but never wrong.
      //   · If it matches, the ledger records every stop number behind the key, so the
      //     enriched sighting on the write day is recognised and CS is not told twice.
      if (TWO_SCAN && buckets) {
        try {
          for (const date of pendingNotifyDates(buckets.keys(), today, targets)) {
            // Terminal rows ride the same pull (the COMPLETED saved search folds in), and
            // "Marked customer scheduled for delivery" is a lie about an order that has
            // already delivered or been cancelled. The write-day pass has the same
            // exposure; on a FUTURE day it is far likelier to be the only thing there.
            const rows = (buckets.get(date) || []).filter((s: any) => !isTerminalStatus(s?.normalizedStatus));
            if (!rows.length) continue;
            const n = await notifyMarkedCustomers(date, rows, { statusWhenIdle: false });
            if (n.matched) console.log(`[cs-notify] EARLY date=${date} matched=${n.matched} sent=${n.sent} failed=${n.failed}${n.skipped ? ` skipped=${n.skipped}` : ''}`);
          }
        } catch (e: any) { console.warn(`[cs-notify] early pass failed: ${e?.message}`); }
      } else {
        // The pull is per-day in legacy mode, so there is no ±7d bucket map to sweep and
        // the email is back to waiting on the write horizon. Say so on every scan rather
        // than being quietly inert — if a CS email is still late, this line is the answer.
        console.warn('[cs-notify] early pass INERT (NUVIZZ_TWO_SCAN is not on) — CS email still waits for the write horizon');
      }
      // Snapshot the CURRENT live unplanned stop-number set (across the whole ±7d pull) so the
      // read-time carry-over fold-in can drop prior-day stops that have since been delivered/
      // planned (they vanish from the active search → not in this set). Zero extra calls. The
      // window the active search reaches back is ~7 days (NUVIZZ_ACTIVE_ARRIVAL '+/-7d'), so
      // carry-over only trusts the filter for days >= windowStart. Best-effort.
      if (TWO_SCAN && buckets) {
        try {
          const live = new Set<string>();
          for (const stops of buckets.values()) for (const s of stops) if (s.isUnplanned && s.stopNbr) live.add(String(s.stopNbr));
          const windowStart = addDaysUTC(today, -7);
          await writeActiveUnplannedSet(TENANT, { at: scannedAt, windowStart, stopNbrs: [...live] });
        } catch (e: any) { console.warn(`[scan] active-set snapshot skipped: ${e?.message}`); }
      }
      // FINISHED rows across the WHOLE pull, keyed by stopNbr regardless of bucket day. A stop
      // delivered while running as rolled-over work buckets under its (stale) past arrival day —
      // which is never a write target — while today's board (where the clamp had filed the OPEN
      // stop) would re-carry the stale open snapshot forever. The carry-forward below consults
      // this map so the terminal state lands on the board that was actually showing the stop.
      const finishedByNbr = new Map<string, any>();
      if (TWO_SCAN && buckets) {
        for (const stops of buckets.values()) for (const s of stops) {
          if (s.stopNbr && (s.normalizedStatus === 'DELIVERED' || s.normalizedStatus === 'EXCEPTION')) finishedByNbr.set(String(s.stopNbr), s);
        }
      }
      // History-terminal cross-check, memoized across all target dates this scan. Window =
      // yesterday back N days from the scan's ET today (the history warehouse seals ET-
      // yesterday nightly, so a 1–2-day-old delivery is present). Bounded read cap is a
      // backstop; a capped miss just HOLDS (re-carries) rather than false-dropping.
      const HISTORY_TERMINAL_LOOKBACK = Math.max(1, Math.min(7, Number(process.env.NUVIZZ_HISTORY_TERMINAL_LOOKBACK) || 4));
      const HISTORY_TERMINAL_READ_CAP = Math.max(0, Number(process.env.NUVIZZ_HISTORY_TERMINAL_READ_CAP) || 400);
      const histTerminal = makeHistoryTerminalLookup({
        readStop: (d, nbr) => getStop(TENANT, d, nbr),
        dates: historyLookbackDates(today, HISTORY_TERMINAL_LOOKBACK),
        isTerminal: isTerminalHistoryStatus,
        readCap: HISTORY_TERMINAL_READ_CAP,
      });
      for (const date of targets) {
        // Two-scan: this day's slice of the merged active+completed pull (board keys are
        // UTC, the saved searches bucket by ET arrival date — map across the frames).
        // Legacy: per-day pull, ET-adjusted period (one request; entity page doesn't paginate).
        let dateStops = TWO_SCAN
          ? (buckets!.get(etDateForTargetUTC(date, today)) || []).map((s) => { s.scheduledDate = date; return s; })
          : await listScanForDate(date);
        // Legacy path: the pull is per-day, so the first one to come back is the proof.
        if (!TWO_SCAN) await stampScanKinds();
        if (!dateStops.length) { results.push({ date, ok: true, skipped: 'list-empty', source: 'list' }); continue; }

        // This day's prior index — carries same-day enriched detail forward + seeds coords.
        // Cross-day "already enriched" memory lives in the per-PRO registry (below), not here.
        // "NO PRIOR INDEX" AND "COULD NOT READ THE PRIOR INDEX" ARE NOT THE SAME DAY.
        //
        // This catch made them identical, and everything downstream is built on prevByNbr:
        // an empty map makes `pullHealthy` vacuously TRUE (it short-circuits on size === 0),
        // the carry-forward loop iterates nothing, and the write below runs with neither
        // partialLoads nor partialUnplanned — a FULL PRUNE. So one unreadable read deletes
        // every stop on the board that this pull happens not to mention: mid-flight stops
        // between status flips, rolled freight, anything the two saved searches miss. The
        // run then returns ok:true, because nothing threw.
        //
        // Same asymmetry as the load-probe guard: skipping a cycle costs ten minutes of
        // staleness, and pruning against a failed read costs the day's board with nothing
        // saying why. A genuinely new day still reads as an empty map and proceeds — that
        // path is untouched.
        const prevByNbr = new Map<string, any>();
        let priorUnreadable = false;
        try {
          const prev = await readStops(TENANT, date);
          for (const p of (prev?.stops || [])) prevByNbr.set(String(p.stopNbr), p);
        } catch (e: any) {
          priorUnreadable = true;
          console.error(`[scan] ${date}: prior index UNREADABLE (${e?.message}) — skipping this date's write rather than pruning against it`);
        }
        if (priorUnreadable) {
          results.push({ date, ok: false, skipped: 'prior-index-unreadable', source: 'list' });
          continue;
        }

        // Two-scan carry-forward: the two saved searches only cover open (20,10) and
        // finished (90,91,80) stops, so a stop mid-flight (in-transit/arrived) momentarily
        // matches NEITHER. Re-add any stop already on this day's board that's absent from
        // this scan, keeping its last-known state, so the live board never loses a stop
        // between status flips. (Firestore holds prior days; this protects the current one.)
        //
        // BOARD-DAY GUARD: only carry a stop forward if it actually belongs to THIS board's
        // day (boardDayFor === this board's ET date). Without it, the carry-forward re-added
        // EVERY stop from a board's prior index regardless of day, so once a stop landed on
        // the wrong day it was re-added every scan forever — that snowball was filing all of
        // today's ~700 deliveries onto tomorrow's board (and triggering their re-enrichment).
        // Wrong-day stays out of dateStops → the full writeStops below prunes it, self-healing
        // an already-polluted index on the next scan.
        const boardEtDate = TWO_SCAN ? etDateForTargetUTC(date, today) : date;
        if (TWO_SCAN) {
          const have = new Set(dateStops.map((s) => String(s.stopNbr)));
          // Absence only MEANS anything when the pull itself came back whole. A thin pull (a
          // vendor hiccup, a half-returned saved search) makes EVERY stop look absent, and
          // "everything vanished" is a scan failure, not a hundred unplannings. Below the
          // ratio, plans carry forward untouched and unquestioned exactly as they always have.
          const pullHealthy = prevByNbr.size === 0 || dateStops.length >= prevByNbr.size * ABSENT_DEMOTE_MIN_RATIO;
          let dropped = 0, healedDelivered = 0, absentPlanned = 0;
          for (const [nbr, p] of prevByNbr) {
            if (have.has(nbr)) continue;
            if (boardDayFor(p, undefined, boardDateOverrides) !== boardEtDate) { dropped++; continue; } // belongs to another day
            // The stop lived on THIS board while open, and the pull now shows it FINISHED under a
            // stale past arrival day (rolled-over work delivered today). File the finished row HERE
            // — pinned to this board's day so it stays — instead of re-carrying the open snapshot,
            // which froze such stops as open forever and lost the delivery entirely.
            const fin = finishedByNbr.get(nbr);
            if (fin) { dateStops.push({ ...fin, boardDate: boardEtDate, scheduledDate: date }); continue; }
            // Would re-carry the stale OPEN snapshot (absent from BOTH pulls, this-pull finished
            // map missed it). If it's still shown OPEN but our sealed history warehouse recorded it
            // DELIVERED/EXCEPTION on a recent prior day, it's a delivery that aged out of the
            // "updated today" completed window — drop it instead of freezing it Scheduled forever
            // (the ULINE APPT case). Only NON-terminal rows are checked; a genuinely-open order
            // NuVizz still returns is in `have` and never reaches here, so this can't hide live work.
            if (!isTerminalHistoryStatus(p)) {
              const histFin = await histTerminal.lookup(nbr);
              if (histFin) { healedDelivered++; continue; }
            }
            // A PLANNED stop that vanished from the pull: carry it forward as a demote
            // CANDIDATE rather than as an unquestionable fact. This is the ONLY way a stop
            // unplanned in the portal can ever be corrected — unplanning removes it from the
            // planned saved search, so the list never returns it again, and the verify below
            // only ever saw rows the list DID return. It rode this line back onto its load on
            // every scan instead (KAI WONG / SUW 5). Nothing is demoted on absence: the
            // candidate goes through the same load-membership-then-stop-record verify as any
            // list disagreement, and only NuVizz's own "that load does not hold it" drops the
            // plan. Over budget, a failed read, or a recent confirmed Save all keep it planned.
            // TERMINAL rows are excluded outright. A delivered stop is routinely absent from a
            // later pull, its load legitimately stops holding it, and demotionLookupVerdict
            // answers `false` for a terminal record — so a delivered stop that became a
            // candidate would be "demoted" into an UNPLANNED row and the delivery would vanish
            // off the board. Absence is a question about the PLAN, never about the outcome.
            if (pullHealthy && p.isPlanned === true && p.loadNbr && !isTerminalHistoryStatus(p)) {
              dateStops.push(absentPlanDemoteCandidate(p));
              absentPlanned++;
              continue;
            }
            dateStops.push(p);
          }
          if (dropped) console.log(`[scan] ${date}: carry-forward dropped ${dropped} wrong-day stop(s) (board=${boardEtDate})`);
          if (healedDelivered) console.log(`[scan] ${date}: dropped ${healedDelivered} stale-Scheduled stop(s) sealed DELIVERED in recent history (histReads=${histTerminal.reads()})`);
          if (absentPlanned) console.warn(`[scan] ${date}: ${absentPlanned} planned stop(s) absent from this pull — queued for demote verify (plan held unless NuVizz says the load dropped them)`);
          if (!pullHealthy) console.warn(`[scan] ${date}: pull looks thin (${dateStops.length} rows vs ${prevByNbr.size} on the prior board) — carrying plans forward UNVERIFIED; absence is being read as a scan failure, not as unplanning`);
        }
        const seed = new Map<string, { lat: number; lng: number }>();
        const toEnrich: any[] = [];
        const demoteChecks: Array<{ s: any; p: any }> = [];
        let reconsigned = 0;
        const reconsignedNbrs = new Set<string>();
        // Stops whose CACHED enriched record must not be merged, for a reason other than a
        // reconsignment — today only the pickup address repair below. Kept separate from
        // reconsignedNbrs so the "N reconsigned stop(s)" line keeps meaning what it says.
        const staleCacheNbrs = new Set<string>();
        let healedPickups = 0;
        for (const s of dateStops) {
          const p = prevByNbr.get(String(s.stopNbr));
          const listSig = addrListSig(s);   // this scan's LIST address signature (same source every scan)
          if (p) {
            // Reconsignment: the LIST address changed vs the last list signature we stored for this
            // stop (list↔list — converges; see addrListSig). Do NOT merge the stale address/coords/
            // line-items over it — leave s as the raw list row (which already holds the new addr1/
            // city/zip) so the `!s.enriched` check below re-enriches it: fresh address, re-geocoded
            // pin, and refreshed detail. Skip seeding the OLD coords too. Rare → negligible calls.
            const wasReconsigned = p.enriched && reconsignedByListSig(p.addrListSig, s);
            // An absent-plan candidate IS the prior row (cloned, plan cleared) so there is no
            // detail to merge — and merging would restore routeSeq, part of the very plan the
            // candidate exists to put a question mark over.
            if (p.enriched && !wasReconsigned && !s.absentFromPull) mergeEnrich(s, p); // carry same-day enriched detail forward
            if (wasReconsigned) { reconsigned++; reconsignedNbrs.add(String(s.stopNbr)); }
            // THE ADDRESS MOVED WITHOUT THE SIGNATURE NOTICING (Chad, ESTES-1283081681).
            //
            // The list↔list check above only fires when the STORED SIGNATURE disagrees with
            // this scan's list row. It cannot fire when there is no stored baseline (first
            // sighting, or a stop that predates the field), and it stops firing the moment a
            // baseline is stamped from the new address while the DISPLAYED address is still
            // the old enriched one — after which both sides agree for ever and the card never
            // corrects itself. That is the state Chad's order was in.
            //
            // So compare the list against the address we are actually SHOWING. That is the
            // list↔stored comparison addrListSig's comment warns off — because the two
            // endpoints format addresses differently and it "re-fired every scan, never
            // converging". It converges NOW, and only now: LIVE_IF_PRESENT_FIELDS means we
            // persist the LIST's spelling of the address, so the next scan compares the list
            // against itself and agrees. One re-enrichment per real move, not per scan.
            //
            // mergeEnrich has already run, so `s` holds what the board WOULD have shown.
            //
            // A PICKUP IS EXEMPT, and this is the whole reason the exemption has to be here
            // rather than only in the merge. Its list address is the ship-to (our terminal on
            // a return) while the address we SHOW is the pickup site, so the two signatures
            // describe different places BY DESIGN and can never be made to agree. Left in,
            // this check would blank the pin and re-enrich every RA row on every scan for
            // ever — precisely the non-converging loop addrListSig's own comment warns off.
            const shownSig = addrListSig(s);
            if (!wasReconsigned && p.enriched && !isPickupRow(s) && shownSig && listSig && shownSig !== listSig) {
              // The list wins the text (mergeEnrich left it alone — the fields are
              // live-if-present), but the coordinates, the state and the line items on the
              // record all describe the PREVIOUS address. A corrected address under a pin
              // still sitting on the old building is worse than the stale address was: the
              // card would read right and the driver would still be sent to the wrong place.
              s.lat = null; s.lng = null;
              s.enriched = false;                       // re-enrich: fresh detail + re-geocode
              reconsigned++; reconsignedNbrs.add(String(s.stopNbr));
            }
            // THE PICKUP ADDRESS REPAIR (see PICKUP_ADDR_HEAL). A pickup carried forward from
            // a pre-fix scan holds the ship-to; the detail merge above has just handed it to
            // this row, and its cached registry record holds the same thing. Keep the detail
            // (so nothing is lost if the re-read is capped or fails) but clear `enriched` so
            // the live /stop/info below runs and recovers stop.from. The stamp rides along on
            // the merge, so a pickup already repaired — or one first enriched after the fix —
            // never comes back through here.
            if (isPickupRow(s) && s.enriched && Number(s.pickupAddrHeal ?? 0) < PICKUP_ADDR_HEAL) {
              s.enriched = false;
              staleCacheNbrs.add(String(s.stopNbr));
              healedPickups++;
            }
            // A recent CONFIRMED live Save (write-through, #361) outranks a lagging list row:
            // hold the confirmed plan fields until the list agrees or the grace expires.
            const held = applyBoardWriteGrace(s, p, Date.now());
            // Demotion verify (Jul 9 SEAAGRI, #408 follow-up): past the grace window the list
            // used to win UNCONDITIONALLY — but NuVizz's saved-search index can stay wrong for
            // HOURS about a stop the portal itself shows planned (the half-applied DAWSONVILLE
            // edit left 007144188 listed un-planned while the load held it, so the board dropped
            // it off Leroy's route with the truck already rolling, and every rescan re-dropped
            // it). A fresh list row may NOT flip a previously-PLANNED row to unplanned on the
            // list's word alone: queue it for a one-call /stop/info check below and let NuVizz's
            // own stop record decide.
            if (!held && p.isPlanned === true && p.loadNbr && s.isPlanned !== true) demoteChecks.push({ s, p });
            // Don't seed a reconsigned stop's OLD coords — they belong to the previous address.
            // `s.enriched` is cleared just above when the shown address moved, so this also
            // stops the OLD coordinates being seeded for a stop that has just been re-addressed.
            if (!wasReconsigned && s.enriched !== false && typeof p.lat === 'number' && typeof p.lng === 'number') { const k = addrKey(p); if (k) seed.set(k, { lat: p.lat, lng: p.lng }); }
          }
          // Stamp THIS scan's list signature so the next scan compares list↔list. Current list
          // wins; fall back to the stored sig when the list carried no address this scan, so a
          // momentarily address-less row can't wipe the baseline (which would re-arm a false
          // positive). addrListSig is a LIVE_LIST_FIELD, so later enrichment merges never clobber it.
          s.addrListSig = listSig || (p && p.addrListSig) || null;
          // Status AND the delivery time are FREE & live from the list every scan (see
          // LIVE_LIST_FIELDS + toBoardStop's deliveredDTTM), so we do NOT spend a /stop/info
          // call to track delivery. We enrich a PRO exactly ONCE — when it first appears — for
          // the static detail (line items, coords, contact, …); the list keeps status/delivery
          // current thereafter. POD photos are pulled ON DEMAND when a stop is opened (a single
          // /stop/info + documentapi fetch keyed by the clicked PRO), never in the background,
          // so a delivery costs zero scheduled calls.
          // We do NOT re-enrich already-enriched stops to backfill newer fields (full notes,
          // stopId) — those load ON DEMAND when a dispatcher opens the stop (the card's Refresh
          // / timeline), keeping background calls minimal (dispatcher's choice). New orders get
          // the fields on their first (and only) enrichment.
          if (!s.enriched) toEnrich.push(s);
        }
        if (reconsigned) console.log(`[scan] ${date}: ${reconsigned} reconsigned stop(s) — address changed, re-enriching for the new address + pin`);
        if (healedPickups) console.log(`[scan] ${date}: ${healedPickups} pickup(s) still carrying the ship-to address — re-reading /stop/info once each for the real pickup address (one-time, see PICKUP_ADDR_HEAL)`);

        // ── Demotion verify (see collection above) ────────────────────────────
        // LOAD-CORROBORATED FIRST (OWUSU 1, Jul 10): NuVizz's per-stop record can read
        // un-planned for 30+ minutes after an ACCEPTED planning-mode save on an undispatched
        // load — long past the write grace — so the record-based verdict demoted a whole
        // just-saved route while the portal showed the load holding every stop. The LOAD
        // (route plan) is the same truth the post-save verify checked, so membership there
        // decides: board rows carry the route NAME in loadNbr, the day's cached roster
        // (Firestore, free) resolves name → real load number, and ONE memoized /load/info
        // covers every check on that load. The per-stop record read remains the fallback
        // when there's no roster match or the load read fails; over-budget lookups return
        // null → held one tick (never demoted on a missing read).
        // Budget fairness (audit P1): the check list arrives in stable pull order, so under a
        // mass dispute the same first loads consumed the whole budget every scan and a
        // genuinely-removed stop on load #5 was held forever. Shuffle so every disputed load
        // gets verified within a few ticks.
        for (let fy = demoteChecks.length - 1; fy > 0; fy--) { const k = Math.floor(Math.random() * (fy + 1)); [demoteChecks[fy], demoteChecks[k]] = [demoteChecks[k], demoteChecks[fy]]; }
        const demoteByNbr = new Map(demoteChecks.map((c) => [String(c.s.stopNbr), c]));
        // Policy + budgets live in makeDemotionLookup (exported, unit-tested); this site only
        // binds the real readers (roster, /load/info membership, /stop/info record).
        const demotion = makeDemotionLookup({
          demoteByNbr,
          readRoster: () => readLoadRoster(TENANT, date),
          readLoadStopNbrs: lookupLoadStopNbrs,
          readStopRecord: lookupStopByPro,
          verdictFromRecord: demotionLookupVerdict,
          loadReadBudget: DEMOTE_VERIFY_LOAD_MAX,
          stopReadBudget: DEMOTE_VERIFY_MAX,
        });
        const dv = await applyDemotionVerify(demoteChecks, {
          // Check-count cap is wide open — the CALL budget is enforced inside the closure
          // (loads ≤ DEMOTE_VERIFY_LOAD_MAX, stop records ≤ DEMOTE_VERIFY_MAX); anything
          // past budget verdicts null → held. max<=0 still disables entirely (list wins).
          max: DEMOTE_VERIFY_MAX > 0 ? Math.max(64, demoteChecks.length) : 0,
          scannedAt,
          lookup: demotion.lookup,
        });
        if (dv.kept || dv.held) console.warn(`[scan] ${date}: list tried to unplan ${demoteChecks.length} routed stop(s) — kept ${dv.kept} (NuVizz stop record says assigned), held ${dv.held} (unverified this scan), dropped ${dv.dropped} (confirmed unplanned) — sample ${JSON.stringify(demoteChecks.slice(0, 5).map((c) => String(c.s.stopNbr)))}`);

        // Per-PRO enrichment registry (day-independent): before spending a /stop/info, check
        // the registry for any PRO not already enriched via a recent day-board. A PRO ever
        // enriched (on ANY day) is carried forward and NEVER re-pulled — only a manual Refresh
        // or a timeline open re-fetches it. Targeted reads (just the candidate set).
        // FAIL-SAFE: if the registry read THROWS (Firestore hiccup), we must NOT fall through
        // and re-enrich every candidate — that's how a transient blip turned into a ~700-call
        // /stop/info burst. A failed read = we can't prove a PRO is new, so we skip enrichment
        // this cycle entirely and retry next scan. Under-enriching for one tick is harmless;
        // bursting the vendor is not.
        let regOk = true;
        let regUnresolved = new Set<string>();
        if (ENRICH && toEnrich.length) {
          try {
            const reg = await readEnrichedPros(TENANT, toEnrich.map((s) => String(s.stopNbr)));
            regUnresolved = reg.unresolved;
            // Skip the registry re-merge for a RECONSIGNED stop — its cached record holds the OLD
            // address and would re-clobber the new one. Left un-enriched, it flows to the live
            // /stop/info below (fresh address + coords), or, if that's capped, its new list address
            // is geocoded in the coords fallback — either way the pin follows the move.
            if (reg.found.size) for (const s of toEnrich) {
              const nbr = String(s.stopNbr);
              if (reconsignedNbrs.has(nbr) || staleCacheNbrs.has(nbr)) continue;
              const r = reg.found.get(nbr);
              if (!r) continue;
              // A pickup cached before the ship-to fix holds OUR TERMINAL's address, so merging
              // it would mark the row enriched and skip the live read that is the only way back
              // to the real one. This is the cross-day half of the repair: the branch above only
              // sees pickups that were already on TODAY's board on a previous scan.
              if (isPickupRow(s) && Number(r.pickupAddrHeal ?? 0) < PICKUP_ADDR_HEAL) continue;
              mergeEnrich(s, r);
            }
            if (regUnresolved.size) console.warn(`[scan] ${date}: registry read could not resolve ${regUnresolved.size} PRO(s) after retries; SKIPPING those this cycle (retry next scan, never re-enrich on a read error)`);
          } catch (e: any) { regOk = false; console.warn(`[scan] ${date}: enrichment registry read failed (${e?.message}); SKIPPING enrichment this cycle to avoid a burst`); }
        }
        // Enrichment: one direct /stop/info per genuinely-new PRO (bounded concurrency, capped).
        // The hard per-scan cap (ENRICH_MAX) is a backstop: even a cold/empty registry can never
        // burst more than ENRICH_MAX calls in one scan — a cold board backfills over a few ticks.
        // A registry read that ERRORED for a PRO (regUnresolved) is treated as UNKNOWN, not "new":
        // it is excluded here so a transient Firestore blip can never cause a re-enrichment spike.
        let enriched = 0;
        const stillNeed = (ENRICH && regOk) ? toEnrich.filter((s) => !s.enriched && !regUnresolved.has(String(s.stopNbr))) : [];
        if (stillNeed.length > ENRICH_MAX) console.warn(`[scan] ${date}: ${stillNeed.length} PROs need enrichment; capping at ENRICH_MAX=${ENRICH_MAX} this scan (rest next tick)`);
        if (ENRICH && stillNeed.length) {
          // Observability: log WHICH PROs we're about to enrich + a sample, so a future "spike"
          // is self-diagnosing (cross-check these against the registry to catch any miss).
          console.log(`[scan] ${date}: enriching ${Math.min(stillNeed.length, ENRICH_MAX)} new PRO(s) via /stop/info — sample ${JSON.stringify(stillNeed.slice(0, 10).map((s) => String(s.stopNbr)))}`);
          const batch = stillNeed.slice(0, ENRICH_MAX);
          let i = 0;
          const worker = async () => {
            while (i < batch.length) {
              const s = batch[i++];
              try {
                const r = await lookupStopByPro(s.stopNbr);
                if (r.ok && r.stop) {
                  // NuVizz ANSWERED, whichever way it answered — so a pickup's one-time address
                  // repair is spent here and not re-armed tomorrow. Stamped on the answer rather
                  // than the attempt: a call that threw falls to the catch below with the stamp
                  // unset and is retried, like any other stop that failed to enrich. This also
                  // settles the honest edge case — a pickup that genuinely happens AT our own
                  // terminal reads back as the terminal, and must not be re-read for ever.
                  if (isPickupRow(s)) s.pickupAddrHeal = PICKUP_ADDR_HEAL;
                  if (enrichedRecordMatches(s, r.stop)) { mergeEnrich(s, r.stop); enriched++; }
                  else {
                    // The by-number read answered with the OTHER record sharing this number.
                    // Keep the row on LIST truth (its address is the record the board shows),
                    // and register it as enriched anyway — re-pulling by number would return
                    // the same twin every scan and burn a call each time. On-demand refresh
                    // (card open / timeline) still re-fetches when the duplicate is cleaned up.
                    s.enriched = true; s.dupNbrSuspect = true; enriched++;
                    console.warn(`[scan] ${date}: /stop/info for ${s.stopNbr} returned a DIFFERENT record (id ${String(r.stop.stopId ?? '?')} vs list ${String(s.stopId)}) — two orders share this number; keeping the list row, NOT merging the twin's detail`);
                  }
                }
              } catch { /* skip; geocode fallback below */ }
            }
          };
          await Promise.all(Array.from({ length: Math.min(ENRICH_CONC, batch.length) }, worker));
          // Record the newly-enriched PROs so they're never auto-enriched again (any day).
          await writeEnrichedPros(TENANT, batch, scannedAt).catch(() => {});
        }

        // Coords: geocode any stop STILL missing coords (enrichment off / failed / capped).
        const need = dateStops.filter((s) => typeof s.lat !== 'number' || typeof s.lng !== 'number');
        if (need.length) {
          const coords = await resolveCoords(need, seed);
          for (const s of need) { const k = addrKey(s); const pt = k ? coords.get(k) : null; if (pt) { s.lat = pt.lat; s.lng = pt.lng; } }
        }

        // Load-ID anchor: drop prior-day instances of recurring routes whose loadId isn't
        // in today's authoritative load roster (one extra NuVizz call per day, cached).
        if (LOAD_ANCHOR) {
          try {
            let ids = loadIdCache.get(date);
            if (!ids) { const r = await loadIdsForDate(date); ids = r.ids; loadIdCache.set(date, ids); console.log(`[scan] load-anchor ${date}: ${r.count} loads (${r.cols} cols)`); }
            const before = dateStops.length;
            dateStops = dropForeignLoadStops(dateStops, ids, date);
            if (dateStops.length !== before) console.log(`[scan] load-anchor ${date}: dropped ${before - dateStops.length} foreign-load stops`);
          } catch (e: any) { console.warn(`[scan] load-anchor ${date} skipped: ${e?.message}`); }
        }

        // includeCompleted: a two-search pull fetches 77131 alongside 77128, so this write IS
        // a completed scan and stamps as one. With TWO_SCAN off there is no completed pull in
        // this path at all, and claiming one would date-stamp a scan that never happened.
        const meta = await writeStops(TENANT, date, dateStops, scannedAt, { includeUnplanned: true, includeLoads: true, includeCompleted: TWO_SCAN, graceFn: (fresh, ex) => { applyBoardWriteGrace(fresh, ex, Date.now()); } });
        // Cache the date's empty-loads roster (once/day for a future date) so the Loads view can
        // show e.g. Monday's empty loads without a per-request live fetch.
        await persistLoadRoster(date, scannedAt);
        // CS notify — this hook only lived in the legacy probe path (scanAndWrite), which the
        // list-discovery config never runs, so a notify_cs-flagged customer produced NO email
        // and no status doc on any production scan. Fire it here too: best-effort, deduped
        // per delivery date inside notifyMarkedCustomers, a mail failure never affects the scan.
        try {
          const n = await notifyMarkedCustomers(date, dateStops);
          if (n.matched) console.log(`[cs-notify] date=${date} matched=${n.matched} sent=${n.sent} failed=${n.failed}${n.skipped ? ` skipped=${n.skipped}` : ''}`);
        } catch (e: any) { console.warn(`[cs-notify] ${date} failed: ${e?.message}`); }
        results.push({ date, ok: true, source: 'list', count: meta.count, planned: meta.plannedCount, unplanned: meta.unplannedCount, enriched, newPros: stillNeed.length });
      }

      // ── Retire carried rows the live snapshot can't judge (phantom-unplanned fix) ──
      // Best-effort and strictly additive: any failure leaves the board exactly as it is
      // today (over-counting), never dropping a row on a guess.
      try {
        const RETIRE_DAYS = Math.max(1, Math.min(30, Number(process.env.NUVIZZ_CARRYOVER_DAYS_MAX) || 14));
        const RETIRE_READ_CAP = Math.max(0, Number(process.env.NUVIZZ_RETIRE_READ_CAP) || 400);
        const floorDate = addDaysUTC(today, -RETIRE_DAYS);
        const priorDates = Array.from({ length: RETIRE_DAYS }, (_, i) => addDaysUTC(today, -(i + 1)));
        const [live, retired] = await Promise.all([
          readActiveUnplannedSet(TENANT).catch(() => null),
          readCarryoverRetired(TENANT),
        ]);
        // Only the identity + status fields — this is a counting pass, not a data pull.
        const RETIRE_MASK = ['stopNbr', 'isPlanned', 'isUnplanned', 'normalizedStatus'];
        const priorRows = await Promise.all(priorDates.map((d) =>
          readStops(TENANT, d, { mask: RETIRE_MASK }).then((r) => ({ date: d, stops: r.stops || [] })).catch(() => ({ date: d, stops: [] as any[] }))));
        const candidates = carryoverRetirementCandidates(priorRows, live, retired);
        const additions: Record<string, string> = {};
        // ONE read budget across the whole pass. Each row searches its own window (its day →
        // yesterday, newest first), so a recent seal costs a single read; the budget is what
        // stops a long tail of never-sealed rows from turning into hundreds. Rows left unproven
        // when it runs out simply keep folding, and the next scan picks up where this stopped.
        let spent = 0;
        for (const c of candidates) {
          if (spent >= RETIRE_READ_CAP) break;
          const perRow = makeHistoryTerminalLookup({
            readStop: (d, nbr) => getStop(TENANT, d, nbr),
            dates: retirementSearchDates(c.date, today, RETIRE_DAYS),
            isTerminal: isTerminalHistoryStatus,
            readCap: RETIRE_READ_CAP - spent,
          });
          const rec = await perRow.lookup(c.nbr);
          spent += perRow.reads();
          if (rec) additions[c.nbr] = String(rec.date || rec.boardDate || today);
        }
        if (Object.keys(additions).length || Object.keys(retired).length) {
          const size = await mergeCarryoverRetired(TENANT, additions, floorDate);
          console.log(`[carryover-retire] candidates=${candidates.length} newly-proven=${Object.keys(additions).length} listSize=${size}`);
        }
      } catch (e: any) {
        console.warn(`[carryover-retire] skipped: ${e?.message}`);
      }
    } catch (e: any) {
      // List-only: do NOT fall back to the number-probe; preserve the existing index.
      console.warn(`[scan] list-discovery error (${e?.message}); preserving last-good board (list-only, no number-probe)`);
      results.push({ ok: false, source: 'list', error: e?.message });
    }
    await refreshOps();
    logScan('none', decision.act, { l: true, u: true }, { l: decision.scanTomorrowLoads, u: decision.scanTomorrowUnplanned }, ' src=list-only');
    return json({ ok: true, tenant: TENANT, mode: isManual ? 'manual' : 'scheduled', source: 'list', decision, totalMs: Date.now() - startedAt, dates: results });
  }

  // Today: loads always; orders inside the 10am-midnight window.
  // Reaching here on a schedule means the EXPENSIVE probe engine is about to run without an
  // explicit trigger — only possible when NUVIZZ_LIST_DISCOVERY is explicitly 'off'. Say so loudly.
  console.warn(`[scan] ⚠ NUMBER-PROBE ENGINE on a ${isManual ? 'manual' : 'scheduled'} tick (NUVIZZ_LIST_DISCOVERY=off) — this is the ~3,000-call path`);
  await scanAndWrite(today, decision.scanTodayUnplanned, isManual, true);
  // Tomorrow (Fix 2): descend orders 10am-midnight, but only scan tomorrow's LOADS
  // 8pm-midnight (they don't exist earlier) — avoids ~13 empty load scans/day.
  if (decision.scanTomorrowLoads || decision.scanTomorrowUnplanned) {
    await scanAndWrite(tomorrow, decision.scanTomorrowUnplanned, isManual, decision.scanTomorrowLoads);
  }

  await refreshOps();
  logScan('none', true,
    { l: true, u: decision.scanTodayUnplanned },
    { l: decision.scanTomorrowLoads, u: decision.scanTomorrowUnplanned });
  return json({ ok: true, tenant: TENANT, mode: isManual ? 'manual' : 'scheduled', decision, totalMs: Date.now() - startedAt, dates: results });
}
