// test/moved-order-driver.test.mjs — PRO 7175976: A DRIVER BELONGS TO THE LOAD, NOT THE ORDER.
//
// Chad, 2026-09-15: "i moved an order from colin 1 to gainesville load — gainesville load did not
// have anyone assigned to it but when i moved the order it assigned colin to the load."
//
// Nothing was assigned in NuVizz: assignDriver only ever fires for a driver STAGED on the card
// (nuvizz-write.mts, `hasDriverId(p.L?.driverId)`), and a move stages none. What moved was the
// BOARD ROW. The confirmed-plan stamp sets the row's new route and, with no driver to write, left
// the row's old one standing — so the moved order carried COLIN onto GAINESVILLE, and everything
// that reads a load's driver off its rows repeated it: the Loads grid takes the first row that has
// one, and board-flags' fillRouteDrivers spreads a route's single driver name onto every flag row,
// which is the name a miss-window email and a driver text print.
//
// The rule pinned here: a stamp with no driver CLEARS the row's driver when the order is
// demonstrably changing loads, and touches nothing when it is not (a re-sequence on a crewed load
// keeps its driver). Two namespaces are not a disagreement — a load NUMBER or a hex card key
// against a route NAME decides nothing, exactly as in unplanStampOvertaken. MOVE_CLEARS_DRIVER=off
// restores the previous write byte for byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SA = JSON.stringify({
  project_id: 'testproj',
  client_email: 'sa@testproj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});
process.env.NUVIZZ_BASE_URL = '';        // never uat → isFirestoreEnabled() true
delete process.env.FIRESTORE_DATABASE;   // '(default)'
delete process.env.MOVE_CLEARS_DRIVER;   // default ON

import { patchBoardPlan, boardWritePlannedFields } from '../netlify/functions/lib/firestore.mts';
import { routeMoved, moveClearsDriverEnabled } from '../netlify/functions/lib/route-identity.mts';
import { isHashLikeId, looksLikeLoadNbr } from '../netlify/functions/lib/nuvizz-list.mts';
import { routeMoved as routeMovedClient, plannedDriverName } from '../src/lib/route-identity.js';
import { fillRouteDrivers } from '../src/lib/board-flags.js';

const DAY = '2026-09-15';
const PRO = '7175976';                       // the order Chad moved
const FROM = 'COLIN 1';
const TO = 'GAINESVILLE';
const AT = '2026-09-15T14:22:11.000Z';
const stopPath = (nbr) => `nuvizz_stop_index/davis__${DAY}/stops/${nbr}`;

async function withEnv(over, fn) {
  const prev = Object.fromEntries(Object.keys(over).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const k of Object.keys(over)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

// ── In-memory Firestore behind a stubbed global fetch (same shape as the other board tests) ──
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
          store.set(path, next);
        } else {
          store.set(path, doc);
        }
        return new Response('{}', { status: 200 });
      }
    }
    throw new Error(`unexpected fetch in moved-order-driver test: ${method} ${url}`);
  };
  return { store, restore: () => { globalThis.fetch = realFetch; } };
}

// The board row for 7175976 as it sat on COLIN 1 before the move.
const rowOnColin = (over = {}) => ({
  stopNbr: PRO, businessName: 'ACME SUPPLY',
  status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false,
  loadNbr: FROM, routeName: FROM, routeSeq: 4,
  driverName: 'COLIN', driverUserName: 'COLIN',
  ...over,
});

// ── THE RULE ─────────────────────────────────────────────────────────────────

test('an order moved to a load with NO driver does not carry the old load\'s driver (7175976: COLIN 1 → GAINESVILLE)', () => {
  const after = { ...rowOnColin(), ...boardWritePlannedFields(TO, 1, null, AT, FROM) };
  assert.equal(after.routeName, TO);
  assert.equal(after.driverName, null);
  assert.equal(after.driverUserName, null);
});

test('a re-sequence on the SAME load leaves a crewed load\'s driver exactly where it was', () => {
  const after = { ...rowOnColin(), ...boardWritePlannedFields(FROM, 2, null, AT, FROM) };
  assert.equal(after.routeSeq, 2);
  assert.equal(after.driverName, 'COLIN');
  assert.equal(after.driverUserName, 'COLIN');
});

test('a stamp that DOES carry a driver still writes that driver, moved or not', () => {
  const moved = { ...rowOnColin(), ...boardWritePlannedFields(TO, 1, 'TONY', AT, FROM) };
  assert.equal(moved.driverName, 'TONY');
  assert.equal(moved.driverUserName, 'TONY');
  const resequenced = { ...rowOnColin(), ...boardWritePlannedFields(FROM, 3, 'TONY', AT, FROM) };
  assert.equal(resequenced.driverName, 'TONY');
});

test('no priorRoute passed → the stamp is byte-identical to the pre-fix one (the switch\'s own path)', () => {
  assert.deepEqual(
    boardWritePlannedFields(TO, 1, null, AT),
    {
      status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false,
      loadNbr: TO, routeName: TO, routeSeq: 1,
      board_write_at: AT, board_write_planned: true,
    },
  );
});

