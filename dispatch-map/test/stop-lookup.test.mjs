// test/stop-lookup.test.mjs — the RULES behind the stop-lookup screen.
//
// Every test here names a real question somebody asks down the phone, because that is what
// the screen is for. The endpoint's own tests (stop-lookup-endpoint.test.mjs) prove the
// gathering; these prove what the documents MEAN once they are gathered.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyQuery, stopIdVariants, dayOutcome, mergeDay, buildStopDossier, notesSummary,
} from '../src/lib/stop-lookup.js';

const TODAY = '2026-09-18';

// A sealed warehouse record, in the real shape buildStopRecord writes.
const sealed = (over = {}) => ({
  stopNbr: '007174397', pro: '007174397', primaryPro: '007174397', shipmentNbr: '007174397',
  businessName: 'LED ENERGY PLUS', customerMatchKey: 'led_energy_plus__5965_peachtree__norcross__30071',
  addr1: '5965 PEACHTREE CORS E STE B3', addr2: null, city: 'NORCROSS', state: 'GA', zip: '30071',
  routeName: 'NOR 2', loadNbr: 'DAVIS000203707', driverName: 'ENOCK AKYEA', driverUserName: 'ENOCK',
  loadStopSeq: 7, isPlanned: true, normalizedStatus: 'DELIVERED',
  arrivalDTTM: '2026-09-15T14:02', deliveredDTTM: '2026-09-15T14:19',
  cartons: 4, pallets: 1, weight: 860, podDocs: [{ documentName: 'pod.jpg' }], stopDetails: [{ product: 'X' }],
  poRef: 'PO-99120', custRef: 'CR-7', bol: 'BOL-3', orderNbr: 'L-551',
  captured_at: '2026-09-16T04:10:00Z', date: '2026-09-15',
  ...over,
});

// ── which box did they type in? ───────────────────────────────────────────────

test('a PRO in every spelling a dispatcher types is read as a STOP, not a name', () => {
  for (const q of ['007174397', '7174397', '007157687-1', 'AVRT-0170416694', 'RA5732712', '0170416694']) {
    assert.equal(classifyQuery(q).kind, 'stop', `${q} should read as a stop number`);
  }
});

test('a business name is read as a NAME — including one with a digit in it', () => {
  for (const q of ['LED ENERGY PLUS', 'E R SNELL', '3M', 'titan electric']) {
    assert.equal(classifyQuery(q).kind, 'name', `${q} should read as a name`);
  }
});

test('an empty box is neither, and never mints a search', () => {
  assert.equal(classifyQuery('').kind, 'empty');
  assert.equal(classifyQuery('   ').kind, 'empty');
});

// ── the three spellings of one order ──────────────────────────────────────────

test('a bare PRO reaches the zero-padded document NuVizz actually wrote', () => {
  const v = stopIdVariants('7174397');
  assert.ok(v.includes('7174397'), 'as typed');
  assert.ok(v.includes('007174397'), 'and padded to nine — the form the warehouse stores');
});

test('a board SEGMENT suffix resolves to the order, not to a different one', () => {
  // The board's stopNbr is often the 9-digit PRO plus a piece number; a dispatcher types the
  // bare PRO off the paperwork. They are one order.
  const v = stopIdVariants('007157687-1');
  assert.ok(v.includes('007157687'), 'the segment tail is stripped');
  assert.ok(v.includes('007157687-1'), 'and the segmented form is still tried first');
});

test('a carrier PRO whose dash is FORMATTING is left whole — ESTES is not a segment', () => {
  // "028-8347656" is a 10-digit PRO written with a dash, not a 9-digit PRO plus a segment.
  // Splitting it would look up an order that is not this one, which is worse than not finding it.
  const v = stopIdVariants('028-8347656');
  assert.ok(v.includes('028-8347656'));
  assert.ok(!v.includes('028'), 'the dash must not be read as a segment boundary');
});

test('a lower-cased carrier PRO still finds the upper-cased document', () => {
  assert.ok(stopIdVariants('avrt-0170416694').includes('AVRT-0170416694'));
});

// ── what happened that day ────────────────────────────────────────────────────

test('a delivered day says delivered', () => {
  assert.equal(dayOutcome({ status: 'DELIVERED', date: '2026-09-15', today: TODAY }), 'delivered');
});

