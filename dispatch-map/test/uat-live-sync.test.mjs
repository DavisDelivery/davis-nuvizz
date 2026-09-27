// test/uat-live-sync.test.mjs — PRODUCTION'S CHANGES REACH THE UAT MIRROR ON THEIR OWN; NOTHING GOES BACK.
//
// Chad, 2026-09-26: "my loads are missing this is not a match to production like its supposed to
// be any update i make to production should automatically be here as well but any change to uat
// should not automatically go to production without explicit approval."
//
// Measured that evening: production held 90 loads for Monday 09-28 (captured 00:30Z); the mirror
// held production's FRIDAY capture of that day — 0 loads — because the mirror copied production
// once a day, at 06:45 UTC. Each test below is named for the real event it pins.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installServiceAccountEnv } from './_firestore-fake.mjs';

delete process.env.FIRESTORE_DATABASE;
delete process.env.UAT_PROD_MIRROR;
delete process.env.UAT_LIVE_SYNC;
delete process.env.AUTH_REQUIRED;

import {
  liveSyncEnabled, planUnits, diffCollection, readSeen, runSync, leaseHeld, runPath, unitStatePath,
  STATIC_SYNC_COLLECTIONS, SYNC_SCHEDULE, SYNC_LEASE_MS,
} from '../netlify/functions/lib/uat-live-sync.mts';
import syncBackground, { syncTickHandler, config as syncConfig } from '../netlify/functions/uat-mirror-sync-background.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FN = (...p) => path.join(HERE, '..', 'netlify', 'functions', ...p);
const read = (...p) => fs.readFileSync(FN(...p), 'utf8');

const MIRROR_ENV = { FIRESTORE_DATABASE: 'uat-mirror' };
const T = 'davis';
const TODAY = '2026-09-26';

// ── an in-memory pair of databases for the pure core ─────────────────────────────────────────
//
// prod: path → { data, updateTime }. The deps handed to the core have NO way to write it — the
// same shape as production (lib/prod-mirror-read.mts has no writer) — and every test that runs a
// tick also proves the production store came out byte-identical.
function world({ prod = {}, mirror = {} } = {}) {
  const P = new Map(Object.entries(prod));
  const M = new Map(Object.entries(mirror));
  const calls = { sets: [], deletes: [], prodGets: [], prodLists: [] };
  const childrenOf = (store, coll) => [...store.keys()]
    .filter((k) => k.startsWith(`${coll}/`) && k.slice(coll.length + 1).split('/').length === 1);
  const idOf = (k) => k.split('/').pop();
  const deps = {
    listProdStamps: async (c) => { calls.prodLists.push(c); return childrenOf(P, c).map((k) => ({ _id: idOf(k), updateTime: P.get(k).updateTime })); },
    getProdStamped: async (p) => { calls.prodGets.push(p); return P.has(p) ? { data: structuredClone(P.get(p).data), updateTime: P.get(p).updateTime } : null; },
    listProd: async (c) => { calls.prodLists.push(c); return childrenOf(P, c).map((k) => ({ _id: idOf(k), ...structuredClone(P.get(k).data) })); },
    getMirror: async (p) => (M.has(p) ? structuredClone(M.get(p)) : null),
    setMirror: async (p, d) => { calls.sets.push(p); M.set(p, structuredClone(d)); },
    deleteMirror: async (p) => { calls.deletes.push(p); M.delete(p); },
    listMirrorIds: async (c) => childrenOf(M, c).map(idOf),
    nowIso: () => '2026-09-27T01:00:00.000Z',
  };
  const snapshot = () => JSON.stringify([...P.entries()].sort());
  return { P, M, deps, calls, snapshot };
}

const roster = (n, at) => ({
  at, emptyStreak: 0,
  loadsJson: JSON.stringify(Array.from({ length: n }, (_, i) => ({ loadId: `L${i}`, name: `ROUTE ${i}`, driver: i % 2 ? `Driver ${i}` : null }))),
});
const units = (keys) => planUnits(TODAY).filter((u) => keys.includes(u.key));

// ── 1. THE SWITCH AND THE PLAN ───────────────────────────────────────────────────────────────

