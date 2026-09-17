// test/rollback-window.test.mjs — how far back the rollback panel looks.
//
// Chad, with the shipped panel open on his phone: "this is not enough history to roll back what
// if i need to roll back 24-48 hrs".
//
// THE BUG THESE PIN IS A UNIT ERROR, not a number that was too small. The panel offered a fixed
// TWELVE ROWS, which in this repo measures 17.5 HOURS — so neither number he named was reachable.
// A row count means a different amount of history every week, and the week it means least is the
// busy week, which is the week somebody opens this panel. The tests below are named for the
// real-world event, not the function.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  windowRows, windowSummary, rangeHours, ROLLBACK_RANGES, DEFAULT_ROLLBACK_RANGE,
  rollbackTargets,
} from '../src/lib/rollback-targets.js';
import { VERSION_DATES } from '../src/lib/version-dates.js';

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-09-16T20:00:00Z');
/** rows every 4 hours, newest first — 20 of them, so 48h is 13 rows and 24h is 7. */
const ROWS = Array.from({ length: 20 }, (_, i) => ({
  version: `1.0.${19 - i}`,
  at: new Date(NOW - i * 4 * HOUR).toISOString(),
  selectable: i > 0,
}));

test('48 hours of history actually reaches back 48 hours', () => {
  const shown = windowRows(ROWS, { hours: 48, now: NOW });
  const oldest = Date.parse(shown[shown.length - 1].at);
  assert.ok(NOW - oldest >= 47 * HOUR, `only reached back ${(NOW - oldest) / HOUR}h`);
  assert.equal(shown.length, 13);            // 0h..48h inclusive at 4h spacing
});

test('24 hours is a shorter list than 48, and both are longer than the old twelve-row cap covered', () => {
  const a = windowRows(ROWS, { hours: 24, now: NOW });
  const b = windowRows(ROWS, { hours: 48, now: NOW });
  assert.ok(a.length < b.length);
  // the floor still applies, so 24h here is 12 rows rather than 7 — that is the rule, not a bug
  assert.equal(a.length, 12);
});

test('a quiet week still offers something to roll back to', () => {
  // Nothing shipped for ten days. Measured from now the window is EMPTY, and a rollback panel
  // offering nothing to roll back to is broken rather than truthful.
  const stale = ROWS.map((r, i) => ({ ...r, at: new Date(NOW - (10 * 24 + i * 4) * HOUR).toISOString() }));
  const shown = windowRows(stale, { hours: 48, now: NOW });
  assert.equal(shown.length, 12);
  assert.equal(shown[0].version, '1.0.19');
});

test('the window is measured from now, not from the last deploy', () => {
  // Three days since anything shipped. A from-newest reading would hand back a full 48h window
  // and quietly redefine the words on the chip.
  const old = ROWS.map((r) => ({ ...r, at: new Date(Date.parse(r.at) - 3 * 24 * HOUR).toISOString() }));
  assert.equal(windowRows(old, { hours: 48, now: NOW, minRows: 0 }).length, 0);
  assert.equal(windowRows(old, { hours: 48, now: NOW - 3 * 24 * HOUR, minRows: 0 }).length, 13);
});

test('an undated version inside the window is kept, and one below it is not', () => {
  // v1.40.0 is the standing real example: a changelog row that never existed as a running
  // APP_VERSION, so nothing can date it. Filtering row by row would punch a HOLE in the list,
  // and a gap in a rollback list reads as "that version does not exist".
  const rows = [
    { version: '1.0.3', at: new Date(NOW - 1 * HOUR).toISOString() },
    { version: '1.0.2', at: null },                                     // inside — rides its neighbours
    { version: '1.0.1', at: new Date(NOW - 5 * HOUR).toISOString() },
    { version: '1.0.0', at: null },                                     // below the boundary
  ];
  const shown = windowRows(rows, { hours: 6, now: NOW, minRows: 0 });
  assert.deepEqual(shown.map((r) => r.version), ['1.0.3', '1.0.2', '1.0.1']);
});

test('All lifts the ceiling completely — that was the actual complaint', () => {
  assert.equal(windowRows(ROWS, { hours: Infinity, now: NOW }).length, ROWS.length);
  assert.equal(rangeHours('all'), Infinity);
});

test('the default range is 48h, because too short costs him the bad morning and too long costs a scroll', () => {
  assert.equal(DEFAULT_ROLLBACK_RANGE, '48h');
  assert.equal(rangeHours(DEFAULT_ROLLBACK_RANGE), 48);
  assert.ok(ROLLBACK_RANGES.some((r) => r.hours === 24), 'he named 24h explicitly');
  assert.ok(ROLLBACK_RANGES.some((r) => r.hours === 48), 'he named 48h explicitly');
});

test('a garbage range id falls back to the default rather than showing nothing', () => {
  // A stored range from an older build, or a typo, must never empty the panel on a bad morning.
  for (const bad of [undefined, null, '', 'ALL', '90d', 42]) assert.equal(rangeHours(bad), 48);
});

