// test/window-check-rollover-day.test.mjs — A STOP ROLLED OVER ON A LIVE ROUTE IS NOT A "DAY CHANGE".
//
// NuVizz keeps a rolled-over stop's Estimated Arrival on the day it first arrived (Mitchell's
// 007137332), even though the driver runs it today. The board files such open, route-assigned
// work on TODAY (boardDayFor's live-route clamp), and the Routing window's pool overlay serves
// that day. Check vs NuVizz then compared the board's day (today) with NuVizz's raw arrival day
// and listed every multi-day routed stop as "changed" — plan, route and status all agreeing.
// A reconciliation that cries wolf on the routed freight is one nobody trusts; and pressing
// "Use NuVizz's list" re-filed those rows back onto their stale arrival day.
//
// Built end to end from the real pieces: the scan's bucketByDate → buildActivePool → the
// window's mergeWindowWithPool → diffWindow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketByDate } from '../netlify/functions/lib/nuvizz-list.mts';
import { buildActivePool, mergeWindowWithPool } from '../netlify/functions/lib/active-pool.mts';
import { diffWindow } from '../netlify/functions/lib/window-check.mts';

const TODAY = '2026-09-25';
const rowDayOf = (s) => s.boardDate || s.scheduledDate || s.requestedDate || '';   // the grid's rowDayOf
const asShown = (s) => ({ stopNbr: s.stopNbr, status: s.status, day: rowDayOf(s) || null, routeName: s.routeName || s.loadNbr || null, weight: s.weight });

function windowAndLive(listRows, from, to) {
  const pool = buildActivePool(bucketByDate(listRows, TODAY), { at: '2026-09-25T14:00:00Z', windowStart: '2026-08-26', windowEnd: '2026-10-25' });
  const cached = listRows.map((r) => ({ ...r, lat: 33.9, lng: -84.1 }));
  const { rows } = mergeWindowWithPool(cached, pool, { from, to, nowMs: Date.parse('2026-09-25T14:05:00Z') });
  // NuVizz's own list rows for the same stops: board-shaped, `day` = the raw arrival (rowDay).
  const all = listRows.map((r) => ({ ...r, day: r.boardDate }));
  const live = all.filter((r) => r.day >= from && r.day <= to);
  return { shown: rows.map(asShown), live, all };
}

test('a stop that arrived 09/23 and is still planned on BEN 1 on 09/25 matches NuVizz — no day change reported', () => {
  const routed = { stopNbr: '007170001', status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'BEN 1', routeName: 'BEN 1', boardDate: '2026-09-23', scheduledDate: '2026-09-23', weight: 500 };
  const { shown, live, all } = windowAndLive([routed], '2026-09-18', TODAY);
  assert.equal(shown[0].day, TODAY, 'precondition: the window serves the board day (the live-route clamp)');
  const d = diffWindow(shown, live, { all, today: TODAY });
  assert.deepEqual(d.changed, [], `no false day change: ${JSON.stringify(d.changed)}`);
  assert.equal(d.matches, true);
});

test('a routed stop that arrived before the window opened is not reported as moved out of it', () => {
  const routed = { stopNbr: '007160002', status: '40', normalizedStatus: 'OUT_FOR_DEL', isPlanned: true, isUnplanned: false, loadNbr: 'MARCUS 2', routeName: 'MARCUS 2', boardDate: '2026-09-15', scheduledDate: '2026-09-15', weight: 800 };
  const { shown, live, all } = windowAndLive([routed], '2026-09-18', TODAY);
  const d = diffWindow(shown, live, { all, today: TODAY });
  assert.deepEqual(d.changed, [], `no false "moved out": ${JSON.stringify(d.changed)}`);
  assert.equal(d.matches, true);
  assert.equal(d.nuvizz.count, d.shown.count, 'both sides count the stop, so the header numbers agree with the verdict');
  assert.equal(d.nuvizz.weight, 800);
});

test('a real day change is still reported: an unplanned order NuVizz re-dated', () => {
  const shown = [{ stopNbr: 'U1', status: '10', day: '2026-09-24', routeName: null }];
  const live = [{ stopNbr: 'U1', status: '10', normalizedStatus: 'UNPLANNED', loadNbr: null, routeName: null, boardDate: '2026-09-25', day: '2026-09-25' }];
  const d = diffWindow(shown, live, { all: live, today: TODAY });
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].ours.day, '2026-09-24');
  assert.equal(d.changed[0].nuvizz.day, '2026-09-25');
});

test('a routed stop we show on a day that is neither its arrival nor today is still a day change', () => {
  const shown = [{ stopNbr: 'R1', status: '20', day: '2026-09-24', routeName: 'BEN 1' }];
  const live = [{ stopNbr: 'R1', status: '20', normalizedStatus: 'SCHEDULED', loadNbr: 'BEN 1', routeName: 'BEN 1', boardDate: '2026-09-23', day: '2026-09-23' }];
  const d = diffWindow(shown, live, { all: live, today: TODAY });
  assert.equal(d.changed.length, 1, 'only the board\'s own clamp (arrival → today) is exempt');
});

test('a routed stop NuVizz now files on a day outside the window, on a different route, is still reported as moved', () => {
  const shown = [{ stopNbr: 'M1', status: '20', day: TODAY, routeName: 'BEN 1' }];
  const all = [{ stopNbr: 'M1', status: '20', normalizedStatus: 'SCHEDULED', loadNbr: 'CHE', routeName: 'CHE', boardDate: '2026-09-15', day: '2026-09-15' }];
  const d = diffWindow(shown, [], { all, today: TODAY });
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].movedOut, true);
});
