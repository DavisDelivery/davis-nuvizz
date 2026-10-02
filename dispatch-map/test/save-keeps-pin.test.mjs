// test/save-keeps-pin.test.mjs — A SAVE THAT DOES NOT MOVE THE PLACE KEEPS THE PIN (v1.106.2).
//
// Chad, on the proposal "stop Save from replacing a pin placed by hand": "yes do 1 and 2".
//
// Every address Save geocoded the street and wrote the answer over the pin — including a Save
// that changed nothing about WHERE the place is: the same street opened and saved again to push
// it to NuVizz, or a fix to the suite line. The geocode asks only about the street line, city,
// state and ZIP (line 2 is left out on purpose), so for those it can only re-find the street —
// never improve a pin somebody dragged onto the right dock, only replace it.
//
// What this pins, each named for the failure it prevents:
//   1. THE SAME QUESTION IS RECOGNISED — through the spellings, the state and line 2.
//   2. A STREET, CITY OR ZIP THAT MOVES STILL GEOCODES — a truck must not go to the old building.
//   3. A PIN OLDER THAN THE CORRECTION IS NOT KEPT — it is already on the old building.
//   4. THE BROWSER'S TIMESTAMPS ARE READ — a Firestore Timestamp is not "cannot tell".
//   5. A KEPT PIN IS RE-STAMPED ON THE SAME WRITE — or the queue lists it as "Pin not moved".
//   6. VITE_SAVE_KEEPS_PIN=off puts the old rule back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sameGeocodeQuery, notePinState, keepsPin } from '../src/lib/address-fix.js';
import { addressReachedNuvizz } from '../src/lib/nuvizzWrite.js';
import { plainWriteError } from '../src/lib/write-error.js';
import { shownAddress } from '../src/lib/address-log.js';
import { houseSwitchOn } from '../src/lib/routing-select.js';
import { Timestamp } from 'firebase/firestore';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

// EXPANDED TECHNOLOGIES INC — one of the three live "Not in NuVizz" rows on 2026-10-02.
const SHOWN = { addr1: '1155 HAYES INDUSTRIAL DR', addr2: 'RECEIVING', city: 'MARIETTA', state: 'GA', zip: '30062' };
// A REAL Firestore Timestamp, as the browser's copy of a note holds one — the shape the server's
// string parser (pinIsStale) cannot read.
const TS = (iso) => Timestamp.fromDate(new Date(iso));

// ── 1/2. the question ──────────────────────────────────────────────────────────────────────────

test('THE SAME QUESTION: line 2, the state and the usual spellings do not move the place', () => {
  assert.equal(sameGeocodeQuery(SHOWN, { ...SHOWN }), true);
  assert.equal(sameGeocodeQuery(SHOWN, { ...SHOWN, addr2: 'DOCK 4 — RECEIVING AT THE REAR' }), true, 'line 2 is not in the geocode');
  assert.equal(sameGeocodeQuery(SHOWN, { ...SHOWN, addr1: '1155 Hayes Industrial Drive', state: 'GEORGIA', zip: '30062-1144' }), true);
  assert.equal(sameGeocodeQuery(SHOWN, { ...SHOWN, city: 'Marietta ' }), true);
});

test('A STREET, CITY OR ZIP THAT MOVES IS A DIFFERENT QUESTION — that save still geocodes', () => {
  assert.equal(sameGeocodeQuery(SHOWN, { ...SHOWN, addr1: '1157 HAYES INDUSTRIAL DR' }), false, 'another building');
  assert.equal(sameGeocodeQuery(SHOWN, { ...SHOWN, zip: '30066' }), false);
  assert.equal(sameGeocodeQuery(SHOWN, { ...SHOWN, city: 'KENNESAW' }), false);
  // The mis-split fix moves the street INTO line 1 — the old pin was geocoded off the dock line.
  assert.equal(sameGeocodeQuery({ ...SHOWN, addr1: 'RECEIVING', addr2: '1155 HAYES INDUSTRIAL DR' }, SHOWN), false);
});

// ── 3/4. the pin ───────────────────────────────────────────────────────────────────────────────

test('notePinState reads the browser’s Timestamps — and calls a pin older than the correction stale', () => {
  const pin = { lat: 33.9784, lng: -84.5437 };
  const at = '2026-09-29T23:34:08.553Z';
  assert.deepEqual(notePinState({ location_override: pin, address_override_at: TS(at), location_override_at: TS(at) }), { pinned: true, stale: false }, 'same write');
  assert.deepEqual(notePinState({ location_override: pin, address_override_at: TS(at), location_override_at: TS('2026-09-29T23:40:00Z') }), { pinned: true, stale: false }, 'dragged after');
  assert.deepEqual(notePinState({ location_override: pin, address_override_at: TS(at), location_override_at: TS('2026-09-20T08:00:00Z') }), { pinned: true, stale: true }, 'pinned before the correction');
  assert.deepEqual(notePinState({ location_override: pin, address_override_at: { seconds: 1790000000, nanoseconds: 0 }, location_override_at: { seconds: 1790000000, nanoseconds: 0 } }), { pinned: true, stale: false }, 'a plain {seconds} copy');
  assert.deepEqual(notePinState({ location_override: pin, address_override_at: at, location_override_at: at }), { pinned: true, stale: false }, 'an ISO string');
  assert.deepEqual(notePinState({ location_override: pin, address_override_at: TS(at) }), { pinned: true, stale: true }, 'pinned, but cannot prove when');
  assert.deepEqual(notePinState({ location_override: pin }), { pinned: true, stale: false }, 'a dragged pin with no address correction');
  assert.deepEqual(notePinState({ location_override: null, address_override_at: TS(at) }), { pinned: false, stale: true });
  assert.deepEqual(notePinState({ location_override: { lat: null, lng: null } }), { pinned: false, stale: false }, 'Number(null) is 0 — not a pin');
  assert.deepEqual(notePinState(null), { pinned: false, stale: false });
});

