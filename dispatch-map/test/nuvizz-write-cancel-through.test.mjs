// test/nuvizz-write-cancel-through.test.mjs — board write-through for an EMPTIED (cancelled) load.
//
// The Jul 30 TRAILER 6 incident: emptying a load in Compare and saving LIVE cancels the route in
// NuVizz and returns its orders to Un-Planned — but the board never learned. An empty-load save
// rides the CLASSIC engine (both runCommitBoardRwb and runCommitBoardImport route it to
// runCommitBoard), and that path had no server-side board write-through at all: no unplanned
// stamps, no board_write_at, so the scan's demotion hold could re-stamp the dead plan forever
// ("0 unplanned in last scan" on a fresh scan). v0.54.17 made the last stop removable from a
// load, which is what opened this door.
//
// Pins:
//   • an empty-load save through the PRODUCTION entry (runCommitBoardRwb → classic fallback)
//     stamps EVERY stop the load actually held board-unplanned;
//   • the stamp uses boardWriteUnplannedFields: loadNbr/routeName/routeSeq all null — no board
//     rows are left grouped under a route that no longer exists;
//   • board_write_at rides the stamp, so applyBoardWriteGrace defends the cancel against a
//     lagging saved-search list for the full grace window;
//   • a cancel whose removeStops FAILED stamps nothing (and claims no boardSync);
//   • NuVizz reporting the cancel as a "Cancelled" error body (the §10 intentional-empty case)
//     still counts as a confirmed cancel and stamps;
//   • ghost-guard: a stop the dispatcher struck off that the load never HELD is never stamped,
//     never even looked up — the unplanned set comes from the load's OWN read, not the client's
//     removeStopNbrs;
//   • a stop the SAME Save re-planted onto another load stays planned (the Phase-2 `inserted`
//     exclusion) — only the genuinely freed stops stamp unplanned;
//   • regression: a normal (non-cancel) classic save touches the board ZERO times and its
//     result-load shape is byte-identical to before (no boardSync key, not even undefined).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// ── env BEFORE the engine import chain is exercised ───────────────────────────
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SA = JSON.stringify({
  project_id: 'testproj',
  client_email: 'sa@testproj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});
process.env.NUVIZZ_BASE_URL = '';        // never uat → isFirestoreEnabled() true
delete process.env.FIRESTORE_DATABASE;   // '(default)'

import { runCommitBoard, runCommitBoardRwb } from '../netlify/functions/lib/nuvizz-write.mts';
import { isFirestoreEnabled } from '../netlify/functions/lib/firestore.mts';
import { applyBoardWriteGrace } from '../netlify/functions/lib/nuvizz-list.mts';

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };
const HEX1 = '6a438e9d52ef82bd1ed4516b';
const HEX2 = '7b549f0e63f093ce2fe5627c';

async function withRwb(over, fn) {
  const keys = ['NUVIZZ_RWB_ENABLED', 'NUVIZZ_RWB_USER', 'NUVIZZ_RWB_PASS', 'NUVIZZ_RWB_LOGIN_BASE', 'NUVIZZ_RWB_PORTAL_BASE', 'NUVIZZ_RWB_SETTLE_MS'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    NUVIZZ_RWB_ENABLED: 'true', NUVIZZ_RWB_USER: 'Chad', NUVIZZ_RWB_PASS: 'pw',
    NUVIZZ_RWB_LOGIN_BASE: 'https://loginqa.nuvizz.com', NUVIZZ_RWB_PORTAL_BASE: 'https://uat.nuvizz.com',
    NUVIZZ_RWB_SETTLE_MS: '15',
    ...over,
  });
  try { return await fn(); }
  finally { for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

// ── NuVizz requester harness — multi-load /load/info plus a failable /load/edit ──
// loads: { [loadNbr]: { loadId, routeName, stops: ['nbr', …] } }
// execStatus: { [stopNbr]: 'ARRIVED' } — the per-stop execution status load/info carries on its
// RAW entries (what rawStopExecStatus reads); absent = no execution info at all.
function makeRequester({ loads = {}, stopHolders = {}, editResponse = null, execStatus = {} } = {}) {
  const calls = [];
  return {
    calls,
    requester: {
      async request(url, opts, meta) {
        const method = (opts.method || 'GET').toUpperCase();
        calls.push({ url, method, route: meta?.route, body: opts.body });
        const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
        if (url.includes('/load/info/')) {
          const nbr = url.split('/load/info/')[1].split('/')[0];
          const Ld = loads[nbr];
          if (!Ld) return J({}, 404);
          return J({ Load: {
            loadHeader: { loadId: Ld.loadId, loadNbr: nbr, routeName: Ld.routeName, rtOrigin: { address: { latitude: 34.04, longitude: -83.71 } } },
            versionId: 'v1', loadExecutionInfo: { loadStatus: 'PLANNED' },
            stops: Ld.stops.map((n, i) => ({
              stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO', to: { seq: i + 2 }, weight: 100, totalPallets: 2, totalCartons: 1, volume: 3 },
              ...(Object.prototype.hasOwnProperty.call(execStatus, n) ? { stopExecutionInfo: { stopStatus: execStatus[n] } } : {}),
            })),
          } });
        }
        if (url.includes('/stop/info/')) {
          const n = url.split('/stop/info/')[1].split('/')[0];
          return J({ Stop: { stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO' }, load: { loadNbr: stopHolders[n] || '' } } });
        }
        if (url.includes('/load/edit/')) return editResponse ? editResponse() : J({ status: 'SUCCESS' });
        if (url.includes('/load/insertstops/')) return J({ status: 'SUCCESS' });
        if (url.includes('/load/assignanddispatch/')) return J({ status: 'SUCCESS' });
        return J({});
      },
    },
  };
}

// ── In-memory Firestore behind a stubbed global fetch (nuvizz-write-through.test.mjs) ──
function encVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}
function decVal(v) {
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  return null;
}
const encDoc = (obj) => ({ fields: Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encVal(v)])) });
const decDoc = (fields) => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, decVal(v)]));

