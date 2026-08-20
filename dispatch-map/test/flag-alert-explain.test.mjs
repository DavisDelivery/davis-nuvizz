// "WHY DID CUSTOMER SERVICE NOT HEAR ABOUT THIS ONE?"
//
// Chad, holding a phone showing an urgent red flag on SIMPLY CHARLOTTE MASON with a
// 10AM-12PM receiving window, at 12:33: "This popped up as an urgent red flag but no email
// was sent to customer service."
//
// Answering that took reading three modules, because nothing in the system could say it.
// Worse, the diagnostic endpoint built precisely to answer it filtered to tier === 'critical'
// — so it could not see a red row either, and reported a clean board. These tests pin the
// answer so it stays a one-request question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldReason, explainStop, normStopNbr, hoursProvenance } from '../netlify/functions/eta-flag-check.mts';
import { selectAlertable, ALERT_TIERS } from '../netlify/functions/lib/flag-alert.mts';

const NOON = 12 * 60;
const row = (o) => ({
  rule: 'hours_risk', tier: 'red', stopNbr: '007164290', customer: 'SIMPLY CHARLOTTE MASON',
  routeName: 'AUBURN', closeMin: NOON, etaMin: NOON + 45, lateBy: 45, anchored: false,
  errorMin: 90, ...o,
});

test('THE CASE ON THE SCREENSHOT: a red flag before the close now emails', () => {
  // This is the regression itself. Before the fix, tier 'red' was dropped outright and this
  // returned zero — the board showed an urgent flag and the inbox stayed empty.
  const got = selectAlertable([row({})], 11 * 60);
  assert.equal(got.length, 1, 'a red row before its close must email');
  assert.equal(got[0].customer, 'SIMPLY CHARLOTTE MASON');
});

test('…and at 12:33, past a noon close, it is held — and SAYS SO', () => {
  // Chad asked for this one explicitly: "Yeah if we are already past the time shouldn't
  // send." So no email here is correct. What was missing was any way to learn that.
  const nowMin = 12 * 60 + 33;
  const got = selectAlertable([row({})], nowMin);
  assert.equal(got.length, 0);
  const why = heldReason(row({}), false, nowMin);
  assert.match(why, /window closed at 12:00p/);
  assert.match(why, /12:33p/);
});

test('the held reason names the tier when the tier is what stopped it', () => {
  const why = heldReason(row({ tier: 'amber' }), false, 11 * 60);
  assert.match(why, /tier is amber/);
  assert.match(why, /critical and red/);
});

test('a collapsed summary row says it is a summary, not a stop', () => {
  assert.match(heldReason(row({ collapsed: 4 }), false, 11 * 60), /collapsed summary row/);
});

test('a row with no receiving close says so rather than blaming the clock', () => {
  assert.match(heldReason(row({ closeMin: null }), false, 11 * 60), /no receiving close/);
});

test('an alertable row has no held reason at all', () => {
  assert.equal(heldReason(row({}), true, 11 * 60), null);
});

// ── explainStop ──────────────────────────────────────────────────────────────

const STOPS = [{ stopNbr: '007164290', businessName: 'SIMPLY CHARLOTTE MASON', status: '10' }];

test('explainStop distinguishes NOT FLAGGED from FLAGGED BUT HELD', () => {
  // The difference is the whole question. "No flag" means the receiving hours never reached
  // the engine — the silent-zero failure. "Flagged but held" means a rule fired. Reporting
  // them the same way is how a broken parser looked like a quiet day.
  const notFlagged = explainStop('007164290', STOPS, [], new Set(), 11 * 60, []);
  assert.equal(notFlagged.found, true);
  assert.equal(notFlagged.flagged, false);
  assert.match(notFlagged.heldBecause, /no receiving close on file/);

  const held = explainStop('007164290', STOPS, [row({})], new Set(), 13 * 60, []);
  assert.equal(held.flagged, true);
  assert.equal(held.tier, 'red');
  assert.match(held.heldBecause, /window closed/);
});

test('explainStop reports an unknown PRO as not on the board', () => {
  const r = explainStop('999999999', STOPS, [], new Set(), 11 * 60, []);
  assert.equal(r.found, false);
  assert.match(r.note, /no stop with that number/);
});

test('explainStop matches the PRO with or without the -1 instance suffix', () => {
  // The card shows "PRO 007164290-1"; the board row carries "007164290". Someone reading a
  // number off a screen must not get "not found" for a stop that is right there.
  const r = explainStop('007164290-1', STOPS, [row({})], new Set(), 11 * 60, []);
  assert.equal(r.found, true);
  assert.equal(r.customer, 'SIMPLY CHARLOTTE MASON');
});

