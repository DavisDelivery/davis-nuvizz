// test/address-queue-screen.test.mjs
//
// THE PROBLEM-ADDRESS QUEUE ON SCREEN — the promises it makes to a dispatcher.
//
// Chad: "list by board day every stop that the system has flagged as a problem address ... and
// push individuals or the group to nuvizz with the correction."
//
// The queue can SPEND. Everything below is about the difference between a button that says what
// it costs and a button that is quietly a scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  const body = APP.slice(start, next > 0 ? next : undefined);
  assert.ok(body.length > 100, `${name} sliced to nothing`);
  return body;
}

test('EVERY BUTTON SAYS WHAT IT COSTS BEFORE IT IS PRESSED', () => {
  // A dispatcher who cannot see the number has been handed a scan button. 30 rows is 90
  // metered calls off one press.
  const bar = fnSource('QueueSummaryBar');
  assert.match(bar, /queueCostLine\(sel, b\)/);
  const line = fnSource('queueCostLine');
  assert.match(line, /NuVizz call/);
  assert.match(line, /left today/, 'and what is left, not just what it costs');
});

test('A RUN THAT WOULD BLOW THE CEILING CANNOT BE STARTED', () => {
  const bar = fnSource('QueueSummaryBar');
  assert.match(bar, /overBudget/);
  assert.match(bar, /sel \* 3 > Math\.max\(0, b\.ceiling - b\.current\)/, '3 calls per order is the arithmetic');
  assert.match(bar, /disabled=\{!sel \|\| overBudget\}/);
});

test('THE PUSH IS SERIAL — never a parallel fan-out', () => {
  // Each order is 3 vendor round trips in a 26s function budget, and one row can spend 20s in
  // backoff. Two per invocation is already unsafe; the endpoint's requester also refuses to
  // coalesce writes.
  const run = fnSource('useQueuePush');
  assert.match(run, /for \(const row of rows\)/, 'a loop, not Promise.all');
  assert.ok(!/Promise\.all/.test(run), 'never concurrent');
  assert.match(run, /setTimeout\(r, 500\)/, 'paced');
});

test('THE RUN STOPS ON A FATAL OUTCOME instead of producing N identical failures', () => {
  const run = fnSource('useQueuePush');
  assert.match(run, /if \(pushed\?\.fatal\)/);
  assert.match(run, /break;/);
});

test('"THE SWITCH IS OFF" IS NOT "THE VENDOR REFUSED IT"', () => {
  // A 403 with no result means NOTHING was attempted. Reporting that as a vendor refusal sends
  // a dispatcher to the portal to fix an order that is already fine.
  const c = fnSource('classifyPushResult');
  assert.match(c, /http === 403/);
  assert.match(c, /Live writes are switched off on the server/);
  assert.match(c, /Nothing was sent/);
  // …and the role refusal is told apart from the switch, because they need different actions.
  assert.match(c, /requires\\s\+\\w\+/);
  assert.match(c, /may not push to NuVizz/);
  // …and the breaker and the ceiling each get their own sentence.
  assert.match(c, /http === 503/);
  assert.match(c, /http === 429/);
});

test('A WRITE WHOSE OUTCOME IS UNKNOWN IS NOT CALLED A FAILURE', () => {
  // The function can be killed between the write and the read-back. The correction may be ON
  // the order with nothing having verified it, and auto-retrying would write it twice.
  const c = fnSource('classifyPushResult');
  assert.match(c, /unverified/);
  assert.match(c, /check the order in the portal/);
});

test('THE ABORT SAYS WHAT IT ACTUALLY DOES', () => {
  // There is no in-flight abort — no AbortSignal is threaded to the requester, and killing the
  // socket would not stop the server finishing its write. A "Cancel" button would be an intent
  // dressed as an outcome.
  const bar = fnSource('QueueSummaryBar');
  assert.match(bar, /Stop after this one/);
  assert.ok(!/>Cancel</.test(bar), 'never a promise the code cannot keep');
});

