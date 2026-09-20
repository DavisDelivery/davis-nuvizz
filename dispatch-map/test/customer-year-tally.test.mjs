// test/customer-year-tally.test.mjs — THE MONTHLY TALLY THAT MAKES "THIS YEAR" POSSIBLE.
//
// Chad, 2026-09-19: "I want there to be a this year button in the date ranges."
//
// The customer view answers a window by reading a whole board per day, twice. A year of that
// is ~510,000 document reads — it does not finish, and nobody waits for it with a customer on
// the phone. So the year is counted ONCE at write time, by the nightly hook that already
// visits every customer of every sealed day.
//
// The two things these tests exist for, in order of what they cost to get wrong:
//   1. A RE-RUN MUST NOT DOUBLE A MONTH. The backfill is documented as safely re-runnable and
//      overlapping ranges are expected. An additive counter with no memory of which days it
//      counted turns one re-run into twice the freight.
//   2. AN UN-BACKFILLED MONTH MUST NOT READ AS ZERO. "0 deliveries this year" is a sentence a
//      rep says out loud to a customer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import {
  monthOf, emptyMonth, tallyBucket, mergeMonthTallies, mergeDriverTallies, countedDaysOf,
  buildRollupsFromStops,
} from '../netlify/functions/lib/history-customers.mts';

const MK = 'earthly_alternative__4200_wendell_dr_sw__atlanta__30336';

/** One sealed warehouse stop, in the shape buildStopRecord writes. */
const seal = (over = {}) => ({
  customerMatchKey: MK, businessName: 'EARTHLY ALTERNATIVE',
  addr1: '4200 WENDELL DR SW', city: 'ATLANTA', state: 'GA', zip: '30336',
  pro: '007180001', stopNbr: '007180001', date: '2026-09-18',
  driverName: 'ANDERSON FRIMPONG', normalizedStatus: 'DELIVERED', ...over,
});

// ── which bucket a stop falls in ──────────────────────────────────────────────

test('a stop is counted as delivered, came-back or refused — never two of them', () => {
  assert.equal(tallyBucket(seal()), 'delivered');
  assert.equal(tallyBucket(seal({ normalizedStatus: 'EXCEPTION' })), 'exceptions');
  assert.equal(tallyBucket(seal({ normalizedStatus: 'CANCELLED' })), 'exceptions');
  assert.equal(tallyBucket(seal({ normalizedStatus: 'SCHEDULED', isAttempt: true })), 'attempted');
  // The ATT marker lands on the SHIPMENT number, never on stopNbr — the same signal the
  // attempts feature keys on (lib/nuvizz-scan.mts isAttemptShipment).
  assert.equal(tallyBucket(seal({ normalizedStatus: 'SCHEDULED', shipmentNbr: 'ATT007180001' })), 'attempted');
  // A stop that simply never reached a terminal status is counted as a VISIT and nothing
  // else. Guessing it into one of the three would put freight in a column it never earned.
  assert.equal(tallyBucket(seal({ normalizedStatus: 'SCHEDULED' })), null);
});

test('the month is the day it happened, and nothing clever', () => {
  assert.equal(monthOf('2026-09-18'), '2026-09');
  assert.equal(monthOf(''), '');
});

// ── a day's contribution ──────────────────────────────────────────────────────

test("one day's stops become one month bucket, with the days it counted written down", () => {
  const rollups = buildRollupsFromStops([
    seal({ pro: 'A' }),
    seal({ pro: 'B' }),
    seal({ pro: 'C', normalizedStatus: 'EXCEPTION', driverName: 'ROBERT MENSAH' }),
  ]);
  const cur = rollups.get(MK);
  const m = cur.months['2026-09'];
  assert.deepEqual(m.days, ['2026-09-18']);
  assert.deepEqual(m.byDay['2026-09-18'], { stops: 3, delivered: 2, attempted: 0, exceptions: 1 });
  assert.deepEqual(cur.driversByDay['2026-09-18'], {
    'ANDERSON FRIMPONG': { stops: 2, delivered: 2 },
    'ROBERT MENSAH': { stops: 1, delivered: 0 },
  });
});

test('a stop with no driver is counted as a visit and invents nobody', () => {
  const cur = buildRollupsFromStops([seal({ driverName: null, driverUserName: null })]).get(MK);
  assert.equal(cur.months['2026-09'].byDay['2026-09-18'].stops, 1);
  assert.deepEqual(cur.driversByDay, {});
});

