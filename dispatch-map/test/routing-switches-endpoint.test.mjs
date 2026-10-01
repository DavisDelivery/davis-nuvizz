// THE ENDPOINT BEHIND DIAGNOSTICS → ROUTING SWITCHES. It touches the world, so these pin the rules
// that only fail for real: one flip writes ONE switch (field-masked, the others survive), the answer
// is read back from the document, a bad name or value changes nothing, the server switches'
// Netlify values are reported, and the server honours a flip on its next request.
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
import { _resetRoutingSwitchesStoreForTests, hydrateRoutingSwitches } from '../netlify/functions/lib/routing-switches-store.mts';
import { timeRestrictionsEnabled } from '../netlify/functions/lib/routing-time-windows.mts';

const DOC = 'routing_switches/davis';
const url = 'https://x.netlify.app/.netlify/functions/routing-switches';
const GET = () => new Request(url);
const POST = (body) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const load = () => import('../netlify/functions/routing-switches.mts').then((m) => m.default);

async function withStore(seed, fn) {
  _resetRoutingSwitchesStoreForTests();
  const fake = installFirestoreFake(seed);
  try { return await fn(fake); } finally { fake.restore(); _resetRoutingSwitchesStoreForTests(); }
}

test('GET reports what is stored and the server switches\' Netlify values, and is never cached', () => withStore({
  [DOC]: { VITE_CLOSEST_FIRST_WITHOUT_TOWNS: { on: false, at: '2026-10-01T15:00:00.000Z', by: 'dispatcher-a' } },
}, async () => {
  process.env.ROUTING_TIME_RESTRICTIONS = 'off';
  try {
    const r = await (await load())(GET());
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.persistent, true);
    assert.equal(j.stored.VITE_CLOSEST_FIRST_WITHOUT_TOWNS.on, false);
    assert.equal(j.serverEnv.ROUTING_TIME_RESTRICTIONS, 'off');
    assert.equal(j.serverEnv.ROAD_BOX_ESTIMATE_UNROUTABLE, null);
    assert.equal('VITE_CLOSEST_FIRST_WITHOUT_TOWNS' in j.serverEnv, false, 'browser switches are not the server\'s to report');
  } finally { delete process.env.ROUTING_TIME_RESTRICTIONS; }
}));

test('POST flips ONE switch, leaves the others alone, and answers with what the document reads back', () => withStore({
  [DOC]: { VITE_CLOSEST_FIRST_WITHOUT_TOWNS: { on: false, at: '2026-10-01T15:00:00.000Z', by: 'dispatcher-a' } },
}, async (fake) => {
  const r = await (await load())(POST({ name: 'VITE_TIME_WINDOWS_MILES_CAP', on: false }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.saved, 'VITE_TIME_WINDOWS_MILES_CAP');
  const stored = fake.store.get(DOC);
  assert.equal(stored.VITE_TIME_WINDOWS_MILES_CAP.on, false);
  assert.ok(stored.VITE_TIME_WINDOWS_MILES_CAP.at, 'stamped with when');
  assert.equal(stored.VITE_TIME_WINDOWS_MILES_CAP.by, 'legacy', 'the principal, not the body (auth off: the legacy login)');
  assert.deepEqual(stored.VITE_CLOSEST_FIRST_WITHOUT_TOWNS, { on: false, at: '2026-10-01T15:00:00.000Z', by: 'dispatcher-a' }, 'the other switch survived');
  assert.deepEqual(j.stored, stored, 'the answer is the document');
}));

test('a bad name or a non-boolean changes nothing', () => withStore({}, async (fake) => {
  const h = await load();
  for (const body of [{ name: 'NOT_A_SWITCH', on: true }, { name: 'VITE_TIME_WINDOWS_MILES_CAP', on: 'off' }, { on: true }]) {
    const r = await h(POST(body));
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((await r.json()).ok, false);
  }
  assert.equal(fake.store.get(DOC), undefined, 'nothing written');
  const bad = await h(new Request(url, { method: 'POST', body: '{not json' }));
  assert.equal(bad.status, 400);
}));

test('the server honours a flip on its next request — and a database it cannot read moves nothing', () => withStore({}, async (fake) => {
  await hydrateRoutingSwitches(1_000_000);
  assert.equal(timeRestrictionsEnabled({}), true, 'nothing stored: the default');
  await (await load())(POST({ name: 'ROUTING_TIME_RESTRICTIONS', on: false }));
  assert.equal(timeRestrictionsEnabled({}), false, 'the flipping instance honours it at once');
  // Another warm instance re-reads within the TTL window and picks it up.
  _resetRoutingSwitchesStoreForTests();
  assert.equal(timeRestrictionsEnabled({}), true, 'a cold copy knows nothing yet');
  await hydrateRoutingSwitches(2_000_000);
  assert.equal(timeRestrictionsEnabled({}), false, 'after its load it does');
  // A read failure keeps the last copy instead of dropping to "nothing set".
  fake.restore();
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  try {
    await hydrateRoutingSwitches(3_000_000 + 40_000);
    assert.equal(timeRestrictionsEnabled({}), false, 'kept the last good copy');
  } finally { globalThis.fetch = real; }
}));

test('no Firestore on the deploy: GET still answers (persistent:false), POST refuses with 503', async () => {
  _resetRoutingSwitchesStoreForTests();
  const sa = process.env.FIREBASE_SA;
  delete process.env.FIREBASE_SA;
  try {
    const h = await load();
    const g = await (await h(GET())).json();
    assert.equal(g.ok, true);
    assert.equal(g.persistent, false);
    assert.deepEqual(g.stored, {});
    const p = await h(POST({ name: 'VITE_TIME_WINDOWS_MILES_CAP', on: false }));
    assert.equal(p.status, 503);
  } finally { process.env.FIREBASE_SA = sa; }
});
