// test/board-write-finished-guard.test.mjs — THE 007174583 INCIDENT, REPLAYED AND CLOSED.
//
// Chad, 2026-09-11 06:27 ET, order 007174583 (TAJ MA HOUND) grey on his board while NuVizz's own
// Stop screen read Completed: "why is this showing unplanned on my board when scan is showing it
// completed?" Read back from the board's own documents, zero NuVizz calls:
//
//   09:59:18.881Z  commitBoard REFUSED the add — NuVizz held the stop on a SECOND load also named
//                  AB (yesterday's instance, DAVIS000203402; the Save was to today's,
//                  DAVIS000203506). The stop had delivered on it at 04:37 ET. The refusal read the
//                  record — status and all — and threw that knowledge away.
//   09:59:32.983Z  the dispatcher struck it off the card; the un-plan write-through stamped the row
//                  status 10 / UNPLANNED, route null, driver null, board_write_planned false.
//   …and the scan's write grace then DEFENDED that stamp for sixty minutes over a completed pull
//   that said DELIVERED on AB.
//
// Three doors, one rule (lib/finished-guard.mts), each pinned here on the incident's own numbers:
//   DOOR 1  patchBoardPlan skips a FINISHED row for BOTH masks, and says so (skippedFinished);
//   DOOR 2  applyBoardWriteGrace never holds a stamp over a FRESH terminal list row;
//   DOOR 3  the RWB refusal records the terminal status it just read onto the board row —
//           field-masked, twin-pinned, never fabricating a row — so the strike-off fourteen
//           seconds later meets a row that already knows the freight is done.
// And the way back, on every door: BOARD_WRITE_FINISHED_GUARD=off restores the old behaviour.
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
delete process.env.BOARD_WRITE_FINISHED_GUARD;

import { patchBoardPlan, boardWriteUnplannedFields, isFirestoreEnabled } from '../netlify/functions/lib/firestore.mts';
import { applyBoardWriteGrace } from '../netlify/functions/lib/nuvizz-list.mts';
import { runCommitBoardRwb } from '../netlify/functions/lib/nuvizz-write.mts';

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };
const DAY = '2026-09-11';
const STOP = '007174583';
const TODAYS_AB = 'DAVIS000203506';        // the load the Save was to
const YESTERDAYS_AB = 'DAVIS000203402';    // the load NuVizz actually held the stop on — the same NAME
const HEXID = '6a438e9d52ef82bd1ed4516b';  // today's AB's routePlanId
const AT = '2026-09-11T09:59:32.983Z';     // the strike-off's stamp, to the millisecond
const stopPath = (day, nbr) => `nuvizz_stop_index/davis__${day}/stops/${nbr}`;

async function withEnv(over, fn) {
  const prev = Object.fromEntries(Object.keys(over).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const k of Object.keys(over)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}
const withRwb = (fn) => withEnv({
  NUVIZZ_RWB_ENABLED: 'true', NUVIZZ_RWB_USER: 'Chad', NUVIZZ_RWB_PASS: 'pw',
  NUVIZZ_RWB_LOGIN_BASE: 'https://loginqa.nuvizz.com', NUVIZZ_RWB_PORTAL_BASE: 'https://uat.nuvizz.com',
  NUVIZZ_RWB_SETTLE_MS: '15',
}, fn);

// ── In-memory Firestore behind a stubbed global fetch ─────────────────────────
// GET, the blind PATCH setDoc makes (replace), and the MASKED PATCH updateDocFields makes — which
// Firestore applies to the named paths only. The fake honours the mask so a test can prove the
// refusal path never blind-writes a document the scan owns.
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
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  const log = { gets: [], sets: [], masked: [] };
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
        const keys = [...url.matchAll(/updateMask\.fieldPaths=([^&]+)/g)].map((x) => decodeURIComponent(x[1]));
        if (keys.length) {
          const next = { ...(store.get(path) || {}) };
          for (const k of keys) next[k] = doc[k];
          log.masked.push({ path, keys, doc });
          store.set(path, next);
        } else {
          log.sets.push({ path, doc });
          store.set(path, doc);
        }
        return new Response('{}', { status: 200 });
      }
    }
    throw new Error(`unexpected fetch in finished-guard test: ${method} ${url}`);
  };
  return { store, log, restore: () => { globalThis.fetch = realFetch; } };
}

