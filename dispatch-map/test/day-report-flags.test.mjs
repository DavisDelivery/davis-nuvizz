// DID THE BOARD WARN ABOUT THE STOPS THAT ENDED THE DAY OPEN?
//
// Chad: "in the nightly 630 email for things undelivered let me know if any of the steps were
// flagged." It splits one list into two different follow-ups — a stop that was flagged and
// missed anyway is a question about the RESPONSE; a stop nothing ever saw is a question about
// the RULE — and at half six today's email cannot tell them apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachFlagHistory, flagLabel, flagSummaryLine } from '../netlify/functions/lib/day-completion.mts';

const stop = (stopNbr, over = {}) => ({
  stopNbr, customer: 'ACME', route: 'SUW 2', driver: 'BEN 2', seq: 4,
  outcome: 'not_attempted', addr: '1 MAIN ST', ...over,
});
const base = () => ({
  date: '2026-08-26', asOf: '6:30p', planned: 20, gradable: 20, delivered: 17, open: 3,
  counts: { not_attempted: 2, in_flight: 0, unable: 1, cancelled: 0, delivered_system: 16, delivered_manual: 1 },
  completionRate: 0.85, manualRate: 0.06, byRoute: [],
  openStops: [stop('001'), stop('002')],
  unableStops: [stop('003', { outcome: 'unable' })],
  excluded: [], excludedStops: [],
});
// Real shape from eta_flag_history: a map keyed by stop number.
const HIST = { rows: {
  '001': { stopNbr: '001', firstTier: 'amber', worstTier: 'red', leadMin: 125, sweeps: 6, emailed: true },
  '003': { stopNbr: '003', firstTier: 'amber', worstTier: 'amber', leadMin: 20, sweeps: 2, emailed: false },
} };

test('a stop that WAS flagged is marked, with the worst tier and how much warning it gave', () => {
  const d = attachFlagHistory(base(), HIST);
  const s1 = d.openStops.find((s) => s.stopNbr === '001');
  assert.equal(s1.flag.tier, 'red', 'the WORST tier it reached, not the first');
  assert.equal(s1.flag.leadMin, 125);
  assert.equal(flagLabel(s1.flag), 'RED · 2h05m warning');
});

test('a stop nothing ever saw is marked as such — that is a different follow-up', () => {
  const d = attachFlagHistory(base(), HIST);
  assert.equal(d.openStops.find((s) => s.stopNbr === '002').flag, null);
  assert.equal(flagLabel(null), '');
});

test('unable-to-deliver stops are joined too, not just the open ones', () => {
  const d = attachFlagHistory(base(), HIST);
  assert.equal(d.unableStops[0].flag.tier, 'amber');
});

test('the summary line answers the question in one sentence', () => {
  const line = flagSummaryLine(attachFlagHistory(base(), HIST));
  assert.match(line, /2 of 3/);
  assert.match(line, /1 never flagged/);
  assert.match(line, /1 red/);
  assert.match(line, /1 amber/);
});

// ── ABSENT IS NOT ZERO ───────────────────────────────────────────────────────
test('an UNREADABLE history says so; it never reports that nobody was flagged', () => {
  // "0 of 3 were flagged" printed off a failed read says the detector stayed silent when the
  // truth is nobody looked — the absence-of-evidence mistake this engine was rescued from once.
  for (const doc of [null, undefined]) {
    const d = attachFlagHistory(base(), doc);
    assert.equal(d.flagJoin.available, false);
    assert.equal(d.openStops[0].flag, null);
    assert.match(flagSummaryLine(d), /history unavailable/);
    assert.ok(!/0 of 3/.test(flagSummaryLine(d)));
  }
});

test('a day with a readable history and genuinely no flags DOES say zero', () => {
  const d = attachFlagHistory(base(), { rows: {} });
  assert.equal(d.flagJoin.available, true);
  assert.equal(d.flagJoin.flagged, 0);
  assert.equal(d.flagJoin.unflagged, 3);
  assert.match(flagSummaryLine(d), /0 of 3/);
});

test('a history row with no tier is not a flag anybody saw', () => {
  const d = attachFlagHistory(base(), { rows: { '001': { stopNbr: '001', leadMin: 30, sweeps: 1 } } });
  assert.equal(d.openStops.find((s) => s.stopNbr === '001').flag, null);
  assert.equal(d.flagJoin.flagged, 0);
});

test('the join does not mutate the report it was handed', () => {
  const original = base();
  const d = attachFlagHistory(original, HIST);
  assert.equal(original.openStops[0].flag, undefined, 'the input must come back untouched');
  assert.ok(d !== original);
});

test('a bare map (no rows wrapper) and an array both join', () => {
  const bare = attachFlagHistory(base(), { '001': HIST.rows['001'] });
  assert.equal(bare.openStops[0].flag.tier, 'red');
  const arr = attachFlagHistory(base(), { rows: Object.values(HIST.rows) });
  assert.equal(arr.openStops[0].flag.tier, 'red');
});

test('lead time reads in the units a dispatcher thinks in', () => {
  assert.equal(flagLabel({ tier: 'red', leadMin: 45, sweeps: 1, emailed: false }), 'RED · 45m warning');
  assert.equal(flagLabel({ tier: 'critical', leadMin: 0, sweeps: 1, emailed: false }), 'CRITICAL · no warning');
  assert.equal(flagLabel({ tier: 'red', leadMin: -30, sweeps: 1, emailed: false }), 'RED · no warning');
  assert.equal(flagLabel({ tier: 'amber', leadMin: null, sweeps: 1, emailed: false }), 'AMBER');
});

test('a report that was never joined prints no flag line at all', () => {
  // The live preview endpoint does not read the history; it must not imply an answer.
  assert.equal(flagSummaryLine(base()), null);
});
