// The Claude shadow tab is ROUTING'S THIRD TAB — Build | Engine | Shadow — on both views, and it is
// no longer a screen of its own. Chad, 2026-09-25: "i want you to move the claude shadow tab to
// here beside the build and engine buttons add a 3rd that is called shadow".
//
// A MOVE, not a copy: a second way in left behind in More would be two doors to one screen, and
// the next person to change one of them would not know the other exists. And BOTH VIEWS
// (CLAUDE.md, "Two views, always"): the phone has no toggle on Build, so it reaches Shadow the way
// it reaches Engine — the Routing app-bar gear, then the row on the Engine and Shadow screens.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const CODE = APP.slice(APP.indexOf('\n];\n', APP.indexOf('const VERSION_LOG = [')));
const between = (from, to) => {
  const a = CODE.indexOf(from);
  assert.ok(a >= 0, `missing: ${from}`);
  const b = CODE.indexOf(to, a + from.length);
  assert.ok(b > a, `missing after ${from}: ${to}`);
  return CODE.slice(a, b);
};
const SUBTABS = between('function RoutingSubTabs(', '\n}\n');
const SECTION = between('function RoutingSection(', '\n}\n');

test('the toggle reads Build | Engine | Shadow, in that order, and Shadow is the Claude shadow screen', () => {
  const order = [...SUBTABS.matchAll(/btn\('(\w+)', '(\w+)'\)/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(order, ['build:Build', 'engine:Engine', 'shadow:Shadow']);
  // Each button after the first carries the divider, so the third is not glued to the second.
  assert.match(SUBTABS, /\$\{id !== 'build' \? 'border-l border-slate-300' : ''\}/);
  assert.match(SECTION, /routingTab === 'shadow'\s*\? <ClaudeShadowScreen isMobile=\{isMobile\} \/>/);
  assert.match(CODE, /<RoutingSection [^>]*isMobile=\{isMobile\}[^>]*\/>/, 'the shell must hand the section the view it is on');
});

test('it is a MOVE: the More menu, the phone menu and the router no longer carry a Claude shadow screen', () => {
  assert.doesNotMatch(CODE, /id: 'claudeshadow'/, 'desktop More menu');
  assert.doesNotMatch(CODE, /onSelectMenu\('claudeshadow'\)/, 'phone chip menu');
  assert.doesNotMatch(CODE, /tab === 'claudeshadow'/, 'the shell router');
  assert.doesNotMatch(CODE, /const KNOWN = \[[^\]]*'claudeshadow'/, 'a name nothing opens any more');
  // The screen is mounted in exactly one place: Routing's third tab.
  assert.equal((CODE.match(/<ClaudeShadowScreen /g) || []).length, 1);
});

test('the phone reaches it from Build through the gear, beside Engine — and the desktop does not get a second door', () => {
  assert.match(SECTION, /onOpenShadow=\{showSubTabs \? \(\) => setRoutingTab\('shadow'\) : null\}/);
  assert.match(CODE, /function RoutingScreen\(\{[^}]*onOpenShadow = null[^}]*\}\)/);
  assert.match(CODE, /\.\.\.\(onOpenShadow \? \[\{ key: 'shadow', label: '⇄ Shadow view \(Claude’s comparison plan\)', onClick: onOpenShadow \}\] : \[\]\)/);
  // The phone row shows on every tab but Build — so on Shadow as well as Engine, and the way
  // back to Build is always on screen.
  assert.match(SECTION, /\{showSubTabs && routingTab !== 'build' && \(/);
});

test('a remembered sub-tab may be Shadow; anything this build does not know opens Build', () => {
  assert.match(CODE, /const v = localStorage\.getItem\('routing\.tab'\); return v === 'engine' \|\| v === 'shadow' \? v : 'build';/);
  // Opening Routing still lands on Build (Chad's standing preference) — Shadow does not change it.
  assert.match(CODE, /useEffect\(\(\) => \{ if \(tab === 'routing'\) setRoutingTab\('build'\); \}, \[tab\]\);/);
});

test('every layout guard still measures it, reached the way a dispatcher now reaches it', () => {
  const mobile = readFileSync(new URL('../scripts/verify-mobile-layout.mjs', import.meta.url), 'utf8');
  assert.match(mobile, /\{ key: 'claudeshadow', label: '[^']+', nav: \/routing\/i, gear: \/shadow view\/i, arrive: 'Claude shadow' \}/);
  for (const f of ['verify-tablet-layout.mjs', 'verify-desktop-layout.mjs']) {
    const src = readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /\{ key: 'claudeshadow', label: '[^']+', nav: \/routing\/i, sub: \/\^shadow\$\/i[^}]*\}/, `${f} must reach Routing → Shadow`);
    assert.doesNotMatch(src, /nav: \/claude shadow\/i/, `${f} still looks for a More-menu entry that is gone`);
  }
  // The heading every guard proves arrival by.
  const screen = readFileSync(new URL('../src/shadow/ClaudeShadowScreen.jsx', import.meta.url), 'utf8');
  assert.match(screen, /<Sparkles size=\{18\} \/> Claude shadow<\/h1>/);
});
