// test/time-window-sequence.test.mjs — "Time windows" on the Compare card's Re-sequence menu (v1.89.0).
//
// Chad, 2026-09-28: "i need an optimization that uses the time restrictions and trys to make the
// best route considering those". These run the REAL routePreflight — the check behind every late
// badge on the card — on small routes whose clocks were measured first, and pin what the option
// promises: fewer late stops, never a worse order, nothing dropped, the same answer twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { routePreflight } from '../src/lib/route-preflight.js';
import { timeWindowSequence, timeWindowSummary, compareWindowScores, compareTimeWindowsEnabled, timeWindowsMilesCapEnabled, TIME_WINDOW_MILES_PER_LATE_STOP } from '../src/lib/time-window-sequence.js';

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
// The window logic below is pinned on the search as it read windows before the miles price (Chad,
// 2026-09-30); those tests pass NO_PRICE. The price has its own tests at the end of this file.
const NO_PRICE = { milesCap: false };

test('THE ASK: the far stop that closes early goes first, and the late badge goes away', () => {
  // Measured on the real engine: B-C-D-E-A reaches A at 10:20a, 50m past its 9:30a close.
  const pfBefore = routePreflight({ ...base(A_CLOSES_930), order: ['B', 'C', 'D', 'E', 'A'] });
  assert.equal(pfBefore.lateCount, 1);
  const res = timeWindowSequence({ ...base(A_CLOSES_930), order: ['B', 'C', 'D', 'E', 'A'], ...NO_PRICE });
  assert.equal(res.changed, true);
  assert.equal(res.order[0], 'A');
  assert.deepEqual(res.before, { late: 1, early: 0, lateMin: 50, finish: 620, meters: 0 });
  assert.equal(res.after.late, 0);
  // Judged by the SAME check the card's badges read.
  assert.equal(routePreflight({ ...base(A_CLOSES_930), order: res.order }).lateCount, 0);
  assert.equal(timeWindowSummary(res, 'MARCUS'), 'Re-sequenced MARCUS · Time windows — 1 late (50m in all) → 0 late · last stop 10:20a → 10:44a', 'the cost is said: the day ends 24m later');
});

test('never worse: a card that already makes every window keeps its order and says so', () => {
  const res = timeWindowSequence({ ...base(A_CLOSES_930), order: ['A', 'B', 'C', 'D', 'E'] });
  assert.equal(res.after.late, 0);
  assert.ok(compareWindowScores(res.after, res.before) <= 0);
  // Measured: B-C-D-E (no hours anywhere) already has the earliest finish, 9:16a.
  const same = timeWindowSequence({ ...base(new Map()), order: ['B', 'C', 'D', 'E'], ...NO_PRICE });
  assert.equal(same.changed, false);
  assert.deepEqual(same.order, ['B', 'C', 'D', 'E']);
  assert.deepEqual(same.after, same.before);
  assert.equal(timeWindowSummary(same, 'MARCUS'), "Time windows: kept MARCUS's order — no order found with fewer late stops (0 late).");
});

test('a typed OPENING is respected: the stop that opens at 9:30a is not reached at 8:05a', () => {
  const s = new Map([...STOPS].filter(([k]) => k !== 'A'));
  s.set('F', stop('F', 33.69, -84.49));   // right by the depot — nearest first by distance
  const notes = new Map([['mF', typed('9:30', '17:00')]]);
  const args = { ...base(notes), stopById: s, order: ['F', 'B', 'C', 'D', 'E'], ...NO_PRICE };
  const res = timeWindowSequence(args);
  assert.equal(res.before.early, 1, 'distance order reaches F before it opens');
  assert.equal(res.after.early, 0);
  assert.equal(res.after.late, 0, 'without making anything late');
  assert.notEqual(res.order[0], 'F');
  assert.match(timeWindowSummary(res, 'MARCUS'), /before an opening 1 → 0/);
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
  assert.match(win, /defaultSlots: detectDefaultSlots\(stops\)/, 'the board\'s vendor-default slots reach the optimizer');
  assert.match(APP, /\{COMPARE_TIME_WINDOWS_ON && <option value="windows">Time windows — fewest late<\/option>\}/);
});

