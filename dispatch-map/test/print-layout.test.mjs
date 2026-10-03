// test/print-layout.test.mjs — WHICH LAYOUT THE PAPER PRINTS IN, AND WHAT THE SCREEN SAYS ABOUT IT.
//
// Chad, 2026-10-03: "i want a way to roll back to old one if needed in diagnostics screen
// somewhere i want to be able to pick which version i'm running."
//
// The rules a wrong answer would hurt: a typo must never switch the company's paper, a device
// that cannot reach the server prints what it LAST KNEW (not the default), a device whose
// storage is blocked still follows the switch, and the Diagnostics banner never shows a layout
// nobody read. The endpoint's half is test/print-layout-endpoint.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PRINT_LAYOUTS, DEFAULT_PRINT_LAYOUT, PRINT_LAYOUT_CACHE_KEY, PRINT_LAYOUT_REFRESH_MS, PRINT_LAYOUT_CHOICES,
  isPrintLayout, normalizePrintLayout, printLayoutWord, printLayoutNow, rememberPrintLayout, printLayoutAnswersKept,
  printLayoutStamp, printLayoutStatus, _resetPrintLayoutForTests,
} from '../src/lib/print-layout.js';
import { liftFromApp, libExports } from './helpers/app-lift.mjs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

/** A localStorage stand-in. `blocked` models a private window: every call throws. */
const storage = (seed = {}, blocked = false) => {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => { if (blocked) throw new Error('blocked'); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (blocked) throw new Error('blocked'); m.set(k, String(v)); },
    peek: (k) => (m.has(k) ? m.get(k) : null),
  };
};

// ── THE VALUE ────────────────────────────────────────────────────────────────

test('the new layout is the default, and only "classic" or "old" mean the old one — a typo never switches the paper', () => {
  assert.equal(DEFAULT_PRINT_LAYOUT, 'new');
  assert.deepEqual(PRINT_LAYOUTS, ['new', 'classic']);
  for (const v of ['classic', 'Classic', ' CLASSIC ', 'old', 'OLD', ' old']) assert.equal(normalizePrintLayout(v), 'classic', JSON.stringify(v));
  // Everything else is the new layout: nothing stored, the word itself, and every near-miss. An
  // off-word is a near-miss here too — the document names a layout, it is not an on/off flag.
  for (const v of [undefined, null, '', '   ', 'new', 'NEW', 'neww', 'clasic', 'classic2', 'older', 'off', '0', 'false', 'no', 0, false, {}, [], 7]) {
    assert.equal(normalizePrintLayout(v), 'new', JSON.stringify(v));
  }
});

test('only the two exact names can be stored by the endpoint', () => {
  assert.equal(isPrintLayout('new'), true);
  assert.equal(isPrintLayout('classic'), true);
  for (const v of ['old', 'Classic', 'NEW', '', null, undefined, 1, true, {}, ['new']]) assert.equal(isPrintLayout(v), false, JSON.stringify(v));
});

test('the screens call the two layouts what Chad calls them: new and old', () => {
  assert.equal(printLayoutWord('new'), 'new');
  assert.equal(printLayoutWord('classic'), 'old');
  assert.equal(printLayoutWord('garbage'), 'new');
  assert.deepEqual(PRINT_LAYOUT_CHOICES.map((c) => [c.layout, c.title]), [['new', 'New layout'], ['classic', 'Old layout']]);
  for (const c of PRINT_LAYOUT_CHOICES) assert.ok(c.does && c.action, `${c.layout} explains itself and names its button`);
});

// ── WHAT A DEVICE PRINTS ─────────────────────────────────────────────────────

test('a device that has never had an answer prints the default', () => {
  _resetPrintLayoutForTests();
  assert.equal(printLayoutNow(storage()), 'new');
  assert.equal(printLayoutNow(null), 'new', 'no storage at all (a test, a server render)');
});