test('liveSyncEnabled: never on production; on for a mirror; UAT_LIVE_SYNC off-words turn it off; a typo leaves it ON', () => {
  assert.equal(liveSyncEnabled({}), false, 'unset FIRESTORE_DATABASE is production');
  assert.equal(liveSyncEnabled({ FIRESTORE_DATABASE: '(default)', UAT_LIVE_SYNC: 'on' }), false, 'no switch turns it on for production');
  assert.equal(liveSyncEnabled(MIRROR_ENV), true, 'default on for a mirror');
  assert.equal(liveSyncEnabled({ ...MIRROR_ENV, UAT_PROD_MIRROR: 'off' }), false, 'a mirror not reading production cannot sync from it');
  for (const off of ['off', 'OFF', '0', 'false', 'no', ' off ']) assert.equal(liveSyncEnabled({ ...MIRROR_ENV, UAT_LIVE_SYNC: off }), false, `'${off}'`);
  for (const junk of ['offf', 'disabled', '1', 'true', '', 'yes']) assert.equal(liveSyncEnabled({ ...MIRROR_ENV, UAT_LIVE_SYNC: junk }), true, `'${junk}' is malformed and leaves it ON`);
});

test('planUnits: LOADS FIRST, each day\'s stops before its meta, the pool\'s chunks before its head — the order production writes them in', () => {
  const keys = planUnits(TODAY).map((u) => u.key);
  assert.deepEqual(keys.slice(0, 4), ['roster__2026-09-26', 'roster__2026-09-27', 'roster__2026-09-28', 'roster__2026-09-29'], 'today + 3, the nightly\'s board window');
  for (const d of ['2026-09-26', '2026-09-28']) assert.ok(keys.indexOf(`board__${d}__stops`) < keys.indexOf(`board__${d}`), `${d}: stops before meta`);
  assert.ok(keys.indexOf('active_pool__chunks') < keys.indexOf('active_pool'));
  for (const c of STATIC_SYNC_COLLECTIONS) assert.ok(keys.includes(c), c);
  assert.equal(keys[keys.length - 1], 'shiplify');
  assert.throws(() => planUnits('2026-9-26'), /bad today/);
});

test('planUnits is an ALLOW-list: credentials, switches and UAT\'s own working state never cross', () => {
  const paths = planUnits(TODAY).map((u) => (u.kind === 'shiplify' ? 'shiplify_index' : u.path));
  const never = ['app_users', 'driver_auth', 'nuvizz_secrets', 'nuvizz_ops', 'routing_routes', 'routing_jobs',
    'routing_load_vehicles', 'dispatch_presence', 'bottom_panel_profiles', 'claude_shadow', 'uat_', 'sms_messages'];
  for (const p of paths) for (const bad of never) assert.ok(!p.startsWith(bad), `${p} must not be synced (${bad})`);
});

test('diffCollection: changed = production updateTime differs from this sync\'s copy; removed = only what this sync copied', () => {
  const prod = [{ _id: 'a', updateTime: 't2' }, { _id: 'b', updateTime: 't1' }];
  const { changed, removed } = diffCollection(prod, { a: 't1', b: 't1', gone: 't0' }, { prune: 'copied', firstTick: false });
  assert.deepEqual(changed.map((c) => c._id), ['a']);
  assert.deepEqual(removed, ['gone']);
  const uatOnly = diffCollection(prod, {}, { prune: 'copied', firstTick: true, mirrorIds: ['uat-made'] });
  assert.deepEqual(uatOnly.removed, [], 'a collection unit never removes a document it did not put there');
  const board = diffCollection(prod, {}, { prune: 'board', firstTick: true, mirrorIds: ['a', 'stale', 'UT-12345'] });
  assert.deepEqual(board.removed, ['stale'], 'a board day\'s first tick removes a stale production copy but keeps the UAT bench\'s UT- order');
  const later = diffCollection(prod, { a: 't2', b: 't1' }, { prune: 'board', firstTick: false, mirrorIds: ['stale'] });
  assert.deepEqual(later.removed, [], 'after the first tick the mirror listing is not consulted');
});

