// test/routing-send-state-wiring.test.mjs — the send control stays CONNECTED to the screen.
//
// sendControlState is pure and passes its own tests whether or not App.jsx calls it. A rule
// wired to nothing is this repo's recurring failure (v1.17.2). The v1.33.0 pins that used to
// live here (card chip, savedAt, routePaintSource, planStaged) went with that PR's revert in
// v1.36.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
const code = src.split('\n').filter((l) => !/^ {2}\['\d+\.\d+\.\d+', /.test(l)).join('\n');

test('the header builds its send control from the rule', () => {
  assert.ok(/import \{[^}]*\bsendControlState\b[^}]*\} from '\.\/lib\/routing-select\.js';/.test(code), 'sendControlState is not imported');
  assert.ok(/const sc = sendControlState\(\{ openCards: wbRoutes\.length, dirtyCards: dirtyRoutes\.length, liveMode \}\);/.test(code), 'the header does not build its control from the rule');
  assert.ok(/if \(sc\.kind === 'none'\) return null;/.test(code), 'the header does not honour the nothing-staged state');
  assert.equal((code.match(/sc\.label/g) || []).length, 1, 'the header must render the rule label on the button');
});

test('THE SEND BUTTON IS NOT BEHIND THE PER-DEVICE GEAR — Sep 15, "i have no way to send these loads"', () => {
  // THE BUG, PINNED AT THE WIRING. `liveWrite` is a localStorage toggle that seeds OFF from
  // VITE_NUVIZZ_WRITE_BETA and persists; gating the send surface on it left a dispatcher with
  // staged changes and no control anywhere on the screen to send them. Everything here must
  // stay OUTSIDE that gate. The card's driver-assign row stays inside it.
  const header = /const sc = sendControlState\(\{[\s\S]*?<\/button>\s*\)\;\s*\}\)\(\)\}/.exec(code);
  assert.ok(header, 'the header send control is gone');
  assert.ok(!/LIVE_WRITE_FLAG/.test(header[0]), 'the send button is behind the live-write gear again');

  // The ● LIVE / ○ Beta switch decides whether that button writes or only simulates — hiding it
  // left the dispatcher unable to tell, or change, which of the two they were about to do.
  assert.ok(!/\{LIVE_WRITE_FLAG && \(\s*\n\s*<button\s*\n\s*onClick=\{\(\) => setLiveMode/.test(code), 'the LIVE/Beta switch is gated again');
  assert.ok(/onClick=\{\(\) => setLiveMode\(\(v\) => !v\)\}/.test(code), 'the LIVE/Beta switch is gone');

  // The close confirmation: a card holding staged changes must never close SILENTLY.
  assert.ok(/const guardedClose = \(key\) => \{ const r = wbRoutes\.find\(\(x\) => x\.key === key\); if \(r && isDirty\(r\)\)/.test(code), 'the one-card close guard is gated again');
  assert.ok(/const guardedCloseAll = \(\) => \{ if \(dirtyRoutes\.length\)/.test(code), 'the close-all guard is gated again');
  assert.ok(!/\{LIVE_WRITE_FLAG && closeGuard && \(/.test(code), 'the close-guard modal is gated again');

  // The toast is the send button's ONLY report channel: every "✓ N load(s) saved to NuVizz"
  // and every ✗ refusal NuVizz answers with comes out of it.
  assert.ok(!/\{LIVE_WRITE_FLAG && toast && \(/.test(code), 'the save-result toast is gated again');

  // …and the gear still covers what it is actually for.
  assert.ok(/\{LIVE_WRITE_FLAG && !route\.collapsed && \(\s*\n\s*<LiveDispatchBar/.test(code), 'the driver-assign + dispatch row left the gear');
});
