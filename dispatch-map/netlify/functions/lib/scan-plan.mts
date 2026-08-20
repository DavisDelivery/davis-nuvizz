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
    what: "The day's authoritative list of loads and their per-day loadIds.",
    affects: "Keeps yesterday's instance of a recurring route (yesterday's \"BEN 2\") from bleeding onto today's board. It does NOT feed the flags. Best-effort: if it fails, the board is left unchanged.",
    costPerScan: '1 NuVizz call',
    quietWhen: 'Any time the load list is not changing — it only needs to be right once the day is built.',
  },
};

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

/** Safe bounds. The interval floor is 15 minutes because the scanner's cron wakes every 15 —
 *  see effectiveCadence. Anything tighter is a number the box accepts and the system cannot
 *  deliver, which is worse than refusing it. */
export const RULE_BOUNDS = {
  intervalMin: [15, 720] as [number, number],
  hour: [0, 24] as [number, number],
};
/** More than this many rules is a table nobody can reason about, not a schedule. */
export const MAX_RULES = 40;

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The shipped plan. Reproduces the single-cadence behaviour this replaces (30m in 04:00–12:59,
 * 60m otherwise, no scanning Sat / Fri night / Sun morning) for `planned` and `roster`, and
 * applies the one change the decoupling is FOR: completed is pulled hard through the delivery
 * day and left alone overnight, when it could only come back empty.
 */
export function defaultScanRules(): ScanRule[] {
  const weekdays = [1, 2, 3, 4, 5];
  return [
    // ── planned / unplanned ──────────────────────────────────────────────────
    { id: 'plan-routing', kind: 'planned', days: [0, 1, 2, 3, 4], startHour: 20, endHour: 24, intervalMin: 15, note: 'Routing evening — the plan is being built, so watch it closely.' },
    { id: 'plan-overnight', kind: 'planned', days: weekdays, startHour: 0, endHour: 4, intervalMin: 60, note: 'Overnight — routing tails off.' },
    { id: 'plan-day', kind: 'planned', days: weekdays, startHour: 4, endHour: 13, intervalMin: 30, note: 'Morning — dispatch edits, and the ~10am order drop.' },
    { id: 'plan-pm', kind: 'planned', days: weekdays, startHour: 13, endHour: 20, intervalMin: 60, note: 'Afternoon — the plan is largely settled.' },
    // ── completed ────────────────────────────────────────────────────────────
    { id: 'done-run', kind: 'completed', days: weekdays, startHour: 4, endHour: 20, intervalMin: 15, note: 'The delivery day — every stamp re-anchors a route clock.' },
    { id: 'done-tail', kind: 'completed', days: weekdays, startHour: 20, endHour: 22, intervalMin: 60, note: 'Late deliveries closing out.' },
    // ── roster ───────────────────────────────────────────────────────────────
    { id: 'roster-am', kind: 'roster', days: weekdays, startHour: 4, endHour: 13, intervalMin: 60, note: 'Enough to keep yesterday’s routes off today’s board.' },
    { id: 'roster-pm', kind: 'roster', days: weekdays, startHour: 20, endHour: 24, intervalMin: 60, note: 'Tomorrow’s loads appear during routing.' },
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
export function estimatePlanCalls(rules: ScanRule[], cronStepMin = 15): {
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
 * and a requested interval is rounded UP to the next one: ask for 40 with a 15-minute cron
 * and you get 45. The UI shows this so the number on screen is the number you get.
 */
export function effectiveCadence(intervalMin: number, cronStepMin = 15, toleranceMin = 7): number {
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
  toleranceMin = 7,
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
