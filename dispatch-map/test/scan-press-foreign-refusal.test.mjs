// test/scan-press-foreign-refusal.test.mjs
//
// SOMEBODY ELSE'S REFUSAL TOLD A DISPATCHER THEIR OWN RUNNING SCAN "DID NOT RUN" (audit
// 2026-09-27, client-orders-labels-territory-libs-6).
//
// The Scan-now poll hands scanPressVerdict any refusal from the last ~2 minutes (the server
// only gives its age in whole minutes). scanPressVerdict looked at that refusal BEFORE it looked
// at the run ledger, so a refused press — an expired session, say — followed within two minutes
// by a dispatcher's press that DID start a scan answered the dispatcher, on their first poll,
// "Scan did not run. <the other person's refusal>", and stopped watching. Their scan went on
// and landed; the button had already told them the board would not refresh.
//
// What happens now: a real run of this press (in flight or finished) outranks a refusal. The
// refusal still wins when no run of this press is on the ledger — including when the newest
// ledger row is the refusal itself, which the gate files there as a finished row with
// outcome 'refused' and which is not a scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanPressVerdict } from '../src/lib/scan-press-verdict.js';

const foreign = { reason: 'expired', message: 'Scan refused: your session has expired.', ageMin: 1 };

test("a dispatcher whose scan is running is not told it did not run because of someone else's fresh refusal", () => {
  const v = scanPressVerdict({ updated: false, refusal: foreign, run: { startedAgeSec: 2, finished: false }, waitedSec: 3 });
  assert.equal(v.kind, 'running');
  assert.equal(v.done, false, 'the press keeps watching its own scan');
  assert.doesNotMatch(v.message, /did not run/);
});

test("a dispatcher whose scan finished is told it landed, not refused, when someone else's refusal is fresh", () => {
  const v = scanPressVerdict({ updated: false, refusal: foreign, run: { startedAgeSec: 50, finished: true, outcome: 'ok' }, waitedSec: 54 });
  assert.equal(v.kind, 'landed');
});

test("a dispatcher whose scan finished with an error hears that error, not someone else's refusal", () => {
  const v = scanPressVerdict({ updated: false, refusal: foreign, run: { startedAgeSec: 50, finished: true, outcome: 'error', error: 'NuVizz did not answer' }, waitedSec: 54 });
  assert.equal(v.kind, 'stalled');
  assert.match(v.message, /NuVizz did not answer/);
});

test('a press that WAS refused still hears the server\'s refusal verbatim — its own refusal row on the ledger is not a scan', () => {
  const own = { reason: 'role', message: 'Scan now needs the dispatcher role.', ageMin: 0 };
  const refusalRow = { startedAgeSec: 2, finished: true, outcome: 'refused', error: own.message };
  const v = scanPressVerdict({ updated: false, refusal: own, run: refusalRow, waitedSec: 3 });
  assert.equal(v.kind, 'refused');
  assert.equal(v.done, true);
  assert.equal(v.message, 'Scan did not run. Scan now needs the dispatcher role.');
});

test("an older scan somebody else started does not hide this press's refusal", () => {
  const own = { reason: 'role', message: 'Scan now needs the dispatcher role.', ageMin: 0 };
  const v = scanPressVerdict({ updated: false, refusal: own, run: { startedAgeSec: 300, finished: false }, waitedSec: 3 });
  assert.equal(v.kind, 'refused');
  assert.equal(v.done, true);
});
