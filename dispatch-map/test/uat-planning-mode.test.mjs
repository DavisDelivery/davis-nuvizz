// test/uat-planning-mode.test.mjs — UAT PLANNING MODE: EVERY DAY'S ORDERS SHOWN UNPLANNED, NOTHING STORED CHANGES.
//
// Chad, 2026-09-28: "i want you to make everything from today's deliveries back to unplanned so i
// can test of some of the planning changes we have made this making everything unplanned has
// nothing to do with production and should change nothing in productions database" — then: "maybe
// we have a planning mode in the uat where it makes the days orders all unplanned so you have a
// live version essentially of uat and then have a planning mode where everything on any given day
// is in unplanned."
//
// Each test is named for the real thing it pins. The two that matter most: production never sees
// it, and nothing stored — on either database — is written by viewing the board in planning mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installTwoDatabases, withEnv } from './_two-db-fake.mjs';

delete process.env.FIRESTORE_DATABASE;
delete process.env.UAT_PLANNING_MODE;
delete process.env.UAT_LIVE_SYNC;
delete process.env.AUTH_REQUIRED;

import {
  planningModeAvailable, planningView, planningRosterLoads, planningRosterBody, readPlanningMode,
  readStopsForPlanning, planningModePath, PLAN_FIELDS, EXECUTION_FIELDS,
} from '../netlify/functions/lib/uat-planning-mode.mts';
import { isPlannedStop } from '../src/lib/routing-select.js';
import { uatModeView } from '../src/lib/uat-mode-bar.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const MIRROR = { FIRESTORE_DATABASE: 'uat-mirror', NUVIZZ_BASE_URL: 'https://uat.nuvizz.com/deliverit/openapi/v7' };
const DAY = '2026-09-28';
const BOARD = `nuvizz_stop_index/davis__${DAY}`;
const MODE = planningModePath('davis');

// A stop as production's scan leaves it after the driver has delivered it, and one still on a load.
const DELIVERED = {
  stopNbr: 'WHITING-7182304', stopType: 'DO', businessName: 'WHITING TURNER', addr1: '1 Peachtree', city: 'Atlanta', zip: '30303',
  lat: 33.75, lng: -84.39, pallets: 11, weight: 6733, scheduledFrom: '08:00', scheduledTo: '14:00',
  loadNbr: 'MARCUS', nuvizzLoadNbr: 'DAVIS000204645', routeName: 'MARCUS', routeSeq: 4, loadStopSeq: 4,
  driverName: 'Marcus T', driverUserName: 'marcus', plannedEtaDTTM: '2026-09-28T10:10:00',
  status: '90', normalizedStatus: 'DELIVERED', isPlanned: true, isUnplanned: false,
  arrivalDTTM: '2026-09-28T10:02:00', deliveredDTTM: '2026-09-28T10:20:00', podDocs: [{ documentName: 'pod.pdf' }],
  executed: { deliveredDTTM: '2026-09-28T10:20:00' },
  raw: { load: { loadId: 'L-204645', routeName: 'MARCUS' }, stopExecutionInfo: { to: { deliveredDTTM: '2026-09-28T10:20:00' }, cancellation: {} }, stop: { sealNbr: 'S1' } },
};
const ON_A_LOAD = { stopNbr: 'POREX-1', businessName: 'POREX', lat: 33.8, lng: -84.2, loadNbr: 'MARCUS', routeName: 'MARCUS', isPlanned: true, isUnplanned: false, status: '30', normalizedStatus: 'SCHEDULED' };
const CANCELLED = { stopNbr: 'GRENZEBACH131732373', loadNbr: 'X', isPlanned: true, raw: { stopExecutionInfo: { cancellation: { reasonCode: 'CANCELLED', cancelDTTM: '2026-09-20T21:00:55' } } } };

// ── 1. THE SWITCH ────────────────────────────────────────────────────────────────────────────

