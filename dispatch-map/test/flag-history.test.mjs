// A HISTORY OF FLAGS, AND WHETHER THEY DID ANY GOOD.
//
// Chad: "I want to build a history of flags... then the time the shipment actually
// delivered. And if the flag allowed us to fix the problem or not before it didn't deliver
// on time or at all and rolled to the next day."
//
// This is measurement code, and measurement code that flatters itself is worse than none —
// which is not a hypothetical here: the last thing built in this repo reported an INTENT as
// an OUTCOME for weeks. So these tests are mostly about what the numbers may NOT claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeSweep, classifyOutcome, scoreRow, summarize, worseTier, flagHistoryPath,
} from '../netlify/functions/lib/flag-history.mts';

import { auditRows } from '../netlify/functions/lib/flag-rows.mts';
import { computeBoardFlags } from '../src/lib/board-flags.js';

const NOON = 12 * 60;
const row = (o = {}) => ({
  rule: 'hours_risk', stopNbr: '007164290', customer: 'SIMPLY CHARLOTTE MASON',
  routeName: 'AUBURN', seq: 4, tier: 'red', closeMin: NOON, etaMin: NOON + 45,
  lateBy: 45, anchored: false, matchKey: 'scm__11_5th_st__auburn__30011', ...o,
});
const sweep = (existing, rows, nowMin, opts = {}) =>
  mergeSweep(existing, rows, { nowMin, atISO: `2026-08-19T${String(Math.floor(nowMin / 60)).padStart(2, '0')}:00:00Z`, ...opts });

// ── FIRST SIGHTING ───────────────────────────────────────────────────────────

test('the first sighting is what the table is FOR, so it is never overwritten', () => {
  // How much warning we got is the whole question. If a later sweep could rewrite
  // firstSeenMin, every flag would eventually report as "we only just found out".
  let { rows } = sweep(null, [row({ tier: 'amber', etaMin: NOON + 10, lateBy: 10 })], 9 * 60 + 40);
  ({ rows } = sweep(rows, [row({ tier: 'critical', etaMin: NOON + 90, lateBy: 90 })], 11 * 60 + 20));

  const r = rows['007164290'];
  assert.equal(r.firstSeenMin, 9 * 60 + 40, 'first sighting must survive');
  assert.equal(r.firstTier, 'amber', 'first tier must survive');
  assert.equal(r.firstEtaMin, NOON + 10);
  assert.equal(r.lastSeenMin, 11 * 60 + 20);
  assert.equal(r.worstTier, 'critical', 'worst is a max over the day');
  assert.equal(r.worstLateBy, 90);
  assert.equal(r.sweeps, 2);
});

test('lead time is how long we had — and stays NEGATIVE when we were already too late', () => {
  // A flag raised after the window shut is not a warning. Clamping this to zero, or
  // dropping it, would quietly turn "nobody could have acted" into "we warned them".
  const early = sweep(null, [row({})], 9 * 60).rows['007164290'];
  assert.equal(early.leadMin, 180, 'flagged at 9:00 against a noon close = 3 hours of warning');

  const late = sweep(null, [row({})], 12 * 60 + 33).rows['007164290'];
  assert.equal(late.leadMin, -33, 'flagged 33 minutes after the close');
});

test('the worst tier is a maximum, not the most recent', () => {
  assert.equal(worseTier('amber', 'red'), 'red');
  assert.equal(worseTier('critical', 'amber'), 'critical', 'a calmer later sweep must not erase it');
  assert.equal(worseTier('red', 'critical'), 'critical');
  assert.equal(worseTier('amber', 'amber'), 'amber');
});

// ── WHAT GETS RECORDED AT ALL ────────────────────────────────────────────────

test('only receiving-hours risks are tracked — the other rules have no on-time question', () => {
  // "No map location" and "duplicate number" are real flags, but they predict nothing about
  // arrival. Their outcome column could only ever read "unknown", which would be noise in a
  // table whose entire purpose is the outcome column.
  const { rows } = sweep(null, [
    row({ rule: 'no_location', stopNbr: 'a' }),
    row({ rule: 'dup_number', stopNbr: 'b' }),
    row({ rule: 'closed_today', stopNbr: 'c' }),
    row({ stopNbr: 'd' }),
  ], 9 * 60);
  assert.deepEqual(Object.keys(rows), ['d']);
});

test('a collapsed summary row is not a stop and is never recorded', () => {
  assert.deepEqual(Object.keys(sweep(null, [row({ collapsed: 3 })], 9 * 60).rows), []);
  assert.deepEqual(Object.keys(sweep(null, [row({ stopNbr: null })], 9 * 60).rows), []);
});

// ── EVIDENCE SOMEBODY ACTED ──────────────────────────────────────────────────

