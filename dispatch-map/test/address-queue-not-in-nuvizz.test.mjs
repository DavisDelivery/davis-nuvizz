// test/address-queue-not-in-nuvizz.test.mjs — FIXED HERE, NOT IN NUVIZZ (v1.106.0).
//
// Chad, 2026-10-01, on BRENT SCARBROUGHQTS (007184497, first stop on MONE): "why was this address
// not flagged?!?" — and then: "Why are we not able to correct this one like we are all the
// others." The customer had been corrected on OUR board on Sep 15 (street first, the laydown yard
// second, the pin moved by hand), and the problem-address queue stops judging the moment a board
// correction exists. But a board correction covers the CUSTOMER and a NuVizz correction covers ONE
// ORDER, so each new order still arrived with the dock line first — in the portal, the carrier's
// record and the driver's manifest — and the list could not see it.
//
// What this pins, each named for the failure it prevents:
//   1. THE TWO REAL ORDERS ARE LISTED (BRENT, WINDSTREAM), and an order NuVizz already holds the
//      board's address for is not — including when NuVizz spells it its own way.
//   2. WORKED FREIGHT IS NOT LISTED — it cannot be re-addressed and the board is already right.
//   3. THE OLDER SIGNALS KEEP THEIR PLACE, and the new one ranks last.
//   4. ITS OWN SWITCH turns only it off, and the answer says which way it is set.
//   5. A WAVE-OFF EXPIRES WHEN NUVIZZ'S ADDRESS CHANGES — and no stored fingerprint for the other
//      three signals changes.
//   6. THE PUSH TOUCHES NOTHING ON THE BOARD for an unedited row: no geocode over a hand-placed
//      pin, no fresh correction stamp. An edited row is an ordinary correction again.
//   7. "CORRECT ON THE BOARD" NEVER CLAIMS A CORRECTION IT DID NOT MAKE.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transformSync } from 'esbuild';
import { installFirestoreFake } from './_firestore-fake.mjs';
import {
  classifyQueueRow, buildQueueRow, sortQueueRows, isDismissed, queueRowFingerprint,
  notInNuvizzEnabled, nuvizzBehindBoard, SIGNAL_RANK,
} from '../netlify/functions/lib/address-queue.mts';
import { sameDeliveryAddress } from '../src/lib/address-fix.js';
import { normalizeMatchKey, normStreetOf } from '../src/lib/matchKey.js';
import { shownAddress } from '../src/lib/address-log.js';

// ── the two orders Chad sent, as the board and the customer note hold them ─────────────────────
const BRENT = {
  stopNbr: '007184497', stopId: '6abd87a06478aaa3a10166c9', businessName: 'BRENT SCARBROUGHQTS',
  addr1: 'SANDY CREEK ENTRANCE LAYDOWN Y', addr2: '568 SANDY CREEK ROAD ENTRANCE', city: 'FAYETTEVILLE', state: 'GA', zip: '30214',
  lat: 33.41, lng: -84.45, normalizedStatus: 'SCHEDULED', isPlanned: true, routeName: 'MONE',
};
const BRENT_NOTE = {
  address_override: { addr1: '568 SANDY CREEK ROAD ENTRANCE', addr2: 'SANDY CREEK ENTRANCE LAYDOWN Y', city: 'FAYETTEVILLE', state: 'GA', zip: '30214' },
  address_override_at: '2026-09-15T23:30:00.000Z',
  location_override: { lat: 33.4123, lng: -84.4567 }, location_override_at: '2026-09-15T23:36:46.944Z',
};
const WINDSTREAM = {
  stopNbr: '007183673', stopId: '6abaf627ced0434f41797699', businessName: 'WINDSTREAM DISTRIBUTION CENTER',
  addr1: 'UNITI KINETIC STE 220', addr2: '655 PEACHTREE INDUSTRIAL BLVD', city: 'SUGAR HILL', state: 'GA', zip: '30518',
  lat: 34.1, lng: -84.04, normalizedStatus: 'UNPLANNED', isPlanned: false,
};
const WINDSTREAM_NOTE = {
  address_override: { city: 'SUGAR HILL', addr1: '655 PEACHTREE INDUSTRIAL BLVD', zip: '30518', state: 'GA', addr2: 'UNITI KINETIC STE 220' },
  address_override_at: '2026-09-15T00:20:00.000Z',
  location_override: { lat: 34.1001, lng: -84.0402 }, location_override_at: '2026-09-15T00:23:27.397Z',
};

