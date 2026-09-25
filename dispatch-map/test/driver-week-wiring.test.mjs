// A driver's week on Stop lookup is WIRED — the panel's third search, the endpoint it reads, the
// guards that measure it — and it keeps the promises the screen makes out loud: a map only
// behind the drop-down, one open at a time; the week never remembered; cost never a number.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const CODE = APP.slice(APP.indexOf('\n];\n', APP.indexOf('const VERSION_LOG = [')));
const SECTION = CODE.slice(CODE.indexOf("// ── A DRIVER'S WEEK OF LOADS (v1.69.0)"), CODE.indexOf("const STOP_LOOKUP_LAST = 'dd_stop_lookup_last';"));
const PANEL = CODE.slice(CODE.indexOf('function StopSearchPanel('), CODE.indexOf('function StopRecentLookups('));
const SCREEN = CODE.slice(CODE.indexOf('function StopLookupScreen() {'), CODE.indexOf('function StopLookupScreen() {') + 60000);

test('it is PART OF STOP LOOKUP — Chad: "i want this to be part of the stops lookup tab"', () => {
  assert.match(PANEL, /<form aria-label="A driver's week of loads"/, 'the panel\'s third form');
  assert.match(PANEL, /\{busy === 'driver' \? 'Reading…' : 'Show loads'\}/);
  assert.match(SCREEN, /apiFetch\(`\/\.netlify\/functions\/driver-loads\?\$\{p\.toString\(\)\}`\)/);
  assert.match(SCREEN, /data\?\.mode === 'driver-week-choose' && \(\s*<DriverWeekChooser/);
  assert.match(SCREEN, /data\?\.mode === 'driver-week' && \(\s*<DriverWeekResults/);
  assert.doesNotMatch(CODE, /tab === 'driverweek'|id: 'driverweek'/, 'not a screen of its own');
});

test('TWO VIEWS — a table from 1280px, cards below it; a phone stacks the map over the stops', () => {
  assert.match(SECTION, /const LOAD_TABLE_MIN = 1280;/);
  assert.match(SCREEN, /wide=\{viewportWidth >= LOAD_TABLE_MIN\}/);
  assert.match(SECTION, /\? <DriverWeekTable /);
  assert.match(SECTION, /: <DriverWeekCards /);
});

test('THE MAP IS BEHIND THE DROP-DOWN — created only in an opened load, one open at a time', () => {
  // The only Google map this section makes is LoadMap's, and LoadMap only renders in LoadDetail,
  // which only renders when its load is the open one.
  assert.equal((SECTION.match(/new google\.maps\.Map\(/g) || []).length, 1);
  assert.match(SECTION, /function LoadMap\(/);
  assert.match(SECTION, /open \? \(\s*<tr key=\{`\$\{l\.key\}:open`\}>/);
  assert.match(SECTION, /\{open && <div className="[^"]*"><LoadDetail /);
  assert.match(SCREEN, /setOpenLoad\(\(cur\) => \(cur === k \? null : k\)\)/, 'opening one load closes the other');
  assert.match(SECTION, /gestureHandling: 'cooperative'/, 'a map inside a scrolling page must not take the scroll');
});

test('the WEEK is not remembered and the name is; a recent driver\'s week reruns that week', () => {
  assert.match(SCREEN, /const \[drvSel, setDrvSel\] = useState\(\{ period: 'today' \}\);/);
  assert.match(SCREEN, /localStorage\.getItem\(STOP_LOOKUP_DRIVER\)/);
  assert.match(SCREEN, /remember\(recentEntry\(\{ kind: 'driver', term: j\.driver\?\.label, key: j\.driver\?\.key, from: j\.week\?\.from, to: j\.week\?\.to \}\)\)/);
  assert.match(SCREEN, /setDrvName\(e\.term\); setDrvSel\(sel\);/);
});

test('COST IS NEVER A NUMBER on this screen, and every blank says why', () => {
  assert.match(SECTION, /<LoadTile label="Cost" value="Not recorded" tone="muted" sub=\{data\.cost\?\.text/);
  assert.doesNotMatch(SECTION, /totals\.cost\b|\.cost\.amount|loadMoney\([^)]*cost/, 'nothing reads a cost figure');
  assert.match(SECTION, /function loadMilesWhy\(/);
  assert.match(SECTION, /if \(miles && !miles\.enabled\) return 'switched off';/);
});

test('the layout guards measure the chooser, the week and an opened load with the BUILT fixture', () => {
  for (const f of ['verify-mobile-layout.mjs', 'verify-tablet-layout.mjs']) {
    const src = readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /import \{ driverWeekAnswer \} from '\.\/lib\/driver-week-fixture\.mjs';/, `${f} must stub the endpoint`);
    assert.match(src, /u\.includes\('driver-loads'\)\) return [RJ]\(driverWeekAnswer\(u\)\)/, `${f} must answer it before the catch-all`);
    for (const probe of ["the week\\\\'s drivers to choose", "a driver\\\\'s week", 'a load opened']) {
      assert.match(src, new RegExp(`name: '${probe}'`), `${f} must probe "${probe}"`);
    }
  }
  const fx = readFileSync(new URL('../scripts/lib/driver-week-fixture.mjs', import.meta.url), 'utf8');
  assert.match(fx, /driverWeek\(rows, key/, 'built by the real load builder, not typed');
});

test('ONE SET OF DATE BUTTONS for the address search and the driver lookup, defaulting to Today', () => {
  const bar = CODE.slice(CODE.indexOf('function PlaceDateBar('), CODE.indexOf('function placeSelOf('));
  assert.match(bar, /PERIODS\.map\(/, 'the buttons are the one shared list');
  const panel = CODE.slice(CODE.indexOf('function StopSearchPanel('), CODE.indexOf('function StopRecentLookups('));
  assert.equal((panel.match(/<PlaceDateBar /g) || []).length, 2, 'both searches draw the same control');
  assert.match(SCREEN, /const \[placeSel, setPlaceSel\] = useState\(\{ period: 'today' \}\);/);
  assert.match(SCREEN, /const \[drvSel, setDrvSel\] = useState\(\{ period: 'today' \}\);/);
});

