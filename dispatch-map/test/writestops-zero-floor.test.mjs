// test/writestops-zero-floor.test.mjs — writeStops is the last gate before a day's board is
// pruned. A pull that came back EMPTY for a day that holds rows must not delete them: a saved
// search answering 200 with no rows, or a forced ?date= scan of a day the vendor has nothing
// for, would otherwise wipe the dispatchers' board, the flags and the ETAs in one write and
// report ok:true. The control case pins that an ordinary pull still prunes exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { writeStops } from '../netlify/functions/lib/firestore.mts';

const DAY = '2026-09-01';
const base = `nuvizz_stop_index/davis__${DAY}`;
const seed = () => ({
  [base]: { tenant: 'davis', date: DAY, count: 3, plannedCount: 2, unplannedCount: 1, last_scanned_at: '2026-09-01T10:00:00Z', lastLoadScanAt: '2026-09-01T10:00:00Z' },
  [`${base}/stops/1001`]: { stopNbr: '1001', isPlanned: true, loadNbr: 'DAVIS000198690' },
  [`${base}/stops/1002`]: { stopNbr: '1002', isPlanned: true, loadNbr: 'DAVIS000198690' },
  [`${base}/stops/1003`]: { stopNbr: '1003', isPlanned: false },
});

test('a scan that returns ZERO stops for a day holding 3 deletes nothing and keeps the counts honest', async () => {
  const fake = installFirestoreFake(seed());
  const errors = [];
  const realErr = console.error; console.error = (...a) => errors.push(a.join(' '));
  try {
    const meta = await writeStops('davis', DAY, [], '2026-09-01T11:00:00Z', { includeUnplanned: true, includeLoads: true });
    assert.deepEqual(fake.log.deletes, [], 'no stop doc deleted');
    assert.equal(meta.count, 3); assert.equal(meta.plannedCount, 2); assert.equal(meta.unplannedCount, 1);
    for (const n of ['1001', '1002', '1003']) assert.ok(fake.store.has(`${base}/stops/${n}`), `stop ${n} still on the board`);
    assert.ok(errors.some((e) => /ZERO stops.*refusing to prune/.test(e)), 'loudly logged — the refusal is visible in the function log');
  } finally { console.error = realErr; fake.restore(); }
});

test('CONTROL: a full pull with one surviving stop still prunes the two that vanished (behaviour unchanged)', async () => {
  const fake = installFirestoreFake(seed());
  try {
    const meta = await writeStops('davis', DAY, [{ stopNbr: '1001', isPlanned: true, loadNbr: 'DAVIS000198690' }], '2026-09-01T11:00:00Z', { includeUnplanned: true, includeLoads: true });
    assert.deepEqual(fake.log.deletes.sort(), [`${base}/stops/1002`, `${base}/stops/1003`]);
    assert.equal(meta.count, 1);
  } finally { fake.restore(); }
});

test('an empty pull on a day with NO rows is the ordinary empty day — no error, count 0', async () => {
  const fake = installFirestoreFake({});
  try {
    const meta = await writeStops('davis', DAY, [], '2026-09-01T11:00:00Z', {});
    assert.equal(meta.count, 0);
    assert.deepEqual(fake.log.deletes, []);
  } finally { fake.restore(); }
});
