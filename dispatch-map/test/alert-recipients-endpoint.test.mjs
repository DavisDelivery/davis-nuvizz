// THE ENDPOINT BEHIND THE "WHO GETS ALERTED" PANEL — the half that touches the world.
//
// The pure rules are pinned in test/alert-recipients-config.test.mjs. These are the ones that
// only fail for real: the write is a field-masked merge and not a whole-document replace, the
// POST is gated and the GET is not, a refusal is reported rather than swallowed, and the
// response the panel replaces its state with is read back from the document rather than
// echoed from the request — because "never report an intent as an outcome" is exactly the
// rule a settings screen breaks when it is written in a hurry.
//
// Fixtures are derived from the shipped allowlist and from 555-01xx, for the reasons set out
// at the top of test/alert-recipients-config.test.mjs.
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
import { ALERT_INTERNAL_SUFFIXES } from '../netlify/functions/lib/alert-recipients.mts';
import { ALERT_TO } from '../netlify/functions/lib/flag-alert.mts';

const DOC = 'nuvizz_ops/alert_recipients';
const at = (role) => `${role}${ALERT_INTERNAL_SUFFIXES[0]}`;
const DISPATCH = at('dispatch');
const OPS = at('ops');
const OUTSIDE = 'someone@example.com';
const P1 = '6785550101';
const P2 = '6785550102';

