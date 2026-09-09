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

/** App.jsx's own profileDocId, lifted out so the reserved-id claim above is actually checked. */
const profileDocIdOf = (name) => String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'profile';

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
  assert.ok(/safeWriteJSON\(LS_BOTTOM_BAR, \{ \.\.\.barSnapshot\(\), profile: activeProfileName \|\| null, profileAt: activeProfile\?\.updatedAt \?\? null \}\)/.test(src),
    'the bar must be persisted STAMPED with the profile it was written under — without the stamp a profile can never cross a device boundary');
  // Same snapshot for the profile and for the device memory, so the two can never drift apart.
  assert.ok(/const barSnapshot = \(\) => \(\{ view, status: \[\.\.\.statusSel\], nvWindow, nvFrom, nvTo, driverSel, unmappedOnly, stopSort, loadSort \}\)/.test(src));
  // The hold: an untouched default bar must not be written down while a selected profile is
  // still in flight, or the next load reads that memory and never restores the profile again.
  assert.ok(/const pendingProfile = useRef\(barBoot\.pending\)/.test(src));
  assert.ok(/if \(pendingProfile\.current && sameBar\(barSnapshot\(\), BAR_DEFAULTS\)\) return;/.test(src),
    'the pending-profile hold is gone — a cold start would freeze the unfiltered board in permanently');
  const deps = src.match(/safeWriteJSON\(LS_BOTTOM_BAR, \{[^\n]*\}\);\s*\n\s*\}, \[([^\]]+)\]/);
  assert.ok(deps, 'the persist effect has no dependency list');
  for (const d of ['view', 'statusSel', 'nvWindow', 'nvFrom', 'nvTo', 'driverSel', 'unmappedOnly', 'stopSort', 'loadSort'])
    assert.ok(deps[1].includes(d), `${d} changes would not be persisted — it is missing from the effect's deps`);
});

