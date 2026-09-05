// lib/scan-plan.mts
//
// THE SCAN PLAN — which NuVizz saved search runs, on which days, in which hours, how often.
//
// Chad: "it's time to decouple them. Part of the day we need to scan more for completed, and
// part of the day we need to scan more for unplanned and planned. Redesign the UI so I can set
// days of week and time schedules for each scan, and rows of when it scans so I can scan more
// heavily on each scan at different times of the day — and I want descriptions of what each
// scan does and what it affects."
//
// WHY DECOUPLING IS THE RIGHT CALL, in freight terms rather than code terms. The two saved
// searches answer completely different questions, and they matter at opposite ends of the day:
//
//   * 77128 (planned/unplanned) is about THE PLAN — what is on which truck, in what order,
//     with which driver. It churns during the routing evening and again at the ~10am order
//     drop, and is nearly static while trucks are actually running.
//   * 77131 (completed) is about WHAT HAPPENED — the delivery stamps. It is dead overnight
//     (nothing is delivering at 2am) and is the whole game from first roll to last stop,
//     because every stamp RE-ANCHORS the arrival clock and moves every downstream ETA on
//     that route.
//
// Running both on one cadence means the evening pays for a completed pull that can only come
// back empty, and the delivery day under-samples the one feed that decides whether a flag is
// right. Hence a plan, not a single interval.
//
// RESOLUTION IS ORDER-FREE: where rules overlap, THE TIGHTEST INTERVAL WINS. Chad's stated
// intent is "scan more heavily" in a window, so a row can only ever tighten — which means
// there is no row ordering to get wrong, no drag-to-reorder, and adding a row can never
// silently slow something down. To scan LESS you widen or edit the row that set the pace.
//
// NO MATCHING RULE = THAT SCAN DOES NOT RUN IN THAT HOUR. Explicit beats implicit: it is what
// lets "don't pull completed at 2am" be a thing you can express by simply not covering 2am.
// The UI renders the resolved 7×24 grid so an uncovered hour is visible rather than inferred.
//
// PURE. No Firestore, no network, no clock — every decision here is testable on plain data.

/** The scans this plan can schedule. Order is display order. */
export const SCAN_KINDS = ['planned', 'completed', 'roster'] as const;
export type ScanKind = typeof SCAN_KINDS[number];

/**
 * What each scan IS, and what it changes if you scan it more or less. This lives beside the
 * resolver rather than in the UI on purpose — the screen and the scheduler must describe the
 * same thing, and a description that drifts from the code is worse than none.
 */
export const SCAN_INFO: Record<ScanKind, {
  label: string; listDef: string; what: string; affects: string; costPerScan: string; quietWhen: string;
}> = {
  planned: {
    label: 'Planned / unplanned',
    listDef: '77128',
    what: 'Every open order — on a route or waiting to be planned. Carries the route name, the delivery sequence, the driver, and the live status.',
    affects: 'The board itself, and EVERY flag. A stop with no route is skipped by the flag engine entirely, so nothing can be judged until this scan has seen it planned. Also drives the no-driver card and "route has started".',
    costPerScan: '1 NuVizz call',
    quietWhen: 'Mid-day, while trucks are running and the plan is not being edited.',
  },
  completed: {
    label: 'Completed',
    listDef: '77131',
    what: 'Stops that have finished — delivered, refused, cancelled — with the delivery timestamp.',
    affects: 'ETA accuracy. Each delivery stamp RE-ANCHORS the route clock: until this scan sees it, the engine still projects from the last known position, so every remaining stop on that truck reads late by however long the stamp went unseen. Scanning this harder is the single best thing for flag accuracy during the delivery day.',
    costPerScan: '1 NuVizz call',
    quietWhen: 'Overnight — nothing is delivering, so a pull can only come back empty.',
  },
  roster: {
    label: 'Load roster',
    listDef: '35833',
    what: "The day's authoritative list of loads: route name, status, stop count, and the per-day loadId (a recurring route like \"BEN 2\" gets a NEW id every day). Also the only place an EMPTY load shows up — one created but not yet filled with orders, which the stop-grouped Loads view cannot display because it has no stops to group.",
    affects: "Two things. It is what lets the board tell yesterday's \"BEN 2\" from today's, so a prior-day instance of a recurring route cannot bleed onto today. And it is what the flag engine uses to spot TWO LIVE LOADS SHARING ONE ROUTE NAME — which raises a red flag AND makes the engine refuse to judge that route at all, because a merged sequence would produce confident wrong ETAs. Without it those route-level checks report \"not checked\" rather than clean.",
    costPerScan: '1 NuVizz call — and it is cached, so the Loads view and the board read it for free afterwards',
    quietWhen: 'Any time the load list is not changing — it only needs to be right once the day is built.',
  },
};

