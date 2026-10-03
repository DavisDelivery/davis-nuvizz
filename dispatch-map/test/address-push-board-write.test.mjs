// test/address-push-board-write.test.mjs — A CORRECTED ORDER LEAVES THE LIST AT ONCE (v1.112.1).
//
// Chad, 2026-10-03, after correcting eight orders on Problem addresses: "Looks like all the ones i
// corrected are still left in my history needing correcting." They were. Read live, all eight held
// the corrected address in NuVizz — but the list (and the board) read the order's address from OUR
// STORED COPY, which only a scan refreshes, and the next scan to re-read Monday's orders was Sunday
// 8 PM. The rows sat there offering the same push again: 24 calls to re-send what NuVizz had.
//
// A landed push now writes NuVizz's READ-BACK lines onto the stored copy, as the piece edit does
// with its counts. What this pins, each named for the failure it prevents:
//   1. THE ROW LEAVES THE LIST — the real write endpoint, then the real queue endpoint.
//   2. FROM WHAT NUVIZZ STORED, field-masked — the rest of the row untouched.
//   3. NEVER A NEW ROW, NEVER A TWIN'S ROW.
//   4. NOTHING WRITTEN when the address did not land, or for a pickup (its row carries the ship-to).
//   5. ADDRESS_PUSH_BOARD_WRITE=off puts it back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';
import { boardAddressFields, boardAddressWriteEnabled } from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { runSetStopAddress } from '../netlify/functions/lib/nuvizz-write.mts';
import { normalizeMatchKey } from '../src/lib/matchKey.js';

installServiceAccountEnv();

// A PLUS LAUNDRY 007186222 — one of the eight, Monday 2026-10-05.
const DAY = '2026-10-05';
const NAME = 'A PLUS LAUNDRY';
const OLD = { addr1: 'STE 109', addr2: '7131 PEACHTREE INDUSTRIAL BLVD', city: 'PEACHTREE CORNERS', state: 'GEORGIA', zip: '30092' };
const FIX = { addr1: '7131 PEACHTREE INDUSTRIAL BLVD', addr2: 'STE 109', city: 'PEACHTREE CORNERS', state: 'GA', zip: '30092' };
const STOP_ID = '6ac0c1e2a3b4c5d6e7f80911';
const OLD_KEY = normalizeMatchKey(NAME, OLD.addr1, OLD.city, OLD.zip);
const ROW_PATH = `nuvizz_stop_index/davis__${DAY}/stops/007186222`;
const REG_PATH = 'nuvizz_enriched/davis/pros/007186222';
const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic x' };

const boardRow = (over = {}) => ({
  stopNbr: '007186222', stopId: STOP_ID, businessName: NAME, ...OLD, state: null,
  lat: 33.95, lng: -84.22, normalizedStatus: 'UNPLANNED', isPlanned: false, pallets: 2, routeName: null, ...over,
});
const rawOrder = (over = {}) => ({
  stopId: STOP_ID, stopNbr: '007186222', stopType: 'DO',
  to: { address: { addressType: 'ANY', name: NAME, ...OLD, country: 'USA' }, contact: { name: NAME } },
  from: { address: { addressType: 'COM', name: 'DAVIS DELIVERY', addr1: '943 GAINESVILLE HIGHWAY', city: 'BUFORD', state: 'GEORGIA', zip: '30518' } },
  comments: [], ...over,
});
/** An honest NuVizz: stores what it is sent (state spelled its own way), unless `ignore`.
 *  `bolGap`: the order carries a BOL, and the read-back right after the write finds none — what
 *  all eight of Chad's pushes on 2026-10-03 met (NuVizz re-creates the BOL under a new id). */
