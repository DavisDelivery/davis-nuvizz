// test/customer-history-backfill.test.mjs — THE BACKFILL LEAVES A RECORD, AND NEVER RUNS
// BESIDE ITSELF.
//
// Chad, 2026-09-19: "I want you to backfill everything in firestore." The function that does
// it is a *-background* job whose response the platform throws away, so before v1.49.0 the
// only way to know it had finished was to guess from a customer document. CLAUDE.md: never
// report an intent as an outcome. These pin (1) the pure rules — busy, stalled, plan, step,
// finish, shape — and (2) that the endpoint writes the record before its first day, after
// every day, and at the end; refuses a second run while one is live and SAYS SO on the live
// document; lets go of a run that stopped heartbeating; and that capture-health serves it.

import crypto from 'node:crypto';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SA = JSON.stringify({
  project_id: 'testproj',
  client_email: 'sa@testproj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});
process.env.NUVIZZ_BASE_URL = '';
delete process.env.FIRESTORE_DATABASE;
delete process.env.AUTH_REQUIRED;

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import {
  BACKFILL_PROGRESS_PATH, BACKFILL_STALE_MS, backfillBusy, planBackfill, stepBackfill, finishBackfill,
  refusalPatch, shapeBackfill,
} from '../netlify/functions/lib/customer-history-backfill.mts';

const T = 'davis';
const FN = 'https://x.netlify.app/.netlify/functions/nuvizz-rebuild-customer-history-background';
const NOW = Date.parse('2026-09-19T03:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const sealed = (date, n, over = {}) => ({
  stopNbr: `00717${n}`, pro: `00717${n}`, date, tenant: T,
  businessName: 'EARTHLY ALTERNATIVE THE', customerMatchKey: 'earthly_alternative_the__239_grant_st_se_ste_104__atlanta__30312',
  addr1: '239 GRANT ST SE STE 104', city: 'ATLANTA', state: 'GA', zip: '30312',
  driverName: 'Theo Afunyah', normalizedStatus: 'DELIVERED', deliveredDTTM: `${date}T13:44`, ...over,
});

// ── the pure rules ────────────────────────────────────────────────────────────

test('busy: a run that heartbeat within the stale window holds the lock', () => {
  assert.equal(backfillBusy({ running: true, started_at: iso(NOW - 60_000), updated_at: iso(NOW - 30_000) }, NOW), true);
});

test('stalled: a run whose heartbeat is older than the stale window does NOT hold the lock', () => {
  // The platform kills the function at its budget with no callback. Judged off updated_at, not
  // started_at — a run that started long ago but is still moving is still live.
  assert.equal(backfillBusy({ running: true, started_at: iso(NOW - 3 * BACKFILL_STALE_MS), updated_at: iso(NOW - BACKFILL_STALE_MS - 1) }, NOW), false);
  assert.equal(backfillBusy({ running: true, started_at: iso(NOW - 3 * BACKFILL_STALE_MS), updated_at: iso(NOW - 5_000) }, NOW), true);
});

test('a finished run, an absent record, and a running record with unparseable stamps are all NOT busy', () => {
  assert.equal(backfillBusy(null, NOW), false);
  assert.equal(backfillBusy({ running: false, updated_at: iso(NOW) }, NOW), false);
  // Malformed stamps must not become a lock nobody can release without the Firebase console.
  assert.equal(backfillBusy({ running: true, started_at: 'garbage', updated_at: null }, NOW), false);
});

test('plan → step → finish: done counts up, the heartbeat moves, and finish clears running', () => {
  let p = planBackfill(['2026-09-03', '2026-09-01', '2026-09-02'], iso(NOW), 'legacy');
  assert.deepEqual([p.from, p.to, p.total, p.done, p.running, p.by], ['2026-09-01', '2026-09-03', 3, 0, true, 'legacy']);
  p = stepBackfill(p, { date: '2026-09-01', ok: true, stops: 700, customers: 300, written: 300, ms: 900 }, iso(NOW + 1000));
  p = stepBackfill(p, { date: '2026-09-02', ok: false, error: 'boom', ms: 10 }, iso(NOW + 2000));
  assert.equal(p.done, 2);
  assert.equal(p.updated_at, iso(NOW + 2000));
  assert.equal(p.running, true);
  p = finishBackfill(p, iso(NOW + 3000));
  assert.equal(p.running, false);
  assert.equal(p.finished_at, iso(NOW + 3000));
  assert.equal(p.error, null);
  assert.equal(finishBackfill(p, iso(NOW), 'threw').error, 'threw');
});

test('shape: totals, failed days, and STALLED derived for the screen; garbage in → null, never a throw', () => {
  const doc = {
    running: true, from: '2026-09-01', to: '2026-09-17', total: 17, done: 2,
    started_at: iso(NOW - 2 * BACKFILL_STALE_MS), updated_at: iso(NOW - BACKFILL_STALE_MS - 1),
    results: [
      { date: '2026-09-01', ok: true, stops: 700, written: 300, ms: 5000 },
      { date: '2026-09-02', ok: false, error: 'boom', ms: 10 },
    ],
  };
  const v = shapeBackfill(doc, NOW);
  assert.equal(v.running, true);
  assert.equal(v.stalled, true, 'running but not heartbeating is STALLED, and the strip must say so');
  assert.equal(v.stops, 700);
  assert.equal(v.customers, 300);
  assert.deepEqual(v.failed_days, ['2026-09-02']);
  assert.equal(shapeBackfill(null), null);
  assert.equal(shapeBackfill('nonsense'), null);
  assert.equal(shapeBackfill({ results: 'not-an-array' }).stops, 0);
});

test('refusalPatch is a field-masked patch of ONE key — it must not touch the live heartbeat', () => {
  const patch = refusalPatch({ from: '2026-08-01', to: '2026-08-31', by: 'legacy' }, iso(NOW), 'still live');
  assert.deepEqual(Object.keys(patch), ['last_refused']);
  assert.equal(patch.last_refused.reason, 'still live');
});

// ── the endpoint, against the fake ────────────────────────────────────────────

async function run(seed, qs) {
  const fake = installFirestoreFake(seed);
  try {
    const handler = (await import('../netlify/functions/nuvizz-rebuild-customer-history-background.mts')).default;
    const resp = await handler(new Request(`${FN}?${qs}`, { method: 'POST' }));
    return { fake, status: resp.status, body: await resp.json() };
  } finally { fake.restore(); }
}

test('A RUN WRITES ITS RECORD BEFORE THE FIRST DAY, AFTER EVERY DAY, AND AT THE END — and reads back finished', async () => {
  const d1 = '2026-09-01', d2 = '2026-09-02';
  const { fake, status, body } = await run({
    [`history_days/${T}__${d1}/stops/007170001`]: sealed(d1, '0001'),
    [`history_days/${T}__${d2}/stops/007170002`]: sealed(d2, '0002'),
  }, `from=${d1}&to=${d2}`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.days, 2);
  const writes = fake.log.sets.filter((w) => w.path === BACKFILL_PROGRESS_PATH);
  // plan + one heartbeat per day + finish
  assert.equal(writes.length, 1 + 2 + 1, 'plan, two heartbeats, finish');
  assert.equal(writes[0].doc.running, true);
  assert.equal(writes[0].doc.done, 0);
  assert.equal(writes[1].doc.done, 1);
  assert.equal(writes[2].doc.done, 2);
  const final = fake.store.get(BACKFILL_PROGRESS_PATH);
  assert.equal(final.running, false);
  assert.equal(final.done, 2);
  assert.equal(final.total, 2);
  assert.ok(final.finished_at, 'finished_at is stamped');
  assert.equal(final.error, null);
  assert.equal(final.results[0].stops, 1);
  // and it actually rolled the customer up — the record is about a real run, not a mock of one
  const rollup = [...fake.store.keys()].find((k) => k.startsWith('history_customers/'));
  assert.ok(rollup, 'a customer rollup was written');
  assert.equal(fake.store.get(rollup).months['2026-09'].stops, 2);
  assert.equal(fake.log.other.length, 0, 'ZERO NuVizz calls');
});

test('A SECOND RUN WHILE ONE IS LIVE IS REFUSED, does NO day, and says so on the live document', async () => {
  const live = {
    running: true, from: '2026-09-01', to: '2026-09-17', total: 17, done: 4,
    started_at: new Date(Date.now() - 60_000).toISOString(), updated_at: new Date(Date.now() - 5_000).toISOString(),
    results: [], by: 'legacy', error: null, finished_at: null, last_refused: null,
  };
  const { fake, status, body } = await run({
    [BACKFILL_PROGRESS_PATH]: live,
    [`history_days/${T}__2026-08-04/stops/007160001`]: sealed('2026-08-04', '0001'),
  }, 'from=2026-08-01&to=2026-08-31');
  assert.equal(status, 409);
  assert.equal(body.ok, false);
  assert.match(body.reason, /4 of 17 days done/);
  // no day was processed: no customer rollup written, no plan written over the live record
  assert.equal([...fake.store.keys()].some((k) => k.startsWith('history_customers/')), false);
  assert.equal(fake.log.sets.filter((w) => w.path === BACKFILL_PROGRESS_PATH).length, 0, 'the live record was not replaced');
  // the refusal landed, field-masked, on the live record — heartbeat and progress intact
  const doc = fake.store.get(BACKFILL_PROGRESS_PATH);
  assert.equal(doc.running, true);
  assert.equal(doc.done, 4);
  assert.equal(doc.last_refused.from, '2026-08-01');
  assert.equal(doc.last_refused.to, '2026-08-31');
  const patches = (fake.log.patches || []).filter((p) => p.path === BACKFILL_PROGRESS_PATH);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].mask, ['last_refused']);
});

