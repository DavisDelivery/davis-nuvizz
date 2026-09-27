// test/grid-roster-age-moves.test.mjs
//
// THE BOTTOM GRID'S "Load roster: N loads · cached …" LINE WAS FROZEN AT FETCH TIME (audit
// 2026-09-27, app-A2-5, the bottom-grid half).
//
// rosterFreshness(meta, now) takes the current time, but the grid memoised it on the roster
// envelope alone, so the age and the one stale signal ("(before today)") were worked out once,
// when the Loads view fetched, and never again. Opened at 9:06 it still said "cached 1m ago"
// at 3 PM, and left open overnight it never said "(before today)".
//
// What happens now: while the Loads view is open the grid recomputes the line every minute, so
// the age it prints is the age of what it holds.
//
// NOT covered here, on purpose: re-reading the roster after a Scan, and the same line on the
// Routing screen's Routes rail. The rail is Route Workbench and its roster also feeds
// Compare-card identity; that half is waiting on Chad.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rosterFreshness } from '../src/lib/roster-freshness.js';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('a roster fetched at 9:05 ET reads its real age at 3:05 PM and "(before today)" the next morning', () => {
  // The rule the grid now follows: the age is measured against the clock NOW, not at fetch.
  const meta = { ok: true, source: 'cache', at: '2026-09-28T13:05:00.000Z', count: 41, date: '2026-09-28' };
  assert.match(rosterFreshness(meta, new Date('2026-09-28T13:06:00.000Z')).label, /41 loads · cached 1m ago$/);
  assert.match(rosterFreshness(meta, new Date('2026-09-28T19:05:00.000Z')).label, /41 loads · cached 6h ago$/);
  assert.match(rosterFreshness(meta, new Date('2026-09-29T12:05:00.000Z')).label, /\(before today\)$/);
});

test('the grid recomputes the roster line on a clock while the Loads view is open', () => {
  const at = APP.indexOf('function BottomStopsTable(');
  const grid = APP.slice(at, APP.indexOf('\nfunction ', at + 1));
  const memo = grid.match(/const rosterState = useMemo\(\(\) => rosterFreshness\(rosterMeta\), \[rosterMeta, (\w+)\]\);/);
  assert.ok(memo, 'the grid\'s roster line must be recomputed on a clock, not only when the roster is re-fetched');
  const tick = memo[1];
  assert.match(grid, new RegExp(`setInterval\\(\\(\\) => set${tick[0].toUpperCase()}${tick.slice(1)}\\(`), `${tick} must be advanced by a timer`);
  assert.match(grid, new RegExp(`if \\(view !== 'loads' \\|\\| !open\\) return undefined;[\\s\\S]{0,200}set${tick[0].toUpperCase()}${tick.slice(1)}`),
    'and the timer only runs while the Loads view (the only place the line shows) is open');
});
