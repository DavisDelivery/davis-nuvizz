// THE BIG TRUCK HAS TO CARRY ITS SHARE, AND A TRUCK THAT GOT NOTHING HAS TO SAY SO.
//
// Chad: "if i give it 2 boxes and 1 tractor and 30 stops it puts what it knows is tractor
// friendly on the tractor and rest on the boxes."
//
// Measured on the real modules before this change, with the shipped default profiles:
//   clean board          BOX-1=14  BOX-2=6   TRACTOR=10
//   8 box-only stops     BOX-1=14  BOX-2=14  TRACTOR=2     <- both boxes at their 14-skid
//                                                             ceiling, the 28-skid trailer
//                                                             following them around
// Growth was purely nearest-pair: whichever truck's territory happened to be closest won
// every stop until it physically could not take another. Nothing in the loop knew one truck
// was full while another was empty — and the objectiveWeights `balance` the request has always
// carried was plumbed the whole way in and never read.
//
// These tests run the REAL solver. They are about the ratio between trucks, not about exact
// stop counts, because the counts move with any geometry change and the property does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { solveRouting } from '../netlify/functions/lib/routing-solver.mts';
import { capacityBreaches, loadFraction, CAPACITY_GATES } from '../netlify/functions/lib/routing-constraints.mts';

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const R = 6371000, rad = (d) => (d * Math.PI) / 180;
const hav = (a, b) => {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
const box = (id) => ({ id, label: id, maxSkids: 14, maxWeightLbs: 10000, deckLengthIn: 312,
  capabilities: { liftgate: true, tractor: false, lengthClassFt: 26, overheadClearance: true } });
const tractor = (id) => ({ id, label: id, maxSkids: 28, maxWeightLbs: 44000, deckLengthIn: 636,
  capabilities: { liftgate: false, tractor: true, lengthClassFt: 53, overheadClearance: true } });
const CLUSTERS = [{ lat: 33.95, lng: -84.55 }, { lat: 33.75, lng: -84.39 }, { lat: 34.06, lng: -84.10 }];
const board = (n, boxOnlyCount = 0) => Array.from({ length: n }, (_, i) => {
  const c = CLUSTERS[i % CLUSTERS.length];
  return {
    id: `S${i}`, lat: c.lat + ((i * 37) % 17) / 300, lng: c.lng - ((i * 53) % 19) / 300,
    skids: 1, weightLbs: 600, linearFeetIn: 48, serviceMin: 14,
    equipmentReqs: i < boxOnlyCount ? ['box_truck_only'] : [],
  };
});
const run = (stops, trucks) => {
  const pts = [DEPOT, ...stops];
  const distanceMeters = pts.map((a) => pts.map((b) => hav(a, b)));
  return solveRouting({
    stops, trucks, depot: DEPOT,
    matrix: { distanceMeters, durationSec: distanceMeters.map((r) => r.map((m) => m / 13)) },
    strategy: 'min_distance', objectiveWeights: { distance: 1, time: 0, balance: 1 },
    windowMode: 'advisory',
  });
};
const counts = (out) => Object.fromEntries(out.routes.map((r) => [r.truckId, (r.orderedStopIds || r.stops || []).length]));

test('30 stops over 2 boxes and a tractor: the trailer carries a real share, not the leftovers', () => {
  const out = run(board(30), [box('BOX-1'), box('BOX-2'), tractor('TRACTOR')]);
  const c = counts(out);
  assert.equal(out.routes.length, 3, 'all three trucks must get a route');
  assert.equal(Object.values(c).reduce((a, b) => a + b, 0), 30, 'every stop placed');
  // The property, stated the way a dispatcher would: the biggest truck is not the smallest route.
  assert.ok(c.TRACTOR >= 7, `the 28-skid trailer took only ${c.TRACTOR} of 30 — it used to take 2`);
  const spread = Math.max(...Object.values(c)) - Math.min(...Object.values(c));
  assert.ok(spread <= 6, `routes are lopsided by ${spread} stops: ${JSON.stringify(c)}`);
});

test('a normal day (8 stops a 53 cannot serve) still fills the trailer', () => {
  const out = run(board(30, 8), [box('BOX-1'), box('BOX-2'), tractor('TRACTOR')]);
  const c = counts(out);
  assert.equal(Object.values(c).reduce((a, b) => a + b, 0), 30);
  assert.ok(c.TRACTOR >= 5, `the trailer took ${c.TRACTOR} of 30 with 8 stops barred from it (was 2)`);
  // And nothing box-only ended up on the trailer — the hard rule still outranks the preference.
  const trailer = out.routes.find((r) => r.truckId === 'TRACTOR');
  const barred = new Set(board(30, 8).filter((s) => s.equipmentReqs.length).map((s) => s.id));
  for (const id of (trailer.orderedStopIds || [])) {
    assert.equal(barred.has(String(id)), false, `${id} is box-only and must never ride the trailer`);
  }
});

test('EQUIPMENT IS STILL ABSOLUTE — balance is a preference and can never override it', () => {
  // Every stop box-only, so the trailer must end up with nothing however empty it is.
  const out = run(board(10, 10), [box('BOX-1'), tractor('TRACTOR')]);
  const trailer = out.routes.find((r) => r.truckId === 'TRACTOR');
  assert.equal(trailer, undefined, 'a trailer cannot take freight that bars trailers, at any cost');
});

test('A TRUCK THAT GOT NOTHING IS NAMED, WITH THE REAL REASON', () => {
  // The visible half of the "only green on a trailer" trap: pick three, get two cards, and
  // nothing anywhere says which one went unused.
  const out = run(board(6, 6), [box('BOX-1'), tractor('TRACTOR')]);
  assert.equal(out.routes.length, 1);
  assert.equal(out.idleTrucks.length, 1);
  assert.equal(out.idleTrucks[0].truckId, 'TRACTOR');
  assert.equal(out.idleTrucks[0].label, 'TRACTOR');
  assert.match(out.idleTrucks[0].reason, /no selected stop is allowed on this truck/);
});

test('an idle truck that COULD have carried the work says so differently', () => {
  // Two stops, two trucks: one truck wins both and the other is idle for want of work, not
  // for want of ability. Telling those apart is the whole value of the line.
  const out = run(board(2), [box('BOX-1'), box('BOX-2')]);
  const idle = out.idleTrucks || [];
  if (idle.length) assert.match(idle[0].reason, /covered every stop before this one was needed/);
});

test('every truck routed → idleTrucks is empty, never undefined', () => {
  const out = run(board(30), [box('BOX-1'), box('BOX-2'), tractor('TRACTOR')]);
  assert.deepEqual(out.idleTrucks, []);
});

test('the DECK gate is off, so nothing may ever spill for deck length', () => {
  // routing-repair carried its own copy of the capacity rule that honoured neither the gates
  // nor the positive-cap guard, so it spilled on deck length — a reason routing-constraints
  // says can never happen — after shredding the geographic assignment to satisfy it.
  assert.equal(CAPACITY_GATES.deckLengthIn, false);
  const truck = box('B');
  const over = { skids: 1, weightLbs: 100, linearFeetIn: 99999 };
  assert.deepEqual(capacityBreaches(over, truck), [], 'a switched-off gate must not produce a reason');
  const out = run(board(30, 30), [box('BOX-1'), box('BOX-2')]);
  for (const u of out.unassigned || []) {
    for (const r of u.reasons || []) {
      assert.doesNotMatch(r, /deck length/, `spilled ${u.stopId} for a limit that is not enforced`);
    }
  }
});

test('a missing or zero capacity means NO LIMIT, never "full" — in the shared rule', () => {
  const noCap = { ...box('X'), maxSkids: 0, maxWeightLbs: null, deckLengthIn: undefined };
  assert.deepEqual(capacityBreaches({ skids: 99, weightLbs: 99999, linearFeetIn: 9999 }, noCap), []);
  assert.equal(loadFraction({ skids: 99, weightLbs: 9, linearFeetIn: 9 }, noCap), 0, 'unknown is not full');
});

test('loadFraction reads the fullest GATED dimension, and only gated ones', () => {
  const t = box('B');   // 14 skids, 10000 lb
  assert.equal(loadFraction({ skids: 7, weightLbs: 0, linearFeetIn: 0 }, t), 0.5);
  assert.equal(loadFraction({ skids: 0, weightLbs: 5000, linearFeetIn: 0 }, t), 0.5);
  assert.equal(loadFraction({ skids: 7, weightLbs: 9000, linearFeetIn: 0 }, t), 0.9, 'the fullest one decides');
  // Deck is not gated, so a huge deck figure must not read as full.
  assert.equal(loadFraction({ skids: 0, weightLbs: 0, linearFeetIn: 99999 }, t), 0);
});
