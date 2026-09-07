// test/refile-core.test.mjs — what the scan does about stops that live on FROZEN days (v0.95.0).
// Pinned to the 09/02–09/07 orders that exposed each rule; see the module header.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  strayFinishedRows, openPastRows, planRefile, planOpenStrays, frozenCopyDays, rotate,
  healFields, HEAL_FIELDS, copyIsTerminal,
} from '../netlify/functions/lib/refile-core.mts';

const AT = '2026-09-02T15:30:00.000Z';
const NOW = Date.parse(AT);
const TODAY = '2026-09-02';
const TARGETS = new Set(['2026-09-02', '2026-09-03', '2026-09-04']);
const delivered = (nbr, over = {}) => ({
  stopNbr: nbr, status: '90', normalizedStatus: 'DELIVERED', isPlanned: true, isUnplanned: false,
  loadNbr: 'BEN 1', routeName: 'BEN 1', routeSeq: 11, driverName: 'Ben  Paintsil', driverUserName: 'Ben  Paintsil', driverId: 'Ben  Paintsil',
  boardDate: '2026-09-01', scheduledDate: '2026-09-01', listUpdatedDTTM: '2026-09-02T11:11:00', deliveredDTTM: '2026-09-02T11:11:00',
  businessName: 'H&H WORLD GROUP', weight: 573, ...over,
});
const openRow = (nbr, over = {}) => ({ stopNbr: nbr, status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, loadNbr: null, routeName: null, routeSeq: null, driverName: null, driverUserName: null, driverId: null, boardDate: '2026-09-01', listUpdatedDTTM: '2026-09-01T14:12:00', ...over });
const plannedRow = (nbr, load, over = {}) => openRow(nbr, { status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: load, routeName: load, ...over });
const stray = (nbr, ownDay, row) => ({ nbr, ownDay, row });
const copies = (nbr, ...days) => new Map([[nbr, days.map(([day, copy]) => ({ day, copy }))]]);
const NONE = new Set();

test('strayFinishedRows: only FINISHED rows on days before today that this scan does not write, inside the reach', () => {
  const buckets = new Map([
    ['2026-09-01', [delivered('007170166-1'), openRow('AVRT-0417929168')]],                 // frozen day: the delivered one is a stray, the open one is not
    ['2026-09-02', [delivered('RA52300615', { boardDate: '2026-09-02' })]],                  // today: the normal path
    ['2026-09-03', [delivered('X-TOMORROW')]],                                              // a target
    ['2026-08-20', [delivered('OLD-1', { boardDate: '2026-08-20' })]],                      // beyond the reach
  ]);
  const strays = strayFinishedRows(buckets, { today: TODAY, targets: TARGETS, floor: '2026-08-26' });
  assert.deepEqual(strays.map((s) => [s.nbr, s.ownDay]), [['007170166-1', '2026-09-01']]);
});

test('openPastRows: OPEN rows on frozen days; with sinceNaive only those NuVizz touched at or after it (ET-naive string against string)', () => {
  const buckets = new Map([
    ['2026-09-01', [openRow('OLD-TOUCH', { listUpdatedDTTM: '2026-08-29T09:00:00' }), openRow('FRI-UNPLAN', { listUpdatedDTTM: '2026-09-01T16:40:00' }), delivered('DONE-1')]],
    ['2026-09-02', [openRow('TODAY-1', { boardDate: '2026-09-02' })]],
  ]);
  const all = openPastRows(buckets, { today: TODAY, targets: TARGETS });
  assert.deepEqual(all.map((s) => s.nbr).sort(), ['FRI-UNPLAN', 'OLD-TOUCH']);
  const recent = openPastRows(buckets, { today: TODAY, targets: TARGETS, sinceNaive: '2026-08-30T15:30' });
  assert.deepEqual(recent.map((s) => s.nbr), ['FRI-UNPLAN']);
});

test('frozenCopyDays: own day through yesterday, NEWEST first, no older than the reach; nothing for today or the future', () => {
  assert.deepEqual(frozenCopyDays('2026-09-01', '2026-09-04', 7), ['2026-09-03', '2026-09-02', '2026-09-01']);
  assert.deepEqual(frozenCopyDays('2026-08-20', '2026-09-04', 7), ['2026-09-03', '2026-09-02', '2026-09-01', '2026-08-31', '2026-08-30', '2026-08-29', '2026-08-28']);
  assert.deepEqual(frozenCopyDays('2026-09-04', '2026-09-04', 7), []);
  assert.deepEqual(frozenCopyDays('2026-09-09', '2026-09-04', 7), []);
});

