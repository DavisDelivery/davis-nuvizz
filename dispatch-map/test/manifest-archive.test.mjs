// test/manifest-archive.test.mjs
//
// KEEP THE MANIFEST, NOT JUST THE VERDICT.
//
// Chad: "we need to download the PDF and put them in our system and have a history of those,
// as well as any that we're missing on that manifest for that particular day… their last one
// is sent at twelve AM, which is technically the delivery day — we need to make sure that day
// applies to the night before and not to that actual day." Then, correcting the first cut:
// "The manifest is only added to, nothing is ever removed from it, so that course of action of
// overwriting it every time was correct. I just want to keep an actual copy of it, but I don't
// want 4 copies a night kept."
//
// So: ONE copy a night, overwritten, plus the metadata the overwrite would otherwise destroy.
//
// The midnight rule is the thing most likely to be got wrong and least likely to be noticed:
// a report filed one day late looks perfectly fine until somebody goes looking for the night
// a disputed order was manifested and finds an empty file.
//
// PURE — no Firestore, no blobs, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  manifestDeliveryDate, foldManifestDay, pdfDigest, manifestBlobKey, describeDay,
  MAX_ARRIVALS, MAX_MISSING_ROWS, NIGHT_ROLLOVER_HOUR,
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

// ── one copy a night ─────────────────────────────────────────────────────────

const entry = (over = {}) => ({
  at: '2026-08-20T22:00:00Z', digest: 'aaa', bytes: 1000, orders: 100,
  onBoard: 98, boardOnly: 0, missing: [], checkedAgainst: [],
  blobKey: 'davis/2026-08-21.pdf', pdfStored: true, ...over,
});

test('A NIGHT OF FIVE REPORTS LEAVES ONE MANIFEST — the last one, which is the complete one', () => {
  // Chad: "the manifest is only added to, nothing is ever removed from it." So each report is
  // a superset of the one before and the survivor holds everything the other four did.
  let doc = null;
  for (let i = 1; i <= 5; i++) {
    const r = foldManifestDay(doc, entry({
      digest: `d${i}`, at: `2026-08-20T2${i}:00:00Z`, orders: 100 + i * 10,
      missing: Array.from({ length: 6 - i }, (_, k) => ({ pro: `p${k}` })),
    }), 'davis', '2026-08-21');
    assert.equal(r.reportNo, i);
    assert.equal(r.duplicate, false);
    assert.equal(r.orderCountFell, false, 'each report is longer than the last, as Uline sends them');
    doc = r.doc;
  }
  assert.equal(doc.latest.orders, 150, 'the night reads the last report');
  assert.equal(doc.latest.missingCount, 1);
  assert.equal(doc.reportCount, 5);
  // ONE key, so five reports left one PDF behind them, not five.
  assert.equal(doc.latest.blobKey, 'davis/2026-08-21.pdf');
  assert.equal(manifestBlobKey('davis', '2026-08-21'), 'davis/2026-08-21.pdf');
});

test('what the overwrite would have destroyed is kept — and it is metadata, not copies', () => {
  let doc = null;
  for (let i = 1; i <= 4; i++) {
    doc = foldManifestDay(doc, entry({ digest: `d${i}`, at: `2026-08-2${i > 3 ? 1 : 0}T2${i}:00:00Z`, orders: 100 + i }), 'davis', '2026-08-21').doc;
  }
  assert.equal(doc.arrivals.length, 4, 'how many came, and when');
  assert.deepEqual(doc.arrivals.map((a) => a.reportNo), [4, 3, 2, 1], 'newest first');
  // No PDFs and no missing lists hang off an arrival — that is the whole point. receivedAt
  // joins the list as metadata of exactly that kind: it is what decides which revision stands
  // (see the supersedes rule), and it must be on the arrival to be readable per report.
  for (const a of doc.arrivals) {
    assert.equal(a.blobKey, undefined);
    assert.equal(a.missing, undefined);
    assert.deepEqual(Object.keys(a).sort(), ['at', 'mailbox', 'missingCount', 'orders', 'receivedAt', 'reportNo']);
  }
  assert.equal(doc.first_at, '2026-08-20T21:00:00Z', 'when the night first reported is write-once');
});

