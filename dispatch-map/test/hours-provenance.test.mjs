// test/hours-provenance.test.mjs — CAN A DISPATCHER TELL A PARSE FROM A PHONE CALL?
//
// Chad, 2026-09-14, looking at a WEAVER DISTRIBUTORS stop card reading MON–SUN 8:00a–12:00p:
// "i think that our system auto updated the hours at the bottom." He was right, and the card
// gave him no way to know — the grid renders seven days and says nothing about who set them.
// Hours a human typed after phoning the dock and hours a regex read off one Uline order look
// identical there, and they call for opposite actions.
import test from 'node:test';
import assert from 'node:assert/strict';

import { hoursProvenance, hasStoredHours } from '../src/lib/hours-provenance.js';

const day = (open, close) => ({ open, close });
const week = (open, close) => Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, day(open, close)]),
);

test('THE WEAVER CARD: scanner-written hours say so, and carry the text they were read from', () => {
  const note = {
    receiving_hours: week('08:00', '17:00'),
    auto_sources: { receiving_hours: ['orderInstructions'] },
    auto_matches: {
      receiving_hours: [{
        source: 'orderInstructions',
        text: 'RH 8 00AM-12 00PM LUNCH 12 00-1 30PM RH 1 30PM-5 00PM',
        pattern: 'hours_range',
      }],
    },
  };
  const p = hoursProvenance(note);
  assert.equal(p.kind, 'auto');
  assert.match(p.label, /verify/i);
  assert.match(p.detail, /order/i);
  // THE LUNCH LINE SURVIVES ON THE CARD even though the stored window is the envelope — the
  // schema holds one window per day, so this text is the only place the break is visible.
  assert.match(p.matchedText, /LUNCH 12 00-1 30PM/);
});

test('a dispatcher-latched field says a human owns it, and promises the parser will not move it', () => {
  const p = hoursProvenance({
    receiving_hours: week('08:00', '14:00'),
    manual_overrides: { receiving_hours: true },
    // The latch wins even when a scanner trail is also on the doc — a human typed over it.
    auto_sources: { receiving_hours: ['orderInstructions'] },
    auto_matches: { receiving_hours: [{ source: 'orderInstructions', text: 'RH 8-2', pattern: 'hours_range' }] },
  });
  assert.equal(p.kind, 'dispatcher');
  assert.match(p.detail, /will not change/i);
  assert.equal(p.matchedText, '', 'a typed window has no matched text to show');
});

test('hours with no trail either way are reported as unknown, never laundered into "typed"', () => {
  const p = hoursProvenance({ receiving_hours: { mon: day('08:00', '17:00') } });
  assert.equal(p.kind, 'unrecorded');
  assert.match(p.label, /not recorded/i);
});

test('the blank seven-day skeleton is NOT hours — no grid, no provenance line', () => {
  // emptyNote() seeds all seven days blank to keep the time inputs controlled, and every note
  // save persists it. Counting keys instead of values is the exact bug that once made the
  // scanner treat an un-owned doc as locked (v0.76.7); it must not return as a phantom line.
  assert.equal(hasStoredHours({ receiving_hours: week('', '') }), false);
  assert.equal(hoursProvenance({ receiving_hours: week('', '') }), null);
  assert.equal(hoursProvenance({}), null);
  assert.equal(hoursProvenance(null), null);
  assert.equal(hoursProvenance({ receiving_hours: {} }), null);
});

test('one real day among blanks IS hours on file — a dispatcher who set Monday only', () => {
  const note = { receiving_hours: { ...week('', ''), mon: day('08:00', '12:00') } };
  assert.equal(hasStoredHours(note), true);
  assert.equal(hoursProvenance(note).kind, 'unrecorded');
});

test('legacy M2.x range strings count as hours on file', () => {
  assert.equal(hasStoredHours({ receiving_hours: { mon: '6AM-2PM' } }), true);
  assert.equal(hasStoredHours({ receiving_hours: { mon: '   ' } }), false);
});

test('the curated address line is named as such — the two sources are not equally trustworthy', () => {
  const p = hoursProvenance({
    receiving_hours: week('07:00', '15:00'),
    auto_sources: { receiving_hours: ['addressLine2'] },
    auto_matches: { receiving_hours: [{ source: 'addressLine2', text: 'RH 7-3', pattern: 'hours_range' }] },
  });
  assert.equal(p.kind, 'auto');
  assert.equal(p.matchedSource, 'addressLine2');
  assert.match(p.detail, /curate/i);
});

test('a match with no sources array still reads as auto — the trail is the fingerprint', () => {
  const p = hoursProvenance({
    receiving_hours: week('08:00', '17:00'),
    auto_matches: { receiving_hours: [{ source: 'orderInstructions', text: 'RH 8-5', pattern: 'hours_range' }] },
  });
  assert.equal(p.kind, 'auto');
  assert.equal(p.matchedText, 'RH 8-5');
});

test('garbled trails never throw and never invent a source', () => {
  for (const bad of [
    { receiving_hours: week('08:00', '17:00'), auto_sources: { receiving_hours: [] } },
    { receiving_hours: week('08:00', '17:00'), auto_sources: { receiving_hours: 'orderInstructions' } },
    { receiving_hours: week('08:00', '17:00'), auto_matches: { receiving_hours: [] } },
    { receiving_hours: week('08:00', '17:00'), auto_matches: { receiving_hours: [{}] } },
  ]) {
    const p = hoursProvenance(bad);
    assert.ok(p, 'hours are on file, so something must be said about them');
    assert.ok(['auto', 'unrecorded'].includes(p.kind));
    assert.equal(typeof p.matchedText, 'string');
  }
});