test('planningModeAvailable: NEVER on production; on for a mirror; UAT_PLANNING_MODE off-words turn it off; a typo leaves it ON', () => {
  assert.equal(planningModeAvailable({}), false);
  assert.equal(planningModeAvailable({ FIRESTORE_DATABASE: '(default)', UAT_PLANNING_MODE: 'on' }), false, 'no switch turns it on for production');
  assert.equal(planningModeAvailable({ FIRESTORE_DATABASE: 'uat-mirror' }), true);
  for (const off of ['off', 'OFF', '0', 'false', 'no', ' off ']) assert.equal(planningModeAvailable({ FIRESTORE_DATABASE: 'uat-mirror', UAT_PLANNING_MODE: off }), false, off);
  for (const junk of ['offf', 'disabled', '1', 'true', '']) assert.equal(planningModeAvailable({ FIRESTORE_DATABASE: 'uat-mirror', UAT_PLANNING_MODE: junk }), true, junk);
});

test('readPlanningMode: production answers OFF WITHOUT A READ; a mirror reads its own switch; a failed read is OFF and says why', async () => {
  let reads = 0;
  const trap = async () => { reads++; throw new Error('must not be reached'); };
  assert.deepEqual(await readPlanningMode({ env: {}, getDoc: trap }), { on: false, available: false, set_at: null, set_by: null, error: null });
  assert.equal((await readPlanningMode({ env: { FIRESTORE_DATABASE: 'uat-mirror', UAT_PLANNING_MODE: 'off' }, getDoc: trap })).available, false);
  assert.equal(reads, 0, 'production and a switched-off mirror never pay for it');

  const at = (doc) => ({ env: { FIRESTORE_DATABASE: 'uat-mirror' }, getDoc: async (p) => { assert.equal(p, 'uat_mode/davis'); return doc; } });
  assert.equal((await readPlanningMode(at({ planning: true, set_at: 'x', set_by: 'Chad' }))).on, true);
  assert.equal((await readPlanningMode(at({ planning: false }))).on, false);
  assert.equal((await readPlanningMode(at(null))).on, false, 'never set = Live');
  assert.equal((await readPlanningMode(at({ planning: 'yes' }))).on, false, 'only a real true turns it on');
  const failed = await readPlanningMode({ env: { FIRESTORE_DATABASE: 'uat-mirror' }, getDoc: trap });
  assert.equal(failed.on, false);
  assert.match(failed.error, /must not be reached/);
});

// ── 2. THE VIEW ──────────────────────────────────────────────────────────────────────────────

test('A DELIVERED STOP ON MARCUS READS UNPLANNED: off the load, no driver, no plan, nothing executed — and the planner still has everything it needs', () => {
  const v = planningView(DELIVERED);
  for (const k of PLAN_FIELDS) if (k in DELIVERED) assert.equal(v[k], null, k);
  for (const k of EXECUTION_FIELDS) if (k in DELIVERED) assert.equal(v[k], null, k);
  assert.deepEqual(v.podDocs, []);
  assert.equal(v.isPlanned, false);
  assert.equal(v.isUnplanned, true);
  assert.equal(v.status, '10');
  assert.equal(v.normalizedStatus, 'UNPLANNED');
  assert.equal(v.raw.load, null, 'the load identity inside the vendor record goes too');
  assert.deepEqual(v.raw.stopExecutionInfo, { cancellation: {} }, 'execution goes; the cancellation record the board looks for stays');
  assert.deepEqual(v.raw.stop, { sealNbr: 'S1' });
  assert.equal(isPlannedStop(v), false, 'the Build Panel and the map read it as unplanned (routing-select.js isPlannedStop)');
  for (const k of ['stopNbr', 'businessName', 'addr1', 'city', 'zip', 'lat', 'lng', 'pallets', 'weight', 'scheduledFrom', 'scheduledTo']) {
    assert.deepEqual(v[k], DELIVERED[k], `${k} is the order, not the plan — kept`);
  }
  assert.equal(v.planning_view, true);
  assert.equal(DELIVERED.isPlanned, true, 'the input row is never mutated');
  assert.deepEqual(DELIVERED.raw.load, { loadId: 'L-204645', routeName: 'MARCUS' });
});

test('the view NEVER INVENTS A FIELD the lean board did not carry', () => {
  const v = planningView(ON_A_LOAD);
  for (const k of ['driverName', 'plannedEtaDTTM', 'raw', 'podDocs', 'executed', 'nuvizzLoadNbr']) assert.equal(k in v, false, k);
  assert.equal(v.loadNbr, null);
  assert.equal(isPlannedStop(v), false);
});

test('a CANCELLED order is returned untouched — it is not freight, and the board drops it by its cancellation record', () => {
  assert.equal(planningView(CANCELLED), CANCELLED);
  assert.equal(planningView(null), null);
});

