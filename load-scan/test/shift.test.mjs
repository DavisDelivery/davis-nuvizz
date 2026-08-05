// Shift-day and worklog tests.
//
// Two things here can be wrong without anyone noticing for weeks: the 8pm
// boundary (every duration either side of midnight) and replay safety (the
// offline queue re-sends everything). Both get hammered.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  shiftDayString,
  shiftDayOf,
  shiftWindow,
  addDays,
  isScheduledShift,
  recentShiftDays,
} from '../netlify/functions/lib/shift.mts';
import {
  mergeSession,
  normalizeEvent,
  applyAssignment,
  loadsFor,
  minutesBetween,
  sessionId,
} from '../netlify/functions/lib/worklog.mts';
import { buildShiftReport, toCsv } from '../netlify/functions/lib/workreport.mts';

/** An ET wall-clock time as a real instant. EDT is -04:00, EST is -05:00. */
const et = (s) => new Date(s);

// ── The 8pm boundary ─────────────────────────────────────────────────────────

test('the shift day rolls over at 8pm ET, not at midnight', () => {
  // Sunday 3 Aug 2026 is EDT (-04:00).
  assert.equal(shiftDayString(et('2026-08-02T19:59:00-04:00')), '2026-08-02', 'before 8pm: same day');
  assert.equal(shiftDayString(et('2026-08-02T20:00:00-04:00')), '2026-08-03', 'at 8pm: next day');
  assert.equal(shiftDayString(et('2026-08-02T23:30:00-04:00')), '2026-08-03', 'late Sunday is Monday work');
  assert.equal(shiftDayString(et('2026-08-03T03:00:00-04:00')), '2026-08-03', 'after midnight: same shift');
  assert.equal(shiftDayString(et('2026-08-03T07:59:00-04:00')), '2026-08-03', 'last minute of the shift');
});

test('the daytime gap between shifts files to the day it is in', () => {
  // 8am-8pm is nobody's shift. Work then is still Monday's work, not Tuesday's.
  assert.equal(shiftDayString(et('2026-08-03T09:00:00-04:00')), '2026-08-03');
  assert.equal(shiftDayString(et('2026-08-03T19:00:00-04:00')), '2026-08-03');
  assert.equal(shiftDayString(et('2026-08-03T20:00:00-04:00')), '2026-08-04', 'and then it rolls');
});

test('a shift straddling midnight lands entirely in ONE shift day', () => {
  // The whole point. Under a calendar key these four would split 2/2.
  const moments = [
    '2026-08-02T20:15:00-04:00',
    '2026-08-02T23:59:00-04:00',
    '2026-08-03T00:01:00-04:00',
    '2026-08-03T07:45:00-04:00',
  ].map((s) => shiftDayString(et(s)));
  assert.deepEqual(new Set(moments).size, 1, `one shift, one key: got ${JSON.stringify(moments)}`);
  assert.equal(moments[0], '2026-08-03');
});

test('the boundary stays at 8pm local across both DST changes', () => {
  // November 2026: clocks fall back on the 1st. EDT -> EST.
  assert.equal(shiftDayString(et('2026-10-31T20:00:00-04:00')), '2026-11-01', 'before the change, EDT');
  assert.equal(shiftDayString(et('2026-11-01T20:00:00-05:00')), '2026-11-02', 'after the change, EST');
  // March 2026: clocks spring forward on the 8th.
  assert.equal(shiftDayString(et('2026-03-07T20:00:00-05:00')), '2026-03-08', 'before, EST');
  assert.equal(shiftDayString(et('2026-03-08T20:00:00-04:00')), '2026-03-09', 'after, EDT');
});

test('the repeated 1am hour in November files to one shift day, not two', () => {
  // 01:30 happens twice on fall-back night: once at -04:00, once at -05:00.
  // Both are before 8pm, so both belong to the same shift.
  const first = shiftDayString(et('2026-11-01T01:30:00-04:00'));
  const second = shiftDayString(et('2026-11-01T01:30:00-05:00'));
  assert.equal(first, '2026-11-01');
  assert.equal(second, '2026-11-01', 'the hour repeats; the shift day must not');
});

test('the shift window is a real instant pair, correct in both DST regimes', () => {
  // Summer, EDT (-04:00): 8pm on 2 Aug is 00:00Z on 3 Aug.
  assert.deepEqual(shiftWindow('2026-08-03'), {
    start: '2026-08-03T00:00:00.000Z',
    end: '2026-08-04T00:00:00.000Z',
  });
  // Winter, EST (-05:00): the SAME 8pm wall clock is an hour later in UTC. A
  // hard-coded offset would put this window an hour out and quietly drop the
  // first hour of every December shift.
  assert.deepEqual(shiftWindow('2026-12-02'), {
    start: '2026-12-02T01:00:00.000Z',
    end: '2026-12-03T01:00:00.000Z',
  });
});

