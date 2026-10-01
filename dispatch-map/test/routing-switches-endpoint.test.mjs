// THE ENDPOINT BEHIND DIAGNOSTICS → ROUTING SWITCHES. It touches the world, so these pin the rules
// that only fail for real: one flip writes ONE switch (field-masked, the others survive), the answer
// is read back from the document, a bad name or value changes nothing, a switch can be HANDED BACK
// to Netlify, a failed write and a failed read-back are told apart, the server switches' Netlify
// values are reported, and what the server does with the document when Firestore blips.
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
import { _resetRoutingSwitchesStoreForTests, hydrateRoutingSwitches, routingSwitchesTrail } from '../netlify/functions/lib/routing-switches-store.mts';
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
  for (const body of [{ name: 'NOT_A_SWITCH', on: true }, { name: 'VITE_TIME_WINDOWS_MILES_CAP', on: 'off' }, { name: 'VITE_TIME_WINDOWS_MILES_CAP' }, { on: true }]) {
    const r = await h(POST(body));
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((await r.json()).ok, false);
  }
  assert.equal(fake.store.get(DOC), undefined, 'nothing written');
  const bad = await h(new Request(url, { method: 'POST', body: '{not json' }));
  assert.equal(bad.status, 400);
}));

test('HAND IT BACK: on:null stores who handed it back and when, and the switch reads its Netlify setting again', () => withStore({
  [DOC]: { ROUTING_TIME_RESTRICTIONS: { on: false, at: '2026-10-01T15:00:00.000Z', by: 'dispatcher-a' } },
}, async (fake) => {
  await hydrateRoutingSwitches(1_000_000);
  assert.equal(timeRestrictionsEnabled({}), false, 'set off on the page');
  const r = await (await load())(POST({ name: 'ROUTING_TIME_RESTRICTIONS', on: null }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  const stored = fake.store.get(DOC).ROUTING_TIME_RESTRICTIONS;
  assert.equal(stored.on, null);
  assert.equal(stored.by, 'legacy');
  assert.ok(stored.at);
  await hydrateRoutingSwitches(1_000_000 + 31_000);
  assert.equal(timeRestrictionsEnabled({}), true, 'handed back: the default again');
  assert.equal(timeRestrictionsEnabled({ ROUTING_TIME_RESTRICTIONS: 'off' }), false, 'handed back: Netlify decides again');
}));

test('a write that FAILED and a write that landed but could not be READ BACK are different answers — the page never says "not changed" about a switch that changed', () => withStore({}, async (fake) => {
  const h = await load();
  const inner = globalThis.fetch;
  // 1. Firestore refuses the PATCH: written:false, nothing stored.
  globalThis.fetch = async (input, init = {}) => ((init.method || 'GET').toUpperCase() === 'PATCH'
    ? new Response('nope', { status: 503 }) : inner(input, init));
  try {
    const r = await h(POST({ name: 'ROUTING_TIME_RESTRICTIONS', on: false }));
    assert.equal(r.status, 502);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.equal(j.written, false);
    assert.equal(fake.store.get(DOC), undefined);
  } finally { globalThis.fetch = inner; }
  // 2. The PATCH lands, the read-back fails: written:true — and the document really holds it.
  let patched = false;
  globalThis.fetch = async (input, init = {}) => {
    const m = (init.method || 'GET').toUpperCase();
    if (m === 'PATCH') { patched = true; return inner(input, init); }
    if (patched && m === 'GET' && String(input?.url ?? input).includes('routing_switches')) return new Response('down', { status: 503 });
    return inner(input, init);
  };
  try {
    const r = await h(POST({ name: 'ROUTING_TIME_RESTRICTIONS', on: false }));
    assert.equal(r.status, 502);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.equal(j.written, true, 'the page must not say "not changed"');
    assert.match(j.error, /accepted the change but could not be read back/);
    assert.equal(fake.store.get(DOC).ROUTING_TIME_RESTRICTIONS.on, false, 'it DID change');
  } finally { globalThis.fetch = inner; }
}));

test('the server re-reads within 30 s, keeps its last copy through a blip, and a COLD instance whose read fails says so and tries again on the very next request', () => withStore({
  [DOC]: { ROUTING_TIME_RESTRICTIONS: { on: false, at: '2026-10-01T15:00:00.000Z', by: 'dispatcher-a' } },
}, async (fake) => {
  const inner = globalThis.fetch;
  let down = true;
  globalThis.fetch = async (input, init = {}) => (down && String(input?.url ?? input).includes('routing_switches')
    ? new Response('down', { status: 503 }) : inner(input, init));
  try {
    // Cold, and the read fails: this request runs on Netlify/default — and the trail says so.
    assert.equal(await hydrateRoutingSwitches(1_000_000), 'failed-none');
    assert.equal(timeRestrictionsEnabled({}), true, 'no copy: the page setting cannot be honoured on this request');
    assert.equal(routingSwitchesTrail(1_000_000).read, 'failed-none');
    assert.match(routingSwitchesTrail(1_000_000).failed.error, /503/);
    // The next request, 1 s later, does NOT wait out a retry window — there is no copy to protect.
    down = false;
    assert.equal(await hydrateRoutingSwitches(1_001_000), 'fresh');
    assert.equal(timeRestrictionsEnabled({}), false, 'the page setting, one request later');
    // A request whose first read failed and whose second succeeded still SAYS a read failed.
    const t = routingSwitchesTrail(1_001_000);
    assert.equal(t.read, 'fresh');
    assert.equal(t.copyFrom, new Date(1_001_000).toISOString());
    assert.deepEqual(t.set, { ROUTING_TIME_RESTRICTIONS: false });
    assert.equal(t.failed.at, new Date(1_000_000).toISOString(), 'the failure 1 s earlier is not hidden');
    assert.equal(routingSwitchesTrail(1_000_000 + 31_000).failed, undefined, 'and drops off once it is older than the 30 s window');
    // Inside the TTL: no read at all.
    const gets = fake.log.gets.length;
    assert.equal(await hydrateRoutingSwitches(1_020_000), 'cached');
    assert.equal(fake.log.gets.length, gets);
    // Past the TTL with the database down: the last good copy stands.
    down = true;
    assert.equal(await hydrateRoutingSwitches(1_040_000), 'failed-kept');
    assert.equal(timeRestrictionsEnabled({}), false, 'kept the last good copy — a blip never moves a switch that has loaded');
    // ...and it waits HYDRATE_RETRY_MS before trying again.
    assert.equal(await hydrateRoutingSwitches(1_042_000), 'failed-kept');
    // A flip made on the page is picked up on the first read past the TTL.
    down = false;
    fake.store.get(DOC).ROUTING_TIME_RESTRICTIONS = { on: true, at: '2026-10-01T16:00:00.000Z', by: 'dispatcher-a' };
    assert.equal(await hydrateRoutingSwitches(1_046_000), 'fresh');
    assert.equal(timeRestrictionsEnabled({ ROUTING_TIME_RESTRICTIONS: 'off' }), true);
  } finally { globalThis.fetch = inner; }
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