test('EVERY LOAD AN EMPTY TRUCK: trips 0, driver and number kept; a diagnostic or an error body passes through untouched', () => {
  const loads = [{ loadId: 'L1', loadNbr: 'DAVIS000204645', name: 'MARCUS', driver: 'Marcus T', status: 'Dispatched', trips: 12 }];
  assert.deepEqual(planningRosterLoads(loads), [{ loadId: 'L1', loadNbr: 'DAVIS000204645', name: 'MARCUS', driver: 'Marcus T', status: 'Dispatched', trips: 0 }]);
  assert.equal(loads[0].trips, 12, 'not mutated');
  const body = { ok: true, date: DAY, source: 'cache', count: 1, loads };
  assert.deepEqual(planningRosterBody(body), { ...body, loads: planningRosterLoads(loads), planning_mode: true });
  const explain = { ok: true, rows: [{ date: DAY, count: 90 }] };
  assert.equal(planningRosterBody(explain), explain, 'the ?explain=1 diagnostic reports what is STORED');
  const err = { ok: false, reason: 'x', loads: [] };
  assert.equal(planningRosterBody(err), err);
});

// ── 3. THE SURFACES, END TO END, ON TWO DATABASES ────────────────────────────────────────────

const mirrorBoard = (extra = {}) => ({
  [BOARD]: { data: { tenant: 'davis', date: DAY, last_scanned_at: '2026-09-28T15:00:00Z', count: 2, plannedCount: 2, unplannedCount: 0 }, updateTime: 't' },
  [`${BOARD}/stops/WHITING-7182304`]: { data: DELIVERED, updateTime: 't' },
  [`${BOARD}/stops/POREX-1`]: { data: ON_A_LOAD, updateTime: 't' },
  ...extra,
});
const snapshot = (fake) => JSON.stringify(['(default)', 'uat-mirror'].map((db) => [...fake.dbs[db].entries()].sort()));

test('THE BOARD IN PLANNING MODE: every stop served unplanned, the tally follows — and NOTHING is written to either database', async () => {
  const fake = installTwoDatabases({ mirror: mirrorBoard({ [MODE]: { data: { planning: true, set_at: 'x', set_by: 'Chad' }, updateTime: 't' } }) });
  const before = snapshot(fake);
  try {
    await withEnv(MIRROR, async () => {
      const { default: board } = await import('../netlify/functions/nuvizz-pull-today-stops.mts');
      const body = await (await board(new Request(`https://x.test/.netlify/functions/nuvizz-pull-today-stops?date=${DAY}`))).json();
      assert.equal(body.ok, true);
      assert.equal(body.planningMode, true);
      assert.equal(body.count, 2);
      assert.equal(body.unplannedCount, 2, 'the tally is counted off the view');
      for (const s of body.stops) {
        assert.equal(isPlannedStop(s), false, s.stopNbr);
        assert.equal(s.normalizedStatus, 'UNPLANNED');
        assert.equal(s.routeName, null);
      }
    });
    assert.deepEqual(fake.log.writes, []);
    assert.deepEqual(fake.log.deletes, []);
    assert.equal(snapshot(fake), before, 'both databases byte-identical');
    assert.deepEqual(fake.log.vendor, [], 'no NuVizz call');
  } finally { fake.restore(); }
});

test('THE BOARD IN LIVE MODE is the stored board, exactly', async () => {
  const fake = installTwoDatabases({ mirror: mirrorBoard({ [MODE]: { data: { planning: false }, updateTime: 't' } }) });
  try {
    await withEnv(MIRROR, async () => {
      const { default: board } = await import('../netlify/functions/nuvizz-pull-today-stops.mts');
      const body = await (await board(new Request(`https://x.test/.netlify/functions/nuvizz-pull-today-stops?date=${DAY}`))).json();
      assert.equal(body.planningMode, false);
      const porex = body.stops.find((s) => s.stopNbr === 'POREX-1');
      assert.equal(porex.routeName, 'MARCUS');
      assert.equal(isPlannedStop(porex), true);
    });
  } finally { fake.restore(); }
});

