// lib/flag-replay-core.mts
//
// WOULD THE FLAG HAVE CAUGHT IT? — the recall question, answered by replay.
//
// Chad: "we need to go back and study all the data that we have to see how our flagging
// system would work and whether or not things that ended up delivering after the receiving
// hours in the data we have would have been flagged."
//
// The live flag history only starts the day the recorder started (2026-08-19). Everything
// before that is sealed in history_days — final stamps, final statuses, full plans. This
// module replays TODAY'S engine (imported, never copied — the back-test that copied it
// silently diverged in three places) over a sealed day in simulated 20-minute sweeps, and
// then grades what it raised against what the trucks actually did.
//
// THE AS-OF RULE, same spirit as eta-backtest but on the time axis: at simulated clock T,
// the engine may only see stamps whose time is <= T. A stop delivered at 10:30 is an OPEN
// stop with no stamp at the 10:20 sweep and a finished, anchoring stop at 10:40. Statuses
// carry no timestamps in sealed data, so their timing is unknowable — they are DERIVED
// from the masked stamps rather than trusted, which is the conservative direction: the
// replay never lets the engine peek at an outcome through a status field, at the cost of
// not crediting it with rolling-evidence statuses (40/50) it might genuinely have seen.
// Reconstructed results must be labelled reconstructed; callers carry that flag through.
//
// KNOWN APPROXIMATION, stated rather than hidden: receiving hours come from customer_notes
// AS THEY EXIST TODAY. Notes are not versioned, so a customer whose hours were typed in
// last week replays with those hours on days before they were known. The replay therefore
// answers "how would TODAY'S system have done on that board" — which is the question asked
// — not "what did the system know that morning".
import { computeBoardFlags, dayReceivingWindow, arrivalAnchor, stampMinutes } from '../../../src/lib/board-flags.js';
import { selectAlertable } from './flag-alert.mts';
import { flattenForConsumers } from './flag-rows.mts';
import { weekdayKey } from './miss-ledger.mts';
import { stopCustomerKey } from './customer-key.mts';

export const REPLAY_VERSION = 1;

const stampDay = (v: any): string => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? ''));
  return m ? m[1] : '';
};

const TERMINAL_STATUSES = new Set(['DELIVERED', 'EXCEPTION']);
const TERMINAL_CODES = new Set(['90', '91', '99', '80']);
const ROLLING_STATUSES = new Set(['OUT_FOR_DEL', 'ARRIVED']);
const ROLLING_CODES = new Set(['40', '50']);

/**
 * PURE. One stop as the engine would have seen it at simulated minute `nowMin` of `date`.
 *
 * A stamp from a future day, or from this day at a time after the clock, does not exist
 * yet and is removed. A stamp from a PRIOR day existed before the day began and is kept —
 * arrivalAnchor already refuses to anchor on it, and its presence is real information.
 * A same-day stamp whose minutes cannot be parsed is removed too: "we cannot tell when
 * this became known" must not decay into "the engine knew it all along".
 *
 * Status fields are then re-derived from the surviving stamps (see header). This also
 * covers EXCEPTION stops: with no stamp to justify a terminal status at T, the stop reads
 * open — the replay judges it like the live board would have before the exception posted.
 */
export function maskStopAsOf(s: any, date: string, nowMin: number): any {
  const out = { ...s };
  for (const field of ['arrivalDTTM', 'deliveredDTTM']) {
    const v = out[field];
    if (!v) continue;
    const day = stampDay(v);
    const min = stampMinutes(v);
    const future = day > date || (day === date && (min == null || min > nowMin));
    if (future) delete out[field];
  }
  if (!out.deliveredDTTM) {
    const ns = String(out.normalizedStatus ?? '');
    const sc = String(out.status ?? '').trim();
    if (TERMINAL_STATUSES.has(ns) || TERMINAL_CODES.has(sc) || ROLLING_STATUSES.has(ns) || ROLLING_CODES.has(sc)) {
      if (out.arrivalDTTM) { out.normalizedStatus = 'ARRIVED'; out.status = '50'; }
      else { delete out.normalizedStatus; out.status = '20'; }
    }
  }
  return out;
}

