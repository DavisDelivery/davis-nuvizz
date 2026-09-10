// CLICKING A DOT ON THE ROUTING MAP MUST SAY WHAT THE ORDER IS.
//
// Chad, on GEORGE L's route: "If i click on one of these dots on the map i want it to bring
// that orders details on in the right panel." It did not — the dispatch Map has opened a stop
// on its own marker click since it was built, and Routing was never wired for it.
//
// These pin the RULE, not the handler: the handler lives inside a marker-building effect in a
// 25,000-line module node:test cannot import, and Google Maps is blocked in the headless
// guard, so a real marker click is observable at neither end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapPinClickActions } from '../src/lib/routing-select.js';

// ── THE ASK ──────────────────────────────────────────────────────────────────

test('a numbered pin on a planned route opens the order — the thing it could not do', () => {
  const act = mapPinClickActions({ isUnplanned: false, hasRouteKey: true });
  assert.equal(act.openPanel, true);
});

test('opening the order does NOT cost the route card the pin already opened', () => {
  // Nothing is taken away: a planned pin still opens its route in Compare. If this ever
  // becomes an either/or, a router loses the whole-route view he has had for months.
  const act = mapPinClickActions({ isUnplanned: false, hasRouteKey: true });
  assert.equal(act.openRoute, true);
  assert.equal(act.toggleGroup, false);
});

test('a pool pin opens the order AND still toggles its whole place into the selection', () => {
  const act = mapPinClickActions({ isUnplanned: true });
  assert.equal(act.openPanel, true);
  assert.equal(act.toggleGroup, true);
  assert.equal(act.openRoute, false);
});

test('a planned stop with no route key falls back to the place toggle rather than doing nothing', () => {
  const act = mapPinClickActions({ isUnplanned: false, hasRouteKey: false });
  assert.equal(act.toggleGroup, true);
  assert.equal(act.openRoute, false);
});

// ── VIEWING: THE CLICK THAT USED TO DO NOTHING ───────────────────────────────

test('on a saved load the pin opens the order — reading was always the safe half', () => {
  // The read-only guard existed to stop WRITES. It also swallowed the click entirely, so the
  // one screen where you most want to ask "what is this stop?" answered nothing at all.
  const act = mapPinClickActions({ viewing: true, isUnplanned: false, hasRouteKey: true });
  assert.equal(act.openPanel, true);
});

test('a saved load still takes no write from a pin click', () => {
  const act = mapPinClickActions({ viewing: true, paint: true, isUnplanned: true, hasRouteKey: true });
  assert.deepEqual(
    { paint: act.paint, selectPoint: act.selectPoint, ninjaAdd: act.ninjaAdd, openRoute: act.openRoute, toggleGroup: act.toggleGroup },
    { paint: false, selectPoint: false, ninjaAdd: false, openRoute: false, toggleGroup: false },
  );
});

// ── THE TWO TOOLS THAT MUST NOT GET A CARD ───────────────────────────────────

test('select-mode gets no card: it is asking for a POINT, not about this order', () => {
  // The handler hands select-mode the MARKER'S POSITION, not the stop. A card about a stop is
  // the wrong answer to "where on the map?" and would cover the map mid-draw.
  const act = mapPinClickActions({ selectMode: true });
  assert.equal(act.openPanel, false);
  assert.equal(act.selectPoint, true);
});

test('ninja-add gets no card: it is a rapid queue and a card on every stop fights it', () => {
  const act = mapPinClickActions({ ninja: true });
  assert.equal(act.openPanel, false);
  assert.equal(act.ninjaAdd, true);
});

// ── PAINT MODE KEEPS THE BEHAVIOUR IT WAS GIVEN ──────────────────────────────

test('paint mode still does both — the mark and the card', () => {
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

test('no arguments at all does not throw and does not act', () => {
  const a = mapPinClickActions();
  assert.equal(a.openPanel, true);       // a bare click is still "what is this?"
  assert.equal(a.toggleGroup, true);     // the pool default
});
