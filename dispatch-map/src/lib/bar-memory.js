// lib/bar-memory.js — what the bottom grid's bar remembers between mounts.
//
// THE BUG THIS EXISTS FOR (Chad, Sep 7): "My profile is not saving settings like if i
// have unplanned checked or if i have my filters set to past 7 days." The profile LIST
// saved fine and the ACTIVE name saved fine — the chip read “Chad” on every load — but
// nothing ever put the profile's settings back on the bar. `applyBarSettings` had exactly
// one caller: picking a profile off the dropdown. So a reload, and every hop between Map
// and Routing (three separate <BottomStopsTable> mounts, one per screen/layout, each with
// its own useState), dropped the dispatcher back to the whole board with no status filter
// — while the chip still said his profile was on. The screen and the grid disagreed about
// what was filtered, which is the worst version of this failure: he isn't told his working
// set is gone, he just quietly starts reading 3,582 rows instead of the 560 he was working.
//
// So the bar now remembers itself on the device, and an active profile is the fallback the
// first time (or on a device that has a profile selected but has never persisted a bar).
// Live memory over profile on purpose: an unsaved tweak — Un-Planned ticked on the way to
// building a route — is the dispatcher's CURRENT working set, and losing it on a screen hop
// is the same complaint in a smaller box.
//
// Pure + total: every input here comes off localStorage or Firestore and can be absent,
// stale, or malformed. Nothing throws, everything falls back to the default bar.

/** Status-filter bucket keys, mirroring TABLE_STATUS_BUCKETS in App.jsx (pinned by test). */
export const BAR_STATUS_KEYS = ['unplanned', 'planned', 'in_transit', 'completed', 'cancelled'];

/** Date-window values the grid's window <select> offers ('' = today's board, no pull). */
export const BAR_WINDOWS = ['', '0d', '+/-7d', '-7d', '-14d', 'custom'];

const DEFAULT_SORT = { key: null, dir: 'asc' };

/**
 * The width below which the grid's date-window and driver controls are not rendered at all
 * (they carry Tailwind's `hidden sm:inline-block` — 640px, NOT the app's 768px phone
 * breakpoint; the band between the two shows them and must keep them).
 */
export const BAR_CONTROL_MIN_WIDTH = 640;

/**
 * The settings whose ONLY control is desktop-only. Restoring one onto a phone would leave a
 * live filter with nothing on screen to see it by and nothing to clear it with — the
 * invisible-filter trap that blanked this grid once already (v0.45.6), except sticky: a
 * reload would bring it back. So a narrow mount restores the board and the filters it can
 * actually show. Picking a profile by hand still applies everything, on any screen: that is
 * a deliberate act with a visible result, not something that happened to you on load.
 */
export const BAR_DESKTOP_ONLY_FIELDS = ['nvWindow', 'nvFrom', 'nvTo', 'driverSel'];

export const BAR_DEFAULTS = Object.freeze({
  view: 'stops',
  status: [],
  nvWindow: '',
  nvFrom: '',
  nvTo: '',
  driverSel: '',
  unmappedOnly: false,
  stopSort: DEFAULT_SORT,
  loadSort: DEFAULT_SORT,
});

const isYmd = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

function normSort(raw) {
  if (!raw || typeof raw !== 'object' || !('key' in raw)) return { ...DEFAULT_SORT };
  const key = typeof raw.key === 'string' && raw.key ? raw.key : null;
  return { key, dir: raw.dir === 'desc' ? 'desc' : 'asc' };
}

/**
 * Coerce anything (a stored snapshot, a profile's `s`, undefined, a half-written object)
 * into a bar-settings object that is safe to hand straight to setState.
 *
 * Unknown values are DROPPED, not kept: a window value this build doesn't offer would sit
 * in the <select> as a blank option and pull nothing, and a status key no bucket matches
 * would filter every row off the grid with no checkbox to un-tick it.
 */