test('readSeen: a corrupt state document reads as empty (a full re-copy), never as a throw', () => {
  assert.deepEqual(readSeen(null), {});
  assert.deepEqual(readSeen({ seenJson: '{nope' }), {});
  assert.deepEqual(readSeen({ seenJson: '[1,2]' }), {});
  assert.deepEqual(readSeen({ seenJson: '{"a":"t"}' }), { a: 't' });
});

// ── 2. THE TICK ──────────────────────────────────────────────────────────────────────────────

test('MONDAY\'S LOADS: production captured 90 at 8:30 PM, the mirror held Friday\'s empty copy — one tick puts production\'s on UAT', async () => {
  const w = world({
    prod: { 'nuvizz_load_roster/davis__2026-09-28': { data: roster(90, '2026-09-27T00:30:47.608Z'), updateTime: '2026-09-27T00:30:48Z' } },
    mirror: { 'nuvizz_load_roster/davis__2026-09-28': { ...roster(0, '2026-09-25T16:15:20.752Z'), emptyStreak: 22 } },
  });
  const before = w.snapshot();
  const rep = await runSync(w.deps, units(['roster__2026-09-28']), { today: TODAY });
  const got = w.M.get('nuvizz_load_roster/davis__2026-09-28');
  assert.equal(JSON.parse(got.loadsJson).length, 90, 'the Loads tab now reads production\'s 90');
  assert.equal(got.at, '2026-09-27T00:30:47.608Z', 'with production\'s own capture stamp, so its age reads true');
  assert.equal(rep.totals.copied, 1);
  assert.equal(rep.nuvizz_calls, 0);
  assert.equal(w.snapshot(), before, 'production is byte-identical after the tick');

  const again = await runSync(w.deps, units(['roster__2026-09-28']), { today: TODAY });
  assert.equal(again.totals.copied, 0, 'a quiet production costs a read, never a write');
});

test('A TEST EDIT ON UAT STAYS until production edits that same customer — then production wins', async () => {
  const w = world({ prod: { 'customer_notes/acme': { data: { receivingHours: '8-2' }, updateTime: 't1' } } });
  const u = units(['customer_notes']);
  await runSync(w.deps, u, { today: TODAY });
  assert.deepEqual(w.M.get('customer_notes/acme'), { receivingHours: '8-2' });

  w.M.set('customer_notes/acme', { receivingHours: '7-11 (UAT test)' });      // Chad tries something on UAT
  await runSync(w.deps, u, { today: TODAY });
  assert.deepEqual(w.M.get('customer_notes/acme'), { receivingHours: '7-11 (UAT test)' }, 'production did not change it, so UAT\'s edit stands');

  w.P.set('customer_notes/acme', { data: { receivingHours: '9-3' }, updateTime: 't2' });   // a dispatcher edits it in production
  await runSync(w.deps, u, { today: TODAY });
  assert.deepEqual(w.M.get('customer_notes/acme'), { receivingHours: '9-3' }, 'production changed it — production wins');
});

test('a note production DELETED is removed from UAT; a note UAT created on its own is never touched', async () => {
  const w = world({
    prod: { 'customer_notes/a': { data: { x: 1 }, updateTime: 't1' }, 'customer_notes/b': { data: { x: 2 }, updateTime: 't1' } },
    mirror: { 'customer_notes/uat-made': { x: 9 } },
  });
  const u = units(['customer_notes']);
  await runSync(w.deps, u, { today: TODAY });
  w.P.delete('customer_notes/b');
  const rep = await runSync(w.deps, u, { today: TODAY });
  assert.equal(w.M.has('customer_notes/b'), false, 'gone in production, gone here');
  assert.deepEqual(w.M.get('customer_notes/uat-made'), { x: 9 }, 'never copied by the sync, so never removed by it');
  assert.equal(rep.totals.removed, 1);
});

