// test/card-saved-before.test.mjs
//
// A ROUTE THAT WAS SAVED, CLOSED AND BROUGHT BACK STILL CARRIES ITS GREEN ✓.
//
// Chad, 2026-09-30: "I want saved route to always carry a green check mark if it has saved
// previously say if a route was closed out and re brought up but keep the message as is for a
// route that just saved."
//
// Two halves, and the second is the one that is easy to break while building the first: the
// card that just saved must keep its "✓ SENT 7:42 AM" message exactly as it was, and its ✗ too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { savedMark } from '../src/lib/routing-select.js';
import { cardSaveIds, recordCardOutcome, mergeCardSaves, pruneCardSaves, earlierOutcome, sameRunOrder, CARD_SAVES_TTL_MS } from '../src/lib/card-saves.js';

const T = (h, m = 0) => new Date(2026, 8, 30, h, m).getTime();   // Sep 30, local clock

// ── the mark ────────────────────────────────────────────────────────────────
test('A ROUTE SAVED, CLOSED AND REOPENED WEARS THE GREEN ✓ — its own stamp is gone, the load\'s record is not', () => {
  const mk = savedMark({ savedAt: null, failedAt: null, dirty: false, earlierSavedAt: T(7, 42) });
  assert.equal(mk.show, true);
  assert.equal(mk.kind, 'saved-before');
  assert.equal(mk.label, '✓');
  assert.match(mk.title, /Saved to NuVizz at 7:42 AM on Sep 30 from this device/);
  assert.match(mk.title, /still shows exactly the stops, in the order, that save carried/);
  // Honest about what it cannot see.
  assert.match(mk.title, /cannot see a change made in the NuVizz portal or on another device/);
});

test('THE MESSAGE STAYS AS IS FOR A ROUTE THAT JUST SAVED — its own stamp wins over the record', () => {
  const now = savedMark({ savedAt: T(9, 5), earlierSavedAt: T(7, 42) });
  assert.equal(now.kind, 'sent');
  assert.equal(now.label, '✓ SENT 9:05 AM');
  // Byte for byte what it said before this change, with no record at all.
  assert.deepEqual(now, savedMark({ savedAt: T(9, 5) }));
});

test('…and so does the ✗ — a send refused this session is not covered up by an older save', () => {
  const mk = savedMark({ failedAt: T(9, 5), earlierSavedAt: T(7, 42) });
  assert.equal(mk.kind, 'failed');
  assert.equal(mk.label, '✗ DID NOT SAVE 9:05 AM');
});

test('the reopened ✓ goes the moment the card stops matching the board it was rebuilt from', () => {
  const mk = savedMark({ dirty: true, earlierSavedAt: T(7, 42) });
  assert.equal(mk.show, false);
  assert.equal(mk.kind, 'stale');
});

test('A LOAD WHOSE LATEST SEND ON RECORD WAS REFUSED CARRIES NO ✓ — a tie goes to the refusal', () => {
  assert.equal(savedMark({ earlierSavedAt: T(7, 42), earlierFailedAt: T(8, 0) }).show, false);
  assert.equal(savedMark({ earlierSavedAt: T(7, 42), earlierFailedAt: T(7, 42) }).show, false);
  // Refused, then fixed and saved: the later save is the truth.
  assert.equal(savedMark({ earlierSavedAt: T(8, 30), earlierFailedAt: T(8, 0) }).kind, 'saved-before');
});

test('a load never saved claims nothing, and a zero is not a timestamp', () => {
  for (const e of [null, undefined, 0, '0', 'garbage', -5]) {
    assert.deepEqual(savedMark({ earlierSavedAt: e }), { show: false, kind: 'none', label: '', title: '', clock: '' });
  }
});

test('a save made last night says which day, so it cannot read as a time this morning', () => {
  const mk = savedMark({ earlierSavedAt: new Date(2026, 8, 29, 19, 15).getTime() });
  assert.match(mk.title, /7:15 PM on Sep 29/);
});

