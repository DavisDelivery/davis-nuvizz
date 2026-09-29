// test/time-window-sequence.test.mjs — "Time windows" on the Compare card's Re-sequence menu (v1.89.0).
//
// Chad, 2026-09-28: "i need an optimization that uses the time restrictions and trys to make the
// best route considering those". These run the REAL routePreflight — the check behind every late
// badge on the card — on small routes whose clocks were measured first, and pin what the option
// promises: fewer late stops, never a worse order, nothing dropped, the same answer twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { routePreflight } from '../src/lib/route-preflight.js';
import { timeWindowSequence, timeWindowSummary, compareWindowScores, compareTimeWindowsEnabled } from '../src/lib/time-window-sequence.js';

const depot = { lat: 33.7004, lng: -84.4955 };
const stop = (id, lat, lng) => ({ stopNbr: id, lat, lng, matchKey: `m${id}`, businessName: id, normalizedStatus: 'SCHEDULED', status: '20' });
const typed = (open, close) => ({ receiving_hours: { tue: { open, close } }, manual_overrides: { receiving_hours: true } });
const auto = (open, close) => ({ receiving_hours: { tue: { open, close } } });
// A is 45 km north and closes at 9:30a; B–E run south of the depot with no hours.
const STOPS = new Map([
  ['A', stop('A', 34.10, -84.50)],
  ['B', stop('B', 33.66, -84.49)], ['C', stop('C', 33.62, -84.47)], ['D', stop('D', 33.58, -84.45)], ['E', stop('E', 33.55, -84.43)],
]);
const base = (notes, extra = {}) => ({ stopById: STOPS, notes, routeKey: 'MARCUS', servedDate: '2026-09-29', dayKey: 'tue', depot, ...extra });
const A_CLOSES_930 = new Map([['mA', typed('7:00', '9:30')]]);

test('THE ASK: the far stop that closes early goes first, and the late badge goes away', () => {
  // Measured on the real engine: B-C-D-E-A reaches A at 10:20a, 50m past its 9:30a close.
  const pfBefore = routePreflight({ ...base(A_CLOSES_930), order: ['B', 'C', 'D', 'E', 'A'] });
  assert.equal(pfBefore.lateCount, 1);
  const res = timeWindowSequence({ ...base(A_CLOSES_930), order: ['B', 'C', 'D', 'E', 'A'] });
  assert.equal(res.changed, true);
  assert.equal(res.order[0], 'A');
  assert.deepEqual(res.before, { late: 1, early: 0, lateMin: 50, finish: 620 });
  assert.equal(res.after.late, 0);
  // Judged by the SAME check the card's badges read.
  assert.equal(routePreflight({ ...base(A_CLOSES_930), order: res.order }).lateCount, 0);
  assert.equal(timeWindowSummary(res, 'MARCUS'), 'Re-sequenced MARCUS · Time windows — 1 late (50m in all) → 0 late');
});

test('never worse: a card that already makes every window keeps its order and says so', () => {
  const res = timeWindowSequence({ ...base(A_CLOSES_930), order: ['A', 'B', 'C', 'D', 'E'] });
  assert.equal(res.after.late, 0);
  assert.ok(compareWindowScores(res.after, res.before) <= 0);
  // Measured: B-C-D-E (no hours anywhere) already has the earliest finish, 9:16a.
  const same = timeWindowSequence({ ...base(new Map()), order: ['B', 'C', 'D', 'E'] });
  assert.equal(same.changed, false);
  assert.deepEqual(same.order, ['B', 'C', 'D', 'E']);
  assert.deepEqual(same.after, same.before);
  assert.equal(timeWindowSummary(same, 'MARCUS'), "Time windows: kept MARCUS's order — no order found with fewer late stops (0 late).");
});

test('a typed OPENING is respected: the stop that opens at 9:30a is not reached at 8:05a', () => {
  const s = new Map([...STOPS].filter(([k]) => k !== 'A'));
  s.set('F', stop('F', 33.69, -84.49));   // right by the depot — nearest first by distance
  const notes = new Map([['mF', typed('9:30', '17:00')]]);
  const args = { ...base(notes), stopById: s, order: ['F', 'B', 'C', 'D', 'E'] };
  const res = timeWindowSequence(args);
  assert.equal(res.before.early, 1, 'distance order reaches F before it opens');
  assert.equal(res.after.early, 0);
  assert.equal(res.after.late, 0, 'without making anything late');
  assert.notEqual(res.order[0], 'F');
  assert.match(timeWindowSummary(res, 'MARCUS'), /before a typed opening 1 → 0/);
});

test('an AUTO opening is not chased — auto hours can invent one ("DELIVER BY 2PM" reads 6:00a–2:00p)', () => {
  const s = new Map([...STOPS].filter(([k]) => k !== 'A'));
  s.set('F', stop('F', 33.69, -84.49));
  const res = timeWindowSequence({ ...base(new Map([['mF', auto('9:30', '17:00')]])), stopById: s, order: ['F', 'B', 'C', 'D', 'E'] });
  assert.equal(res.before.early, 0);
  assert.equal(res.after.early, 0);
});

test('a stop with no map location is never dropped or guessed — it rides at the end, in its order', () => {
  const s = new Map(STOPS);
  s.set('X', { stopNbr: 'X', lat: null, lng: null, matchKey: 'mX' });
  const res = timeWindowSequence({ ...base(A_CLOSES_930), stopById: s, order: ['B', 'X', 'C', 'D', 'E', 'A', 'ZZ'] });
  assert.deepEqual(res.order.slice(-2), ['X', 'ZZ'], 'no location and unresolvable, both kept, both last');
  assert.equal(new Set(res.order).size, 7);
  assert.equal(res.unjudged, 2);
  assert.match(timeWindowSummary(res, 'MARCUS'), /2 stop\(s\) without a map location left at the end/);
});

