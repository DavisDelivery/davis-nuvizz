// manifest-schedule.test.mjs
//
// THE MODULE THAT KEEPS THE SCREEN AND THE JOB TELLING THE SAME STORY.
//
// The parse narrowed from every-30-minutes to three evening passes and the Manifest check tab
// went on printing "Checked automatically every 30 minutes" in two places. These tests pin the
// two things that made that possible: that the hours have ONE home, and that the card's
// staleness signal is computed against the schedule rather than against a raw age.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PARSE_HOURS_ET, PARSE_SCHEDULE_LABEL, isParseHour, etStamp, lastParseSlot, parsePollOverdue,
} from '../src/lib/manifest-schedule.js';
import { PARSE_HOURS_ET as JOB_HOURS } from '../netlify/functions/manifest-email-ingest-background.mts';

const at = (iso) => new Date(iso);

test('the job and the screen read the SAME hours — one module, not two lists', () => {
  assert.deepEqual(JOB_HOURS, PARSE_HOURS_ET);
  assert.deepEqual(PARSE_HOURS_ET, [20, 21, 22]);
  // The sentence the card prints names every hour the job actually runs. This is the assertion
  // that would have failed on the change that left the tab saying "every 30 minutes".
  for (const label of ['8:10p', '9:10p', '10:10p']) {
    assert.ok(PARSE_SCHEDULE_LABEL.includes(label), `${label} missing from "${PARSE_SCHEDULE_LABEL}"`);
  }
  assert.ok(!/30 minutes/.test(PARSE_SCHEDULE_LABEL));
});

test('only the three evening hours are parse hours', () => {
  for (let h = 0; h < 24; h += 1) assert.equal(isParseHour(h), [20, 21, 22].includes(h));
});

test('a missing or malformed stamp is null, NOT the epoch', () => {
  // `new Date(null)` is 1969, a perfectly valid Date — the bug that once painted a stale
  // warning on a card that had simply never carried a timestamp.
  for (const bad of [null, undefined, '', 'not a date', NaN]) assert.equal(etStamp(bad), null);
  assert.equal(etStamp('2026-09-10T00:46:00Z'), '2026-09-09T20:46');
});

test('the last pass is found on the ET clock, in both seasons', () => {
  // EDT: 8:46p ET is 00:46Z the next day. The 8:10p pass has fired.
  assert.equal(lastParseSlot(at('2026-09-10T00:46:00Z')), '2026-09-09T20:10');
  // EST: 8:46p ET on Jan 14 is 01:46Z on the 15th. Same answer on the ET calendar.
  assert.equal(lastParseSlot(at('2026-01-15T01:46:00Z')), '2026-01-14T20:10');
  // 11:30p ET, after all three.
  assert.equal(lastParseSlot(at('2026-09-10T03:30:00Z')), '2026-09-09T22:10');
});

test('before tonight\'s first pass, the last pass is YESTERDAY at 10:10p — not "none"', () => {
  // 2pm ET. A card that treated "no pass today" as "nothing to compare against" would go
  // quiet for the entire working day, which is when somebody is actually looking at it.
  assert.equal(lastParseSlot(at('2026-09-09T18:00:00Z')), '2026-09-08T22:10');
  // And 8:00p, still inside the last quiet stretch.
  assert.equal(lastParseSlot(at('2026-09-10T00:00:00Z')), '2026-09-08T22:10');
});

test('the grace window keeps the card quiet while the pass is still running', () => {
  // 8:12p ET — the cron fired two minutes ago and the function is fetching the mailbox. The
  // 8:10p pass must NOT count as missed yet, or the card cries wolf every night at 8:11.
  assert.equal(lastParseSlot(at('2026-09-10T00:12:00Z')), '2026-09-08T22:10');
  // 8:31p — eleven minutes past the grace, and now it counts.
  assert.equal(lastParseSlot(at('2026-09-10T00:31:00Z')), '2026-09-09T20:10');
});

test('overdue means a pass fired and the mailbox was not read — not merely "old"', () => {
  const twoPm = at('2026-09-10T18:00:00Z');
  // Read at 10:12p last night, now 2pm: 16 hours old and perfectly healthy. Under the old
  // every-30-minutes cadence this age WOULD have meant something was broken; it no longer does,
  // and a card that still read it that way would be red every afternoon.
  assert.equal(parsePollOverdue('2026-09-10T02:12:00Z', twoPm), false);
  // Read the night BEFORE last: three passes have fired since. That is the dead token.
  assert.equal(parsePollOverdue('2026-09-09T02:12:00Z', twoPm), true);
});

test('a mailbox that has never polled is not overdue', () => {
  // Connected this afternoon, nothing has run yet. The card says "No poll has run yet",
  // which is the honest sentence; a red warning here would be a lie about a working setup.
  assert.equal(parsePollOverdue(null, at('2026-09-10T18:00:00Z')), false);
  assert.equal(parsePollOverdue('', at('2026-09-10T18:00:00Z')), false);
});

test('DST cannot move the slot onto the wrong ET day', () => {
  // Spring forward, 2027-03-14: the night before loses an hour at 2am. A slot computed by
  // subtracting 24 hours of milliseconds from an ET wall time would land on the wrong day.
  assert.equal(lastParseSlot(at('2027-03-14T18:00:00Z')), '2027-03-13T22:10');   // 2pm EDT
  // Fall back, 2026-11-01: the night before gains one.
  assert.equal(lastParseSlot(at('2026-11-01T19:00:00Z')), '2026-10-31T22:10');   // 2pm EST
  // And the evening of each changeover day still resolves its own passes.
  assert.equal(lastParseSlot(at('2027-03-15T00:46:00Z')), '2027-03-14T20:10');
  assert.equal(lastParseSlot(at('2026-11-02T01:46:00Z')), '2026-11-01T20:10');
});
