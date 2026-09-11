// test/address-history-screen.test.mjs — the screen exists in BOTH navigations, has TWO
// views, and every override call site actually logs.
//
// CLAUDE.md: "a screen added to one navigation and not the other is a screen that does not
// exist on a phone. It has shipped that way twice." Dispatch runs on a phone, so this is the
// first thing pinned rather than an afterthought.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const LOG = fs.readFileSync(new URL('../src/lib/address-log.js', import.meta.url), 'utf8');

test('IT EXISTS ON A PHONE TOO — both navigations carry Address history', () => {
  // The desktop overflow menu…
  assert.match(APP, /\{ id: 'addrhistory', label: 'Address history'/, 'the desktop More menu carries it');
  // …and the separate phone chip menu, which is a second list built separately.
  assert.match(APP, /onSelectMenu\('addrhistory'\)/, 'the phone chip menu carries it');
  // …and the router renders it.
  assert.match(APP, /tab === 'addrhistory' \? <AddressHistoryScreen \/>/, 'the router renders it');
  // …and a restored tab id survives a reload.
  const known = APP.match(/const KNOWN = \[([^\]]*)\]/);
  assert.ok(known && known[1].includes("'addrhistory'"), 'the tab id is known to the restore list');
});

test('THE SCREEN HAS TWO VIEWS, not one layout with patches', () => {
  assert.match(APP, /function AddressHistoryTable\(/, 'a desktop table');
  assert.match(APP, /function AddressHistoryListMobile\(/, 'and a separate phone list');
  // And it picks between them on the measured viewport, like every other screen here.
  assert.match(APP, /isMobile \? <AddressHistoryListMobile rows=\{rows\} \/> : <AddressHistoryTable rows=\{rows\} \/>/);
});

test('the wide table is the only thing allowed to scroll sideways', () => {
  // A page that scrolls sideways on a phone fails verify-mobile-layout; a table inside its
  // own overflow container is the documented exception.
  assert.match(APP, /function AddressHistoryTable\([\s\S]{0,400}?overflow-x-auto/);
});

test('EVERY override call site logs — all four of them', () => {
  // The override is saved from the Map card, the Routing card, and the modal's Save and
  // Reset. A site that saves without logging is a silent hole in an audit trail, which is
  // worse than no audit trail because it reads as proof nothing happened.
  const saves = APP.match(/address_override: fields/g) || [];
  const logs = APP.match(/logAddressOverride\(\{/g) || [];
  assert.equal(saves.length, 3, 'three address_override writes (Map, Routing, modal Save)');
  assert.equal(logs.length, 4, 'plus the Reset — four logged changes in total');
  assert.match(APP, /source: 'override-reset'/, 'clearing an override is recorded too');
});

test('the BEFORE is captured before the write, never after', () => {
  // After the setDoc lands, the old address is gone from every surface — reading it then
  // would log a change from the value we had just written, i.e. no change at all.
  const save = APP.slice(APP.indexOf('const wasShowing = shownAddress(stop, note);'));
  assert.ok(save.indexOf('const wasShowing') < save.indexOf('setDoc'), 'captured ahead of the write');
});

test('a logging failure can never fail the save', () => {
  assert.match(LOG, /catch \{[\s\S]{0,200}?return false;/, 'the POST swallows its own errors');
  // And the call sites must not await it into the happy path.
  assert.doesNotMatch(APP, /await logAddressOverride/, 'never awaited into a save');
});

test('the shown address is what the CARD shows — override first, then NuVizz', () => {
  // Same precedence the stop card renders with. Reading the raw stop instead would log a
  // change from an address nobody was looking at.
  assert.match(LOG, /const ov = note\?\.address_override \|\| \{\};/);
  assert.match(LOG, /addr1: clean\(ov\.addr1 \|\| stop\?\.addr1\)/);
});

test('the screen says it costs nothing, because every other screen here has to', () => {
  assert.match(APP, /Zero NuVizz calls/);
});

test('formatting rows are hidden by default, and a PRO search shows every one of them', () => {
  // Hiding them is right on a 700-stop window and wrong the moment somebody asks about ONE
  // order: "did we change 007174397" coming back "no address changed" because the only row
  // was a suite moving between lines is the confident-and-wrong answer this replaces.
  assert.match(APP, /Show formatting-only changes/);
  assert.match(APP, /if \(showNoise \|\| searching\) p\.set\('all', '1'\);/);
});

test('the empty state never claims rows are hidden when none are', () => {
  // The inverted version of this said "formatting differences are hidden" on a screen with
  // the toggle already ON and nothing to show — turning "nothing happened" into "something is
  // being kept from me", which is the one thing a log must never do.
  assert.match(APP, /const formattingHidden = !showNoise && !searching && Number\(sum\.formatting \|\| 0\) > 0;/);
  assert.match(APP, /Nothing was recorded at all/);
});

test('a PRO search is not limited to the chosen window', () => {
  // "Did we change 007174397" must not return nothing merely because the date picker is on
  // the last 14 days and the change was in July.
  assert.match(APP, /if \(searching\) \{ p\.set\('stop', stopQ\.trim\(\)\); p\.set\('days', String\(MAX_RANGE_DAYS\)\); \}/);
});
