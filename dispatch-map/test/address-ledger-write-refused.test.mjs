// test/address-ledger-write-refused.test.mjs — A REFUSED WRITE IS A FAILURE, NOT A DECLINE.
//
// THE DEFECT (audit 2026-09-27, firestore-history-address-3). recordAddressChanges returned
// `false` for three different things — a real repeat (the de-dupe), a thrown write, a thrown
// read — and the POST answered all three `{ ok: true, recorded: false }` with no reason. The
// browser reads that as "declined — already recorded", and the problem-address queue's group
// run counts a decline as logged. So a correction whose audit row Firestore REFUSED (a 429 on
// write bandwidth, a 503) was reported as having reached the address history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

const DAY = '2026-09-10';
const BODY = {
  source: 'override', stopNbr: '007157687', date: DAY,
  before: { addr1: '5965 PEACHTREE STREET', city: 'NORCROSS', zip: '30071' },
  after: { addr1: '5965 PEACHTREE CORS E STE B3', city: 'NORCROSS', zip: '30071' },
};

/** The fake, with every PATCH to the day's address-log document answered `status`. */
function installRefusingWrites(status) {
  const fake = installFirestoreFake({});
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if (String(init.method || '').toUpperCase() === 'PATCH' && url.includes('addr_changes__')) {
      return new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status });
    }
    return inner(input, init);
  };
  return { ...fake, restore: () => { globalThis.fetch = inner; fake.restore(); } };
}

const post = async (body) => {
  const handler = (await import('../netlify/functions/address-history.mts')).default;
  return handler(new Request('https://x.netlify.app/.netlify/functions/address-history', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
};

test('a correction whose address-log write Firestore refuses is answered as a failure, not "already recorded"', async () => {
  const fake = installRefusingWrites(429);
  try {
    const res = await post(BODY);
    const j = await res.json();
    assert.equal(j.recorded, false);
    assert.equal(j.ok, false, 'a write that did not land is not a correct refusal');
    assert.ok(res.status >= 500, `HTTP ${res.status}`);
    assert.match(String(j.error), /429|failed/);
    const { readAddressChanges } = await import('../netlify/functions/lib/firestore.mts');
    assert.equal((await readAddressChanges('davis', DAY)).length, 0, 'and indeed nothing was stored');
  } finally { fake.restore(); }
});

test('the same correction logged twice is declined WITH its reason, and is still ok', async () => {
  const fake = installFirestoreFake({});
  try {
    const first = await (await post(BODY)).json();
    assert.equal(first.recorded, true);
    const res = await post(BODY);
    const again = await res.json();
    assert.equal(res.status, 200);
    assert.equal(again.ok, true);
    assert.equal(again.recorded, false);
    assert.equal(again.reason, 'already recorded');
  } finally { fake.restore(); }
});

test('the scan path is unchanged: a refused ledger write still never throws into the scan', async () => {
  const fake = installRefusingWrites(503);
  try {
    const { recordAddressChanges } = await import('../netlify/functions/lib/firestore.mts');
    const { buildAddressChangeRow } = await import('../netlify/functions/lib/address-history.mts');
    const row = buildAddressChangeRow({ at: '2026-09-10T11:00:00.000Z', date: DAY, stopNbr: '1', source: 'scan', before: { addr1: '1 A ST' }, after: { addr1: '2 A ST' } });
    assert.equal(await recordAddressChanges('davis', DAY, [row]), false);
  } finally { fake.restore(); }
});
