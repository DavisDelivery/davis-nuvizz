// src/lib/routing-switches.js
//
// ── THE ROUTING SWITCHES, IN ONE PLACE, SETTABLE FROM THE APP (Chad, 2026-10-01) ──────────────
//
// Chad, asked whether the switches behind this week's optimizer changes could be turned on and off
// from the app: "Yeah. Is there any problem with storing them in a database? The question would be
// where to locate them, which I would say we put in the Diagnostics tab … I would like to have the
// date that the switch was put in place so I'll know which ones to toggle on and off if there's a
// change made that I don't like."
//
// Every switch here used to be a Netlify environment variable: invisible from the app, and a
// redeploy to flip. Now each one can be SET on Diagnostics → Routing switches and stored in one
// Firestore document (ROUTING_SWITCHES_DOC). The order a switch is resolved in, everywhere:
//
//   1. set on the page (the document)        — wins, and the page says "set here"
//   2. the Netlify environment variable      — what it was before this page existed
//   3. the switch's default                  — what the code ships with
//
// So an empty document, or a deploy with no Firestore at all, leaves every switch EXACTLY where it
// was before this file. A database that cannot be read is NOT free: a switch set on the page is
// then not honoured until it can be (the browser and a cold server fall back to Netlify/default; a
// server that has read it before keeps its last copy) — the page and each build's trail say so.
//
// ONE REGISTRY, read by the page, the browser's switch reads and the server's. `since` is the
// moment the change went live on main, in Eastern time, from the merge commit — the date Chad
// reads to find "the change I don't like". PURE: no imports, safe in the browser bundle and in a
// Netlify function alike.

// A plain string literal on purpose: test/firestore-rules-shape.test.mjs reads the browser's call
// sites off the source and resolves `const X = '…'`, so the rules guard sees this collection.
// READ-ONLY TO THE BROWSER (firestore.rules browserReadOnlyCollection): a flip goes through the
// routing-switches endpoint, where it is gated admin and stamped with who made it.
export const ROUTING_SWITCHES_COLL = 'routing_switches';
export const ROUTING_SWITCHES_DOC = { collection: ROUTING_SWITCHES_COLL, id: 'davis' };
export const ROUTING_SWITCHES_PATH = `${ROUTING_SWITCHES_DOC.collection}/${ROUTING_SWITCHES_DOC.id}`;

const OFF_WORDS = ['off', '0', 'false', 'no'];
const ON_WORDS = ['on', '1', 'true', 'yes'];

/**
 * side: 'browser' — read in the app (a VITE_ variable, baked into the build); 'server' — read by a
 *       Netlify function at request time.
 * shape: 'house' — default on, an off-word turns it off, anything else leaves it on;
 *        'opt-in' — default off, only an on-word turns it on.
 */