/** PURE. The simulated sweep clock: fromMin..toMin inclusive, every stepMin minutes. */
export function sweepGrid(fromMin: number, toMin: number, stepMin: number): number[] {
  const out: number[] = [];
  if (!Number.isFinite(fromMin) || !Number.isFinite(toMin) || !Number.isFinite(stepMin) || stepMin <= 0) return out;
  for (let t = fromMin; t <= toMin; t += stepMin) out.push(t);
  return out;
}

export interface StopTrajectory {
  stopNbr: string; customer: string; route: string;
  closeMin: number | null; hoursTier: string | null;
  firstAnyMin: number | null; firstAnyTier: string | null;   // first sweep any hours_risk row appeared
  firstRedMin: number | null;                                 // first sweep an EMAIL would have gone (selectAlertable)
  worstTier: string | null; sweepsFlagged: number;
  etaAtFirstRed: number | null; lateByAtFirstRed: number | null; anchoredAtFirstRed: boolean | null;
}

const TIER_RANK: Record<string, number> = { critical: 3, red: 2, amber: 1 };
const worse = (a: string | null, b: string | null) =>
  (TIER_RANK[b || ''] || 0) > (TIER_RANK[a || ''] || 0) ? b : a;

/**
 * Replay one sealed day. `stops` must already carry matchKey (withCustomerKeys); `notes`
 * is the same Map the live sweep builds; `travel` is the same {legs, curve, serviceMin}
 * the live sweep passes, so the replay prices legs exactly like the board does today.
 * Pure given its inputs — all IO stays in the endpoint.
 */
export function replayDay({ stops, notes, date, grid, depot, travel }: {
  stops: any[]; notes: Map<string, any>; date: string; grid: number[];
  depot: any; travel?: any;
}): { trajectories: Map<string, StopTrajectory>; sweepsRun: number; lastSkipped: any } {
  const dayKey = weekdayKey(date);
  const traj = new Map<string, StopTrajectory>();
  let lastSkipped: any = null;

  for (const nowMin of grid) {
    const masked = stops.map((s) => maskStopAsOf(s, date, nowMin));
    const flags = computeBoardFlags({
      stops: masked, notes, servedDate: date, dayKey,
      opts: { depot, nowMin, ...(travel ? { travel } : {}) },
    });
    lastSkipped = flags?.checked ?? null;

    // ONE POPULATION FOR BOTH HALVES OF THE MEASUREMENT. selectAlertable flattens collapsed
    // summary rows (v0.73.1); this loop used to iterate the raw capped list — so on a
    // capped board one half of the function saw the constituents and the other did not,
    // and the trajectory record disagreed with the alertable set it was scored against.
    const rows = flattenForConsumers(flags.rows || []);
    const alertable = new Set(selectAlertable(rows, nowMin).map((c: any) => String(c.stopNbr)));
    for (const r of rows) {
      // THE TWO RULES THAT REACH AN INBOX. hours_risk is the primary one; no_driver_hours
      // (R6) supersedes a driverless route's hours_risk rows and, since it started carrying
      // a stop and a close, is emailable in its own right (lib/flag-alert ALERT_RULES).
      //
      // This used to hard-code no_driver_hours as screen-only and skip the email accounting
      // for it, which made the backtest UNDER-report its own warning: a driverless route's
      // card was scored "seen but never emailed" while production emailed it. A measurement
      // tool that restates the production rule instead of asking it will drift from it, and
      // the drift is invisible — the numbers still look like numbers. selectAlertable is the
      // one authority on email-eligibility, and `alertable` below already consults it.
      if ((r?.rule !== 'hours_risk' && r?.rule !== 'no_driver_hours') || r?.scope !== 'occurrence' || r?.stopNbr == null) continue;
      const key = String(r.stopNbr);
      let t = traj.get(key);
      if (!t) {
        t = {
          stopNbr: key, customer: String(r.customer || ''), route: String(r.routeName || ''),
          closeMin: Number.isFinite(r.closeMin) ? r.closeMin : null,
          hoursTier: null,
          firstAnyMin: null, firstAnyTier: null, firstRedMin: null,
          worstTier: null, sweepsFlagged: 0,
          etaAtFirstRed: null, lateByAtFirstRed: null, anchoredAtFirstRed: null,
        };
        traj.set(key, t);
      }
      t.sweepsFlagged += 1;
      t.worstTier = worse(t.worstTier, r.tier || null);
      if (t.firstAnyMin == null) { t.firstAnyMin = nowMin; t.firstAnyTier = r.tier || null; }
      if (t.firstRedMin == null && alertable.has(key)) {
        t.firstRedMin = nowMin;
        t.etaAtFirstRed = Number.isFinite(r.etaMin) ? r.etaMin : null;
        t.lateByAtFirstRed = Number.isFinite(r.lateBy) ? r.lateBy : null;
        t.anchoredAtFirstRed = r.anchored === true;
      }
    }
  }
  return { trajectories: traj, sweepsRun: grid.length, lastSkipped };
}

