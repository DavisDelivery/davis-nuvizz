// test/admin-set-password.test.mjs — an admin TYPES a person's password.
//
// Chad, 2026-10-03, looking at a row that still read "Temporary password": "I want to be able to
// set their password, reset it …". Until then the only password an admin could give anyone was a
// generated one the person had to replace, and — before sign-in is switched on — nothing made
// them replace it, so the row said "Temporary password" for as long as nobody did.
//
// The rules are pinned twice: as pure functions (auth-core), and through the REAL handlers
// (auth-users, auth-login, auth-reset-confirm) over an in-memory Firestore with real session
// tokens and real scrypt — so "the person can sign in with it" is something a test did, not
// something a test read.
//
// Each test names the morning it prevents.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';
delete process.env.AUTH_REQUIRED;
delete process.env.RESEND_API_KEY;

import { installFirestoreFake } from './_firestore-fake.mjs';
import {
  adminSetPasswordPlan, newAccountPasswordPlan, typedPasswordEdgeProblem, passwordProblem, issueSessionToken,
  hashPassword, verifyPassword, newResetToken, PASSWORD_MIN,
} from '../netlify/functions/lib/auth-core.mts';
import { publicUser } from '../netlify/functions/lib/auth-store.mts';
import { requireUser, _resetUserCacheForTests, _resetThrottleForTests } from '../netlify/functions/lib/require-user.mts';
import usersHandler from '../netlify/functions/auth-users.mts';
import loginHandler from '../netlify/functions/auth-login.mts';
import resetConfirmHandler from '../netlify/functions/auth-reset-confirm.mts';

const GOOD = 'Dock-door-9-at-5am';
const OLD = 'old-password-1234';

// ── the rule, pure ───────────────────────────────────────────────────────────

test('a password the admin sets is the person\'s to keep unless the admin says otherwise', () => {
  assert.deepEqual(adminSetPasswordPlan({ actor: 'owner', target: 'dee', password: GOOD }), { ok: true, mustChange: false });
  assert.deepEqual(adminSetPasswordPlan({ actor: 'owner', target: 'dee', password: GOOD, mustChange: false }), { ok: true, mustChange: false });
  assert.deepEqual(adminSetPasswordPlan({ actor: 'owner', target: 'dee', password: GOOD, mustChange: null }), { ok: true, mustChange: false });
  assert.deepEqual(adminSetPasswordPlan({ actor: 'owner', target: 'dee', password: GOOD, mustChange: true }), { ok: true, mustChange: true });
});

test('an admin cannot use it on their own account — that path asks for the current password', () => {
  const r = adminSetPasswordPlan({ actor: 'owner', target: 'owner', password: GOOD });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.error, /your own password/);
  assert.match(r.error, /Change password/);
});

test('an admin typing it does not make a weak password acceptable — the site\'s one policy applies', () => {
  const short = adminSetPasswordPlan({ actor: 'owner', target: 'dee', password: 'short' });
  assert.equal(short.ok, false);
  assert.equal(short.status, 400);
  assert.match(short.error, new RegExp(`at least ${PASSWORD_MIN}`));
  assert.match(adminSetPasswordPlan({ actor: 'owner', target: 'dee', password: 'dee-is-on-dock-9' }).error, /username/);
  assert.match(adminSetPasswordPlan({ actor: 'owner', target: 'dee', password: 'aaaaaaaaaaaa' }).error, /repeated/);
});

test('the absent and the malformed are refused, never read as a password or as a yes', () => {
  for (const password of [undefined, null, '', 12345678901, {}, ['x']]) {
    const r = adminSetPasswordPlan({ actor: 'owner', target: 'dee', password });
    assert.equal(r.ok, false, `password ${JSON.stringify(password)}`);
    assert.equal(r.error, 'password required');
  }
  for (const mustChange of ['true', 'false', 1, 0, 'yes', {}]) {
    const r = adminSetPasswordPlan({ actor: 'owner', target: 'dee', password: GOOD, mustChange });
    assert.equal(r.ok, false, `mustChange ${JSON.stringify(mustChange)}`);
    assert.equal(r.error, 'mustChange must be true or false');
  }
  assert.equal(adminSetPasswordPlan({ actor: 'owner', target: '', password: GOOD }).ok, false);
});

