// test/address-ledger-dedupe.test.mjs — THE DE-DUPE MAY ONLY DROP A REPEAT, NEVER A NEW EVENT.
//
// THE DEFECT (audit 2026-09-27, firestore-history-address-4). The address log's de-dupe key
// was `stopNbr|before.addr1|after.addr1|kind`. Zip, suite (addr2), city, state and source were
// not in it, so on one stop and one day a zip override (moved), its Reset (moved, back again)
// and a second zip correction (moved) all produced the SAME key and only the first was kept.
// The Address history screen then showed a superseded override as the last word on the
// address — wrong exactly when somebody is using it to settle a dispute.
//
// What the de-dupe is FOR is the scan re-filing the identical change every fifteen minutes
// after a failed board write. So a row is a repeat only when it is identical — every address
// part, the kind and the source — to the NEWEST row already on file for that stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { unrecordedAddressChanges } from '../netlify/functions/lib/address-history.mts';

const DAY = '2026-09-10';
const STOP = '007174397';
const ADDR = { addr1: '5965 PEACHTREE CORS E STE B3', addr2: '', city: 'NORCROSS', state: 'GA' };

async function postAll(bodies) {
  const fake = installFirestoreFake({});
  try {
    const handler = (await import('../netlify/functions/address-history.mts')).default;
    const { readAddressChanges } = await import('../netlify/functions/lib/firestore.mts');
    const answers = [];
    for (const b of bodies) {
      const res = await handler(new Request('https://x.netlify.app/.netlify/functions/address-history', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stopNbr: STOP, date: DAY, ...b }),
      }));
      answers.push(await res.json());
    }
    return { answers, rows: await readAddressChanges('davis', DAY) };
  } finally { fake.restore(); }
}

test('a zip override, its Reset, and a second zip correction on one stop in one day are all in the log', async () => {
  const { answers, rows } = await postAll([
    { source: 'override', before: { ...ADDR, zip: '30071' }, after: { ...ADDR, zip: '30092' } },
    { source: 'override-reset', before: { ...ADDR, zip: '30092' }, after: { ...ADDR, zip: '30071' } },
    { source: 'override', before: { ...ADDR, zip: '30071' }, after: { ...ADDR, zip: '30093' } },
  ]);
  assert.deepEqual(answers.map((a) => a.recorded), [true, true, true]);
  // Newest first: the board is on 30093, and the log's last word says so.
  assert.deepEqual(rows.map((r) => `${r.source} ${r.before.zip}->${r.after.zip}`), [
    'override 30071->30093',
    'override-reset 30092->30071',
    'override 30071->30092',
  ]);
});

test('two suite corrections on the same stop in one day are both in the log', async () => {
  const { rows } = await postAll([
    { source: 'override', before: { ...ADDR, addr1: '100 MAIN ST', addr2: 'STE 100', zip: '30071' }, after: { ...ADDR, addr1: '100 MAIN ST', addr2: 'STE 200', zip: '30071' } },
    { source: 'override', before: { ...ADDR, addr1: '100 MAIN ST', addr2: 'STE 200', zip: '30071' }, after: { ...ADDR, addr1: '100 MAIN ST', addr2: 'STE 300', zip: '30071' } },
  ]);
  assert.deepEqual(rows.map((r) => r.after.addr2), ['STE 300', 'STE 200']);
});

test('re-applying an override after a Reset is recorded again — it is a new act, not a repeat', async () => {
  const { rows } = await postAll([
    { source: 'override', before: { ...ADDR, zip: '30071' }, after: { ...ADDR, zip: '30092' } },
    { source: 'override-reset', before: { ...ADDR, zip: '30092' }, after: { ...ADDR, zip: '30071' } },
    { source: 'override', before: { ...ADDR, zip: '30071' }, after: { ...ADDR, zip: '30092' } },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].source, 'override');
  assert.equal(rows[0].after.zip, '30092');
});

test('the same correction saved twice in a row is filed once', async () => {
  const body = { source: 'override', before: { ...ADDR, zip: '30071' }, after: { ...ADDR, zip: '30092' } };
  const { answers, rows } = await postAll([body, body]);
  assert.equal(rows.length, 1);
  assert.equal(answers[1].recorded, false);
});

test('PURE: the scan re-observing the change it already filed is dropped; a different stop is not', () => {
  const row = (stopNbr, zipFrom, zipTo, source = 'scan') => ({
    stopNbr, source, kind: 'moved', before: { ...ADDR, zip: zipFrom }, after: { ...ADDR, zip: zipTo },
  });
  const prior = [row(STOP, '30071', '30092')];
  assert.deepEqual(unrecordedAddressChanges(prior, [row(STOP, '30071', '30092')]), [], 'the re-observation');
  assert.equal(unrecordedAddressChanges(prior, [row('007174398', '30071', '30092')]).length, 1, 'another stop');
  assert.equal(unrecordedAddressChanges(prior, [row(STOP, '30071', '30092', 'override')]).length, 1, 'a dispatcher making the same change is its own event');
  // Formatting does not make a repeat look new: the same change re-observed with different case.
  assert.deepEqual(unrecordedAddressChanges(prior, [{ ...row(STOP, '30071', '30092'), before: { ...ADDR, city: 'Norcross', zip: '30071' } }]), []);
  // Only the NEWEST row for the stop is compared: the vendor flipping back and forth is three events.
  const flipped = [row(STOP, '30092', '30071'), row(STOP, '30071', '30092')];
  assert.equal(unrecordedAddressChanges(flipped, [row(STOP, '30071', '30092')]).length, 1);
  // A dispatcher's edit in between does not let the scan re-file what it already filed.
  const edited = [row(STOP, '30092', '30093', 'override'), row(STOP, '30071', '30092')];
  assert.deepEqual(unrecordedAddressChanges(edited, [row(STOP, '30071', '30092')]), []);
});
