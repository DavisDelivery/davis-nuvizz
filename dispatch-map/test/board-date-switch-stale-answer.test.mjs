// test/board-date-switch-stale-answer.test.mjs — A LATE ANSWER FOR THE DAY YOU LEFT MAY NOT
// REPLACE THE BOARD FOR THE DAY YOU PICKED.
//
// THE DEFECT (review 2026-09-03, A1-S1-1). useStops — the board behind the Map and Routing,
// desktop and phone — called setStops() and every freshness setter whenever a response
// arrived, whatever day it was for. A dispatcher on Tuesday's board picks Wednesday. If
// Tuesday's read (a big board, or a retried one) lands AFTER Wednesday's, Tuesday's stops
// replace Wednesday's under a date picker that still says Wednesday — and the dispatcher plans
// the wrong day's freight. The same happens when a silent 5-minute poll for the old day is in
// flight at the moment of the switch.
//
// The guard is tied to WHAT the answer is for (the date and carry-over window it asked about),
// not merely to which request is newest: a newer silent poll that FAILS must not cause the
// good answer for the current day to be thrown away, which is what a bare request counter
// would do here.
//
// A React state race cannot be run without a browser, so this pins the guard at the source,
// the way the other screen tests in this directory do.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  return APP.slice(start, next > 0 ? next : undefined);
}
function refreshSource() {
  const hook = fnSource('useStops');
  const at = hook.indexOf('const refresh = useCallback(');
  assert.ok(at > 0, 'the refresh callback is where it was');
  return { hook, refresh: hook.slice(at, hook.indexOf('}, [date, carryDays]);', at)) };
}

test('a slow board read for the previous date cannot overwrite the newly selected date\'s board', () => {
  const { hook, refresh } = refreshSource();
  // The hook always knows which selection is on screen right now…
  assert.match(hook, /const selectionRef = useRef\(''\);\s*selectionRef\.current = `\$\{date\}\|\$\{carryDays\}`;/);
  // …and every read remembers which selection it was asked for.
  assert.match(refresh, /const asked = `\$\{date\}\|\$\{carryDays\}`;/);
  const guard = refresh.indexOf('if (asked !== selectionRef.current) return;');
  assert.ok(guard > 0, 'an answer for a selection no longer on screen is dropped');
  assert.ok(guard > refresh.indexOf('await fetchJsonWithRetry(url)'), 'checked AFTER the wait, where the race is');
  const firstSet = refresh.indexOf('setStops(');
  assert.ok(firstSet > 0 && guard < firstSet, 'before it can reach the board');
});

test('a stale failure cannot put an error banner over the current board, nor clear its spinner', () => {
  const { refresh } = refreshSource();
  assert.match(refresh, /catch \(e\) \{\s*if \(!silent && asked === selectionRef\.current\) setError\(e\.message\);/);
  assert.match(refresh, /finally \{\s*if \(!silent && asked === selectionRef\.current\) setLoading\(false\);\s*\}/);
});
