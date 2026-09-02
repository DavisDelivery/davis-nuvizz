// test/split-role-gates.test.mjs — THE ROLE FOLLOWS THE ACT, NOT THE ENDPOINT.
//
// Three endpoints were gated at the role their READ deserves, while carrying a branch that does
// something a reader must never be able to do. Each is split here the way nuvizz-board-reconcile
// already splits its free preview from its metered run — one URL, two doors.
//
//   route-departures        ?refit=1 REFITS AND PUBLISHES the departure table that every ETA on
//                           the board is computed from. At viewer, the read-only role could
//                           shift every ETA — and therefore every red flag — on a 700-stop day,
//                           and the visible symptom would be flags that quietly stopped firing.
//   manifest-push-log       the POST APPENDS to the push audit trail: the record that answers
//                           "did that order actually get pushed?" when a customer says a
//                           delivery never arrived. A viewer who can append can write history.
//   nuvizz-pull-today-stops ?live=1 is a ~3,000-metered-call cold number probe of the NuVizz
//                           number space — the exact spend CLAUDE.md's hard rule forbids without
//                           Chad saying so per request. The read-only role must never be the one
//                           that can spend the vendor budget.
//
// BOTH DIRECTIONS ARE PINNED. A split that shuts the acting branch but also breaks the read is
// worse than no split: the read is the common case, and a gate that breaks the common case gets
// ripped out, taking the useful half with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SA = JSON.stringify({
  project_id: 'testproj',
  client_email: 'sa@testproj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});
process.env.NUVIZZ_BASE_URL = '';
delete process.env.FIRESTORE_DATABASE;
process.env.AUTH_SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';
delete process.env.AUTH_REQUIRED;

import { installFirestoreFake } from './_firestore-fake.mjs';
import { issueSessionToken } from '../netlify/functions/lib/auth-core.mts';
import { _resetUserCacheForTests, _resetThrottleForTests } from '../netlify/functions/lib/require-user.mts';
import routeDepartures from '../netlify/functions/route-departures.mts';
import pushLog from '../netlify/functions/manifest-push-log.mts';
import pullStops from '../netlify/functions/nuvizz-pull-today-stops.mts';

const VIEWER = { username: 'ro', displayName: 'Ro', role: 'viewer', active: true, tokenVersion: 0 };
const DISPATCHER = { username: 'tina', displayName: 'Tina', role: 'dispatcher', active: true, tokenVersion: 0 };
const ADMIN = { username: 'ada', displayName: 'Ada', role: 'admin', active: true, tokenVersion: 0 };
const USERS = { 'app_users/ro': VIEWER, 'app_users/tina': DISPATCHER, 'app_users/ada': ADMIN };

const bearer = (u) => ({ authorization: `Bearer ${issueSessionToken(u).token}` });
const fn = (path, init = {}) => new Request(`https://x.netlify.app/.netlify/functions/${path}`, init);

async function enforcing(seed, run) {
  process.env.AUTH_REQUIRED = 'true';
  _resetUserCacheForTests();
  _resetThrottleForTests();
  const fake = installFirestoreFake({ ...USERS, ...seed });
  try { return await run(fake); } finally { fake.restore(); delete process.env.AUTH_REQUIRED; }
}

// ── route-departures: the read is a viewer's, the refit is not ───────────────

test('route-departures: a viewer READS the table and is refused the REFIT that republishes it', async () => {
  await enforcing({}, async () => {
    const read = await routeDepartures(fn('route-departures?days=21', { headers: bearer(VIEWER) }));
    assert.equal(read.status, 200, 'the fleet\'s departure behaviour is the same class of thing as the board');

    const refit = await routeDepartures(fn('route-departures?refit=1&days=1', { headers: bearer(VIEWER) }));
    assert.equal(refit.status, 403, 'a viewer must not be able to move every ETA on a 700-stop day');

    // The DRY refit is held at dispatcher too, deliberately unlike board-reconcile's free
    // preview: it publishes nothing but still sweeps up to 30 sealed days out of the warehouse,
    // and the person who needs the rehearsal is the person about to publish it.
    const dry = await routeDepartures(fn('route-departures?refit=1&dry=1&days=1', { headers: bearer(VIEWER) }));
    assert.equal(dry.status, 403);
  });
});

test('route-departures: a dispatcher\'s refit goes through — the gate must not cost the fit its operator', async () => {
  await enforcing({}, async (fake) => {
    const dry = await routeDepartures(fn('route-departures?refit=1&dry=1&days=1', { headers: bearer(DISPATCHER) }));
    assert.equal(dry.status, 200);
    const body = await dry.json();
    assert.equal(body.refit, true);
    assert.equal(body.dry, true);
    assert.equal(fake.log.sets.filter((s) => s.path.startsWith('route_departures')).length, 0, 'a dry run publishes nothing');
  });
});