const url = (qs = '') => `https://x.netlify.app/.netlify/functions/alert-recipients-config${qs}`;
const GET = () => new Request(url());
const POST = (body, headers = {}) => new Request(url(), {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

const load = () => import('../netlify/functions/alert-recipients-config.mts').then((m) => m.default);
const chan = (j, key) => j.channels.find((c) => c.key === key);

/** Run `fn` with a fake Firestore seeded with `seed`, cleaning up whatever happens. */
async function withStore(seed, fn) {
  const fake = installFirestoreFake(seed);
  try { return await fn(fake); } finally { fake.restore(); }
}

// ── THE READ ────────────────────────────────────────────────────────────────

test('THE GET ANSWERS "WHO GETS THIS" FOR EVERY CHANNEL, and costs nothing to ask', () => {
  // The whole reason this exists: before it, "am I on the text list?" could only be answered
  // from the Netlify console, and "why did I not get that email?" could not be answered at
  // all. The fake THROWS on any fetch that is not Firestore, so this also proves the read
  // makes no vendor call — CLAUDE.md's cost rule.
  return withStore({}, async () => {
    const handler = await load();
    const r = await handler(GET());
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store', 'a recipient list must never be served from a cache');
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.persistent, true);
    assert.equal(j.channels.length, 5);
    for (const c of j.channels) {
      assert.ok(Array.isArray(c.recipients), `${c.key} must say who it reaches`);
      assert.ok(c.when && c.label && c.emptyNote, `${c.key} must be explainable on screen`);
    }
    assert.equal(typeof j.transports.email, 'boolean', 'a perfect list sends nothing with the transport off');
    assert.equal(typeof j.transports.sms, 'boolean');
  });
});

test('THE GET REPORTS WHAT IS ON THE DOCUMENT, resolved the way the sender resolves it', () => {
  return withStore({ [DOC]: { flagSmsTo: [P1], alertCc: [DISPATCH] } }, async () => {
    const j = await (await (await load())(GET())).json();
    assert.deepEqual(chan(j, 'flagSmsTo').recipients, [P1]);
    assert.equal(chan(j, 'flagSmsTo').source, 'saved');
    assert.deepEqual(chan(j, 'alertCc').recipients, [ALERT_TO, DISPATCH], 'customer service leads, always');
  });
});

test('A TAMPERED DOCUMENT CANNOT PUT AN OUTSIDE ADDRESS ON AN ALERT THAT NAMES A CUSTOMER', () => {
  // nuvizz_ops is writable by anyone holding the Firebase web config out of the public bundle
  // under the live rules, so the admin gate protects the WRITE PATH and not the document. The
  // allowlist therefore has to bind between the document and the sender.
  return withStore({ [DOC]: { alertCc: [OUTSIDE, DISPATCH] } }, async () => {
    const j = await (await (await load())(GET())).json();
    assert.deepEqual(chan(j, 'alertCc').recipients, [ALERT_TO, DISPATCH]);
    assert.equal(chan(j, 'alertCc').savedRejected[0].value, OUTSIDE, 'and it is named, not vanished');
  });
});

// ── THE WRITE ───────────────────────────────────────────────────────────────

test('A SAVE WRITES ONLY THE CHANNELS IT NAMES — a field-masked merge, not a document replace', () => {
  // THIS IS THE ONE THAT ONLY FAILS IN PRODUCTION. setDoc here is a whole-document replace, so
  // saving the email list with a blind write takes the phone numbers with it. Two people in
  // two tabs is an ordinary Tuesday.
  return withStore({ [DOC]: { flagSmsTo: [P1], alertCc: [DISPATCH] } }, async (fake) => {
    const r = await (await load())(POST({ alertCc: [OPS] }));
    assert.equal(r.status, 200);
    assert.deepEqual(fake.store.get(DOC).flagSmsTo, [P1], 'the untouched channel survived the save');
    assert.deepEqual(fake.store.get(DOC).alertCc, [OPS]);
    assert.equal(fake.log.sets.length, 0, 'no unmasked write may ever touch this document');
    assert.ok(fake.log.patches?.length, 'the write is field-masked');
    assert.ok(!fake.log.patches[0].mask.includes('flagSmsTo'), 'and the mask names only what changed');
  });
});

test('THE RESPONSE IS READ BACK FROM THE DOCUMENT, not echoed from the request', () => {
  // The panel replaces its state with this body. Echoing the request would make the screen
  // show a list that was never stored — reporting an intent as an outcome, which this repo has
  // shipped once already ("✅ routed to Google" for weeks).
  return withStore({}, async (fake) => {
    const j = await (await (await load())(POST({ flagSmsTo: [P1, P2] }))).json();
    assert.deepEqual(chan(j, 'flagSmsTo').recipients, [P1, P2]);
    assert.deepEqual(fake.store.get(DOC).flagSmsTo, [P1, P2]);
    assert.ok(j.updatedAt, 'stamped, so the panel can say when it last changed');
  });
});

test('CLEARING A LIST STORES AN EMPTY LIST — it does not fall back to the env var', () => {
  // Decision 1, end to end: a control that silently reverts when you empty it is a control
  // that lies. `[]` on the document is a different thing from no key at all.
  const before = process.env.FLAG_SMS_TO;
  process.env.FLAG_SMS_TO = P2;
  return withStore({ [DOC]: { flagSmsTo: [P1] } }, async (fake) => {
    const j = await (await (await load())(POST({ flagSmsTo: [] }))).json();
    assert.deepEqual(fake.store.get(DOC).flagSmsTo, []);
    assert.deepEqual(chan(j, 'flagSmsTo').recipients, [], 'nobody is texted, and the screen says so');
    assert.equal(chan(j, 'flagSmsTo').source, 'saved');
  }).finally(() => { if (before === undefined) delete process.env.FLAG_SMS_TO; else process.env.FLAG_SMS_TO = before; });
});

test('A REFUSED ENTRY IS NAMED IN THE SAVE RESPONSE, beside the channel it was typed into', () => {
  return withStore({}, async (fake) => {
    const j = await (await (await load())(POST({ flagSmsTo: [P1, '555'], alertCc: [OUTSIDE] }))).json();
    assert.deepEqual(fake.store.get(DOC).flagSmsTo, [P1], 'the good one still saved');
    assert.equal(j.rejected.flagSmsTo[0].value, '555');
    assert.match(j.rejected.flagSmsTo[0].reason, /10-digit/);
    assert.equal(j.rejected.alertCc[0].value, OUTSIDE);
    assert.deepEqual(j.saved, ['flagSmsTo', 'alertCc'], 'and which channels the save touched');
  });
});

test('A BODY THAT NAMES NO CHANNEL IS REFUSED — an empty save must not stamp the document', () => {
  // Otherwise "Save" on an untouched form rewrites updatedAt and the panel reports an edit
  // nobody made, which is the sort of thing that makes an audit line worthless.
  return withStore({}, async (fake) => {
    const r = await (await load())(POST({ updatedBy: 'nobody' }));
    assert.equal(r.status, 400);
    assert.equal(fake.store.has(DOC), false, 'nothing was written');
  });
});

test('MALFORMED JSON IS A 400, NOT A 500', () => {
  return withStore({}, async () => {
    const r = await (await load())(new Request(url(), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope',
    }));
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid JSON');
  });
});