test('a stored bar is read through the ONE carve-out, never straight into setState', () => {
  assert.ok(/const applyBarSettings = \(s, \{ openAfter = true, automatic = false \} = \{\}\) => \{[\s\S]{0,120}const n = reachableBar\(s, viewportW\(\), \{ automatic \}\);/.test(src));
  assert.ok(!/setStatusSel\(new Set\(Array\.isArray\(s\.status\)/.test(src), 'the hand-rolled guards are back — unknown keys can reach the filter again');
});

test('THERE IS ONLY ONE PHONE BREAKPOINT for what a screen may restore', () => {
  // v0.95.0 carved the date window at the app's 768px phone breakpoint while the control
  // itself appears at 640 (`hidden sm:`), so between 640 and 767 the select sat on screen
  // reading "Board (today)" against a profile that said Last 7 days — and picking the
  // profile could not fix it. Two numbers for one rule; there is now one function.
  assert.ok(!/setNvWindow\(gridIsPhone \? '' :/.test(src),
    'the inline gridIsPhone carve-out is back — that is the SECOND breakpoint, and the 640-767 band goes wrong again');
  assert.ok(!/setNvFrom\(gridIsPhone \? '' :/.test(src) && !/setNvTo\(gridIsPhone \? '' :/.test(src));
  assert.ok(/const viewportW = \(\) => readViewportSize\(\)\.w \|\| null;/.test(src),
    'one place must decide how wide the screen is, or a call site will invent its own number');
});

test('an AUTOMATIC restore never spends a vendor call; a deliberate pick may', () => {
  // "NuVizz · Today" is the one window that pulls live. Restoring it on every reload and
  // every Map<->Routing hop turns one deliberate click into unattended repeated spend.
  assert.ok(/applyBarSettings\(activeProfile\.s, \{ openAfter: false, automatic: true \}\)/.test(src),
    'the late/cold restore must be marked automatic, or a restored 0d profile pulls live NuVizz on every mount');
  assert.ok(/applyBarSettings\(p\.s, \{ automatic: false \}\)/.test(src),
    'picking a profile by hand is deliberate and gets the window it asked for');
});

test('saving from a screen that cannot SHOW a setting must not erase it for everyone', () => {
  const uses = src.split('settingsForSave(barSnapshot()').length - 1;
  assert.equal(uses, 2, 'both save paths (new profile AND update-active) must go through settingsForSave');
  assert.ok(/settingsForSave\(barSnapshot\(\), activeProfile\.s, viewportW\(\)\)/.test(src));
});

test('restoring never flings the grid open over the map; picking a profile still does', () => {
  assert.ok(/applyBarSettings\(activeProfile\.s, \{ openAfter: false, automatic: true \}\)/.test(src), 'the restore must not open the panel');
  assert.ok(/applyBarSettings\(p\.s, \{ automatic: false \}\);/.test(src), 'selecting a profile is a deliberate act — it opens the grid');
});

test('a profile arriving — cold start, or selected on another device — is applied once', () => {
  assert.ok(/const lateProfileApplied = useRef\(false\)/.test(src));
  assert.ok(/if \(lateProfileApplied\.current \|\| !activeProfile\) return;/.test(src), 'the late apply must not re-run and yank the bar back mid-plan');
  // Asked with the SAME function the mount used, so the two can never disagree about which wins.
  assert.ok(/const r = restoreBar\(\{\s*\n\s*memory: safeReadJSON\(LS_BOTTOM_BAR, null\),/.test(src),
    'the late apply must re-ask restoreBar, not re-implement the precedence rule');
  assert.ok(/if \(r\.from !== 'profile'\) return;/.test(src), "this device's own bar has to be able to win");
  assert.ok(/if \(sameBar\(barSnapshot\(\), boot\)\) applyBarSettings/.test(src),
    'a bar the dispatcher already touched this session must be left alone');
});

test('the SELECTION is shared, and read once at mount so nobody is yanked mid-plan', () => {
  assert.ok(/const ACTIVE_DOC_ID = '__active';/.test(src), 'the shared selection doc is gone — the profile is device-local again');
  assert.ok(/setDoc\(doc\(db, 'bottom_panel_profiles', ACTIVE_DOC_ID\), \{ activeName: name \?\? null/.test(src),
    'selecting a profile must publish the selection, or it never reaches the iPad');
  assert.ok(/if \(!sharedActiveRead\.current\) \{/.test(src),
    'the shared selection must be read ONCE — live, the other dispatcher\'s pick would yank this grid mid-plan');
  // profileDocId() strips underscores, so no profile a person can name collides with it.
  assert.equal(profileDocIdOf('__active'), 'active');
  assert.ok(/\.filter\(\(p\) => p\.s\)/.test(src), 'the selection doc carries no `s`, and that filter is what keeps it out of the list');
});

test('each profile carries WHEN it was saved, so a device can tell stale from current', () => {
  assert.ok(/updatedAt: \(\(\) => \{ try \{ return d\.data\(\)\?\.updated_at\?\.toMillis\?\.\(\) \?\? null; \} catch \{ return null; \} \}\)\(\)/.test(src),
    'without the save time, "Update Chad to current" on the desktop never reaches the iPad');
});

test('the restore is told how wide the screen is, and a stale driver stays clearable', () => {
  assert.ok(/width: readViewportSize\(\)\.w \|\| null/.test(src),
    'the restore no longer knows the viewport — a phone would get back a window it cannot clear');
  assert.ok(/\{driverSel && !driverOptions\.includes\(driverSel\) && <option value=\{driverSel\}>/.test(src),
    'a restored driver who is not on today\'s board would render a BLANK select that still filters every row out');
});

test('the chip cannot claim a profile the bar has drifted from — nor cry drift that never happened', () => {
  // Measured against what was APPLIED, not against the profile: on a screen too narrow for
  // the window control the profile says "-7d" and the bar can only say "", so comparing to
  // the profile lit the amber dot permanently and told the dispatcher he had changed
  // something he never touched.
  assert.ok(/const profileEdited = !!activeProfile && !sameBar\(barSnapshot\(\), appliedBar\.current\)/.test(src));
  assert.ok(/const appliedBar = useRef\(boot\);/.test(src));
  assert.ok(/appliedBar\.current = n;/.test(src), 'applyBarSettings must record what it applied');
  assert.ok(/\{profileEdited && <span/.test(src), 'the drift marker is gone — the chip is free to lie again');
});

test('the shared selection is read once per SESSION, not once per mount', () => {
  // useBottomPanelProfiles lives inside BottomStopsTable, which unmounts on every
  // Map<->Routing hop and every gear toggle. A per-mount flag re-read the shared doc on each
  // of those, so the other dispatcher's pick would yank this grid mid-plan within one hop.
  assert.ok(/^let sharedActiveReadOnce = false;$/m.test(src),
    'the read-once flag must live at module scope — a useRef resets on every remount');
  assert.ok(!/const sharedActiveRead = useRef\(false\);/.test(src));
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
