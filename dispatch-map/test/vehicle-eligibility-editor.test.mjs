// THE STOP CARD SHOWED "Box truck only" AND THE EDIT BUTTON COULD NOT TAKE IT OFF.
//
// Chad, from a stop card reading CUSTOMER NOTES → VEHICLE → "Box truck only" in red:
// "take the box truck only off."
//
// `customer_notes.vehicle_eligibility` had exactly one writer in the whole app — the
// Routing map's eligibility brush (markEligibility). The stop card RENDERS the mark, in
// red, with an Edit button beside it, and the editor behind that button had no vehicle
// control at all. So the field was display-only from the one screen that shows it: the
// way to remove a box-only mark was to leave the card, open Routing, arm a brush in the
// ⚙ menu and find the customer's pin on the map.
//
// WHY THAT MATTERS IN FREIGHT TERMS, not just UI terms. The mark is keyed by LOCATION,
// so it holds for every future stop at that customer, and it is a hard block in two
// places: the router (routing-build-background.mts forces the stop onto a box) and the
// trailer-conflict alert (dispatcherTrailerBlock). A mark set in error, or one the world
// has outgrown, bars a 53' trailer from that address indefinitely and costs a trailer's
// worth of capacity every day nobody finds the brush.
//
// These tests pin the RULE (clearing the mark actually unblocks the trailer), the
// provenance rule (an unrelated note edit must not restamp somebody else's decision),
// and — because a fixture cannot prove a control REACHED the screen — that the picker is
// in the shared editor both the phone and the desktop panel render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dispatcherTrailerBlock, eligibilityChanged, normalizeEligibility,
} from '../src/lib/trailer-block.js';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
// THE CODE, WITHOUT THE CHANGELOG. VERSION_LOG is 800 lines of prose at the top of the file
// and a row that QUOTES a guard counts as a copy of it — v1.53.0's row names
// `...(eligibilityChanged(draft, existing)` in so many words, and the count below read 4
// saves where there are 3. A test that a changelog entry can break is a test that gets its
// number edited rather than its cause fixed, which is how a real fourth unguarded save would
// slip past it.
const CODE = APP.slice(APP.indexOf('\n];\n', APP.indexOf('const VERSION_LOG = [')));

// ── The rule: taking the mark off actually lets a trailer serve the stop ──────
test('clearing a box-only mark unblocks the 53-footer at that location', () => {
  const painted = { vehicle_eligibility: 'box_only', equipment_restrictions: [] };
  assert.equal(dispatcherTrailerBlock(painted).blocked, true, 'box_only must block while it is set');
  assert.equal(dispatcherTrailerBlock(painted).via, 'eligibility');

  // What the editor writes when a dispatcher picks "not set".
  const cleared = { ...painted, vehicle_eligibility: null };
  assert.equal(dispatcherTrailerBlock(cleared).blocked, false, 'a cleared mark must stop blocking');
  assert.equal(dispatcherTrailerBlock(cleared).via, null);
});

test('clearing the vehicle mark does NOT clear a ticked equipment restriction', () => {
  // Two independent statements. A dispatcher who un-sets the vehicle picker has not
  // said anything about the "No tractor trailer" box they ticked separately, and the
  // stop must stay blocked — otherwise this control would silently undo the other one.
  const both = { vehicle_eligibility: 'box_only', equipment_restrictions: ['no_tractor_trailer'] };
  const cleared = { ...both, vehicle_eligibility: null };
  const out = dispatcherTrailerBlock(cleared);
  assert.equal(out.blocked, true, 'the ticked restriction still stands on its own');
  assert.equal(out.via, 'restriction', 'and the block is now quoted as the restriction, not the paint');
});

// ── The provenance rule ──────────────────────────────────────────────────────
test('editing receiving hours does not restamp a vehicle mark nobody touched', () => {
  const existing = { vehicle_eligibility: 'box_only', receiving_hours: { mon: { open: '08:00', close: '16:00' } } };
  const draft = { ...existing, receiving_hours: { mon: { open: '09:00', close: '15:00' } } };
  assert.equal(eligibilityChanged(draft, existing), false);
});

test('a save that moves the vehicle mark is stamped — set, changed and cleared alike', () => {
  assert.equal(eligibilityChanged({ vehicle_eligibility: 'box_only' }, {}), true, 'none → box only');
  assert.equal(eligibilityChanged({ vehicle_eligibility: 'tractor' }, { vehicle_eligibility: 'box_only' }), true, 'box only → tractor');
  assert.equal(eligibilityChanged({ vehicle_eligibility: null }, { vehicle_eligibility: 'box_only' }), true, 'box only → cleared');
});

