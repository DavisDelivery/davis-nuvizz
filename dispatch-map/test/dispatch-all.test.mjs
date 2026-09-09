// Dispatch all — the pure planner behind the bulk button.
//
// Chad: "i want a dispatch all button that dispatches every route that hasn't been dispatched
// in the routes menu."
//
// Dispatch is the least reversible thing this app does: it releases a load to a driver in
// production NuVizz. So the rules these tests hold are the ones that keep a bulk version from
// being more dangerous than the twenty clicks it replaces — it must be exactly as picky, and
// it must never drop a route in silence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planDispatchAll, dispatchPlanLines, dispatchAllSummary, DISPATCHABLE_STATUSES,
} from '../src/lib/dispatch-all.js';

const route = (over = {}) => ({ key: 'k', name: 'SUW 2', loadNbr: 'DAVIS1', loadId: 'ld-1', status: 'Draft', driver: 'MICHAEL THARP', ...over });
const driverFor = (g) => g.driver || null;
const loadIdFor = (g) => g.loadId || null;
const plan = (groups) => planDispatchAll({ groups, driverFor, loadIdFor });

// ── who goes ────────────────────────────────────────────────────────────────

test('a driver-assigned, pre-dispatch route with a load id goes', () => {
  const out = plan([route()]);
  assert.equal(out.eligible.length, 1);
  assert.deepEqual(out.skipped, []);
});

test('every pre-dispatch status the row button allows is allowed here too', () => {
  // One rule, two readers. A status the row will dispatch and the bulk button silently skips
  // is the kind of disagreement that only shows up at 5am.
  for (const status of DISPATCHABLE_STATUSES) {
    assert.equal(plan([route({ status })]).eligible.length, 1, `${status} should be dispatchable`);
  }
});

test('an already-dispatched route is counted, not listed as a problem', () => {
  // A board of dispatched routes must not bury the four that need a driver under eighteen
  // that need nothing.
  const out = plan([route({ status: 'Dispatched' }), route({ status: 'In-Transit' }), route({ status: 'Completed' })]);
  assert.equal(out.eligible.length, 0);
  assert.deepEqual(out.skipped, []);
  assert.equal(out.alreadyDispatched, 3);
});

// ── who does NOT, and is SAID so ────────────────────────────────────────────

test('a route with no driver is skipped BY NAME — dispatching to nobody has no undo', () => {
  const out = plan([route({ driver: null, name: 'CHE' })]);
  assert.equal(out.eligible.length, 0);
  assert.deepEqual(out.skipped, [{ name: 'CHE', reason: 'no driver assigned' }]);
});

test('a route whose load id has not resolved is skipped BY NAME, not guessed at', () => {
  const out = plan([route({ loadId: null, name: 'GARY PITTS' })]);
  assert.equal(out.eligible.length, 0);
  assert.deepEqual(out.skipped, [{ name: 'GARY PITTS', reason: 'NuVizz load id not loaded yet' }]);
});

test('a mixed list separates cleanly and loses nothing', () => {
  const out = plan([
    route({ key: 'a', name: 'A' }),
    route({ key: 'b', name: 'B', driver: null }),
    route({ key: 'c', name: 'C', loadId: null }),
    route({ key: 'd', name: 'D', status: 'Dispatched' }),
    route({ key: 'e', name: 'E' }),
  ]);
  assert.deepEqual(out.eligible.map((g) => g.name), ['A', 'E']);
  assert.deepEqual(out.skipped.map((x) => x.name), ['B', 'C']);
  assert.equal(out.alreadyDispatched, 1);
  assert.equal(out.eligible.length + out.skipped.length + out.alreadyDispatched, 5,
    'every route must land in exactly one bucket — a bulk write may not lose one');
});

test('junk in the list cannot crash the planner or become a dispatch', () => {
  const out = planDispatchAll({ groups: [null, undefined, {}], driverFor, loadIdFor });
  assert.equal(out.eligible.length, 0);
});

test('no arguments at all is an empty plan, not a throw', () => {
  const out = planDispatchAll();
  assert.deepEqual(out, { eligible: [], skipped: [], alreadyDispatched: 0 });
});

// ── what the dispatcher is shown before anything fires ──────────────────────

test('the confirm names every load AND its driver — a count cannot be checked', () => {
  const lines = dispatchPlanLines([route({ name: 'SUW 2', driver: 'MICHAEL THARP' })], driverFor);
  assert.deepEqual(lines, ['Dispatch SUW 2 → MICHAEL THARP']);
});

// ── what it reports afterwards ──────────────────────────────────────────────

test('a clean run says so plainly', () => {
  assert.equal(dispatchAllSummary([{ ok: true, name: 'A' }, { ok: true, name: 'B' }]), '✓ 2 routes dispatched.');
});

test('a FAILURE is never drowned by the successes', () => {
  const msg = dispatchAllSummary([
    { ok: true, name: 'A' }, { ok: true, name: 'B' }, { ok: false, name: 'CHE', error: 'write error' },
  ]);
  assert.match(msg, /2 dispatched/);
  assert.match(msg, /1 FAILED: CHE \(write error\)/);
});

test('a bad run names the first few and counts the rest rather than running to a paragraph', () => {
  const bad = ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => ({ ok: false, name }));
  const msg = dispatchAllSummary(bad);
  assert.match(msg, /\+2 more/);
});

test('an empty run says nothing happened rather than claiming success', () => {
  assert.equal(dispatchAllSummary([]), 'Nothing to dispatch.');
});