// ── 1. the rule ────────────────────────────────────────────────────────────────────────────────

test('BRENT SCARBROUGHQTS and WINDSTREAM are listed: corrected on our board, still dock-line-first in NuVizz', () => {
  assert.equal(classifyQueueRow(BRENT, BRENT_NOTE), 'not_in_nuvizz');
  assert.equal(classifyQueueRow(WINDSTREAM, WINDSTREAM_NOTE), 'not_in_nuvizz');
  const row = buildQueueRow(BRENT, BRENT_NOTE, '2026-10-01');
  assert.equal(row.signal, 'not_in_nuvizz');
  assert.equal(row.rank, 3);
  assert.equal(row.corrected, true);
  assert.equal(row.shown.addr1, '568 SANDY CREEK ROAD ENTRANCE', '"We show" is the board correction');
  assert.equal(row.vendor.addr1, 'SANDY CREEK ENTRANCE LAYDOWN Y', '"NuVizz has" is the order as NuVizz holds it');
  assert.equal(row.suggestion, null, 'no split to suggest — the board already has the right one');
  assert.equal(row.stopId, BRENT.stopId, 'pinned to this record, so the push can never re-address its twin');
});

test('an order NuVizz already holds the board address for is NOT listed — spelled its own way or not', () => {
  const fixed = { ...BRENT, addr1: '568 Sandy Creek Rd. Entrance', addr2: 'Sandy Creek Entrance Laydown Y', state: 'GEORGIA', zip: '30214-1102' };
  assert.equal(classifyQueueRow(fixed, BRENT_NOTE), null, 'ROAD/RD, case, punctuation, GEORGIA/GA and ZIP+4 are the same door');
  const city = { ...WINDSTREAM, addr1: '655 PEACHTREE INDUSTRIAL BOULEVARD', addr2: 'UNITI KINETIC SUITE 220', city: 'SUGARHILL' };
  assert.equal(classifyQueueRow(city, WINDSTREAM_NOTE), null, 'BOULEVARD/BLVD, SUITE/STE and the city run together');
});

test('the comparison reads the words in their order — the dock ahead of the street is a different manifest', () => {
  const a = { addr1: '1200 NORTHBROOK PKWY STE 180', addr2: 'DOCK 32', city: 'SUWANEE', zip: '30024' };
  const b = { addr1: 'DOCK 32', addr2: '1200 NORTHBROOK PKWY STE 180', city: 'SUWANEE', zip: '30024' };
  assert.equal(sameDeliveryAddress(a, b), false);
  assert.equal(sameDeliveryAddress(a, { ...a, addr2: 'DOCK 33' }), false, 'a different dock is a different door');
  assert.equal(sameDeliveryAddress(a, { ...a, addr2: '' }), false, 'the dock left off is a different door');
  assert.equal(sameDeliveryAddress(a, { ...a, zip: '30025' }), false);
  assert.equal(sameDeliveryAddress(a, { ...a, city: 'DULUTH' }), false);
  assert.equal(sameDeliveryAddress({ addr1: '755 SUWANEE LAKE CIR' }, { addr1: '755 Suwanee Lake Circle' }), true, 'suffixes normStreetOf does not fold are folded here');
  assert.equal(sameDeliveryAddress({ addr1: '1 MAIN ST', addr2: 'SUITE #4' }, { addr1: '1 MAIN ST', addr2: 'STE 4' }), true);
  assert.equal(sameDeliveryAddress({ addr1: '1 MAIN ST', addr2: '' }, { addr1: '1 MAIN ST', addr2: null }), true, 'blank and absent are the same nothing');
});

