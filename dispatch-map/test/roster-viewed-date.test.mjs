// test/roster-viewed-date.test.mjs — THE REFRESH BUTTON FOLLOWS THE BOARD ON SCREEN.
//
// Chad, after an evening of watching his call counter: "I want my schedule to be just what it
// was unless I hit the manual refresh as well as if I have it set for a future date when I hit
// the refresh button it should pull the load roster for that day and the next."
//
// Two rules in one sentence, and they pull in opposite directions on purpose:
//
//   THE SCHEDULE knows nothing about what is on his screen, so it works the standard horizon
//   from today. Widening it is what put 65 vendor calls on a Saturday that used to cost 0.
//
//   THE BUTTON is a person saying "this day, now". It knows exactly which board is open, and
//   that is information the cadence cannot have. So it aims the roster pulls at the day being
//   planned instead of at a horizon anchored on a day he is not looking at.
//
// The cost does not go up: the horizon was already three roster pulls and this is two.
import test from 'node:test';
import assert from 'node:assert/strict';

import { rosterDatesFor, scanDatesFrom } from '../netlify/functions/lib/refresh-stops-core.mts';
import { manualScanUrl } from '../netlify/functions/nuvizz-manual-scan-background.mts';
import { overrideParams } from '../netlify/functions/lib/background-gate.mts';

const TODAY = '2026-09-05';                               // Saturday
const HORIZON = scanDatesFrom(TODAY, 3);                  // ['2026-09-05','2026-09-07','2026-09-08']

test('the horizon this is measured against is the shipped one', () => {
  assert.deepEqual(HORIZON, ['2026-09-05', '2026-09-07', '2026-09-08']);
});

test('A MANUAL PRESS ON A FUTURE BOARD PULLS THAT DAY AND THE NEXT — the whole ask', () => {
  // Monday Sep 7 on screen, pressed on Saturday: Monday and Tuesday, nothing else.
  assert.deepEqual(
    rosterDatesFor(TODAY, HORIZON, { viewedDate: '2026-09-07', isManual: true }),
    ['2026-09-07', '2026-09-08'],
  );
  // And a date beyond the scan horizon entirely still works — that is the point of the button.
  assert.deepEqual(
    rosterDatesFor(TODAY, HORIZON, { viewedDate: '2026-09-10', isManual: true }),
    ['2026-09-10', '2026-09-11'],
  );
});

test('"the next" is the next BUSINESS day — a Saturday entry would buy a day with no loads', () => {
  // Friday on screen → Friday and MONDAY. Davis does not deliver at the weekend, so stepping by
  // calendar day here would spend a call on a day that is empty by construction.
  assert.deepEqual(
    rosterDatesFor(TODAY, HORIZON, { viewedDate: '2026-09-11', isManual: true }),
    ['2026-09-11', '2026-09-14'],
  );
});

test('THE SCHEDULE NEVER FOLLOWS THE SCREEN, whatever it is handed', () => {
  // The cron does not pass viewedDate at all; this pins that even if it somehow did, the
  // scheduled horizon is untouched. Steering the cron by URL is exactly the class of thing
  // the background-gate exists to stop.
  for (const viewedDate of ['2026-09-07', '2026-12-25', null, undefined, '']) {
    assert.deepEqual(rosterDatesFor(TODAY, HORIZON, { viewedDate, isManual: false }), HORIZON,
      `scheduled fire with viewedDate=${viewedDate}`);
  }
});

test('today or the past on screen = the normal horizon, not a two-date narrowing', () => {
  // Looking at today is the ordinary case and it already covers today + the next business day
  // plus one. Narrowing it would quietly REMOVE a date the button used to refresh.
  assert.deepEqual(rosterDatesFor(TODAY, HORIZON, { viewedDate: TODAY, isManual: true }), HORIZON);
  assert.deepEqual(rosterDatesFor(TODAY, HORIZON, { viewedDate: '2026-09-04', isManual: true }), HORIZON);
});

test('a malformed or absent viewedDate silently means "the normal horizon"', () => {
  // A typo must never widen a scan, error the press, or produce a bad Firestore key.
  for (const bad of ['', null, undefined, 'tomorrow', '2026-13-45', '09/07/2026', '2026-09-07T10:00:00Z', '  ']) {
    assert.deepEqual(rosterDatesFor(TODAY, HORIZON, { viewedDate: bad, isManual: true }), HORIZON,
      `viewedDate=${JSON.stringify(bad)}`);
  }
});

// ── THE PARAMETER MAY NOT BECOME A BACK DOOR ────────────────────────────────
//
// `?date=` and `?days=` set `explicit` in runRefreshStops, which flips it into the number-probe
// engine — the ~3,000-metered-call cold scan CLAUDE.md's hard rule forbids. The manual-scan URL
// builder has always discarded them. Adding a second date-shaped parameter is exactly how that
// protection gets undone by accident, so these pin that it did not.

test('viewedDate rides through the manual scan URL — and date/days still cannot', () => {
  const base = 'https://x.netlify.app/.netlify/functions/nuvizz-manual-scan-background';
  assert.equal(manualScanUrl(base + '?viewedDate=2026-09-07'), base + '?manual=1&viewedDate=2026-09-07');
  const probed = manualScanUrl(base + '?date=2026-07-31&days=3&manual=0&viewedDate=2026-09-07');
  assert.ok(!/[?&]date=/.test(probed), 'the number-probe params are still structurally unreachable');
  assert.ok(!/days=/.test(probed));
  assert.ok(/viewedDate=2026-09-07/.test(probed));
  assert.ok(/manual=1/.test(probed));
});

test('a junk viewedDate is DROPPED at the endpoint, not forwarded', () => {
  const base = 'https://x.netlify.app/.netlify/functions/nuvizz-manual-scan-background';
  for (const bad of ['tomorrow', '2026-13-45', '../../etc', '2026-09-07;DROP']) {
    assert.equal(manualScanUrl(`${base}?viewedDate=${encodeURIComponent(bad)}`), base + '?manual=1',
      `viewedDate=${bad} must not survive`);
  }
});

test('viewedDate is NOT a scheduled-override param — it cannot gate the cron', () => {
  // overrideParams matches exact keys. If it ever matched by substring, `viewedDate` would
  // contain `date` and every press would be refused as an override attempt.
  const base = 'https://x.test/.netlify/functions/nuvizz-refresh-stops-background';
  assert.deepEqual(overrideParams(`${base}?manual=1&viewedDate=2026-09-07`, ['date', 'days']), []);
  assert.deepEqual(overrideParams(`${base}?date=2026-09-07`, ['date', 'days']), ['date'], 'the real one still gates');
});
