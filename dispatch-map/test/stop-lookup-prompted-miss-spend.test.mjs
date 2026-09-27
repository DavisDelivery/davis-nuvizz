// test/stop-lookup-prompted-miss-spend.test.mjs — A CALL SPENT ON "NUVIZZ HAS NOTHING" STILL SHOWS.
//
// Audit 2026-09-27 (app-A4-8). A rep presses "Ask NuVizz for this order — 1 call" on a
// mistyped PRO. NuVizz answers 404, one call is spent, and the endpoint says nuvizzCalls: 1 —
// but the screen only kept the answer when NuVizz FOUND the order. On a miss or an error it
// showed the sentence and dropped the count, so the header chip went on saying "0 NuVizz calls"
// with the tooltip "Nothing here spends a NuVizz call" under "NuVizz has nothing either."
//
// The rule, pure: every call a prompted answer cost stays on the count of what is on screen,
// found or not — and a second tap after an error adds to the first rather than replacing it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { promptedCallsOnScreen } from '../src/lib/stop-lookup.js';

test('a prompted call that found nothing still counts on the screen\'s call total', () => {
  // The Firestore answer on screen carried 0; NuVizz's 404 reply carried 1.
  assert.equal(promptedCallsOnScreen(0, 1), 1);
});

test('a retry after an error adds its calls to the ones already spent', () => {
  assert.equal(promptedCallsOnScreen(1, 1), 2);
  assert.equal(promptedCallsOnScreen(5, 2), 7);
});

test('a refusal before the wire (breaker, switch) adds nothing, and junk is never a count', () => {
  assert.equal(promptedCallsOnScreen(0, 0), 0);
  assert.equal(promptedCallsOnScreen(undefined, undefined), 0);
  assert.equal(promptedCallsOnScreen(null, 'x'), 0);
  assert.equal(promptedCallsOnScreen(-3, 1), 1);
});

test('the screen keeps the spend on BOTH branches of the answer — found, and not found', () => {
  const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = APP.indexOf('const askNuvizz = useCallback(async () => {');
  assert.ok(start > 0, 'askNuvizz is where it was');
  const body = APP.slice(start, APP.indexOf('}, [data, asking]);', start));
  const [found, missed] = body.split('} else {');
  assert.ok(missed, 'the not-found branch exists');
  assert.match(found, /nuvizzCalls: promptedCallsOnScreen\(/, 'a found answer carries the whole spend');
  assert.match(missed, /setData\(\(cur\) => [^\n]*nuvizzCalls: promptedCallsOnScreen\(cur\.nuvizzCalls, j\.nuvizzCalls\)/,
    'a miss or an error folds its spend into the answer on screen, so the header chip counts it');
  assert.match(APP, /import \{[^}]*\bpromptedCallsOnScreen\b[^}]*\} from '\.\/lib\/stop-lookup\.js'/, 'from the shared module');
});

test('after "NuVizz has nothing either" the chip counts the call without claiming the answer came from NuVizz', async () => {
  // The count now stays up over a MISS, where the order on screen is still the Firestore answer.
  // The chip's tooltip used to say "This answer came from NuVizz" — true only when NuVizz found it.
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { liftFromApp } = await import('./helpers/app-lift.mjs');
  const { LookupCallsPill } = liftFromApp({ targets: ['LookupCallsPill'], inject: { React } });
  const html = renderToStaticMarkup(React.createElement(LookupCallsPill, { calls: promptedCallsOnScreen(0, 1) }));
  assert.match(html, /1 NuVizz call — on request/);
  assert.doesNotMatch(html, /came from NuVizz/, 'a miss must not be described as an answer from NuVizz');
  assert.match(html, /title="NuVizz was asked about this order, on request — one call spent\."/);
});
