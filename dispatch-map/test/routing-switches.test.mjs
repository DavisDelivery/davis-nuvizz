// ROUTING SWITCHES, SETTABLE FROM DIAGNOSTICS (Chad, 2026-10-01: "I would say we put in the
// Diagnostics tab … I would like to have the date that the switch was put in place so I'll know which
// ones to toggle on and off if there's a change made that I don't like.").
//
// The registry, the resolution order (set on the page → Netlify → default), the browser's live copy,
// and the server's readers. The endpoint is pinned in routing-switches-endpoint.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ROUTING_SWITCHES, ROUTING_SWITCH_NAMES, ROUTING_SWITCHES_PATH, routingSwitchDef, resolveRoutingSwitch,
  storedSetting, setStoredRoutingSwitches, routingSwitchOn, subscribeRoutingSwitches, routingSwitchesVersion,
} from '../src/lib/routing-switches.js';
import { sweepModeFor, SWEEP_MODE } from '../src/lib/routing-select.js';
import { setRoutingSwitchCache, storedRoutingSwitch } from '../netlify/functions/lib/routing-switch-cache.mts';
import { timeRestrictionsEnabled } from '../netlify/functions/lib/routing-time-windows.mts';
import { repairOriginFirstEnabled } from '../netlify/functions/lib/routing-repair.mts';
import { unroutableEstimateEnabled, roadBoxUnroutableEstimateEnabled } from '../netlify/functions/google-route-matrix.mts';

const set = (on) => ({ on, at: '2026-10-01T14:00:00.000Z', by: 'dispatcher-a' });

test('every switch says what it does, what off puts back, and the moment it went in', () => {
  assert.equal(new Set(ROUTING_SWITCH_NAMES).size, ROUTING_SWITCHES.length, 'no switch listed twice');
  assert.equal(ROUTING_SWITCHES_PATH, 'routing_switches/davis');
  for (const s of ROUTING_SWITCHES) {
    for (const k of ['name', 'label', 'where', 'on', 'off', 'since', 'version']) assert.ok(String(s[k] || '').length > 3, `${s.name}: ${k}`);
    assert.ok(['browser', 'server'].includes(s.side), s.name);
    assert.ok(['house', 'opt-in'].includes(s.shape), s.name);
    assert.ok(Number.isInteger(s.pr) && s.pr > 0, `${s.name}: pr`);
    assert.match(s.since, /^2026-\d\d-\d\dT\d\d:\d\d:00-04:00$/, `${s.name}: Eastern time, from the merge`);
    assert.ok(!Number.isNaN(Date.parse(s.since)), s.name);
    assert.equal(s.side === 'browser', s.name.startsWith('VITE_'), `${s.name}: a VITE_ name is a browser switch`);
  }
});

test('the dates are the merges on main, in Eastern time', () => {
  // Pinned so a later edit cannot quietly move the date Chad reads to find a change.
  const at = Object.fromEntries(ROUTING_SWITCHES.map((s) => [s.name, `${s.since.slice(0, 16)} v${s.version} #${s.pr}`]));
  assert.deepEqual(at, {
    VITE_TIME_WINDOWS_MILES_CAP: '2026-09-30T15:17 v1.99.5 #1094',
    VITE_CLOSEST_FIRST_WITHOUT_TOWNS: '2026-09-30T14:31 v1.99.4 #1093',
    ROAD_BOX_ESTIMATE_UNROUTABLE: '2026-09-30T14:06 v1.99.3 #1092',
    VITE_PREFLIGHT_COUNTS_EVERY_LATE_STOP: '2026-09-30T13:41 v1.99.2 #1091',
    VITE_ROAD_REPLY_DROPS_MOVED_STOPS: '2026-09-30T13:09 v1.99.1 #1090',
    VITE_RETURN_TO_WAREHOUSE: '2026-09-30T03:49 v1.98.0 #1081',
    VITE_COMPARE_TIME_WINDOWS: '2026-09-28T23:56 v1.89.0 #1066',
    ROUTING_REPAIR_ORIGIN_FIRST: '2026-09-27T20:04 v1.81.3 #1045',
    ROUTE_MATRIX_ESTIMATE_UNROUTABLE: '2026-09-27T19:37 v1.81.2 #1043',
    ROUTING_TIME_RESTRICTIONS: '2026-09-12T17:48 v1.21.0 #912',
  });
});

