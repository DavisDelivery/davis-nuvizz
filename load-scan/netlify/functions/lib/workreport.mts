// workreport.mts — the numbers, and an honest account of what they mean.
//
// Two readers, and they want different things from the same rows:
//
//   the logistics manager   "is the dock running well tonight, and who is stuck"
//   the data analyst        "give me clean rows I can group and compare"
//
// So this builds ONE dataset with per-load rows as the grain, and derives the
// manager's rollups from it. The analyst gets the same rows as CSV. Nothing is
// computed twice by two different rules, which is how two dashboards start
// disagreeing about the same night.
//
// ── METRICS THAT LIE, AND WHAT IS USED INSTEAD ───────────────────────────────
//
// "Minutes per load" is the number everyone asks for first and it is close to
// meaningless on its own: a 6-stop truck and a 30-stop truck are not the same
// job. Ranking loaders by it just ranks them by which trucks they were handed.
//
// So minutes-per-load is reported, because it answers "how long is that truck
// taking right now", but the COMPARATIVE metric is pieces per hour, which
// normalises for the size of the work. Stops per hour is carried too, because a
// stop is a separate placement in the trailer and thirty small stops is more
// work than six pallets of the same count.
//
// Where a duration was inferred from scan timestamps rather than measured from
// real start/finish events, the row says so. An inferred duration is a FLOOR —
// it cannot see the time before the first successful scan — and averaging floors
// with measurements silently understates how long the work takes.

import { minutesBetween, type WorkSession, type Assignment } from './worklog.mts';
import { isScheduledShift, shiftLabel } from './shift.mts';

export interface LoadRow {
  shiftDay: string;
  loadNbr: string;
  routeName: string | null;
  worker: string;
  workerName: string;
  role: string;
  assigned: boolean;
  assignedTo: string[];
  startedAt: string;
  finishedAt: string;
  minutes: number | null;
  /** 'events' = measured, 'derived' = a floor inferred from scans. */
  timing: 'events' | 'derived' | 'none';
  pieces: number;
  expectedPieces: number;
  stops: number;
  closedOut: boolean;
  /** Closed with fewer pieces than the manifest called for. */
  short: number;
  piecesPerHour: number | null;
  stopsPerHour: number | null;
  status: 'complete' | 'in_progress' | 'short' | 'not_started';
}

export interface WorkerRollup {
  worker: string;
  workerName: string;
  role: string;
  loads: number;
  pieces: number;
  stops: number;
  firstStart: string;
  lastFinish: string;
  /** Sum of per-load durations — time on trucks, not shift length. */
  workingMinutes: number;
  /** lastFinish - firstStart. Includes gaps between trucks. */
  spanMinutes: number | null;
  avgMinutesPerLoad: number | null;
  piecesPerHour: number | null;
  /** How many of this worker's loads had measured rather than inferred timing. */
  measuredLoads: number;
}

export interface ShiftReport {
  shiftDay: string;
  label: string;
  scheduled: boolean;
  rows: LoadRow[];
  workers: WorkerRollup[];
  totals: {
    loads: number;
    loadsStarted: number;
    loadsComplete: number;
    pieces: number;
    workers: number;
    assignedNotStarted: number;
    workedWithoutApp: number;
  };
  /** Loads assigned to someone that nobody ever opened. The absence IS the finding. */
  notStarted: Array<{ loadNbr: string; assignedTo: string[] }>;
  /** Loads with freight on them but no work session — someone loaded without the app. */
  offApp: Array<{ loadNbr: string; reason: string }>;
}

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function perHour(count: number, minutes: number | null): number | null {
  if (!minutes || minutes <= 0 || !count) return null;
  // Under two minutes the rate explodes into a meaningless number — a single
  // scan a minute after start would read as 60 pieces/hour. Withhold it rather
  // than publish a figure nobody should act on.
  if (minutes < 2) return null;
  return round((count / minutes) * 60, 1);
}

/**
 * Build one shift day's report.
 *
 * @param shiftDay     YYYY-MM-DD, labelled by the morning the shift ends
 * @param sessions     work sessions recorded for that shift day
 * @param assignments  what the dispatcher handed out, by load number
 * @param loads        the board: [{loadNbr, routeName, expectedPieces, stopCount, sessionPieces}]
 */
