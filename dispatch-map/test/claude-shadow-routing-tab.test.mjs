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
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

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

// ── LAZY (Chad, 2026-09-27, "12 yes" to "Load the Shadow's code only when its tab opens?") ──
// The code before the VERSION_LOG array: the imports, and the lazy declaration beside them.
const HEAD = APP.slice(0, APP.indexOf('const VERSION_LOG = ['));
// The one mount, inside its own Suspense boundary; group 1 is the loading line.
const SHADOW_MOUNT = /routingTab === 'shadow'\s*\? <React\.Suspense fallback=\{<div className="[^"]*">([^<{}]*)<\/div>\}><ClaudeShadowScreen isMobile=\{isMobile\} \/><\/React\.Suspense>/;
// The lazy declaration: a rejected import is handed, error and all, to the shared failure screen
// (src/components/TabLoadFailure.jsx — rendered and pressed in test/tab-load-failure.test.mjs).
const LAZY = /const ClaudeShadowScreen = React\.lazy\(\(\) => import\('\.\/shadow\/ClaudeShadowScreen\.jsx'\)\.catch\(\((\w+)\) => tabLoadFailed\('Shadow', \1\)\)\);/;
const LAZY_FACTORY = "const ClaudeShadowScreen = React.lazy(() => import('./shadow/ClaudeShadowScreen.jsx')";
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