test('malformed input is empty, not a crash', () => {
  for (const bad of [null, undefined, 'nope', 42, {}]) assert.deepEqual(windowRows(bad), []);
  assert.deepEqual(windowRows([]), []);
  // a row whose date is unparseable is treated as undated, never as epoch 0
  assert.equal(windowRows([{ version: '1.0.0', at: 'not-a-date' }], { hours: 48, now: NOW, minRows: 0 }).length, 0);
});

test('the summary reports the oldest DATED row, because that is what answers "does this reach Sunday"', () => {
  const shown = windowRows(ROWS, { hours: 48, now: NOW });
  const s = windowSummary(shown, { total: ROWS.length });
  assert.equal(s.count, 13);
  assert.equal(s.total, 20);
  assert.equal(s.oldestAt, ROWS[12].at);
  assert.equal(s.all, false);
  const everything = windowSummary(ROWS, { total: ROWS.length });
  assert.equal(everything.all, true);
});

test('the summary ignores a trailing undated row rather than claiming it has no dates at all', () => {
  const s = windowSummary([{ version: '1.0.1', at: '2026-09-16T10:00:00Z' }, { version: '1.0.0', at: null }], { total: 2 });
  assert.equal(s.oldestAt, '2026-09-16T10:00:00Z');
  assert.equal(s.oldestVersion, '1.0.0');      // the row shown, dated or not
});

test('REGRESSION: a row count is not a time window — the same twelve rows drift', () => {
  // THIS TEST REPLACED ONE THAT WAS WRONG IN THE WAY IT WAS WARNING ABOUT. The first version
  // asserted "twelve rows covers less than 24 hours on the committed dates", which is a fact about
  // the DEPLOY CADENCE, not about this code — and it went red within the hour, when the commit
  // adding it moved the anchor and twelve rows became 30.3h. A test that passes or fails on how
  // often somebody shipped yesterday pins nothing.
  //
  // What is actually true, and stays true: a fixed row count buys a DIFFERENT amount of history
  // depending on when you look, and a window does not.
  const dated = Object.entries(VERSION_DATES)
    .map(([version, at]) => ({ version, at, t: Date.parse(at) }))
    .sort((a, b) => b.t - a.t);
  assert.ok(dated.length > 12, 'need more than twelve dated versions to measure this at all');

  const twelfth = dated[11].t;
  const atRelease = (dated[0].t - twelfth) / HOUR;
  const aDayLater = (dated[0].t + 24 * HOUR - twelfth) / HOUR;
  assert.ok(aDayLater > atRelease, 'the same twelve rows must mean more history a day later');
  assert.ok(Math.abs(aDayLater - atRelease - 24) < 0.01);

  // Whereas the window is anchored to the clock at every cadence: nothing outside it is offered.
  for (const now of [dated[0].t, dated[0].t + 24 * HOUR, dated[0].t + 72 * HOUR]) {
    for (const r of windowRows(dated, { hours: 48, now, minRows: 0 })) {
      assert.ok(now - r.t <= 48 * HOUR, `${r.version} is outside the 48h window`);
    }
  }
});

test('REGRESSION: on the night he complained, twelve rows did not reach 24 hours back', () => {
  // The complaint itself, pinned to stamps that are fixed history and cannot drift. He was
  // running v1.43.2 and the twelfth row in that build was v1.38.0.
  const running = VERSION_DATES['1.43.2'];
  const twelfthRow = VERSION_DATES['1.38.0'];
  assert.ok(running && twelfthRow, 'both stamps are committed history and should still be here');
  const covered = (Date.parse(running) - Date.parse(twelfthRow)) / HOUR;
  assert.ok(covered < 24, `it covered ${covered.toFixed(1)}h — he asked for 24-48`);

  // And 48h, measured from that same moment, reaches past it.
  const dated = Object.entries(VERSION_DATES)
    .map(([version, at]) => ({ version, at, t: Date.parse(at) }))
    .sort((a, b) => b.t - a.t)
    .filter((r) => r.t <= Date.parse(running));
  const shown = windowRows(dated, { hours: 48, now: Date.parse(running) });
  assert.ok(shown.length > 12, `48h from that moment must beat twelve rows, got ${shown.length}`);
  const reach = (Date.parse(running) - shown[shown.length - 1].t) / HOUR;
  assert.ok(reach > covered, `48h reached ${reach.toFixed(1)}h vs the cap's ${covered.toFixed(1)}h`);
  assert.ok(reach <= 48);
});

test('the panel builds the whole log when asked, so the window is the only thing limiting it', () => {
  const many = Array.from({ length: 50 }, (_, i) => [`1.0.${49 - i}`, `Release ${49 - i}.`]);
  assert.equal(rollbackTargets(many, '1.0.49', Infinity).length, 50);
  // and `undoes` is still right at the far end after the findIndex hoist
  assert.equal(rollbackTargets(many, '1.0.49', Infinity)[49].undoes, 49);
});