// Measured on the line-by-line rule before this shipped: NuVizz holding the suite on line 1 and
// our board holding it on line 2 LISTED the order — on every order for that customer — and the
// one-line price said Correct + NuVizz would not send it, so the row could never be cleared.
test('the same words with the line break moved are the SAME door — not a row on every order for a line break', () => {
  const board = { addr1: '1200 MAIN ST', addr2: 'STE 5', city: 'ATLANTA', state: 'GA', zip: '30301' };
  for (const nv of [
    { ...board, addr1: '1200 MAIN ST, STE 5', addr2: '' },
    { ...board, addr1: '1200 MAIN ST STE 5', addr2: '' },
    { ...board, addr1: '1200 Main Street', addr2: 'Suite 5' },
  ]) {
    assert.equal(sameDeliveryAddress(board, nv), true, `${nv.addr1} / ${nv.addr2}`);
    const stop = { stopNbr: '1', stopId: 'x', businessName: 'ACME', ...nv, lat: 33.7, lng: -84.4, normalizedStatus: 'SCHEDULED' };
    const note = { address_override: board, address_override_at: '2026-09-15T00:00:00Z', location_override: { lat: 33.7001, lng: -84.4001 }, location_override_at: '2026-09-15T00:05:00Z' };
    assert.equal(classifyQueueRow(stop, note), null, `${nv.addr1} / ${nv.addr2} is not listed`);
  }
  // …while the street and the suite TRADING places is still listed: the order changed, not the break.
  assert.equal(sameDeliveryAddress(board, { ...board, addr1: 'STE 5', addr2: '1200 MAIN ST' }), false);
  assert.equal(sameDeliveryAddress(board, { ...board, addr1: 'STE 5 1200 MAIN ST', addr2: '' }), false);
});

test('the fold never reaches the customer key — widening normStreetOf would re-key every note on the board', () => {
  // The FOLD table lives in address-fix.js beside the comparison, and normalizeMatchKey still keys
  // CIRCLE and CIR apart exactly as it always has.
  assert.notEqual(normalizeMatchKey('X', '755 SUWANEE LAKE CIRCLE', 'SUWANEE', '30024'), normalizeMatchKey('X', '755 SUWANEE LAKE CIR', 'SUWANEE', '30024'));
});

// ── 2. worked freight ──────────────────────────────────────────────────────────────────────────

test('delivered, arrived or excepted freight is not listed: it cannot be re-addressed and the board is right', () => {
  for (const st of ['DELIVERED', 'ARRIVED', 'EXCEPTION', 'delivered']) {
    assert.equal(classifyQueueRow({ ...BRENT, normalizedStatus: st }, BRENT_NOTE), null, st);
  }
  for (const st of ['SCHEDULED', 'UNPLANNED', 'OUT_FOR_DEL', '']) {
    assert.equal(classifyQueueRow({ ...BRENT, normalizedStatus: st }, BRENT_NOTE), 'not_in_nuvizz', st || '(no status)');
  }
});

// ── 3. precedence and rank ─────────────────────────────────────────────────────────────────────

test('the older signals keep their place: a stale pin is still "pin not moved", no position is still "no pin"', () => {
  const stale = { ...BRENT_NOTE, location_override_at: '2026-09-15T23:00:00.000Z' };   // pinned BEFORE the correction
  assert.equal(classifyQueueRow(BRENT, stale), 'corrected_not_pinned');
  const noPos = { ...BRENT_NOTE, location_override: null };
  assert.equal(classifyQueueRow({ ...BRENT, lat: null, lng: null }, noPos), 'no_pin');
  assert.equal(classifyQueueRow(BRENT, null), 'mis_split', 'with no board correction it is the ordinary mis-split it always was');
});

