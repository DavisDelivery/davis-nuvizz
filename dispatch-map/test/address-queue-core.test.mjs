// test/address-queue-core.test.mjs
//
// THE PROBLEM-ADDRESS QUEUE — the rules that decide which stops a dispatcher is shown.
//
// Chad: "list by board day every stop that the system has flagged as a problem address."
// Three signals populate it, and the third one did not exist before this: an address that was
// CORRECTED while its geocode quietly failed, leaving the stale feed pin from the old wrong
// address in place. Nothing flagged that. The card read the right street, the map pin sat on
// the old building, and `no_location` stayed silent because a position did exist.
//
// These tests pin the RULES and name the real-world event, per CLAUDE.md. They are pure — no
// Firestore, no network, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addressQueueEnabled, classifyQueueRow, pinIsStale, hasPin, queueRowFingerprint,
  dismissalKey, buildQueueRow, sortQueueRows, isDismissed, SIGNAL_RANK,
} from '../netlify/functions/lib/address-queue.mts';

const stop = (o = {}) => ({
  stopNbr: 'ESTES-1', stopId: 'abc123', businessName: 'ACME DOCK',
  addr1: '800 N COMMERCE ST', addr2: '', city: 'MONROE', state: 'GA', zip: '30655',
  lat: 33.79, lng: -83.71, ...o,
});
const T0 = '2026-09-14T10:00:00.000Z';
const T1 = '2026-09-14T11:00:00.000Z';

// ── the three signals ────────────────────────────────────────────────────────

test('NO PIN: a stop that never geocoded cannot be routed, and leads the queue', () => {
  assert.equal(classifyQueueRow(stop({ lat: null, lng: null }), null), 'no_pin');
  assert.equal(SIGNAL_RANK.no_pin, 0, 'it outranks the others — the board already flags it');
});

test('NO PIN clears when a dispatcher drags a pin, because stopPosition prefers the override', () => {
  const note = { location_override: { lat: 33.8, lng: -83.7 } };
  assert.equal(classifyQueueRow(stop({ lat: null, lng: null }), note), null);
});

test('MIS-SPLIT: the suite is where the street should be, so the pin was geocoded off addr2', () => {
  assert.equal(classifyQueueRow(stop({ addr1: 'BLDG 200', addr2: '4310 INDUSTRIAL ACCESS RD' }), null), 'mis_split');
});

test('CORRECTED, PIN NOT MOVED — the case nothing could see', () => {
  // autoFixAddress saved the text and skipped the pin (the geocode threw). stopPosition falls
  // through to the FEED coordinates, which were geocoded from the OLD wrong address — so the
  // stop HAS a position, `no_location` stays silent, and a truck routed off that pin goes to
  // the old building while the paperwork says the new one.
  const note = { address_override: { addr1: '800 N COMMERCE ST' }, address_override_at: T0 };
  assert.equal(classifyQueueRow(stop(), note), 'corrected_not_pinned');
});

test('…and it clears the moment somebody drags the pin to match', () => {
  const note = {
    address_override: { addr1: '800 N COMMERCE ST' }, address_override_at: T0,
    location_override: { lat: 33.8, lng: -83.7 }, location_override_at: T1,
  };
  assert.equal(classifyQueueRow(stop(), note), null);
});

test('A PIN DRAGGED BEFORE THE CORRECTION IS STILL STALE — it points at the old building', () => {
  const note = {
    address_override: { addr1: '800 N COMMERCE ST' }, address_override_at: T1,
    location_override: { lat: 33.8, lng: -83.7 }, location_override_at: T0,   // dragged FIRST
  };
  assert.equal(classifyQueueRow(stop(), note), 'corrected_not_pinned');
});