test('AN OLD DAY WITH A LATER DAY BEHIND IT IS "ROLLED", NOT "OPEN"', () => {
  // The failure this pins: a stop that failed on Monday and delivered on Tuesday. Monday's
  // row read "open" for ever, so a rep reading it top-down tells a customer their freight is
  // still out — about an order that delivered two days ago.
  assert.equal(dayOutcome({ status: 'SCHEDULED', date: '2026-09-15', today: TODAY, laterDay: true }), 'rolled');
  assert.equal(dayOutcome({ status: 'SCHEDULED', date: '2026-09-15', today: TODAY, laterDay: false }), 'unfinished');
});

test("today's un-terminal stop is OPEN — it has not failed, it has not happened yet", () => {
  assert.equal(dayOutcome({ status: 'OUT_FOR_DEL', date: TODAY, today: TODAY }), 'open');
  assert.equal(dayOutcome({ status: 'SCHEDULED', date: '2026-09-19', today: TODAY }), 'open');
});

test('an ATT marker on a day with no terminal status is an ATTEMPT — the freight came back', () => {
  assert.equal(dayOutcome({ status: 'SCHEDULED', isAttempt: true, date: '2026-09-15', today: TODAY, laterDay: true }), 'attempted');
});

// ── merging the four documents for one day ────────────────────────────────────

test('the SEALED record wins over the live board copy — it is the one that cannot be rewritten', () => {
  const row = mergeDay({
    date: '2026-09-15',
    sealed: sealed(),
    board: { ...sealed(), normalizedStatus: 'SCHEDULED', routeName: 'DULUTH', driverName: 'SOMEBODY ELSE' },
  }, { today: TODAY });
  assert.equal(row.status, 'DELIVERED');
  assert.equal(row.route, 'NOR 2');
  assert.equal(row.driver, 'ENOCK AKYEA');
  assert.deepEqual(row.sources, ['sealed', 'board']);
});

test('a day with ONLY a board copy is still a full row — an unsealed day is not a blank one', () => {
  // Today and tomorrow are never sealed. If the merge needed a warehouse record, the screen
  // would answer "nothing" about the stop sitting on the board in front of the dispatcher.
  const row = mergeDay({ date: TODAY, board: { ...sealed(), normalizedStatus: 'OUT_FOR_DEL', deliveredDTTM: null } }, { today: TODAY });
  assert.deepEqual(row.sources, ['board']);
  assert.equal(row.outcome, 'open');
  assert.equal(row.route, 'NOR 2');
  assert.equal(row.name, 'LED ENERGY PLUS');
});

test('ON AN ATTEMPT DAY THE DRIVER SHOWN IS THE MORNING DRIVER, and the evening one is named separately', () => {
  // attempts-core is explicit: by evening the stop is on whoever it was re-planned onto, and
  // that is NEVER the attribution. A screen that showed the evening driver beside the word
  // "attempted" would blame the wrong person for a delivery they never had.
  const row = mergeDay({
    date: '2026-09-16',
    plan: { stopNbr: '007174397', driverName: 'ROBERT MENSAH', routeName: 'NOR 2', businessName: 'LED ENERGY PLUS' },
    attempt: { stopNbr: '007174397', originalDriverName: 'ROBERT MENSAH', currentDriverName: 'JOE NKRUMAH', shipmentNbr: 'ATT007174397' },
  }, { today: TODAY, laterDay: true });
  assert.equal(row.outcome, 'attempted');
  assert.equal(row.driver, 'ROBERT MENSAH');
  assert.equal(row.currentDriver, 'JOE NKRUMAH');
});

test('the refs a customer quotes down the phone ride on the row', () => {
  const row = mergeDay({ date: '2026-09-15', sealed: sealed() }, { today: TODAY });
  assert.equal(row.refs.po, 'PO-99120');
  assert.equal(row.refs.bol, 'BOL-3');
  assert.equal(row.refs.custRef, 'CR-7');
});

// ── the whole dossier ─────────────────────────────────────────────────────────

test('every day we hold is one row, newest first, and the counts add up', () => {
  const d = buildStopDossier({
    query: '007174397', today: TODAY,
    sealed: [
      { date: '2026-09-15', stop: sealed({ normalizedStatus: 'EXCEPTION', deliveredDTTM: null, date: '2026-09-15' }) },
      { date: '2026-09-17', stop: sealed({ date: '2026-09-17' }) },
    ],
    attempts: [{ date: '2026-09-15', item: { stopNbr: '007174397', originalDriverName: 'ENOCK AKYEA' } }],
  });
  assert.deepEqual(d.days.map((x) => x.date), ['2026-09-17', '2026-09-15']);
  assert.equal(d.counts.days, 2);
  assert.equal(d.counts.delivered, 1);
  assert.equal(d.counts.attempts, 1);
  assert.equal(d.firstSeen, '2026-09-15');
  assert.equal(d.lastSeen, '2026-09-17');
  assert.equal(d.found, true);
});