test('a password the admin will TELL someone cannot start or end with a space — the part that goes missing when it is said aloud', () => {
  for (const pw of [`${GOOD} `, ` ${GOOD}`, `  ${GOOD}`, `${GOOD}\t`, `${GOOD}\n`]) {
    assert.equal(typedPasswordEdgeProblem(pw), 'password cannot start or end with a space', JSON.stringify(pw));
    const set = adminSetPasswordPlan({ actor: 'owner', target: 'dee', password: pw });
    assert.equal(set.ok, false);
    assert.equal(set.status, 400);
    assert.equal(set.error, 'password cannot start or end with a space');
    assert.equal(newAccountPasswordPlan({ username: 'dee', password: pw, mustChange: false }).error, 'password cannot start or end with a space');
  }
  // Spaces INSIDE are a passphrase and are fine; nothing typed is not this rule's business.
  assert.equal(typedPasswordEdgeProblem('four words at 5am'), null);
  assert.equal(adminSetPasswordPlan({ actor: 'owner', target: 'dee', password: 'four words at 5am' }).ok, true);
  for (const nothing of ['', null, undefined, 12]) assert.equal(typedPasswordEdgeProblem(nothing), null);
  // And it is NOT the site-wide policy: a person choosing their own password is not refused for it.
  assert.equal(passwordProblem(`${GOOD} `, 'dee'), null);
});

test('creating an account: a password nobody typed is temporary, always', () => {
  assert.deepEqual(newAccountPasswordPlan({ username: 'dee' }), { ok: true, typed: false, mustChange: true });
  assert.deepEqual(newAccountPasswordPlan({ username: 'dee', password: '' }), { ok: true, typed: false, mustChange: true });
  assert.deepEqual(newAccountPasswordPlan({ username: 'dee', mustChange: true }), { ok: true, typed: false, mustChange: true });
  // What the endpoint has always done with a password that is not a string: generate one.
  assert.deepEqual(newAccountPasswordPlan({ username: 'dee', password: 12345678901 }), { ok: true, typed: false, mustChange: true });
  // A generated password the person keeps is refused: nobody chose it, and its only copy is the
  // one shown once on the admin's screen.
  const keep = newAccountPasswordPlan({ username: 'dee', mustChange: false });
  assert.equal(keep.ok, false);
  assert.match(keep.error, /temporary/);
});

test('creating an account: a typed password is replaced at sign-in as it always was, unless the admin says they keep it', () => {
  assert.deepEqual(newAccountPasswordPlan({ username: 'dee', password: GOOD }), { ok: true, typed: true, mustChange: true });
  assert.deepEqual(newAccountPasswordPlan({ username: 'dee', password: GOOD, mustChange: true }), { ok: true, typed: true, mustChange: true });
  assert.deepEqual(newAccountPasswordPlan({ username: 'dee', password: GOOD, mustChange: false }), { ok: true, typed: true, mustChange: false });
  assert.match(newAccountPasswordPlan({ username: 'dee', password: 'short' }).error, /at least/);
  assert.match(newAccountPasswordPlan({ username: 'dee', password: 'dee-is-on-dock-9' }).error, /username/);
  assert.equal(newAccountPasswordPlan({ username: 'dee', password: GOOD, mustChange: 'no' }).error, 'mustChange must be true or false');
});

// ── through the real handlers ────────────────────────────────────────────────