test('BOTH ARMS ARE LOAD-BEARING: resetStopLocation clears the pin and leaves its timestamp', () => {
  // App.jsx:12038 writes `location_override: null` WITHOUT clearing location_override_at. The
  // timestamp arm alone would read that stamp as proof of a pin that no longer exists and
  // under-fire. The pin arm catches it. A queue that quietly shows fewer rows looks exactly
  // like a clean board — the v0.56.3 shape.
  const note = {
    address_override: { addr1: '800 N COMMERCE ST' }, address_override_at: T0,
    location_override: null, location_override_at: T1,   // stamp outlives its pin
  };
  assert.equal(pinIsStale(note), true);
  assert.equal(classifyQueueRow(stop(), note), 'corrected_not_pinned');
});

test('a half-written pin (lat but no lng) is NOT a pin — Number(null) is 0 and 0 is finite', () => {
  assert.equal(hasPin({ lat: 33.8, lng: null }), false);
  assert.equal(hasPin({ lat: 33.8 }), false);
  assert.equal(hasPin({ lat: 0, lng: 0 }), true, 'null island is a real coordinate, not absence');
});

test('no correction recorded = nothing stale, whatever the pin says', () => {
  assert.equal(pinIsStale({ location_override_at: T1 }), false);
  assert.equal(pinIsStale({}), false);
  assert.equal(pinIsStale(null), false);
});

test('ONE ROW PER STOP: a corrected address can never also report as mis-split', () => {
  // addressLooksOff returns false the moment an override exists (address-fix.js:28), so these
  // are mutually exclusive by construction, not by the order of the if-statements.
  const note = { address_override: { addr1: 'BLDG 200' }, address_override_at: T0 };
  const sig = classifyQueueRow(stop({ addr1: 'BLDG 200', addr2: '4310 INDUSTRIAL ACCESS RD' }), note);
  assert.equal(sig, 'corrected_not_pinned');
});

test('a clean stop is not on the queue', () => {
  assert.equal(classifyQueueRow(stop(), null), null);
});

// ── dismissals ───────────────────────────────────────────────────────────────

test('A DISMISSAL EXPIRES WHEN THE ADDRESS CHANGES AGAIN — it must not swallow a new problem', () => {
  const before = buildQueueRow(stop({ lat: null, lng: null }), null, '2026-09-14');
  const items = { [before.key]: { fp: before.fp } };
  assert.equal(isDismissed(before, items), true, 'waved off, stays hidden');

  // The carrier re-addresses the order overnight. Same stop, same signal, different address.
  const after = buildQueueRow(stop({ lat: null, lng: null, addr1: '1 SOMEWHERE ELSE RD' }), null, '2026-09-15');
  assert.equal(after.key, before.key, 'same row identity');
  assert.notEqual(after.fp, before.fp, 'but a different thing is wrong now');
  assert.equal(isDismissed(after, items), false, 'so it comes back');
});

test('dragging the pin changes the fingerprint, so a dismissed stale-pin row retires itself', () => {
  const note = { address_override: { addr1: '800 N COMMERCE ST' }, address_override_at: T0 };
  const stale = buildQueueRow(stop(), note, '2026-09-14');
  const fixed = queueRowFingerprint(stop(), { ...note, location_override: { lat: 33.8, lng: -83.7 }, location_override_at: T1 });
  assert.notEqual(stale.fp, fixed, 'feed pin -> override pin is a real change');
});

test('the same coordinates from a DIFFERENT source still change the fingerprint', () => {
  // feed -> override at identical lat/lng IS the corrected-not-pinned case being resolved.
  const a = queueRowFingerprint(stop(), null);
  const b = queueRowFingerprint(stop({ lat: null, lng: null }), { location_override: { lat: 33.79, lng: -83.71 } });
  assert.notEqual(a, b);
});

test('dismissals are keyed per ORDER, not per customer — two PROs at one dock are two calls', () => {
  const a = dismissalKey('mis_split', { stopNbr: 'ESTES-1', matchKey: 'acme|800|monroe' });
  const b = dismissalKey('mis_split', { stopNbr: 'ESTES-2', matchKey: 'acme|800|monroe' });
  assert.notEqual(a, b);
});