test('PRODUCTION IS UNTOUCHED: with no named database the switch is never even read, whatever a stray document says', async () => {
  const fake = installTwoDatabases({ prod: { ...mirrorBoard(), [MODE]: { data: { planning: true }, updateTime: 't' } } });
  try {
    await withEnv({ FIRESTORE_DATABASE: null, NUVIZZ_BASE_URL: '' }, async () => {
      const { default: board } = await import('../netlify/functions/nuvizz-pull-today-stops.mts');
      const body = await (await board(new Request(`https://x.test/.netlify/functions/nuvizz-pull-today-stops?date=${DAY}`))).json();
      assert.equal(body.planningMode, false);
      assert.equal(isPlannedStop(body.stops.find((s) => s.stopNbr === 'POREX-1')), true);
    });
    assert.equal(fake.log.reads.some((r) => r.includes('uat_mode')), false, 'production never reads the switch');
    assert.equal(fake.log.reads.some((r) => r.startsWith('uat-mirror:')), false, 'and never touches the mirror');
  } finally { fake.restore(); }
});

test('THE LOADS IN PLANNING MODE: Monday\'s 90 loads are 90 empty trucks with their drivers — served, not stored', async () => {
  const loads = Array.from({ length: 90 }, (_, i) => ({ loadId: `L${i}`, loadNbr: `DAVIS0002046${String(i).padStart(2, '0')}`, name: `ROUTE ${i}`, driver: i % 2 ? `Driver ${i}` : null, trips: 5 }));
  const fake = installTwoDatabases({
    mirror: {
      [MODE]: { data: { planning: true }, updateTime: 't' },
      [`nuvizz_load_roster/davis__${DAY}`]: { data: { at: '2026-09-28T12:00:00Z', loadsJson: JSON.stringify(loads), emptyStreak: 0 }, updateTime: 't' },
    },
  });
  const before = snapshot(fake);
  try {
    await withEnv(MIRROR, async () => {
      const { default: roster } = await import('../netlify/functions/nuvizz-loads-roster.mts');
      const body = await (await roster(new Request(`https://x.test/.netlify/functions/nuvizz-loads-roster?date=${DAY}`))).json();
      assert.equal(body.count, 90);
      assert.equal(body.planning_mode, true);
      assert.ok(body.loads.every((l) => l.trips === 0), 'every load empty');
      assert.equal(body.loads[1].driver, 'Driver 1', 'drivers stay on their trucks');
      assert.equal(body.loads[3].loadNbr, 'DAVIS000204603', 'and the load numbers stay');
    });
    assert.equal(snapshot(fake), before, 'the stored roster is untouched');
    assert.deepEqual(fake.log.vendor, []);
  } finally { fake.restore(); }
});

test('THE SOLVERS\' READ (readStopsForPlanning): planning mode hands the draft and end-of-night solvers an all-unplanned day; Live hands them the stored one', async () => {
  const fake = installTwoDatabases({ mirror: mirrorBoard({ [MODE]: { data: { planning: true }, updateTime: 't' } }) });
  try {
    await withEnv(MIRROR, async () => {
      const on = await readStopsForPlanning('davis', DAY);
      assert.equal(on.planning.on, true);
      assert.ok(on.stops.every((s) => s.isUnplanned === true && s.isPlanned === false));
      assert.equal(on.meta.plannedCount, 0);
      assert.equal(on.meta.unplannedCount, 2);
      fake.dbs['uat-mirror'].set(MODE, { data: { planning: false }, updateTime: 't2' });
      const off = await readStopsForPlanning('davis', DAY);
      assert.equal(off.planning.on, false);
      assert.equal(off.stops.filter((s) => s.isPlanned === true).length, 2);
    });
    assert.deepEqual(fake.log.writes, []);
  } finally { fake.restore(); }
});

// ── 4. THE SWITCH'S ENDPOINT ─────────────────────────────────────────────────────────────────