test('planRefile — 007170166-1: delivered on BEN 1 on 09/02, frozen 09/01 copy still "unplanned" → filed onto today pinned, and the copy healed', () => {
  const s = stray('007170166-1', '2026-09-01', delivered('007170166-1'));
  const plan = planRefile([s], { today: TODAY, at: AT, onBoard: NONE, copies: copies('007170166-1', ['2026-09-01', openRow('007170166-1')]), nowMs: NOW });
  assert.equal(plan.file.length, 1);
  assert.equal(plan.file[0].boardDate, TODAY);
  assert.equal(plan.file[0].scheduledDate, TODAY);
  assert.equal(plan.file[0].refiledFrom, '2026-09-01');
  assert.equal(plan.file[0].status, '90');
  assert.equal(plan.heal.length, 1);
  assert.equal(plan.heal[0].day, '2026-09-01');
  assert.equal(plan.heal[0].fields.status, '90');
  assert.equal(plan.heal[0].fields.normalizedStatus, 'DELIVERED');
  assert.equal(plan.heal[0].fields.isPlanned, true);
  assert.equal(plan.heal[0].fields.isUnplanned, false);
  assert.equal(plan.heal[0].fields.routeName, 'BEN 1');
  assert.equal(plan.heal[0].fields.deliveredDTTM, '2026-09-02T11:11:00');
  assert.equal(plan.heal[0].fields.closedOnBoard, TODAY, 'the copy says which board holds the delivery');
  assert.equal(plan.heal[0].fields.frozen_heal_reason, 'finished');
  assert.equal('boardDate' in plan.heal[0].fields, false, 'a heal never moves a row');
  assert.deepEqual(plan.healedStops, ['007170166-1']);
});

test('planRefile — a routed stop clamped forward each day it stayed open: EVERY open copy is healed, not just the arrival day\'s (the 125-ghost bug)', () => {
  const today = '2026-09-04';
  const s = stray('CLAMP-1', '2026-09-01', delivered('CLAMP-1', { listUpdatedDTTM: '2026-09-04T09:00:00', deliveredDTTM: '2026-09-04T09:00:00' }));
  const c = copies('CLAMP-1',
    ['2026-09-03', plannedRow('CLAMP-1', 'BEN 1', { boardDate: '2026-09-03' })],   // the clamped copy on the day before it delivered
    ['2026-09-02', plannedRow('CLAMP-1', 'BEN 1', { boardDate: '2026-09-02' })],
    ['2026-09-01', openRow('CLAMP-1')]);
  const plan = planRefile([s], { today, at: AT, onBoard: NONE, copies: c, nowMs: NOW });
  assert.deepEqual(plan.heal.map((h) => h.day), ['2026-09-03', '2026-09-02', '2026-09-01']);
  assert.equal(plan.file.length, 1);
});

test('planRefile — RA52300615 already on today\'s board via the carry-forward → not filed twice, but its frozen open copy is STILL healed (#838 skipped exactly these)', () => {
  const s = stray('RA52300615', '2026-09-01', delivered('RA52300615'));
  const plan = planRefile([s], { today: TODAY, at: AT, onBoard: new Set(['RA52300615']), copies: copies('RA52300615', ['2026-09-01', plannedRow('RA52300615', 'BEN 1')]), nowMs: NOW });
  assert.equal(plan.file.length, 0);
  assert.equal(plan.skippedOnBoard, 1);
  assert.equal(plan.heal.length, 1, 'the ghost on the planning day is closed');
});

test('planRefile — a Friday delivery whose POD was uploaded Monday: its own copy is already DELIVERED → not today\'s work; a later open copy is still healed', () => {
  const s = stray('FRI-1', '2026-09-01', delivered('FRI-1', { listUpdatedDTTM: '2026-09-02T09:30:00' }));
  const done = { ...delivered('FRI-1'), listUpdatedDTTM: '2026-09-01T14:00:00' };
  const plan = planRefile([s], { today: TODAY, at: AT, onBoard: NONE, copies: copies('FRI-1', ['2026-09-01', done]), nowMs: NOW });
  assert.equal(plan.file.length, 0);
  assert.equal(plan.skippedTerminal, 1);
  assert.equal(plan.heal.length, 0);
  // Same order, but a clamped OPEN twin sits on the next day: healed, still not filed.
  const today = '2026-09-03';
  const plan2 = planRefile([s], { today, at: AT, onBoard: NONE, copies: copies('FRI-1', ['2026-09-02', plannedRow('FRI-1', 'CHAD', { boardDate: '2026-09-02' })], ['2026-09-01', done]), nowMs: NOW });
  assert.equal(plan2.file.length, 0);
  assert.equal(plan2.skippedTerminal, 1);
  assert.deepEqual(plan2.heal.map((h) => h.day), ['2026-09-02']);
});

