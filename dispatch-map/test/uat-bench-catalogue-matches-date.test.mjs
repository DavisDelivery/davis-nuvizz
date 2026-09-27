// test/uat-bench-catalogue-matches-date.test.mjs
//
// THE BENCH'S ORDER LIST COULD SHOW A DIFFERENT DAY THAN ITS DATE BOX (audit 2026-09-27,
// client-map-ui-libs-3).
//
// Every date change fires a catalogue read, and whichever answer landed LAST filled the list —
// even when it belonged to an earlier date. A native date input fires per segment, so a tester
// who typed 09-22 then 09-23 could see 09-23 in the box and Tuesday's orders in the table; ticking
// one and pressing Preview or Seed sent date 2026-09-23 with a Tuesday order number. Neither the
// read nor the Preview/Seed/Clear call caught a network failure: nothing appeared on screen, and
// after a failed date change the previous day's list stayed up under the new date.
//
// What happens now: only the answer for the date in the box is shown; changing the date empties
// the list and the picks until that day's answer arrives; a read or a Preview/Seed/Clear that
// fails to reach the server says so on screen. The whole real component runs here
// (test/helpers/uat-bench-harness.mjs), both its desktop table and its phone cards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountBench, textOf, dateBox, tableRows, phoneCards, button, errorBanner } from './helpers/uat-bench-harness.mjs';

const catalogue = (date, rows) => ({ ok: true, op: 'catalogue', date, dayTotal: rows.length, unplannedTotal: rows.length, note: null, rows, seeded: { count: 0, orders: [] } });
const order = (stopNbr, businessName) => ({ stopNbr, businessName, addr1: '1 Main', city: 'Buford', state: 'GA', isPlanned: false, isUnplanned: true });
const TUE = catalogue('2026-09-22', [order('D22-A', 'TUESDAY CUSTOMER')]);
const WED = catalogue('2026-09-23', [order('D23-A', 'WEDNESDAY CUSTOMER')]);
const catalogueCalls = (b) => b.calls.filter((c) => c.method === 'GET');

async function pickDate(b, value) {
  dateBox(b.tree).props.onChange({ target: { value } });
  return b.render();
}

test('a slow answer for the day the tester moved off never replaces the day in the date box', async () => {
  const b = mountBench();
  catalogueCalls(b)[0].answer(catalogue('2026-09-27', []));
  await b.settle();
  await pickDate(b, '2026-09-22');
  await pickDate(b, '2026-09-23');
  const [, tue, wed] = catalogueCalls(b);
  assert.match(tue.url, /date=2026-09-22/);
  assert.match(wed.url, /date=2026-09-23/);

  wed.answer(WED);          // Wednesday answers first…
  await b.settle();
  tue.answer(TUE);          // …and Tuesday's slow read lands after it
  const tree = await b.settle();

  assert.equal(dateBox(tree).props.value, '2026-09-23');
  for (const view of [tableRows(tree), phoneCards(tree)]) {
    const shown = textOf(view);
    assert.match(shown, /WEDNESDAY CUSTOMER/, 'the box\'s day is what is listed');
    assert.doesNotMatch(shown, /TUESDAY CUSTOMER/, 'the stale answer is dropped');
  }

  // So a Preview can only ever pair the date in the box with an order from that same day.
  tableRows(tree)[0].props.onClick();
  button(b.render(), 'Preview').props.onClick();
  const post = b.calls.find((c) => c.method === 'POST');
  assert.deepEqual({ date: post.body.date, stopNbrs: post.body.stopNbrs }, { date: '2026-09-23', stopNbrs: ['D23-A'] });
});

test('changing the date takes the old day\'s list and picks down at once — they never sit under the new date', async () => {
  const b = mountBench();
  catalogueCalls(b)[0].answer(TUE);
  let tree = await b.settle();
  tableRows(tree)[0].props.onClick();
  tree = b.render();
  assert.match(textOf(tree), /1 picked/);

  tree = await pickDate(b, '2026-09-23');   // Wednesday's read is still in flight
  assert.equal(tableRows(tree).length, 0, 'no Tuesday rows under a Wednesday date');
  assert.equal(phoneCards(tree).length, 0, 'on the phone either');
  assert.match(textOf(tree), /0 picked/, 'and no Tuesday order is still ticked');
});

test('a catalogue read that cannot reach the server says so, instead of leaving the old day up in silence', async () => {
  const b = mountBench();
  catalogueCalls(b)[0].answer(TUE);
  await b.settle();
  await pickDate(b, '2026-09-23');
  catalogueCalls(b)[1].fail(new TypeError('Failed to fetch'));
  const tree = await b.settle();
  assert.ok(errorBanner(tree), 'an error is on screen');
  assert.match(textOf(errorBanner(tree)), /Failed to fetch/);
  assert.equal(tableRows(tree).length, 0);
  assert.doesNotMatch(textOf(tree), /TUESDAY CUSTOMER/);
});

test('a Preview that cannot reach the server says so and frees the buttons', async () => {
  const b = mountBench();
  catalogueCalls(b)[0].answer(WED);
  let tree = await b.settle();
  tableRows(tree)[0].props.onClick();
  button(b.render(), 'Preview').props.onClick();
  b.calls.find((c) => c.method === 'POST').fail(new TypeError('Failed to fetch'));
  tree = await b.settle();
  assert.ok(errorBanner(tree), 'the failure is on screen');
  assert.match(textOf(errorBanner(tree)), /Failed to fetch/);
  assert.equal(button(tree, 'Preview').props.disabled, false, 'nothing is left spinning');
});

test('the list reloaded after a Seed is the day now in the box, even if the tester moved while it ran', async () => {
  const b = mountBench();
  catalogueCalls(b)[0].answer(catalogue('2026-09-27', []));
  await b.settle();
  await pickDate(b, '2026-09-22');
  catalogueCalls(b)[1].answer(TUE);
  let tree = await b.settle();
  tableRows(tree)[0].props.onClick();
  button(b.render(), 'Seed into UAT').props.onClick();
  const seed = b.calls.find((c) => c.method === 'POST');
  assert.equal(seed.body.date, '2026-09-22');

  await pickDate(b, '2026-09-23');           // the tester moves on while the seed runs
  seed.answer({ ok: true, op: 'seed', seeded: 1, created: [], failed: [], skipped: [], warnings: [], callsUsed: 1, boardRows: 1 });
  await b.settle();
  // Answer every read still open with the day it asked for, in the order they were sent.
  for (const c of catalogueCalls(b).slice(2)) c.answer(/date=2026-09-22/.test(c.url) ? TUE : WED);
  tree = await b.settle();

  assert.equal(dateBox(tree).props.value, '2026-09-23');
  assert.match(textOf(tableRows(tree)), /WEDNESDAY CUSTOMER/);
  assert.doesNotMatch(textOf(tableRows(tree)), /TUESDAY CUSTOMER/, 'Tuesday\'s reload never lands under Wednesday');
});
