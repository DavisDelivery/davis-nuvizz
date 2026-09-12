// test/manifest-check-screen.test.mjs
//
// THE MANUAL DROP BOX IS GONE, AND EVERYTHING ELSE ON THAT SCREEN IS NOT.
//
// Chad: "there is no need for the manual manifest drop in box any longer as we are pulling it
// out of the emails." Every report arrives through the Gmail ingest now — every 30 minutes,
// self-validating, archived with its PDF — so a manual drop could only overwrite tonight's
// filed result with a stale copy, and its target swallowed stray drags. Removing a feature is
// the easy half; this pins that the mailbox card, the last verdict, and the archive under it
// survived the deletion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const SCREEN = (() => {
  const i = APP.indexOf('function ManifestCheckScreen(');
  return APP.slice(i, APP.indexOf('\nfunction ', i + 10));
})();

test('THE DROP BOX IS GONE — no file input, no drop target, no manual POST', () => {
  assert.ok(!/type="file"/.test(SCREEN), 'no file input');
  assert.ok(!/onDrop=/.test(SCREEN), 'no drop target');
  assert.ok(!/accept="\.pdf"/.test(SCREEN), 'no PDF picker');
  assert.ok(!/manifest-check'/.test(SCREEN), 'nothing on this screen POSTs a PDF by hand');
  assert.ok(!/Drop the Uline/.test(SCREEN), 'and the prompt text went with it');
});

test('WHAT MUST SURVIVE: the mailbox card, the verdict, the archive', () => {
  assert.match(SCREEN, /<GmailCard onStoredRun=\{adoptRun\}/, 'the Gmail card, which is now the only way a report arrives');
  assert.match(SCREEN, /manifestHeadline\(result\)/, 'the last run’s verdict');
  assert.match(SCREEN, /<ManifestHistoryCard \/>/, 'the archive underneath');
  assert.match(SCREEN, /const adoptRun = useCallback/, 'a run the ingest just wrote is still adopted live');
  assert.match(SCREEN, /window\.addEventListener\('dd-manifest-check-updated', sync\)/, 'and the screen still hears about it');
  assert.match(SCREEN, />Clear</, 'Clear stays — a stale verdict can still be dismissed');
});

test('the intro says how the report arrives now, and does not offer a drop', () => {
  assert.match(SCREEN, /read out of the mailbox on its own/);
  assert.ok(!/drop the PDF yourself/.test(SCREEN));
});

test('the app-wide drag guard is untouched — a stray PDF must still not navigate the app away', () => {
  // The drop zone was never what stopped that; Shell's window-level swallow is, and it stays.
  assert.match(APP, /window\.addEventListener\('dragover', swallow\)/);
  assert.match(APP, /window\.addEventListener\('drop', swallow\)/);
});

// ── ASKING THE BOARD AGAIN (v1.20.1) ─────────────────────────────────────────
//
// Chad, Saturday 10:42: "If we ran a scan this morning to complete the board from last week
// which looks like we did. It should have fixed the manifest incompleteness." Nothing on this
// screen could ask, and nothing on it said how old the answer was.

test('the verdict can be re-checked against the board, and it spends no NuVizz calls', () => {
  assert.match(SCREEN, /manifest-recheck/, 'the button that closes the two-day blind spot');
  assert.match(SCREEN, /const recheckNow = useCallback/);
  assert.match(SCREEN, /Re-check against the board/, 'and it says what it does in freight language');
  assert.match(SCREEN, /adoptRun\(d\.stored\)/, 'the new run lands on the screen you are looking at');
  // The probe step is the only thing here that can spend a NuVizz call, and it lives behind
  // its own click in manifest-check.mts. This screen must never reach it.
  assert.ok(!/probe=1/.test(SCREEN), 'no path from this screen spends a NuVizz call');
});

test('the card says how old its reading is — a 10h-old verdict must not look fresh', () => {
  assert.match(SCREEN, /manifestFreshness\(result\)/);
  assert.match(SCREEN, /Read against the board as it stood/);
  // It states the AGE and stops there. Claiming the scan has run since would be reporting an
  // intent as an outcome — this screen cannot observe that.
  assert.ok(!/the scan has run since/i.test(SCREEN));
});

test('the re-check furniture is IN FLOW, never pinned over what it sits beside', () => {
  // Mobile and desktop are two views, and on a phone overlay furniture lives in one flow
  // container: absolutely-pinned siblings put the draw buttons on top of the status card on
  // 2026-08-19 after four collision patches. When the sentence wraps, the button MOVES.
  const row = SCREEN.slice(SCREEN.indexOf('Read against the board as it stood') - 900,
                           SCREEN.indexOf('Read against the board as it stood') + 900);
  assert.ok(!/\babsolute\b/.test(row), 'nothing in this row is absolutely positioned');
  assert.match(row, /flex flex-wrap items-center/, 'one wrapping flow row, so 390px stacks instead of colliding');
});
