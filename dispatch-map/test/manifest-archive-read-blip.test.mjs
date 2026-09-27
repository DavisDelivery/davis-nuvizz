// AN OLDER ULINE REPORT FILED DURING A FIRESTORE BLIP MUST NOT TAKE THE NIGHT.
//
// X-errors-3 (review 2026-09-03), reproduced by running the fold: archiveManifest read the
// night's record with `getDoc(path).catch(() => null)`. Against the real two-arrival record, an
// older report (earlier receivedAt) is kept as an arrival and does NOT supersede. Against null
// — which is what a read blip produced — the same report supersedes, becomes `latest`, is
// uploaded over the night's PDF, and the record is REPLACED (setDoc) with one arrival where
// there were two. The later, complete manifest is gone from the record and from the blob.
//
// The fix: the read is strict. A failed read lands in archiveManifest's own catch, which
// reports ok:false and writes nothing — the night keeps the manifest it had.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import {
  manifestDayPath, manifestDeliveryDate, foldManifestDay, pdfDigest,
} from '../netlify/functions/lib/manifest-archive.mts';
import { archiveManifest } from '../netlify/functions/lib/manifest-archive-store.mts';

const TENANT = 'davis';
// 10:40p ET on Sep 21 (EDT) — the night's filing time. Not a real PDF, so the date comes off
// the clock (no rows), which is the same date for every report in this test.
const AT = '2026-09-22T02:40:00Z';
const DATE = manifestDeliveryDate([], AT).date;
const PATH = manifestDayPath(TENANT, DATE);

// Uline's send times for three reports of one night.
const T_EARLY = Date.parse('2026-09-21T19:05:00Z');   // the afternoon preliminary — sent FIRST
const T_MID = Date.parse('2026-09-21T23:10:00Z');
const T_LATE = Date.parse('2026-09-22T04:30:00Z');    // the complete manifest — sent LAST

const entry = (tag, receivedAt, orders) => {
  const buf = Buffer.from(`not-a-real-pdf ${tag}`);
  return { at: AT, digest: pdfDigest(buf), bytes: buf.length, orders, receivedAt, blobKey: `${TENANT}/${DATE}.pdf`, pdfStored: true };
};

/** The night's real record: the mid report then the late one, both filed and stored. */
function twoArrivalNight() {
  const one = foldManifestDay(null, entry('mid', T_MID, 400), TENANT, DATE).doc;
  return foldManifestDay(one, entry('late', T_LATE, 686), TENANT, DATE).doc;
}

/** The fake, plus N failed (503) GETs of the night's record before it answers. */
function withBlip(seed, failedReads) {
  const fake = installFirestoreFake(seed);
  const inner = globalThis.fetch;
  let left = failedReads;
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input?.url ?? input);
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET' && u.includes('firestore.googleapis.com') && u.includes(`/documents/${PATH}`) && left > 0) {
      left -= 1;
      return new Response('{"error":{"status":"UNAVAILABLE"}}', { status: 503 });
    }
    return inner(input, init);
  };
  return fake;
}

test('an older Uline report filed during a Firestore read blip does not overwrite the night\'s complete manifest', async () => {
  const night = twoArrivalNight();
  assert.equal(night.arrivals.length, 2);
  assert.equal(night.latest.receivedAt, T_LATE);

  const fake = withBlip({ [PATH]: structuredClone(night) }, 1);
  try {
    const out = await archiveManifest({
      tenant: TENANT, buf: Buffer.from('not-a-real-pdf early'), diff: { manifest: { orders: 120 } },
      email: { id: 'e-early', receivedAt: T_EARLY }, fileName: 'early.pdf', at: AT, mailbox: 'gmail',
    });
    assert.equal(out.ok, false, 'a filing that could not read the night is reported as NOT filed');
    assert.equal(fake.log.sets.filter((s) => s.path === PATH).length, 0, 'the night\'s record was not rewritten');
    assert.deepEqual(fake.store.get(PATH), night, 'the complete manifest and both arrivals are still on file');
    assert.equal(fake.log.other.length, 0, 'and nothing was uploaded over the night\'s PDF');
  } finally { fake.restore(); }
});

test('with Firestore answering, the same older report is recorded as an arrival and the night keeps the later manifest', async () => {
  // The guard this blip used to bypass, working as designed.
  const night = twoArrivalNight();
  const fake = withBlip({ [PATH]: structuredClone(night) }, 0);
  try {
    const out = await archiveManifest({
      tenant: TENANT, buf: Buffer.from('not-a-real-pdf early'), diff: { manifest: { orders: 120 } },
      email: { id: 'e-early', receivedAt: T_EARLY }, fileName: 'early.pdf', at: AT, mailbox: 'gmail',
    });
    assert.equal(out.ok, true);
    assert.equal(out.superseded, true);
    const doc = fake.store.get(PATH);
    assert.equal(doc.latest.receivedAt, T_LATE, 'the night keeps the last manifest Uline sent');
    assert.equal(doc.arrivals.length, 3, 'the early one is recorded beside the two already there');
  } finally { fake.restore(); }
});

test('the first report of a night (no record yet) is still filed', async () => {
  // A 404 is "nothing filed tonight", not an outage — the strict read must still allow it.
  const fake = withBlip({}, 0);
  try {
    const out = await archiveManifest({
      tenant: TENANT, buf: Buffer.from('not-a-real-pdf first'), diff: { manifest: { orders: 120 } },
      email: { id: 'e-first', receivedAt: T_EARLY }, fileName: 'first.pdf', at: AT, mailbox: 'gmail',
    });
    assert.equal(out.ok, true);
    const doc = fake.store.get(PATH);
    assert.equal(doc.arrivals.length, 1);
    assert.equal(doc.latest.receivedAt, T_EARLY);
  } finally { fake.restore(); }
});