test('a stop that moved route or position after the flag is marked acted-on', () => {
  // The closest honest signal that the flag did something: a human moved the freight.
  let { rows } = sweep(null, [row({ routeName: 'AUBURN', seq: 8 })], 9 * 60);
  assert.equal(rows['007164290'].actedOn, false, 'nothing has happened yet');

  ({ rows } = sweep(rows, [row({ routeName: 'AUBURN', seq: 2 })], 10 * 60));
  assert.equal(rows['007164290'].actedOn, true, 'resequenced earlier');
  assert.equal(rows['007164290'].firstSeq, 8, 'where it started is still on the record');
  assert.equal(rows['007164290'].lastSeq, 2);
});

test('a route change counts as acted-on too, and the flag stays acted-on afterwards', () => {
  let { rows } = sweep(null, [row({ routeName: 'AUBURN' })], 9 * 60);
  ({ rows } = sweep(rows, [row({ routeName: 'LAWRENCEVILLE' })], 10 * 60));
  assert.equal(rows['007164290'].actedOn, true);
  // Moving it back must not read as "nobody did anything".
  ({ rows } = sweep(rows, [row({ routeName: 'AUBURN' })], 11 * 60));
  assert.equal(rows['007164290'].actedOn, true, 'acted-on is sticky');
});

test('a stop sitting still is NOT marked acted-on', () => {
  let { rows } = sweep(null, [row({})], 9 * 60);
  ({ rows } = sweep(rows, [row({})], 10 * 60));
  ({ rows } = sweep(rows, [row({})], 11 * 60));
  assert.equal(rows['007164290'].actedOn, false);
});

test('whether it emailed is carried through and never un-set', () => {
  let { rows } = sweep(null, [row({})], 9 * 60);
  assert.equal(rows['007164290'].emailed, false);
  ({ rows } = sweep(rows, [row({})], 10 * 60, { emailedStops: new Set(['007164290']) }));
  assert.equal(rows['007164290'].emailed, true);
  ({ rows } = sweep(rows, [row({})], 11 * 60));
  assert.equal(rows['007164290'].emailed, true, 'a later quiet sweep must not erase the send');
});

// ── WHAT ACTUALLY HAPPENED ───────────────────────────────────────────────────

test('made / missed are decided against the close, not against the estimate', () => {
  assert.equal(classifyOutcome({ closeMin: NOON, arrivalMin: NOON - 48 }), 'made');
  assert.equal(classifyOutcome({ closeMin: NOON, arrivalMin: NOON }), 'made', 'exactly on the close counts');
  assert.equal(classifyOutcome({ closeMin: NOON, arrivalMin: NOON + 1 }), 'missed');
});

test('ROLLED is the case Chad named, and it needs evidence from outside the day', () => {
  // "didn't deliver on time or at all and rolled to the next day". A stop with no stamp is
  // only "rolled" if it turns up again later; otherwise we know it did not deliver and we
  // do NOT know it came back, which is a different, honest answer.
  assert.equal(classifyOutcome({ closeMin: NOON, arrivalMin: null, seenLater: true }), 'rolled');
  assert.equal(classifyOutcome({ closeMin: NOON, arrivalMin: null, seenLater: false }), 'undelivered');
});

test('"never delivered" is only claimed once we have LOOKED at the day it would return on', () => {
  // Scoring last night's flags before tonight's capture exists would label every genuine
  // roll as "never delivered" — the harsher answer, and the wrong one. Not-yet-known has
  // to stay distinguishable from known-absent.
  assert.equal(classifyOutcome({ closeMin: NOON, arrivalMin: null, seenLater: null }), 'unknown');
  assert.equal(classifyOutcome({ closeMin: NOON, arrivalMin: null }), 'unknown');
});

test('an ungradable stop says unknown rather than being scored as a win', () => {
  // No close on file: the arrival cannot be compared to anything. Calling that "made"
  // because nobody complained is exactly the flattery this table must not do.
  assert.equal(classifyOutcome({ closeMin: null, arrivalMin: NOON }), 'unknown');
  assert.equal(classifyOutcome({ closeMin: null, arrivalMin: null, seenLater: false }), 'undelivered');
  // Finished with no usable stamp — cancelled, or an exception. Not a miss, not a win.
  assert.equal(classifyOutcome({ closeMin: NOON, arrivalMin: null, finished: true }), 'unknown');
});

test('scoreRow attaches the outcome without disturbing the observation', () => {
  const { rows } = sweep(null, [row({})], 9 * 60);
  const scored = scoreRow(rows['007164290'], {
    arrivalMin: 11 * 60 + 12, deliveredAt: '2026-08-19T15:12:00Z', scoredAt: '2026-08-20T08:00:00Z',
  });
  assert.equal(scored.outcome, 'made');
  assert.equal(scored.arrivalMin, 11 * 60 + 12);
  assert.equal(scored.firstSeenMin, 9 * 60, 'the observation is untouched');
  assert.equal(scored.leadMin, 180);
});

