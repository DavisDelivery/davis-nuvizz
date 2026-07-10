// test/nuvizz-write-through.test.mjs — the SERVER-SIDE board write-through (audit follow-up T1).
//
// runCommitBoardRwb end-to-end with Firestore ENABLED: a fake service account (real throwaway
// RSA key, so the SA-JWT signing runs for real) and a stubbed global fetch that serves the
// oauth token exchange + an in-memory Firestore. The NuVizz side rides the same injected
// requester harness as nuvizz-rwb.test.mjs. Pins, each from a real incident:
//   • the board patch lands on the LOWERCASE tenant tree (davis__…, never DAVIS__ — the
//     v0.46.10 phantom-tree fix) anchored on the CLIENT's board date (payload.date, v0.46.11),
//     falling back to the ET day for old clients;
//   • ghost removals never stamp (curNbrs guard) and a stop planned by the batch is excluded
//     from every unplanned stamp (batchPlanned, audit C4);
//   • the stamped routeName is the server-read route NAME, never the client's hex id (C5);
//   • boardSync rides the result per load (patched/rescued/missing) — a sync miss is never
//     invisible; the carry-over rescue walks prior days and heals them in place;
//   • a save that did NOT verify green never touches the board (planOk gate).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// ── env BEFORE the engine import chain is exercised ───────────────────────────
// A real (throwaway) RSA key so firestore.mts's crypto.createSign path runs unmodified.
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SA = JSON.stringify({
  project_id: 'testproj',
  client_email: 'sa@testproj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});
process.env.NUVIZZ_BASE_URL = '';        // never uat → isFirestoreEnabled() true
delete process.env.FIRESTORE_DATABASE;   // '(default)'

import { runCommitBoardRwb } from '../netlify/functions/lib/nuvizz-write.mts';
import { etDayString, isFirestoreEnabled } from '../netlify/functions/lib/firestore.mts';

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };
const HEXID = '6a438e9d52ef82bd1ed4516b';
const CLIENT_HEX_NAME = '6b449e9d52ef82bd1ed4516c';   // a Loads-grid card's hex "name" (C5)

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

// ── NuVizz requester harness (trimmed copy of nuvizz-rwb.test.mjs's makeRequester) ──
function makeRequester({ loadStops, stopHolders = {}, applySave = true } = {}) {
  const calls = [];
  return {
    calls,
    requester: {
      async request(url, opts, meta) {
        const method = (opts.method || 'GET').toUpperCase();
        calls.push({ url, method, route: meta?.route, body: opts.body });
        const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
        const T = (txt, status = 200) => new Response(txt, { status });
        if (url.includes('/loginreg/') && method === 'GET') {
          return T('<html><head><meta name="_csrf" content="tok123"><meta name="_csrf_header" content="X-CSRF-TOKEN"></head></html>');
        }
        if (url.includes('checkCompanyLogin')) return J({ ok: true });
        if (url.includes('auth/userLogin')) return J({ data: { jwtToken: 'jwt-abc' } });
        if (url.includes('/authtoken/')) return J({ authToken: 'authtok-xyz' });
        if (url.includes('validateStopstoPerformAction')) return T('Success');
        if (url.includes('addStopsToRouteAfterValidation')) {
          try {
            const sids = opts.body && opts.body.get ? String(opts.body.get('stopIds') || '') : '';
            for (const sid of sids.split(',').filter(Boolean)) { const n = sid.startsWith('id-') ? sid.slice(3) : null; if (n && loadStops && !loadStops.value.includes(n)) loadStops.value.push(n); }
          } catch { /* unit tests without loadStops */ }
          return J({ responseCode: 200, message: 'SUCCESS', stops: [] });
        }
        if (url.includes('fetchUpdatedJson')) {
          return J([{ etaStopVOList: [{ timeZone: 'America/New_York' }], distance: 10, duration: 20, schStartTime: { dttm: 'Jul 2, 2026' } }]);
        }
        if (url.includes('resequenceRoute')) return J({ responseCode: 200, message: 'SUCCESS' });
        if (url.includes('saveComparedRouteData')) {
          if (applySave && loadStops) {
            try {
              const rj = opts.body && opts.body.get ? String(opts.body.get('routeJsonData') || '') : '';
              for (const entry of JSON.parse(rj)) {
                if (String(entry.routePlanId) === HEXID && Array.isArray(entry.tripDataJsonArray)) {
                  loadStops.value = [...new Set(entry.tripDataJsonArray.map((id) => String(id).replace(/^id-/, '')))];
                }
              }
            } catch { /* ignore */ }
          }
          return J({ responseCode: 200 });
        }
        if (url.includes('/load/info/')) {
          return J({ Load: {
            loadHeader: { loadId: HEXID, loadNbr: 'DAVIS000000123', routeName: 'TEST', rtOrigin: { address: { latitude: 34.04, longitude: -83.71 } } },
            versionId: 'v1', loadExecutionInfo: { loadStatus: 'PLANNED' },
            stops: (loadStops?.value ?? []).map((n, i) => ({ stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO', to: { seq: i + 2 }, weight: 100, totalPallets: 2, totalCartons: 1, volume: 3 } })),
          } });
        }
        if (url.includes('/stop/info/')) {
          const n = url.split('/stop/info/')[1].split('/')[0];
          return J({ Stop: { stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO' }, load: { loadNbr: stopHolders[n] || '' } } });
        }
        if (url.includes('/load/edit/')) return J({ status: 'SUCCESS' });
        if (url.includes('/load/insertstops/')) return J({ status: 'SUCCESS' });
        if (url.includes('/load/assignanddispatch/')) return J({ status: 'SUCCESS' });
        return J({});
      },
    },
  };
}

// ── In-memory Firestore behind a stubbed global fetch ─────────────────────────
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

// seed: { 'nuvizz_stop_index/davis__2026-07-15/stops/A': { stopNbr:'A', isPlanned:false }, … }
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
    throw new Error(`unexpected fetch in write-through test: ${method} ${url}`);
  };
  return { store, log, restore: () => { globalThis.fetch = realFetch; } };
}

const stopPath = (day, nbr) => `nuvizz_stop_index/davis__${day}/stops/${nbr}`;
const setsFor = (log, day, nbr) => log.sets.filter((s) => s.path === stopPath(day, nbr));

// ─────────────────────────────────────────────────────────────────────────────

test('write-through: stamps land on the LOWERCASE tenant tree under the CLIENT board date; ghosts never stamp; boardSync rides the result', async () => {
  assert.equal(isFirestoreEnabled(), true, 'harness sanity: Firestore must be ON for these pins');
  const DAY = '2026-07-15';
  const fs = installFirestoreFake({
    [stopPath(DAY, 'A')]: { stopNbr: 'A', isPlanned: false },
    [stopPath(DAY, 'B')]: { stopNbr: 'B', isPlanned: false },
  });
  try {
    await withRwb({}, async () => {
      const loadStops = { value: ['A', 'B'] };
      const { requester } = makeRequester({ loadStops });
      const r = await runCommitBoardRwb(requester, {
        date: DAY,   // the dispatcher's board day — NOT necessarily today (v0.46.11)
        loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, routeName: CLIENT_HEX_NAME, orderedStopNbrs: ['A', 'B'], removeStopNbrs: ['GHOST'] }],
      }, CREDS);
      assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));

      // Every board touch sits on davis__<client day> — the uppercase creds ('DAVIS') never leak.
      const paths = [...fs.log.gets, ...fs.log.sets.map((s) => s.path)];
      assert.ok(paths.length > 0, 'the server stamped the board');
      for (const p of paths) {
        assert.ok(p.startsWith(`nuvizz_stop_index/davis__${DAY}/stops/`), `anchored + lowercase: ${p}`);
        assert.ok(!p.includes('DAVIS__'), `no phantom tree: ${p}`);
      }

      // Planned stamps: server-read route NAME (never the client's hex), portal-true fields.
      const a = setsFor(fs.log, DAY, 'A').at(-1).doc;
      const b = setsFor(fs.log, DAY, 'B').at(-1).doc;
      assert.equal(a.routeName, 'TEST', 'server-read name wins');
      assert.ok(!String(a.routeName).match(/^[0-9a-f]{24}$/i), 'hex id never becomes a route name (C5)');
      assert.equal(a.status, '20');
      assert.equal(a.normalizedStatus, 'SCHEDULED');
      assert.equal(a.isPlanned, true);
      assert.equal(a.board_write_planned, true);
      assert.ok(a.board_write_at, 'grace stamp present');
      assert.equal(a.routeSeq, 1);
      assert.equal(b.routeSeq, 2);

      // The ghost: never held by the load (curNbrs) → filtered BEFORE the board — no stamp,
      // no read, no 62-day rescue hunt.
      assert.equal(setsFor(fs.log, DAY, 'GHOST').length, 0, 'ghost never stamped unplanned (v0.46.7/v0.46.9)');
      assert.ok(!fs.log.gets.some((p) => p.endsWith('/stops/GHOST')), 'ghost never even looked up');

      // boardSync journaled on the result load — a miss can never be invisible (v0.46.9).
      assert.deepEqual(r.loads[0].boardSync, { patched: 2, rescued: 0, missing: 0 });
      assert.equal(r.loads[0].requestedLoadNbr, 'DAVIS000000123', 'client identity echo (C8)');
    });
  } finally { fs.restore(); }
});

test('write-through: a stop planned by the batch is EXCLUDED from its own removal stamps (batchPlanned, C4)', async () => {
  const DAY = '2026-07-15';
  const fs = installFirestoreFake({
    [stopPath(DAY, 'A')]: { stopNbr: 'A', isPlanned: false },
    [stopPath(DAY, 'B')]: { stopNbr: 'B', isPlanned: false },
  });
  try {
    await withRwb({}, async () => {
      // B rides BOTH lists (a cross-card move folded into one card in the degenerate
      // single-load form): planned wins, order-independent — B must never stamp '10'.
      const loadStops = { value: ['A', 'B'] };
      const { requester } = makeRequester({ loadStops });
      const r = await runCommitBoardRwb(requester, {
        date: DAY,
        loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A', 'B'], removeStopNbrs: ['B'] }],
      }, CREDS);
      assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
      const bSets = setsFor(fs.log, DAY, 'B');
      assert.ok(bSets.length >= 1, 'B was stamped');
      for (const s of bSets) assert.equal(s.doc.status, '20', 'planned wins — no unplanned stamp for a batch-planned stop');
      assert.equal(bSets.at(-1).doc.isPlanned, true);
    });
  } finally { fs.restore(); }
});

test('write-through: a REAL removal stamps board-unplanned (curNbrs-held, not re-planned)', async () => {
  const DAY = '2026-07-15';
  const fs = installFirestoreFake({
    [stopPath(DAY, 'A')]: { stopNbr: 'A', isPlanned: true, routeName: 'TEST' },
    [stopPath(DAY, 'B')]: { stopNbr: 'B', isPlanned: true, routeName: 'TEST' },
  });
  try {
    await withRwb({}, async () => {
      const loadStops = { value: ['A', 'B'] };
      const { requester } = makeRequester({ loadStops });
      const r = await runCommitBoardRwb(requester, {
        date: DAY,
        loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A'], removeStopNbrs: ['B'] }],
      }, CREDS);
      assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
      const b = setsFor(fs.log, DAY, 'B').at(-1).doc;
      assert.equal(b.status, '10');
      assert.equal(b.isPlanned, false);
      assert.equal(b.board_write_planned, false, 'a confirmed removal stamps with grace protection too');
      assert.equal(b.loadNbr, null);
      assert.deepEqual(r.loads[0].boardSync, { patched: 2, rescued: 0, missing: 0 });
    });
  } finally { fs.restore(); }
});

test('write-through: a stop missing from the day walks the carry-over rescue — heals a prior-day row, else reports missingNbrs', async () => {
  const DAY = '2026-07-15';
  const RESCUE_DAY = '2026-06-20';   // 25 days back — inside the 62-day window (F8)
  const fs = installFirestoreFake({
    [stopPath(DAY, 'A')]: { stopNbr: 'A', isPlanned: false },
    // C lives on an OLD day's board (a window-grid pick) — no row on DAY at all.
    [stopPath(RESCUE_DAY, 'C')]: { stopNbr: 'C', isPlanned: false, address: '1 Main St' },
  });
  try {
    await withRwb({}, async () => {
      const loadStops = { value: ['A'] };
      const { requester } = makeRequester({ loadStops });
      const r = await runCommitBoardRwb(requester, {
        date: DAY,
        loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A', 'C', 'D'] }],
      }, CREDS);
      assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
      // C: rescued — the prior-day copy is patched IN PLACE and a copy lands on DAY.
      const cPrior = fs.log.sets.filter((s) => s.path === stopPath(RESCUE_DAY, 'C'));
      assert.equal(cPrior.at(-1).doc.status, '20', 'prior-day row healed in place (fold stops serving it stale)');
      const cToday = setsFor(fs.log, DAY, 'C').at(-1).doc;
      assert.equal(cToday.status, '20');
      assert.equal(cToday.boardDate, DAY, 'upserted onto the served board');
      assert.equal(cToday.carryover, true);
      // D: nowhere on any day — reported, never fabricated.
      assert.equal(setsFor(fs.log, DAY, 'D').length, 0, 'no phantom row is ever created');
      const sync = r.loads[0].boardSync;
      assert.equal(sync.patched, 1);
      assert.equal(sync.rescued, 1);
      assert.equal(sync.missing, 1);
      assert.deepEqual(sync.missingNbrs, ['D'], 'the miss is named, not just counted');
    });
  } finally { fs.restore(); }
});

test('write-through: an old client with NO payload.date anchors on the ET day (fallback)', async () => {
  const fs = installFirestoreFake({});
  try {
    await withRwb({}, async () => {
      const DAY = etDayString();   // computed at call time, same clock the engine uses
      fs.store.set(stopPath(DAY, 'A'), { stopNbr: 'A', isPlanned: false });
      const loadStops = { value: ['A'] };
      const { requester } = makeRequester({ loadStops });
      const r = await runCommitBoardRwb(requester, {
        loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A'] }],
      }, CREDS);
      assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
      assert.equal(setsFor(fs.log, DAY, 'A').at(-1).doc.status, '20');
      assert.deepEqual(r.loads[0].boardSync, { patched: 1, rescued: 0, missing: 0 });
    });
  } finally { fs.restore(); }
});

test('write-through: a save that did NOT verify green never touches the board (planOk gate)', async () => {
  const DAY = '2026-07-15';
  const fs = installFirestoreFake({
    [stopPath(DAY, 'A')]: { stopNbr: 'A', isPlanned: false },
    [stopPath(DAY, 'B')]: { stopNbr: 'B', isPlanned: false },
    [stopPath(DAY, 'C')]: { stopNbr: 'C', isPlanned: false },
  });
  try {
    await withRwb({}, async () => {
      // applySave:false = the Jul 9 DAWSONVILLE portal: SUCCESS answered, nothing applied →
      // the kept-order verify fails the load. The board must stay untouched.
      const loadStops = { value: ['A', 'B', 'C'] };
      const { requester } = makeRequester({ loadStops, applySave: false });
      const r = await runCommitBoardRwb(requester, {
        date: DAY,
        loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['C', 'A', 'B'] }],
      }, CREDS);
      assert.equal(r.ok, false, 'the kept-order failure stands');
      assert.equal(fs.log.sets.length, 0, 'no stamp of any kind from an unverified save');
      assert.equal(r.loads[0].boardSync, undefined, 'no boardSync claim either');
    });
  } finally { fs.restore(); }
});
