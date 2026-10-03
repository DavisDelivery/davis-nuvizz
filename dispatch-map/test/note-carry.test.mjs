// test/note-carry.test.mjs — A PUSH THAT RE-KEYS AN ORDER TAKES ITS CUSTOMER NOTE WITH IT.
//
// Chad, on two proposals — the second "don't lose a hand-placed pin when pushing: keep the pin on
// the order a push corrects": "yes do 1 and 2".
//
// A customer note is keyed by the order's own line 1, city and ZIP as NuVizz holds them, so an
// address push that moves line 1 re-keys the order on the next scan and the note — the hand pin,
// receiving hours, the opt-out — stops joining it. Measured on DESIGN PRINT BANNER 007183435,
// pushed 2026-09-28: sealed on 09-29 under …__1200_northbrook_pkwy_ste_180__… with no note.
//
// What this pins, each named for the failure it prevents:
//   1. THE NEW KEY IS THE ONE THE SCAN WILL USE — computed from what NuVizz STORED, and equal to
//      the key the real order was sealed under.
//   2. THE OLD KEY IS PROVEN, NOT TRUSTED — a stale board or a wrong key copies nothing, rather
//      than one customer's pin onto another's address.
//   3. ONLY INTO AN EMPTY PLACE — a note already under the new key is never touched.
//   4. NOTHING OF THE OLD ADDRESS TRAVELS — not the override, not a pin older than the correction.
//   5. A TIMESTAMP STAYS A TIMESTAMP — the copy never passes through the one-way decoder.
//   6. IT NEVER FAILS THE PUSH, costs no NuVizz call, and the write log says what happened.
//   7. ADDRESS_PUSH_CARRY_NOTE=off puts it back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';
import {
  carryKeys, carriedFields, carryNoteAfterPush, noteCarryEnabled, rawEmpty, NOT_CARRIED,
} from '../netlify/functions/lib/note-carry.mts';
import { getDoc, getDocFieldsRaw, createDocIfAbsent, createDocIfAbsentRaw } from '../netlify/functions/lib/firestore.mts';
import { normalizeMatchKey } from '../src/lib/matchKey.js';

installServiceAccountEnv();

// ── the real order ─────────────────────────────────────────────────────────────────────────────
const NAME = 'DESIGN PRINT BANNER';
const WAS = { addr1: 'DOCK 32', addr2: '1200 NORTHBROOK PKWY STE 180', city: 'SUWANEE', state: 'GA', zip: '30024' };
const NOW = { addr1: '1200 NORTHBROOK PKWY STE 180', addr2: 'DOCK 32', city: 'SUWANEE', state: 'GA', zip: '30024' };
const OLD_KEY = 'design_print_banner__dock_32__suwanee__30024';
// The key 007183435 was SEALED under on 2026-09-29, read from stop-lookup — a fact, not a derivation.
const SEALED_KEY = 'design_print_banner__1200_northbrook_pkwy_ste_180__suwanee__30024';
const PAYLOAD = { stopNbr: '007183435', matchKey: OLD_KEY, businessName: NAME };
// The orange case is the common one: the address landed and the BOL read back late (ok:false).
const LANDED = { ok: false, addressLanded: true, side: 'to', stopNbr: '007183435', wasAddress: WAS, nowAddress: NOW };

// ── 1/2. the keys ──────────────────────────────────────────────────────────────────────────────

test('THE NEW KEY IS THE ONE THE SCAN SEALED THE REAL ORDER UNDER — from what NuVizz stored', () => {
  assert.deepEqual(carryKeys(PAYLOAD, LANDED), { from: OLD_KEY, to: SEALED_KEY });
  assert.deepEqual(carryKeys(PAYLOAD, { ...LANDED, ok: true, addressLanded: undefined }), { from: OLD_KEY, to: SEALED_KEY }, 'a clean push too');
});

