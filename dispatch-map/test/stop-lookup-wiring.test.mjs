// test/stop-lookup-wiring.test.mjs — the screen is REACHABLE, on both devices.
//
// stop-lookup.test.mjs pins the rules and stop-lookup-endpoint.test.mjs pins the gathering.
// Neither of them would have caught v0.54.50, which is the failure this file exists for:
// Manifest check shipped visible on a laptop and invisible on a phone, because the desktop
// nav row and the phone chip menu are built separately in App.jsx and only one of them was
// edited. Dispatch runs on a phone. A screen added to one navigation and not the other is a
// screen that does not exist.
//
// Source-text assertions, deliberately. The layout guards drive the real bundle in a browser
// and would catch a missing menu item too — but they need a build, a Chromium and ~6 minutes,
// and they run in a different CI job from the one a developer watches. These run in the unit
// suite in milliseconds, and they name the specific line that has to be there.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const FN = readFileSync(new URL('../netlify/functions/stop-lookup.mts', import.meta.url), 'utf8');
const TOML = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');

test('THE DESKTOP MORE MENU CARRIES IT', () => {
  assert.match(APP, /id: 'stoplookup', label: 'Stop lookup'/, 'the overflow menu must list it');
});

test('THE PHONE CHIP MENU CARRIES IT TOO — this is the v0.54.50 failure', () => {
  assert.match(APP, /onSelectMenu\('stoplookup'\)/, 'the phone menu must have its own button');
});

test("the phone menu's KNOWN list names it, or the tap silently opens the Map", () => {
  // onSelectMenu defaults anything unrecognised to 'map'. A screen in the chip menu but not
  // in KNOWN is a button that looks like it works and opens the wrong screen — exactly what
  // happened to Manifest check, and the comment above that list says so.
  const known = /const KNOWN = \[([^\]]+)\]/.exec(APP);
  assert.ok(known, 'the KNOWN list must still exist');
  assert.match(known[1], /'stoplookup'/);
});

test('the tab actually renders the screen', () => {
  assert.match(APP, /tab === 'stoplookup' \? <StopLookupScreen \/>/);
});

test('the heading stays the literal the layout guards navigate by', () => {
  // verify-desktop-layout.mjs, verify-mobile-layout.mjs and verify-tablet-layout.mjs all
  // prove arrival with document.body.innerText.includes('Stop lookup'). Rename the heading
  // and a screen that opens perfectly fails as "could not be opened".
  assert.match(APP, /<h1 className="text-xl font-bold text-slate-900">Stop lookup<\/h1>/);
});

test('ONE RULE decides PRO-vs-name, and the client reads it from the shared module', () => {
  // The box is one box. If the screen classified the query itself, a string the client called
  // a name and the server called a PRO would search the wrong index and answer "nothing" —
  // the confidently-wrong empty answer this whole feature exists to stop producing.
  assert.match(APP, /import \{ classifyQuery \} from '\.\/lib\/stop-lookup\.js'/);
  assert.match(APP, /classifyQuery\(term\)\.kind === 'name' \? `name=/);
  assert.match(FN, /from '\.\.\/\.\.\/src\/lib\/stop-lookup\.js'/);
});

test('THE ENDPOINT PROMISES ZERO NUVIZZ CALLS AND IMPORTS NOTHING THAT COULD SPEND ONE', () => {
  // The screen prints "0 NuVizz calls" on its header. That claim has to be structurally true,
  // not maintained by good intentions — CLAUDE.md: never report an intent as an outcome.
  assert.match(APP, /0 NuVizz calls/, 'the screen makes the claim');
  assert.match(FN, /nuvizzCalls: 0/, 'and the endpoint states it in every answer');
  const imports = [...FN.matchAll(/^import .*?from '([^']+)';$/gm)].map((m) => m[1]);
  for (const i of imports) {
    assert.ok(
      !/nuvizz-(scan|request|list|loads|write|rwb)\.mts$/.test(i),
      `stop-lookup must not import a vendor-calling module: ${i}`,
    );
  }
});

test('the function gets the same timeout as the other Firestore-heavy reads', () => {
  // On Netlify's 10s DEFAULT a slow list is killed and answers an HTML 502 the client cannot
  // parse ("Unexpected token '<'") — the failure the explorer, the write path and the
  // explainer each hit before being given headroom.
  assert.match(TOML, /\[functions\."stop-lookup"\]\s*\n\s*timeout = 26/);
});

test('both layout guards and the tablet guard know the screen exists', () => {
  // A screen not listed in a guard is a screen the guard silently never opens — and a green
  // run then proves nothing about it. v1.42.0 shipped "This device" that way.
  for (const f of ['verify-mobile-layout.mjs', 'verify-desktop-layout.mjs', 'verify-tablet-layout.mjs']) {
    const src = readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /key: 'stoplookup', label: 'Stop lookup'/, `${f} must list the screen`);
  }
});

test('the phone and tablet guards drive the SAME fixture, so they cannot drift apart', () => {
  for (const f of ['verify-mobile-layout.mjs', 'verify-tablet-layout.mjs']) {
    const src = readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /import \{ STOP_LOOKUP_DOSSIER \} from '\.\/lib\/stop-lookup-fixture\.mjs'/, f);
    assert.match(src, /u\.includes\('stop-lookup'\)/, `${f} must stub the endpoint`);
  }
});

test('the version log has a row for the version the footer will show', () => {
  const v = /const APP_VERSION = '([^']+)'/.exec(APP)[1];
  assert.ok(APP.includes(`['${v}', '`), `VERSION_LOG needs a row for v${v}`);
});
