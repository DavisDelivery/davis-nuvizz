// test/manifest-archive.test.mjs
//
// KEEP THE MANIFEST, NOT JUST THE VERDICT.
//
// Chad: "we need to download the PDF and put them in our system and have a history of those,
// as well as any that we're missing on that manifest for that particular day… we get four or
// five manifests every night, and every new manifest needs to overwrite the previous for that
// particular day. But their last one is sent at twelve AM, which is technically the delivery
// day — we need to make sure that day applies to the night before and not to that actual day."
//
// The midnight rule is the thing most likely to be got wrong and least likely to be noticed:
// a report filed one day late looks perfectly fine until somebody goes looking for the night
// a disputed order was manifested and finds an empty file.
//
// PURE — no Firestore, no blobs, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  manifestDeliveryDate, foldRevision, pdfDigest, manifestBlobKey, describeDay,
  MAX_REVISIONS, MAX_MISSING_ROWS, NIGHT_ROLLOVER_HOUR,
} from '../netlify/functions/lib/manifest-archive.mts';

const row = (shipDate, pro) => ({ shipDate, pro });
// 12:05a ET on Aug 21 == 04:05 UTC (EDT is UTC-4).
const MIDNIGHT_ET = '2026-08-21T04:05:00Z';
// 9:40p ET on Aug 20 == 01:40 UTC on Aug 21.
const EVENING_ET = '2026-08-21T01:40:00Z';

// ── which night does this report belong to ───────────────────────────────────

test('THE PAPER DECIDES: every report of one night files under the date it prints', () => {
  const rows = [row('8/21/26', '1'), row('8/21/26', '2'), row('8/21/26', '3')];
  // The 9:40p report and the 12:05a one carry the same ship date, so they land in the same
  // file WITHOUT needing any rule about the clock at all.
  const evening = manifestDeliveryDate(rows, EVENING_ET);
  const midnight = manifestDeliveryDate(rows, MIDNIGHT_ET);
  assert.equal(evening.date, '2026-08-21');
  assert.equal(midnight.date, '2026-08-21');
  assert.equal(midnight.from, 'manifest', 'read off the document, not off the clock');
});

test('THE MIDNIGHT RULE: with no date on the paper, an after-midnight arrival files to the night before', () => {
  // Chad's case exactly — "that day applies to the night before and not to that actual day."
  const m = manifestDeliveryDate([], MIDNIGHT_ET);
  assert.equal(m.date, '2026-08-20', '12:05a on the 21st belongs to the night of the 20th');
  assert.equal(m.from, 'clock');
});

test('…and an evening arrival still files to that evening', () => {
  const m = manifestDeliveryDate([], EVENING_ET);
  assert.equal(m.date, '2026-08-20', '9:40p on the 20th is the 20th');
  assert.equal(m.from, 'clock');
});

test('the rollover is a night rule, not an all-day one', () => {
  // 5:00a ET on Aug 21 == 09:00 UTC. Past the rollover, so it is its own day again.
  const after = manifestDeliveryDate([], '2026-08-21T09:00:00Z');
  assert.equal(after.date, '2026-08-21');
  // …and 4:59a is still the night before.
  const before = manifestDeliveryDate([], '2026-08-21T08:59:00Z');
  assert.equal(before.date, '2026-08-20');
  assert.equal(NIGHT_ROLLOVER_HOUR, 5);
});

test('ONE MIS-READ ROW CANNOT MISFILE A NIGHT: the mode wins, not row zero', () => {
  // The old diff took rows[0].shipDate on trust. A single stray date at the top of the
  // document would have filed the whole night under the wrong day.
  const rows = [row('8/14/26', 'bad'), row('8/21/26', 'a'), row('8/21/26', 'b'), row('8/21/26', 'c')];
  assert.equal(manifestDeliveryDate(rows, EVENING_ET).date, '2026-08-21');
});

test('a tie between dates resolves the same way every time', () => {
  const a = manifestDeliveryDate([row('8/21/26', '1'), row('8/20/26', '2')], EVENING_ET);
  const b = manifestDeliveryDate([row('8/20/26', '2'), row('8/21/26', '1')], EVENING_ET);
  assert.equal(a.date, b.date, 'row order must not change where a night is filed');
  assert.equal(a.date, '2026-08-20', 'ties break to the earlier date');
});