test('keepsPin: a pin of our own, not stale, and the same question — all three, or it geocodes', () => {
  const fresh = { pinned: true, stale: false };
  assert.equal(keepsPin(fresh, SHOWN, { ...SHOWN, addr2: 'DOCK 4' }), true);
  assert.equal(keepsPin({ pinned: false, stale: false }, SHOWN, SHOWN), false, 'no pin of our own: the geocode IS the pin');
  assert.equal(keepsPin({ pinned: true, stale: true }, SHOWN, SHOWN), false, 'a stale pin is on the old building');
  assert.equal(keepsPin(fresh, SHOWN, { ...SHOWN, addr1: '1157 HAYES INDUSTRIAL DR' }), false);
});

// ── 5. Edit address — the modal's own save(), with its dependencies injected ───────────────────

function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  return APP.slice(start, next > 0 ? next : undefined);
}
const MODAL = fnSource('AddressEditModal');
const SAVE_SRC = MODAL.slice(MODAL.indexOf('const save = async () => {'), MODAL.indexOf('\n  const reset = async'));

const HAND_PIN = { lat: 33.97842, lng: -84.54373 };
const NOTE = {
  address_override: SHOWN, address_override_at: TS('2026-09-29T23:34:08.553Z'),
  location_override: HAND_PIN, location_override_at: TS('2026-09-29T23:36:00.000Z'),
};
function runSave({ fields, note = NOTE, keepSwitch = true, toNuvizz = false }) {
  const seen = { geocode: 0, docs: [], push: [] };
  const env = {
    addr1: fields.addr1, addr2: fields.addr2, city: fields.city, state: fields.state, zip: fields.zip,
    setErr: () => {}, setBusy: () => {}, setPush: (v) => seen.push.push(v),
    google: {},
    stop: { stopNbr: '007185593', stopId: 'abc', matchKey: 'expanded_technologies___receiving__marietta__30062', businessName: 'EXPANDED TECHNOLOGIES INC', addr1: 'RECEIVING', addr2: '1155 HAYES INDUSTRIAL DR', city: 'MARIETTA', state: 'GA', zip: '30062' },
    note,
    shownAddress,
    geocodeAddress: async () => { seen.geocode += 1; return { lat: 33.9781, lng: -84.5440 }; },
    setDoc: async (_ref, data) => { seen.docs.push(data); },
    doc: (_db, coll, id) => `${coll}/${id}`,
    db: {},
    serverTimestamp: () => 'ts',
    logAddressOverride: () => Promise.resolve({ recorded: true }),
    onSaved: () => {}, onClose: () => {},
    canPush: true, toNuvizz, pro: '007185593',
    setStopAddress: async () => ({ ok: true, result: { ok: true, now: 'x' } }),
    addressReachedNuvizz, plainWriteError,
    SAVE_KEEPS_PIN: keepSwitch, keepsPin, notePinState,
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const save = new Function(...names, `'use strict';\n${SAVE_SRC}\nreturn save;`)(...names.map((k) => env[k]));
  return { save, seen };
}

test('EDIT ADDRESS: saving the same street again — to push it, or with a new suite line — keeps the pin', async () => {
  for (const fields of [SHOWN, { ...SHOWN, addr2: 'DOCK 4 — RECEIVING' }]) {
    const { save, seen } = runSave({ fields });
    await save();
    assert.equal(seen.geocode, 0, `no geocode for ${fields.addr2}`);
    assert.equal('location_override' in seen.docs[0], false, 'the pin is not written over');
    assert.equal(seen.docs[0].location_override_at, 'ts', 'it is re-stamped on the same write as the address');
    assert.equal(seen.docs[0].address_override_at, 'ts');
    assert.deepEqual(seen.docs[0].address_override, fields, 'the address itself still saves');
  }
});

test('EDIT ADDRESS: a new street, no pin of our own, or a stale one — geocodes exactly as before', async () => {
  const cases = [
    { fields: { ...SHOWN, addr1: '1157 HAYES INDUSTRIAL DR' } },
    { fields: SHOWN, note: null },
    { fields: SHOWN, note: { ...NOTE, location_override_at: TS('2026-09-01T00:00:00Z') } },
  ];
  for (const c of cases) {
    const { save, seen } = runSave(c);
    await save();
    assert.equal(seen.geocode, 1, JSON.stringify(c.fields.addr1));
    assert.deepEqual(seen.docs[0].location_override, { lat: 33.9781, lng: -84.5440 });
  }
});

test('VITE_SAVE_KEEPS_PIN=off puts the old rule back — every Save geocodes; a typo leaves it on', async () => {
  const { save, seen } = runSave({ fields: SHOWN, keepSwitch: false });
  await save();
  assert.equal(seen.geocode, 1);
  assert.match(APP, /const SAVE_KEEPS_PIN = \(\(\) => \{\n\s+try \{ return houseSwitchOn\(import\.meta\.env\.VITE_SAVE_KEEPS_PIN\); \} catch \{ return true; \}\n\}\)\(\);/);
  for (const off of ['off', '0', 'false', 'no']) assert.equal(houseSwitchOn(off), false);
  for (const on of [undefined, '', 'on', 'of']) assert.equal(houseSwitchOn(on), true);
});

// ── the Problem addresses editor — saveQueueCorrection, with its dependencies injected ─────────

function fnOnly(name, prefix = 'function ') {
  const start = APP.indexOf(`${prefix}${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}
const constLine = (name) => { const s = APP.indexOf(`const ${name} = `); return APP.slice(s, APP.indexOf('\n', s)); };
const PURE = [constLine('oneLineAddr'), fnOnly('correctedFields'), fnOnly('queueBoardHasIt'), fnOnly('queueNoteText')].join('\n');
function queueSave(keepSwitch = true) {
  const seen = { geocode: 0, docs: [] };
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'db', 'doc', 'setDoc', 'serverTimestamp', 'geocodeAddress', 'setStopAddress', 'classifyPushResult', 'addressReachedNuvizz', 'logAddressOverride', 'SAVE_KEEPS_PIN', 'keepsPin',
    `'use strict';\n${PURE}\n${fnOnly('saveQueueCorrection', 'async function ')}\nreturn saveQueueCorrection;`,
  )({}, (_d, c, id) => `${c}/${id}`, async (_r, data) => { seen.docs.push(data); }, () => 'ts',
    async () => { seen.geocode += 1; return { lat: 1, lng: 2 }; }, async () => ({ ok: true, result: { ok: true } }),
    () => ({ kind: 'ok', text: '' }), () => true, async () => ({ recorded: true }), keepSwitch, keepsPin);
  return { fn, seen };
}
const QROW = {
  signal: 'not_in_nuvizz', key: 'not_in_nuvizz__007185593', stopNbr: '007185593', stopId: 'abc', matchKey: 'k', businessName: 'EXPANDED TECHNOLOGIES INC',
  shown: SHOWN, vendor: { ...SHOWN, addr1: 'RECEIVING', addr2: '1155 HAYES INDUSTRIAL DR' }, suggestion: null,
  pin: { ...HAND_PIN, source: 'override' }, date: '2026-10-02',
};

test('PROBLEM ADDRESSES: an edited row that keeps the street keeps its pin; a moved street, a feed pin or a "Pin not moved" row geocodes', async () => {
  let q = queueSave();
  await q.fn({ row: QROW, fields: { ...SHOWN, addr2: 'DOCK 4' }, google: {}, push: false, today: '2026-10-02', clientOpId: 'a' });
  assert.equal(q.seen.geocode, 0);
  assert.equal('location_override' in q.seen.docs[0], false);
  assert.equal(q.seen.docs[0].location_override_at, 'ts');
  for (const [row, fields] of [
    [QROW, { ...SHOWN, addr1: '1157 HAYES INDUSTRIAL DR' }],
    [{ ...QROW, pin: { ...HAND_PIN, source: 'feed' } }, { ...SHOWN, addr2: 'DOCK 4' }],
    [{ ...QROW, signal: 'corrected_not_pinned' }, { ...SHOWN, addr2: 'DOCK 4' }],
  ]) {
    q = queueSave();
    await q.fn({ row, fields, google: {}, push: false, today: '2026-10-02', clientOpId: 'b' });
    assert.equal(q.seen.geocode, 1, `${row.signal}/${row.pin.source}/${fields.addr1}`);
    assert.deepEqual(q.seen.docs[0].location_override, { lat: 1, lng: 2 });
  }
  q = queueSave(false);
  await q.fn({ row: QROW, fields: { ...SHOWN, addr2: 'DOCK 4' }, google: {}, push: false, today: '2026-10-02', clientOpId: 'c' });
  assert.equal(q.seen.geocode, 1, 'switched off: the old rule');
});

test('the one-click auto-fix is untouched — its split always moves the street, so it always geocodes', () => {
  const fix = APP.slice(APP.indexOf('const autoFixAddress = useCallback('), APP.indexOf('const cancelMoveLocation'));
  assert.ok(fix.length > 200);
  assert.doesNotMatch(fix, /keepsPin/);
  assert.match(fix, /try \{ geo = await geocodeAddress\(google, q\); \} catch \(e\) \{ geoErr = e; \}/);
});