test('THE ROLLED DAY IS DECIDED BY THE DOSSIER, not by each row in isolation', () => {
  // The whole reason mergeDay takes `laterDay`: only the assembled list knows a later day
  // exists. Monday reads "rolled", Wednesday (the newest) reads for itself.
  const d = buildStopDossier({
    query: '007174397', today: TODAY,
    board: [
      { date: '2026-09-16', row: { ...sealed(), normalizedStatus: 'SCHEDULED', deliveredDTTM: null } },
      { date: '2026-09-17', row: { ...sealed(), normalizedStatus: 'SCHEDULED', deliveredDTTM: null } },
    ],
  });
  assert.equal(d.days[0].date, '2026-09-17');
  assert.equal(d.days[0].outcome, 'unfinished', 'the newest past day has nothing after it');
  assert.equal(d.days[1].outcome, 'rolled', 'and the older one rolled into it');
});

test('identity falls back through the days — a sealed day with no name does not blank the header', () => {
  const d = buildStopDossier({
    query: '007174397', today: TODAY,
    sealed: [
      { date: '2026-09-17', stop: sealed({ businessName: null, addr1: null, city: null, zip: null, date: '2026-09-17' }) },
      { date: '2026-09-15', stop: sealed() },
    ],
  });
  assert.equal(d.identity.name, 'LED ENERGY PLUS');
  assert.equal(d.identity.address.addr1, '5965 PEACHTREE CORS E STE B3');
  assert.equal(d.identity.asOf, '2026-09-17', 'and it still says which day the header is as of');
});

test('A STOP WE HOLD NOTHING FOR STILL RETURNS THE LEDGER OF WHERE WE LOOKED', () => {
  // The point of the whole module. "Nothing found" and "we only asked one place" render as
  // the same blank screen otherwise — which is how the roster bug went four rounds
  // undiagnosed (CLAUDE.md), and it is the one case where spending a NuVizz call is right.
  const d = buildStopDossier({
    query: '009999999', today: TODAY,
    looked: { boardWindow: '14 days back, 3 ahead', sealedWindow: 'no days to read — the index had none' },
  });
  assert.equal(d.found, false);
  assert.equal(d.days.length, 0);
  assert.ok(d.sources.length >= 8, 'every collection is listed, populated or not');
  assert.ok(d.sources.every((s) => s.looked === true), 'and each says it was actually read');
  assert.ok(d.sources.every((s) => s.found === false), 'and that it held nothing');
  assert.equal(d.sources.find((s) => s.key === 'board').note, '14 days back, 3 ahead');
});

test('a source that was NOT read is marked unread rather than empty — they are different answers', () => {
  const d = buildStopDossier({ query: '007174397', today: TODAY, looked: { writes: false } });
  const writes = d.sources.find((s) => s.key === 'writes');
  assert.equal(writes.looked, false);
  assert.equal(writes.found, false);
});

test('the ledger counts what each source HELD, so a populated screen is auditable too', () => {
  const d = buildStopDossier({
    query: '007174397', today: TODAY,
    pointers: [{ date: '2026-09-15', pro: '007174397' }],
    sealed: [{ date: '2026-09-15', stop: sealed() }],
    addressChanges: [{ kind: 'moved' }, { kind: 'suite' }],
    writes: [{ at: '2026-09-15T12:00:00Z', op: 'planStops', status: 'ok', summary: 'ok' }],
    customer: { name: 'LED ENERGY PLUS', pros: [{ pro: '007174397', date: '2026-09-15' }] },
    notes: { notes: 'Ring the bell at the side door' },
  });
  const by = Object.fromEntries(d.sources.map((s) => [s.key, s]));
  assert.equal(by.sealed.count, 1);
  assert.equal(by.address.count, 2);
  assert.equal(by.writes.count, 1);
  assert.equal(by.notes.count, 1);
  assert.equal(by.customer.count, 1);
});

// ── the notes card ────────────────────────────────────────────────────────────

test('the note flags a dispatcher must see before promising anything are surfaced', () => {
  const n = notesSummary({ no_tractor: true, notify_cs: true, address_override: { addr1: 'X' }, notes: 'Dock 7 rear' });
  assert.equal(n.text, 'Dock 7 rear');
  assert.deepEqual(n.flags.map((f) => f.key).sort(), ['no_tractor', 'notify_cs', 'override']);
});

