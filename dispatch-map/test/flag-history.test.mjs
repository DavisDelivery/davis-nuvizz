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
import { readFileSync } from 'node:fs';
import {
  mergeSweep, classifyOutcome, scoreRow, summarize, worseTier, flagHistoryPath,
  rollCheckDate, ROLL_LOOKAHEAD_DAYS,
  isDeliveredLate,
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

// ── EVERY FRIDAY WAS PERMANENTLY "UNKNOWN" (bug hunt, Aug 2026) ─────────────

test('a FRIDAY flag is graded against MONDAY — Saturday has no board and never will', () => {
  // "Rolled" vs "never delivered" is decided by whether the stop turned up on a later board,
  // and the scorer asked about day+1 and nothing else. On a Friday that is Saturday, Davis
  // does not run, no board is ever captured — so seenLater was null forever, every Friday
  // flag read "unknown" for good, and needsOutcomeRescore stayed true, so the nightly sweep
  // re-read those days every night until they aged out still ungraded. A fifth of the week
  // could not answer the question the table exists to ask, and nothing went red: a history
  // full of shrugs looks exactly like a quiet week.
  const weekdayBoards = new Set(['2026-08-24']);            // Mon; Sat 22nd + Sun 23rd empty
  assert.equal(rollCheckDate('2026-08-21', (d) => weekdayBoards.has(d)), '2026-08-24');
});

test('an ordinary Tuesday still settles on Wednesday — the walk changes nothing normal', () => {
  const boards = new Set(['2026-08-19', '2026-08-20']);
  assert.equal(rollCheckDate('2026-08-18', (d) => boards.has(d)), '2026-08-19');
});

test('a long holiday weekend is still reachable, and beyond that we say we cannot tell', () => {
  // Fri + a Monday holiday → Tuesday, four days out, which is the real calendar this runs on.
  assert.equal(rollCheckDate('2026-11-27', (d) => d === '2026-12-01'), '2026-12-01');
  // Nothing captured in range is STILL "we cannot tell", not "never delivered". The further
  // out you look the weaker the evidence, so the walk is bounded rather than unlimited.
  assert.equal(rollCheckDate('2026-08-21', () => false), null);
  assert.equal(rollCheckDate('2026-08-21', (d) => d === '2026-09-30'), null, 'a month later proves nothing');
  assert.equal(ROLL_LOOKAHEAD_DAYS, 4);
});

test('AND THEN THE OUTCOME RESOLVES: the same row reads unknown, then rolled', () => {
  const row = { closeMin: 14 * 60, arrivalMin: null, finished: false };
  assert.equal(classifyOutcome({ ...row, seenLater: null }), 'unknown', 'before any later board existed');
  assert.equal(classifyOutcome({ ...row, seenLater: true }), 'rolled', 'once Monday is sealed and carries it');
  assert.equal(classifyOutcome({ ...row, seenLater: false }), 'undelivered', 'or Monday is sealed and does not');
});

// ── DID THE FREIGHT ACTUALLY GET THERE ───────────────────────────────────────
//
// Chad, on the Flag history cards: "need a card here for delivered even though it didn't
// 'made it' make the flag time."
//
// The distinction is the one that costs money. Late is an apology; never-delivered is a truck
// going back out tomorrow. No card told them apart: `missed` covers only the same-day-late
// case, and the roll that delivered first thing next morning — freight the customer HAS — sat
// under `rolled` beside rolls still sitting on a dock.

test('MISSED IS A DELIVERY — late, but the customer has their freight', () => {
  // classifyOutcome reaches 'missed' only WITH a stamp and a close to grade it against. The
  // word reads like a non-delivery next to "Never delivered", which is exactly why the count
  // needed saying out loud.
  assert.equal(classifyOutcome({ closeMin: 900, arrivalMin: 960 }), 'missed');
  assert.equal(isDeliveredLate({ outcome: 'missed' }), true);
});

test('A ROLL COUNTS ONLY ONCE WE CAN PROVE IT DELIVERED', () => {
  // A roll that came back on a later board but has not delivered off it keeps a null stamp
  // for ever. Counting it would dress freight still sitting on a dock as a delivery — the
  // exact thing deliveredWhen's 'open' tone exists to prevent.
  assert.equal(isDeliveredLate({ outcome: 'rolled', rolledDeliveredAt: '2026-08-28T09:12:00' }), true);
  assert.equal(isDeliveredLate({ outcome: 'rolled', rolledDeliveredAt: null }), false);
  assert.equal(isDeliveredLate({ outcome: 'rolled' }), false, 'no stamp is not a delivery');
});

test('on-time, never-delivered and ungradable are all excluded', () => {
  assert.equal(isDeliveredLate({ outcome: 'made' }), false, 'it made the window');
  assert.equal(isDeliveredLate({ outcome: 'undelivered' }), false);
  assert.equal(isDeliveredLate({ outcome: 'unknown' }), false);
  assert.equal(isDeliveredLate(null), false);
  assert.equal(isDeliveredLate(undefined), false);
  assert.equal(isDeliveredLate('missed'), false, 'a string is not a row');
});

test('the summary counts it as a ROLL-UP across two buckets, not a seventh bucket', () => {
  // A day: one on time, two late the same day, one rolled and delivered next morning, one
  // rolled and still sitting, one gone.
  const rows = [
    { outcome: 'made' },
    { outcome: 'missed' },
    { outcome: 'missed' },
    { outcome: 'rolled', rolledDeliveredAt: '2026-08-28T08:40:00' },
    { outcome: 'rolled', rolledDeliveredAt: null },
    { outcome: 'undelivered' },
  ];
  const s = summarize(rows);
  assert.equal(s.deliveredLate, 3, 'two same-day-late plus the roll that landed');
  // The exclusive buckets are untouched — this must not shift any existing number.
  assert.equal(s.made, 1);
  assert.equal(s.missed, 2);
  assert.equal(s.rolled, 2);
  assert.equal(s.undelivered, 1);
  assert.equal(s.flags, 6);
  // The EXCLUSIVE buckets still partition the day exactly — this must not disturb that.
  assert.equal(s.made + s.missed + s.rolled + s.undelivered + s.unknown, s.flags);
  // And deliveredLate is drawn from inside missed+rolled rather than adding a bucket: it is
  // larger than missed alone (so it picked up a roll) and never exceeds the two together.
  assert.ok(s.deliveredLate > s.missed, 'it includes a roll that delivered');
  assert.ok(s.deliveredLate <= s.missed + s.rolled, 'and it invents nothing outside those two');
});

test('a day where everything got there late still reports every delivery', () => {
  const s = summarize([{ outcome: 'missed' }, { outcome: 'missed' }, { outcome: 'missed' }]);
  assert.equal(s.deliveredLate, 3);
});

test('an empty day is zero, not undefined — the card renders a number either way', () => {
  assert.equal(summarize([]).deliveredLate, 0);
  assert.equal(summarize({}).deliveredLate, 0);
});

// ── THE STALE-SUMMARY TRAP ───────────────────────────────────────────────────

test('A DAY SCORED BEFORE THIS FIELD EXISTED MUST NOT REPORT ZERO', () => {
  // The endpoint prefers the summary written at score time. Every day already on file was
  // scored without deliveredLate, so serving the stored summary straight would print a
  // confident 0 on the one card whose job is to say freight DID arrive — the same
  // absence-read-as-evidence error this file has been rescued from before.
  const src = readFileSync(new URL('../netlify/functions/eta-flag-history.mts', import.meta.url), 'utf8');
  assert.match(src, /function summaryFor\(/, 'there is a guard between the stored summary and the screen');
  assert.match(src, /s\.deliveredLate == null\) return summarize\(/, 'a summary missing the field is re-derived');
  assert.ok(!/summary: doc\.summary \?\? summarize/.test(src),
    'no path may serve the stored summary without checking it carries the field');
  // And the range roll-up has to total it, or a multi-day view reads 0 while each day is right.
  assert.match(src, /'gradable', 'deliveredLate'\]/, 'deliveredLate is in TOTAL_KEYS');
});

test('the card is on the screen and reads the field the endpoint sends', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /value=\{t\.deliveredLate \?\? 0\} label="Delivered late"/);
  // Eight tiles now, so the wide grid has to make room or the last one wraps alone.
  assert.match(app, /grid-cols-2 sm:grid-cols-4 xl:grid-cols-8/);
});