/**
 * HOW OFTEN THE SCANNER WAKES, and how much jitter a fire is allowed.
 *
 * The cron used to wake every 15 minutes with a 7-minute tolerance. Chad asked for
 * planned/unplanned every 20 minutes between midnight
 * and 5am — and on a 15-minute cron there is no such thing as 20: it snaps to 15, so the box
 * would have said 20 while the system did 15. A screen that lies about a number you typed is
 * worse than a screen that refuses it.
 *
 * At a 5-minute step every interval a dispatcher would actually reach for lands exactly:
 * 15→15, 20→20, 30→30, 45→45, 60→60. The tolerance has to come down with it — it exists to
 * absorb cron jitter and is meant to be about half the step, and at 7 on a 5-minute cron a
 * 15-minute rule would fire every 10.
 *
 * The cost is Netlify invocations (288/day instead of 96), not NuVizz calls: a fire that is
 * not due does two Firestore reads and returns.
 */
export const CRON_STEP_MIN = 5;
export const CRON_TOLERANCE_MIN = 2;

export interface ScanRule {
  /** Stable id so the UI can key rows and edits survive re-ordering. */
  id?: string;
  kind: ScanKind;
  /** ET weekdays this rule covers. 0=Sun … 6=Sat. */
  days: number[];
  /** ET hour the window opens (inclusive) and closes (exclusive). Wraps midnight when start > end. */
  startHour: number;
  endHour: number;
  /** Target minutes between scans of this kind inside the window. */
  intervalMin: number;
  enabled?: boolean;
  /** Free-text, so a row can say WHY it exists. */
  note?: string;
}

/**
 * THE HARD ANTI-THRASH FLOOR, in minutes — nuvizz-request's MIN_SCAN_INTERVAL_MS, restated
 * here because scan-schedule.mts already imports THIS module and the dependency cannot run
 * both ways. Read from the same env var so the two can never disagree.
 *
 * It matters to the plan because scanDecision refuses any fire inside the floor with
 * skip='floor', and overrideCadenceSkip deliberately does NOT override that one. So a rule
 * tighter than the floor is a number the editor accepts and the scanner will not deliver.
 */
export const HARD_FLOOR_MIN = Math.max(
  1,
  Math.round((Number(process.env.NUVIZZ_MIN_SCAN_INTERVAL_MS) || 10 * 60 * 1000) / 60000),
);

/** Safe bounds. The interval floor is the LARGER of the cron step and the hard anti-thrash
 *  floor — anything tighter is a number the box accepts and the system cannot deliver, which
 *  is worse than refusing it outright. It used to be the cron step alone (5), so the editor
 *  would take a 5-minute rule, `effectiveCadence` would report 5 back, and the scanner would
 *  then hold every one of those fires at the 10-minute floor. A screen that lies about a
 *  number you typed is the thing CRON_STEP_MIN was raised to avoid; this is the same defect
 *  one layer down. */