test('THE BOARD: stale stops the nightly left behind go on the day\'s first tick; the UAT bench\'s UT- orders stay; meta written after its stops', async () => {
  const d = '2026-09-28';
  const base = `nuvizz_stop_index/davis__${d}`;
  const w = world({
    prod: {
      [base]: { data: { count: 2, last_scanned_at: '2026-09-27T00:20:00Z' }, updateTime: 'm1' },
      [`${base}/stops/A1`]: { data: { stopNbr: 'A1', isPlanned: true }, updateTime: 's1' },
      [`${base}/stops/A2`]: { data: { stopNbr: 'A2', isPlanned: false }, updateTime: 's1' },
    },
    mirror: {
      [`${base}/stops/A1`]: { stopNbr: 'A1', isPlanned: false },            // the nightly's older copy
      [`${base}/stops/CANCELLED9`]: { stopNbr: 'CANCELLED9' },               // production pruned it; the nightly never does
      [`${base}/stops/UT-0060189919`]: { stopNbr: 'UT-0060189919' },         // the UAT bench's own test order
    },
  });
  const rep = await runSync(w.deps, units([`board__${d}__stops`, `board__${d}`]), { today: TODAY });
  assert.deepEqual(w.M.get(`${base}/stops/A1`), { stopNbr: 'A1', isPlanned: true }, 'production\'s current row');
  assert.equal(w.M.has(`${base}/stops/A2`), true);
  assert.equal(w.M.has(`${base}/stops/CANCELLED9`), false, 'the stale copy is gone');
  assert.equal(w.M.has(`${base}/stops/UT-0060189919`), true, 'the bench\'s order is UAT\'s own and stays');
  const meta = w.M.get(base);
  assert.equal(meta.count, 2);
  assert.equal(meta.mirrored_from, '(default)', 'the day\'s meta says where it came from, as the nightly\'s does');
  const lastStop = Math.max(...w.calls.sets.map((p, i) => (p.startsWith(`${base}/stops/`) ? i : -1)));
  assert.ok(w.calls.sets.indexOf(base) > lastStop, 'meta written after every stop');
  assert.equal(rep.totals.errors, 0);

  // production prunes a stop later — the sync copied it, so the sync removes it
  w.P.delete(`${base}/stops/A2`);
  await runSync(w.deps, units([`board__${d}__stops`]), { today: TODAY });
  assert.equal(w.M.has(`${base}/stops/A2`), false);
  assert.equal(w.M.has(`${base}/stops/UT-0060189919`), true, 'and still leaves the bench alone');
});

test('NOTHING IS EVER WRITTEN TO PRODUCTION: a full tick over every unit leaves the production store byte-identical', async () => {
  const w = world({
    prod: {
      'nuvizz_load_roster/davis__2026-09-26': { data: roster(3, 'x'), updateTime: 't' },
      'nuvizz_stop_index/davis__2026-09-26/stops/S1': { data: { stopNbr: 'S1' }, updateTime: 't' },
      'customer_notes/c': { data: { y: 1 }, updateTime: 't' },
      'shiplify_index/davis': { data: { generation: 'g1', chunks: 1 }, updateTime: 'h1' },
      'shiplify_index/davis__0': { data: { generation: 'g1', lines: ['l'] }, updateTime: 'c1' },
    },
  });
  const before = w.snapshot();
  const rep = await runSync(w.deps, planUnits(TODAY), { today: TODAY });
  assert.equal(w.snapshot(), before);
  assert.equal(rep.totals.errors, 0, JSON.stringify(rep.units.filter((u) => u.error)));
  assert.equal(rep.finished, true);
});

