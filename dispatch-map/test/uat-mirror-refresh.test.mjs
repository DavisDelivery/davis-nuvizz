// test/uat-mirror-refresh.test.mjs — loading production's days into the UAT mirror from
// Firestore alone, with ZERO NuVizz calls.
//
// Chad, 2026-09-20: "I want to use firestore to load up all our stops so I can test there
// without doing anything in nuvizz or nuvizz uat … We can do this all without a single nuvizz
// call just using our uat and firestore data."
//
// The tests pin the rules that make a cross-database copy safe, each named for what goes
// wrong without it: production is never written, production is never reached from
// production, nothing here can spend a vendor call, and a half-copied day never reads as a
// sealed one on the mirror.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// env BEFORE the import chain — the endpoints read process.env at request time, but nothing
// in the chain may need FIREBASE_SA at import time either.
delete process.env.FIRESTORE_DATABASE;
delete process.env.UAT_PROD_MIRROR;
delete process.env.AUTH_REQUIRED;

import { prodMirrorReadEnabled, listProdDocs, getProdDoc } from '../netlify/functions/lib/prod-mirror-read.mts';
import {
  planRefresh, onOff, addDays, stripId, leanStop, planLabel, freshProgress, progressPath,
  prodHistoryDates, copyStatic, copyHistoryDay, copyBoardDay, copyRosterDay, copyLedgerDay,
  runRefresh, explainRefresh,
  STATIC_COLLECTIONS, BOARD_COLLECTION, ROSTER_COLLECTION, LEDGER_COLLECTION, PROGRESS_COLLECTION,
  DEFAULT_HISTORY_DAYS, DEFAULT_HORIZON_DAYS, TIME_BUDGET_MS,
} from '../netlify/functions/lib/uat-mirror-refresh.mts';
import { HISTORY_COLLECTION, dayPath } from '../netlify/functions/lib/history-store.mts';
import refreshBackground, { OVERRIDE_PARAMS, config as backgroundConfig } from '../netlify/functions/uat-mirror-refresh-background.mts';
import refreshRead from '../netlify/functions/uat-mirror-refresh.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FN = (...p) => path.join(HERE, '..', 'netlify', 'functions', ...p);
const read = (...p) => fs.readFileSync(FN(...p), 'utf8');

const NEW_FILES = [
  ['lib', 'prod-mirror-read.mts'],
  ['lib', 'uat-mirror-refresh.mts'],
  ['uat-mirror-refresh-background.mts'],
  ['uat-mirror-refresh.mts'],
];

