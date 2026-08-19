// test/flag-outcome-rescore.test.mjs
//
// THE HISTORY THAT COULD ONLY EVER SAY "UNKNOWN".
//
// Chad asked for a flag history that records "if the flag allowed us to fix the problem or
// not before it didn't deliver on time or at all and rolled to the next day." The store, the
// screen and the nightly scorer all shipped (v0.57.0). The one thing it could never answer
// was the half he named out loud.
//
// The arithmetic, all of it from the crons:
//   • the day capture seals day D at 06:00 UTC on D+1
//   • the miss ledger runs 08:00 UTC and scores ET-yesterday, i.e. D
//   • "rolled" needs D+1's sealed board — which will not exist until 06:00 UTC on D+2
// so `seenLater` was null on every scheduled run, classifyOutcome returned 'unknown', and the
// next night's run hit `prior?.version === LEDGER_VERSION` and `continue`d before the flag
// step could ever look again. 'rolled' and 'undelivered' were unreachable outcomes.
//
// Nothing failed. No check went red. A history recording nothing but shrugs looks exactly
// like a week in which nothing went wrong, which is the whole reason this file exists.
//
// PURE — no Firestore, no network, no NuVizz.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  needsOutcomeRescore, pendingOutcomeCount, classifyOutcome, summarize,
} from '../netlify/functions/lib/flag-history.mts';

const row = (over = {}) => ({
  stopNbr: '1283081681', customer: 'SIMPLY CHARLOTTE MASON', matchKey: 'scm|x|monroe|30655',
  firstRoute: 'BEN 2', lastRoute: 'BEN 2', firstSeq: null, lastSeq: null,
  firstSeenMin: 580, firstSeenAt: '2026-08-19T13:40:00Z', lastSeenMin: 900,
  leadMin: 140, closeMin: 720, arrivalMin: null, deliveredAt: null,
  outcome: 'unknown', emailed: true, actedOn: false, ...over,
});
const doc = (rows, over = {}) => ({
  tenant: 'davis', date: '2026-08-19', version: 1,
  rows: Object.fromEntries(rows.map((r) => [r.stopNbr, r])), ...over,
});

// ── WHEN A DAY IS STILL PENDING ──────────────────────────────────────────────

test('THE BUG: a day scored before the next day existed is NOT finished', () => {
  const d = doc([row()], { next_day_captured: false });
  assert.equal(needsOutcomeRescore(d), true,
    'this is every scheduled run before the fix — it must come back');
});

test('a day scored WITH the next day is finished and costs nothing further', () => {
  assert.equal(needsOutcomeRescore(doc([row({ outcome: 'rolled' })], { next_day_captured: true })), false);
  // Even with unknowns left. Once we have actually looked at the day it would have come back
  // on, "unknown" is a verdict (cancelled, exception, no stamp) rather than a missing input —
  // and re-reading a sealed pair of days for ever would be a standing cost for no new answer.
  assert.equal(needsOutcomeRescore(doc([row({ outcome: 'unknown' })], { next_day_captured: true })), false);
});

test('a day with no flags is never revisited', () => {
  for (const d of [null, undefined, {}, doc([]), { rows: {} }]) {
    assert.equal(needsOutcomeRescore(d), false, JSON.stringify(d));
  }
});

test('a day never scored at all is pending, not finished', () => {
  // No next_day_captured field means the nightly run has not reached it — absence of the
  // flag must not read as "resolved", or a day the job missed is silently written off.
  assert.equal(needsOutcomeRescore(doc([row()])), true);
});

test('pendingOutcomeCount counts what is still waiting on evidence', () => {
  const d = doc([
    row({ stopNbr: '1', outcome: 'made' }),
    row({ stopNbr: '2', outcome: 'unknown' }),
    row({ stopNbr: '3', outcome: null }),
    row({ stopNbr: '4', outcome: 'rolled' }),
  ]);
  assert.equal(pendingOutcomeCount(d), 2);
  assert.equal(pendingOutcomeCount(null), 0);
});

// ── THE OUTCOME THE BUG MADE UNREACHABLE ─────────────────────────────────────

test('THE POINT: with the next day in hand, a roll is finally callable', () => {
  const base = { closeMin: 720, arrivalMin: null, finished: false };
  // Before: no capture of D+1 -> null -> the harsher answer withheld, correctly, but for ever.
  assert.equal(classifyOutcome({ ...base, seenLater: null }), 'unknown');
  // After: the sweep revisits once D+1 is sealed, and the two real answers separate.
  assert.equal(classifyOutcome({ ...base, seenLater: true }), 'rolled');
  assert.equal(classifyOutcome({ ...base, seenLater: false }), 'undelivered');
});

test('a stop that arrived is graded on its stamp, capture or no capture', () => {
  assert.equal(classifyOutcome({ closeMin: 720, arrivalMin: 700, seenLater: null }), 'made');
  assert.equal(classifyOutcome({ closeMin: 720, arrivalMin: 740, seenLater: null }), 'missed');
});

test('a finished stop with no usable stamp stays unknown even with the next day', () => {
  // Cancelled or exceptioned. There is no arrival to grade and it did not roll.
  assert.equal(classifyOutcome({ closeMin: 720, arrivalMin: null, finished: true, seenLater: false }), 'unknown');
});

// ── WHAT THE SCREEN WOULD HAVE SHOWN ─────────────────────────────────────────

test('the pending day and the clean day are DIFFERENT, and the summary shows it', () => {
  // The failure this whole change is about: both of these used to reach the screen as a row
  // of zeros under "rolled", and nothing distinguished "nothing rolled" from "we never looked".
  const pending = summarize(doc([row(), row({ stopNbr: '2' })]).rows);
  const clean = summarize(doc([
    row({ stopNbr: '1', outcome: 'made', arrivalMin: 700 }),
    row({ stopNbr: '2', outcome: 'made', arrivalMin: 690 }),
  ]).rows);
  assert.equal(pending.rolled, 0);
  assert.equal(clean.rolled, 0, 'identical in the headline number...');
  assert.equal(pending.unknown, 2);
  assert.equal(clean.unknown, 0, '...and separable only by the unknown count');
  assert.equal(pending.gradable, 0, 'nothing was gradable, so no rate may be quoted');
  assert.equal(pending.missedAfterWarning, null);
  assert.equal(clean.gradable, 2);
});
