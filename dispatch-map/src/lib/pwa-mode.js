// src/lib/pwa-mode.js
//
// IS THIS THE INSTALLED APP, OR A BROWSER TAB? — the one question that decides whether a
// link to a document is a convenience or a trap.
//
// Chad, holding a 15-page Uline manifest filling his whole phone: "there is no way to close
// out the manifest viewer." The screenshot was not our viewer at all — it was iOS's own PDF
// view ("1 of 15" in a pill, pages on black), which means the document had NAVIGATED the
// window. A home-screen web app has no address bar, no toolbar and no back gesture, so once
// that happens the only way out is to kill the app. In a browser tab the same navigation opens
// a tab you can close. Same anchor, opposite outcome, and only this predicate can tell the
// two apart.
//
// Two signals, because the platforms disagree:
//   • iOS Safari sets `navigator.standalone === true` in a home-screen app and does NOT
//     reliably report the display-mode media query.
//   • Android Chrome and desktop PWAs report `(display-mode: standalone)` and have no
//     `navigator.standalone` at all.
// Either one is enough. Anything that throws — a test harness with no matchMedia, a locked-down
// WebView — reads as a browser, which is the safe direction: the hatch stays available and a
// tab can always be closed. The failure this must never produce is the reverse.
//
// PURE. `win` is injected so the rule is testable without a browser — there is no WebKit in
// the environment this ships from, which is exactly why it is held by construction.

/**
 * @param {object|undefined} win  the window-like object; defaults to the global one
 * @returns {boolean} true when running as an installed (standalone) app
 */
export function isStandaloneApp(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win || typeof win !== 'object') return false;
  try {
    if (win.navigator && win.navigator.standalone === true) return true;
  } catch { /* a navigator that throws is not a home-screen app we can prove */ }
  try {
    const mm = typeof win.matchMedia === 'function' ? win.matchMedia('(display-mode: standalone)') : null;
    if (mm && mm.matches === true) return true;
  } catch { /* same: unknowable reads as a browser */ }
  return false;
}

/**
 * IS THIS AN iOS HOME-SCREEN APP SPECIFICALLY? — because that is the only place the trap is.
 *
 * An Android installed app opens a target=_blank link in a Chrome Custom Tab with its own
 * close control; a desktop installed app opens it in the browser beside the app. Neither
 * replaces the app window. iOS is the one platform where a home-screen web app navigates
 * ITSELF to the document and offers nothing to come back with. So the hatch decision must
 * ask this narrower question, not "is it installed?" — or every Android dispatcher loses a
 * harmless link for a trap they never had.
 *
 * Two signals again: Safari's own `navigator.standalone`, and (for the iPadOS "desktop
 * class" user agent, which hides the iPad) a touch-capable Mac platform running in
 * display-mode standalone. Unknowable → false, the safe direction.
 */
export function isIosHomeScreenApp(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win || typeof win !== 'object') return false;
  let nav = null;
  try { nav = win.navigator || null; } catch { return false; }
  if (!nav) return false;
  try { if (nav.standalone === true) return true; } catch { /* unknowable */ }
  try {
    const ua = String(nav.userAgent || '');
    const iosUa = /iP(hone|ad|od)/.test(ua) || (String(nav.platform || '') === 'MacIntel' && Number(nav.maxTouchPoints) > 1);
    if (!iosUa) return false;
    const mm = typeof win.matchMedia === 'function' ? win.matchMedia('(display-mode: standalone)') : null;
    return !!(mm && mm.matches === true);
  } catch { return false; }
}

/**
 * THE HEADER DECISION, AS A RULE. What the document viewer offers beside Close:
 *
 *   'hatch'  an "Open in browser" link — a browser tab, an Android or desktop installed app:
 *            the link opens somewhere with its own close control.
 *   'share'  a Share button — an iOS home-screen app that can hand a FILE to the system
 *            sheet. The link is a dead end there; Share comes straight back.
 *   'none'   an iOS home-screen app that cannot share files. Nothing is better than a trap.
 *
 * Pure, so the test can hand it every combination and read the answer — a test that greps
 * the JSX for the shape of a ternary was shown to pass five different dead ends.
 */
export function viewerWayOut({ iosHomeScreen, canShareFiles: canShare }) {
  if (!iosHomeScreen) return 'hatch';
  return canShare ? 'share' : 'none';
}

/**
 * Can this device hand a FILE to another app (AirDrop, Messages, Files)? The replacement for
 * "open in browser" inside the installed app: it gets the manifest OFF the phone without ever
 * leaving the board. `canShare` is a capability probe, not a permission — it can be asked
 * before any bytes are fetched, which is why it is separated from the share itself.
 */
export function canShareFiles(nav = typeof navigator !== 'undefined' ? navigator : undefined) {
  if (!nav || typeof nav !== 'object') return false;
  try {
    return typeof nav.share === 'function' && typeof nav.canShare === 'function';
  } catch { return false; }
}

/**
 * One short label for the footer, so the answer the predicate gave can be READ BACK on the
 * device it was given on. The dead-end fix turns on isStandaloneApp(); a phone that reports
 * "browser tab" while behaving like a home-screen app is a phone whose icon was added in a
 * way this predicate does not see, and that is a fact worth one line of footer.
 */
export function describePwaMode(win = typeof window !== 'undefined' ? window : undefined,
  nav = typeof navigator !== 'undefined' ? navigator : undefined) {
  const mode = isIosHomeScreenApp(win) ? 'iPhone app' : isStandaloneApp(win) ? 'installed app' : 'browser tab';
  return canShareFiles(nav) ? `${mode} · can share files` : mode;
}