export const RULE_BOUNDS = {
  intervalMin: [Math.max(CRON_STEP_MIN, HARD_FLOOR_MIN), 720] as [number, number],
  hour: [0, 24] as [number, number],
};
/** More than this many rules is a table nobody can reason about, not a schedule. */
export const MAX_RULES = 40;

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * THE SHIPPED PLAN — Chad's schedule, verbatim.
 *
 * Planned/unplanned is his, band for band: "every 30 mins from 8pm–12am, then every 20 mins
 * from 12am to 5am, and every 15 mins from 5am to 10am, then every 30 mins from 10am to 8pm."
 * The 20-minute band is why the cron moved to a 5-minute step — see CRON_STEP_MIN.
 *
 * Completed is his too, and is the decoupling this feature exists for: "every 30 mins from
 * 4-6am, 6am to 7pm every 15 mins, 7pm-4am not at all" — plus one sweep 7-10pm for the tail
 * of a long day. Nine hours a day with no call at all,
 * because nothing is delivering then and the pull could only come back empty.
 *
 * Roster drops to hourly. It was being pulled on every one of the ~33 fires a day for a list
 * that only changes when somebody creates a load; that reclaim pays for most of the extra
 * completed sampling.
 *
 * DAY ASSIGNMENT: an evening band belongs to the night BEFORE a delivery day (Sun–Thu), and a
 * small-hours band to the morning OF one (Mon–Fri). Friday evening and Saturday are therefore
 * quiet, because Saturday delivers nothing.
 */
export function defaultScanRules(): ScanRule[] {
  const deliveryDays = [1, 2, 3, 4, 5];         // Mon-Fri — days freight actually moves
  const routingNights = [0, 1, 2, 3, 4];        // Sun-Thu evenings — the night before one
  const allDays = [0, 1, 2, 3, 4, 5, 6];        // the roster is about PLANNING, not delivering
  return [
    // ── planned / unplanned (77128) — Chad's bands ───────────────────────────
    { id: 'plan-eve', kind: 'planned', days: routingNights, startHour: 20, endHour: 24, intervalMin: 30, note: 'Routing opens — routes are being built for tomorrow.' },
    { id: 'plan-small-hours', kind: 'planned', days: deliveryDays, startHour: 0, endHour: 5, intervalMin: 20, note: 'Routing runs late; the plan is still moving.' },
    { id: 'plan-rollout', kind: 'planned', days: deliveryDays, startHour: 5, endHour: 10, intervalMin: 15, note: 'Trucks rolling and dispatch still editing — the plan changes fastest here.' },
    { id: 'plan-day', kind: 'planned', days: deliveryDays, startHour: 10, endHour: 20, intervalMin: 30, note: 'Running day — the plan is largely settled.' },
    // ── completed (77131) — the ETA anchor. Chad's bands. ────────────────────
    { id: 'done-early', kind: 'completed', days: deliveryDays, startHour: 4, endHour: 6, intervalMin: 30, note: 'First trucks rolling — a few early deliveries.' },
    { id: 'done-run', kind: 'completed', days: deliveryDays, startHour: 6, endHour: 19, intervalMin: 15, note: 'The delivery day — every stamp re-anchors a route clock.' },
    // ONE sweep across the late window — a 3-hour band at a 3-hour interval fires exactly
    // once, which catches a long day's last deliveries without paying 15-minute rates for
    // three hours that usually carry a handful of stops.
    { id: 'done-late', kind: 'completed', days: deliveryDays, startHour: 19, endHour: 22, intervalMin: 180, note: 'One sweep for the tail of a long day.' },
    // 10pm-4am: NOT PULLED. Nothing is delivering, so the call can only come back empty.
    // ── load roster (35833) — EVERY DAY, and here is why it is not shaped like the others ──
    //
    // Chad, twice, on a Saturday looking at Tuesday: "Where are all my empty loads" and then
    // "the loads use to populate just fine." They did. Before v0.77.0 (2026-08-24) the roster
    // was pulled UNCONDITIONALLY inside every scan of every date — `await persistLoadRoster(...)`
    // with no gate on it — so any fire at all refreshed the empty loads. v0.77.0 put it behind
    // this plan to reclaim calls, and drew its windows the way the other two are drawn: around
    // the DELIVERY day. roster-am was Mon-Fri 04:00-13:00 and roster-eve Sun-Thu 20:00-24:00.
    //
    // That is the right shape for planned and completed and the WRONG shape for this one. The
    // other two describe freight moving; this one describes what a dispatcher can still fill,
    // and he plans on Saturday afternoons and on weekday afternoons — precisely the hours those
    // two rules left uncovered. The holes it left: every weekday 13:00-20:00, and from Friday
    // 13:00 all the way to Monday 04:00, a sixty-three hour freeze across the weekend he does
    // his planning in. The board showed him whatever Friday lunchtime had seen, for three days,
    // with nothing on screen admitting it.
    //
    // ONE RULE, ALL SEVEN DAYS, 04:00-24:00, hourly — no uncovered hour to reason about. The
    // cost is the argument: this is the cheapest call the scanner makes (one list pull, cached
    // afterwards), and 20 fires a day across 7 days is ~20 calls/day against a 2,000 ceiling.
    // Before v0.77.0 the same list cost ~33 a day. So restoring it is 40% CHEAPER than the
    // behaviour it restores, not new spend — which is why it ships on rather than behind a
    // switch. (Saturday additionally needs the blackout carve-out below; a rule alone cannot
    // reach a day on which no scan fires at all.)
    { id: 'roster-day', kind: 'roster', days: allDays, startHour: 4, endHour: 24, intervalMin: 60, note: 'The empty loads are the planning surface — a dispatcher reading next week on a Saturday needs them as much as a Tuesday morning does.' },
  ];
}

