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
  assert.match(fnSource('UlineReviewDesktop'), /w-72 shrink-0/);
  assert.match(fnSource('UlineReviewMobile'), /\{i \+ 1\} of \{n\} to decide/);
});

test('Refresh re-reads THIS tab, not the log behind it', () => {
  assert.match(fnSource('AddressHistoryScreen'), /section === 'problems' \|\| section === 'uline' \? setQueueNonce/);
});

test('THE WRITE IS THE BRUSH\'S WRITE — a merge of the shared payload into customer_notes', () => {
  const hook = fnSource('useUlineReview');
  // ONE write path (v1.61.0) — the vehicle answer, a building-type chip and Undo all go through
  // the same merged setDoc, and every payload comes from a tested builder in uline-review.js.
  assert.match(hook, /await setDoc\(doc\(db, 'customer_notes', row\.key\), fields, \{ merge: true \}\);/);
  assert.match(hook, /fields = eligibilityPayload\(row\.key, change\.eligibility, stamp\);/);
  assert.match(hook, /const w = buildingTypeWrite\(row\.key, change\.buildingType, stamp\);/);
  assert.match(hook, /fields = undoWrite\(row\.key, change, stamp\);/);
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
  assert.match(hook, /decision: decisionAfter\(r, nextElig\)/, 'and moves to where the pure rule says');
  assert.match(hook, /catch \(e\) \{\s*setWriteErr\(/, 'a failed save is said out loud');
});

test('UNDO restores what was there before the press — never a guess at it', () => {
  const hook = fnSource('useUlineReview');
  // The snapshot is taken from the row BEFORE the write: the vehicle mark (currentElig) and,
  // for a chip, the building type — both when Residential did double duty.
  assert.match(APP, /const currentElig = \(row\) => \(row\?\.decision === 'box_only' \|\| row\?\.decision === 'tractor' \? row\.decision : null\);/);
  assert.match(hook, /prev\.eligibility = currentElig\(row\);/);
  assert.match(hook, /prev\.buildingType = row\.buildingType \?\? null;/);
  assert.match(fnSource('UlineLastLine'), /u\.apply\(row, u\.last\.prev, \{ undo: true \}\)/);
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
  assert.match(mob, /const \[seen, setSeen\] = React\.useState\(\(\) => new Set\(\['above'\]\)\);/, 'only the first view is built on arrival');
  assert.match(mob, /\{seen\.has\('street'\) && <UlineStreetView /, 'the street view waits for its tap');
  assert.match(mob, /\{seen\.has\('3d'\) && <UlineThreeD /, 'so does 3D, on its own meter');
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
  // Desktop 44, the phone card 52, the phone's full-screen row 48 — none under the 44px phone
  // floor, all over the 40px tablet one.
  const b = fnSource('UlineDecisionButtons');
  assert.match(b, /const tall = \{ minHeight: compact \? 48 : stacked \? 52 : 44 \};/);
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
    assert.match(src, /\{note && <div className=\{ULINE_NOTE_CLS\}>/, `${name} messages are overlays`);
  }
});

test('the street view does not keep showing the LAST building under a new row', () => {
  // A stale 'ok' from the previous location would hide the overlay over a panorama still
  // pointed at the old building — the most misleading picture this tab could show.
  // (Since v1.60.3 the same branch also stops the stale panorama drawing — see the guards below.)
  assert.match(fnSource('UlineStreetView'), /if \(!active \|\| !google \|\| !holder\.current \|\| !pin\) \{[\s\S]{0,260}?setState\('loading'\);\s*return undefined;\s*\}/);
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
  for (const name of ['UlineSatellite', 'UlineStreetView', 'UlineThreeD']) {
    const src = fnSource(name);
    assert.match(src, /<div ref=\{holder\} className="absolute inset-0 isolate /, `${name}: the holder is its own stacking context`);
    assert.match(src, /\{note && <div className=\{ULINE_NOTE_CLS\}>/, `${name}: the note is the shared overlay`);
  }
  // …and the shared overlay sits above the holder regardless.
  assert.match(APP, /const ULINE_NOTE_CLS = 'absolute inset-0 z-10 /);
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
  assert.match(fnSource('UlineStreetView'), /if \(!active \|\| !google \|\| !holder\.current \|\| !pin\) \{[\s\S]{0,160}?try \{ panoRef\.current\?\.setVisible\(false\); \}/);
});

test('the note Chad asked for is the sentence on screen when there is no street view', () => {
  assert.match(fnSource('UlineStreetView'), /Google has no street view within 80 m of this pin — judge it from the satellite or 3D\./);
});

// ── v1.61.0 — THE 3D VIEW, FULL SCREEN INSIDE THE BROWSER, BIGGER PICTURES, BUILDING TYPE ─────
//
// Chad, on the live tab: "I want my 3d view here as well also when you click full screen i want
// it to stay within the browser we have a lot of gray space on this page we could be using to
// make this maps bigger initially" — and: "also give me options to label building type like this
// is residential ... double duty as residentials we don't allow to be planned on tractors."

test('THE 3D VIEW IS ON BOTH VIEWS, and it keeps every rule the Map\'s 3D learned the hard way', () => {
  assert.match(fnSource('UlineReviewDesktop'), /<UlineThreeD /);
  assert.match(fnSource('UlineReviewMobile'), /<UlineThreeD /);
  const d3 = fnSource('UlineThreeD');
  assert.match(d3, /if \(!MAP_3D_ON \|\| /, 'VITE_MAP_3D=off turns it off here exactly as on the Map — one switch');
  assert.match(d3, /if \(!webglUsable\(\)\) \{ setErr\(MAP3D_NO_WEBGL\); return; \}/, 'WebGL checked before anything is built or billed');
  assert.match(d3, /addEventListener\('gmp-error'/, 'Google\'s own "could not start" is caught');
  assert.match(d3, /groundedCamera\(cam, mode\)/, 'the camera aims at the ground, not at sea level inside the hill');
  assert.match(d3, /RELATIVE_TO_MESH/, 'the pin sits on the roof where it can be seen');
});

test('ONE 3D ELEMENT, RE-POINTED — Google bills 3D per element created, on its own meter', () => {
  const d3 = fnSource('UlineThreeD');
  assert.match(d3, /if \(!elRef\.current\) \{/);
  assert.match(d3, /if \(building\.current\) return;/, 'two fast rows cannot both construct');
  assert.match(d3, /elRef\.current\.flyCameraTo\(\{ endCamera: end, durationMillis: 0 \}\)/, 'every later row only moves the camera');
});

test('THE 3D VIEW STAYS COVERED UNTIL THE NEW BUILDING HAS LANDED — the v1.60.3 rule, for 3D', () => {
  // Google applies a teleported camera a moment AFTER flyCameraTo returns (measured in
  // map-3d.js), so for that moment the element still shows the PREVIOUS customer's roof.
  const d3 = fnSource('UlineThreeD');
  assert.match(d3, /React\.useEffect\(\(\) => \{\s*setReady\(false\);/, 'hidden the instant the pin changes');
  assert.match(d3, /setTimeout\(\(\) => \{ if \(!dead\) setReady\(true\); \}, ULINE_3D_SETTLE_MS\)/);
  assert.match(d3, /style=\{\{ visibility: note \? 'hidden' : 'visible' \}\}/);
  assert.match(d3, /: !ready \? 'Loading the 3D view…' : null;/);
});

test('FULL SCREEN STAYS IN THE BROWSER — Google\'s monitor-wide button is off, ours fills the window', () => {
  // Google's fullscreenControl calls the browser Fullscreen API and takes the whole monitor.
  assert.match(fnSource('UlineSatellite'), /fullscreenControl: false/);
  assert.match(fnSource('UlineStreetView'), /fullscreenControl: false/);
  assert.doesNotMatch(fnSource('UlineSatellite') + fnSource('UlineStreetView'), /fullscreenControl: true/);
  const frame = fnSource('UlineViewFrame');
  assert.match(frame, /expanded \? 'fixed inset-0 z-\[80\] bg-white p-3 flex flex-col'/, 'fills the browser window');
  assert.match(frame, /data-overlay-layer=\{expanded \? '' : undefined\}/, 'and declares itself to the overlap guard');
});

test('GOING FULL SCREEN REBUILDS NOTHING — the pane is restyled, never re-parented', () => {
  // A portal would unmount the pane and remount it elsewhere: a new Google map, panorama or 3D
  // element — a new billed load — every time somebody pressed Full screen.
  const block = APP.slice(APP.indexOf('// ── ULINE: STRAIGHT TRUCK ONLY'), APP.indexOf('function AddressHistoryScreen() {'));
  assert.doesNotMatch(block, /createPortal/);
});

test('THE ANSWERS STAY ON SCREEN IN FULL SCREEN — and Esc gets you out', () => {
  const bar = fnSource('UlineExpandedBar');
  assert.match(bar, /<UlineDecisionButtons row=\{row\} u=\{u\}/, 'N / T / Skip across the top of the full-screen view');
  assert.match(bar, /onClick=\{onClose\}/);
  assert.match(fnSource('useEscToClose'), /if \(e\.key === 'Escape'\)/);
  assert.match(fnSource('UlineReviewDesktop'), /useEscToClose\(!!expanded, close\);/);
  assert.match(fnSource('UlineReviewMobile'), /useEscToClose\(expanded, close\);/);
});

test('FULL SCREEN STARTS AT THE TOP OF THE WINDOW — the card\'s spacing cannot push it down', () => {
  // On the phone the frame is a child of a space-y-3 card. That margin-top moved a fixed
  // inset-0 view 12px down the screen and 12px off the bottom (measured: top 0px, rect top 12).
  assert.match(fnSource('UlineViewFrame'), /style=\{expanded \? \{ margin: 0 \} : style\}/);
});

test('ON A PHONE THE FULL-SCREEN BAR IS COMPACT — the building keeps the screen', () => {
  // The card's thumb buttons stack three deep; over a full-screen picture that is most of it.
  const bar = fnSource('UlineExpandedBar');
  const phone = bar.slice(bar.indexOf('if (stacked) {'), bar.indexOf('\n  return (', bar.indexOf('if (stacked) {')));
  assert.match(phone, /<UlineDecisionButtons row=\{row\} u=\{u\} onDone=\{onDone\} onSkip=\{onSkip\} compact \/>/);
  assert.match(phone, /onClick=\{onClose\}/, 'Close shares the name row');
  assert.match(fnSource('UlineDecisionButtons'), /compact \? 'grid grid-cols-3 gap-1\.5'/, 'three answers, one row');
});

test('THE VIEW SWITCH FOLLOWS THE PICTURE INTO FULL SCREEN — and there is only ever one', () => {
  // Above / 3D / Street a tap away without closing — and never two tab lists answering to the
  // same name, which is also what a guard or a screen reader would trip over.
  const mob = fnSource('UlineReviewMobile');
  assert.match(mob, /\{!expanded && tabs\}/);
  assert.match(mob, /<UlineExpandedBar row=\{row\} u=\{u\} onDone=\{done\} onSkip=\{skip\} onClose=\{close\} stacked tabs=\{tabs\} \/>/);
  assert.equal((mob.match(/role="tablist"/g) || []).length, 1, 'one tab list, placed in one spot at a time');
});

test('RESIDENTIAL CAN BE PRESSED IN FULL SCREEN on the desktop — where a house is seen as a house', () => {
  const bar = fnSource('UlineExpandedBar');
  const desk = bar.slice(bar.lastIndexOf('\n  return ('));
  assert.match(desk, /<UlineBuildingType row=\{row\} u=\{u\} onDecided=\{onDone\} hint=\{false\} \/>/);
  // The sentence stays on the CARD, where there is room for it.
  assert.match(fnSource('UlineReviewDesktop'), /<UlineBuildingType row=\{row\} u=\{u\} onDecided=\{advance\} \/>/);
  assert.match(fnSource('UlineBuildingType'), /\{hint && \(/);
});

test('the expand button is IN FLOW in the label row, never pinned over the imagery', () => {
  // Pinned over the map it would land on Google's own controls — the collision the phone guard
  // exists to catch, patched four times on the Map before the rule was written.
  const frame = fnSource('UlineViewFrame');
  assert.match(frame, /<div className="flex items-center justify-between gap-2 mb-1">[\s\S]{0,900}?Full screen/);
  assert.doesNotMatch(frame, /absolute[^"]*top-/, 'no absolutely-pinned button');
});

test('THE PICTURES USE THE WINDOW — no dashboard cap on this tab, and sized to the screen height', () => {
  assert.match(fnSource('AddressHistoryScreen'), /section === 'uline' \? 'w-full' : SCREEN_DASH/);
  assert.match(APP, /const ULINE_PANE = \{ flex: '1 1 max\(40%, 460px\)', height: 'max\(460px, calc\(100vh - 560px\)\)' \};/);
});

test('TWO PICTURES ACROSS AT MOST — three across a 1080p screen were no bigger than v1.60.0\'s two', () => {
  // Measured, not assumed: three across at 1920 gave each ~500px; 3D beside a stacked pair
  // left satellite and street at 608×300 against v1.60.0's 676×380. A 40% basis fits two per
  // row and never three; the 460px floor puts one per row on a narrower desktop.
  const d = fnSource('UlineReviewDesktop');
  assert.match(d, /<div className="flex flex-wrap gap-3">\{above\}\{threeD\}\{street\}<\/div>/, 'from above and 3D first, the street view wraps under them');
  assert.match(d, /bar=\{bar\} style=\{ULINE_PANE\}>/, 'every pane takes the same sizing rule');
  assert.doesNotMatch(d, /ULINE_WIDE_PX|flex-\[3\]/, 'no second layout keyed to a breakpoint');
});

test('THE ANSWERS SIT BESIDE THE NAME — with pictures this big they would be below the fold', () => {
  const d = fnSource('UlineReviewDesktop');
  const name = d.indexOf('{row.businessName}</div>');
  const buttons = d.indexOf('<UlineDecisionButtons row={row} u={u} onDone={advance} onSkip={advance} />');
  const pictures = d.indexOf('{above}{threeD}{street}');
  assert.ok(name > 0 && buttons > name && buttons < pictures, 'answers come before the pictures, not after');
  // Evidence left, answers and building type right: the header is one band, not five rows.
  assert.match(d, /style=\{\{ flex: '1 1 420px' \}\}>[\s\S]{0,400}?<UlineEvidence row=\{row\} \/>/);
  assert.match(d, /style=\{\{ flex: '0 1 600px' \}\}>\s*<UlineDecisionButtons[\s\S]{0,200}?<UlineBuildingType row=\{row\} u=\{u\} onDecided=\{advance\} \/>/);
});

test('BUILDING TYPE IS ON THE CARD, on both views, through the one write path', () => {
  assert.match(fnSource('UlineReviewDesktop'), /<UlineBuildingType row=\{row\} u=\{u\} onDecided=\{advance\} \/>/);
  assert.match(fnSource('UlineReviewMobile'), /<UlineBuildingType row=\{row\} u=\{u\} onDecided=\{done\} stacked \/>/);
  const hook = fnSource('useUlineReview');
  assert.match(hook, /const setType = React\.useCallback\(\(row, type\) => apply\(row, \{ buildingType: type \}\), \[apply\]\);/);
});

test('RESIDENTIAL SAYS IT DOES TWO THINGS — on the chip and in words under the row', () => {
  // A button that quietly does two things is how a dispatcher gets surprised by the second one.
  const bt = fnSource('UlineBuildingType');
  assert.match(bt, /Residential — also saves Box truck only/);
  assert.match(bt, /\+ box only/);
  assert.match(bt, /Residential also saves Box truck only — we don’t send tractors to houses\./);
  // A Residential press DECIDED the row, so the card moves on; a plain label does not.
  assert.match(bt, /if \(await u\.setType\(row, next\) && BOX_ONLY_BUILDING_TYPES\.has\(next\)\) onDecided\?\.\(\);/);
  // Pressing the lit chip clears it back to Auto — the only way off, and it is the obvious one.
  assert.match(bt, /const next = current === t \? null : t;/);
});

test('the Undo line names both halves of a Residential press', () => {
  assert.match(fnSource('useUlineReview'), /`\$\{label\} — and No tractor trailer \(Box truck only\)`/);
});

test('EACH PHONE VIEW IS BUILT ON ITS FIRST TAP AND THEN ONLY HIDDEN', () => {
  // Torn down and rebuilt on every switch would be a new billed Google load per tap.
  const mob = fnSource('UlineReviewMobile');
  assert.match(mob, /const layer = \(id\) => \(\{ zIndex: view === id \? 2 : 1, pointerEvents: view === id \? 'auto' : 'none' \}\);/);
  assert.match(mob, /active=\{view === 'street'\}/, 'and a hidden view does no work until it is looked at');
});

test('NOTHING NEW TOUCHES NUVIZZ', () => {
  for (const name of ['UlineThreeD', 'UlineBuildingType', 'UlineViewFrame', 'UlineExpandedBar']) {
    assert.doesNotMatch(fnSource(name), /callWrite|setStopAddress|addStopNote|nuvizz-write/, name);
  }
});
