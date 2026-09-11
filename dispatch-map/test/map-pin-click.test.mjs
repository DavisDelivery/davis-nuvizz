// CLICKING A DOT ON THE ROUTING MAP MUST NOT OPEN THE ORDER.
//
// Chad, 2026-09-11, one day after asking for the opposite: "i asked that when i click on a
// stop it opens the stop and i don't want that to happen anymore, i don't want it to open
// every order i click on when i'm clicking it on the map."
//
// A pin is how a load gets BUILT — put this on the truck, show me this route, grab this whole
// dock — and on a 700-stop morning that is hundreds of clicks. A card on each one covers the
// map and takes the right rail off the route being tuned. The rows still open the card.
//
// These pin the RULE, not the handler: the handler lives inside a marker-building effect in a
// 25,000-line module node:test cannot import, and Google Maps is blocked in the headless
// guard, so a real marker click is observable at neither end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapPinClickActions } from '../src/lib/routing-select.js';

// ── THE ASK: NO CARD OFF A PIN ───────────────────────────────────────────────

test('a numbered pin on a planned route does NOT open the order card', () => {
  const act = mapPinClickActions({ isUnplanned: false, hasRouteKey: true });
  assert.equal(act.openPanel, false);
});

test('a pool pin does NOT open the order card either — every order, he said', () => {
  const act = mapPinClickActions({ isUnplanned: true });
  assert.equal(act.openPanel, false);
});

test('a pin click still does its routing job: planned opens the route in Compare', () => {
  // Taking the card away must not take the pin's real work with it.
  const act = mapPinClickActions({ isUnplanned: false, hasRouteKey: true });
  assert.equal(act.openRoute, true);
  assert.equal(act.toggleGroup, false);
});

test('a pool pin still toggles its whole place into the selection', () => {
  const act = mapPinClickActions({ isUnplanned: true });
  assert.equal(act.toggleGroup, true);
  assert.equal(act.openRoute, false);
});

test('a planned stop with no route key falls back to the place toggle rather than doing nothing', () => {
  const act = mapPinClickActions({ isUnplanned: false, hasRouteKey: false });
  assert.equal(act.toggleGroup, true);
  assert.equal(act.openRoute, false);
});

// ── VIEWING: A SAVED LOAD IS READ-ONLY AND THE CLICK DOES NOTHING ────────────

test('on a saved load a pin click does nothing at all — no card, no write', () => {
  const act = mapPinClickActions({ viewing: true, isUnplanned: false, hasRouteKey: true });
  assert.deepEqual(act, {
    openPanel: false, paint: false, selectPoint: false, ninjaAdd: false, openRoute: false, toggleGroup: false,
  });
});

test('a saved load takes no write from a pin click even with a brush armed', () => {
  const act = mapPinClickActions({ viewing: true, paint: true, isUnplanned: true, hasRouteKey: true });
  assert.deepEqual(act, {
    openPanel: false, paint: false, selectPoint: false, ninjaAdd: false, openRoute: false, toggleGroup: false,
  });
});

// ── THE DRAW AND QUEUE TOOLS ARE UNCHANGED ───────────────────────────────────

test('select-mode gets no card: it is asking for a POINT, not about this order', () => {
  const act = mapPinClickActions({ selectMode: true });
  assert.equal(act.openPanel, false);
  assert.equal(act.selectPoint, true);
});

test('ninja-add gets no card: it is a rapid queue and a card on every stop fights it', () => {
  const act = mapPinClickActions({ ninja: true });
  assert.equal(act.openPanel, false);
  assert.equal(act.ninjaAdd, true);
});

// ── PAINT IS THE ONE EXCEPTION, AND IT IS OLDER THAN THE CHANGE BEING UNDONE ─

test('paint mode still does both — the mark and the card ("first click does both")', () => {
  // A separate, earlier dispatcher request. It was not what Chad asked to go away, and paint
  // is one deliberate click at a time rather than the routing rhythm. If he wants it gone,
  // this is the test that changes.
  const act = mapPinClickActions({ paint: true, isUnplanned: true });
  assert.equal(act.paint, true);
  assert.equal(act.openPanel, true);
  // and it does not ALSO toggle the place into the selection behind the paint
  assert.equal(act.toggleGroup, false);
});

// ── ONE CLICK NEVER FIRES TWO CONFLICTING TOOLS ──────────────────────────────

test('exactly one tool action fires per click, in every mode', () => {
  const modes = [
    { name: 'normal planned', o: { isUnplanned: false, hasRouteKey: true } },
    { name: 'normal pool', o: { isUnplanned: true } },
    { name: 'paint', o: { paint: true } },
    { name: 'select', o: { selectMode: true } },
    { name: 'ninja', o: { ninja: true } },
    { name: 'paint+select armed', o: { paint: true, selectMode: true } },
  ];
  for (const { name, o } of modes) {
    const a = mapPinClickActions(o);
    const fired = [a.paint, a.selectPoint, a.ninjaAdd, a.openRoute, a.toggleGroup].filter(Boolean).length;
    assert.equal(fired, 1, `${name} fired ${fired} tool actions, expected exactly 1`);
  }
});

test('the ONLY mode that opens a card is paint', () => {
  // The mutation this catches is the one that just shipped and was rolled back: a card that
  // creeps onto the ordinary routing click. Named so that putting it back is a decision
  // somebody makes on purpose.
  const modes = [
    { name: 'normal planned', o: { isUnplanned: false, hasRouteKey: true } },
    { name: 'normal pool', o: { isUnplanned: true } },
    { name: 'viewing', o: { viewing: true, hasRouteKey: true } },
    { name: 'select', o: { selectMode: true } },
    { name: 'ninja', o: { ninja: true } },
    { name: 'no arguments', o: undefined },
  ];
  for (const { name, o } of modes) {
    assert.equal(mapPinClickActions(o).openPanel, false, `${name} opened the order card`);
  }
  assert.equal(mapPinClickActions({ paint: true }).openPanel, true);
});

test('no arguments at all does not throw and does not open a card', () => {
  const a = mapPinClickActions();
  assert.equal(a.openPanel, false);
  assert.equal(a.toggleGroup, true);     // the pool default
});