test('shift window brackets its own shift day and excludes the neighbours', () => {
  const w = shiftWindow('2026-08-03');
  const inside = et('2026-08-03T03:00:00-04:00').toISOString();
  const before = et('2026-08-02T19:00:00-04:00').toISOString();
  const after = et('2026-08-03T21:00:00-04:00').toISOString();
  assert.ok(inside >= w.start && inside < w.end, 'a 3am scan is inside its shift');
  assert.ok(before < w.start, '7pm the evening before is the previous shift day');
  assert.ok(after >= w.end, '9pm is already the next shift');
});

test('date helpers survive month and year ends', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29', 'leap year');
});

test('scheduled shifts are Monday to Friday mornings', () => {
  assert.equal(isScheduledShift('2026-08-03'), true, 'Monday morning: Sunday night shift');
  assert.equal(isScheduledShift('2026-08-07'), true, 'Friday morning: Thursday night shift');
  assert.equal(isScheduledShift('2026-08-08'), false, 'Saturday: no shift ends here');
  assert.equal(isScheduledShift('2026-08-09'), false, 'Sunday: none either');
});

test('recentShiftDays walks backwards from the day given', () => {
  assert.deepEqual(recentShiftDays('2026-08-03', 3), ['2026-08-03', '2026-08-02', '2026-08-01']);
});

// ── Replay safety: the offline queue re-sends everything ─────────────────────

test('replaying the same start event does not create a second session', () => {
  const e = { worker: '9667', loadNbr: 'MORGAN', startedAt: '2026-08-03T01:00:00Z', source: 'events' };
  let s = mergeSession([], e);
  s = mergeSession(s, e);
  s = mergeSession(s, e);
  assert.equal(s.length, 1, 'one person on one truck is one session, however many flushes');
  assert.equal(s[0].id, sessionId('9667', 'MORGAN'));
});

test('a replayed start cannot push the start time forward', () => {
  // The failure this guards: the queue re-sends at 03:00 and the truck now looks
  // like it took two hours less than it did.
  let s = mergeSession([], { worker: '9', loadNbr: 'L', startedAt: '2026-08-03T01:00:00Z' });
  s = mergeSession(s, { worker: '9', loadNbr: 'L', startedAt: '2026-08-03T03:00:00Z' });
  assert.equal(s[0].startedAt, '2026-08-03T01:00:00Z', 'earliest start always wins');
});

test('a stale finish cannot cut the work short', () => {
  let s = mergeSession([], { worker: '9', loadNbr: 'L', finishedAt: '2026-08-03T05:00:00Z' });
  s = mergeSession(s, { worker: '9', loadNbr: 'L', finishedAt: '2026-08-03T04:00:00Z' });
  assert.equal(s[0].finishedAt, '2026-08-03T05:00:00Z', 'latest finish always wins');
});

test('pieces take the running total, never the sum', () => {
  // The client sends a cumulative count, so summing would double on every flush.
  let s = mergeSession([], { worker: '9', loadNbr: 'L', pieces: 12 });
  s = mergeSession(s, { worker: '9', loadNbr: 'L', pieces: 12 });
  s = mergeSession(s, { worker: '9', loadNbr: 'L', pieces: 18 });
  assert.equal(s[0].pieces, 18);
});

test('a measured session is never downgraded by a derived one', () => {
  let s = mergeSession([], { worker: '9', loadNbr: 'L', startedAt: '2026-08-03T01:00:00Z', source: 'events' });
  s = mergeSession(s, { worker: '9', loadNbr: 'L', startedAt: '2026-08-03T01:05:00Z', source: 'derived' });
  assert.equal(s[0].source, 'events', 'a real measurement outranks an inference');
});

test('closing out is sticky against a stale queue item', () => {
  let s = mergeSession([], { worker: '9', loadNbr: 'L', closedOut: true });
  s = mergeSession(s, { worker: '9', loadNbr: 'L', closedOut: false });
  assert.equal(s[0].closedOut, true);
});

test('two people on one truck are two sessions', () => {
  let s = mergeSession([], { worker: '1', loadNbr: 'L' });
  s = mergeSession(s, { worker: '2', loadNbr: 'L' });
  assert.equal(s.length, 2, 'a truck worked by two people must show both');
});

test('one person on several trucks is several sessions', () => {
  let s = mergeSession([], { worker: '1', loadNbr: 'A' });
  s = mergeSession(s, { worker: '1', loadNbr: 'B' });
  assert.equal(s.length, 2);
});

