// test/uat-test-board.test.mjs — the UAT board's daily pool, and the box in front of a write.
//
// Chad, on the UAT site: "what i want to happen in UAT is it reads the firestore for
// unplanned orders however it doesnt plan them i want them daily left unplanned and
// isolated to this enviroment for testing" — and, asked whether UAT should be able to
// write NuVizz so the cancel-route and New-route fixes can be exercised there: "Allow
// writes but make it where you have to confirm via box that this is what is about to
// occur."
//
// WHY THE BOARD WAS EMPTY, which is the thing being fixed: isMirrorDeploy() keys on
// FIRESTORE_DATABASE and scansEnabled() is false for any mirror — the cutoff Chad asked
// for on Sep 3 after the mirror spent 109 NuVizz calls a day nobody had authorised. So
// nothing ever writes the uat-mirror database's stop index and the map says "No stops
// match the current filters." The fix is not to let UAT scan again; it is to let it READ
// the day production already paid for.
//
// Pins:
//   • the pool refuses on production and when switched off — it never silently no-ops;
//   • it serves ONLY orders unplanned in production, and STRIPS the plan off every row it
//     serves, so nothing arrives wearing a production route, driver or sequence;
//   • an unknown row is NOT assumed unplanned (the wrong direction to guess in);
//   • an empty board says WHY, in words, instead of being blank;
//   • UAT_POOL_MODE=all widens the pool and still serves every row unplanned;
//   • the module has no writer at all, and never addresses a database but (default);
//   • the confirmation box fires for a real write on UAT and for nothing else — not a dry
//     run, not a read op, never on production;
//   • what the box SAYS is built from the payload that is about to be sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  isUnplannedRow, asUnplannedRow, prodPoolEnabled, poolMode, PLAN_FIELDS,
} from '../netlify/functions/lib/prod-pool.mts';
import { needsUatConfirm, describeWriteOp, MUTATING_WRITE_OPS, UAT_CONFIRM_PREAMBLE } from '../src/lib/uat-write-confirm.js';

const UAT = { FIRESTORE_DATABASE: 'uat-mirror' };
const PROD = {};

// ── the pool ─────────────────────────────────────────────────────────────────

test('the pool runs on a mirror only, and can be switched off there', () => {
  assert.equal(prodPoolEnabled(UAT), true);
  assert.equal(prodPoolEnabled(PROD), false, 'production must never take this path');
  assert.equal(prodPoolEnabled({ FIRESTORE_DATABASE: '(default)' }), false);
  for (const off of ['off', 'false', '0', 'no']) {
    assert.equal(prodPoolEnabled({ ...UAT, UAT_PROD_POOL: off }), false, off);
  }
  assert.equal(prodPoolEnabled({ ...UAT, UAT_PROD_POOL: 'on' }), true);
});

test('poolMode defaults to unplanned; only the literal "all" widens it', () => {
  assert.equal(poolMode(UAT), 'unplanned');
  assert.equal(poolMode({ ...UAT, UAT_POOL_MODE: 'all' }), 'all');
  assert.equal(poolMode({ ...UAT, UAT_POOL_MODE: 'ALL' }), 'all');
  for (const junk of ['everything', 'true', '1', '']) {
    assert.equal(poolMode({ ...UAT, UAT_POOL_MODE: junk }), 'unplanned', junk);
  }
});

test('only orders production has UNPLANNED reach the test board — and an unknown row does not', () => {
  assert.equal(isUnplannedRow({ isUnplanned: true }), true);
  assert.equal(isUnplannedRow({ isPlanned: false }), true, 'a row written before isUnplanned existed');
  assert.equal(isUnplannedRow({ isPlanned: true, isUnplanned: false }), false);
  assert.equal(isUnplannedRow({ isUnplanned: false, isPlanned: false }), false, 'an explicit no wins');
  // A row that says NEITHER is not assumed free to route. An unknown order arriving on a
  // test board as "unplanned" is the direction that invents work; leaving it out is the
  // direction that merely shows fewer orders.
  assert.equal(isUnplannedRow({ stopNbr: '007173697' }), false);
  assert.equal(isUnplannedRow(null), false);
  assert.equal(isUnplannedRow('nope'), false);
});

test('"LEFT UNPLANNED" is true of the ROW, not just of the query that found it', () => {
  // The filter decides which orders reach the board; the strip guarantees none of them
  // arrives wearing production's plan. Two different jobs — a row can be unplanned and
  // still carry a stale route name from earlier in the day.
  const row = {
    stopNbr: '007173697', businessName: 'STACI AMERICAS', isUnplanned: true, isPlanned: false,
    loadNbr: 'DAVIS000203261', loadId: 'hex', routeName: 'TRAILER 5', routeSeq: 3, loadStopSeq: 3,
    driverName: 'Seymour Watts', driverId: 11, driverUserName: 'SEYMOUR',
    plannedEtaDTTM: '2026-09-09T14:00:00', plannedDistanceToNextStop: 12,
    plannedDurationToNextStop: 20, board_write_at: 'x', board_write_planned: true,
    boardDate: '2026-09-09', normalizedStatus: 'SCHEDULED', status: '20', pallets: 4,
  };
  const out = asUnplannedRow(row);
  for (const f of PLAN_FIELDS) assert.equal(out[f], null, `${f} must be cleared`);
  assert.equal(out.isPlanned, false);
  assert.equal(out.isUnplanned, true);
  assert.equal(out.normalizedStatus, 'UNPLANNED', 'or the board paints it as routed');
  assert.equal(out.status, '10');
  assert.equal(out.uatPoolSource, 'production', 'provenance travels with the row');
  // The freight itself is untouched — this is a test board, not a fake one.
  assert.equal(out.businessName, 'STACI AMERICAS');
  assert.equal(out.pallets, 4);
  assert.equal(out.stopNbr, '007173697');
  assert.notEqual(row.routeName, null, 'and the source row is never mutated');
});