test('planRefile — no frozen copy anywhere (created and delivered between two scans) → filed onto today, nothing to heal', () => {
  const s = stray('NEW-1', '2026-09-01', delivered('NEW-1'));
  const plan = planRefile([s], { today: TODAY, at: AT, onBoard: NONE, copies: copies('NEW-1', ['2026-09-01', null]), nowMs: NOW });
  assert.equal(plan.file.length, 1);
  assert.equal(plan.heal.length, 0);
});

test('planRefile — a stop whose copies the caller could not read this scan is left alone (retried next scan), never guessed', () => {
  const s = stray('UNREAD-1', '2026-09-01', delivered('UNREAD-1'));
  const plan = planRefile([s], { today: TODAY, at: AT, onBoard: NONE, copies: new Map(), nowMs: NOW });
  assert.equal(plan.file.length, 0);
  assert.equal(plan.heal.length, 0);
  assert.equal(plan.unread, 1);
});

test('planRefile — a frozen copy with a confirmed Save inside the write grace is filed but NOT patched over', () => {
  const s = stray('SAVE-1', '2026-09-01', delivered('SAVE-1'));
  const fresh = openRow('SAVE-1', { board_write_at: new Date(NOW - 10 * 60 * 1000).toISOString() });
  const plan = planRefile([s], { today: TODAY, at: AT, onBoard: NONE, copies: copies('SAVE-1', ['2026-09-01', fresh]), nowMs: NOW });
  assert.equal(plan.file.length, 1);
  assert.equal(plan.heal.length, 0);
});

test('planOpenStrays — PRIMARY LOGISTICS: frozen 09/02 copy says planned on MARCUS 2, NuVizz says unplanned since Friday → plan fields healed, no delivery stamp, no day, NOT filed (it has an open copy)', () => {
  const live = openRow('PRIMARY131434870', { boardDate: '2026-09-02', listUpdatedDTTM: '2026-09-04T15:02:00' });
  const frozen = plannedRow('PRIMARY131434870', 'MARCUS 2', { boardDate: '2026-09-02', driverName: 'Marcus Young' });
  const plan = planOpenStrays([stray('PRIMARY131434870', '2026-09-02', live)], { today: '2026-09-07', at: AT, onBoard: NONE, copies: copies('PRIMARY131434870', ['2026-09-02', frozen]), nowMs: NOW });
  assert.equal(plan.heal.length, 1);
  const f = plan.heal[0].fields;
  assert.equal(f.isPlanned, false);
  assert.equal(f.isUnplanned, true);
  assert.equal(f.routeName, null);
  assert.equal(f.loadNbr, null);
  assert.equal(f.status, '10');
  assert.equal(f.frozen_heal_reason, 'plan');
  assert.equal('deliveredDTTM' in f, false);
  assert.equal('closedOnBoard' in f, false);
  assert.equal('boardDate' in f, false);
  assert.equal(plan.file.length, 0, 'the carry-over fold and the pool already serve it');
});

test('planOpenStrays — HIGHLAND FORGE 007171197: frozen copy REFUSED (80) on TAYLOR, NuVizz lists the same number OPEN as an ATT re-attempt → copy re-opened, and the attempt filed onto today as a carry-over', () => {
  const live = openRow('007171197', { shipmentNbr: 'ATT007171197', isAttempt: true, listUpdatedDTTM: '2026-09-03T10:06:00' });
  const refused = { ...plannedRow('007171197', 'TAYLOR'), status: '80', normalizedStatus: 'EXCEPTION', shipmentNbr: '007171197' };
  const plan = planOpenStrays([stray('007171197', '2026-09-01', live)], { today: '2026-09-03', at: AT, onBoard: NONE, copies: copies('007171197', ['2026-09-02', null], ['2026-09-01', refused]), nowMs: NOW });
  assert.equal(plan.reopened, 1);
  assert.equal(plan.heal.length, 1);
  assert.equal(plan.heal[0].fields.frozen_heal_reason, 'reopen');
  assert.equal(plan.heal[0].fields.status, '10');
  assert.equal(plan.heal[0].fields.shipmentNbr, 'ATT007171197');
  assert.equal(plan.heal[0].fields.isAttempt, true);
  assert.equal('deliveredDTTM' in plan.heal[0].fields, false);
  assert.equal(plan.file.length, 1);
  assert.equal(plan.file[0].refiledOpen, true);
  assert.equal(plan.file[0].carryover, true);
  assert.equal(plan.file[0].boardDate, '2026-09-03');
});

