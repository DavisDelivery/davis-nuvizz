// test/account-view.test.mjs — the sentences the Account & logins screen says about a login.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fmtWhen, fmtDay, modeSentence, nuvizzBadge, checkLine, readiness, rolloutSteps,
  newPersonProblem, nuvizzUsernameProblem, USERNAME_RE, ROLE_CHOICES,
} from '../src/lib/account-view.js';
import { USERNAME_RE as SERVER_USERNAME_RE, ROLES, normalizeUsername } from '../netlify/functions/lib/auth-core.mts';
import { normalizeNuvizzUsername } from '../netlify/functions/lib/nuvizz-identity.mts';

test('dates: the house shape in Eastern time, never ISO; absent is "never"', () => {
  assert.equal(fmtWhen('2026-09-27T00:41:00Z'), 'Sep 26, 2026, 8:41 PM');
  assert.equal(fmtDay('2026-09-27T00:41:00Z'), 'Sep 26, 2026');
  assert.equal(fmtWhen(null), 'never');
  assert.equal(fmtWhen('not a date'), '—');
});

test('mode sentences name what happens to a change, and an unknown mode says it is unknown', () => {
  assert.match(modeSentence('preferred'), /own NuVizz login when they have a working one/);
  assert.match(modeSentence('required'), /refused/);
  assert.match(modeSentence('off'), /shared login/);
  assert.match(modeSentence(undefined), /Could not read/);
});

const saved = (over = {}) => ({ saved: true, username: 'jdoe', savedAt: '2026-09-26T20:00:00Z', savedBy: 'owner', check: null, rejected: null, ...over });

test('badge: nothing saved — and what that means for a change, per mode', () => {
  assert.equal(nuvizzBadge(null).tone, 'none');
  assert.match(nuvizzBadge({ saved: false }, 'preferred').detail, /shared login until one is saved/);
  assert.match(nuvizzBadge({ saved: false }, 'required').detail, /refused until one is saved/);
  assert.match(nuvizzBadge({ saved: false }, 'off').detail, /switched off/);
});

test('badge: saved is NOT working — untested reads as a warning', () => {
  const b = nuvizzBadge(saved());
  assert.equal(b.tone, 'warn');
  assert.match(b.label, /not tested/);
});

test('badge: working only when NuVizz said yes and no side said no', () => {
  assert.equal(nuvizzBadge(saved({ check: { at: 't', api: 'ok', portal: 'ok' } })).tone, 'ok');
  assert.equal(nuvizzBadge(saved({ check: { at: 't', api: 'ok', portal: 'skipped' } })).tone, 'ok', 'Route Workbench off on this site');
  assert.equal(nuvizzBadge(saved({ check: { at: 't', api: 'skipped', portal: 'skipped' } })).tone, 'warn', 'a mirror site asked nobody');
  assert.equal(nuvizzBadge(saved({ check: { at: 't', api: 'unknown', portal: 'ok' } })).tone, 'warn');
  assert.match(nuvizzBadge(saved({ check: { at: 't', api: 'unknown', portal: 'ok' } })).detail, /the API/);
  assert.equal(nuvizzBadge(saved({ check: { at: 't', api: 'ok', portal: 'refused', portalDetail: 'NuVizz said: Invalid' } })).tone, 'bad');
});

test('badge: a refusal recorded during a Save wins over an old good test, and says what happens now', () => {
  const b = nuvizzBadge(saved({ check: { at: 't', api: 'ok', portal: 'ok' }, rejected: { at: '2026-09-27T00:41:00Z', reason: 'NuVizz answered 401' } }), 'preferred');
  assert.equal(b.tone, 'bad');
  assert.match(b.detail, /NuVizz answered 401/);
  assert.match(b.detail, /shared login until then/);
  assert.match(nuvizzBadge(saved({ rejected: { at: 't', reason: null } }), 'required').detail, /refused until then/);
});

test('badge: working under the off switch still says changes use the shared login', () => {
  const b = nuvizzBadge(saved({ check: { at: 't', api: 'ok', portal: 'ok' } }), 'off');
  assert.equal(b.tone, 'ok');
  assert.match(b.detail, /switched off/);
});

test('check line: both sides, the raw status, the calls it cost', () => {
  assert.equal(checkLine(null), 'Not tested yet.');
  const line = checkLine({ at: '2026-09-27T00:41:00Z', api: 'ok', apiStatus: 404, portal: 'ok', calls: 5 });
  assert.equal(line, 'Route Workbench accepted · API accepted (HTTP 404) · 5 NuVizz calls · Sep 26, 2026, 8:41 PM');
  assert.match(checkLine({ at: 't', api: 'skipped', portal: 'refused', calls: 1 }), /refused · API not asked · 1 NuVizz call ·/);
});

