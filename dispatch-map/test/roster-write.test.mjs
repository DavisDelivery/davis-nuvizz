// test/roster-write.test.mjs — an empty answer may not silently erase a good roster, and it
// may not make every page load pay for the same nothing.
//
// Chad, on the deployed v0.93.3: "load roster 35833 this scan is not loading loads to system
// like it should also each refresh is causing like 14 calls when it should only be 3 or 4 …
// routes is only supposed to show loads with stops on them and that is what the bottom panel
// is doing that it didn't used to do."
//
// Two symptoms, one loop, every step of it in the code:
//   1. loadRosterForDate returns [] WITHOUT THROWING when the response carries no column defs
//      (nuvizz-loads.mts:70) — a 200 of an unexpected shape is an empty roster, not an error.
//   2. writeLoadRoster is a bare setDoc, a REPLACE. So that empty answer erased a hundred loads.
//   3. An empty cache is never served (`if (cached && cached.loads.length)`), so from then on
//      every read fell through to a LIVE call — and the client has THREE automatic fetch sites,
//      so a page load cost three, and a date change three more, each rewriting the same nothing.
//
// That third one is now fixed in the endpoint rather than here: an automatic read never spends
// a vendor call at all, so there is no cooldown to tune and no clock to reason about. Chad:
// "i don't need 10 and i need it to fire when i manually refresh."
//
// This repo already refuses this exact shape of mistake twice: the scan will not prune a board
// it could not fully see, and finalizeCaptureSeal will not seal a zero-stop capture. The roster
// was the third and had no guard at all.
import test from 'node:test';
import assert from 'node:assert/strict';

import { acceptRosterWrite, ACCEPT_EMPTY_AFTER } from '../netlify/functions/lib/roster-write.mts';

const held = (n, over = {}) => ({ at: '2026-09-05T12:00:00Z', loads: Array.from({ length: n }, (_, i) => ({ loadId: `l${i}` })), ...over });
const rows = (n) => Array.from({ length: n }, (_, i) => ({ loadId: `f${i}` }));

// ── the write guard ──────────────────────────────────────────────────────────

test('a real list always writes, and clears the strike count', () => {
  assert.deepEqual(acceptRosterWrite(null, rows(106)).write, true);
  assert.equal(acceptRosterWrite(held(3, { emptyStreak: 2 }), rows(106)).emptyStreak, 0, 'a real answer resets it');
});

test('a SHRINK is a fact about the day, not a failure — 106 loads down to 3 still writes', () => {
  // Refusing shrinks would freeze Friday's roster onto Monday's board, which is its own bug.
  // Only the EMPTY case is refused, because only the empty case is indistinguishable from a
  // vendor hiccup.
  const v = acceptRosterWrite(held(106), rows(3));
  assert.equal(v.write, true);
  assert.match(v.reason, /3 load\(s\)/);
});

test('an EMPTY answer over a held roster is REFUSED — this is the bug Chad reported', () => {
  const v = acceptRosterWrite(held(106), []);
  assert.equal(v.write, false, '106 loads must not be erased by one odd 200');
  assert.equal(v.emptyStreak, 1);
  assert.match(v.reason, /REFUSED/);
  assert.match(v.reason, /106 held/);
});

test('…but a day whose loads really are all gone still lands, after enough strikes', () => {
  // "Refuse forever" is not an option: a stale list a dispatcher acts on is its own kind of
  // wrong. A blip does not repeat; a real emptying does.
  let cache = held(106);
  for (let i = 1; i < ACCEPT_EMPTY_AFTER; i++) {
    const v = acceptRosterWrite(cache, []);
    assert.equal(v.write, false, `strike ${i} must still refuse`);
    cache = { ...cache, emptyStreak: v.emptyStreak };
  }
  const last = acceptRosterWrite(cache, []);
  assert.equal(last.write, true, `the ${ACCEPT_EMPTY_AFTER}th consecutive empty is believed`);
  assert.match(last.reason, /believed/);
});

test('an empty answer over an absent or already-empty cache writes freely', () => {
  // Nothing to lose, and it is how a genuinely empty day gets recorded at all.
  assert.equal(acceptRosterWrite(null, []).write, true);
  assert.equal(acceptRosterWrite(undefined, []).write, true);
  assert.equal(acceptRosterWrite({ loads: [] }, []).write, true);
  assert.equal(acceptRosterWrite({}, []).write, true);
});

test('the strike count survives the malformed and never goes backwards', () => {
  for (const bad of [null, undefined, 'x', -3, NaN, {}]) {
    const v = acceptRosterWrite({ loads: [{}], emptyStreak: bad }, []);
    assert.equal(v.emptyStreak, 1, `emptyStreak=${JSON.stringify(bad)} restarts at 1, never below`);
  }
  assert.equal(acceptRosterWrite({ loads: [{}], emptyStreak: 1.7 }, []).emptyStreak, 2, 'a fractional count floors');
});

test('a non-array answer is treated as empty, not as one load', () => {
  // `rows()` guards this: `loads.length` on a non-array is undefined, and undefined > 0 is
  // false — but reading a count off a string would be worse than refusing it.
  for (const junk of [null, undefined, 'nope', 42, {}]) {
    assert.equal(acceptRosterWrite(held(9), junk).write, false, `${JSON.stringify(junk)} must not overwrite`);
  }
});

test('every verdict carries a reason, because a refusal must never be silent', () => {
  for (const v of [acceptRosterWrite(held(9), []), acceptRosterWrite(null, rows(2)), acceptRosterWrite({ loads: [] }, [])]) {
    assert.ok(v.reason && v.reason.length > 8, 'write verdicts explain themselves');
  }
});
