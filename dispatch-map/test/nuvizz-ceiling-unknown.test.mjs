// test/nuvizz-ceiling-unknown.test.mjs — a ceiling nobody could read does not release the breaker.
//
// Audit 2026-09-27 (nuvizz-write-4): on a cold instance whose one read of scan_config failed,
// hydrateDailyCeiling kept its "previous value" — which on a cold instance is nothing — and
// effectiveDailyCeiling() fell through to the 2,000 default with no sign it was a guess.
// readCircuitSelfHealing then compared the day's count against that 2,000 and RELEASED a trip
// Chad's lower saved ceiling had taken, writing open:false to the shared nuvizz_ops/circuit so
// every instance resumed spending. The code's own rule says the opposite: WHEN WE CANNOT TELL,
// IT STAYS OPEN.
//
// Own file: the resolved ceiling is a module singleton, and node --test runs each file in a
// fresh process. Firestore fake only — nothing here can reach NuVizz.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

delete process.env.NUVIZZ_DAILY_CEILING;
delete process.env.NUVIZZ_BREAKER_MODE;

const nvreq = await import('../netlify/functions/lib/nuvizz-request.mts');
const { etDayString } = await import('../netlify/functions/lib/firestore.mts');

// The fake, with one document's read made to fail the way a Firestore 5xx does.
function install(seed, { failScanConfig }) {
  const h = installFirestoreFake(seed);
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    const method = String(init?.method || 'GET').toUpperCase();
    if (failScanConfig() && method === 'GET' && url.includes('firestore.googleapis.com') && url.includes('nuvizz_ops/scan_config')) {
      return new Response('{"error":{"code":503,"status":"UNAVAILABLE"}}', { status: 503 });
    }
    return inner(input, init);
  };
  return h;
}

function seedTrippedAt(savedCeiling, dayCount) {
  const today = etDayString();
  return {
    'nuvizz_ops/scan_config': { dailyCeiling: savedCeiling },
    [`nuvizz_ops/calls__${today}`]: { count: dayCount },
    'nuvizz_ops/circuit': { open: true, reason: `daily ceiling ${savedCeiling} reached (count=${savedCeiling})`, at: new Date().toISOString(), day: today },
  };
}

test('Chad lowered the ceiling to 1,500 and it tripped: a cold instance that cannot read the setting keeps the breaker shut', async () => {
  let fail = true;
  const h = install(seedTrippedAt(1500, 1600), { failScanConfig: () => fail });
  try {
    nvreq.__resetDailyCeilingCache();
    assert.equal(await nvreq.breakerTripped(), true, 'an unknown ceiling releases nothing');
    const c = h.store.get('nuvizz_ops/circuit');
    assert.equal(c.open, true, 'the shared breaker is not written open for every instance');
    assert.match(String(c.reason), /1500 reached/, 'the trip Chad\'s setting took is left as it was');
    assert.equal(nvreq.dailyCeilingKnown(), false, 'and the process knows it is running on a guess');

    // The next good read of his setting settles it — still over 1,500, so still shut.
    fail = false;
    nvreq.__resetDailyCeilingCache();
    assert.equal(await nvreq.breakerTripped(), true);
    assert.equal(nvreq.dailyCeilingKnown(), true);
    assert.equal(h.store.get('nuvizz_ops/circuit').open, true);
  } finally { h.restore(); }
});

test('a ceiling that WAS read and has been raised above the day\'s count still releases the breaker', async () => {
  const h = install({ ...seedTrippedAt(1500, 1600), 'nuvizz_ops/scan_config': { dailyCeiling: 3000 } }, { failScanConfig: () => false });
  try {
    nvreq.__resetDailyCeilingCache();
    assert.equal(await nvreq.breakerTripped(), false, 'raising the setting still frees a stale trip');
    assert.equal(h.store.get('nuvizz_ops/circuit').open, false);
    assert.match(String(h.store.get('nuvizz_ops/circuit').reason), /released: day count 1600 .*\(3000\)/);
  } finally { h.restore(); }
});

test('no saved ceiling at all, read cleanly, is the default — known, and it can release', async () => {
  const seed = seedTrippedAt(1500, 1600);
  delete seed['nuvizz_ops/scan_config'];
  const h = install(seed, { failScanConfig: () => false });
  try {
    nvreq.__resetDailyCeilingCache();
    assert.equal(await nvreq.breakerTripped(), false, 'nobody has decided, and we KNOW nobody has: the 2,000 default is the answer');
    assert.equal(nvreq.dailyCeilingKnown(), true);
  } finally { h.restore(); }
});

