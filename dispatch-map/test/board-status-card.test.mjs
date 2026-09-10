// test/board-status-card.test.mjs — what the board-status card shows, in both placements.
//
// The card is drawn two ways: the floating pill (dispatch Map, phone) stacks its detail and
// its scan error IN FLOW, and the desktop app-bar card drops a single ABSOLUTE panel below
// the bar. That difference is the whole reason this rule exists as a function: two absolute
// siblings under one bar land on the same pixels, and the only morning anybody would notice
// is a morning a scan has already failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boardStatusPanel } from '../src/lib/board-status-card.js';

test('expanded, no error: the detail shows and the panel is open', () => {
  const p = boardStatusPanel({ collapsed: false, scanErr: null });
  assert.equal(p.showDetails, true);
  assert.equal(p.showError, false);
  assert.equal(p.open, true);
});

test('collapsed, no error: nothing to drop, so the bar shows no panel at all', () => {
  const p = boardStatusPanel({ collapsed: true, scanErr: null });
  assert.equal(p.showDetails, false);
  assert.equal(p.showError, false);
  assert.equal(p.open, false, 'an empty dropdown under the bar is furniture');
});

test('A FAILED SCAN IS VISIBLE WHILE COLLAPSED — the refresh button is always on screen', () => {
  // The icon spins for a minute, goes quiet, and the button reads as broken. This is the
  // rule the pill has always had; bar mode must not quietly lose it by hiding the error
  // inside the collapse.
  const p = boardStatusPanel({ collapsed: true, scanErr: 'NuVizz refused the scan (403)' });
  assert.equal(p.showDetails, false);
  assert.equal(p.showError, true);
  assert.equal(p.open, true, 'the panel opens for the error alone');
});

test('expanded AND failed: one panel carries both, so neither can cover the other', () => {
  const p = boardStatusPanel({ collapsed: false, scanErr: 'timeout' });
  assert.equal(p.showDetails, true);
  assert.equal(p.showError, true);
  assert.equal(p.open, true);
});

test('a blank or whitespace-only error is not an error', () => {
  for (const junk of ['', '   ', '\n\t']) {
    const p = boardStatusPanel({ collapsed: true, scanErr: junk });
    assert.equal(p.showError, false, `"${JSON.stringify(junk)}" should not paint a red box`);
    assert.equal(p.open, false, 'and must not force an otherwise-empty dropdown open');
  }
});

test('the absent and the malformed: no arguments at all still answers', () => {
  const p = boardStatusPanel();
  assert.equal(p.showDetails, true);
  assert.equal(p.showError, false);
  assert.equal(p.open, true);
});

test('a non-string error object still shows — never swallow a failure on its type', () => {
  const p = boardStatusPanel({ collapsed: true, scanErr: new Error('boom') });
  assert.equal(p.showError, true);
  assert.equal(p.open, true);
});

test('only collapsed === true collapses; a missing flag leaves the detail up', () => {
  // `collapsed` arrives from a persisted JSON read that can come back undefined on a fresh
  // device. Undefined must read as "open", which is the app's default, not as collapsed.
  assert.equal(boardStatusPanel({ collapsed: undefined }).showDetails, true);
  assert.equal(boardStatusPanel({ collapsed: null }).showDetails, true);
  assert.equal(boardStatusPanel({ collapsed: 0 }).showDetails, true);
  assert.equal(boardStatusPanel({ collapsed: true }).showDetails, false);
});