const USERS_URL = 'https://x.netlify.app/.netlify/functions/auth-users';
const OWNER = { username: 'owner', displayName: 'The Owner', role: 'admin', active: true, tokenVersion: 0 };
const DEE = { username: 'dee', displayName: 'Dee', role: 'dispatcher', active: true, tokenVersion: 0, mustChangePassword: true, failedAttempts: 0, lockedUntil: null };

async function world(overrides, fn) {
  _resetUserCacheForTests();
  _resetThrottleForTests();
  const seed = {
    'app_users/owner': { ...OWNER, passwordHash: await hashPassword('the-owners-own-password') },
    'app_users/dee': { ...DEE, passwordHash: await hashPassword(OLD), ...(overrides || {}) },
    'app_users/ops2': { username: 'ops2', displayName: 'Second Dispatcher', role: 'dispatcher', active: true, tokenVersion: 0, passwordHash: await hashPassword('ops2-own-password-77') },
  };
  const fake = installFirestoreFake(seed, undefined, { commitSemantics: true });
  // The log is part of the contract: a password an admin types must never reach it.
  const lines = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try { return await fn({ fake, lines, dee: () => fake.store.get('app_users/dee') }); }
  finally { Object.assign(console, real); fake.restore(); }
}

const as = (u) => ({ authorization: `Bearer ${issueSessionToken(u).token}` });
const post = (who, body) => usersHandler(new Request(USERS_URL, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(who ? as(who) : {}) }, body: JSON.stringify(body),
}));
const signIn = (username, password) => loginHandler(new Request('https://x.netlify.app/.netlify/functions/auth-login', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
}));

test('the admin types a password and the person signs in with it — not asked to change it, and the old one is dead', async () => {
  await world({}, async ({ dee, lines }) => {
    const startedAt = Date.now();
    const res = await post(OWNER, { action: 'set-password', username: 'dee', password: GOOD });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.mustChange, false);
    assert.equal(body.user.mustChangePassword, false, 'the row no longer reads "Temporary password"');
    assert.ok(body.user.passwordChangedAt, 'and says when the password was put there');

    assert.equal(await verifyPassword(GOOD, dee().passwordHash), true);
    assert.equal(await verifyPassword(OLD, dee().passwordHash), false);
    assert.equal(dee().mustChangePassword, false);
    // The stamp is THIS save's time — not a constant, not the old one.
    const stamped = Date.parse(dee().passwordChangedAt);
    assert.ok(stamped >= startedAt && stamped <= Date.now(), `passwordChangedAt ${dee().passwordChangedAt}`);
    assert.equal(body.user.passwordChangedAt, dee().passwordChangedAt, 'and the answer carries the stored one');

    const good = await signIn('dee', GOOD);
    const session = await good.json();
    assert.equal(good.status, 200, JSON.stringify(session));
    assert.equal(session.user.mustChangePassword, false, 'the board opens — no "choose a password" screen first');
    assert.equal((await signIn('dee', OLD)).status, 401);

    // Typed by an admin, hashed, and nowhere else: not in the answer, not in the log.
    assert.ok(!JSON.stringify(body).includes(GOOD), 'never echoed back');
    assert.ok(!JSON.stringify(body).includes('scrypt$'), 'and never the hash');
    assert.ok(!lines.some((l) => l.includes(GOOD)), `logged: ${lines.join(' | ')}`);
    assert.ok(lines.some((l) => /owner set password user=dee mustChange=false/.test(l)), 'who did it to whom IS logged');
  });
});

