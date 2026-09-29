// A tab whose lazily loaded code did not arrive shows a line, a Reload button and what the browser
// said — never a white page (src/components/TabLoadFailure.jsx).
//
// Two tabs fetch their code on the first open: Routing → Shadow (Chad, 2026-09-27, "12 yes") and
// Quote. The app has no error boundary, so a React.lazy import that REJECTS throws into render and
// React unmounts the whole app. Each import's .catch hands React.lazy this screen instead. These
// tests run the real component (compiled with esbuild, see helpers/tab-load-failure.mjs), render
// it, and press its button; the last ones pin that App.jsx wires both tabs to it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { failTab, renderFailed, elements, tabLoadFailureModule } from './helpers/tab-load-failure.mjs';

const FETCH_FAILED = () => new TypeError('Failed to fetch dynamically imported module: https://example.test/assets/quote-generator-Dsimtsa7.js');

test('a Quote tab whose file could not be fetched shows its own line, a Reload button and what the browser said', () => {
  const { mod } = failTab('Quote', FETCH_FAILED());
  assert.equal(typeof mod.default, 'function', 'React.lazy renders `default`, so it must be a component');
  const html = renderFailed(mod);
  assert.match(html, /<p>The Quote tab could not load\. Reload the page to try again\.<\/p>/);
  assert.match(html, /<button class="[^"]*\bmin-h-\[44px\][^"]*">Reload<\/button>/, 'a Reload button that meets the touch floor');
  assert.match(html, /<p class="[^"]*\bbreak-words\b[^"]*">If a reload does not fix it, send Chad a screenshot of this screen\. What the browser said: TypeError: Failed to fetch dynamically imported module: https:\/\/example\.test\/assets\/quote-generator-Dsimtsa7\.js<\/p>/,
    'what the browser said is printed where a screenshot carries it, wrapped so a long URL cannot widen a phone');
});

test('pressing Reload reloads the page — the way back that also works in a home-screen app with no browser bar', () => {
  const { mod } = failTab('Quote', FETCH_FAILED());
  const button = elements(mod.default()).find((el) => el.type === 'button');
  assert.ok(button, 'the screen has a button');
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  let reloads = 0;
  globalThis.window = { location: { reload: () => { reloads += 1; } } };
  try {
    button.props.onClick();
  } finally {
    if (had) globalThis.window = prev; else delete globalThis.window;
  }
  assert.equal(reloads, 1);
});

test('the Shadow tab gets the same screen under its own name — and it cannot pass a layout guard as the Shadow screen', () => {
  const { mod } = failTab('Shadow', new SyntaxError("Unexpected token '?'"));
  const html = renderFailed(mod);
  assert.match(html, /<p>The Shadow tab could not load\. Reload the page to try again\.<\/p>/);
  assert.match(html, /What the browser said: SyntaxError: Unexpected token &#x27;\?&#x27;<\/p>/, 'a code error reads as one — a reload will not fix it');
  // Every layout guard proves it reached the Shadow by "Claude shadow" (the phone and iPad by the
  // heading, the desktop by the page text). A failure screen carrying those words would be
  // measured as the Shadow screen.
  assert.doesNotMatch(html, /claude shadow/i);
});

test('the error is logged first, the error itself, so DevTools has it as well as the screen', () => {
  const err = FETCH_FAILED();
  const { logged } = failTab('Quote', err);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], '[quote] the Quote tab failed to load');
  assert.equal(logged[0][1], err, 'the error object, not a copy of its message');
  assert.equal(failTab('Shadow', err).logged[0][0], '[shadow] the Shadow tab failed to load');
});

test('a rejection with no usable reason still gives a screen that says so — the .catch this runs in must never throw, or the app goes white', () => {
  const trap = new Proxy({}, { get() { throw new Error('getter trap'); } });
  for (const err of [undefined, null, {}, '', trap, Object.create(null)]) {
    let mod;
    assert.doesNotThrow(() => { mod = failTab('Quote', err).mod; });
    assert.match(renderFailed(mod), /What the browser said: no reason given<\/p>/);
  }
});

test('a console that throws cannot take the screen down with it', () => {
  const { tabLoadFailed } = tabLoadFailureModule();
  const orig = console.error;
  let calls = 0;
  console.error = () => { calls += 1; throw new Error('console is broken'); };
  let mod;
  try {
    assert.doesNotThrow(() => { mod = tabLoadFailed('Quote', FETCH_FAILED()); });
  } finally {
    console.error = orig;
  }
  assert.equal(calls, 1, 'the log was attempted');
  assert.match(renderFailed(mod), /<p>The Quote tab could not load\./);
});

