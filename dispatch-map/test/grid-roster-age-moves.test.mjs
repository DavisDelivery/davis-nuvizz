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

// THE LINE COMES INTO VIEW LONG AFTER IT WAS WORKED OUT. The roster is fetched whenever the
// Loads view is selected, open or closed, so a dispatcher can open the grid at 3 PM onto a line
// last computed at 9:05. A timer that only fires a minute later showed "cached 1m ago" for that
// first minute — the very minute he reads it. This RUNS the grid's tick block out of App.jsx on
// a minimal hooks runtime with a hand-driven clock and hand-fired intervals.
test('a grid opened at 3 PM onto a roster fetched at 9:05 shows its real age at once, not a minute later', () => {
  const at = APP.indexOf('function BottomStopsTable(');
  const grid = APP.slice(at, APP.indexOf('\nfunction ', at + 1));
  const from = grid.indexOf('  const [rosterTick, setRosterTick] = useState(0);');
  const memoAt = grid.indexOf('  const rosterState = useMemo(');
  assert.ok(from > 0 && memoAt > from, 'the roster tick block was not found in BottomStopsTable');
  const block = grid.slice(from, grid.indexOf('\n', memoAt));

  let clock = Date.parse('2026-09-28T13:05:00.000Z');   // 9:05 ET
  const intervals = [];
  const slots = [];
  let i = 0;
  let dirty = false;
  let pending = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((x, j) => !Object.is(x, b[j]));
  const hooks = {
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = { v: typeof init === 'function' ? init() : init };
      const s = slots[k];
      return [s.v, (v) => { const n = typeof v === 'function' ? v(s.v) : v; if (!Object.is(n, s.v)) { s.v = n; dirty = true; } }];
    },
    useEffect(fn, deps) {
      const k = i++;
      const prev = slots[k];
      if (!prev || changed(prev.deps, deps)) {
        pending.push(() => { if (prev?.cleanup) prev.cleanup(); const c = fn(); slots[k] = { deps, cleanup: typeof c === 'function' ? c : null }; });
      }
    },
    useMemo(fn, deps) {
      const k = i++;
      const prev = slots[k];
      if (!prev || changed(prev.deps, deps)) slots[k] = { deps, v: fn() };
      return slots[k].v;
    },
  };
  const fakeSetInterval = (fn) => { intervals.push(fn); return intervals.length; };
  const fakeClearInterval = (id) => { intervals[id - 1] = null; };
  const freshnessNow = (meta) => rosterFreshness(meta, new Date(clock));
  const body = new Function('hooks', 'props', 'rosterFreshness', 'setInterval', 'clearInterval', `
    const { useState, useEffect, useMemo } = hooks;
    const { view, open, rosterMeta } = props;
    ${block}
    return rosterState.label;
  `);
  const render = (props) => {
    let out;
    for (let pass = 0; pass < 20; pass++) {
      i = 0; dirty = false; pending = [];
      out = body(hooks, props, freshnessNow, fakeSetInterval, fakeClearInterval);
      for (const run of pending) run();
      if (!dirty) return out;
    }
    throw new Error('render loop did not settle');
  };

  const meta = { ok: true, source: 'cache', at: '2026-09-28T13:04:00.000Z', count: 41, date: '2026-09-28' };
  // 9:05: the Loads view is selected on a CLOSED grid, and the roster lands.
  assert.match(render({ view: 'loads', open: false, rosterMeta: meta }), /cached 1m ago$/);
  // 3:05 PM: he opens the grid. No interval has fired yet.
  clock = Date.parse('2026-09-28T19:05:00.000Z');
  assert.match(render({ view: 'loads', open: true, rosterMeta: meta }), /41 loads · cached 6h ago$/,
    'the line he opens onto must be as old as the roster it describes');
  // And it keeps moving while it is shown.
  clock = Date.parse('2026-09-29T12:05:00.000Z');
  intervals.filter(Boolean).forEach((fn) => fn());
  assert.match(render({ view: 'loads', open: true, rosterMeta: meta }), /\(before today\)$/);
});