// ── THE DAY IN ONE LINE ──────────────────────────────────────────────────────

const scored = (o) => ({ ...sweep(null, [row(o.row || {})], o.at ?? 9 * 60).rows['007164290'], ...o });

test('the summary counts outcomes without inventing a success rate', () => {
  const s = summarize([
    scored({ outcome: 'made' }), scored({ outcome: 'made' }),
    scored({ outcome: 'missed' }), scored({ outcome: 'rolled' }),
    scored({ outcome: 'undelivered' }), scored({ outcome: 'unknown' }),
  ]);
  assert.equal(s.flags, 6);
  assert.equal(s.made, 2);
  assert.equal(s.missed, 1);
  assert.equal(s.rolled, 1);
  assert.equal(s.undelivered, 1);
  assert.equal(s.unknown, 1);
  // Only made+missed are gradable. Rolled and undelivered are outcomes, not grades.
  assert.equal(s.gradable, 3);
  assert.equal(s.missedAfterWarning, 33, '1 of 3 gradable flags still missed');
});

test('a flag raised after the close is counted as too-late, not as a warning', () => {
  // Averaging a post-close flag into "we warned them" is the number-flattering move this
  // whole table exists to avoid.
  const s = summarize([
    scored({ at: 9 * 60, outcome: 'made' }),
    scored({ at: 12 * 60 + 33, outcome: 'missed' }),
  ]);
  assert.equal(s.warned, 1);
  assert.equal(s.tooLateToAct, 1);
  assert.equal(s.medianLeadMin, 180, 'the median ignores the one nobody could act on');
});

test('a day with nothing gradable reports null, not 0% and not 100%', () => {
  // "0% missed" from zero data reads as a perfect day on a dashboard.
  const s = summarize([scored({ outcome: 'rolled' }), scored({ outcome: 'unknown' })]);
  assert.equal(s.missedAfterWarning, null);
  assert.equal(s.gradable, 0);
  assert.equal(summarize([]).flags, 0);
  assert.equal(summarize([]).medianLeadMin, null);
  assert.equal(summarize({}).flags, 0);
});

test('the day path is namespaced by tenant and date', () => {
  assert.equal(flagHistoryPath('davis', '2026-08-19'), 'eta_flag_history/davis__2026-08-19');
});


// ── WHAT THE RECORDING PATH IS ALLOWED TO MISS (bug hunt, Aug 2026) ──────────

test('a DRIVERLESS route lands in flag history — the panel shows one card, the record keeps both', () => {
  // The no-driver card supersedes a driverless route's hours_risk rows, which is right for a
  // screen and an inbox: one situation, one card. It deleted them, and mergeSweep keeps only
  // `hours_risk` — so the routes in the WORST trouble contributed nothing at all to the table
  // that measures whether flagging works. Built from the real engine, not a hand-written row,
  // because the whole failure was in the shape the engine actually emits.
  const stops = [{
    stopNbr: '5', routeSeq: 5, loadNbr: 'SUW', routeName: 'SUW', status: '20',
    normalizedStatus: 'SCHEDULED', isPlanned: true, stopType: 'DO',
    matchKey: 'mck|k', businessName: 'MCNAUGHTON MCKAY ELECTRIC',
    addr1: '1 Main', city: 'Buford', lat: 34.10, lng: -84.00,
  }];
  const notes = new Map([['mck|k', {
    receiving_hours: { mon: { open: '08:00', close: '11:30' } },
    manual_overrides: { receiving_hours: true },
  }]]);
  const flags = computeBoardFlags({
    stops, notes, servedDate: '2026-08-10', dayKey: 'mon', rosterRows: [],
    opts: { depot: { lat: 34.147791, lng: -83.960911 }, departMin: 8 * 60, nowMin: 11 * 60 + 20 },
  });

  assert.equal(flags.rows.filter((r) => r.rule === 'hours_risk').length, 0, 'panel: one card');
  const bare = sweep(null, flags.rows, 11 * 60 + 20).rows;
  assert.deepEqual(Object.keys(bare), [], 'this is the bug: the panel list records nothing');

  const { rows } = sweep(null, auditRows(flags), 11 * 60 + 20);
  assert.deepEqual(Object.keys(rows), ['5']);
  assert.equal(rows['5'].closeMin, 11 * 60 + 30);
  assert.equal(rows['5'].firstSeenMin, 11 * 60 + 20, 'the first sighting is recorded at all');
  assert.equal(rows['5'].leadMin, 10, 'and so is how much warning it gave');
});

test('auditRows is the panel list when nothing was suppressed', () => {
  const flags = { rows: [row()], suppressedRows: [] };
  assert.deepEqual(auditRows(flags), flags.rows);
  assert.deepEqual(auditRows({ rows: [row()] }), flags.rows, 'and it tolerates the field being absent');
  assert.deepEqual(auditRows(null), []);
});