test('a missing or malformed tab name still reads as a sentence, never "The undefined tab"', () => {
  for (const tab of [undefined, null, '', '   ', 42, {}]) {
    const html = renderFailed(failTab(tab, FETCH_FAILED()).mod);
    assert.match(html, /<p>This tab could not load\. Reload the page to try again\.<\/p>/, `tab=${String(tab)}`);
    assert.doesNotMatch(html, /undefined|null|\[object Object\]/);
  }
  assert.match(renderFailed(failTab('  Quote ', FETCH_FAILED()).mod), /<p>The Quote tab could not load\./);
});

// ── the wiring in App.jsx ────────────────────────────────────────────────────

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const HEAD = APP.slice(0, APP.indexOf('const VERSION_LOG = ['));

test('wired: the Quote console\'s lazy import hands a rejection to the failure screen — and only a rejection, so a console that loads is untouched', () => {
  // .then(...) BEFORE .catch(...): when the file loads, the console is the default and the catch
  // never runs; when it does not, the catch answers with the failure screen instead of rejecting.
  assert.match(HEAD, /const UlineQuoteConsole = React\.lazy\(\(\) =>\s*import\('@davisdelivery\/quote-generator'\)\.then\(\(m\) => \(\{ default: m\.UlineQuoteConsole \}\)\)\.catch\(\((\w+)\) => tabLoadFailed\('Quote', \1\)\)\);/);
  assert.match(HEAD, /import \{ tabLoadFailed \} from '\.\/components\/TabLoadFailure\.jsx';/);
  // The Quote tab still shows its own loading line while the file arrives.
  assert.match(APP, /<React\.Suspense fallback=\{<div className="[^"]*">Loading quote console…<\/div>\}>\s*<UlineQuoteConsole embedded \/>\s*<\/React\.Suspense>/);
});

test('wired: the Shadow\'s lazy import hands a rejection to the same screen, under the Shadow\'s name', () => {
  assert.match(HEAD, /const ClaudeShadowScreen = React\.lazy\(\(\) => import\('\.\/shadow\/ClaudeShadowScreen\.jsx'\)\.catch\(\((\w+)\) => tabLoadFailed\('Shadow', \1\)\)\);/);
});

test('the tab names on the failure screens are the names on the tabs\' own buttons', () => {
  // A screen saying "The Quotes tab" under a button reading "Quote" sends someone looking for a
  // tab that does not exist.
  assert.match(APP, /<TabBtn label="Quote" /, 'desktop tab bar');
  assert.match(APP, /<Calculator size=\{12\} \/> Quote\n/, 'phone menu');
  assert.match(APP, /btn\('shadow', 'Shadow'\)/, 'Routing\'s Build | Engine | Shadow switch');
});

// A TAB WHOSE CODE DID NOT LOAD IS A SCREEN THAT DID NOT ARRIVE — in CI too. The failure line names
// the tab ("The Quote tab could not load…"), which is all a layout guard's arrival check looked for,
// so a Quote file that throws as it loads used to pass all three guards as a working Quote screen.
// Each guard now reads the line's fixed tail from the one constant the screen prints.
test('every layout guard reads the tab-load failure line as a screen that did not arrive', async () => {
  const { TAB_LOAD_FAILURE_TAIL } = await import('../src/lib/load-failure.js');
  const { readFileSync } = await import('node:fs');
  assert.ok(TAB_LOAD_FAILURE_TAIL.length > 10, 'the tail is a real sentence');
  const screen = readFileSync(new URL('../src/components/TabLoadFailure.jsx', import.meta.url), 'utf8');
  assert.match(screen, /\$\{TAB_LOAD_FAILURE_TAIL\}/, 'the failure screen prints the shared tail');
  for (const f of ['verify-desktop-layout.mjs', 'verify-mobile-layout.mjs', 'verify-tablet-layout.mjs']) {
    const src = readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /import \{ TAB_LOAD_FAILURE_TAIL \} from '\.\.\/src\/lib\/load-failure\.js'/, `${f} imports the tail`);
    assert.match(src, /includes\(tail\)/, `${f} refuses a screen showing the failure line`);
  }
});
