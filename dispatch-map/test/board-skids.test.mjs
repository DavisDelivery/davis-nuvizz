// board-skids — the drivers board's live skid count (Chad: "i want the davis delivery drivers
// board to have a live skid count from the dispatch map board").
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { sumBoardSkids } from '../netlify/functions/lib/board-skids.mts';

test('skids are summed from cartons (NuVizz totalCartons), never from pallets (total pieces)', () => {
  const t = sumBoardSkids([
    { cartons: 4, pallets: 90, volume: 2, weight: 1000.4, isUnplanned: false },
    { cartons: 3, pallets: 50, volume: 0, weight: 500, isUnplanned: true },
  ]);
  assert.deepEqual(t, { stops: 2, skids: 7, routedSkids: 4, unroutedSkids: 3, unroutedStops: 1, loose: 2, weight: 1500 });
});

test('a stop with no skid count, a junk count or a null row adds nothing and does not throw', () => {
  const t = sumBoardSkids([{ cartons: null }, { cartons: 'x' }, { cartons: -2 }, null, { cartons: '5' }]);
  assert.equal(t.skids, 5);
  assert.equal(t.stops, 4);
  assert.deepEqual(sumBoardSkids(undefined), { stops: 0, skids: 0, routedSkids: 0, unroutedSkids: 0, unroutedStops: 0, loose: 0, weight: 0 });
});

test('the endpoint counts the day the map shows: cancelled freight is not skids, and it spends no NuVizz call', async () => {
  const day = '2026-10-01';
  const base = `nuvizz_stop_index/davis__${day}`;
  const fake = installFirestoreFake({
    [base]: { count: 3, last_scanned_at: '2026-10-01T12:00:00Z' },
    [`${base}/stops/A`]: { stopNbr: 'A', cartons: 6, isUnplanned: false, routeName: 'MARCUS', businessName: 'WHITING TURNER', status: 'PLANNED' },
    [`${base}/stops/B`]: { stopNbr: 'B', cartons: 4, isUnplanned: true, businessName: 'POREX', status: 'OPEN' },
    [`${base}/stops/C`]: { stopNbr: 'C', cartons: 9, isUnplanned: true, status: 'OPEN', raw: { stopExecutionInfo: { cancellation: { cancelDTTM: '2026-10-01T10:00:00Z', reasonCode: 'CUST' } } } },
  });
  try {
    const handler = (await import('../netlify/functions/board-skids.mts')).default;
    const res = await handler(new Request(`https://x.netlify.app/.netlify/functions/board-skids?date=${day}`));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.date, day);
    assert.equal(body.source, 'firestore');
    assert.equal(body.lastScannedAt, '2026-10-01T12:00:00Z');
    assert.equal(body.stops, 2, 'the cancelled stop is gone, as it is from the map');
    assert.equal(body.skids, 10);
    assert.equal(body.routedSkids, 6);
    assert.equal(body.unroutedSkids, 4);
    // A public feed: totals only — no customer, route or driver name leaves it.
    const text = JSON.stringify(body);
    for (const leak of ['WHITING', 'POREX', 'MARCUS']) assert.ok(!text.includes(leak), `${leak} must not be in the public feed`);
    assert.deepEqual(fake.log.other, [], 'no call outside Firestore — 0 NuVizz calls');
  } finally {
    fake.restore?.();
  }
});

test('an unscanned day answers index-empty, not a confident zero', async () => {
  const fake = installFirestoreFake({});
  try {
    const handler = (await import('../netlify/functions/board-skids.mts')).default;
    const body = await (await handler(new Request('https://x.netlify.app/.netlify/functions/board-skids?date=2026-10-02'))).json();
    assert.equal(body.ok, true);
    assert.equal(body.source, 'index-empty');
    assert.equal(body.skids, 0);
  } finally {
    fake.restore?.();
  }
});

test('a malformed date is refused before any read', async () => {
  const handler = (await import('../netlify/functions/board-skids.mts')).default;
  const res = await handler(new Request('https://x.netlify.app/.netlify/functions/board-skids?date=../../x'));
  assert.equal(res.status, 400);
});
