// test/background-gate.test.mjs — GATING A BACKGROUND FUNCTION WITHOUT SILENCING IT.
//
// THE EVENT THIS PREVENTS. A dispatcher presses "Scan now" at 5am on a signed-out board.
// Netlify answers a *-background* function's caller 202 the instant the request lands and
// throws the handler's Response away — so an ordinary `return gate.response` 401 reaches
// nobody, the button reports "Scan running", and no scan ever happens. That is CLAUDE.md's
// "never report an intent as an outcome" produced BY the security fix, and it is worse than
// leaving the endpoint open, because an open endpoint at least does the work.
//
// So every gated background job here must leave the refusal somewhere a person can read:
// the job doc its own client polls, or the ledger that job family already keeps, and always
// the shared nuvizz_ops/background_refusals row.
//
// These tests run the REAL handlers against an in-memory Firestore and a fetch that THROWS on
// anything that is not Firestore — so "no vendor call was made" is proven, not asserted.
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
import {
  requireUserForBackground, refusalMessage, appendBackgroundRefusal, BACKGROUND_REFUSALS_PATH,
} from '../netlify/functions/lib/background-gate.mts';
import manualScan from '../netlify/functions/nuvizz-manual-scan-background.mts';
import routingBuild from '../netlify/functions/routing-build-background.mts';
import manifestOcr from '../netlify/functions/manifest-ocr-background.mts';
import { jobDocPath } from '../netlify/functions/manifest-ocr-background.mts';

const VIEWER = { username: 'ro', displayName: 'Ro', role: 'viewer', active: true, tokenVersion: 0 };
const DISPATCHER = { username: 'tina', displayName: 'Tina', role: 'dispatcher', active: true, tokenVersion: 0 };

/** Run `fn` with the auth switch ON, a seeded Firestore, and NO network but Firestore. */
async function enforcing(seed, fn) {
  process.env.AUTH_REQUIRED = 'true';
  _resetUserCacheForTests();
  _resetThrottleForTests();
  const fake = installFirestoreFake(seed);
  try { return await fn(fake); } finally {
    fake.restore();
    delete process.env.AUTH_REQUIRED;
  }
}

const bearer = (u) => ({ authorization: `Bearer ${issueSessionToken(u).token}` });
const refusals = (fake) => (fake.store.get(BACKGROUND_REFUSALS_PATH)?.refusals) || [];

// ── the words ────────────────────────────────────────────────────────────────

test('a ROLE refusal never tells a signed-in dispatcher to sign in — it names the role', () => {
  // Telling somebody who IS signed in to sign in sends them round a loop that cannot end.
  assert.match(refusalMessage('role', 'admin'), /needs the admin role/);
  assert.doesNotMatch(refusalMessage('role', 'admin'), /not signed in/);
  assert.match(refusalMessage('no-token'), /not signed in/);
  assert.match(refusalMessage('revoked'), /session is no longer valid/);
  // An unreachable user store is a RETRY, not a permissions problem — routing it to
  // "go find an admin" sends a dispatcher chasing a person over a blip.
  assert.match(refusalMessage('store-error'), /try again/i);
  assert.doesNotMatch(refusalMessage('store-error'), /admin/);
  // Every message says the job did NOT run. That is the whole point of the pattern.
  for (const r of ['role', 'no-token', 'revoked', 'store-error', 'bad-token', 'inactive']) {
    assert.match(refusalMessage(r, 'admin'), /Refused/, r);
  }
});

// ── the pattern ──────────────────────────────────────────────────────────────

test('SHIPS INERT: with AUTH_REQUIRED off a token-less background job runs and writes no refusal', async () => {
  delete process.env.AUTH_REQUIRED;
  const fake = installFirestoreFake({});
  try {
    let recorded = 0;
    const gate = await requireUserForBackground(new Request('https://x.test/f', { method: 'POST' }), 'j', {
      role: 'admin', record: async () => { recorded++; },
    });
    assert.ok(gate.ok, 'the legacy principal still runs the job — nothing changes on merge day');
    assert.equal(recorded, 0);
    assert.equal(refusals(fake).length, 0, 'a ledger row for a job that RAN would be a lie');
  } finally { fake.restore(); }
});

test('a refusal lands in the job\'s OWN doc first, then the shared ledger — never only in a discarded 401', async () => {
  await enforcing({}, async (fake) => {
    const seen = [];
    const gate = await requireUserForBackground(new Request('https://x.test/f', { method: 'POST' }), 'demo-job', {
      role: 'dispatcher', record: async (r) => seen.push(r),
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.response.status, 401, 'the Response is still built — netlify dev and curl see it even though the platform will not');
    assert.equal(seen.length, 1, 'the client-visible write happened');
    assert.match(seen[0].message, /Refused/);
    const rows = refusals(fake);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].job, 'demo-job');
    assert.equal(rows[0].reason, 'no-token');
  });
});

test('a job doc write that FAILS does not swallow the refusal — the shared ledger still gets it', async () => {
  // The whole value of this pattern is that a refusal is never nowhere. If the per-job write
  // could throw the refusal away, the failure mode would be exactly the one being fixed.
  await enforcing({}, async (fake) => {
    const gate = await requireUserForBackground(new Request('https://x.test/f', { method: 'POST' }), 'broken-record', {
      role: 'admin', record: async () => { throw new Error('firestore said no'); },
    });
    assert.equal(gate.ok, false);
    assert.equal(refusals(fake).length, 1, 'the ledger is the floor and it held');
  });
});

