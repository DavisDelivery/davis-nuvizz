// test/nuvizz-write-error-readable.test.mjs — a rejected write has to SAY WHY.
//
// Sep 10 2026. A ＋ New route for "Steven Adjenty" (14 orders) failed, and the entire
// diagnosis available to anyone — dispatcher, developer, the write ledger — was this:
//
//   createRoute: Internal Server Error: {"reasons":[{"description":"\u003cDeliverItLoad
//   Response xmlns\u003d…\u003e\n\u003cDocumentID\u003eUNKNOWN\u003c/DocumentID\u003e\n
//   \u003cStatus\u003e99\u003c/Status\u003e\n\u003cErrors class\u003d"java.util.ArrayList"…
//
// NuVizz had listed what it objected to. The list is the next thing in that string, and
// firstError() cut the message at 300 characters — landing, to the character, immediately
// after `<Errors class="java.util.ArrayList">`. So a whole day went into inferring from the
// vendor's spec what the vendor had already said out loud.
//
// These tests pin the three rules that came out of it, each named for the real event:
//   1. the vendor's text is never truncated on the way to the ledger;
//   2. the screen leads with the vendor's own complaint, and MARKS it when it clips;
//   3. a rejection journals what we SENT as well as what came back.
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeVendorText, summarizeVendorError, clipForToast, TOAST_MAX } from '../src/lib/write-error.js';

// The real thing, as it arrives: XML, JSON-escaped, inside a JSON string, inside `message`.
// The tail after <Errors> is invented — this repo has never once seen inside that list,
// which is exactly the point — but the wrapping is verbatim from the Sep 10 failure.
const VENDOR_XML = [
  '\\u003cDeliverItLoadResponse xmlns\\u003d\\"http://schemas.nuvizzards.com/schemas/di/response\\"\\u003e',
  '\\u003cDocumentID\\u003eUNKNOWN\\u003c/DocumentID\\u003e',
  '\\u003cStatus\\u003e99\\u003c/Status\\u003e',
  '\\u003cErrors class\\u003d\\"java.util.ArrayList\\"\\u003e',
  '\\u003cError\\u003e\\u003cMessage\\u003eDuplicate sequence 1 on route legs\\u003c/Message\\u003e\\u003c/Error\\u003e',
  '\\u003cError\\u003e\\u003cMessage\\u003eStop 007174458 could not be planned\\u003c/Message\\u003e\\u003c/Error\\u003e',
  '\\u003c/Errors\\u003e',
  '\\u003c/DeliverItLoadResponse\\u003e',
].join('\\n');
const REJECTION = `Internal Server Error: {"reasons":[{"description":"${VENDOR_XML}"}]}`;

test('the escaped XML NuVizz answers with is decoded far enough to read', () => {
  const t = decodeVendorText(REJECTION);
  assert.ok(t.includes('<DeliverItLoadResponse'), 'angle brackets come back');
  assert.ok(t.includes('<Errors class="java.util.ArrayList">'), 'the quoted attribute comes back');
  assert.ok(t.includes('\n'), 'the newlines come back');
  // Never throws on the shapes a failure actually hands it.
  for (const junk of [null, undefined, '', 42, {}, []]) assert.equal(typeof decodeVendorText(junk), 'string');
});

test('THE SEP 10 FAILURE: the dispatcher is shown what NuVizz objected to, not the XML preamble', () => {
  const s = summarizeVendorError(REJECTION);
  assert.ok(s, 'a DeliverIt response is recognized');
  assert.equal(s.documentId, 'UNKNOWN');
  assert.equal(s.status, '99');
  assert.deepEqual(s.errors, ['Duplicate sequence 1 on route legs', 'Stop 007174458 could not be planned']);
  const shown = clipForToast(REJECTION);
  assert.ok(shown.includes('Duplicate sequence 1 on route legs'), 'the actual reason leads');
  assert.ok(!shown.startsWith('Internal Server Error'), 'the envelope does not lead');
});