test('SHIPLIFY: an import in production reaches UAT — locations, chunks, logs (never the run lease), head LAST; the same import is not copied twice', async () => {
  const batch = 'shp_0123456789abcdef';
  const w = world({
    prod: {
      'shiplify_index/davis': { data: { generation: 'g1', chunks: 2 }, updateTime: 'h1' },
      'shiplify_index/davis__0': { data: { generation: 'g1', lines: ['a'] }, updateTime: 'c' },
      'shiplify_index/davis__1': { data: { generation: 'g1', lines: ['b'] }, updateTime: 'c' },
      'shiplify_locations/davis__k1': { data: { name: 'Dock 1' }, updateTime: 'c' },
      [`shiplify_imports/${batch}`]: { data: { status: 'done' }, updateTime: 'c' },
      'shiplify_imports/davis__lock': { data: { token: 'prod-lease' }, updateTime: 'c' },
    },
  });
  const u = units(['shiplify']);
  const rep = await runSync(w.deps, u, { today: TODAY });
  assert.deepEqual(w.M.get('shiplify_index/davis'), { generation: 'g1', chunks: 2 });
  assert.deepEqual(w.M.get('shiplify_index/davis__1'), { generation: 'g1', lines: ['b'] });
  assert.deepEqual(w.M.get('shiplify_locations/davis__k1'), { name: 'Dock 1' });
  assert.deepEqual(w.M.get(`shiplify_imports/${batch}`), { status: 'done' }, 'the import screen says what production\'s says');
  assert.equal(w.M.has('shiplify_imports/davis__lock'), false, 'a production lease would refuse a UAT import for fifteen minutes');
  const headAt = w.calls.sets.indexOf('shiplify_index/davis');
  assert.ok(w.calls.sets.every((p, i) => !p.startsWith('shiplify_index/davis__') || i < headAt), 'every chunk before the head');
  assert.equal(rep.units[0].copied, 5);

  const setsBefore = w.calls.sets.length;
  await runSync(w.deps, u, { today: TODAY });
  assert.equal(w.calls.sets.length, setsBefore, 'the same import is one read a tick, not thousands of writes');

  w.P.set('shiplify_index/davis', { data: { generation: 'g2', chunks: 2 }, updateTime: 'h2' });
  await runSync(w.deps, u, { today: TODAY });
  assert.equal(w.M.get('shiplify_index/davis').generation, 'g2', 'a new import is');
});

test('ONE UNREADABLE COLLECTION DOES NOT STOP THE LOADS: the failing unit is reported with its error, the others run', async () => {
  const w = world({ prod: { 'nuvizz_load_roster/davis__2026-09-28': { data: roster(5, 'x'), updateTime: 't' } } });
  const listProdStamps = w.deps.listProdStamps;
  w.deps.listProdStamps = async (c) => { if (c === 'customer_notes') throw new Error('403 PERMISSION_DENIED'); return listProdStamps(c); };
  const rep = await runSync(w.deps, units(['customer_notes', 'roster__2026-09-28']), { today: TODAY });
  assert.equal(rep.totals.errors, 1);
  assert.match(rep.units.find((u) => u.key === 'customer_notes').error, /PERMISSION_DENIED/);
  assert.equal(JSON.parse(w.M.get('nuvizz_load_roster/davis__2026-09-28').loadsJson).length, 5);
});

test('BUDGET: units the tick did not reach are named as deferred and leave no state behind — the next tick does them', async () => {
  const w = world({ prod: { 'customer_notes/a': { data: { x: 1 }, updateTime: 't' } } });
  let t = 0;
  w.deps.now = () => (t += 1000);
  const rep = await runSync(w.deps, units(['roster__2026-09-26', 'customer_notes']), { today: TODAY, budgetMs: 1500 });
  assert.deepEqual(rep.deferred, ['customer_notes']);
  assert.equal(rep.finished, false);
  assert.equal(w.M.has(unitStatePath(T, 'customer_notes')), false);
});

test('DRY RUN (?sync=explain) writes nothing and says what a tick would do', async () => {
  const d = '2026-09-28';
  const base = `nuvizz_stop_index/davis__${d}`;
  const w = world({
    prod: { 'nuvizz_load_roster/davis__2026-09-28': { data: roster(90, 'x'), updateTime: 't' }, [`${base}/stops/A1`]: { data: { stopNbr: 'A1' }, updateTime: 's' } },
    mirror: { [`${base}/stops/STALE`]: { stopNbr: 'STALE' } },
  });
  const rep = await runSync(w.deps, units(['roster__2026-09-28', `board__${d}__stops`]), { today: TODAY, dry: true });
  assert.equal(w.calls.sets.length, 0);
  assert.equal(w.calls.deletes.length, 0);
  assert.equal(rep.dry, true);
  assert.equal(rep.units[0].changed, 1);
  assert.deepEqual(rep.units[1].wouldRemove, ['STALE']);
});

// ── 3. THE SCHEDULED TICK ────────────────────────────────────────────────────────────────────