/** Run `fn` with a given env, restoring what was there. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v == null) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const MIRROR = { FIRESTORE_DATABASE: 'uat-mirror' };
const PRODUCTION = { FIRESTORE_DATABASE: null };

// ── 1. THE PRODUCTION READER CANNOT WRITE, CANNOT POINT ELSEWHERE, CANNOT RUN ON PRODUCTION ──

test('prod-mirror-read HAS NO WRITER — not a guarded one, not a disabled one, none (source text)', () => {
  const src = read('lib', 'prod-mirror-read.mts');
  assert.doesNotMatch(src, /method:\s*['"](POST|PATCH|PUT|DELETE)['"]/i, 'no mutating HTTP method anywhere in the file');
  assert.doesNotMatch(src, /\bsetDoc\b|\bdeleteDoc\b|\bupdateDocFields\b|:commit\b|\brunQuery\b/, 'no Firestore writer imported or called');
  // Every fetch in the file is a bare GET (no options object carrying a method).
  const fetches = src.match(/fetch\([^)]*\)/g) || [];
  assert.ok(fetches.length >= 2, 'the list and get paths both fetch');
  for (const f of fetches) assert.doesNotMatch(f, /method/i, `${f} must not name a method`);
});

test('prod-mirror-read ONLY EVER ADDRESSES databases/(default) — hard-coded, interpolated in exactly one place', () => {
  const src = read('lib', 'prod-mirror-read.mts');
  assert.match(src, /const PROD_DATABASE = '\(default\)';/, 'a const, so nothing can point it elsewhere');
  assert.match(src, /databases\/\$\{PROD_DATABASE\}/, 'the URL interpolates the constant');
  assert.equal((src.match(/databases\/\$\{([A-Za-z_$][\w$]*)\}/g) || []).length, 1, 'exactly one database is ever addressed');
  assert.match(src, /const FIRESTORE_BASE = 'https:\/\/firestore\.googleapis\.com\/v1'/, 'and only the Firestore REST host');
  assert.equal((src.match(/https?:\/\//g) || []).length, 1, 'no other host appears in the file');
});

test('prodMirrorReadEnabled: false on production, true on a mirror, an off-word turns it off, a typo leaves it ON', () => {
  assert.equal(prodMirrorReadEnabled({}), false, 'unset FIRESTORE_DATABASE is production');
  assert.equal(prodMirrorReadEnabled({ FIRESTORE_DATABASE: '(default)' }), false);
  assert.equal(prodMirrorReadEnabled({ FIRESTORE_DATABASE: '(default)', UAT_PROD_MIRROR: 'on' }), false, 'no switch turns it on for production');
  assert.equal(prodMirrorReadEnabled({ FIRESTORE_DATABASE: 'uat-mirror' }), true, 'default on for a mirror');
  for (const off of ['off', 'OFF', '0', 'false', 'no', ' off ']) {
    assert.equal(prodMirrorReadEnabled({ FIRESTORE_DATABASE: 'uat-mirror', UAT_PROD_MIRROR: off }), false, `'${off}' turns it off`);
  }
  for (const junk of ['offf', 'disabled', 'nope', '1', 'true', '']) {
    assert.equal(prodMirrorReadEnabled({ FIRESTORE_DATABASE: 'uat-mirror', UAT_PROD_MIRROR: junk }), true, `'${junk}' is malformed and leaves it ON — a typo must never silently disable the mirror`);
  }
});

test('listProdDocs / getProdDoc REFUSE on production and on a switched-off mirror — before any network call', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not be reached'); };
  try {
    await assert.rejects(listProdDocs('customer_notes', { env: { FIRESTORE_DATABASE: '(default)' } }), /refused/);
    await assert.rejects(getProdDoc('customer_notes/x', { env: {} }), /refused/);
    await assert.rejects(listProdDocs('customer_notes', { env: { FIRESTORE_DATABASE: 'uat-mirror', UAT_PROD_MIRROR: 'off' } }), /refused/);
    await assert.rejects(getProdDoc('customer_notes/x', { env: { FIRESTORE_DATABASE: 'uat-mirror', UAT_PROD_MIRROR: 'off' } }), /refused/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0, 'refusal happens before fetch');
});

// ── 2. ZERO NUVIZZ CALLS, BY CONSTRUCTION ────────────────────────────────────

test('NOTHING IN THE REFRESH IMPORTS A NUVIZZ MODULE OR NAMES THE NUVIZZ BASE URL — zero vendor calls is structural', () => {
  for (const f of NEW_FILES) {
    const src = read(...f);
    const imports = src.match(/^import[^\n]*from\s+['"][^'"]+['"]/gm) || [];
    for (const line of imports) {
      assert.doesNotMatch(line, /nuvizz/i, `${f.join('/')}: ${line}`);
    }
    assert.doesNotMatch(src, /NUVIZZ_BASE_URL|NUVIZZ_API|nuvizzFetch|nuvizzGet|nuvizzPost/, `${f.join('/')} must not reach the vendor`);
  }
  // The core and the two endpoints do not call fetch at all — only the production reader does,
  // and that one is pinned above to the Firestore host.
  for (const f of NEW_FILES.slice(1)) {
    assert.doesNotMatch(read(...f), /\bfetch\(/, `${f.join('/')} performs no HTTP of its own`);
  }
});

test('the background endpoint REFUSES PRODUCTION BEFORE PARSING — a malformed override gets 403, never 400', async () => {
  const src = read('uat-mirror-refresh-background.mts');
  assert.ok(src.indexOf('isMirrorDeploy()') < src.indexOf('new URL('), 'the mirror gate precedes the URL parse in the source');
  assert.ok(src.indexOf('isMirrorDeploy()') < src.indexOf('gateScheduledOverride('), 'and precedes the override gate');
  await withEnv(PRODUCTION, async () => {
    const res = await refreshBackground(new Request('https://x.test/.netlify/functions/uat-mirror-refresh-background?from=garbage', { method: 'POST' }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.refused, /not a mirror deploy/);
    assert.equal(body.database, '(default)');
  });
});

test('the background endpoint is SCHEDULED, and on production the cron fires into that first-line 403', async () => {
  assert.equal(backgroundConfig.schedule, '45 6 * * *', 'daily after production\'s 06:00 capture has sealed yesterday');
  await withEnv(PRODUCTION, async () => {
    // A scheduled invocation carries no query string. Production still answers 403 and spends nothing.
    const res = await refreshBackground(new Request('https://x.test/.netlify/functions/uat-mirror-refresh-background', { method: 'POST' }));
    assert.equal(res.status, 403);
  });
});

test('UAT_PROD_MIRROR=off puts a mirror back to its own database — the endpoint says so and stops', async () => {
  await withEnv({ ...MIRROR, UAT_PROD_MIRROR: 'off' }, async () => {
    const res = await refreshBackground(new Request('https://x.test/.netlify/functions/uat-mirror-refresh-background', { method: 'POST' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.refused, /UAT_PROD_MIRROR=off/);
  });
});

test('every override the background endpoint reads is in OVERRIDE_PARAMS — an unlisted one would slip past the admin gate', () => {
  const src = read('uat-mirror-refresh-background.mts');
  const reads = new Set([...src.matchAll(/\b(?:q|num)\('([a-z]+)'\)/g)].map((m) => m[1]));
  for (const k of reads) assert.ok(OVERRIDE_PARAMS.includes(k), `'${k}' is read but not gated`);
  for (const k of OVERRIDE_PARAMS) assert.ok(reads.has(k), `'${k}' is gated but never read — dead gate`);
});

test('the sync reader REFUSES PRODUCTION FIRST, then non-GET — and its explain path cannot write', async () => {
  const src = read('uat-mirror-refresh.mts');
  assert.ok(src.indexOf('isMirrorDeploy()') < src.indexOf("req.method !== 'GET'"), 'mirror gate before the method gate');
  assert.ok(src.indexOf('isMirrorDeploy()') < src.indexOf('requireUser('), 'mirror gate before auth');
  assert.match(src, /setDoc: async \(\) => \{ throw new Error\('explain never writes'\); \}/, 'explain is handed a writer that throws');
  await withEnv(PRODUCTION, async () => {
    const res = await refreshRead(new Request('https://x.test/.netlify/functions/uat-mirror-refresh?explain=1'));
    assert.equal(res.status, 403);
  });
  await withEnv(MIRROR, async () => {
    const res = await refreshRead(new Request('https://x.test/.netlify/functions/uat-mirror-refresh', { method: 'POST' }));
    assert.equal(res.status, 405, 'the copy runs through the background function only');
  });
});

// ── 3. THE PLAN ──────────────────────────────────────────────────────────────

test('planRefresh defaults: yesterday is the newest sealed day, 90 days back, the board is today + 3', () => {
  const p = planRefresh({ today: '2026-09-20' });
  assert.equal(p.tenant, 'davis');
  assert.equal(p.historyTo, '2026-09-19', 'today is not sealed yet');
  assert.equal(p.historyFrom, '2026-06-22', `${DEFAULT_HISTORY_DAYS} days inclusive`);
  assert.deepEqual(p.boardDates, ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'], `today + ${DEFAULT_HORIZON_DAYS}`);
  assert.equal(p.board, true); assert.equal(p.history, true); assert.equal(p.static, true);
  assert.equal(p.remine, true); assert.equal(p.lean, true);
});

test('planRefresh honours an explicit window, clamps the horizon, and never widens on a bad date', () => {
  const p = planRefresh({ today: '2026-09-20', from: '2026-09-01', to: '2026-09-10', horizonDays: 0, lean: false, remine: false });
  assert.equal(p.historyFrom, '2026-09-01'); assert.equal(p.historyTo, '2026-09-10');
  assert.deepEqual(p.boardDates, ['2026-09-20'], 'horizon 0 = today only');
  assert.equal(p.lean, false); assert.equal(p.remine, false);
  assert.equal(planRefresh({ today: '2026-09-20', horizonDays: 99 }).boardDates.length, 15, 'horizon clamps to 14');
  assert.equal(planRefresh({ today: '2026-09-20', historyDays: 7 }).historyFrom, '2026-09-13');
  assert.throws(() => planRefresh({ today: 'today' }), /bad today/);
  assert.throws(() => planRefresh({ today: '2026-09-20', from: '9/1/2026' }), /bad from/);
  assert.throws(() => planRefresh({ today: '2026-09-20', from: '2026-09-15', to: '2026-09-10' }), /after/);
});

test('onOff: unset is on, an off-word is off, a malformed word is ON (house shape)', () => {
  assert.equal(onOff(null), true); assert.equal(onOff(undefined), true); assert.equal(onOff(''), true);
  for (const v of ['off', 'OFF', '0', 'false', 'no']) assert.equal(onOff(v), false, v);
  for (const v of ['on', '1', 'yes', 'disabled', 'offf']) assert.equal(onOff(v), true, v);
});

test('addDays is calendar arithmetic across a month end and DST', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(addDays('2026-11-01', -1), '2026-10-31');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('planLabel: the same window gets the same label; any changed knob is a different run', () => {
  const a = planRefresh({ today: '2026-09-20' });
  const b = planRefresh({ today: '2026-09-20' });
  assert.equal(planLabel(a), planLabel(b));
  assert.notEqual(planLabel(a), planLabel(planRefresh({ today: '2026-09-21' })), 'the nightly gets a new label every day');
  assert.notEqual(planLabel(a), planLabel(planRefresh({ today: '2026-09-20', lean: false })));
  assert.notEqual(planLabel(a), planLabel(planRefresh({ today: '2026-09-20', remine: false })));
  assert.equal(progressPath('Davis'), `${PROGRESS_COLLECTION}/davis`);
  assert.equal(freshProgress(a, '2026-09-20T06:45:00Z').nuvizz_calls, 0);
});

// ── 4. THE COPY — fakes for both sides ───────────────────────────────────────

/** Two in-memory databases. `prod` is read-only by construction of the deps we hand out. */
function fakes(prodSeed = {}) {
  const prod = new Map(Object.entries(prodSeed));
  const mirror = new Map();
  const writes = [];   // [path] in the order they landed
  const listOf = (db) => async (collectionPath) => {
    const prefix = `${collectionPath}/`;
    const out = [];
    for (const [k, v] of db) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (rest.includes('/')) continue;      // a sub-collection doc, not a direct child
      out.push({ _id: rest, ...v });
    }
    return out;
  };
  const getOf = (db) => async (docPath) => (db.has(docPath) ? { ...db.get(docPath) } : null);
  const deps = {
    listProd: listOf(prod),
    getProd: getOf(prod),
    listMirror: listOf(mirror),
    getMirror: getOf(mirror),
    setDoc: async (p, data) => { mirror.set(p, structuredClone(data)); writes.push(p); return true; },
    nowIso: () => '2026-09-20T06:45:00.000Z',
    log: () => {},
  };
  return { prod, mirror, writes, deps };
}

