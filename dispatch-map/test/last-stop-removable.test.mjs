// test/last-stop-removable.test.mjs — the last stop on a Compare card MUST be removable.
//
// v0.54.17 made the last ✕ visible (Chad: "I have no way of unplanning all stops off this
// load") — emptying a load is the documented route-cancel flow, handled server-side since
// v0.32.20 and gated client-side by the cancel-guard popup. Then v0.54.19 (PR #571, the call
// -ceiling release) silently REVERTED it: that branch was cut from a base older than 0.54.17,
// and the merge restored the pre-0.54.17 `rows.length > 1` guard — a regression nothing
// noticed for days because no test pinned the UI side of the path. The server path, the board
// write-through (v0.54.18) and the confirm popup (cancel-guard) all survived; the one UI
// button that reaches them was gone.
//
// The card renders inside App.jsx (no component export, no DOM test rig), so this pins the
// SOURCE — crude, but it is exactly the artifact the regression corrupted, and the assertions
// are narrow enough to survive refactors that keep the behaviour:
//   1. the remove button must NOT be gated on `rows.length > 1`;
//   2. the last-stop title (the amber "EMPTIES the load … CANCELS the route" wording) exists.
// If a refactor moves the card out of App.jsx, move these pins with it — do not delete them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');

test('the stop-row ✕ is not hidden on the last remaining stop', () => {
  assert.ok(
    !/onRemoveStop\s*&&\s*rows\.length\s*>\s*1/.test(src),
    'App.jsx gates the remove button on rows.length > 1 again — that is the exact v0.54.19 ' +
    'regression: the last stop becomes unremovable, so a route can never be emptied/cancelled ' +
    'from the app. Restore the v0.54.17 button (always rendered; amber on the last stop).'
  );
});

test('the last-stop ✕ names what it really does (empties the load → cancels the route)', () => {
  assert.ok(
    src.includes('EMPTIES the load, which CANCELS the route in NuVizz on Save'),
    'the last-stop remove button must carry the explicit cancel warning title — removing the ' +
    'last order is a different action (route cancel) and has to say so at the button.'
  );
});
