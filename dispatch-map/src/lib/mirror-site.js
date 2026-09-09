// src/lib/mirror-site.js
//
// THE BROWSER HALF OF THE MIRROR GUARD (PURE).
//
// The server refuses to touch production Firestore from a UAT-pointed deploy
// (netlify/functions/lib/firestore.mts, uatMisconfigured). The BROWSER has no such check, and
// the browser writes real things: customer notes, receiving hours, closed days, vehicle
// eligibility, truck profiles, board-date overrides, routing jobs. src/lib/firebase.js reads
// VITE_FIRESTORE_DATABASE and calls getFirestore(app, dbName) with no cross-check at all — so
// if that one build-time variable is missing or misspelled on the UAT site, every write from
// that browser lands in PRODUCTION, and nothing anywhere says so. The failure is silent by
// construction: the app looks completely normal.
//
// KEYED ON THE HOSTNAME, DELIBERATELY. Every other candidate is a variable somebody has to
// remember to set — which is the same failure, one level up. The UAT site is served from a
// host with "uat" in it, and that is a fact about the deploy that cannot be forgotten,
// mistyped into the dangerous direction, or copied from production's env.
//
// It only ever fires in the SAFE direction: a uat host with no named database is a
// misconfiguration, full stop. A uat host WITH a named database is correct and silent. A
// production host is never touched, whatever it sets.

/** Does this hostname belong to a mirror/UAT site? */
export function isUatHost(hostname) {
  return /(^|[.-])uat([.-]|$)/i.test(String(hostname || ''));
}

// ── WHAT THIS BOARD CALLS ITSELF ─────────────────────────────────────────────
//
// Chad, on the UAT site: "this needs to be labeled as UAT Dispatch Map."
//
// The two boards are pixel-identical, and a dispatcher who mistakes one for the other
// either plans freight on a board nobody ships from, or — the expensive direction —
// believes a real morning is a test. The tab, the header and the footer all read
// "Dispatch Map" on both sites today; nothing on screen says which one you are on.
//
// KEYED ON THE HOSTNAME, for the same reason mirrorMisconfigured is: a build-time
// variable is a thing somebody has to remember, and forgetting it here would label the
// test board as production — the dangerous direction. The URL cannot be forgotten.

/** The product name this deploy shows: the browser tab, the desktop wordmark, the footer. */
export function siteTitle(hostname) {
  return isUatHost(hostname) ? 'UAT Dispatch Map' : 'Dispatch Map';
}

/** The short form, for the phone app bar where the desktop wordmark does not fit. */
export function siteTitleShort(hostname) {
  return isUatHost(hostname) ? 'UAT Dispatch' : 'Dispatch';
}

/** The browser-tab title. Set at RUNTIME rather than in index.html: the tab is what a
 *  dispatcher with both boards open actually reads, and index.html ships identically to
 *  both sites. */
export function documentTitle(hostname) {
  return `${siteTitle(hostname)} · Davis Delivery`;
}

/**
 * PURE. Is this browser about to write the production database from a UAT site?
 *
 * @param {string} hostname   location.hostname
 * @param {string} dbName     the resolved VITE_FIRESTORE_DATABASE ('' = the default database)
 */
export function mirrorMisconfigured(hostname, dbName) {
  return isUatHost(hostname) && !String(dbName || '').trim();
}

/** The sentence shown when it is. Names what is wrong, what it would break, and the fix. */
export const MIRROR_MISCONFIGURED_MESSAGE =
  'This is the UAT site, but it is pointed at the PRODUCTION database. '
  + 'Anything saved here — receiving hours, closed days, vehicle eligibility, truck profiles — '
  + 'would change the real dispatch board. Set VITE_FIRESTORE_DATABASE on this Netlify site '
  + '(e.g. uat-mirror) and redeploy. Saving is switched off until then.';
