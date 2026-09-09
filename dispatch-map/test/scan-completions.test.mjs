// test/scan-completions.test.mjs
//
// THE COMPLETED-ONLY PULL. Decoupling the saved searches means some fires want 77131 without
// 77128 — all through the delivery day, when every delivery stamp re-anchors a route clock.
//
// The reason this is its own tiny module rather than a flag on the normal scan: the rebuild
// path reads ABSENCE as meaning, and a completed-only pull is missing every planned stop by
// definition. These tests pin the property that makes it safe to run unattended every 15
// minutes — it can mark a stop finished and it can do nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completionPatch, planCompletions, COMPLETION_FIELDS,
} from '../netlify/functions/lib/scan-completions.mts';

const stop = (over = {}) => ({
  stopNbr: '007164934', businessName: 'RAICOM LLC', addr1: '5240 SNAPFINGER PARK DR',
  loadNbr: 'KOSTNER', routeName: 'KOSTNER', routeSeq: 10, driverName: 'Anthony Kostner',
  isPlanned: true, isUnplanned: false, status: '20', normalizedStatus: 'SCHEDULED',
  deliveredDTTM: null, listUpdatedDTTM: '2026-08-20T09:00:00', lat: 33.7, lng: -84.2, ...over,
});
const done = (over = {}) => ({
  stopNbr: '007164934', status: '90', normalizedStatus: 'DELIVERED',
  deliveredDTTM: '2026-08-20T12:33:00', listUpdatedDTTM: '2026-08-20T12:33:00', ...over,
});

// ── the safety property ──────────────────────────────────────────────────────

test('THE GUARANTEE: an overlay can mark a stop finished and nothing else', () => {
  const fields = completionPatch(stop(), done());
  assert.deepEqual(Object.keys(fields).sort(), ['deliveredDTTM', 'listUpdatedDTTM', 'normalizedStatus', 'status']);
  for (const k of Object.keys(fields)) {
    assert.ok(COMPLETION_FIELDS.includes(k), `${k} is on the allow-list`);
  }
  // The things that would hurt if this ever wrote them.
  for (const k of ['loadNbr', 'routeName', 'routeSeq', 'driverName', 'isPlanned', 'isUnplanned', 'lat', 'lng']) {
    assert.equal(k in fields, false, `${k} must never be in a completions patch`);
  }
});

test('A COMPLETED-ONLY PULL CANNOT UNPLAN ANYTHING — absence is not a signal here', () => {
  // The whole board, and a pull that mentions ONE of them. The other 3 are simply not
  // mentioned; in the rebuild path that would make them absent-plan demote candidates.
  const board = new Map([
    ['1', stop({ stopNbr: '1' })], ['2', stop({ stopNbr: '2' })],
    ['3', stop({ stopNbr: '3' })], ['4', stop({ stopNbr: '4' })],
  ]);
  const out = planCompletions(board, [done({ stopNbr: '2' })]);
  assert.equal(out.patches.length, 1, 'exactly one stop is touched');
  assert.equal(out.patches[0].stopNbr, '2');
  assert.equal(out.unknown.length, 0);
  // Nothing anywhere in the result refers to 1, 3 or 4.
  const touched = new Set(out.patches.map((p) => p.stopNbr));
  for (const n of ['1', '3', '4']) assert.equal(touched.has(n), false, `${n} untouched`);
});

test('a stop we have never seen is REPORTED, never invented', () => {
  const out = planCompletions(new Map([['1', stop({ stopNbr: '1' })]]), [done({ stopNbr: 'STRANGER' })]);
  assert.equal(out.patches.length, 0, 'nothing is written for it');
  assert.deepEqual(out.unknown, ['STRANGER'], 'but it is counted, so drift cannot stay invisible');
});

// ── the write-once delivery stamp ────────────────────────────────────────────

test('THE DELIVERY TIME IS WRITE-ONCE: 4pm paperwork cannot rewrite a 12:33 delivery', () => {
  // NuVizz's "Stop Updated Dttm" keeps moving after delivery — a POD upload, a note, a status
  // correction. If the overlay overwrote it, every ETA anchored on this stop would move too.
  const already = stop({ status: '90', normalizedStatus: 'DELIVERED', deliveredDTTM: '2026-08-20T12:33:00' });
  const later = done({ deliveredDTTM: '2026-08-20T16:05:00', listUpdatedDTTM: '2026-08-20T16:05:00' });
  const fields = completionPatch(already, later);
  assert.ok(fields, 'the touched-time still refreshes');
  assert.equal('deliveredDTTM' in fields, false, 'but the DELIVERY time is frozen');
  assert.equal(fields.listUpdatedDTTM, '2026-08-20T16:05:00');
});

