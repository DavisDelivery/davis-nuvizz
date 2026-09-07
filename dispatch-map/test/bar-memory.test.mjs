// test/bar-memory.test.mjs — the bottom grid's bar has to come back the way you left it.
//
// Chad, Sep 7: "My profile is not saving settings like if i have unplanned checked or if i
// have my fliters set to past 7 days." These pin the RULE, not the plumbing: what the bar
// opens as, given what the device remembered and which profile is selected.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  restoreBar, normalizeBar, sameBar, barRestoreCostsCall,
  BAR_DEFAULTS, BAR_STATUS_KEYS, BAR_WINDOWS, BAR_CONTROL_MIN_WIDTH,
} from '../src/lib/bar-memory.js';

const CHAD = { name: 'Chad', s: { status: ['unplanned'], nvWindow: '-7d' } };

test('a reload with a profile selected comes back with Un-Planned ticked and Last 7 days set', () => {
  const { settings, from } = restoreBar({ memory: null, activeName: 'Chad', profiles: [CHAD] });
  assert.equal(from, 'profile');
  assert.deepEqual(settings.status, ['unplanned'], 'the status filter is the whole point of the profile');
  assert.equal(settings.nvWindow, '-7d');
});

test('an UNSAVED tweak survives too — the live bar beats the profile it came from', () => {
  // Ticking Planned on the way to building a route and hopping Map → Routing is the same
  // complaint in a smaller box: the working set must not reset under you.
  const memory = { status: ['unplanned', 'planned'], nvWindow: '-7d', driverSel: 'STEVEN' };
  const { settings, from } = restoreBar({ memory, activeName: 'Chad', profiles: [CHAD] });
  assert.equal(from, 'memory');
  assert.deepEqual(settings.status, ['unplanned', 'planned']);
  assert.equal(settings.driverSel, 'STEVEN');
});

test('no memory and no profile opens the plain board — nothing filtered, nothing pulled', () => {
  const { settings, from } = restoreBar({});
  assert.equal(from, 'defaults');
  assert.deepEqual(settings, normalizeBar(BAR_DEFAULTS));
  assert.equal(settings.nvWindow, '', 'a first-ever load must not fire a date-window pull');
});

test('a selected profile that has not arrived from Firestore yet reports PENDING, not silence', () => {
  // `pending` does two jobs: apply the profile when the snapshot lands, and until then do not
  // write this default bar down as the device's memory — a written default would make the
  // next load read 'memory', never look at the profile again, and freeze the unfiltered board
  // in for good under a chip naming a filter. That is the original bug rebuilt out of its fix.
  const { from, pending } = restoreBar({ memory: null, activeName: 'Chad', profiles: [] });
  assert.equal(from, 'defaults');
  assert.equal(pending, true);
});

test('nothing is pending when no profile is selected, or when the one selected is applied', () => {
  assert.equal(restoreBar({}).pending, false, 'a dispatcher with no profile must not be held');
  assert.equal(restoreBar({ memory: null, activeName: 'Chad', profiles: [CHAD] }).pending, false);
  assert.equal(restoreBar({ memory: { status: [] }, activeName: 'Chad', profiles: [] }).pending, false,
    'a remembered bar answers the question — nothing to wait for');
});

test('a profile saved under another name is not applied, but is still pending', () => {
  const { from, pending } = restoreBar({ memory: null, activeName: 'Nobody', profiles: [CHAD] });
  assert.equal(from, 'defaults');
  assert.equal(pending, true, 'a name we cannot resolve yet may just be a list that has not landed');
});

test('an unknown status key is DROPPED — it would filter every row off with no box to un-tick', () => {
  const s = normalizeBar({ status: ['unplanned', 'delivered_ish', 42, null] });
  assert.deepEqual(s.status, ['unplanned']);
});

test('an unknown date window is dropped back to the board, not left blank in the select', () => {
  assert.equal(normalizeBar({ nvWindow: '-30d' }).nvWindow, '');
  assert.equal(normalizeBar({ nvWindow: '-7d' }).nvWindow, '-7d');
});

test('custom-range endpoints only survive on a custom window, and only whole dates', () => {
  assert.deepEqual(
    [normalizeBar({ nvWindow: 'custom', nvFrom: '2026-09-01', nvTo: '2026-09-07' }).nvFrom,
     normalizeBar({ nvWindow: 'custom', nvFrom: '2026-09-01', nvTo: '2026-09-07' }).nvTo],
    ['2026-09-01', '2026-09-07'],
  );
  assert.equal(normalizeBar({ nvWindow: '-7d', nvFrom: '2026-09-01' }).nvFrom, '', 'a stale endpoint from another window is noise');
  assert.equal(normalizeBar({ nvWindow: 'custom', nvFrom: '2026-09-' }).nvFrom, '', 'a half-typed date must not survive a reload');
});

