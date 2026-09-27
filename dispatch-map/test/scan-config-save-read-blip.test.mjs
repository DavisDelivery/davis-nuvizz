// A SCAN-SCHEDULE SAVE DURING A FIRESTORE BLIP MUST NOT TURN THE SCANS BACK ON.
//
// X-firestore-2 (review 2026-09-03), reproduced by running the code: with scans switched off
// in Diagnostics and a lowered call ceiling on file, one failed read of nuvizz_ops/scan_config
// followed by a save of ONE field returned 200 — and the stored document was then only that
// field plus its stamps. The POST merged onto `readScanConfig().catch(() => ({}))` and wrote
// with setDoc, which REPLACES, so the blip read as "nothing customised" and the kill switch,
// the ceiling override and every other setting were deleted. The scanner then runs on its
// defaults — scans back on — and the only person who can tell is the one reading the screen.
//
// The fix: the save reads strictly. An unreadable current state refuses the save.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

delete process.env.AUTH_REQUIRED;

const DOC = 'nuvizz_ops/scan_config';
const STORED = { scansEnabled: false, dailyCeiling: 1500, intervalDayMin: 20, updatedAt: '2026-09-20T12:00:00.000Z', updatedBy: 'diagnostics-ui' };

const url = 'https://x.netlify.app/.netlify/functions/nuvizz-scan-config';
const POST = (body) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const load = () => import('../netlify/functions/nuvizz-scan-config.mts').then((m) => m.default);

/** The fake, plus N failed (503) GETs of the scan_config document before it answers. */
function withBlip(seed, failedReads) {
  const fake = installFirestoreFake(seed);
  const inner = globalThis.fetch;
  let left = failedReads;
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input?.url ?? input);
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET' && u.includes('firestore.googleapis.com') && u.includes(`/documents/${DOC}`) && left > 0) {
      left -= 1;
      return new Response('{"error":{"status":"UNAVAILABLE"}}', { status: 503 });
    }
    return inner(input, init);
  };
  return fake;
}

test('a ceiling save during a Firestore read blip is refused and scans stay switched OFF', async () => {
  const fake = withBlip({ [DOC]: { ...STORED } }, 1);
  try {
    const handler = await load();
    const r = await handler(POST({ dailyCeiling: 1800 }));
    const j = await r.json();
    assert.notEqual(r.status, 200, 'an unreadable current state is not a successful save');
    assert.equal(j.ok, false);
    assert.equal(fake.log.sets.filter((s) => s.path === DOC).length, 0, 'no document was written');
    assert.deepEqual(fake.store.get(DOC), STORED, 'the kill switch and every override are still on file');
  } finally { fake.restore(); }
});

test('the retry once Firestore answers changes the ceiling and keeps the kill switch', async () => {
  const fake = withBlip({ [DOC]: { ...STORED } }, 0);
  try {
    const handler = await load();
    const r = await handler(POST({ dailyCeiling: 1800 }));
    assert.equal(r.status, 200);
    const doc = fake.store.get(DOC);
    assert.equal(doc.dailyCeiling, 1800);
    assert.equal(doc.scansEnabled, false, 'a ceiling edit never switches scanning back on');
    assert.equal(doc.intervalDayMin, 20);
  } finally { fake.restore(); }
});

test('the first save ever (no scan_config document yet) still works', async () => {
  // A 404 is "nothing customised yet", not an outage — the strict read must still allow it.
  const fake = withBlip({}, 0);
  try {
    const handler = await load();
    const r = await handler(POST({ dailyCeiling: 1800 }));
    assert.equal(r.status, 200);
    assert.equal(fake.store.get(DOC)?.dailyCeiling, 1800);
  } finally { fake.restore(); }
});
