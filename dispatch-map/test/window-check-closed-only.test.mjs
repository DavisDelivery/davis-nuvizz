// test/window-check-closed-only.test.mjs — CHECK VS NUVIZZ ON A COMPLETED-ONLY GRID SPENDS NOTHING.
//
// The check compares OPEN work only. The grid sends the rows it is showing, already filtered to
// the ticked status buckets — so with only Completed and/or Cancelled ticked, every row it sends
// is closed and is set aside. The server used to fall back to "all four open codes", spend one
// metered NuVizz call on them, and report every open order in the window (hundreds on a normal
// day) as "in NuVizz, not shown here": a comparison against a filter nobody was looking at.
//
// Driven through the REAL handler. The Firestore fake is installed with NO vendor stub, so any
// NuVizz call made here throws — the refusal is proven to cost nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { closedOnlyRequest, checkCodes, ACTIVE_CODES } from '../netlify/functions/lib/window-check.mts';

delete process.env.AUTH_REQUIRED;

test('a status filter holding only Completed and/or Cancelled is named as having no open work to compare', () => {
  assert.equal(closedOnlyRequest(['90', '91']), true, 'Completed');
  assert.equal(closedOnlyRequest(['99']), true, 'Cancelled');
  assert.equal(closedOnlyRequest(['90', '91', '99']), true, 'Completed + Cancelled');
  assert.equal(closedOnlyRequest(['10', '90']), false, 'Un-Planned + Completed still has open work on screen');
  assert.equal(closedOnlyRequest([]), false, 'no status filter is the whole window — all four open codes, as before');
  assert.equal(closedOnlyRequest(undefined), false);
  assert.equal(closedOnlyRequest(null), false);
  assert.deepEqual(checkCodes([]), ACTIVE_CODES, 'the no-filter fallback is unchanged');
});

async function post(body) {
  const { restore, log } = installFirestoreFake({});      // no onOther → a NuVizz fetch THROWS
  try {
    const rq = await import('../netlify/functions/lib/require-user.mts');
    rq._resetThrottleForTests();
    const { default: handler } = await import('../netlify/functions/nuvizz-window-check.mts');
    const res = await handler(new Request('https://x.netlify.app/.netlify/functions/nuvizz-window-check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json(), log };
  } finally { restore(); }
}

test('a dispatcher who filters the grid to Completed and presses Check vs NuVizz spends no call and is told why', async () => {
  const shown = [
    { stopNbr: 'D1', status: '90', day: '2026-09-25', routeName: 'BEN 1' },
    { stopNbr: 'D2', status: '91', day: '2026-09-25', routeName: 'BEN 1' },
  ];
  const r = await post({ fromDate: '2026-09-18', toDate: '2026-09-25', statusCodes: ['90', '91'], shown });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /open work/i, 'the reason names what the check compares');
  assert.equal(r.body.missing, undefined, 'no "missing" list of every open order');
  assert.deepEqual(r.log.other, [], 'no NuVizz call was made');
});

test('the same refusal holds for a Cancelled-only grid on a NuVizz period preset', async () => {
  const r = await post({ arrivalPeriod: '+/-7d', statusCodes: ['99'], shown: [{ stopNbr: 'X1', status: '99' }] });
  assert.equal(r.status, 400);
  assert.deepEqual(r.log.other, []);
});
