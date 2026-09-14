// test/address-queue-wiring.test.mjs
//
// THE PROMISES THE QUEUE ENDPOINT MAKES, pinned at the source.
//
// The queue reads the board and never the vendor. That claim is worth a test rather than a
// comment because the endpoint sits one import away from a client that spends metered calls,
// and the screen tells a dispatcher it costs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const FN = fs.readFileSync(new URL('../netlify/functions/address-queue.mts', import.meta.url), 'utf8');
const CORE = fs.readFileSync(new URL('../netlify/functions/lib/address-queue.mts', import.meta.url), 'utf8');
const RULES = fs.readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');

test('ZERO NUVIZZ CALLS, STRUCTURALLY — there is no vendor client in scope to misuse', () => {
  // A promise in a comment is worth less than an import list. Nothing here can reach NuVizz.
  const imports = FN.split('\n').filter((l) => l.startsWith('import '));
  for (const line of imports) {
    assert.ok(!/nuvizz-request|nuvizz-write|nuvizz-scan|buildOpRequest|fireSingle/.test(line),
      `address-queue must not import a vendor client: ${line}`);
  }
  assert.match(FN, /nuvizzCalls: 0/, 'and the envelope asserts it, so the screen quotes a field not a sentence');
});

test('THE FREE DIAGNOSTIC: notesLoaded, so "no problems" and "no notes" are never the same screen', () => {
  // customer-key.mts records the failure at scale: 778 stops, matchKey null on every row, zero
  // notes loaded — and a board that reported clean. A queue with rows but zero notes is that
  // failure announcing itself.
  assert.match(FN, /notesLoaded: notes\.size/);
});

test('MATCHKEY IS DERIVED BEFORE ANYTHING IS JUDGED', () => {
  // The stored stop index carries none. Skip this and every stop joins to no note, every
  // correction looks unmade, and the queue fills with confident wrong rows.
  assert.match(FN, /withCustomerKeys\(stops\)/);
  const judge = FN.indexOf('buildQueueRow(');
  assert.ok(FN.indexOf('withCustomerKeys(stops)') < judge, 'derived first, judged second');
});

test('BUSINESS DAYS, NOT CALENDAR DAYS — the scan writes no Sunday document', () => {
  // A calendar horizon asks for a day nothing ever wrote and renders an empty column
  // indistinguishable from a clean one.
  assert.match(FN, /scanDatesFrom\(etDayString\(\), MAX_DAYS\)/);
  assert.match(FN, /const MAX_DAYS = 3/);
});

test('THE DISMISSAL WRITE IS FIELD-MASKED — a blind setDoc would erase the rest of the day', () => {
  assert.match(FN, /updateDocFields\(dismissalPath\(date\)/);
  assert.ok(!/setDoc\(/.test(FN), 'setDoc in this codebase REPLACES; two dispatchers must both land');
});

test('A DISMISSAL CANNOT BE STORED WITHOUT ITS FINGERPRINT', () => {
  // Without one the row could never come back, so waving off a mis-split would silently
  // swallow the carrier re-addressing that order tonight.
  assert.match(FN, /a fingerprint is required — without it the row could never come back/);
});

test('the dismissal names the DEVICE, never a verified person', () => {
  // Every request from the production site arrives with request.auth == null today. Naming a
  // human would be a claim the system cannot read back.
  assert.match(FN, /THE DEVICE, NEVER A VERIFIED PERSON/);
});

test('THE SWITCH covers the read AND the dismissal write, and is its own var', () => {
  assert.match(FN, /if \(!addressQueueEnabled\(\)\)/);
  const gate = FN.indexOf('addressQueueEnabled()');
  assert.ok(gate < FN.indexOf("req.method === 'POST'"), 'the POST is behind it too — one switch, every side');
  assert.match(CORE, /env\?\.ADDRESS_QUEUE/);
  // Must not READ the log's var — mentioning it in the comment that explains WHY is the point,
  // so match the access, not the word. A test that forbids documenting a decision gets the
  // documentation deleted rather than the rule enforced.
  assert.ok(!/env\??\.?\.?ADDRESS_HISTORY|process\.env\.ADDRESS_HISTORY/.test(CORE),
    "sharing the log's switch would mean ADDRESS_HISTORY=off silently took the queue with it");
});

test('THE COLLECTION IS CLOSED TO THE BROWSER, or the live catch-all leaves it world-writable', () => {
  // firestore.rules' live block allows read+write on everything not named in
  // serverOnlyCollection(). A browser able to forge a dismissal could bury a bad address.
  const fn = RULES.slice(RULES.indexOf('function serverOnlyCollection'), RULES.indexOf('function serverOnlyCollection') + 900);
  assert.match(fn, /'address_queue_dismissals'/);
});

test('the queue reads its own narrow projection, not the whole lean board', () => {
  // LEAN_STOP_FIELDS is ~70 fields; board-fields.mts records what a fat payload cost once —
  // a cold load blocked for seconds. Three days of it to find twenty rows repeats it.
  const FIELDS = fs.readFileSync(new URL('../netlify/functions/lib/board-fields.mts', import.meta.url), 'utf8');
  assert.match(FIELDS, /export const QUEUE_STOP_FIELDS/);
  const arr = FIELDS.slice(FIELDS.indexOf('export const QUEUE_STOP_FIELDS'));
  const body = arr.slice(0, arr.indexOf('];'));
  assert.ok((body.match(/'/g) || []).length / 2 < 25, 'narrow, not a second lean list');
  for (const must of ['stopId', 'lat', 'lng', 'addr1', 'addr2', 'normalizedStatus']) {
    assert.match(body, new RegExp(`'${must}'`), `${must} is load-bearing for the queue`);
  }
});

test('stopId is in the projection because without it the twin guard is disarmed', () => {
  const FIELDS = fs.readFileSync(new URL('../netlify/functions/lib/board-fields.mts', import.meta.url), 'utf8');
  assert.match(FIELDS, /twin guard is disarmed/, 'and the reason is written down where the field is chosen');
});
