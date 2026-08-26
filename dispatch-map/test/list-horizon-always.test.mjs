// test/list-horizon-always.test.mjs
//
// THE CALLS WE MAKE TODAY SHOULD BE POPULATING TOMORROW'S BOARD.
//
// Chad, the morning after the feed-window fix, on a board where tomorrow was still empty
// before 10am: "the calls we make today should be populating tomorrow's board."
//
// He is describing an invariant, and the arithmetic backs it. The list-discovery path makes
// ONE ±7d saved-search pull that already contains tomorrow's rows and the day after's; which
// of those days gets WRITTEN is pure Firestore. So gating the write on an ET-hour window
// (tomorrow-orders from 10:00, tomorrow-loads from 20:00 — both inherited from the
// number-probe era, where a future day meant its own expensive descent) returns no NuVizz
// call to the budget. It only discards rows the scan already paid for, and it left tomorrow's
// board unwritten from midnight to 10:00 ET every single day. The live ledger for the morning
// this was found: the ONLY fire that wrote tomorrow before 10:00 was a MANUAL scan at 06:30.
//
// This is a source-level guard for the same reason scan-stamp-order.test.mjs is one — the
// rule lives inside one long handler that cannot be invoked without Firestore and a vendor,
// and what can regress is exactly the thing the source says. It is written to FAIL if anyone
// reintroduces the hour gate on the list path's write targets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanDatesFrom } from '../netlify/functions/lib/refresh-stops-core.mts';

const SRC = readFileSync(new URL('../netlify/functions/lib/refresh-stops-core.mts', import.meta.url), 'utf8');
const listBlock = () => {
  const start = SRC.indexOf('if (LIST_DISCOVERY) {');
  assert.ok(start > 0, 'found the list-discovery block');
  return SRC.slice(start, SRC.indexOf('src=list-only'));
};

test('the list path writes the WHOLE horizon — its targets are not narrowed by the ET hour', () => {
  const block = listBlock();
  const assign = block.indexOf('const targets =');
  assert.ok(assign > 0, 'found the write-target assignment');

  // The whole horizon, unconditionally. `scanDates` is today + the next LIST_HORIZON_DAYS-1
  // business days, which is precisely the set the ±7d pull already answered for.
  assert.match(block.slice(assign, assign + 60), /const targets = \[\.\.\.scanDates\]/);

  // And nothing may push the far days back behind a feed window. This is the mutation the
  // guard exists to catch: restoring `if (decision.scanTomorrowLoads || ...) targets.push(...)`
  // re-freezes tomorrow's board for the ten hours before 10:00 ET.
  const gated = /targets\.push|targets\s*=\s*\[today\]/.test(block);
  assert.equal(gated, false, 'list-path write targets must not be rebuilt behind an hour gate');
});

test('the hour windows still govern the PROBE path, where a future day is genuinely expensive', () => {
  // The gates are not wrong, they are wrong HERE. In the number-probe fallback a future day
  // means its own load-number window plus an order descent, so refusing it before those orders
  // exist is real money saved. Deleting them there would be a separate, costly bug.
  const probe = SRC.slice(SRC.indexOf('src=list-only'));
  assert.match(probe, /decision\.scanTomorrowLoads/, 'probe path still consults the loads window');
  assert.match(probe, /decision\.scanTomorrowUnplanned/, 'probe path still consults the orders window');
});

test("a Friday scan still writes MONDAY and TUESDAY — the horizon is business days, not +1/+2", () => {
  // Widening the gate must not quietly change WHICH days the horizon covers: Saturday
  // delivers nothing, so a Friday fire has to reach across the weekend or Monday's board is
  // the one that starts empty.
  assert.deepEqual(scanDatesFrom('2026-08-28', 3), ['2026-08-28', '2026-08-31', '2026-09-01']);
  // And a midweek fire is simply the next two days.
  assert.deepEqual(scanDatesFrom('2026-08-26', 3), ['2026-08-26', '2026-08-27', '2026-08-28']);
});