export const ROUTING_SWITCHES = [
  {
    name: 'VITE_TIME_WINDOWS_MILES_CAP', side: 'browser', shape: 'house', where: 'Compare card · Time windows',
    label: 'Time windows weighs miles: a missed window is worth 2 miles',
    on: 'Time windows takes the fewest miles plus 2 for each late or early stop, never with more of them than the card.',
    off: 'Time windows goes back to clearing late stops at any mileage (it never looked at miles).',
    since: '2026-09-30T15:17:00-04:00', version: '1.99.5', pr: 1094,
  },
  {
    name: 'VITE_CLOSEST_FIRST_WITHOUT_TOWNS', side: 'browser', shape: 'house', where: 'Compare card · Closest first',
    label: 'Closest first without the one-town-at-a-time rule',
    on: 'Closest first is the plain shortest sweep out from Buford.',
    off: 'Closest first works one town at a time again (the Sep 10 rule).',
    since: '2026-09-30T14:31:00-04:00', version: '1.99.4', pr: 1093,
  },
  {
    name: 'ROAD_BOX_ESTIMATE_UNROUTABLE', side: 'server', shape: 'house', where: 'Compare card · road distances box',
    label: 'A leg Google cannot route gets a straight-line estimate, not 0 miles',
    on: 'With the road box ticked, a stop Google cannot route is priced at 1.3 × straight line.',
    off: 'That stop counts as a free 0-mile leg again.',
    since: '2026-09-30T14:06:00-04:00', version: '1.99.3', pr: 1092,
  },
  {
    name: 'VITE_PREFLIGHT_COUNTS_EVERY_LATE_STOP', side: 'browser', shape: 'house', where: 'Compare card · late badges',
    label: 'Late badges count every late stop, past 12',
    on: 'Every late stop gets its badge, and Time windows reads them all.',
    off: 'Past 12 late stops (25 amber) the card shows none again.',
    since: '2026-09-30T13:41:00-04:00', version: '1.99.2', pr: 1091,
  },
  {
    name: 'VITE_ROAD_REPLY_DROPS_MOVED_STOPS', side: 'browser', shape: 'house', where: 'Compare card · road distances box',
    label: 'A late road reply cannot put a moved or removed stop back',
    on: 'The road order lands on the card as it is when Google answers.',
    off: 'A stop moved or removed while the reply was out comes back (a stop on two loads).',
    since: '2026-09-30T13:09:00-04:00', version: '1.99.1', pr: 1090,
  },
  {
    name: 'VITE_RETURN_TO_WAREHOUSE', side: 'browser', shape: 'opt-in', where: 'Compare card · Re-sequence menu',
    label: 'Return to warehouse (round trip) in the Re-sequence menu',
    on: 'The option is in the menu.',
    off: 'The option is hidden (always shown on the UAT site unless set off here).',
    since: '2026-09-30T03:49:00-04:00', version: '1.98.0', pr: 1081,
  },
  {
    name: 'VITE_COMPARE_TIME_WINDOWS', side: 'browser', shape: 'house', where: 'Compare card · Re-sequence menu',
    label: 'Time windows in the Re-sequence menu',
    on: 'The option is in the menu.',
    off: 'The option is hidden; every other strategy is untouched.',
    since: '2026-09-28T23:56:00-04:00', version: '1.89.0', pr: 1066,
  },
  {
    name: 'ROUTING_REPAIR_ORIGIN_FIRST', side: 'server', shape: 'house', where: 'Build Panel · Build',
    label: 'A stop taken off in repair tries its own truck first',
    on: 'Repair offers a spilled stop back to the truck the solver chose before any other.',
    off: 'Repair hands it to the first truck in the list that can take it.',
    since: '2026-09-27T20:04:00-04:00', version: '1.81.3', pr: 1045,
  },
  {
    name: 'ROUTE_MATRIX_ESTIMATE_UNROUTABLE', side: 'server', shape: 'house', where: 'Build Panel · Google road distances',
    label: 'Build: a leg Google cannot route gets an estimate, not 0 miles',
    on: 'A build on Google road distances prices an unroutable leg at 1.3 × straight line.',
    off: 'That leg counts as 0 miles in the build again.',
    since: '2026-09-27T19:37:00-04:00', version: '1.81.2', pr: 1043,
  },
  {
    name: 'ROUTING_TIME_RESTRICTIONS', side: 'server', shape: 'house', where: 'Build Panel · Build',
    label: 'The build reads receiving hours and appointments',
    on: 'The build sequences around receiving hours, booked windows and closed days.',
    off: 'The build ignores them (the blind behaviour before Sep 12).',
    since: '2026-09-12T17:48:00-04:00', version: '1.21.0', pr: 912,
  },
];

export const ROUTING_SWITCH_NAMES = ROUTING_SWITCHES.map((s) => s.name);
const BY_NAME = new Map(ROUTING_SWITCHES.map((s) => [s.name, s]));
export const routingSwitchDef = (name) => BY_NAME.get(name) || null;

/** PURE: the stored setting for one switch out of the document, or undefined. */
export function storedSetting(doc, name) {
  const v = doc?.[name];
  return v && typeof v === 'object' && typeof v.on === 'boolean' ? v : undefined;
}