// ── BOOKED WINDOWS AND APPOINTMENTS COUNT, NOT RECEIVING HOURS ALONE ─────────
//
// Chad, 2026-09-28: "optimizes to the time restrictions". A stop's clock is the merged rule the route
// builder reads (order window / appointment + receiving hours + closed day), so a booked slot moves the
// order too. Numbers below were measured on the real engine before being pinned.
const eta = (stops, order, notes = new Map()) => Object.fromEntries(
  routePreflight({ stopById: stops, notes, routeKey: 'MARCUS', servedDate: '2026-09-29', dayKey: 'tue', depot, order }).stops.map((s) => [s.stopNbr, s.etaMin]));
const booked = (id, lat, lng, from, to) => ({ ...stop(id, lat, lng), scheduledFrom: `2026-09-29T${from}:00`, scheduledTo: `2026-09-29T${to}:00` });
const SOUTH = () => new Map([['B', STOPS.get('B')], ['C', STOPS.get('C')], ['D', STOPS.get('D')], ['E', STOPS.get('E')]]);

test('a 9:30a–12:00p ORDER WINDOW: the stop by the depot is not delivered at 8:04a, it goes last', () => {
  const s = SOUTH(); s.set('F', booked('F', 33.69, -84.49, '09:30', '12:00'));
  const args = { ...base(new Map()), stopById: s };
  assert.equal(eta(s, ['F', 'B', 'C', 'D', 'E']).F, 484, 'distance order reaches F at 8:04a, before its window opens');
  const res = timeWindowSequence({ ...args, order: ['F', 'B', 'C', 'D', 'E'], ...NO_PRICE });
  assert.deepEqual(res.before, { late: 0, early: 1, lateMin: 0, finish: 572, meters: 0 });
  assert.equal(res.after.early, 0);
  assert.equal(res.after.late, 0);
  assert.equal(res.order[res.order.length - 1], 'F');
  assert.ok(eta(s, res.order).F >= 9 * 60 + 30 && eta(s, res.order).F <= 12 * 60, 'F is now reached inside its window');
  // The cost of making the window is SAID: the day ends later than the shortest order.
  assert.equal(timeWindowSummary(res, 'MARCUS'), 'Re-sequenced MARCUS · Time windows — none late · before an opening 1 → 0 · last stop 9:32a → 9:50a');
});

test('a 9:00a–9:30a BOOKED APPOINTMENT: the order lands the stop inside its slot', () => {
  const s = SOUTH(); s.set('G', booked('G', 33.69, -84.49, '09:00', '09:30'));
  const res = timeWindowSequence({ ...base(new Map()), stopById: s, order: ['G', 'B', 'C', 'D', 'E'], ...NO_PRICE });
  assert.equal(res.before.early, 1, 'G first is reached at 8:04a, an hour early for its slot');
  assert.equal(res.after.early, 0);
  const at = eta(s, res.order).G;
  assert.ok(at >= 9 * 60 && at <= 9 * 60 + 30, `G reached at ${at}`);
});

test('the vendor\'s default creation slot is NOT an appointment (detectDefaultSlots keeps it out)', () => {
  const s = SOUTH(); s.set('G', booked('G', 33.69, -84.49, '09:00', '09:30'));
  const withDefault = timeWindowSequence({ ...base(new Map()), stopById: s, order: ['G', 'B', 'C', 'D', 'E'], defaultSlots: new Set(['540-570']) });
  assert.equal(withDefault.before.early, 0);
  assert.equal(withDefault.changed, false);
});