test('and per SIGNAL — waving off a mis-split must not hide that the stop has no pin', () => {
  assert.notEqual(dismissalKey('mis_split', { stopNbr: 'ESTES-1' }), dismissalKey('no_pin', { stopNbr: 'ESTES-1' }));
});

test('a row we cannot name REFUSES a key rather than colliding with every other nameless row', () => {
  assert.equal(dismissalKey('no_pin', { stopNbr: '', pro: '', matchKey: '' }), null);
  assert.equal(dismissalKey('no_pin', {}), null);
  // …and an un-keyable row can never read as dismissed, whatever is in the store.
  assert.equal(isDismissed({ key: null, fp: 'x' }, { 'no_pin__': { fp: 'x' } }), false);
});

// ── the row, and the order it is read in ─────────────────────────────────────

test('the row carries BOTH sides of the disagreement — what we show and what NuVizz holds', () => {
  const note = { address_override: { addr1: '800 N COMMERCE ST', city: 'MONROE' }, address_override_at: T0 };
  const row = buildQueueRow(stop({ addr1: '1 WRONG ST', city: 'BUFORD' }), note, '2026-09-14');
  assert.equal(row.shown.addr1, '800 N COMMERCE ST', 'what the card renders');
  assert.equal(row.vendor.addr1, '1 WRONG ST', 'what the order still says');
  assert.equal(row.corrected, true);
});

test('a mis-split row carries its suggested fix; the others carry none rather than a made-up one', () => {
  const split = buildQueueRow(stop({ addr1: 'BLDG 200', addr2: '4310 INDUSTRIAL ACCESS RD' }), null, '2026-09-14');
  assert.equal(split.suggestion.addr1, '4310 INDUSTRIAL ACCESS RD');
  const nopin = buildQueueRow(stop({ lat: null, lng: null }), null, '2026-09-14');
  assert.equal(nopin.suggestion, null);
});

test('stopId rides on the row — without it the server cannot refuse the wrong twin', () => {
  assert.equal(buildQueueRow(stop({ lat: null, lng: null }), null, '2026-09-14').stopId, 'abc123');
  assert.equal(buildQueueRow(stop({ lat: null, lng: null, stopId: null }), null, '2026-09-14').stopId, null);
});

test('the worst signal is read first, then by the name a dispatcher is looking for', () => {
  const rows = sortQueueRows([
    { rank: 2, signal: 'mis_split', businessName: 'ZZZ', stopNbr: '1' },
    { rank: 0, signal: 'no_pin', businessName: 'MMM', stopNbr: '2' },
    { rank: 1, signal: 'corrected_not_pinned', businessName: 'AAA', stopNbr: '3' },
    { rank: 0, signal: 'no_pin', businessName: 'AAA', stopNbr: '4' },
  ]);
  assert.deepEqual(rows.map((r) => r.stopNbr), ['4', '2', '3', '1']);
});

// ── the switch ───────────────────────────────────────────────────────────────

test('THE WAY BACK: ADDRESS_QUEUE=off, and a typo leaves the queue ON', () => {
  for (const off of ['off', '0', 'false', 'no', 'OFF', ' Off ']) {
    assert.equal(addressQueueEnabled({ ADDRESS_QUEUE: off }), false, `${JSON.stringify(off)} switches it off`);
  }
  for (const on of [undefined, '', '1', 'true', 'on', 'yes', 'offf', 'nope!']) {
    assert.equal(addressQueueEnabled({ ADDRESS_QUEUE: on }), true, `${JSON.stringify(on)} leaves it on`);
  }
});

test('it is its OWN switch — turning off the log must not silently take the queue with it', () => {
  assert.equal(addressQueueEnabled({ ADDRESS_HISTORY: 'off' }), true);
});