test('it ranks last — our truck goes to the right door; it is the paperwork that is wrong', () => {
  assert.equal(SIGNAL_RANK.not_in_nuvizz, 3);
  const rows = sortQueueRows([
    { rank: SIGNAL_RANK.not_in_nuvizz, businessName: 'A', stopNbr: '1' },
    { rank: SIGNAL_RANK.mis_split, businessName: 'Z', stopNbr: '2' },
  ]);
  assert.equal(rows[0].rank, SIGNAL_RANK.mis_split);
});

// ── 4. the switch ──────────────────────────────────────────────────────────────────────────────

test('ADDRESS_QUEUE_NOT_IN_NUVIZZ: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(notInNuvizzEnabled({}), true);
  for (const v of ['off', 'OFF', '0', 'false', 'no', ' off ']) assert.equal(notInNuvizzEnabled({ ADDRESS_QUEUE_NOT_IN_NUVIZZ: v }), false, v);
  for (const v of ['on', '1', 'true', 'yes', 'of', 'nope', '']) assert.equal(notInNuvizzEnabled({ ADDRESS_QUEUE_NOT_IN_NUVIZZ: v }), true, v);
  assert.equal(classifyQueueRow(BRENT, BRENT_NOTE, { notInNuvizz: false }), null, 'off: the list is exactly what it was before');
  assert.equal(nuvizzBehindBoard(BRENT, BRENT_NOTE), true, 'the rule itself is unchanged by the switch');
});

// ── 5. dismissals ──────────────────────────────────────────────────────────────────────────────

test('a waved-off row comes back when NuVizz re-addresses the order to something else wrong', () => {
  const row = buildQueueRow(BRENT, BRENT_NOTE, '2026-10-01');
  const items = { [row.key]: { fp: row.fp } };
  assert.equal(isDismissed(row, items), true);
  const again = buildQueueRow({ ...BRENT, addr1: 'GATE 2', addr2: '568 SANDY CREEK ROAD ENTRANCE' }, BRENT_NOTE, '2026-10-01');
  assert.equal(again.signal, 'not_in_nuvizz');
  assert.equal(again.key, row.key, 'same order, same row');
  assert.equal(isDismissed(again, items), false, 'NuVizz holds something new — the dispatcher should see it');
});

test('no stored fingerprint for the other three signals changes', () => {
  // Rebuilt HERE from the v1 recipe, independently of queueRowFingerprint — comparing the function
  // with itself would pass whatever it did. A stored wave-off is matched against exactly this
  // string; if it moved, every waved-off row on the board would come back at once.
  const v1 = (stop, note, pin) => {
    const a = shownAddress(stop, note);
    return ['v1', normStreetOf(a.addr1), normStreetOf(a.addr2), a.city, a.state, a.zip, pin].join('|');
  };
  const noPos = { ...BRENT, lat: null, lng: null };
  assert.equal(queueRowFingerprint(noPos, null, 'no_pin'), v1(noPos, null, 'nopin'), 'no_pin');
  assert.equal(queueRowFingerprint(BRENT, null, 'mis_split'), v1(BRENT, null, 'feed:33.41000,-84.45000'), 'mis_split');
  const stale = { ...BRENT_NOTE, location_override_at: '2026-09-15T23:00:00.000Z' };
  assert.equal(queueRowFingerprint(BRENT, stale, 'corrected_not_pinned'), v1(BRENT, stale, 'override:33.41230,-84.45670'), 'corrected_not_pinned');
  assert.equal(queueRowFingerprint(BRENT, BRENT_NOTE, 'not_in_nuvizz'),
    `${v1(BRENT, BRENT_NOTE, 'override:33.41230,-84.45670')}|nv:sandy_creek_entrance_laydown_y|568_sandy_creek_rd_entrance|FAYETTEVILLE|30214`,
    'only the new signal carries NuVizz’s address');
});

