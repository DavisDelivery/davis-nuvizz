// test/request-validators.test.mjs — request values that become Firestore document paths
// (or fire vendor calls) are shape-checked at the edge: a bad one is a 4xx before any
// network, a good one behaves exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installServiceAccountEnv } from './_firestore-fake.mjs';

delete process.env.FIREBASE_SA;
process.env.NUVIZZ_BASE_URL = '';
import attempts, { STOP_NBR_RE } from '../netlify/functions/nuvizz-attempts.mts';
import roster from '../netlify/functions/nuvizz-driver-roster.mts';
import driverRoute from '../netlify/functions/nuvizz-driver-route.mts';
import routingBuild from '../netlify/functions/routing-build-background.mts';
import { isRoutingJobId, newId } from '../netlify/functions/lib/routing-store.mts';
import tombstone from '../netlify/functions/history-tombstone.mts';
import reconcile from '../netlify/functions/nuvizz-board-reconcile.mts';
import { etDayString } from '../netlify/functions/lib/firestore.mts';

const FN = 'https://x.netlify.app/.netlify/functions/';
async function noNetwork(fn) {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network reached'); };
  try { return await fn(() => calls); } finally { globalThis.fetch = realFetch; }
}

test('attempts DELETE: a stopNbr that is a path (../../nuvizz_ops/circuit) is a 400 with no Firestore call', async () => {
  await noNetwork(async (calls) => {
    for (const bad of ['../../nuvizz_ops/circuit', '1?x=1', 'a#b', '', 'x'.repeat(65)]) {
      const r = await attempts(new Request(`${FN}nuvizz-attempts?date=2026-09-01&stopNbr=${encodeURIComponent(bad)}`, { method: 'DELETE' }));
      if (bad === '') { assert.notEqual(r.status, 400, 'an empty stopNbr is simply "no delete" (the GET path), as before'); continue; }
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    // POST ?delete= takes the same gate.
    assert.equal((await attempts(new Request(`${FN}nuvizz-attempts?date=2026-09-01&delete=..%2Fx`, { method: 'POST' }))).status, 400);
    assert.equal(calls(), 0);
  });
  for (const ok of ['007137828', 'AVRT-0028093763', 'ESTES_0538243875', 'a.b']) assert.ok(STOP_NBR_RE.test(ok), ok);
  // A real stopNbr with Firestore off still answers the documented firestore-disabled body.
  const r = await attempts(new Request(`${FN}nuvizz-attempts?date=2026-09-01&stopNbr=007137828`, { method: 'DELETE' }));
  assert.equal(r.status, 200); assert.equal((await r.json()).error, 'firestore-disabled');
});

test('driver roster: only the deploy tenant is accepted as the roster doc id', async () => {
  await noNetwork(async (calls) => {
    for (const bad of ['../nuvizz_ops/circuit', 'uline', 'davis?x', 'DAVIS ']) {
      const r = await roster(new Request(`${FN}nuvizz-driver-roster?tenant=${encodeURIComponent(bad)}`));
      assert.equal(r.status, 400, bad);
    }
    assert.equal(calls(), 0);
    // 'DAVIS' (the case getCreds().companyCode uses) is lower-cased and accepted, as before.
    const r = await roster(new Request(`${FN}nuvizz-driver-roster?tenant=DAVIS`));
    assert.equal(r.status, 200); assert.equal((await r.json()).neverScanned, true);
  });
});

test('driver route: ?date= must be YYYY-MM-DD before it becomes nuvizz_stop_index/davis__{date}', async () => {
  await noNetwork(async (calls) => {
    for (const bad of ['2026-09-01/../x', 'today', '2026-9-1']) {
      const r = await driverRoute(new Request(`${FN}nuvizz-driver-route?driver=VINCENT&date=${encodeURIComponent(bad)}`));
      assert.equal(r.status, 400, bad);
    }
    assert.equal(calls(), 0);
  });
});

test('routing jobId: the shape the app mints (job_<uuid>, job_<ms>) passes; a path does not', () => {
  assert.ok(isRoutingJobId(newId('job')));
  assert.ok(isRoutingJobId(`job_${Date.now()}`));
  for (const bad of ['../x', 'job_1/2', 'job?x=1', '', 'x'.repeat(81), null, 42]) assert.equal(isRoutingJobId(bad), false, String(bad));
});

test('routing-build-background: a bad jobId is a 400 before routing_jobs/{jobId} is ever read', async () => {
  installServiceAccountEnv();
  try {
    await noNetwork(async (calls) => {
      const r = await routingBuild(new Request(`${FN}routing-build-background`, { method: 'POST', body: JSON.stringify({ jobId: '../nuvizz_ops/circuit' }) }));
      assert.equal(r.status, 400); assert.equal((await r.json()).error, 'bad jobId');
      assert.equal(calls(), 0);
    });
  } finally { delete process.env.FIREBASE_SA; }
});

test('history-tombstone: a date after today (ET) is refused with 400, dry run or not, before any read', async () => {
  installServiceAccountEnv();
  try {
    await noNetwork(async (calls) => {
      const r = await tombstone(new Request(`${FN}history-tombstone?date=2999-01-01&reason=holiday&dryRun=1`));
      assert.equal(r.status, 400); assert.match((await r.json()).error, /future/);
      const p = await tombstone(new Request(`${FN}history-tombstone?date=2999-01-01&reason=holiday`, { method: 'POST' }));
      assert.equal(p.status, 400);
      assert.equal(calls(), 0);
      // Today itself is NOT "the future" — it proceeds to the reads (which this test refuses → 500 from the stub).
      const t = await tombstone(new Request(`${FN}history-tombstone?date=${etDayString()}&reason=holiday&dryRun=1`));
      assert.notEqual(t.status, 400);
    });
  } finally { delete process.env.FIREBASE_SA; }
});

test('board reconcile: run=1 over GET is a 405 that says how to run it; preview GET and POST run are unchanged', async () => {
  installServiceAccountEnv();
  try {
    await noNetwork(async (calls) => {
      const g = await reconcile(new Request(`${FN}nuvizz-board-reconcile?date=2026-09-01&run=1`));
      assert.equal(g.status, 405);
      const b = await g.json();
      assert.equal(b.error, 'run=1 requires POST'); assert.match(b.note, /curl -X POST/);
      assert.equal(calls(), 0, 'the 405 is decided before the roster read');
      // Preview (no run=1) still reads Firestore — the stub refuses, readLoadRoster catches → "no cached roster".
      const p = await reconcile(new Request(`${FN}nuvizz-board-reconcile?date=2026-09-01`));
      assert.equal(p.status, 200); assert.match((await p.json()).error, /no cached roster/);
      const r = await reconcile(new Request(`${FN}nuvizz-board-reconcile?date=2026-09-01&run=1`, { method: 'POST' }));
      assert.equal(r.status, 200); assert.match((await r.json()).error, /no cached roster/);
    });
  } finally { delete process.env.FIREBASE_SA; }
});