function installFirestoreFake(seed = {}) {
  const store = new Map(Object.entries(seed));
  const log = { gets: [], sets: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    const method = (init.method || (input && input.method) || 'GET').toUpperCase();
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (url.includes('firestore.googleapis.com')) {
      const m = url.match(/\/documents\/(.+?)(\?|$)/);
      const path = m ? decodeURIComponent(m[1]) : '';
      if (method === 'GET') {
        log.gets.push(path);
        const d = store.get(path);
        return d
          ? new Response(JSON.stringify({ name: `projects/testproj/databases/(default)/documents/${path}`, ...encDoc(d) }), { status: 200 })
          : new Response('{}', { status: 404 });
      }
      if (method === 'PATCH') {
        const doc = decDoc(JSON.parse(String(init.body)).fields);
        log.sets.push({ path, doc });
        store.set(path, doc);
        return new Response('{}', { status: 200 });
      }
    }
    throw new Error(`unexpected fetch in cancel write-through test: ${method} ${url}`);
  };
  return { store, log, restore: () => { globalThis.fetch = realFetch; } };
}

const stopPath = (day, nbr) => `nuvizz_stop_index/davis__${day}/stops/${nbr}`;
const setsFor = (log, day, nbr) => log.sets.filter((s) => s.path === stopPath(day, nbr));

const DAY = '2026-07-30';
// The six TRAILER 6 orders from the incident report.
const HELD = ['THG', 'HAEWA', 'ROSSINI', 'TELECONNECT', 'DMS', 'SIXTH'];
const seedPlanned = () => Object.fromEntries(HELD.map((n, i) => [
  stopPath(DAY, n),
  { stopNbr: n, status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'TRAILER 6', routeName: 'TRAILER 6', routeSeq: i + 1 },
]));
const T6 = { DAVIS000000123: { loadId: HEX1, routeName: 'TRAILER 6', stops: HELD } };
const emptyT6 = (extraRemoved = []) => ({
  loadNbr: 'DAVIS000000123', loadId: HEX1, routeName: 'TRAILER 6',
  emptyLoad: true, orderedStopNbrs: [], removeStopNbrs: [...HELD, ...extraRemoved],
});

// ─────────────────────────────────────────────────────────────────────────────

