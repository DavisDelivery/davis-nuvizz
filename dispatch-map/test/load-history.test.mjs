// test/load-history.test.mjs — the load send history, pinned to the RULES rather than the
// implementation, and named for the real-world event each rule exists to survive.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deliveryOrderOf, diffStopOrder, buildLoadSendRows, changeLabel,
  selectLoadSends, summarizeLoadSends, loadHistoryEnabled,
} from '../netlify/functions/lib/load-history.mts';

const AT = '2026-09-16T18:14:00.000Z';
const DAY = '2026-09-16';

// A load as nuvizz-write-ops.normalizeLoad hands it back.
const load = (pairs, extra = []) => ({
  stops: [...pairs.map(([stopNbr, stopSeq]) => ({ stopNbr, stopSeq, stopType: 'DO' })), ...extra],
});

// ── deliveryOrderOf: the same projection the RWB verify judges a save by ─────

test('deliveryOrderOf reads VISIT ORDER off stopSeq, not array order', () => {
  assert.deepEqual(deliveryOrderOf(load([['007000003', 3], ['007000001', 1], ['007000002', 2]])),
    ['007000001', '007000002', '007000003']);
});

test('a PICKUP leg is not a delivery and never enters the history', () => {
  const l = load([['007000001', 2]], [{ stopNbr: 'PU-1', stopSeq: 1, stopType: 'PU' }]);
  assert.deepEqual(deliveryOrderOf(l), ['007000001']);
});

test('an unreadable load yields an empty order rather than throwing', () => {
  assert.deepEqual(deliveryOrderOf(null), []);
  assert.deepEqual(deliveryOrderOf({}), []);
});

// ── diffStopOrder ───────────────────────────────────────────────────────────

test('adds and removals are named, not counted', () => {
  const d = diffStopOrder(['a', 'b', 'c'], ['b', 'c', 'd']);
  assert.deepEqual(d.added, ['d']);
  assert.deepEqual(d.removed, ['a']);
  assert.equal(d.unchanged, false);
});

test('DROPPING THE FIRST STOP IS NOT A RESEQUENCE. Every remaining index shifts by one, and a '
  + 'history where almost every removal also says "resequenced" says nothing', () => {
  const d = diffStopOrder(['a', 'b', 'c', 'd'], ['b', 'c', 'd']);
  assert.deepEqual(d.removed, ['a']);
  assert.equal(d.resequenced, false, 'the stops that stayed kept their relative order');
});

test('a genuine reorder of the same stops IS a resequence', () => {
  assert.equal(diffStopOrder(['a', 'b', 'c'], ['c', 'a', 'b']).resequenced, true);
});

test('same members, same order → unchanged (a driver-only Save)', () => {
  const d = diffStopOrder(['a', 'b'], ['a', 'b']);
  assert.equal(d.unchanged, true);
  assert.deepEqual([d.added, d.removed], [[], []]);
});

test('AN ABSENT READ IS NOT AN EMPTY LOAD. before=null must never render as "this send added '
  + 'all seventeen stops"', () => {
  const d = diffStopOrder(null, ['a', 'b', 'c']);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.equal(d.unchanged, false, 'we do not know that nothing changed either');
});

// ── buildLoadSendRows: the verdict is what the SERVER observed ───────────────

const rowsFor = (payloadLoads, resultLoads, op = 'commitBoard') =>
  buildLoadSendRows({ at: AT, date: DAY, op, by: 'jrivera', clientOpId: 'op_1', payloadLoads, resultLoads });

test('a confirmed save records the verified before → after, and names both sides of the move', () => {
  const [r] = rowsFor(
    [{ loadNbr: 'L1', routeName: 'ALPHA', orderedStopNbrs: ['b', 'c', 'd'] }],
    [{ loadNbr: 'L1', ok: true, before: ['a', 'b', 'c'], after: ['b', 'c', 'd'], steps: [] }],
  );
  assert.equal(r.verdict, 'confirmed');
  assert.equal(r.routeName, 'ALPHA');
  assert.deepEqual(r.added, ['d']);
  assert.deepEqual(r.removed, ['a']);
  assert.equal(r.by, 'jrivera');
  assert.equal(r.date, DAY, 'filed against the BOARD day, not the day it was written');
});

test('A REFUSED SEND IS A ROW. "nothing happened at 2:14" and "we tried and NuVizz refused" are '
  + 'different facts, and the second is the one somebody has to act on', () => {
  const [r] = rowsFor(
    [{ loadNbr: 'L1', routeName: 'CHE', orderedStopNbrs: ['a', 'b'] }],
    [{ loadNbr: 'L1', ok: false, error: 'commitBoard(rwb): load not found', before: ['a'], steps: [] }],
  );
  assert.equal(r.verdict, 'refused');
  assert.match(r.error, /load not found/);
  assert.equal(r.after, null);
});