test('resolution order: set on the page, then Netlify, then the default — and nothing set is exactly as before', () => {
  const house = routingSwitchDef('VITE_TIME_WINDOWS_MILES_CAP');
  assert.deepEqual(resolveRoutingSwitch(house, {}), { on: true, source: 'default' });
  assert.deepEqual(resolveRoutingSwitch(house, { envValue: 'off' }), { on: false, source: 'netlify' });
  assert.deepEqual(resolveRoutingSwitch(house, { envValue: 'offf' }), { on: true, source: 'netlify' }, 'a typo never turns a switch off');
  assert.deepEqual(resolveRoutingSwitch(house, { envValue: '' }), { on: true, source: 'default' });
  assert.deepEqual(resolveRoutingSwitch(house, { envValue: 'off', stored: set(true) }), { on: true, source: 'page' }, 'the page wins over Netlify');
  assert.deepEqual(resolveRoutingSwitch(house, { stored: set(false) }), { on: false, source: 'page' });
  assert.deepEqual(resolveRoutingSwitch(house, { stored: { on: 'no' } }), { on: true, source: 'default' }, 'a malformed stored value is ignored');

  const optIn = routingSwitchDef('VITE_RETURN_TO_WAREHOUSE');
  assert.deepEqual(resolveRoutingSwitch(optIn, {}), { on: false, source: 'default' });
  assert.deepEqual(resolveRoutingSwitch(optIn, { envValue: 'on' }), { on: true, source: 'netlify' });
  assert.deepEqual(resolveRoutingSwitch(optIn, { envValue: 'onn' }), { on: false, source: 'netlify' });
  assert.deepEqual(resolveRoutingSwitch(optIn, { onUat: true }), { on: true, source: 'uat' });
  assert.deepEqual(resolveRoutingSwitch(optIn, { onUat: true, stored: set(false) }), { on: false, source: 'page' });
  assert.deepEqual(resolveRoutingSwitch(optIn, { stored: set(true) }), { on: true, source: 'page' });
});

test("the browser's copy: empty until loaded, a flip notifies, and the page wins over the build's Netlify value", () => {
  const env = { VITE_CLOSEST_FIRST_WITHOUT_TOWNS: 'off' };
  setStoredRoutingSwitches({});
  assert.equal(routingSwitchOn('VITE_CLOSEST_FIRST_WITHOUT_TOWNS', env), false, 'nothing stored: the build value');
  let heard = 0;
  const off = subscribeRoutingSwitches(() => { heard += 1; });
  const v0 = routingSwitchesVersion();
  setStoredRoutingSwitches({ VITE_CLOSEST_FIRST_WITHOUT_TOWNS: set(true) });
  assert.equal(heard, 1);
  assert.equal(routingSwitchesVersion(), v0 + 1);
  assert.equal(routingSwitchOn('VITE_CLOSEST_FIRST_WITHOUT_TOWNS', env), true);
  assert.equal(sweepModeFor('closest', env, routingSwitchOn('VITE_CLOSEST_FIRST_WITHOUT_TOWNS', env)), 'pure');
  assert.equal(sweepModeFor('closest', env), SWEEP_MODE, 'sweepModeFor with no position passed reads env as before');
  off();
  setStoredRoutingSwitches({});
  assert.equal(heard, 1, 'unsubscribed');
  assert.equal(routingSwitchOn('VITE_RETURN_TO_WAREHOUSE', {}, { onUat: true }), true);
  assert.equal(storedSetting({ X: set(false) }, 'X').on, false);
  assert.equal(storedSetting(null, 'X'), undefined);
});

