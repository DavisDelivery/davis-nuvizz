// THE SILENT-ZERO BUG, PINNED.
//
// The live stop index carries NO matchKey. Measured against a real board: 778 stops,
// 63 routes judged, matchKey null on every row — so the notes lookup found nothing, no stop
// appeared to have receiving hours, and the whole board came back clean. The critical-flag
// alert would have read an ordinary Tuesday as a day with nothing wrong on it and never sent
// a thing. Nobody would have noticed, because a quiet alert looks exactly like a good day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopCustomerKey, withCustomerKeys } from '../netlify/functions/lib/customer-key.mts';
import { computeBoardFlags } from '../src/lib/board-flags.js';

// A stop shaped like the LIVE index: real name and address, no matchKey field at all.
const liveStop = (o = {}) => ({
  stopNbr: '1', businessName: 'PYROK INC', addr1: '100 Main St', city: 'Buford', zip: '30518',
  loadNbr: 'WILLIAM', stopType: 'DL', routeSeq: 1, lat: 34.30, lng: -83.96,
  normalizedStatus: 'PLANNED', status: '10', ...o,
});

test('a live stop with no matchKey still resolves to its customer key', () => {
  const s = liveStop();
  assert.equal(s.matchKey, undefined, 'the fixture must reproduce the live shape');
  assert.ok(stopCustomerKey(s), 'a key is derived from name + address');
});

test('the key is DERIVED, so it does not change when a stale stored one disagrees', () => {
  const fresh = stopCustomerKey(liveStop());
  const stale = stopCustomerKey(liveStop({ matchKey: 'something-else-entirely' }));
  assert.equal(stale, fresh, 'the derivation wins over a stored value');
});

test('a stored key is still accepted when there is nothing to derive from', () => {
  assert.equal(stopCustomerKey({ customerMatchKey: 'kept|key' }), 'kept|key');
});

test('a name with no alphanumerics is refused rather than fetched as a garbage doc', () => {
  assert.equal(stopCustomerKey({ businessName: '---', addr1: '', city: '', zip: '' }), null);
});

test('withCustomerKeys stamps the key the flag engine looks its hours up by', () => {
  const [s] = withCustomerKeys([liveStop()]);
  assert.equal(s.matchKey, stopCustomerKey(liveStop()));
});

test('withCustomerKeys does not clone a stop that already has the right key', () => {
  const already = withCustomerKeys([liveStop()])[0];
  assert.equal(withCustomerKeys([already])[0], already, 'same object, no churn');
});

test('THE REGRESSION ITSELF: live-shaped stops produce flags only once keys are stamped', () => {
  const DEPOT = { name: 'Buford Terminal', lat: 34.147791, lng: -83.960911 };
  const stops = [
    liveStop({ stopNbr: '1', routeSeq: 1, businessName: 'FIRST CO', lat: 34.30 }),
    liveStop({ stopNbr: '2', routeSeq: 2, businessName: 'PYROK INC', lat: 33.60, lng: -84.60 }),
  ];
  const key = stopCustomerKey(stops[1]);
  const notes = new Map([[key, {
    manual_overrides: { receiving_hours: true },
    receiving_hours: { mon: { open: '08:00', close: '09:00' } },
  }]]);
  const args = { notes, servedDate: '2026-08-17', dayKey: 'mon', opts: { depot: DEPOT } };

  // Exactly what shipped: raw live stops, notes loaded correctly, and still nothing.
  const before = computeBoardFlags({ stops, ...args });
  assert.equal(before.rows.filter((r) => r.rule === 'hours_risk').length, 0,
    'this is the silent zero — a clean board that is not clean');
  assert.equal(before.checked.stopsWithHours, 0, 'and it reported looking at zero deadlines');

  // With the key stamped on, the same board, same notes, produces the flag.
  const after = computeBoardFlags({ stops: withCustomerKeys(stops), ...args });
  assert.equal(after.rows.filter((r) => r.rule === 'hours_risk').length, 1);
  assert.ok(after.checked.stopsWithHours > 0, 'and it can now say it looked at a deadline');
});