test('an error list we cannot read says SO — "unreadable" and "no errors" are opposite instructions', () => {
  // Precisely the Sep 10 case: the list is there and its contents are gone (truncated).
  const cut = REJECTION.slice(0, 300);
  const s = summarizeVendorError(cut);
  assert.ok(s, 'still recognized as a NuVizz rejection');
  assert.match(s.headline, /could not be read/);
  assert.match(s.headline, /Status 99/);
  assert.match(s.headline, /write log/, 'and it says where the rest lives');
});

test('unknown element names inside the list are still surfaced — we never guess at a tag', () => {
  // The shipped OpenAPI document does not describe this envelope at all (it never mentions
  // DeliverItLoadResponse), so a parser keyed on <Message> would show nothing on the day the
  // vendor uses <errorLiteral>. Whatever text the list holds is what gets shown.
  const xml = '<DeliverItLoadResponse><Status>99</Status><Errors class="java.util.ArrayList">'
    + '<SomethingNew>Vehicle Type unavailable or disabled</SomethingNew></Errors></DeliverItLoadResponse>';
  const s = summarizeVendorError(xml);
  assert.deepEqual(s.errors, ['SomethingNew: Vehicle Type unavailable or disabled']);
});

test('a repeated complaint is one complaint — fourteen identical lines is not fourteen problems', () => {
  const dup = '<DeliverItLoadResponse><Status>99</Status><Errors class="java.util.ArrayList">'
    + '<Error><Message>Duplicate sequence</Message></Error>'.repeat(14)
    + '</Errors></DeliverItLoadResponse>';
  assert.deepEqual(summarizeVendorError(dup).errors, ['Duplicate sequence']);
});

test('a clip SAYS it clipped and names where the rest is — an unmarked cut is what cost Sep 9', () => {
  const long = `x${'y'.repeat(5000)}`;
  const out = clipForToast(long);
  assert.ok(out.length > TOAST_MAX && out.length < TOAST_MAX + 120);
  assert.match(out, /\[cut — full text in the write log/);
  // Something that fits is returned untouched, with no marker to mislead.
  assert.equal(clipForToast('stop 007144371 is already planned on TRAILER 6'), 'stop 007144371 is already planned on TRAILER 6');
});

test('a non-vendor message passes through unchanged — the parser never eats an ordinary refusal', () => {
  const plain = 'createRoute: order 007174458 is ALREADY PLANNED on TRAILER 6 — remove it from this card';
  assert.equal(clipForToast(plain), plain);
  assert.equal(summarizeVendorError(plain), null);
  for (const junk of [null, undefined, '', 0]) assert.equal(summarizeVendorError(junk), null);
});

// ── the receipt must survive its own payloads ────────────────────────────────

test('an oversized ledger row drops the CAPTURES, never the row — and says it dropped them', async () => {
  const { trimOpRecord } = await import('../netlify/functions/lib/write-registries.mts');
  // Firestore refuses a document over 1 MiB and putOpRecord swallows the throw, so a Save
  // with enough failed ops would vanish from the ledger completely — losing the receipt to
  // the forensics riding on it, silently, which is the failure this capture exists to end.
  const big = 'x'.repeat(9000);
  const rec = {
    clientOpId: 'op_1', op: 'commitBoard', status: 'failed', tenant: 'DAVIS', at: '2026-09-10T12:00:00Z',
    result: { ok: false, steps: Array.from({ length: 120 }, () => ({ op: 'createRoute', result: { ok: false, sentBody: big, rawBody: big, error: 'refused' } })) },
  };
  const trimmed = trimOpRecord(rec);
  assert.equal(trimmed.op, 'commitBoard', 'the row itself survives');
  assert.equal(trimmed.status, 'failed');
  assert.equal(trimmed.result.steps[0].result.error, 'refused', 'and so does the reason');
  assert.equal(trimmed.result.steps[0].result.sentBody, null, 'the payloads are what give way');
  assert.equal(trimmed.capturesDropped, 240);
  assert.match(trimmed.captureNote, /over the 700000 cap/);
  assert.ok(JSON.stringify(trimmed).length < 700_000);
  // A row that fits is returned untouched — no note, nothing to mislead a reader.
  const small = { ...rec, result: { ok: false, steps: [{ op: 'createRoute', result: { sentBody: 'a', rawBody: 'b' } }] } };
  assert.deepEqual(trimOpRecord(small), small);
});