// ── the endpoint, end to end against the Firestore fake ───────────────────────────────────────

const DAY = '2026-10-01';
const seed = () => {
  const key = normalizeMatchKey(BRENT.businessName, BRENT.addr1, BRENT.city, BRENT.zip);
  return {
    [`nuvizz_stop_index/davis__${DAY}/stops/${BRENT.stopNbr}`]: { ...BRENT },
    [`customer_notes/${key}`]: { match_key: key, ...BRENT_NOTE },
  };
};
async function getQueue(env = {}) {
  const keep = process.env.ADDRESS_QUEUE_NOT_IN_NUVIZZ;
  if ('ADDRESS_QUEUE_NOT_IN_NUVIZZ' in env) process.env.ADDRESS_QUEUE_NOT_IN_NUVIZZ = env.ADDRESS_QUEUE_NOT_IN_NUVIZZ;
  // No vendor handler: any request that is not Firestore THROWS, so a passing run is proof of
  // zero NuVizz calls.
  const fake = installFirestoreFake(seed());
  try {
    const h = (await import('../netlify/functions/address-queue.mts')).default;
    const body = await (await h(new Request(`https://x.netlify.app/.netlify/functions/address-queue?from=${DAY}&to=${DAY}`))).json();
    return { body, other: fake.log.other };
  } finally {
    fake.restore();
    if (keep === undefined) delete process.env.ADDRESS_QUEUE_NOT_IN_NUVIZZ; else process.env.ADDRESS_QUEUE_NOT_IN_NUVIZZ = keep;
  }
}

test('THE ENDPOINT lists BRENT’s order, counts it, says the switch is on — and asks NuVizz nothing', async () => {
  const { body, other } = await getQueue();
  assert.equal(body.ok, true);
  assert.equal(body.nuvizzCalls, 0);
  assert.equal(other.length, 0, 'not one request left for anywhere but Firestore');
  assert.equal(body.notInNuvizz, true, 'the switch position, read back');
  const rows = body.days[0].rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].signal, 'not_in_nuvizz');
  assert.equal(rows[0].key, 'not_in_nuvizz__007184497');
  assert.equal(body.summary.not_in_nuvizz, 1);
});

test('THE ENDPOINT with ADDRESS_QUEUE_NOT_IN_NUVIZZ=off is the list from before — and says it is off', async () => {
  const { body } = await getQueue({ ADDRESS_QUEUE_NOT_IN_NUVIZZ: 'off' });
  assert.equal(body.ok, true);
  assert.equal(body.notInNuvizz, false);
  assert.equal(body.days[0].rows.length, 0);
  assert.equal(body.summary.not_in_nuvizz, 0);
});

