// test/pwa-mode.test.mjs
//
// THE PREDICATE THAT DECIDES WHETHER A DOCUMENT LINK IS A TRAP.
//
// Chad: "there is no way to close out the manifest viewer." He was in iOS's native PDF view
// inside the home-screen app — the document had navigated the window, and a home-screen app
// has nothing to navigate back with. The same link in a browser tab is harmless. So the rule
// has to know which one it is running in, and it has to get the UNKNOWN case right: when it
// cannot tell, it must say "browser", because a browser tab can always be closed and a
// stranded dispatcher cannot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isStandaloneApp, isIosHomeScreenApp, canShareFiles, describePwaMode, viewerWayOut } from '../src/lib/pwa-mode.js';

const browserTab = { navigator: {}, matchMedia: (q) => ({ matches: false, media: q }) };

test('AN iOS HOME-SCREEN APP IS STANDALONE — navigator.standalone is the only signal Safari gives', () => {
  // Safari does not reliably answer the display-mode media query in a home-screen app.
  assert.equal(isStandaloneApp({ navigator: { standalone: true }, matchMedia: () => ({ matches: false }) }), true);
  assert.equal(isStandaloneApp({ navigator: { standalone: true } }), true, 'and with no matchMedia at all');
});

test('an Android / desktop PWA is standalone — display-mode is the only signal Chrome gives', () => {
  assert.equal(isStandaloneApp({ navigator: {}, matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' }) }), true);
});

test('a browser tab is NOT standalone', () => {
  assert.equal(isStandaloneApp(browserTab), false);
  // navigator.standalone is `false` (not undefined) in Safari's ordinary tab — still a tab.
  assert.equal(isStandaloneApp({ navigator: { standalone: false }, matchMedia: () => ({ matches: false }) }), false);
});

test('WHEN IT CANNOT TELL, IT SAYS BROWSER — the safe direction', () => {
  // A stranded dispatcher is the expensive mistake; an extra link in a tab costs nothing.
  assert.equal(isStandaloneApp(undefined), false, 'no window (tests, SSR)');
  assert.equal(isStandaloneApp(null), false);
  assert.equal(isStandaloneApp({}), false, 'a window with neither signal');
  assert.equal(isStandaloneApp({ navigator: {}, matchMedia: () => { throw new Error('locked down'); } }), false, 'matchMedia throwing');
  assert.equal(isStandaloneApp({ navigator: {}, matchMedia: () => null }), false, 'matchMedia returning nothing');
  const hostile = { matchMedia: () => ({ matches: false }) };
  Object.defineProperty(hostile, 'navigator', { get() { throw new Error('nope'); } });
  assert.equal(isStandaloneApp(hostile), false, 'a navigator getter that throws');
});

test('the string "true" is not true — a standalone flag must be the boolean', () => {
  assert.equal(isStandaloneApp({ navigator: { standalone: 'true' } }), false);
  assert.equal(isStandaloneApp({ navigator: {}, matchMedia: () => ({ matches: 'true' }) }), false);
});

test('file sharing is a capability probe, asked before any bytes move', () => {
  assert.equal(canShareFiles({ share: () => {}, canShare: () => true }), true);
  assert.equal(canShareFiles({ share: () => {} }), false, 'share without canShare cannot be probed for files');
  assert.equal(canShareFiles({}), false);
  assert.equal(canShareFiles(undefined), false);
});

test('the footer label reads the predicate back, so the device can say which world it is in', () => {
  assert.equal(describePwaMode({ navigator: { standalone: true } }, { share() {}, canShare() {} }), 'iPhone app · can share files');
  assert.equal(describePwaMode({ navigator: { standalone: true } }, {}), 'iPhone app');
  assert.equal(describePwaMode(browserTab, {}), 'browser tab');
  assert.equal(describePwaMode(undefined, undefined), 'browser tab', 'unknowable reads as a browser here too');
});

// ── THE HEADER DECISION IS A RULE, AND THE RULE IS WHAT IS TESTED ────────────
//
// A reviewer showed that a test grepping the JSX for the shape of a ternary passed five
// different dead-end implementations. So the decision lives here, takes real inputs, and is
// asserted on every combination. The viewer only renders what it answers.

test('AN iOS HOME-SCREEN APP IS NEVER HANDED A LINK OUT — Share when it can, nothing when it cannot', () => {
  assert.equal(viewerWayOut({ iosHomeScreen: true, canShareFiles: true }), 'share');
  assert.equal(viewerWayOut({ iosHomeScreen: true, canShareFiles: false }), 'none', 'nothing beats a trap');
});

test('everywhere else keeps the browser hand-off — a tab, an Android or desktop installed app', () => {
  // An Android installed app opens _blank in a Custom Tab with a close control; a desktop
  // installed app opens the browser beside it. Neither replaces the app window.
  assert.equal(viewerWayOut({ iosHomeScreen: false, canShareFiles: true }), 'hatch');
  assert.equal(viewerWayOut({ iosHomeScreen: false, canShareFiles: false }), 'hatch');
  assert.equal(viewerWayOut({}), 'hatch', 'unknowable reads as a browser: an extra link costs nothing');
});

test('isIosHomeScreenApp: Safari sets navigator.standalone; the iPad "desktop" UA needs the touch test', () => {
  assert.equal(isIosHomeScreenApp({ navigator: { standalone: true } }), true);
  assert.equal(isIosHomeScreenApp({ navigator: { standalone: false, userAgent: 'iPhone' } }), false, 'a Safari tab on an iPhone');
  // iPadOS asks for the desktop site: the UA says Macintosh, but a Mac has no touch points.
  assert.equal(isIosHomeScreenApp({ navigator: { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 }, matchMedia: () => ({ matches: true }) }), true);
  assert.equal(isIosHomeScreenApp({ navigator: { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 }, matchMedia: () => ({ matches: true }) }), false, 'a real Mac installed app is not the trap');
  // Android standalone is NOT an iOS home-screen app, whatever display-mode says.
  assert.equal(isIosHomeScreenApp({ navigator: { userAgent: 'Linux; Android 14' }, matchMedia: () => ({ matches: true }) }), false);
  assert.equal(isIosHomeScreenApp(undefined), false);
  assert.equal(isIosHomeScreenApp({ navigator: { standalone: 'true' } }), false, 'the boolean, not the string');
});

test('the footer label names the iPhone app distinctly, since only there does the hatch go', () => {
  assert.equal(describePwaMode({ navigator: { standalone: true } }, {}), 'iPhone app');
  assert.equal(describePwaMode({ navigator: { userAgent: 'Linux; Android 14' }, matchMedia: () => ({ matches: true }) }, {}), 'installed app');
});
