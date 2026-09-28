// test/require-user-fresh-token-after-bump.test.mjs — X-authgates-1.
//
// requireUser keeps a 30-second per-instance cache of user documents. On a tokenVersion
// mismatch it refused straight off that cache — so the moment a user's tokenVersion was bumped
// (password changed, password reset, "sign out everywhere", an admin's role change), the FRESH
// token issued with the new version was refused as "session revoked" by any warm instance that
// had read the user in the last 30 seconds. The dispatcher who just did the right thing was
// signed straight back out.
//
// A token can only carry a tokenVersion the store once held, so a cached document whose version
// is LOWER than the token's is stale, not a revocation: re-read the store once and decide on
// that. A cached version HIGHER than the token's is a real revocation and is still refused off
// the cache, with no extra read.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';
process.env.AUTH_REQUIRED = 'true';

import { installFirestoreFake } from './_firestore-fake.mjs';
import { issueSessionToken } from '../netlify/functions/lib/auth-core.mts';
import { requireUser, _resetUserCacheForTests } from '../netlify/functions/lib/require-user.mts';
import { getUser, bumpTokenVersion } from '../netlify/functions/lib/auth-store.mts';

const USER = { username: 'dee', displayName: 'Dee', role: 'dispatcher', active: true, tokenVersion: 0 };
const withToken = (u) => new Request('https://x.netlify.app/.netlify/functions/anything', {
  headers: { authorization: `Bearer ${issueSessionToken(u).token}` },
});

test('a dispatcher who signs out everywhere is not refused on the fresh token the server just handed them', async () => {
  _resetUserCacheForTests();
  const fake = installFirestoreFake({ 'app_users/dee': { ...USER } }, undefined, { commitSemantics: true });
  try {
    // A warm instance reads the user on the old session: the cache now holds tokenVersion 0.
    assert.equal((await requireUser(withToken(USER), { role: 'viewer' })).ok, true);

    const tv = await bumpTokenVersion(await getUser('dee'));
    assert.equal(tv, 1);
    assert.equal(fake.store.get('app_users/dee').tokenVersion, 1, 'the store really moved');

    const fresh = await requireUser(withToken({ ...USER, tokenVersion: tv }), { role: 'viewer' });
    assert.equal(fresh.ok, true, `fresh token refused: ${fresh.ok ? '' : fresh.reason}`);
    assert.equal(fresh.ok && fresh.user.tokenVersion, 1);
  } finally { fake.restore(); }
});

test('the OLD session is still refused after the bump — the cache never lets a revoked token back in', async () => {
  _resetUserCacheForTests();
  const fake = installFirestoreFake({ 'app_users/dee': { ...USER } }, undefined, { commitSemantics: true });
  try {
    await bumpTokenVersion(await getUser('dee'));
    const fresh = await requireUser(withToken({ ...USER, tokenVersion: 1 }), { role: 'viewer' });
    assert.equal(fresh.ok, true);                         // cache now holds tokenVersion 1
    const old = await requireUser(withToken(USER), { role: 'viewer' });
    assert.equal(old.ok, false);
    assert.equal(!old.ok && old.reason, 'revoked');
  } finally { fake.restore(); }
});

test('a revoked token polling the board does not cost a store read per request', async () => {
  // The re-read is only for a cache that is BEHIND the token. A token that is behind the cache
  // is plainly revoked and is refused off the cache, so an old phone left polling cannot turn
  // the 30-second cache into one Firestore read per poll.
  _resetUserCacheForTests();
  const fake = installFirestoreFake({ 'app_users/dee': { ...USER, tokenVersion: 3 } }, undefined, { commitSemantics: true });
  try {
    const old = withToken({ ...USER, tokenVersion: 2 });
    assert.equal((await requireUser(old, { role: 'viewer' })).ok, false);
    const readsAfterFirst = fake.log.gets.length;
    for (let i = 0; i < 5; i++) assert.equal((await requireUser(withToken({ ...USER, tokenVersion: 2 }), { role: 'viewer' })).ok, false);
    assert.equal(fake.log.gets.length, readsAfterFirst, 'no extra reads for a token older than the cache');
  } finally { fake.restore(); }
});

test('a token claiming a version the store has never held is still refused after the one re-read', async () => {
  _resetUserCacheForTests();
  const fake = installFirestoreFake({ 'app_users/dee': { ...USER } }, undefined, { commitSemantics: true });
  try {
    assert.equal((await requireUser(withToken(USER), { role: 'viewer' })).ok, true);
    const before = fake.log.gets.length;
    const forged = await requireUser(withToken({ ...USER, tokenVersion: 7 }), { role: 'viewer' });
    assert.equal(forged.ok, false);
    assert.equal(!forged.ok && forged.reason, 'revoked');
    assert.equal(fake.log.gets.length, before + 1, 'exactly one re-read, then the refusal');
  } finally { fake.restore(); }
});
