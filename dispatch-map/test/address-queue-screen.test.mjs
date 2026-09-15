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
  // Priced on the rows a push would actually CHANGE (pushWorth), not on everything ticked —
  // quoting the wrong number is how a dispatcher is surprised by the bill.
  assert.match(bar, /queueCostLine\(pushWorth, b\)/);
  const line = fnSource('queueCostLine');
  assert.match(line, /NuVizz call/);
  assert.match(line, /left today/, 'and what is left, not just what it costs');
});

test('A RUN THAT WOULD BLOW THE CEILING CANNOT BE STARTED', () => {
  const bar = fnSource('QueueSummaryBar');
  assert.match(bar, /overBudget/);
  assert.match(bar, /pushWorth \* 3 > Math\.max\(0, b\.ceiling - b\.current\)/, '3 calls per order is the arithmetic');
  assert.match(bar, /disabled=\{!sel \|\| overBudget \|\| !pushWorth\}/);
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

// ── v1.25.0 — what Chad found by using it ────────────────────────────────────

test('"CORRECT" ACTUALLY CORRECTS — the editor opens with the fix, not the fault', () => {
  // Chad: "i clicked correct but it didn't correct". It opened seeded with row.shown, which on
  // a mis-split row IS the mis-split — "PMB 271" in the street box and the real street in the
  // suite box. The row knew the fix and never offered it.
  const hook = fnSource('useQueueRowEdit');
  assert.match(hook, /React\.useState\(\(\) => correctedFields\(row\)\)/);
  assert.ok(!/useState\(\(\) => \(\{ \.\.\.row\.shown \}\)\)/.test(hook), 'never seeded from the broken values');
  const cf = fnSource('correctedFields');
  assert.match(cf, /addr1: s\.addr1 \|\| base\.addr1/);
  assert.match(cf, /addr2: s\.addr2 \?\? base\.addr2/, 'an explicitly empty suite is honoured, not skipped by ||');
});

test('THE GROUP ACTION SENDS THE CORRECTED ADDRESS, NEVER THE BROKEN ONE', () => {
  // The worse half of the same bug: the group push sent row.shown, so pushing a mis-split row
  // would have handed NuVizz back its own bad address AND written it as an override — marking
  // the row corrected when nothing had been.
  const run = fnSource('useQueuePush');
  assert.match(run, /fields: correctedFields\(row\)/);
  assert.ok(!/fields: row\.shown/.test(run), 'row.shown is the fault, not the fix');
});

test('A ROW NUVIZZ ALREADY AGREES WITH IS NOT PUSHED — 3 calls to restate their own address', () => {
  const w = fnSource('worthPushing');
  assert.match(w, /oneLineAddr\(correctedFields\(row\)\) !== oneLineAddr\(row\?\.vendor\)/);
  const run = fnSource('useQueuePush');
  assert.match(run, /const sendToVendor = push && worthPushing\(row\)/);
  // …and the price quoted is for the rows that would actually change, not everything ticked.
  const bar = fnSource('QueueSummaryBar');
  assert.match(bar, /const pushWorth = q\.selected\.filter\(worthPushing\)\.length/);
  assert.match(bar, /queueCostLine\(pushWorth, b\)/);
  assert.match(bar, /need.*only a pin moved/s, 'and the difference is explained, not silently dropped');
});

test('BOARD-ONLY IS ITS OWN BUTTON, sharing the runner so the two cannot drift', () => {
  // Chad: "i want to be able to correct only in dispatch map as well".
  const bar = fnSource('QueueSummaryBar');
  assert.match(bar, /runGroup\(q\.selected, q\.google, false\)/, 'board-only');
  assert.match(bar, /runGroup\(q\.selected, q\.google, true\)/, 'and with the vendor');
  assert.match(bar, /Correct \{sel \|\| ''\} on the board/);
  const run = fnSource('useQueuePush');
  assert.match(run, /async \(rows, google, push = true\)/, 'one loop, a flag — not two copies');
  assert.match(run, /if \(push\) readBudget\(\)/, 'a board-only sweep spends nothing to re-read');
});

test('THE ADDRESS LINES ARE LABELLED — a placeholder vanishes the moment there is a value', () => {
  // And there is always a value here, so the two lines rendered as two unlabelled boxes with no
  // way to tell which one the geocoder reads.
  const ed = fnSource('QueueRowEditor');
  assert.match(ed, /Address 1 · street/);
  assert.match(ed, /Address 2 · suite \/ dock/);
  assert.match(ed, /aria-label="Address 1, the street line"/);
  assert.match(ed, /This line is what gets geocoded/);
});

test('THE SUGGESTED FIX IS VISIBLE ON BOTH VIEWS, not just the phone', () => {
  assert.match(fnSource('QueueRowDesktop'), /row\.suggestion &&/, 'the desktop row showed no sign one existed');
  assert.match(fnSource('QueueRowMobile'), /row\.suggestion &&/);
});

test('THE MAP SHOWS BOTH PINS — where it is now and where the fix lands', () => {
  // Chad: "show original pin and new pin location as well as be able to just move the pin where
  // i want it". On a corrected_not_pinned row this is the whole diagnosis: the coordinate on
  // screen came from the OLD address, and only seeing them together says so.
  const m = fnSource('QueuePinMap');
  assert.match(m, /Where the pin is now/);
  assert.match(m, /draggable: true/);
  assert.match(m, /addListener\('dragend'/);
  // Two markers on the same spot read as one, and invite "which am I dragging".
  assert.match(m, /Math\.abs\(orig\.lat - pos\.lat\) > 1e-6/);
});

test('A FAILED GEOCODE STILL LETS YOU DROP THE PIN BY HAND', () => {
  // The addresses Google cannot find are exactly the ones most worth a human who has been there.
  const m = fnSource('QueuePinMap');
  assert.match(m, /setPos\(orig \? \{ lat: orig\.lat, lng: orig\.lng \} : null\)/);
  assert.match(m, /a dragged pin beats an address nobody can geocode/);
});

test('SAVING A PIN MERGES — customer_notes carries the dispatcher\'s own receiving hours', () => {
  const hook = fnSource('useQueueRowEdit');
  assert.match(hook, /location_override: \{ lat: pos\.lat, lng: pos\.lng \}/);
  assert.match(hook, /\{ merge: true \}/, 'setDoc REPLACES here; a blind write takes the hours with it');
});

test('THE TO-FIX FLAG IS ON BOTH NAVIGATIONS, or it does not exist on a phone', () => {
  // v0.54.50 shipped a screen visible on a laptop and invisible on a phone. Dispatch runs on a
  // phone.
  const bar = fnSource('MobileAppBar');
  assert.match(bar, /addrBadge = 0/, 'the phone bar takes it');
  assert.match(bar, /addrBadge > 0 &&/, 'and renders it on the item');
  assert.match(bar, /\(manifestBadge \+ addrBadge\) > 0/, 'and rolls it into the collapsed More chip');
  assert.match(APP, /badge: addrBadge/, 'the desktop More menu item carries it');
  assert.match(APP, /badge=\{moreBadge \+ addrBadge\}/, 'and the desktop More chip rolls it up too');
});

test('THE BADGE COSTS ONE READ PER SESSION, and working the list moves it', () => {
  const hook = fnSource('useProblemAddressCount');
  assert.match(hook, /if \(__addrQueueBadgeCache != null\) return undefined;/, 'not polled');
  assert.ok(!/setInterval/.test(hook), 'three days of board rows is a real read');
  const q = fnSource('useAddressQueue');
  assert.match(q, /bustProblemAddressCount\(\)/, 'or the badge goes stale and stops being read');
});

// ── v1.26.2 — what using it in anger turned up ───────────────────────────────

test('THE DESKTOP ACTION BUTTONS NEVER WRAP, whatever the row height', () => {
  // Chad, on a row whose map was open: "I want these buttons in a row no matter height of the
  // row". The "Do" cell is a table column, not a card — the browser was shrinking it until
  // "Wave off" fell onto its own line, which happened the moment the map button grew from
  // "Map" to "Hide map". Two halves, and one without the other does nothing: the row must not
  // wrap, AND the <td> must refuse to be squeezed so the table widens the column instead.
  const actions = fnSource('QueueRowActions');
  assert.match(actions, /flex-nowrap whitespace-nowrap/);
  assert.match(actions, /stacked \? 'flex items-center gap-1\.5 flex-wrap'/, 'the phone card still wraps — it has room to grow down');
  const desktop = fnSource('QueueRowDesktop');
  assert.match(desktop, /className="px-3 py-2 whitespace-nowrap"><QueueRowActions/, 'the column must widen rather than clip');
});

test('the phone keeps wrapping — three 44px buttons do not fit across 360px', () => {
  const mobile = fnSource('QueueRowMobile');
  assert.match(mobile, /<QueueRowActions[^>]*stacked/, 'the card passes stacked, which selects the wrapping row');
});

test('A GROUP RUN COUNTS WHAT REACHED THE ADDRESS LOG, and says so when one did not', () => {
  // Ten queue corrections read as an empty address log on 2026-09-14, so the runner learned to
  // count what it logged. (The rows had in fact all been written — to the BOARD DAY, which the
  // reader clamped away; see history-range.js. The count stays useful either way and is what
  // would have shown the writer was fine on the first evening instead of the third.)
  const save = fnSource('saveQueueCorrection');
  assert.match(save, /const logged = await logAddressOverride\(/, 'awaited, so its answer exists');
  assert.match(save, /return \{ geoErr, pushed: verdict, logged \}/, 'and is carried back to the runner');
  const run = fnSource('useQueuePush');
  // THE OBJECT IS ALWAYS TRUTHY. `if (logged)` counts every attempt a success and reports a
  // perfect run whatever happened — the failure mode this whole counter exists to catch,
  // reintroduced by the thing that fixed it.
  assert.doesNotMatch(run, /if \(logged\) loggedOk/, 'never counts the object itself');
  assert.match(run, /logged\?\.recorded/, 'counts the recorded flag');
  // A DECLINE IS NOT A FAILURE. The server refuses a row carrying no material change, and one
  // the day already holds (firestore.mts de-dupes on stop + before/after + kind). Warning about
  // either is the banner crying wolf on the log doing its job correctly.
  assert.match(run, /logged\?\.outcome === 'declined'/, 'and a correct refusal is not counted against the run');
  assert.match(run, /setLogged\(\{ ok: loggedOk, tried: loggedTried \}\)/);
});

test('…and the warning appears ONLY when a row failed to log', () => {
  // A line that renders on every clean run is one nobody reads, and this exists to be noticed.
  const bar = fnSource('QueueSummaryBar');
  assert.match(bar, /q\.push\.logged\.ok < q\.push\.logged\.tried/);
  assert.match(bar, /only the audit row is missing/, 'and it must not read as if the correction failed');
});

test('a failed log can still never fail the correction', () => {
  // The await must not turn a missing audit row into a lost address.
  const log = fs.readFileSync(new URL('../src/lib/address-log.js', import.meta.url), 'utf8');
  assert.match(log, /catch \(e\) \{[\s\S]{0,700}?return \{ recorded: false, outcome: 'failed'/, 'the POST still resolves its own errors rather than throwing them');
  // A `throw` STATEMENT anywhere in the function, not the word 'throw' wherever it appears —
  // the first draft of this line matched the word "throws" in the comment directly below the
  // catch and would have failed a correct implementation.
  assert.doesNotMatch(log.slice(log.indexOf('export async function logAddressOverride')), /(^|\n)\s*throw\s/, 'and still never rethrows');
  const save = fnSource('saveQueueCorrection');
  const board = save.indexOf("setDoc(doc(db, 'customer_notes'");
  const firstLog = save.indexOf('await logAddressOverride(');
  assert.ok(board > 0 && firstLog > board, 'the durable write still happens before any logging');
});

test('THE MAP IS TALLER — it is the whole diagnosis on a pin row', () => {
  assert.match(fnSource('QueuePinMap'), /style=\{\{ height: 320 \}\}/);
});

// ── SELECT ALL, ABOVE THE BOXES IT CONTROLS ──────────────────────────────────
//
// Chad: "there should be a select all check box above the individual check boxes." The toolbar
// already had a Select all BUTTON, but it lives in a different block at the top of the screen
// and takes EVERY board day at once. On a screen showing three days that is not the control a
// dispatcher wants: clearing tomorrow's board should not drag Thursday's rows into the same
// push at 3 metered calls each.

test('the desktop box sits in the header cell directly above the row boxes', () => {
  const desk = fnSource('ProblemQueueDesktop');
  assert.match(desk, /<th className="px-3 py-2 w-8"><QueueSelectAllBox d=\{d\} q=\{q\} \/><\/th>/,
    'the blank header cell over the checkbox column is where it goes');
});

test('the phone gets its own labelled control, not the desktop one reflowed', () => {
  // Two views, always. There is no header row on a card list, so the box needs a label of its
  // own — and a 44px touch target, which an 16px checkbox in a table header does not need.
  const mob = fnSource('ProblemQueueMobile');
  assert.match(mob, /<QueueSelectAllBox d=\{d\} q=\{q\}/, 'the same rule');
  assert.match(mob, /Select all \{dayPickState\(d\.rows, q\.picked\)\.total\} on this day/, 'with its own wording');
  assert.match(mob, /<label[^>]*minHeight: 44/, 'and a thumb-sized target');
});

test('A PART-PICKED DAY IS NEVER DRAWN AS AN EMPTY BOX', () => {
  // A plain unchecked box over four picked rows claims a selection that is not there, and the
  // next press would push rows the dispatcher never chose. `indeterminate` is not a React prop
  // and cannot be set in JSX — it exists only on the DOM node, which is why this needs a ref.
  const box = fnSource('QueueSelectAllBox');
  assert.match(box, /ref\.current\.indeterminate = st\.some/);
  assert.match(box, /checked=\{st\.all\}/, 'checked only when every selectable row is picked');
});

test('the box counts exactly the rows it can act on — the same test the toolbar sweep uses', () => {
  // A box that counts rows it cannot push reads "4 of 6" for ever and never goes checked.
  const st = fnSource('dayPickState');
  assert.match(st, /queueRowPushable\(r\) && !r\.dismissed/);
  const hook = fnSource('useProblemQueue');
  assert.match(hook, /sweepable = React\.useMemo\(\(\) => allRows\.filter\(\(r\) => queueRowPushable\(r\) && !r\.dismissed\)/,
    'and the toolbar sweep tests the same thing, so the two can never disagree about "all"');
});

test('a half-picked day resolves to ALL on one press, never inverting into the other half', () => {
  // Toggling each key individually would turn "4 of 9 picked" into "5 of 9 picked" — a control
  // that scrambles a selection rather than completing it.
  const hook = fnSource('useProblemQueue');
  assert.match(hook, /const sweepDay = React\.useCallback\(\(rows, on\) =>/);
  assert.match(hook, /if \(on\) next\.add\(r\.key\); else next\.delete\(r\.key\);/, 'explicit add/remove, not a toggle');
  assert.match(fnSource('QueueSelectAllBox'), /q\.sweepDay\(d\.rows, !st\.all\)/);
  assert.match(hook, /sweepable, selected, picked, toggle, sweep, sweepDay,/, 'and the views can reach it');
});

test('it cannot be pressed mid-run, when the selection is what is being spent', () => {
  assert.match(fnSource('QueueSelectAllBox'), /disabled=\{q\.push\.running\}/);
});

test('a day with nothing selectable shows no box at all', () => {
  // An always-disabled checkbox over "Nothing wrong with this day's addresses" is furniture.
  assert.match(fnSource('QueueSelectAllBox'), /if \(!st\.total\) return null;/);
});
