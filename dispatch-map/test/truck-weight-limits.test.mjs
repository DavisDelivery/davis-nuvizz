// test/truck-weight-limits.test.mjs — ONE WEIGHT LIMIT PER TRUCK, WRITTEN IN FOUR PLACES.
//
// Chad, 2026-09-26: "10,000 pound limit on box trucks and 30,000 on tractors is the weight limits."
//
// The same default is written into the code four times, because four systems each needed a number
// before the others existed:
//
//   1. CLIENT_DEFAULT_TRUCKS (src/App.jsx) — THE ONE THAT SEEDS THE LIVE BUILDER. When
//      truck_profiles is empty the browser writes these as the 26ft Box and 53ft Trailer cards,
//      and the Build panel's route builder reads those cards by id from then on.
//   2. DEFAULT_TRUCK_PROFILES (netlify/functions/lib/truck-profiles.mts) — the server's copy.
//      Nothing seeds from it today (ensureSeedProfiles has no callers); the Claude backtest's pin
//      already compared its own copy to this one.
//   3. engineConfigDefaults().weight_cap_{box,tractor}_lb (routing-engine-config.mts) — the
//      engine's per-trip payload cap when nobody has set one (By driver, the nightly engine).
//   4. PROFILE_MAX_LBS (lib/claude-shadow/backtest-core.mts) — the Claude backtest's and planner's
//      limit when Router settings leave it blank.
//
// WHY THIS FILE EXISTS. On Sep 26 Chad was told "a test now pins them together, so they can't
// drift apart again". It did not: only 4 was compared to 2. The client seed — the copy that actually
// seeds production — could be set back to 44,000 with the whole suite green (measured Sep 27 with
// this file set aside), and the engine's default was pinned only to a bare literal. This pins all four.
//
// WHAT IT PINS IS THE AGREEMENT, NOT THE NUMBER. The number itself (10,000 / 30,000) is already
// pinned by routing-skid-caps.test.mjs (classCapsFor on engineConfigDefaults({}); #1022 changed its
// tractor line along with the four copies) — so with this file, all four are held to Chad's numbers.
// Nothing here names 30,000 on purpose: the v1.73.1 row's way back is "revert this commit", and a
// copy of the number in a file #1022 never touched turns that revert red (two v1.74.0 backtest tests
// already do — measured Sep 27, the only failures after a revert). A revert of #1022 moves all four
// copies and the skid-caps line together, and this file stays green through it.
//
// WHAT IT CANNOT PIN: the live truck cards in Firestore and any Engine-tab or Router-settings
// override. Those are data, changed on screen, and a test of the code cannot see them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_TRUCK_PROFILES } from '../netlify/functions/lib/truck-profiles.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';
import { PROFILE_MAX_LBS } from '../netlify/functions/lib/claude-shadow/backtest-core.mts';

/**
 * CLIENT_DEFAULT_TRUCKS, read out of App.jsx's SOURCE. App.jsx is a React module that cannot be
 * imported here, and the constant is not exported — so the array literal is cut out of the text
 * and evaluated. It holds only plain object literals; if that ever changes, or the constant moves
 * or is renamed, this throws with a message saying so rather than passing on nothing.
 */
function clientDefaultTrucks(source) {
  const anchor = 'const CLIENT_DEFAULT_TRUCKS = [';
  const at = source.indexOf(anchor);
  assert.notEqual(at, -1, 'CLIENT_DEFAULT_TRUCKS is gone from App.jsx — this pin must follow it to wherever it went');
  const end = source.indexOf('\n];', at);
  assert.notEqual(end, -1, 'CLIENT_DEFAULT_TRUCKS has no closing "];" on its own line');
  const literal = source.slice(at + anchor.length - 1, end + 2);
  return new Function(`"use strict"; return (${literal});`)();
}

const APP_SOURCE = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const byId = (list) => Object.fromEntries(list.map((t) => [t.id, t]));

/** The four copies, as { box, tractor } pounds each. Read fresh from whatever is passed in. */
function fourCopies({ source = APP_SOURCE, profiles = DEFAULT_TRUCK_PROFILES, engine = engineConfigDefaults({}), shadow = PROFILE_MAX_LBS } = {}) {
  const client = byId(clientDefaultTrucks(source));
  const server = byId(profiles);
  return {
    'App.jsx CLIENT_DEFAULT_TRUCKS (seeds the live truck cards)': { box: client.box_26?.maxWeightLbs, tractor: client.tractor_53?.maxWeightLbs },
    'truck-profiles.mts DEFAULT_TRUCK_PROFILES': { box: server.box_26?.maxWeightLbs, tractor: server.tractor_53?.maxWeightLbs },
    'routing-engine-config.mts weight_cap_*_lb default': { box: engine.weight_cap_box_lb, tractor: engine.weight_cap_tractor_lb },
    'claude-shadow backtest-core.mts PROFILE_MAX_LBS': { box: shadow.box_truck, tractor: shadow.tractor },
  };
}

