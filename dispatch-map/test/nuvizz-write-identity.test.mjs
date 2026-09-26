// test/nuvizz-write-identity.test.mjs — the write door's brakes on a refused personal login, and
// the in-flight dedupe that must not hand one login another login's answer.
//
// Each test names the night it prevents:
//   • a five-load Save sending a stale password to NuVizz five times (the review measured it);
//   • a login the portal already refused being tried again on the v7 API in the same Save;
//   • Jane's login check coalesced into Mike's, so Jane is handed Mike's 401 and her working
//     login is taken out of service.
import test from 'node:test';
import assert from 'node:assert/strict';

import { watchPersonalRefusals, refusalAfterWrite, resolveWriteIdentity, markLoginRejected } from '../netlify/functions/lib/nuvizz-write-identity.mts';
import { createNuvizzRequester, dedupeKey, credentialFingerprint } from '../netlify/functions/lib/nuvizz-request.mts';

const JANE_AUTH = 'Basic ' + Buffer.from('jdoe:old-password').toString('base64');
const SHARED_AUTH = 'Basic ' + Buffer.from('sharednv:shared-pw').toString('base64');

function nuvizz(statusFor = () => 200) {
  const calls = [];
  return {
    calls,
    request: async (url, opts, meta) => {
      calls.push({ url, auth: opts?.headers?.Authorization ?? opts?.headers?.authorization });
      return new Response('{}', { status: statusFor(opts?.headers?.Authorization) });
    },
    getStats: () => ({ totalThisInstance: calls.length }),
  };
}

test('a stale personal password reaches NuVizz ONCE per Save — then every further try is answered here', async () => {
  const n = nuvizz((auth) => (auth === JANE_AUTH ? 401 : 200));
  let refusedHook = 0;
  const w = watchPersonalRefusals(n, JANE_AUTH, { onRefused: () => { refusedHook++; } });
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await w.requester.request(`https://x/load/info/L${i}/DAVIS`, { headers: { Authorization: JANE_AUTH } }, {})).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401], 'the engine sees the same refusal every time');
  assert.equal(n.calls.length, 1, 'but NuVizz saw the stale password once, not five times');
  assert.equal(w.refusedStatus(), 401);
  assert.equal(w.withheld(), 4);
  assert.equal(refusedHook, 1, 'the portal side is told once, so it holds the login too');
});

test('a withheld request says it was not sent, in words', async () => {
  const n = nuvizz(() => 401);
  const w = watchPersonalRefusals(n, JANE_AUTH);
  await w.requester.request('https://x/a', { headers: { Authorization: JANE_AUTH } }, {});
  const r = await w.requester.request('https://x/b', { headers: { Authorization: JANE_AUTH } }, {});
  assert.match((await r.json()).message, /Not sent: NuVizz already refused this NuVizz login/);
});

test('a login the PORTAL already refused is not sent to the v7 API at all', async () => {
  const n = nuvizz(() => 200);
  const w = watchPersonalRefusals(n, JANE_AUTH, { isHeld: () => true });
  const r = await w.requester.request('https://x/load/info/L1/DAVIS', { headers: { Authorization: JANE_AUTH } }, {});
  assert.equal(r.status, 401);
  assert.equal(n.calls.length, 0);
  assert.equal(w.refusedStatus(), 401, 'the same refusal, for the same Save — so the account gets marked');
});

test('only THIS person\'s header is braked: portal calls and other headers pass straight through', async () => {
  const n = nuvizz((auth) => (auth === JANE_AUTH ? 401 : 200));
  const w = watchPersonalRefusals(n, JANE_AUTH);
  await w.requester.request('https://x/1', { headers: { Authorization: JANE_AUTH } }, {});
  const portal = await w.requester.request('https://portal/rwb', { headers: { authorization: 'Basic ' + Buffer.from('JWT:tok').toString('base64') } }, {});
  assert.equal(portal.status, 200);
  assert.equal(n.calls.length, 2);
});

test('a 403 (permission) is not a wrong password: nothing is braked or marked', async () => {
  const n = nuvizz(() => 403);
  const w = watchPersonalRefusals(n, JANE_AUTH);
  await w.requester.request('https://x/1', { headers: { Authorization: JANE_AUTH } }, {});
  await w.requester.request('https://x/2', { headers: { Authorization: JANE_AUTH } }, {});
  assert.equal(n.calls.length, 2);
  assert.equal(w.refusedStatus(), null);
});

test('the shared login gets the real requester back, untouched', () => {
  const n = nuvizz();
  const w = watchPersonalRefusals(n, null);
  assert.equal(w.requester, n);
  assert.equal(w.refusedStatus(), null);
  assert.equal(w.withheld(), 0);
});

