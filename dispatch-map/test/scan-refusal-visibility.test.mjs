// test/scan-refusal-visibility.test.mjs — A REFUSAL THAT NOBODY CAN READ IS A LIE THE SYSTEM
// TELLS ITSELF.
//
// THE EVENT. 5am, a signed-out board, a dispatcher presses "Scan now". It fires
// nuvizz-manual-scan-background, which is a *-background* function: Netlify answers the caller
// 202 the instant the request lands and throws the handler's 401 away. So `resp.ok` is TRUE in
// the client, both of its fallbacks are skipped, and the dispatcher is told "Scan running — the
// board will refresh automatically" while nothing runs at all. Twenty minutes later they are
// routing off a board that never moved.
//
// The gate DID record the refusal — as a scan_runs row — but nothing the dispatcher looks at
// reads that ledger, and the same was true of nuvizz_ops/background_refusals: sixteen of the
// eighteen gates route their only durable record there and until now nothing in the repo read
// it back. Recording something nobody reads is not observability, it is filing.
//
// These tests pin the two channels that close it:
//   • `lastScanRefusal` on nuvizz-pull-today-stops — the poll the client is ALREADY making;
//   • `backgroundRefusals` on nuvizz-scan-config?explain=1 — the ops dry run, for the operator.
//
// And they pin the two things it must NOT do, both of which were considered and rejected:
// writing lastScannedAt (claiming a scan that never ran) and markScanState({halted}) (which
// paints "Scanning paused (kill switch)" on EVERY viewer's board, handing one refused caller a
// way to red-banner the whole dispatch floor).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// ── env BEFORE the import chain ───────────────────────────────────────────────
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SA = JSON.stringify({
  project_id: 'testproj',
  client_email: 'sa@testproj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});
process.env.NUVIZZ_BASE_URL = '';        // never uat → isFirestoreEnabled() true
delete process.env.FIRESTORE_DATABASE;
process.env.AUTH_SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';
delete process.env.AUTH_REQUIRED;

import { installFirestoreFake } from './_firestore-fake.mjs';
import { issueSessionToken } from '../netlify/functions/lib/auth-core.mts';
import { _resetUserCacheForTests, _resetThrottleForTests } from '../netlify/functions/lib/require-user.mts';
import { appendBackgroundRefusal } from '../netlify/functions/lib/background-gate.mts';
import { recordScanRefusal, readScanRefusal } from '../netlify/functions/lib/firestore.mts';
import manualScan from '../netlify/functions/nuvizz-manual-scan-background.mts';
import pullStops from '../netlify/functions/nuvizz-pull-today-stops.mts';
import scanConfig from '../netlify/functions/nuvizz-scan-config.mts';

const VIEWER = { username: 'ro', displayName: 'Ro', role: 'viewer', active: true, tokenVersion: 0 };
const bearer = (u) => ({ authorization: `Bearer ${issueSessionToken(u).token}` });
const fn = (path, init = {}) => new Request(`https://x.netlify.app/.netlify/functions/${path}`, init);

async function enforcing(seed, run) {
  process.env.AUTH_REQUIRED = 'true';
  _resetUserCacheForTests();
  _resetThrottleForTests();
  const fake = installFirestoreFake(seed);
  try { return await run(fake); } finally { fake.restore(); delete process.env.AUTH_REQUIRED; }
}

// ── the channel the button can actually see ──────────────────────────────────

test('a refused "Scan now" comes back on the NEXT BOARD POLL as lastScanRefusal', async () => {
  await enforcing({ 'app_users/ro': VIEWER }, async (fake) => {
    // 1. Signed out, the button fires. The platform has already said 202; this 401 is discarded.
    const kick = await manualScan(fn('nuvizz-manual-scan-background', { method: 'POST' }));
    assert.equal(kick.status, 401);

    // 2. The client's very next poll — the one it was going to make anyway — now carries it.
    const poll = await pullStops(fn('nuvizz-pull-today-stops?date=2026-09-01', { headers: bearer(VIEWER) }));
    assert.equal(poll.status, 200);
    const body = await poll.json();
    const r = body.lastScanRefusal;
    assert.ok(r, 'without this the button says "Scan running" over a scan that never started');
    assert.equal(r.job, 'nuvizz-manual-scan-background');
    assert.equal(r.trigger, 'manual');
    assert.equal(r.reason, 'no-token');
    assert.match(r.message, /Refused/, 'the message is the sentence to put in front of the dispatcher');
    assert.match(r.message, /not signed in/);
    assert.ok(typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)), 'at is an ISO stamp the client compares against its own press');
    assert.equal(typeof r.ageMin, 'number');

    // 3. AND NEITHER OF THE TWO REJECTED ALTERNATIVES HAPPENED.
    assert.equal(body.lastScannedAt, null, 'stamping a scan time would claim a scan that never ran');
    assert.equal(body.scanState, null, 'markScanState({halted}) renders as "Scanning paused (kill switch)" on EVERY viewer\'s board');
    // The board doc itself was never touched by the refusal.
    assert.equal(fake.store.get('nuvizz_stop_index/davis__2026-09-01'), undefined);
  });
});

