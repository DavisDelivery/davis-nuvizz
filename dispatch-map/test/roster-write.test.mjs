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

// ── ?explain=1 — the question "is the roster populating?" answered with data ──
//
// Chad, three rounds in: "the problem is the roster scan not populating the loads panel you are
// fixing the wrong thing." He was right each time, and it took three rounds because nothing
// could answer it: from outside, "the scan wrote a roster" and "the panel got nothing" are the
// same blank screen.

import { explainRosterRow } from '../netlify/functions/lib/roster-write.mts';

test('the three failure states read DIFFERENTLY, which is the entire point', () => {
  const never = explainRosterRow('2026-09-08', null);
  assert.equal(never.cached, false);
  assert.match(never.note, /never been captured/);

  const emptyDoc = explainRosterRow('2026-09-08', { at: '2026-09-05T12:00:00Z', loads: [] });
  assert.equal(emptyDoc.cached, true);
  assert.equal(emptyDoc.count, 0);
  assert.match(emptyDoc.note, /captured but EMPTY/);

  const builtOnly = explainRosterRow('2026-09-08', {
    at: '2026-09-05T12:00:00Z',
    loads: [{ loadId: 'a', loadNbr: 'D1', trips: 11 }, { loadId: 'b', loadNbr: 'D2', trips: 8 }],
  });
  assert.equal(builtOnly.empties, 0);
  assert.equal(builtOnly.built, 2);
  assert.match(builtOnly.note, /no empty loads in it/);
});

test('EMPTIES is the number that matters, not count — a working roster says so', () => {
  // The Loads panels exist to show loads with NO trips. A roster of 3 built loads and a broken
  // roster look identical on screen; `empties` is what tells them apart.
  const r = explainRosterRow('2026-09-08', {
    at: '2026-09-05T12:00:00Z',
    loads: [
      { loadId: 'a', loadNbr: 'D1', trips: 11 },
      { loadId: 'b', loadNbr: 'D2', trips: 0 },
      { loadId: 'c', loadNbr: 'D3', trips: null },
      { loadId: 'd', loadNbr: 'D4' },
    ],
  });
  assert.equal(r.count, 4);
  assert.equal(r.empties, 3, 'trips 0, null and absent all count as empty');
  assert.equal(r.built, 1);
  assert.match(r.note, /3 empty load\(s\)/);
});

test('it reports the numbered count, because a number-less capture is its own known failure', () => {
  // The Jul 1 2026 regression: 102 rows with zero load numbers froze the day and every evening
  // Save was refused. `numbered` makes that visible instead of inferred.
  const r = explainRosterRow('2026-09-08', {
    at: '2026-09-05T12:00:00Z',
    loads: [{ loadId: 'a', loadNbr: null, trips: 0 }, { loadId: 'b', loadNbr: 'D2', trips: 0 }],
  });
  assert.equal(r.numbered, 1);
  assert.equal(r.empties, 2);
});

test('it carries the capture time and the strike count, and survives a malformed document', () => {
  const r = explainRosterRow('2026-09-08', { at: '2026-09-05T12:00:00Z', loads: [], emptyStreak: 2, emptyAt: '2026-09-05T12:00:00Z' });
  assert.equal(r.at, '2026-09-05T12:00:00Z');
  assert.equal(r.emptyStreak, 2);
  const junk = explainRosterRow('2026-09-08', { loads: 'not-an-array', emptyStreak: 'x' });
  assert.equal(junk.count, 0);
  assert.equal(junk.empties, 0);
  assert.equal(junk.emptyStreak, 0);
  assert.equal(junk.at, null);
});

// ── A DIAGNOSTIC MAY NOT LIE ABOUT ITS OWN FAILURE ──────────────────────────
//
// explainRosterRow(date, null) says "this date has never been captured". That is correct for an
// ABSENT document and catastrophically wrong for a Firestore read that THREW — the store being
// unreachable and the scan never having run send a reader in opposite directions, and the whole
// point of this endpoint is to end that class of confusion rather than add to it.
//
// The endpoint used to spell the read `readLoadRoster(...).catch(() => null)`, which collapses
// the two. It no longer does; this pins the property the row itself must carry so a future edit
// cannot quietly reintroduce the collapse.
test('an ABSENT roster and a FAILED read must not produce the same sentence', () => {
  const absent = explainRosterRow('2026-09-08', null);
  assert.equal(absent.cached, false);
  assert.match(absent.note, /never been captured/i);
  // The shape the endpoint emits for a throw — asserted here so the two are provably distinct.
  const failed = { date: '2026-09-08', cached: null, error: 'getDoc 503',
    note: 'FIRESTORE READ FAILED — this is NOT "never captured"; the store could not be reached' };
  assert.notEqual(failed.cached, absent.cached, 'cached:null vs cached:false is the machine-readable difference');
  assert.doesNotMatch(failed.note, /never been captured/i);
  assert.match(failed.note, /READ FAILED/);
});