const clampInt = (v: any, lo: number, hi: number): number | null => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
};

/** PURE. Validate + clamp an untrusted rules array. Anything unusable is DROPPED, not fixed
 *  into something plausible — a rule nobody wrote should not end up scanning the vendor. */
export function clampScanRules(input: any): ScanRule[] {
  if (!Array.isArray(input)) return [];
  const out: ScanRule[] = [];
  for (const r of input.slice(0, MAX_RULES)) {
    if (!r || typeof r !== 'object') continue;
    const kind = String(r.kind || '') as ScanKind;
    if (!SCAN_KINDS.includes(kind)) continue;
    const days = Array.isArray(r.days)
      ? [...new Set(r.days.map((d: any) => clampInt(d, 0, 6)).filter((d: any) => d != null))].sort() as number[]
      : [];
    if (!days.length) continue;
    const startHour = clampInt(r.startHour, 0, 23);
    const endHour = clampInt(r.endHour, 1, 24);
    const intervalMin = clampInt(r.intervalMin, RULE_BOUNDS.intervalMin[0], RULE_BOUNDS.intervalMin[1]);
    if (startHour == null || endHour == null || intervalMin == null) continue;
    if (startHour === endHour) continue;   // a zero-width window is a typo, not a schedule
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id.slice(0, 64) : `r${out.length + 1}`,
      kind, days, startHour, endHour, intervalMin,
      enabled: r.enabled !== false,
      ...(typeof r.note === 'string' && r.note ? { note: r.note.slice(0, 160) } : {}),
    });
  }
  return out;
}

/** PURE. Does this rule's window contain the hour? Windows wrap midnight when start > end. */
export function ruleCoversHour(rule: ScanRule, hour: number): boolean {
  const { startHour: s, endHour: e } = rule;
  return s < e ? (hour >= s && hour < e) : (hour >= s || hour < e);
}

/**
 * PURE. The effective interval for one scan kind at one ET weekday+hour, or null when no rule
 * covers it (= that scan does not run then).
 *
 * TIGHTEST WINS where rules overlap — see the header. A disabled rule contributes nothing.
 *
 * NOTE ON WRAPPING WINDOWS: `days` is matched against the day the HOUR falls on, not the day
 * the window opened. A Friday 20:00→02:00 rule therefore covers Friday 20:00-23:59 only; to
 * carry it into Saturday morning, include Saturday in the row. That is the reading that
 * survives being explained to somebody looking at the grid — the hour is coloured by the day
 * it is in, and any other rule makes the preview lie.
 */
