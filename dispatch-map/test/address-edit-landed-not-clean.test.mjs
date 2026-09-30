// test/address-edit-landed-not-clean.test.mjs
//
// THE COMMON OUTCOME THAT CRASHED THE MODAL (audit 2026-09-27, app-A1-1).
//
// "Edit address" with "Also correct order N in NuVizz" ticked. NuVizz takes the new street, and
// the read-back also sees something else on the order move (the `documents: LOST …` attachment
// check fires on about half of all address pushes). The server answers ok:false with
// addressLanded:true — "the address is on the order, but look at the rest of it".
//
// The modal read `out.now` in that branch, and `out` was declared inside the try block above
// it. So the one outcome the modal says it must word carefully threw "out is not defined": a
// red error, a spinner that never stopped, and no Address-history row for a change that DID
// reach NuVizz. A dispatcher reading that retries — and every retry is three more NuVizz calls.
//
// These RUN the modal's real save() — sliced out of App.jsx and executed with stubbed Firestore,
// geocoder and write client — because the defect was a scoping error that no regex over the
// source could have seen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { addressReachedNuvizz } from '../src/lib/nuvizzWrite.js';
import { plainWriteError } from '../src/lib/write-error.js';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  const body = APP.slice(start, next > 0 ? next : undefined);
  assert.ok(body.length > 200, `${name} sliced to nothing`);
  return body;
}

const MODAL = fnSource('AddressEditModal');
const SAVE_SRC = (() => {
  const start = MODAL.indexOf('const save = async () => {');
  const end = MODAL.indexOf('\n  const reset = async');
  assert.ok(start > 0 && end > start, 'save() could not be sliced out of AddressEditModal');
  return MODAL.slice(start, end);
})();

/** The modal's own save(), run against stubs. Strict mode, as the ES module it lives in is. */
function runSave({ vendor, geocode }) {
  const seen = { err: [], busy: [], push: [], log: [], docs: [], closed: 0, saved: 0 };
  const env = {
    addr1: '100 Main St', addr2: '', city: 'Buford', state: 'GA', zip: '30518',
    setErr: (v) => seen.err.push(v),
    setBusy: (v) => seen.busy.push(v),
    setPush: (v) => seen.push.push(v),
    google: {},
    stop: { stopNbr: '007174397', stopId: 'abc123', matchKey: 'acme|buford', businessName: 'ACME' },
    note: null,
    shownAddress: () => ({ addr1: 'PMB 271', city: 'Buford', state: 'GA', zip: '30518' }),
    geocodeAddress: geocode,
    setDoc: async (ref, data) => { seen.docs.push(data); },
    doc: (_db, coll, id) => `${coll}/${id}`,
    db: {},
    serverTimestamp: () => 'ts',
    logAddressOverride: (row) => { seen.log.push(row); return Promise.resolve({ recorded: true }); },
    onSaved: () => { seen.saved += 1; },
    onClose: () => { seen.closed += 1; },
    canPush: true,
    toNuvizz: true,
    pro: '007174397',
    setStopAddress: vendor,
    addressReachedNuvizz,
    plainWriteError,
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const save = new Function(...names, `'use strict';\n${SAVE_SRC}\nreturn save;`)(...names.map((k) => env[k]));
  return { save, seen };
}

const geocodeOk = async () => ({ lat: 34.1, lng: -84.0, formatted: '100 Main St, Buford, GA 30518' });

// The server's envelope for "address landed, write not clean", exactly as nuvizz-write.mts
// wraps runSetStopAddress: { ok, error, result: { ok:false, addressLanded:true, now, … } }.
const landedNotClean = async () => ({
  ok: false,
  httpStatus: 502,
  error: 'documents: LOST to|BOL|03||pdf||01',
  result: { ok: false, addressLanded: true, now: '100 MAIN ST, BUFORD, GEORGIA 30518', error: 'documents: LOST to|BOL|03||pdf||01' },
});

test('a NuVizz address write that landed but touched another field tells the dispatcher the address is on the order', async () => {
  const { save, seen } = runSave({ vendor: landedNotClean, geocode: geocodeOk });
  await save();
  assert.deepEqual(seen.err.filter((e) => e != null), [], 'no red error — the address IS saved, on the board and on the order');
  const last = seen.push.at(-1);
  assert.equal(last?.kind, 'warn', 'amber: landed, with something to check');
  assert.match(last.text, /^NuVizz now reads 100 MAIN ST, BUFORD, GEORGIA 30518\./, 'quotes what NuVizz stored, first');
  assert.match(last.text, /check it in the portal before the truck goes: documents: LOST/, 'and names what else moved');
  assert.doesNotMatch(last.text, /still has the old address/, 'never sends anybody to re-type an address already correct');
});

test('…the spinner stops: the last word on screen is the vendor answer, not "Writing it onto the order"', async () => {
  const { save, seen } = runSave({ vendor: landedNotClean, geocode: geocodeOk });
  await save();
  assert.notEqual(seen.push.at(-1)?.kind, 'busy', 'a busy line left up for good reads as a write still in flight');
  assert.equal(seen.busy.at(-1), false);
});

test('…and Address history gets its row, recorded as having reached NuVizz', async () => {
  const { save, seen } = runSave({ vendor: landedNotClean, geocode: geocodeOk });
  await save();
  assert.equal(seen.log.length, 1, 'a change that reached the order leaves a record');
  assert.equal(seen.log[0].nuvizz, true, 'the address landed — the audit row says so');
  assert.equal(seen.log[0].source, 'override');
});

test('the clean and the refused outcomes still read as they did', async () => {
  {
    const { save, seen } = runSave({
      vendor: async () => ({ ok: true, result: { ok: true, addressLanded: true, now: '100 MAIN ST, BUFORD, GEORGIA 30518' } }),
      geocode: geocodeOk,
    });
    await save();
    assert.deepEqual(seen.push.at(-1), { kind: 'ok', text: 'NuVizz now reads 100 MAIN ST, BUFORD, GEORGIA 30518.' });
    assert.equal(seen.log[0].nuvizz, true);
  }
  {
    const { save, seen } = runSave({
      vendor: async () => ({ ok: false, httpStatus: 502, error: 'NuVizz rejected the address', result: { ok: false, addressLanded: false } }),
      geocode: geocodeOk,
    });
    await save();
    assert.equal(seen.push.at(-1).kind, 'warn');
    assert.match(seen.push.at(-1).text, /^Saved on the board, but NuVizz did not take it: NuVizz rejected the address/);
    assert.equal(seen.log[0].nuvizz, false);
    assert.deepEqual(seen.err.filter((e) => e != null), []);
  }
});
