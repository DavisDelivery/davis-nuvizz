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
// What happens now: the run ledger decides whose refusal it is. The gate files a refused press
// on the ledger (a finished row, outcome 'refused') BEFORE it stamps the refusal the poll reads,
// so a press that really was refused sees its own refused row as the newest run. A real run of
// this press outranks any refusal; this press's own refused row confirms it at once; and a
// refusal the ledger cannot place on this press — its scan has not written a row yet — waits,
// and is only the answer if nothing of this press ever shows up in the window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanPressVerdict, SCAN_POLL_WINDOW_SEC } from '../src/lib/scan-press-verdict.js';

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

test("on the first poll, before the dispatcher's own scan has written its row, someone else's refusal is not the answer yet", () => {
  // The finding's own timeline: refused at 06:00:10, the dispatcher presses at 06:00:40. On the
  // first poll the newest ledger row is still that refusal (33s old), because the dispatcher's
  // scan has not written its row. That row is older than this press, so it is not this press's.
  const theirRow = { startedAgeSec: 33, finished: true, outcome: 'refused', error: foreign.message };
  const first = scanPressVerdict({ updated: false, refusal: foreign, run: theirRow, waitedSec: 3 });
  assert.equal(first.done, false, 'the press keeps watching instead of telling the dispatcher it did not run');
  // Next poll: the dispatcher's scan is on the ledger.
  const next = scanPressVerdict({ updated: false, refusal: foreign, run: { startedAgeSec: 5, finished: false }, waitedSec: 6 });
  assert.equal(next.kind, 'running');
  assert.equal(next.done, false);
});

test("a refusal the ledger never places on this press is still the answer once the window is waited out", () => {
  const own = { reason: 'role', message: 'Scan now needs the dispatcher role.', ageMin: 0 };
  const older = { startedAgeSec: 300, finished: false };
  const early = scanPressVerdict({ updated: false, refusal: own, run: older, waitedSec: 3 });
  assert.equal(early.done, false, 'an older run somebody else started does not settle whose refusal this is');
  const end = scanPressVerdict({ updated: false, refusal: own, run: { startedAgeSec: 492, finished: false }, waitedSec: SCAN_POLL_WINDOW_SEC });
  assert.equal(end.kind, 'refused');
  assert.equal(end.done, true);
  assert.equal(end.message, 'Scan did not run. Scan now needs the dispatcher role.');
});

test('with no ledger reading at all a refusal is believed at once, as before', () => {
  const own = { reason: 'role', message: 'Scan now needs the dispatcher role.', ageMin: 0 };
  const v = scanPressVerdict({ updated: false, refusal: own, run: null, waitedSec: 3 });
  assert.equal(v.kind, 'refused');
  assert.equal(v.done, true);
});
