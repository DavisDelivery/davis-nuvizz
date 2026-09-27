// test/tractor-rebuild-window-keeps-lifetime.test.mjs
//
// A ONE-DAY TRACTOR REBUILD MUST NOT ERASE A LOCATION'S LIFETIME.
//
// tractor-flags-rebuild-background advertises ?date= and ?from&to modes. Both filtered the
// history partitions down to the window, aggregated ONLY that window, and then wrote the result
// with writeTractorLocationsFresh — a whole-document setDoc. So a dock a tractor had served 40
// times since January, re-run for one September day, came back as "1 delivery, first served
// September 10, one driver": its lifetime count, its first-served date and every other driver
// were replaced by the window's. first_tractor_date is what "lime as of board date" paints on,
// so that dock also stopped painting lime on every earlier board.
//
// A window now folds into each location through the SAME sticky merge the nightly pass uses
// (dates only widen, drivers only add, counts only grow). The full rebuild — no window — is
// unchanged: it still recomputes every location from scratch, which is the re-tag path.
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

const T = 'davis';
const FN = 'https://x.netlify.app/.netlify/functions/tractor-flags-rebuild-background';
const MK = 'acme_supply__100_main_st__duluth__30096';
const LOC = `tractor_locations/${T}__${MK}`;

const EMPLOYEE = { fullName: 'Brenton Byrd', vehicleType: 'tractor', externalIds: { nuvizz: 'Brent Boyd' } };
const LIFETIME = {
  tenant: T, match_key: MK, business_name: 'ACME SUPPLY', city: 'DULUTH',
  first_tractor_date: '2026-01-05', last_tractor_date: '2026-09-01',
  tractor_drivers: ['Anthony Kostner'], delivery_count: 40, updated_at: '2026-09-02T03:00:00Z',
};
const delivered = (date, n) => ({
  stopNbr: n, date, tenant: T, customerMatchKey: MK, businessName: 'ACME SUPPLY', city: 'DULUTH',
  driverName: 'Brent Boyd', normalizedStatus: 'DELIVERED',
});

const seed = () => ({
  'employees/e1': EMPLOYEE,
  [LOC]: { ...LIFETIME },
  [`history_days/${T}__2026-09-10`]: { tenant: T, date: '2026-09-10' },
  [`history_days/${T}__2026-09-10/stops/1001`]: delivered('2026-09-10', '1001'),
  [`history_days/${T}__2026-09-11`]: { tenant: T, date: '2026-09-11' },
  [`history_days/${T}__2026-09-11/stops/1002`]: delivered('2026-09-11', '1002'),
});

async function run(qs) {
  const fake = installFirestoreFake(seed());
  try {
    const handler = (await import('../netlify/functions/tractor-flags-rebuild-background.mts')).default;
    const resp = await handler(new Request(`${FN}${qs}`, { method: 'POST' }));
    return { fake, status: resp.status, body: await resp.json() };
  } finally { fake.restore(); }
}

test('a one-day tractor rebuild adds that day to a dock served 40 times since January instead of replacing its history', async () => {
  const { fake, body } = await run('?date=2026-09-10');
  assert.equal(body.ok, true);
  assert.equal(fake.log.other.length, 0, 'no vendor call');
  const doc = fake.store.get(LOC);
  assert.equal(doc.first_tractor_date, '2026-01-05', 'first served in January, still');
  assert.equal(doc.last_tractor_date, '2026-09-10');
  assert.equal(doc.delivery_count, 41, '40 on file plus the one on Sep 10');
  assert.deepEqual(doc.tractor_drivers, ['Anthony Kostner', 'Brenton Byrd'], 'the earlier driver is kept');
});

test('a from/to window rebuild also merges, day by day, rather than overwriting the lifetime', async () => {
  const { fake, body } = await run('?from=2026-09-10&to=2026-09-11');
  assert.equal(body.ok, true);
  const doc = fake.store.get(LOC);
  assert.equal(doc.first_tractor_date, '2026-01-05');
  assert.equal(doc.last_tractor_date, '2026-09-11');
  assert.equal(doc.delivery_count, 42);
  assert.deepEqual(doc.tractor_drivers, ['Anthony Kostner', 'Brenton Byrd']);
});

test('re-running the same one-day window does not count that day twice', async () => {
  const fake = installFirestoreFake(seed());
  try {
    const handler = (await import('../netlify/functions/tractor-flags-rebuild-background.mts')).default;
    await handler(new Request(`${FN}?date=2026-09-10`, { method: 'POST' }));
    await handler(new Request(`${FN}?date=2026-09-10`, { method: 'POST' }));
    assert.equal(fake.store.get(LOC).delivery_count, 41);
  } finally { fake.restore(); }
});

test('the full rebuild (no window) still recomputes every location from scratch — the re-tag path is unchanged', async () => {
  const { fake, body } = await run('');
  assert.equal(body.ok, true);
  const doc = fake.store.get(LOC);
  // Only the two captured days exist in this warehouse, so from scratch that is the whole truth.
  assert.equal(doc.delivery_count, 2);
  assert.equal(doc.first_tractor_date, '2026-09-10');
  assert.equal(doc.last_tractor_date, '2026-09-11');
  assert.deepEqual(doc.tractor_drivers, ['Brenton Byrd']);
});