test('SELECT-ALL SKIPS WHAT THE SERVER WOULD REFUSE, AND SAYS WHY PER ROW', () => {
  // Delivered freight costs a call to be refused. A row with no stopId has the twin guard
  // disarmed, and re-addressing the wrong twin sends freight where nobody chose.
  const q = fnSource('useProblemQueue');
  assert.match(q, /queueRowPushable\(r\) && !r\.dismissed/);
  const pushable = APP.slice(APP.indexOf('const queueRowPushable'), APP.indexOf('const queueRowPushable') + 300);
  assert.match(pushable, /!!row\.stopNbr && !!row\.stopId && !queueRowExecuted\(row\)/);
  const actions = fnSource('QueueRowActions');
  assert.match(actions, /delivered freight cannot be re-addressed/);
  assert.match(actions, /No order id on this row/);
});

test('THE CORRECTION SAVES EVEN WHEN THE GEOCODE FAILS — and says the pin did not move', () => {
  // The modal used to throw the whole correction away on ZERO_RESULTS, on exactly the addresses
  // most likely to be wrong. Both paths now save and report.
  const save = fnSource('saveQueueCorrection');
  assert.match(save, /try \{ geo = await geocodeAddress\(google, q\); \} catch \(e\) \{ geoErr = e; \}/);
  assert.ok(save.indexOf('geoErr = e') < save.indexOf("setDoc(doc(db, 'customer_notes'"), 'the save is downstream of the failure, not behind it');
  const modal = fnSource('AddressEditModal');
  assert.match(modal, /let geo = null, geoErr = null;/, 'the modal matches');
  assert.match(modal, /if \(!geoErr\) onClose\(\)/, 'and does not close over an unread pin warning');
});

test('THE BOARD HALF IS WRITTEN BEFORE THE VENDOR HALF IS EVEN CONSIDERED', () => {
  const save = fnSource('saveQueueCorrection');
  const board = save.indexOf("setDoc(doc(db, 'customer_notes'");
  const vendor = save.indexOf('setStopAddress(');
  assert.ok(board > 0 && vendor > board, 'a failed push must never cost the typed address');
});

test('THE NOTE SAYS WHAT CHANGED, NOT JUST THAT SOMETHING DID', () => {
  // "Address corrected" tells the next reader in the portal nothing they can act on.
  const n = fnSource('queueNoteText');
  assert.match(n, /was "\$\{was\}" — now "\$\{now\}"/);
  assert.match(n, /Davis dispatch corrected the delivery address on \$\{today\}/);
});

test('A ZERO-NOTES READ IS REPORTED, NEVER RENDERED AS A CLEAN LIST', () => {
  // 778 stops, matchKey null on every row, zero notes — and a board that reported clean. A
  // queue in that state would list corrections made weeks ago as outstanding problems.
  const f = fnSource('QueueFooterNote');
  assert.match(f, /notes === 0/);
  assert.match(f, /Do not work this list until that is fixed/);
});

test('THE TWO SCOPES ARE SAID OUT LOUD WHERE THE CHOICE IS MADE', () => {
  // Firestore is per-CUSTOMER and carries forward; NuVizz is per-ORDER and reaches the driver.
  // A dispatcher pressing one of two buttons has to know which is which.
  const ed = fnSource('QueueRowEditor');
  assert.match(ed, /this customer’s future orders/);
  assert.match(ed, /THIS order only/);
  assert.match(ed, /driver’s manifest/);
});

test('A WAVED-OFF ROW IS HONEST ABOUT NOT BEING LIVE', () => {
  const f = fnSource('QueueFooterNote');
  assert.match(f, /hides it for everyone/);
  assert.match(f, /not live/, 'another dispatcher sees it on their next refresh, not instantly');
});

test('THE QUEUE DOES NOT FIRE THE LOG ENDPOINT BEHIND IT', () => {
  const screen = fnSource('AddressHistoryScreen');
  assert.match(screen, /if \(!logSection\) return undefined;/, 'a Firestore read per keystroke for a screen nobody is looking at');
});
