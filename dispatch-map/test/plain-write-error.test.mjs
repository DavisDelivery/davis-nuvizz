// test/plain-write-error.test.mjs — a write error, said as a plain sentence (v1.98.7).
//
// Chad, 2026-09-30: "Can you make it simple sentence when there is an error that looks less like
// code". Every message below is REAL — copied word for word from the write log's failed writes
// (September 2026) — and the sentence each one must become is pinned exactly. A rule that stops
// matching its real message turns its test red.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plainWriteError, plainErrorsEnabled, clipForToast } from '../src/lib/write-error.js';

// The real messages, word for word, from the write log (failed writes, September 2026).
const REAL = {
  NONDO_OLD: "commitBoard(rwb): load has a non-DO stop in a delivery slot that this card is not sequencing — reorder skipped (verify in portal)",
  BOARD_5: "commitBoard(rwb): load DAVIS000204039 has 5 stop(s) the board isn't showing (007176053, 007176112, 007176028…) — a declarative RWB save would unplan them. Refresh and retry.",
  BOARD_1: "commitBoard(rwb): load DAVIS000204841 has 1 stop(s) the board isn't showing (007182984) — a declarative RWB save would unplan them. Refresh and retry.",
  HELD: "commitBoard(rwb): stop 007174958 couldn't be added to ENOCK (DAVIS000203499) — NuVizz holds it on WILLIAM (DAVIS000203441). Open WILLIAM (DAVIS000203441) in Compare to move it, or unplan it there in the portal (RWB can't pull a stop off a route that isn't part of the Save).",
  HELD_SAME_NAME: "commitBoard(rwb): stop 007174083-1 couldn't be added to BUFORD (DAVIS000203661) — NuVizz holds it on BUFORD (DAVIS000203544). Open BUFORD (DAVIS000203544) in Compare to move it, or unplan it there in the portal (RWB can't pull a stop off a route that isn't part of the Save).",
  ALREADY: "commitBoard(rwb): stop AVRT-0170416694 is ALREADY PLANNED on WILLIAM (DAVIS000203338) (our board may be showing it stale-unplanned) — open WILLIAM (DAVIS000203338) in Compare to stage the move, or refresh and re-check",
  COLLATERAL: "commitBoard(rwb): stop 007173900 is on DENIS SALKIC (DAVIS000203267), which FAILED this Save (commitBoard(rwb): stop 007173614 couldn't be added to DENIS SALKIC (DAVIS000203267) — NuVizz holds it on WILLIAM (DAVIS000203232). Open WILLIAM (DAVIS000203232) in Compare to move it, or unplan it there in the portal (RWB can't pull a stop off a route that isn't part of the Save).) — it could not be moved to DARVIN (DAVIS000203303), and nothing was written for DARVIN (DAVIS000203303). Fix DENIS SALKIC (DAVIS000203267), then re-Save.",
  ABORTED: "commitBoard(rwb): aborted — another load in this Save failed (fetchUpdatedJson returned no route preview). The multi-load save is all-or-nothing, so nothing was written; re-Save.",
  NO_PREVIEW: "commitBoard(rwb): fetchUpdatedJson returned no route preview",
  NOT_APPEAR: "commitBoard(rwb): 12 stops (007175028, 007174623, 007175309…) did not appear on NOR 2 (DAVIS000203463) after the add — the stop record reads UNPLANNED right now, so NuVizz is likely still processing (nothing was double-planned). Wait a few seconds and Save again.",
  BREAKER: "commitBoard(rwb): post-save verify read failed (NuVizz circuit breaker open — refusing /load/info (DAVIS)) — NuVizz took the save; refresh and re-Save to confirm",
  CANCEL_REFUSED: "commitBoard: 16 stop(s) moved to ALLEN C (DAVIS000203183), but NuVizz refused to cancel the now-emptied TERRANCE (DAVIS000203132): Vehicle Type unavailable or disabled. Please verify Vehicle Type in Vehicle Type Configuration for DAVIS000203132 (code 903). It still holds 007172492. NuVizz is refusing every edit of this route because its Vehicle Type is disabled/unavailable — enable or change it under Vehicle Type Configuration in the portal (or cancel the route there), then re-Save.",
  PARTIAL: "commitBoard(rwb): 15 of 16 stop(s) landed on ALLEN C (DAVIS000203183); stop 007172492 is still on TERRANCE (DAVIS000203132), whose cancel was refused (commitBoard: 16 stop(s) moved to ALLEN C (DAVIS000203183), but NuVizz refused to cancel the now-emptied TERRANCE (DAVIS000203132): Vehicle Type unavailable or disabled. Please verify Vehicle Type in Vehicle Type Configuration for DAVIS000203132 (code 903). It still holds 007172492. NuVizz is refusing every edit of this route because its Vehicle Type is disabled/unavailable — enable or change it under Vehicle Type Configuration in the portal (or cancel the route there), then re-Save.). Sort out TERRANCE (DAVIS000203132), then move 007172492 and re-Save — nothing on ALLEN C (DAVIS000203183) was lost.",
  ADDRESS_DRIFT: "setStopAddress: the address changed to 2030 POWERS FERRY ROAD, STE 150, ATLANTA, GA, 30339 AND partialUpdate changed 1 other field(s) on the order. documents: LOST to|BOL|03||pdf||01. Check 007177120 in the portal.",
  NOTE_DRIFT: "addStopNote: the note landed BUT partialUpdate changed 1 other field(s) on the order. documents: LOST to|BOL|03||pdf||01. Check 007179517 in the portal — do not use notes again until this is investigated.",
  IN_TRANSIT: "Stop ESTES-0642557119 is in Transit,can not be updated. (code 906)",
  COULD_NOT_READ: "setStopAddress: could not read stop AVRT-0410740348 (read failed) — nothing was written.",
  FETCH_FAILED: "fetch failed",
  CREATE_CRASH: "createRoute: Internal Server Error: {\"reasons\":[{\"description\":\"\\u003cDeliverItLoadResponse xmlns\\u003d\\\"http://schemas.nuvizzards.com/schemas/di/response\\\"\\u003e\\n   \\u003cDocumentID\\u003eUNKNOWN\\u003c/DocumentID\\u003e\\n   \\u003cStatus\\u003e99\\u003c/Status\\u003e\\n   \\u003cErrors class\\u003d\\\"java.util.ArrayList\\\"\\u003e\\n      \\u003cError ErrorMsgID\\u003d\\\"998\\\"\\u003eCannot invoke \\u0026quot;com.nuvizz.openapi.server.v7.model.DeliverItLoad.getCompanyCode()\\u0026quot; because \\u0026quot;deliverItLoad\\u0026quot; is null\\u003c/Error\\u003e\\n   \\u003c/Errors\\u003e\\n   \\u003cResult\\u003e\\n      \\u003cRecordsCreated\\u003e0\\u003c/RecordsCreated\\u003e\\n      \\u003cRecordsUpdated\\u003e0\\u003c/RecordsUpdated\\u003e\\n      \\u003cRecordsDeleted\\u003e0\\u003c/RecordsDeleted\\u003e\\n   \\u003c/Result\\u003e\\n\\u003c/DeliverItLoadResponse\\u003e\",\"reasonCode\":\"998\"}]}",
};

