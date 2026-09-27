// test/address-ledger-read-failure.test.mjs — ONE FAILED READ MUST NOT WIPE A DAY'S LEDGER.
//
// THE DEFECT (audit 2026-09-27, firestore-history-address-2). recordAddressChanges appends by
// read-merge-replace: read the day's rows, prepend the new ones, setDoc the lot. The read
// swallowed every error as [] — so a transient 503 or a timeout on that one getDoc looked
// exactly like an empty day, and the setDoc that followed (no mask: a whole-document REPLACE)
// wrote only the new row. Every correction logged earlier that day was gone for good, and the
// call reported success. recordPlanVerdicts had the same shape. And the address-history GET,
// reading through the same swallow, answered ok:true with zero rows while every read was
// failing — "nothing changed" when the truth was "could not read".
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

const DAY = '2026-09-10';
const ADDR_DOC = `nuvizz_ops/addr_changes__davis__${DAY}`;
const VERDICT_DOC = `nuvizz_ops/plan_verdicts__davis__${DAY}`;

const addrRow = (stopNbr, from, to) => ({
  at: '2026-09-10T11:00:00.000Z', date: DAY, stopNbr, businessName: 'ACME', source: 'override', kind: 'renamed',
  before: { addr1: from, addr2: null, city: 'NORCROSS', state: 'GA', zip: '30071' },
  after: { addr1: to, addr2: null, city: 'NORCROSS', state: 'GA', zip: '30071' },
  fields: ['addr1'], route: null, planned: false, matchKey: null, actor: null,
});
const PRIOR = [
  addrRow('007174391', '1 A ST', '1 B ST'),
  addrRow('007174392', '2 A ST', '2 B ST'),
  addrRow('007174393', '3 A ST', '3 B ST'),
];
const verdictRow = (stopNbr) => ({ at: '2026-09-10T11:00:00.000Z', stopNbr, route: 'NOR 2', verdict: 'kept', basis: 'record', detail: 'x', path: ['record'], absent: false, listStatus: null });

/** The fake, with `failures` 503s injected on GETs of any document whose path includes `match`. */
function installWithFlakyRead(seed, match, failures = 1) {
  const fake = installFirestoreFake(seed);
  const inner = globalThis.fetch;
  let left = failures;
  const failed = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    const method = String(init.method || 'GET').toUpperCase();
    if (method === 'GET' && url.includes('firestore.googleapis.com') && url.includes(match) && left > 0) {
      left -= 1;
      failed.push(url);
      return new Response('{"error":{"status":"UNAVAILABLE"}}', { status: 503 });
    }
    return inner(input, init);
  };
  return { ...fake, failed, restore: () => { globalThis.fetch = inner; fake.restore(); } };
}

test("a transient read failure while logging a dispatcher's correction does not wipe the day's earlier corrections", async () => {
  const fake = installWithFlakyRead({
    [ADDR_DOC]: { tenant: 'davis', date: DAY, count: 3, rowsJson: JSON.stringify(PRIOR) },
  }, 'addr_changes__', 1);
  try {
    const { recordAddressChanges, readAddressChanges } = await import('../netlify/functions/lib/firestore.mts');
    const wrote = await recordAddressChanges('davis', DAY, [addrRow('007174394', '4 A ST', '4 B ST')]);
    assert.equal(fake.failed.length, 1, 'the read really did fail');
    assert.notEqual(wrote, true, 'a write that could not see the day must not claim it logged');
    const rows = await readAddressChanges('davis', DAY);
    assert.deepEqual(rows.map((r) => r.stopNbr), ['007174391', '007174392', '007174393'], 'the three earlier corrections are all still there');
    assert.equal(fake.log.sets.filter((s) => s.path === ADDR_DOC).length, 0, 'nothing replaced the document');

    // Once the read works again, the next correction appends as normal.
    assert.equal(await recordAddressChanges('davis', DAY, [addrRow('007174395', '5 A ST', '5 B ST')]), true);
    assert.equal((await readAddressChanges('davis', DAY)).length, 4);
  } finally { fake.restore(); }
});

test("a transient read failure while the scan records plan verdicts does not wipe the day's earlier verdicts", async () => {
  const fake = installWithFlakyRead({
    [VERDICT_DOC]: { tenant: 'davis', date: DAY, count: 2, rowsJson: JSON.stringify([verdictRow('A1'), verdictRow('A2')]) },
  }, 'plan_verdicts__', 1);
  try {
    const { recordPlanVerdicts, readPlanVerdicts } = await import('../netlify/functions/lib/firestore.mts');
    const wrote = await recordPlanVerdicts('davis', DAY, [verdictRow('A3')]);
    assert.equal(fake.failed.length, 1);
    assert.equal(wrote, false);
    assert.deepEqual((await readPlanVerdicts('davis', DAY)).map((r) => r.stopNbr), ['A1', 'A2']);
  } finally { fake.restore(); }
});

test('the address history screen says the log could not be read, instead of "nothing changed", when the reads fail', async () => {
  const fake = installWithFlakyRead({
    [ADDR_DOC]: { tenant: 'davis', date: DAY, count: 3, rowsJson: JSON.stringify(PRIOR) },
  }, 'addr_changes__', 1000);
  try {
    const handler = (await import('../netlify/functions/address-history.mts')).default;
    const res = await handler(new Request(`https://x.netlify.app/.netlify/functions/address-history?from=${DAY}&to=${DAY}`));
    const body = await res.json();
    assert.equal(body.ok, false, 'an unreadable day is not an empty day');
    assert.ok(res.status >= 500);
    assert.match(String(body.error), /503|failed/);
  } finally { fake.restore(); }
});

test('an absent day document is still an empty day, not an error', async () => {
  const fake = installFirestoreFake({});
  try {
    const handler = (await import('../netlify/functions/address-history.mts')).default;
    const body = await (await handler(new Request(`https://x.netlify.app/.netlify/functions/address-history?from=${DAY}&to=${DAY}`))).json();
    assert.equal(body.ok, true);
    assert.equal(body.matched, 0);
    const { recordAddressChanges, readAddressChanges } = await import('../netlify/functions/lib/firestore.mts');
    assert.equal(await recordAddressChanges('davis', DAY, [addrRow('007174394', '4 A ST', '4 B ST')]), true, 'the first row of a new day still lands');
    assert.equal((await readAddressChanges('davis', DAY)).length, 1);
  } finally { fake.restore(); }
});