test('ON A PHONE (no hover) the ✓ says WHEN: the clock today, the day if it was not today', () => {
  assert.equal(savedMark({ earlierSavedAt: T(7, 42), now: T(9) }).short, '7:42 AM');
  assert.equal(savedMark({ earlierSavedAt: new Date(2026, 8, 29, 19, 15).getTime(), now: T(9) }).short, 'Sep 29');
});

// ── the record behind it ──────────────────────────────────────────────────────
test('A LOAD IS KNOWN BY ITS ID AND ITS REAL NUMBER — NEVER BY ITS ROUTE NAME', () => {
  // Friday's MARCUS (DAVIS000204535) and Monday's MARCUS (DAVIS000204645) read the same by name.
  assert.deepEqual(cardSaveIds({ key: 'MARCUS', name: 'MARCUS', loadNbr: 'DAVIS000204645', loadId: '6a3560cb52ef82bd1ed4516b' }),
    ['id:6a3560cb52ef82bd1ed4516b', 'nbr:DAVIS000204645']);
  assert.deepEqual(cardSaveIds({ key: 'MARCUS', name: 'MARCUS', loadNbr: 'MARCUS', loadId: null }), []);
  assert.deepEqual(cardSaveIds({ loadNbr: 'davis000204645' }), ['nbr:DAVIS000204645']);
  for (const bad of [null, undefined, {}, { loadId: 'null' }, { loadId: '  ' }]) assert.deepEqual(cardSaveIds(bad), []);
});

test('MONDAY\'S MARCUS DOES NOT INHERIT FRIDAY\'S ✓ — the record is per load, not per name', () => {
  const friday = { loadNbr: 'DAVIS000204535', loadId: 'aaaaaaaaaaaaaaaaaaaaaaaa' };
  const monday = { loadNbr: 'DAVIS000204645', loadId: 'bbbbbbbbbbbbbbbbbbbbbbbb' };
  const map = recordCardOutcome({}, cardSaveIds(friday), 'saved', T(7, 0), ['1', '2']);
  assert.equal(earlierOutcome(map, cardSaveIds(monday)).savedAt, null);
  assert.equal(earlierOutcome(map, cardSaveIds(friday)).savedAt, T(7, 0));
});

test('a load saved under its id is found again when it reopens known only by its number, and back', () => {
  // A ＋ New route is recorded with both (from the create's result); a reopened card may resolve
  // either, depending on what the board and the roster hold at the time.
  const map = recordCardOutcome({}, cardSaveIds({ loadId: 'cccccccccccccccccccccccc', loadNbr: 'DAVIS000205000' }), 'saved', T(7, 0), ['1']);
  assert.equal(earlierOutcome(map, cardSaveIds({ loadNbr: 'DAVIS000205000' })).savedAt, T(7, 0));
  assert.equal(earlierOutcome(map, cardSaveIds({ loadId: 'cccccccccccccccccccccccc' })).savedAt, T(7, 0));
});

test('the record keeps the LATEST save and the LATEST refusal, never mutating what it was given', () => {
  const ids = ['id:x'];
  const a = recordCardOutcome({}, ids, 'saved', T(9, 0), ['3', '2', '1']);
  const b = recordCardOutcome(a, ids, 'saved', T(7, 0), ['1', '2', '3']);   // an older save arriving late
  const c = recordCardOutcome(b, ids, 'failed', T(10, 0));
  assert.deepEqual(a, { 'id:x': { savedAt: T(9, 0), order: ['3', '2', '1'] } });
  assert.deepEqual(earlierOutcome(c, ids), { savedAt: T(9, 0), failedAt: T(10, 0), order: ['3', '2', '1'] }, 'the late older save did not replace the newer order');
  for (const [ids2, kind, at, order] of [[[], 'saved', T(9), ['1']], [ids, 'bogus', T(9), null], [ids, 'saved', 0, ['1']], [null, 'saved', T(9), ['1']], [ids, 'saved', T(9), null]]) {
    assert.equal(recordCardOutcome(a, ids2, kind, at, order), a, 'a malformed write — or a save with no order to hold a card to — changes nothing');
  }
});

