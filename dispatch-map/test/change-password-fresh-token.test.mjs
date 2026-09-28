// test/change-password-fresh-token.test.mjs — A5-S25-10.
//
// auth-change-password gates itself with requireUser (which caches the user doc at the OLD
// tokenVersion), bumps the version, and hands back a fresh token. On that same warm instance —
// and on any other that read the user in the last 30 seconds — the fresh token was refused as
// "session revoked", so changing your password signed you out of the session you changed it
// from. The endpoint needs no change: the fix is in require-user (see
// require-user-fresh-token-after-bump.test.mjs); this pins the end-to-end flow a user performs.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';
process.env.AUTH_REQUIRED = 'true';

import { installFirestoreFake } from './_firestore-fake.mjs';
import { issueSessionToken, hashPassword } from '../netlify/functions/lib/auth-core.mts';
import { requireUser, _resetUserCacheForTests, _resetThrottleForTests } from '../netlify/functions/lib/require-user.mts';
import changePassword from '../netlify/functions/auth-change-password.mts';

test('a dispatcher who changes their password keeps working on the new token instead of being signed straight back out', async () => {
  _resetUserCacheForTests();
  _resetThrottleForTests();
  const user = {
    username: 'dee', displayName: 'Dee', role: 'dispatcher', active: true, tokenVersion: 0,
    passwordHash: await hashPassword('old-password-1234'),
  };
  const fake = installFirestoreFake({ 'app_users/dee': { ...user } }, undefined, { commitSemantics: true });
  try {
    const oldToken = issueSessionToken(user).token;
    const r = await changePassword(new Request('https://x.netlify.app/.netlify/functions/auth-change-password', {
      method: 'POST',
      headers: { authorization: `Bearer ${oldToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'old-password-1234', newPassword: 'brand-new-password-5678' }),
    }));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(fake.store.get('app_users/dee').tokenVersion, 1, 'every other session was revoked');

    // The very next request the app makes, on the same warm instance, with the token it was given.
    const next = await requireUser(new Request('https://x.netlify.app/.netlify/functions/anything', {
      headers: { authorization: `Bearer ${body.token}` },
    }), { role: 'viewer' });
    assert.equal(next.ok, true, `new token refused: ${next.ok ? '' : next.reason}`);

    // And the session the password was changed FROM is gone, as the endpoint promises.
    const stale = await requireUser(new Request('https://x.netlify.app/.netlify/functions/anything', {
      headers: { authorization: `Bearer ${oldToken}` },
    }), { role: 'viewer' });
    assert.equal(stale.ok, false);
  } finally { fake.restore(); }
});