test('a refusal from LAST NIGHT is not served on this morning\'s board', async () => {
  // The client compares `at` against the moment it pressed the button, but the server must not
  // hand it a stale refusal to get that wrong with. Six hours: longer than the gap between a
  // press and a second look, shorter than a shift.
  const old = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
  await enforcing({ 'app_users/ro': VIEWER }, async () => {
    await recordScanRefusal({ at: old, reason: 'no-token', message: 'Refused — not signed in.', job: 'nuvizz-manual-scan-background', trigger: 'manual' });
    const poll = await pullStops(fn('nuvizz-pull-today-stops?date=2026-09-01', { headers: bearer(VIEWER) }));
    assert.equal((await poll.json()).lastScanRefusal, null, 'yesterday is history, and history lives in ?explain=1');
  });
});

test('a board with no refusal serves lastScanRefusal: null, not a missing key', async () => {
  // A field that is sometimes absent and sometimes null is two shapes for the client to handle,
  // and the absent one reads as "this build does not have it yet".
  await enforcing({ 'app_users/ro': VIEWER }, async () => {
    const body = await (await pullStops(fn('nuvizz-pull-today-stops?date=2026-09-01', { headers: bearer(VIEWER) }))).json();
    assert.ok('lastScanRefusal' in body);
    assert.equal(body.lastScanRefusal, null);
    assert.equal(await readScanRefusal(), null);
  });
});

// ── the channel the operator can see ─────────────────────────────────────────

test('nuvizz-scan-config?explain=1 reports what has been REFUSED, not only what was due', async () => {
  // "Why didn't it scan?" and "did somebody get refused?" are the same question asked twice.
  // Before this, the second one could only be answered by opening the Firebase console.
  await enforcing({}, async () => {
    _resetThrottleForTests();
    await appendBackgroundRefusal({ job: 'nuvizz-att-scan-background?date', reason: 'role', message: 'Refused — this needs the admin role.', at: '2026-09-02T08:00:00.000Z' }, '1.1.1.1');
    await appendBackgroundRefusal({ job: 'routing-build-background', reason: 'no-token', message: 'Refused — not signed in.', at: '2026-09-02T09:00:00.000Z' }, '1.1.1.2');
    await recordScanRefusal({ at: '2026-09-02T09:30:00.000Z', reason: 'no-token', message: 'Refused — not signed in.', job: 'nuvizz-manual-scan-background', trigger: 'manual' });

    const body = await (await scanConfig(fn('nuvizz-scan-config?explain=1'))).json();
    assert.equal(body.backgroundRefusals.count, 2);
    assert.equal(body.backgroundRefusals.showing, 2, 'count is how many the ledger HOLDS; showing is how many are printed');
    assert.deepEqual(body.backgroundRefusals.rows.map((r) => r.job), ['routing-build-background', 'nuvizz-att-scan-background?date'], 'newest first');
    assert.match(body.backgroundRefusals.rows[0].message, /Refused/);
    assert.equal(typeof body.backgroundRefusals.rows[0].ageMin, 'number', 'an age is what makes "this morning" answerable');
    assert.match(body.backgroundRefusals.note, /202/, 'the note has to say WHY the caller was told nothing');
    // This GET is not gated (only the POST is), so it must not be the thing that publishes
    // visitor IPs to anyone who guesses the query string. The stored row keeps the IP for a
    // real investigation; the served one does not.
    assert.ok(!('ip' in body.backgroundRefusals.rows[0]), 'an ungated endpoint must not hand out caller IPs');
    assert.equal(body.lastScanRefusal.job, 'nuvizz-manual-scan-background');
  });
});

test('an empty refusal ledger says "nothing was refused", not nothing at all', async () => {
  // An empty array with no words beside it reads as a broken query, and an operator who cannot
  // tell "healthy" from "broken" checks neither next time.
  await enforcing({}, async () => {
    const body = await (await scanConfig(fn('nuvizz-scan-config?explain=1'))).json();
    assert.equal(body.backgroundRefusals.count, 0);
    assert.equal(body.backgroundRefusals.showing, 0);
    assert.deepEqual(body.backgroundRefusals.rows, []);
    assert.match(body.backgroundRefusals.note, /No background job has refused/);
    assert.match(body.backgroundRefusals.note, /AUTH_REQUIRED off/, 'and why that is the EXPECTED state today');
    assert.equal(body.lastScanRefusal, null);
  });
});