test('SWITCHED BACK, THEN THE SERVER GOES QUIET: the device keeps printing the old layout it last read', () => {
  // The whole point of keeping the answer. A PC that was told "old" at 6am and cannot reach the
  // endpoint at 7am must not drift back to the new layout on its own.
  _resetPrintLayoutForTests();
  const s = storage();
  assert.equal(rememberPrintLayout('classic', s), 'classic');
  assert.equal(s.peek(PRINT_LAYOUT_CACHE_KEY), 'classic');
  assert.equal(printLayoutNow(s), 'classic');
  // A fresh page on the same device (nothing in memory yet) reads it out of storage.
  _resetPrintLayoutForTests();
  assert.equal(printLayoutNow(s), 'classic');
  // And the way forward is kept the same way.
  rememberPrintLayout('new', s);
  assert.equal(printLayoutNow(s), 'new');
});

test('A PRIVATE WINDOW (storage blocked): the device still follows the switch for as long as the page is open', () => {
  _resetPrintLayoutForTests();
  const s = storage({}, true);
  assert.equal(printLayoutNow(s), 'new');
  assert.equal(rememberPrintLayout('classic', s), 'classic', 'a refused write must not throw at the caller');
  assert.equal(printLayoutNow(s), 'classic');
  _resetPrintLayoutForTests();
});

test('TWO TABS ON ONE PC: the tab that did not ask prints what the newest answer said', () => {
  // Tab A read "old" an hour ago and holds it in memory. Tab B has just read "new" and written
  // the shared storage. Tab A must print new — storage is read first.
  _resetPrintLayoutForTests();
  const shared = storage();
  rememberPrintLayout('classic', shared);
  shared.setItem(PRINT_LAYOUT_CACHE_KEY, 'new');
  assert.equal(printLayoutNow(shared), 'new');
  _resetPrintLayoutForTests();
});

test('a kept value that is not a layout prints the default, and what is kept is always a clean name', () => {
  _resetPrintLayoutForTests();
  assert.equal(printLayoutNow(storage({ [PRINT_LAYOUT_CACHE_KEY]: 'garbage' })), 'new');
  const s = storage();
  assert.equal(rememberPrintLayout(' OLD ', s), 'classic');
  assert.equal(s.peek(PRINT_LAYOUT_CACHE_KEY), 'classic');
  assert.equal(rememberPrintLayout(undefined, s), 'new');
  assert.equal(s.peek(PRINT_LAYOUT_CACHE_KEY), 'new');
  _resetPrintLayoutForTests();
});

// ── WHAT THE DIAGNOSTICS BANNER SAYS ─────────────────────────────────────────

test('while it is reading, the banner says so and marks neither layout in use', () => {
  const s = printLayoutStatus({ phase: 'loading' });
  assert.deepEqual([s.tone, s.layout, s.canChange], ['idle', null, false]);
  assert.match(s.headline, /Reading/);
});

test('NOBODY HAS CHOSEN: the new layout is in use and the banner says it is the default', () => {
  const s = printLayoutStatus({ phase: 'ready', answer: { ok: true, layout: 'new', stored: null, persistent: true, set_at: null, set_by: null } });
  assert.deepEqual([s.tone, s.layout, s.canChange], ['good', 'new', true]);
  assert.equal(s.headline, 'In use: the NEW layout.');
  assert.match(s.detail, /default/);
});

test('SWITCHED BACK: the banner says the old layout, who switched and when — on the office clock, never an ISO stamp', () => {
  const s = printLayoutStatus({ phase: 'ready', answer: { ok: true, layout: 'classic', stored: 'classic', persistent: true, set_at: '2026-10-03T18:14:00.000Z', set_by: 'Chad' } });
  assert.deepEqual([s.tone, s.layout, s.canChange], ['warn', 'classic', true]);
  assert.equal(s.headline, 'In use: the OLD layout.');
  assert.equal(s.detail, 'Switched back by Chad on Oct 3, 2026, 2:14 PM.');
  // No login yet: there is no person to name, and the banner does not invent one.
  const anon = printLayoutStatus({ phase: 'ready', answer: { ok: true, layout: 'classic', stored: 'classic', persistent: true, set_at: '2026-10-03T18:14:00.000Z', set_by: null } });
  assert.equal(anon.detail, 'Switched back on Oct 3, 2026, 2:14 PM.');
  // A document with no stamp at all still says which layout is in use.
  assert.equal(printLayoutStatus({ phase: 'ready', answer: { ok: true, layout: 'classic', stored: 'classic', persistent: true } }).detail, 'Switched back to the old layout.');
});