test('THE INVARIANT IS A CHECK: a report that comes back SHORTER is flagged, not silently taken', () => {
  // Nothing is ever removed from a manifest, so fewer orders means a truncated download or a
  // mis-parse — the one case where overwriting a good document with a worse one would hurt.
  const first = foldManifestDay(null, entry({ digest: 'd1', orders: 212 }), 'davis', '2026-08-21');
  assert.equal(first.orderCountFell, false);
  const short = foldManifestDay(first.doc, entry({ digest: 'd2', orders: 118 }), 'davis', '2026-08-21');
  assert.equal(short.orderCountFell, true);
  assert.equal(short.priorOrders, 212);
  assert.equal(short.doc.latest.orderCountFell, true);
  assert.equal(short.doc.sawOrderCountFall, true);
  assert.match(describeDay(short.doc), /ARRIVED SHORTER/);
  // …and the night stays flagged once a good report lands on top, because the reason to look
  // does not go away.
  const recovered = foldManifestDay(short.doc, entry({ digest: 'd3', orders: 220 }), 'davis', '2026-08-21');
  assert.equal(recovered.orderCountFell, false, 'this report itself is fine');
  assert.equal(recovered.doc.sawOrderCountFall, true, 'but the night still says something went wrong');
});

test('THE SAME PDF TWICE IS NOT A NEW REPORT — a resend costs no upload and no report number', () => {
  const first = foldManifestDay(null, entry({ digest: 'same' }), 'davis', '2026-08-21');
  const again = foldManifestDay(first.doc, entry({ digest: 'same', at: '2026-08-20T23:30:00Z' }), 'davis', '2026-08-21');
  assert.equal(again.duplicate, true, 'the caller must skip the upload on this');
  assert.equal(again.doc.reportCount, 1, 'and it is not a second report');
  assert.equal(again.doc.arrivals.length, 1);
  // Seeing it again is still a fact worth keeping.
  assert.equal(again.doc.latest.seen, 2);
  assert.equal(again.doc.latest.lastSeenAt, '2026-08-20T23:30:00Z');
});

test('the missing list is what the night is FOR, and its count never lies about its length', () => {
  const missing = Array.from({ length: MAX_MISSING_ROWS + 40 }, (_, i) => ({ pro: `p${i}` }));
  const { doc } = foldManifestDay(null, entry({ missing }), 'davis', '2026-08-21');
  assert.equal(doc.latest.missingCount, MAX_MISSING_ROWS + 40, 'the COUNT is exact');
  assert.equal(doc.latest.missing.length, MAX_MISSING_ROWS, 'the list is capped');
  assert.equal(doc.latest.missingTruncated, true, 'and says so, so a capped night cannot read as complete');
});

test('a PDF that did not reach the store is recorded as not stored, with no key pointing at nothing', () => {
  const { doc } = foldManifestDay(null, entry({ blobKey: null, pdfStored: false, pdfError: 'store unavailable' }), 'davis', '2026-08-21');
  assert.equal(doc.latest.pdfStored, false);
  assert.equal(doc.latest.blobKey, null, 'never a key that resolves to nothing');
  assert.equal(doc.latest.pdfError, 'store unavailable');
  assert.match(describeDay(doc), /PDF not stored/, 'and it is visible in the summary, not buried');
});

