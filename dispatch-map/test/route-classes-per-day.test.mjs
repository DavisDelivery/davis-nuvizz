// THE ROUTE→CLASS MAP IS ONE DOCUMENT PER DAY NOW, AND THAT IS WHY THE BOARD GOES QUIET
// OVERNIGHT NO LONGER.
//
// Chad: "most routes have a driver assigned to them and we have an employee roster that
// tells what type of driver it is and we need to start using it."
//
// It WAS being used — by the daytime sweep, into a single document carrying a `date`. Because
// that document could only describe one day, the evening sweep (which resolves TOMORROW's
// trucks from the roster at 8pm, while routing is being built) deliberately threw its map
// away rather than put the browser's whole board on the wrong clock until 7am.
//
// The cost was invisible and exactly wrong: between 8pm and 7am — the hours loads actually
// get built — the board had NO class map, so every truck-class rule reported "not checked"
// on the one board where a wrong truck is still free to change for nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { routeClassesPath, legacyRouteClassesPath, readRouteClasses, TRAVEL_CAL_COLLECTION } from '../netlify/functions/lib/travel-store.mts';

const T = 'davis';
const TODAY = '2026-09-10';
const TOMORROW = '2026-09-11';

test('the day is in the KEY, so today and tomorrow are different documents', () => {
  assert.equal(routeClassesPath(T, TODAY), `${TRAVEL_CAL_COLLECTION}/davis__route_classes__2026-09-10`);
  assert.notEqual(routeClassesPath(T, TODAY), routeClassesPath(T, TOMORROW));
});

test("tomorrow's map is readable while today's still stands — the thing that could not happen before", async () => {
  const fake = installFirestoreFake({
    [routeClassesPath(T, TODAY)]: { tenant: T, date: TODAY, classes: { MANDI: 'box' } },
    [routeClassesPath(T, TOMORROW)]: { tenant: T, date: TOMORROW, classes: { MANDI: 'tractor' } },
  });
  try {
    // The same route, a different truck tomorrow — and both answers survive.
    assert.deepEqual(await readRouteClasses(T, TODAY), { MANDI: 'box' });
    assert.deepEqual(await readRouteClasses(T, TOMORROW), { MANDI: 'tractor' });
  } finally { fake.restore(); }
});

test('a day with no document reads as UNKNOWN, never as yesterday’s trucks', async () => {
  const fake = installFirestoreFake({
    [routeClassesPath(T, TODAY)]: { tenant: T, date: TODAY, classes: { MANDI: 'box' } },
  });
  try {
    // Drivers rotate. Absence has to stay absence — board-flags turns {} into
    // skipped.noTruckClasses, which reports "not checked" rather than reading every route
    // as a box truck.
    assert.deepEqual(await readRouteClasses(T, TOMORROW), {});
  } finally { fake.restore(); }
});

// ── THE DEPLOY WINDOW ───────────────────────────────────────────────────────

test('the pre-split document still answers for its own day, so the board is not blind until the next sweep', async () => {
  // Without this fallback every route would read unclassed from deploy until a sweep wrote
  // a per-day doc — a real regression, and a silent one, because "not checked" looks exactly
  // like what it always looks like.
  const fake = installFirestoreFake({
    [legacyRouteClassesPath(T)]: { tenant: T, date: TODAY, classes: { MANDI: 'box' } },
  });
  try {
    assert.deepEqual(await readRouteClasses(T, TODAY), { MANDI: 'box' });
  } finally { fake.restore(); }
});

test('the pre-split document may NOT answer for a day it is not about', async () => {
  // The one check the legacy document existed for, kept exactly: a map from another day is
  // a lie, whichever document it is in.
  const fake = installFirestoreFake({
    [legacyRouteClassesPath(T)]: { tenant: T, date: TODAY, classes: { MANDI: 'box' } },
  });
  try {
    assert.deepEqual(await readRouteClasses(T, TOMORROW), {});
  } finally { fake.restore(); }
});

test('the per-day document wins over a stale pre-split one for the same day', async () => {
  const fake = installFirestoreFake({
    [routeClassesPath(T, TODAY)]: { tenant: T, date: TODAY, classes: { MANDI: 'tractor' } },
    [legacyRouteClassesPath(T)]: { tenant: T, date: TODAY, classes: { MANDI: 'box' } },
  });
  try {
    assert.deepEqual(await readRouteClasses(T, TODAY), { MANDI: 'tractor' });
  } finally { fake.restore(); }
});