test('refusalAfterWrite: the portal\'s own words win; a v7 401 is named; nothing else is a refusal', () => {
  const personal = { kind: 'personal', appUser: 'jane', nuvizzUser: 'jdoe', password: 'x' };
  assert.equal(refusalAfterWrite(personal, null, { detail: 'NuVizz said: Invalid' }), 'NuVizz said: Invalid');
  assert.match(refusalAfterWrite(personal, 401, null), /401 to the NuVizz login saved as jdoe/);
  assert.equal(refusalAfterWrite(personal, 403, null), null);
  assert.equal(refusalAfterWrite(personal, null, null), null);
  assert.equal(refusalAfterWrite({ kind: 'shared', appUser: null, why: 'off', note: null }, 401, { detail: 'x' }), null);
});

test('resolveWriteIdentity: a presented token that arrived as the pre-login caller is "unavailable", not "not signed in"', async () => {
  const LEGACY = { username: 'legacy', authenticated: false };
  const id = await resolveWriteIdentity('required', LEGACY, { getUser: async () => null }, { tokenPresented: true });
  assert.equal(id.kind, 'refused');
  assert.equal(id.status, 503);
  const plain = await resolveWriteIdentity('required', LEGACY, { getUser: async () => null });
  assert.equal(plain.why, 'not-signed-in');
});

test('resolveWriteIdentity: off and the pre-login caller read no account at all', async () => {
  let reads = 0;
  const deps = { getUser: async () => { reads++; return null; } };
  await resolveWriteIdentity('off', { username: 'jane', authenticated: true }, deps);
  await resolveWriteIdentity('preferred', { username: 'legacy', authenticated: false }, deps);
  assert.equal(reads, 0, 'the off switch costs exactly what the code before it cost');
});

test('markLoginRejected: reports whether the mark landed, and never throws', async () => {
  assert.equal(await markLoginRejected('jane', 'r', { patchUser: async () => {} }), true);
  assert.equal(await markLoginRejected('jane', 'r', { patchUser: async () => { throw new Error('store down'); } }), false);
});

// ── the in-flight dedupe carries the credentials ─────────────────────────────

test('dedupe key: unchanged with no credentials; different credentials → different keys', () => {
  assert.equal(dedupeKey('get', 'https://x/load/info/1'), 'GET https://x/load/info/1');
  const a = credentialFingerprint({ Authorization: JANE_AUTH });
  const b = credentialFingerprint({ authorization: SHARED_AUTH });
  assert.equal(a.length, 16);
  assert.notEqual(a, b);
  assert.equal(a, credentialFingerprint({ authorization: JANE_AUTH }), 'header case does not matter');
  assert.equal(credentialFingerprint({ 'Content-Type': 'application/json' }), '');
  assert.equal(credentialFingerprint(null), '');
  assert.notEqual(dedupeKey('GET', 'u', a), dedupeKey('GET', 'u', b));
  assert.ok(!dedupeKey('GET', 'u', a).includes('old-password'));
});

function requesterOver(fetchImpl) {
  return createNuvizzRequester({
    fetchImpl,
    recordCall: async () => 1,
    isCircuitOpen: async () => false,
    tripCircuit: async () => {},
    log: () => {},
    now: () => 1_000_000,
    sleep: async () => {},
  }, { dailyCeiling: 100_000, breakerMode: 'enforce', maxRetries: 0 });
}

test('two logins GETting the same URL at the same moment are two requests — Jane never gets Mike\'s 401', async () => {
  const seen = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const r = requesterOver(async (url, init) => {
    seen.push(init.headers.Authorization);
    await gate;
    return new Response('{}', { status: init.headers.Authorization === JANE_AUTH ? 200 : 401 });
  });
  const MIKE_AUTH = 'Basic ' + Buffer.from('msmith:typo').toString('base64');
  const pMike = r.request('https://x/load/info/DDLOGINCHECK0/DAVIS', { headers: { Authorization: MIKE_AUTH } }, { route: '/load/info', tenant: 'DAVIS' });
  const pJane = r.request('https://x/load/info/DDLOGINCHECK0/DAVIS', { headers: { Authorization: JANE_AUTH } }, { route: '/load/info', tenant: 'DAVIS' });
  release();
  const [m, j] = await Promise.all([pMike, pJane]);
  assert.equal(seen.length, 2, 'both reached NuVizz');
  assert.equal(m.status, 401);
  assert.equal(j.status, 200, 'Jane got her own answer');
});

test('the same login GETting the same URL twice at once is still ONE request (the dedupe still works)', async () => {
  let n = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const r = requesterOver(async () => { n++; await gate; return new Response('{}', { status: 200 }); });
  const a = r.request('https://x/u', { headers: { Authorization: SHARED_AUTH } }, { route: '/u', tenant: 'DAVIS' });
  const b = r.request('https://x/u', { headers: { Authorization: SHARED_AUTH } }, { route: '/u', tenant: 'DAVIS' });
  release();
  await Promise.all([a, b]);
  assert.equal(n, 1);
});
