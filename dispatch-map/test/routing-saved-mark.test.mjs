// test/routing-saved-mark.test.mjs — the ✓ a Compare card wears once its save landed.
//
// Chad, 2026-09-16: "I want a check mark somewhere denoting that the save to nuvizz was
// successful."
//
// The rule these pin is the one in CLAUDE.md: never report an intent as an outcome. A tick
// on a load NuVizz does not hold is freight that reads as routed and never gets driven —
// so every case below is written from the dispatcher's side of the screen, not the code's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { savedMark, fmtClockMs } from '../src/lib/routing-select.js';

const at = (h, m) => new Date(2026, 8, 16, h, m, 0, 0).getTime();   // local clock, like the card

test('A CONFIRMED SAVE PUTS A TICK ON THE CARD, WITH THE TIME IT LANDED', () => {
  const mk = savedMark({ savedAt: at(14, 14), dirty: false });
  assert.equal(mk.show, true);
  assert.equal(mk.kind, 'sent');
  assert.match(mk.label, /^✓ /, `the ask was a check mark: ${mk.label}`);
  assert.match(mk.label, /2:14 PM/);
  assert.match(mk.title, /NuVizz/);
});

test('THE TICK GOES THE MOMENT THE CARD STOPS MATCHING WHAT WAS SENT', () => {
  // The expensive direction: a dispatcher drags a stop onto a saved card, the card still
  // says SENT, and a stop that is only on this screen reads as routed.
  const mk = savedMark({ savedAt: at(14, 14), dirty: true });
  assert.equal(mk.show, false);
  assert.equal(mk.kind, 'stale');
  assert.equal(mk.label, '');
});

test('and it comes back on the next confirmed save, not on the edit', () => {
  const edited = savedMark({ savedAt: at(14, 14), dirty: true });
  const resent = savedMark({ savedAt: at(14, 31), dirty: false });
  assert.equal(edited.show, false);
  assert.equal(resent.show, true);
  assert.match(resent.label, /2:31 PM/, 'the tick must carry the LATEST save, not the first');
});

test('A CARD NOBODY HAS SAVED CLAIMS NOTHING — no stamp, no tick', () => {
  for (const savedAt of [null, undefined, '', NaN]) {
    const mk = savedMark({ savedAt, dirty: false });
    assert.equal(mk.show, false, `savedAt=${String(savedAt)} must not claim a save`);
    assert.equal(mk.label, '');
  }
  assert.equal(savedMark().show, false);
  assert.equal(savedMark({}).show, false);
});

test('ZERO IS NOT A TIMESTAMP — Number(null) is 0 and 0 is finite', () => {
  // The shape that once mailed a customer a midnight deadline for a stop with no deadline:
  // a falsy value that survives every finite check. A card must not claim a 1970 save.
  assert.equal(savedMark({ savedAt: 0 }).show, false);
  assert.equal(savedMark({ savedAt: -1 }).show, false);
  assert.equal(savedMark({ savedAt: '0' }).show, false);
});

test('a numeric string stamp still reads as a save', () => {
  const mk = savedMark({ savedAt: String(at(9, 5)), dirty: false });
  assert.equal(mk.show, true);
  assert.match(mk.label, /9:05 AM/);
});

test('THE RULE SAYS ONLY THAT THE SAVE WORKED — it has no "not sent" state', () => {
  // The amber NOT SENT TO NUVIZZ chip, the header wording and the map-paint rule of
  // v1.33.0 were reverted in v1.36.1 and were NOT asked for here. A card with nothing
  // saved renders nothing at all; if this rule ever grows a second, louder state it is
  // rebuilding the thing Chad rolled back.
  for (const c of [{}, { savedAt: null }, { savedAt: at(8, 0), dirty: true }]) {
    const mk = savedMark(c);
    assert.equal(mk.label, '', `${JSON.stringify(c)} must render nothing, not a warning`);
  }
  assert.equal(savedMark({ savedAt: at(8, 0) }).kind, 'sent');
});

test('the clock is the dispatcher’s, 12-hour with a padded minute', () => {
  assert.equal(fmtClockMs(at(0, 7)), '12:07 AM');   // midnight is 12, never 0
  assert.equal(fmtClockMs(at(12, 0)), '12:00 PM');  // noon is PM, never 0 AM
  assert.equal(fmtClockMs(at(13, 5)), '1:05 PM');
  assert.equal(fmtClockMs(at(23, 59)), '11:59 PM');
});

test('a malformed stamp formats to nothing rather than "Invalid Date"', () => {
  for (const v of [null, undefined, 0, -1, NaN, 'soon', {}]) assert.equal(fmtClockMs(v), '');
});