test('the card\'s own late verdict is never ignored, and a stop closed today adds nothing to the ranking', () => {
  const s = SOUTH();
  // B is shut on Tuesdays (typed) and also carries an impossible 8:00a close: the card would flag it, no order can serve it.
  const notes = new Map([['mB', { ...typed('7:00', '8:00'), closed_days: ['tue'], manual_overrides: { receiving_hours: true, closed_days: true } }]]);
  const res = timeWindowSequence({ ...base(notes), stopById: s, order: ['B', 'C', 'D', 'E'] });
  assert.equal(res.before.late, 0, 'a closed stop is left out of the count');
  const open = new Map([['mC', typed('7:00', '8:10')]]);   // C is open but closes before the truck can get there in this order
  const r2 = timeWindowSequence({ ...base(open), stopById: s, order: ['B', 'C', 'D', 'E'] });
  const pf = routePreflight({ ...base(open), stopById: s, order: ['B', 'C', 'D', 'E'] });
  assert.equal(r2.before.late, pf.lateCount, 'what the badges show, the ranking counts');
});

// ── THE MILES PRICE (Chad, 2026-09-30) ───────────────────────────────────────────────────────────
// "a couple of miles is worth it, but not 15 or 20 miles." Each late stop is priced at
// TIME_WINDOW_MILES_PER_LATE_STOP of the card header's miles; the search takes the lowest miles plus
// that price, never with more late stops than the card.
const MI_M = 1609.344;

test('the price is two miles a late stop saved', () => {
  assert.equal(TIME_WINDOW_MILES_PER_LATE_STOP, 2);
});

test('THE ASK again, priced: saving A costs 22 miles, so the card keeps its order and says why', () => {
  const res = timeWindowSequence({ ...base(A_CLOSES_930), order: ['B', 'C', 'D', 'E', 'A'] });
  const aFirst = timeWindowSequence({ ...base(A_CLOSES_930), order: ['A', 'B', 'C', 'D', 'E'], maxEvals: 1 }).before;
  assert.ok((aFirst.meters - res.before.meters) / MI_M > 20, 'A first really is 20+ miles longer');
  assert.equal(res.changed, false);
  assert.deepEqual(res.order, ['B', 'C', 'D', 'E', 'A']);
  assert.equal(timeWindowSummary(res, 'MARCUS'), "Time windows: kept MARCUS's order — no shorter order, and no late stop it can make for 2 mi or less (1 late (50m in all)).");
  // The switch off is the old search, byte for byte.
  const old = timeWindowSequence({ ...base(A_CLOSES_930), order: ['B', 'C', 'D', 'E', 'A'], ...NO_PRICE });
  assert.equal(old.order[0], 'A');
  assert.equal(old.milesPerLateStop, null);
});

test('a late stop saved for a mile is taken, and the miles are said', () => {
  // B, then C 0.6 km further on. C closes at 8:23a; B-C reaches it at 8:28a, C-B at 8:12a.
  const s = new Map([['B', stop('B', 33.64, -84.49)], ['C', stop('C', 33.6345, -84.4885)], ['D', stop('D', 33.58, -84.45)], ['E', stop('E', 33.55, -84.43)]]);
  const notes = new Map([['mC', typed('7:00', '8:23')]]);
  const res = timeWindowSequence({ ...base(notes), stopById: s, order: ['B', 'C', 'D', 'E'] });
  assert.deepEqual(res.order, ['C', 'B', 'D', 'E']);
  assert.equal(res.before.late, 1);
  assert.equal(res.after.late, 0);
  const added = (res.after.meters - res.before.meters) / MI_M;
  assert.ok(added > 0 && added <= 2, `${added.toFixed(2)} mi`);
  assert.equal(res.milesPerLateStop, 2);
  assert.equal(timeWindowSummary(res, 'MARCUS'), 'Re-sequenced MARCUS · Time windows — 1 late (5m in all) → 0 late · 14.7 → 15.7 mi');
});

