// test/stop-lookup-chooser-count-once.test.mjs — THE CUSTOMER CHOOSER COUNTS A DELIVERY ONCE.
//
// Audit 2026-09-27 (shiplify-lookup-uat-5). A rep types "EARTHLY" and two businesses match,
// each delivered once yesterday. Yesterday's order exists twice in Firestore — the live board
// copy and the sealed nightly copy — and the chooser added 1 for each, so both read
// "2 stops in this window". Picking one then showed 1 delivery, because the customer view
// merges on day + stop number. The chooser now counts on the same key.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

const T = 'davis';
const URL_BASE = 'https://x.netlify.app/.netlify/functions/stop-lookup';
const call = async (qs) => {
  const handler = (await import('../netlify/functions/stop-lookup.mts')).default;
  return (await handler(new Request(`${URL_BASE}?${qs}`))).json();
};
const today = async () => (await import('../netlify/functions/lib/firestore.mts')).etDayString();
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const stopA = { stopNbr: '111111111', pro: '111111111', businessName: 'EARTHLY ALTERNATIVE', addr1: '1 WENDELL DR', city: 'ATLANTA', state: 'GA', zip: '30301', normalizedStatus: 'DELIVERED', driverName: 'A' };
const stopB = { stopNbr: '222222222', pro: '222222222', businessName: 'EARTHLY GOODS', addr1: '9 OAK ST', city: 'ATLANTA', state: 'GA', zip: '30302', normalizedStatus: 'DELIVERED', driverName: 'B' };

test("the chooser counts yesterday's delivery once, though the board copy and the sealed copy both exist — and agrees with the view a rep lands on", async () => {
  const y = addDays(await today(), -1);
  const fake = installFirestoreFake({
    [`nuvizz_stop_index/${T}__${y}/stops/111111111`]: stopA,
    [`history_days/${T}__${y}/stops/111111111`]: { ...stopA, date: y },
    [`nuvizz_stop_index/${T}__${y}/stops/222222222`]: stopB,
    [`history_days/${T}__${y}/stops/222222222`]: { ...stopB, date: y },
  });
  try {
    const body = await call('name=EARTHLY');
    assert.equal(body.mode, 'customer-choose');
    const by = Object.fromEntries(body.matches.map((m) => [m.name, m]));
    assert.equal(by['EARTHLY ALTERNATIVE'].stops, 1, 'one delivery, counted once');
    assert.equal(by['EARTHLY GOODS'].stops, 1, 'one delivery, counted once');
    assert.equal(by['EARTHLY GOODS'].lastDate, y);

    const picked = await call(`name=EARTHLY&nameKey=${by['EARTHLY GOODS'].nameKey}`);
    assert.equal(picked.mode, 'customer');
    assert.equal(picked.view.totals.stops, by['EARTHLY GOODS'].stops, 'the chooser and the view say the same number');
  } finally { fake.restore(); }
});

test('two different orders to the same business on the same day are still two', async () => {
  const y = addDays(await today(), -1);
  const fake = installFirestoreFake({
    [`nuvizz_stop_index/${T}__${y}/stops/111111111`]: stopA,
    [`history_days/${T}__${y}/stops/111111111`]: { ...stopA, date: y },
    [`history_days/${T}__${y}/stops/111111112`]: { ...stopA, stopNbr: '111111112', pro: '111111112', date: y },
    [`nuvizz_stop_index/${T}__${y}/stops/222222222`]: stopB,
  });
  try {
    const body = await call('name=EARTHLY');
    const by = Object.fromEntries(body.matches.map((m) => [m.name, m]));
    assert.equal(by['EARTHLY ALTERNATIVE'].stops, 2);
    assert.equal(by['EARTHLY GOODS'].stops, 1);
  } finally { fake.restore(); }
});