test('the toggle reads Build | Engine | Shadow, in that order, and Shadow is the Claude shadow screen', () => {
  const order = [...SUBTABS.matchAll(/btn\('(\w+)', '(\w+)'\)/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(order, ['build:Build', 'engine:Engine', 'shadow:Shadow']);
  // Each button after the first carries the divider, so the third is not glued to the second.
  assert.match(SUBTABS, /\$\{id !== 'build' \? 'border-l border-slate-300' : ''\}/);
  assert.match(SECTION, SHADOW_MOUNT);
  assert.match(CODE, /<RoutingSection [^>]*isMobile=\{isMobile\}[^>]*\/>/, 'the shell must hand the section the view it is on');
});


test('a dispatcher who never opens Shadow never downloads it — nothing outside src/shadow loads it up front, statically or by an early import()', () => {
  assert.match(HEAD, /const ClaudeShadowScreen = React\.lazy\(\(\) => import\('\.\/shadow\/ClaudeShadowScreen\.jsx'\)/, 'the screen is a React.lazy dynamic import');
  const files = walk(SRC)
    // src/shadow itself, as a DIRECTORY: a file merely named shadow-something.js is still read.
    .filter((f) => /\.(jsx?|mjs|tsx?)$/.test(f) && !relative(SRC, f).startsWith(`shadow${sep}`))
    .map((f) => ({ rel: relative(SRC, f), text: readFileSync(f, 'utf8') }));
  // A single STATIC import of anything under shadow/, from any file the app loads at boot, pulls
  // the whole screen back into the start-up file and the lazy line above does nothing.
  // `shadow/` as a whole path segment, so the server's lib/claude-shadow/ is not mistaken for it.
  const staticImport = /^\s*(?:import|export)\b[^;]*?\bfrom\s*['"](?:[^'"]*\/)?shadow\/[^'"]*['"]|^\s*import\s*['"](?:[^'"]*\/)?shadow\/[^'"]*['"]/m;
  assert.deepEqual(files.filter((f) => staticImport.test(f.text)).map((f) => f.rel), [], 'files statically importing the Shadow screen');
  // An import() is only lazy where it is CALLED. One at the top of a module (a "prefetch"), in an
  // effect at start-up, or on hover fetches the file for a dispatcher who never opens the tab —
  // the 200 KB comes back and nothing else would go red. So there is exactly ONE, and it is the
  // React.lazy factory, which React calls the first time the Shadow tab renders.
  const dynamicImport = /\bimport\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)*['"`](?:[^'"`]*\/)?shadow\/[^'"`]*['"`]/g;
  const sites = files.flatMap((f) => [...f.text.matchAll(dynamicImport)].map((m) => ({ rel: f.rel, at: m.index })));
  assert.equal(sites.length, 1, `exactly one import() of the Shadow's code outside src/shadow, found: ${sites.map((x) => x.rel).join(', ') || 'none'}`);
  assert.equal(sites[0].rel, 'App.jsx');
  assert.equal(sites[0].at, APP.indexOf(LAZY_FACTORY) + LAZY_FACTORY.indexOf('import('), 'the one import() must be the React.lazy factory');
  // Vite's glob import can pull a directory in eagerly; nothing may point one at shadow/.
  assert.deepEqual(files.filter((f) => /import\.meta\.glob\s*\([^)]*(?:^|[\/'"`])shadow\//m.test(f.text)).map((f) => f.rel), [], 'files globbing the Shadow directory');
});

test('opening Shadow shows a plain loading line while its code arrives — and the line cannot pass for the screen', () => {
  const m = SECTION.match(SHADOW_MOUNT);
  assert.ok(m, 'the Shadow mount sits inside a React.Suspense with a loading line');
  const line = m[1].trim();
  assert.match(line, /^Loading\b/);
  // Every layout guard proves it reached the Shadow by "Claude shadow" (the phone and iPad by the
  // heading, the desktop by the page text). A loading line carrying those words would let a guard
  // measure the loading line under the Shadow's name.
  assert.doesNotMatch(line, /claude shadow/i);
});

test('a Shadow tab whose code fails to load shows a line and a Reload button — never a white page — and keeps the reason', () => {
  // With no error boundary anywhere in the app, a lazy import that REJECTS throws into render and
  // React unmounts everything — the Build view and whatever was staged on it. The rejection is
  // caught AT the import, as one expression that cannot rethrow, and handed with the error itself
  // to the shared failure screen: it logs the error first and prints what the browser said under
  // the Reload button, because import() rejects both when the file cannot be fetched AND when it
  // arrives and its code fails — and a reload fixes only the first. What that screen says, logs and
  // does when pressed is run, not read, in test/tab-load-failure.test.mjs.
  assert.match(HEAD, LAZY, 'the dynamic import carries its own .catch, handing the error to tabLoadFailed');
  assert.match(HEAD, /import \{ tabLoadFailed \} from '\.\/components\/TabLoadFailure\.jsx';/);
});

test('the Shadow screen\'s file still exports the default React.lazy renders — a build no longer fails without it', () => {
  // Before the lazy import, a missing default export failed `vite build`. Now the import() resolves
  // with no default, React.lazy throws at render, and — the .catch never runs, nothing rejected —
  // the whole app goes white (measured when the Shadow went lazy: #root emptied, React error #306).
  // Read by esbuild itself, so any spelling of a default export counts and none of a named one does.
  const out = buildSync({
    entryPoints: [fileURLToPath(new URL('../src/shadow/ClaudeShadowScreen.jsx', import.meta.url))],
    bundle: false, write: false, metafile: true, format: 'esm', outdir: 'unused', logLevel: 'silent',
  });
  const [only] = Object.values(out.metafile.outputs);
  assert.ok(only.exports.includes('default'), `src/shadow/ClaudeShadowScreen.jsx exports ${JSON.stringify(only.exports)} — React.lazy needs a default`);
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

test('entering Routing lands on Build from the FIRST render — leaving from Shadow does not remount it on the way back', () => {
  // The effect above runs after a render that already used the old sub-tab; measured on the first
  // cut, Shadow → Map → Routing fired one claude-shadow request nobody saw, on both views.
  assert.match(CODE, /const openTab = \(next\) => \{\s*if \(next === 'routing' && tab !== 'routing'\) setRoutingTab\('build'\);\s*setTab\(next\);\s*\};/);
  // Both ways in go through it: the desktop tab and the phone menu.
  assert.match(CODE, /<TabBtn label="Routing \(beta\)"[^\n]*onClick=\{\(\) => openTab\('routing'\)\} \/>/);
  assert.match(CODE, /openTab\(next === 'diagnostics' \? 'diag' : KNOWN\.includes\(next\) \? next : 'map'\);/);
  assert.doesNotMatch(CODE, /onClick=\{\(\) => setTab\('routing'\)\}/, 'a way into Routing that skips the reset');
});

test('the header gives the presence chip\'s text up before the tab row — never the toggle, never Messages', () => {
  // Measured in scripts/verify-routing-topbar.mjs (1180–1920px, an unread badge on Messages);
  // this pins the two properties that make it hold: the cluster shrinks first, and the toggle's
  // column cannot shrink (an `auto` column would — the toggle is overflow-hidden).
  assert.match(CODE, /<div className="grid grid-flow-col grid-cols-\[minmax\(1\.75rem,auto\)\] auto-cols-max items-center gap-2" style=\{\{ flexShrink: 1e6 \}\}>\s*<PresenceChip presence=\{presence\} \/>\s*\{tab === 'routing' && ROUTING_FLAG && <RoutingSubTabs /);
  const topbar = readFileSync(new URL('../scripts/verify-routing-topbar.mjs', import.meta.url), 'utf8');
  // 1440 is STOPS_BAR_MIN_WIDTH (lib/stops-tab.js, pinned in stops-tab.test.mjs): since v1.104.1 the
  // guard measures the Stops cutoff and the pixel below it, so both sides of it hold Messages.
  assert.match(topbar, /for \(const width of \[1180, 1194, 1366, STOPS_BAR_MIN_WIDTH - 1, STOPS_BAR_MIN_WIDTH, 1920\]\)/);
  assert.match(topbar, /import \{ STOPS_BAR_MIN_WIDTH \} from '\.\.\/src\/lib\/stops-tab\.js';/);
  assert.match(topbar, /the tab row overflows by/);
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

test('every guard that opens the Shadow WAITS for its lazy code, then gives it the settle time it always had — a slow file is neither a missing screen nor a half-drawn one', () => {
  // Since the Shadow's code became its own file fetched on the tap, a guard that glances once
  // after a fixed sleep turns a slow CI runner into a red build — and a guard that waits but then
  // measures at once measures a screen still drawing. Each waits (bounded) for the Shadow's own
  // heading or label, THEN sleeps as it always did, THEN runs the same proof of arrival as before,
  // so no heading still means not measured.
  const read = (f) => readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8');
  // A REAL wait: at least a second (\d{4,} ms). `timeout: 1` would still read as "waits" and wait
  // for nothing.
  const heading = (name) => `await page\\.getByRole\\('heading', \\{ name: ${name} \\}\\)\\.first\\(\\)\\.waitFor\\(\\{ state: 'visible', timeout: \\d{4,} \\}\\)\\.catch\\(\\(\\) => \\{\\}\\);\\s*await page\\.waitForTimeout\\(900\\);`;
  for (const f of ['verify-mobile-layout.mjs', 'verify-tablet-layout.mjs']) {
    const src = read(f);
    assert.match(src, new RegExp(`if \\(screen\\.arrive\\) ${heading('screen\\.arrive')}`), `${f} must wait for the heading before its settle sleep`);
    assert.match(src, /if \(screen\.arrive && !\(await page\.getByRole\('heading', \{ name: screen\.arrive \}\)\.first\(\)\.isVisible\(\)\.catch\(\(\) => false\)\)\) return false;/, `${f} still proves arrival`);
  }
  assert.match(read('verify-desktop-layout.mjs'), /if \(!sub\) return false;\s*(?:\/\/[^\n]*\n\s*)*await page\.waitForFunction\(\(label\) => document\.body\.innerText\.includes\(label\), screen\.label, \{ timeout: \d{4,} \}\)\.catch\(\(\) => \{\}\);\s*await page\.waitForTimeout\(1100\);/, 'verify-desktop-layout.mjs must wait for the label before its settle sleep');
  const map = read('verify-shadow-map.mjs');
  assert.match(map, new RegExp(heading("'Claude shadow'")), 'verify-shadow-map.mjs must wait for the heading before its settle sleep');
  assert.match(map, /return page\.getByRole\('heading', \{ name: 'Claude shadow' \}\)\.first\(\)\.isVisible\(\)\.catch\(\(\) => false\);/, 'verify-shadow-map.mjs still proves arrival');
});
