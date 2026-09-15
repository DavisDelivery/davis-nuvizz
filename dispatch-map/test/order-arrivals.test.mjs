// WHEN THE FREIGHT LANDED, AND WHETHER 6PM CAN SEE A HEAVY NIGHT COMING.
//
// The night this is built for: Mon 2026-09-14, 6:12pm ET, Chad building Tuesday's loads and
// asking whether tomorrow is heavier than a normal Tuesday. Uline's forecast said 779 and the
// nightly manifest would not exist for another two hours — both end-of-night answers to a
// question asked in the evening. These tests pin the evening answer.
//
// Every refusal is tested as hard as every verdict. A projection this module declines to make
// is the output that keeps a wrong number off the screen, and a wrong number here becomes a
// driver called in or not called in.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rollInstant, leadHoursFor, clockLabelFor, buildCurve, inHandAt, buildBaseline, assess,
  sealedDoc, sameWeekdayDates, LEAD_MAX_HOURS, MIN_COVERAGE, MIN_BASELINE_DAYS,
  MIN_PROJECT_FRACTION, HEAVY_RATIO, LIGHT_RATIO,
} from '../src/lib/order-arrivals.js';

// 6:12pm ET on Mon 2026-09-14 — the moment Chad asked. EDT, so UTC-4.
const MON_612PM = Date.parse('2026-09-14T22:12:00Z');
// The delivery day that evening is building: Tue 2026-09-15.
const TUE = '2026-09-15';

const stopAt = (iso) => ({ enriched_at: iso });
/** n orders first seen at the given ET clock time on the given date. */
const arrivals = (n, isoUtc) => Array.from({ length: n }, () => stopAt(isoUtc));

test('the lead axis is measured from the delivery day 5am ET roll, not midnight', () => {
  // 5am ET on Tue 9/15 under EDT is 09:00 UTC.
  assert.equal(rollInstant(TUE), Date.parse('2026-09-15T09:00:00Z'));
  // 6:12pm Monday (22:12 UTC) is 10.8 hours before that roll.
  assert.equal(Math.round(leadHoursFor(MON_612PM, TUE) * 10) / 10, 10.8);
});

test('the roll survives a DST flip — a November delivery is still 5am ET, not 5am UTC-4', () => {
  // 2026-11-01 is the EDT→EST flip. Mon 2026-11-02 is EST, so 5am ET is 10:00 UTC.
  assert.equal(rollInstant('2026-11-02'), Date.parse('2026-11-02T10:00:00Z'));
  // And a July day is EDT: 5am ET is 09:00 UTC. A fixed offset would get one of these wrong.
  assert.equal(rollInstant('2026-07-15'), Date.parse('2026-07-15T09:00:00Z'));
});

test('an order first seen at 6pm Monday reads back as "Mon 6pm" on a Tuesday board', () => {
  const lead = leadHoursFor(Date.parse('2026-09-14T22:00:00Z'), TUE);
  assert.equal(clockLabelFor(lead, TUE), 'Mon 6pm');
  // And the Monday board's equivalent lead is a SUNDAY evening — the reason the axis is lead
  // hours and not "the day before". Monday's freight is Friday's ship.
  assert.equal(clockLabelFor(lead, '2026-09-14'), 'Sun 6pm');
});

test('a stop with no arrival stamp is counted, never silently dropped', () => {
  // The failure this prevents: a third of the freight unstamped reads as a light night, and a
  // light night is a driver sent home.
  const curve = buildCurve({
    deliveryDate: TUE,
    stops: [...arrivals(60, '2026-09-14T20:00:00Z'), ...Array.from({ length: 40 }, () => ({}))],
  });
  assert.equal(curve.stamped, 60);
  assert.equal(curve.unstamped, 40);
  assert.equal(curve.total, 100);
  assert.equal(curve.coverage, 0.6);
});

test('orders older than the bucket window land in the early bucket rather than vanishing', () => {
  const curve = buildCurve({ deliveryDate: TUE, stops: arrivals(5, '2026-09-01T12:00:00Z') });
  assert.equal(curve.buckets[LEAD_MAX_HOURS], 5);
  assert.equal(curve.stamped, 5);
  // And they still count as in hand at any lead.
  assert.equal(inHandAt(curve, 10.8), 5);
});