const REQ = new Request('https://x.test/.netlify/functions/uat-mirror-sync-background', { method: 'POST', body: '{"next_run":"x"}' });

test('ON PRODUCTION the cron fires and the tick returns 403 in its first line — nothing read, nothing written', async () => {
  let touched = 0;
  const trap = new Proxy({}, { get: () => () => { touched++; throw new Error('must not be reached'); } });
  const res = await syncTickHandler(REQ, { env: {}, deps: trap, firestore: true });
  assert.equal(res.status, 403);
  assert.match((await res.json()).refused, /never runs on production/);
  assert.equal(touched, 0);
});

test('UAT_LIVE_SYNC=off is the way back: the tick refuses before reading anything', async () => {
  let touched = 0;
  const trap = new Proxy({}, { get: () => () => { touched++; throw new Error('must not be reached'); } });
  const res = await syncTickHandler(REQ, { env: { ...MIRROR_ENV, UAT_LIVE_SYNC: 'off' }, deps: trap, firestore: true });
  assert.match((await res.json()).refused, /UAT_LIVE_SYNC=off/);
  assert.equal(touched, 0);
});

test('ONE TICK AT A TIME: a live lease skips the tick without writing; a stale one is taken over; the lease is always released', async () => {
  const w = world({ prod: { 'nuvizz_load_roster/davis__2026-09-26': { data: roster(1, 'x'), updateTime: 't' } } });
  const now = Date.parse('2026-09-27T01:00:00Z');
  w.deps.now = () => now;
  w.M.set(runPath(T), { running_since: '2026-09-27T00:55:00Z' });
  const skipped = await (await syncTickHandler(REQ, { env: MIRROR_ENV, deps: w.deps, firestore: true, today: TODAY })).json();
  assert.equal(skipped.skipped, 'a tick is already running');
  assert.equal(w.calls.sets.length, 0);

  w.M.set(runPath(T), { running_since: new Date(now - SYNC_LEASE_MS - 1000).toISOString() });
  const ran = await (await syncTickHandler(REQ, { env: MIRROR_ENV, deps: w.deps, firestore: true, today: TODAY })).json();
  assert.equal(ran.ok, true);
  assert.equal(ran.nuvizz_calls, 0);
  const run = w.M.get(runPath(T));
  assert.equal(run.running_since, null, 'released');
  assert.equal(run.last.totals.errors, 0);
  assert.ok(run.last.units.length > 20, 'the report ?sync=1 serves, unit by unit');
});

test('leaseHeld: a missing or unreadable stamp is not a lease', () => {
  assert.equal(leaseHeld(null, Date.now()), false);
  assert.equal(leaseHeld({ running_since: 'garbage' }, Date.now()), false);
  assert.equal(leaseHeld({ running_since: null }, Date.now()), false);
});

test('the schedule Netlify reads is a literal in the source, and it is SYNC_SCHEDULE (every 10 minutes)', () => {
  assert.equal(syncConfig.schedule, SYNC_SCHEDULE);
  assert.equal(SYNC_SCHEDULE, '*/10 * * * *');
  assert.match(read('uat-mirror-sync-background.mts'), /schedule: '\*\/10 \* \* \* \*'/);
  assert.equal(typeof syncBackground, 'function');
});

// ── 4. ZERO NUVIZZ CALLS, BY CONSTRUCTION ────────────────────────────────────────────────────

