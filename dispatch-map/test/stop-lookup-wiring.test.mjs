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

test('ONE RULE decides customer-vs-PRO, and the client reads it from the shared module', () => {
  // The box is one box. If the screen classified the query itself, a string the client called
  // a name and the server called a PRO would search the wrong index and answer "nothing" —
  // the confidently-wrong empty answer this whole feature exists to stop producing.
  assert.match(APP, /import \{ classifyQuery \} from '\.\/lib\/stop-lookup\.js'/);
  assert.match(APP, /const isName = classifyQuery\(term\)\.kind === 'name';/);
  assert.match(FN, /from '\.\.\/\.\.\/src\/lib\/stop-lookup\.js'/);
});

test('ONE MODULE resolves the window, on both sides', () => {
  // The screen resolves a selection to decide what to print at the top; the endpoint resolves
  // the same selection to decide which boards to sweep. Two copies of that rule is a header
  // describing one window over rows from another — history-range.js says so in its own header.
  assert.match(APP, /resolveRange\(sel, today, 0\)/, 'the screen resolves through the shared module');
  assert.match(FN, /from '\.\.\/\.\.\/src\/lib\/history-range\.js'/, 'and so does the endpoint');
  assert.match(FN, /selectionFromParams/);
});

test("THE LIT RANGE PILL COMES FROM THE SERVER'S WINDOW, not the client's selection", () => {
  // This screen's ceiling is 14 days, so asking wider gets a clamped window back. Lighting
  // the pill the rep PRESSED would label a fortnight of rows as a month.
  assert.match(APP, /range=\{data\.window \|\| range\}/);
});

test('THE CUSTOMER WINDOW HAS ITS OWN CEILING, because a day here is a whole board', () => {
  // Every other screen using resolveRange reads ONE document per day. This reads a board per
  // day, twice. The shared 60-day cap would be ~84,000 document reads with a customer waiting.
  assert.match(FN, /const CUSTOMER_MAX_DAYS = 14;/);
  // …and the screen must not offer a preset the endpoint will silently clamp.
  const presets = /const CUSTOMER_PRESETS = \[([\s\S]*?)\];/.exec(APP);
  assert.ok(presets, 'the customer view has its own preset row');
  assert.ok(!/days: (30|60)/.test(presets[1]), 'no preset may exceed the endpoint ceiling');
});

test('THE BOARD SWEEP IS MASKED — it must not ship a whole board to find six rows', () => {
  assert.match(FN, /CUSTOMER_STOP_FIELDS/);
  const fields = readFileSync(new URL('../netlify/functions/lib/board-fields.mts', import.meta.url), 'utf8');
  const block = /export const CUSTOMER_STOP_FIELDS = \[([\s\S]*?)\];/.exec(fields);
  assert.ok(block, 'the mask exists');
  assert.ok(!/'raw'/.test(block[1]), 'the whole raw NuVizz object must never be swept');
  assert.ok(!/allComments|stopDetails/.test(block[1]), 'nor the comment and line-item blobs');
  // The address is load-bearing, not furniture: board rows carry no customerMatchKey, so
  // name+addr+city+zip is the only way to reach a customer_notes document at all.
  for (const f of ['businessName', 'addr1', 'city', 'zip', 'driverName', 'deliveredDTTM']) {
    assert.ok(block[1].includes(`'${f}'`), `${f} is needed by the customer view`);
  }
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

test('the phone and tablet guards drive the SAME fixtures, so they cannot drift apart', () => {
  for (const f of ['verify-mobile-layout.mjs', 'verify-tablet-layout.mjs']) {
    const src = readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /import \{ STOP_LOOKUP_DOSSIER \} from '\.\/lib\/stop-lookup-fixture\.mjs'/, f);
    assert.match(src, /import \{ CUSTOMER_VIEW, ORDER_DETAIL \} from '\.\/lib\/customer-view-fixture\.mjs'/, f);
    // EVERY mode, or the guard measures a screen the app never renders. The stub must pick
    // the same way the endpoint branches do — detail, then year, then name, then stop.
    assert.match(src, /u\.includes\('detail='\) \? ORDER_DETAIL/, `${f} must stub the order drawer`);
    assert.match(src, /u\.includes\('year='\) \? CUSTOMER_YEAR/, `${f} must stub the year`);
    assert.match(src, /u\.includes\('name='\) \? CUSTOMER_VIEW : STOP_LOOKUP_DOSSIER/, `${f} must stub the window and the stop`);
  }
});

test('the guards actually OPEN the customer view — it is the default path now', () => {
  for (const f of ['verify-mobile-layout.mjs', 'verify-tablet-layout.mjs']) {
    const src = readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /a customer looked up/, `${f} must probe the customer view`);
  }
});

test('the version log has a row for the version the footer will show', () => {
  const v = /const APP_VERSION = '([^']+)'/.exec(APP)[1];
  assert.ok(APP.includes(`['${v}', '`), `VERSION_LOG needs a row for v${v}`);
});

test('THIS YEAR IS A MODE, NOT A WIDER WINDOW', () => {
  // The whole point. A year cannot be a range this screen resolves — that would be ~510,000
  // document reads and a timeout. The endpoint answers it from the nightly tally instead, and
  // the client must ask for it as `year=`, never as a from/to.
  assert.match(APP, /const \[yearOn, setYearOn\] = useState\(false\)/, 'the year is its own state');
  assert.match(APP, /p\.set\('year', String\(opts\.year\)\)/, 'and its own parameter');
  assert.match(FN, /mode: 'customer-year'/, 'served by its own branch');
  // And that branch must never sweep a day. Pinned structurally: the year returns before the
  // window path's readStops/listSealedStops are ever set up.
  const year = FN.slice(FN.indexOf("url.searchParams.get('year')"), FN.indexOf("if (!stopRaw && nameRaw) {"));
  assert.ok(!/readStops\(|listSealedStops\(/.test(year), 'the year branch reads no board or warehouse day');
});

test('the year names the day sources it SKIPPED, rather than omitting them', () => {
  // A ledger that simply left them out would read as an oversight. The year deliberately does
  // not read them, and says so with the number that makes the decision obvious.
  assert.match(FN, /not read for a year — that is ~510,000 documents/);
});

test('the guards drive all THREE modes off one URL, the way the endpoint does', () => {
  for (const f of ['verify-mobile-layout.mjs', 'verify-tablet-layout.mjs']) {
    const src = readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /import \{ CUSTOMER_YEAR \} from '\.\/lib\/customer-year-fixture\.mjs'/, f);
    assert.match(src, /u\.includes\('year='\) \? CUSTOMER_YEAR/, `${f} must stub the year mode`);
    assert.match(src, /a customer year/, `${f} must probe it`);
  }
});