const T = 'davis';
const stop = (nbr, over = {}) => ({ stopNbr: nbr, businessName: `B${nbr}`, lat: 33.9, lng: -84.2, executed: { arrive: '2026-09-19T14:00:00' }, raw: { huge: 'x'.repeat(200) }, ...over });

function seedSealedDay(prodSeed, date, nbrs) {
  const base = dayPath(T, date);
  prodSeed[base] = { tenant: T, date, sealed_at: `${date}T06:00:00Z`, stop_count: nbrs.length };
  for (const n of nbrs) prodSeed[`${base}/stops/${n}`] = stop(n);
  prodSeed[`${base}/routes/TRAILER 6`] = { name: 'TRAILER 6', driver: 'Steven', stops: nbrs.length };
  prodSeed[`${base}/drivers/Steven`] = { name: 'Steven', stops: nbrs.length };
  prodSeed[`${ROSTER_COLLECTION}/${T}__${date}`] = { tenant: T, date, loads: [{ loadNbr: 'DAVIS000203261', name: 'TRAILER 6', driver: 'Steven', trips: 1 }] };
  prodSeed[`${LEDGER_COLLECTION}/${T}__${date}`] = { tenant: T, date, rows: { [nbrs[0]]: 'on_time' } };
  return prodSeed;
}