// ── THE RE-RUN HAZARD ─────────────────────────────────────────────────────────

test('RE-COUNTING A DAY ALREADY COUNTED IS A NO-OP — a re-run costs time and nothing else', () => {
  // nuvizz-rebuild-customer-history-background says in its own header that overlapping ranges
  // are safe. An additive counter with no day set would make a re-run report twice the freight
  // we moved, and nothing on screen would look wrong.
  const day = buildRollupsFromStops([seal({ pro: 'A' }), seal({ pro: 'B' })]).get(MK).months;
  const once = mergeMonthTallies({}, day);
  const twice = mergeMonthTallies(once, day);
  const thrice = mergeMonthTallies(twice, day);
  assert.equal(once['2026-09'].stops, 2);
  assert.equal(twice['2026-09'].stops, 2, 'the second run must add nothing');
  assert.equal(thrice['2026-09'].stops, 2, 'and so must the third');
  assert.deepEqual(thrice['2026-09'].days, ['2026-09-18']);
});

test('a DIFFERENT day in the same month does add', () => {
  const d18 = buildRollupsFromStops([seal({ pro: 'A' })]).get(MK).months;
  const d19 = buildRollupsFromStops([seal({ pro: 'B', date: '2026-09-19' }), seal({ pro: 'C', date: '2026-09-19' })]).get(MK).months;
  const merged = mergeMonthTallies(mergeMonthTallies({}, d18), d19);
  assert.equal(merged['2026-09'].stops, 3);
  assert.deepEqual(merged['2026-09'].days, ['2026-09-18', '2026-09-19']);
});

test('months are kept apart, and an untouched month survives the merge untouched', () => {
  const aug = buildRollupsFromStops([seal({ pro: 'A', date: '2026-08-04' })]).get(MK).months;
  const sep = buildRollupsFromStops([seal({ pro: 'B' })]).get(MK).months;
  const merged = mergeMonthTallies(mergeMonthTallies({}, aug), sep);
  assert.equal(merged['2026-08'].stops, 1);
  assert.equal(merged['2026-09'].stops, 1);
});

test('the driver tally is bounded — a decade of turnover cannot grow the document forever', () => {
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`DRIVER ${i}`, { stops: i, delivered: i }]));
  const merged = mergeDriverTallies(many, {}, new Set(), 40);
  assert.equal(Object.keys(merged).length, 40);
  assert.ok(merged['DRIVER 59'], 'the busiest are the ones kept');
  assert.ok(!merged['DRIVER 0']);
});

test('an absent tally merges to an empty one rather than throwing', () => {
  assert.deepEqual(mergeMonthTallies(undefined, undefined), {});
  assert.deepEqual(mergeDriverTallies(null, null), {});
  assert.deepEqual([...countedDaysOf(null)], []);
  assert.deepEqual(emptyMonth(), { stops: 0, delivered: 0, attempted: 0, exceptions: 0 });
});

// ── end to end, through the real writer ───────────────────────────────────────

test('THE NIGHTLY WRITER ACCUMULATES THE YEAR, AND NEVER WIPES WHAT IT ALREADY HELD', async () => {
  // setDoc REPLACES the whole document, so a field the writer forgets to re-state is a year of
  // counts gone on the next nightly run. This drives two real days through the real writer and
  // asserts the first day survived the second.
  const fake = installFirestoreFake({});
  try {
    const { updateCustomerRollupsForDay, getCustomerByMatchKey } = await import('../netlify/functions/lib/history-customers.mts');
    await updateCustomerRollupsForDay('davis', '2026-08-04', [seal({ pro: 'A', date: '2026-08-04' })]);
    await updateCustomerRollupsForDay('davis', '2026-09-18', [
      seal({ pro: 'B' }), seal({ pro: 'C', normalizedStatus: 'EXCEPTION' }),
    ]);
    const c = await getCustomerByMatchKey('davis', MK);
    assert.equal(c.months['2026-08'].stops, 1, "August must survive September's write");
    assert.equal(c.months['2026-09'].stops, 2);
    assert.equal(c.months['2026-09'].exceptions, 1);
    assert.equal(c.drivers['ANDERSON FRIMPONG'].stops, 3);
    assert.equal(c.drivers['ANDERSON FRIMPONG'].delivered, 2);
    assert.equal(c.monthsFrom, '2026-08-04', 'and the tally says how far back it has counted');
    // The existing fields are untouched by all of this.
    assert.equal(c.name, 'EARTHLY ALTERNATIVE');
    assert.equal(c.pros.length, 3);
  } finally { fake.restore(); }
});

