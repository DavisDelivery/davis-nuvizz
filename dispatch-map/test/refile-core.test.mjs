// test/refile-core.test.mjs — finished stops from frozen days are filed where they ran, and the
// frozen copy is healed. Pinned to the 09/02 orders that exposed the gap.
import test from 'node:test';
import assert from 'node:assert/strict';

import { strayFinishedRows, openPastRows, planRefile, planChangeHeals, healFields, HEAL_FIELDS } from '../netlify/functions/lib/refile-core.mts';

const AT = '2026-09-02T15:30:00.000Z';
const TODAY = '2026-09-02';
const TARGETS = new Set(['2026-09-02', '2026-09-03', '2026-09-04']);
const delivered = (nbr, over = {}) => ({
  stopNbr: nbr, status: '90', normalizedStatus: 'DELIVERED', isPlanned: true, isUnplanned: false,
  loadNbr: 'BEN 1', routeName: 'BEN 1', routeSeq: 11, driverName: 'Ben  Paintsil', driverUserName: 'Ben  Paintsil', driverId: 'Ben  Paintsil',
  boardDate: '2026-09-01', scheduledDate: '2026-09-01', listUpdatedDTTM: '2026-09-02T11:11:00', deliveredDTTM: '2026-09-02T11:11:00',
  businessName: 'H&H WORLD GROUP', weight: 573, ...over,
});
const openRow = (nbr, over = {}) => ({ stopNbr: nbr, status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, loadNbr: null, routeName: null, routeSeq: null, driverName: null, driverUserName: null, driverId: null, boardDate: '2026-09-01', listUpdatedDTTM: '2026-09-01T14:12:00', ...over });

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

test('planRefile — 007170166-1: delivered on BEN 1 on 09/02, frozen 09/01 copy still "unplanned" → filed onto today pinned, and the copy healed', () => {
  const strays = strayFinishedRows(new Map([['2026-09-01', [delivered('007170166-1')]]]), { today: TODAY, targets: TARGETS });
  const plan = planRefile(strays, { today: TODAY, at: AT, onBoard: new Set(), ownCopies: new Map([['007170166-1', openRow('007170166-1')]]) });
  assert.equal(plan.file.length, 1);
  const f = plan.file[0];
  assert.equal(f.boardDate, TODAY, 'pinned to the board it ran on');
  assert.equal(f.scheduledDate, TODAY);
  assert.equal(f.refiledFrom, '2026-09-01');
  assert.equal(f.status, '90');
  assert.equal(plan.heal.length, 1);
  assert.equal(plan.heal[0].day, '2026-09-01');
  assert.equal(plan.heal[0].nbr, '007170166-1');
  const h = plan.heal[0].fields;
  assert.equal(h.status, '90');
  assert.equal(h.normalizedStatus, 'DELIVERED');
  assert.equal(h.isUnplanned, false);
  assert.equal(h.isPlanned, true);
  assert.equal(h.routeName, 'BEN 1');
  assert.equal(h.deliveredDTTM, '2026-09-02T11:11:00');
  assert.equal(h.closedOnBoard, TODAY);
  assert.equal(h.frozen_heal_reason, 'finished');
  assert.equal('boardDate' in h, false, 'a heal never moves the copy to another day');
  assert.equal('scheduledDate' in h, false);
  assert.equal('isTerminal' in h, false, 'isTerminal means "delivers to our own terminal" in this schema, not a status');
});

test('planRefile — RA52300615 already on today\'s board via the carry-forward → left to that path, not filed twice', () => {
  const strays = strayFinishedRows(new Map([['2026-09-01', [delivered('RA52300615')]]]), { today: TODAY, targets: TARGETS });
  const plan = planRefile(strays, { today: TODAY, at: AT, onBoard: new Set(['RA52300615']), ownCopies: new Map() });
  assert.equal(plan.file.length, 0);
  assert.equal(plan.skippedOnBoard, 1);
});

test('planRefile — a Friday delivery whose POD was uploaded Monday: the frozen copy is already DELIVERED → not today\'s work, nothing filed, nothing healed', () => {
  const row = delivered('FRI-1', { boardDate: '2026-09-04', listUpdatedDTTM: '2026-09-07T09:00:00', deliveredDTTM: '2026-09-04T14:00:00' });
  const strays = strayFinishedRows(new Map([['2026-09-04', [row]]]), { today: '2026-09-07', targets: new Set(['2026-09-07', '2026-09-08', '2026-09-09']) });
  const plan = planRefile(strays, { today: '2026-09-07', at: AT, onBoard: new Set(), ownCopies: new Map([['FRI-1', { ...row, boardDate: '2026-09-04' }]]) });
  assert.equal(plan.file.length, 0);
  assert.equal(plan.heal.length, 0);
  assert.equal(plan.skippedTerminal, 1);
});

