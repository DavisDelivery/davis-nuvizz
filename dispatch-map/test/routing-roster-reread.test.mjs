// test/routing-roster-reread.test.mjs — the Routing screen re-reads the STORED roster when a newer
// scan lands (v1.87.5).
//
// Chad, 2026-09-28: "tony will not pull up in the compare panel even though its a fresh scan. It was
// built in nuvizz not our system but should still pull up in our system unless when i hit refresh
// it doesn't load the roster scan?" Read from the code: the screen read the day's roster once per
// DATE. TONY 1 (DAVIS000205073) was built in the portal and captured by the 9:36 PM scan, after
// the screen had opened 9/29, so the card had no load to open and refused — in the hidden Setup
// panel, where nobody could see it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rosterRereadApplies, routingRosterRereadEnabled } from '../src/lib/roster-freshness.js';

// The stored 9/29 roster as nuvizz-loads-roster?date=2026-09-29&cacheOnly=1 returned it at 9:36 PM
// (zero NuVizz calls), trimmed to the two loads that mattered that night.
const AT_936 = '2026-09-29T01:36:08.976Z';
const STORED_936 = { ok: true, date: '2026-09-29', source: 'cache', at: AT_936, count: 2, loads: [
  { name: 'TONY 1', loadNbr: 'DAVIS000205073', loadId: '6abb142deea3a7b757133398', status: 'Draft', trips: 20 },
  { name: 'MARCUS', loadNbr: 'DAVIS000204749', loadId: '6ab3f11d96c7f0f093e06034', status: 'Draft', trips: 19 },
] };

test('TONY 1: a newer stored capture replaces the one the screen opened with', () => {
  assert.equal(rosterRereadApplies(STORED_936, '2026-09-29T00:58:06.312Z'), true);
  assert.equal(rosterRereadApplies(STORED_936, null), true, 'the screen had no capture at all');
});

test('the same capture again is a no-op — a quiet scan does not repaint the Loads list', () => {
  assert.equal(rosterRereadApplies(STORED_936, AT_936), false);
});

test('a failed, absent or empty read KEEPS the roster on screen — "could not read it" is not "no loads"', () => {
  const keep = {
    'ok:false': { ...STORED_936, ok: false },
    'no stored copy (source none)': { ok: true, date: '2026-09-29', source: 'none', at: null, count: 0, loads: [] },
    'a live answer (never asked for here)': { ...STORED_936, source: 'live' },
    'a stored copy with no loads': { ...STORED_936, loads: [], count: 0 },
    'no capture stamp': { ...STORED_936, at: null },
    'loads not a list': { ...STORED_936, loads: 'x' },
  };
  for (const [why, j] of Object.entries(keep)) assert.equal(rosterRereadApplies(j, '2026-09-29T00:58:06.312Z'), false, why);
  for (const bad of [null, undefined, 'x', 0, {}]) assert.equal(rosterRereadApplies(bad, null), false, String(bad));
});

test('VITE_ROUTING_ROSTER_REREAD: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(routingRosterRereadEnabled({}), true);
  assert.equal(routingRosterRereadEnabled(undefined), true);
  for (const off of ['off', '0', 'false', 'no', ' Off ']) assert.equal(routingRosterRereadEnabled({ VITE_ROUTING_ROSTER_REREAD: off }), false, off);
  assert.equal(routingRosterRereadEnabled({ VITE_ROUTING_ROSTER_REREAD: 'of' }), true);
});

// ── the wiring, read off the source: the two promises a behaviour test inside RoutingScreen
// cannot reach cheaply, and the two whose breaking would cost money or hide the answer ──────────
const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('the re-read asks for the STORED copy only — a poll can never spend a NuVizz call', () => {
  const start = APP.indexOf('RE-READ THE STORED ROSTER WHEN A NEWER SCAN LANDS');
  const end = APP.indexOf('}, [selectedDate, lastScannedAt, applyDayRoster]);', start);
  assert.ok(start > 0 && end > start, 'the re-read effect is where it says it is');
  const block = APP.slice(start, end);
  assert.match(block, /nuvizz-loads-roster\?date=' \+ encodeURIComponent\(selectedDate\) \+ '&cacheOnly=1'/);
  assert.match(block, /rosterRereadApplies\(j, dayRosterAtRef\.current\)/, 'only a newer stored capture is applied');
  assert.match(block, /applyDayRoster\(j, \{ keepShells: true \}\)/, 'the open read\'s shells survive a re-read');
  assert.doesNotMatch(block, /live=1/);
});

test('a Compare card that cannot open says why ON THE MAP, not only in the hidden Setup panel', () => {
  const start = APP.indexOf('const openRouteInWorkbench = useCallback(');
  const block = APP.slice(start, APP.indexOf('const closeWbRoute', start));
  assert.match(block, /if \(r\.refusal\) \{ setLastAction\(r\.refusal\); if \(ROUTING_ROSTER_REREAD_ON\) showMapToast\(r\.refusal\); return prev; \}/);
});