test('RUNNING THE BACKFILL TWICE OVER THE SAME DAY DOES NOT DOUBLE THE YEAR', async () => {
  const fake = installFirestoreFake({});
  try {
    const { updateCustomerRollupsForDay, getCustomerByMatchKey } = await import('../netlify/functions/lib/history-customers.mts');
    const stops = [seal({ pro: 'A' }), seal({ pro: 'B' })];
    await updateCustomerRollupsForDay('davis', '2026-09-18', stops);
    await updateCustomerRollupsForDay('davis', '2026-09-18', stops);
    const c = await getCustomerByMatchKey('davis', MK);
    assert.equal(c.months['2026-09'].stops, 2, 'not 4');
    assert.equal(c.drivers['ANDERSON FRIMPONG'].stops, 2, 'and the driver tally holds too');
  } finally { fake.restore(); }
});

test('A ROLLUP WRITTEN BEFORE THIS SHIPPED READS AS ABSENT, NOT AS ZERO', async () => {
  // The distinction the whole feature turns on. An old document has no months at all; the
  // reader must be able to tell that from a customer we genuinely did not deliver to.
  const fake = installFirestoreFake({
    'history_customers/davis__old_customer': {
      match_key: 'old_customer', tenant: 'davis', name: 'OLD CUSTOMER',
      pros: [{ pro: '1', date: '2026-01-02' }], last_date: '2026-01-02',
    },
  });
  try {
    const { getCustomerByMatchKey } = await import('../netlify/functions/lib/history-customers.mts');
    const c = await getCustomerByMatchKey('davis', 'old_customer');
    assert.equal(c.months, null, 'absent, not {}');
    assert.equal(c.monthsFrom, null);
  } finally { fake.restore(); }
});

// ── THE YEAR VIEW, and the endpoint mode that serves it ──────────────────────

test('A YEAR IN PROGRESS HAS NO DECEMBER — an unreached month is not a month we did nothing in', async () => {
  const { monthsOfYear, buildCustomerYear } = await import('../src/lib/stop-lookup.js');
  assert.deepEqual(monthsOfYear('2026', '2026-03-04'), ['2026-01', '2026-02', '2026-03']);
  assert.equal(monthsOfYear('2025', '2026-09-19').length, 12, 'a year already past shows all twelve');
  const v = buildCustomerYear({ year: '2026', today: '2026-03-04', customers: [] });
  assert.equal(v.months.length, 3);
});

test('AN UNCOUNTED MONTH IS NOT A ZERO, and the totals refuse to include it', async () => {
  // The distinction the whole feature turns on. A tally backfilled only from March cannot say
  // anything about January — and "0 deliveries" is what a rep reads out to a customer.
  const { buildCustomerYear } = await import('../src/lib/stop-lookup.js');
  const v = buildCustomerYear({
    year: '2026', today: '2026-04-10',
    customers: [{ monthsFrom: '2026-03-02', months: { '2026-03': { stops: 4, delivered: 4 } }, drivers: {} }],
  });
  const by = Object.fromEntries(v.months.map((m) => [m.month, m]));
  assert.equal(by['2026-01'].uncounted, true, 'before the tally started');
  assert.equal(by['2026-02'].uncounted, true);
  assert.equal(by['2026-03'].uncounted, false);
  assert.equal(by['2026-04'].uncounted, false, 'after it started, an empty month is a REAL zero');
  assert.equal(by['2026-04'].stops, 0);
  assert.equal(v.totals.stops, 4, 'uncounted months contribute nothing rather than zero');
  assert.equal(v.wholeYear, false, 'and the answer knows it does not cover the whole year');
  assert.equal(v.uncountedMonths, 2);
});

test('a tally that reaches back past January covers the whole year and says so', async () => {
  const { buildCustomerYear } = await import('../src/lib/stop-lookup.js');
  const v = buildCustomerYear({
    year: '2026', today: '2026-09-19',
    customers: [{ monthsFrom: '2025-11-04', months: { '2026-02': { stops: 3, delivered: 3 } }, drivers: {} }],
  });
  assert.equal(v.wholeYear, true);
  assert.equal(v.uncountedMonths, 0);
});

