// THE SWITCH BEHIND DIAGNOSTICS → MANIFEST LAYOUT — the half that touches the world.
//
// Chad, 2026-10-03: "i want a way to roll back to old one if needed in diagnostics screen
// somewhere i want to be able to pick which version i'm running."
//
// The words and the defaults are pinned in test/print-layout.test.mjs. These are the ones that
// only fail for real: the answer is READ BACK from the document and not echoed from the request,
// a read that fails is an error and never a quiet "new", the write names its own fields and
// replaces nothing else, anyone signed in can see the setting and only an admin can change it.
// The Firestore fake THROWS on any request that is not Firestore, so every passing test here is
// also proof the endpoint makes no NuVizz call.
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

const DOC = 'nuvizz_ops/print_layout';
const url = 'https://x.netlify.app/.netlify/functions/print-layout';
const GET = (headers = {}) => new Request(url, { headers });
const POST = (body, headers = {}) => new Request(url, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const load = () => import('../netlify/functions/print-layout.mts');

/** Run `fn` with a fake Firestore seeded with `seed`, cleaning up whatever happens. */
async function withStore(seed, fn) {
  const fake = installFirestoreFake(seed);
  try { return await fn(fake); } finally { fake.restore(); }
}
/** Make the document's requests misbehave: `on(method)` returns a Response to answer with, or nothing. */
function intercept(on) {
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input?.url ?? input);
    if (u.includes(`/documents/${DOC}`)) {
      const r = on((init.method || 'GET').toUpperCase());
      if (r) return r;
    }
    return inner(input, init);
  };
  return () => { globalThis.fetch = inner; };
}

// ── THE READ ────────────────────────────────────────────────────────────────

test('NOBODY HAS EVER CHOSEN: the new layout is in use, and the answer says nothing is stored', () =>
  withStore({}, async () => {
    const { default: handler, PRINT_LAYOUT_PATH } = await load();
    assert.equal(PRINT_LAYOUT_PATH, DOC);
    const r = await handler(GET());
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store', 'a setting that changes what prints must never come out of a cache');
    assert.deepEqual(await r.json(), { ok: true, layout: 'new', stored: null, persistent: true, set_at: null, set_by: null });
  }));

test('SWITCHED BACK: the read says the old layout, who chose it and when', () =>
  withStore({ [DOC]: { layout: 'classic', set_at: '2026-10-03T18:14:00.000Z', set_by: 'Chad' } }, async () => {
    const j = await (await (await load()).default(GET())).json();
    assert.deepEqual(j, { ok: true, layout: 'classic', stored: 'classic', persistent: true, set_at: '2026-10-03T18:14:00.000Z', set_by: 'Chad' });
  }));

test('A HAND-EDITED DOCUMENT: a value that is not a layout prints the new one, and the value found is passed on', () =>
  withStore({ [DOC]: { layout: 'clasic' } }, async () => {
    // A typo must never switch the layout — and must not hide either: `stored` carries what was
    // found so the screen can name it. A non-string is not passed on at all.
    const j = await (await (await load()).default(GET())).json();
    assert.equal(j.layout, 'new');
    assert.equal(j.stored, 'clasic');
    await withStore({ [DOC]: { layout: 7, set_by: { x: 1 } } }, async () => {
      const k = await (await (await load()).default(GET())).json();
      assert.deepEqual([k.layout, k.stored, k.set_by], ['new', null, null]);
    });
  }));

test('A READ THAT FAILS IS AN ERROR, NEVER A QUIET "NEW"', () =>
  withStore({ [DOC]: { layout: 'classic' } }, async () => {
    // The company is on the old layout and Firestore is having a bad minute. Answering "new" here
    // would switch every device that asked back to the new layout without anybody choosing it.
    const undo = intercept((m) => (m === 'GET' ? new Response('unavailable', { status: 503 }) : null));
    try {
      const r = await (await load()).default(GET());
      assert.equal(r.status, 500);
      const j = await r.json();
      assert.equal(j.ok, false);
      assert.equal('layout' in j, false, 'no layout is offered when none was read');
      assert.match(j.error, /503/);
    } finally { undo(); }
  }));

// ── THE WRITE ───────────────────────────────────────────────────────────────

test('GOING BACK TO THE OLD LAYOUT: the answer is the document READ BACK, stamped with when', () =>
  withStore({}, async (fake) => {
    const before = Date.now();
    const r = await (await load()).default(POST({ layout: 'classic' }));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.layout, 'classic');
    assert.equal(j.stored, 'classic');
    assert.ok(Date.parse(j.set_at) >= before - 1000 && Date.parse(j.set_at) <= Date.now() + 1000, j.set_at);
    // With sign-in not required the caller is the pre-login principal — no person to name.
    assert.equal(j.set_by, null);
    assert.equal(fake.store.get(DOC).layout, 'classic');
    // …and back again, so the way forward is as real as the way back.
    const again = await (await (await load()).default(POST({ layout: 'new' }))).json();
    assert.deepEqual([again.layout, again.stored, fake.store.get(DOC).layout], ['new', 'new', 'new']);
  }));

