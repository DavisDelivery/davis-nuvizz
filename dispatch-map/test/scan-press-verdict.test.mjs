// test/scan-press-verdict.test.mjs — what the dispatcher is told after pressing "Scan now".
//
// Every case here is a real one. Chad, 2026-09-10 8:01pm: "Manual Refresh button is not
// working. Timed out and said it wouldn't update." The run ledger for that press: started
// 20:01, zero NuVizz calls recorded, no board written, still open seven minutes later — a
// vendor request with no deadline had wedged the scan. The button waited its ~60 seconds and
// said "Scan running — the board will refresh automatically", which was false in a way that
// matters: a dispatcher who believes a scan is running does not press again and does not
// suspect the board.
//
// The same sentence was also wrong the other way. Measured over one day of that ledger, a full
// scan takes 41.4s / 49.2s median / 72.3s max, and the button gave up at ~60s — so a WORKING
// scan was reported as a failure on roughly one press in seven.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanPressVerdict, SCAN_STALL_AFTER_SEC, SCAN_POLL_WINDOW_SEC, SCAN_SPINNER_SEC } from '../src/lib/scan-press-verdict.js';

const running = (age) => ({ startedAgeSec: age, finished: false });
const finished = (age, over = {}) => ({ startedAgeSec: age, finished: true, outcome: 'ok', ...over });

test('the board moved: say nothing and stop — the screen is already showing it', () => {
  const v = scanPressVerdict({ updated: true, waitedSec: 12 });
  assert.equal(v.kind, 'landed');
  assert.equal(v.message, null);
  assert.equal(v.done, true);
});

test('THE 72-SECOND SCAN: at 65s a genuinely running scan is reported as running, not as a failure', () => {
  // The case that made one press in seven a lie. The old button had already given up here.
  const v = scanPressVerdict({ updated: false, run: running(65), waitedSec: 65 });
  assert.equal(v.kind, 'running');
  assert.equal(v.done, false, 'and it keeps watching rather than concluding');
  assert.match(v.message, /still running/);
  assert.match(v.message, /65 seconds ago/, 'the age is in the sentence, so "still running" can be checked');
});

test('THE 20:01 RUN: started, never finished, long past any real scan — the board is NOT about to refresh', () => {
  // Seven minutes in, zero calls, no board written. The old sentence here was "Scan running —
  // the board will refresh automatically"; this is the one a dispatcher has to act on.
  // At the end of its window the press sees its OWN run, now ~190s old and still open.
  const v = scanPressVerdict({ updated: false, run: running(190), waitedSec: 190 });
  assert.equal(v.kind, 'stalled');
  assert.equal(v.done, true);
  assert.match(v.message, /has not finished/);
  assert.match(v.message, /still showing its last scan/, 'it says what the board on screen now IS');
  assert.doesNotMatch(v.message, /will refresh automatically/);
});

test('the threshold between the two is the stall line, and it is past the slowest measured scan', () => {
  assert.ok(SCAN_STALL_AFTER_SEC > 72, 'the slowest full scan in the ledger was 72.3s');
  assert.equal(scanPressVerdict({ updated: false, run: running(SCAN_STALL_AFTER_SEC - 1), waitedSec: 180 }).kind, 'running');
  assert.equal(scanPressVerdict({ updated: false, run: running(SCAN_STALL_AFTER_SEC), waitedSec: 180 }).kind, 'stalled');
  assert.ok(SCAN_SPINNER_SEC > 72 && SCAN_SPINNER_SEC < SCAN_POLL_WINDOW_SEC, 'the spinner outlasts a real scan, the poll outlasts the spinner');
});

test('a run that FINISHED with an error is reported as an error, with the reason, not as "running"', () => {
  const v = scanPressVerdict({
    updated: false, waitedSec: 60,
    run: finished(50, { outcome: 'error', error: 'NuVizz /entity/filterdata did not answer within 30000ms' }),
  });
  assert.equal(v.kind, 'stalled');
  assert.equal(v.done, true);
  assert.match(v.message, /finished with an error/);
  assert.match(v.message, /did not answer within 30000ms/);
  assert.match(v.message, /last good data/, 'and says the board is not broken, only unchanged');
});

test('a run that finished OK while the board read had not caught up yet is not called a failure', () => {
  const v = scanPressVerdict({ updated: false, run: finished(40), waitedSec: 45 });
  assert.equal(v.kind, 'landed');
  assert.equal(v.message, null);
});

test("a refusal uses the SERVER's sentence verbatim — one failure must not have two vocabularies", () => {
  const v = scanPressVerdict({
    updated: false, waitedSec: 9,
    refusal: { message: 'Scan refused: you are signed in as a viewer. Ask a dispatcher to run it.' },
  });
  assert.equal(v.kind, 'refused');
  assert.equal(v.done, true);
  assert.match(v.message, /signed in as a viewer\. Ask a dispatcher to run it\./);
});

test('a refusal with no sentence still names its reason rather than going quiet', () => {
  const v = scanPressVerdict({ updated: false, refusal: { reason: 'killswitch' }, waitedSec: 5 });
  assert.match(v.message, /killswitch/);
});

test("SOMEBODY ELSE'S run is never claimed as this press: an older run in flight is not an answer", () => {
  // Two dispatchers share this board. A run that started five minutes before this press
  // belongs to the schedule, and reporting it as "your scan is running" would be the same
  // reassurance-lie in a new costume.
  const v = scanPressVerdict({ updated: false, run: running(300), waitedSec: 30 });
  assert.equal(v.kind, 'stalled');
  assert.match(v.message, /No scan was recorded for this press/);
});

test('the round trip is allowed for: a run that started a few seconds before the press registers still counts as ours', () => {
  assert.equal(scanPressVerdict({ updated: false, run: running(70), waitedSec: 55 }).kind, 'running');
});

test('no run recorded at all: the press never reached the scanner, and it keeps looking until the window closes', () => {
  const early = scanPressVerdict({ updated: false, run: null, waitedSec: 30 });
  assert.equal(early.kind, 'stalled');
  assert.equal(early.done, false, 'early on, keep polling — the ledger write may simply be behind');
  const late = scanPressVerdict({ updated: false, run: null, waitedSec: SCAN_POLL_WINDOW_SEC });
  assert.equal(late.done, true, 'at the end of the window it is a final answer');
  assert.match(late.message, /still showing its last scan/);
});

test('no arguments at all does not throw — a dropped poll must never take the button down', () => {
  const v = scanPressVerdict();
  assert.equal(v.kind, 'stalled');
  assert.ok(v.message);
});
