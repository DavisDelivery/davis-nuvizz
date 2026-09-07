// test/bar-memory-wiring.test.mjs — the bar's memory must stay WIRED, not just implemented.
//
// The original bug was a wiring bug, not a logic bug: applyBarSettings existed and worked,
// and had exactly ONE caller (picking a profile off the dropdown), so nothing ever put the
// settings back on a reload. A pure-module test would have passed the whole time. These pin
// the one-line connections in App.jsx that a stale-base merge can silently drop — the same
// way the last-stop ✕ vanished in v0.54.19.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BAR_STATUS_KEYS, BAR_WINDOWS } from '../src/lib/bar-memory.js';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');

test('the bar is restored from the device BEFORE any of its state is declared', () => {
  assert.ok(/const \[barBoot\] = useState\(\(\) => restoreBar\(\{/.test(src), 'the grid no longer restores its bar at mount');
  for (const k of ['memory: safeReadJSON\\(LS_BOTTOM_BAR', 'activeName: safeReadJSON\\(LS_BOTTOM_PROFILES_ACTIVE', 'profiles: safeReadJSON\\(LS_BOTTOM_PROFILES'])
    assert.ok(new RegExp(k).test(src), `restoreBar is missing its ${k} input`);
  // Lazy useState, not an effect: an effect paints one frame of unfiltered board first and
  // fires the window pull twice.
  assert.ok(src.indexOf('const [barBoot]') < src.indexOf('const [view, setView]'), 'the restore must be read before the bar state it seeds');
});

test('every setting on the bar is seeded from the restore — one missed line is one lost filter', () => {
  const seeded = [
    ['view', /const \[view, setView\] = useState\(boot\.view\)/],
    ['status', /const \[statusSel, setStatusSel\] = useState\(\(\) => new Set\(boot\.status\)\)/],
    ['window', /const \[nvWindow, setNvWindow\] = useState\(boot\.nvWindow\)/],
    ['range from', /const \[nvFrom, setNvFrom\] = useState\(boot\.nvFrom\)/],
    ['range to', /const \[nvTo, setNvTo\] = useState\(boot\.nvTo\)/],
    ['driver', /const \[driverSel, setDriverSel\] = useState\(boot\.driverSel\)/],
    ['no-location', /const \[unmappedOnly, setUnmappedOnly\] = useState\(boot\.unmappedOnly\)/],
    ['stop sort', /const \[stopSort, setStopSort\] = useState\(boot\.stopSort\)/],
    ['load sort', /const \[loadSort, setLoadSort\] = useState\(boot\.loadSort\)/],
  ];
  for (const [what, re] of seeded) assert.ok(re.test(src), `${what} is no longer restored — it resets on every reload and screen hop`);
});

test('the bar is written back on every change', () => {
  assert.ok(/safeWriteJSON\(LS_BOTTOM_BAR, barSnapshot\(\)\)/.test(src), 'nothing persists the live bar — this is the write that was missing');
  // Same snapshot for the profile and for the device memory, so the two can never drift apart.
  assert.ok(/const barSnapshot = \(\) => \(\{ view, status: \[\.\.\.statusSel\], nvWindow, nvFrom, nvTo, driverSel, unmappedOnly, stopSort, loadSort \}\)/.test(src));
  // The hold: an untouched default bar must not be written down while a selected profile is
  // still in flight, or the next load reads that memory and never restores the profile again.
  assert.ok(/const pendingProfile = useRef\(barBoot\.pending\)/.test(src));
  assert.ok(/if \(pendingProfile\.current && sameBar\(barSnapshot\(\), BAR_DEFAULTS\)\) return;/.test(src),
    'the pending-profile hold is gone — a cold start would freeze the unfiltered board in permanently');
  const deps = src.match(/safeWriteJSON\(LS_BOTTOM_BAR, barSnapshot\(\)\);\s*\n\s*\}, \[([^\]]+)\]/);
  assert.ok(deps, 'the persist effect has no dependency list');
  for (const d of ['view', 'statusSel', 'nvWindow', 'nvFrom', 'nvTo', 'driverSel', 'unmappedOnly', 'stopSort', 'loadSort'])
    assert.ok(deps[1].includes(d), `${d} changes would not be persisted — it is missing from the effect's deps`);
});

test('a stored bar is read through normalizeBar, never straight into setState', () => {
  assert.ok(/const applyBarSettings = \(s, \{ openAfter = true \} = \{\}\) => \{[\s\S]{0,200}const n = normalizeBar\(s\);/.test(src));
  assert.ok(!/setStatusSel\(new Set\(Array\.isArray\(s\.status\)/.test(src), 'the hand-rolled guards are back — unknown keys can reach the filter again');
});

test('restoring never flings the grid open over the map; picking a profile still does', () => {
  assert.ok(/applyBarSettings\(p\.s, \{ openAfter: false \}\)/.test(src), 'the cold-start restore must not open the panel');
  assert.ok(/applyBarSettings\(p\.s\);/.test(src), 'selecting a profile is a deliberate act — it opens the grid');
});

test('a profile arriving late still gets applied — once, and only over an untouched bar', () => {
  assert.ok(/const lateProfileApplied = useRef\(!barBoot\.pending\)/.test(src));
  assert.ok(/if \(lateProfileApplied\.current \|\| !activeProfileName\) return;/.test(src), 'the late apply must not re-run and yank the bar back mid-plan');
  assert.ok(/if \(sameBar\(barSnapshot\(\), BAR_DEFAULTS\)\) applyBarSettings/.test(src), 'a bar the dispatcher already touched must be left alone');
});

test('the restore is told how wide the screen is, and a stale driver stays clearable', () => {
  assert.ok(/width: readViewportSize\(\)\.w \|\| null/.test(src),
    'the restore no longer knows the viewport — a phone would get back a window it cannot clear');
  assert.ok(/\{driverSel && !driverOptions\.includes\(driverSel\) && <option value=\{driverSel\}>/.test(src),
    'a restored driver who is not on today\'s board would render a BLANK select that still filters every row out');
});

test('the chip cannot claim a profile the bar has drifted from', () => {
  assert.ok(/const profileEdited = !!activeProfile && !sameBar\(barSnapshot\(\), activeProfile\.s\)/.test(src));
  assert.ok(/\{profileEdited && <span/.test(src), 'the drift marker is gone — the chip is free to lie again');
});

test('the lib and the grid agree on what a status filter and a window can be', () => {
  // The lib DROPS values it does not recognise, so a bucket added to App.jsx and not to the
  // lib would be silently unsavable — the exact class of half-wiring this file exists for.
  const buckets = [...src.matchAll(/\{ k: '([a-z_]+)', label: '[^']*', match: \[/g)].map((m) => m[1]);
  assert.deepEqual(buckets, BAR_STATUS_KEYS, 'TABLE_STATUS_BUCKETS and BAR_STATUS_KEYS have drifted');
  const select = src.match(/value=\{nvWindow\}[\s\S]*?<\/select>/);
  assert.ok(select, 'the window <select> moved — this pin cannot see it any more');
  const options = [...select[0].matchAll(/<option value="([^"]*)">/g)].map((m) => m[1]);
  assert.deepEqual(options.sort(), [...BAR_WINDOWS].sort(), 'the window options and BAR_WINDOWS have drifted');
});
