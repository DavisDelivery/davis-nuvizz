// worklog.mts — who worked which truck, when they started, when they finished.
//
// ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
//
// Three questions from the office, none of which the app could answer before:
//
//   "How long is a truck taking?"        -> duration per load, per person
//   "How many did they do last night?"   -> loads and pieces per shift
//   "Are the drivers even using it?"     -> the ABSENCE of a record is the answer
//
// ── WHY A SEPARATE RECORD AT ALL ─────────────────────────────────────────────
//
// The scan-session doc already knows who touched a load and when (mergeWorker
// keeps firstAt/lastAt per person). That is enough for "who" and roughly enough
// for "how long", but not for the two things the office actually asked for:
//
//   1. START means picking up the truck, not the first successful scan. A loader
//      who spends eight minutes finding the freight before the first label reads
//      did eight minutes of work, and firstAt throws it away.
//   2. A load nobody scanned has NO scan session at all, so it is invisible.
//      "Assigned and never started" is precisely the finding a manager wants, and
//      it cannot come from a collection that only contains work that happened.
//
// So the worklog is written from explicit start/finish events, and the report
// falls back to scan timestamps when an event is missing — a phone that died
// mid-truck still leaves a truthful, if coarser, record.
//
// ── REPLAY SAFETY ────────────────────────────────────────────────────────────
//
// The app queues offline and flushes when signal returns, so every write here
// WILL arrive more than once. Sessions are keyed by worker+load and merged, not
// appended: startedAt keeps the earliest value ever seen, finishedAt the latest.
// A replay can therefore never create a second session, and can never inflate a
// duration — the same events always converge on the same answer, in any order.

import { shiftDayOf } from './shift.mts';

export interface WorkSession {
  /** worker + load. Stable across replays; this is what makes merging idempotent. */
  id: string;
  worker: string;
  workerName: string;
  role: string;
  loadNbr: string;
  /** When they picked up the truck. Earliest ever seen. */
  startedAt: string;
  /** When they closed it out, or last touched it. Latest ever seen. */
  finishedAt: string;
  /** True once the load was formally closed, as opposed to merely gone quiet. */
  closedOut: boolean;
  /** Pieces this person scanned on this load. */
  pieces: number;
  /**
   * How the times were obtained, so a report never presents a guess as a
   * measurement:
   *   'events'  explicit start and finish — trustworthy to the minute
   *   'derived' inferred from scan timestamps — a floor, not the real duration
   */
  source: 'events' | 'derived';
}

export function sessionId(worker: string, loadNbr: string): string {
  return `${String(worker || '').trim()}__${String(loadNbr || '').trim()}`;
}

/** Minutes between two ISO instants, or null when either is missing/unparseable. */
export function minutesBetween(a: any, b: any): number | null {
  const t0 = Date.parse(String(a ?? ''));
  const t1 = Date.parse(String(b ?? ''));
  if (Number.isNaN(t0) || Number.isNaN(t1)) return null;
  const min = Math.round((t1 - t0) / 60000);
  // A negative span means clocks disagreed across devices. Report nothing rather
  // than a negative duration that would poison an average.
  return min < 0 ? null : min;
}

/**
 * Merge one incoming event into the set, keyed by worker+load.
 *
 * The merge rules ARE the replay safety, so they are worth stating plainly:
 *   startedAt   earliest wins   — a later replay cannot push the start forward
 *   finishedAt  latest wins     — a re-sent early event cannot cut the work short
 *   closedOut   sticky true     — closing out is not undone by a stale queue item
 *   pieces      max, not sum    — the client sends a running total, so adding
 *                                 would double-count on every flush
 *   source      'events' wins   — a real measurement beats an inference
 */