test('NO TALLY AT ALL READS AS ABSENT — the screen must not print a year of zeros', async () => {
  const { buildCustomerYear } = await import('../src/lib/stop-lookup.js');
  const v = buildCustomerYear({ year: '2026', today: '2026-09-19', customers: [{ monthsFrom: null, months: null, drivers: null }] });
  assert.equal(v.counted, false);
  assert.equal(v.totals.stops, 0);
  assert.ok(v.months.every((m) => m.uncounted), 'every month is uncounted, not zero');
});

test("TWO DOCKS ARE ONE CUSTOMER'S YEAR — summed, not shown as halves", async () => {
  const { buildCustomerYear } = await import('../src/lib/stop-lookup.js');
  const v = buildCustomerYear({
    year: '2026', today: '2026-09-19',
    customers: [
      { matchKey: 'a', addr1: '4200 WENDELL DR SW', city: 'ATLANTA', zip: '30336', monthsFrom: '2026-01-02', months: { '2026-09': { stops: 6, delivered: 5, attempted: 1 } }, drivers: { ANDERSON: { stops: 6, delivered: 5 } } },
      { matchKey: 'b', addr1: '1100 NORTHSIDE DR NW', city: 'ATLANTA', zip: '30318', monthsFrom: '2026-01-02', months: { '2026-09': { stops: 2, delivered: 2 } }, drivers: { ROBERT: { stops: 2, delivered: 2 } } },
    ],
  });
  assert.equal(v.totals.stops, 8);
  assert.equal(v.totals.delivered, 7);
  assert.equal(v.totals.attempted, 1);
  assert.equal(v.locations.length, 2);
  assert.equal(v.locations[0].stops, 6, 'busiest dock first');
  assert.deepEqual(v.drivers.map((d) => d.driver), ['ANDERSON', 'ROBERT']);
});

test('ONE DOCK MISSING ITS TALLY MAKES THE WHOLE CUSTOMER PARTIAL', async () => {
  // Half an answer presented as a whole one is the failure mode here: summing a counted dock
  // with an uncounted one silently under-reports the customer.
  const { buildCustomerYear } = await import('../src/lib/stop-lookup.js');
  const v = buildCustomerYear({
    year: '2026', today: '2026-09-19',
    customers: [
      { matchKey: 'a', monthsFrom: '2026-01-02', months: { '2026-09': { stops: 6 } }, drivers: {} },
      { matchKey: 'b', monthsFrom: null, months: null, drivers: null },
    ],
  });
  assert.equal(v.monthsFrom, null, 'no common start, so no month can be called counted-from');
  assert.equal(v.wholeYear, false);
});

test('THE YEAR ENDPOINT READS THE ROLLUP AND NOT ONE BOARD DAY', async () => {
  // The whole cost argument. If this ever starts listing day collections, the button is back
  // to half a million reads and a timeout.
  const key = 'earthly_alternative__4200_wendell_dr_sw__atlanta__30336';
  const fake = installFirestoreFake({
    [`history_customers/davis__${key}`]: {
      match_key: key, tenant: 'davis', name: 'EARTHLY ALTERNATIVE', name_lower: 'earthly alternative',
      name_tokens: ['ea', 'ear', 'eart', 'earth', 'earthl', 'earthly', 'al', 'alt', 'alte', 'alter', 'altern', 'alterna', 'alternat', 'alternati', 'alternativ', 'alternative'],
      addr1: '4200 WENDELL DR SW', city: 'ATLANTA', state: 'GA', zip: '30336',
      pros: [], last_date: '2026-09-18', months_from: '2026-01-05',
      months: { '2026-08': { stops: 18, delivered: 17, attempted: 1, exceptions: 0, days: [] }, '2026-09': { stops: 11, delivered: 10, attempted: 0, exceptions: 1, days: [] } },
      drivers: { 'ANDERSON FRIMPONG': { stops: 20, delivered: 19 }, 'ROBERT MENSAH-ADDAI': { stops: 9, delivered: 8 } },
    },
  });
  try {
    const handler = (await import('../netlify/functions/stop-lookup.mts')).default;
    const body = await (await handler(new Request('https://x/.netlify/functions/stop-lookup?name=earthly%20alternative&year=2026'))).json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'customer-year');
    assert.equal(body.nuvizzCalls, 0);
    assert.equal(body.view.totals.stops, 29);
    assert.equal(body.view.totals.delivered, 27);
    assert.equal(body.view.wholeYear, false, 'counted from January 5th, so January is partial');
    assert.deepEqual(body.view.drivers.map((d) => d.driver), ['ANDERSON FRIMPONG', 'ROBERT MENSAH-ADDAI']);

    // NOT ONE day collection may be listed.
    const dayLists = fake.log.lists.filter((p) => /nuvizz_stop_index|history_days/.test(p));
    assert.deepEqual(dayLists, [], `the year must read no board or warehouse day: ${dayLists.join(', ')}`);
    assert.equal(fake.log.other.filter((o) => !o.url.includes(':runQuery')).length, 0, 'and nothing but Firestore');

    // …and the ledger says the day sources were skipped ON PURPOSE, not overlooked.
    const by = Object.fromEntries(body.sources.map((s) => [s.key, s]));
    assert.equal(by.board.state, 'skipped');
    assert.match(by.board.note, /510,000|stop-by-stop/);
  } finally { fake.restore(); }
});

