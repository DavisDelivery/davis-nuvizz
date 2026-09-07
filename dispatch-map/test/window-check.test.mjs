// test/window-check.test.mjs — the "Check vs NuVizz" diff, pinned to the 09/07 numbers.
import test from 'node:test';
import assert from 'node:assert/strict';

import { checkCodes, diffWindow, totalsOf, ACTIVE_CODES } from '../netlify/functions/lib/window-check.mts';

test('checkCodes: clamps to open work — delivered/cancelled never ride the check; none → all four', () => {
  assert.deepEqual(checkCodes(['10', '90', '99']), ['10']);
  assert.deepEqual(checkCodes(['10', '10', '20']), ['10', '20']);
  assert.deepEqual(checkCodes([]), ACTIVE_CODES);
  assert.deepEqual(checkCodes(['90']), ACTIVE_CODES, 'a check on delivered only is a check on open work');
  assert.deepEqual(checkCodes(undefined), ACTIVE_CODES);
});

test('totalsOf: the four header numbers — count, weight, skids (cartons), loose (volume) — plus the planned split', () => {
  const t = totalsOf([
    { status: '10', weight: '573', cartons: 1, volume: 0 },
    { status: '20', routeName: 'CHAD', weight: 1700, cartons: 2, volume: 1 },
    { status: '10', weight: null, cartons: null, volume: undefined },
  ]);
  assert.deepEqual(t, { count: 3, unplanned: 2, planned: 1, weight: 2273, skids: 3, loose: 1 });
});

test('the 09/07 check: 30 stale, 2 missing, 3 changed; totals reproduce 550/306,121 vs 525/290,087', () => {
  const shown = [], live = [];
  // 520 shared unplanned rows, 500 lb / 1 skid each.
  for (let i = 0; i < 520; i++) {
    shown.push({ stopNbr: `S${i}`, status: '10', day: '2026-09-07', weight: 500, cartons: 1, volume: 0 });
    live.push({ stopNbr: `S${i}`, status: '10', day: '2026-09-07', weight: 500, cartons: 1, volume: 0 });
  }
  // 30 stale on screen (28,412 lb / 54 skids / 1 loose between them).
  for (let i = 0; i < 30; i++) shown.push({ stopNbr: `STALE${i}`, status: '10', day: '2026-09-01', weight: i === 0 ? 28412 - 29 * 900 : 900, cartons: i < 24 ? 2 : 1, volume: i === 0 ? 1 : 0 });
  // 3 shown planned that NuVizz un-planned (10,749 lb / 28 skids).
  shown.push({ stopNbr: 'PRIMARY131434870', status: '20', routeName: 'MARCUS 2', day: '2026-09-02', weight: 10000, cartons: 26, volume: 0, businessName: 'PRIMARY LOGISTICS' });
  shown.push({ stopNbr: '007171307-1', status: '20', routeName: 'WILLIAM', day: '2026-09-03', weight: 143, cartons: 1, volume: 0 });
  shown.push({ stopNbr: '007171668', status: '20', routeName: 'ULINE APPT', day: '2026-09-03', weight: 606, cartons: 1, volume: 0 });
  for (const [n, w, c] of [['PRIMARY131434870', 10000, 26], ['007171307-1', 143, 1], ['007171668', 606, 1]]) live.push({ stopNbr: n, status: '10', routeName: null, day: '2026-09-03', weight: w, cartons: c, volume: 0 });
  // 2 in NuVizz's list only.
  live.push({ stopNbr: '007171664-1', status: '10', day: '2026-09-03', weight: 848, cartons: 1, volume: 0, businessName: 'EXPEDITORS INTERNATIONAL' });
  live.push({ stopNbr: '007171197', status: '10', day: '2026-09-02', weight: 781, cartons: 2, volume: 2, businessName: 'HIGHLAND FORGE' });
  // Make the shared 520 carry the real remainder so the sums land on the screenshot figures.
  // The unplanned selection on our side is the 520 shared + 30 stale; the 3 planned rows sit outside it.
  shown[0].weight += 306121 - 500 * 520 - 28412; live[0].weight += 290087 - 500 * 520 - 10749 - 848 - 781;
  shown[0].cartons += 909 - 520 - 54; live[0].cartons += 886 - 520 - 28 - 1 - 2;
  shown[0].volume += 200 - 1; live[0].volume += 201 - 2;

  const d = diffWindow(shown, live);
  assert.equal(d.matches, false);
  assert.equal(d.stale.length, 30);
  assert.equal(d.missing.length, 2);
  assert.deepEqual(d.missing.map((m) => m.stopNbr), ['007171197', '007171664-1']);
  assert.equal(d.changed.length, 3);
  const primary = d.changed.find((c) => c.stopNbr === 'PRIMARY131434870');
  assert.equal(primary.ours.planned, true);
  assert.equal(primary.ours.routeName, 'MARCUS 2');
  assert.equal(primary.nuvizz.planned, false);
  assert.equal(primary.nuvizz.weight, 10000);
  // Shown side: 553 rows on screen in this fixture (550 unplanned + the 3 planned); the four header numbers of the unplanned selection are the screenshot's.
  const shownUnplanned = totalsOf(shown.filter((r) => r.status === '10'));
  assert.deepEqual([shownUnplanned.count, shownUnplanned.weight, shownUnplanned.skids, shownUnplanned.loose], [550, 306121, 909, 200]);
  assert.deepEqual([d.nuvizz.count, d.nuvizz.unplanned, d.nuvizz.weight, d.nuvizz.skids, d.nuvizz.loose], [525, 525, 290087, 886, 201]);
});

test('a matching window says so and lists nothing', () => {
  const rows = [{ stopNbr: 'A', status: '10', day: '2026-09-07', weight: 1 }, { stopNbr: 'B', status: '20', routeName: 'CHAD', day: '2026-09-08', weight: 2 }];
  const d = diffWindow(rows, rows.map((r) => ({ ...r })));
  assert.equal(d.matches, true);
  assert.deepEqual([d.stale, d.missing, d.changed], [[], [], []]);
});

test('changed: a day move is a change; out-for-delivery vs planned is NOT (both are "on a load"); a load rename is', () => {
  const shown = [
    { stopNbr: 'DAY', status: '10', day: '2026-09-04' },
    { stopNbr: 'OFD', status: '20', routeName: 'BEN 1', day: '2026-09-07' },
    { stopNbr: 'LOAD', status: '20', routeName: 'SCOTT', day: '2026-09-07' },
  ];
  const live = [
    { stopNbr: 'DAY', status: '10', day: '2026-09-09' },
    { stopNbr: 'OFD', status: '40', routeName: 'BEN 1', day: '2026-09-07' },
    { stopNbr: 'LOAD', status: '20', routeName: 'SCOTT 2', day: '2026-09-07' },
  ];
  const d = diffWindow(shown, live);
  assert.deepEqual(d.changed.map((c) => c.stopNbr), ['DAY', 'LOAD']);
  assert.equal(d.changed[0].nuvizz.day, '2026-09-09');
});

test('stop numbers are compared as trimmed strings; duplicates on one side count once', () => {
  const d = diffWindow([{ stopNbr: ' 007170329 ', status: '10' }, { stopNbr: '007170329', status: '10' }], [{ stopNbr: '007170329', status: '10' }]);
  assert.equal(d.matches, true);
  assert.equal(d.shown.count, 1);
});
