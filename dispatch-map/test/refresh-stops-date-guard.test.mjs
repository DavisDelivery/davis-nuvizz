// test/refresh-stops-date-guard.test.mjs — ?date= on the scan is Chad's explicit-date manual
// scan and it STAYS. What is refused is a value that is not a real calendar date: it used to
// key a forced scan-and-prune of `nuvizz_stop_index/davis__${whatever}`. A bad date is a 400
// before any counter, ledger row, Firestore read or vendor call; a good date goes through
// exactly as before (here: all the way to the FIREBASE_SA gate, with nothing else set).
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.FIREBASE_SA;
process.env.NUVIZZ_BASE_URL = '';
delete process.env.NUVIZZ_SCANS_ENABLED;
import { runRefreshStops, isValidScanDate } from '../netlify/functions/lib/refresh-stops-core.mts';
import manualScan from '../netlify/functions/nuvizz-manual-scan.mts';

const BASE = 'https://x.netlify.app/.netlify/functions/nuvizz-refresh-stops-background';

test('isValidScanDate: shape AND calendar', () => {
  for (const ok of ['2026-09-01', '2024-02-29', '2026-12-31']) assert.equal(isValidScanDate(ok), true, ok);
  for (const bad of ['2026-02-30', '2026-13-01', '2023-02-29', '2026-9-1', '20260901', '../x', '2026-09-01T00:00', '', null, undefined, 42]) assert.equal(isValidScanDate(bad), false, String(bad));
});

async function withNoNetwork(fn) {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network reached'); };
  try { return await fn(() => calls); } finally { globalThis.fetch = realFetch; }
}

test('a bad ?date= is a 400 with a JSON body and NOTHING runs — no fetch, no counter, no scan', async () => {
  await withNoNetwork(async (calls) => {
    for (const d of ['2026-02-30', '../nuvizz_ops', 'tomorrow', '2026-09-01%2F..%2Fx']) {
      const r = await runRefreshStops(new Request(`${BASE}?date=${d}&manual=1`, { method: 'POST' }));
      assert.equal(r.status, 400, d);
      const b = await r.json();
      assert.equal(b.ok, false); assert.match(b.error, /real YYYY-MM-DD/);
    }
    assert.equal(calls(), 0);
  });
});

test('a REAL ?date= still passes the gate and enters the run (reaches the FIREBASE_SA check, not a 400)', async () => {
  await withNoNetwork(async () => {
    const r = await runRefreshStops(new Request(`${BASE}?date=2026-09-01&manual=1`, { method: 'POST' }));
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.error, 'FIREBASE_SA not set', 'the run started — the date was accepted, and only the (deliberately unset) SA stopped it');
  });
});

test("nuvizz-manual-scan still FORWARDS ?date= (Chad's explicit-date scan) — and a bad one comes back as the 400", async () => {
  await withNoNetwork(async () => {
    const bad = await manualScan(new Request('https://x.netlify.app/.netlify/functions/nuvizz-manual-scan?date=2026-02-30', { method: 'POST' }));
    assert.equal(bad.status, 400);
    const good = await manualScan(new Request('https://x.netlify.app/.netlify/functions/nuvizz-manual-scan?date=2026-09-01', { method: 'POST' }));
    assert.equal(good.status, 200);
    assert.equal((await good.json()).error, 'FIREBASE_SA not set');
  });
});