test('SCOTT/SHP29379: a FAILED save that read back a load which HAS moved is `partial`, not '
  + 'refused — that false ✗ over freight physically on the route is the whole reason '
  + 'observedOrder exists', () => {
  const [r] = rowsFor(
    [{ loadNbr: 'L1', routeName: 'SCOTT', orderedStopNbrs: ['a', 'b', 'SHP29379'] }],
    [{
      loadNbr: 'L1', ok: false, error: 'commitBoard(rwb): NuVizz kept its own sequence',
      before: ['a', 'b'], observedOrder: ['a', 'b', 'SHP29379'], steps: [],
    }],
  );
  assert.equal(r.verdict, 'partial');
  assert.deepEqual(r.added, ['SHP29379'], 'the stop that landed is named');
});

test('NEVER REPORT AN INTENT AS AN OUTCOME: with no read-back, `after` stays null and the label '
  + 'says so instead of printing the requested order', () => {
  const [r] = rowsFor(
    [{ loadNbr: 'L1', routeName: 'SUW', orderedStopNbrs: ['a', 'b', 'c'] }],
    [{ loadNbr: 'L1', ok: false, error: 'network error', before: ['a'], steps: [] }],
  );
  assert.equal(r.after, null);
  assert.match(changeLabel(r), /not read back/);
  assert.doesNotMatch(changeLabel(r), /\+2/, 'the requested order never becomes the outcome');
});

test('the driver is recorded only when the assign STEP came back ok — the name is the card\'s, '
  + 'the landing is the server\'s', () => {
  const ask = [{ loadNbr: 'L1', routeName: 'ALPHA', driverId: 7, driverName: 'Denis' }];
  const landed = rowsFor(ask, [{ loadNbr: 'L1', ok: true, before: ['a'], after: ['a'], steps: [{ op: 'assignDriver', ok: true }] }]);
  assert.equal(landed[0].driverSet, 'Denis');
  const refused = rowsFor(ask, [{ loadNbr: 'L1', ok: false, error: 'x', before: ['a'], after: ['a'], steps: [{ op: 'assignDriver', ok: false }] }]);
  assert.equal(refused[0].driverSet, null, 'an assign that failed never claims a driver');
});

test('dispatch is read off its own step', () => {
  const [r] = rowsFor(
    [{ loadNbr: 'L1', routeName: 'ALPHA', dispatch: true }],
    [{ loadNbr: 'L1', ok: true, before: ['a'], after: ['a'], steps: [{ op: 'dispatchLoad', ok: true }] }],
  );
  assert.equal(r.dispatched, true);
  assert.match(changeLabel(r), /dispatched/);
});

test('an emptied card reads as a CANCELLED route, because removing every delivery cancels it', () => {
  const [r] = rowsFor(
    [{ loadNbr: 'L1', routeName: 'TERRANCE', emptyLoad: true }],
    [{ loadNbr: 'L1', ok: true, before: ['a', 'b'], after: [], steps: [] }],
  );
  assert.equal(r.cancelled, true);
  assert.match(changeLabel(r), /route cancelled/);
});

test('＋ New route\'s Save reads as a route CREATED', () => {
  const [r] = rowsFor([{ routeName: 'NEW 1' }], [{ loadNbr: 'L9', ok: true, before: [], after: ['a', 'b'], steps: [] }], 'newRoute');
  assert.equal(r.created, true);
  assert.match(changeLabel(r), /route created/);
});

test('AUDIT C8 (the retarget twin): the row joins back to the card by the identity we SENT, so a '
  + 'server-resolved twin number cannot orphan the change from its route name', () => {
  const [r] = rowsFor(
    [{ loadNbr: 'ASKED', routeName: 'ALPHA', orderedStopNbrs: ['a'] }],
    [{ loadNbr: 'TWIN', requestedLoadNbr: 'ASKED', ok: true, before: [], after: ['a'], steps: [] }],
  );
  assert.equal(r.routeName, 'ALPHA');
  assert.equal(r.loadNbr, 'TWIN', 'and the number NuVizz actually acted on is kept, not hidden');
});

test('a result that joins to no card still produces a row — a quietly incomplete history is '
  + 'worse than a row with a thin name', () => {
  const rows = rowsFor([], [{ loadNbr: 'GHOST', ok: true, before: [], after: ['a'], steps: [] }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].loadNbr, 'GHOST');
});

