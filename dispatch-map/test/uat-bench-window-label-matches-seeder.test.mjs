// test/uat-bench-window-label-matches-seeder.test.mjs
//
// THE BENCH SHOWED A WINDOW THE SEEDER WAS ABOUT TO THROW AWAY (audit 2026-09-27,
// client-map-ui-libs-5).
//
// windowLabel's own comment says the pick list and the seeder "must say the same thing". The
// seeder (lib/uat-seed.mts buildSeedRow) keeps a production window only when both ends have the
// contract's yyyy-MM-ddTHH:mm:ss shape AND it opens before it closes; otherwise the UAT copy goes
// out with the builder's 12:00–17:00 default. The screen printed any two 16+ character strings as
// a window, in whatever order: a row reading 18:30 -> 17:00 STRICT showed "18:30–17:00 strict", a
// tester ticked it to test a strict deadline, and the copy arrived with a 12–5 PREFERRED window.
//
// What happens now: the pick list applies the seeder's rule, so a window it shows is a window the
// copy will carry, and one it will not carry reads "no window". Pinned as parity against the real
// seeder, so the two cannot drift apart again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { windowLabel } from '../src/lib/uat-bench-view.js';
import { buildSeedRow } from '../netlify/functions/lib/uat-seed.mts';

const row = (scheduledFrom, scheduledTo, timeConstraint = 'STRICT') => ({
  stopNbr: '0012345678', businessName: 'ACME', addr1: '1 Main', city: 'Buford', state: 'GA', zip: '30518',
  scheduledFrom, scheduledTo, timeConstraint,
});

const CASES = {
  'a real window': row('2026-09-10T08:00:00', '2026-09-10T17:00:00'),
  'an inverted window': row('2026-09-10T18:30:00', '2026-09-10T17:00:00'),
  'a window that opens and closes at the same minute': row('2026-09-10T14:00:00', '2026-09-10T14:00:00'),
  'only an opening time': row('2026-09-10T18:30:00', null),
  'only a closing time': row(null, '2026-09-10T17:00:00'),
  'times that are not the contract\'s shape': row('2026-09-10 08:00:00', '2026-09-10 17:00:00'),
  'a long non-date string': row('not-a-time-at-all-x', 'not-a-time-at-all-y'),
  'no window at all': row(null, null),
};

test('a strict window that closes before it opens is shown as no window — the copy will not carry it', () => {
  assert.equal(windowLabel(CASES['an inverted window']), 'no window');
});

test('the pick list and the seeder say the same thing about every window', () => {
  for (const [name, r] of Object.entries(CASES)) {
    const seeded = buildSeedRow(r).window;
    const label = windowLabel(r);
    if (seeded.from === null) {
      assert.equal(label, 'no window', `${name}: the seeder drops it, so the screen must not show it (showed "${label}")`);
    } else {
      assert.equal(label, `${seeded.from.slice(11, 16)}–${seeded.to.slice(11, 16)} strict`, `${name}: the screen shows the window the copy carries`);
    }
  }
});