test('nothing to carry when the address did not land, on a pickup, or when the key did not move', () => {
  assert.match(carryKeys(PAYLOAD, { ...LANDED, addressLanded: false }).skip, /did not land/);
  assert.match(carryKeys(PAYLOAD, { ...LANDED, side: 'from' }).skip, /only a delivery address/);
  const suiteOnly = { ...LANDED, nowAddress: { ...WAS, addr2: '1200 NORTHBROOK PKWY STE 190' } };
  assert.match(carryKeys(PAYLOAD, suiteOnly).skip, /did not change/, 'line 2 is not in the key');
  assert.match(carryKeys(PAYLOAD, { ...LANDED, wasAddress: undefined }).skip, /did not report/);
});

test('THE OLD KEY IS PROVEN, NOT TRUSTED: a caller naming no note, or the wrong one, copies nothing', () => {
  assert.match(carryKeys({ stopNbr: '1' }, LANDED).skip, /did not say which customer note/, 'an old browser sends neither');
  const other = carryKeys({ ...PAYLOAD, matchKey: 'acme__1_main_st__suwanee__30024' }, LANDED).skip;
  assert.match(other, /acme__1_main_st__suwanee__30024/, 'names the key it was given');
  assert.match(other, new RegExp(OLD_KEY), 'and the key the order really had');
  // A board one scan behind NuVizz: the order was re-addressed in the portal since the board read it.
  const stale = carryKeys(PAYLOAD, { ...LANDED, wasAddress: { ...WAS, addr1: 'DOCK 33' } }).skip;
  assert.match(stale, /is not the key of this order's address in NuVizz/);
});

// ── 4. what is copied ──────────────────────────────────────────────────────────────────────────

const T = (iso) => ({ timestampValue: iso });
const S = (v) => ({ stringValue: v });
const map = (o) => ({ mapValue: { fields: o } });
const PIN = map({ lat: { doubleValue: 34.0601 }, lng: { doubleValue: -84.0712 } });
const HOURS = map({ mon: map({ open: S('07:00'), close: S('14:30') }), tue: map({ open: S('07:00'), close: S('14:30') }) });
// The note as Firestore stores it: corrected on Sep 26 at 19:40:31, pin dragged by hand 6 min later.
const SRC = () => ({
  match_key: S(OLD_KEY), raw_name: S(NAME), raw_address: S('DOCK 32, SUWANEE, GA 30024'),
  address_override: map({ addr1: S(NOW.addr1), addr2: S('DOCK 32'), city: S('SUWANEE'), state: S('GA'), zip: S('30024') }),
  address_override_at: T('2026-09-26T19:40:31.538Z'),
  location_override: PIN, location_override_at: T('2026-09-26T19:46:02.120Z'),
  receiving_hours: HOURS, comms_opt_out: { booleanValue: true }, dock_notes: S('USE DOCK 32 — BACK OF BUILDING'),
  vehicle_eligibility: S('box_only'), vehicle_eligibility_at: T('2026-09-01T12:00:00Z'), vehicle_eligibility_by: S('dispatcher'),
  updated_by: S('dispatcher'), last_updated: T('2026-09-26T19:46:02.120Z'),
});
const CTX = { from: OLD_KEY, to: SEALED_KEY, stopNbr: '007183435', at: '2026-10-02T14:30:00.000Z' };

test('THE COPY: every field verbatim — the hand pin, the hours, the opt-out, the vehicle mark — and where it came from', () => {
  const src = SRC();
  const out = carriedFields(src, CTX);
  for (const k of ['raw_name', 'location_override', 'location_override_at', 'receiving_hours', 'comms_opt_out', 'dock_notes', 'vehicle_eligibility', 'vehicle_eligibility_at', 'vehicle_eligibility_by']) {
    assert.deepEqual(out[k], src[k], `${k} exactly as stored`);
  }
  assert.deepEqual(out.location_override_at, T('2026-09-26T19:46:02.120Z'), 'the pin keeps its own age');
  assert.deepEqual(out.match_key, S(SEALED_KEY));
  assert.deepEqual(out.carried_from, S(OLD_KEY));
  assert.deepEqual(out.carried_for, S('007183435'));
  assert.deepEqual(out.carried_at, T(CTX.at));
  assert.deepEqual(src, SRC(), 'the old note is not modified');
});

test('NOTHING OF THE OLD ADDRESS TRAVELS: no override, no stamp, no raw address, no editor name', () => {
  const out = carriedFields(SRC(), CTX);
  for (const k of ['address_override', 'address_override_at', 'raw_address', 'updated_by']) assert.equal(k in out, false, k);
  for (const k of NOT_CARRIED) if (!['match_key', 'last_updated', 'carried_from', 'carried_for', 'carried_at'].includes(k)) assert.equal(k in out, false, k);
});

test('A PIN OLDER THAN THE CORRECTION STAYS BEHIND — it is on the old building; a pin that belongs to the address goes', () => {
  // Saved on the same write as the correction (the edit's own geocode): one stamp — goes.
  const sameWrite = { ...SRC(), location_override_at: T('2026-09-26T19:40:31.538Z') };
  assert.ok('location_override' in carriedFields(sameWrite, CTX));
  // Pinned BEFORE the address was corrected, and never moved since — stays.
  const stale = { ...SRC(), location_override_at: T('2026-09-20T08:00:00.000Z') };
  const out = carriedFields(stale, CTX);
  assert.equal('location_override' in out, false);
  assert.equal('location_override_at' in out, false, 'and its stamp with it');
  assert.ok('receiving_hours' in out, 'the rest still goes');
  // A dragged pin on a customer whose address was never corrected — goes.
  const { address_override, address_override_at, ...uncorrected } = SRC();
  assert.ok('location_override' in carriedFields(uncorrected, CTX));
  // A cleared pin (null) is not a pin.
  assert.equal('location_override' in carriedFields({ ...SRC(), location_override: { nullValue: null } }, CTX), false);
});

test('a note holding nothing but the old address and blank defaults is not copied', () => {
  const blank = {
    match_key: S(OLD_KEY), raw_name: S(NAME), address_override: SRC().address_override, address_override_at: SRC().address_override_at,
    receiving_hours: map({ mon: map({ open: S(''), close: S('') }) }), closed_days: { arrayValue: {} }, comms_opt_out: { booleanValue: false },
    dock_notes: S(''), contacts: { arrayValue: { values: [] } }, priority_flag: { nullValue: null }, manual_overrides: map({}),
  };
  assert.equal(carriedFields(blank, CTX), null);
  assert.ok(carriedFields({ ...blank, comms_opt_out: { booleanValue: true } }, CTX), 'an opt-out alone IS worth carrying');
  assert.equal(rawEmpty(T('2026-01-01T00:00:00Z')), false, 'a timestamp is a value');
  assert.equal(rawEmpty({ integerValue: '0' }), false, 'so is a number');
});

// ── 3/6. the carry, with its I/O injected ──────────────────────────────────────────────────────

function deps(over = {}) {
  const calls = { getRaw: [], create: [] };
  return {
    calls,
    d: {
      env: {},
      firestoreEnabled: () => true,
      getRaw: async (p) => { calls.getRaw.push(p); return SRC(); },
      createIfAbsentRaw: async (p, f) => { calls.create.push([p, f]); return true; },
      now: () => new Date('2026-10-02T14:30:00.000Z'),
      ...over,
    },
  };
}

test('carried: the copy is created under the new key, once, and the answer lists what went', async () => {
  const { calls, d } = deps();
  const out = await carryNoteAfterPush(PAYLOAD, LANDED, d);
  assert.deepEqual(calls.getRaw, [`customer_notes/${OLD_KEY}`]);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0][0], `customer_notes/${SEALED_KEY}`);
  assert.deepEqual(out.from, OLD_KEY);
  assert.deepEqual(out.to, SEALED_KEY);
  assert.ok(out.carried.includes('location_override') && out.carried.includes('receiving_hours') && out.carried.includes('comms_opt_out'));
  assert.equal(out.carried.includes('carried_from'), false, 'the bookkeeping is not reported as carried');
});