test('cancel write-through: an empty-load save through the PRODUCTION entry stamps EVERY held stop unplanned; ghosts never stamp; the grace defends it', async () => {
  assert.equal(isFirestoreEnabled(), true, 'harness sanity: Firestore must be ON for these pins');
  const fs = installFirestoreFake(seedPlanned());
  try {
    await withRwb({}, async () => {
      const { requester } = makeRequester({ loads: T6 });
      // The RWB engine routes an emptyLoad save to the classic fallback — this is the exact
      // production path of the Compare panel's Save (useRwb pinned true client-side).
      const r = await runCommitBoardRwb(requester, { date: DAY, loads: [emptyT6(['GHOST'])] }, CREDS);
      assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
      assert.equal(r.loads.length, 1);
      const step = r.loads[0].steps.find((s) => s.op === 'removeStops');
      assert.equal(step.cancelledRoute, true, 'the save really was a route cancel');

      // EVERY stop the load held is stamped board-unplanned, with no dead-route grouping left.
      for (const n of HELD) {
        const sets = setsFor(fs.log, DAY, n);
        assert.equal(sets.length, 1, `${n} stamped exactly once`);
        const d = sets[0].doc;
        assert.equal(d.status, '10', n);
        assert.equal(d.normalizedStatus, 'UNPLANNED', n);
        assert.equal(d.isPlanned, false, n);
        assert.equal(d.isUnplanned, true, n);
        assert.equal(d.loadNbr, null, `${n}: no grouping under the cancelled route`);
        assert.equal(d.routeName, null, n);
        assert.equal(d.routeSeq, null, n);
        assert.equal(d.driverName, null, n);
        assert.equal(d.board_write_planned, false, n);
        assert.ok(d.board_write_at, `${n}: grace stamp present`);
      }

      // The ghost the dispatcher struck off but the load never HELD: the unplanned set comes
      // from the load's OWN read (plan.removeStopIds), so GHOST is filtered at the source —
      // no stamp, no read, no 62-day rescue hunt.
      assert.equal(setsFor(fs.log, DAY, 'GHOST').length, 0, 'ghost never stamped');
      assert.ok(!fs.log.gets.some((p) => p.endsWith('/stops/GHOST')), 'ghost never even looked up');

      // boardSync rides the result load — the journal shows the board heard about the cancel.
      assert.deepEqual(r.loads[0].boardSync, { patched: 6, rescued: 0, missing: 0 });

      // The 60-min grace DEFENDS the cancel: a lagging saved-search list that still shows the
      // stop planned on the dead route may not revert the confirmed unplanned stamp.
      const prior = fs.store.get(stopPath(DAY, 'THG'));
      const staleListRow = { stopNbr: 'THG', status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'TRAILER 6', routeName: 'TRAILER 6', routeSeq: 1 };
      assert.equal(applyBoardWriteGrace(staleListRow, prior, Date.now()), true, 'grace holds the cancel over the stale list');
      assert.equal(staleListRow.isPlanned, false);
      assert.equal(staleListRow.loadNbr, null);
      assert.equal(staleListRow.board_write_planned, false);
    });
  } finally { fs.restore(); }
});

