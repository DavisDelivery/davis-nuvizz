// test/first-sight-stamp.test.mjs — the arrival stamp writeStops puts on a stop, once.
//
// WHY THIS EXISTS, measured rather than assumed. On 2026-09-14 the live index held 643 stops
// for the next delivery day and TWO of them carried `enriched_at` — the field an entire
// feature had just been built on. The other candidate, `listUpdatedDTTM`, is a LIVE field: on
// Tue 2026-09-08, 650 of 704 stamps had drifted onto the delivery day itself, the arrival time
// overwritten by the delivery flip. Neither can answer "when did this order land", and no
// history can be rebuilt from either. This is the replacement, and these are its three rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { firstSightStamps } from '../netlify/functions/lib/firestore.mts';

const SCAN = '2026-09-14T23:10:15.789Z';
const fresh = (extra = {}) => ({ stopNbr: '007151447', listUpdatedDTTM: '2026-09-14T19:05:00', ...extra });

test('a stop NEW to the day is stamped with this scan, and with the vendor time it arrived at', () => {
  const { stamps } = firstSightStamps(null, fresh(), SCAN);
  assert.equal(stamps.first_seen_at, SCAN);
  assert.equal(stamps.arrived_list_dttm, '2026-09-14T19:05:00');
});

test('write-once: a stop already on the day keeps the stamp it had — setDoc REPLACES', () => {
  // Without the explicit carry-forward, every 5-minute scan would re-stamp every order with
  // `now` and the whole curve would collapse onto the current tick.
  const existing = { first_seen_at: '2026-09-14T11:00:00.000Z', arrived_list_dttm: '2026-09-14T06:58:00' };
  const { stamps } = firstSightStamps(existing, fresh({ listUpdatedDTTM: '2026-09-14T19:05:00' }), SCAN);
  assert.equal(stamps.first_seen_at, '2026-09-14T11:00:00.000Z');
  assert.equal(stamps.arrived_list_dttm, '2026-09-14T06:58:00', 'the vendor stamp is frozen, not refreshed');
});

test('a doc that predates this change gets NOTHING — not today\'s clock', () => {
  // The expensive mistake in the other direction: stamping every order already in the index
  // with the deploy time. That is worse than absent because it looks like data — a whole
  // board that appears to have arrived in one minute. Absent, the coverage floor counts them
  // honestly and refuses to seal the night.
  const { stamps } = firstSightStamps({ stopNbr: '007151447' }, fresh(), SCAN);
  assert.equal(stamps.first_seen_at, undefined);
  assert.equal(stamps.arrived_list_dttm, undefined);
  assert.deepEqual(Object.keys(stamps), []);
});

test('another day\'s stamp cannot ride in on the fresh row via the enrich registry', () => {
  // mergeEnrich copies the per-PRO registry record onto the row, and that record is a whole
  // stop from whatever day it was FIRST enriched. Unstripped, a recurring PRO would carry a
  // first_seen_at from weeks ago onto tonight's board and read as an order that never arrived.
  const contaminated = fresh({ first_seen_at: '2026-08-02T09:00:00.000Z', arrived_list_dttm: '2026-08-02T05:00:00' });
  const { clean, stamps } = firstSightStamps({ stopNbr: '007151447' }, contaminated, SCAN);
  assert.equal(clean.first_seen_at, undefined, 'stripped from the spread');
  assert.equal(clean.arrived_list_dttm, undefined, 'stripped from the spread');
  assert.deepEqual(stamps, {}, 'an existing doc with no stamp stays unstamped');
  // And on a genuinely new stop the incoming values are still ignored in favour of this scan.
  const onNew = firstSightStamps(null, contaminated, SCAN);
  assert.equal(onNew.stamps.first_seen_at, SCAN);
  assert.equal(onNew.stamps.arrived_list_dttm, '2026-09-14T19:05:00', 'the row\'s own live field, not the registry copy');
});

test('the rest of the row is passed through untouched', () => {
  const { clean } = firstSightStamps(null, fresh({ businessName: 'ACME', lat: 34.1 }), SCAN);
  assert.equal(clean.stopNbr, '007151447');
  assert.equal(clean.businessName, 'ACME');
  assert.equal(clean.lat, 34.1);
});

test('a stop with no vendor timestamp still gets our scan clock', () => {
  const { stamps } = firstSightStamps(null, { stopNbr: '9' }, SCAN);
  assert.equal(stamps.first_seen_at, SCAN);
  assert.equal(stamps.arrived_list_dttm, undefined, 'absent is not invented');
});