test('the shared ledger is BOUNDED and per-caller throttled — a refusal must not become a cheaper way to spend money', async () => {
  await enforcing({}, async (fake) => {
    _resetThrottleForTests();
    // 12 attempts from one IP; the throttle admits 10 per minute.
    for (let i = 0; i < 12; i++) {
      await appendBackgroundRefusal({ job: `j${i}`, reason: 'no-token', message: 'x', at: new Date().toISOString() }, '1.2.3.4');
    }
    assert.equal(refusals(fake).length, 10, 'the 11th and 12th hits from the same caller wrote nothing');
    // A different caller is not punished for the first one's flood.
    await appendBackgroundRefusal({ job: 'other', reason: 'no-token', message: 'x', at: new Date().toISOString() }, '9.9.9.9');
    assert.equal(refusals(fake).length, 11);
  });
});

// ── the three verified call sites ────────────────────────────────────────────

test('5am "Scan now" while signed out: NO NuVizz call, and the scan ledger says REFUSED rather than nothing', async () => {
  // The client (App.jsx useManualScan) polls lastScannedAt and, seeing no change, prints
  // "Scan running — the board will refresh automatically". The one durable record that can
  // contradict that is the run ledger the scheduled scanner already writes and
  // nuvizz-scan-config?explain=1 reads back, so the refusal is filed there.
  await enforcing({}, async (fake) => {
    const r = await manualScan(new Request('https://x.test/.netlify/functions/nuvizz-manual-scan-background', { method: 'POST' }));
    assert.equal(r.status, 401);
    // The fake THROWS on any non-Firestore fetch, so reaching this line proves no vendor call.
    const runs = fake.store.get('nuvizz_ops/scan_runs')?.runs || [];
    assert.equal(runs.length, 1);
    assert.equal(runs[0].outcome, 'refused');
    assert.equal(runs[0].trigger, 'manual');
    assert.match(runs[0].error, /not signed in/i);
    // startedAt AND finishedAt: `?explain=1` lists a start-with-no-finish as a STUCK run, and
    // a refusal that never began must not be reported as a scan that died mid-board-write.
    assert.ok(runs[0].startedAt && runs[0].finishedAt, 'a refusal is not an unfinished run');
    assert.equal(refusals(fake)[0].job, 'nuvizz-manual-scan-background');
  });
});

test('a refused routing build ENDS the job doc — the Routing panel does not spin on "queued" for ever', async () => {
  // App.jsx opens onSnapshot(routing_jobs/{jobId}) the moment it fires the build and renders
  // job.error. Without this write the panel watches a doc that will never move again.
  await enforcing({ 'routing_jobs/job_abc': { id: 'job_abc', status: 'queued', request: { date: '2026-09-01' } } }, async (fake) => {
    const r = await routingBuild(new Request('https://x.test/.netlify/functions/routing-build-background', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'job_abc' }),
    }));
    assert.equal(r.status, 401);
    const job = fake.store.get('routing_jobs/job_abc');
    assert.equal(job.status, 'error', 'terminal, so the client stops polling');
    assert.match(job.error, /Refused/);
    assert.ok(job.finished_at);
  });
});

test('a VIEWER dropping a manifest is told why, through the same doc manifest-ocr-result serves', async () => {
  // The sharp case: this person IS signed in, so their poll of manifest-ocr-result succeeds —
  // they simply lack the dispatcher role the reader needs. The refusal has to arrive as the
  // job doc's own error, because that string is what App.jsx renders verbatim via fail(pd.error).
  const job = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  await enforcing({ 'app_users/ro': VIEWER }, async (fake) => {
    const r = await manifestOcr(new Request('https://x.test/.netlify/functions/manifest-ocr-background', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(VIEWER) },
      body: JSON.stringify({ jobId: job, pdfBase64: 'JVBERiAxLjQ=' }),
    }));
    assert.equal(r.status, 403, 'a role refusal, not a sign-in refusal');
    const doc = fake.store.get(jobDocPath(job));
    assert.equal(doc.status, 'error');
    assert.match(doc.error, /needs the dispatcher role/);
    assert.doesNotMatch(doc.error, /not signed in/, 'they ARE signed in — sending them to a login is a loop');
  });
});

test('a DISPATCHER drop is not refused — the gate does not cost a legitimate user their manifest', async () => {
  // The other direction, which is the one that gets a gate switched off if it is wrong.
  const job = 'b1b2c3d4-e5f6-7890-abcd-ef1234567890';
  delete process.env.ANTHROPIC_API_KEY;
  await enforcing({ 'app_users/tina': DISPATCHER }, async (fake) => {
    const r = await manifestOcr(new Request('https://x.test/.netlify/functions/manifest-ocr-background', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(DISPATCHER) },
      body: JSON.stringify({ jobId: job, pdfBase64: 'JVBERiAxLjQ=' }),
    }));
    assert.equal(r.status, 200, 'the gate let them through');
    // It stops at the (deliberately unset) API key, INSIDE the reader — past the gate.
    assert.match(fake.store.get(jobDocPath(job)).error, /ANTHROPIC_API_KEY/);
    assert.equal(refusals(fake).length, 0);
  });
});
