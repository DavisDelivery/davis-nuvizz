// "WHY DID CUSTOMER SERVICE NOT HEAR ABOUT THIS ONE?"
//
// Chad, holding a phone showing an urgent red flag on SIMPLY CHARLOTTE MASON with a
// 10AM-12PM receiving window, at 12:33: "This popped up as an urgent red flag but no email
// was sent to customer service."
//
// Answering that took reading three modules, because nothing in the system could say it.
// Worse, the diagnostic endpoint built precisely to answer it filtered to tier === 'critical'
// — so it could not see a red row either, and reported a clean board. These tests pin the
// answer so it stays a one-request question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldReason, explainStop, normStopNbr, hoursProvenance, hoursCoverage, isBoardUrgent } from '../netlify/functions/eta-flag-check.mts';
import { selectAlertable, ALERT_TIERS } from '../netlify/functions/lib/flag-alert.mts';

const NOON = 12 * 60;
// The default row is CRITICAL because that is the only tier that emails since 2026-09-02
// (Chad: "We are only emailing on critical" — flag-alert.mts ALERT_MIN_TIER). Every test
// below that pins a rule OTHER than the tier gate needs a row the gate lets through, or it
// stops testing its own subject. The tests about red pass tier: 'red' explicitly.
const row = (o) => ({
  rule: 'hours_risk', tier: 'critical', stopNbr: '007164290', customer: 'SIMPLY CHARLOTTE MASON',
  routeName: 'AUBURN', closeMin: NOON, etaMin: NOON + 45, lateBy: 45, anchored: false,
  errorMin: 90, ...o,
});

test('THE CASE ON THE SCREENSHOT: a red flag before the close is now SILENT — and the endpoint says so', () => {
  // The incident that created this file was not "red does not email". It was that nobody
  // could find out WHY: the board showed an urgent flag, the inbox was empty, and the
  // diagnostic built to explain it shared the same blind spot and reported a clean board.
  //
  // Chad has since narrowed the policy himself — "I don't want a 100 Emails. We are only
  // emailing on critical" — so this row is deliberately silent again. What must never come
  // back is the silence with no explanation, which is what these three assertions pin.
  const got = selectAlertable([row({ tier: 'red' })], 11 * 60);
  assert.equal(got.length, 0, 'red is below the shipped floor');
  const why = heldReason(row({ tier: 'red' }), false, 11 * 60);
  assert.match(why, /tier is red/);
  assert.match(why, /only critical emails/);
  assert.match(why, /ALERT_MIN_TIER=critical/, 'and it names the switch, so the fix is findable');
  // …and the same row at the wide floor emails exactly as it did before.
  const wide = selectAlertable([row({ tier: 'red' })], 11 * 60, 0, 'red');
  assert.equal(wide.length, 1);
  assert.equal(wide[0].customer, 'SIMPLY CHARLOTTE MASON');
  assert.equal(heldReason(row({ tier: 'red' }), true, 11 * 60, 0, 'red'), null);
});

test('…and at 12:33, past a noon close, it is held — and SAYS SO', () => {
  // Chad asked for this one explicitly: "Yeah if we are already past the time shouldn't
  // send." So no email here is correct. What was missing was any way to learn that.
  const nowMin = 12 * 60 + 33;
  const got = selectAlertable([row({})], nowMin);
  assert.equal(got.length, 0);
  const why = heldReason(row({}), false, nowMin);
  assert.match(why, /window closed at 12:00p/);
  assert.match(why, /12:33p/);
});

test('the held reason names the tier when the tier is what stopped it', () => {
  // A tier that can never email says so by naming the bar that can.
  const why = heldReason(row({ tier: 'info' }), false, 11 * 60);
  assert.match(why, /tier is info/);
  assert.match(why, /only critical emails/);
  // …and the sentence follows the floor rather than being written out by hand, which is how
  // the screen and the inbox came to disagree in the first place.
  assert.match(heldReason(row({ tier: 'info' }), false, 11 * 60, 0, 'red'), /only critical and red email/);
});