test('a runaway resend loop cannot grow the night document without end', () => {
  let doc = null;
  for (let i = 1; i <= MAX_ARRIVALS + 10; i++) {
    doc = foldManifestDay(doc, entry({ digest: `x${i}`, orders: 100 + i }), 'davis', '2026-08-21').doc;
  }
  assert.equal(doc.arrivals.length, MAX_ARRIVALS);
  assert.equal(doc.reportCount, MAX_ARRIVALS + 10, 'the true count is still true');
  assert.equal(doc.arrivals[0].reportNo, MAX_ARRIVALS + 10, 'the newest is always kept');
});

// ── keys and digests ─────────────────────────────────────────────────────────

test('ONE KEY PER NIGHT: a later report overwrites the bytes rather than sitting beside them', () => {
  // "I don't want 4 copies a night kept." Four reports, one key, one object.
  const keys = new Set([1, 2, 3, 4].map(() => manifestBlobKey('davis', '2026-08-21')));
  assert.equal(keys.size, 1);
  assert.equal([...keys][0], 'davis/2026-08-21.pdf');
  assert.notEqual(manifestBlobKey('davis', '2026-08-22'), manifestBlobKey('davis', '2026-08-21'));
});

test('the digest is the bytes, so one changed byte is a different report', () => {
  const a = pdfDigest(Buffer.from('%PDF-1.4 hello'));
  assert.equal(a, pdfDigest(Buffer.from('%PDF-1.4 hello')), 'stable');
  assert.notEqual(a, pdfDigest(Buffer.from('%PDF-1.4 hellp')));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('describeDay reads as a sentence a dispatcher can act on', () => {
  const { doc } = foldManifestDay(null, entry({ orders: 212, missing: [{ pro: 'a' }, { pro: 'b' }] }), 'davis', '2026-08-21');
  assert.equal(describeDay(doc), '212 orders · 2 not on the board · 1 report tonight');
  const clean = foldManifestDay(null, entry({ orders: 1 }), 'davis', '2026-08-21').doc;
  assert.equal(describeDay(clean), '1 order · all on the board · 1 report tonight');
  assert.equal(describeDay(null), 'no manifest on file');
});

// ── WHICH REVISION IS THE NIGHT'S TRUTH ──────────────────────────────────────
//
// Chad, holding a stored manifest: "you're saving the wrong manifest, you should be saving
// the last one pulled in. You're instead saving the first one."
//
// Uline sends one night's report five times. The real 08/27/26 mail: a 26,971-byte
// preliminary at 14:51, then 61,475 / 61,498 / 61,495 / 61,474 bytes at midnight, 1am, 2am
// and 3am. The manifest is append-only, so the LAST one is complete and the first is a
// fragment. The ingest now reads the mailbox oldest-first — but a report that could not be
// filed on arrival ("board not scanned yet") is deliberately left unmarked and retried, so it
// comes BACK later in a batch with newer reports. Re-batching is designed in, so the archive
// cannot rely on arrival order alone.

const ulineNight = (label, receivedAt, orders) => entry({
  digest: `d-${label}`, at: '2026-08-28T03:05:00Z', orders, receivedAt: Date.parse(receivedAt),
});

test('AN EARLIER REPORT CANNOT TAKE THE NIGHT FROM A LATER ONE', () => {
  // The 3am full report is on file. The 14:51 preliminary then comes back off the retry queue.
  const full = foldManifestDay(null, ulineNight('3am', '2026-08-28T03:00:59Z', 545), 'davis', '2026-08-27');
  assert.equal(full.supersedes, true, 'the first report of a night always stands');

  const late = foldManifestDay(full.doc, ulineNight('prelim', '2026-08-27T14:51:06Z', 76), 'davis', '2026-08-27');
  assert.equal(late.supersedes, false, 'an earlier send may not replace a later one');
  assert.equal(late.doc.latest.orders, 545, 'the night keeps the complete manifest');
  assert.equal(late.doc.latest.digest, 'd-3am');
  // It is still COUNTED and RECORDED — a report that arrived is a fact, and hiding it would
  // make "how many came" wrong.
  assert.equal(late.doc.reportCount, 2);
  assert.equal(late.doc.arrivals.length, 2);
  assert.equal(late.doc.arrivals[0].supersededByStanding, true, 'and it says it did not take the night');
});

test('the ordinary case is untouched: a later report DOES replace an earlier one', () => {
  const prelim = foldManifestDay(null, ulineNight('prelim', '2026-08-27T14:51:06Z', 76), 'davis', '2026-08-27');
  const full = foldManifestDay(prelim.doc, ulineNight('midnight', '2026-08-28T00:01:23Z', 545), 'davis', '2026-08-27');
  assert.equal(full.supersedes, true);
  assert.equal(full.doc.latest.orders, 545);
  assert.equal(full.doc.latest.digest, 'd-midnight');
  assert.equal(full.doc.arrivals[0].supersededByStanding, undefined, 'nothing to note when it stands');
});

test('THE WHOLE NIGHT, IN THE ORDER GMAIL USED TO HAND IT OVER, STILL ENDS CORRECT', () => {
  // Newest first — the order that produced the bug. With the supersede rule, even this
  // sequence settles on the complete manifest instead of the fragment.
  const night = [
    ['3am', '2026-08-28T03:00:59Z', 545],
    ['2am', '2026-08-28T02:00:44Z', 544],
    ['1am', '2026-08-28T01:00:29Z', 540],
    ['midnight', '2026-08-28T00:01:23Z', 533],
    ['prelim', '2026-08-27T14:51:06Z', 76],
  ];
  let doc = null;
  for (const [label, when, orders] of night) {
    doc = foldManifestDay(doc, ulineNight(label, when, orders), 'davis', '2026-08-27').doc;
  }
  assert.equal(doc.latest.digest, 'd-3am', 'the 3am report stands, whatever order the mail came in');
  assert.equal(doc.latest.orders, 545);
  assert.equal(doc.reportCount, 5, 'all five are still counted');
  // And the "came back short" flag stays quiet: walking backwards used to make the order
  // count fall on almost every fold, so a healthy night looked broken.
  assert.equal(doc.sawOrderCountFall, false, 'out-of-order arrivals are not short reports');
});

test('a night with no timestamps behaves exactly as it did before', () => {
  // Older records, and any source that cannot supply a receive time, must not change shape.
  const a = foldManifestDay(null, entry({ digest: 'd1', orders: 100 }), 'davis', '2026-08-21');
  assert.equal(a.supersedes, true);
  const b = foldManifestDay(a.doc, entry({ digest: 'd2', orders: 200 }), 'davis', '2026-08-21');
  assert.equal(b.supersedes, true, 'unknown times cannot prove an ordering, so filing order stands');
  assert.equal(b.doc.latest.orders, 200);
});

test('a report with a time landing on a record that has none is adopted', () => {
  // The migration case: the night was filed before receivedAt existed. Refusing here would
  // freeze that night on whatever it happened to hold.
  const old = foldManifestDay(null, entry({ digest: 'd1', orders: 100 }), 'davis', '2026-08-21');
  assert.equal(old.doc.latest.receivedAt, null);
  const now = foldManifestDay(old.doc, ulineNight('later', '2026-08-28T03:00:00Z', 545), 'davis', '2026-08-21');
  assert.equal(now.supersedes, true);
  assert.equal(now.doc.latest.orders, 545);
});

test('the same paper arriving twice is still a duplicate, and supersedes nothing', () => {
  const first = foldManifestDay(null, ulineNight('3am', '2026-08-28T03:00:59Z', 545), 'davis', '2026-08-27');
  const again = foldManifestDay(first.doc, ulineNight('3am', '2026-08-28T03:00:59Z', 545), 'davis', '2026-08-27');
  assert.equal(again.duplicate, true);
  assert.equal(again.supersedes, false, 'nothing to overwrite — and nothing should be uploaded');
  assert.equal(again.doc.latest.seen, 2);
});