test('BACK ON THE NEW LAYOUT after a switch: the banner says who chose it and when', () => {
  const s = printLayoutStatus({ phase: 'ready', answer: { ok: true, layout: 'new', stored: 'new', persistent: true, set_at: '2026-10-04T10:05:00.000Z', set_by: 'Chad' } });
  assert.equal(s.headline, 'In use: the NEW layout.');
  assert.equal(s.detail, 'Chosen by Chad on Oct 4, 2026, 6:05 AM.');
});

test('THE READ FAILED: the banner says so, names what this device prints meanwhile, and marks NEITHER layout in use', () => {
  // The worst banner this screen could draw is a confident "In use: the NEW layout" over a read
  // that never came back, on the morning somebody opened it to check a rollback.
  const s = printLayoutStatus({ phase: 'error', error: 'the server answered 500', device: 'classic' });
  assert.deepEqual([s.tone, s.layout, s.canChange], ['bad', null, false]);
  assert.equal(s.headline, 'Could not read the setting — the server answered 500.');
  assert.match(s.detail, /this device prints the old layout/);
  assert.match(printLayoutStatus({ phase: 'error', device: 'new' }).detail, /this device prints the new layout/);
  // "ready" with no body, or a body that says it failed, is the same thing.
  assert.equal(printLayoutStatus({ phase: 'ready', answer: null }).layout, null);
  const refused = printLayoutStatus({ phase: 'ready', answer: { ok: false, error: 'getDoc failed: 503' } });
  assert.equal(refused.layout, null);
  assert.match(refused.headline, /503/);
});

test('A HAND-EDITED TYPO in the document: the new layout prints and the banner names the value it found', () => {
  const s = printLayoutStatus({ phase: 'ready', answer: { ok: true, layout: 'new', stored: 'clasic', persistent: true } });
  assert.equal(s.layout, 'new');
  assert.match(s.detail, /“clasic” is not a layout name/);
});

test('A SITE WITH NO DATABASE: the banner says the choice cannot be stored, and the buttons stay off', () => {
  const s = printLayoutStatus({ phase: 'ready', answer: { ok: true, layout: 'new', stored: null, persistent: false, note: 'This site has no database, so the choice cannot be stored here. It prints the new layout.' } });
  assert.deepEqual([s.layout, s.canChange], ['new', false]);
  assert.match(s.detail, /cannot be stored/);
});

test('the stamp reads "Oct 3, 2026, 2:14 PM" in Eastern time, and a missing or unreadable one reads as nothing', () => {
  assert.equal(printLayoutStamp('2026-10-03T18:14:00.000Z'), 'Oct 3, 2026, 2:14 PM');
  assert.equal(printLayoutStamp('2026-01-15T03:30:00.000Z'), 'Jan 14, 2026, 10:30 PM', 'winter, and the day before in UTC terms');
  // Number(null) is 0 and 0 is a valid date — a missing stamp must not print "Dec 31, 1969".
  for (const v of [null, undefined, '', 'yesterday', {}, NaN]) assert.equal(printLayoutStamp(v), '', JSON.stringify(v));
});

// ── THE WIRING ───────────────────────────────────────────────────────────────

test('the sentence on the screen and the refresh the app actually runs say the same number of minutes', () => {
  assert.equal(PRINT_LAYOUT_REFRESH_MS, 5 * 60 * 1000);
  assert.match(APP, /The other devices follow within 5 minutes/);
  assert.match(APP, /setInterval\(ask, PRINT_LAYOUT_REFRESH_MS\)/);
});

