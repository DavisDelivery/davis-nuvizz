// test/cs-notify-window.test.mjs
//
// Chad, 8/10: "DSV came in on Friday. The moment the scan picked it up on Friday, it
// should have sent the email. Why is it sending the email today? It's too late."
//
// The CS email used to ride the scan's WRITE targets — today plus the next 1-2 business
// days, and future days only from 10:00 ET. So the trigger was "this delivery date's
// board got built", not "we saw the order". An order landing Friday for Tuesday was in
// every weekend pull and reported none of them; it went out on Monday's first post-10am
// tick. pendingNotifyDates is what widens the notify to the whole ±7d pull the scan
// already makes — for free, since the rows are in hand either way.
//
// These tests pin the two ways that can go wrong: notifying too little (the original
// bug) and notifying too much (spraying CS with far-future or historical days).
import test from 'node:test';
import assert from 'node:assert/strict';

import { pendingNotifyDates, NOTIFY_PULL_HORIZON_DAYS, alreadySent, collectHits } from '../netlify/functions/lib/cs-notify.mts';
import { normalizeMatchKey } from '../netlify/functions/lib/match-key.mts';

// The real shape: a ±7d pull bucketed by day, around Friday 2026-08-07.
const FRIDAY_PULL = [
  '2026-07-31', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',  // past
  '2026-08-07',                                                          // today (Fri)
  '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14',  // ahead
];

test('THE BUG: Tuesday is in Friday\'s pull, and Friday now notifies it', () => {
  // Friday's write targets with the 3-business-day horizon. Even at its widest the write
  // horizon stops at Tuesday; a narrower horizon (or any scan before 10:00 ET, when the
  // targets are today ONLY) leaves Tuesday unreported. The pull has it either way.
  const narrowTargets = ['2026-08-07', '2026-08-10'];  // horizon=2 — Tue never written Friday
  const days = pendingNotifyDates(FRIDAY_PULL, '2026-08-07', narrowTargets);
  assert.ok(days.includes('2026-08-11'), 'Tuesday 8/11 must get a notify pass on Friday');
});

