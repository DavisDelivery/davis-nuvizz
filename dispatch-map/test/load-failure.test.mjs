// The line a lazily loaded tab (Routing → Shadow, Quote) prints when its code did not load
// (src/lib/load-failure.js; the screen around it is src/components/TabLoadFailure.jsx).
//
// It exists because the first cut of the lazy Shadow tab threw the error away: a file that could
// not be fetched and a file that arrived broken both read "could not load, reload to try again",
// the console was empty, and only one of the two is fixed by a reload. The line is what a
// screenshot from a phone or an iPad — which have no console anyone can open — will carry.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFailureDetail, LOAD_FAILURE_DETAIL_MAX } from '../src/lib/load-failure.js';

test('a file that could not be fetched (a dropped connection, or a file the site no longer has — Chromium prints the two the same) reads as the fetch failure, URL and all', () => {
  const err = new TypeError('Failed to fetch dynamically imported module: https://example.test/assets/ClaudeShadowScreen-p96XbK81.js');
  assert.equal(loadFailureDetail(err), 'TypeError: Failed to fetch dynamically imported module: https://example.test/assets/ClaudeShadowScreen-p96XbK81.js');
});

test('Shadow code one browser will not parse reads as a SyntaxError — not as a fetch failure a reload would fix', () => {
  assert.equal(loadFailureDetail(new SyntaxError("Unexpected token '?'")), "SyntaxError: Unexpected token '?'");
});

test('an error thrown as the Shadow code loads keeps its own name, including a custom one', () => {
  assert.equal(loadFailureDetail(new Error('boom at load')), 'Error: boom at load');
  class ShadowBootError extends Error { constructor(m) { super(m); this.name = 'ShadowBootError'; } }
  assert.equal(loadFailureDetail(new ShadowBootError('no plan store')), 'ShadowBootError: no plan store');
  // An Error with no message still says what kind it was.
  assert.equal(loadFailureDetail(new Error('')), 'Error');
  // Error-shaped values that are not Error instances read the same way.
  assert.equal(loadFailureDetail({ name: 'TypeError', message: 'x is not a function' }), 'TypeError: x is not a function');
  assert.equal(loadFailureDetail({ message: 'only a message' }), 'only a message');
});

test('a rejection with no reason at all still says so — never an empty line, never "[object Object]"', () => {
  for (const v of [undefined, null, '', '   ', {}, { name: '', message: '' }, { name: 42, message: null }]) {
    assert.equal(loadFailureDetail(v), 'no reason given', `for ${JSON.stringify(v)}`);
  }
});

test('a rejection with a plain value is shown as text — zero is a value, not an absence', () => {
  assert.equal(loadFailureDetail('offline'), 'offline');
  assert.equal(loadFailureDetail(0), '0');
  assert.equal(loadFailureDetail(false), 'false');
});

test('a value that cannot even be turned into text does not throw — the catch this runs in must never reject, or the app goes white', () => {
  const noProto = Object.create(null);
  const trap = new Proxy({}, { get() { throw new Error('getter trap'); } });
  const badToString = { toString() { throw new Error('toString trap'); } };
  for (const v of [noProto, trap, badToString]) {
    assert.doesNotThrow(() => loadFailureDetail(v));
    assert.equal(loadFailureDetail(v), 'no reason given');
  }
});

test('a long URL or a pasted stack is one line, cut to length — it cannot push a phone screen wider or fill it', () => {
  const stack = `Error: first line\n    at a (x.js:1:1)\n\n    at b (y.js:2:2)`;
  assert.equal(loadFailureDetail(stack), 'Error: first line at a (x.js:1:1) at b (y.js:2:2)');
  const long = new TypeError(`Failed to fetch dynamically imported module: https://example.test/${'a'.repeat(1000)}.js`);
  const out = loadFailureDetail(long);
  assert.equal(out.length, LOAD_FAILURE_DETAIL_MAX);
  assert.ok(out.endsWith('…'));
  assert.ok(out.startsWith('TypeError: Failed to fetch dynamically imported module: https://example.test/aaa'));
  assert.equal(loadFailureDetail('abcdef', 4), 'abc…');
  assert.equal(loadFailureDetail('abcd', 4), 'abcd', 'exactly at the limit is not cut');
});

test('a malformed length limit falls back to the default instead of cutting everything (Number(null) is 0)', () => {
  const text = 'x'.repeat(LOAD_FAILURE_DETAIL_MAX + 50);
  for (const max of [null, NaN, -1, 0, 1, Infinity, '12']) {
    assert.equal(loadFailureDetail(text, max).length, LOAD_FAILURE_DETAIL_MAX, `max=${String(max)}`);
  }
});