test("the server's readers: stored wins, nothing stored reads the environment exactly as before", () => {
  try {
    setRoutingSwitchCache({});
    assert.equal(storedRoutingSwitch('ROUTING_TIME_RESTRICTIONS'), undefined);
    assert.equal(timeRestrictionsEnabled({}), true);
    assert.equal(timeRestrictionsEnabled({ ROUTING_TIME_RESTRICTIONS: 'off' }), false);
    assert.equal(repairOriginFirstEnabled({ ROUTING_REPAIR_ORIGIN_FIRST: 'off' }), false);
    assert.equal(unroutableEstimateEnabled({}), true);
    assert.equal(roadBoxUnroutableEstimateEnabled({ ROAD_BOX_ESTIMATE_UNROUTABLE: 'no' }), false);

    setRoutingSwitchCache({
      ROUTING_TIME_RESTRICTIONS: set(false), ROUTING_REPAIR_ORIGIN_FIRST: set(true),
      ROUTE_MATRIX_ESTIMATE_UNROUTABLE: set(false), ROAD_BOX_ESTIMATE_UNROUTABLE: set(true),
    });
    assert.equal(timeRestrictionsEnabled({}), false, 'set off on the page: off, whatever Netlify says');
    assert.equal(repairOriginFirstEnabled({ ROUTING_REPAIR_ORIGIN_FIRST: 'off' }), true, 'set on on the page beats Netlify off');
    assert.equal(unroutableEstimateEnabled({}), false);
    assert.equal(roadBoxUnroutableEstimateEnabled({ ROAD_BOX_ESTIMATE_UNROUTABLE: 'off' }), true);
  } finally {
    setRoutingSwitchCache({});
  }
});

test('every server path that reads a server switch loads the stored switches first', () => {
  // A path that skipped the load would honour Netlify while the page said otherwise — a switch
  // whose position cannot be trusted. These are the four readers' only callers (grep-checked).
  const has = (f, ...needles) => { const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'); for (const n of needles) assert.ok(src.includes(n), `${f}: ${n}`); };
  has('netlify/functions/google-route-matrix.mts', 'await hydrateRoutingSwitches();   // ROUTE_MATRIX_ESTIMATE_UNROUTABLE', 'await hydrateRoutingSwitches();   // ROAD_BOX_ESTIMATE_UNROUTABLE');
  has('netlify/functions/routing-build-background.mts', 'await hydrateRoutingSwitches();');
  has('netlify/functions/lib/routing-pipeline.mts', 'await hydrateRoutingSwitches();');
  has('netlify/functions/lib/routing-cleanup-core.mts', 'await hydrateRoutingSwitches();');
  // And the module the browser bundle pulls in never imports the Firestore client.
  const tw = readFileSync(new URL('../netlify/functions/lib/routing-time-windows.mts', import.meta.url), 'utf8');
  assert.ok(!/routing-switches-store|firestore\.mts/.test(tw), 'routing-time-windows.mts stays browser-safe');
});

test('the app reads each browser switch where it is used, not frozen at load', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  for (const s of ROUTING_SWITCHES.filter((x) => x.side === 'browser')) {
    assert.ok(app.includes(`rsOn('${s.name}')`), `${s.name} is read through the switches`);
  }
  for (const frozen of ['COMPARE_TIME_WINDOWS_ON', 'TIME_WINDOWS_MILES_CAP_ON', 'RETURN_TO_WAREHOUSE_ON', 'ROAD_REPLY_DROPS_MOVED_STOPS_ON', 'PREFLIGHT_COUNTS_EVERY_LATE_STOP_ON']) {
    assert.ok(!app.includes(frozen), `${frozen} is gone`);
  }
  assert.ok(app.includes("{ id: 'routing', label: 'Routing switches'"), 'the Diagnostics tab exists');
  assert.ok(app.includes('routing: <RoutingSwitchesPanel />'), 'and renders its panel');
  assert.ok(app.includes('useRoutingSwitchesLive();'), 'the live copy is loaded in Shell');
});