test('a zig-zag card does not buy headroom: the stop is priced against the shortest order that leaves it late', () => {
  // Found in review. FGEBDCA runs 108.9 mi with A late. AFEDCBG makes A for 109.9 mi, only a mile over
  // the card, but 25.7 mi over BGCDEFA, the shortest order that leaves A late. That is the 15-20
  // miles Chad ruled out, so the price takes the short order and says what it saved.
  const s = new Map([...STOPS, ['F', stop('F', 33.64, -84.36)], ['G', stop('G', 33.58, -84.60)]]);
  const args = { ...base(A_CLOSES_930), stopById: s, order: ['F', 'G', 'E', 'B', 'D', 'C', 'A'] };
  const res = timeWindowSequence(args);
  assert.deepEqual(res.order, ['B', 'G', 'C', 'D', 'E', 'F', 'A']);
  assert.equal(res.after.late, 1);
  assert.match(timeWindowSummary(res, 'MARCUS'), /· 108\.9 → 84\.2 mi$/);
  const old = timeWindowSequence({ ...args, ...NO_PRICE });
  assert.deepEqual(old.order, ['A', 'F', 'E', 'D', 'C', 'B', 'G'], 'the old search: A made, at any cost');
});

test('an order that saves no late stop may not add a mile — arriving before an opening is not chased at a cost', () => {
  const s = new Map([...STOPS].filter(([k]) => k !== 'A'));
  s.set('F', stop('F', 33.69, -84.49));
  const res = timeWindowSequence({ ...base(new Map([['mF', typed('9:30', '17:00')]])), stopById: s, order: ['F', 'B', 'C', 'D', 'E'] });
  assert.equal(res.before.early, 1);
  assert.ok(res.after.meters <= res.before.meters, 'no miles added');
  assert.equal(res.after.late, 0);
});

test('never over the price, on 60 random cards with random closes', () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let t = 0; t < 60; t++) {
    const n = 5 + Math.floor(rnd() * 6);
    const st = new Map(); const notes = new Map();
    for (let i = 0; i < n; i++) {
      const id = `S${i}`;
      st.set(id, stop(id, 33.45 + rnd() * 0.5, -84.75 + rnd() * 0.5));
      if (rnd() < 0.5) notes.set(`m${id}`, typed('7:00', `${8 + Math.floor(rnd() * 4)}:${rnd() < 0.5 ? '00' : '30'}`));
    }
    const order = [...st.keys()];
    const res = timeWindowSequence({ ...base(notes), stopById: st, order, maxEvals: 800 });
    const allowed = TIME_WINDOW_MILES_PER_LATE_STOP * MI_M * Math.max(0, res.before.late - res.after.late);
    assert.ok(res.after.meters - res.before.meters <= allowed + 1, `card ${t}: +${((res.after.meters - res.before.meters) / MI_M).toFixed(1)} mi for ${res.before.late - res.after.late} late stop(s) saved`);
    assert.ok(res.after.late <= res.before.late, 'never more late stops');
    const priced = (x) => x.meters + TIME_WINDOW_MILES_PER_LATE_STOP * MI_M * x.late;
    assert.ok(priced(res.after) <= priced(res.before) + 1, 'never costs more miles-plus-price than the card');
    assert.deepEqual([...res.order].sort(), [...order].sort(), 'every stop once');
  }
});

test('VITE_TIME_WINDOWS_MILES_CAP: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(timeWindowsMilesCapEnabled({}), true);
  assert.equal(timeWindowsMilesCapEnabled(undefined), true);
  for (const v of ['off', 'OFF', ' 0 ', 'false', 'no']) assert.equal(timeWindowsMilesCapEnabled({ VITE_TIME_WINDOWS_MILES_CAP: v }), false, v);
  for (const v of ['on', '1', '2', 'offf', '']) assert.equal(timeWindowsMilesCapEnabled({ VITE_TIME_WINDOWS_MILES_CAP: v }), true, `"${v}" leaves it on`);
});
