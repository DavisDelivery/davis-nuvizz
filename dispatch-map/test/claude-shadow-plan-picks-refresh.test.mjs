// test/claude-shadow-plan-picks-refresh.test.mjs — A PICKED ROSTER LOAD FOLLOWS THE ROSTER ON SCREEN.
//
// Audit 2026-09-27 (shadow-frontend-1): the dispatcher ticks Draft load "1 SATL" the evening before
// (no driver yet, so it is a box truck), JOE SMITH — a tractor driver — is assigned in NuVizz, and
// Refresh re-reads the roster. The row then read "JOE SMITH · tractor", the screen said the preview
// matched, and Plan still sent { driver: null, cls: 'box_truck' }: Claude planned a truck that was not
// the one on screen. After a re-read, a surviving roster pick is the NEW row — so the plan request
// changes with it, and the preview goes stale until it is run again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rebasePicks, asPick, pickKey, nextSectionPicks } from '../src/shadow/plan-pick-core.js';

const row = (route, driver, o = {}) => ({ route, driver, loadNbr: `DAVIS${route.replace(/\W/g, '')}`, cls: driver ? 'tractor' : null, cap: 26, source: 'learned', onBoard: 0, ...o });
const picksOf = (...rows) => new Map(rows.map((l) => { const p = asPick(l); return [pickKey(p), p]; }));
// What PlanPanel sends for a pick (usePlanArea's params).
const sent = (m) => [...m.values()].map((p) => ({ kind: p.kind, route: p.route, driver: p.driver ?? null, cls: p.cls ?? null, loadNbr: p.loadNbr ?? null }));

test('a Draft load picked before its driver was assigned is planned with the tractor driver the refreshed roster shows', () => {
  const before = picksOf(row('1 SATL', null, { cap: 18 }));
  assert.deepEqual(sent(before), [{ kind: 'roster', route: '1 SATL', driver: null, cls: 'box_truck', loadNbr: 'DAVIS1SATL' }]);
  const after = rebasePicks(before, [row('1 SATL', 'JOE SMITH', { cls: 'tractor', cap: 30 })]);
  assert.deepEqual(sent(after), [{ kind: 'roster', route: '1 SATL', driver: 'JOE SMITH', cls: null, loadNbr: 'DAVIS1SATL' }],
    'the driver on screen goes with the plan, and his class (not the old box-truck guess) decides the truck');
  assert.equal([...after.values()][0].cap, 30, 'the cap on the pick is the cap on screen');
  assert.notEqual(JSON.stringify(sent(after)), JSON.stringify(sent(before)), 'the request changed, so the old preview no longer matches');
});

test('a driver taken off a picked load in NuVizz is not planned on it any more', () => {
  const before = picksOf(row('4 GAIN', 'MARY JONES'));
  const after = rebasePicks(before, [row('4 GAIN', null)]);
  assert.deepEqual(sent(after), [{ kind: 'roster', route: '4 GAIN', driver: null, cls: 'box_truck', loadNbr: 'DAVIS4GAIN' }]);
});

test('a truck class the dispatcher chose for a load with no driver survives a refresh that still shows no driver', () => {
  const before = picksOf(row('7 ATH', null));
  before.set('r:DAVIS7ATH', { ...before.get('r:DAVIS7ATH'), cls: 'tractor' });
  const after = rebasePicks(before, [row('7 ATH', null, { cap: 20 })]);
  assert.equal(after.get('r:DAVIS7ATH').cls, 'tractor');
  assert.equal(after.get('r:DAVIS7ATH').cap, 20);
  // …and gives way once a driver is on it.
  const later = rebasePicks(after, [row('7 ATH', 'JOE SMITH')]);
  assert.equal(later.get('r:DAVIS7ATH').cls, null);
  assert.equal(later.get('r:DAVIS7ATH').driver, 'JOE SMITH');
});