test('THE WRITE NAMES ITS OWN THREE FIELDS AND REPLACES NOTHING ELSE', () =>
  withStore({ [DOC]: { layout: 'new', note: 'kept' } }, async (fake) => {
    await (await load()).default(POST({ layout: 'classic' }));
    assert.equal(fake.log.sets.length, 0, 'no unmasked write — setDoc here REPLACES the document');
    assert.deepEqual([...fake.log.patches[0].mask].sort(), ['layout', 'set_at', 'set_by']);
    assert.equal(fake.store.get(DOC).note, 'kept', 'a field this endpoint does not own survives the switch');
  }));

test('ONLY THE TWO LAYOUTS CAN BE STORED: anything else is refused and nothing is written', () =>
  withStore({}, async (fake) => {
    const handler = (await load()).default;
    for (const body of [{ layout: 'blue' }, { layout: 'old' }, { layout: 'Classic' }, { layout: '' }, { layout: null }, {}, { planning: true }, 'not json', '[]']) {
      const r = await handler(POST(body));
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal((await r.json()).ok, false);
    }
    assert.equal(fake.store.has(DOC), false);
    assert.equal((fake.log.patches || []).length + fake.log.sets.length, 0);
  }));

test('A WRITE THAT DID NOT LAND IS NOT REPORTED AS A SWITCH', () =>
  withStore({ [DOC]: { layout: 'new' } }, async () => {
    // Firestore answers 200 to the write and the document does not change. The screen replaces
    // its state with this body, so echoing the request would show "old layout" while every
    // device went on printing the new one.
    const undo = intercept((m) => (m === 'PATCH' ? new Response('{}', { status: 200 }) : null));
    try {
      const r = await (await load()).default(POST({ layout: 'classic' }));
      assert.equal(r.status, 500);
      const j = await r.json();
      assert.equal(j.ok, false);
      assert.match(j.error, /wrote layout=classic but reading it back says new/);
      assert.equal(j.layout, 'new', 'and it says what IS stored');
    } finally { undo(); }
  }));

test('A WRITE FIRESTORE REFUSES IS AN ERROR WITH ITS REASON', () =>
  withStore({}, async (fake) => {
    const undo = intercept((m) => (m === 'PATCH' ? new Response('quota', { status: 429 }) : null));
    try {
      const r = await (await load()).default(POST({ layout: 'classic' }));
      assert.equal(r.status, 500);
      assert.match((await r.json()).error, /429/);
      assert.equal(fake.store.has(DOC), false);
    } finally { undo(); }
  }));

test('GET or POST only', () =>
  withStore({}, async () => {
    const r = await (await load()).default(new Request(url, { method: 'DELETE' }));
    assert.equal(r.status, 405);
  }));

// ── WHO MAY ─────────────────────────────────────────────────────────────────

test('WITH SIGN-IN ON: anyone signed in can see the layout, only an admin can change it, and the change carries a name', async () => {
  process.env.AUTH_REQUIRED = 'true';
  _resetUserCacheForTests();
  _resetThrottleForTests();
  const viewer = { username: 'ro', displayName: 'Ro', role: 'viewer', active: true, tokenVersion: 0 };
  const dispatcher = { username: 'dee', displayName: 'Dee', role: 'dispatcher', active: true, tokenVersion: 0 };
  const admin = { username: 'boss', displayName: 'Chad', role: 'admin', active: true, tokenVersion: 0 };
  const fake = installFirestoreFake({ 'app_users/ro': viewer, 'app_users/dee': dispatcher, 'app_users/boss': admin });
  const as = (u) => ({ authorization: `Bearer ${issueSessionToken(u).token}` });
  try {
    const handler = (await load()).default;
    assert.equal((await handler(GET())).status, 401, 'signed out reads nothing');
    assert.equal((await handler(GET(as(viewer)))).status, 200, 'a viewer can see which layout is in use');
    assert.equal((await handler(POST({ layout: 'classic' }))).status, 401, 'signed out cannot switch');
    for (const u of [viewer, dispatcher]) {
      const r = await handler(POST({ layout: 'classic' }, as(u)));
      assert.equal(r.status, 403, `${u.role} cannot switch the company's paper`);
    }
    assert.equal(fake.store.has(DOC), false, 'and none of those wrote anything');
    const ok = await handler(POST({ layout: 'classic' }, as(admin)));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).set_by, 'Chad');
    assert.equal(fake.store.get(DOC).set_by, 'Chad');
  } finally {
    fake.restore();
    delete process.env.AUTH_REQUIRED;
    _resetUserCacheForTests();
  }
});

// ── THE DEGRADED CASE ───────────────────────────────────────────────────────

test('A SITE WITH NO DATABASE prints the new layout, says the choice cannot be stored, and refuses a switch', async () => {
  const sa = process.env.FIREBASE_SA;
  delete process.env.FIREBASE_SA;
  try {
    const handler = (await load()).default;
    const j = await (await handler(GET())).json();
    assert.equal(j.ok, true);
    assert.equal(j.layout, 'new');
    assert.equal(j.persistent, false);
    assert.ok(j.note);
    const r = await handler(POST({ layout: 'classic' }));
    assert.equal(r.status, 409);
    const k = await r.json();
    assert.equal(k.ok, false);
    assert.match(k.error, /cannot be changed here/);
  } finally { process.env.FIREBASE_SA = sa; }
});
