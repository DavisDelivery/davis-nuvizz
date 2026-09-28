// A SAVE ON THE CUSTOMER-EMAIL SCREEN DURING A FIRESTORE BLIP MUST NOT SWITCH THE MAILER OFF.
//
// A5-S26-12 / X-firestore-3 (review 2026-09-03), reproduced by running the code: with the
// program ON and a custom template on file, one failed read of nuvizz_ops/customer_comms_config
// followed by a save that only changed the daily cap returned 200 — and the stored document
// then read enabled:false with the default sender, subject and template. writeConfig built
// the new document on top of readConfig(), which deliberately fails CLOSED to DEFAULT_CONFIG
// (so the sweep stops mail on an outage), and wrote it with setDoc, which REPLACES.
//
// The sweep's fail-closed read is right and stays. The save must read strictly instead: an
// unreadable current state is a refused save the person can retry, never a document rebuilt
// from defaults.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

delete process.env.AUTH_REQUIRED;
delete process.env.COMMS_ADMIN_TOKEN;

const DOC = 'nuvizz_ops/customer_comms_config';
const STORED = {
  enabled: true,
  fromAddress: 'Davis Delivery Service <notifications@davisdelivery.com>',
  replyTo: 'customerservice@davisdelivery.com',
  subjectTemplate: 'Your freight arrived — PRO {{pro}}',
  htmlTemplate: '<p>custom</p>',
  dailyCap: 50,
};

const url = 'https://x.netlify.app/.netlify/functions/customer-comms-config';
const PUT = (body) => new Request(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const load = () => import('../netlify/functions/customer-comms-config.mts').then((m) => m.default);

/** The fake, plus N failed (503) GETs of the config document before it answers normally. */
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

test('a daily-cap save during a Firestore read blip is refused and the live mailer stays ON with its template', async () => {
  const fake = withBlip({ [DOC]: { ...STORED } }, 1);
  try {
    const handler = await load();
    const r = await handler(PUT({ dailyCap: 60 }));
    const j = await r.json();
    assert.notEqual(r.status, 200, 'an unreadable current state is not a successful save');
    assert.equal(j.ok, false);
    assert.match(String(j.error), /nothing was saved/i, 'the person is told the save did not happen');
    assert.equal(fake.log.sets.filter((s) => s.path === DOC).length, 0, 'no document was written');
    assert.deepEqual(fake.store.get(DOC), STORED, 'the stored config is exactly what it was');
  } finally { fake.restore(); }
});

test('the retry once Firestore answers saves the cap and keeps enabled, sender and template', async () => {
  const fake = withBlip({ [DOC]: { ...STORED } }, 0);
  try {
    const handler = await load();
    const r = await handler(PUT({ dailyCap: 60 }));
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    const doc = fake.store.get(DOC);
    assert.equal(doc.dailyCap, 60);
    assert.equal(doc.enabled, true, 'a cap change never switches the program off');
    assert.equal(doc.htmlTemplate, '<p>custom</p>');
    assert.equal(doc.subjectTemplate, STORED.subjectTemplate);
    assert.equal(doc.fromAddress, STORED.fromAddress);
  } finally { fake.restore(); }
});

test('the very first save (no config document yet) still works from the defaults', async () => {
  // A 404 is "nothing saved yet", not an outage — the strict read must still allow it.
  const fake = withBlip({}, 0);
  try {
    const handler = await load();
    const r = await handler(PUT({ dailyCap: 30 }));
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    const doc = fake.store.get(DOC);
    assert.equal(doc.dailyCap, 30);
    assert.equal(doc.enabled, false, 'the default is off, exactly as before');
  } finally { fake.restore(); }
});

test('the sweep\'s read still fails CLOSED on a blip — an unreadable config means no mail', async () => {
  // The other half of the contract, unchanged: the sweep reads leniently so an outage stops
  // the mail rather than starting it. Only the SAVE became strict.
  const fake = withBlip({ [DOC]: { ...STORED } }, 1);
  try {
    const { readConfig } = await import('../netlify/functions/lib/customer-comms.mts');
    const cfg = await readConfig();
    assert.equal(cfg.enabled, false);
  } finally { fake.restore(); }
});
