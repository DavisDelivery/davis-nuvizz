// test/roster-cache-serve.test.mjs
//
// AN EMPTY ANSWER IS AN ANSWER, AND THROWING IT AWAY COST A CALL EVERY TIME.
//
// nuvizz-loads-roster served the cache only when it held rows. So a day NuVizz genuinely
// reports no loads for went LIVE on every read — and the live pull wrote back another empty
// doc, which failed the same test on the next read. It never converged. The client has five
// fetch sites for this endpoint (the Map screen's Routes panel, the Routing rail, the bottom
// grid, and two refresh controls), several re-firing on ordinary UI state, so one such day
// turned every panel toggle into a metered PkgRoute call. Chad, having counted: "each refresh
// is causing like 14 calls when it should only be 3 or 4."
//
// What must NOT be lost is the distinction the old rule was reaching for: "we never pulled
// this day" and "the vendor says none" call for opposite actions and must not read the same.
// That lives in the doc's EXISTENCE now, which is where it always belonged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldServeCachedRoster } from '../netlify/functions/lib/nuvizz-loads.mts';

const etDay = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);
const NOW = new Date('2026-09-05T21:50:00Z');            // 17:50 ET Saturday — Chad's screenshot
const iso = (s) => new Date(s).toISOString();

test('NEVER PULLED goes live — absent is not zero, and it is the one case worth a call', () => {
  assert.equal(shouldServeCachedRoster(null, etDay, NOW), false);
  assert.equal(shouldServeCachedRoster(undefined, etDay, NOW), false);
});

test('a cache WITH ROWS is served whatever its age — the surfaces label the age and offer Refresh', () => {
  const old = { at: iso('2026-08-30T12:00:00Z'), loads: [{ loadId: 'a', name: 'BEN 2' }] };
  assert.equal(shouldServeCachedRoster(old, etDay, NOW), true);
});

test('an EMPTY capture taken today is this scan day’s answer for ONE roster interval — served, free', () => {
  const emptyRecent = { at: iso('2026-09-05T21:20:00Z'), loads: [] };   // 30 min before NOW, same ET day
  assert.equal(shouldServeCachedRoster(emptyRecent, etDay, NOW), true);
});

test('JULY’S FRESHNESS, BOUNDED: an empty capture older than the roster interval is re-asked', () => {
  // Chad: "6 weeks ago there was no issue." v0.52.4 went live on every open of an empty day;
  // v0.93.5 froze the empty until midnight. This is the middle: 59 minutes served, 61 re-asked.
  const t = (minAgo) => ({ at: new Date(NOW.getTime() - minAgo * 60_000).toISOString(), loads: [] });
  assert.equal(shouldServeCachedRoster(t(59), etDay, NOW), true, '59 min: still this hour’s answer');
  assert.equal(shouldServeCachedRoster(t(61), etDay, NOW), false, '61 min: one live re-ask');
  assert.equal(shouldServeCachedRoster(t(240), etDay, NOW), false, 'the 11:37 empty at 15:37 is re-asked, not shown');
});

test('the bound IS the scan plan’s roster cadence — asserted equal so the two cannot drift', async () => {
  const { defaultScanRules } = await import('../netlify/functions/lib/scan-plan.mts');
  const { ROSTER_EMPTY_RECHECK_MIN } = await import('../netlify/functions/lib/nuvizz-loads.mts');
  const rosterIntervals = [...new Set(defaultScanRules().filter((r) => r.kind === 'roster').map((r) => r.intervalMin))];
  assert.deepEqual(rosterIntervals, [ROSTER_EMPTY_RECHECK_MIN], `plan roster interval(s) ${rosterIntervals} must equal the recheck bound`);
});

test('a NON-EMPTY cache is never subject to the bound — rows are served whatever their age', () => {
  const oldRows = { at: iso('2026-09-05T02:00:00Z'), loads: [{ loadId: 'a', name: 'BEN 2' }] };
  assert.equal(shouldServeCachedRoster(oldRows, etDay, NOW), true);
});

test('an EMPTY capture from an earlier ET day is stale AND empty — worth one call', () => {
  const emptyYesterday = { at: iso('2026-09-04T16:00:00Z'), loads: [] };
  assert.equal(shouldServeCachedRoster(emptyYesterday, etDay, NOW), false);
});

test('the ET day boundary is ET, not UTC — 21:00 ET is already tomorrow in UTC', () => {
  // 2026-09-05T01:30:00Z is 21:30 ET on Sep 4. Against a Sep 5 ET "now" that is yesterday,
  // even though the UTC dates read Sep 5 and Sep 5. Anchoring on UTC would serve it.
  const lateEve = { at: '2026-09-05T01:30:00Z', loads: [] };
  assert.equal(shouldServeCachedRoster(lateEve, etDay, NOW), false);
});

test('an unreadable stamp reads as NOT today — never an exception, never the epoch', () => {
  // roster-freshness.js records the sibling of this: new Date(null) is a VALID Date at the
  // epoch, so the obvious NaN guard alone lets a missing stamp through as 1969-12-31.
  for (const at of [null, undefined, '', 'not a date', 0]) {
    assert.equal(shouldServeCachedRoster({ at, loads: [] }, etDay, NOW), false, `at=${JSON.stringify(at)}`);
  }
  // ...and an etDay implementation that throws on a bad Date cannot take the endpoint down.
  const thrower = () => { throw new RangeError('Invalid time value'); };
  assert.doesNotThrow(() => shouldServeCachedRoster({ at: iso('2026-09-05T14:00:00Z'), loads: [] }, thrower, NOW));
  assert.equal(shouldServeCachedRoster({ at: iso('2026-09-05T14:00:00Z'), loads: [] }, thrower, NOW), false);
});

test('a malformed doc with no loads array is not served', () => {
  assert.equal(shouldServeCachedRoster({ at: iso('2026-09-05T21:30:00Z') }, etDay, NOW), true, 'no loads array but a fresh stamp — served as an empty within the bound');
  assert.equal(shouldServeCachedRoster({ loads: undefined }, etDay, NOW), false, 'no rows and no stamp → live');
});