// AMBER IS NO LONGER A FLAT "NEVER" — IT DEPENDS ON THE GATE, AND THE ANSWER MUST SAY SO.
// "tier is amber — only critical and red email" was true until the amber lead gate existed.
// With the gate on it is a confident lie: amber DOES email, just not this far from the close.
test('an amber row names the GATE, not a tier list — off, too far out, or no clock', () => {
  // AT THE FLOOR THAT HAS A GATE. Under the shipped floor the answer is the floor itself,
  // asserted in the test below: reporting "the gate is off" while AMBER_LEAD_GATE_MIN is 120
  // would send somebody to change a setting that is not the one holding the email.
  const off = heldReason(row({ tier: 'amber' }), false, 11 * 60, 0, 'red');
  assert.match(off, /amber/);
  assert.match(off, /gate is off|AMBER_LEAD_GATE_MIN=0/);

  // close is 12:00p, now is 8:00a => 240 minutes out, outside a 120-minute gate
  const farOut = heldReason(row({ tier: 'amber' }), false, 8 * 60, 120, 'red');
  assert.match(farOut, /outside the 120-minute amber gate/);
  assert.match(farOut, /240 min out/);

  const noClock = heldReason(row({ tier: 'amber' }), false, null, 120, 'red');
  assert.match(noClock, /no clock/);
});

test('…but under the SHIPPED floor an amber names the floor, not the gate', () => {
  // The gate answer would be a confident lie here: with the floor at critical the gate is
  // not what is holding this email, and "AMBER_LEAD_GATE_MIN=0" reads as "set it and you
  // will get these" — which is now false. Chad: "We are only emailing on critical."
  for (const gate of [0, 120, 600]) {
    const why = heldReason(row({ tier: 'amber' }), false, 11 * 60, gate);
    assert.match(why, /only critical emails/);
    assert.match(why, /the amber lead gate cannot open it/, `gate ${gate}`);
    assert.ok(!/gate is off/.test(why), 'never blame a gate that is not the blocker');
  }
});

test('a collapsed summary row says it is a summary, not a stop', () => {
  assert.match(heldReason(row({ collapsed: 4 }), false, 11 * 60), /collapsed summary row/);
});

test('a row with no receiving close says so rather than blaming the clock', () => {
  assert.match(heldReason(row({ closeMin: null }), false, 11 * 60), /no receiving close/);
});

test('an alertable row has no held reason at all', () => {
  assert.equal(heldReason(row({}), true, 11 * 60), null);
});

test('THE DRY RUN STILL LISTS RED ROWS AFTER RED STOPPED EMAILING — the list is the board, not the inbox', () => {
  // This is the original defect, and narrowing the floor is the exact condition that brings
  // it back. The endpoint filtered to tier === 'critical' once before; when Chad asked why a
  // red flag on SIMPLY CHARLOTTE MASON produced no email, the tool built to answer him could
  // not see the row and reported a clean board. A diagnostic that shares the mailer's scope
  // answers "nothing is wrong" to the one question it exists for.
  for (const tier of ['critical', 'red']) {
    assert.equal(isBoardUrgent(row({ tier })), true, `${tier} must stay visible`);
  }
  assert.equal(isBoardUrgent(row({ tier: 'amber' })), false, 'amber is a screen thing with the gate off');
  assert.equal(isBoardUrgent(row({ tier: 'amber' }), 120), true, 'and visible once the gate is on');
  assert.equal(isBoardUrgent(row({ rule: 'dup_number' })), false, 'other rules are not this list');
  // And the row it lists carries the REASON, which is the half the floor is allowed to move.
  assert.match(heldReason(row({ tier: 'red' }), false, 11 * 60), /only critical emails/);
});

// ── explainStop ──────────────────────────────────────────────────────────────

const STOPS = [{ stopNbr: '007164290', businessName: 'SIMPLY CHARLOTTE MASON', status: '10' }];