test('ANY OTHER METHOD IS 405', () => {
  return withStore({}, async () => {
    const r = await (await load())(new Request(url(), { method: 'DELETE' }));
    assert.equal(r.status, 405);
  });
});

// ── THE GATE ────────────────────────────────────────────────────────────────

test('THE READ STAYS OPEN AND THE WRITE SHUTS — the panel must render to show anyone what would change', async () => {
  // Same split as nuvizz-scan-config. A gated GET turns a panel that explains who is alerted
  // into a blank box; an ungated POST lets anyone change who hears that freight is about to be
  // refused, and spend money at somebody's phone.
  process.env.AUTH_REQUIRED = 'true';
  _resetUserCacheForTests();
  _resetThrottleForTests();
  const viewer = { username: 'ro', displayName: 'Ro', role: 'viewer', active: true, tokenVersion: 0 };
  const admin = { username: 'boss', displayName: 'Boss', role: 'admin', active: true, tokenVersion: 0 };
  const fake = installFirestoreFake({ 'app_users/ro': viewer, 'app_users/boss': admin });
  try {
    const handler = await load();
    assert.equal((await handler(GET())).status, 200, 'the read is open');

    assert.equal((await handler(POST({ flagSmsTo: [P1] }))).status, 401, 'signed out cannot write');
    const asViewer = await handler(POST({ flagSmsTo: [P1] }, { authorization: `Bearer ${issueSessionToken(viewer).token}` }));
    assert.equal(asViewer.status, 403, 'a viewer cannot change who gets alerted');
    assert.match((await asViewer.json()).error, /requires admin/);

    const asAdmin = await handler(POST({ flagSmsTo: [P1] }, { authorization: `Bearer ${issueSessionToken(admin).token}` }));
    assert.equal(asAdmin.status, 200);
    assert.equal(fake.store.get(DOC).updatedBy, 'boss', 'and the change carries a name');
  } finally {
    fake.restore();
    delete process.env.AUTH_REQUIRED;
    _resetUserCacheForTests();
  }
});

// ── THE DEGRADED CASE ───────────────────────────────────────────────────────

test('WITHOUT FIRESTORE THE PANEL STILL RENDERS THE TRUTH — a blank one would read as "nobody is alerted"', async () => {
  const before = { sa: process.env.FIREBASE_SA, cc: process.env.ALERT_CC };
  delete process.env.FIREBASE_SA;
  process.env.ALERT_CC = DISPATCH;
  try {
    const j = await (await (await load())(GET())).json();
    assert.equal(j.ok, true);
    assert.equal(j.persistent, false, 'and it says plainly that it cannot save');
    assert.ok(j.note, 'with the reason, next to the thing that will not work');
    assert.deepEqual(chan(j, 'alertCc').recipients, [ALERT_TO, DISPATCH], 'the env lists are still resolved and shown');
  } finally {
    if (before.sa === undefined) delete process.env.FIREBASE_SA; else process.env.FIREBASE_SA = before.sa;
    if (before.cc === undefined) delete process.env.ALERT_CC; else process.env.ALERT_CC = before.cc;
  }
});