function seedBoardDay(prodSeed, date, nbrs) {
  const base = `${BOARD_COLLECTION}/${T}__${date}`;
  prodSeed[base] = { tenant: T, boardDate: date, count: nbrs.length, last_scan_at: `${date}T09:00:00Z` };
  for (const n of nbrs) prodSeed[`${base}/stops/${n}`] = stop(n, { boardDate: date, isPlanned: true });
  prodSeed[`${ROSTER_COLLECTION}/${T}__${date}`] = { tenant: T, date, loads: [] };
  return prodSeed;
}

test('stripId drops the read-side id and leanStop drops the vendor payload — nothing else', () => {
  assert.deepEqual(stripId({ _id: 'a', x: 1, raw: { y: 2 } }), { x: 1, raw: { y: 2 } });
  assert.deepEqual(leanStop({ _id: 'a', x: 1, raw: { y: 2 } }), { _id: 'a', x: 1 });
  assert.deepEqual(stripId(null), {}); assert.deepEqual(leanStop(undefined), {});
});

test('prodHistoryDates: only this tenant, only the window, ascending — a tombstoned day is still a day', async () => {
  const seed = {};
  for (const d of ['2026-09-10', '2026-09-12', '2026-09-11']) seedSealedDay(seed, d, ['1']);
  seed[dayPath(T, '2026-09-13')] = { tenant: T, date: '2026-09-13', no_board: true };
  seed[dayPath('other', '2026-09-11')] = { tenant: 'other', date: '2026-09-11' };
  seed[dayPath(T, '2026-08-01')] = { tenant: T, date: '2026-08-01' };
  const { deps } = fakes(seed);
  assert.deepEqual(await prodHistoryDates(deps, T, '2026-09-10', '2026-09-13'), ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13']);
  assert.deepEqual(await prodHistoryDates(deps, T, '2026-09-11', '2026-09-11'), ['2026-09-11']);
});

test('copyHistoryDay LEAN: stops land without _id and without raw, and THE MANIFEST IS WRITTEN LAST with the mirror stamps', async () => {
  const seed = seedSealedDay({}, '2026-09-19', ['A1', 'A2', 'A3']);
  const { deps, mirror, writes } = fakes(seed);
  const res = await copyHistoryDay(deps, T, '2026-09-19', { lean: true });
  assert.equal(res.manifest, true);
  assert.deepEqual([res.stops, res.routes, res.drivers], [3, 1, 1]);
  const base = dayPath(T, '2026-09-19');
  for (const n of ['A1', 'A2', 'A3']) {
    const w = mirror.get(`${base}/stops/${n}`);
    assert.ok(w, `${n} copied`);
    assert.equal('_id' in w, false, 'the read-side id is not a field');
    assert.equal('raw' in w, false, 'lean strips the vendor payload');
    assert.equal(w.stopNbr, n);
    assert.deepEqual(w.executed, { arrive: '2026-09-19T14:00:00' }, 'the lifted stamps the miners read survive');
  }
  assert.equal(writes[writes.length - 1], base, 'a half-copied day must never read as sealed on this side');
  const m = mirror.get(base);
  assert.equal(m.sealed_at, '2026-09-19T06:00:00Z', 'production\'s manifest fields are kept');
  assert.equal(m.mirrored_from, '(default)');
  assert.equal(m.mirrored_at, '2026-09-20T06:45:00.000Z');
  assert.equal(m.mirrored_lean, true);
  assert.equal(res.stopRecords.length, 3);
  assert.equal('raw' in res.stopRecords[0], false, 'the miners get exactly what was written');
  assert.ok(mirror.get(`${base}/routes/TRAILER 6`)); assert.ok(mirror.get(`${base}/drivers/Steven`));
});

test('copyHistoryDay ?lean=0 keeps raw; a day production has not sealed writes NOTHING', async () => {
  const seed = seedSealedDay({}, '2026-09-19', ['A1']);
  const { deps, mirror, writes } = fakes(seed);
  const res = await copyHistoryDay(deps, T, '2026-09-19', { lean: false });
  assert.equal(res.stops, 1);
  assert.ok(mirror.get(`${dayPath(T, '2026-09-19')}/stops/A1`).raw, 'raw kept');
  assert.equal(mirror.get(dayPath(T, '2026-09-19')).mirrored_lean, false);
  const before = writes.length;
  const none = await copyHistoryDay(deps, T, '2026-09-18');
  assert.deepEqual(none, { date: '2026-09-18', manifest: false, stops: 0, routes: 0, drivers: 0, stopRecords: [] });
  assert.equal(writes.length, before, 'no manifest in production → no write on the mirror');
});

test('copyBoardDay keeps raw (the Map popups read it) and stamps the parent; an absent day writes nothing', async () => {
  const seed = seedBoardDay({}, '2026-09-20', ['B1', 'B2']);
  const { deps, mirror, writes } = fakes(seed);
  const res = await copyBoardDay(deps, T, '2026-09-20');
  assert.deepEqual(res, { date: '2026-09-20', parent: true, stops: 2 });
  const base = `${BOARD_COLLECTION}/${T}__2026-09-20`;
  const w = mirror.get(`${base}/stops/B1`);
  assert.ok(w.raw, 'raw survives on the board');
  assert.equal('_id' in w, false);
  assert.equal(w.isPlanned, true, 'production\'s plan is copied as-is — this is the board, not a bench seed');
  assert.equal(mirror.get(base).mirrored_from, '(default)');
  assert.equal(mirror.get(base).count, 2);
  const before = writes.length;
  assert.deepEqual(await copyBoardDay(deps, T, '2026-09-27'), { date: '2026-09-27', parent: false, stops: 0 });
  assert.equal(writes.length, before);
});

test('copyRosterDay / copyLedgerDay copy the one document id-for-id, and say when there is none', async () => {
  const seed = seedSealedDay({}, '2026-09-19', ['A1']);
  const { deps, mirror } = fakes(seed);
  assert.equal(await copyRosterDay(deps, T, '2026-09-19'), true);
  assert.equal(mirror.get(`${ROSTER_COLLECTION}/${T}__2026-09-19`).loads[0].driver, 'Steven', 'the driver NuVizz already had on the load crosses with it');
  assert.equal(await copyLedgerDay(deps, T, '2026-09-19'), true);
  assert.equal(mirror.get(`${LEDGER_COLLECTION}/${T}__2026-09-19`).rows.A1, 'on_time');
  assert.equal(await copyRosterDay(deps, T, '2026-09-18'), false);
  assert.equal(await copyLedgerDay(deps, T, '2026-09-18'), false);
});

test('copyStatic copies every document of every static collection id-for-id', async () => {
  const seed = { 'customer_notes/c1': { receivingHours: '8-2' }, 'customer_notes/c2': { closed: true }, 'employees/e1': { name: 'Steven' }, 'routing_engine_config/davis': { version: '2.13.0' } };
  const { deps, mirror } = fakes(seed);
  const counts = await copyStatic(deps, T);
  assert.equal(counts.customer_notes, 2); assert.equal(counts.employees, 1); assert.equal(counts.routing_engine_config, 1);
  assert.equal(counts.truck_profiles, 0);
  assert.deepEqual(Object.keys(counts).sort(), [...STATIC_COLLECTIONS].sort());
  assert.deepEqual(mirror.get('customer_notes/c1'), { receivingHours: '8-2' });
  assert.deepEqual(mirror.get('routing_engine_config/davis'), { version: '2.13.0' });
});

// ── 5. THE RUN ───────────────────────────────────────────────────────────────

test('runRefresh: STATIC → SEALED DAYS ASCENDING (each re-mined with what was copied) → BOARD; finished, nuvizz_calls 0', async () => {
  let seed = { 'employees/e1': { name: 'Steven' } };
  for (const d of ['2026-09-18', '2026-09-17', '2026-09-19']) seed = seedSealedDay(seed, d, [`${d}-1`, `${d}-2`]);
  seed = seedBoardDay(seed, '2026-09-20', ['T1']);
  seed = seedBoardDay(seed, '2026-09-21', ['U1', 'U2']);
  const { deps, mirror, writes } = fakes(seed);
  const remined = [];
  deps.remine = async (tenant, date, stops) => { remined.push({ tenant, date, stops }); return { ok: true, hooks: {} }; };
  const persisted = [];
  deps.persist = async (p) => { persisted.push(structuredClone(p)); };
  const plan = planRefresh({ today: '2026-09-20', from: '2026-09-17', to: '2026-09-19', horizonDays: 1 });
  const p = await runRefresh(deps, plan, null);

  assert.equal(p.finished, true); assert.equal(p.stopped_at, null); assert.equal(p.nuvizz_calls, 0);
  assert.deepEqual(p.history_dates_in_prod, ['2026-09-17', '2026-09-18', '2026-09-19']);
  assert.deepEqual(p.done.history, ['2026-09-17', '2026-09-18', '2026-09-19'], 'ascending, the way the nightly folds');
  assert.deepEqual(p.done.board, ['2026-09-20', '2026-09-21']);
  assert.equal(p.done.static, true);
  assert.equal(p.counts.static.employees, 1);
  assert.deepEqual(p.counts.history['2026-09-18'], { stops: 2, routes: 1, drivers: 1, roster: true, ledger: true, remined: true });
  assert.deepEqual(p.counts.board['2026-09-21'], { stops: 2, parent: true, roster: true });

  // order of the writes: static first, then the three days, then the board
  const firstStatic = writes.indexOf('employees/e1');
  const firstHist = writes.findIndex((w) => w.startsWith(`${HISTORY_COLLECTION}/`));
  const firstBoard = writes.findIndex((w) => w.startsWith(`${BOARD_COLLECTION}/`));
  assert.ok(firstStatic < firstHist && firstHist < firstBoard, `static(${firstStatic}) < history(${firstHist}) < board(${firstBoard})`);
  const d17 = writes.indexOf(dayPath(T, '2026-09-17')), d19 = writes.indexOf(dayPath(T, '2026-09-19'));
  assert.ok(d17 < d19, 'older day sealed on the mirror before the newer');

  // the miners ran once per day, over the lean records that were written
  assert.deepEqual(remined.map((r) => r.date), ['2026-09-17', '2026-09-18', '2026-09-19']);
  assert.equal(remined[0].tenant, T);
  assert.equal(remined[0].stops.length, 2);
  assert.equal('raw' in remined[0].stops[0], false);
  assert.equal(remined[0].stops[0].stopNbr, '2026-09-17-1');

  // progress was persisted after every unit — static, the date resolve, 3 days, 2 boards, the finish
  assert.ok(persisted.length >= 7, `persisted ${persisted.length} times`);
  assert.equal(persisted[persisted.length - 1].finished, true);
  assert.ok(mirror.get(dayPath(T, '2026-09-19')).mirrored_at);
});

test('runRefresh under a budget STOPS at the next pending date and a resume with the same label picks up there — never restarting a day', async () => {
  let seed = {};
  for (const d of ['2026-09-17', '2026-09-18', '2026-09-19']) seed = seedSealedDay(seed, d, [`${d}-1`]);
  seed = seedBoardDay(seed, '2026-09-20', ['T1']);
  const { deps, writes } = fakes(seed);
  const remined = [];
  deps.remine = async (_t, date) => { remined.push(date); return { ok: true, hooks: {} }; };
  // a clock that jumps 10 minutes on every read: the first day fits, the second is over budget
  let t = 0;
  deps.now = () => { t += 10 * 60 * 1000; return t; };
  const plan = planRefresh({ today: '2026-09-20', from: '2026-09-17', to: '2026-09-19', horizonDays: 0, static: false });
  const first = await runRefresh(deps, plan, null, { budgetMs: 15 * 60 * 1000 });
  assert.equal(first.finished, false);
  assert.equal(first.stopped_at, '2026-09-18', 'the date it did not start');
  assert.deepEqual(first.done.history, ['2026-09-17']);
  assert.deepEqual(first.done.board, []);
  assert.deepEqual(remined, ['2026-09-17']);
  const writesAfterFirst = writes.length;

  // resume: an unlimited clock, the stored progress as prior
  deps.now = () => 0;
  const second = await runRefresh(deps, plan, first, { budgetMs: TIME_BUDGET_MS });
  assert.equal(second.finished, true); assert.equal(second.stopped_at, null);
  assert.deepEqual(second.done.history, ['2026-09-17', '2026-09-18', '2026-09-19']);
  assert.deepEqual(second.done.board, ['2026-09-20']);
  assert.deepEqual(remined, ['2026-09-17', '2026-09-18', '2026-09-19'], 'the finished day was not re-mined');
  assert.equal(writes.slice(writesAfterFirst).includes(dayPath(T, '2026-09-17')), false, 'the finished day was not re-copied');
  assert.equal(second.started_at, first.started_at, 'same run');

  // a DIFFERENT window ignores the prior and starts fresh
  const other = planRefresh({ today: '2026-09-20', from: '2026-09-19', to: '2026-09-19', horizonDays: 0, static: false });
  const third = await runRefresh(deps, other, second, { budgetMs: TIME_BUDGET_MS });
  assert.deepEqual(third.done.history, ['2026-09-19']);
  assert.notEqual(third.label, second.label);
});

test('runRefresh with remine off, or a day with no stops, records remined:false and never calls the miners', async () => {
  let seed = seedSealedDay({}, '2026-09-19', ['A1']);
  seed[dayPath(T, '2026-09-18')] = { tenant: T, date: '2026-09-18', no_board: true };   // tombstone: a manifest, no stops
  const { deps } = fakes(seed);
  let calls = 0;
  deps.remine = async () => { calls++; return { ok: true, hooks: {} }; };
  const plan = planRefresh({ today: '2026-09-20', from: '2026-09-18', to: '2026-09-19', board: false, static: false });
  const p = await runRefresh(deps, plan, null);
  assert.equal(calls, 1, 'only the day that has stops');
  assert.equal(p.counts.history['2026-09-18'].remined, false);
  assert.equal(p.counts.history['2026-09-18'].stops, 0);
  assert.equal(p.counts.history['2026-09-19'].remined, true);
  const off = await runRefresh(deps, planRefresh({ today: '2026-09-20', from: '2026-09-19', to: '2026-09-19', board: false, static: false, remine: false }), null);
  assert.equal(calls, 1, 'remine=off: not called');
  assert.equal(off.counts.history['2026-09-19'].remined, false);
});

test('explainRefresh READS BOTH SIDES AND WRITES NOTHING — production counts beside the mirror\'s, per date', async () => {
  let seed = seedSealedDay({}, '2026-09-19', ['A1', 'A2']);
  seed = seedBoardDay(seed, '2026-09-20', ['T1', 'T2', 'T3']);
  seed['customer_notes/c1'] = { x: 1 };
  const { deps, mirror } = fakes(seed);
  // the mirror already holds a partial copy of the sealed day, and nothing of the board
  mirror.set(dayPath(T, '2026-09-19'), { tenant: T, date: '2026-09-19' });
  mirror.set(`${dayPath(T, '2026-09-19')}/stops/A1`, { stopNbr: 'A1' });
  deps.setDoc = async () => { throw new Error('explain never writes'); };
  const plan = planRefresh({ today: '2026-09-20', from: '2026-09-19', to: '2026-09-19', horizonDays: 0 });
  const res = await explainRefresh(deps, plan);
  assert.equal(res.writes, 0); assert.equal(res.nuvizz_calls, 0);
  assert.deepEqual(res.history, [{ date: '2026-09-19', prod: { manifest: true, stops: 2 }, mirror: { manifest: true, stops: 1 } }]);
  assert.deepEqual(res.board, [{ date: '2026-09-20', prod: { manifest: true, stops: 3 }, mirror: { manifest: false, stops: 0 } }]);
  assert.deepEqual(res.static.customer_notes, { prod: 1, mirror: 0 });
});
