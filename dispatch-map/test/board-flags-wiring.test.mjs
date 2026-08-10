// test/board-flags-wiring.test.mjs — Board Flags must stay WIRED, not just implemented.
// The rules themselves are tested by executing board-flags.js directly; these pins cover the
// one-line connections in App.jsx that a stale-base merge can silently lose (exactly how the
// last-stop ✕ vanished in v0.54.19).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');

test('the detector is computed from the live board with the roster riding along', () => {
  assert.ok(
    /computeBoardFlags\(\{\s*\n?\s*stops, notes, rosterRows: rosterRawRows, servedDate: selectedDate/.test(src),
    'MapScreen no longer computes board flags from stops+notes+roster — the chip has no data source.',
  );
});

test('the chip renders in BOTH pills (desktop and mobile)', () => {
  const n = (src.match(/<BoardFlagsChip /g) || []).length;
  assert.equal(n, 2, `expected the flag chip in the desktop and mobile status pills, found ${n} render site(s)`);
});

test('the panel renders and can open stops', () => {
  const n = (src.match(/<BoardFlagsPanel /g) || []).length;
  assert.equal(n, 2, `expected the panel in both layouts, found ${n}`);
  assert.ok(src.includes('onOpenStop={openFlaggedStop}'), 'panel rows must click through to the stop card');
});

test('a clean board renders NO chip — the flag must never become furniture', () => {
  assert.ok(
    /if \(!flags \|\| \(flags\.redCount === 0 && flags\.amberCount === 0\)\) return null;/.test(src),
    'BoardFlagsChip must render nothing at zero — an always-present flag gets ignored by Wednesday.',
  );
});

test('the detector never fetches the roster itself (metered on cache miss)', () => {
  // rosterRawRows must only be set inside the routesPanelOn-gated effect that already exists.
  // Anchor on the populate CALL, not the useState declaration (which precedes the gate).
  const idx = src.indexOf('setRosterRawRows(j');
  assert.ok(idx > 0, 'the roster-populate call is gone');
  const before = src.slice(0, idx);
  const gate = before.lastIndexOf('if (!routesPanelOn || !selectedDate) return;');
  assert.ok(gate > 0 && idx - gate < 1500,
    'rosterRawRows must be populated ONLY by the Routes-panel-gated fetch — the flags detector must never initiate a roster fetch of its own.');
});
