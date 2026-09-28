// test/bar-profile-crosses-devices.test.mjs
//
// A GRID PROFILE SELECTED OR UPDATED ON ANOTHER DEVICE NEVER APPLIED (audit 2026-09-27,
// client-map-ui-libs-1).
//
// lib/bar-memory.js gets the rule right: a bar this device remembers loses to the selected
// profile when it was written under a different profile, or before the profile's last save.
// The wiring in BottomStopsTable defeated it. When the Firestore snapshot landed with the new
// selection or the new save time, two effects ran in declaration order in the same commit: the
// persist effect FIRST re-wrote this device's memory stamped with the new profile and time, and
// only THEN did the late-restore effect read that memory back — so the profile never beat it.
// The chip read "Chad" while the grid stayed on the whole board, and the re-stamped memory
// meant it never applied on any later load either.
//
// What happens now: the late-restore check runs before the persist effect in the same commit,
// so it compares the profile against the memory as it was BEFORE the snapshot, and the profile
// applies.
//
// This RUNS the real persist and late-restore effects (and applyBarSettings) out of App.jsx
// verbatim, inside a stand-in grid component, on a minimal hooks runtime that runs effects in
// declaration order after each render — which is the property the bug lives in. No DOM, no
// Firestore: the profile snapshot is the test changing two props in one render, exactly as
// useBottomPanelProfiles' single onSnapshot callback does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { restoreBar, reachableBar, sameBar, normalizeBar, BAR_DEFAULTS } from '../src/lib/bar-memory.js';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const start = APP.indexOf('  const barSnapshot = () => ({ view, status: [...statusSel]');
const end = APP.indexOf('  const profileEdited = ');
assert.ok(start > 0 && end > start, 'the bar persist / late-restore block was not found in App.jsx');
const BLOCK = APP.slice(start, end);

const LS_BOTTOM_BAR = 'dispatchMap.bottomPanelBar';
const LS_BOTTOM_PROFILES = 'dispatchMap.bottomPanelProfiles';
const LS_BOTTOM_PROFILES_ACTIVE = 'dispatchMap.bottomPanelProfiles.active';

/** A hooks runtime that keeps React's one property this bug depends on: after a render, the
 *  effects whose deps changed run in DECLARATION order, and state set inside them causes
 *  another render. */
function runtime() {
  const slots = [];
  let i = 0;
  let dirty = false;
  let pending = [];
  const depsChanged = (a, b) => !a || !b || a.length !== b.length || a.some((x, j) => !Object.is(x, b[j]));
  const hooks = {
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = { v: typeof init === 'function' ? init() : init };
      const s = slots[k];
      return [s.v, (v) => { const n = typeof v === 'function' ? v(s.v) : v; if (!Object.is(n, s.v)) { s.v = n; dirty = true; } }];
    },
    useRef(v) { const k = i++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
    useEffect(fn, deps) {
      const k = i++;
      const prev = slots[k];
      if (!prev || depsChanged(prev.deps, deps)) pending.push(() => { slots[k] = { deps }; fn(); });
    },
  };
  const render = (component, props) => {
    let out;
    for (let pass = 0; pass < 20; pass++) {
      i = 0; dirty = false; pending = [];
      out = component(hooks, props);
      for (const run of pending) run();
      if (!dirty) return out;
    }
    throw new Error('render loop did not settle');
  };
  return { render };
}