test('a first note on a customer with no doc yet is not a vehicle change', () => {
  // emptyNote() seeds vehicle_eligibility: null. Saving hours on a brand-new customer
  // must not write a vehicle stamp for a decision nobody made.
  assert.equal(eligibilityChanged({ vehicle_eligibility: null }, undefined), false);
  assert.equal(eligibilityChanged({}, undefined), false);
});

test('a malformed stored value reads as "not set", not as a fourth state', () => {
  for (const junk of ['', false, 0, 'BOX_ONLY', 'box', undefined, null]) {
    assert.equal(normalizeEligibility(junk), null, `${JSON.stringify(junk)} must normalize to null`);
  }
  assert.equal(normalizeEligibility('tractor'), 'tractor');
  assert.equal(normalizeEligibility('box_only'), 'box_only');
  // And so a legacy '' doc does not look like an edit every time hours are saved.
  assert.equal(eligibilityChanged({ vehicle_eligibility: '' }, { vehicle_eligibility: null }), false);
});

// ── The control actually reached the screen (both of them) ────────────────────
test('the notes editor offers all three vehicle states, cleared included', () => {
  const block = APP.match(/const VEHICLE_ELIGIBILITY_OPTIONS = \[[\s\S]*?\];/);
  assert.ok(block, 'VEHICLE_ELIGIBILITY_OPTIONS must exist');
  for (const v of ['value: null', "value: 'tractor'", "value: 'box_only'"]) {
    assert.ok(block[0].includes(v), `the picker must offer ${v} — without null there is no way to take a mark off`);
  }
  assert.ok(
    /VEHICLE_ELIGIBILITY_OPTIONS\.map\(/.test(APP) && /setD\(\{ vehicle_eligibility: o\.value \}\)/.test(APP),
    'the picker must be rendered and write vehicle_eligibility into the draft',
  );
});

test('the vehicle picker is inside StopNotesEditor, which BOTH stop panels render', () => {
  // Chad has had a screen ship to one navigation and not the other twice. There are two
  // stop panels and they are genuinely separate work: StopSidebar (desktop, `compact` —
  // tight spacing for a narrow sidebar driven by a mouse, and mounted by BOTH the Map and
  // the Routing screens) and MobileStopDetailDrawer (the phone, full padding and 44px tap
  // targets). `compact` means tight spacing, not "mobile" — the phone is the roomy one.
  // The editor itself is shared, so what has to be checked is that the picker is inside it
  // and that both panels still mount it.
  const editor = APP.slice(APP.indexOf('function StopNotesEditor'));
  const body = editor.slice(0, editor.indexOf('\nfunction '));
  assert.ok(body.includes('VEHICLE_ELIGIBILITY_OPTIONS.map('), 'the picker must live in the shared editor');

  const mounts = [...APP.matchAll(/<StopNotesSection[^>]*/g)].map((m) => m[0]);
  assert.equal(mounts.length, 2, 'expected exactly two panels mounting the notes section');
  assert.equal(mounts.filter((m) => /\bcompact\b/.test(m)).length, 1, 'the desktop sidebar mounts it compact');
  assert.equal(mounts.filter((m) => !/\bcompact\b/.test(m)).length, 1, 'the phone drawer mounts it full-size');

  // And the desktop sidebar is the panel both desktop screens use, so the picker reaches
  // the Routing stop panel as well as the Map's without a third copy of anything.
  assert.equal([...APP.matchAll(/<StopSidebar\b/g)].length, 2, 'Map + Routing both mount the sidebar');
  assert.equal([...APP.matchAll(/<MobileStopDetailDrawer\b/g)].length, 1, 'one phone drawer');
});

test('EVERY note-save path stamps vehicle provenance, and none does it unconditionally', () => {
  // The save is duplicated — Map screen, Routing screen, and since v1.53.0 the Stop lookup
  // screen. Half-fixing the set is the exact bug shape the Routing save's own comment warns
  // about, and this count is the thing that says so: the Stop lookup copy shipped UNGUARDED
  // in draft precisely because it used its own variable names and this number did not move.
  // That is why all three write `...(eligibilityChanged(draft, existing)` verbatim.
  const guarded = [...CODE.matchAll(/\.\.\.\(eligibilityChanged\(draft, existing\)/g)];
  assert.equal(guarded.length, 3, 'every save must stamp, and all of them through eligibilityChanged');
  const stamps = [...CODE.matchAll(/vehicle_eligibility_at: serverTimestamp\(\)/g)];
  assert.equal(stamps.length, 4, 'three guarded note saves + the Routing brush that has always stamped');
  // The shared editor is why this matters at all: it carries the three-state vehicle picker,
  // so ANY screen that mounts it can move a hard capacity block.
  assert.match(APP.slice(APP.indexOf('function StopNotesEditor')), /vehicle_eligibility: o\.value/);
});
