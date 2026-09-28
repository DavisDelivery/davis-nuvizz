// test/driver-loads-impossible-date.test.mjs — an impossible day is refused with the 400 sentence.
//
// Audit 2026-09-27 (nuvizz-write-5): the range was checked only against YYYY-MM-DD, so a day that
// has the shape but not the calendar (2026-09-00, 2026-13-45) reached addDays, whose
// toISOString() throws RangeError, and the platform answered a bare 500. A hand-edited URL or an
// old Recent-lookups entry got a crash instead of the handler's own "must be days" sentence, and
// 2026-02-31 quietly rolled over into March.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { isCalendarDay } from '../src/lib/load-lookup.js';

const call = async (qs) => {
  const handler = (await import('../netlify/functions/driver-loads.mts')).default;
  const r = await handler(new Request(`https://x.netlify.app/.netlify/functions/driver-loads?${qs}`));
  return { status: r.status, body: await r.json() };
};

test('a lookup for a day that is not on the calendar is answered with the 400 sentence, not a crash', async () => {
  const fake = installFirestoreFake({});
  try {
    for (const qs of ['from=2026-09-00&to=2026-09-02', 'from=2026-09-01&to=2026-13-45', 'week=2026-13-45', 'week=2026-09-00', 'from=2026-02-31&to=2026-03-02']) {
      let res;
      await assert.doesNotReject(async () => { res = await call(qs); }, `${qs} must not throw`);
      assert.equal(res.status, 400, `${qs} is refused`);
      assert.equal(res.body.ok, false);
      assert.match(res.body.error, /YYYY-MM-DD/, `${qs} gets the handler's own sentence`);
      assert.equal(res.body.nuvizzCalls, 0);
    }
    assert.equal(fake.log.other.length, 0, 'nothing but Firestore was called');
  } finally { fake.restore(); }
});

test('a real day still reads — the check refuses only days the calendar does not have', async () => {
  const fake = installFirestoreFake({});
  try {
    assert.equal((await call('from=2026-02-28&to=2026-03-01')).status, 200);
    assert.equal((await call('week=2028-02-29')).status, 200, 'a leap day is a day');
  } finally { fake.restore(); }
});

test('isCalendarDay: the shape AND the calendar', () => {
  for (const d of ['2026-09-27', '2026-02-28', '2028-02-29', '2026-12-31', '2026-01-01']) assert.equal(isCalendarDay(d), true, d);
  for (const d of ['2026-09-00', '2026-13-45', '2026-02-31', '2026-02-29', '2026-04-31', '2026-00-10', '09/27/2026', '', null, undefined, 20260927])
    assert.equal(isCalendarDay(d), false, String(d));
});