export type Verdict =
  | 'missed_caught'          // email-eligible red/critical BEFORE the close — the warning worked
  | 'missed_screen_only'     // flagged before the close, but never email-eligible in time (amber, or red too late)
  | 'missed_flag_after_close'// first flag of any kind arrived at/after the close
  | 'missed_blind'           // delivered late and no sweep ever raised it
  | 'made_flagged'           // email-eligible flag, but the stop made its window (false alarm OR a save — indistinguishable)
  | 'made_screen_only'
  | 'made_quiet';

export interface ReplayRow {
  stopNbr: string; customer: string; route: string;
  closeMin: number; arrivalMin: number; lateBy: number; missed: boolean;
  hoursTier: 'typed' | 'auto';
  verdict: Verdict;
  leadMin: number | null;      // close - firstRedMin, only when caught (positive by construction)
  leadAnyMin: number | null;   // close - firstAnyMin, when any flag preceded the close
  firstAnyMin: number | null; firstAnyTier: string | null;
  firstRedMin: number | null; worstTier: string | null;
  anchoredAtFirstRed: boolean | null;
  blindReason?: string;
}

/** PURE. Why a late stop could never have been judged — best-effort, for the blind bucket. */
export function blindReason(s: any): string {
  const route = String(s?.loadNbr || s?.routeName || '').trim();
  if (!route) return 'no_route_assigned';
  if (/\b(?:APPTS?|APPOINTMENTS?)\b/i.test(route)) return 'appointment_route';
  const seqRaw = s?.routeSeq ?? s?.raw?.stop?.to?.seq ?? s?.raw?.stop?.from?.seq;
  if (typeof seqRaw !== 'number') return 'no_sequence';
  const lat = Number(s?.lat), lng = Number(s?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'no_position';
  return 'never_predicted_late';
}

/**
 * PURE. Join the trajectories to what actually happened, over gradable stops only —
 * a close on file for that weekday AND a real same-day arrival stamp, the same population
 * the miss ledger scores. Everything else is counted in `ungradable`, never guessed.
 */
export function judgeDay({ stops, notes, date, trajectories }: {
  stops: any[]; notes: Map<string, any>; date: string;
  trajectories: Map<string, StopTrajectory>;
}): { rows: ReplayRow[]; ungradable: Record<string, number> } {
  const dayKey = weekdayKey(date);
  const rows: ReplayRow[] = [];
  const ungradable: Record<string, number> = {};
  const bump = (k: string) => { ungradable[k] = (ungradable[k] || 0) + 1; };
  const seen = new Set<string>();

  for (const s of stops) {
    const stopNbr = String(s?.stopNbr ?? '');
    if (!stopNbr || seen.has(stopNbr)) continue;
    seen.add(stopNbr);
    if (String(s?.stopType || '').toUpperCase() === 'PU') { bump('pickup'); continue; }
    const note = notes.get(stopCustomerKey(s));
    const w = note ? dayReceivingWindow(note, dayKey) : null;
    if (!w || !Number.isFinite(w.closeMin)) { bump('no_receiving_hours_on_file'); continue; }
    const a = arrivalAnchor(s, date);
    if (!a) { bump('no_arrival_stamp'); continue; }

    const missed = a.min > w.closeMin;
    const t = trajectories.get(stopNbr) || null;
    const caughtInTime = t?.firstRedMin != null && t.firstRedMin < w.closeMin;
    const seenInTime = t?.firstAnyMin != null && t.firstAnyMin < w.closeMin;

    let verdict: Verdict;
    if (missed) {
      verdict = caughtInTime ? 'missed_caught'
        : seenInTime ? 'missed_screen_only'
        : t ? 'missed_flag_after_close'
        : 'missed_blind';
    } else {
      verdict = t?.firstRedMin != null ? 'made_flagged' : t ? 'made_screen_only' : 'made_quiet';
    }

    rows.push({
      stopNbr, customer: String(s?.businessName || ''), route: String(s?.loadNbr || s?.routeName || ''),
      closeMin: w.closeMin, arrivalMin: a.min, lateBy: a.min - w.closeMin, missed,
      hoursTier: w.tier,
      verdict,
      leadMin: caughtInTime && t ? w.closeMin - (t.firstRedMin as number) : null,
      leadAnyMin: seenInTime && t ? w.closeMin - (t.firstAnyMin as number) : null,
      firstAnyMin: t?.firstAnyMin ?? null, firstAnyTier: t?.firstAnyTier ?? null,
      firstRedMin: t?.firstRedMin ?? null, worstTier: t?.worstTier ?? null,
      anchoredAtFirstRed: t?.anchoredAtFirstRed ?? null,
      ...(verdict === 'missed_blind' ? { blindReason: blindReason(s) } : {}),
    });
  }
  return { rows, ungradable };
}

const pctl = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
};