test('an unchanged stop costs no write — that is what keeps 15 minutes cheap', () => {
  const settled = stop({ status: '90', normalizedStatus: 'DELIVERED', deliveredDTTM: '2026-08-20T12:33:00', listUpdatedDTTM: '2026-08-20T12:33:00' });
  assert.equal(completionPatch(settled, done()), null);

  const board = new Map(Array.from({ length: 800 }, (_, i) => [String(i), settled]));
  const rows = Array.from({ length: 40 }, (_, i) => done({ stopNbr: String(i) }));
  const out = planCompletions(board, rows);
  assert.equal(out.patches.length, 0, 'a re-pull of the same completions writes nothing');
  assert.equal(out.unchanged, 40);
});

test('the first sighting of a delivery is what lands', () => {
  const fields = completionPatch(stop(), done());
  assert.equal(fields.deliveredDTTM, '2026-08-20T12:33:00');
  assert.equal(fields.normalizedStatus, 'DELIVERED');
  assert.equal(fields.status, '90');
});

test('an exception is a completion too — it finishes the stop without a delivery time', () => {
  const fields = completionPatch(stop(), { stopNbr: '007164934', status: '80', normalizedStatus: 'EXCEPTION', deliveredDTTM: null, listUpdatedDTTM: '2026-08-20T14:00:00' });
  assert.equal(fields.normalizedStatus, 'EXCEPTION');
  assert.equal('deliveredDTTM' in fields, false, 'a refusal is not a delivery');
});

// ── the boring edges ─────────────────────────────────────────────────────────

test('junk in, nothing out', () => {
  assert.equal(completionPatch(null, done()), null);
  assert.equal(completionPatch(stop(), null), null);
  const out = planCompletions(new Map(), [null, undefined, {}, { stopNbr: '' }]);
  assert.equal(out.patches.length, 0);
  assert.equal(out.unknown.length, 0, 'a row with no stop number is not an unknown stop');
});

test('stop numbers are compared as strings, so a numeric row still matches', () => {
  const board = new Map([['007164934', stop()]]);
  const out = planCompletions(board, [done({ stopNbr: 7164934 })]);
  assert.equal(out.patches.length, 0, 'a differently-formatted number does NOT silently match');
  assert.deepEqual(out.unknown, ['7164934'], 'it is surfaced as unknown instead');
});


// ── v0.95.0: the overlay pins the day, clears the unplanned flag, and refuses a twin ─────────

test('a finish landing on a ROLLED-OVER copy is pinned to today, so the board read and the next full scan keep the delivery', () => {
  // The clamp filed this open stop onto today's board with its boardDate still at the old
  // arrival day; the read's own-day filter stripped the delivery the moment the overlay wrote
  // it, and the full scan's day guard pruned the row. Now it lands where it is recorded.
  const rolled = stop({ boardDate: '2026-08-19', scheduledDate: '2026-08-19' });
  const fields = completionPatch(rolled, done(), { today: '2026-08-20' });
  assert.equal(fields.boardDate, '2026-08-20');
  assert.equal(fields.scheduledDate, '2026-08-20');
  // A stop already on its own day is not moved.
  const own = completionPatch(stop({ boardDate: '2026-08-20', scheduledDate: '2026-08-20' }), done(), { today: '2026-08-20' });
  assert.equal('boardDate' in own, false);
  // No today → no pin (the legacy caller).
  assert.equal('boardDate' in completionPatch(rolled, done()), false);
});

test('a cancelled UNPLANNED order leaves the unplanned count at once — isUnplanned is cleared on any finish', () => {
  const unplanned = stop({ isPlanned: false, isUnplanned: true, status: '10', normalizedStatus: 'UNPLANNED', loadNbr: null, routeName: null });
  const fields = completionPatch(unplanned, done({ status: '99', normalizedStatus: 'CANCELLED', deliveredDTTM: null }));
  assert.equal(fields.isUnplanned, false);
  assert.equal(fields.status, '99');
  assert.equal('isPlanned' in fields, false, 'still never a plan field');
  assert.equal('deliveredDTTM' in fields, false);
});

test('TWO RECORDS, ONE NUMBER: a finished twin re-touched today must not mark the live order delivered — skipped and reported', () => {
  const board = new Map([['500', stop({ stopNbr: '500', stopId: 'live-id' })]]);
  const out = planCompletions(board, [done({ stopNbr: '500', stopId: 'old-twin-id' })], { today: '2026-08-20' });
  assert.equal(out.patches.length, 0);
  assert.deepEqual(out.twins, ['500']);
  // Same id (or no id on either side) → the normal patch.
  const same = planCompletions(board, [done({ stopNbr: '500', stopId: 'live-id' })], { today: '2026-08-20' });
  assert.equal(same.patches.length, 1);
  assert.equal(same.twins.length, 0);
});
