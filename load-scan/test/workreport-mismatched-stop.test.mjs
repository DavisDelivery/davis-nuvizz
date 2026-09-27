// workreport-mismatched-stop.test.mjs — A6-S31-3.
//
// The work report reads the shift's board to name every truck — including the
// ones nobody touched, which is the finding a manager looks for first. It built
// that board with `.map(toManifestStop)`, and Array.map hands the INDEX in as
// toManifestStop's second argument, `warn`. The first stop whose skids + loose
// disagree with its piece total (routine — the manifest is served anyway) then
// called `warn(...)` on a number, threw, and the catch around it left the
// board empty: every truck vanished from that shift's report without a word.
// Driven end to end against the in-memory Firestore.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeFirestore } from './helpers/fake-firestore.mjs';

process.env.LOADSCAN_JWT_SECRET = 'test-secret-that-is-long-enough-to-pass-32';
const fake = installFakeFirestore();

const fs = await import('../netlify/functions/lib/firestore.mts');
const auth = await import('../netlify/functions/lib/auth.mts');
const workReport = await import('../netlify/functions/work-report.mts');

const DAY = '2026-08-07';
const TOKEN = auth.issueToken('1', 'Dispatcher', 'dispatcher');

const getReport = async () => {
  const res = await workReport.default(
    new Request(`http://localhost/.netlify/functions/work-report?shiftDay=${DAY}&days=1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  assert.equal(res.status, 200);
  return (await res.json()).reports[0];
};

test('a stop whose skids + loose disagree with its piece total no longer empties the shift\'s truck list', async () => {
  fake.docs.clear();
  await fs.setDoc('driver_auth/1', { driverNumber: '1', displayName: 'Dispatcher', role: 'dispatcher', active: true, pinHash: '' });
  const base = `nuvizz_stop_index/davis__${DAY}/stops`;
  // A clean stop first, then the mismatched one — any mismatch at index >= 1 threw.
  await fs.setDoc(`${base}/007157687`, { stopNbr: '007157687', loadNbr: 'STEVEN', routeName: 'STEVEN', pallets: 2, cartons: 1, volume: 1 });
  await fs.setDoc(`${base}/007158397`, { stopNbr: '007158397', loadNbr: 'MANDI', routeName: 'MANDI', pallets: 5, cartons: 2, volume: 0 });

  const report = await getReport();
  assert.equal(report.totals.loads, 2, 'both trucks on the board are named');
  assert.deepEqual(
    report.offApp.map((r) => r.loadNbr),
    ['MANDI', 'STEVEN'],
    'and both show as untouched — the absence is the finding',
  );
});