test('it is ONE write: the new password, the cleared lockout, the dead reset link and the sign-out land together or not at all', async () => {
  const { hash } = newResetToken();
  await world({ failedAttempts: 8, lockedUntil: new Date(Date.now() + 600_000).toISOString(), resetTokenHash: hash, resetExpiresAt: new Date(Date.now() + 600_000).toISOString() }, async ({ fake }) => {
    assert.equal((await post(OWNER, { action: 'set-password', username: 'dee', password: GOOD })).status, 200);
    // Exactly one commit, and nothing written any other way (a PATCH would be a second write —
    // and a moment at which the new password and the old sessions were both good, or neither).
    assert.equal(fake.log.commits.length, 1, `commits: ${fake.log.commits.length}`);
    assert.equal(fake.log.sets.length, 0, `separate writes: ${JSON.stringify(fake.log.sets.map((x) => x.path))}`);
    const [write] = fake.log.commits[0].writes;
    assert.match(write.update.name, /\/app_users\/dee$/);
    for (const f of ['passwordHash', 'passwordChangedAt', 'mustChangePassword', 'resetTokenHash', 'resetExpiresAt', 'failedAttempts', 'lockedUntil']) {
      assert.ok(write.updateMask.fieldPaths.includes(f), `the commit sets ${f}`);
    }
    assert.deepEqual(write.updateTransforms.map((t) => t.fieldPath), ['tokenVersion'], 'and bumps the session version in the same write');
    assert.deepEqual(write.currentDocument, { exists: true }, 'on a record that must already exist — never a silent create');
  });
});

test('the store hiccups right after the write: the admin is still told it worked, because it did', async () => {
  await world({}, async ({ fake, dee, lines }) => {
    // The handler reads dee, commits, then reads dee back. Fail that LAST read only.
    const real = globalThis.fetch;
    let committed = false;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input?.url ?? input);
      if (url.includes(':commit')) committed = true;
      else if (committed && url.includes('/app_users/dee') && (init.method || 'GET').toUpperCase() === 'GET') return new Response('unavailable', { status: 503 });
      return real(input, init);
    };
    let res;
    try { res = await post(OWNER, { action: 'set-password', username: 'dee', password: GOOD, mustChange: true }); }
    finally { globalThis.fetch = real; }
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    // Answered from what was just written — and still never the hash.
    assert.equal(body.user.username, 'dee');
    assert.equal(body.user.mustChangePassword, true);
    assert.ok(body.user.passwordChangedAt);
    assert.ok(!JSON.stringify(body).includes('scrypt$'));
    assert.equal(await verifyPassword(GOOD, dee().passwordHash), true, 'the write really had landed');
    assert.ok(lines.some((l) => /read-back failed/.test(l)), 'and the failed read is in the log, not swallowed');
    assert.ok(fake.log.commits.length === 1);
  });
});

test('an account that is turned off: the password is set, and sign-in is still refused until the account is on', async () => {
  await world({ active: false }, async ({ dee }) => {
    const res = await post(OWNER, { action: 'set-password', username: 'dee', password: GOOD });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.user.active, false, 'the answer says so, which is what the screen\'s sentence reads');
    assert.equal(await verifyPassword(GOOD, dee().passwordHash), true);
    assert.equal((await signIn('dee', GOOD)).status, 401);
  });
});

test('a trailing space typed by the admin is refused by the server too, and nothing is written', async () => {
  await world({}, async ({ fake, dee }) => {
    const res = await post(OWNER, { action: 'set-password', username: 'dee', password: `${GOOD} ` });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'password cannot start or end with a space');
    assert.equal(await verifyPassword(OLD, dee().passwordHash), true);
    assert.equal(fake.log.commits.length, 0);
    const made = await post(OWNER, { action: 'create', username: 'ops8', displayName: 'Eighth', role: 'dispatcher', password: ` ${GOOD}`, mustChange: false });
    assert.equal(made.status, 400);
    assert.equal(fake.store.has('app_users/ops8'), false);
  });
});