test('an empty per-day document falls through rather than masking the fallback', async () => {
  // A sweep that resolved nothing writes no classes; that must not shadow a legacy doc that
  // does have them.
  const fake = installFirestoreFake({
    [routeClassesPath(T, TODAY)]: { tenant: T, date: TODAY, classes: {} },
    [legacyRouteClassesPath(T)]: { tenant: T, date: TODAY, classes: { MANDI: 'box' } },
  });
  try {
    assert.deepEqual(await readRouteClasses(T, TODAY), { MANDI: 'box' });
  } finally { fake.restore(); }
});

// ── THE WAY BACK ────────────────────────────────────────────────────────────
//
// Chad: "if it changes something I do like I can just tell you to flip it back the way it was
// and it's an easy fix." ROUTE_CLASSES_PER_DAY=off is that flip. It has to restore the OLD
// behaviour exactly, on every side at once — a switch that half-reverts (a browser asking for
// a day nothing writes) is worse than no switch.

import { perDayRouteClassesEnabled } from '../netlify/functions/lib/travel-store.mts';

const withEnv = async (val, fn) => {
  const had = 'ROUTE_CLASSES_PER_DAY' in process.env;
  const prev = process.env.ROUTE_CLASSES_PER_DAY;
  if (val === undefined) delete process.env.ROUTE_CLASSES_PER_DAY;
  else process.env.ROUTE_CLASSES_PER_DAY = val;
  try { return await fn(); } finally {
    if (had) process.env.ROUTE_CLASSES_PER_DAY = prev;
    else delete process.env.ROUTE_CLASSES_PER_DAY;
  }
};

test('the switch is ON by default, and a typo cannot silently turn it off', () => {
  // A malformed value must not return the board to going blind overnight — that is the exact
  // failure this feature exists to end, and it is invisible when it happens.
  assert.equal(perDayRouteClassesEnabled({}), true);
  assert.equal(perDayRouteClassesEnabled({ ROUTE_CLASSES_PER_DAY: '' }), true);
  assert.equal(perDayRouteClassesEnabled({ ROUTE_CLASSES_PER_DAY: 'maybe' }), true);
  assert.equal(perDayRouteClassesEnabled({ ROUTE_CLASSES_PER_DAY: 'ON' }), true);
  for (const off of ['off', 'OFF', '0', 'false', 'no', '  No  ']) {
    assert.equal(perDayRouteClassesEnabled({ ROUTE_CLASSES_PER_DAY: off }), false, `${off} must turn it off`);
  }
});

test('OFF ignores the per-day document entirely and reads the old one — a real revert', async () => {
  const fake = installFirestoreFake({
    [routeClassesPath(T, TODAY)]: { tenant: T, date: TODAY, classes: { MANDI: 'tractor' } },
    [legacyRouteClassesPath(T)]: { tenant: T, date: TODAY, classes: { MANDI: 'box' } },
  });
  try {
    // ON, the per-day doc wins (previous test). OFF, the old document is the only one read —
    // so flipping the switch genuinely puts the answer back, it does not merely stop writing.
    await withEnv('off', async () => {
      assert.deepEqual(await readRouteClasses(T, TODAY), { MANDI: 'box' });
    });
  } finally { fake.restore(); }
});

test('OFF still refuses a map from another day — the one check that predates all of this', async () => {
  const fake = installFirestoreFake({
    [routeClassesPath(T, TOMORROW)]: { tenant: T, date: TOMORROW, classes: { MANDI: 'tractor' } },
    [legacyRouteClassesPath(T)]: { tenant: T, date: TODAY, classes: { MANDI: 'box' } },
  });
  try {
    await withEnv('off', async () => {
      // Tomorrow's per-day doc exists and is correct, but OFF means we do not look at it;
      // the legacy doc is today's, so tomorrow reads unknown. That IS the old behaviour.
      assert.deepEqual(await readRouteClasses(T, TOMORROW), {});
    });
  } finally { fake.restore(); }
});
