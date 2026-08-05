// test/live-stop-fold-guard.test.mjs — the open card must never be silently re-keyed to the
// OTHER order sharing its number.
//
// Chad, the morning after v0.54.36 shipped: "Changed the date on Estes again and it changed
// all the addresses so your fix did not work." The v0.54.36 guards did hold — but only on
// the date WRITE and its repaint. The card's own refresh paths (the Refresh-from-NuVizz
// button, the Activity-timeline fold-back, the POD pull) still merged whatever the
// by-number lookup answered, INCLUDING the twin's stopId. One such merge and the card
// BECOMES the twin: the address block flips wholesale, and every later write-guard compares
// the twin to itself and passes. The identity was stolen before the write began.
//
// The guard therefore lives in the ONE funnel every fold-back flows through
// (useLiveStop.onRefreshed), not at individual call sites. The decision is a pure function
// (liveStopFoldGuard), lifted out of App.jsx and executed here — same technique as
// sms-prefill.test.mjs — plus source pins on the funnel wiring, which is the part a
// stale-base merge can silently lose (the v0.54.19 lesson).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');

// The guard depends on isHashLikeId; lift both and run the real code.
const hashFn = src.match(/function isHashLikeId\(v\) \{[\s\S]*?\n\}/)?.[0];
const guardFn = src.match(/function liveStopFoldGuard\(cardStopId, incoming\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(hashFn, 'isHashLikeId is gone from App.jsx');
assert.ok(guardFn, 'liveStopFoldGuard is gone from App.jsx — if renamed, update this test');
const liveStopFoldGuard = new Function(`${hashFn}; ${guardFn}; return liveStopFoldGuard;`)();

const ID_A = '66b1f00dc0ffee0123456789'; // 24-hex, id-shaped
const ID_B = '66b1f00dc0ffee9876543210';

test('a different id-shaped record is refused, with both ids named', () => {
  const msg = liveStopFoldGuard(ID_A, { stopId: ID_B });
  assert.ok(msg, 'the twin merged straight over the card');
  assert.ok(msg.includes(ID_B.slice(-6)) && msg.includes(ID_A.slice(-6)), 'the refusal must name both record ids');
});

test('the same record always merges', () => {
  assert.equal(liveStopFoldGuard(ID_A, { stopId: ID_A }), null);
});

test('the guard only narrows: a missing id on either side merges as before', () => {
  assert.equal(liveStopFoldGuard('', { stopId: ID_B }), null);       // card opened without an id
  assert.equal(liveStopFoldGuard(null, { stopId: ID_B }), null);
  assert.equal(liveStopFoldGuard(ID_A, { stopId: '' }), null);       // lookup carried no id
  assert.equal(liveStopFoldGuard(ID_A, {}), null);
  assert.equal(liveStopFoldGuard(ID_A, null), null);
});

test('a stop NUMBER can never arm the guard', () => {
  // Numbers (even long ones with a carrier prefix) are not id-shaped; two records keyed by
  // number are exactly the ambiguity this cannot resolve — it must merge, not block.
  assert.equal(liveStopFoldGuard('007157031', { stopId: ID_B }), null);
  assert.equal(liveStopFoldGuard(ID_A, { stopId: '007157031' }), null);
});

// ── wiring pins ───────────────────────────────────────────────────────────────

test('useLiveStop routes every fold through the guard and refuses by NOT merging', () => {
  const hook = src.match(/function useLiveStop\(stop\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(hook, 'useLiveStop is gone from App.jsx');
  assert.ok(
    hook.includes('liveStopFoldGuard(liveIdRef.current, d)'),
    'useLiveStop.onRefreshed no longer consults liveStopFoldGuard — the Refresh button, ' +
    'timeline, and POD pulls are back to merging the twin over the card.',
  );
  assert.ok(
    hook.includes('dupNbrSuspect: true'),
    'a refused fold must light the red "2 orders share this number" badge, or the refusal is ' +
    'an invisible no-op and the card just looks broken.',
  );
});

test('the Refresh button surfaces the refusal to the dispatcher', () => {
  assert.ok(
    /const refusal = onRefreshed\?\.\(d\.stop\);\s*\n\s*if \(refusal\) setRefreshErr\(refusal\)/.test(src),
    'StopLiveDetail must show the funnel refusal as its refresh error — a silent refusal ' +
    'reads as a broken Refresh button.',
  );
});