test('NOTHING IN THE LIVE SYNC IMPORTS A NUVIZZ MODULE, AND ONLY THE PRODUCTION READER TALKS HTTP', () => {
  const files = [['lib', 'uat-live-sync.mts'], ['lib', 'uat-live-sync-io.mts'], ['uat-mirror-sync-background.mts']];
  for (const f of files) {
    const src = read(...f);
    for (const line of src.match(/^import[^\n]*from\s+['"][^'"]+['"]/gm) || []) assert.doesNotMatch(line, /nuvizz/i, `${f.join('/')}: ${line}`);
    assert.doesNotMatch(src, /NUVIZZ_BASE_URL|nuvizzFetch|nuvizzGet|nuvizzPost/);
    assert.doesNotMatch(src, /\bfetch\(/, `${f.join('/')} performs no HTTP of its own`);
  }
  // The core imports no database module at all: it can only write through the deps it is handed.
  assert.doesNotMatch(read('lib', 'uat-live-sync.mts'), /from '\.\/firestore\.mts'/);
});

test('prod-mirror-read\'s stamped readers keep the file\'s three constraints: GET only, (default) only, mirror only', async () => {
  const src = read('lib', 'prod-mirror-read.mts');
  assert.match(src, /export async function listProdDocStamps/);
  assert.match(src, /export async function getProdDocStamped/);
  assert.equal((src.match(/databases\/\$\{([A-Za-z_$][\w$]*)\}/g) || []).length, 1, 'still exactly one database addressed');
  const { listProdDocStamps, getProdDocStamped } = await import('../netlify/functions/lib/prod-mirror-read.mts');
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not be reached'); };
  try {
    await assert.rejects(listProdDocStamps('customer_notes', { env: {} }), /refused/);
    await assert.rejects(getProdDocStamped('customer_notes/x', { env: { FIRESTORE_DATABASE: '(default)' } }), /refused/);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls, 0);
});

// ── 5. THE LOADS ENDPOINT ON THE MIRROR ──────────────────────────────────────────────────────
//
// A two-database Firestore fake keyed on the database in the URL, so a test can see which side
// was read and which was written. Anything that is not Firestore or the token endpoint is logged
// as a vendor call and refused.
const encVal = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encVal) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encVal(x)])) } };
};
const decVal = (v) => {
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decVal);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decVal(x)]));
  return null;
};
function installTwoDatabases({ prod = {}, mirror = {} }) {
  installServiceAccountEnv();
  const dbs = { '(default)': new Map(Object.entries(prod)), 'uat-mirror': new Map(Object.entries(mirror)) };
  const log = { vendor: [], writes: [], reads: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    const method = String(init.method || 'GET').toUpperCase();
    if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    const m = /firestore\.googleapis\.com\/v1\/projects\/[^/]+\/databases\/([^/]+)\/documents\/([^?]+)/.exec(url);
    if (!m) { log.vendor.push(url); throw new Error(`vendor call refused by the test: ${url}`); }
    const db = decodeURIComponent(m[1]);
    const p = decodeURIComponent(m[2]);
    const store = dbs[db];
    if (!store) throw new Error(`unknown database ${db}`);
    if (method === 'PATCH') {
      log.writes.push(`${db}:${p}`);
      const fields = JSON.parse(String(init.body)).fields || {};
      store.set(p, { data: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decVal(v)])), updateTime: '2026-09-27T01:05:00Z' });
      return new Response('{}', { status: 200 });
    }
    log.reads.push(`${db}:${p}`);
    const hit = store.get(p);
    if (!hit) return new Response('{"error":{"code":404}}', { status: 404 });
    return new Response(JSON.stringify({
      name: `projects/testproj/databases/${db}/documents/${p}`, updateTime: hit.updateTime,
      fields: Object.fromEntries(Object.entries(hit.data).map(([k, v]) => [k, encVal(v)])),
    }), { status: 200 });
  };
  return { dbs, log, restore: () => { globalThis.fetch = realFetch; } };
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

const MONDAY = '2026-09-28';
const PROD_ROSTER = { data: roster(90, '2026-09-27T00:30:47.608Z'), updateTime: '2026-09-27T00:30:48Z' };
const FRIDAY_EMPTY = { data: { ...roster(0, '2026-09-25T16:15:20.752Z'), emptyStreak: 22 }, updateTime: '2026-09-26T06:46:00Z' };
const rosterUrl = (q = '') => `https://x.test/.netlify/functions/nuvizz-loads-roster?date=${MONDAY}${q}`;