test('the malformed and the absent never throw — every input here is off localStorage', () => {
  for (const bad of [null, undefined, '', 0, 'nope', [], { status: 'unplanned' }, { stopSort: 'city' }]) {
    const s = normalizeBar(bad);
    assert.equal(s.view, 'stops');
    assert.deepEqual(s.status, []);
    assert.deepEqual(s.stopSort, { key: null, dir: 'asc' });
  }
  const r = restoreBar({ memory: 'garbage', activeName: 5, profiles: 'nope' });
  assert.equal(r.from, 'defaults');
  assert.equal(r.pending, false, 'a non-string profile name is not a profile to wait for');
  assert.equal(restoreBar({ memory: ['not', 'an', 'object'] }).from, 'defaults', 'an array is not a stored bar');
});

test('sameBar compares the status filter as a SET, not as a list', () => {
  assert.ok(sameBar({ status: ['planned', 'unplanned'] }, { status: ['unplanned', 'planned'] }));
  assert.ok(!sameBar({ status: ['planned'] }, { status: [] }));
});

test('sameBar sees a change in every field the chip claims to be showing', () => {
  const base = { view: 'stops', status: ['unplanned'], nvWindow: '-7d', driverSel: '', unmappedOnly: false, stopSort: { key: null, dir: 'asc' } };
  const changed = [
    { ...base, view: 'loads' },
    { ...base, status: [] },
    { ...base, nvWindow: '-14d' },
    { ...base, driverSel: 'STEVEN' },
    { ...base, unmappedOnly: true },
    { ...base, stopSort: { key: 'city', dir: 'asc' } },
    { ...base, stopSort: { key: null, dir: 'desc' } },
    { ...base, loadSort: { key: 'name', dir: 'asc' } },
  ];
  for (const c of changed) assert.ok(!sameBar(base, c), `no drift seen for ${JSON.stringify(c)}`);
  assert.ok(sameBar(base, { ...base }));
});

test('a phone gets back only the filters a phone can SHOW', () => {
  // The window and driver controls are desktop-only (hidden sm:inline-block). Restored onto
  // a 390px screen they would be live filters with nothing to see them by and nothing to
  // clear them with — and unlike the old behaviour, a reload would bring them back.
  const memory = { status: ['unplanned'], nvWindow: '-7d', driverSel: 'STEVEN', view: 'loads', unmappedOnly: true, stopSort: { key: 'city', dir: 'desc' } };
  const phone = restoreBar({ memory, width: 390 }).settings;
  assert.equal(phone.nvWindow, '', 'a date window the phone cannot clear must not come back');
  assert.equal(phone.driverSel, '', 'same for the driver filter');
  assert.deepEqual(phone.status, ['unplanned'], 'the status filter HAS a phone control — it stays');
  assert.equal(phone.view, 'loads');
  assert.equal(phone.unmappedOnly, true);
  assert.deepEqual(phone.stopSort, { key: 'city', dir: 'desc' });
});

test('the cut is at the CONTROL\'s breakpoint (640), not the app\'s phone breakpoint (768)', () => {
  // A 700px tablet renders those controls. Cutting at 768 would strip a window it can see.
  assert.equal(restoreBar({ memory: { nvWindow: '-7d' }, width: 700 }).settings.nvWindow, '-7d');
  assert.equal(restoreBar({ memory: { nvWindow: '-7d' }, width: 639 }).settings.nvWindow, '');
  assert.equal(restoreBar({ memory: { nvWindow: '-7d' }, width: BAR_CONTROL_MIN_WIDTH }).settings.nvWindow, '-7d');
});

test('an unmeasurable width drops NOTHING — never strip a filter on a guess', () => {
  for (const w of [null, undefined, 0, NaN, 'wide']) {
    assert.equal(restoreBar({ memory: { nvWindow: '-7d' }, width: w }).settings.nvWindow, '-7d', `width ${String(w)} stripped the window`);
  }
});

test('a phone restoring a selected PROFILE drops the same unreachable fields', () => {
  const s = restoreBar({ memory: null, activeName: 'Chad', profiles: [CHAD], width: 390 }).settings;
  assert.equal(s.nvWindow, '');
  assert.deepEqual(s.status, ['unplanned']);
});

test('remembering a window is FREE except for the one live-NuVizz option', () => {
  // The cost rule in CLAUDE.md is about scans, but a restore that fires a vendor call on
  // every mount is still a cost nobody asked for. Only the narrow live periods reach NuVizz;
  // '-7d' / '-14d' / '+/-7d' / a custom range are served from our own per-day board docs
  // (LIVE_PERIODS in netlify/functions/nuvizz-stop-explorer.mts).
  assert.equal(barRestoreCostsCall('-7d'), false);
  assert.equal(barRestoreCostsCall('-14d'), false);
  assert.equal(barRestoreCostsCall('+/-7d'), false);
  assert.equal(barRestoreCostsCall('custom'), false);
  assert.equal(barRestoreCostsCall(''), false);
  assert.equal(barRestoreCostsCall('0d'), true, 'NuVizz · Today is a live list pull');
});

test('the key sets are canonical — order-independent in, canonical order out', () => {
  assert.deepEqual(normalizeBar({ status: ['cancelled', 'unplanned'] }).status, ['unplanned', 'cancelled']);
  assert.ok(BAR_WINDOWS.includes(''), 'the board (no pull) must stay a valid window');
  assert.equal(new Set(BAR_STATUS_KEYS).size, BAR_STATUS_KEYS.length);
});