export function mergeSession(existing: WorkSession[], incoming: Partial<WorkSession>): WorkSession[] {
  const list = (Array.isArray(existing) ? existing : []).map((s) => ({ ...s }));
  const worker = String(incoming.worker ?? '').trim();
  const loadNbr = String(incoming.loadNbr ?? '').trim();
  if (!worker || !loadNbr) return list;

  const id = sessionId(worker, loadNbr);
  const found = list.find((s) => s.id === id);

  if (!found) {
    list.push({
      id,
      worker,
      loadNbr,
      workerName: String(incoming.workerName ?? ''),
      role: String(incoming.role ?? 'driver'),
      startedAt: String(incoming.startedAt ?? ''),
      finishedAt: String(incoming.finishedAt ?? ''),
      closedOut: !!incoming.closedOut,
      pieces: Number(incoming.pieces ?? 0) || 0,
      source: incoming.source === 'events' ? 'events' : 'derived',
    });
    return list;
  }

  const inStart = String(incoming.startedAt ?? '');
  if (inStart && (!found.startedAt || inStart < found.startedAt)) found.startedAt = inStart;

  const inFinish = String(incoming.finishedAt ?? '');
  if (inFinish && inFinish > String(found.finishedAt || '')) found.finishedAt = inFinish;

  if (incoming.closedOut) found.closedOut = true;
  if (incoming.source === 'events') found.source = 'events';
  if (incoming.workerName) found.workerName = String(incoming.workerName);
  if (incoming.role) found.role = String(incoming.role);

  const inPieces = Number(incoming.pieces ?? 0) || 0;
  if (inPieces > found.pieces) found.pieces = inPieces;

  return list;
}

/**
 * Normalize one incoming event from a phone, or explain why it is unusable.
 *
 * The shift day is derived SERVER-SIDE from the event's own timestamp. A phone
 * with a wrong clock, or one flushing a queue at 8:05pm that it filled at 7:50pm,
 * must not be able to file work under the wrong shift.
 */
export function normalizeEvent(raw: any): { session?: Partial<WorkSession>; shiftDay?: string; reason?: string } {
  const worker = String(raw?.worker ?? '').trim();
  if (!worker) return { reason: 'missing worker' };

  const loadNbr = String(raw?.loadNbr ?? '').trim();
  if (!loadNbr) return { reason: `missing loadNbr for worker ${worker}` };

  const kind = String(raw?.kind ?? '').toLowerCase();
  if (kind !== 'start' && kind !== 'finish') return { reason: `kind must be start or finish, got "${kind}"` };

  const atRaw = String(raw?.at ?? '').trim();
  const at = atRaw && !Number.isNaN(Date.parse(atRaw)) ? new Date(atRaw).toISOString() : new Date().toISOString();

  // The shift day comes from the moment the work happened, never from the client.
  const shiftDay = shiftDayOf(at);
  if (!shiftDay) return { reason: `unusable timestamp ${atRaw}` };

  return {
    shiftDay,
    session: {
      worker,
      loadNbr,
      workerName: String(raw?.workerName ?? ''),
      role: String(raw?.role ?? 'driver'),
      startedAt: kind === 'start' ? at : '',
      finishedAt: kind === 'finish' ? at : '',
      closedOut: kind === 'finish' && !!raw?.closedOut,
      pieces: Number(raw?.pieces ?? 0) || 0,
      source: 'events',
    },
  };
}

// ── Assignments ──────────────────────────────────────────────────────────────

export interface Assignment {
  loadNbr: string;
  /** Driver numbers. A list because two people on one truck is normal. */
  loaders: string[];
  assignedBy: string;
  assignedAt: string;
}

/**
 * Apply an assignment change.
 *
 * Assigning an EMPTY loader list removes the assignment rather than storing a
 * load nobody owns — otherwise a dispatcher un-assigning a truck would leave a
 * ghost row that reads as "assigned to no one" in every report.
 */
export function applyAssignment(
  existing: Record<string, Assignment>,
  change: { loadNbr: string; loaders: string[]; assignedBy: string; at?: string },
): Record<string, Assignment> {
  const out: Record<string, Assignment> = { ...(existing || {}) };
  const loadNbr = String(change.loadNbr ?? '').trim();
  if (!loadNbr) return out;

  const loaders = [...new Set((change.loaders || []).map((l) => String(l).trim()).filter(Boolean))];
  if (!loaders.length) {
    delete out[loadNbr];
    return out;
  }

  out[loadNbr] = {
    loadNbr,
    loaders,
    assignedBy: String(change.assignedBy ?? ''),
    assignedAt: change.at || new Date().toISOString(),
  };
  return out;
}

/** The loads assigned to one worker, in load-number order. */
export function loadsFor(assignments: Record<string, Assignment>, worker: string): string[] {
  const w = String(worker ?? '').trim();
  if (!w) return [];
  return Object.values(assignments || {})
    .filter((a) => (a.loaders || []).some((l) => String(l) === w))
    .map((a) => a.loadNbr)
    .sort();
}
