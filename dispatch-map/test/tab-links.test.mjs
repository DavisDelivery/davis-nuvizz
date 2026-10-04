// test/tab-links.test.mjs — A SCREEN IN THE NAVIGATION OPENS IN A NEW TAB (v1.117.0).
//
// Chad, 2026-10-04: "can you make it where you can right click things in the app to bring up in new
// tab like if I want to bring up the stops tab or quotes tab in another tab".
//
// The pure half (src/lib/tab-links.js), each test named for what it keeps from going wrong:
//   1. THE LINK NAMES THE SCREEN — /?tab=quote, and the Map is plain "/".
//   2. THE NEW TAB STARTS ON IT — and only on a screen this build offers; anything else is the Map.
//   3. THE ADDRESS BAR GOES BACK TO "/" — every other parameter kept.
//   4. A PLAIN CLICK IS THE APP'S, ANY OTHER IS THE BROWSER'S.
//   5. THE SAME APP IN THE NEW TAB — ?write= / ?routing= ride along; the Gmail outcome never does.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LINKABLE_SCREENS, SCREEN_PARAM, CARRIED_PARAMS,
  isLinkableScreen, screenHref, screenFromSearch, searchWithoutScreen, isPlainLeftClick,
} from '../src/lib/tab-links.js';

const ALL = { routing: true, bench: true };
const searchOf = (href) => new URL(href, 'https://dd-dispatch-map.netlify.app').search;

test('THE LINK NAMES THE SCREEN: /?tab=<id>, and the Map is plain "/"', () => {
  assert.equal(SCREEN_PARAM, 'tab');
  assert.equal(screenHref('quote'), '/?tab=quote');
  assert.equal(screenHref('stoplookup'), '/?tab=stoplookup');
  assert.equal(screenHref('diag'), '/?tab=diag');
  assert.equal(screenHref('map'), '/', 'the Map is what "/" already opens');
  assert.equal(screenHref('signout'), '/', 'an action is not a screen: no ?tab=');
  assert.equal(screenHref(undefined), '/');
});

test('EVERY LINK ROUND-TRIPS: the href a row carries is the screen the new tab starts on', () => {
  for (const id of LINKABLE_SCREENS) {
    const back = screenFromSearch(searchOf(screenHref(id)), ALL);
    assert.equal(back, id === 'map' ? null : id, id);   // null is "start on the Map"
  }
});

test('THE NEW TAB STARTS ON IT — only a screen this build offers, anything else is the Map', () => {
  assert.equal(screenFromSearch('?tab=quote'), 'quote');
  assert.equal(screenFromSearch('?tab=stoplookup&write=1'), 'stoplookup');
  for (const junk of ['', '?', '?tab=', '?tab=nope', '?tab=QUOTE', '?tab=%20quote', '?gmail=connected', '?tab=diagnostics']) {
    assert.equal(screenFromSearch(junk), null, `${JSON.stringify(junk)} starts on the Map`);
  }
  // "diagnostics" is the phone menu's NAME for it; the screen id is "diag" — a link carries the id.
  assert.equal(screenFromSearch('?tab=diag'), 'diag');
  // Routing only while ROUTING_FLAG is on: the Shell's switch would fall through to Diagnostics.
  assert.equal(screenFromSearch('?tab=routing', { routing: false }), null);
  assert.equal(screenFromSearch('?tab=routing', { routing: true }), 'routing');
  // The UAT bench only on a UAT host — never on production, whatever the URL says.
  assert.equal(screenFromSearch('?tab=uatbench'), null, 'off by default');
  assert.equal(screenFromSearch('?tab=uatbench', { bench: false }), null);
  assert.equal(screenFromSearch('?tab=uatbench', { bench: true }), 'uatbench');
  // Never throws on what a hand-typed URL can hold.
  assert.equal(screenFromSearch(null), null);
  assert.equal(screenFromSearch(42), null);
});

test('THE ADDRESS BAR GOES BACK TO "/" — every other parameter kept, nothing to do without ?tab=', () => {
  assert.equal(searchWithoutScreen('?tab=quote'), '');
  assert.equal(searchWithoutScreen('?write=1&tab=quote&routing=0'), '?write=1&routing=0');
  assert.equal(searchWithoutScreen('?tab=nope'), '', 'an unknown screen is cleared too — it opened the Map');
  assert.equal(searchWithoutScreen(''), null);
  assert.equal(searchWithoutScreen('?write=1'), null, 'no ?tab=, no rewrite');
  assert.equal(searchWithoutScreen(undefined), null);
});

test('A PLAIN CLICK IS THE APP\'S; Ctrl/⌘, Shift, Alt and any other button are the browser\'s', () => {
  assert.equal(isPlainLeftClick({ button: 0 }), true);
  assert.equal(isPlainLeftClick({ button: 0, ctrlKey: true }), false, 'Ctrl-click: new tab');
  assert.equal(isPlainLeftClick({ button: 0, metaKey: true }), false, '⌘-click: new tab');
  assert.equal(isPlainLeftClick({ button: 0, shiftKey: true }), false, 'Shift-click: new window');
  assert.equal(isPlainLeftClick({ button: 0, altKey: true }), false);
  assert.equal(isPlainLeftClick({ button: 1 }), false, 'middle button');
  assert.equal(isPlainLeftClick({ button: 2 }), false, 'right button');
  assert.equal(isPlainLeftClick(null), false);
});

test('THE SAME APP IN THE NEW TAB: ?write= and ?routing= ride along, one-shot parameters never do', () => {
  assert.deepEqual([...CARRIED_PARAMS], ['routing', 'write']);
  assert.equal(screenHref('quote', '?write=1'), '/?write=1&tab=quote');
  assert.equal(screenHref('map', '?write=1&routing=0'), '/?routing=0&write=1');
  // The Gmail return and a password-reset token are read once and must not be copied anywhere.
  assert.equal(screenHref('quote', '?gmail=connected&account=a%40b.com&reason=x'), '/?tab=quote');
  assert.equal(screenHref('quote', '?u=dispatcher&t=SECRET'), '/?tab=quote');
  // The current page's own ?tab= is replaced, never doubled.
  assert.equal(screenHref('quote', '?tab=stoplookup'), '/?tab=quote');
  assert.equal(screenHref('quote', '?write='), '/?tab=quote', 'an empty switch is not carried');
});

test('the list is frozen and holds only the Shell\'s screen ids', () => {
  assert.ok(Object.isFrozen(LINKABLE_SCREENS));
  assert.ok(Object.isFrozen(CARRIED_PARAMS));
  assert.equal(new Set(LINKABLE_SCREENS).size, LINKABLE_SCREENS.length, 'no duplicates');
  for (const id of LINKABLE_SCREENS) assert.match(id, /^[a-z]+$/);
  assert.equal(isLinkableScreen('debug'), false);
  assert.equal(isLinkableScreen('messages'), false, 'Messages is a window over the screen, not a screen');
  assert.equal(isLinkableScreen('rollback'), false);
  assert.equal(isLinkableScreen('quote'), true);
});