test('a same-day add lands after the roll and is reported, not hidden in the evening', () => {
  // 9am Tuesday is AFTER Tuesday's 5am roll: negative lead.
  const curve = buildCurve({ deliveryDate: TUE, stops: arrivals(3, '2026-09-15T13:00:00Z') });
  assert.equal(curve.afterRoll, 3);
  assert.equal(curve.buckets[0], 3);
  // It is not in hand at 6pm the night before — which is the point.
  assert.equal(inHandAt(curve, 10.8), 0);
});

// ── the evening question ─────────────────────────────────────────────────────

/** A typical Tuesday: 780 orders, 55% of them in by 6pm Monday, the rest overnight. */
const typicalTuesday = (final, atSixPm) => buildCurve({
  deliveryDate: TUE,
  stops: [
    ...arrivals(atSixPm, '2026-09-14T20:00:00Z'),          // 4pm ET Monday — lead 13, in hand by 6pm
    ...arrivals(final - atSixPm, '2026-09-15T03:00:00Z'),  // 11pm ET Monday — lead 6, the overnight flood
  ],
});

test('with three sealed Tuesdays the pacing model projects the night from a 6pm count', () => {
  const baseline = buildBaseline([
    typicalTuesday(780, 429), typicalTuesday(760, 418), typicalTuesday(800, 440),
  ]);
  assert.equal(baseline.ready, true);
  assert.equal(baseline.typicalFinal, 780);

  // Tonight: 429 in hand at 6pm — dead on the normal pace.
  const tonight = buildCurve({ deliveryDate: TUE, stops: arrivals(429, '2026-09-14T20:00:00Z') });
  const a = assess({ curve: tonight, nowMs: MON_612PM, baseline });
  assert.equal(a.verdict, 'normal');
  assert.equal(a.soFar, 429);
  assert.equal(a.projected, 780);
});

test('a heavy night is CALLED at 6pm — the whole reason this exists', () => {
  const baseline = buildBaseline([typicalTuesday(780, 429), typicalTuesday(760, 418), typicalTuesday(800, 440)]);
  // 500 in hand where a Tuesday normally has 429 → tracking to ~909.
  const tonight = buildCurve({ deliveryDate: TUE, stops: arrivals(500, '2026-09-14T20:00:00Z') });
  const a = assess({ curve: tonight, nowMs: MON_612PM, baseline });
  assert.equal(a.verdict, 'heavy');
  assert.ok(a.projected > 860, `projected ${a.projected} should be well over a typical 780`);
  assert.match(a.text, /tracking to/);
  // The dispatcher's two numbers are both in the sentence: what we have, what is normal.
  assert.match(a.text, /500 in hand/);
  assert.match(a.text, /usually has 429/);
});

test('LIGHT waits for -15% while HEAVY fires at +8% — under-staffing is the expensive mistake', () => {
  assert.ok(HEAVY_RATIO < 1.10, 'heavy must fire early; a short route is cheaper than carryover');
  assert.ok(LIGHT_RATIO <= 0.85, 'light must be obvious before we stand anyone down');
  const baseline = buildBaseline([typicalTuesday(780, 429), typicalTuesday(760, 418), typicalTuesday(800, 440)]);

  // 5% over normal pace is NOT heavy — that is a wobble, not a warning.
  const mild = buildCurve({ deliveryDate: TUE, stops: arrivals(450, '2026-09-14T20:00:00Z') });
  assert.equal(assess({ curve: mild, nowMs: MON_612PM, baseline }).verdict, 'normal');

  // 10% under normal pace is NOT light either — we do not send a driver home on 10%.
  const slightlyDown = buildCurve({ deliveryDate: TUE, stops: arrivals(386, '2026-09-14T20:00:00Z') });
  assert.equal(assess({ curve: slightlyDown, nowMs: MON_612PM, baseline }).verdict, 'normal');

  // 25% under is light and says so.
  const quiet = buildCurve({ deliveryDate: TUE, stops: arrivals(322, '2026-09-14T20:00:00Z') });
  assert.equal(assess({ curve: quiet, nowMs: MON_612PM, baseline }).verdict, 'light');
});

// ── the four refusals, each named ────────────────────────────────────────────

test('two sealed Tuesdays is not a normal — it says so instead of inventing one', () => {
  const baseline = buildBaseline([typicalTuesday(780, 429), typicalTuesday(760, 418)]);
  assert.equal(baseline.ready, false);
  const a = assess({ curve: typicalTuesday(780, 429), nowMs: MON_612PM, baseline });
  assert.equal(a.verdict, 'unknown');
  assert.equal(a.why, 'no baseline');
  assert.match(a.text, new RegExp(`2 of ${MIN_BASELINE_DAYS}`));
  // The raw count is still given — it is useful without a baseline.
  assert.equal(a.soFar, 429);
});