test('explainStop distinguishes NOT FLAGGED from FLAGGED BUT HELD', () => {
  // The difference is the whole question. "No flag" means the receiving hours never reached
  // the engine — the silent-zero failure. "Flagged but held" means a rule fired. Reporting
  // them the same way is how a broken parser looked like a quiet day.
  const notFlagged = explainStop('007164290', STOPS, [], new Set(), 11 * 60, []);
  assert.equal(notFlagged.found, true);
  assert.equal(notFlagged.flagged, false);
  assert.match(notFlagged.heldBecause, /no receiving close on file/);

  const held = explainStop('007164290', STOPS, [row({})], new Set(), 13 * 60, []);
  assert.equal(held.flagged, true);
  assert.equal(held.tier, 'critical');
  assert.match(held.heldBecause, /window closed/);
  // A RED row past its close reports the TIER, because that is the refusal the alert path
  // reaches first — the floor is tested above the clock in selectAlertable, and an
  // explanation that reorders them is explaining a different function than the one that ran.
  const redHeld = explainStop('007164290', STOPS, [row({ tier: 'red' })], new Set(), 13 * 60, []);
  assert.match(redHeld.heldBecause, /tier is red/);
});

test('explainStop reports an unknown PRO as not on the board', () => {
  const r = explainStop('999999999', STOPS, [], new Set(), 11 * 60, []);
  assert.equal(r.found, false);
  assert.match(r.note, /no stop with that number/);
});

test('explainStop matches the PRO with or without the -1 instance suffix', () => {
  // The card shows "PRO 007164290-1"; the board row carries "007164290". Someone reading a
  // number off a screen must not get "not found" for a stop that is right there.
  const r = explainStop('007164290-1', STOPS, [row({})], new Set(), 11 * 60, []);
  assert.equal(r.found, true);
  assert.equal(r.customer, 'SIMPLY CHARLOTTE MASON');
});

// ── CHAD'S "7165047", 2026-08-20 ─────────────────────────────────────────────
//
// "why was this not flagged to be late it was next to last delivery and closes at 2pm
// 7165047". The endpoint answered "no stop with that number on this board" — three times, on
// three different dates. The stop was on every one of them, as 007165047. A diagnostic that
// cannot find the stop does not return an error; it returns a confident, wrong answer.

test('a PRO typed WITHOUT its leading zeros still finds the stop', () => {
  const padded = [{ stopNbr: '007165047', businessName: 'METRO', status: '10' }];
  const r = explainStop('7165047', padded, [], new Set(), 11 * 60, []);
  assert.equal(r.found, true, 'the number on the paperwork must find the stop in the feed');
  assert.equal(r.customer, 'METRO');
});

test('normStopNbr strips padding and the split-order suffix, and keeps a lone zero', () => {
  assert.equal(normStopNbr('007165047'), '7165047');
  assert.equal(normStopNbr('7165047'), '7165047');
  assert.equal(normStopNbr(' 007165047-1 '), '7165047');
  assert.equal(normStopNbr('0'), '0', 'a real zero must not normalise to empty');
  assert.equal(normStopNbr(null), '');
});

// ── WHY THERE IS NO DEADLINE ─────────────────────────────────────────────────
//
// "close: null" was the whole answer, and it covers four situations with four different
// fixes. Only one of them is an engine problem.

test('hoursProvenance names WHICH way the hours are missing', () => {
  const day = 'thu';
  const withNote = (n) => new Map([['metro|k', n]]);
  const stop = { stopNbr: '007165047', matchKey: 'metro|k' };

  const noKey = hoursProvenance({ stopNbr: '1' }, withNote({}), day);
  assert.equal(noKey.noteOnFile, false);
  assert.match(noKey.why, /no customer match key/);

  const noNote = hoursProvenance(stop, new Map(), day);
  assert.equal(noNote.noteOnFile, false);
  assert.match(noNote.why, /no customer note on file/);
  assert.match(noNote.why, /metro\|k/, 'name the key so the gap is fixable');

  const blankDay = hoursProvenance(stop, withNote({ receiving_hours: { mon: '8-5' } }), day);
  assert.equal(blankDay.noteOnFile, true);
  assert.equal(blankDay.parsed, null);
  assert.match(blankDay.why, /no receiving hours recorded for thu/);

  const freeText = hoursProvenance(stop, withNote({ receiving_hours: { thu: 'call first' } }), day);
  assert.equal(freeText.raw, 'call first');
  assert.equal(freeText.parsed, null);
  assert.match(freeText.why, /not a comparable clock window/);

  const good = hoursProvenance(stop, withNote({ receiving_hours: { thu: { open: '08:00', close: '14:00' } } }), day);
  assert.deepEqual(good.parsed, { open: '8:00a', close: '2:00p', tier: 'auto' });
  assert.equal(good.why, null);
});

