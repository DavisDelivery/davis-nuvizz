// test/stop-lookup-customer.test.mjs — "HOW MANY DELIVERIES FOR EARTHLY ALTERNATIVE TODAY?"
//
// Chad, 2026-09-18: "I wanted to see how many deliveries we had for earthly alternative today
// and couldn't. Wanted to see all the different ones and drivers who delivered them."
//
// The first build answered that from history_customers, which is assembled from SEALED
// history — so the one day he asked about is the one day it structurally cannot contain. The
// first test in this file is that failure, pinned: a customer with three stops on today's
// board must come back as three, from the live board, with their drivers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import {
  customerNameKey, nameMatchesQuery, buildCustomerStopRow, summarizeStopRows, driverTally,
  buildCustomerView,
} from '../src/lib/stop-lookup.js';

const T = 'davis';
const URL_BASE = 'https://x.netlify.app/.netlify/functions/stop-lookup';
const call = async (qs) => {
  const handler = (await import('../netlify/functions/stop-lookup.mts')).default;
  return (await handler(new Request(`${URL_BASE}?${qs}`))).json();
};
const today = async () => (await import('../netlify/functions/lib/firestore.mts')).etDayString();
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** One EARTHLY ALTERNATIVE stop, in the shape the board actually stores. */
const ea = (over = {}) => ({
  stopNbr: '007180001', pro: '007180001', businessName: 'EARTHLY ALTERNATIVE',
  addr1: '4200 WENDELL DR SW', city: 'ATLANTA', state: 'GA', zip: '30336',
  routeName: 'ATL 3', loadNbr: 'DAVIS000203801', driverName: 'ANDERSON FRIMPONG', driverUserName: 'ANDERSON',
  loadStopSeq: 5, isPlanned: true, normalizedStatus: 'DELIVERED',
  arrivalDTTM: '2026-09-18T10:02', deliveredDTTM: '2026-09-18T10:21',
  cartons: 6, pallets: 2, weight: 1240, ...over,
});

// ── the name rule ─────────────────────────────────────────────────────────────

test('one customer written four ways is ONE customer', () => {
  const k = customerNameKey('EARTHLY ALTERNATIVE');
  for (const n of ['Earthly Alternative', 'EARTHLY ALTERNATIVE, LLC.', 'earthly alternative llc', 'EARTHLY  ALTERNATIVE']) {
    assert.equal(customerNameKey(n), k, `${n} must group with the rest`);
  }
});

test('typing part of a name finds it, in any word order, and a near-miss does not', () => {
  assert.equal(nameMatchesQuery('EARTHLY ALTERNATIVE', 'earthly'), true);
  assert.equal(nameMatchesQuery('EARTHLY ALTERNATIVE LLC', 'earthly alt'), true);
  assert.equal(nameMatchesQuery('EARTHLY ALTERNATIVE', 'alternative'), true, 'word order must not matter');
  assert.equal(nameMatchesQuery('EARTHLY ALTERNATIVE', 'earthy'), false, 'a prefix, not a fuzzy match');
  assert.equal(nameMatchesQuery('EARTHLY ALTERNATIVE', 'earthly alternative warehouse'), false);
  assert.equal(nameMatchesQuery('', 'earthly'), false);
  assert.equal(nameMatchesQuery('EARTHLY ALTERNATIVE', ''), false, 'an empty box must never match everything');
});

// ── the counts a rep reads out loud ──────────────────────────────────────────

test('the counts separate what DELIVERED from what merely went out', () => {
  const rows = [
    buildCustomerStopRow(ea(), { date: '2026-09-18', today: '2026-09-18' }),
    buildCustomerStopRow(ea({ stopNbr: '2', normalizedStatus: 'DELIVERED' }), { date: '2026-09-18', today: '2026-09-18' }),
    buildCustomerStopRow(ea({ stopNbr: '3', normalizedStatus: 'OUT_FOR_DEL', deliveredDTTM: null }), { date: '2026-09-18', today: '2026-09-18' }),
    buildCustomerStopRow(ea({ stopNbr: '4', normalizedStatus: 'SCHEDULED', deliveredDTTM: null, isAttempt: true }), { date: '2026-09-18', today: '2026-09-18' }),
    buildCustomerStopRow(ea({ stopNbr: '5', normalizedStatus: 'EXCEPTION', deliveredDTTM: null }), { date: '2026-09-18', today: '2026-09-18' }),
  ];
  const c = summarizeStopRows(rows);
  assert.equal(c.stops, 5);
  assert.equal(c.delivered, 2);
  assert.equal(c.open, 1);
  assert.equal(c.attempted, 1);
  assert.equal(c.exceptions, 1);
  assert.equal(c.pieces, 30);
  assert.equal(c.weight, 6200);
});

