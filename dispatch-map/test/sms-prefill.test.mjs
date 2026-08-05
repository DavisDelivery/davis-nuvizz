// test/sms-prefill.test.mjs — a text composed FROM an order opens on that order's reference
// line ("PRO 007157031 — GOOGLE: ").
//
// Chad, looking at an empty Text box on the GOOGLE stop: "i want it to prepopulate the message
// with the customer name and their pro number". The driver text had done this since the
// prefill helper landed; the CUSTOMER text opened blank, so the dispatcher retyped the PRO by
// hand (or sent a message with no reference on it at all).
//
// The composer renders inside App.jsx (no component export, no DOM test rig), so this pins the
// SOURCE for the wiring — the same approach, and the same reason, as
// last-stop-removable.test.mjs: a stale-base merge silently reverted a one-line UI change once
// already. The format itself is pinned properly: stopRefPrefill is a pure function, so it is
// lifted out of the source and executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');

// Lift the helper out of App.jsx and run it for real. It is self-contained (no imports, no JSX),
// so this executes the shipping implementation rather than a copy that can drift.
const fnSrc = src.match(/function stopRefPrefill\(stop\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(fnSrc, 'stopRefPrefill is gone from App.jsx — if it was renamed, update this test with it');
const stopRefPrefill = new Function(`${fnSrc}; return stopRefPrefill;`)();

test('prefill is the PRO + customer name, ready to type after', () => {
  assert.equal(
    stopRefPrefill({ pro: '007157031', businessName: 'GOOGLE' }),
    'PRO 007157031 — GOOGLE: ',
  );
});

test('prefill falls back to the stop number when there is no PRO', () => {
  assert.equal(stopRefPrefill({ stopNbr: '12345', businessName: 'GOOGLE' }), 'PRO 12345 — GOOGLE: ');
});

test('a missing field never leaves a stray dash or an empty PRO', () => {
  assert.equal(stopRefPrefill({ pro: '007157031' }), 'PRO 007157031: ');
  assert.equal(stopRefPrefill({ businessName: 'GOOGLE' }), 'GOOGLE: ');
  assert.equal(stopRefPrefill({}), '');
  assert.equal(stopRefPrefill(null), '');
});

// The wiring: BOTH customer-text entry points (Map stop panel and the ported Routing stop
// detail) must seed the composer. Either one left blank is the bug Chad reported.
test('both customer-text paths open the composer prefilled', () => {
  const customerOpens = src.match(/set(?:Routing)?SmsTargets\(\{ title: `Text \$\{stop\.businessName[^\n]*\n?/g) || [];
  assert.equal(
    customerOpens.length, 2,
    `expected 2 customer-text call sites (Map + Routing), found ${customerOpens.length} — if a ` +
    'screen was added or removed, update this count and keep every one of them prefilled.',
  );
  for (const call of customerOpens) {
    assert.ok(
      call.includes('initialText: stopRefPrefill(stop)'),
      'a customer-text composer opens without initialText: stopRefPrefill(stop) — it will open ' +
      'blank and the dispatcher has to retype the PRO. Seed it like the driver text does.',
    );
  }
});