test('a stop WITH hours on file that simply is not late says so, and does not blame the data', () => {
  const stops = [{ stopNbr: '007165047', businessName: 'METRO', matchKey: 'metro|k', status: '10' }];
  const notes = new Map([['metro|k', { receiving_hours: { thu: { open: '08:00', close: '14:00' } } }]]);
  const r = explainStop('7165047', stops, [], new Set(), 11 * 60, [], { notes, dayKey: 'thu' });
  assert.equal(r.hours.parsed.close, '2:00p');
  assert.match(r.heldBecause, /receiving hours ARE on file/);

  // …and the same stop with nothing on file blames the data, by name.
  const bare = explainStop('7165047', stops, [], new Set(), 11 * 60, [], { notes: new Map(), dayKey: 'thu' });
  assert.equal(bare.hours.parsed, null);
  assert.match(bare.heldBecause, /no receiving close on file/);
  assert.match(bare.heldBecause, /no customer note on file/);
});

test('an already-emailed stop says THAT, not that it was held', () => {
  // Otherwise "no second email" reads as a failure instead of the once-per-day rule working.
  const r = explainStop('007164290', STOPS, [row({})], new Set(['007164290']), 11 * 60,
    [{ stopNbr: '007164290' }]);
  assert.equal(r.emailedToday, true);
  assert.match(r.heldBecause, /already emailed once today/);
});

test('the explain surface and the alert gate read the SAME tier list', () => {
  // They disagreed once. That disagreement is why a red flag could sit on the board with
  // nothing behind it and no way to find out.
  for (const tier of ALERT_TIERS) {
    assert.equal(selectAlertable([row({ tier })], 11 * 60).length, 1, `${tier} must alert`);
    assert.equal(heldReason(row({ tier }), true, 11 * 60), null);
  }
  // The enumeration still derives from ALERT_TIERS — checked on a tier the gate never
  // reaches, so this guard keeps testing drift rather than the amber wording.
  assert.match(heldReason(row({ tier: 'info' }), false, 11 * 60), /only critical emails/);
});

// ── "MAYBE THE PARSER NEEDS TO LEARN HOW THE NOTE WAS CONSTRUCTED" ───────────
//
// Chad, after METRO turned out to have perfectly good hours on file. The way to answer that
// is not to read one note and generalise — it is to ask the whole board how many customers
// carry hours the parser REFUSES, and show the text it refused. Only that bucket is one
// parser work can move; the rest is data entry, and conflating them sends the wrong fix.

test('hoursCoverage splits the gaps by what would actually fix each one', () => {
  const stop = (matchKey, over = {}) => ({ stopNbr: String(Math.random()), matchKey, ...over });
  const notes = new Map([
    ['parsed_auto|k', { receiving_hours: { thu: { open: '08:00', close: '14:00' } } }],
    ['parsed_typed|k', { receiving_hours: { thu: '6AM-2PM' }, manual_overrides: { receiving_hours: true } }],
    ['blank_today|k', { receiving_hours: { mon: '8-5', tue: '8-5' } }],
    ['never|k', { pin: { lat: 1, lng: 2 } }],
    ['freetext|k', { receiving_hours: { thu: 'call first' } }],
    ['overnight|k', { receiving_hours: { thu: { open: '21:00', close: '05:00' } } }],
    ['alsofreetext|k', { receiving_hours: { thu: 'call first' } }],
  ]);
  const stops = [
    stop('parsed_auto|k'), stop('parsed_auto|k'), stop('parsed_auto|k'), // one customer, 3 orders
    stop('parsed_typed|k'),
    stop('blank_today|k'),
    stop('never|k'),
    stop('freetext|k'),
    stop('overnight|k'),
    stop('alsofreetext|k'),
    stop('no_note_at_all|k'),
    { stopNbr: 'X' }, // no matchKey — cannot be looked up at all
  ];
  const c = hoursCoverage(stops, notes, 'thu');
  assert.equal(c.customers, 8, 'counted per customer, not per board row');
  assert.equal(c.stopsWithNoMatchKey, 1);
  assert.equal(c.parsedAuto, 1);
  assert.equal(c.parsedTyped, 1);
  assert.equal(c.blankToday, 1, 'hours on other weekdays but not this one — likeliest oversight');
  assert.equal(c.noHoursAnyDay, 1, 'a note exists but hours were never recorded');
  assert.equal(c.noNote, 1);
  // THE REFUSALS SPLIT BY WHO CAN FIX THEM — the distinction the first real run turned on.
  // An 804-customer board returned 7 refusals and every one was an hours record saved with a
  // blank close: no free text anywhere, nothing for a parser to learn. One combined number
  // would have read as "7 customers the parser is failing" and sent someone to rewrite it.
  assert.equal(c.refusedText, 2, 'two free-text strings — the only parser-fixable kind');
  assert.equal(c.refusedWindow, 1, 'the overnight dock is refused on purpose: policy, not parser');
  assert.equal(c.incompleteRecord, 0);
  // The samples are what makes this actionable: deduped SHAPES, not a customer list.
  assert.deepEqual(c.refusedSamples.filter((t) => t === 'call first').length, 1, 'deduped');
  assert.ok(c.refusedSamples.some((t) => t.includes('21:00')), 'the overnight window is shown as refused');
  assert.equal(c.refusedSamples.length, 2);
});