function makeGrid(storage) {
  const safeReadJSON = (k, d) => { try { const v = storage.get(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const safeWriteJSON = (k, v) => { storage.set(k, JSON.stringify(v)); };
  const readViewportSize = () => ({ w: 1440, h: 900 });
  const body = new Function(
    'hooks', 'props', 'restoreBar', 'reachableBar', 'sameBar', 'BAR_DEFAULTS', 'safeReadJSON', 'safeWriteJSON', 'readViewportSize',
    'LS_BOTTOM_BAR', 'LS_BOTTOM_PROFILES', 'LS_BOTTOM_PROFILES_ACTIVE',
    `
    const { useState, useRef, useEffect } = hooks;
    const { profileList, activeProfileName } = props;
    // The mount restore and the bar seeds, as App.jsx has them (pinned by bar-memory-wiring).
    const [barBoot] = useState(() => restoreBar({
      memory: safeReadJSON(LS_BOTTOM_BAR, null),
      activeName: safeReadJSON(LS_BOTTOM_PROFILES_ACTIVE, null),
      profiles: safeReadJSON(LS_BOTTOM_PROFILES, null)?.list || [],
      width: readViewportSize().w || null,
    }));
    const boot = barBoot.settings;
    const viewportW = () => readViewportSize().w || null;
    const appliedBar = useRef(boot);
    const [view, setView] = useState(boot.view);
    const [statusSel, setStatusSel] = useState(() => new Set(boot.status));
    const [nvWindow, setNvWindow] = useState(boot.nvWindow);
    const [nvFrom, setNvFrom] = useState(boot.nvFrom);
    const [nvTo, setNvTo] = useState(boot.nvTo);
    const [unmappedOnly, setUnmappedOnly] = useState(boot.unmappedOnly);
    const [stopSort, setStopSort] = useState(boot.stopSort);
    const [loadSort, setLoadSort] = useState(boot.loadSort);
    const setOpen = () => {};
    // ── verbatim from App.jsx ──
    ${BLOCK}
    // ──
    return { chip: activeProfileName || null, status: [...statusSel], nvWindow, setStatus: (a) => setStatusSel(new Set(a)) };
    `,
  );
  return (hooks, props) => body(hooks, props, restoreBar, reachableBar, sameBar, BAR_DEFAULTS, safeReadJSON, safeWriteJSON, readViewportSize,
    LS_BOTTOM_BAR, LS_BOTTOM_PROFILES, LS_BOTTOM_PROFILES_ACTIVE);
}

const WORKING_SET = { view: 'stops', status: ['unplanned'], nvWindow: '-7d' };
const savedProfile = (updatedAt, s = WORKING_SET) => ({ name: 'Chad', s, updatedAt });
const wholeBoard = (stamp) => ({ ...normalizeBar(null), ...stamp });

function device(seed) {
  const storage = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return { storage, grid: makeGrid(storage), rt: runtime() };
}
const memoryOf = (d) => JSON.parse(d.storage.get(LS_BOTTOM_BAR));

test('control: a profile selected on this device and still loading applies itself when it lands', () => {
  const d = device({ [LS_BOTTOM_PROFILES_ACTIVE]: 'Chad' });
  const mount = d.rt.render(d.grid, { profileList: [], activeProfileName: 'Chad' });
  assert.deepEqual([mount.status, mount.nvWindow], [[], '']);
  const after = d.rt.render(d.grid, { profileList: [savedProfile(1000)], activeProfileName: 'Chad' });
  assert.deepEqual([after.status, after.nvWindow], [['unplanned'], '-7d']);
});

test('Chad selects his profile on the desktop, then opens the iPad: the iPad grid applies it', () => {
  // The iPad has used the grid before (whole board, no profile) and has Chad's profile in its
  // cached list, but not selected.
  const d = device({
    [LS_BOTTOM_BAR]: wholeBoard({ profile: null, profileAt: null }),
    [LS_BOTTOM_PROFILES]: { list: [savedProfile(1000)] },
  });
  const mount = d.rt.render(d.grid, { profileList: [savedProfile(1000)], activeProfileName: null });
  assert.deepEqual([mount.chip, mount.status, mount.nvWindow], [null, [], '']);
  // The snapshot: the shared selection says Chad.
  const after = d.rt.render(d.grid, { profileList: [savedProfile(1000)], activeProfileName: 'Chad' });
  assert.equal(after.chip, 'Chad');
  assert.deepEqual([after.status, after.nvWindow], [['unplanned'], '-7d'], 'the chip says Chad, so the grid must be on Chad\'s working set');
  const mem = memoryOf(d);
  assert.deepEqual([mem.status, mem.nvWindow, mem.profile, mem.profileAt], [['unplanned'], '-7d', 'Chad', 1000], 'and the device remembers Chad\'s bar under Chad\'s stamp');
});

test('Chad presses "Update Chad to current" on the desktop, then opens the iPad: the iPad grid takes the new version', () => {
  const OLD = { view: 'stops', status: ['planned'], nvWindow: '' };
  const d = device({
    [LS_BOTTOM_BAR]: wholeBoard({ ...normalizeBar(OLD), profile: 'Chad', profileAt: 1000 }),
    [LS_BOTTOM_PROFILES]: { list: [savedProfile(1000, OLD)] },
    [LS_BOTTOM_PROFILES_ACTIVE]: 'Chad',
  });
  const mount = d.rt.render(d.grid, { profileList: [savedProfile(1000, OLD)], activeProfileName: 'Chad' });
  assert.deepEqual([mount.status, mount.nvWindow], [['planned'], '']);
  const after = d.rt.render(d.grid, { profileList: [savedProfile(2000)], activeProfileName: 'Chad' });
  assert.deepEqual([after.status, after.nvWindow], [['unplanned'], '-7d'], 'the newer save on the desktop is the one he means');
  assert.equal(memoryOf(d).profileAt, 2000);
});

test('a dispatcher\'s own unsaved tweak still survives a snapshot that brings nothing new', () => {
  const d = device({
    [LS_BOTTOM_BAR]: wholeBoard({ ...normalizeBar({ status: ['completed'] }), profile: 'Chad', profileAt: 1000 }),
    [LS_BOTTOM_PROFILES]: { list: [savedProfile(1000)] },
    [LS_BOTTOM_PROFILES_ACTIVE]: 'Chad',
  });
  d.rt.render(d.grid, { profileList: [savedProfile(1000)], activeProfileName: 'Chad' });
  const after = d.rt.render(d.grid, { profileList: [savedProfile(1000)], activeProfileName: 'Chad' });
  assert.deepEqual(after.status, ['completed'], 'same profile, same save time: this device\'s bar wins');
});

test('a dispatcher who started filtering before the snapshot landed keeps what they set', () => {
  const d = device({
    [LS_BOTTOM_BAR]: wholeBoard({ profile: null, profileAt: null }),
    [LS_BOTTOM_PROFILES]: { list: [savedProfile(1000)] },
  });
  const mount = d.rt.render(d.grid, { profileList: [savedProfile(1000)], activeProfileName: null });
  d.rt.render(d.grid, { profileList: [savedProfile(1000)], activeProfileName: null });
  mount.setStatus(['cancelled']);
  d.rt.render(d.grid, { profileList: [savedProfile(1000)], activeProfileName: null });
  const after = d.rt.render(d.grid, { profileList: [savedProfile(1000)], activeProfileName: 'Chad' });
  assert.deepEqual(after.status, ['cancelled']);
});