test('A MULTI-ORDER STOP COUNTS AS ONE STOP AND SEVERAL ORDERS', () => {
  // A dock taking three PROs on one visit is one stop and three deliveries, and a rep asked
  // "how many deliveries" means the orders. Reporting only the stop count under-reports the
  // freight to the person on the phone.
  const row = buildCustomerStopRow(ea({ pros: ['007180001', '007180002', '007180003'] }), { date: '2026-09-18', today: '2026-09-18' });
  assert.equal(row.proCount, 3);
  const c = summarizeStopRows([row]);
  assert.equal(c.stops, 1);
  assert.equal(c.orders, 3);
});

test('THE DRIVER TALLY SEPARATES CARRIED FROM DELIVERED — they are different claims', () => {
  // A driver who had four of these and delivered two did not deliver four, and that sentence
  // gets repeated to a customer.
  const rows = [
    buildCustomerStopRow(ea({ driverName: 'ANDERSON FRIMPONG' }), { date: '2026-09-18', today: '2026-09-18' }),
    buildCustomerStopRow(ea({ stopNbr: '2', driverName: 'ANDERSON FRIMPONG', normalizedStatus: 'OUT_FOR_DEL', deliveredDTTM: null }), { date: '2026-09-18', today: '2026-09-18' }),
    buildCustomerStopRow(ea({ stopNbr: '3', driverName: 'ROBERT MENSAH' }), { date: '2026-09-18', today: '2026-09-18' }),
  ];
  const t = driverTally(rows);
  assert.deepEqual(t, [
    { driver: 'ANDERSON FRIMPONG', stops: 2, delivered: 1 },
    { driver: 'ROBERT MENSAH', stops: 1, delivered: 1 },
  ]);
});

test('an un-assigned stop does not invent a driver row', () => {
  const rows = [buildCustomerStopRow(ea({ driverName: null, driverUserName: null }), { date: '2026-09-18', today: '2026-09-18' })];
  assert.deepEqual(driverTally(rows), []);
});

// ── the view ──────────────────────────────────────────────────────────────────

test('THE SAME STOP IN BOTH THE SEAL AND THE BOARD IS COUNTED ONCE', () => {
  // Both sweeps run over the same days, so every sealed day returns its stops twice. Counting
  // them twice tells a rep we were there six times when we were there three — the single
  // easiest way for this screen to be confidently wrong.
  const v = buildCustomerView({
    query: 'earthly', name: 'EARTHLY ALTERNATIVE', today: '2026-09-18',
    window: { from: '2026-09-17', to: '2026-09-18', days: 2 },
    stops: [
      { date: '2026-09-17', source: 'board', stop: ea({ stopNbr: 'A' }) },
      { date: '2026-09-17', source: 'sealed', stop: ea({ stopNbr: 'A' }) },
      { date: '2026-09-17', source: 'board', stop: ea({ stopNbr: 'B' }) },
    ],
  });
  assert.equal(v.totals.stops, 2);
  assert.equal(v.days.length, 1);
  assert.equal(v.days[0].counts.stops, 2);
});

test('the sealed record wins the merge, and the row still says it was on the board too', () => {
  const v = buildCustomerView({
    query: 'earthly', name: 'EARTHLY ALTERNATIVE', today: '2026-09-18',
    window: { from: '2026-09-17', to: '2026-09-17', days: 1 },
    stops: [
      { date: '2026-09-17', source: 'board', stop: ea({ stopNbr: 'A', normalizedStatus: 'SCHEDULED', driverName: 'SOMEBODY ELSE', deliveredDTTM: null }) },
      { date: '2026-09-17', source: 'sealed', stop: ea({ stopNbr: 'A' }) },
    ],
  });
  assert.equal(v.rows[0].source, 'sealed');
  assert.equal(v.rows[0].driver, 'ANDERSON FRIMPONG');
  assert.equal(v.rows[0].alsoOnBoard, true);
});