// ── manifest-push-log: reading history vs writing it ────────────────────────

test('manifest-push-log: a viewer reads the day and is refused the POST that appends to the audit trail', async () => {
  await enforcing({}, async () => {
    const read = await pushLog(fn('manifest-push-log?date=2026-09-01', { headers: bearer(VIEWER) }));
    assert.equal(read.status, 200, '"what did I push yesterday" is a read');

    const write = await pushLog(fn('manifest-push-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(VIEWER) },
      body: JSON.stringify({ date: '2026-09-01', records: [{ orderRef: 'FAKE-1', name: 'Invented' }] }),
    }));
    assert.equal(write.status, 403, 'this log is what answers "did that order get pushed" in a dispute');
  });
});

test('manifest-push-log: a dispatcher\'s POST still lands — the audit trail is only useful if it gets written', async () => {
  await enforcing({}, async (fake) => {
    const write = await pushLog(fn('manifest-push-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(DISPATCHER) },
      body: JSON.stringify({ date: '2026-09-01', records: [{ orderRef: 'SO-100', name: 'Real Customer' }] }),
    }));
    assert.equal(write.status, 200);
    assert.equal((await write.json()).added, 1);
    assert.ok([...fake.store.keys()].some((k) => k.startsWith('manifest_push_log/davis__2026-09-01/records/')));
  });
});

// ── nuvizz-pull-today-stops: the board vs the vendor budget ─────────────────

test('nuvizz-pull-today-stops: a viewer gets the board and is refused ?live=1, the ~3,000-call probe', async () => {
  process.env.NUVIZZ_LIVE_READ_ENABLED = 'on';   // the env brake OFF, so the ROLE is what refuses
  await enforcing({}, async (fake) => {
    const board = await pullStops(fn('nuvizz-pull-today-stops?date=2026-09-01', { headers: bearer(VIEWER) }));
    assert.equal(board.status, 200, 'the map polls this — gating the board at anything above viewer breaks the app');

    const probe = await pullStops(fn('nuvizz-pull-today-stops?date=2026-09-01&live=1', { headers: bearer(VIEWER) }));
    assert.equal(probe.status, 403, 'the read-only role must never be the one that can spend the vendor budget');
    assert.equal(fake.log.other.length, 0, 'and it cost NuVizz nothing — the refusal is before the scan');
  });
  delete process.env.NUVIZZ_LIVE_READ_ENABLED;
});

test('nuvizz-pull-today-stops: even an ADMIN\'s ?live=1 still meets NUVIZZ_LIVE_READ_ENABLED', async () => {
  // The role split is the SECOND lock, not a replacement for the first. CLAUDE.md's hard rule is
  // that a ~3,000-call probe needs Chad's per-request say-so; an admin session is not that.
  delete process.env.NUVIZZ_LIVE_READ_ENABLED;
  await enforcing({}, async (fake) => {
    const probe = await pullStops(fn('nuvizz-pull-today-stops?date=2026-09-01&live=1', { headers: bearer(ADMIN) }));
    assert.equal(probe.status, 403);
    assert.match((await probe.json()).reason, /live_read_disabled/, 'past the role gate, stopped by the env brake');
    assert.equal(fake.log.other.length, 0);
  });
});

// ── and all three stay INERT until the switch ──────────────────────────────

test('every split ships INERT — with AUTH_REQUIRED off nothing changes for anybody today', async () => {
  // The whole change set is inert on production (VITE_AUTH_ENABLED is unset, so no login screen
  // exists). A split that started refusing today would be a security fix that broke the app.
  delete process.env.AUTH_REQUIRED;
  _resetUserCacheForTests();
  process.env.NUVIZZ_LIVE_READ_ENABLED = 'on';
  const fake = installFirestoreFake(USERS);
  try {
    assert.notEqual((await routeDepartures(fn('route-departures?refit=1&dry=1&days=1'))).status, 403);
    assert.notEqual((await pushLog(fn('manifest-push-log', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: '2026-09-01', records: [] }),
    }))).status, 403);
    const live = await pullStops(fn('nuvizz-pull-today-stops?date=2026-09-01&live=1'));
    assert.notEqual(live.status, 401);
    assert.notEqual(live.status, 403, 'the legacy principal is admin, so ?live=1 is exactly as reachable as it was');
  } finally {
    fake.restore();
    delete process.env.NUVIZZ_LIVE_READ_ENABLED;
  }
});