test('the record ages out after a week and drops anything malformed', () => {
  const now = T(12);
  const map = {
    'id:fresh': { savedAt: now - 1000, order: ['1'] },
    'id:old': { savedAt: now - CARD_SAVES_TTL_MS - 1 },
    'id:junk': 'not an object',
    'id:zero': { savedAt: 0 },
    'id:failed-only': { failedAt: now - 1000 },
  };
  assert.deepEqual(Object.keys(pruneCardSaves(map, now)).sort(), ['id:failed-only', 'id:fresh']);
  assert.deepEqual(pruneCardSaves(null, now), {});
  assert.deepEqual(pruneCardSaves('corrupt localStorage', now), {});
});

// ── the review's findings, pinned ─────────────────────────────────────────────
test('A SAVE THAT CANCELLED THE LOAD OUTRANKS EVERY EARLIER SAVE — a cancelled route never wears a ✓', () => {
  const ids = ['id:trailer6'];
  let map = recordCardOutcome({}, ids, 'saved', T(7), ['1', '2']);
  map = recordCardOutcome(map, ids, 'cancelled', T(9));
  const e = earlierOutcome(map, ids);
  assert.equal(e.failedAt, T(9));
  assert.equal(savedMark({ earlierSavedAt: e.savedAt, earlierFailedAt: e.failedAt }).show, false);
});

test('TWO TABS MERGE, THEY DO NOT OVERWRITE — the refusal tab B recorded survives tab A\'s next save', () => {
  // 7:00 tab A saves X. 7:42 tab B (stale copy) records X refused. 8:00 tab A saves Y from ITS copy.
  const tabA = recordCardOutcome({}, ['id:x'], 'saved', T(7), ['1']);
  const stored = recordCardOutcome(tabA, ['id:x'], 'failed', T(7, 42));       // what B wrote
  const afterA = recordCardOutcome(mergeCardSaves(stored, tabA), ['id:y'], 'saved', T(8), ['9']);
  const e = earlierOutcome(afterA, ['id:x']);
  assert.equal(e.failedAt, T(7, 42), 'the refusal was lost');
  assert.equal(savedMark({ earlierSavedAt: e.savedAt, earlierFailedAt: e.failedAt }).show, false);
  assert.equal(earlierOutcome(afterA, ['id:y']).savedAt, T(8));
});

test('mergeCardSaves keeps each field\'s latest stamp and the order of the latest save', () => {
  const m = mergeCardSaves({ k: { savedAt: T(9), order: ['b'], failedAt: T(7) } }, { k: { savedAt: T(8), order: ['a'], cancelledAt: T(10) } });
  assert.deepEqual(m.k, { savedAt: T(9), order: ['b'], failedAt: T(7), cancelledAt: T(10) });
  assert.deepEqual(mergeCardSaves(null, 'junk'), {});
});

test('THE REOPENED CARD MUST SHOW WHAT WAS SENT — same stops, same order', () => {
  assert.equal(sameRunOrder(['1', '2', '3'], ['1', '2', '3']), true);
  assert.equal(sameRunOrder(['1', '2', '3'], ['3', '2', '1']), false, 'the board still holds the order from before the save');
  assert.equal(sameRunOrder(['1', '2', '3'], ['1', '2']), false, 'a stop is now staged on another card, or was unplanned in the portal');
  assert.equal(sameRunOrder(['1', '2'], ['1', '2', '4']), false, 'a stop was added since');
  assert.equal(sameRunOrder(null, ['1']), false);
  assert.equal(sameRunOrder([], []), false, 'an empty card was never a saved route');
});

test('…but two orders at one dock may come back from the scan in either order', () => {
  const dock = { 1: 'A', 2: 'B', 3: 'B', 4: 'C' };
  assert.equal(sameRunOrder(['1', '2', '3', '4'], ['1', '3', '2', '4'], (id) => dock[id]), true);
  // Not at one dock: a swap is a real change.
  assert.equal(sameRunOrder(['1', '2', '3', '4'], ['1', '2', '4', '3'], (id) => dock[id]), false);
});