function vendor({ ignore = false, order = rawOrder(), bolGap = false, packingLost = false } = {}) {
  if (bolGap) order = { ...order, to: { ...order.to, documents: [{ documentName: 'BOL', documentType: '03', documentExtType: 'pdf', dispositionType: '01', reference: '639398d6-c24b-4d1a-b601-7ea9ca9c445d', documentGuid: '639398d6-c24b-4d1a-b601-7ea9ca9c445d' }] } };
  // `packingLost`: an attachment that is NOT the BOL goes missing — still a real loss (v1.112.2),
  // so the push reads orange, with the address on the order all the same.
  if (packingLost) order = { ...order, to: { ...order.to, documents: [{ documentName: 'PACKING LIST', documentType: '05', documentExtType: 'pdf', dispositionType: '01', reference: 'aaa', documentGuid: 'aaa' }] } };
  const state = { stop: order };
  const calls = [];
  const respond = async (url, init = {}) => {
    calls.push(String(url));
    const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st });
    if (String(url).includes('/stop/info/')) return J({ Stop: { stop: state.stop, stopExecutionInfo: { stopStatus: 'PLANNED' }, load: {} } });
    if (String(url).includes('/stop/partialUpdate/')) {
      const sent = JSON.parse(String(init.body)).stops[0];
      const side = state.stop.stopType === 'PU' ? 'from' : 'to';
      if (!ignore) state.stop = { ...state.stop, [side]: { ...state.stop[side], address: { ...sent[side].address, state: 'GEORGIA' } } };
      if (bolGap || packingLost) state.stop = { ...state.stop, to: { ...state.stop.to, documents: [] } };
      return J({ status: 'SUCESS', apiResult: { updated: 1, failed: 0, errors: [] } });
    }
    return J({}, 404);
  };
  return { calls, respond, requester: { request: (url, opts) => respond(url, opts) } };
}

// ── the pure half ──────────────────────────────────────────────────────────────────────────────

test('boardAddressFields: NuVizz’s read-back lines, trimmed, blanks as blanks, and a stamp', () => {
  assert.deepEqual(
    boardAddressFields({ addr1: ' 7131 PEACHTREE INDUSTRIAL BLVD ', addr2: null, city: 'PEACHTREE CORNERS', state: 'GEORGIA', zip: '30092' }, 'T'),
    { addr1: '7131 PEACHTREE INDUSTRIAL BLVD', addr2: '', city: 'PEACHTREE CORNERS', state: 'GEORGIA', zip: '30092', address_set_at: 'T' },
  );
});

test('ADDRESS_PUSH_BOARD_WRITE: default on, an off-word turns it off, a typo leaves it on', () => {
  for (const off of ['off', 'OFF', '0', 'false', 'no']) assert.equal(boardAddressWriteEnabled({ ADDRESS_PUSH_BOARD_WRITE: off }), false, off);
  for (const on of [undefined, '', 'on', 'of', 'nope']) assert.equal(boardAddressWriteEnabled({ ADDRESS_PUSH_BOARD_WRITE: on }), true, String(on));
});

// ── the op, against a fake NuVizz and the Firestore fake ──────────────────────────────────────

const PUSH = (over = {}) => ({ stopNbr: '007186222', stopId: STOP_ID, address: FIX, boardDates: [DAY], ...over });

test('A LANDED PUSH PUTS NUVIZZ’S LINES ON OUR COPY — from the read-back, and nothing else on the row moves', async () => {
  const v = vendor();
  const fake = installFirestoreFake({ [ROW_PATH]: boardRow(), [REG_PATH]: boardRow() }, undefined, { commitSemantics: true });
  try {
    const r = await runSetStopAddress(v.requester, PUSH(), CREDS);
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    assert.equal(r.board.days[DAY], 'patched');
    assert.equal(r.board.registry, 'patched');
    const row = fake.store.get(ROW_PATH);
    assert.equal(row.addr1, '7131 PEACHTREE INDUSTRIAL BLVD');
    assert.equal(row.addr2, 'STE 109');
    assert.equal(row.state, 'GEORGIA', 'what NuVizz STORED, not the "GA" we sent');
    assert.ok(row.address_set_at);
    assert.equal(row.pallets, 2, 'field-masked: the freight is untouched');
    assert.equal(row.lat, 33.95, 'and so is the position');
    assert.equal(fake.store.get(REG_PATH).addr1, '7131 PEACHTREE INDUSTRIAL BLVD', 'the registry copy too, so a merge cannot bring the old line back');
    assert.equal(v.calls.length, 3, 'no NuVizz call added');
  } finally { fake.restore(); }
});