test('PRO_HISTORY IS NOT SURFACED — it is a log of note SAVES, not of deliveries', () => {
  // src/lib/stop-history.js has the whole argument: printing pro_history beside warehouse
  // rows made a card contradict itself about when we delivered an order, because those dates
  // are EDIT dates wearing a delivery date's clothes. This screen has the real days from the
  // warehouse two inches up; repeating that mistake here would be worse, not better.
  const n = notesSummary({ pro_history: [{ pro: '007174397', date: '2026-07-07' }], notes: 'x' });
  assert.equal(JSON.stringify(n).includes('pro_history'), false);
  assert.equal(JSON.stringify(n).includes('2026-07-07'), false);
});

test('an absent note is null, not an empty card pretending to be a note', () => {
  assert.equal(notesSummary(null), null);
  assert.equal(notesSummary(undefined), null);
});

// ── the hostile inputs ────────────────────────────────────────────────────────

test('a malformed day id can never become a row (and so can never become a Firestore path)', () => {
  const d = buildStopDossier({
    query: '007174397', today: TODAY,
    sealed: [{ date: '../../etc', stop: sealed() }, { date: '', stop: sealed() }, { date: null, stop: sealed() }],
  });
  assert.equal(d.days.length, 0);
  assert.equal(d.found, false);
});

test('empty, absent and malformed facts produce a well-formed empty answer rather than a throw', () => {
  for (const facts of [undefined, {}, { sealed: null, board: undefined, days: 'nope' }]) {
    const d = buildStopDossier(facts);
    assert.equal(d.found, false);
    assert.deepEqual(d.days, []);
    assert.ok(Array.isArray(d.sources));
  }
});

// ── "NOTHING FOUND" vs "WE COULD NOT FINISH LOOKING" ─────────────────────────
//
// These two must never render the same, and the first cut of this screen printed "every
// source was read and came back empty" over a ledger three inches below saying three of
// them had NOT been read. That is the screen contradicting itself about the single fact
// that decides whether to go and spend a vendor call.

test('a source that FAILED makes the answer incomplete, and names itself', () => {
  const d = buildStopDossier({ query: '009999999', today: TODAY, looked: { writes: false } });
  assert.equal(d.found, false);
  assert.equal(d.complete, false, 'a failed locating read must not read as a clean miss');
  assert.deepEqual(d.unreadSources, ['What we sent NuVizz']);
  assert.equal(d.sources.find((s) => s.key === 'writes').state, 'unread');
});

test('A SOURCE THERE WAS NOTHING TO LOOK IT UP BY IS SKIPPED, NOT FAILED', () => {
  // The customer rollup and the dispatcher note are keyed by the CUSTOMER, which we only
  // learn from the stop documents. On a genuine miss they were not left unread — there was
  // nothing to read them by. Counting those as failures made every empty answer look broken
  // and would have sent a dispatcher chasing an outage that was not happening.
  const d = buildStopDossier({ query: '009999999', today: TODAY, looked: { customer: 'skipped', notes: 'skipped' } });
  assert.equal(d.complete, true, 'a skipped non-locating source still allows a clean miss');
  assert.deepEqual(d.unreadSources, []);
  assert.equal(d.sources.find((s) => s.key === 'notes').state, 'skipped');
  assert.equal(d.sources.find((s) => s.key === 'customer').state, 'skipped');
});

test('PRO_INDEX=off is a switch somebody threw, not a read that failed', () => {
  const d = buildStopDossier({ query: '009999999', today: TODAY, looked: { pros: 'skipped' } });
  assert.equal(d.sources.find((s) => s.key === 'pros').state, 'skipped');
  assert.equal(d.complete, true, 'the fallback sweep still covers the window');
});

test('every source read and empty IS a clean miss — the one case worth a vendor call', () => {
  const d = buildStopDossier({ query: '009999999', today: TODAY });
  assert.equal(d.complete, true);
  assert.deepEqual(d.sources.map((s) => s.state), Array(9).fill('empty'));
});

test('a populated source reports found, and the dossier stays complete', () => {
  const d = buildStopDossier({
    query: '007174397', today: TODAY,
    sealed: [{ date: '2026-09-15', stop: sealed() }],
  });
  assert.equal(d.complete, true);
  assert.equal(d.sources.find((s) => s.key === 'sealed').state, 'found');
});
