// sweep-readout.test.mjs
//
// THE LINE THAT WOULD HAVE ANSWERED IT ON THE SCREEN.
//
// 2026-09-10: Chad added a number to the flag texts, got two texts himself, and the person he
// added got none. Nothing was broken — the number went on the OVERNIGHT list and the sweep
// that sent those texts fired at 6:00:50a, past the 6:00a cutoff where that list is dropped.
// Answering it took the config endpoint, the durable claim record and a read of flag-sms.mts.
// These tests pin the sentence that says it in one line, and the two silences that keep it
// honest when the record does not carry the answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepReadout, etClock } from '../src/lib/sweep-readout.js';

test('the 6:00a sweep says the overnight list was not on it — the real night, verbatim', () => {
  const r = sweepReadout({
    at: '2026-09-10T10:00:50.736Z', etMin: 360, recipients: 1, sent: 2, failed: 0,
    standingCount: 1, nightCount: 2, nightRode: false, smsEnabled: true, textsSilenced: false,
  });
  assert.equal(r.line, 'Last sweep 6:00a — 2 texts to 1 number. The overnight list (2) was NOT — it is dropped at 6:00a.');
  assert.equal(r.cutOff, true);
  // NOT a warning. The cutoff is the rule working; painting it red teaches people to ignore red.
  assert.equal(r.tone, 'plain');
});

test('a 10:00p sweep says the overnight list WAS on it', () => {
  const r = sweepReadout({ etMin: 1320, recipients: 3, sent: 0, nightCount: 2, nightRode: true, smsEnabled: true });
  assert.match(r.line, /Last sweep 10:00p — no flags to text; 3 numbers on the list\./);
  assert.match(r.line, /overnight list \(2\) was on this sweep/);
  assert.equal(r.cutOff, false);
});

test('a status doc written before nightRode existed says NOTHING about the overnight list', () => {
  // The guess would be right most nights and wrong on exactly the night somebody is looking.
  const r = sweepReadout({ etMin: 360, recipients: 1, sent: 2 });
  assert.equal(r.line, 'Last sweep 6:00a — 2 texts to 1 number.');
  assert.ok(!/overnight/i.test(r.line));
  assert.equal(r.cutOff, false);
});

test('an empty overnight list is not worth a sentence', () => {
  const r = sweepReadout({ etMin: 360, recipients: 1, sent: 1, nightCount: 0, nightRode: false });
  assert.ok(!/overnight/i.test(r.line));
  assert.equal(r.cutOff, false);
});

test('a failed send is the one thing that colours the line', () => {
  const r = sweepReadout({ etMin: 1320, recipients: 2, sent: 3, failed: 1, nightCount: 1, nightRode: true, smsEnabled: true });
  assert.match(r.line, /1 send failed\./);
  assert.equal(r.tone, 'warn');
});

test('texting switched off and texting not configured are different sentences', () => {
  const off = sweepReadout({ etMin: 1320, recipients: 0, sent: 0, textsSilenced: true, smsEnabled: true });
  assert.match(off.line, /switched off here on purpose/);
  const missing = sweepReadout({ etMin: 1320, recipients: 0, sent: 0, smsEnabled: false });
  assert.match(missing.line, /not configured on this deploy/);
  assert.equal(missing.tone, 'warn');
});

test('nothing to say is said as nothing — never as a half-line', () => {
  for (const bad of [null, undefined, {}, { etMin: null }, { etMin: 'x' }, 'nope']) {
    assert.equal(sweepReadout(bad), null);
  }
});

test('the clock reads in ET wall time, and midnight is 12:00a not 0:00a', () => {
  assert.equal(etClock(0), '12:00a');
  assert.equal(etClock(360), '6:00a');
  assert.equal(etClock(720), '12:00p');
  assert.equal(etClock(1320), '10:00p');
  assert.equal(etClock(NaN), null);
});
