// test/address-queue-identity-refusal.test.mjs
//
// A PERSONAL-LOGIN REFUSAL WAS REPORTED AS "WRITES SWITCHED OFF" OR "BREAKER OPEN"
// (audit 2026-09-27, app-A3-4).
//
// Under NUVIZZ_PERSONAL_LOGINS=required, nuvizz-write refuses a write that has no personal NuVizz
// login behind it, with the identity's own status (403, or 503 when the account store could not be
// read) and a sentence naming the one thing to fix. The problem-address queue's verdict mapper read
// every non-role 403 as NUVIZZ_WRITE_ENABLED being off and every 503 as the call breaker, and threw
// the server's sentence away. So a dispatcher with no saved login was told live writes are off
// server-side, and a one-off store blip stopped the group run with "no further writes will go out
// today" — while the app-wide login bar said "try the Save again in a moment".
//
// These feed the REAL server refusal (resolveIdentity + publicIdentity, as nuvizz-write.mts
// answers it) into the REAL classifyPushResult sliced out of App.jsx.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { addressReachedNuvizz } from '../src/lib/nuvizzWrite.js';
import { resolveIdentity, publicIdentity } from '../netlify/functions/lib/nuvizz-identity.mts';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  return APP.slice(start, next > 0 ? next : undefined);
}
// eslint-disable-next-line no-new-func
const classifyPushResult = new Function('addressReachedNuvizz',
  `'use strict';\n${fnSource('classifyPushResult')}\nreturn classifyPushResult;`)(addressReachedNuvizz);

/** What callWrite hands back for nuvizz-write.mts's identity refusal (step 4b). */
function refusedAnswer(input) {
  const id = resolveIdentity({ mode: 'required', open: () => null, ...input });
  assert.equal(id.kind, 'refused', 'the fixture must be a real refusal');
  return { ok: false, op: 'setStopAddress', error: id.error, identity: publicIdentity(id, 'required'), httpStatus: id.status };
}
const jane = { username: 'jane', authenticated: true };

test('a dispatcher with no NuVizz login saved is sent to Account & logins, not told writes are switched off', () => {
  const j = refusedAnswer({ principal: jane, doc: {} });
  assert.equal(j.httpStatus, 403);
  const v = classifyPushResult(j);
  assert.equal(v.text, j.error, 'the server’s own sentence');
  assert.match(v.text, /Account & logins/);
  assert.doesNotMatch(v.text, /NUVIZZ_WRITE_ENABLED/);
  assert.equal(v.fatal, true, 'every row after it would be refused the same way — the run still stops');
});

test('an account-store blip says "try again in a moment", not "breaker open — no further writes today"', () => {
  const j = refusedAnswer({ principal: jane, doc: null, docUnavailable: true });
  assert.equal(j.httpStatus, 503);
  const v = classifyPushResult(j);
  assert.match(v.text, /try the Save again in a moment/);
  assert.doesNotMatch(v.text, /breaker/);
  assert.doesNotMatch(v.text, /no further writes/);
});

test('the real switch-off and breaker answers still read as they did', () => {
  // nuvizz-write.mts step 2: no `identity` on the answer at all.
  const off = classifyPushResult({ ok: false, httpStatus: 403, error: 'live writes disabled — set NUVIZZ_WRITE_ENABLED=true to enable' });
  assert.equal(off.kind, 'switch');
  assert.match(off.text, /NUVIZZ_WRITE_ENABLED/);
  const breaker = classifyPushResult({ ok: false, httpStatus: 503, error: 'breaker open' });
  assert.equal(breaker.kind, 'breaker');
  const role = classifyPushResult({ ok: false, httpStatus: 403, error: 'requires dispatcher' });
  assert.equal(role.kind, 'role');
});

test('a write that went out under the shared login is not mistaken for a refusal', () => {
  const v = classifyPushResult({ ok: true, httpStatus: 200, identity: { mode: 'preferred', as: 'shared', why: 'not-saved' }, result: { now: '1 MAIN ST' } });
  assert.equal(v.kind, 'ok');
});
