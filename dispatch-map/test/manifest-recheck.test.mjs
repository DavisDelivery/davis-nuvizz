// test/manifest-recheck.test.mjs — asking the board again.
//
// Chad, Saturday 10:42, on a card that had not moved since the 1:10a pass: "If we ran a scan
// this morning to complete the board from last week which looks like we did. It should have
// fixed the manifest incompleteness." It could not have: nothing but a NEW report email can
// rewrite that card, and an already-checked email is marked and skipped for ever. These pin
// the pure parts of the endpoint that closes the gap.
import test from 'node:test';
import assert from 'node:assert/strict';

import { pickNight, parseLookback, addDays } from '../netlify/functions/manifest-recheck.mts';

const night = (date, latest) => ({ date, doc: latest ? { latest } : null });
const filed = (over = {}) => ({ blobKey: 'davis/2026-09-11.pdf', pdfStored: true, fileName: 'r.pdf', orders: 556, ...over });

test('the NEWEST night with a stored PDF is the one re-checked', () => {
  const pick = pickNight([
    night('2026-09-12', null),                       // no report filed that night
    night('2026-09-11', filed({ fileName: 'friday.pdf' })),
    night('2026-09-10', filed({ fileName: 'thursday.pdf' })),
  ]);
  assert.equal(pick.date, '2026-09-11');
  assert.equal(pick.latest.fileName, 'friday.pdf');
  assert.deepEqual(pick.skipped, [], 'a night with no report at all is not a complaint');
});

test('a night RECORDED but whose PDF never stored is skipped — and says why', () => {
  // pdfStored:false is a real state the archive writes on purpose. Treating it as usable
  // would read nothing and then report on nothing, which is the blank screen this repo has
  // burned an evening on: a job that wrote nothing and a panel that got nothing look alike.
  const pick = pickNight([
    night('2026-09-12', filed({ pdfStored: false, pdfError: 'blob store 500' })),
    night('2026-09-11', filed({ fileName: 'friday.pdf' })),
  ]);
  assert.equal(pick.date, '2026-09-11', 'it falls through to the night it CAN read');
  assert.equal(pick.skipped.length, 1);
  assert.equal(pick.skipped[0].date, '2026-09-12');
  assert.match(pick.skipped[0].why, /PDF was not stored/);
});

test('a record with no blobKey is unusable however cheerful pdfStored is', () => {
  const pick = pickNight([night('2026-09-12', filed({ blobKey: null, pdfStored: true }))]);
  assert.equal(pick.date, null);
  assert.equal(pick.skipped.length, 1);
});

test('nothing on file at all returns nothing, not a wrong night', () => {
  assert.deepEqual(pickNight([]), { date: null, latest: null, skipped: [] });
  assert.equal(pickNight([night('2026-09-12', null), night('2026-09-11', null)]).date, null);
  assert.equal(pickNight(null).date, null, 'a failed read is not an empty archive');
});

test('an absent ?days= means the default, NOT zero', () => {
  // `Number(null)` is 0 and 0 is finite — the trap CLAUDE.md names by hand, and the one that
  // made the drop-zone check diff against ONE day while the email path checked two.
  assert.equal(parseLookback(null), 7);
  assert.equal(parseLookback(undefined), 7);
  assert.equal(parseLookback(''), 7, 'an empty string is not a request for zero days');
  assert.equal(parseLookback('garbage'), 7);
  assert.equal(parseLookback('1'), 1);
  assert.equal(parseLookback('14'), 14);
  assert.equal(parseLookback('999'), 30, 'bounded — one click must not read a year of archive');
  assert.equal(parseLookback('-4'), 1);
});

test('the walk back is on the DIGITS and cannot lose a day to a timezone', () => {
  assert.equal(addDays('2026-09-12', -1), '2026-09-11');
  assert.equal(addDays('2026-09-01', -1), '2026-08-31');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  // Across the EDT→EST changeover, where a midnight-anchored date walk drops or repeats one.
  assert.equal(addDays('2026-11-02', -1), '2026-11-01');
  assert.equal(addDays('2026-11-01', -1), '2026-10-31');
});