test("TODAY IS BROKEN OUT — it is the question that was actually asked", () => {
  const v = buildCustomerView({
    query: 'earthly', name: 'EARTHLY ALTERNATIVE', today: '2026-09-18',
    window: { from: '2026-09-11', to: '2026-09-18', days: 8 },
    stops: [
      { date: '2026-09-18', source: 'board', stop: ea({ stopNbr: 'A' }) },
      { date: '2026-09-18', source: 'board', stop: ea({ stopNbr: 'B' }) },
      { date: '2026-09-18', source: 'board', stop: ea({ stopNbr: 'C', normalizedStatus: 'OUT_FOR_DEL', deliveredDTTM: null }) },
      { date: '2026-09-12', source: 'sealed', stop: ea({ stopNbr: 'D' }) },
    ],
  });
  assert.equal(v.totals.stops, 4);
  assert.equal(v.todayCounts.stops, 3);
  assert.equal(v.todayCounts.delivered, 2);
  assert.equal(v.todayCounts.open, 1);
  assert.equal(v.hasToday, true);
  assert.equal(v.days[0].isToday, true, 'today leads the list');
});

test('a window that does not reach today SAYS so rather than showing an empty today', () => {
  const v = buildCustomerView({
    query: 'earthly', name: 'EARTHLY ALTERNATIVE', today: '2026-09-18',
    window: { from: '2026-09-01', to: '2026-09-05', days: 5 },
    stops: [{ date: '2026-09-03', source: 'sealed', stop: ea({ stopNbr: 'A' }) }],
  });
  assert.equal(v.hasToday, false, "a 'today: 0' headline over a window that excludes today is a lie");
  assert.equal(v.totals.stops, 1);
});

test('ONE CUSTOMER WITH TWO DOCKS IS ONE ANSWER, WITH BOTH LOCATIONS NAMED', () => {
  // The database keys a customer by name+street+city+zip, so two warehouses are two keys.
  // Grouping by key would split the answer in half and show neither total — and the rep on
  // the phone asked about the company, not the dock.
  const v = buildCustomerView({
    query: 'earthly', name: 'EARTHLY ALTERNATIVE', today: '2026-09-18',
    window: { from: '2026-09-18', to: '2026-09-18', days: 1 },
    stops: [
      { date: '2026-09-18', source: 'board', stop: ea({ stopNbr: 'A' }) },
      { date: '2026-09-18', source: 'board', stop: ea({ stopNbr: 'B', addr1: '1100 NORTHSIDE DR', city: 'ATLANTA', zip: '30318' }) },
      { date: '2026-09-18', source: 'board', stop: ea({ stopNbr: 'C', addr1: '1100 NORTHSIDE DR', city: 'ATLANTA', zip: '30318' }) },
    ],
  });
  assert.equal(v.totals.stops, 3);
  assert.equal(v.locations.length, 2);
  assert.equal(v.locations[0].stops, 2, 'busiest dock first');
  assert.equal(v.locations[0].address.addr1, '1100 NORTHSIDE DR');
});

test('rows run in route order within a day — the order a rep reads a truck in', () => {
  const v = buildCustomerView({
    query: 'earthly', name: 'EARTHLY ALTERNATIVE', today: '2026-09-18',
    window: { from: '2026-09-18', to: '2026-09-18', days: 1 },
    stops: [
      { date: '2026-09-18', source: 'board', stop: ea({ stopNbr: 'A', loadStopSeq: 11 }) },
      { date: '2026-09-18', source: 'board', stop: ea({ stopNbr: 'B', loadStopSeq: 3 }) },
    ],
  });
  assert.deepEqual(v.rows.map((r) => r.seq), [3, 11]);
});

test('an empty answer is still a well-formed one', () => {
  const v = buildCustomerView({ query: 'nobody', name: 'NOBODY', today: '2026-09-18', window: { from: '2026-09-18', to: '2026-09-18', days: 1 } });
  assert.equal(v.totals.stops, 0);
  assert.deepEqual(v.days, []);
  assert.deepEqual(v.drivers, []);
  assert.deepEqual(v.locations, []);
});

