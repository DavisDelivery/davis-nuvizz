// THE ROUTING GEAR'S MENU STAYS ON A PHONE'S SCREEN, AND SO DOES THE PHONE'S NAV (v1.71.3).
//
// Chad, v1.71.2, a phone photo of the Routing gear's menu reading "…m data grid / …ispatch
// (assign driver +": "Fix the formatting issue I've asked to be fixed multiple times". Measured
// on that build in a real browser: with a second dispatcher online the presence chip took ~146px
// of the app bar and put the gear at x 149..193, so the 240px menu hung `right-0` ran to x=-47 —
// and the same chip pushed the version chip, the phone's only way to another screen, to x 351..437.
// These pins hold the fix's three parts in place; the phone guard's "a second dispatcher on" probe
// measures the result, and it fails on v1.71.2.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const CODE = APP.slice(APP.indexOf('\n];\n', APP.indexOf('const VERSION_LOG = [')));
const MENU = CODE.slice(CODE.indexOf('function RoutingSettingsMenu('), CODE.indexOf('function stopTractorFriendly('));
const BAR = CODE.slice(CODE.indexOf('function MobileAppBar('), CODE.indexOf('function MobileAppBar(') + 6000);
const CHIP = CODE.slice(CODE.indexOf('function PresenceChip('), CODE.indexOf('function PresenceChip(') + 3000);
const GUARD = readFileSync(new URL('../scripts/verify-mobile-layout.mjs', import.meta.url), 'utf8');

test('the menu\'s placement is MEASURED by dropRight, before paint, on open and on resize', () => {
  assert.match(APP, /import \{ dropSide, dropSideClass, dropRight \} from '\.\/lib\/drop-side\.js';/);
  assert.match(MENU, /const \[menuRight, setMenuRight\] = useState\(0\);/);
  assert.match(MENU, /useLayoutEffect\(\(\) => \{\s*if \(!open\) return undefined;/, 'a layout effect: settled before the first paint');
  assert.match(MENU, /setMenuRight\(dropRight\(ref\.current\?\.getBoundingClientRect\(\), menuRef\.current\?\.offsetWidth, window\.innerWidth\)\)/,
    'the wrapper is measured — it is the box `right` is measured from');
  assert.match(MENU, /window\.addEventListener\('resize', place\);/);
});

test('the menu is no longer pinned right-0: its `right` is the measurement, and it is capped to the screen', () => {
  const div = (MENU.match(/<div ref=\{menuRef\} data-overlay-layer[^\n]*/) || [''])[0];
  assert.ok(div, 'the popover carries menuRef and still declares data-overlay-layer');
  assert.match(div, /style=\{\{ right: menuRight \}\}/);
  assert.doesNotMatch(div, /\bright-0\b/, 'a hard-coded right-0 is the bug this replaced');
  assert.match(div, /max-w-\[calc\(100vw-1rem\)\]/);
  // Everything else about the menu is as it was: width, height cap, drop direction.
  assert.match(div, /absolute z-30 w-60 /);
  assert.match(div, /\$\{dropUp \? 'bottom-full mb-1' : 'mt-1'\}\$\{capHeight \? ' max-h-\[50vh\] overflow-y-auto overscroll-contain' : ''\}/);
});

test('the presence chip GIVES WAY on a phone and the version chip never does', () => {
  // min-w-0 on both the bar's right group and the compact chip: `truncate` cannot truncate a flex
  // item that will not shrink below its own content.
  assert.match(BAR, /<div className="relative flex items-center gap-1\.5 min-w-0">\s*\{\/\* A SLOT FOR THE SCREEN'S OWN CONTROL/);
  assert.match(CHIP, /compact \? 'bg-white\/15 text-white max-w-\[150px\] min-w-0'/);
  // The version chip is how Chad reads which build he is on. Once the group may shrink the
  // browser squeezes it too (measured: 85px down to 44) — shrink-0 keeps it whole.
  assert.match(BAR, /className="relative text-\[12px\] px-2\.5 py-1\.5 min-h-\[44px\] rounded bg-white\/15 text-white\/90 active:bg-white\/25 inline-flex items-center gap-1\.5 shrink-0"/);
  // The desktop chip is untouched: it has its own rule (v1.68.2) in its own bar.
  assert.match(CHIP, /: 'border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 max-w-\[260px\]'\}/);
});

test('the phone guard runs the gear with a SECOND DISPATCHER ON, in the real chip\'s classes', () => {
  assert.match(GUARD, /const PEER_CHIP_CLASS = \(\(\) => \{/);
  assert.match(GUARD, /readFileSync\(new URL\('\.\.\/src\/App\.jsx', import\.meta\.url\), 'utf8'\)/, 'read from the source, not typed');
  assert.match(GUARD, /slot\.after\(b\);/, 'injected where PresenceChip renders');
  assert.match(GUARD, /name: 'App-bar gear open, a second dispatcher on',/);
  assert.equal((GUARD.match(/check: gearMenuOnScreen,/g) || []).length, 2, 'both gear probes assert the menu and the nav chip by name');
  assert.match(GUARD, /if \(probe\.check\) pp\.push\(\.\.\.\(await probe\.check\(page\)/, 'the runner reports a probe\'s own check');
  // The regex the guard reads the classes with must still find them in today's App.jsx.
  const m = CHIP.match(/className=\{`([^`$]*)\$\{compact \? '([^']+)'/);
  assert.ok(m, 'the guard would read no classes and its probe would fail to open');
  assert.match(`${m[1]}${m[2]}`, /min-w-0/);
});
