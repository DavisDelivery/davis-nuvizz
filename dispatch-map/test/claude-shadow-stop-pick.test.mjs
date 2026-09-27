// test/claude-shadow-stop-pick.test.mjs — PICKING A SECTION'S STOPS ON THE MAP (v1.78.0): the rules.
//
// Chad, 2026-09-27: "a map in a drawer and can select the stops i want you to put the stops on." What a
// dispatcher relies on: a tap picks or unpicks; an area takes every stop in it that may be picked and
// nothing else; a stop on a load in NuVizz (planning unplanned only) or one an earlier section placed
// cannot be picked; and the totals are what is picked, not what is drawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickable, stopState, toggleStop, boxFrom, inBox, addInBox, pruneSel, selTotals, boundsOf, pickGeo } from '../src/shadow/stop-pick-core.js';

const S = (n, lat, lng, o = {}) => ({ n, lat, lng, name: `CUST ${n}`, city: 'BUFORD', spots: 2, lbs: 500, noTractor: false, onLoad: null, earlier: null, ...o });
const stops = [
  S('A', 34.0, -84.0), S('B', 34.1, -84.1), S('C', 34.5, -83.5),
  S('L', 34.05, -84.05, { onLoad: 'SCOTT' }),
  S('E', 34.02, -84.02, { earlier: { route: 'SPARE BOX 1', driver: '(no driver)' } }),
  S('T', 34.03, -84.03, { noTractor: true, spots: 1.5, lbs: 250 }),
];

test('what may be picked: not a stop an earlier section placed; a stop on a load in NuVizz only when planning every open stop', () => {
  assert.equal(pickable(stops[0], 'unplanned'), true);
  assert.equal(pickable(stops[3], 'unplanned'), false, 'on SCOTT in NuVizz: it stays there');
  assert.equal(pickable(stops[3], 'open'), true, 'a full re-plan may move it');
  assert.equal(pickable(stops[4], 'open'), false, 'placed by the earlier section: it rides its truck');
  assert.equal(pickable(null, 'open'), false);
  const sel = new Set(['A', 'L']);
  assert.equal(stopState(stops[0], sel, 'unplanned'), 'picked');
  assert.equal(stopState(stops[3], sel, 'unplanned'), 'onload', 'a stale pick of a stop that cannot be picked is not drawn as picked');
  assert.equal(stopState(stops[3], sel, 'open'), 'picked');
  assert.equal(stopState(stops[4], sel, 'open'), 'earlier');
  assert.equal(stopState(stops[1], sel, 'open'), 'free');
});

test('a tap picks a stop and a second tap takes it off; a tap on a stop that cannot be picked changes nothing', () => {
  let sel = new Set();
  sel = toggleStop(sel, stops[0], 'unplanned');
  assert.deepEqual([...sel], ['A']);
  sel = toggleStop(sel, stops[0], 'unplanned');
  assert.deepEqual([...sel], []);
  const before = new Set(['B']);
  assert.equal(toggleStop(before, stops[3], 'unplanned'), before, 'the same set back — nothing picked');
  assert.equal(toggleStop(before, stops[4], 'open'), before);
});

test('an area takes every stop in it that may be picked, whichever way the box was dragged, and says how many were new', () => {
  const b = boxFrom({ lat: 34.2, lng: -83.9 }, { lat: 33.9, lng: -84.2 });
  assert.deepEqual(b, { north: 34.2, south: 33.9, east: -83.9, west: -84.2 });
  assert.equal(inBox(stops[2], b), false, 'C is outside');
  const r = addInBox(new Set(['A']), stops, b, 'unplanned');
  assert.deepEqual([...r.next].sort(), ['A', 'B', 'T'], 'A kept, B and T added; L on a load and E placed earlier are not');
  assert.equal(r.added, 2);
  assert.equal(addInBox(new Set(), stops, b, 'open').next.has('L'), true, 'planning every open stop, the stop on a load is taken too');
  assert.equal(boxFrom({ lat: NaN, lng: 1 }, { lat: 1, lng: 1 }), null, 'a corner that is not a place is no box');
  assert.equal(addInBox(new Set(), stops, null, 'open').added, 0);
});

test('when the board is read again, a pick no longer offered comes off, and how many is said', () => {
  const r = pruneSel(new Set(['A', 'L', 'GONE']), stops, 'unplanned');
  assert.deepEqual([...r.next], ['A']);
  assert.equal(r.dropped, 2);
  assert.equal(pruneSel(new Set(['A']), stops, 'unplanned').dropped, 0);
});

test('the totals are the picked stops: skid spots, pounds and the no-tractor ones — with nothing picked, zeros', () => {
  assert.deepEqual(selTotals(stops, new Set(['A', 'T'])), { stops: 2, spots: 3.5, lbs: 750, noTractor: 1 });
  assert.deepEqual(selTotals(stops, new Set()), { stops: 0, spots: 0, lbs: 0, noTractor: 0 });
  assert.deepEqual(selTotals([S('X', 1, 1, { spots: null, lbs: undefined })], new Set(['X'])), { stops: 1, spots: 0, lbs: 0, noTractor: 0 }, 'a missing number adds nothing, never NaN');
});

test('the map frames every stop, draws one point per stop keyed by its number, and says in its title what it is', () => {
  assert.deepEqual(boundsOf(stops), { north: 34.5, south: 34.0, east: -83.5, west: -84.1 });
  assert.equal(boundsOf([]), null);
  assert.equal(boundsOf([S('Z', null, null)]), null);
  const g = pickGeo([...stops, S('Z', null, -84)]);
  assert.equal(g.features.length, stops.length, 'a stop with no map point is not drawn');
  assert.deepEqual(g.features[0].geometry.coordinates, [-84, 34]);
  assert.equal(g.features[0].properties.n, 'A');
  assert.match(g.features.find((f) => f.properties.n === 'L').properties.title, /on SCOTT in NuVizz/);
  assert.match(g.features.find((f) => f.properties.n === 'E').properties.title, /placed on SPARE BOX 1 by the earlier section/);
});

test('a stop an earlier section left off is free to pick again, drawn apart, and says why it was left off', () => {
  const lo = S('O', 34.0, -84.0, { leftOff: 'no truck had room' });
  assert.equal(pickable(lo, 'unplanned'), true);
  assert.equal(stopState(lo, new Set(), 'unplanned'), 'leftoff');
  assert.equal(stopState(lo, new Set(['O']), 'unplanned'), 'picked');
  assert.match(pickGeo([lo]).features[0].properties.title, /left off by an earlier section: no truck had room/);
});
