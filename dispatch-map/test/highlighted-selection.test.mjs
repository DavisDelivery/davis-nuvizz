// test/highlighted-selection.test.mjs — "＋ Add selection" accepts what is already lit.
//
// Chad, twice: "i don't want the add selection to prompt me to drag a box i want it to accept
// what i have already selected" → "accept the stops already highlighted on map."
//
// The rule pinned here is WHICH stops those are. It is not a matter of taste: the map's own
// definition of highlighted is one line in useLegendInventory (selected OR a search hit), and
// the addable half is the search hits minus what is already selected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { highlightedForSelection, areaSelectPartition, areaSelectSkipsPlanned, houseSwitchOn } from '../src/lib/routing-select.js';

const stop = (n, extra = {}) => ({ stopNbr: n, lat: 35.1, lng: -80.8, businessName: `S${n}`, ...extra });
const ids = (...n) => new Set(n.map(String));
const nbrs = (arr) => arr.map((s) => String(s.stopNbr));

test('A SEARCH FOR A CUSTOMER, THEN ONE TAP: the burnt-orange pins become the selection', () => {
  const drawn = [stop(1), stop(2), stop(3), stop(4)];
  const take = highlightedForSelection(drawn, { searchMatchIds: ids(2, 4), selectedIds: ids() });
  assert.deepEqual(nbrs(take), ['2', '4']);
});

test('stops ALREADY IN the selection are not offered again — the button would be a no-op', () => {
  const drawn = [stop(1), stop(2), stop(3)];
  const take = highlightedForSelection(drawn, { searchMatchIds: ids(1, 2, 3), selectedIds: ids(2) });
  assert.deepEqual(nbrs(take), ['1', '3']);
});

test('NO SEARCH RUNNING → nothing is highlighted, so there is nothing to accept', () => {
  // This is the case that must fall back to the box draw rather than leave a dead button.
  assert.deepEqual(highlightedForSelection([stop(1), stop(2)], { searchMatchIds: null, selectedIds: ids() }), []);
});

test('a search that matches the WHOLE selection already leaves nothing — box draw, not a dead press', () => {
  const take = highlightedForSelection([stop(1), stop(2)], { searchMatchIds: ids(1, 2), selectedIds: ids(1, 2) });
  assert.equal(take.length, 0);
});

test('A STOP WITH NO GEOCODE NEVER RIDES IN — it has no pin, and a build would drop it silently', () => {
  // It lists in the grid and matches the search, so a raw match list WOULD hand it over. It
  // has no marker, cannot be box-selected, and the map's stopById is coord-only: in a build it
  // is an order that vanishes. The one shape this rule exists to stop.
  const drawn = [stop(1), { stopNbr: 2, lat: null, lng: null, businessName: 'NO PIN' }, stop(3, { lng: undefined })];
  const take = highlightedForSelection(drawn, { searchMatchIds: ids(1, 2, 3), selectedIds: ids() });
  assert.deepEqual(nbrs(take), ['1']);
});

test('only what the MAP IS DRAWING counts — a stop the status filter hid is not highlighted', () => {
  // drawnStops is already filtered upstream; feeding it is what makes the button WYSIWYG.
  const onMap = [stop(1), stop(3)];               // 2 was filtered out of the map
  const take = highlightedForSelection(onMap, { searchMatchIds: ids(1, 2, 3), selectedIds: ids() });
  assert.deepEqual(nbrs(take), ['1', '3']);
});

test('numeric and string stop numbers both match — the two surfaces key them differently', () => {
  const take = highlightedForSelection([{ stopNbr: 7, lat: 1, lng: 2 }], { searchMatchIds: ids(7), selectedIds: null });
  assert.deepEqual(nbrs(take), ['7']);
});

test('EMPTY, ABSENT AND MALFORMED: no map, no stops, no sets — never throws, never invents', () => {
  assert.deepEqual(highlightedForSelection(null, { searchMatchIds: ids(1) }), []);
  assert.deepEqual(highlightedForSelection(undefined, {}), []);
  assert.deepEqual(highlightedForSelection([stop(1)], {}), []);
  assert.deepEqual(highlightedForSelection([null, undefined, stop(1)], { searchMatchIds: ids(1) }).length, 1);
  assert.deepEqual(highlightedForSelection([stop(1)], { searchMatchIds: ['1'] }), [], 'an array is not a Set — no .has, so nothing is taken');
});

test('THE SKIPS STILL APPLY — a sent load stays sent, because this feeds the SAME area-select path', () => {
  // v1.36.3, Chad: "its letting me select stops that are already on routes that have been sent
  // to nuvizz." Accepting a highlight must not be a second door around that rule, so the handler
  // hands this list to addEnclosed → areaSelectPartition, exactly as box and lasso do.
  const drawn = [stop(1), stop(2, { routeName: 'CHE', stopStatus: 'SCHEDULED' }), stop(3)];
  const lit = highlightedForSelection(drawn, { searchMatchIds: ids(1, 2, 3), selectedIds: ids() });
  assert.deepEqual(nbrs(lit), ['1', '2', '3'], 'the rule reports what is lit; the partition decides what is taken');
  const part = areaSelectPartition(lit, { staged: new Map([['3', 'CHE']]), skipPlanned: true });
  assert.deepEqual(nbrs(part.take), ['1']);
  assert.deepEqual(nbrs(part.onLoads), ['2'], 'a stop already planned onto a load is left alone');
  assert.deepEqual(nbrs(part.onCards), ['3'], 'a stop staged on an open Compare card is left alone');
});

// ── PUT IT BACK ───────────────────────────────────────────────────────────────
// Chad: "build this in such a way if it changes something I do like I can just tell you to
// flip it back the way it was and it's an easy fix." This ALTERS a button that already
// worked, so it ships behind VITE_ROUTING_ADD_SELECTION_ACCEPTS_HIGHLIGHT.
test('THE HOUSE SWITCH SHAPE: default ON, an explicit off-word off, ANYTHING MALFORMED STILL ON', () => {
  assert.equal(houseSwitchOn(undefined), true, 'unset must be ON — that is the shipped default');
  assert.equal(houseSwitchOn(''), true);
  assert.equal(houseSwitchOn(null), true);
  for (const off of ['off', 'OFF', ' Off ', '0', 'false', 'FALSE', 'no', 'No']) {
    assert.equal(houseSwitchOn(off), false, `${JSON.stringify(off)} should turn it off`);
  }
  // The important half: a TYPO must never silently disable a rule, because a quiet feature
  // looks exactly like a working one and nobody goes looking for it.
  for (const typo of ['offf', 'disabled', 'no!', 'true', '1', 'yes', 'ON', {}, 7]) {
    assert.equal(houseSwitchOn(typo), true, `${JSON.stringify(typo)} is malformed — it must leave the rule ON`);
  }
});

test('areaSelectSkipsPlanned still answers identically — one shape, two flags', () => {
  for (const raw of [undefined, '', 'off', '0', 'false', 'no', 'typo', 'on']) {
    assert.equal(areaSelectSkipsPlanned(raw), houseSwitchOn(raw), `disagreement on ${JSON.stringify(raw)}`);
  }
});