test('a malformed year is refused rather than turned into a path', async () => {
  const fake = installFirestoreFake({});
  try {
    const handler = (await import('../netlify/functions/stop-lookup.mts')).default;
    const r = await handler(new Request('https://x/.netlify/functions/stop-lookup?name=earthly&year=../secrets'));
    assert.equal(r.status, 400);
  } finally { fake.restore(); }
});

test('AN ABSENT TALLY RENDERS AS A DASH, NEVER AS A ZERO', async () => {
  // Caught in a screenshot of this exact state: the banner correctly said "we have no yearly
  // tally", and four big zeros sat directly underneath it. A rep skimming reads the zeros.
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8'));
  assert.match(src, /\{blank \? '—' : n\}/, 'the stat tile must be able to show no-figure');
  const tiles = /<CustStat n=\{t\.stops\}[^/]*\/>/.exec(src);
  assert.ok(tiles, 'the year tiles exist');
  assert.match(tiles[0], /blank=\{!v\.counted\}/, 'and go blank when the tally is absent');
  assert.match(src, /\? <><span className="font-semibold">\{l\.stops\}<\/span> stop\{l\.stops === 1 \? '' : 's'\} counted<\/>/,
    'the per-location count is gated the same way');
});

// ── THE TALLY'S OWN RANGE (v1.49.2) — "counted, and zero" needs a global fact ─────────────
//
// After the 2026-09-19 backfill the real Earthly Alternative rollup read monthsFrom
// 2026-07-24 (their first captured delivery) and the year screen said June was "not counted
// yet — we do not know what it held". June 4–30 HAD been counted for everyone; Earthly simply
// had nothing in it. A per-customer monthsFrom is the first day that customer HAD stops, so it
// can never say "counted, and zero". The writer now keeps ONE global range, and the year rule
// prefers it. These pin the merge, the stamp, the rule, and the endpoint reading it.

import {
  TALLY_RANGE_PATH, mergeTallyRange, readTallyRange, stampTallyRange,
} from '../netlify/functions/lib/history-customers.mts';
import { buildCustomerYear } from '../src/lib/stop-lookup.js';

test('mergeTallyRange: min/max, order-free, and a malformed date changes nothing', () => {
  assert.deepEqual(mergeTallyRange(null, '2026-09-18'), { months_from: '2026-09-18', counted_through: '2026-09-18' });
  const a = mergeTallyRange({ months_from: '2026-09-01', counted_through: '2026-09-18' }, '2026-06-04');
  assert.deepEqual(a, { months_from: '2026-06-04', counted_through: '2026-09-18' }, 'a backfill running newest-first still lands on the right floor');
  const b = mergeTallyRange(a, '2026-09-19');
  assert.deepEqual(b, { months_from: '2026-06-04', counted_through: '2026-09-19' });
  assert.deepEqual(mergeTallyRange(b, 'garbage'), b);
  assert.deepEqual(mergeTallyRange({ months_from: 'x', counted_through: null }, '2026-07-01'), { months_from: '2026-07-01', counted_through: '2026-07-01' }, 'a corrupt stored value is replaced, not propagated');
});