// ── the screen: the real functions out of App.jsx ─────────────────────────────────────────────

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function fnOnly(name, prefix = 'function ') {
  const start = APP.indexOf(`${prefix}${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}
function constLine(name) {
  const start = APP.indexOf(`const ${name} = `);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  return APP.slice(start, APP.indexOf('\n', start));
}
const jsx = (src) => transformSync(src, { loader: 'jsx', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' }).code;
const PURE = () => [
  constLine('oneLineAddr'), fnOnly('correctedFields'), fnOnly('worthPushing'), fnOnly('queueBoardHasIt'),
  fnOnly('queueNoteText'), fnOnly('queueCostLine'), fnOnly('queueClientOpId'), constLine('QUEUE_WARN_KINDS'), fnOnly('queueVerdictsOffList'),
].join('\n');
// eslint-disable-next-line no-new-func
const pure = new Function(`'use strict';\n${PURE()}\nreturn { queueBoardHasIt, correctedFields, worthPushing };`)();

const ROW = buildQueueRow(BRENT, BRENT_NOTE, DAY);
ROW.matchKey = normalizeMatchKey(BRENT.businessName, BRENT.addr1, BRENT.city, BRENT.zip);

test('queueBoardHasIt: a "Not in NuVizz" row left as it is — and only that', () => {
  const { queueBoardHasIt, correctedFields } = pure;
  assert.equal(queueBoardHasIt(ROW, correctedFields(ROW)), true, 'the editor opens on exactly the board address');
  assert.equal(queueBoardHasIt(ROW, { ...ROW.shown, addr1: ` ${ROW.shown.addr1} ` }), true, 'padding is not an edit');
  assert.equal(queueBoardHasIt(ROW, { ...ROW.shown, addr2: 'GATE 2' }), false, 'an edited field is an ordinary correction again');
  assert.equal(queueBoardHasIt({ ...ROW, signal: 'mis_split' }, correctedFields(ROW)), false, 'never for the other signals');
  assert.equal(pure.worthPushing(ROW), true, 'and it is always worth the push — NuVizz differs, by definition of the row');
});

test('every "Not in NuVizz" row is one Correct + NuVizz sends — the row and the button never disagree', () => {
  // A listed row whose one-line address happens to read the same as NuVizz's (an empty city, say)
  // would otherwise be priced as "nothing to push", skipped by the push, and listed forever.
  const sameOneLine = { ...ROW, shown: { addr1: 'A', addr2: '', city: 'X', state: 'GA', zip: '1' }, vendor: { addr1: 'A', addr2: 'X', city: '', state: 'GA', zip: '1' } };
  assert.equal(pure.worthPushing(sameOneLine), true);
  assert.equal(pure.worthPushing({ ...sameOneLine, signal: 'no_pin' }), false, 'the other signals are still priced by the address they would send');
});

function saveWith(spies) {
  // eslint-disable-next-line no-new-func
  return new Function(
    'db', 'doc', 'setDoc', 'serverTimestamp', 'geocodeAddress', 'setStopAddress', 'classifyPushResult', 'addressReachedNuvizz', 'logAddressOverride',
    `'use strict';\n${PURE()}\n${fnOnly('saveQueueCorrection', 'async function ')}\nreturn saveQueueCorrection;`,
  )({}, (_db, coll, id) => `${coll}/${id}`, spies.setDoc, () => 'TS', spies.geocode, spies.push, () => ({ kind: 'ok', text: 'NuVizz now reads it.' }), () => true, spies.log);
}
function spySet() {
  const calls = { setDoc: [], geocode: [], push: [], log: [] };
  return {
    calls,
    setDoc: async (...a) => { calls.setDoc.push(a); },
    geocode: async (...a) => { calls.geocode.push(a); return { lat: 1, lng: 2 }; },
    push: async (...a) => { calls.push.push(a); return { ok: true, result: { addressLanded: true, now: 'x' } }; },
    log: async (a) => { calls.log.push(a); return { recorded: true }; },
  };
}

test('THE PUSH ALONE: an unedited row writes nothing to the board — no geocode over the hand pin, no fresh stamp', async () => {
  const sp = spySet();
  const out = await saveWith(sp)({ row: ROW, fields: pure.correctedFields(ROW), google: {}, push: true, today: DAY, clientOpId: 'op1' });
  assert.equal(sp.calls.setDoc.length, 0, 'customer_notes is not touched');
  assert.equal(sp.calls.geocode.length, 0, 'the street is not re-geocoded');
  assert.equal(sp.calls.push.length, 1, 'the order is pushed');
  const [stopNbr, sent, opts] = sp.calls.push[0];
  assert.equal(stopNbr, '007184497');
  assert.deepEqual(sent, ROW.shown, 'with exactly the board’s address');
  assert.equal(opts.stopId, BRENT.stopId);
  assert.match(opts.note, /Davis dispatch corrected the delivery address/, 'the dispatcher note still rides the same write');
  assert.deepEqual(sp.calls.log[0].before, ROW.vendor, 'the log’s "before" is what CHANGED — the order in NuVizz');
  assert.equal(sp.calls.log[0].nuvizz, true);
  assert.equal(out.boardUnchanged, true);
});

test('…and a board-only save of that row writes nothing and claims nothing', async () => {
  const sp = spySet();
  const out = await saveWith(sp)({ row: ROW, fields: pure.correctedFields(ROW), google: {}, push: false, today: DAY, clientOpId: 'op1' });
  assert.equal(sp.calls.setDoc.length + sp.calls.geocode.length + sp.calls.push.length + sp.calls.log.length, 0);
  assert.equal(out.boardUnchanged, true);
  assert.equal(out.logged.outcome, 'declined', 'the log’s own word for a write it rightly refused — not counted as lost');
});

test('an EDITED row is an ordinary correction again: board half first, geocode, then the push', async () => {
  const sp = spySet();
  const edited = { ...ROW.shown, addr2: 'GATE 2 LAYDOWN YARD' };
  await saveWith(sp)({ row: ROW, fields: edited, google: {}, push: true, today: DAY, clientOpId: 'op2' });
  assert.equal(sp.calls.geocode.length, 1);
  assert.equal(sp.calls.setDoc.length, 1);
  assert.deepEqual(sp.calls.setDoc[0][1].address_override, edited);
  assert.equal(sp.calls.push.length, 1);
  assert.deepEqual(sp.calls.log[0].before, ROW.shown, 'an ordinary correction logs what the board showed');
});

test('the other signals save exactly as before — board half, geocode, push', async () => {
  const sp = spySet();
  const mis = { ...ROW, signal: 'mis_split', corrected: false, suggestion: { addr1: '568 SANDY CREEK ROAD ENTRANCE', addr2: 'SANDY CREEK ENTRANCE LAYDOWN Y' } };
  await saveWith(sp)({ row: mis, fields: pure.correctedFields(mis), google: {}, push: true, today: DAY, clientOpId: 'op3' });
  assert.equal(sp.calls.setDoc.length, 1);
  assert.equal(sp.calls.geocode.length, 1);
  assert.equal(sp.calls.push.length, 1);
});

function hooksRuntime() {
  const slots = [];
  let i = 0;
  const React = {
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = { v: typeof init === 'function' ? init() : init };
      const s = slots[k];
      return [s.v, (v) => { s.v = typeof v === 'function' ? v(s.v) : v; }];
    },
    useRef(v) { const k = i++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect: () => {},
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
    Fragment: 'Fragment',
  };
  return { React, render: (fn) => { i = 0; return fn(); } };
}
function textOf(node) {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}
function find(node, pred, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; }
  if (pred(node)) out.push(node);
  find(node.props?.children, pred, out);
  return out;
}
function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  return APP.slice(start, next > 0 ? next : undefined);
}

test('"CORRECT ON THE BOARD" over a "Not in NuVizz" row says it was left alone — never "corrected"', async () => {
  const rt = hooksRuntime();
  // eslint-disable-next-line no-new-func
  const useQueuePush = new Function('React', 'saveQueueCorrection', 'callWrite',
    `'use strict';\n${PURE()}\n${fnSource('useQueuePush')}\nreturn useQueuePush;`)(
    rt.React, async () => ({ geoErr: null, pushed: null, logged: { outcome: 'declined' }, boardUnchanged: true }), async () => ({}));
  const p = rt.render(() => useQueuePush(DAY, () => {}));
  await p.runGroup([ROW], null, false);
  const v = rt.render(() => useQueuePush(DAY, () => {})).results[ROW.key];
  assert.equal(v.kind, 'skipped');
  assert.match(v.text, /Already right on the board/);
  assert.doesNotMatch(v.text, /Corrected/);
});

function summaryBar() {
  const rt = hooksRuntime();
  const Badge = () => null;
  // eslint-disable-next-line no-new-func
  const Bar = new Function('React', 'QueueSignalBadge', `'use strict';\n${PURE()}\n${jsx(fnSource('QueueSummaryBar'))}\nreturn QueueSummaryBar;`)(rt.React, Badge);
  return { rt, Bar, Badge };
}
const qWith = (o = {}) => ({
  data: { summary: { not_in_nuvizz: 1 }, notInNuvizz: true }, allRows: [], selected: [], picked: new Set(), sweepable: [], showDismissed: false,
  push: { running: false, budget: null, fatal: null, logged: null, results: {} }, ...o,
});

test('THE SUMMARY BAR: a "Not in NuVizz" chip with its count — and none when the switch is off', () => {
  const { rt, Bar, Badge } = summaryBar();
  for (const stacked of [true, false]) {
    const tree = rt.render(() => Bar({ q: qWith(), stacked }));
    const sigs = find(tree, (n) => n.type === Badge).map((n) => n.props.signal);
    assert.deepEqual(sigs, ['no_pin', 'corrected_not_pinned', 'mis_split', 'not_in_nuvizz'], stacked ? 'phone' : 'desktop');
    const off = rt.render(() => Bar({ q: qWith({ data: { summary: {}, notInNuvizz: false } }), stacked }));
    assert.ok(!find(off, (n) => n.type === Badge).some((n) => n.props.signal === 'not_in_nuvizz'));
  }
});

test('THE SUMMARY BAR: "on the board" counts only rows the board can change, and says why the rest are left out', () => {
  const { rt, Bar } = summaryBar();
  const mis = { ...ROW, key: 'mis_split__1', signal: 'mis_split', suggestion: { addr1: '1 A ST', addr2: 'DOCK 1' } };
  const text = textOf(rt.render(() => Bar({ q: qWith({ selected: [ROW, mis] }), stacked: false })));
  assert.match(text, /Correct 1 on the board/, 'one of the two can be corrected on the board');
  assert.match(text, /Correct 2 \+ NuVizz/, 'both can be pushed');
  assert.match(text, /1 of the 2 selected is already right on the board — only Correct \+ NuVizz changes it/);
});

test('THE EDITOR offers the push alone on an unedited row, and both buttons once it is edited', () => {
  const rt = hooksRuntime();
  // eslint-disable-next-line no-new-func
  const Editor = new Function('React', `'use strict';\n${PURE()}\n${jsx(fnOnly('QueueRowEditor'))}\nreturn QueueRowEditor;`)(rt.React);
  const e = (f) => ({ f, setF() {}, busy: false, msg: null, save() {} });
  for (const stacked of [true, false]) {
    const left = textOf(rt.render(() => Editor({ e: e(pure.correctedFields(ROW)), row: ROW, pushable: true, stacked })));
    assert.match(left, /Send to NuVizz \(3 calls\)/);
    assert.doesNotMatch(left, /Save to board/, 'nothing to save on the board');
    assert.match(left, /nothing is saved here and the pin is not touched/);
    const edited = textOf(rt.render(() => Editor({ e: e({ ...ROW.shown, addr2: 'GATE 2' }), row: ROW, pushable: true, stacked })));
    assert.match(edited, /Save to board/);
    assert.match(edited, /Save & correct NuVizz \(3 calls\)/);
    const stuck = textOf(rt.render(() => Editor({ e: e(pure.correctedFields(ROW)), row: ROW, pushable: false, stacked })));
    assert.match(stuck, /cannot be pushed/, 'no button that can only fail, and it says why');
  }
});

test('the badge counts these rows, and its hint says so', () => {
  // eslint-disable-next-line no-new-func
  const problemAddressTotal = new Function(`'use strict';\n${fnOnly('problemAddressTotal')}\nreturn problemAddressTotal;`)();
  assert.equal(problemAddressTotal({ no_pin: 1, mis_split: 1, corrected_not_pinned: 1, not_in_nuvizz: 2 }, false), 5);
  assert.equal(problemAddressTotal({ not_in_nuvizz: 2, dismissed: 1 }, true), 1);
  assert.match(APP, /to fix — wrong door, wrong pin, no pin, or fixed here but not in NuVizz/);
});