// ── NuVizz requester: the RWB portal plus v7 load/info + stop/info ────────────
//   stopHolders[n]     the load NuVizz says holds n (assignedLoadNbr)
//   stopRouteNames[n]  that load's NAME (so the refusal reads "AB (DAVIS000203402)")
//   stopStatuses[n]    the record's stopExecutionInfo.stopStatus — NuVizz's numeric code
//   addLands=false     the add answers SUCCESS and the stop never appears: the refusal scenario
//   firstStopInfoUnplanned  the FIRST stop/info read answers un-planned with a fresh id, later
//                      reads answer normally — reaches the post-add "still holds it on" path
function makeRequester({ loadStops, stopHolders = {}, stopRouteNames = {}, stopStatuses = {}, addLands = true, firstStopInfoUnplanned = false } = {}) {
  const calls = [];
  const stopInfoReads = new Map();
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
          if (addLands) {
            try {
              const sids = opts.body && opts.body.get ? String(opts.body.get('stopIds') || '') : '';
              for (const sid of sids.split(',').filter(Boolean)) { const n = sid.startsWith('id-') ? sid.slice(3) : null; if (n && loadStops && !loadStops.value.includes(n)) loadStops.value.push(n); }
            } catch { /* ignore */ }
          }
          return J({ responseCode: 200, message: 'SUCCESS', stops: [] });
        }
        if (url.includes('fetchUpdatedJson')) {
          return J([{ etaStopVOList: [{ timeZone: 'America/New_York' }], distance: 10, duration: 20, schStartTime: { dttm: 'Sep 11, 2026' } }]);
        }
        if (url.includes('resequenceRoute')) return J({ responseCode: 200, message: 'SUCCESS' });
        if (url.includes('saveComparedRouteData')) return J({ responseCode: 200 });
        if (url.includes('/load/info/')) {
          return J({ Load: {
            loadHeader: { loadId: HEXID, loadNbr: TODAYS_AB, routeName: 'AB', rtOrigin: { address: { latitude: 34.04, longitude: -83.71 } } },
            versionId: 'v1', loadExecutionInfo: { loadStatus: 'PLANNED' },
            stops: (loadStops?.value ?? []).map((n, i) => ({ stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO', to: { seq: i + 2 }, weight: 100, totalPallets: 2, totalCartons: 1, volume: 3 } })),
          } });
        }
        if (url.includes('/stop/info/')) {
          const n = url.split('/stop/info/')[1].split('/')[0];
          const reads = (stopInfoReads.get(n) || 0) + 1;
          stopInfoReads.set(n, reads);
          if (firstStopInfoUnplanned && reads === 1) {
            return J({ Stop: { stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO' }, load: { loadNbr: '' } } });
          }
          const holder = stopHolders[n] || '';
          return J({ Stop: {
            stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO' },
            ...(stopStatuses[n] != null ? { stopExecutionInfo: { stopStatus: String(stopStatuses[n]) } } : {}),
            load: holder ? { loadNbr: holder, routeName: stopRouteNames[n] || '' } : { loadNbr: '' },
          } });
        }
        if (url.includes('/load/edit/')) return J({ status: 'SUCCESS' });
        if (url.includes('/load/insertstops/')) return J({ status: 'SUCCESS' });
        if (url.includes('/load/assignanddispatch/')) return J({ status: 'SUCCESS' });
        return J({});
      },
    },
  };
}

// ── The board rows, as they stood ─────────────────────────────────────────────
const openRow = (nbr, over = {}) => ({
  stopNbr: nbr, stopId: `id-${nbr}`, businessName: `CUSTOMER ${nbr}`,
  status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false,
  loadNbr: 'AB', routeName: 'AB', routeSeq: 1, driverName: 'Anthony  Bennett', driverUserName: 'Anthony  Bennett',
  boardDate: DAY, scheduledDate: DAY, lat: 33.77, lng: -84.29, weight: 100, cartons: 1, deliveredDTTM: null,
  ...over,
});
/** 007174583 as the 05:59 Save found it on the board: still SCHEDULED on AB (the completed scan had not caught up). */
const tajMaHound = (over = {}) => openRow(STOP, { businessName: 'TAJ MA HOUND', addr1: '707 EAST LAKE DRIVE', city: 'DECATUR', zip: '30030', routeSeq: 7, weight: 151, ...over });
/** …and as the board holds it once a completed pull has seen the 04:37 delivery. */
const delivered = (over = {}) => tajMaHound({ status: '90', normalizedStatus: 'DELIVERED', deliveredDTTM: '2026-09-11T04:37:00', ...over });

test('sanity: Firestore is enabled for these tests', () => {
  assert.equal(isFirestoreEnabled(), true);
});

// ── DOOR 1: patchBoardPlan ────────────────────────────────────────────────────

test('DOOR 1 — the strike-off does NOT un-plan a row the board holds DELIVERED, and says so', async () => {
  const fs = installFirestoreFake({ [stopPath(DAY, STOP)]: delivered(), [stopPath(DAY, 'X')]: openRow('X') });
  try {
    const r = await patchBoardPlan('DAVIS', DAY, { routeName: 'AB', orderedStopNbrs: ['X'], unplannedStopNbrs: [STOP], driverName: null, at: AT });
    assert.equal(r.patched, 1, 'the open stop still stamps');
    assert.equal(r.missing, 0);
    assert.equal(r.rescued, 0);
    assert.equal(r.skippedFinished, 1);
    assert.deepEqual(r.skippedFinishedNbrs, [STOP]);
    const row = fs.store.get(stopPath(DAY, STOP));
    assert.equal(row.status, '90');
    assert.equal(row.normalizedStatus, 'DELIVERED');
    assert.equal(row.routeName, 'AB', 'the route it delivered on is kept');
    assert.equal(row.driverName, 'Anthony  Bennett', 'who delivered it is kept');
    assert.equal(row.deliveredDTTM, '2026-09-11T04:37:00');
    assert.equal(row.isUnplanned, false, 'it never re-enters the selection pool');
    assert.equal(row.board_write_at, undefined, 'no stamp — nothing for the write grace to defend');
    assert.equal(fs.log.sets.some((s) => s.path === stopPath(DAY, STOP)), false, 'the finished row was not written at all');
    const x = fs.store.get(stopPath(DAY, 'X'));
    assert.equal(x.board_write_planned, true);
    assert.equal(x.routeSeq, 1);
  } finally { fs.restore(); }
});

test('DOOR 1 — re-saving a load with delivered stops on it does NOT flip them back to SCHEDULED', async () => {
  const fs = installFirestoreFake({ [stopPath(DAY, STOP)]: delivered(), [stopPath(DAY, 'X')]: openRow('X') });
  try {
    const r = await patchBoardPlan('DAVIS', DAY, { routeName: 'AB', orderedStopNbrs: [STOP, 'X'], unplannedStopNbrs: [], driverName: 'Anthony  Bennett', at: AT });
    assert.equal(r.patched, 1);
    assert.equal(r.skippedFinished, 1);
    assert.deepEqual(r.skippedFinishedNbrs, [STOP]);
    const row = fs.store.get(stopPath(DAY, STOP));
    assert.equal(row.normalizedStatus, 'DELIVERED');
    assert.equal(row.status, '90');
    assert.equal(row.routeSeq, 7, 'a delivery keeps the position it was delivered at');
    assert.equal(fs.store.get(stopPath(DAY, 'X')).routeSeq, 2, 'the open stop takes its new position');
  } finally { fs.restore(); }
});

test('DOOR 1 — a prior-day DELIVERED copy is found, not rescued: history is never copied forward as open work', async () => {
  const fs = installFirestoreFake({ [stopPath('2026-09-10', STOP)]: delivered({ boardDate: '2026-09-10', scheduledDate: '2026-09-10' }) });
  try {
    const r = await patchBoardPlan('DAVIS', DAY, { routeName: 'AB', orderedStopNbrs: [], unplannedStopNbrs: [STOP], driverName: null, at: AT });
    assert.equal(r.missing, 0, 'it was found on the prior day');
    assert.equal(r.rescued, 0, 'and left there');
    assert.equal(r.skippedFinished, 1);
    assert.equal(fs.store.has(stopPath(DAY, STOP)), false, 'nothing was upserted onto today');
    assert.equal(fs.log.sets.length, 0, 'nothing was written anywhere');
    assert.equal(fs.store.get(stopPath('2026-09-10', STOP)).normalizedStatus, 'DELIVERED');
  } finally { fs.restore(); }
});

test('DOOR 1 — an OPEN row still un-plans exactly as before: the rule only touches finished freight', async () => {
  const fs = installFirestoreFake({ [stopPath(DAY, STOP)]: tajMaHound() });
  try {
    const r = await patchBoardPlan('DAVIS', DAY, { routeName: 'AB', orderedStopNbrs: [], unplannedStopNbrs: [STOP], driverName: null, at: AT });
    assert.equal(r.patched, 1);
    assert.equal(r.skippedFinished, 0);
    assert.deepEqual(r.skippedFinishedNbrs, []);
    const row = fs.store.get(stopPath(DAY, STOP));
    assert.equal(row.status, '10');
    assert.equal(row.normalizedStatus, 'UNPLANNED');
    assert.equal(row.isUnplanned, true);
    assert.equal(row.routeName, null);
    assert.equal(row.driverName, null);
    assert.equal(row.board_write_at, AT);
    assert.equal(row.board_write_planned, false);
    assert.equal(row.board_write_from, 'AB');
    assert.equal(row.businessName, 'TAJ MA HOUND', 'the rest of the row rides along, as it always did');
  } finally { fs.restore(); }
});

test('DOOR 1 — BOARD_WRITE_FINISHED_GUARD=off puts it back: the delivered row is overwritten, as it was', async () => {
  await withEnv({ BOARD_WRITE_FINISHED_GUARD: 'off' }, async () => {
    const fs = installFirestoreFake({ [stopPath(DAY, STOP)]: delivered() });
    try {
      const r = await patchBoardPlan('DAVIS', DAY, { routeName: 'AB', orderedStopNbrs: [], unplannedStopNbrs: [STOP], driverName: null, at: AT });
      assert.equal(r.patched, 1);
      assert.equal(r.skippedFinished, 0);
      const row = fs.store.get(stopPath(DAY, STOP));
      assert.equal(row.status, '10', 'the old behaviour, exactly');
      assert.equal(row.normalizedStatus, 'UNPLANNED');
      assert.equal(row.routeName, null);
      assert.equal(row.deliveredDTTM, '2026-09-11T04:37:00', 'the orphaned delivery stamp the old behaviour left behind');
    } finally { fs.restore(); }
  });
});

// ── DOOR 2: applyBoardWriteGrace ──────────────────────────────────────────────

const NOW = Date.parse('2026-09-11T10:20:00.000Z');   // 21 minutes after the strike-off — deep inside the grace
const freshFinished = (status, normalizedStatus) => ({
  stopNbr: STOP, status, normalizedStatus, isPlanned: true, isUnplanned: false,
  loadNbr: 'AB', routeName: 'AB', routeSeq: 7, driverName: 'Anthony  Bennett', driverUserName: 'Anthony  Bennett',
});
const priorStrikeOff = () => ({ stopNbr: STOP, businessName: 'TAJ MA HOUND', ...boardWriteUnplannedFields(AT, 'AB') });

test('DOOR 2 — a FRESH delivered list row is never held by an un-plan stamp inside the grace', () => {
  const fresh = freshFinished('90', 'DELIVERED');
  assert.equal(applyBoardWriteGrace(fresh, priorStrikeOff(), NOW), false, 'the list is authoritative');
  assert.equal(fresh.normalizedStatus, 'DELIVERED');
  assert.equal(fresh.routeName, 'AB');
  assert.equal(fresh.driverName, 'Anthony  Bennett');
  assert.equal(fresh.board_write_at, undefined, 'the stamp is NOT carried forward');
});

test('DOOR 2 — the same for unable-to-deliver and cancelled: finished is finished', () => {
  for (const [code, norm] of [['80', 'EXCEPTION'], ['99', 'EXCEPTION'], ['99', 'CANCELLED']]) {
    const fresh = freshFinished(code, norm);
    assert.equal(applyBoardWriteGrace(fresh, priorStrikeOff(), NOW), false, `${code}/${norm}`);
    assert.equal(fresh.normalizedStatus, norm);
  }
});

test('DOOR 2 — a fresh SCHEDULED row on the same route is still held: the lag rule is untouched', () => {
  const fresh = freshFinished('20', 'SCHEDULED');
  assert.equal(applyBoardWriteGrace(fresh, priorStrikeOff(), NOW), true, 'indistinguishable from an index that has not caught up with our un-plan');
  assert.equal(fresh.isPlanned, false);
  assert.equal(fresh.normalizedStatus, 'UNPLANNED');
  assert.equal(fresh.board_write_at, AT);
});

test('DOOR 2 — BOARD_WRITE_FINISHED_GUARD=off puts it back: the delivery is held under the stamp, as it was', async () => {
  await withEnv({ BOARD_WRITE_FINISHED_GUARD: 'off' }, () => {
    const fresh = freshFinished('90', 'DELIVERED');
    assert.equal(applyBoardWriteGrace(fresh, priorStrikeOff(), NOW), true);
    assert.equal(fresh.normalizedStatus, 'UNPLANNED', 'the old behaviour: a delivery reads un-planned for the grace');
  });
});

// ── DOOR 3: the refusal records what it read — THE INCIDENT, END TO END ─────────

const incidentSave = () => ({
  date: DAY,
  loads: [{ loadNbr: TODAYS_AB, loadId: HEXID, routeName: 'AB', orderedStopNbrs: ['X', STOP], stopIdsByNbr: { [STOP]: 'a'.repeat(24) } }],
});
const holderSaysDelivered = (over = {}) => makeRequester({
  loadStops: { value: ['X'] }, addLands: false,
  stopHolders: { [STOP]: YESTERDAYS_AB }, stopRouteNames: { [STOP]: 'AB' }, stopStatuses: { [STOP]: '90' },
  ...over,
});

test('DOOR 3 — THE INCIDENT: the add is refused, the holder is yesterday\'s AB, the record says 90 → the board row is recorded DELIVERED (masked) and the strike-off then leaves it alone', async () => {
  await withRwb(async () => {
    const fs = installFirestoreFake({ [stopPath(DAY, STOP)]: tajMaHound(), [stopPath(DAY, 'X')]: openRow('X') });
    try {
      const { requester, calls } = holderSaysDelivered();
      const r = await runCommitBoardRwb(requester, incidentSave(), CREDS);
      assert.equal(r.ok, false, 'the Save is still refused — nothing here pretends the add landed');
      const err = String(r.loads[0].error || '');
      assert.match(err, /holds it on AB \(DAVIS000203402\)/, 'the holder is still named, the same way');
      assert.match(err, /It is already DELIVERED there — the board now says so\./, 'and the dispatcher is told the freight is done');
      assert.deepEqual(r.loads[0].finishedRecorded, { stopNbr: STOP, status: '90', normalizedStatus: 'DELIVERED', patched: true }, 'the outcome rides the result into the write journal');
      assert.equal(calls.some((c) => c.url.includes('saveComparedRouteData')), false, 'no route was persisted missing the stop');
      // The board row: finished, through a FIELD-MASKED patch, everything else untouched.
      const row = fs.store.get(stopPath(DAY, STOP));
      assert.equal(row.status, '90');
      assert.equal(row.normalizedStatus, 'DELIVERED');
      assert.equal(row.isUnplanned, false);
      assert.equal(row.businessName, 'TAJ MA HOUND');
      assert.equal(row.routeName, 'AB');
      assert.equal(row.routeSeq, 7);
      assert.equal(row.driverName, 'Anthony  Bennett');
      assert.equal(row.lat, 33.77);
      assert.equal(row.deliveredDTTM, null, 'the delivery TIME is left to the list, where it is write-once');
      assert.equal(row.board_write_at, undefined, 'this is an observation, not a Save stamp — it engages no grace');
      assert.equal(fs.log.masked.length, 1, 'exactly one masked patch');
      assert.deepEqual(fs.log.masked[0].keys.slice().sort(), ['normalizedStatus', 'status'], 'and it names only the fields that changed');
      assert.equal(fs.log.sets.some((s) => s.path === stopPath(DAY, STOP)), false, 'never a blind replace of a document the scan owns');
      // Fourteen seconds later: the strike-off. The client's sync un-plans what the card removed.
      const strike = await patchBoardPlan('DAVIS', DAY, { routeName: 'AB', orderedStopNbrs: ['X'], unplannedStopNbrs: [STOP], driverName: null, at: AT });
      assert.equal(strike.skippedFinished, 1);
      assert.deepEqual(strike.skippedFinishedNbrs, [STOP]);
      assert.equal(strike.patched, 1);
      const after = fs.store.get(stopPath(DAY, STOP));
      assert.equal(after.normalizedStatus, 'DELIVERED', 'the grey pin never happens');
      assert.equal(after.routeName, 'AB');
      assert.equal(after.driverName, 'Anthony  Bennett');
      assert.equal(after.isUnplanned, false);
    } finally { fs.restore(); }
  });
});

test('DOOR 3 — a row the board already held UN-PLANNED (a carry-over) leaves the pool too: isUnplanned is cleared with the status', async () => {
  await withRwb(async () => {
    const fs = installFirestoreFake({
      [stopPath(DAY, STOP)]: tajMaHound({ status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, loadNbr: null, routeName: null, routeSeq: null, driverName: null, driverUserName: null }),
      [stopPath(DAY, 'X')]: openRow('X'),
    });
    try {
      const r = await runCommitBoardRwb(holderSaysDelivered().requester, incidentSave(), CREDS);
      assert.equal(r.loads[0].finishedRecorded?.patched, true);
      const row = fs.store.get(stopPath(DAY, STOP));
      assert.equal(row.normalizedStatus, 'DELIVERED');
      assert.equal(row.isUnplanned, false, 'out of the selection pool');
      assert.deepEqual(fs.log.masked[0].keys.slice().sort(), ['isUnplanned', 'normalizedStatus', 'status']);
    } finally { fs.restore(); }
  });
});

test('DOOR 3 — the post-add "still holds it on" path records it too: same rule, second door', async () => {
  await withRwb(async () => {
    // The first stop/info read answers un-planned with a fresh id (a stale supplied id), the
    // re-add lands nothing, and the holder is only named by the post-add read — rwbStopHolder.
    const fs = installFirestoreFake({ [stopPath(DAY, STOP)]: tajMaHound(), [stopPath(DAY, 'X')]: openRow('X') });
    try {
      const r = await runCommitBoardRwb(holderSaysDelivered({ firstStopInfoUnplanned: true }).requester, incidentSave(), CREDS);
      assert.equal(r.ok, false);
      const err = String(r.loads[0].error || '');
      assert.match(err, /still holds it on AB \(DAVIS000203402\)/);
      assert.match(err, /It is already DELIVERED there — the board now says so\./);
      assert.deepEqual(r.loads[0].finishedRecorded, { stopNbr: STOP, status: '90', normalizedStatus: 'DELIVERED', patched: true });
      assert.equal(fs.store.get(stopPath(DAY, STOP)).normalizedStatus, 'DELIVERED');
      assert.equal(fs.log.masked.length, 1);
    } finally { fs.restore(); }
  });
});

test('DOOR 3 — a holder whose record is NOT finished records nothing: the refusal reads exactly as before', async () => {
  await withRwb(async () => {
    const fs = installFirestoreFake({ [stopPath(DAY, STOP)]: tajMaHound(), [stopPath(DAY, 'X')]: openRow('X') });
    try {
      const r = await runCommitBoardRwb(holderSaysDelivered({ stopStatuses: { [STOP]: '20' } }).requester, incidentSave(), CREDS);
      assert.equal(r.ok, false);
      assert.match(String(r.loads[0].error || ''), /holds it on AB \(DAVIS000203402\)/);
      assert.doesNotMatch(String(r.loads[0].error || ''), /already/);
      assert.equal(r.loads[0].finishedRecorded, undefined);
      assert.equal(fs.log.masked.length, 0);
      assert.equal(fs.store.get(stopPath(DAY, STOP)).normalizedStatus, 'SCHEDULED');
    } finally { fs.restore(); }
  });
});

test('DOOR 3 — a record with NO status at all records nothing: fail closed, never invent a finish', async () => {
  await withRwb(async () => {
    const fs = installFirestoreFake({ [stopPath(DAY, STOP)]: tajMaHound(), [stopPath(DAY, 'X')]: openRow('X') });
    try {
      const r = await runCommitBoardRwb(holderSaysDelivered({ stopStatuses: {} }).requester, incidentSave(), CREDS);
      assert.equal(r.ok, false);
      assert.equal(r.loads[0].finishedRecorded, undefined);
      assert.equal(fs.log.masked.length, 0);
    } finally { fs.restore(); }
  });
});

test('DOOR 3 — TWO RECORDS, ONE NUMBER: a different stopId on the board row is refused, nothing is written, nothing is claimed', async () => {
  await withRwb(async () => {
    const fs = installFirestoreFake({ [stopPath(DAY, STOP)]: tajMaHound({ stopId: 'ffffffffffffffffffffffff' }), [stopPath(DAY, 'X')]: openRow('X') });
    try {
      const r = await runCommitBoardRwb(holderSaysDelivered().requester, incidentSave(), CREDS);
      assert.deepEqual(r.loads[0].finishedRecorded, { stopNbr: STOP, status: '90', normalizedStatus: 'DELIVERED', patched: false, reason: 'a different record shares this number' });
      assert.doesNotMatch(String(r.loads[0].error || ''), /the board now says so/, 'it must not claim what it did not do');
      assert.equal(fs.log.masked.length, 0);
      assert.equal(fs.store.get(stopPath(DAY, STOP)).normalizedStatus, 'SCHEDULED');
    } finally { fs.restore(); }
  });
});

test('DOOR 3 — a stop the day document does not hold is never fabricated', async () => {
  await withRwb(async () => {
    const fs = installFirestoreFake({ [stopPath(DAY, 'X')]: openRow('X') });
    try {
      const r = await runCommitBoardRwb(holderSaysDelivered().requester, incidentSave(), CREDS);
      assert.deepEqual(r.loads[0].finishedRecorded, { stopNbr: STOP, status: '90', normalizedStatus: 'DELIVERED', patched: false, reason: "not on this day's board" });
      assert.equal(fs.log.masked.length, 0);
      assert.equal(fs.store.has(stopPath(DAY, STOP)), false);
    } finally { fs.restore(); }
  });
});

test('DOOR 3 — a row already recorded finished is left alone: idempotent, no write, and it says so', async () => {
  await withRwb(async () => {
    const fs = installFirestoreFake({ [stopPath(DAY, STOP)]: delivered(), [stopPath(DAY, 'X')]: openRow('X') });
    try {
      const r = await runCommitBoardRwb(holderSaysDelivered().requester, incidentSave(), CREDS);
      assert.deepEqual(r.loads[0].finishedRecorded, { stopNbr: STOP, status: '90', normalizedStatus: 'DELIVERED', patched: false, reason: 'already recorded' });
      assert.equal(fs.log.masked.length, 0);
    } finally { fs.restore(); }
  });
});

test('DOOR 3 — BOARD_WRITE_FINISHED_GUARD=off: the refusal records nothing, as before', async () => {
  await withEnv({ BOARD_WRITE_FINISHED_GUARD: 'off' }, () => withRwb(async () => {
    const fs = installFirestoreFake({ [stopPath(DAY, STOP)]: tajMaHound(), [stopPath(DAY, 'X')]: openRow('X') });
    try {
      const r = await runCommitBoardRwb(holderSaysDelivered().requester, incidentSave(), CREDS);
      assert.equal(r.ok, false);
      assert.match(String(r.loads[0].error || ''), /holds it on/);
      assert.equal(r.loads[0].finishedRecorded, undefined);
      assert.equal(fs.log.masked.length, 0);
      assert.equal(fs.store.get(stopPath(DAY, STOP)).normalizedStatus, 'SCHEDULED');
    } finally { fs.restore(); }
  }));
});