const person = (username, role, over = {}) => ({ username, role, active: true, lastLoginAt: '2026-09-26T12:00:00Z', nuvizz: saved({ check: { at: 't', api: 'ok', portal: 'ok' } }), ...over });

test('readiness: only active accounts count, and viewers are not waited on for a NuVizz login', () => {
  const r = readiness([
    person('owner', 'admin'),
    person('jane', 'dispatcher'),
    person('mike', 'dispatcher', { nuvizz: { saved: false } }),
    person('pat', 'dispatcher', { nuvizz: saved({ rejected: { at: 't', reason: 'x' } }) }),
    person('rv', 'viewer', { nuvizz: { saved: false }, lastLoginAt: null }),
    person('gone', 'dispatcher', { active: false, nuvizz: { saved: false }, lastLoginAt: null }),
  ]);
  assert.deepEqual(r, { total: 5, writers: 4, nuvizzOk: 2, nuvizzBad: 1, nuvizzMissing: 1, neverSignedIn: 1, locked: 0 });
});

test('rollout: every step reads its state from something reported — the rules deploy says it cannot', () => {
  const steps = rolloutSteps({ loginMode: 'off', configured: true, authRequired: false, mode: 'preferred', users: [person('owner', 'admin'), person('jane', 'dispatcher')] });
  const by = Object.fromEntries(steps.map((s) => [s.key, s]));
  assert.equal(by.secret.state, 'done');
  assert.equal(by.rules.state, 'unknown');
  assert.match(by.rules.detail, /cannot read this/);
  assert.equal(by.accounts.state, 'done');
  assert.equal(by.nuvizz.state, 'done');
  assert.equal(by.signedin.state, 'done');
  assert.equal(by.gate.state, 'todo');
  assert.match(by.gate.detail, /build-time/);
  assert.equal(by.enforce.state, 'todo');
  assert.equal(by.required.state, 'optional');
  // The order IS the procedure: accounts before the lock, the lock before enforcement.
  assert.deepEqual(steps.map((s) => s.key), ['secret', 'rules', 'accounts', 'nuvizz', 'signedin', 'gate', 'enforce', 'required']);
});

test('rollout: no answer from the server is "unknown", never a tick', () => {
  const by = Object.fromEntries(rolloutSteps({ loginMode: 'server', configured: null, authRequired: null, mode: 'required', users: [] }).map((s) => [s.key, s]));
  assert.equal(by.secret.state, 'unknown');
  assert.equal(by.enforce.state, 'unknown');
  assert.equal(by.gate.state, 'done');
  assert.equal(by.required.state, 'done');
  assert.equal(by.nuvizz.state, 'todo', 'nobody to be ready is not ready');
});

// ── the form rules match the server's ────────────────────────────────────────

test('the username rule is the server\'s, character for character', () => {
  assert.equal(USERNAME_RE.source, SERVER_USERNAME_RE.source);
  for (const u of ['jane', 'j2', 'jane_doe', 'jane-doe', 'a'.repeat(40), 'x', '-jane', 'Jane', 'jane.doe', 'a'.repeat(41), 'ja ne']) {
    // Both sides lower-case first (the username IS the document id), so "Jane" is jane on both.
    assert.equal(newPersonProblem({ username: u, role: 'dispatcher' }) === null, normalizeUsername(u) !== null, u);
  }
});

test('the role choices are the server\'s roles, and nothing else', () => {
  assert.deepEqual(ROLE_CHOICES.map((r) => r.value).sort(), [...ROLES].sort());
});

test('new person: a bad email and a missing role are named', () => {
  assert.match(newPersonProblem({ username: 'jane', email: 'not-an-email', role: 'dispatcher' }), /email/);
  assert.match(newPersonProblem({ username: 'jane', role: 'boss' }), /role/);
  assert.equal(newPersonProblem({ username: 'jane', email: '', role: 'viewer' }), null);
});

test('the NuVizz username rule matches the server\'s', () => {
  for (const v of ['jdoe', 'jane.doe@example.com', 'j:doe', 'j doe', '', 'x'.repeat(121)]) {
    assert.equal(nuvizzUsernameProblem(v) === null, normalizeNuvizzUsername(v) !== null, JSON.stringify(v));
  }
});