/** PURE. The day's headline. Rates are null (not 0) when nothing is gradable — a quiet
 *  day and an unmeasurable day must never read the same. */
export function summarizeReplay(rows: ReplayRow[]): any {
  const missed = rows.filter((r) => r.missed);
  const made = rows.filter((r) => !r.missed);
  const caught = missed.filter((r) => r.verdict === 'missed_caught');
  const leads = caught.map((r) => r.leadMin as number).filter(Number.isFinite);
  const flaggedMade = made.filter((r) => r.verdict === 'made_flagged');
  const emailable = caught.length + flaggedMade.length;
  return {
    gradable: rows.length,
    missed: missed.length,
    made: made.length,
    missed_caught: caught.length,
    missed_screen_only: missed.filter((r) => r.verdict === 'missed_screen_only').length,
    missed_flag_after_close: missed.filter((r) => r.verdict === 'missed_flag_after_close').length,
    missed_blind: missed.filter((r) => r.verdict === 'missed_blind').length,
    made_flagged: flaggedMade.length,
    made_screen_only: made.filter((r) => r.verdict === 'made_screen_only').length,
    recallPct: missed.length ? Math.round((caught.length / missed.length) * 100) : null,
    emailPrecisionPct: emailable ? Math.round((caught.length / emailable) * 100) : null,
    leadMedianMin: pctl(leads, 50), leadP10Min: pctl(leads, 10), leadP90Min: pctl(leads, 90),
    caughtAnchored: caught.filter((r) => r.anchoredAtFirstRed === true).length,
    caughtUnanchored: caught.filter((r) => r.anchoredAtFirstRed === false).length,
  };
}