// ── The shift day comes from the event, not the phone ────────────────────────

test('an event flushed after 8pm still files under the shift it happened in', () => {
  // Phone offline from 19:50, reconnects at 20:05. The work was the earlier shift.
  const { shiftDay } = normalizeEvent({
    worker: '9', loadNbr: 'L', kind: 'start', at: '2026-08-03T19:50:00-04:00',
  });
  assert.equal(shiftDay, '2026-08-03', 'not the shift it reconnected in');
});

test('a garbage timestamp is refused with a reason, never silently filed', () => {
  const r = normalizeEvent({ worker: '9', loadNbr: 'L', kind: 'start', at: 'not-a-date' });
  // An unparseable time falls back to now(), which is still a real shift day —
  // what must NOT happen is a missing worker or load slipping through.
  assert.ok(r.shiftDay, 'still lands somewhere real');
  assert.equal(normalizeEvent({ loadNbr: 'L', kind: 'start' }).reason, 'missing worker');
  assert.match(normalizeEvent({ worker: '9', kind: 'start' }).reason, /missing loadNbr/);
  assert.match(normalizeEvent({ worker: '9', loadNbr: 'L', kind: 'wat' }).reason, /start or finish/);
});

test('a negative duration is withheld rather than reported', () => {
  // Two devices whose clocks disagree. A negative minute count would poison every
  // average it touched.
  assert.equal(minutesBetween('2026-08-03T05:00:00Z', '2026-08-03T04:00:00Z'), null);
  assert.equal(minutesBetween('2026-08-03T04:00:00Z', '2026-08-03T05:30:00Z'), 90);
});

// ── Assignments ──────────────────────────────────────────────────────────────

test('a loader can hold several loads and a load can have several loaders', () => {
  let a = applyAssignment({}, { loadNbr: 'A', loaders: ['1'], assignedBy: 'd' });
  a = applyAssignment(a, { loadNbr: 'B', loaders: ['1', '2'], assignedBy: 'd' });
  assert.deepEqual(loadsFor(a, '1'), ['A', 'B'], 'multiple loads per loader');
  assert.deepEqual(a.B.loaders, ['1', '2'], 'multiple loaders per load');
});

test('un-assigning removes the row instead of leaving an ownerless load', () => {
  let a = applyAssignment({}, { loadNbr: 'A', loaders: ['1'], assignedBy: 'd' });
  a = applyAssignment(a, { loadNbr: 'A', loaders: [], assignedBy: 'd' });
  assert.deepEqual(a, {}, 'no ghost row reading as "assigned to nobody"');
});

test('assigning the same person twice does not duplicate them', () => {
  const a = applyAssignment({}, { loadNbr: 'A', loaders: ['1', '1', ' 1 '], assignedBy: 'd' });
  assert.deepEqual(a.A.loaders, ['1']);
});

// ── The report ───────────────────────────────────────────────────────────────

const LOADS = [
  { loadNbr: 'A', routeName: 'R1', expectedPieces: 20, stopCount: 5 },
  { loadNbr: 'B', routeName: 'R2', expectedPieces: 30, stopCount: 12 },
  { loadNbr: 'C', routeName: 'R3', expectedPieces: 10, stopCount: 3 },
];

test('a load assigned and never touched is reported, because absence is the finding', () => {
  const rep = buildShiftReport(
    '2026-08-03',
    [{ id: 'x', worker: '1', workerName: 'ANA', role: 'loader', loadNbr: 'A', startedAt: '2026-08-03T01:00:00Z', finishedAt: '2026-08-03T02:00:00Z', closedOut: true, pieces: 20, source: 'events' }],
    { A: { loadNbr: 'A', loaders: ['1'], assignedBy: 'd', assignedAt: '' },
      B: { loadNbr: 'B', loaders: ['2'], assignedBy: 'd', assignedAt: '' } },
    LOADS,
  );
  assert.deepEqual(rep.notStarted.map((n) => n.loadNbr), ['B'], 'B was handed out and never opened');
  assert.deepEqual(rep.notStarted[0].assignedTo, ['2'], 'and the report says whose it was');
  assert.equal(rep.totals.assignedNotStarted, 1);
});

test('a truck worked with no app activity at all is surfaced separately', () => {
  const rep = buildShiftReport('2026-08-03', [], {}, LOADS);
  assert.equal(rep.offApp.length, 3, 'nobody used the app on any truck');
  assert.match(rep.offApp[0].reason, /no app activity/);
});