test('ON THE MIRROR an automatic Loads read serves production\'s copy — even a stale empty one — and NEVER reaches NuVizz', async () => {
  const fake = installTwoDatabases({ prod: { [`nuvizz_load_roster/davis__${MONDAY}`]: PROD_ROSTER }, mirror: { [`nuvizz_load_roster/davis__${MONDAY}`]: FRIDAY_EMPTY } });
  try {
    await withEnv({ FIRESTORE_DATABASE: 'uat-mirror', NUVIZZ_BASE_URL: 'https://uat.nuvizz.com/deliverit/openapi/v7' }, async () => {
      const { default: handler } = await import('../netlify/functions/nuvizz-loads-roster.mts');
      const body = await (await handler(new Request(rosterUrl()))).json();
      assert.equal(body.ok, true);
      assert.equal(body.source, 'cache');
      assert.equal(body.count, 0, 'the copy it holds, until the sync brings production\'s newer one');
      assert.equal(body.at, '2026-09-25T16:15:20.752Z', 'with its real age, so the freshness line says how old it is');
      assert.equal(body.mirror, true);
    });
    assert.deepEqual(fake.log.vendor, [], 'the UAT NuVizz tenant was not asked');
    assert.deepEqual(fake.log.writes, [], 'and nothing was written over production\'s copy');
  } finally { fake.restore(); }
});

test('ON THE MIRROR the Refresh button (?live=1) re-copies PRODUCTION\'S roster and serves Monday\'s 90 loads — zero NuVizz calls', async () => {
  const fake = installTwoDatabases({ prod: { [`nuvizz_load_roster/davis__${MONDAY}`]: PROD_ROSTER }, mirror: { [`nuvizz_load_roster/davis__${MONDAY}`]: FRIDAY_EMPTY } });
  try {
    await withEnv({ FIRESTORE_DATABASE: 'uat-mirror', NUVIZZ_BASE_URL: 'https://uat.nuvizz.com/deliverit/openapi/v7' }, async () => {
      const { default: handler } = await import('../netlify/functions/nuvizz-loads-roster.mts');
      const body = await (await handler(new Request(rosterUrl('&live=1')))).json();
      assert.equal(body.count, 90);
      assert.equal(body.refreshed_from_production, true);
      assert.equal(body.source, 'cache', 'never "live" — nothing came straight from NuVizz');
    });
    assert.deepEqual(fake.log.vendor, []);
    assert.deepEqual(fake.log.writes, [`uat-mirror:nuvizz_load_roster/davis__${MONDAY}`], 'written to the MIRROR, and only there');
    assert.ok(fake.log.reads.includes(`(default):nuvizz_load_roster/davis__${MONDAY}`), 'read from production');
    assert.equal(fake.dbs['(default)'].get(`nuvizz_load_roster/davis__${MONDAY}`), PROD_ROSTER, 'production untouched');
  } finally { fake.restore(); }
});

test('ON THE MIRROR a date production never captured answers "none" rather than asking NuVizz', async () => {
  const fake = installTwoDatabases({});
  try {
    await withEnv({ FIRESTORE_DATABASE: 'uat-mirror', NUVIZZ_BASE_URL: 'https://uat.nuvizz.com/deliverit/openapi/v7' }, async () => {
      const { default: handler } = await import('../netlify/functions/nuvizz-loads-roster.mts');
      const body = await (await handler(new Request(rosterUrl()))).json();
      assert.equal(body.source, 'none');
      assert.match(body.note, /production holds no roster/);
    });
    assert.deepEqual(fake.log.vendor, []);
  } finally { fake.restore(); }
});

test('PRODUCTION IS UNCHANGED: with no named database the mirror branch never runs and production\'s cache is served exactly as before', async () => {
  const fake = installTwoDatabases({ prod: { [`nuvizz_load_roster/davis__${MONDAY}`]: PROD_ROSTER } });
  try {
    await withEnv({ FIRESTORE_DATABASE: null, NUVIZZ_BASE_URL: '' }, async () => {
      const { default: handler } = await import('../netlify/functions/nuvizz-loads-roster.mts');
      const body = await (await handler(new Request(rosterUrl()))).json();
      assert.equal(body.source, 'cache');
      assert.equal(body.count, 90);
      assert.equal(body.mirror, undefined, 'no mirror field on production\'s answer');
    });
    assert.deepEqual(fake.log.vendor, []);
    assert.deepEqual(fake.log.writes, []);
  } finally { fake.restore(); }
});
