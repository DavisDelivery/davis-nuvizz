// test/carrier-mark.test.mjs — which orders wear the Estes paint (lib/carrier-mark.js).
//
// The order NUMBER decides it, the same ESTES-<digits> convention the manifest intake writes
// and the Stops grid shows in full. The rule has to be forgiving about case and separator
// (a hand-typed "estes-…" is still Estes) and strict about the word (a number that merely
// contains those letters is not).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isEstesOrder, ESTES_FILL, ESTES_RING } from '../src/lib/carrier-mark.js';

test('the board’s ESTES-<digits> numbers are Estes orders, whatever the case or separator', () => {
  for (const n of ['ESTES-0538243875', 'Estes-0828068215', 'estes-2258732686', 'ESTES 123', 'ESTES_9', ' ESTES-1 ', 'ESTES']) {
    assert.equal(isEstesOrder(n), true, n);
  }
});

test('a Uline PRO, a Davis SHP, an AVRT order, or a number that merely contains the letters is not', () => {
  for (const n of ['007172492', 'SHP29379', 'AVRT-0028093763', 'WESTES-1', 'ESTESX-1', 'ESTESIAN', '']) {
    assert.equal(isEstesOrder(n), false, JSON.stringify(n));
  }
});

test('junk in never throws — the rule runs per stop per repaint', () => {
  for (const n of [null, undefined, 0, 12345, {}, []]) assert.equal(isEstesOrder(n), false);
  assert.equal(isEstesOrder({ toString: () => 'ESTES-1' }), true, 'a stringable object is read as its string');
});

test('the paint is black with a yellow ring, as asked', () => {
  assert.equal(ESTES_FILL, '#000000');
  assert.match(ESTES_RING, /^#[0-9a-f]{6}$/i);
  // "Yellow": strong red + green, little blue.
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(ESTES_RING.slice(i, i + 2), 16));
  assert.ok(r > 200 && g > 150 && b < 80, `${ESTES_RING} should read as yellow`);
});