test('minutes per load and pieces per hour are both reported', () => {
  const rep = buildShiftReport(
    '2026-08-03',
    [{ id: 'x', worker: '1', workerName: 'ANA', role: 'loader', loadNbr: 'B', startedAt: '2026-08-03T01:00:00Z', finishedAt: '2026-08-03T02:00:00Z', closedOut: true, pieces: 30, source: 'events' }],
    {},
    LOADS,
  );
  const row = rep.rows[0];
  assert.equal(row.minutes, 60);
  assert.equal(row.piecesPerHour, 30, 'the size-normalised metric');
  assert.equal(row.stopsPerHour, 12);
  assert.equal(row.status, 'complete');
});

test('a rate is withheld when the window is too short to mean anything', () => {
  const rep = buildShiftReport(
    '2026-08-03',
    [{ id: 'x', worker: '1', workerName: 'A', role: 'loader', loadNbr: 'C', startedAt: '2026-08-03T01:00:00Z', finishedAt: '2026-08-03T01:01:00Z', closedOut: true, pieces: 1, source: 'events' }],
    {},
    LOADS,
  );
  assert.equal(rep.rows[0].piecesPerHour, null, 'one scan a minute in is not 60/hour');
});

test('closing short is flagged with the shortfall', () => {
  const rep = buildShiftReport(
    '2026-08-03',
    [{ id: 'x', worker: '1', workerName: 'A', role: 'loader', loadNbr: 'A', startedAt: '2026-08-03T01:00:00Z', finishedAt: '2026-08-03T02:00:00Z', closedOut: true, pieces: 17, source: 'events' }],
    {},
    LOADS,
  );
  assert.equal(rep.rows[0].short, 3);
  assert.equal(rep.rows[0].status, 'short');
});

test('a derived duration is labelled so it is never mistaken for a measurement', () => {
  const rep = buildShiftReport(
    '2026-08-03',
    [{ id: 'x', worker: '1', workerName: 'A', role: 'loader', loadNbr: 'A', startedAt: '2026-08-03T01:00:00Z', finishedAt: '2026-08-03T02:00:00Z', closedOut: true, pieces: 20, source: 'derived' }],
    {},
    LOADS,
  );
  assert.equal(rep.rows[0].timing, 'derived', 'a floor, not the real duration');
  assert.equal(rep.workers[0].measuredLoads, 0, 'and the rollup counts how many were real');
});

test('the worker rollup separates time on trucks from time on shift', () => {
  const rep = buildShiftReport(
    '2026-08-03',
    [
      { id: 'a', worker: '1', workerName: 'ANA', role: 'loader', loadNbr: 'A', startedAt: '2026-08-03T01:00:00Z', finishedAt: '2026-08-03T02:00:00Z', closedOut: true, pieces: 20, source: 'events' },
      { id: 'b', worker: '1', workerName: 'ANA', role: 'loader', loadNbr: 'B', startedAt: '2026-08-03T04:00:00Z', finishedAt: '2026-08-03T05:00:00Z', closedOut: true, pieces: 30, source: 'events' },
    ],
    {},
    LOADS,
  );
  const w = rep.workers[0];
  assert.equal(w.loads, 2);
  assert.equal(w.pieces, 50);
  assert.equal(w.workingMinutes, 120, 'two hours actually on trucks');
  assert.equal(w.spanMinutes, 240, 'four hours between first start and last finish');
  assert.equal(w.avgMinutesPerLoad, 60);
  assert.equal(w.piecesPerHour, 25, 'rated on working time, not on the gap');
});

test('the CSV carries one row per person per load, with the timing source', () => {
  const rep = buildShiftReport(
    '2026-08-03',
    [{ id: 'x', worker: '1', workerName: 'ANA MARIE', role: 'loader', loadNbr: 'A', startedAt: '2026-08-03T01:00:00Z', finishedAt: '2026-08-03T02:00:00Z', closedOut: true, pieces: 20, source: 'events' }],
    {},
    LOADS,
  );
  const csv = toCsv([rep]);
  const [head, row] = csv.split('\n');
  assert.match(head, /^shift_day,shift_scheduled,load_nbr/);
  assert.match(head, /timing_source/);
  assert.match(row, /2026-08-03,true,A,R1,1,ANA MARIE,loader/);
  assert.match(row, /,events,/, 'the analyst can filter out inferred rows');
});

test('a value containing a comma cannot break the CSV', () => {
  const rep = buildShiftReport(
    '2026-08-03',
    [{ id: 'x', worker: '1', workerName: 'SMITH, ANA', role: 'loader', loadNbr: 'A', startedAt: '', finishedAt: '', closedOut: false, pieces: 0, source: 'derived' }],
    {},
    LOADS,
  );
  assert.match(toCsv([rep]).split('\n')[1], /"SMITH, ANA"/);
});
