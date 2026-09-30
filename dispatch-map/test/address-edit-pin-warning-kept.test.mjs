// test/address-edit-pin-warning-kept.test.mjs
//
// "THE PIN COULD NOT BE MOVED" MUST SURVIVE THE NUVIZZ ANSWER (audit 2026-09-27, app-A1-3).
//
// A dispatcher corrects an address Google cannot geocode (ZERO_RESULTS — common on exactly the
// addresses most likely to be wrong). The board saves the text and leaves the pin where it was;
// the modal says so in amber. With "Also correct order N in NuVizz" ticked — the default — the
// vendor half then wrote its own line into the same single message slot: a green "NuVizz now
// reads …" and a Done button, with nothing left on screen saying the map pin, which routing
// uses, still points at the old building.
//
// The modal's own comment already names the failure: "closing over that warning is how a
// dispatcher comes away believing the stop is fixed when the map still points at the old
// building". These run the real save() out of App.jsx and read the LAST message it leaves up.
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

function runSave({ vendor, geocode, toNuvizz = true }) {
  const seen = { err: [], push: [], log: [], docs: [], closed: 0 };
  const env = {
    addr1: '100 Main St', addr2: '', city: 'Buford', state: 'GA', zip: '30518',
    setErr: (v) => seen.err.push(v),
    setBusy: () => {},
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
    onSaved: () => {},
    onClose: () => { seen.closed += 1; },
    canPush: true,
    toNuvizz,
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

const geocodeFails = async () => { throw new Error("Couldn't find that address"); };
const geocodeOk = async () => ({ lat: 34.1, lng: -84.0, formatted: '100 Main St, Buford, GA 30518' });
const nuvizzTookIt = async () => ({ ok: true, result: { ok: true, addressLanded: true, now: '100 MAIN ST, BUFORD, GEORGIA 30518' } });

test('an address Google cannot find, pushed to NuVizz cleanly, still tells the dispatcher the pin did not move', async () => {
  const { save, seen } = runSave({ vendor: nuvizzTookIt, geocode: geocodeFails });
  await save();
  const last = seen.push.at(-1);
  assert.match(last.text, /NuVizz now reads 100 MAIN ST, BUFORD, GEORGIA 30518\./, 'the vendor half is still reported');
  assert.match(last.text, /pin could not be moved — Couldn't find that address/, 'and the pin half is not overwritten');
  assert.match(last.text, /Correct pin location/, 'with the next action');
  assert.equal(last.kind, 'warn', 'amber, never a green all-clear over a pin on the old building');
  assert.equal(seen.closed, 0, 'and the modal stays up so it can be read');
  assert.ok(!('location_override' in seen.docs[0]), 'no pin was written — the warning is true');
});

test('…and so does a refused push, and a push that landed but touched something else', async () => {
  for (const vendor of [
    async () => ({ ok: false, httpStatus: 502, error: 'NuVizz rejected the address', result: { ok: false, addressLanded: false } }),
    async () => ({ ok: false, httpStatus: 502, error: 'documents: LOST x', result: { ok: false, addressLanded: true, now: '100 MAIN ST, BUFORD, GEORGIA 30518' } }),
  ]) {
    const { save, seen } = runSave({ vendor, geocode: geocodeFails });
    await save();
    const last = seen.push.at(-1);
    assert.equal(last.kind, 'warn');
    assert.match(last.text, /pin could not be moved — Couldn't find that address/);
  }
});

test('a pin that DID move leaves the NuVizz line exactly as before — green, no pin talk', async () => {
  const { save, seen } = runSave({ vendor: nuvizzTookIt, geocode: geocodeOk });
  await save();
  assert.deepEqual(seen.push.at(-1), { kind: 'ok', text: 'NuVizz now reads 100 MAIN ST, BUFORD, GEORGIA 30518.' });
});

test('the board-only path is unchanged: the pin warning shows and the modal is held open', async () => {
  const { save, seen } = runSave({ vendor: nuvizzTookIt, geocode: geocodeFails, toNuvizz: false });
  await save();
  assert.equal(seen.push.at(-1).kind, 'warn');
  assert.match(seen.push.at(-1).text, /^Address saved, but the pin could not be moved/);
  assert.equal(seen.closed, 0);
});