test('planOpenStrays — EXPEDITORS 007171664-1: created after its day froze, no copy anywhere → filed onto today so the Map can show it; an agreeing open copy → nothing at all', () => {
  const live = openRow('007171664-1', { listUpdatedDTTM: '2026-09-03T12:01:00' });
  const none = planOpenStrays([stray('007171664-1', '2026-09-01', live)], { today: '2026-09-03', at: AT, onBoard: NONE, copies: copies('007171664-1', ['2026-09-02', null], ['2026-09-01', null]), nowMs: NOW });
  assert.equal(none.file.length, 1);
  assert.equal(none.heal.length, 0);
  const agree = planOpenStrays([stray('007171664-1', '2026-09-01', live)], { today: '2026-09-03', at: AT, onBoard: NONE, copies: copies('007171664-1', ['2026-09-01', openRow('007171664-1')]), nowMs: NOW });
  assert.equal(agree.file.length, 0);
  assert.equal(agree.heal.length, 0);
  // Already on today's board (the carry-forward re-files it from the live pull) → not filed again.
  const onBoard = planOpenStrays([stray('007171664-1', '2026-09-01', live)], { today: '2026-09-03', at: AT, onBoard: new Set(['007171664-1']), copies: copies('007171664-1', ['2026-09-01', null]), nowMs: NOW });
  assert.equal(onBoard.file.length, 0);
});

test('planOpenStrays — a copy inside a confirmed Save\'s write grace is never patched; an unread stop is left for the next scan', () => {
  const live = openRow('G-1', { listUpdatedDTTM: '2026-09-02T09:00:00' });
  const fresh = plannedRow('G-1', 'CHAD', { board_write_at: new Date(NOW - 5 * 60 * 1000).toISOString() });
  const plan = planOpenStrays([stray('G-1', '2026-09-01', live)], { today: TODAY, at: AT, onBoard: NONE, copies: copies('G-1', ['2026-09-01', fresh]), nowMs: NOW });
  assert.equal(plan.heal.length, 0);
  const unread = planOpenStrays([stray('G-1', '2026-09-01', live)], { today: TODAY, at: AT, onBoard: NONE, copies: new Map(), nowMs: NOW });
  assert.equal(unread.unread, 1);
  assert.equal(unread.file.length, 0);
});

test('healFields: only the live status/plan fields ever ride a heal; blanks become null; the reason is recorded', () => {
  const f = healFields(delivered('X', { routeName: '' }), { today: TODAY, at: AT, reason: 'finished' });
  for (const k of Object.keys(f)) assert.ok([...HEAL_FIELDS, 'frozen_heal_at', 'frozen_heal_reason', 'closedOnBoard'].includes(k), `${k} is not a heal field`);
  assert.equal(f.routeName, null);
  assert.equal(f.frozen_heal_at, AT);
  for (const k of ['boardDate', 'scheduledDate', 'lat', 'lng', 'businessName', 'isTerminal', 'enriched']) assert.equal(k in f, false, `${k} never rides a heal`);
});

test('copyIsTerminal reads the status code as well as the normalized status; rotate walks a capped list\'s tail across scans', () => {
  assert.equal(copyIsTerminal({ status: '99' }), true);
  assert.equal(copyIsTerminal({ normalizedStatus: 'EXCEPTION' }), true);
  assert.equal(copyIsTerminal({ status: '10', normalizedStatus: 'UNPLANNED' }), false);
  assert.deepEqual(rotate(['a', 'b', 'c', 'd'], 1), ['b', 'c', 'd', 'a']);
  assert.deepEqual(rotate(['a', 'b', 'c', 'd'], 6), ['c', 'd', 'a', 'b']);
  assert.deepEqual(rotate(['a'], 3), ['a']);
});
