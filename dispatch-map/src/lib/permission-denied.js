// permission-denied.js — MAKE A REFUSED FIRESTORE RULE VISIBLE.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FAILURE THIS EXISTS TO PREVENT.
//
// Ten Firestore paths in this app swallow their own errors. Seven reads
// (customer_notes, sms_messages, routing_customer_drivers, bottom_panel_profiles,
// truck_profiles, dispatch_presence, nuvizz_ops/manifest_check_latest) end in a
// bare `() => {}` or a `.catch(() => {})`, and two writes (the moved-pin address
// override) end in a console.error nobody is reading. Every one of them was written
// for the world where the rules said `allow read, write: if true` — in that world the
// only thing an error could mean was "the wifi blinked", and silence was the right
// answer.
//
// The moment the rules start checking request.auth that is no longer true. A denied
// read does not look like an outage: the board loads, the pins paint, the stop cards
// open — and every receiving hour, every closed day, every equipment restriction and
// every SMS thread is quietly missing, because the collection that holds them answered
// "denied" and the handler returned an empty Map. Nothing on the screen disagrees with
// an empty Map. It is found when a truck arrives at a dock that closed at 2pm.
//
// A denied WRITE is worse in a different direction: the dispatcher drags a pin onto the
// right door, watches the panel close, and believes the correction is saved. firestore.rules
// calls a bad one "a truck sent to the wrong door" — and this is the version of that where
// nobody even knows the fix did not land.
//
// So: a permission denial is REPORTED, once per surface, to a bar the dispatcher sees.
// An offline blip is NOT — a bar that lights every time a phone goes through a dead spot
// on the yard is wallpaper inside a week, and wallpaper is what this bar must never be.
// That is the whole reason this module classifies instead of just reporting.
//
// PURE except for the tiny subscriber list at the bottom. No React, no Firestore, no
// window — so the rule can be tested without a browser.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Firestore codes that mean "the rules said no" (or "there is nobody signed in to
 * ask"). Both are actionable by a person: sign in, or get the rules/role fixed.
 */
const DENIED_CODES = new Set(['permission-denied', 'unauthenticated']);

/**
 * The codes that mean "try again later" — a dropped connection, a cancelled listener on
 * unmount, a Firestore hiccup. These must stay silent: they are the normal weather of a
 * phone in a truck and they already self-heal (onSnapshot reconnects on its own).
 */
const TRANSIENT_CODES = new Set([
  'unavailable', 'cancelled', 'deadline-exceeded', 'aborted',
  'internal', 'resource-exhausted', 'unknown',
]);

/** Strip the SDK's optional product prefix: 'firestore/permission-denied' → 'permission-denied'. */
function codeOf(err) {
  const raw = String(err?.code ?? '').trim().toLowerCase();
  return raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
}

/**
 * PURE. 'denied' | 'transient' | 'other'.
 *
 * The message fallback is deliberate and narrow. "Missing or insufficient permissions."
 * is the exact sentence the Firestore Web SDK puts on a rules refusal, and a few paths
 * in this app re-wrap errors (Promise.all, a batch commit that reports per-document)
 * in a way that can lose `code` while keeping `message`. Losing the classification there
 * would put us straight back in the silent-board failure this module exists to stop, so
 * the sentence is matched as a second signal — never as the first one.
 */
export function classifyFirestoreError(err) {
  const code = codeOf(err);
  if (DENIED_CODES.has(code)) return 'denied';
  if (TRANSIENT_CODES.has(code)) return 'transient';
  if (!code && /missing or insufficient permissions/i.test(String(err?.message ?? ''))) return 'denied';
  return 'other';
}

/** PURE. The one question every call site asks. */
export function isPermissionDenied(err) {
  return classifyFirestoreError(err) === 'denied';
}

// ── WHAT IS MISSING, IN WORDS A DISPATCHER CAN ACT ON ────────────────────────
//
// Keyed by collection, not by function name. The dispatcher does not care that
// `useCustomerNotes` failed; they care that the hours on the screen are not the whole
// truth. Anything unlisted still reports — under its own raw key — because an
// unrecognised surface going dark is exactly the case where a silent fallback would
// hide the next one of these.
export const SURFACE_LABELS = {
  customer_notes: 'receiving hours, closed days and equipment restrictions',
  sms_messages: 'the SMS message threads',
  routing_customer_drivers: 'the usual-driver history on stop cards',
  bottom_panel_profiles: 'your saved grid layouts',
  truck_profiles: 'the truck profiles',
  dispatch_presence: 'who else is working the board',
  'nuvizz_ops/manifest_check_latest': "the overnight manifest check's result",
  'customer_notes:location_override': 'a moved pin (the corrected delivery location)',
  'customer_notes:auto_scan': 'the auto-scanner writing hours and restrictions',
};

export function surfaceLabel(key) {
  return SURFACE_LABELS[key] || String(key || 'part of the board');
}

// ── THE REPORT BUS ───────────────────────────────────────────────────────────
//
// Module-level, not React context: the call sites are scattered through a 27,000-line
// component tree and half of them are inside effects that have no props. One shared
// store, one banner, and a surface that is denied on every retry still only says so once.

/** @type {Map<string, { key: string, mode: 'read'|'write', label: string, at: number }>} */
const _denials = new Map();
const _listeners = new Set();

function _emit() {
  const snap = deniedSurfaces();
  for (const fn of _listeners) { try { fn(snap); } catch { /* a bad listener must not stop the others */ } }
}

/**
 * Report ONE surface as refused. Idempotent per (key, mode): a snapshot listener that
 * retries every few seconds must not re-render the app on every retry.
 *
 * Returns true when the error really was a denial (so callers can keep their own
 * transient-path behaviour unchanged), false otherwise.
 */
export function reportDenied(key, err, mode = 'read') {
  if (!isPermissionDenied(err)) return false;
  const id = `${mode}:${key}`;
  if (_denials.has(id)) return true;
  _denials.set(id, { key: String(key), mode: mode === 'write' ? 'write' : 'read', label: surfaceLabel(key), at: Date.now() });
  _emit();
  return true;
}

/** Everything currently refused, writes first — an edit that did not save outranks a read. */
export function deniedSurfaces() {
  return [..._denials.values()].sort((a, b) => (a.mode === b.mode ? a.at - b.at : a.mode === 'write' ? -1 : 1));
}

/** Subscribe; returns an unsubscribe. Fires immediately with the current state. */
export function subscribeDenied(fn) {
  _listeners.add(fn);
  try { fn(deniedSurfaces()); } catch { /* ignore */ }
  return () => { _listeners.delete(fn); };
}

/** Only for a fresh sign-in (and tests): the previous person's denials are not this one's. */
export function clearDenied() {
  if (!_denials.size) return;
  _denials.clear();
  _emit();
}
