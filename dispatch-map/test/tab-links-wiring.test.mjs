// test/tab-links-wiring.test.mjs — EVERY SCREEN ENTRY, IN BOTH NAVIGATIONS, IS A LINK (v1.117.0).
//
// Chad, 2026-10-04: "can you make it where you can right click things in the app to bring up in new
// tab like if I want to bring up the stops tab or quotes tab in another tab".
//
// The desktop bar, the desktop More menu and the phone menu are built separately, and a screen in one
// navigation and not the other is the v0.54.50 failure this file's siblings keep catching. So each is
// read here: every row that opens a screen renders a ScreenLink naming THAT screen, every action stays
// a button, and the list of linkable screens cannot drift from the screens the Shell renders.
// The behaviour itself — a plain click switching in place, a middle/Ctrl-click opening a new tab that
// starts on the screen — is driven in the real bundle by scripts/verify-new-tab.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LINKABLE_SCREENS } from '../src/lib/tab-links.js';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const slice = (from, to) => APP.slice(APP.indexOf(from), APP.indexOf(to, APP.indexOf(from)));
const SHELL = slice('function Shell() {', '\n// ── FLAG HISTORY');
const PHONE = slice('function MobileAppBar(', 'function MobileFAB(');
const MORE = slice('function MoreMenu(', '\n// ── Gmail, on the Manifest check tab');