test('A STALLED RUN DOES NOT BLOCK THE NEXT ONE — the lock is the heartbeat, not the flag', async () => {
  const stalled = {
    running: true, from: '2026-09-01', to: '2026-09-17', total: 17, done: 4,
    started_at: new Date(Date.now() - 3 * BACKFILL_STALE_MS).toISOString(),
    updated_at: new Date(Date.now() - BACKFILL_STALE_MS - 1000).toISOString(),
    results: [], by: 'legacy', error: null, finished_at: null, last_refused: null,
  };
  const d = '2026-08-04';
  const { fake, status } = await run({
    [BACKFILL_PROGRESS_PATH]: stalled,
    [`history_days/${T}__${d}/stops/007160001`]: sealed(d, '0001'),
  }, `date=${d}`);
  assert.equal(status, 200);
  const doc = fake.store.get(BACKFILL_PROGRESS_PATH);
  assert.equal(doc.running, false);
  assert.equal(doc.from, d);
  assert.equal(doc.done, 1);
});

test('a day that throws is recorded as a FAILED day, the run continues, and the run still finishes', async () => {
  // The bad day's customer key carries a '?', which histDocId does not strip and assertSafePath
  // refuses — so the rollup write for that day genuinely throws, inside the per-day try.
  const good = '2026-08-05', bad = '2026-08-06';
  const { fake, status, body } = await run({
    [`history_days/${T}__${good}/stops/007160001`]: sealed(good, '0001'),
    [`history_days/${T}__${bad}/stops/007160002`]: sealed(bad, '0002', { customerMatchKey: 'earthly?bad' }),
  }, `from=${good}&to=${bad}`);
  assert.equal(status, 200, 'a bad day is a failed row, not a failed run');
  assert.equal(body.days, 2);
  assert.equal(body.results[1].ok, false);
  assert.match(String(body.results[1].error), /forbidden character/);
  const doc = fake.store.get(BACKFILL_PROGRESS_PATH);
  assert.equal(doc.running, false, 'the run still finished');
  assert.equal(doc.done, 2, 'both days were stepped through');
  assert.equal(doc.results[0].ok, true);
  assert.equal(doc.results[1].ok, false);
  const shaped = shapeBackfill(doc);
  assert.deepEqual(shaped.failed_days, [bad]);
  assert.equal(shaped.stops, 1, 'only the good day counts toward the total');
});