test('TWO NAMESPACES ARE NOT A DISAGREEMENT — a load number or a hex card key never clears a driver', () => {
  // The real fallback values both write-through callers can produce (v1.12.0's own list).
  for (const prior of ['DAVIS000203388', '007141059', '6a3560cb52ef82bd1ed4516b', '', null]) {
    const after = { ...rowOnColin({ routeName: prior, loadNbr: prior }), ...boardWritePlannedFields(TO, 1, null, AT, prior) };
    assert.equal(after.driverName, 'COLIN', `prior=${String(prior)} must decide nothing`);
  }
  for (const next of ['DAVIS000203388', '007141059', '6a3560cb52ef82bd1ed4516b']) {
    const after = { ...rowOnColin(), ...boardWritePlannedFields(next, 1, null, AT, FROM) };
    assert.equal(after.driverName, 'COLIN', `next=${next} must decide nothing`);
  }
  // …and the shape predicates the rule leans on are the ones the rest of the engine uses.
  assert.equal(looksLikeLoadNbr('DAVIS000203388'), true);
  assert.equal(isHashLikeId('6a3560cb52ef82bd1ed4516b'), true);
  assert.equal(looksLikeLoadNbr(FROM), false);
  assert.equal(isHashLikeId(TO), false);
});

test('routeMoved: same route (any casing / padding) is not a move; a different name is', () => {
  assert.equal(routeMoved(FROM, TO), true);
  assert.equal(routeMoved(FROM, FROM), false);
  assert.equal(routeMoved('colin 1', ' COLIN 1 '), false);
  assert.equal(routeMoved(null, TO), false);
  assert.equal(routeMoved(FROM, ''), false);
});

// ── THE STORED ROW ───────────────────────────────────────────────────────────

test('patchBoardPlan: the moved row is stored on GAINESVILLE with no driver — and GAINESVILLE\'s own crewed rows keep theirs', async () => {
  const fake = installFirestoreFake({
    [stopPath(PRO)]: rowOnColin(),
    [stopPath('7100001')]: { stopNbr: '7100001', isPlanned: true, loadNbr: TO, routeName: TO, routeSeq: 1, driverName: 'TONY', driverUserName: 'TONY' },
  });
  try {
    const r = await patchBoardPlan('DAVIS', DAY, { routeName: TO, orderedStopNbrs: ['7100001', PRO], driverName: null, at: AT });
    assert.equal(r.patched, 2);
    const moved = fake.store.get(stopPath(PRO));
    assert.equal(moved.routeName, TO);
    assert.equal(moved.routeSeq, 2);
    assert.equal(moved.driverName, null);
    assert.equal(moved.driverUserName, null);
    const alreadyThere = fake.store.get(stopPath('7100001'));
    assert.equal(alreadyThere.driverName, 'TONY');   // not a move → untouched
  } finally { fake.restore(); }
});

test('MOVE_CLEARS_DRIVER=off puts it back: the moved row keeps COLIN exactly as before', async () => {
  const fake = installFirestoreFake({ [stopPath(PRO)]: rowOnColin() });
  try {
    await withEnv({ MOVE_CLEARS_DRIVER: 'off' }, () =>
      patchBoardPlan('DAVIS', DAY, { routeName: TO, orderedStopNbrs: [PRO], driverName: null, at: AT }));
    const moved = fake.store.get(stopPath(PRO));
    assert.equal(moved.routeName, TO);
    assert.equal(moved.driverName, 'COLIN');
  } finally { fake.restore(); }
});

test('the switch defaults ON and anything malformed leaves it ON', () => {
  assert.equal(moveClearsDriverEnabled({}), true);
  assert.equal(moveClearsDriverEnabled({ MOVE_CLEARS_DRIVER: 'banana' }), true);
  assert.equal(moveClearsDriverEnabled({ MOVE_CLEARS_DRIVER: '' }), true);
  for (const off of ['off', 'OFF', '0', 'false', 'no']) {
    assert.equal(moveClearsDriverEnabled({ MOVE_CLEARS_DRIVER: off }), false, off);
  }
});

// ── WHY IT MATTERS: what the wrong row said about the whole load ─────────────

test('one stale row used to name COLIN as GAINESVILLE\'s driver on every flag row — cleared, it names nobody', () => {
  const gainesvilleRow = () => ({ stopNbr: '7100002', routeName: TO, driverName: '' });
  const stale = [{ ...rowOnColin(), loadNbr: TO, routeName: TO }, { stopNbr: '7100002', routeName: TO, loadNbr: TO }];
  assert.equal(fillRouteDrivers([gainesvilleRow()], stale)[0].driverName, 'COLIN');   // the reported bug

  const fixed = stale.map((s) => (s.stopNbr === PRO ? { ...s, driverName: null, driverUserName: null } : s));
  assert.equal(fillRouteDrivers([gainesvilleRow()], fixed)[0].driverName, '');        // no name invented
});

// ── THE CLIENT MIRROR ────────────────────────────────────────────────────────

test('the client mirror answers exactly what the server does (the two must never drift)', () => {
  const cases = [
    [FROM, TO], [FROM, FROM], ['colin 1', 'COLIN 1'], [null, TO], [FROM, ''],
    ['DAVIS000203388', TO], [FROM, 'DAVIS000203388'], ['6a3560cb52ef82bd1ed4516b', TO], [FROM, '007141059'],
  ];
  for (const [a, b] of cases) {
    assert.equal(routeMovedClient(a, b), routeMoved(a, b), `routeMoved(${String(a)}, ${String(b)})`);
  }
});

test('plannedDriverName: the confirmed driver wins, a move drops the stale one, a re-sequence keeps it', () => {
  assert.equal(plannedDriverName('TONY', 'COLIN', FROM, TO), 'TONY');   // assigned in the same Save
  assert.equal(plannedDriverName(null, 'COLIN', FROM, TO), null);       // moved → the old truck goes
  assert.equal(plannedDriverName(null, 'COLIN', FROM, FROM), 'COLIN');  // re-sequenced → untouched
  assert.equal(plannedDriverName(null, 'COLIN', null, TO), 'COLIN');    // no baseline → decides nothing
  assert.equal(plannedDriverName(null, undefined, FROM, TO), null);
});