/** PURE: the copies that disagree with the first, named — the message a drift should fail with. */
function drift(copies) {
  const [[firstName, first], ...rest] = Object.entries(copies);
  return rest.filter(([, v]) => v.box !== first.box || v.tractor !== first.tractor)
    .map(([name, v]) => `${name} says box ${v.box} / tractor ${v.tractor}, but ${firstName} says box ${first.box} / tractor ${first.tractor}`);
}

test('the four default weight limits agree — a tractor seeded at 44,000 while the engine splits at 30,000 fails here', () => {
  const copies = fourCopies();
  for (const [name, v] of Object.entries(copies)) {
    assert.ok(Number.isFinite(v.box) && v.box > 0, `${name}: box limit is not a positive number (${v.box})`);
    assert.ok(Number.isFinite(v.tractor) && v.tractor > 0, `${name}: tractor limit is not a positive number (${v.tractor})`);
  }
  assert.deepEqual(drift(copies), []);
});

test('the engine default is read with NO env — a Netlify variable cannot hide a drift in the code', () => {
  // engineConfigDefaults() with no argument reads process.env. A test run on a machine with
  // ROUTING_ENGINE_WEIGHT_CAP_TRACTOR_LB set would compare the environment, not the code.
  // 12345 is no default anywhere, so each line below pins which NAME is read, never Chad's number.
  const codeDefault = engineConfigDefaults({}).weight_cap_tractor_lb;
  assert.notEqual(codeDefault, 12345);
  assert.equal(engineConfigDefaults({ ROUTING_ENGINE_WEIGHT_CAP_TRACTOR_LB: '12345' }).weight_cap_tractor_lb, 12345,
    'ROUTING_ENGINE_WEIGHT_CAP_TRACTOR_LB is the env name that really moves the engine cap');
  assert.equal(engineConfigDefaults({ WEIGHT_CAP_TRACTOR_LB: '12345' }).weight_cap_tractor_lb, codeDefault,
    'the name given on Sep 26 (WEIGHT_CAP_TRACTOR_LB) is not read by anything');
  assert.deepEqual(drift(fourCopies({ engine: engineConfigDefaults({}) })), []);
});

test('the client seed mirrors the server profile in every field it carries', () => {
  // App.jsx calls CLIENT_DEFAULT_TRUCKS a "client-side mirror of the server seed profiles". The
  // seed writes whole documents, so a mirror that differs in skids or deck length seeds a card
  // that differs too. The server-only fields (palletFootprintIn, driverKey, notes) are not seeded.
  const client = byId(clientDefaultTrucks(APP_SOURCE));
  for (const p of DEFAULT_TRUCK_PROFILES) {
    const c = client[p.id];
    assert.ok(c, `the client seed has no ${p.id}`);
    for (const k of Object.keys(c)) assert.deepEqual(c[k], p[k], `${p.id}.${k}: client ${JSON.stringify(c[k])} vs server ${JSON.stringify(p[k])}`);
  }
  assert.deepEqual(Object.keys(client).sort(), DEFAULT_TRUCK_PROFILES.map((p) => p.id).sort());
});

test('a drift in any ONE copy is caught and named', () => {
  // The rule above, run against each copy moved on its own — so it is proven to see every one of
  // them, not just the pair the old pin compared.
  // Each copy is moved OFF whatever the copies agree on today (not onto a fixed number), so this
  // holds whatever limit Chad sets — including 44,000 again, if #1022 is ever reverted.
  const [now] = Object.values(fourCopies());
  const tractorAt = (lb) => APP_SOURCE.replace(
    /(id: 'tractor_53'[^\n]*?maxWeightLbs: )\d+/, `$1${lb}`);
  assert.notEqual(tractorAt(now.tractor + 14000), APP_SOURCE, 'the client seed edit landed');
  const cases = {
    client: fourCopies({ source: tractorAt(now.tractor + 14000) }),
    server: fourCopies({ profiles: DEFAULT_TRUCK_PROFILES.map((p) => (p.id === 'box_26' ? { ...p, maxWeightLbs: now.box + 2000 } : p)) }),
    engine: fourCopies({ engine: { ...engineConfigDefaults({}), weight_cap_tractor_lb: now.tractor + 14000 } }),
    shadow: fourCopies({ shadow: { ...PROFILE_MAX_LBS, box_truck: now.box - 1000 } }),
  };
  for (const [which, copies] of Object.entries(cases)) {
    assert.ok(drift(copies).length > 0, `a drift in the ${which} copy went unseen`);
  }
});