test('thin arrival-stamp coverage refuses the projection and names the coverage', () => {
  // THE PREMISE-FAILURE GUARD. If enriched_at turns out sparse in the real index, the screen
  // must say so rather than project off whatever fraction happens to carry a stamp.
  const baseline = buildBaseline([typicalTuesday(780, 429), typicalTuesday(760, 418), typicalTuesday(800, 440)]);
  const thin = buildCurve({
    deliveryDate: TUE,
    stops: [...arrivals(200, '2026-09-14T20:00:00Z'), ...Array.from({ length: 300 }, () => ({}))],
  });
  assert.ok(thin.coverage < MIN_COVERAGE);
  const a = assess({ curve: thin, nowMs: MON_612PM, baseline });
  assert.equal(a.verdict, 'unknown');
  assert.equal(a.why, 'coverage');
  assert.match(a.text, /40% of today's orders carry an arrival stamp/);
});

test('too early in the night, the count is given and the projection is refused', () => {
  const baseline = buildBaseline([typicalTuesday(780, 429), typicalTuesday(760, 418), typicalTuesday(800, 440)]);
  // Saturday morning, ~67 hours before Tuesday's roll: almost nothing has landed and dividing
  // by a 0.0x fraction would print four figures from a handful of orders.
  const early = Date.parse('2026-09-12T14:00:00Z');
  const curve = buildCurve({ deliveryDate: TUE, stops: arrivals(12, '2026-09-12T13:00:00Z') });
  const a = assess({ curve, nowMs: early, baseline });
  assert.equal(a.verdict, 'unknown');
  assert.equal(a.why, 'too early');
  assert.equal(a.projected, null);
  assert.ok(MIN_PROJECT_FRACTION > 0);
});

test('a night with no stamped orders never drags the baseline toward zero', () => {
  // A day the scan never ran is not a quiet Tuesday. Including it would halve every fraction
  // and make the next ordinary Tuesday read HEAVY.
  const blank = buildCurve({ deliveryDate: '2026-09-08', stops: [] });
  const baseline = buildBaseline([typicalTuesday(780, 429), typicalTuesday(760, 418), typicalTuesday(800, 440), blank]);
  assert.equal(baseline.n, 3, 'the empty night is excluded from the baseline');
  assert.equal(baseline.typicalFinal, 780);
});

test('the sealed document carries the counts that say how much of the night it describes', () => {
  const curve = buildCurve({
    deliveryDate: TUE,
    stops: [...arrivals(60, '2026-09-14T20:00:00Z'), ...Array.from({ length: 40 }, () => ({}))],
  });
  const doc = sealedDoc(curve, { sealedAt: '2026-09-16T06:00:00.000Z' });
  assert.equal(doc.total, 100);
  assert.equal(doc.stamped, 60);
  assert.equal(doc.unstamped, 40);
  assert.equal(doc.coverage, 0.6);
  assert.equal(doc.sealedAt, '2026-09-16T06:00:00.000Z');
  assert.ok(Array.isArray(doc.buckets));
});

test('the baseline looks back same-weekday only, and never at the day being judged', () => {
  const dates = sameWeekdayDates(TUE, 6);
  assert.equal(dates.length, 6);
  assert.ok(!dates.includes(TUE));
  assert.deepEqual(dates.slice(0, 3), ['2026-09-08', '2026-09-01', '2026-08-25']);
});

test('an hour that has not happened yet is null, never zero', async () => {
  // "Absent is not zero" — a column of zeros running into tomorrow morning reads as a collapse
  // in volume, and this repo has shipped that mistake before.
  const { checkpoints } = await import('../src/lib/order-arrivals.js');
  const baseline = buildBaseline([typicalTuesday(780, 429), typicalTuesday(760, 418), typicalTuesday(800, 440)]);
  const tonight = buildCurve({ deliveryDate: TUE, stops: arrivals(429, '2026-09-14T20:00:00Z') });
  const rows = checkpoints({ curve: tonight, baseline, nowMs: MON_612PM, deliveryDate: TUE });
  const byLead = Object.fromEntries(rows.map((r) => [r.lead, r]));
  // 6:12pm Monday is lead 10.8, so the 11-lead checkpoint (Mon 6pm) has been reached...
  assert.equal(byLead[11].reached, true);
  assert.equal(byLead[11].soFar, 429);
  // ...and Tue 3am has not.
  assert.equal(byLead[2].reached, false);
  assert.equal(byLead[2].soFar, null);
  // The typical column is populated for every hour, reached or not — that is the whole point.
  assert.ok(Number.isFinite(byLead[2].typical));
});

// ── THE STAMP ITSELF, AFTER THE FIRST ONE TURNED OUT TO BE EMPTY ─────────────
//
// Measured on the live index, 2026-09-14: enriched_at was on 2 of 643 stops on tomorrow's
// board, and on a past Tuesday listUpdatedDTTM had drifted onto the delivery day for 650 of
// 704 — the arrival time overwritten by the delivery flip. These pin the replacement.

test('a zone-less ET string is read as ET, not as the runtime zone, in BOTH seasons', async () => {
  // Date.parse would read NuVizz's "2026-09-14T19:05:00" in the runtime zone — UTC on Netlify
  // — filing a 7pm ET arrival four hours early and shifting a whole evening's curve. Silent,
  // plausible, and wrong.
  const { etLocalToInstant } = await import('../src/lib/order-arrivals.js');
  assert.equal(new Date(etLocalToInstant('2026-09-14T19:05:00')).toISOString(), '2026-09-14T23:05:00.000Z', 'EDT is UTC-4');
  assert.equal(new Date(etLocalToInstant('2026-12-01T08:00:00')).toISOString(), '2026-12-01T13:00:00.000Z', 'EST is UTC-5');
  assert.equal(etLocalToInstant(''), null);
  assert.equal(etLocalToInstant('not a date'), null);
});

test('the vendor stamp outranks our scan clock, and the legacy field is last', async () => {
  const { stampInstant } = await import('../src/lib/order-arrivals.js');
  // All three present: NuVizz's own frozen stamp wins — it is the vendor's clock, and earlier.
  const all = stampInstant({ arrived_list_dttm: '2026-09-14T19:05:00', first_seen_at: '2026-09-14T23:10:00Z', enriched_at: '2026-09-10T12:00:00Z' });
  assert.equal(all.from, 'arrived_list_dttm');
  assert.equal(all.ms, Date.parse('2026-09-14T23:05:00Z'));
  // Without it, our scan clock.
  assert.equal(stampInstant({ first_seen_at: '2026-09-14T23:10:00Z', enriched_at: '2026-09-10T12:00:00Z' }).from, 'first_seen_at');
  // And enriched_at only as a last resort — it was measured at 2 of 643.
  assert.equal(stampInstant({ enriched_at: '2026-09-10T12:00:00Z' }).from, 'enriched_at');
  assert.equal(stampInstant({}), null);
  assert.equal(stampInstant(null), null);
});

test('the curve reports WHICH field each stamp came from', async () => {
  // A curve resting on the legacy fallback must not look like one built on the vendor stamp.
  const curve = buildCurve({
    deliveryDate: TUE,
    stops: [
      ...Array.from({ length: 3 }, () => ({ arrived_list_dttm: '2026-09-14T16:00:00Z'.replace('Z', '') })),
      ...Array.from({ length: 2 }, () => ({ first_seen_at: '2026-09-14T20:00:00Z' })),
      { enriched_at: '2026-09-14T20:00:00Z' },
    ],
  });
  assert.equal(curve.stamped, 6);
  assert.deepEqual(curve.sources, { arrived_list_dttm: 3, first_seen_at: 2, enriched_at: 1 });
});

test('a thinly-stamped night never becomes a normal Tuesday', () => {
  // THE FAILURE THIS PREVENTS, measured: every day indexed before the first-sight stamp
  // shipped carries almost no stamps. buildBaseline only drops a night at ZERO, so a 2-of-643
  // night would sail through a "> 0" filter and drag every projection that later used it.
  const thin = { ...typicalTuesday(780, 429), total: 643, stamped: 2, coverage: 2 / 643 };
  const baseline = buildBaseline([typicalTuesday(780, 429), typicalTuesday(760, 418), typicalTuesday(800, 440), thin]);
  assert.equal(baseline.n, 3, 'the thin night is excluded');
  assert.equal(baseline.typicalFinal, 780);
});
