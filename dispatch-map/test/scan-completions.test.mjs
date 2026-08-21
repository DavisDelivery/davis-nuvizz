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