test('planRefile — no frozen copy anywhere (created and delivered between two scans) → filed onto today, nothing to heal', () => {
  const strays = strayFinishedRows(new Map([['2026-09-01', [delivered('NEW-1')]]]), { today: TODAY, targets: TARGETS });
  const plan = planRefile(strays, { today: TODAY, at: AT, onBoard: new Set(), ownCopies: new Map([['NEW-1', null]]) });
  assert.equal(plan.file.length, 1);
  assert.equal(plan.heal.length, 0);
});

test('planRefile — a copy the caller could not read this scan is left alone (retried next scan), never guessed', () => {
  const strays = strayFinishedRows(new Map([['2026-09-01', [delivered('UNREAD-1')]]]), { today: TODAY, targets: TARGETS });
  const plan = planRefile(strays, { today: TODAY, at: AT, onBoard: new Set(), ownCopies: new Map() });
  assert.equal(plan.file.length, 0);
  assert.equal(plan.unread, 1);
});

test('planRefile — a frozen copy with a confirmed Save inside the write grace is filed but NOT patched over', () => {
  const strays = strayFinishedRows(new Map([['2026-09-01', [delivered('GRACE-1')]]]), { today: TODAY, targets: TARGETS });
  const now = Date.parse(AT);
  const copy = openRow('GRACE-1', { board_write_at: new Date(now - 10 * 60 * 1000).toISOString(), board_write_planned: true });
  const plan = planRefile(strays, { today: TODAY, at: AT, onBoard: new Set(), ownCopies: new Map([['GRACE-1', copy]]), nowMs: now });
  assert.equal(plan.file.length, 1);
  assert.equal(plan.heal.length, 0);
});

test('openPastRows: open rows on frozen days that NuVizz updated recently — the un-planned-on-Friday case', () => {
  const primary = openRow('PRIMARY131434870', { boardDate: '2026-09-02', listUpdatedDTTM: '2026-09-04T16:02:00' });
  const quiet = openRow('QUIET-1', { boardDate: '2026-09-02', listUpdatedDTTM: '2026-09-02T09:00:00' });
  const rows = openPastRows(new Map([['2026-09-02', [primary, quiet, delivered('DONE-1', { boardDate: '2026-09-02' })]]]),
    { today: '2026-09-04', targets: new Set(['2026-09-04', '2026-09-07', '2026-09-08']), sinceMs: Date.parse('2026-09-03T00:00:00') });
  assert.deepEqual(rows.map((r) => r.nbr), ['PRIMARY131434870']);
});

test('planChangeHeals — PRIMARY LOGISTICS: frozen 09/02 copy says planned on MARCUS 2, NuVizz says unplanned since Friday → plan fields healed, no delivery stamp, no day', () => {
  const live = { nbr: 'PRIMARY131434870', ownDay: '2026-09-02', row: openRow('PRIMARY131434870', { boardDate: '2026-09-02', listUpdatedDTTM: '2026-09-04T16:02:00' }) };
  const copy = { stopNbr: 'PRIMARY131434870', status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'MARCUS 2', routeName: 'MARCUS 2', driverName: 'Marcus Young', boardDate: '2026-09-02' };
  const heals = planChangeHeals([live], new Map([['PRIMARY131434870', copy]]), { at: AT });
  assert.equal(heals.length, 1);
  const f = heals[0].fields;
  assert.equal(f.status, '10');
  assert.equal(f.isUnplanned, true);
  assert.equal(f.isPlanned, false);
  assert.equal(f.routeName, null);
  assert.equal(f.driverName, null);
  assert.equal(f.frozen_heal_reason, 'plan');
  assert.equal('deliveredDTTM' in f, false);
  assert.equal('boardDate' in f, false);
});

test('planChangeHeals — agreeing, terminal, or fresh-Save copies are left alone', () => {
  const live = { nbr: 'A', ownDay: '2026-09-02', row: openRow('A', { boardDate: '2026-09-02', listUpdatedDTTM: '2026-09-04T16:02:00' }) };
  const agreeing = { stopNbr: 'A', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, routeName: null };
  const terminal = { stopNbr: 'A', status: '90', normalizedStatus: 'DELIVERED', isPlanned: true, routeName: 'X' };
  const fresh = { stopNbr: 'A', status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, routeName: 'CHAD', board_write_at: AT };
  assert.equal(planChangeHeals([live], new Map([['A', agreeing]]), { at: AT }).length, 0);
  assert.equal(planChangeHeals([live], new Map([['A', terminal]]), { at: AT }).length, 0);
  assert.equal(planChangeHeals([live], new Map([['A', fresh]]), { at: AT, nowMs: Date.parse(AT) + 60_000 }).length, 0);
  assert.equal(planChangeHeals([live], new Map(), { at: AT }).length, 0, 'unread → untouched');
});

test('healFields: only the live status/plan fields ever ride a heal; blanks become null', () => {
  const f = healFields(delivered('Z', { driverName: '' }), { today: TODAY, at: AT, reason: 'finished' });
  for (const k of Object.keys(f)) assert.ok([...HEAL_FIELDS, 'frozen_heal_at', 'frozen_heal_reason', 'closedOnBoard'].includes(k), k);
  assert.equal(f.driverName, null);
});