export function normalizeBar(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const status = Array.isArray(s.status)
    ? BAR_STATUS_KEYS.filter((k) => s.status.includes(k))   // known keys only, canonical order
    : [];
  const nvWindow = BAR_WINDOWS.includes(s.nvWindow) ? s.nvWindow : '';
  return {
    view: s.view === 'loads' ? 'loads' : 'stops',
    status,
    nvWindow,
    // Endpoints only mean anything to a custom range, and a half-typed date ('2026-09-')
    // must not survive a reload — the pull refuses to fire until both are valid anyway.
    nvFrom: nvWindow === 'custom' && isYmd(s.nvFrom) ? s.nvFrom : '',
    nvTo: nvWindow === 'custom' && isYmd(s.nvTo) ? s.nvTo : '',
    driverSel: typeof s.driverSel === 'string' ? s.driverSel : '',
    unmappedOnly: !!s.unmappedOnly,
    stopSort: normSort(s.stopSort),
    loadSort: normSort(s.loadSort),
  };
}

/** True when two bar snapshots describe the same bar. Status compares as a SET. */
export function sameBar(a, b) {
  const x = normalizeBar(a); const y = normalizeBar(b);
  return x.view === y.view
    && x.status.join(',') === y.status.join(',')     // normalizeBar canonicalises the order
    && x.nvWindow === y.nvWindow && x.nvFrom === y.nvFrom && x.nvTo === y.nvTo
    && x.driverSel === y.driverSel && x.unmappedOnly === y.unmappedOnly
    && x.stopSort.key === y.stopSort.key && x.stopSort.dir === y.stopSort.dir
    && x.loadSort.key === y.loadSort.key && x.loadSort.dir === y.loadSort.dir;
}

/**
 * What the bar should open as.
 *
 *   memory     — the last bar this device was using (localStorage), or null/absent
 *   activeName — the profile name this device has selected, or null
 *   profiles   — the profile list as known right now (Firestore cache or live)
 *
 * Returns { settings, from, pending }.
 *
 * `pending` is the one that matters and the one that is easy to miss: a profile is SELECTED
 * but is not in the list we can see yet (Firestore still in flight). Two things hang off it —
 * apply the profile when it lands, and until then do NOT write this untouched default bar
 * down as the device's memory. Writing it would make the next load read 'memory', never look
 * at the profile again, and freeze the defaults in permanently under a chip naming a filter.
 * That is the original bug, rebuilt out of its own fix.
 */
export function restoreBar({ memory = null, activeName = null, profiles = [], width = null } = {}) {
  const name = typeof activeName === 'string' && activeName ? activeName : null;
  // A width we were not given is not a narrow one — never drop a filter on a guess. And
  // ZERO is not a narrow screen, it is the absence of one (no window to measure, a hidden
  // document): Number.isFinite(0) is true and 0 < 640, so the naive check silently strips
  // the dispatcher's window on a headless or pre-layout mount. Same shape as the Number(null)
  // bug that mailed a customer a midnight deadline for a stop with no deadline at all.
  const narrow = Number.isFinite(width) && width > 0 && width < BAR_CONTROL_MIN_WIDTH;
  const reachable = (s) => {
    if (!narrow) return s;
    const out = { ...s };
    for (const f of BAR_DESKTOP_ONLY_FIELDS) out[f] = BAR_DEFAULTS[f];
    return out;
  };
  if (memory && typeof memory === 'object' && !Array.isArray(memory)) {
    return { settings: reachable(normalizeBar(memory)), from: 'memory', pending: false };
  }
  const list = Array.isArray(profiles) ? profiles : [];
  const p = name ? list.find((x) => x && x.name === name && x.s) : null;
  if (p) return { settings: reachable(normalizeBar(p.s)), from: 'profile', pending: false };
  return { settings: normalizeBar(null), from: 'defaults', pending: !!name };
}

/**
 * Does a window restore cost a NuVizz call? Only the narrow live periods hit the vendor;
 * everything wider (±7d, the "last N days" ranges, custom ranges) is served from our own
 * per-day board docs — see the LIVE_PERIODS gate in netlify/functions/nuvizz-stop-explorer.
 * Kept here so the cost of remembering a window is a stated fact with a test on it, not a
 * thing someone has to re-derive from the server the next time this is touched.
 */
export const BAR_WINDOWS_COSTING_A_CALL = ['0d'];
export const barRestoreCostsCall = (nvWindow) => BAR_WINDOWS_COSTING_A_CALL.includes(normalizeBar({ nvWindow }).nvWindow);
