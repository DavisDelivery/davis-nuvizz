// src/lib/tab-links.js — A SCREEN IN THE NAVIGATION IS A LINK, SO IT CAN OPEN IN A NEW TAB.
//
// Chad, 2026-10-04: "can you make it where you can right click things in the app to bring up in new
// tab like if I want to bring up the stops tab or quotes tab in another tab".
//
// The screens were <button>s that flipped the Shell's `tab` state, and no URL named a screen — so a
// browser offered nothing on a right-click, and a second tab always opened on the Map. Each screen
// entry is now an <a href="/?tab=…">: the browser's own right-click menu ("Open link in new tab"),
// a middle-click, Ctrl/⌘-click and a phone's long-press all open that screen in a tab of its own,
// while a plain click still switches the screen in this tab exactly as before.
//
// The new tab reads ?tab= ONCE, as it starts, and then the address bar goes back to "/": a URL that
// still said ?tab=quote after the dispatcher had moved on to the Map would be the URL lying about the
// page (the same rule as /tv and the Gmail return), and a reload would land on the wrong screen.

/**
 * Every screen a link may open — the Shell's own screen ids. A screen added to the Shell and to
 * onSelectMenu's KNOWN list belongs here too (test/tab-links-wiring.test.mjs holds the two lists
 * together): a link to an id this list does not know opens the Map.
 */
export const LINKABLE_SCREENS = Object.freeze([
  'map', 'routing', 'stoplookup', 'neworder', 'quote',
  'manifest', 'comms', 'labels', 'flaghistory', 'addrhistory', 'performance', 'users', 'diag', 'uatbench',
]);

/** The query parameter a new tab reads its screen from. */
export const SCREEN_PARAM = 'tab';

/**
 * The URL switches this app reads once, at load: ?routing=0 hides Routing (ROUTING_FLAG) and
 * ?write=1 / ?write=0 forces the live-write beta (LIVE_WRITE_FLAG). A tab opened from a page that
 * was started with one carries it, so the new tab is the same app on another screen. Nothing else
 * is carried — the Gmail outcome and a password-reset token are one-shot and must never be copied.
 */
export const CARRIED_PARAMS = Object.freeze(['routing', 'write']);

/** PURE. Is `id` a screen a link may open? */
export function isLinkableScreen(id) {
  return typeof id === 'string' && LINKABLE_SCREENS.includes(id);
}

/**
 * PURE. The href for a screen entry: "/" for the Map, "/?tab=<id>" for the rest, plus any of
 * CARRIED_PARAMS present in `search` (the current page's query string).
 */
export function screenHref(id, search = '') {
  const out = new URLSearchParams();
  let have;
  try { have = new URLSearchParams(String(search || '')); } catch { have = new URLSearchParams(); }
  for (const k of CARRIED_PARAMS) {
    const v = have.get(k);
    if (v != null && v !== '') out.set(k, v);
  }
  if (isLinkableScreen(id) && id !== 'map') out.set(SCREEN_PARAM, id);
  const q = out.toString();
  return q ? `/?${q}` : '/';
}

/**
 * PURE. The screen a page should open on, read from its query string — or null (open the Map).
 * Only screens this build offers: Routing only while ROUTING_FLAG is on, the UAT bench only on a
 * UAT host. Anything else — unknown, misspelt, empty — is null rather than a guess, because the
 * Shell's screen switch falls through to Diagnostics for an id it does not render. (Account &
 * logins is refused by the Shell itself, from the signed-in user, the moment it renders.)
 */
export function screenFromSearch(search, { routing = true, bench = false } = {}) {
  let v;
  try { v = new URLSearchParams(String(search || '')).get(SCREEN_PARAM); } catch { return null; }
  if (!isLinkableScreen(v)) return null;
  if (v === 'routing' && !routing) return null;
  if (v === 'uatbench' && !bench) return null;
  return v;
}

/**
 * PURE. `search` with the screen parameter taken out, for history.replaceState — "" or "?…" with
 * every other parameter kept in order. null when there is no screen parameter (nothing to do).
 */
export function searchWithoutScreen(search) {
  let params;
  try { params = new URLSearchParams(String(search || '')); } catch { return null; }
  if (!params.has(SCREEN_PARAM)) return null;
  params.delete(SCREEN_PARAM);
  const q = params.toString();
  return q ? `?${q}` : '';
}

/**
 * PURE. A click the app keeps for itself: the primary button with no modifier key. Everything else
 * — Ctrl/⌘-click (new tab), Shift-click (new window), Alt-click — is the browser's, and the app
 * leaves it alone. A middle-click never arrives here at all: it is an auxclick, not a click.
 */
export function isPlainLeftClick(e) {
  return !!e && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