// ── end to end, against the Firestore fake ───────────────────────────────────

test("THE QUESTION THAT PROMPTED THIS: today's deliveries, from the LIVE BOARD, with drivers", async () => {
  // The rollup cannot answer this — it is built from sealed history and today is not sealed.
  // Deliberately seeded with NOTHING in history_customers, so a pass proves the board sweep is
  // doing the work rather than a rollup that happened to be warm.
  const d = await today();
  const fake = installFirestoreFake({
    [`nuvizz_stop_index/${T}__${d}/stops/007180001`]: ea({ stopNbr: '007180001', deliveredDTTM: `${d}T10:21` }),
    [`nuvizz_stop_index/${T}__${d}/stops/007180002`]: ea({ stopNbr: '007180002', driverName: 'ROBERT MENSAH-ADDAI', loadStopSeq: 9, deliveredDTTM: `${d}T13:44` }),
    [`nuvizz_stop_index/${T}__${d}/stops/007180003`]: ea({ stopNbr: '007180003', normalizedStatus: 'OUT_FOR_DEL', deliveredDTTM: null, driverName: 'ROBERT MENSAH-ADDAI', loadStopSeq: 12 }),
    // A different customer on the same board — it must not be counted.
    [`nuvizz_stop_index/${T}__${d}/stops/007199999`]: ea({ stopNbr: '007199999', businessName: 'TITAN ELECTRIC' }),
  });
  try {
    const body = await call('name=earthly&date=' + d);
    assert.equal(body.ok, true);
    assert.equal(body.nuvizzCalls, 0);
    assert.equal(fake.log.other.length, 0, 'no non-Firestore call may be made');
    assert.equal(body.mode, 'customer');
    assert.equal(body.view.name, 'EARTHLY ALTERNATIVE');
    assert.equal(body.view.todayCounts.stops, 3, 'three stops today');
    assert.equal(body.view.todayCounts.delivered, 2, 'two of them delivered');
    assert.equal(body.view.todayCounts.open, 1, 'one still out');
    assert.deepEqual(body.view.drivers, [
      { driver: 'ROBERT MENSAH-ADDAI', stops: 2, delivered: 1 },
      { driver: 'ANDERSON FRIMPONG', stops: 1, delivered: 1 },
    ]);
  } finally { fake.restore(); }
});

test('a different customer on the same board is not counted', async () => {
  const d = await today();
  const fake = installFirestoreFake({
    [`nuvizz_stop_index/${T}__${d}/stops/1`]: ea({ stopNbr: '1' }),
    [`nuvizz_stop_index/${T}__${d}/stops/2`]: ea({ stopNbr: '2', businessName: 'EARTH FARE' }),
    [`nuvizz_stop_index/${T}__${d}/stops/3`]: ea({ stopNbr: '3', businessName: 'ALTERNATIVE ENERGY CO' }),
  });
  try {
    const body = await call(`name=earthly%20alternative&date=${d}`);
    assert.equal(body.mode, 'customer');
    assert.equal(body.view.totals.stops, 1);
  } finally { fake.restore(); }
});

test('SEVERAL BUSINESSES MATCH → THE REP CHOOSES, and each row carries its own count', async () => {
  // Silently picking one and reporting its count as the answer is the confidently-wrong
  // output this repo exists to avoid. The counts are already paid for by the sweep.
  const d = await today();
  const fake = installFirestoreFake({
    [`nuvizz_stop_index/${T}__${d}/stops/1`]: ea({ stopNbr: '1', businessName: 'EARTHLY ALTERNATIVE' }),
    [`nuvizz_stop_index/${T}__${d}/stops/2`]: ea({ stopNbr: '2', businessName: 'EARTHLY ALTERNATIVE' }),
    [`nuvizz_stop_index/${T}__${d}/stops/3`]: ea({ stopNbr: '3', businessName: 'EARTHLY GOODS' }),
  });
  try {
    const body = await call(`name=earthly&date=${d}`);
    assert.equal(body.mode, 'customer-choose');
    assert.equal(body.matches.length, 2);
    assert.equal(body.matches[0].name, 'EARTHLY ALTERNATIVE', 'the busiest today leads');
    assert.equal(body.matches[0].today, 2);
    assert.equal(body.matches[1].today, 1);

    // …and pinning one returns that one's view.
    const picked = await call(`name=earthly&date=${d}&nameKey=${body.matches[1].nameKey}`);
    assert.equal(picked.mode, 'customer');
    assert.equal(picked.view.name, 'EARTHLY GOODS');
    assert.equal(picked.view.totals.stops, 1);
  } finally { fake.restore(); }
});