const say = (m) => plainWriteError(m, { on: true });

test('the non-DO refusal, before it named the stop: what happened and where to look', () => {
  assert.equal(say(REAL.NONDO_OLD), "Not saved. NuVizz has a stop on this route that isn't on your card, so the stop order could not be changed. Find it on the route in the NuVizz portal.");
});

test('the non-DO refusal as v1.98.4 names it: the stop, and both ways out', () => {
  const one = 'commitBoard(rwb): load has a non-DO stop in a delivery slot that this card is not sequencing — RA58610778-1-1 (pickup, LOCKHEED MARTIN, NuVizz stop 19). Nothing was sent: add it to the card if it belongs on this route, or take it off the load in the portal, then Save.';
  assert.equal(say(one), "Not saved. NuVizz has a stop on this route that isn't on your card: RA58610778-1-1 (pickup, LOCKHEED MARTIN, NuVizz stop 19). Add it to the card if it belongs on this route, or take it off the route in the portal, then Save again.");
  const two = 'commitBoard(rwb): load has a non-DO stop in a delivery slot that this card is not sequencing — A1 (pickup, ACME, NuVizz stop 3); B2 (pickup, BETA, NuVizz stop 7). Nothing was sent: add them to the card if they belong on this route, or take them off the load in the portal, then Save.';
  assert.match(say(two), /^Not saved\. NuVizz has stops on this route that aren't on your card: A1 \(pickup, ACME, NuVizz stop 3\); B2 \(pickup, BETA, NuVizz stop 7\)\. Add them/);
});

test('orders the screen is not showing yet: how many, which, and why the Save stopped', () => {
  assert.equal(say(REAL.BOARD_5), "Not saved. NuVizz has 5 orders on this route that your screen isn't showing yet (007176053, 007176112, 007176028…). Saving now would take them off the truck — refresh, then Save again.");
  assert.equal(say(REAL.BOARD_1), "Not saved. NuVizz has an order on this route that your screen isn't showing yet (007182984). Saving now would take it off the truck — refresh, then Save again.");
});

test('an order another route holds: the route names, and the load numbers only when the names match', () => {
  assert.equal(say(REAL.HELD), "Order 007174958 is already on WILLIAM, so it couldn't go on ENOCK. Open WILLIAM in Compare and move it from there, or take it off WILLIAM in the portal.");
  // BUFORD on two different days: the numbers are the only way to tell them apart, so they stay.
  assert.equal(say(REAL.HELD_SAME_NAME), "Order 007174083-1 is already on BUFORD (DAVIS000203544), so it couldn't go on BUFORD (DAVIS000203661). Open BUFORD (DAVIS000203544) in Compare and move it from there, or take it off BUFORD (DAVIS000203544) in the portal.");
  // The holder is in the same Save: NuVizz is catching up, and the words say so.
  const inBatch = "commitBoard(rwb): stop 111 couldn't be added to ENOCK (DAVIS000203499) — NuVizz still holds it on WILLIAM (DAVIS000203441). WILLIAM (DAVIS000203441) is part of this Save, so its own save should have released the stop — NuVizz may still be settling. Wait a few seconds, refresh, and re-Save; if it persists, unplan the stop there in the portal.";
  assert.match(say(inBatch), /^Order 111 is still on WILLIAM in NuVizz, so it couldn't go on ENOCK\. WILLIAM is in this same Save/);
  assert.equal(say(REAL.ALREADY), 'Order AVRT-0170416694 is already on WILLIAM — your screen may be out of date. Open WILLIAM in Compare to move it, or refresh and check again.');
});

test('a route that failed because another failed first says which, and why that one failed', () => {
  assert.equal(say(REAL.COLLATERAL), "DARVIN was not saved. Order 007173900 comes from DENIS SALKIC, and DENIS SALKIC couldn't be saved: Order 007173614 is already on WILLIAM, so it couldn't go on DENIS SALKIC. Open WILLIAM in Compare and move it from there, or take it off WILLIAM in the portal. Fix DENIS SALKIC first, then Save again.");
  assert.equal(say(REAL.ABORTED), "Nothing was saved, because another route in this Save failed (NuVizz didn't send back the updated route, so the stop order was not saved). A Save goes through all together or not at all, so Save again once that route is fixed.");
  const persisted = 'commitBoard(rwb): aborted — another load in this Save failed (fetchUpdatedJson returned no route preview). A resequence step had ALREADY persisted for an earlier load — check the loads in the portal, then re-Save.';
  assert.equal(say(persisted), "Not all of this Save went through. Another route in it failed (NuVizz didn't send back the updated route, so the stop order was not saved), after an earlier route's stop order had already been saved. Check the routes in the portal, then Save again.");
});

test('no route preview says the ORDER was not saved — never that nothing changed', () => {
  const s = say(REAL.NO_PREVIEW);
  assert.equal(s, "NuVizz didn't send back the updated route, so the stop order was not saved. Refresh and check the route, then Save again.");
  assert.doesNotMatch(s, /nothing (was|has been) (saved|changed|written)/i, 'orders may already have been added before this step');
});

test('orders not on the route yet, and a Save NuVizz took that could not be read back', () => {
  assert.equal(say(REAL.NOT_APPEAR), "12 orders (007175028, 007174623, 007175309…) haven't shown up on NOR 2 yet. NuVizz still has the first one as unplanned, so it is probably still working on it. Nothing was planned twice. Wait a few seconds, then Save again.");
  const settling = "commitBoard(rwb): stop 222 did not appear on NOR 2 (DAVIS000203463) after the add — the stop record reads ON this load already (NuVizz’s route view is still settling) (nothing was double-planned). Wait a few seconds and Save again.";
  assert.equal(say(settling), "Order 222 hasn't shown up on NOR 2 yet, but NuVizz's own record already has it on NOR 2, so NuVizz is still catching up. Nothing was planned twice. Wait a few seconds, then Save again.");
  assert.equal(say(REAL.BREAKER), "NuVizz took the Save, but the app couldn't read it back to check it — NuVizz calls are paused for a moment. Refresh in a minute, then Save again to confirm.");
});

test('the route NuVizz would not cancel: why, what it still holds, and what to do', () => {
  assert.equal(say(REAL.CANCEL_REFUSED), "The orders moved to ALLEN C, but NuVizz wouldn't cancel the TERRANCE route because its Vehicle Type is turned off. TERRANCE still has order 007172492. Turn the Vehicle Type back on or change it (or cancel TERRANCE) in the portal, then Save again.");
  assert.equal(say(REAL.PARTIAL), "15 of 16 orders moved to ALLEN C. Order 007172492 is still on TERRANCE, because NuVizz wouldn't cancel TERRANCE. Sort out TERRANCE in the portal, then move 007172492 and Save again — nothing on ALLEN C was lost.");
});

test('address and note writes: what changed, what else moved, in words — and no instruction is dropped', () => {
  assert.equal(say(REAL.ADDRESS_DRIFT), 'The address changed to 2030 POWERS FERRY ROAD, STE 150, ATLANTA, GA, 30339, but NuVizz also changed one other thing on the order (the BOL document). Check order 007177120 in the portal.');
  // The server says not to use notes again until it is looked at; the plain words keep that.
  assert.equal(say(REAL.NOTE_DRIFT), "The note was added, but NuVizz also changed one other thing on the order (the BOL document). Check order 007179517 in the portal, and don't add more notes until this is looked into.");
  const moved = 'addStopNote: the note did NOT land BUT partialUpdate changed 2 other field(s) on the order. AN ADDRESS ON THE ORDER MOVED — verify the order\'s addresses in the portal before it ships. to.address.addr1: "1 A ST" → "2 B ST" | to.referenceNbr: "X" → "Y". Check 333 in the portal — do not use notes again until this is investigated.';
  assert.equal(say(moved), "The note didn't go on, but NuVizz also changed 2 other things on the order (addr1, reference nbr). An address on the order moved — check its addresses before it ships. Check order 333 in the portal, and don't add more notes until this is looked into.");
  const notChanged = 'setStopAddress: NuVizz accepted the write but 444 still reads 1 OLD RD, BUFORD, GA, 30518, not 2 NEW RD, BUFORD, GA, 30518 — the address did NOT change. Check it in the portal; do not assume it took.';
  assert.equal(say(notChanged), "NuVizz didn't change the address — order 444 still reads 1 OLD RD, BUFORD, GA, 30518. Check it in the portal before trying again.");
  assert.equal(say(REAL.COULD_NOT_READ), "Nothing was changed: the app couldn't read order AVRT-0410740348 from NuVizz. Refresh, then try again.");
  assert.equal(say(REAL.IN_TRANSIT), "Order ESTES-0642557119 is already in transit, so NuVizz won't let it be changed.");
});

test('NuVizz crashing on a new route is said as NuVizz refusing it — its own reply created nothing', () => {
  assert.match(REAL.CREATE_CRASH, /RecordsCreated\\u003e0/, 'NuVizz answered RecordsCreated 0');
  assert.equal(say(REAL.CREATE_CRASH), 'NuVizz hit an internal error and refused to create the route.');
});

test('the new-route guards, said plainly', () => {
  assert.equal(say('createRoute: order 007174458 is ALREADY PLANNED on TRAILER 6 (DAVIS000204111) — remove it from this card, or open TRAILER 6 (DAVIS000204111) in Compare to move it. Nothing was created'),
    'Nothing was created: order 007174458 is already on TRAILER 6. Take it off this card, or open TRAILER 6 in Compare to move it.');
  assert.equal(say('createRoute: NuVizz already has a route named SHEATS — open it from the Routes panel instead of creating it again, or pick another name — nothing was created'),
    'Nothing was created: NuVizz already has a route named SHEATS. Open it from the Routes panel, or pick another name.');
  assert.match(say('createRoute: route TEST WAS created in NuVizz (DAVIS000000123), but its 2 order(s) did not attach — commitBoard(rwb): fetchUpdatedJson returned no route preview. Close this card and open TEST from the Routes panel to add them; do NOT create it again.'),
    /^The route TEST was created in NuVizz \(DAVIS000000123\), but its orders didn't go on it .* — don't create it again\.$/);
  assert.equal(say('createRoute: the route needs at least one order — NuVizz will not create an empty one (reason 903). Drag orders onto the card, then Save'),
    'Nothing was created: a new route needs at least one order. Drag orders onto the card, then Save.');
});

test('the connection: NuVizz unreachable, or an answer that never came back', () => {
  assert.equal(say(REAL.FETCH_FAILED), "The app couldn't reach NuVizz (a network problem). Check the route in the portal before trying again.");
  assert.equal(say('Failed to fetch'), "The connection dropped before the answer came back, so the app can't tell whether this went through. Check it before trying again.");
});

test('a message no rule knows keeps its own words — only the code-looking prefix goes', () => {
  assert.equal(say('commitBoard(rwb): load unreadable after save (400) — verify in the portal, then refresh'), 'Load unreadable after save (400) — verify in the portal, then refresh.');
  assert.equal(say('setStopDate: something new happened'), 'Something new happened.');
});

test('every real message from the log reads without the code-looking words', () => {
  for (const [k, m] of Object.entries(REAL)) {
    const s = say(m);
    assert.doesNotMatch(s, /commitBoard|createRoute|setStopAddress|addStopNote|partialUpdate|fetchUpdatedJson|declarative|RWB\b|\\u003c|<DeliverIt/, k);
    assert.ok(s.length > 0 && s.length < m.length + 120, `${k}: a sentence, not a novel`);
  }
});

test('VITE_PLAIN_ERRORS: off hands back the server words exactly; a typo leaves the plain words on', () => {
  assert.equal(plainWriteError(REAL.NONDO_OLD, { on: false }), REAL.NONDO_OLD);
  assert.equal(plainErrorsEnabled({}), true);
  assert.equal(plainErrorsEnabled(undefined), true);
  for (const v of ['off', 'OFF', '0', 'false', ' no ']) assert.equal(plainErrorsEnabled({ VITE_PLAIN_ERRORS: v }), false, v);
  for (const v of ['offf', 'on', '1', '', 'nope']) assert.equal(plainErrorsEnabled({ VITE_PLAIN_ERRORS: v }), true, v);
  for (const junk of [null, undefined, '', '   ']) assert.equal(plainWriteError(junk, { on: true }), junk == null ? '' : junk);
});

test('the new-route toast speaks plainly through clipForToast, and says when it cut', () => {
  assert.equal(clipForToast(REAL.CREATE_CRASH), 'NuVizz hit an internal error and refused to create the route.');
  assert.match(clipForToast('x'.repeat(900)), /… \(cut short — the full message is in the write log\)$/);
});

// ── the screen uses it everywhere a write error is shown ─────────────────────
const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
test('App.jsx: the Save toasts, the address window and the address queue all say it plainly', () => {
  assert.match(APP, /import \{ clipForToast, plainWriteError, PLAIN_ERRORS_ON \} from '\.\/lib\/write-error\.js';/);
  assert.match(APP, /\$\{cardName\(l\)\}: \$\{plainWriteError\(l\.error \|\| /, 'each failed route in a Save');
  assert.match(APP, /showToast\(`✗ \$\{plainWriteError\(res\.error \|\| 'write failed'\)\}\$\{orphanMsg\}`\);/, 'a Save that failed whole');
  assert.match(APP, /NuVizz did not take it: \$\{plainWriteError\(why\)\}/, 'the address window');
  assert.match(APP, /kind: 'refused', text: plainWriteError\(out\.error \|\| err\) \|\| 'NuVizz refused the write\.'/, 'the address queue');
  assert.match(APP, /kind: 'unknown', text: PLAIN_ERRORS_ON && \(out\.error \|\| err\) \? plainWriteError\(out\.error \|\| err\)/, 'no empty line when there is no error text');
  assert.match(APP, /kind: 'dirty', text: PLAIN_ERRORS_ON && \(out\.error \|\| err\) \? plainWriteError\(out\.error \|\| err\)/);
});