test('history-capture-health serves the record as `backfill`, with stalled judged server-side', async () => {
  const stalled = {
    running: true, from: '2026-09-01', to: '2026-09-17', total: 17, done: 4,
    started_at: new Date(Date.now() - 3 * BACKFILL_STALE_MS).toISOString(),
    updated_at: new Date(Date.now() - BACKFILL_STALE_MS - 1000).toISOString(),
    results: [{ date: '2026-09-01', ok: true, stops: 640, written: 290, ms: 4000 }], by: 'legacy', error: null, finished_at: null, last_refused: null,
  };
  const fake = installFirestoreFake({
    [BACKFILL_PROGRESS_PATH]: stalled,
    [`history_days/${T}__2026-09-17`]: { tenant: T, date: '2026-09-17', verified: true, complete: true, counts: { stops: 5 } },
  });
  try {
    const handler = (await import('../netlify/functions/history-capture-health.mts')).default;
    const body = await (await handler(new Request('https://x.netlify.app/.netlify/functions/history-capture-health'))).json();
    assert.equal(body.ok, true);
    assert.equal(body.backfill.running, true);
    assert.equal(body.backfill.stalled, true);
    assert.equal(body.backfill.done, 4);
    assert.equal(body.backfill.stops, 640);
    assert.equal(body.backfill.customers, 290);
    assert.ok(body.coverage, 'the coverage block is still there beside it');
  } finally { fake.restore(); }
});

test('history-capture-health with NO record on file reports backfill: null and still answers', async () => {
  const fake = installFirestoreFake({
    [`history_days/${T}__2026-09-17`]: { tenant: T, date: '2026-09-17', verified: true, complete: true, counts: { stops: 5 } },
  });
  try {
    const handler = (await import('../netlify/functions/history-capture-health.mts')).default;
    const body = await (await handler(new Request('https://x.netlify.app/.netlify/functions/history-capture-health'))).json();
    assert.equal(body.ok, true);
    assert.equal(body.backfill, null);
  } finally { fake.restore(); }
});
