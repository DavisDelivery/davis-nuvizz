// test/address-log-refused-write-outcome.test.mjs — THE BROWSER MAY ONLY CALL A ROW "DECLINED"
// WHEN THE SERVER SAID WHY.
//
// THE DEFECT (audit 2026-09-27, client-lookup-account-libs-3). logAddressOverride read ANY
// 200 answer carrying recorded:false as outcome 'declined', detail 'already recorded'. The
// problem-address queue's group run counts a decline as logged, and its "N of M did not reach
// the address history" line exists for the rows that did not — so a server answer that did
// not say why (the shape a refused Firestore write used to come back in) silently read as a
// clean run. A decline is now only a decline when it carries its reason; anything else is a
// failure the run reports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { logAddressOverride } from '../src/lib/address-log.js';

const STOP = { stopNbr: '007157687', businessName: 'ACME', boardDate: '2026-09-10', isPlanned: false };
const BEFORE = { addr1: '5965 PEACHTREE STREET', addr2: '', city: 'NORCROSS', state: 'GA', zip: '30071' };
const AFTER = { addr1: '5965 PEACHTREE CORS E STE B3', addr2: '', city: 'NORCROSS', state: 'GA', zip: '30071' };

/** What the queue's group run counts as having reached the address history. */
const countsAsLogged = (logged) => logged?.recorded === true || logged?.outcome === 'declined';

async function withServerAnswer(answer, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('a row the server did not record and gave no reason for is counted as NOT reaching the address history', async () => {
  const logged = await withServerAnswer({ body: { ok: true, recorded: false } },
    () => logAddressOverride({ stop: STOP, before: BEFORE, after: AFTER }));
  assert.equal(logged.recorded, false);
  assert.equal(logged.outcome, 'failed');
  assert.equal(countsAsLogged(logged), false);
});

test('a correct refusal that says why is still a decline, and still not held against the run', async () => {
  for (const reason of ['already recorded', 'no material change']) {
    const logged = await withServerAnswer({ body: { ok: true, recorded: false, reason } },
      () => logAddressOverride({ stop: STOP, before: BEFORE, after: AFTER }));
    assert.equal(logged.outcome, 'declined', reason);
    assert.equal(logged.detail, reason);
  }
});

test('end to end: a correction whose audit row Firestore refused is reported by the group run as not logged', async () => {
  const fake = installFirestoreFake({});
  const fsFetch = globalThis.fetch;
  const handler = (await import('../netlify/functions/address-history.mts')).default;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if (url.startsWith('/.netlify/functions/address-history')) return handler(new Request(`https://x.netlify.app${url}`, init));
    if (String(init.method || '').toUpperCase() === 'PATCH' && url.includes('addr_changes__')) {
      return new Response('{"error":{"status":"UNAVAILABLE"}}', { status: 503 });
    }
    return fsFetch(input, init);
  };
  try {
    const logged = await logAddressOverride({ stop: STOP, before: BEFORE, after: AFTER });
    assert.equal(logged.recorded, false);
    assert.equal(logged.outcome, 'failed');
    assert.equal(countsAsLogged(logged), false);
  } finally { globalThis.fetch = fsFetch; fake.restore(); }
});
