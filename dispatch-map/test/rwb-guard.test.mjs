// test/rwb-guard.test.mjs — the Route Workbench boundary is a TEST, not a paragraph.
//
// Chad, 2026-09-16: "you made changes to the map and rwb when you were only supposed to be
// working in this panel … I want you to name this panel so going forward when i ask you to
// work on it you work on it and nothing else."
//
// CLAUDE.md said the workbench was frozen the evening before and it happened again anyway.
// These pin the guard that makes it mechanical — including the two ways a guard like this
// fails: crying on work it should not care about (so it gets switched off), and going quiet
// on the work it exists for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  changedLinesOf, surfaceHits, approvedIn, RWB_SURFACE, SURFACE_OF, APPROVAL_TOKEN,
} from '../scripts/check-rwb-untouched.mjs';

const diff = (...lines) => lines.join('\n');
const names = (d) => [...new Set(surfaceHits(changedLinesOf(d)).map((h) => h.name))];

test('EVERY NAME IT GUARDS IS REAL — a guard naming a dead symbol reads as protection', async () => {
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  for (const [name] of SURFACE_OF) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(app), `${name} is guarded but is not in App.jsx any more`);
  }
  // And the surface covers every sentence CLAUDE.md freezes.
  assert.deepEqual(Object.keys(RWB_SURFACE).length, 6);
});

test('a staged-card change is caught, and the reason names the rule it breaks', () => {
  const hits = surfaceHits(changedLinesOf(diff(
    '@@ -100,0 +100,1 @@',
    '+    const seeded = seedStagedCard(ids, held, b.key);',
  )));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'seedStagedCard');
  assert.equal(hits[0].why, 'staging a stop onto a card, and releasing it');
  assert.equal(hits[0].n, 100);
});

test('a REMOVED workbench line counts — deleting the rule is changing it', () => {
  assert.deepEqual(names(diff('@@ -50,1 +50,0 @@', '-      {liveWrite && <NewRouteButton onNewRoute={openNewRoute} />}')), ['NewRouteButton']);
});

test('CONTEXT LINES DO NOT COUNT — sitting near the workbench is not touching it', () => {
  assert.deepEqual(names(diff(
    '@@ -10,3 +10,4 @@',
    '   const effectiveRouteInfo = routePaint === "cards" ? a : b;',
    '+  const tally = selectionTally(stops);',
    '   const drawnStops = positioned;',
  )), []);
});

// ── THE THREE SHAPES THAT NAME THE WORKBENCH WITHOUT MOVING IT ──
// Each was found by running the matcher over real history before this shipped.
test('the shared import line is not a workbench change — it caught v1.34.0 and should not have', () => {
  // The Box|Tractor toggle (v1.34.0, #942) extended App.jsx's one routing-select import to add
  // resolveLoadVehicle. routePaintSource rides that same statement. Behaviour: unchanged.
  assert.deepEqual(names(diff(
    '@@ -49,1 +49,1 @@',
    "-import { selectionTally, cardSendState, routePaintSource } from './lib/routing-select.js';",
    "+import { selectionTally, cardSendState, routePaintSource, resolveLoadVehicle } from './lib/routing-select.js';",
  )), []);
});

test('a changelog row is a release note, not a behaviour change', () => {
  assert.deepEqual(names(diff('@@ -200,0 +200,1 @@', "+  ['1.33.0', 'THE MAP LETS GO: routePaintSource decides what effectiveRouteInfo paints.'],")), []);
});

test('a comment is a rule being explained, not a rule being changed', () => {
  assert.deepEqual(names(diff(
    '@@ -30,0 +30,2 @@',
    '+  // markSaved is the one writer of savedAt — see syncBoardAfterSave.',
    '+   * stagePlanOntoLoads appends each built route to its card.',
  )), []);
});

test('…but the CODE line beside those comments is still caught', () => {
  assert.deepEqual(names(diff(
    '@@ -30,0 +30,2 @@',
    '+  // markSaved is the one writer of savedAt.',
    '+  const markSaved = (keys) => setSavedAtByKey(keys);',
  )), ['markSaved']);
});

// ── THE APPROVAL TOKEN ──
test('THE TOKEN IS HOW CHAD NAMES THE CHANGE — and it has to quote him, not just appear', () => {
  assert.ok(approvedIn(`fix\n\n${APPROVAL_TOKEN} my create route button is gone`));
  assert.equal(approvedIn('a tidy commit with no token'), null);
  // A bare token with nothing after it is a box ticked, not a person quoted.
  assert.equal(approvedIn(`${APPROVAL_TOKEN}`), null);
  assert.equal(approvedIn(`${APPROVAL_TOKEN} ok`), null, 'two letters is not an instruction');
});

test('the token is found anywhere in the branch’s messages, on its own line or after a prefix', () => {
  assert.match(approvedIn(`subject\n\nbody\n${APPROVAL_TOKEN} move new route beside loads`), /move new route/);
  assert.match(approvedIn(`Approved — ${APPROVAL_TOKEN} put the lines back`), /put the lines back/);
});

// ── WHAT IT WOULD HAVE DONE TO THE PRs THAT CAUSED THIS ──
test('the shapes of the changes that actually moved the workbench are all caught', () => {
  const real = [
    ['v1.33.0 map paint', '+  const effectiveRouteInfo = routePaint === "cards" ? wbRouteInfo : routeInfo;', 'effectiveRouteInfo'],
    ['v1.36.0 send control', '+            const sc = sendControlState({ dirty, liveMode });', 'sendControlState'],
    ['v1.36.3 box-select', '+      if (wbStagedRef.current.get(k)) continue;', 'wbStagedRef'],
    ['v1.19.0 auto-stage', '+    stagePlanOntoLoads(bound, next);', 'stagePlanOntoLoads'],
    ['card close guard', '+  const guardedClose = (key) => { if (isDirty(key)) return setConfirm(key); closeWbRoute(key); };', 'guardedClose'],
  ];
  for (const [label, line, expect] of real) {
    assert.ok(names(diff('@@ -1,0 +1,1 @@', line)).includes(expect), `${label} slipped past the guard`);
  }
});

test('BUILD PANEL work is invisible to it — the whole point', () => {
  const panel = diff(
    '@@ -1,0 +1,6 @@',
    '+  const preBuild = useMemo(() => buildPreview({ stops: selectedStops, notes }), [selectedStops, notes]);',
    '+  const tally = selectionTally(selectedStops);',
    '+  <button onClick={runBuild} disabled={!canBuild}>Build</button>',
    '+  const veh = loadVehicleFor(r);',
    '+  setPlanTargetKeys((prev) => new Set(prev));',
    '+  <div>2 · Plan onto</div>',
  );
  assert.deepEqual(names(panel), []);
});