test('cancel write-through: the CLASSIC direct entry (RWB env-blocked) stamps the same way', async () => {
  const fs = installFirestoreFake(seedPlanned());
  try {
    const { requester } = makeRequester({ loads: T6 });
    const r = await runCommitBoard(requester, { date: DAY, loads: [emptyT6()] }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
    for (const n of HELD) {
      const d = setsFor(fs.log, DAY, n).at(-1).doc;
      assert.equal(d.status, '10', n);
      assert.equal(d.routeName, null, n);
      assert.ok(d.board_write_at, n);
    }
    assert.deepEqual(r.loads[0].boardSync, { patched: 6, rescued: 0, missing: 0 });
    assert.deepEqual(Object.keys(r.loads[0]), ['loadNbr', 'loadId', 'ok', 'error', 'steps', 'boardSync']);
  } finally { fs.restore(); }
});

test('cancel write-through: a cancel whose removeStops FAILED stamps NOTHING and claims no boardSync', async () => {
  const fs = installFirestoreFake(seedPlanned());
  try {
    const { requester } = makeRequester({
      loads: T6,
      editResponse: () => new Response(JSON.stringify({ error: 'SOMETHING WENT WRONG!!, PLEASE TRY AGAIN' }), { status: 500 }),
    });
    const r = await runCommitBoard(requester, { date: DAY, loads: [emptyT6()] }, CREDS);
    assert.equal(r.ok, false, 'the failed remove fails the load');
    assert.equal(fs.log.sets.length, 0, 'no stamp of any kind from a failed cancel');
    assert.ok(!('boardSync' in r.loads[0]), 'no boardSync claim either');
  } finally { fs.restore(); }
});

test('cancel write-through: NuVizz reporting the cancel AS a "Cancelled" error body (§10) still stamps', async () => {
  const fs = installFirestoreFake(seedPlanned());
  try {
    // The documented intentional-empty response: removing every delivery cancels the route and
    // NuVizz can answer with a non-OK "Cancelled" body — runCommitBoard treats that as success
    // for an intended empty, and the board must hear about it exactly like a clean 200.
    const { requester } = makeRequester({
      loads: T6,
      editResponse: () => new Response(JSON.stringify({ error: 'Route has been Cancelled' }), { status: 200 }),
    });
    const r = await runCommitBoard(requester, { date: DAY, loads: [emptyT6()] }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
    for (const n of HELD) assert.equal(setsFor(fs.log, DAY, n).at(-1).doc.status, '10', n);
    assert.deepEqual(r.loads[0].boardSync, { patched: 6, rescued: 0, missing: 0 });
  } finally { fs.restore(); }
});

test('cancel write-through: a stop the SAME Save re-planted onto another load stays planned (inserted exclusion)', async () => {
  const fs = installFirestoreFake({
    [stopPath(DAY, 'A')]: { stopNbr: 'A', isPlanned: true, loadNbr: 'TRAILER 6', routeName: 'TRAILER 6' },
    [stopPath(DAY, 'B')]: { stopNbr: 'B', isPlanned: true, loadNbr: 'TRAILER 6', routeName: 'TRAILER 6' },
    [stopPath(DAY, 'C')]: { stopNbr: 'C', isPlanned: true, loadNbr: 'SUW 2', routeName: 'SUW 2' },
  });
  try {
    // One Save: TRAILER 6 (A,B) is emptied while SUW 2 takes A. The cancel frees A and B; the
    // Phase-2 insert re-plants A on SUW 2 — so only B may stamp unplanned. A's board row is the
    // client belt's to update (the classic path never server-stamps plans); it must NOT be
    // flipped unplanned by the cancel it survived.
    const { requester } = makeRequester({
      loads: {
        DAVIS000000123: { loadId: HEX1, routeName: 'TRAILER 6', stops: ['A', 'B'] },
        DAVIS000000456: { loadId: HEX2, routeName: 'SUW 2', stops: ['C'] },
      },
      stopHolders: { A: 'DAVIS000000123' },
    });
    const r = await runCommitBoard(requester, {
      date: DAY,
      loads: [
        { loadNbr: 'DAVIS000000123', loadId: HEX1, emptyLoad: true, orderedStopNbrs: [], removeStopNbrs: ['A', 'B'] },
        { loadNbr: 'DAVIS000000456', loadId: HEX2, orderedStopNbrs: ['C', 'A'] },
      ],
    }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads.map((l) => l.error)));
    assert.equal(setsFor(fs.log, DAY, 'A').length, 0, 'the re-planted stop is never stamped unplanned');
    const b = setsFor(fs.log, DAY, 'B').at(-1).doc;
    assert.equal(b.status, '10');
    assert.equal(b.routeName, null);
    const cancelLoad = r.loads.find((l) => l.loadNbr === 'DAVIS000000123');
    assert.deepEqual(cancelLoad.boardSync, { patched: 1, rescued: 0, missing: 0 });
  } finally { fs.restore(); }
});

test('regression: a normal (non-cancel) classic save touches the board ZERO times and its result shape is unchanged', async () => {
  const fs = installFirestoreFake(seedPlanned());
  try {
    const { requester } = makeRequester({ loads: { DAVIS000000123: { loadId: HEX1, routeName: 'TRAILER 6', stops: ['THG', 'HAEWA'] } } });
    const r = await runCommitBoard(requester, {
      date: DAY,
      loads: [{ loadNbr: 'DAVIS000000123', loadId: HEX1, orderedStopNbrs: ['HAEWA', 'THG'] }],
    }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
    assert.equal(fs.log.sets.length, 0, 'classic reorders leave board stamping to the client belt, exactly as before');
    assert.equal(fs.log.gets.length, 0, 'not even a read');
    assert.deepEqual(Object.keys(r.loads[0]), ['loadNbr', 'loadId', 'ok', 'error', 'steps'], 'byte-identical result-load shape (no boardSync key at all)');
  } finally { fs.restore(); }
});

// ── HARDENING (adversarial review of the v0.54.18 write-through) ──────────────
// Two holes the write-through turned from cosmetic into dangerous, both found by review
// before they were ever hit in the field:
//   • the cancel-success test was /cancel/i over the error body, which cannot tell NuVizz
//     CONFIRMING a cancel from NuVizz REFUSING one ("cannot be cancelled — already
//     dispatched" matches). A refusal used to be a wrong message; with the write-through it
//     would stamp every order board-unplanned for the 60-minute grace while NuVizz still has
//     them planned on a LIVE route — a double-plan invitation.
//   • emptying only ever rides the classic path, which had no executed-stop guard (RWB has
//     refused since the Jul 22 AVRT case). NuVizz KEEPS an executed stop even when a Save
//     removes it, so such a load cannot truly be emptied — and stamping would resurrect
//     finished work as unplanned.

test('hardening: a REFUSAL that merely contains the word "cancel" fails the Save and stamps NOTHING', async () => {
  for (const refusal of [
    'Load cannot be cancelled — already dispatched',
    'Unable to cancel route: driver en route',
    'Cancel request denied',
    'Route could not be cancelled',
    'Cancellation failed',
    'Stop is not cancellable',
  ]) {
    const fs = installFirestoreFake(seedPlanned());
    try {
      const { requester } = makeRequester({
        loads: T6,
        editResponse: () => new Response(JSON.stringify({ error: refusal }), { status: 200 }),
      });
      const r = await runCommitBoard(requester, { date: DAY, loads: [emptyT6()] }, CREDS);
      assert.equal(r.ok, false, `refusal must fail the Save: ${refusal}`);
      assert.equal(fs.log.sets.length, 0, `refusal must stamp nothing: ${refusal}`);
      assert.ok(!('boardSync' in r.loads[0]), `refusal must claim no boardSync: ${refusal}`);
    } finally { fs.restore(); }
  }
});

test('hardening: a genuine cancellation NOTICE still confirms (the §10 non-OK body)', async () => {
  for (const notice of ['Route has been Cancelled', 'Load cancelled successfully', 'CANCELLED']) {
    const fs = installFirestoreFake(seedPlanned());
    try {
      const { requester } = makeRequester({
        loads: T6,
        editResponse: () => new Response(JSON.stringify({ error: notice }), { status: 200 }),
      });
      const r = await runCommitBoard(requester, { date: DAY, loads: [emptyT6()] }, CREDS);
      assert.equal(r.ok, true, `a real cancel notice must still succeed: ${notice}`);
      assert.deepEqual(r.loads[0].boardSync, { patched: 6, rescued: 0, missing: 0 }, notice);
    } finally { fs.restore(); }
  }
});

test('hardening: a load with an EXECUTED stop refuses to empty — no NuVizz write, no stamp', async () => {
  const fs = installFirestoreFake(seedPlanned());
  try {
    // ROSSINI is already ARRIVED: NuVizz would keep it, so the route would NOT actually cancel.
    const { requester, calls } = makeRequester({ loads: T6, execStatus: { ROSSINI: 'ARRIVED' } });
    const r = await runCommitBoard(requester, { date: DAY, loads: [emptyT6()] }, CREDS);
    assert.equal(r.ok, false, 'the Save refuses up front');
    assert.match(r.loads[0].error, /stop ROSSINI on DAVIS000000123 is already ARRIVED/);
    assert.match(r.loads[0].error, /cannot be emptied/);
    assert.ok(!calls.some((c) => c.url.includes('/load/edit/')), 'the destructive write never fired');
    assert.equal(fs.log.sets.length, 0, 'finished work is never stamped unplanned');
  } finally { fs.restore(); }
});

test('hardening: an unknown/absent execution status fails OPEN — an ordinary cancel still works', async () => {
  const fs = installFirestoreFake(seedPlanned());
  try {
    // Same guard, benign statuses: nothing here means "the driver already acted on it".
    const { requester } = makeRequester({ loads: T6, execStatus: { THG: 'PLANNED', HAEWA: '', DMS: null } });
    const r = await runCommitBoard(requester, { date: DAY, loads: [emptyT6()] }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
    assert.deepEqual(r.loads[0].boardSync, { patched: 6, rescued: 0, missing: 0 });
  } finally { fs.restore(); }
});