test('an unreadable arrival stamp does not throw or file to 1970', () => {
  const m = manifestDeliveryDate([], 'not a date');
  assert.match(m.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(m.from, 'clock');
});

// ── four or five a night, latest wins, nothing destroyed ─────────────────────

const entry = (over = {}) => ({
  at: '2026-08-20T22:00:00Z', digest: 'aaa', bytes: 1000, orders: 100,
  onBoard: 98, boardOnly: 0, missing: [], checkedAgainst: [],
  blobKey: 'davis/2026-08-21/r001.pdf', pdfStored: true, ...over,
});

test('A NIGHT OF FIVE REPORTS: the newest is what the day reads, and the other four survive', () => {
  let doc = null;
  for (let i = 1; i <= 5; i++) {
    const r = foldRevision(doc, entry({
      digest: `d${i}`, at: `2026-08-20T2${i}:00:00Z`, orders: 100 + i,
      missing: Array.from({ length: 6 - i }, (_, k) => ({ pro: `p${k}` })),
    }), 'davis', '2026-08-21');
    assert.equal(r.revision, i);
    assert.equal(r.duplicate, false);
    doc = r.doc;
  }
  assert.equal(doc.latest.revision, 5, 'the day reads the newest report — the overwrite Chad asked for');
  assert.equal(doc.latest.orders, 105);
  assert.equal(doc.latest.missingCount, 1);
  assert.equal(doc.revisionCount, 5, 'and the four it superseded are still on file');
  // The sequence is the story: six orders that only appear on the last report is a fact
  // about Uline, and it is only visible if the earlier reports were kept.
  assert.deepEqual(doc.revisions.map((r) => r.revision), [5, 4, 3, 2, 1], 'newest first');
  assert.deepEqual(doc.revisions.map((r) => r.missingCount), [1, 2, 3, 4, 5]);
});

test('THE SAME PDF TWICE IS NOT A NEW REPORT — a resend costs no revision and no blob write', () => {
  const first = foldRevision(null, entry({ digest: 'same' }), 'davis', '2026-08-21');
  const again = foldRevision(first.doc, entry({ digest: 'same', at: '2026-08-20T23:30:00Z' }), 'davis', '2026-08-21');
  assert.equal(again.duplicate, true, 'the caller must skip the upload on this');
  assert.equal(again.revision, 1);
  assert.equal(again.doc.revisionCount ?? again.doc.revisions.length, 1);
  // Seeing it again is still a fact worth keeping.
  assert.equal(again.doc.revisions[0].seen, 2);
  assert.equal(again.doc.revisions[0].lastSeenAt, '2026-08-20T23:30:00Z');
});

test('the missing list is what the day is FOR, and its count never lies about its length', () => {
  const missing = Array.from({ length: MAX_MISSING_ROWS + 40 }, (_, i) => ({ pro: `p${i}` }));
  const { doc } = foldRevision(null, entry({ missing }), 'davis', '2026-08-21');
  assert.equal(doc.latest.missingCount, MAX_MISSING_ROWS + 40, 'the COUNT is exact');
  assert.equal(doc.latest.missing.length, MAX_MISSING_ROWS, 'the list is capped');
  assert.equal(doc.latest.missingTruncated, true, 'and says so, so a capped day cannot read as complete');
});

test('a PDF that did not reach the store is recorded as not stored, with no key pointing at nothing', () => {
  const { doc } = foldRevision(null, entry({ blobKey: null, pdfStored: false, pdfError: 'store unavailable' }), 'davis', '2026-08-21');
  assert.equal(doc.latest.pdfStored, false);
  assert.equal(doc.latest.blobKey, null, 'never a key that resolves to nothing');
  assert.equal(doc.latest.pdfError, 'store unavailable');
  assert.match(describeDay(doc), /PDF not stored/, 'and it is visible in the summary, not buried');
});

test('a runaway resend loop cannot grow the day document without end', () => {
  let doc = null;
  for (let i = 1; i <= MAX_REVISIONS + 10; i++) {
    doc = foldRevision(doc, entry({ digest: `x${i}` }), 'davis', '2026-08-21').doc;
  }
  assert.equal(doc.revisions.length, MAX_REVISIONS);
  assert.equal(doc.latest.revision, MAX_REVISIONS + 10, 'the newest is always kept');
  assert.equal(doc.revisions[0].revision, MAX_REVISIONS + 10);
});

test('first_at survives every later write — when this night first reported is write-once', () => {
  const a = foldRevision(null, entry({ digest: '1', at: '2026-08-20T20:00:00Z' }), 'davis', '2026-08-21');
  const b = foldRevision(a.doc, entry({ digest: '2', at: '2026-08-21T04:05:00Z' }), 'davis', '2026-08-21');
  assert.equal(b.doc.first_at, '2026-08-20T20:00:00Z');
  assert.equal(b.doc.updated_at, '2026-08-21T04:05:00Z');
});

// ── keys and digests ─────────────────────────────────────────────────────────

test('the blob key sorts by date then revision, so a prefix is a night and a month', () => {
  assert.equal(manifestBlobKey('davis', '2026-08-21', 1), 'davis/2026-08-21/r001.pdf');
  assert.equal(manifestBlobKey('davis', '2026-08-21', 12), 'davis/2026-08-21/r012.pdf');
  const keys = [manifestBlobKey('davis', '2026-08-21', 10), manifestBlobKey('davis', '2026-08-21', 2)];
  assert.deepEqual([...keys].sort(), [manifestBlobKey('davis', '2026-08-21', 2), manifestBlobKey('davis', '2026-08-21', 10)],
    'zero-padded, so 10 does not sort before 2');
});

test('the digest is the bytes, so one changed byte is a different report', () => {
  const a = pdfDigest(Buffer.from('%PDF-1.4 hello'));
  assert.equal(a, pdfDigest(Buffer.from('%PDF-1.4 hello')), 'stable');
  assert.notEqual(a, pdfDigest(Buffer.from('%PDF-1.4 hellp')));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('describeDay reads as a sentence a dispatcher can act on', () => {
  const { doc } = foldRevision(null, entry({ orders: 212, missing: [{ pro: 'a' }, { pro: 'b' }] }), 'davis', '2026-08-21');
  assert.equal(describeDay(doc), '212 orders · 2 not on the board · report 1 of 1');
  const clean = foldRevision(null, entry({ orders: 1 }), 'davis', '2026-08-21').doc;
  assert.equal(describeDay(clean), '1 order · all on the board · report 1 of 1');
  assert.equal(describeDay(null), 'no manifest on file');
});