test('THE SWITCH: 403 on production before anything runs; on UAT a flip is written to the MIRROR and answered as READ BACK', async () => {
  const fake = installTwoDatabases({});
  try {
    const { default: sw } = await import('../netlify/functions/uat-planning-mode.mts');
    await withEnv({ FIRESTORE_DATABASE: null, NUVIZZ_BASE_URL: '' }, async () => {
      const res = await sw(new Request('https://x.test/.netlify/functions/uat-planning-mode', { method: 'POST', body: '{"planning":true}' }));
      assert.equal(res.status, 403);
    });
    assert.deepEqual(fake.log.writes, [], 'production refused before any write');
    await withEnv(MIRROR, async () => {
      const got = await (await sw(new Request('https://x.test/.netlify/functions/uat-planning-mode'))).json();
      assert.equal(got.planning, false, 'never set = Live');
      const on = await (await sw(new Request('https://x.test/.netlify/functions/uat-planning-mode', { method: 'POST', body: '{"planning":true}' }))).json();
      assert.equal(on.ok, true);
      assert.equal(on.planning, true);
      assert.ok(on.set_at);
      const bad = await sw(new Request('https://x.test/.netlify/functions/uat-planning-mode', { method: 'POST', body: '{"planning":"yes"}' }));
      assert.equal(bad.status, 400, 'only a real boolean flips it');
      const off = await (await sw(new Request('https://x.test/.netlify/functions/uat-planning-mode', { method: 'POST', body: '{"planning":false}' }))).json();
      assert.equal(off.planning, false);
    });
    assert.deepEqual(fake.log.writes, ['uat-mirror:uat_mode/davis', 'uat-mirror:uat_mode/davis'], 'the mirror\'s own document, and nothing else');
    assert.deepEqual(fake.log.vendor, []);
  } finally { fake.restore(); }
});

// ── 5. THE BAR ───────────────────────────────────────────────────────────────────────────────

test('THE BAR SAYS WHICH BOARD THIS IS — Live, Planning, or unknown; never a mode nobody read', () => {
  assert.equal(uatModeView(null).mode, 'unknown');
  const live = uatModeView({ ok: true, available: true, planning: false });
  assert.equal(live.mode, 'live');
  assert.match(live.title, /LIVE/);
  assert.equal(live.action, 'Planning mode');
  assert.equal(live.next, true);
  const planning = uatModeView({ ok: true, available: true, planning: true, set_by: 'Chad' });
  assert.equal(planning.mode, 'planning');
  assert.match(planning.title, /PLANNING MODE/);
  assert.match(planning.detail, /unplanned/);
  assert.match(planning.detail, /Production is not touched/);
  assert.match(planning.detail, /by Chad/);
  assert.equal(planning.action, 'Back to live');
  assert.equal(planning.next, false);
  const unknown = uatModeView({ ok: false, error: 'HTTP 502' });
  assert.equal(unknown.mode, 'unknown');
  assert.equal(unknown.action, null, 'no button on a switch nobody could read');
  assert.match(unknown.detail, /HTTP 502/);
  assert.equal(uatModeView({ ok: true, available: false, planning: false }).action, null);
});

test('the shell mounts the bar ONLY on the UAT host, and it is the bar that carries the notch there', () => {
  const src = read('src', 'App.jsx');
  assert.match(src, /\{BENCH_ON && \(\s*<UatModeBar /, 'behind BENCH_ON (isUatHost)');
  assert.match(src, /const headerAtTop = [^;]*&& !BENCH_ON;/);
});

// ── 6. WHERE THE VIEW IS APPLIED, AND WHERE IT IS NOT ────────────────────────────────────────

test('the view is applied at exactly the four planning surfaces', () => {
  const fn = (...p) => read('netlify', 'functions', ...p);
  assert.match(fn('nuvizz-pull-today-stops.mts'), /stops = stops\.map\(planningView\)/);
  assert.match(fn('nuvizz-loads-roster.mts'), /planningOn \? planningRosterBody\(b\) : b/);
  assert.match(fn('lib', 'routing-draft-core.mts'), /await readStopsForPlanning\(tenant, date\)/);
  assert.match(fn('lib', 'routing-cleanup-core.mts'), /await readStopsForPlanning\(tenant, date\)/);
  // The record is the record: the lookups keep reading what is stored.
  for (const f of ['stop-lookup.mts', 'driver-loads.mts']) assert.doesNotMatch(fn(f), /planning/i, `${f} shows the order as it is`);
});

test('the planning-mode module writes NOTHING and reaches no NuVizz module', () => {
  const src = read('netlify', 'functions', 'lib', 'uat-planning-mode.mts');
  for (const line of src.match(/^import[^\n]*from\s+['"][^'"]+['"]/gm) || []) assert.doesNotMatch(line, /nuvizz/i, line);
  assert.doesNotMatch(src, /\bsetDoc\b|\bupdateDocFields\b|\bdeleteDoc\b|\bfetch\(/);
});
