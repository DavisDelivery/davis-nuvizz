// test/backfill-refusal-survives-heartbeat.test.mjs — A REFUSED BACKFILL'S ONLY TRACE MUST
// OUTLIVE THE RUN THAT REFUSED IT.
//
// firestore-history-address-6. Chad starts the September customer-history backfill, then August
// "to save time". August is correctly refused, and the refusal is written onto September's
// progress record (last_refused, field-masked) — the only trace he gets, because the platform
// throws the 409 away. But September's own heartbeat after every day, and its final write, were
// whole-document setDoc calls carrying its in-memory `last_refused: null`, so the first
// heartbeat after the refusal erased it. The Diagnostics strip then showed September finished and
// no refusal, and nothing said August never ran.
//
// Now the heartbeat and the finish write only the run's own fields; last_refused is left alone.
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
  BACKFILL_PROGRESS_PATH, planBackfill, stepBackfill, heartbeatFields, shapeBackfill,
} from '../netlify/functions/lib/customer-history-backfill.mts';

const T = 'davis';
const FN = 'https://x.netlify.app/.netlify/functions/nuvizz-rebuild-customer-history-background';
const sealed = (date, n) => ({
  stopNbr: `00717${n}`, pro: `00717${n}`, date, tenant: T,
  businessName: 'EARTHLY ALTERNATIVE THE', customerMatchKey: 'earthly_alternative_the__239_grant_st_se_ste_104__atlanta__30312',
  addr1: '239 GRANT ST SE STE 104', city: 'ATLANTA', state: 'GA', zip: '30312',
  driverName: 'Theo Afunyah', normalizedStatus: 'DELIVERED', deliveredDTTM: `${date}T13:44`,
});

test('heartbeatFields is the run\'s own record WITHOUT last_refused — a refusal is not the live run\'s to overwrite', () => {
  const p = stepBackfill(planBackfill(['2026-09-01', '2026-09-02'], '2026-09-19T03:00:00Z', 'ada'), { date: '2026-09-01', ok: true, ms: 5 }, '2026-09-19T03:00:05Z');
  const f = heartbeatFields(p);
  assert.equal('last_refused' in f, false);
  assert.equal(f.done, 1);
  assert.equal(f.running, true);
  assert.deepEqual(Object.keys(f).sort(), Object.keys(p).filter((k) => k !== 'last_refused').sort());
});

test('September is refused-over mid-run by August: after September finishes, the strip still says August was turned away', async () => {
  const d1 = '2026-09-01', d2 = '2026-09-02', d3 = '2026-09-03';
  const fake = installFirestoreFake({
    [`history_days/${T}__${d1}/stops/007170001`]: sealed(d1, '0001'),
    [`history_days/${T}__${d2}/stops/007170002`]: sealed(d2, '0002'),
    [`history_days/${T}__${d3}/stops/007170003`]: sealed(d3, '0003'),
  });
  const handler = (await import('../netlify/functions/nuvizz-rebuild-customer-history-background.mts')).default;
  const inner = globalThis.fetch;
  let augustStatus = null;
  let fired = false;
  // Pause September as it reaches day 2, and issue August's run right there.
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if (!fired && (init.method || 'GET').toUpperCase() === 'GET' && url.includes(`/history_days/${T}__${d2}/stops`)) {
      fired = true;
      const r = await handler(new Request(`${FN}?from=2026-08-01&to=2026-08-31`, { method: 'POST' }));
      augustStatus = r.status;
    }
    return inner(input, init);
  };
  try {
    const r = await handler(new Request(`${FN}?from=${d1}&to=${d3}`, { method: 'POST' }));
    assert.equal(r.status, 200, 'September finished');
    assert.equal(augustStatus, 409, 'August was refused while September was live');
    const doc = fake.store.get(BACKFILL_PROGRESS_PATH);
    assert.equal(doc.running, false);
    assert.equal(doc.done, 3);
    assert.ok(doc.finished_at);
    assert.ok(doc.last_refused, 'the refusal survived September\'s heartbeats and its finish');
    assert.equal(doc.last_refused.from, '2026-08-01');
    assert.equal(doc.last_refused.to, '2026-08-31');
    assert.equal(shapeBackfill(doc).last_refused.from, '2026-08-01', 'and capture-health serves it');
    assert.equal(fake.log.other.length, 0, 'ZERO NuVizz calls');
  } finally { globalThis.fetch = inner; fake.restore(); }
});

test('a NEW run still starts from a clean record (the plan write replaces the last run\'s, unchanged)', async () => {
  const d = '2026-09-04';
  const fake = installFirestoreFake({
    [BACKFILL_PROGRESS_PATH]: {
      running: false, from: '2026-09-01', to: '2026-09-03', total: 3, done: 3, started_at: '2026-09-19T03:00:00Z',
      updated_at: '2026-09-19T03:01:00Z', finished_at: '2026-09-19T03:01:00Z', by: 'ada', error: null, results: [],
      last_refused: { at: '2026-09-19T03:00:30Z', from: '2026-08-01', to: '2026-08-31', reason: 'x', by: 'ada' },
    },
    [`history_days/${T}__${d}/stops/007170004`]: sealed(d, '0004'),
  });
  try {
    const handler = (await import('../netlify/functions/nuvizz-rebuild-customer-history-background.mts')).default;
    const r = await handler(new Request(`${FN}?date=${d}`, { method: 'POST' }));
    assert.equal(r.status, 200);
    const doc = fake.store.get(BACKFILL_PROGRESS_PATH);
    assert.equal(doc.from, d);
    assert.equal(doc.done, 1);
    assert.equal(doc.running, false);
    assert.equal(doc.last_refused, null, 'the re-run is the answer to the old refusal');
  } finally { fake.restore(); }
});