test('ONLY INTO AN EMPTY PLACE: a note already under the new key is left exactly as it is, and the answer says so', async () => {
  const { d } = deps({ createIfAbsentRaw: async () => false });
  const out = await carryNoteAfterPush(PAYLOAD, LANDED, d);
  assert.match(out.skipped, /already has its own note — nothing copied/);
  assert.equal(out.to, SEALED_KEY);
});

test('no note under the old key, a note with nothing in it, Firestore off — each a plain answer, nothing written', async () => {
  let r = deps({ getRaw: async () => null });
  assert.match((await carryNoteAfterPush(PAYLOAD, LANDED, r.d)).skipped, /no note under the board's key/);
  assert.equal(r.calls.create.length, 0);
  r = deps({ getRaw: async () => ({ match_key: S(OLD_KEY), raw_name: S(NAME) }) });
  assert.match((await carryNoteAfterPush(PAYLOAD, LANDED, r.d)).skipped, /nothing to carry/);
  assert.equal(r.calls.create.length, 0);
  r = deps({ firestoreEnabled: () => false });
  assert.match((await carryNoteAfterPush(PAYLOAD, LANDED, r.d)).skipped, /Firestore is not configured/);
  assert.equal(r.calls.getRaw.length, 0);
});

test('IT NEVER FAILS THE PUSH: a Firestore error is an answer, not a throw', async () => {
  const { d } = deps({ getRaw: async () => { throw new Error('getDocFieldsRaw customer_notes/x failed: 503'); } });
  const out = await carryNoteAfterPush(PAYLOAD, LANDED, d);
  assert.match(out.error, /503/);
  const { d: d2 } = deps({ createIfAbsentRaw: async () => { throw new Error('createDocIfAbsent failed: 500'); } });
  assert.match((await carryNoteAfterPush(PAYLOAD, LANDED, d2)).error, /500/);
});

test('ADDRESS_PUSH_CARRY_NOTE=off puts it back — no read, no write; a typo leaves it on', async () => {
  for (const off of ['off', 'OFF', '0', 'false', 'no', ' no ']) assert.equal(noteCarryEnabled({ ADDRESS_PUSH_CARRY_NOTE: off }), false, off);
  for (const on of [undefined, '', 'on', 'true', 'yes', 'of', 'nope']) assert.equal(noteCarryEnabled({ ADDRESS_PUSH_CARRY_NOTE: on }), true, String(on));
  const { calls, d } = deps({ env: { ADDRESS_PUSH_CARRY_NOTE: 'off' } });
  assert.match((await carryNoteAfterPush(PAYLOAD, LANDED, d)).skipped, /ADDRESS_PUSH_CARRY_NOTE=off/);
  assert.equal(calls.getRaw.length + calls.create.length, 0);
});

// ── 5. a timestamp stays a timestamp ───────────────────────────────────────────────────────────

test('A TIMESTAMP STAYS A TIMESTAMP: the raw read and the raw create carry it untouched — the decoded pair would not', async () => {
  const STORED = { location_override_at: T('2026-09-26T19:46:02.120Z'), location_override: PIN, comms_opt_out: { booleanValue: true } };
  const commits = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    if (url.includes('/documents:commit')) { commits.push(JSON.parse(String(init.body))); return new Response('{"writeResults":[{}]}', { status: 200 }); }
    if (url.includes('/documents/customer_notes/')) return new Response(JSON.stringify({ name: 'x', fields: STORED, updateTime: '2026-09-26T19:46:02.2Z' }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const raw = await getDocFieldsRaw(`customer_notes/${OLD_KEY}`);
    assert.deepEqual(raw.location_override_at, T('2026-09-26T19:46:02.120Z'), 'read: still a timestampValue');
    assert.equal(await createDocIfAbsentRaw(`customer_notes/${SEALED_KEY}`, raw), true);
    assert.deepEqual(commits[0].writes[0].update.fields.location_override_at, T('2026-09-26T19:46:02.120Z'), 'written: still a timestampValue');
    assert.deepEqual(commits[0].writes[0].currentDocument, { exists: false }, 'and only into an empty place');
    // WHY THE RAW PAIR EXISTS: the ordinary pair turns the same stamp into text.
    const decoded = await getDoc(`customer_notes/${OLD_KEY}`);
    await createDocIfAbsent(`customer_notes/${SEALED_KEY}`, decoded);
    assert.deepEqual(commits[1].writes[0].update.fields.location_override_at, S('2026-09-26T19:46:02.120Z'), 'the decoder is one-way');
    assert.deepEqual(commits[1].writes[0].currentDocument, { exists: false }, 'createDocIfAbsent is unchanged — the same create-if-absent');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('…and the carry itself is wired to the raw pair: the pin’s stamp reaches the new note as a timestamp', async () => {
  // The shared fake stores decoded values, so it cannot tell the raw pair from the decoded one —
  // this stub can. No injected I/O: the module's own reads and writes.
  const commits = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    if (url.includes('/documents:commit')) { commits.push(JSON.parse(String(init.body))); return new Response('{"writeResults":[{}]}', { status: 200 }); }
    if (url.includes(`/documents/customer_notes/${OLD_KEY}`)) return new Response(JSON.stringify({ name: 'x', fields: SRC() }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const out = await carryNoteAfterPush(PAYLOAD, LANDED);
    assert.ok(out.carried, JSON.stringify(out));
    const f = commits[0].writes[0].update.fields;
    assert.match(commits[0].writes[0].update.name, new RegExp(`/documents/customer_notes/${SEALED_KEY}$`));
    assert.deepEqual(f.location_override_at, T('2026-09-26T19:46:02.120Z'));
    assert.deepEqual(f.vehicle_eligibility_at, T('2026-09-01T12:00:00Z'));
    assert.ok('timestampValue' in f.carried_at, 'and its own stamp is a timestamp too');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── 6. end to end, through the real write endpoint ─────────────────────────────────────────────

process.env.NUVIZZ_WRITE_ENABLED = 'true';
process.env.NUVIZZ_DAVIS_USER = 'u';
process.env.NUVIZZ_DAVIS_PASS = 'p';
delete process.env.AUTH_REQUIRED;
delete process.env.NUVIZZ_PERSONAL_LOGINS;
const { default: writeHandler } = await import('../netlify/functions/nuvizz-write.mts');

const rawOrder = () => ({
  stopId: '6abe0a3b9e1c2d3f4a5b6c7d', stopNbr: '007183435', stopType: 'DO',
  to: { address: { addressType: 'ANY', name: NAME, ...WAS, state: 'GEORGIA', country: 'USA' }, contact: { name: NAME } },
  from: { address: { addressType: 'COM', name: 'DAVIS DELIVERY', addr1: '943 GAINESVILLE HIGHWAY', city: 'BUFORD', state: 'GEORGIA', zip: '30518' } },
  comments: [],
});
/** An honest NuVizz: stores the address it is sent, unless `ignore` — then the write does nothing.
 *  `store` rewrites what it keeps, the way NuVizz normalises a line its own way. */
function vendor({ ignore = false, store = (a) => a } = {}) {
  const state = { stop: rawOrder() };
  const calls = [];
  const onOther = async (url, init = {}) => {
    calls.push(String(url));
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (String(url).includes('/stop/info/')) return J({ Stop: { stop: state.stop, stopExecutionInfo: { stopStatus: 'PLANNED' }, load: {} } });
    if (String(url).includes('/stop/partialUpdate/')) {
      const sent = JSON.parse(String(init.body)).stops[0];
      if (!ignore) state.stop = { ...state.stop, to: { ...state.stop.to, address: store({ ...sent.to.address, state: 'GEORGIA' }) } };
      return J({ status: 'SUCESS', apiResult: { updated: 1, failed: 0, errors: [] } });
    }
    return J({}, 404);
  };
  return { calls, onOther, order: state.stop };
}
const NOTE_SEED = () => ({
  match_key: OLD_KEY, raw_name: NAME,
  address_override: { ...NOW }, address_override_at: '2026-09-26T19:40:31.538Z',
  location_override: { lat: 34.0601, lng: -84.0712 }, location_override_at: '2026-09-26T19:46:02.120Z',
  receiving_hours: { mon: { open: '07:00', close: '14:30' } }, comms_opt_out: true, dock_notes: 'USE DOCK 32 — BACK OF BUILDING',
});
const push = (body) => writeHandler(new Request('http://localhost/.netlify/functions/nuvizz-write', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
const BODY = (clientOpId) => ({ op: 'setStopAddress', clientOpId, payload: { stopNbr: '007183435', stopId: '6abe0a3b9e1c2d3f4a5b6c7d', address: NOW, matchKey: OLD_KEY, businessName: NAME } });

test('END TO END: the push lands, the note is under the order’s new key, the old note is untouched, the write log says so — 3 NuVizz calls, no more', async () => {
  const v = vendor();
  const fake = installFirestoreFake({ [`customer_notes/${OLD_KEY}`]: NOTE_SEED() }, v.onOther);
  try {
    const j = await (await push(BODY('op_carry_1'))).json();
    assert.equal(j.result.ok, true, JSON.stringify(j.result).slice(0, 400));
    assert.equal(v.calls.length, 3, 'read, write, read — the carry costs nothing at NuVizz');
    const carried = fake.store.get(`customer_notes/${SEALED_KEY}`);
    assert.ok(carried, JSON.stringify(j.result.carry));
    assert.deepEqual(carried.location_override, { lat: 34.0601, lng: -84.0712 }, 'the hand pin');
    assert.deepEqual(carried.receiving_hours, { mon: { open: '07:00', close: '14:30' } }, 'the hours');
    assert.equal(carried.comms_opt_out, true, 'the opt-out — nobody who asked us to stop is emailed about this order');
    assert.equal(carried.dock_notes, 'USE DOCK 32 — BACK OF BUILDING');
    assert.equal(carried.carried_from, OLD_KEY);
    assert.equal(carried.carried_for, '007183435');
    assert.equal('address_override' in carried, false, 'NuVizz holds the address now');
    assert.deepEqual(fake.store.get(`customer_notes/${OLD_KEY}`), NOTE_SEED(), 'the customer’s next order, still arriving the old way, keeps its note');
    assert.deepEqual(j.result.carry.to, SEALED_KEY);
    const op = [...fake.store.entries()].find(([k]) => k.startsWith('nuvizz_write_ops/') && k.endsWith('op_carry_1'))?.[1];
    assert.ok(op?.result?.carry?.carried?.includes('location_override'), 'the write log keeps what was carried — free to read back');
  } finally { fake.restore(); }
});

test('END TO END: a push NuVizz did not take carries nothing — and with the switch off, nothing either', async () => {
  let v = vendor({ ignore: true });
  let fake = installFirestoreFake({ [`customer_notes/${OLD_KEY}`]: NOTE_SEED() }, v.onOther);
  try {
    const j = await (await push(BODY('op_carry_2'))).json();
    assert.notEqual(j.result.addressLanded, true);
    assert.equal(fake.store.has(`customer_notes/${SEALED_KEY}`), false);
    assert.match(j.result.carry.skipped, /did not land/);
  } finally { fake.restore(); }
  process.env.ADDRESS_PUSH_CARRY_NOTE = 'off';
  v = vendor();
  fake = installFirestoreFake({ [`customer_notes/${OLD_KEY}`]: NOTE_SEED() }, v.onOther);
  try {
    const j = await (await push(BODY('op_carry_3'))).json();
    assert.equal(j.result.ok, true);
    assert.equal(fake.store.has(`customer_notes/${SEALED_KEY}`), false);
    assert.match(j.result.carry.skipped, /switched off/);
  } finally { fake.restore(); delete process.env.ADDRESS_PUSH_CARRY_NOTE; }
});

test('END TO END: the key is the one NuVizz STORED, not the one we sent — the scan keys the order by what NuVizz holds', async () => {
  // The push counts "CIR" stored as "CIRCLE" as landed (addressMatchesTyped — USPS spellings), but
  // the customer key does not fold them (normStreetOf), so the next scan files the order under
  // "circle". A copy keyed off what we SENT would sit under a key nothing ever reads.
  const was = { addr1: 'DOCK 4', addr2: '755 SUWANEE LAKE CIR', city: 'SUWANEE', state: 'GA', zip: '30024' };
  const sent = { addr1: '755 SUWANEE LAKE CIR', addr2: 'DOCK 4', city: 'SUWANEE', state: 'GA', zip: '30024' };
  const oldKey = normalizeMatchKey(NAME, was.addr1, was.city, was.zip);
  const sentKey = normalizeMatchKey(NAME, sent.addr1, sent.city, sent.zip);
  const storedKey = normalizeMatchKey(NAME, '755 SUWANEE LAKE CIRCLE', 'SUWANEE', '30024');
  assert.notEqual(sentKey, storedKey, 'the premise: the two spellings key apart');
  const v = vendor({ store: (a) => ({ ...a, addr1: a.addr1.replace(/ CIR$/, ' CIRCLE') }) });
  v.order.to.address = { ...v.order.to.address, ...was };
  const fake = installFirestoreFake({ [`customer_notes/${oldKey}`]: { ...NOTE_SEED(), match_key: oldKey } }, v.onOther);
  try {
    const j = await (await push({ op: 'setStopAddress', clientOpId: 'op_carry_5', payload: { stopNbr: '007183435', stopId: '6abe0a3b9e1c2d3f4a5b6c7d', address: sent, matchKey: oldKey, businessName: NAME } })).json();
    assert.equal(j.result.ok, true, JSON.stringify(j.result).slice(0, 300));
    assert.equal(j.result.carry.to, storedKey);
    assert.ok(fake.store.has(`customer_notes/${storedKey}`), 'under the key the scan will read');
    assert.equal(fake.store.has(`customer_notes/${sentKey}`), false, 'never under the key of the address we only SENT');
  } finally { fake.restore(); }
});

test('END TO END: a note already under the new key is not touched', async () => {
  const v = vendor();
  const theirs = { match_key: SEALED_KEY, receiving_hours: { mon: { open: '06:00', close: '12:00' } }, comms_opt_out: false };
  const fake = installFirestoreFake({ [`customer_notes/${OLD_KEY}`]: NOTE_SEED(), [`customer_notes/${SEALED_KEY}`]: theirs }, v.onOther);
  try {
    const j = await (await push(BODY('op_carry_4'))).json();
    assert.equal(j.result.ok, true);
    assert.deepEqual(fake.store.get(`customer_notes/${SEALED_KEY}`), theirs);
    assert.match(j.result.carry.skipped, /already has its own note/);
  } finally { fake.restore(); }
});

test('the browser names the note it joined — both places that push send the key and the name', async () => {
  const { setStopAddress } = await import('../src/lib/nuvizzWrite.js');
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push(JSON.parse(init.body)); return new Response('{"ok":true}', { status: 200 }); };
  try {
    await setStopAddress('007183435', NOW, { stopId: 'x', matchKey: OLD_KEY, businessName: NAME });
    await setStopAddress('007183435', NOW, { stopId: 'x' });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(seen[0].payload.matchKey, OLD_KEY);
  assert.equal(seen[0].payload.businessName, NAME);
  assert.equal('matchKey' in seen[1].payload, false, 'nothing invented when the caller has none');
  const fs = await import('node:fs');
  const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(APP, /setStopAddress\(pro, fields, \{ stopId: stop\?\.stopId \|\| undefined, matchKey: stop\?\.matchKey, businessName: stop\?\.businessName[,}]/, 'Edit address');
  assert.match(APP, /setStopAddress\(row\.stopNbr, fields, \{[\s\S]{0,400}?matchKey: row\.matchKey,\s*businessName: row\.businessName,/, 'Problem addresses');
  assert.equal(normalizeMatchKey(NAME, WAS.addr1, WAS.city, WAS.zip), OLD_KEY, 'the board keys the order this way (App.jsx, lib/customer-key.mts)');
});
