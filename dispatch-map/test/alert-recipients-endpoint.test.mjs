// THE ENDPOINT BEHIND THE "WHO GETS ALERTED" PANEL — the half that touches the world.
//
// The pure rules are pinned in test/alert-recipients-config.test.mjs. These are the ones that
// only fail for real: the write is a field-masked merge and not a whole-document replace, the
// read is gated at viewer and the write at admin, a refusal is reported rather than swallowed, and the
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

test('THE SAVE REPORTS WHAT IT WROTE, not what the body mentioned', () => {
  // `null` on a channel means "leave it alone", and it is dropped before the write. Naming it
  // in `saved` would tell the caller a list had been stored when nothing was — an intent
  // reported as an outcome, in the endpoint that re-reads the document precisely to avoid it.
  return withStore({ [DOC]: { flagSmsTo: [P1] } }, async (fake) => {
    const j = await (await (await load())(POST({ flagSmsTo: null, alertCc: [DISPATCH] }))).json();
    assert.deepEqual(j.saved, ['alertCc']);
    assert.deepEqual(fake.store.get(DOC).flagSmsTo, [P1], 'and the null channel really was left alone');
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

test('THE AUDIT LINE NAMES THE PRINCIPAL, never a string the caller supplied', () => {
  // The panel renders this as "last changed … by X" — the one line somebody reads to find out
  // who took them off a list. A body field outranking the authenticated user turns that from
  // an audit fact into an assertion by whoever made the request.
  return withStore({}, async (fake) => {
    await (await load())(POST({ flagSmsTo: [P1], updatedBy: 'somebody-else' }));
    assert.notEqual(fake.store.get(DOC).updatedBy, 'somebody-else');
    // With AUTH_REQUIRED off the principal really is the pre-login one, and the audit line
    // says 'legacy' rather than inventing a name. That is the honest answer to "who did this"
    // on a site where nobody signs in yet, and it changes to the real username the day the
    // switch flips — see the gate test below, which asserts exactly that.
    assert.equal(fake.store.get(DOC).updatedBy, 'legacy');
  });
});

test('THE RESPONSE DOES NOT REPUBLISH THE RAW DOCUMENT', () => {
  // nuvizz_ops is writable by anyone holding the web config out of the public bundle, so
  // echoing the document whole would hand back whatever an outside writer put on it, beside
  // the validated channels and looking every bit as official.
  return withStore({ [DOC]: { flagSmsTo: [P1], evilPayload: 'anything at all' } }, async () => {
    const j = await (await (await load())(GET())).json();
    assert.deepEqual(Object.keys(j.stored), ['flagSmsTo']);
    assert.equal(JSON.stringify(j).includes('evilPayload'), false);
  });
});

// ── THE NAME AGAINST THE NUMBER ─────────────────────────────────────────────

test('A NAME IS SAVED BESIDE ITS NUMBER, and comes back on the channel that uses it', () => {
  // Chad: "Also let me put a name in to id the number." At 6am, "is that Zach or Marcus" is
  // the question, and a column of digits cannot answer it.
  return withStore({}, async (fake) => {
    const j = await (await (await load())(POST({ flagSmsTo: [P1, P2], labels: { [P1]: 'Chad', [P2]: 'Zach' } }))).json();
    assert.deepEqual(fake.store.get(DOC).labels, { [P1]: 'Chad', [P2]: 'Zach' });
    assert.deepEqual(chan(j, 'flagSmsTo').names, { [P1]: 'Chad', [P2]: 'Zach' });
    assert.deepEqual(chan(j, 'flagSmsTo').recipients, [P1, P2], 'and the send list is untouched by any of it');
  });
});

test('A NAME TYPED IN THE SAME SAVE AS ITS NUMBER SURVIVES', () => {
  // The prune runs against the lists this write LEAVES BEHIND. Pruning against the lists it
  // arrived with would drop every name added alongside its number — which is the ordinary way
  // anybody would use this — and it would look exactly like the field not working.
  return withStore({}, async (fake) => {
    await (await load())(POST({ flagSmsTo: [P1], labels: { [P1]: 'Chad' } }));
    assert.deepEqual(fake.store.get(DOC).labels, { [P1]: 'Chad' });
  });
});

test('REMOVING SOMEBODY FROM EVERY LIST TAKES THEIR NAME WITH IT', () => {
  // A phone number is personal data — lib/flag-sms.mts says so in as many words — so a name
  // and number for somebody who is on no list must not sit in the document forever.
  return withStore({ [DOC]: { flagSmsTo: [P1, P2], labels: { [P1]: 'Chad', [P2]: 'Zach' } } }, async (fake) => {
    await (await load())(POST({ flagSmsTo: [P1] }));
    assert.deepEqual(fake.store.get(DOC).labels, { [P1]: 'Chad' }, 'the one still on a list keeps their name');
  });
});

test('A NAME IS ONE NAME PER NUMBER, ACROSS CHANNELS — nobody types it twice', () => {
  return withStore({ [DOC]: { flagSmsTo: [P1], labels: { [P1]: 'Chad' } } }, async () => {
    const j = await (await (await load())(POST({ flagSmsToNight: [P1] }))).json();
    assert.equal(chan(j, 'flagSmsToNight').names[P1], 'Chad');
    assert.equal(chan(j, 'flagSmsTo').names[P1], 'Chad');
  });
});

test('A NAME IS A LABEL, NOT A PAYLOAD — one line, trimmed, and capped', () => {
  return withStore({}, async (fake) => {
    await (await load())(POST({ flagSmsTo: [P1], labels: { [P1]: `  Chad\n\tBlyth  ${'x'.repeat(80)}` } }));
    const saved = fake.store.get(DOC).labels[P1];
    assert.equal(saved.length <= 40, true, `capped, got ${saved.length}`);
    assert.equal(/[\n\t]/.test(saved), false, 'one line');
    assert.match(saved, /^Chad Blyth/);
  });
});

test('EDITING ONLY THE NAMES IS A VALID SAVE — it must not be refused as "name a channel"', () => {
  return withStore({ [DOC]: { flagSmsTo: [P1] } }, async (fake) => {
    const r = await (await load())(POST({ labels: { [P1]: 'Chad' } }));
    assert.equal(r.status, 200);
    assert.deepEqual(fake.store.get(DOC).labels, { [P1]: 'Chad' });
    assert.deepEqual(fake.store.get(DOC).flagSmsTo, [P1], 'and the list it did not name is untouched');
  });
});

test('THE WHOLE GESTURE: add two numbers with names, rename one, remove the other', () => {
  // Each step is pinned above; this is the sequence a person actually performs, in order,
  // because the steps interact — the prune reads the lists, and the lists are edited in the
  // same requests that carry the names.
  return withStore({}, async (fake) => {
    const h = await load();
    const doc = () => fake.store.get(DOC);
    await h(POST({ flagSmsTo: [P1, P2], labels: { [P1]: 'Chad', [P2]: 'Zach' } }));
    assert.deepEqual(doc().labels, { [P1]: 'Chad', [P2]: 'Zach' });

    const renamed = await (await h(POST({ labels: { [P1]: 'Chad B', [P2]: 'Zach' } }))).json();
    assert.equal(chan(renamed, 'flagSmsTo').names[P1], 'Chad B');
    assert.deepEqual(chan(renamed, 'flagSmsTo').recipients, [P1, P2], 'renaming never moves a recipient');

    await h(POST({ flagSmsTo: [P2], labels: { [P1]: 'Chad B', [P2]: 'Zach' } }));
    assert.deepEqual(doc().labels, { [P2]: 'Zach' }, 'the removed one takes their name with them');

    await h(POST({ labels: { [P2]: 'Zach', '6785559999': 'Ghost' } }));
    assert.deepEqual(Object.keys(doc().labels), [P2], 'a name for somebody on no list is never stored');
  });
});

// ── THE GATE ────────────────────────────────────────────────────────────────

test('A SIGNED-OUT CALLER GETS NOTHING — this response is a list of personal mobile numbers', async () => {
  // The first draft of this endpoint left the GET open on the scan-config precedent. That
  // precedent is about a cadence and a call ceiling; this body carries staff phone numbers,
  // which until this feature existed lived only in the Netlify console. The repo has the rule
  // written down twice — driver-phone.mts gates a plain GET at viewer BECAUSE it turns a name
  // into a personal number, and day-completion.mts reports only WHETHER a recipient is set,
  // with a test that greps its source to keep the address out of the body. A viewer is anyone
  // signed in, so the panel still renders for everyone who can open it.
  process.env.AUTH_REQUIRED = 'true';
  _resetUserCacheForTests();
  _resetThrottleForTests();
  const viewer = { username: 'ro', displayName: 'Ro', role: 'viewer', active: true, tokenVersion: 0 };
  const admin = { username: 'boss', displayName: 'Boss', role: 'admin', active: true, tokenVersion: 0 };
  const fake = installFirestoreFake({ 'app_users/ro': viewer, 'app_users/boss': admin });
  try {
    const handler = await load();
    const anon = await handler(GET());
    assert.equal(anon.status, 401, 'a stranger cannot read the phone list');
    const asViewerRead = await handler(new Request(url(), { headers: { authorization: `Bearer ${issueSessionToken(viewer).token}` } }));
    assert.equal(asViewerRead.status, 200, 'but anyone signed in can see who is alerted');
    assert.equal(asViewerRead.headers.get('vary'), 'Authorization', 'the body varies by caller — no shared cache may hold it');

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
