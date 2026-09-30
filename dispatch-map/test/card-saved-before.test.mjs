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
import { cardSaveIds, recordCardOutcome, pruneCardSaves, earlierOutcome, CARD_SAVES_TTL_MS } from '../src/lib/card-saves.js';

const T = (h, m = 0) => new Date(2026, 8, 30, h, m).getTime();   // Sep 30, local clock

// ── the mark ────────────────────────────────────────────────────────────────
test('A ROUTE SAVED, CLOSED AND REOPENED WEARS THE GREEN ✓ — its own stamp is gone, the load\'s record is not', () => {
  const mk = savedMark({ savedAt: null, failedAt: null, dirty: false, earlierSavedAt: T(7, 42) });
  assert.equal(mk.show, true);
  assert.equal(mk.kind, 'saved-before');
  assert.equal(mk.label, '✓');
  assert.match(mk.title, /Saved to NuVizz at 7:42 AM \(Sep 30\) on this device/);
  assert.match(mk.title, /closed and reopened/);
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
  assert.match(mk.title, /7:15 PM \(Sep 29\)/);
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
  const map = recordCardOutcome({}, cardSaveIds(friday), 'saved', T(7, 0));
  assert.equal(earlierOutcome(map, cardSaveIds(monday)).savedAt, null);
  assert.equal(earlierOutcome(map, cardSaveIds(friday)).savedAt, T(7, 0));
});

test('a load saved under its id is found again when it reopens known only by its number, and back', () => {
  // A ＋ New route is recorded with both (from the create's result); a reopened card may resolve
  // either, depending on what the board and the roster hold at the time.
  const map = recordCardOutcome({}, cardSaveIds({ loadId: 'cccccccccccccccccccccccc', loadNbr: 'DAVIS000205000' }), 'saved', T(7, 0));
  assert.equal(earlierOutcome(map, cardSaveIds({ loadNbr: 'DAVIS000205000' })).savedAt, T(7, 0));
  assert.equal(earlierOutcome(map, cardSaveIds({ loadId: 'cccccccccccccccccccccccc' })).savedAt, T(7, 0));
});

test('the record keeps the LATEST save and the LATEST refusal, never mutating what it was given', () => {
  const ids = ['id:x'];
  const a = recordCardOutcome({}, ids, 'saved', T(9, 0));
  const b = recordCardOutcome(a, ids, 'saved', T(7, 0));   // an older stamp arriving late
  const c = recordCardOutcome(b, ids, 'failed', T(10, 0));
  assert.deepEqual(a, { 'id:x': { savedAt: T(9, 0) } });
  assert.deepEqual(earlierOutcome(c, ids), { savedAt: T(9, 0), failedAt: T(10, 0) });
  for (const [ids2, kind, at] of [[[], 'saved', T(9)], [ids, 'bogus', T(9)], [ids, 'saved', 0], [null, 'saved', T(9)]]) {
    assert.equal(recordCardOutcome(a, ids2, kind, at), a, 'a malformed write changes nothing');
  }
});

test('the record ages out after a week and drops anything malformed', () => {
  const now = T(12);
  const map = {
    'id:fresh': { savedAt: now - 1000 },
    'id:old': { savedAt: now - CARD_SAVES_TTL_MS - 1 },
    'id:junk': 'not an object',
    'id:zero': { savedAt: 0 },
    'id:failed-only': { failedAt: now - 1000 },
  };
  assert.deepEqual(Object.keys(pruneCardSaves(map, now)).sort(), ['id:failed-only', 'id:fresh']);
  assert.deepEqual(pruneCardSaves(null, now), {});
  assert.deepEqual(pruneCardSaves('corrupt localStorage', now), {});
});