test('THE MODULE HAS NO WRITER, and never names a database but production', () => {
  // The whole isolation argument. A read-only reader that COULD be made to write is one
  // refactor away from the test board editing the live one, so this is asserted on the
  // source rather than trusted to review.
  const src = readFileSync(new URL('../netlify/functions/lib/prod-pool.mts', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  for (const verb of ['PATCH', 'POST', 'DELETE', ':commit', 'updateDocFields', 'setDoc', 'patchStopFields']) {
    assert.ok(!code.includes(verb), `prod-pool must not contain ${verb}`);
  }
  assert.ok(!/method:\s*'(?!GET)/.test(code), 'the only request method is a plain GET');
  // Exactly one database, hard-coded — not a parameter a caller can get wrong.
  assert.match(code, /const PROD_DATABASE = '\(default\)'/);
  // The URL does interpolate — but only ever the hard-coded constant. Pin that shape
  // exactly, so a future edit that threads a database in as a parameter fails here.
  const dbSlots = [...code.matchAll(/databases\/\$\{([A-Za-z_$][\w$]*)\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(dbSlots)], ['PROD_DATABASE'], 'the only database in any URL is the constant');
  // …and it is assigned exactly once, to that literal. (Written as two plain counts rather
  // than one clever lookahead: a trailing \s* backtracks past the space and makes a negative
  // lookahead match its own declaration, which is how the first version of this line passed
  // for the wrong reason.)
  const assignments = code.match(/PROD_DATABASE\s*=[^;]*/g) || [];
  assert.equal(assignments.length, 1, 'assigned exactly once');
  assert.match(assignments[0], /=\s*'\(default\)'/, 'and only ever to production');
});

// ── the box ──────────────────────────────────────────────────────────────────

test('the box fires for a real write on UAT — and for nothing else', () => {
  assert.equal(needsUatConfirm({ isUat: true, dryRun: false, op: 'commitBoard' }), true);
  // Production never asks: its own confirms already apply and the write path is unchanged.
  assert.equal(needsUatConfirm({ isUat: false, dryRun: false, op: 'commitBoard' }), false);
  // A dry run touches nothing by construction — asking would train people to click through.
  assert.equal(needsUatConfirm({ isUat: true, dryRun: true, op: 'commitBoard' }), false);
  // A read is not a decision.
  assert.equal(needsUatConfirm({ isUat: true, dryRun: false, op: 'roster' }), false);
  assert.equal(needsUatConfirm({ isUat: true, dryRun: false, op: 'getLoad' }), false);
});

test('every op that changes NuVizz raises the box — the list cannot quietly fall behind', () => {
  // The server is the authority (MUTATING_OPS); this list decides whether to ASK. If a new
  // mutating op is added there and not here, a write goes through unannounced on the test
  // board, which is the one outcome this must never have.
  const ops = readFileSync(new URL('../netlify/functions/lib/nuvizz-write-ops.mts', import.meta.url), 'utf8');
  const block = ops.slice(ops.indexOf('export const MUTATING_OPS'));
  const server = [...block.slice(0, block.indexOf(']')).matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.ok(server.length >= 15, `sanity: parsed ${server.length} server mutating ops`);
  const missing = server.filter((op) => !MUTATING_WRITE_OPS.has(op));
  assert.deepEqual(missing, [], 'these mutate NuVizz but would not raise the UAT box');
});

test('the box says what is ABOUT TO HAPPEN, off the payload that is about to be sent', () => {
  const d = describeWriteOp('commitBoard', {
    loads: [
      { routeName: 'TRAILER 5', emptyLoad: true, removeStopNbrs: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
      { routeName: 'TRAILER 6', orderedStopNbrs: ['x', 'y'], driverId: 11, dispatch: true },
    ],
  });
  assert.equal(d.title, 'Save 2 routes to NuVizz');
  assert.deepEqual(d.lines, [
    'CANCEL TRAILER 5 — 7 order(s) go back to Un-Planned',
    'TRAILER 6 — set 2 stop(s), assign a driver, DISPATCH to the driver',
  ]);
  // The one with a truck on the end of it has to be legible as such.
  assert.match(d.lines[1], /DISPATCH/);

  const c = describeWriteOp('newRoute', { routeName: 'Suw 3', orderedStopNbrs: ['1', '2', '3'] });
  assert.match(c.lines[0], /CREATE route Suw 3/);
  assert.match(c.lines[1], /3 order\(s\)/);

  // An op with nothing specific to say gets an honest generic line, never a confident
  // wrong one — never describe a write you have not actually read.
  const u = describeWriteOp('somethingNew', {});
  assert.match(u.title, /somethingNew/);
  assert.match(u.lines[0], /changes data in NuVizz/);

  assert.match(UAT_CONFIRM_PREAMBLE, /UAT test board/);
});

test('WIRING: the single write door asks, and only sends the flag when the answer was yes', () => {
  const src = readFileSync(new URL('../src/lib/nuvizzWrite.js', import.meta.url), 'utf8');
  assert.match(src, /if \(needsUatConfirm\(\{ isUat, dryRun, op \}\)\)/, 'callWrite consults the rule');
  assert.match(src, /return \{ ok: false, cancelled: true/, 'a no returns without touching the endpoint');
  assert.match(src, /\.\.\.\(uatConfirmed \? \{ uatConfirmed: true \} : \{\}\)/, 'the flag rides the request only when confirmed');
  // No box available ⇒ no write. Refusing costs a re-run; guessing costs a NuVizz write
  // from a board nobody is watching.
  assert.match(src, /\/\/ No way to ask ⇒ do not write\./);
});