// THE SHAPE THE REAL BOARD ACTUALLY HAD, 2026-08-20: 804 customers, 7 refusals, and every
// one of them a receiving-hours record with the close left blank. Not one line of free text.
test('an hours record saved with a blank close is data entry, NOT a parser gap', () => {
  const notes = new Map([
    ['both_blank|k', { receiving_hours: { thu: { open: '', close: '' } } }],
    ['open_only|k', { receiving_hours: { thu: { open: '08:00', close: '' } } }],
    ['no_close_key|k', { receiving_hours: { thu: { open: '08:00' } } }],
  ]);
  const stops = [...notes.keys()].map((matchKey, i) => ({ stopNbr: String(i), matchKey }));
  const c = hoursCoverage(stops, notes, 'thu');
  assert.equal(c.incompleteRecord, 3, 'no close means nothing to be late against');
  assert.equal(c.refusedText, 0, 'and NOTHING here is a parser problem');
  assert.equal(c.refusedWindow, 0);
});

test('hoursCoverage caps its samples and never leaks a customer name', () => {
  const notes = new Map();
  const stops = [];
  for (let i = 0; i < 60; i += 1) {
    notes.set(`c${i}|k`, { receiving_hours: { thu: `weird text ${i}` } });
    stops.push({ stopNbr: String(i), matchKey: `c${i}|k`, businessName: `SECRET CO ${i}` });
  }
  const c = hoursCoverage(stops, notes, 'thu', { sampleCap: 5 });
  assert.equal(c.refusedText, 60, 'every one is counted');
  assert.equal(c.refusedSamples.length, 5, 'only the cap is shown');
  assert.ok(!c.refusedSamples.some((t) => t.includes('SECRET CO')), 'samples are hours text, never identities');
});

test('hoursCoverage on an empty board is zeros, not a crash', () => {
  const c = hoursCoverage([], null, null);
  assert.equal(c.customers, 0);
  assert.deepEqual(c.refusedSamples, []);
});

test('normStopNbr strips the instance suffix ONLY on an all-numeric PRO', () => {
  // Found while chasing the phantom-instance bug: a carrier-prefixed id is a whole
  // identifier. Stripping its tail collapsed every AVRT order onto the bare string "AVRT",
  // so any two of them matched each other and this endpoint would confidently explain the
  // wrong stop — a wrong answer dressed as an answer, which is the failure mode this
  // diagnostic exists to avoid.
  assert.equal(normStopNbr('007165852-1'), '7165852', 'a real instance suffix still strips');
  assert.equal(normStopNbr('AVRT-0028093763'), 'AVRT-0028093763', 'carrier id kept whole');
  assert.equal(normStopNbr('ESTES-0538243875'), 'ESTES-0538243875');
  assert.notEqual(normStopNbr('AVRT-0028093763'), normStopNbr('AVRT-0060538833'),
    'two unrelated AVRT orders must never normalise to the same thing');
});