test('NEVER A NEW ROW, NEVER A TWIN’S: an absent day stays absent; another record’s row is left alone', async () => {
  const v = vendor();
  const twinPath = `nuvizz_stop_index/davis__2026-10-06/stops/007186222`;
  const fake = installFirestoreFake({ [twinPath]: boardRow({ stopId: '6ac0c1e2ffffffffffffffff' }) }, undefined, { commitSemantics: true });
  try {
    const r = await runSetStopAddress(v.requester, PUSH({ boardDates: [DAY, '2026-10-06'] }), CREDS);
    assert.equal(r.board.days[DAY], 'absent');
    assert.equal(fake.store.has(ROW_PATH), false, 'no row invented');
    assert.equal(r.board.days['2026-10-06'], 'other-record');
    assert.equal(fake.store.get(twinPath).addr1, 'STE 109', 'the twin keeps its own address');
  } finally { fake.restore(); }
});

test('NOTHING IS WRITTEN when the address did not land, for a pickup, or with the switch off', async () => {
  let v = vendor({ ignore: true });
  let fake = installFirestoreFake({ [ROW_PATH]: boardRow() }, undefined, { commitSemantics: true });
  try {
    const r = await runSetStopAddress(v.requester, PUSH(), CREDS);
    assert.notEqual(r.ok, true);
    assert.equal(r.board, undefined);
    assert.equal(fake.store.get(ROW_PATH).addr1, 'STE 109');
  } finally { fake.restore(); }

  // A pickup re-addresses the FROM side; its board row carries the ship-to, which this must not touch.
  v = vendor({ order: rawOrder({ stopType: 'PU', from: { address: { addressType: 'ANY', name: NAME, ...OLD, country: 'USA' } } }) });
  fake = installFirestoreFake({ [ROW_PATH]: boardRow() }, undefined, { commitSemantics: true });
  try {
    const r = await runSetStopAddress(v.requester, PUSH(), CREDS);
    assert.equal(r.side, 'from');
    assert.equal(r.board, undefined);
    assert.equal(fake.store.get(ROW_PATH).addr1, 'STE 109');
  } finally { fake.restore(); }

  process.env.ADDRESS_PUSH_BOARD_WRITE = 'off';
  v = vendor();
  fake = installFirestoreFake({ [ROW_PATH]: boardRow() }, undefined, { commitSemantics: true });
  try {
    const r = await runSetStopAddress(v.requester, PUSH(), CREDS);
    assert.equal(r.ok, true);
    assert.match(r.board.skipped, /ADDRESS_PUSH_BOARD_WRITE=off/);
    assert.equal(fake.store.get(ROW_PATH).addr1, 'STE 109');
  } finally { fake.restore(); delete process.env.ADDRESS_PUSH_BOARD_WRITE; }
});

// ── end to end: the report, through the real write endpoint and the real queue endpoint ──────

process.env.NUVIZZ_WRITE_ENABLED = 'true';
process.env.NUVIZZ_DAVIS_USER = 'u';
process.env.NUVIZZ_DAVIS_PASS = 'p';
delete process.env.AUTH_REQUIRED;
delete process.env.NUVIZZ_PERSONAL_LOGINS;
const { default: writeHandler } = await import('../netlify/functions/nuvizz-write.mts');
const { default: queueHandler } = await import('../netlify/functions/address-queue.mts');