// "Signed out everywhere" means what it means for every action on this endpoint: the next READ of
// the record refuses the old sessions. A warm function instance re-reads within its 30-second
// cache (require-user.mts), so this test empties that cache to see the refusal immediately — the
// window itself is pinned in test/require-user-fresh-token-after-bump.test.mjs.
test('the sessions the person held are refused as soon as the record is next read — the old password\'s sessions do not outlive it', async () => {
  await world({}, async ({ dee }) => {
    const before = issueSessionToken({ ...DEE }).token;
    const ask = () => requireUser(new Request('https://x.netlify.app/.netlify/functions/anything', { headers: { authorization: `Bearer ${before}` } }), { strict: true });
    assert.equal((await ask()).ok, true, 'the session works before');
    _resetUserCacheForTests();
    assert.equal((await post(OWNER, { action: 'set-password', username: 'dee', password: GOOD })).status, 200);
    assert.equal(dee().tokenVersion, 1);
    _resetUserCacheForTests();
    const after = await ask();
    assert.equal(after.ok, false);
    assert.equal(after.reason, 'revoked');
  });
});

test('asked to, it is a one-time password: it gets them in and they must choose their own', async () => {
  await world({ mustChangePassword: false }, async ({ dee }) => {
    const res = await post(OWNER, { action: 'set-password', username: 'dee', password: GOOD, mustChange: true });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.mustChange, true);
    assert.equal(dee().mustChangePassword, true);
    const session = await (await signIn('dee', GOOD)).json();
    assert.equal(session.user.mustChangePassword, true);
  });
});

test('a dispatcher locked out at 5am gets straight in with the password the admin just set', async () => {
  const lockedUntil = new Date(Date.now() + 10 * 60_000).toISOString();
  await world({ failedAttempts: 8, lockedUntil }, async ({ dee }) => {
    assert.equal((await signIn('dee', OLD)).status, 423, 'locked, even with the right password');
    assert.equal((await post(OWNER, { action: 'set-password', username: 'dee', password: GOOD })).status, 200);
    assert.equal(dee().failedAttempts, 0);
    assert.equal(dee().lockedUntil, null);
    assert.equal((await signIn('dee', GOOD)).status, 200);
  });
});

test('a reset link emailed earlier cannot replace the password the admin set afterwards', async () => {
  const { token, hash } = newResetToken();
  const resetExpiresAt = new Date(Date.now() + 20 * 60_000).toISOString();
  await world({ resetTokenHash: hash, resetExpiresAt, email: 'ops@example.com' }, async ({ dee }) => {
    assert.equal((await post(OWNER, { action: 'set-password', username: 'dee', password: GOOD })).status, 200);
    assert.equal(dee().resetTokenHash, null);
    assert.equal(dee().resetExpiresAt, null);
    const confirm = await resetConfirmHandler(new Request('https://x.netlify.app/.netlify/functions/auth-reset-confirm', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'dee', token, newPassword: 'somebody-elses-choice-1' }),
    }));
    assert.equal(confirm.status, 400);
    assert.equal(await verifyPassword(GOOD, dee().passwordHash), true, 'still the admin\'s password');
  });
});

test('a refusal writes nothing: own account, a weak password, a malformed flag, a person who does not exist', async () => {
  await world({}, async ({ fake, dee }) => {
    const snapshot = () => JSON.stringify([...fake.store.entries()]);
    const before = snapshot();

    const own = await post(OWNER, { action: 'set-password', username: 'owner', password: GOOD });
    assert.equal(own.status, 409);
    assert.match((await own.json()).error, /your own password/);

    const weak = await post(OWNER, { action: 'set-password', username: 'dee', password: 'short' });
    assert.equal(weak.status, 400);
    assert.match((await weak.json()).error, /at least/);

    assert.equal((await post(OWNER, { action: 'set-password', username: 'dee' })).status, 400);
    assert.equal((await post(OWNER, { action: 'set-password', username: 'dee', password: GOOD, mustChange: 'yes' })).status, 400);
    assert.equal((await post(OWNER, { action: 'set-password', username: 'nobody-here', password: GOOD })).status, 404);

    assert.equal(snapshot(), before, 'not one field moved');
    assert.equal(dee().tokenVersion, 0, 'and nobody was signed out by a refused request');
  });
});