// THE OTHER DIRECTION stays conservative — a write past the 2,000 default is still refused while
// the saved ceiling cannot be read (the same "when we cannot tell" rule) — but it now SAYS the
// number is the default, instead of "(2100/2000)" under a card that reads 3,000.
const assign = async () => {
  const handler = (await import('../netlify/functions/nuvizz-write.mts')).default;
  const r = await handler(new Request('http://localhost/.netlify/functions/nuvizz-write', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'assignDriver', payload: { loadId: '6a438e9d52ef82bd1ed4516b', driverId: 7 } }),
  }));
  return { status: r.status, body: await r.json() };
};
const withWriteEnv = async (fn) => {
  const keep = { NUVIZZ_WRITE_ENABLED: process.env.NUVIZZ_WRITE_ENABLED, NUVIZZ_DAVIS_USER: process.env.NUVIZZ_DAVIS_USER, NUVIZZ_DAVIS_PASS: process.env.NUVIZZ_DAVIS_PASS, AUTH_REQUIRED: process.env.AUTH_REQUIRED };
  process.env.NUVIZZ_WRITE_ENABLED = 'true'; process.env.NUVIZZ_DAVIS_USER = 'u'; process.env.NUVIZZ_DAVIS_PASS = 'p';
  delete process.env.AUTH_REQUIRED;
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(keep)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
};

test('a Save refused because the saved ceiling could not be read says the 2,000 is the default, not his setting', async () => {
  const seed = seedTrippedAt(3000, 2100);
  delete seed['nuvizz_ops/circuit'];
  const h = install(seed, { failScanConfig: () => true });
  try {
    nvreq.__resetDailyCeilingCache();
    const { status, body } = await withWriteEnv(assign);
    assert.equal(status, 429, 'still refused — an unknown ceiling is not headroom');
    assert.match(body.error, /\(2100\/2000\)/);
    assert.match(body.error, /saved ceiling could not be read, so the 2000 default is in force/);
    assert.equal(h.log.other.length, 0, 'nothing reached NuVizz');
  } finally { h.restore(); }
});

test('a Save refused at a ceiling that WAS read keeps the plain sentence', async () => {
  const seed = seedTrippedAt(2000, 2100);
  delete seed['nuvizz_ops/circuit'];
  const h = install(seed, { failScanConfig: () => false });
  try {
    nvreq.__resetDailyCeilingCache();
    const { status, body } = await withWriteEnv(assign);
    assert.equal(status, 429);
    assert.equal(body.error, 'daily NuVizz call ceiling reached (2100/2000) — write refused');
    assert.equal(h.log.other.length, 0, 'nothing reached NuVizz');
  } finally { h.restore(); }
});

// THE SCANNER IS THE PATH THAT MATTERS: it is what calls breakerTripped() every five minutes.
// It reads scan_config for the schedule itself and hands the ceiling to the breaker with
// setDailyCeilingOverride — and it used to do that after a FAILED read too, reporting "nothing
// is saved". That marked the 2,000 default as known, and the breaker released Chad's 1,500 trip
// against it a few lines later. A manual press (so the schedule cannot skip first) against the
// fake: the breaker must answer before anything reaches the vendor.
test('a scan on a cold instance that cannot read scan_config does not release a trip Chad\'s lower ceiling took', async () => {
  const keep = { NUVIZZ_SCANS_ENABLED: process.env.NUVIZZ_SCANS_ENABLED, NUVIZZ_DAVIS_USER: process.env.NUVIZZ_DAVIS_USER, NUVIZZ_DAVIS_PASS: process.env.NUVIZZ_DAVIS_PASS };
  process.env.NUVIZZ_SCANS_ENABLED = '1'; process.env.NUVIZZ_DAVIS_USER = 'u'; process.env.NUVIZZ_DAVIS_PASS = 'p';
  const h = install(seedTrippedAt(1500, 1600), { failScanConfig: () => true });
  try {
    nvreq.__resetDailyCeilingCache();
    const { runRefreshStops } = await import('../netlify/functions/lib/refresh-stops-core.mts');
    const res = await runRefreshStops(new Request('https://x.netlify.app/.netlify/functions/nuvizz-refresh-stops-background?manual=1', { method: 'POST' }));
    const body = await res.json();
    assert.equal(body.skipped, 'circuit-open', `the scan halts on the breaker: ${JSON.stringify(body)}`);
    const c = h.store.get('nuvizz_ops/circuit');
    assert.equal(c.open, true, 'the shared breaker is not written open for every instance');
    assert.match(String(c.reason), /1500 reached/, 'the trip Chad\'s setting took is left as it was');
    assert.equal(h.log.other.length, 0, 'nothing reached NuVizz');
  } finally {
    h.restore();
    for (const [k, v] of Object.entries(keep)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
});