const NOTE = { match_key: OLD_KEY, raw_name: NAME, address_override: { ...FIX }, address_override_at: '2026-10-03T19:49:30.000Z', location_override: { lat: 33.9531, lng: -84.2217 }, location_override_at: '2026-10-03T19:49:30.000Z' };
async function queueRows() {
  const j = await (await queueHandler(new Request(`https://x.netlify.app/.netlify/functions/address-queue?from=${DAY}&to=${DAY}`))).json();
  assert.equal(j.ok, true, JSON.stringify(j).slice(0, 300));
  return j.days[0].rows;
}
const pushBody = (clientOpId) => ({ op: 'setStopAddress', clientOpId, payload: { ...PUSH(), matchKey: OLD_KEY, businessName: NAME } });
const post = (body) => writeHandler(new Request('http://localhost/.netlify/functions/nuvizz-write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

test('THE REPORT, END TO END: corrected and pushed, the order is off Problem addresses at once — not on Sunday', async () => {
  // With the BOL gap every one of the eight met — a clean push since v1.112.2 (the BOL is
  // NuVizz re-creating it), and our copy follows the address either way.
  const v = vendor({ bolGap: true });
  const fake = installFirestoreFake({ [ROW_PATH]: boardRow(), [`customer_notes/${OLD_KEY}`]: NOTE }, v.respond, { commitSemantics: true });
  try {
    const before = await queueRows();
    assert.deepEqual(before.map((r) => r.signal), ['not_in_nuvizz'], 'listed before the push, as on Chad’s screen');
    const j = await (await post(pushBody('op_board_1'))).json();
    assert.equal(j.result.ok, true, JSON.stringify(j.result).slice(0, 300));
    assert.deepEqual(j.result.bolRecreating, ['to|BOL|03||pdf||01'], 'green, and the log still says the BOL was being re-created');
    assert.equal(j.result.board.days[DAY], 'patched');
    assert.deepEqual(await queueRows(), [], 'and gone the moment the push lands');
    assert.ok(fake.store.has(`customer_notes/${normalizeMatchKey(NAME, FIX.addr1, FIX.city, FIX.zip)}`), 'its note went with it (v1.106.2), so the pin follows');
  } finally { fake.restore(); }
});

test('a push that lands with a REAL loss (an attachment that is not the BOL) still puts the address on our copy', async () => {
  const v = vendor({ packingLost: true });
  const fake = installFirestoreFake({ [ROW_PATH]: boardRow(), [`customer_notes/${OLD_KEY}`]: NOTE }, v.respond, { commitSemantics: true });
  try {
    const j = await (await post(pushBody('op_board_3'))).json();
    assert.equal(j.result.addressLanded, true);
    assert.equal(j.result.ok, false, 'orange — the packing list is a real loss');
    assert.equal(j.result.board.days[DAY], 'patched', 'and the board copy is written anyway: the address IS on the order');
    assert.deepEqual(await queueRows(), []);
  } finally { fake.restore(); }
});

test('…and with ADDRESS_PUSH_BOARD_WRITE=off it stays listed until a scan re-reads it — the old behaviour', async () => {
  process.env.ADDRESS_PUSH_BOARD_WRITE = 'off';
  const v = vendor();
  const fake = installFirestoreFake({ [ROW_PATH]: boardRow(), [`customer_notes/${OLD_KEY}`]: NOTE }, v.respond, { commitSemantics: true });
  try {
    await post(pushBody('op_board_2'));
    assert.deepEqual((await queueRows()).map((r) => r.signal), ['not_in_nuvizz']);
  } finally { fake.restore(); delete process.env.ADDRESS_PUSH_BOARD_WRITE; }
});

// ── the browser names the days ─────────────────────────────────────────────────────────────────

test('both places that push name the board days: Edit address the card’s own, Problem addresses the row’s', async () => {
  const { setStopAddress } = await import('../src/lib/nuvizzWrite.js');
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { seen.push(JSON.parse(init.body)); return new Response('{"ok":true}', { status: 200 }); };
  try {
    await setStopAddress('007186222', FIX, { boardDates: [DAY] });
    await setStopAddress('007186222', FIX, {});
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(seen[0].payload.boardDates, [DAY]);
  assert.equal('boardDates' in seen[1].payload, false);
  const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(APP, /setStopAddress\(pro, fields, \{[^}]*boardDates: piecesBoardDatesOf\(stop\) \}\)/, 'Edit address');
  assert.match(APP, /setStopAddress\(row\.stopNbr, fields, \{[\s\S]{0,700}?boardDates: \[row\.date\],\n\s*\}\);/, 'Problem addresses');
});