test('THE WRITER STAMPS THE RANGE once per day, field-masked, and re-running a day leaves it unchanged', async () => {
  const fake = installFirestoreFake({});
  try {
    const { updateCustomerRollupsForDay } = await import('../netlify/functions/lib/history-customers.mts');
    await updateCustomerRollupsForDay('davis', '2026-09-18', [seal({ pro: 'B' })]);
    await updateCustomerRollupsForDay('davis', '2026-06-04', [seal({ pro: 'A', date: '2026-06-04' })]);
    const doc = fake.store.get(TALLY_RANGE_PATH);
    assert.equal(doc.months_from, '2026-06-04');
    assert.equal(doc.counted_through, '2026-09-18');
    const patches = (fake.log.patches || []).filter((p) => p.path === TALLY_RANGE_PATH);
    assert.ok(patches.length >= 2, 'written with a field mask, never a blind replace');
    assert.ok(patches.every((p) => p.mask.every((k) => ['months_from', 'counted_through', 'updated_at'].includes(k))), 'only its own fields');
    const before = patches.length;
    await updateCustomerRollupsForDay('davis', '2026-08-04', [seal({ pro: 'C', date: '2026-08-04' })]);
    assert.equal((fake.log.patches || []).filter((p) => p.path === TALLY_RANGE_PATH).length, before, 'a day inside the range writes nothing');
    assert.deepEqual(await readTallyRange(), { monthsFrom: '2026-06-04', countedThrough: '2026-09-18' });
  } finally { fake.restore(); }
});

test('stampTallyRange never throws — a range write that fails must not fail the day it records', async () => {
  const r = await stampTallyRange('2026-09-18', { getDoc: async () => { throw new Error('down'); }, updateDocFields: async () => { throw new Error('down'); } });
  assert.equal(r, null);
  assert.equal(await stampTallyRange('nope'), null);
});

test('readTallyRange: absent or corrupt → null, never a guessed floor', async () => {
  assert.equal(await readTallyRange({ getDoc: async () => null }), null);
  assert.equal(await readTallyRange({ getDoc: async () => ({ months_from: 'soon' }) }), null);
  assert.deepEqual(await readTallyRange({ getDoc: async () => ({ months_from: '2026-06-04', counted_through: 'x' }) }), { monthsFrom: '2026-06-04', countedThrough: null });
});

test('THE EARTHLY CASE: with the global range, June is a REAL ZERO and the floor is June 4 — not July 24', () => {
  const v = buildCustomerYear({
    year: '2026', today: '2026-09-19',
    customers: [{ monthsFrom: '2026-07-24', months: { '2026-07': { stops: 1, delivered: 1 }, '2026-09': { stops: 1, delivered: 1 } }, drivers: {} }],
    tally: { monthsFrom: '2026-06-04', countedThrough: '2026-09-18' },
  });
  const by = Object.fromEntries(v.months.map((m) => [m.month, m]));
  assert.equal(v.counted, true);
  assert.equal(v.monthsFrom, '2026-06-04', 'the floor is the day counting started for everyone');
  assert.equal(v.countedThrough, '2026-09-18');
  assert.equal(by['2026-05'].uncounted, true, 'before the warehouse: unknown');
  assert.equal(by['2026-06'].uncounted, false, 'June was counted — they were not there');
  assert.equal(by['2026-06'].stops, 0);
  assert.equal(by['2026-08'].uncounted, false);
  assert.equal(by['2026-09'].stops, 1);
  assert.equal(v.uncountedMonths, 5, 'Jan–May');
  assert.equal(v.uncountedAfter, 0);
  assert.equal(v.wholeYear, false);
  assert.equal(v.totals.stops, 2);
});

test('with the global range a customer with NO months is "zero since the floor", not "no tally yet"', () => {
  const v = buildCustomerYear({ year: '2026', today: '2026-09-19', customers: [{ monthsFrom: null, months: null, drivers: null }], tally: { monthsFrom: '2026-06-04', countedThrough: '2026-09-18' } });
  assert.equal(v.counted, true);
  assert.equal(v.totals.stops, 0);
  assert.equal(v.months.find((m) => m.month === '2026-07').uncounted, false);
  assert.equal(v.months.find((m) => m.month === '2026-03').uncounted, true);
});

