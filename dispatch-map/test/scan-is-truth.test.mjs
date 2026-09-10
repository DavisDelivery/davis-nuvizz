// test/scan-is-truth.test.mjs — "WHATEVER THE SCAN SAYS IS THE TRUTH" (Chad, Sep 10 2026).
//
// Order 007174547, read live from the app's own zero-cost explain that morning:
//
//   board day document : UNPLANNED, route null
//   stamps             : board_write_at 10:18:15Z, board_write_planned FALSE
//   open-order pool    : planned = TRUE, route = "RONALD"      ← NuVizz's own word, same scan
//   roster             : RONALD → DAVIS000203388 (Draft)
//   write journal      : 10:18:15.710Z  boardSync TREVARR  ordered 8, unplanned 1
//
// A Save took it off TREVARR at 6:18am; somebody re-planned it onto RONALD in the portal. The
// 6:58 and 7:15 scans both read RONALD and both threw it away, because a confirmed un-plan
// outranked the list for sixty minutes with nothing allowed to argue. For that hour the order sat
// in the selection pool looking free while RONALD held it — the setup for putting the same
// freight on a second truck.
//
// THE BOARD IS NOT THE ONLY SURFACE. The Map serves the day document, the Routing date window
// serves cached rows reconciled against the pool, and the Map's carry-over fold serves prior-day
// rows judged by the same pool. All three held the same stale stamp by the same blind clock. These
// tests pin the shared rule across them, because a fix on one surface only moves the symptom.
import test from 'node:test';
import assert from 'node:assert/strict';

import { unplanStampOvertaken } from '../netlify/functions/lib/nuvizz-list.mts';
import { mergeWindowWithPool } from '../netlify/functions/lib/active-pool.mts';
import { boardWriteUnplannedFields } from '../netlify/functions/lib/firestore.mts';
import { LEAN_STOP_FIELDS } from '../netlify/functions/lib/board-fields.mts';

const DAY = '2026-09-10';
const SAVE_AT = '2026-09-10T10:18:15.288Z';
const SCAN_AT = '2026-09-10T11:15:17.868Z';   // the 7:15am scan — 57 minutes in, still inside the old grace
const NOW = Date.parse('2026-09-10T11:16:00.000Z');

/** The cached day row as the board actually held it: un-planned by the TREVARR Save. */
const cachedUnplanned = (from = 'TREVARR') => ({
  stopNbr: '007174547', businessName: 'VERISMA', city: 'ALPHARETTA', zip: '30009',
  boardDate: DAY, scheduledDate: DAY, lat: 34.07, lng: -84.29, weight: 181, cartons: 1,
  ...boardWriteUnplannedFields(SAVE_AT, from),
});
/** The pool row NuVizz produced at that same scan. */
const poolRow = (route = 'RONALD') => ({
  stopNbr: '007174547', day: DAY, boardDate: DAY, scheduledDate: DAY,
  isPlanned: true, isUnplanned: false, status: '20', normalizedStatus: 'SCHEDULED',
  routeName: route, loadNbr: route, routeSeq: 4,
});
const pool = (rows) => ({ at: SCAN_AT, windowStart: '2026-08-11', windowEnd: '2026-10-10', count: rows.length, rows, thin: false });
const opts = { from: '2026-09-03', to: DAY, nowMs: NOW, explain: true };

test('THE WINDOW: the pool naming RONALD beats a stamp that says we took it off TREVARR', () => {
  const { rows, stats } = mergeWindowWithPool([cachedUnplanned()], pool([poolRow()]), opts);
  assert.equal(stats.held, 0, 'the stale stamp no longer holds the window');
  assert.equal(stats.synced, 1);
  const r = rows.find((x) => x.stopNbr === '007174547');
  assert.equal(r.isPlanned, true, 'the window shows what NuVizz says');
  assert.equal(r.routeName, 'RONALD');
});

test('THE WINDOW, LAG CASE: the pool still naming TREVARR is held, exactly as before', () => {
  // Indistinguishable from an index that has not caught up with our un-plan. Taking it would put
  // the order back on the route the Save just removed it from.
  const { rows, stats } = mergeWindowWithPool([cachedUnplanned('TREVARR')], pool([poolRow('TREVARR')]), opts);
  assert.equal(stats.held, 1);
  const r = rows.find((x) => x.stopNbr === '007174547');
  assert.equal(r.isPlanned, false, 'the cached un-planned row is served untouched');
  assert.equal(r.routeName, null, 'it is NOT put back on the route the Save emptied');
});

test('THE WINDOW: a stamp with no from-route still holds — old rows keep the old behaviour', () => {
  const cached = { ...cachedUnplanned(), board_write_from: undefined };
  delete cached.board_write_from;
  const { stats } = mergeWindowWithPool([cached], pool([poolRow()]), opts);
  assert.equal(stats.held, 1);
});

test('THE WINDOW: a confirmed PLAN is still defended against a pool that disagrees', () => {
  // The other direction must not be weakened: this is the LVILLE / MONE hold.
  const plannedRow = {
    stopNbr: '007174547', boardDate: DAY, isPlanned: true, isUnplanned: false, routeName: 'TREVARR', loadNbr: 'TREVARR',
    board_write_at: SAVE_AT, board_write_planned: true,
  };
  const { stats } = mergeWindowWithPool([plannedRow], pool([{ ...poolRow(), isPlanned: false, isUnplanned: true, routeName: null, loadNbr: null }]), opts);
  assert.equal(stats.held, 1, 'a confirmed plan still outranks a disagreeing pool');
});

test('the from-route survives the window\'s LEAN read mask — otherwise the window is blind to it', () => {
  // The Routing window reads day documents through a field mask (v1.5.0). A rule that depends on
  // a field the mask drops is a rule that silently never fires on that surface.
  assert.ok(LEAN_STOP_FIELDS.includes('board_write_from'), 'board_write_from must be served');
  for (const f of ['board_write_at', 'board_write_planned']) assert.ok(LEAN_STOP_FIELDS.includes(f), f);
});

test('ONE definition, three surfaces: the scan, the window and the carry-over fold import the same rule', async () => {
  // Two copies of a discriminator is two chances for the board and the window to disagree about a
  // plan — which is the class of defect this whole fix is about.
  const fs = await import('node:fs');
  const win = fs.readFileSync('netlify/functions/lib/active-pool.mts', 'utf8');
  const fold = fs.readFileSync('netlify/functions/nuvizz-pull-today-stops.mts', 'utf8');
  for (const [name, src] of [['active-pool', win], ['carry-over fold', fold]]) {
    assert.match(src, /import \{[^}]*unplanStampOvertaken[^}]*\} from/, `${name} must IMPORT the rule, not restate it`);
    assert.match(src, /unplanStampOvertaken\(/, `${name} must actually apply it`);
  }
});
