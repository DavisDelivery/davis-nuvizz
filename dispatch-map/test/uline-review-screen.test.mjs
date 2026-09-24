// test/uline-review-screen.test.mjs — the Uline straight-truck tab, on screen.
//
// These assert against App.jsx's source text: the tab cannot be mounted here without a browser,
// Firestore and the Google Maps API. The layout guards (verify-mobile/tablet-layout) open the
// tab for real on every phone and tablet width with a stubbed endpoint; these pin the promises
// a layout check cannot see — what a press WRITES, and when.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  return APP.slice(start, next > 0 ? next : undefined);
}

test('the tab is IN Address history, on both choosers', () => {
  // Both the phone chips and the desktop bar render ADDR_SECTIONS, so one entry is both tabs —
  // a screen added to one navigation and not the other is a screen that does not exist on a
  // phone, which has shipped in this repo twice.
  assert.match(APP, /\{ id: 'uline', label: 'Uline straight truck'/);
  assert.match(fnSource('AddrSectionChipsMobile'), /ADDR_SECTIONS\.map/);
  assert.match(fnSource('AddrSectionBarDesktop'), /ADDR_SECTIONS\.map/);
});

test('TWO VIEWS, not one reflowed', () => {
  const screen = fnSource('AddressHistoryScreen');
  assert.match(screen, /section === 'uline' && \(\s*isMobile\s*\? <UlineReviewMobile nonce=\{queueNonce\} \/>\s*: <UlineReviewDesktop nonce=\{queueNonce\} \/>/);
  // The desktop is a list BESIDE the building; the phone is one building at a time.
  assert.match(fnSource('UlineReviewDesktop'), /w-80 shrink-0/);
  assert.match(fnSource('UlineReviewMobile'), /\{i \+ 1\} of \{n\} to decide/);
});

test('Refresh re-reads THIS tab, not the log behind it', () => {
  assert.match(fnSource('AddressHistoryScreen'), /section === 'problems' \|\| section === 'uline' \? setQueueNonce/);
});

test('THE WRITE IS THE BRUSH\'S WRITE — a merge of the shared payload into customer_notes', () => {
  const hook = fnSource('useUlineReview');
  assert.match(hook, /setDoc\(doc\(db, 'customer_notes', row\.key\), eligibilityPayload\(row\.key, next, serverTimestamp\(\)\), \{ merge: true \}\)/);
  // CLAUDE.md: setDoc REPLACES unless merged. A decision that took the customer's receiving
  // hours and dock notes with it would be the worst possible outcome of a one-tap button.
  // EVERY setDoc statement in the hook ends in a merge — counted, so a second, unmerged write
  // added later fails here rather than shipping.
  const writes = hook.split('setDoc(').slice(1).map((rest) => rest.slice(0, rest.indexOf(';')));
  assert.ok(writes.length >= 1, 'the hook writes');
  for (const w of writes) assert.match(w, /\{ merge: true \}\)$/, `unmerged write: setDoc(${w}`);
});

test('NOTHING HERE TOUCHES NUVIZZ — the answer is saved to the customer, not the order', () => {
  // The tab's footer says zero calls; hold the code to it. No write client, no order op.
  for (const name of ['useUlineReview', 'UlineReviewDesktop', 'UlineReviewMobile', 'UlineDecisionButtons', 'UlineDecidedList']) {
    assert.doesNotMatch(fnSource(name), /callWrite|setStopAddress|addStopNote|nuvizz-write/, name);
  }
});

test('A ROW LEAVES "TO DECIDE" ONLY ONCE FIRESTORE HAS ACKNOWLEDGED THE WRITE', () => {
  // Moving it first would be an intent reported as an outcome: a failed save would leave the
  // screen saying "decided" over a location the router still holds to a box truck.
  const hook = fnSource('useUlineReview');
  const write = hook.indexOf("await setDoc(doc(db, 'customer_notes'");
  const move = hook.indexOf('setData((d) =>');
  assert.ok(write > 0 && move > write, 'the list moves after the await, not before');
  assert.match(hook, /decision: decisionAfter\(r, next\)/, 'and moves to where the pure rule says');
  assert.match(hook, /catch \(e\) \{\s*setWriteErr\(/, 'a failed save is said out loud');
});

test('UNDO restores what was there before the press — never a guess at it', () => {
  const hook = fnSource('useUlineReview');
  assert.match(hook, /const prev = row\.decision === 'box_only' \|\| row\.decision === 'tractor' \? row\.decision : null;/);
  assert.match(fnSource('UlineLastLine'), /u\.decide\(row, u\.last\.prev, \{ undo: true \}\)/);
});

test('A LOCATION A PERSON ALREADY MARKED "NO" IS NEVER GIVEN A ONE-TAP TRACTOR OK', () => {
  // vehicle_eligibility 'tractor' drops EVERY trailer blocker — Tractor OK on a row a dispatcher
  // had separately marked would overrule them. Confirmed rows get no controls; the stop card is
  // where that person's mark is changed.
  const list = fnSource('UlineDecidedList');
  assert.match(list, /const other = r\.decision === 'box_only' \? 'tractor' : r\.decision === 'tractor' \? 'box_only' : null;/);
  assert.match(list, /\{other && \(/, 'the change/clear controls exist only when there is an "other" — never on confirmed');
  assert.match(APP, /confirmed: \{ label: 'No tractor trailer — set by a dispatcher'/);
});

test('THE KEYS ARE N, T, S — and a stray keystroke cannot re-route a customer', () => {
  const desk = fnSource('UlineReviewDesktop');
  assert.match(desk, /if \(!row \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey \|\| e\.repeat\) return;/, 'no modifiers, no key-repeat');
  assert.match(desk, /tag === 'input' \|\| tag === 'textarea' \|\| tag === 'select' \|\| e\.target\?\.isContentEditable/, 'never inside a field');
  assert.match(desk, /k === 'n' \|\| k === 't'/);
  assert.match(desk, /window\.removeEventListener\('keydown', onKey\)/, 'and the listener leaves with the tab');
});

test('ONE MAP AND ONE PANORAMA FOR THE WHOLE REVIEW, re-pointed — not a billed load per row', () => {
  const sat = fnSource('UlineSatellite');
  assert.match(sat, /if \(!mapRef\.current\) \{/);
  assert.match(sat, /mapRef\.current\.setCenter\(at\)/);
  const sv = fnSource('UlineStreetView');
  assert.match(sv, /if \(!panoRef\.current\) \{/);
  assert.match(sv, /panoRef\.current\.setPano\(data\.location\.pano\)/);
  // A panorama built into a box that later hides renders black — the holder stays mounted.
  assert.match(sv, /<div ref=\{holder\} className="absolute inset-0/);
});

test('THE STREET VIEW FACES THE BUILDING — the camera is turned to the pin', () => {
  assert.match(fnSource('UlineStreetView'), /heading: bearingDeg\(/);
  assert.match(fnSource('UlineStreetView'), /Google has no street view within 80 m of this pin/, 'and a miss is said, not a black box');
});

test('the phone loads the street view only when asked for it', () => {
  // A phone shows one picture at a readable size; a panorama nobody opened is a billed load.
  const mob = fnSource('UlineReviewMobile');
  assert.match(mob, /view === 'above'\s*\? <UlineSatellite/);
  assert.match(mob, /: <UlineStreetView/);
});

test('the phone summary is ONE line — the building is the point, not the paragraph', () => {
  assert.match(fnSource('UlineReviewMobile'), /<UlineSummary u=\{u\} stacked \/>/);
  assert.match(fnSource('UlineSummary'), /if \(stacked\) \{/);
});

test('no pin → the screen sends the dispatcher to fix it, rather than showing the equator', () => {
  assert.match(fnSource('UlineSatellite'), /No pin for this stop — fix it on Problem addresses/);
});

test('the evidence card quotes Uline, and says when it cannot', () => {
  const ev = fnSource('UlineEvidence');
  assert.match(ev, /What Uline wrote/);
  assert.match(ev, /Uline’s exact words were not kept/);
  assert.match(ev, /One of our tractors has delivered here/);
  assert.match(ev, /NO_TRACTOR_PLACE_MARKS\.has\(place\)/, 'a school or church says so');
});

test('zero notes is announced as a READ FAILURE, not rendered as a clean board', () => {
  assert.match(fnSource('UlineEmpty'), /Number\(u\.data\.notesLoaded\) === 0/);
  assert.match(fnSource('UlineEmpty'), /This is a read failure, not a clean board/);
});

test('every answer button meets the 40px tablet floor — a tablet renders the DESKTOP branch', () => {
  const b = fnSource('UlineDecisionButtons');
  assert.match(b, /const tall = \{ minHeight: stacked \? 52 : 44 \};/);
});

// ── found by reading the diff back with "how does this fail silently?" ─────────

test('A NO-PIN ROW CANNOT BLANK THE NEXT ROW\'S PICTURES — the holders never unmount', () => {
  // Both panes keep their Google object in a ref. An early return for a no-pin row unmounted
  // the div it was built into, so the NEXT row with a pin re-pointed a map bound to a detached
  // element: a blank grey box, with nothing on screen saying why. Every note is now an overlay.
  for (const name of ['UlineSatellite', 'UlineStreetView']) {
    const src = fnSource(name);
    assert.doesNotMatch(src, /if \(!pin\) return </, `${name} must not unmount its holder for a no-pin row`);
    assert.doesNotMatch(src, /if \(!google\) return </, `${name} must not unmount its holder while Maps loads`);
    assert.match(src, /<div ref=\{holder\} className="absolute inset-0/, `${name} holder is always rendered`);
    assert.match(src, /\{note && <div className="absolute inset-0/, `${name} messages are overlays`);
  }
});

test('the street view does not keep showing the LAST building under a new row', () => {
  // A stale 'ok' from the previous location would hide the overlay over a panorama still
  // pointed at the old building — the most misleading picture this tab could show.
  // (Since v1.60.1 the same branch also stops the stale panorama drawing — see the guards below.)
  assert.match(fnSource('UlineStreetView'), /if \(!google \|\| !holder\.current \|\| !pin\) \{[\s\S]{0,160}?setState\('loading'\);\s*return undefined;\s*\}/);
});

test('ONE WRITE AT A TIME — N then T pressed faster than a render cannot race', () => {
  // Two in-flight writes for one row: Firestore keeps whichever LANDS last, which need not be
  // the key pressed last. Guarded in `decide` itself, so buttons, keys, Undo and Change all pass
  // through the same gate.
  const hook = fnSource('useUlineReview');
  assert.match(hook, /const inFlight = React\.useRef\(false\);/);
  assert.match(hook, /if \(inFlight\.current\) return false;\s*inFlight\.current = true;/);
  assert.match(hook, /finally \{ inFlight\.current = false; setBusyKey\(null\); \}/, 'and always released');
});

test('the desktop says how big the whole backlog is — and so exposes a broken join', () => {
  assert.match(fnSource('UlineSummary'), /u\.data\.backlog\.undecided\} undecided across all \{u\.data\.backlog\.flagged\} flagged customers/);
});

// ── NEVER ANOTHER CUSTOMER'S BUILDING ───────────────────────────────────────────
//
// Chad, 2026-09-24, on F13 at 475 Wilbanks Rd, Alto — the row after BURMAN PRINTING: "This stop
// is showing the street view from previous stop because i'm assuming there isn't one for this
// stop so if that is case just make it say so." The street pane showed Burman's front door.
// On the one screen whose whole job is judging a building by its picture, the picture was of the
// wrong building, and the decision buttons sat right under it.
//
// The note saying "no street view here" WAS set. It did not show, because Google paints the
// panorama with its own z-indexes and nothing contained them — so the stale panorama rose above
// the note meant to cover it. Each guard below would have prevented it on its own.

test('THE STREET PANE IS VISIBLE ONLY WHEN IT IS PROVEN TO BE THIS BUILDING', () => {
  const sv = fnSource('UlineStreetView');
  // Loading, none, no pin, no key — all hidden. Only a lookup for THIS pin can set 'ok'.
  assert.match(sv, /style=\{\{ visibility: state === 'ok' && !note \? 'visible' : 'hidden' \}\}/);
  assert.match(sv, /if \(dead\) return;/, 'a late answer for the previous pin is dropped');
});

test('Google\'s layers are CONTAINED, so no note can be painted over again', () => {
  for (const name of ['UlineSatellite', 'UlineStreetView']) {
    const src = fnSource(name);
    assert.match(src, /<div ref=\{holder\} className="absolute inset-0 isolate /, `${name}: the holder is its own stacking context`);
    assert.match(src, /\{note && <div className="absolute inset-0 z-10 /, `${name}: the note sits above it regardless`);
  }
});

test('"NO PANORAMA HERE" IS CAUGHT — it arrives as a rejection on the current API', () => {
  const sv = fnSource('UlineStreetView');
  assert.match(sv, /getPanorama\(req\)\.then\(/, 'the promise form');
  assert.match(sv, /\}\)\.catch\(none\);/, 'and its rejection handled — an unhandled one left the pane on the last building');
  assert.doesNotMatch(sv, /getPanorama\(req, \(/, 'not the callback form that failed to carry the answer');
  // Hidden from drawing as well as from view: one CSS change must not bring the old door back.
  assert.match(sv, /const none = \(\) => \{[\s\S]{0,400}?panoRef\.current\?\.setVisible\(false\)/);
  assert.match(sv, /panoRef\.current\.setVisible\(true\);/, 'and shown again only on a real match');
});

test('a no-pin row hides the previous building in BOTH panes', () => {
  // The map stays centred where the last row put it; the pane must not be trusted to sit under
  // a note — it is hidden outright.
  assert.match(fnSource('UlineSatellite'), /style=\{\{ visibility: note \? 'hidden' : 'visible' \}\}/);
  assert.match(fnSource('UlineStreetView'), /if \(!google \|\| !holder\.current \|\| !pin\) \{\s*try \{ panoRef\.current\?\.setVisible\(false\); \}/);
});

test('the note Chad asked for is the sentence on screen when there is no street view', () => {
  assert.match(fnSource('UlineStreetView'), /Google has no street view within 80 m of this pin — judge it from the satellite\./);
});