test('MONTHS THE NIGHTLY HAS NOT REACHED ARE UNCOUNTED, NOT ZERO — and counted separately from "before we started"', () => {
  const v = buildCustomerYear({ year: '2026', today: '2026-09-19', customers: [{ monthsFrom: '2026-07-24', months: { '2026-07': { stops: 1, delivered: 1 } }, drivers: {} }], tally: { monthsFrom: '2026-06-04', countedThrough: '2026-08-31' } });
  const by = Object.fromEntries(v.months.map((m) => [m.month, m]));
  assert.equal(by['2026-09'].uncounted, true, 'September is past the last counted day');
  assert.equal(by['2026-08'].uncounted, false, 'August is inside the range: a real zero');
  assert.equal(v.uncountedAfter, 1);
  assert.equal(v.uncountedMonths, 6, 'Jan–May plus September');
  assert.equal(v.wholeYear, false);
});

test('wholeYear needs the range to cover the last month on screen, not just to start before January', () => {
  const docs = [{ monthsFrom: '2026-02-01', months: { '2026-02': { stops: 3, delivered: 3 } }, drivers: {} }];
  assert.equal(buildCustomerYear({ year: '2026', today: '2026-09-19', customers: docs, tally: { monthsFrom: '2025-11-04', countedThrough: '2026-09-18' } }).wholeYear, true);
  assert.equal(buildCustomerYear({ year: '2026', today: '2026-09-19', customers: docs, tally: { monthsFrom: '2025-11-04', countedThrough: '2026-08-31' } }).wholeYear, false);
  assert.equal(buildCustomerYear({ year: '2026', today: '2026-09-19', customers: docs, tally: { monthsFrom: '2026-01-15', countedThrough: '2026-09-18' } }).wholeYear, false, 'started mid-January');
});

test('with NO range on file the per-dock rule still applies, unchanged — its caution is the right caution', () => {
  const v = buildCustomerYear({ year: '2026', today: '2026-09-19', customers: [{ monthsFrom: '2026-07-24', months: { '2026-07': { stops: 1, delivered: 1 } }, drivers: {} }] });
  assert.equal(v.monthsFrom, '2026-07-24');
  assert.equal(v.countedThrough, null);
  assert.equal(v.months.find((m) => m.month === '2026-06').uncounted, true);
  assert.equal(v.uncountedAfter, 0);
});

test('THE YEAR ENDPOINT READS THE RANGE and the answer carries the global floor and names the source', async () => {
  const fake = installFirestoreFake({
    [`history_customers/davis__${MK}`]: {
      match_key: MK, tenant: 'davis', name: 'EARTHLY ALTERNATIVE', name_lower: 'earthly alternative', name_tokens: ['earthly', 'alternative', 'e', 'ea', 'ear', 'eart', 'earth', 'earthl', 'earthly', 'a', 'al', 'alt', 'alte', 'alter', 'altern', 'alterna', 'alternat', 'alternati', 'alternativ', 'alternative'],
      addr1: '4200 WENDELL DR SW', city: 'ATLANTA', state: 'GA', zip: '30336', pros: [{ pro: '007152060', date: '2026-07-24', driver: 'Olamide Kazeem' }], pro_index: ['007152060'],
      months: { '2026-07': { stops: 1, delivered: 1, attempted: 0, exceptions: 0, days: ['2026-07-24'] } }, drivers: {}, months_from: '2026-07-24', last_date: '2026-07-24',
    },
    [TALLY_RANGE_PATH]: { months_from: '2026-06-04', counted_through: '2026-09-18', updated_at: '2026-09-20T00:04:47Z' },
  });
  try {
    const handler = (await import('../netlify/functions/stop-lookup.mts')).default;
    const body = await (await handler(new Request('https://x.netlify.app/.netlify/functions/stop-lookup?name=earthly&year=2026'))).json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'customer-year');
    assert.equal(body.nuvizzCalls, 0);
    assert.equal(body.view.monthsFrom, '2026-06-04');
    assert.equal(body.view.countedThrough, '2026-09-18');
    assert.equal(body.view.months.find((m) => m.month === '2026-06').uncounted, false, 'June is a zero on the wire, not a gap');
    const src = body.sources.find((r) => r.key === 'tally');
    assert.equal(src.state, 'found');
    assert.match(src.note, /from 2026-06-04 through 2026-09-18/);
    assert.equal(fake.log.other.length, 0, 'ZERO NuVizz calls');
  } finally { fake.restore(); }
});