export function resolveInterval(kind: ScanKind, weekday: number, hour: number, rules: ScanRule[]): number | null {
  let best: number | null = null;
  for (const r of rules || []) {
    if (r.enabled === false) continue;
    if (r.kind !== kind) continue;
    if (!r.days.includes(weekday)) continue;
    if (!ruleCoversHour(r, hour)) continue;
    if (best == null || r.intervalMin < best) best = r.intervalMin;
  }
  return best;
}

/** PURE. The whole week resolved, for the preview grid: grid[kind][weekday][hour] = min | null. */
export function resolveWeekGrid(rules: ScanRule[]): Record<ScanKind, Array<Array<number | null>>> {
  const out: any = {};
  for (const kind of SCAN_KINDS) {
    out[kind] = WEEKDAYS.map((wd) => Array.from({ length: 24 }, (_, h) => resolveInterval(kind, wd, h, rules)));
  }
  return out;
}

/**
 * PURE. What this plan costs, so the spend consequence of an edit is visible before saving.
 *
 * Counts one NuVizz call per scan of each kind, at the cadence that will ACTUALLY be
 * achieved rather than the one typed (see effectiveCadence) — an estimate that flatters the
 * plan is worse than no estimate. Enrichment (/stop/info on genuinely new PROs) is on top of
 * this and is not schedulable, so it is deliberately not counted here.
 */
export function estimatePlanCalls(rules: ScanRule[], cronStepMin = CRON_STEP_MIN): {
  perDay: number[]; perWeek: number; byKind: Record<ScanKind, number>; busiestDay: number;
} {
  const perDay = WEEKDAYS.map(() => 0);
  const byKind: any = {}; for (const k of SCAN_KINDS) byKind[k] = 0;
  for (const kind of SCAN_KINDS) {
    for (const wd of WEEKDAYS) {
      for (let h = 0; h < 24; h++) {
        const iv = resolveInterval(kind, wd, h, rules);
        if (iv == null) continue;
        // Effective cadence quantises UP to the cron step (see effectiveCadence).
        const scansThisHour = 60 / effectiveCadence(iv, cronStepMin);
        perDay[wd] += scansThisHour;
        byKind[kind] += scansThisHour;
      }
    }
  }
  const rounded = perDay.map((n) => Math.round(n));
  for (const k of SCAN_KINDS) byKind[k] = Math.round(byKind[k]);
  return {
    perDay: rounded,
    perWeek: rounded.reduce((a, b) => a + b, 0),
    byKind,
    busiestDay: rounded.indexOf(Math.max(...rounded)),
  };
}

/**
 * PURE. What a requested interval ACTUALLY becomes.
 *
 * The scanner wakes on a fixed cron — every `cronStepMin` minutes — and on each wake asks
 * whether enough time has passed. So the achievable cadence only comes in whole cron steps,
 * and a requested interval is rounded UP to the next one. At the 5-minute step every interval
 * worth typing lands exactly (15, 20, 30, 45, 60); only an off-step number like 22 moves, and
 * the UI shows what it will really be so the number on screen is the number you get.
 */
export function effectiveCadence(intervalMin: number, cronStepMin = CRON_STEP_MIN, toleranceMin = CRON_TOLERANCE_MIN): number {
  const steps = Math.max(1, Math.ceil((intervalMin - toleranceMin) / cronStepMin));
  return steps * cronStepMin;
}

/**
 * PURE. Which scans are DUE on this fire.
 *
 * Same elapsed-time discipline the single-cadence scanner already uses, per kind: the cron
 * wakes on its own rhythm and rarely lands on the minute, so gating on "is it :00" silently
 * no-ops a fire that arrives at :01. Gating on time elapsed since that KIND last ran makes an
 * on-cadence fire count even when it lands a few minutes late.
 *
 * `lastByKind` is the durable per-kind stamp. A kind that has never run reads as due — a fresh
 * deploy should scan, not wait an hour to discover it is allowed to.
 */