test('THE LIST CANNOT DRIFT: every screen the Shell renders, and every name the phone menu knows, is linkable', () => {
  // The phone menu's own allowlist, plus the two screens it reaches by another name or by default.
  const known = /const KNOWN = \[([^\]]+)\]/.exec(SHELL);
  assert.ok(known, 'KNOWN must still exist');
  const knownIds = [...known[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set([...knownIds, 'map', 'diag'])].sort(), [...LINKABLE_SCREENS].sort(),
    'a screen in KNOWN but not in LINKABLE_SCREENS would get a link that opens the Map');
  // Every `tab === '<id>'` the screen switch tests is a screen a link may open.
  const switchLine = SHELL.split('\n').find((l) => l.includes("{tab === 'map' ? <MapScreen"));
  assert.ok(switchLine, 'the screen switch must still exist');
  const rendered = [...switchLine.matchAll(/tab === '([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(rendered.length >= 12, `read ${rendered.length} screens off the switch`);
  for (const id of rendered) assert.ok(LINKABLE_SCREENS.includes(id), `${id} is rendered but not linkable`);
});

test('THE DESKTOP BAR: each screen tab names its own screen; Messages stays a button', () => {
  const bar = SHELL.slice(SHELL.indexOf('<nav className="flex items-center gap-1 text-sm'), SHELL.indexOf('</nav>'));
  const tabs = [...bar.matchAll(/<TabBtn label="([^"]+)"[^\n]*/g)].map((m) => m[0]);
  const want = { Map: 'map', 'Routing (beta)': 'routing', Stops: 'stoplookup', 'New Order': 'neworder', Quote: 'quote' };
  for (const [label, id] of Object.entries(want)) {
    const line = tabs.find((t) => t.startsWith(`<TabBtn label="${label}"`));
    assert.ok(line, `${label} is on the bar`);
    assert.match(line, new RegExp(`screen="${id}"`), `${label} links to ${id}`);
    // …and the same screen its plain click opens, so the new tab and this tab agree.
    assert.match(line, new RegExp(`onClick=\\{\\(\\) => (setTab|openTab)\\('${id}'\\)\\}`), `${label}'s click opens ${id}`);
  }
  const messages = tabs.find((t) => t.startsWith('<TabBtn label="Messages"'));
  assert.ok(messages && !/screen=/.test(messages), 'Messages opens a window over this screen — not a link');
});

test('THE DESKTOP MORE MENU: a screen row is a ScreenLink menuitem, Debug and Sign out stay buttons', () => {
  assert.match(MORE, /return isLinkableScreen\(it\.id\)\s*\? <ScreenLink key=\{it\.id\} screen=\{it\.id\} role="menuitem" onClick=\{pick\}/);
  assert.match(MORE, /: <button key=\{it\.id\} role="menuitem" onClick=\{pick\}/);
  // The ids it is handed: every screen row's id is linkable, and the two actions are not.
  const items = SHELL.slice(SHELL.indexOf('<MoreMenu'), SHELL.indexOf('/>\n', SHELL.indexOf('items={[')));
  const ids = [...items.matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(ids.length >= 10, `read ${ids.length} More rows`);
  for (const id of ids) {
    if (id === 'debug' || id === 'signout') assert.equal(LINKABLE_SCREENS.includes(id), false, id);
    else assert.ok(LINKABLE_SCREENS.includes(id), `More's ${id} row would stay a button`);
  }
  assert.match(SHELL, /\.\.\.\(stopsBar \? \[\] : \[\{ \.\.\.STOPS_MORE_ITEM/, 'Stops under More (narrow window) is a row like the rest');
});

test('THE PHONE MENU: every screen row is a ScreenLink naming its screen, every action a button', () => {
  // Each multi-line row element with its attributes, then the onSelectMenu('<name>') rows among them.
  const blocks = [...PHONE.matchAll(/<(ScreenLink|button)\n((?:[ \t]+[^\n]*\n)+?)[ \t]*>/g)]
    .map((m) => ({ el: m[1], attrs: m[2], name: (/onSelectMenu\('([a-z]+)'\)/.exec(m[2]) || [])[1] }));
  const rows = blocks.filter((r) => r.name);
  const screens = { map: 'map', routing: 'routing', neworder: 'neworder', quote: 'quote', manifest: 'manifest', comms: 'comms', stoplookup: 'stoplookup', labels: 'labels', flaghistory: 'flaghistory', addrhistory: 'addrhistory', performance: 'performance', uatbench: 'uatbench', users: 'users', diagnostics: 'diag' };
  for (const [name, id] of Object.entries(screens)) {
    const row = rows.find((r) => r.name === name);
    assert.ok(row, `the phone menu has a ${name} row`);
    assert.equal(row.el, 'ScreenLink', `${name} is a link`);
    assert.match(row.attrs, new RegExp(`screen="${id}"`), `${name} links to ${id}`);
    assert.match(row.attrs, /role="menuitem"/, `${name} keeps its menuitem role`);
  }
  for (const action of ['messages', 'signout', 'rollback', 'debug']) {
    const row = rows.find((r) => r.name === action);
    assert.ok(row, `the phone menu has a ${action} row`);
    assert.equal(row.el, 'button', `${action} acts on this tab — it stays a button`);
  }
  const fold = blocks.find((b) => b.attrs.includes('setMoreOpen((v) => !v)'));
  assert.ok(fold, 'the More fold is still there');
  assert.equal(fold.el, 'button', 'the More fold is a button, not a link');
});

test('THE SHELL STARTS ON THE LINKED SCREEN — Gmail first, only screens this build offers, then "/" again', () => {
  assert.match(SHELL, /if \(new URLSearchParams\(search\)\.has\('gmail'\)\) return 'manifest';\s*return screenFromSearch\(search, \{ routing: ROUTING_FLAG, bench: BENCH_ON \}\) \|\| 'map';/);
  assert.match(SHELL, /const rest = searchWithoutScreen\(window\.location\.search\);\s*if \(rest == null\) return;\s*window\.history\.replaceState\(window\.history\.state, '', `\$\{window\.location\.pathname\}\$\{rest\}\$\{window\.location\.hash\}`\);/);
  // A tab that starts on Routing starts on Build, like every other way in.
  assert.match(SHELL, /useState\(\(\) => \{\s*if \(tab === 'routing'\) return 'build';/);
  // Account & logins opened by link for someone it is not offered to still bounces to the Map.
  assert.match(SHELL, /if \(tab === 'users' && !accountsOpen\) setTab\('map'\)/);
});

test('A PLAIN CLICK IS STILL THE APP\'S: the link is caught before the browser follows it', () => {
  const link = slice('function ScreenLink(', '\nfunction TabBtn(');
  assert.match(link, /href=\{screenHref\(screen, /);
  assert.match(link, /onClick=\{\(e\) => \{ if \(!isPlainLeftClick\(e\)\) return; e\.preventDefault\(\); open\(e\); \}\}/);
  assert.match(link, /if \(e\.key === ' ' && !e\.repeat\) \{ e\.preventDefault\(\); open\(e\); \}/, 'Space works as it did on the button');
  assert.match(link, /role = 'button'/, 'a bar tab keeps the role it had');
  // Whatever the app does not catch (Safari's "Open Link", a phone's long-press "Open") opens a NEW tab —
  // never a reload of this one, which would throw away unsaved work with nothing to ask first.
  assert.match(link, /target="_blank"\s+rel="noopener"/);
});