/**
 * A switch HANDED BACK on the page ("Use the Netlify setting") is stored as { on: null, at, by }:
 * it resolves exactly like a switch never set (storedSetting ignores it), and the page can still
 * say who handed it back and when. Returns that entry, or undefined.
 */
export function handedBackSetting(doc, name) {
  const v = doc?.[name];
  return v && typeof v === 'object' && v.on === null ? v : undefined;
}

/**
 * PURE. Where a switch sits and why: { on, source } with source one of
 *   'page'    — set on Diagnostics → Routing switches (the stored document)
 *   'netlify' — the environment variable is set to something
 *   'uat'     — the UAT site's own rule (Return to warehouse is shown there)
 *   'default' — nothing set anywhere
 * `envValue` is the raw environment string the caller can see (the browser's baked-in VITE_
 * value, or the function's process.env value). A malformed value counts as set and resolves the
 * way the house shape always has: anything not an off-word leaves a 'house' switch ON.
 */
export function resolveRoutingSwitch(def, { stored, envValue, onUat = false } = {}) {
  if (!def) return { on: false, source: 'default' };
  if (stored && typeof stored.on === 'boolean') return { on: stored.on, source: 'page' };
  if (def.shape === 'opt-in' && onUat) return { on: true, source: 'uat' };
  const raw = envValue == null ? '' : String(envValue).trim().toLowerCase();
  if (raw !== '') {
    return def.shape === 'opt-in'
      ? { on: ON_WORDS.includes(raw), source: 'netlify' }
      : { on: !OFF_WORDS.includes(raw), source: 'netlify' };
  }
  return { on: def.shape !== 'opt-in', source: 'default' };
}

// ── THE BROWSER'S COPY OF THE DOCUMENT ─────────────────────────────────────────────────────────
// The app loads the document once and listens for changes (App.jsx, Shell), so a switch flipped
// on the page reaches every open screen without a reload. Until it has loaded — or if it never
// can — `doc` is empty and every switch reads its Netlify value or default, as before.
let doc = {};
let version = 0;
let loaded = false;
const listeners = new Set();

export function setStoredRoutingSwitches(next) {
  doc = next && typeof next === 'object' ? next : {};
  loaded = true;
  version += 1;
  for (const fn of listeners) { try { fn(); } catch { /* one listener cannot stop the rest */ } }
}

/**
 * PURE. Two copies of the document, switch by switch, keeping the entry stamped LATER (`at`). Every
 * write stamps `at` and nothing deletes a switch (a hand-back is an { on: null } entry), so the
 * later stamp is the later state. An entry with no readable `at` loses to one with.
 */
export function newerRoutingSwitches(a, b) {
  const t = (v) => { const n = Date.parse(v?.at); return Number.isFinite(n) ? n : -Infinity; };
  const out = { ...(a && typeof a === 'object' ? a : {}) };
  for (const [k, v] of Object.entries(b && typeof b === 'object' ? b : {})) {
    if (!(k in out) || t(v) >= t(out[k])) out[k] = v;
  }
  return out;
}

/**
 * Fold an answer from the ENDPOINT into the browser's copy. The live listener replaces the copy
 * (Firestore delivers its snapshots in order); an HTTP answer can arrive after a newer snapshot, so it
 * may only move a switch forward in time, never back.
 */
export function mergeStoredRoutingSwitches(incoming) {
  setStoredRoutingSwitches(newerRoutingSwitches(doc, incoming));
}
export function storedRoutingSwitches() { return doc; }
export function routingSwitchesLoaded() { return loaded; }
export function routingSwitchesVersion() { return version; }
export function subscribeRoutingSwitches(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Is this switch on, in this browser, right now? `env` is import.meta.env. */
export function routingSwitchOn(name, env, { onUat = false } = {}) {
  const def = BY_NAME.get(name);
  return resolveRoutingSwitch(def, { stored: storedSetting(doc, name), envValue: env?.[name], onUat }).on;
}