test('a load gone from the roster comes off, an added truck stays, and an added driver who now has a roster load comes off', () => {
  const cur = picksOf(row('1 SATL', null), row('2 BUF', 'AL'));
  cur.set('t:SPARE BOX 1', { kind: 'truck', route: 'SPARE BOX 1', driver: null, cls: 'box_truck', loadNbr: null });
  cur.set('d:Joe  Smith', { kind: 'driver', route: 'JOE SMITH', driver: 'Joe  Smith', cls: null, loadNbr: null });
  cur.set('d:BOB', { kind: 'driver', route: 'BOB', driver: 'BOB', cls: null, loadNbr: null });
  const after = rebasePicks(cur, [row('1 SATL', 'JOE SMITH')]);
  assert.deepEqual([...after.keys()].sort(), ['d:BOB', 'r:DAVIS1SATL', 't:SPARE BOX 1']);
  assert.deepEqual([...rebasePicks(cur, null).keys()].sort(), ['d:BOB', 'd:Joe  Smith', 't:SPARE BOX 1'], 'no roster at all: every roster pick comes off, the added drivers and truck stay');
});

test('PlanPanel rebuilds the picks from the roster it just read, not only filters them', () => {
  const src = readFileSync(new URL('../src/shadow/PlanPanel.jsx', import.meta.url), 'utf8');
  const read = src.slice(src.indexOf("pl.post({ action: 'plan-options', date })"), src.indexOf('}, [date, pl.post, optsTick]);'));
  assert.match(read, /setPicks\(\(cur\) => rebasePicks\(cur, j\.roster\?\.loads \|\| \[\]\)\)/);
  assert.match(src, /import \{ asPick, pickKey, rebasePicks, nextSectionPicks \} from '\.\/plan-pick-core\.js';/);
  assert.doesNotMatch(src, /const asPick = /, 'one definition of a roster pick, shared with the re-read');
});

// Review of the fix above: "Plan the next section" puts the finished plan's picks back — as its request
// carried them. On the same day nothing re-reads the roster, so after a Refresh had shown JOE SMITH on
// "1 SATL" the next section went out as the old driverless box truck again, with his row ticked.
test('"Plan the next section" after a Refresh showed a tractor driver on the load: the section is planned with him, not the finished plan\'s box-truck guess', () => {
  const finished = [{ kind: 'roster', route: '1 SATL', driver: null, cls: 'box_truck', loadNbr: 'DAVIS1SATL' }];
  const opts = { date: '2026-09-28', roster: { loads: [row('1 SATL', 'JOE SMITH', { cls: 'tractor', cap: 30 })] } };
  const next = nextSectionPicks(finished, opts, '2026-09-28');
  assert.deepEqual(sent(next), [{ kind: 'roster', route: '1 SATL', driver: 'JOE SMITH', cls: null, loadNbr: 'DAVIS1SATL' }]);
  assert.equal(next.get('r:DAVIS1SATL').cap, 30);
});

test('"Plan the next section" keeps the finished plan\'s picks as they were when the roster on screen is another day\'s (the day change re-reads it)', () => {
  const finished = [{ kind: 'roster', route: '1 SATL', driver: null, cls: 'tractor', loadNbr: 'DAVIS1SATL' }, { kind: 'truck', route: 'SPARE BOX 1', driver: null, cls: 'box_truck', loadNbr: null }];
  const other = { date: '2026-09-29', roster: { loads: [] } };
  assert.deepEqual(sent(nextSectionPicks(finished, other, '2026-09-28')), finished);
  assert.deepEqual(sent(nextSectionPicks(finished, null, '2026-09-28')), finished, 'no roster read yet: nothing to hold them to');
  // Same day, row still driverless: the class the dispatcher chose for the finished plan stays.
  const same = { date: '2026-09-28', roster: { loads: [row('1 SATL', null)] } };
  assert.deepEqual(sent(nextSectionPicks(finished, same, '2026-09-28')), finished);
});

test('PlanPanel\'s "Plan the next section" starts from nextSectionPicks against the roster on screen', () => {
  const src = readFileSync(new URL('../src/shadow/PlanPanel.jsx', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('const nextSection = useCallback('), src.indexOf('return {', src.indexOf('const nextSection = useCallback(')));
  assert.match(fn, /setPicks\(nextSectionPicks\(p\.picks, opts, res\?\.date \|\| date\)\);/);
  assert.match(fn, /\}, \[opts, date\]\);/, 'the callback reads the roster on screen now, not the one it was made with');
});