// ── CHAD'S "7165047", 2026-08-20 ─────────────────────────────────────────────
//
// "why was this not flagged to be late it was next to last delivery and closes at 2pm
// 7165047". The endpoint answered "no stop with that number on this board" — three times, on
// three different dates. The stop was on every one of them, as 007165047. A diagnostic that
// cannot find the stop does not return an error; it returns a confident, wrong answer.

test('a PRO typed WITHOUT its leading zeros still finds the stop', () => {
  const padded = [{ stopNbr: '007165047', businessName: 'METRO', status: '10' }];
  const r = explainStop('7165047', padded, [], new Set(), 11 * 60, []);
  assert.equal(r.found, true, 'the number on the paperwork must find the stop in the feed');
  assert.equal(r.customer, 'METRO');
});

test('normStopNbr strips padding and the split-order suffix, and keeps a lone zero', () => {
  assert.equal(normStopNbr('007165047'), '7165047');
  assert.equal(normStopNbr('7165047'), '7165047');
  assert.equal(normStopNbr(' 007165047-1 '), '7165047');
  assert.equal(normStopNbr('0'), '0', 'a real zero must not normalise to empty');
  assert.equal(normStopNbr(null), '');
});

// ── WHY THERE IS NO DEADLINE ─────────────────────────────────────────────────
//
// "close: null" was the whole answer, and it covers four situations with four different
// fixes. Only one of them is an engine problem.

test('hoursProvenance names WHICH way the hours are missing', () => {
  const day = 'thu';
  const withNote = (n) => new Map([['metro|k', n]]);
  const stop = { stopNbr: '007165047', matchKey: 'metro|k' };

  const noKey = hoursProvenance({ stopNbr: '1' }, withNote({}), day);
  assert.equal(noKey.noteOnFile, false);
  assert.match(noKey.why, /no customer match key/);

  const noNote = hoursProvenance(stop, new Map(), day);
  assert.equal(noNote.noteOnFile, false);
  assert.match(noNote.why, /no customer note on file/);
  assert.match(noNote.why, /metro\|k/, 'name the key so the gap is fixable');

  const blankDay = hoursProvenance(stop, withNote({ receiving_hours: { mon: '8-5' } }), day);
  assert.equal(blankDay.noteOnFile, true);
  assert.equal(blankDay.parsed, null);
  assert.match(blankDay.why, /no receiving hours recorded for thu/);

  const freeText = hoursProvenance(stop, withNote({ receiving_hours: { thu: 'call first' } }), day);
  assert.equal(freeText.raw, 'call first');
  assert.equal(freeText.parsed, null);
  assert.match(freeText.why, /not a comparable clock window/);

  const good = hoursProvenance(stop, withNote({ receiving_hours: { thu: { open: '08:00', close: '14:00' } } }), day);
  assert.deepEqual(good.parsed, { open: '8:00a', close: '2:00p', tier: 'auto' });
  assert.equal(good.why, null);
});

test('a stop WITH hours on file that simply is not late says so, and does not blame the data', () => {
  const stops = [{ stopNbr: '007165047', businessName: 'METRO', matchKey: 'metro|k', status: '10' }];
  const notes = new Map([['metro|k', { receiving_hours: { thu: { open: '08:00', close: '14:00' } } }]]);
  const r = explainStop('7165047', stops, [], new Set(), 11 * 60, [], { notes, dayKey: 'thu' });
  assert.equal(r.hours.parsed.close, '2:00p');
  assert.match(r.heldBecause, /receiving hours ARE on file/);

  // …and the same stop with nothing on file blames the data, by name.
  const bare = explainStop('7165047', stops, [], new Set(), 11 * 60, [], { notes: new Map(), dayKey: 'thu' });
  assert.equal(bare.hours.parsed, null);
  assert.match(bare.heldBecause, /no receiving close on file/);
  assert.match(bare.heldBecause, /no customer note on file/);
});

test('an already-emailed stop says THAT, not that it was held', () => {
  // Otherwise "no second email" reads as a failure instead of the once-per-day rule working.
  const r = explainStop('007164290', STOPS, [row({})], new Set(['007164290']), 11 * 60,
    [{ stopNbr: '007164290' }]);
  assert.equal(r.emailedToday, true);
  assert.match(r.heldBecause, /already emailed once today/);
});

test('the explain surface and the alert gate read the SAME tier list', () => {
  // They disagreed once. That disagreement is why a red flag could sit on the board with
  // nothing behind it and no way to find out.
  for (const tier of ALERT_TIERS) {
    assert.equal(selectAlertable([row({ tier })], 11 * 60).length, 1, `${tier} must alert`);
    assert.equal(heldReason(row({ tier }), true, 11 * 60), null);
  }
  assert.match(heldReason(row({ tier: 'amber' }), false, 11 * 60), /only critical and red email/);
});