test('only an admin may: a dispatcher is refused, and so is a caller with no session — even before sign-in is required', async () => {
  await world({}, async ({ dee }) => {
    const ops2 = { username: 'ops2', displayName: 'Second Dispatcher', role: 'dispatcher', tokenVersion: 0 };
    assert.equal((await post(ops2, { action: 'set-password', username: 'dee', password: GOOD })).status, 403);
    assert.equal((await post(null, { action: 'set-password', username: 'dee', password: GOOD })).status, 401);
    assert.equal(await verifyPassword(OLD, dee().passwordHash), true);
  });
});

test('adding a person with a typed password they keep: no temporary password comes back, and they sign straight in', async () => {
  await world({}, async ({ fake, lines }) => {
    const res = await post(OWNER, { action: 'create', username: 'ops3', displayName: 'Third Dispatcher', role: 'dispatcher', password: GOOD, mustChange: false });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.tempPassword, null, 'the admin typed it; there is nothing to show once');
    assert.equal(body.user.mustChangePassword, false);
    assert.equal(fake.store.get('app_users/ops3').mustChangePassword, false);
    const session = await (await signIn('ops3', GOOD)).json();
    assert.equal(session.ok, true);
    assert.equal(session.user.mustChangePassword, false);
    assert.ok(!JSON.stringify(body).includes(GOOD));
    assert.ok(!lines.some((l) => l.includes(GOOD)));
  });
});

test('adding a person the old ways is unchanged: a typed password is replaced at sign-in, an untyped one is generated and shown once', async () => {
  await world({}, async ({ fake }) => {
    const typed = await (await post(OWNER, { action: 'create', username: 'ops4', displayName: 'Fourth', role: 'dispatcher', password: GOOD })).json();
    assert.equal(typed.ok, true);
    assert.equal(typed.tempPassword, null);
    assert.equal(fake.store.get('app_users/ops4').mustChangePassword, true);

    const made = await (await post(OWNER, { action: 'create', username: 'ops5', displayName: 'Fifth', role: 'viewer' })).json();
    assert.equal(made.ok, true);
    assert.equal(typeof made.tempPassword, 'string');
    assert.equal(fake.store.get('app_users/ops5').mustChangePassword, true);
    assert.equal(await verifyPassword(made.tempPassword, fake.store.get('app_users/ops5').passwordHash), true);
  });
});

test('adding a person: a generated password they would keep is refused, and no account is left behind', async () => {
  await world({}, async ({ fake }) => {
    const res = await post(OWNER, { action: 'create', username: 'ops6', displayName: 'Sixth', role: 'dispatcher', mustChange: false });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /temporary/);
    assert.equal(fake.store.has('app_users/ops6'), false);

    const weak = await post(OWNER, { action: 'create', username: 'ops6', displayName: 'Sixth', role: 'dispatcher', password: 'short', mustChange: false });
    assert.equal(weak.status, 400);
    assert.equal(fake.store.has('app_users/ops6'), false);
  });
});

// ── what the list says afterwards ────────────────────────────────────────────

test('the people list says when each password was put there, and still never carries a hash', async () => {
  await world({ passwordChangedAt: '2026-10-03T19:53:00.000Z' }, async () => {
    const res = await usersHandler(new Request(USERS_URL, { method: 'GET', headers: as(OWNER) }));
    const body = await res.json();
    assert.equal(res.status, 200);
    const row = body.users.find((u) => u.username === 'dee');
    assert.equal(row.passwordChangedAt, '2026-10-03T19:53:00.000Z');
    assert.equal(row.mustChangePassword, true);
    assert.ok(!JSON.stringify(body).includes('scrypt$'));
    assert.ok(!('passwordHash' in row));
  });
});

test('a record that never carried the stamp says null — absent is not a date', () => {
  assert.equal(publicUser({ username: 'dee' }).passwordChangedAt, null);
  assert.equal(publicUser({ username: 'dee', passwordChangedAt: '' }).passwordChangedAt, null);
  assert.equal(publicUser(null).passwordChangedAt, null);
});
