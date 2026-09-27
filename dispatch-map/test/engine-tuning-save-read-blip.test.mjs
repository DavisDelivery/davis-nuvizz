// AN ENGINE-TAB SAVE DURING A FIRESTORE BLIP MUST NOT DROP THE OTHER SAVED KNOBS.
//
// X-errors-2 (review 2026-09-03), reproduced by running the code: with road_factor,
// speed_short_mph and zone_precision tuned and saved, one failed read of
// routing_engine_config/davis followed by a save of ONE knob returned 200 — and the document
// was then that one knob plus its stamps. The POST merged onto
// `getDoc(...).catch(() => null)` and wrote with setDoc, which REPLACES, so the blip read as
// "nothing tuned" and the next assignment run quietly went back to the defaults for the rest.
//
// The fix: the save reads strictly. An unreadable current state refuses the save.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

delete process.env.AUTH_REQUIRED;

const DOC = 'routing_engine_config/davis';
const STORED = { road_factor: 1.4, speed_short_mph: 22, zone_precision: 6, updated_at: '2026-09-20T12:00:00.000Z', updated_by: 'engine-tab' };

const url = 'https://x.netlify.app/.netlify/functions/routing-engine-tuning';
const POST = (body) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const load = () => import('../netlify/functions/routing-engine-tuning.mts').then((m) => m.default);

/** The fake, plus N failed (503) GETs of the engine config document before it answers. */
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

test('a one-knob Engine save during a Firestore read blip is refused and the other tuned knobs stay', async () => {
  const fake = withBlip({ [DOC]: { ...STORED } }, 1);
  try {
    const handler = await load();
    const r = await handler(POST({ speed_mid_mph: 40 }));
    const j = await r.json();
    assert.notEqual(r.status, 200, 'an unreadable current state is not a successful save');
    assert.equal(j.ok, false);
    assert.equal(fake.log.sets.filter((s) => s.path === DOC).length, 0, 'no document was written');
    assert.deepEqual(fake.store.get(DOC), STORED, 'road_factor, speed_short_mph and zone_precision are still on file');
  } finally { fake.restore(); }
});

test('the retry once Firestore answers saves the knob and keeps the others', async () => {
  const fake = withBlip({ [DOC]: { ...STORED } }, 0);
  try {
    const handler = await load();
    const r = await handler(POST({ speed_mid_mph: 40 }));
    assert.equal(r.status, 200);
    const doc = fake.store.get(DOC);
    assert.equal(doc.speed_mid_mph, 40);
    assert.equal(doc.road_factor, 1.4);
    assert.equal(doc.speed_short_mph, 22);
    assert.equal(doc.zone_precision, 6);
  } finally { fake.restore(); }
});

test('the first Engine save ever (no config document yet) still works', async () => {
  // A 404 is "nothing tuned yet", not an outage — the strict read must still allow it.
  const fake = withBlip({}, 0);
  try {
    const handler = await load();
    const r = await handler(POST({ speed_mid_mph: 40 }));
    assert.equal(r.status, 200);
    assert.equal(fake.store.get(DOC)?.speed_mid_mph, 40);
  } finally { fake.restore(); }
});