test('the dispatcher note is joined by a DERIVED key, because the board carries none', async () => {
  // customer-key.mts exists because an alert once read 778 board rows with matchKey null on
  // every one and reported a clean day. A stored key cannot be trusted here; it is derived.
  const d = await today();
  const { normalizeMatchKey } = await import('../src/lib/matchKey.js');
  const key = normalizeMatchKey('EARTHLY ALTERNATIVE', '4200 WENDELL DR SW', 'ATLANTA', '30336');
  const fake = installFirestoreFake({
    [`nuvizz_stop_index/${T}__${d}/stops/1`]: ea({ stopNbr: '1' }),
    [`customer_notes/${key}`]: { notes: 'Receiving closes at 2pm sharp — call ahead', no_tractor: true },
  });
  try {
    const body = await call(`name=earthly&date=${d}`);
    assert.equal(body.view.notes.text, 'Receiving closes at 2pm sharp — call ahead');
    assert.deepEqual(body.view.notes.flags.map((f) => f.key), ['no_tractor']);
  } finally { fake.restore(); }
});

test('a sealed day OUTSIDE the board window is still found by the sweep', async () => {
  const d = addDays(await today(), -3);
  const fake = installFirestoreFake({ [`history_days/${T}__${d}/stops/1`]: ea({ stopNbr: '1', deliveredDTTM: `${d}T09:10` }) });
  try {
    const body = await call('name=earthly&days=7');
    assert.equal(body.view.totals.stops, 1);
    assert.equal(body.view.rows[0].source, 'sealed');
    assert.equal(body.view.todayCounts.stops, 0, 'and it is not today');
  } finally { fake.restore(); }
});

test('THE WINDOW IS CAPPED AT 14 DAYS AND THE ANSWER SAYS SO', async () => {
  // Every other screen using resolveRange reads ONE document per day. This reads a whole board
  // per day, twice. Sixty days would be ~84,000 document reads with a customer on the phone.
  const fake = installFirestoreFake({});
  try {
    const body = await call('name=earthly&days=60');
    assert.equal(body.window.days, 14);
    assert.match(body.window.clamped, /ceiling/);
  } finally { fake.restore(); }
});

test('a customer with NO stops in the window is still findable through the rollup', async () => {
  // "We have not been there recently" and "no such customer" must not render the same.
  const fake = installFirestoreFake({});
  try {
    const body = await call('name=earthly&days=1');
    assert.equal(body.ok, true);
    assert.ok(body.mode === 'customer' || body.mode === 'customer-choose');
    if (body.mode === 'customer') assert.equal(body.view.totals.stops, 0);
  } finally { fake.restore(); }
});

test('a failed board sweep is reported UNREAD, and never as a zero', async () => {
  // "Zero deliveries today" is a sentence a rep says to a customer. It must never be what a
  // broken read looks like.
  const d = await today();
  const fake = installFirestoreFake({ [`nuvizz_stop_index/${T}__${d}/stops/1`]: ea({ stopNbr: '1' }) });
  const fakeFetch = globalThis.fetch;
  let armed = false;
  globalThis.fetch = async (input, init) => {
    const u = String(input?.url ?? input);
    if (armed && u.includes('/nuvizz_stop_index/') && u.includes('/stops')) return new Response('boom', { status: 500 });
    return fakeFetch(input, init);
  };
  try {
    armed = true;
    const body = await call(`name=earthly&date=${d}`);
    const board = body.view.sources.find((s) => s.key === 'board');
    assert.equal(board.state, 'unread');
    assert.match(body.errors.board, /500/);
  } finally { globalThis.fetch = fakeFetch; fake.restore(); }
});