test('the app keeps up with the setting: on opening, on coming back to the tab, on a timer, and when a preview opens', () => {
  const hook = APP.slice(APP.indexOf('\nfunction usePrintLayoutSync('), APP.indexOf('\n}', APP.indexOf('\nfunction usePrintLayoutSync(')));
  assert.match(hook, /pullPrintLayout\(\{ force: true \}\)/, 'asks as soon as the app opens');
  assert.match(hook, /addEventListener\('visibilitychange', ask\)/);
  assert.match(hook, /addEventListener\('focus', ask\)/);
  assert.match(hook, /removeEventListener\('visibilitychange', ask\)/, 'and cleans up after itself');
  assert.match(APP, /usePrintLayoutSync\(!tvMode\);/, 'mounted in the shell; the wall display never prints, so it never asks');
  const modal = APP.slice(APP.indexOf('\nfunction PrintDocModal('), APP.indexOf('\nfunction PrintDocModal(') + 900);
  assert.match(modal, /useEffect\(\(\) => \{ pullPrintLayout\(\); \}, \[\]\);/);
});

// ── THE READ THE APP MAKES, run for real: pullPrintLayout lifted out of App.jsx ───────────────
// Its only edges are apiFetch (stood in below) and the lib above (the real one, so what it keeps
// is what printLayoutNow() then answers).
const net = { calls: 0, next: null };
const answerWith = (body, { status = 200 } = {}) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
// The URL and the reader's own clock are named as targets because nothing here can find them by
// running the function: it is async, and its own try/catch swallows the missing-name error.
const { pullPrintLayout, PRINT_LAYOUT_URL } = liftFromApp({
  targets: ['pullPrintLayout', 'PRINT_LAYOUT_URL', 'printLayoutAskedAt'],
  inject: { ...(await libExports(['print-layout.js'])), apiFetch: (url, init) => { net.calls += 1; net.url = url; net.init = init; return net.next(url, init); } },
});
/** A fresh device: nothing kept, and the reader's own 30-second memory cleared by a forced read. */
async function freshDevice() {
  net.next = answerWith({ ok: false });
  await pullPrintLayout({ force: true });
  _resetPrintLayoutForTests();
  net.calls = 0;
}

test('THE COMPANY IS SWITCHED BACK: the next read tells this device, and it prints the old layout from then on', async () => {
  await freshDevice();
  net.next = answerWith({ ok: true, layout: 'classic', stored: 'classic', persistent: true });
  assert.equal(await pullPrintLayout({ force: true }), 'classic');
  assert.equal(PRINT_LAYOUT_URL, '/.netlify/functions/print-layout');
  assert.deepEqual([net.url, net.init], [PRINT_LAYOUT_URL, { cache: 'no-store' }], 'the endpoint, and never out of a cache');
  assert.equal(printLayoutNow(null), 'classic');
  net.next = answerWith({ ok: true, layout: 'new' });
  assert.equal(await pullPrintLayout({ force: true }), 'new');
  assert.equal(printLayoutNow(null), 'new');
  _resetPrintLayoutForTests();
});

test('A READ THAT FAILS, OR NAMES NO LAYOUT, CHANGES NOTHING — the device keeps printing what it last knew', async () => {
  await freshDevice();
  rememberPrintLayout('classic', null);          // the company is on the old layout, and this device knows
  const kept = printLayoutAnswersKept();
  const failures = [
    answerWith({ ok: false, error: 'getDoc failed: 503' }, { status: 500 }),      // the endpoint's own error
    answerWith({ ok: false, error: 'getDoc failed: 503' }),                        // …even with a 200 on it
    answerWith({ ok: true, layout: 'new' }, { status: 502 }),                      // a gateway's error page that happens to parse
    answerWith({ ok: true, stops: [], count: 0 }),                                 // some other body: no layout named
    answerWith({ ok: true, layout: 'clasic' }),                                    // a name that is not a layout
    answerWith({ ok: true, layout: 'old' }),                                       // only the two exact names are kept
    answerWith(null),
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }),   // an HTML page
    async () => { throw new TypeError('Failed to fetch'); },                       // offline
  ];
  for (const f of failures) {
    net.next = f;
    assert.equal(await pullPrintLayout({ force: true }), null);
    assert.equal(printLayoutNow(null), 'classic', 'still the old layout — "could not tell" is never taken for "new"');
  }
  assert.equal(printLayoutAnswersKept(), kept, 'and nothing was written over the answer it had');
  _resetPrintLayoutForTests();
});