test('a CREATE files both sides too: a route that did not exist held nothing, and what it holds '
  + 'now was read back off the created route', () => {
  // The shape runNewRoute answers with — one route, not a `loads` list.
  const [r] = buildLoadSendRows({
    at: AT, date: DAY, op: 'newRoute', by: 'jrivera', clientOpId: 'op_new',
    payloadLoads: [{ routeName: 'NEW 1', loadNbr: null }],
    resultLoads: [{ loadNbr: 'DAVIS9', loadId: 'hex9', routeName: 'NEW 1', ok: true, before: [], after: ['a', 'b'], driverApplied: true, dispatched: true, steps: [{ op: 'assignDriver', ok: true }, { op: 'dispatchLoad', ok: true }] }],
  });
  assert.equal(r.created, true);
  assert.equal(r.verdict, 'confirmed');
  assert.deepEqual(r.added, ['a', 'b'], 'the stops the create actually attached');
  assert.equal(r.dispatched, true);
  assert.match(changeLabel(r), /route created · \+2 stops/);
});

// ── selection ───────────────────────────────────────────────────────────────

const R = (over) => ({
  at: AT, date: DAY, loadNbr: 'L1', routeName: 'ALPHA', verdict: 'confirmed',
  before: [], after: [], added: [], removed: [], ...over,
});

test('a load filter matches the route NAME or the load number, case-insensitively', () => {
  const all = [R({ routeName: 'ALPHA' }), R({ routeName: 'SUW 2', loadNbr: 'L2' })];
  assert.equal(selectLoadSends(all, { load: 'alpha' }).length, 1);
  assert.equal(selectLoadSends(all, { load: 'L2' }).length, 1);
});

test('A STOP SEARCH MATCHES BOTH SIDES. "what happened to 007175992" is usually asked about a '
  + 'stop that was REMOVED, and matching only the after-list answers it with silence', () => {
  const all = [R({ removed: ['007175992'], before: ['007175992'] }), R({ after: ['007000001'] })];
  assert.equal(selectLoadSends(all, { stop: '007175992' }).length, 1);
});

test('zero-padding: 7175992 finds 007175992 (the v1.31.2 PRO-search lesson)', () => {
  const all = [R({ after: ['007175992'] })];
  assert.equal(selectLoadSends(all, { stop: '7175992' }).length, 1);
});

test('FILTER BEFORE THE CUT — a history routine traffic can crowd out is not a history '
  + '(the 2026-08-17 incident that nuvizz-write-log could not size)', () => {
  const noise = Array.from({ length: 25 }, () => R({ routeName: 'BULK' }));
  const wanted = R({ routeName: 'ALPHA', at: '2026-09-16T01:00:00.000Z' });
  const got = selectLoadSends([...noise, wanted], { load: 'ALPHA', limit: 5 });
  assert.equal(got.length, 1);
  assert.equal(got[0].routeName, 'ALPHA');
});

test('newest first', () => {
  const older = R({ at: '2026-09-16T01:00:00.000Z' });
  const newer = R({ at: '2026-09-16T09:00:00.000Z' });
  assert.equal(selectLoadSends([older, newer])[0].at, newer.at);
});

test('a row with no timestamp cannot be ordered and is dropped rather than listed out of place', () => {
  assert.equal(selectLoadSends([R({ at: null })]).length, 0);
});

// ── summary ─────────────────────────────────────────────────────────────────

test('the summary counts what is THERE, and keeps an honesty counter for rows never read back', () => {
  const sum = summarizeLoadSends([
    R({ verdict: 'confirmed', added: ['a', 'b'] }),
    R({ verdict: 'refused', after: null, routeName: 'SUW' }),
    R({ verdict: 'partial', removed: ['c'] }),
  ]);
  assert.equal(sum.rows, 3);
  assert.equal(sum.confirmed, 1);
  assert.equal(sum.refused, 1);
  assert.equal(sum.partial, 1);
  assert.equal(sum.loads, 2);
  assert.equal(sum.stopsAdded, 2);
  assert.equal(sum.stopsRemoved, 1);
  assert.equal(sum.unobserved, 1);
});

// ── the switch ──────────────────────────────────────────────────────────────

test('LOAD_HISTORY defaults ON, an explicit off-word turns it off, and a TYPO LEAVES IT ON — a '
  + 'mistyped env var must never silently disable a record nobody is watching', () => {
  assert.equal(loadHistoryEnabled({}), true);
  assert.equal(loadHistoryEnabled({ LOAD_HISTORY: '' }), true);
  for (const v of ['off', 'OFF', '0', 'false', 'no']) assert.equal(loadHistoryEnabled({ LOAD_HISTORY: v }), false, v);
  for (const v of ['offf', 'nope', 'disabled', 'on']) assert.equal(loadHistoryEnabled({ LOAD_HISTORY: v }), true, v);
});
