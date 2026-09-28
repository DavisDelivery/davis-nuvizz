// test/order-arrivals-unstamped-basis.test.mjs — client-orders-labels-territory-libs-2.
//
// The heavy-night reading projected tonight from STAMPED orders only (soFar / pace) and then
// compared that with a typical night's TOTAL, unstamped orders included. Any order on the board
// without an arrival stamp therefore shrank tonight's side of the comparison and pushed the
// verdict toward "normal" — the under-call the module's own header names as the expensive one.
//
// Read off the code, an unstamped order is one already ON the board: writeStops stamps every
// new board document with first_seen_at (firestore.mts firstSightStamps), and every other writer
// copies an existing document, stamps and all. So it is counted as in hand, and only the
// stamped part — the part with a pace — is projected forward.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCurve, buildBaseline, assess } from '../src/lib/order-arrivals.js';

const MON_612PM = Date.parse('2026-09-14T22:12:00Z');   // 6:12pm ET, building Tuesday
const TUE = '2026-09-15';
const arrivals = (n, isoUtc) => Array.from({ length: n }, () => ({ first_seen_at: isoUtc }));
const unstamped = (n) => Array.from({ length: n }, () => ({}));

// A typical Tuesday: 400 orders, 220 of them (55%) in by 6pm Monday, every one stamped.
const typicalTuesday = () => buildCurve({
  deliveryDate: TUE,
  stops: [...arrivals(220, '2026-09-14T20:00:00Z'), ...arrivals(180, '2026-09-15T03:00:00Z')],
});
const baseline = buildBaseline([typicalTuesday(), typicalTuesday(), typicalTuesday()]);

test('a heavier-than-normal Tuesday is still called heavy when some orders on the board carry no arrival stamp', () => {
  // Normal stamped pace (220 by 6pm → 400) PLUS 50 orders already on the board with no stamp:
  // 450 against a typical 400 is +12.5%, past the +8% line.
  const tonight = buildCurve({ deliveryDate: TUE, stops: [...arrivals(220, '2026-09-14T20:00:00Z'), ...unstamped(50)] });
  assert.ok(tonight.coverage >= 0.8, `coverage ${tonight.coverage} is above the floor, so it projects`);
  const a = assess({ curve: tonight, nowMs: MON_612PM, baseline });
  assert.equal(baseline.typicalFinal, 400);
  assert.equal(a.projected, 450, 'the unstamped orders on the board are part of tonight\'s total');
  assert.equal(a.verdict, 'heavy');
});

test('the evening sentence compares what is on the board with a typical total, on one basis', () => {
  const tonight = buildCurve({ deliveryDate: TUE, stops: [...arrivals(220, '2026-09-14T20:00:00Z'), ...unstamped(50)] });
  const a = assess({ curve: tonight, nowMs: MON_612PM, baseline });
  assert.match(a.text, /270 in hand/, `every order on the board is in hand, stamped or not: ${a.text}`);
  assert.match(a.text, /usually has 220 by now/);
  assert.match(a.text, /tracking to ~450 \(\+50 vs a typical 400\)/);
});

test('a fully stamped night reads exactly as before', () => {
  const tonight = buildCurve({ deliveryDate: TUE, stops: arrivals(220, '2026-09-14T20:00:00Z') });
  const a = assess({ curve: tonight, nowMs: MON_612PM, baseline });
  assert.equal(a.projected, 400);
  assert.equal(a.verdict, 'normal');
  assert.match(a.text, /^220 in hand/);
});