test('focus and visibility fire together: the second ask within 30 seconds is not sent; a forced one always is', async () => {
  await freshDevice();
  net.next = answerWith({ ok: true, layout: 'new' });
  await pullPrintLayout({ force: true });
  assert.equal(net.calls, 1);
  assert.equal(await pullPrintLayout(), null);
  assert.equal(await pullPrintLayout(), null);
  assert.equal(net.calls, 1, 'no second request');
  await pullPrintLayout({ force: true });
  assert.equal(net.calls, 2);
  _resetPrintLayoutForTests();
});

test('THE SWITCH PRESSED WHILE A READ WAS OUT: the read’s older answer is dropped, not kept over the switch', async () => {
  // The periodic read leaves at 6:00:00 and the server answers "new". Before that answer arrives
  // the dispatcher presses "Go back to the old layout" and the endpoint reads back "old", which the
  // panel keeps. The late "new" must not overwrite it — the banner would say OLD while this device
  // went on printing NEW, and nothing on the screen would show it.
  await freshDevice();
  let release;
  net.next = () => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true, layout: 'new' }) }); });
  const reading = pullPrintLayout({ force: true });
  rememberPrintLayout('classic', null);          // the panel keeps the POST's read-back
  release();
  assert.equal(await reading, null, 'the older answer is not kept');
  assert.equal(printLayoutNow(null), 'classic');
  // The same read with nothing landing in between IS kept — the guard drops only a stale answer.
  net.next = answerWith({ ok: true, layout: 'new' });
  assert.equal(await pullPrintLayout({ force: true }), 'new');
  _resetPrintLayoutForTests();
});

test('the section is registered in Diagnostics, on both views, and the phone guard opens it', () => {
  // DIAG_SECTIONS drives the desktop rail AND the phone chip row from one array, so one entry
  // covers both. The probe is what makes the phone guard measure it — "This device" shipped
  // without one once and the guard's green run proved nothing about that section.
  assert.match(APP, /\{ id: 'printlayout', label: 'Manifest layout'/);
  assert.match(APP, /printlayout: <ManifestLayoutPanel isPhone=\{isPhone\} \/>/);
  const guard = readFileSync(new URL('../scripts/verify-mobile-layout.mjs', import.meta.url), 'utf8');
  assert.match(guard, /\['Manifest layout', \/manifest layout\/i, \/Printed manifest and delivery ticket\/i\]/);
});

test('the panel changes the layout only through the endpoint, and shows what the endpoint READ BACK', () => {
  const panel = APP.slice(APP.indexOf('\nfunction ManifestLayoutPanel('), APP.indexOf('\n}\n', APP.indexOf('\nfunction ManifestLayoutPanel(')));
  assert.match(panel, /const gate = useRoleGate\('admin'\);/);
  assert.match(panel, /method: 'POST'/);
  // The banner is drawn from the answer; a failed save re-reads rather than leaving the pressed value up.
  assert.match(panel, /printLayoutStatus\(\{ phase, answer, error: readErr, device: printLayoutNow\(\) \}\)/);
  assert.match(panel, /setSaveErr\(String\(e\?\.message \|\| e\)\);\s*await load\(\);/);
  assert.doesNotMatch(panel, /localStorage/, 'the panel never writes the device copy by hand — rememberPrintLayout does, from an answer');
});