export function dueKinds(
  weekday: number,
  hour: number,
  rules: ScanRule[],
  lastByKind: Partial<Record<ScanKind, string | null>> = {},
  nowMs: number = 0,
  toleranceMin = CRON_TOLERANCE_MIN,
): Record<ScanKind, { due: boolean; intervalMin: number | null; elapsedMin: number; reason: string }> {
  const out: any = {};
  for (const kind of SCAN_KINDS) {
    const intervalMin = resolveInterval(kind, weekday, hour, rules);
    if (intervalMin == null) {
      out[kind] = { due: false, intervalMin: null, elapsedMin: Infinity, reason: 'no rule covers this hour' };
      continue;
    }
    const lastMs = lastByKind?.[kind] ? Date.parse(String(lastByKind[kind])) : NaN;
    const elapsedMin = Number.isFinite(lastMs) ? (nowMs - lastMs) / 60000 : Infinity;
    const due = elapsedMin >= intervalMin - toleranceMin;
    out[kind] = {
      due,
      intervalMin,
      elapsedMin,
      reason: due
        ? `due (${elapsedMin === Infinity ? 'never run' : Math.round(elapsedMin) + 'm'} >= ${intervalMin}-${toleranceMin})`
        : `not due (${Math.round(elapsedMin)}m < ${intervalMin}-${toleranceMin})`,
    };
  }
  return out;
}

/**
 * THE LEGACY SINGLE-CADENCE GATE CAN SILENCE THE WHOLE PLAN, AND IT WAS DOING SO.
 *
 * Chad, at 10:45am on a delivery day, reading a status card where Loads, Orders AND
 * Completed all showed the identical "22 min ago": "I thought at this time of day we were on
 * 15 min scans." He was right to expect that — done-run (6am-7pm) is 15 minutes in
 * defaultScanRules — and the card was telling the truth about what actually ran.
 *
 * WHY ALL THREE MATCHED. refresh-stops-core computes an outer `ScanDecision` FIRST, via the
 * pre-decoupling scanDecision()/intervalForHour() in scan-schedule.mts — a single global
 * cadence (30 min in the day band, by default) measured against elapsedMin since
 * lastLoadScanAt SPECIFICALLY. Only once that gate says "act" does the function go on to ask
 * dueKinds() which of planned/completed/roster actually wants to run this tick.
 *
 * The completed-only overlay does not touch lastLoadScanAt — it never calls writeStops, only
 * applyCompletionPatches/markScanKinds/markCompletedScan. So once a full (planned) scan resets
 * lastLoadScanAt, the outer gate stays closed for the FULL legacy interval (~23-28 minutes
 * after tolerance) on every 5-minute cron tick — and while it is closed, the function returns
 * before dueKinds is ever consulted. The completed rule's own 15-minute promise never gets a
 * chance to fire on its own: it can only ever piggyback on whatever the outer load-cadence
 * gate allows through, which is why the observed cadence tracked the OLD 30-minute band
 * instead of the new 15-minute one, and why the three stamps landed on the same age — nothing
 * ran in between at all.
 *
 * THE FIX IS NARROW ON PURPOSE. Only the 'cadence' skip reason is overridable — that is the
 * one driven by the legacy single-interval math this plan replaced. 'weekend' (the Fri
 * 22:00-Sun 20:00 blackout) and 'floor' (the hard 10-minute anti-thrash minimum) are real
 * safety gates that have nothing to do with which kind is due, and stay in force exactly as
 * written; a manual scan already bypasses this function entirely via `isManual`, so it is
 * untouched here too.
 */
/** The four things a cron fire can turn into. */
export type ScanPath = 'skip' | 'roster-only' | 'completed-overlay' | 'full';

