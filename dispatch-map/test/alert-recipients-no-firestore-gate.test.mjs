// STAFF MOBILE NUMBERS STAY BEHIND SIGN-IN ON A DEPLOY WITH FIRESTORE OFF.
//
// alert-recipients-config's GET is gated at viewer because its body carries personal mobile
// numbers (FLAG_SMS_TO / FLAG_SMS_TO_NIGHT). The no-Firestore branch — a preview build without
// FIREBASE_SA, or a UAT mirror missing FIRESTORE_DATABASE, either of which can carry
// production's env — returned the resolved env lists BEFORE that gate ran, so with
// AUTH_REQUIRED=true an anonymous caller still got every number. The POST on the same branch
// echoed the same payload without the admin gate.
//
// Phone numbers are 555-01xx fixtures, never real ones.
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.FIREBASE_SA;             // Firestore off: the degraded branch
process.env.NUVIZZ_BASE_URL = '';
delete process.env.FIRESTORE_DATABASE;
process.env.AUTH_SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';

const P1 = '6785550101';
const P2 = '4045550123';
const NIGHT = '7705550199';

const url = 'https://x.netlify.app/.netlify/functions/alert-recipients-config';
const load = () => import('../netlify/functions/alert-recipients-config.mts').then((m) => m.default);

function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

test('with sign-in required and Firestore off, an anonymous caller does not get the flag-text mobile numbers', () =>
  withEnv({ AUTH_REQUIRED: 'true', FLAG_SMS_TO: `${P1},${P2}`, FLAG_SMS_TO_NIGHT: NIGHT }, async () => {
    const handler = await load();
    const r = await handler(new Request(url));
    const text = await r.text();
    assert.equal(r.status, 401, text);
    for (const p of [P1, P2, NIGHT]) assert.ok(!text.includes(p), `${p} must not be in an anonymous response`);

    const post = await handler(new Request(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flagSmsTo: [P1] }),
    }));
    const postText = await post.text();
    assert.equal(post.status, 401, postText);
    for (const p of [P1, P2, NIGHT]) assert.ok(!postText.includes(p), `${p} must not be in an anonymous POST response`);
  }));

test('with sign-in not yet required, the no-Firestore panel still renders the env lists exactly as before', () =>
  withEnv({ AUTH_REQUIRED: undefined, FLAG_SMS_TO: `${P1},${P2}`, FLAG_SMS_TO_NIGHT: NIGHT }, async () => {
    const handler = await load();
    const r = await handler(new Request(url));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.persistent, false);
    assert.ok(j.note);
    assert.deepEqual(j.channels.find((c) => c.key === 'flagSmsTo').recipients, [P1, P2]);
    assert.deepEqual(j.channels.find((c) => c.key === 'flagSmsToNight').recipients, [NIGHT]);
  }));