test('the sweep reads a MASKED board — it must not ship a whole board to find six rows', async () => {
  const d = await today();
  const fake = installFirestoreFake({ [`nuvizz_stop_index/${T}__${d}/stops/1`]: ea({ stopNbr: '1' }) });
  try {
    await call(`name=earthly&date=${d}`);
    const listed = fake.log.listMasks.filter((m) => m.path.includes('nuvizz_stop_index') && m.path.endsWith('/stops'));
    assert.ok(listed.length > 0, 'the board was listed');
    for (const l of listed) {
      assert.ok(l.mask.length > 0, `the board list must be masked: ${l.path}`);
      assert.ok(!l.mask.includes('raw'), 'and must never pull the whole raw NuVizz object');
      assert.ok(!l.mask.includes('allComments'));
    }
    const sealed = fake.log.listMasks.filter((m) => m.path.includes('history_days') && m.path.endsWith('/stops'));
    for (const l of sealed) assert.ok(l.mask.length > 0, `the sealed list must be masked too: ${l.path}`);
  } finally { fake.restore(); }
});

test('A BROKEN READ NEVER RENDERS AS A CUSTOMER THAT DOES NOT EXIST', async () => {
  // The first cut of this got it wrong: a 500 on the board sweep emptied the match list, the
  // chooser came back with nothing in it, and the screen said "no customer matches" about a
  // customer we deliver to every week. A rep repeats that sentence to the person on the phone.
  const d = await today();
  const fake = installFirestoreFake({ [`nuvizz_stop_index/${T}__${d}/stops/1`]: ea({ stopNbr: '1' }) });
  const fakeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = String(input?.url ?? input);
    if (u.includes('/nuvizz_stop_index/') && u.includes('/stops')) return new Response('boom', { status: 500 });
    return fakeFetch(input, init);
  };
  try {
    const body = await call(`name=earthly&date=${d}`);
    assert.equal(body.mode, 'customer', 'a view, not an empty chooser');
    assert.equal(body.view.complete, false, 'and it refuses to call the answer complete');
    assert.equal(body.view.sources.find((s) => s.key === 'board').state, 'unread');
    assert.match(body.errors.board, /500/);
  } finally { globalThis.fetch = fakeFetch; fake.restore(); }
});

test('a customer we genuinely have not been to reports COMPLETE, so the rep can say so', async () => {
  const fake = installFirestoreFake({});
  try {
    const body = await call('name=earthly%20alternative&days=7');
    assert.equal(body.mode, 'customer');
    assert.equal(body.view.complete, true);
    assert.equal(body.view.totals.stops, 0);
    assert.equal(body.view.name, 'earthly alternative', 'the name as typed, so the screen can say who it looked for');
  } finally { fake.restore(); }
});

test('ONE CLOCK DECIDES WHICH DAY IS TODAY — the server one that counted the stats', async () => {
  // Caught in a screenshot of this very screen: the header said "4 stops today" while the
  // TODAY chip sat on a different day. The stat tiles count against the SERVER's ET today;
  // if the day chip compared against the BROWSER's clock they can disagree — reachable at
  // 8pm ET, when a UTC browser has ticked over and the board has not, or on a bad clock.
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8'));
  assert.match(src, /\{day\.isToday && <span/, 'the chip must read the server-computed flag');
  assert.ok(!/CustomerDayHeading\({ day, today/.test(src), 'and must not take a client clock at all');
  // …and buildCustomerView is where that flag is set, off the `today` the endpoint passed.
  const v = buildCustomerView({
    query: 'earthly', name: 'EARTHLY ALTERNATIVE', today: '2026-09-18',
    window: { from: '2026-09-17', to: '2026-09-18', days: 2 },
    stops: [
      { date: '2026-09-18', source: 'board', stop: ea({ stopNbr: 'A' }) },
      { date: '2026-09-17', source: 'board', stop: ea({ stopNbr: 'B' }) },
    ],
  });
  assert.deepEqual(v.days.map((d) => [d.date, d.isToday]), [['2026-09-18', true], ['2026-09-17', false]]);
  assert.equal(v.todayCounts.stops, 1, 'and the tiles count the same day the chip marks');
});