/**
 * PURE. WHICH PATH THIS FIRE TAKES — the one place that decides, so no combination of due-ness
 * can fall through to something nobody chose.
 *
 * refresh-stops-core used to spell this out inline as three `if`s and an implicit else, and the
 * else was the FULL board rebuild. Two of the eight combinations landed there by accident:
 *
 *   • roster due, nothing else — the plan drops the load roster to hourly precisely so it stops
 *     riding along on every fire, and a roster-only fire then paid for a whole planned rebuild
 *     plus its enrichment. The reclaim that was supposed to fund the 15-minute completed
 *     sampling never happened.
 *   • roster due at 04:00–05:59 — worse, because the roster branch carried its own
 *     `etHour >= 6` gate from before this plan existed. `roster-am` opens at 04:00, so
 *     `rosterDue` went true at four in the morning and the branch that would have STAMPED it
 *     refused to run. Nothing cleared it, so every fire for two hours fell through to a full
 *     rebuild — measured at 10 rebuilds between 04:00 and 06:00 against the 6 the plan asks
 *     for, on a board of ~700 stops.
 *
 * Order is by cost and by what supersedes what: a full scan rebuilds the board and so already
 * carries whatever the completed overlay would have applied; the overlay is one call and can
 * only mark existing stops finished; the roster is one cheap list call and touches no stops at
 * all. Nothing due = nothing runs, which is the whole point of a plan with uncovered hours.
 */
export function scanPath(
  act: boolean,
  due: { plannedDue: boolean; completedDue: boolean; rosterDue: boolean },
): ScanPath {
  if (!act) return 'skip';
  if (due.plannedDue) return 'full';
  if (due.completedDue) return 'completed-overlay';
  if (due.rosterDue) return 'roster-only';
  return 'skip';
}

/**
 * PURE. May the LOAD ROSTER — and nothing else — run during the weekend blackout?
 *
 * The blackout (Fri 22:00 → Sun 20:00 ET) stops scheduled scans because Davis is not
 * delivering, and for planned and completed that is exactly right: nothing is moving, so those
 * pulls can only come back unchanged. The roster is a different question. It lists the loads
 * that EXIST, it is one cheap list call, and Saturday is when next week gets planned — so the
 * blackout was silently taking away the one thing a dispatcher is on the board for at the
 * weekend. Chad found it the only way left: "the loads use to populate just fine."
 *
 * DELIBERATELY NOT `overrideCadenceSkip` WITH ANOTHER SKIP REASON ADDED. That function flips
 * `act`, and a flipped `act` is handed to scanPath, which asks plannedDue FIRST and answers
 * 'full' — a whole board rebuild plus enrichment, on a day nothing is delivering, the moment
 * anybody adds a Saturday planned rule to the stored config. The cost rule in CLAUDE.md exists
 * because of exactly that class of accident. So this returns a narrow permission instead: the
 * caller uses it to run the roster pull and to force the 'roster-only' path directly, and it
 * refuses the moment either expensive kind is also due.
 *
 * Returns false unless ALL of: the scan is skipping, the reason is the weekend blackout, the
 * roster is due, and neither planned nor completed is.
 */
export function rosterMayRunOnBlackout(
  decision: { act: boolean; skip: string },
  plannedDue: boolean,
  completedDue: boolean,
  rosterDue: boolean,
): boolean {
  if (!decision || decision.act) return false;          // already running; nothing to carve out
  if (decision.skip !== 'weekend') return false;        // the floor and cadence are not ours
  if (!rosterDue) return false;
  if (plannedDue || completedDue) return false;         // never let an expensive kind ride along
  return true;
}

export function overrideCadenceSkip<T extends { act: boolean; skip: string; reason: string }>(
  decision: T,
  plannedDue: boolean,
  completedDue: boolean,
  rosterDue: boolean,
): T {
  if (decision.act) return decision;
  if (decision.skip !== 'cadence') return decision;
  if (!(plannedDue || completedDue || rosterDue)) return decision;
  return {
    ...decision,
    act: true,
    skip: 'none',
    reason: `plan override (planned=${plannedDue} completed=${completedDue} roster=${rosterDue}); legacy gate said: ${decision.reason}`,
  };
}