export function buildShiftReport(
  shiftDay: string,
  sessions: WorkSession[],
  assignments: Record<string, Assignment>,
  loads: Array<{
    loadNbr: string;
    routeName?: string | null;
    expectedPieces?: number;
    stopCount?: number;
    scannedPieces?: number;
    hasSession?: boolean;
  }>,
): ShiftReport {
  const byLoad = new Map(loads.map((l) => [String(l.loadNbr), l]));
  const rows: LoadRow[] = [];

  for (const s of sessions || []) {
    const load = byLoad.get(String(s.loadNbr));
    const assignment = (assignments || {})[String(s.loadNbr)];
    const minutes = minutesBetween(s.startedAt, s.finishedAt);
    const expected = Number(load?.expectedPieces ?? 0) || 0;
    const stops = Number(load?.stopCount ?? 0) || 0;
    const pieces = Number(s.pieces ?? 0) || 0;

    const timing: LoadRow['timing'] = s.startedAt && s.finishedAt ? s.source : 'none';
    const short = expected > 0 && s.closedOut && pieces < expected ? expected - pieces : 0;

    let status: LoadRow['status'] = 'in_progress';
    if (!s.startedAt) status = 'not_started';
    else if (short > 0) status = 'short';
    else if (s.closedOut) status = 'complete';

    rows.push({
      shiftDay,
      loadNbr: String(s.loadNbr),
      routeName: load?.routeName ?? null,
      worker: s.worker,
      workerName: s.workerName || s.worker,
      role: s.role || 'driver',
      assigned: !!assignment,
      assignedTo: assignment?.loaders ?? [],
      startedAt: s.startedAt || '',
      finishedAt: s.finishedAt || '',
      minutes,
      timing,
      pieces,
      expectedPieces: expected,
      stops,
      closedOut: !!s.closedOut,
      short,
      piecesPerHour: perHour(pieces, minutes),
      stopsPerHour: perHour(stops, minutes),
      status,
    });
  }

  // Assigned, and nobody ever opened it. This is the row a manager scans for
  // first, and it exists precisely because there is NO session to find.
  const worked = new Set(rows.map((r) => r.loadNbr));
  const notStarted = Object.values(assignments || {})
    .filter((a) => !worked.has(a.loadNbr))
    .map((a) => ({ loadNbr: a.loadNbr, assignedTo: a.loaders || [] }))
    .sort((a, b) => a.loadNbr.localeCompare(b.loadNbr));

  // Freight moved but the app was never used on it. Distinct from "not started":
  // this truck went out, it just went out unrecorded.
  const offApp = (loads || [])
    .filter((l) => !worked.has(String(l.loadNbr)) && !assignments?.[String(l.loadNbr)])
    .map((l) => ({
      loadNbr: String(l.loadNbr),
      reason: l.hasSession ? 'scans exist but no work session' : 'no app activity at all',
    }))
    .sort((a, b) => a.loadNbr.localeCompare(b.loadNbr));

  // ── Per-worker rollup ──────────────────────────────────────────────────────
  const byWorker = new Map<string, WorkerRollup>();
  for (const r of rows) {
    const cur =
      byWorker.get(r.worker) ??
      ({
        worker: r.worker,
        workerName: r.workerName,
        role: r.role,
        loads: 0,
        pieces: 0,
        stops: 0,
        firstStart: '',
        lastFinish: '',
        workingMinutes: 0,
        spanMinutes: null,
        avgMinutesPerLoad: null,
        piecesPerHour: null,
        measuredLoads: 0,
      } as WorkerRollup);

    cur.loads += 1;
    cur.pieces += r.pieces;
    cur.stops += r.stops;
    if (r.minutes != null) cur.workingMinutes += r.minutes;
    if (r.timing === 'events') cur.measuredLoads += 1;
    if (r.startedAt && (!cur.firstStart || r.startedAt < cur.firstStart)) cur.firstStart = r.startedAt;
    if (r.finishedAt && r.finishedAt > cur.lastFinish) cur.lastFinish = r.finishedAt;
    byWorker.set(r.worker, cur);
  }

  const workers = [...byWorker.values()].map((w) => {
    const timed = rows.filter((r) => r.worker === w.worker && r.minutes != null);
    return {
      ...w,
      spanMinutes: minutesBetween(w.firstStart, w.lastFinish),
      avgMinutesPerLoad: timed.length ? round(w.workingMinutes / timed.length, 1) : null,
      piecesPerHour: perHour(w.pieces, w.workingMinutes),
    };
  });
  workers.sort((a, b) => b.pieces - a.pieces || a.workerName.localeCompare(b.workerName));

  rows.sort((a, b) => (a.startedAt || '~').localeCompare(b.startedAt || '~'));

  return {
    shiftDay,
    label: shiftLabel(shiftDay),
    scheduled: isScheduledShift(shiftDay),
    rows,
    workers,
    totals: {
      loads: byLoad.size,
      loadsStarted: rows.filter((r) => r.startedAt).length,
      loadsComplete: rows.filter((r) => r.status === 'complete').length,
      pieces: rows.reduce((n, r) => n + r.pieces, 0),
      workers: workers.length,
      assignedNotStarted: notStarted.length,
      workedWithoutApp: offApp.length,
    },
    notStarted,
    offApp,
  };
}

/** CSV of the per-load rows — the analyst's grain, one row per person per load. */
export function toCsv(reports: ShiftReport[]): string {
  const head = [
    'shift_day', 'shift_scheduled', 'load_nbr', 'route', 'worker', 'worker_name', 'role',
    'assigned', 'assigned_to', 'started_at', 'finished_at', 'minutes', 'timing_source',
    'pieces', 'expected_pieces', 'stops', 'closed_out', 'short_by', 'pieces_per_hour',
    'stops_per_hour', 'status',
  ];
  const esc = (v: any) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.join(',')];
  for (const rep of reports) {
    for (const r of rep.rows) {
      lines.push(
        [
          r.shiftDay, rep.scheduled, r.loadNbr, r.routeName ?? '', r.worker, r.workerName, r.role,
          r.assigned, (r.assignedTo || []).join(' '), r.startedAt, r.finishedAt,
          r.minutes ?? '', r.timing, r.pieces, r.expectedPieces, r.stops, r.closedOut,
          r.short, r.piecesPerHour ?? '', r.stopsPerHour ?? '', r.status,
        ]
          .map(esc)
          .join(','),
      );
    }
  }
  return lines.join('\n');
}