test('deterministic: the same card gives the same order twice', () => {
  const a = timeWindowSequence({ ...base(A_CLOSES_930), order: ['E', 'D', 'C', 'B', 'A'] });
  const b = timeWindowSequence({ ...base(A_CLOSES_930), order: ['E', 'D', 'C', 'B', 'A'] });
  assert.deepEqual(a.order, b.order);
  assert.deepEqual(a.after, b.after);
});

test('a spent budget is REPORTED, and the order is still never worse than the card', () => {
  const res = timeWindowSequence({ ...base(A_CLOSES_930), order: ['B', 'C', 'D', 'E', 'A'], maxEvals: 3 });
  assert.equal(res.capped, true);
  assert.ok(compareWindowScores(res.after, res.before) <= 0);
  assert.match(timeWindowSummary(res, 'MARCUS'), /search cut short/);
});

test('fewer than two placeable stops: nothing to order, nothing claimed', () => {
  const res = timeWindowSequence({ ...base(A_CLOSES_930), order: ['A'] });
  assert.equal(res.changed, false);
  assert.deepEqual(res.order, ['A']);
  assert.deepEqual(timeWindowSequence({ ...base(A_CLOSES_930), order: [] }).order, []);
});

test('the ranking: late first, then early, then minutes late, then the finish', () => {
  assert.ok(compareWindowScores({ late: 0, early: 3, lateMin: 0, finish: 900 }, { late: 1, early: 0, lateMin: 1, finish: 500 }) < 0);
  assert.ok(compareWindowScores({ late: 1, early: 0, lateMin: 90, finish: 900 }, { late: 1, early: 1, lateMin: 10, finish: 500 }) < 0);
  assert.ok(compareWindowScores({ late: 1, early: 0, lateMin: 10, finish: 900 }, { late: 1, early: 0, lateMin: 90, finish: 500 }) < 0);
  assert.ok(compareWindowScores({ late: 0, early: 0, lateMin: 0, finish: 500 }, { late: 0, early: 0, lateMin: 0, finish: 501 }) < 0);
});

test('VITE_COMPARE_TIME_WINDOWS: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(compareTimeWindowsEnabled({}), true);
  assert.equal(compareTimeWindowsEnabled(undefined), true);
  for (const off of ['off', '0', 'false', 'no']) assert.equal(compareTimeWindowsEnabled({ VITE_COMPARE_TIME_WINDOWS: off }), false, off);
  assert.equal(compareTimeWindowsEnabled({ VITE_COMPARE_TIME_WINDOWS: 'of' }), true);
});

test('a real-sized card (18 stops) answers inside the budget, well under a second', () => {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const s = new Map(); const notes = new Map(); const order = [];
  for (let i = 0; i < 18; i++) {
    const id = `S${i}`;
    s.set(id, stop(id, 33.55 + rnd() * 0.55, -84.75 + rnd() * 0.6));
    if (i % 4 === 0) notes.set(`m${id}`, typed('7:00', `${9 + (i % 4)}:30`));
    order.push(id);
  }
  const t0 = performance.now();
  const res = timeWindowSequence({ ...base(notes), stopById: s, order });
  const ms = performance.now() - t0;
  assert.ok(compareWindowScores(res.after, res.before) <= 0);
  assert.equal(new Set(res.order).size, 18);
  assert.ok(ms < 5000, `took ${Math.round(ms)} ms`);
});

// ── ONE CLOCK: the option and the card's badges read the same inputs ─────────
import { readFileSync } from 'node:fs';
import { travelForServedDate } from '../src/lib/route-preflight.js';

test('travelForServedDate: per-day route classes only on their own day — the rule the badges always used', () => {
  assert.equal(travelForServedDate(null, '2026-09-29'), null);
  const base = { speeds: { box: 30 } };
  assert.equal(travelForServedDate(base, '2026-09-29'), base, 'no classes → the calibration as is');
  const today = { ...base, routeClasses: { MARCUS: 'box' }, routeClassesDate: '2026-09-29' };
  assert.equal(travelForServedDate(today, '2026-09-29'), today);
  const stale = { ...base, routeClasses: { MARCUS: 'box' }, routeClassesDate: '2026-09-28' };
  const out = travelForServedDate(stale, '2026-09-29');
  assert.equal(out.routeClasses, undefined);
  assert.deepEqual(out.speeds, base.speeds);
});

test('the Re-sequence handler scores with the SAME route key, departure, travel and day as the card\'s preflight', () => {
  const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const pre = APP.slice(APP.indexOf('const wbPreflight = useMemo('), APP.indexOf('const effectiveRouteInfo'));
  const win = APP.slice(APP.indexOf("if (strategy === 'windows') {"), APP.indexOf('const newOrder = resequence(pts, ROUTING_DEPOT, strategy)'));
  for (const src of [pre, win]) {
    assert.match(src, /travelForServedDate\(travelInputs, selectedDate\)/);
    assert.match(src, /const routeKey = r\.name \|\| r\.loadNbr \|\| r\.key;/);
    assert.match(src, /const measured = departureFor\(departTable, routeKey\);/);
    assert.match(src, /dayKey: weekdayKeyFromDate\(selectedDate\)/);
    assert.match(src, /depot: ROUTING_DEPOT/);
  }
  assert.match(APP, /\{COMPARE_TIME_WINDOWS_ON && <option value="windows">Time windows — fewest late<\/option>\}/);
});
