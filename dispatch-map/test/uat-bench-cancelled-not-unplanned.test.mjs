// test/uat-bench-cancelled-not-unplanned.test.mjs
//
// THE UAT BENCH LISTED A CANCELLED ORDER AS "UN-PLANNED" (audit 2026-09-27, client-map-ui-libs-4).
//
// A cancelled (or unable-to-deliver) order with no route is written to the board as isPlanned:false
// AND isUnplanned:false — "neither planned nor unplanned: it is done" (lib/nuvizz-list.mts), the fix
// for PRO 007151447-2 being built onto a truck. The server's un-planned count honours that. The
// bench's "un-planned only" filter let such a row through anyway (`isPlanned === false`), and both
// views labelled it a green "un-planned" — so the header said "1 un-planned" over two rows, and a
// tester picking freight for a route-building scenario could seed a cancelled order into UAT as a
// fresh, plannable one.
//
// What happens now: the filter and the label use the server's rule. A finished order is labelled
// by its status ("cancelled"), on the desktop table and the phone cards, and "un-planned only"
// shows exactly the rows the count counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { isUnplannedRow, notPlannedLabel } from '../src/lib/uat-bench-view.js';
import { mountBench, textOf, tableRows, phoneCards, findAll } from './helpers/uat-bench-harness.mjs';

const D = '2026-09-23';
// Shaped exactly as nuvizz-list.mts writes them.
const CANCELLED = { stopNbr: '0071514472', businessName: 'MICROSOFT ATL22', addr1: '1 Main', city: 'Atlanta', state: 'GA', isPlanned: false, isUnplanned: false, normalizedStatus: 'CANCELLED' };
const OPEN = { stopNbr: '0071000001', businessName: 'OPEN ORDER CO', addr1: '2 Main', city: 'Buford', state: 'GA', isPlanned: false, isUnplanned: true, normalizedStatus: 'UNPLANNED' };
const PLANNED = { stopNbr: '0071000002', businessName: 'ROUTED CO', addr1: '3 Main', city: 'Cumming', state: 'GA', isPlanned: true, isUnplanned: false, normalizedStatus: 'SCHEDULED', routeName: 'TRAILER 6' };

test('the bench\'s un-planned rule is the server\'s — it counts exactly the rows the catalogue counts', async () => {
  const fake = installFirestoreFake({
    [`nuvizz_stop_index/davis__${D}/stops/${CANCELLED.stopNbr}`]: CANCELLED,
    [`nuvizz_stop_index/davis__${D}/stops/${OPEN.stopNbr}`]: OPEN,
    [`nuvizz_stop_index/davis__${D}/stops/${PLANNED.stopNbr}`]: PLANNED,
    [`nuvizz_stop_index/davis__${D}/stops/LEGACY`]: { stopNbr: 'LEGACY', businessName: 'OLD ROW', isPlanned: false },
  });
  const saved = process.env.FIRESTORE_DATABASE;
  process.env.FIRESTORE_DATABASE = 'uat-mirror';
  try {
    const { readProdDay } = await import('../netlify/functions/lib/prod-catalogue.mts');
    const cat = await readProdDay('davis', D);
    assert.equal(cat.rows.filter(isUnplannedRow).length, cat.unplannedTotal);
    assert.deepEqual(cat.rows.filter(isUnplannedRow).map((r) => r.stopNbr).sort(), ['0071000001', 'LEGACY']);
  } finally {
    if (saved === undefined) delete process.env.FIRESTORE_DATABASE; else process.env.FIRESTORE_DATABASE = saved;
    fake.restore();
  }
});

test('a cancelled order with no route is labelled cancelled, not un-planned', () => {
  assert.equal(isUnplannedRow(CANCELLED), false);
  assert.equal(notPlannedLabel(CANCELLED), 'cancelled');
  assert.equal(notPlannedLabel({ ...CANCELLED, normalizedStatus: 'EXCEPTION' }), 'exception');
  assert.equal(notPlannedLabel(OPEN), 'un-planned');
  assert.equal(isUnplannedRow(OPEN), true);
  for (const junk of [null, undefined, {}]) assert.equal(isUnplannedRow(junk), false, JSON.stringify(junk));
});

test('"un-planned only" on the bench shows the open order and not the cancelled one — in both views', async () => {
  const b = mountBench();
  b.calls[0].answer({ ok: true, op: 'catalogue', date: D, dayTotal: 3, unplannedTotal: 1, note: null, rows: [CANCELLED, OPEN, PLANNED], seeded: { count: 0, orders: [] } });
  let tree = await b.settle();

  // Unfiltered: every row, and the cancelled one says what it is.
  for (const view of [tableRows(tree), phoneCards(tree)]) {
    const cancelledRow = view.find((n) => textOf(n).includes('MICROSOFT ATL22'));
    assert.ok(cancelledRow, 'the cancelled order is still listed');
    assert.match(textOf(cancelledRow), /cancelled/);
    assert.doesNotMatch(textOf(cancelledRow), /un-planned/, 'it is not freight waiting for a route');
    assert.match(textOf(view.find((n) => textOf(n).includes('OPEN ORDER CO'))), /un-planned/);
  }

  const onlyUnplanned = findAll(tree, (n) => n.type === 'input' && n.props.type === 'checkbox' && typeof n.props.onChange === 'function')[0];
  onlyUnplanned.props.onChange({ target: { checked: true } });
  tree = b.render();
  for (const view of [tableRows(tree), phoneCards(tree)]) {
    assert.deepEqual(view.map((n) => n.props.key), ['0071000001'], 'only the open order');
  }
  assert.match(textOf(tree), /1 of 3 shown · 1 un-planned/, 'the list and its count agree');
});
