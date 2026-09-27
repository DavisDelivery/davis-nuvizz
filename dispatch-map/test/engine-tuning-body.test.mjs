// test/engine-tuning-body.test.mjs — what the Engine tab's Tuning panel sends (Sep 27 audit, B-04).
//
// Number('') is 0 and 0 is finite, so a box a dispatcher cleared to retype used to post 0, which
// the server clamps to the knob's MINIMUM bound and persists with a "customized" badge nobody
// asked for. A cleared box is "no change"; Save waits until it holds a number again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tuningSaveBody, hasBlankEdit } from '../src/lib/engine-tuning.js';

test('a cleared box is NO CHANGE — never 0, never the minimum bound', () => {
  const body = tuningSaveBody({ far_deadhead_mi: '' }, []);
  assert.equal('far_deadhead_mi' in body, false);
  assert.deepEqual(body, { updatedBy: 'engine-tab', reset: [] });
});

test('a typed number is sent as a number, whitespace and all; junk is dropped; resets ride along', () => {
  const body = tuningSaveBody({ far_deadhead_mi: ' 30 ', w_zone_owner: 'abc', w_far: '1.5' }, ['w_time']);
  assert.deepEqual(body, { updatedBy: 'engine-tab', reset: ['w_time'], far_deadhead_mi: 30, w_far: 1.5 });
});

test('hasBlankEdit: Save must wait while any box is blank', () => {
  assert.equal(hasBlankEdit({}), false);
  assert.equal(hasBlankEdit({ a: '30' }), false);
  assert.equal(hasBlankEdit({ a: '30', b: '   ' }), true);
  assert.equal(hasBlankEdit({ a: null }), true);
});

test('WIRING: the panel builds its body through the pure helper and disables Save on a blank box', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const i = app.indexOf('function EngineTuningPanel(');
  assert.ok(i > 0, 'EngineTuningPanel exists');
  const panel = app.slice(i, i + 12000);
  assert.match(panel, /const body = tuningSaveBody\(edits, resets\);/, 'the body comes from lib/engine-tuning.js');
  assert.match(panel, /const blank = hasBlankEdit\(edits\);/, 'blank is computed from the same helper');
  assert.match(panel, /disabled=\{!dirty \|\| saving \|\| blank\}/, 'Save is disabled while a box is blank');
  assert.doesNotMatch(panel, /const n = Number\(v\); if \(Number\.isFinite\(n\)\) body\[k\] = n;/, 'the old inline loop is gone');
});
