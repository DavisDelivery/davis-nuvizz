// A4-S19-1 — an order the load scan found on a truck must not ALSO come back from the
// unplanned descent as a second, unplanned copy.
//
// scanDate merges two feeds: the load probe (rows shaped { stop: {stopNbr…}, stopExecutionInfo,
// load }) and the unplanned descent (rows shaped { stop, stopExecutionInfo }). The merge was
// meant to let the load-sourced row win, but it keyed its "already seen" set on s.stopNbr — a
// field the wrapped load row does not have — so the set was always empty and a stop NuVizz still
// reports at status 10 with no load on /stop/info (the settling window after planning) came
// back twice: once planned on its route, once unplanned with no route.
//
// No network: the Firestore fake's onOther is the vendor, and it refuses anything that is not a
// stubbed NuVizz URL.
process.env.NUVIZZ_DAVIS_USER = 'u';
process.env.NUVIZZ_DAVIS_PASS = 'p';
delete process.env.NUVIZZ_SCANS_ENABLED;

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

const DATE = '2026-09-14';
const stopRec = (nbr) => ({
  stopNbr: nbr, stopType: 'DO',
  to: { schedule: { timeFrom: `${DATE}T08:00:00` }, address: { name: 'ACME', addr1: '1 MAIN ST', city: 'BUFORD', state: 'GA', zip: '30518' } },
});

test('the merge keys a wrapped load row by its own stop number', async () => {
  const { unplannedNotOnLoads } = await import('../netlify/functions/lib/nuvizz-scan.mts');
  const loadRows = [
    { stop: stopRec('000001001'), stopExecutionInfo: { stopStatus: '20' }, load: { loadNbr: 'DAVIS000000500' } },
    // A flat row (normalizeStop accepts both shapes) is keyed the same way.
    { stopNbr: '000001002', load: { loadNbr: 'DAVIS000000500' } },
  ];
  const descent = [
    { stop: stopRec('000001001'), stopExecutionInfo: { stopStatus: '10' } },
    { stop: stopRec('000001002'), stopExecutionInfo: { stopStatus: '10' } },
    { stop: stopRec('000001003'), stopExecutionInfo: { stopStatus: '10' } },
    { stop: {}, stopExecutionInfo: {} },
  ];
  assert.deepEqual(unplannedNotOnLoads(loadRows, descent).map((u) => u.stop.stopNbr), ['000001003']);
  // A numeric stop number on either side still matches its string twin.
  assert.equal(unplannedNotOnLoads([{ stop: { stopNbr: 1001 } }], [{ stop: { stopNbr: '1001' } }]).length, 0);
});

test('an order found on a load is not also filed as a second, unplanned copy', async () => {
  const vendor = async (url) => {
    const u = String(url);
    if (!u.includes('nuvizz')) throw new Error(`blocked non-vendor url ${u.slice(0, 80)}`);
    if (u.includes('/load/info/')) {
      return new Response(JSON.stringify({ Load: {
        loadHeader: { loadNbr: 'DAVIS000000500', routeName: 'BEN 1', earliestStartDttm: `${DATE}T07:00:00` },
        loadAssignment: {},
        stops: [{ stop: stopRec('000001001'), stopExecutionInfo: { stopStatus: '20' } }],
      } }), { status: 200 });
    }
    if (u.includes('/stop/info/')) {
      const n = u.split('/stop/info/')[1].split('/')[0];
      // NuVizz still reports the planned stop at status 10 with no load on it.
      if (n === '000001001') return new Response(JSON.stringify({ Stop: { stop: stopRec(n), stopExecutionInfo: { stopStatus: '10' }, load: {} } }), { status: 200 });
      if (n === '000001004') return new Response(JSON.stringify({ Stop: { stop: stopRec(n), stopExecutionInfo: { stopStatus: '10' }, load: {} } }), { status: 200 });
      return new Response('{}', { status: 404 });
    }
    return new Response('{}', { status: 404 });
  };
  installFirestoreFake({}, vendor);
  const { scanDate } = await import('../netlify/functions/lib/nuvizz-scan.mts');
  const r = await scanDate(DATE, { loadTargets: [500], forwardUnplanned: { start: 1000 } });
  const rows = r.stops.filter((s) => String(s.stopNbr) === '000001001');
  assert.equal(rows.length, 1, `one row for 000001001, got ${JSON.stringify(rows.map((s) => ({ isPlanned: s.isPlanned, loadNbr: s.loadNbr })))}`);
  assert.equal(rows[0].isPlanned, true);
  assert.equal(rows[0].loadNbr, 'DAVIS000000500');
  // A genuinely unplanned order the descent found is still kept.
  const other = r.stops.filter((s) => String(s.stopNbr) === '000001004');
  assert.equal(other.length, 1);
  assert.equal(other[0].isPlanned, false);
  assert.equal(r.plannedCount, 1);
  assert.equal(r.unplannedCount, 1);
});
