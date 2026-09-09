// test/selection-send-targets.test.mjs — the Selected panel's send buttons: one per open
// Compare card, named as the card header names it, in the card's colour, and none when no
// card is open (v0.98.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectionSendTargets } from '../src/lib/send-selection.js';

// The app's loadDisplayName: a human name passes, a NuVizz hash-like id does not.
const displayName = (k) => (/^[0-9a-f]{20,}$/i.test(String(k)) ? '' : String(k));

test('no Compare card open → no buttons (a dead button is worse than none)', () => {
  assert.deepEqual(selectionSendTargets([]), []);
  assert.deepEqual(selectionSendTargets(null), []);
  assert.deepEqual(selectionSendTargets(undefined), []);
});

test('one button per open card, in card order, carrying the card colour', () => {
  const out = selectionSendTargets([
    { key: 'ALPHA', name: 'ALPHA', color: '#e11d48', order: ['1'] },
    { key: 'SUW 2', name: 'SUW 2', color: '#2563eb', order: [] },
  ]);
  assert.deepEqual(out, [
    { key: 'ALPHA', name: 'ALPHA', color: '#e11d48' },
    { key: 'SUW 2', name: 'SUW 2', color: '#2563eb' },
  ]);
});

test('a card opened from the Loads grid by its NuVizz number is named as its header is: name, then display name, then the key itself', () => {
  const out = selectionSendTargets([
    { key: 'DAVIS000198668', name: null, color: '#0f766e' },                 // roster name not resolved yet
    { key: '5f3c2a1b9e8d7c6b5a4f3e2d', name: '', color: '#7c3aed' },          // a bare load-id hash: displayName refuses it
    { key: 'NOR', name: 'NOR (Draft)', color: '#ca8a04' },                    // the card's own name wins
  ], { displayName });
  assert.deepEqual(out.map((t) => t.name), ['DAVIS000198668', '5f3c2a1b9e8d7c6b5a4f3e2d', 'NOR (Draft)']);
});

test('a card with no key cannot be a button — it is dropped, not rendered', () => {
  const out = selectionSendTargets([null, { name: 'ghost' }, { key: '', name: 'blank' }, { key: 'ATL', name: 'ATL', color: '#16a34a' }]);
  assert.deepEqual(out, [{ key: 'ATL', name: 'ATL', color: '#16a34a' }]);
});

test('a card without a colour still gets a button (the render site paints the brand blue)', () => {
  const out = selectionSendTargets([{ key: 'ATL', name: 'ATL' }]);
  assert.deepEqual(out, [{ key: 'ATL', name: 'ATL', color: null }]);
});