test('a scan before 10:00 ET — targets are TODAY only — still sweeps every future day', () => {
  // scanDecision gates every future day behind hour>=10, so an 06:00 scan writes only
  // today. That is a WRITE budget decision (loads, enrichment); it must not silence CS.
  const days = pendingNotifyDates(FRIDAY_PULL, '2026-08-07', ['2026-08-07']);
  assert.deepEqual(days, ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']);
});

test('days the write loop already notified are NOT swept again', () => {
  // The loop emails off the ENRICHED stop for the days it writes; re-sweeping them here
  // would just re-read the same ledger for no reason.
  const days = pendingNotifyDates(FRIDAY_PULL, '2026-08-07', ['2026-08-07', '2026-08-10', '2026-08-11']);
  assert.deepEqual(days, ['2026-08-12', '2026-08-13', '2026-08-14']);
  assert.ok(!days.includes('2026-08-07'), 'today is always a write target — never swept twice');
});

test('past days are never swept — a delivered board is history, not a heads-up', () => {
  const days = pendingNotifyDates(FRIDAY_PULL, '2026-08-07', []);
  assert.ok(days.every((d) => d >= '2026-08-07'), `swept a past day: ${JSON.stringify(days)}`);
  assert.ok(!days.includes('2026-08-06'));
  assert.ok(days.includes('2026-08-07'), 'today is swept when the write loop somehow did not');
});

test('the sweep stops at the pull\'s own reach — a stray far-future row cannot spray emails', () => {
  // boardDayFor takes the date NuVizz reports; a fat-fingered 2027 arrival would otherwise
  // become a CS email today. The active search is +/-7d, so anything past that is noise.
  const days = pendingNotifyDates(
    [...FRIDAY_PULL, '2026-08-15', '2026-09-30', '2027-01-04'], '2026-08-07', [],
  );
  assert.ok(days.includes('2026-08-14'), 'the last day the pull genuinely reaches is in');
  assert.ok(!days.includes('2026-08-15'), 'one day past the window is out');
  assert.ok(!days.includes('2027-01-04'), 'a bogus far-future date is out');
  assert.equal(NOTIFY_PULL_HORIZON_DAYS, 7, 'the default matches NUVIZZ_ACTIVE_ARRIVAL +/-7d');
});

test('junk bucket keys are dropped rather than emailed', () => {
  const days = pendingNotifyDates(
    ['2026-08-11', '', null, undefined, 'today', '2026-8-11', '20260811'], '2026-08-07', [],
  );
  assert.deepEqual(days, ['2026-08-11']);
});

test('the result is sorted and de-duplicated (soonest day first)', () => {
  const days = pendingNotifyDates(
    ['2026-08-12', '2026-08-10', '2026-08-11', '2026-08-10'], '2026-08-07', [],
  );
  assert.deepEqual(days, ['2026-08-10', '2026-08-11', '2026-08-12']);
});

test('an empty pull sweeps nothing (a failed list pull must not look like a quiet day)', () => {
  assert.deepEqual(pendingNotifyDates([], '2026-08-07', ['2026-08-07']), []);
});

test('it takes the scan\'s real inputs: a Map iterator of buckets and the targets array', () => {
  // The call site is pendingNotifyDates(buckets.keys(), today, targets) — buckets is a
  // Map keyed by day, targets a string[]. Both are consumed once, so anything that
  // iterated them twice internally would silently return nothing on the second pass.
  const buckets = new Map(FRIDAY_PULL.map((d) => [d, [{ stopNbr: `x-${d}` }]]));
  const days = pendingNotifyDates(buckets.keys(), '2026-08-07', ['2026-08-07', '2026-08-10']);
  assert.deepEqual(days, ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']);
  // And every day it returns can actually be looked up in that same Map — the bucket keys
  // and the scan's board dates are the same frame (etDateForTargetUTC is an identity here).
  for (const d of days) assert.ok(buckets.get(d)?.length, `no rows for ${d}`);
});

test('horizonDays=0 collapses the sweep to today only', () => {
  assert.deepEqual(pendingNotifyDates(FRIDAY_PULL, '2026-08-07', [], 0), ['2026-08-07']);
});

// ── the ledger: sending EARLIER must not mean sending TWICE ──────────────────
//
// The new risk the early pass introduces. The same order is now seen twice: once as a
// raw saved-search row, and again on its write day after enrichment replaced the address
// with the /stop/info version. If those two normalize to different match keys, the
// customer axis alone would treat the second sighting as new and CS gets a duplicate.

// The two shapes of the same customer. Left: the raw saved-search row. Right: what the
// board holds after enrichment folds in the /stop/info address (a suite line appears).
const RAW = { businessName: 'DSV CONTRACT LOGISTICS LLC', addr1: '300 RIVERSIDE PKWY', city: 'LITHIA SPRINGS', zip: '30122' };
const ENRICHED = { ...RAW, addr1: '300 RIVERSIDE PKWY STE 200' };
const EARLY_KEY = normalizeMatchKey(RAW.businessName, RAW.addr1, RAW.city, RAW.zip);
const ENRICHED_KEY = normalizeMatchKey(ENRICHED.businessName, ENRICHED.addr1, ENRICHED.city, ENRICHED.zip);

test('the fixture is honest: enrichment really does move this customer to a different key', () => {
  assert.notEqual(EARLY_KEY, ENRICHED_KEY, 'if these matched, the dedup tests below would prove nothing');
});

test('an empty ledger sends', () => {
  assert.equal(alreadySent(null, EARLY_KEY, '007159533'), false);
  assert.equal(alreadySent({}, EARLY_KEY, '007159533'), false);
  assert.equal(alreadySent({ notified: {}, notifiedStops: {} }, EARLY_KEY, '007159533'), false);
});

test('THE DUPLICATE GUARD: the enriched sighting is recognised even when its key drifted', () => {
  const ledger = { notified: { [EARLY_KEY]: '2026-08-07T20:00:00Z' }, notifiedStops: { '007159533': '2026-08-07T20:00:00Z' } };
  assert.equal(alreadySent(ledger, ENRICHED_KEY, '007159533'), true,
    'same order, address rewritten by enrichment — must NOT email CS a second time');
});

test('the customer axis still holds on its own (a second ORDER for the same customer that day)', () => {
  const ledger = { notified: { [EARLY_KEY]: '2026-08-07T20:00:00Z' }, notifiedStops: { '007159533': '2026-08-07T20:00:00Z' } };
  assert.equal(alreadySent(ledger, EARLY_KEY, '007160001'), true, 'one email per marked customer per date');
});

test('a DIFFERENT customer and a different order still sends', () => {
  const ledger = { notified: { [EARLY_KEY]: 'x' }, notifiedStops: { '007159533': 'x' } };
  assert.equal(alreadySent(ledger, 'someone_else__1_main_st__dalton__30721', '007160002'), false);
});

test('a blank stop number never suppresses, and never matches a blank ledger entry', () => {
  const ledger = { notified: {}, notifiedStops: { '': 'x', '007159533': 'x' } };
  assert.equal(alreadySent(ledger, 'new_customer__x__y__30000', ''), false);
  assert.equal(alreadySent(ledger, 'new_customer__x__y__30000', null), false);
  assert.equal(alreadySent(ledger, 'new_customer__x__y__30000', undefined), false);
});

test('a legacy ledger with no notifiedStops still dedupes on the customer axis', () => {
  // Every ledger doc written before this change has only `notified`.
  const legacy = { notified: { [EARLY_KEY]: '2026-08-07T20:00:00Z' } };
  assert.equal(alreadySent(legacy, EARLY_KEY, '007159533'), true);
  assert.equal(alreadySent(legacy, ENRICHED_KEY, '007159533'), false,
    'a legacy doc cannot know the stop number — this is the one case that can still double, and only once');
});

test('stop numbers are compared trimmed, as strings', () => {
  const ledger = { notifiedStops: { '007159533': 'x' } };
  assert.equal(alreadySent(ledger, 'k', ' 007159533 '), true);
  assert.equal(alreadySent(ledger, 'k', '007159534'), false, 'a neighbouring PRO is a different order');
});

// ── collectHits: one email per marked customer, but EVERY order stamped ──────

test('collectHits ignores customers with no flag on', () => {
  const marked = new Set([EARLY_KEY]);
  const hits = collectHits([{ ...RAW, stopNbr: '007159533' }, { businessName: 'SOMEONE ELSE', addr1: '1 MAIN ST', city: 'DALTON', zip: '30721', stopNbr: '007160000' }], marked);
  assert.equal(hits.size, 1);
  assert.deepEqual([...hits.keys()], [EARLY_KEY]);
});

test('THE TWO-ORDERS CASE: one email, but both order numbers go into the ledger', () => {
  // This is the hole a customer-only ledger leaves. CS is emailed early off order A's raw
  // row; on the write day the enriched address re-keys the customer and `hits` happens to
  // pick order B — neither the new key nor B's number is in the ledger, so CS is told
  // twice about a customer they already heard about. Stamping every matched order number
  // on send is what closes it.
  const marked = new Set([EARLY_KEY]);
  const hits = collectHits([
    { ...RAW, stopNbr: '007159533' },
    { ...RAW, stopNbr: '007159999' },
  ], marked);
  assert.equal(hits.size, 1, 'one email for the customer, not one per order');
  const hit = hits.get(EARLY_KEY);
  assert.equal(hit.stop.stopNbr, '007159533', 'the email names the first order seen');
  assert.deepEqual(hit.nbrs, ['007159533', '007159999'], 'but BOTH are stamped into the ledger');

  // Replay the write-day pass: the address has drifted, so it lands on the other key and
  // could pick the other order. Both are already in the ledger → nothing is sent.
  const ledger = { notified: { [EARLY_KEY]: 'x' }, notifiedStops: Object.fromEntries(hit.nbrs.map((n) => [n, 'x'])) };
  const later = collectHits([{ ...ENRICHED, stopNbr: '007159999' }, { ...ENRICHED, stopNbr: '007159533' }], new Set([ENRICHED_KEY]));
  const laterHit = later.get(ENRICHED_KEY);
  assert.ok(laterHit.nbrs.some((n) => alreadySent(ledger, ENRICHED_KEY, n)), 'the second sighting is recognised despite the new key');
});

test('collectHits works off a Map too — loadMarkedCustomers returns match_key → name', () => {
  const marked = new Map([[EARLY_KEY, 'DSV CONTRACT LOGISTICS LLC']]);
  const hits = collectHits([{ ...RAW, stopNbr: '007159533' }], marked);
  assert.equal(hits.size, 1);
});

test('collectHits survives a ragged batch: nulls, blank numbers, repeats', () => {
  const marked = new Set([EARLY_KEY]);
  const hits = collectHits([
    null, undefined,
    { ...RAW, stopNbr: '  007159533  ' },
    { ...RAW, stopNbr: '007159533' },   // same order twice in one pull
    { ...RAW, stopNbr: null },          // a row with no number at all
    { ...RAW },
  ], marked);
  assert.deepEqual(hits.get(EARLY_KEY).nbrs, ['007159533'], 'trimmed and de-duplicated; blanks dropped');
});

test('collectHits on an empty batch hits nothing', () => {
  assert.equal(collectHits([], new Set([EARLY_KEY])).size, 0);
  assert.equal(collectHits(null, new Set([EARLY_KEY])).size, 0);
});

// ── the Monday-morning case, end to end ──────────────────────────────────────
test('MONDAY 06:00: the 8/11 order is reported four hours before the old code could', () => {
  // What actually happened: Monday's scans before 10:00 targeted 8/10 only, so 8/11 was
  // never looked at; the 10:16 tick was the first to add it and the email went out then.
  const mondayPull = ['2026-08-07', '2026-08-10', '2026-08-11', '2026-08-12'];
  const beforeTen = pendingNotifyDates(mondayPull, '2026-08-10', ['2026-08-10']);
  assert.ok(beforeTen.includes('2026-08-11'), 'the 06:00 scan now reports the 8/11 order');
});
