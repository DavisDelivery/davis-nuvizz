// test/format-phone.test.mjs — the customer phone on the stop card.
//
// Chad, Jul 31, with NuVizz's Ship-To block open beside our card: "why are we not displaying
// customer phone numbers?" KAI WONG's 6788608099 was right there in NuVizz and nowhere on
// ours. We had it the whole time — the scan carries to.contact, and resolveStopPhone already
// fed the "Text customer" button (that's how it knew whether to say "(add #)"). It was simply
// never printed.
//
// These pin the display formatter. The rule that matters: anything that is NOT a plain
// 10/11-digit US number is shown EXACTLY as stored. A dispatcher dialling an extension or an
// international number must see what is on file, not a number reshaped to look American.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const fnSrc = src.slice(src.indexOf('export function formatPhone'));
const formatPhone = new Function(`${fnSrc.slice(0, fnSrc.indexOf('\n}') + 2).replace('export function', 'return function')}`)();

test("Chad's stop: KAI WONG's number reads like a phone number", () => {
  assert.equal(formatPhone('6788608099'), '(678) 860-8099');
});

test('already-formatted and 1-prefixed US numbers normalize to one shape', () => {
  assert.equal(formatPhone('678-860-8099'), '(678) 860-8099');
  assert.equal(formatPhone('(678) 860-8099'), '(678) 860-8099');
  assert.equal(formatPhone('678.860.8099'), '(678) 860-8099');
  assert.equal(formatPhone('16788608099'), '(678) 860-8099');
  assert.equal(formatPhone('1-678-860-8099'), '(678) 860-8099');
});

test('anything that is not a plain US number is shown VERBATIM, never reshaped', () => {
  for (const s of ['678-860-8099 x204', '+44 20 7946 0958', '911', '', '  ']) {
    assert.equal(formatPhone(s), s.trim(), s);
  }
  // An 11-digit number that does NOT start with 1 is not a US number — leave it alone.
  assert.equal(formatPhone('26788608099'), '26788608099');
});

test('junk in, no crash out', () => {
  assert.equal(formatPhone(null), '');
  assert.equal(formatPhone(undefined), '');
  assert.equal(formatPhone(6788608099), '(678) 860-8099', 'numeric input still formats');
});
