// src/lib/load-failure.js — the one line a screen shows when its lazily loaded code did not arrive.
//
// WHY THIS EXISTS. Two tabs fetch their code the first time they open: Routing → Shadow (Chad,
// 2026-09-27, "12 yes") and Quote. Each import() rejects for two different reasons, and only one
// of them can be fixed by a reload:
//   - the file could not be FETCHED (a dropped connection, a file the server no longer has).
//     Measured in Chromium: "TypeError: Failed to fetch dynamically imported module: <url>".
//   - the file ARRIVED and its code failed as it loaded: an error thrown at the top of the
//     module, or syntax one browser will not parse. Measured in Chromium: "Error: …" and
//     "SyntaxError: …". Reloading the same build fetches the same file and fails the same way.
// The first version of the Shadow's fallback screen threw the error away, so both read "could not
// load, reload to try again" and nothing anywhere said which it was. A phone or an iPad has no
// console a dispatcher can open, so the screen itself has to carry the reason, where a screenshot
// sees it. The screen is src/components/TabLoadFailure.jsx; this is its one line of detail.
//
// WHAT THE LINE CAN AND CANNOT TELL. In Chromium it tells a file that could not be fetched from
// code that failed once it arrived. It does NOT tell a dropped connection from a file the site no
// longer has: measured, both print the same "TypeError: Failed to fetch dynamically imported
// module". And only Chromium was measured — how Safari words these has not been checked, so do
// not read a Safari screenshot by the Chromium wording above.
//
// PURE. Never throws — it runs inside the import's .catch, and a throw there would reject the
// lazy import after all and take the whole app down with it, which is the thing the catch is for.

export const LOAD_FAILURE_DETAIL_MAX = 300;

// THE FAILURE LINE'S FIXED TAIL. TabLoadFailure.jsx ends its line with it, and every layout guard
// (verify-desktop/mobile/tablet-layout.mjs) reads a screen showing it as a screen that did NOT
// arrive. Without that, a Quote or Shadow file that throws as it loads would pass CI as a working
// screen — the failure line carries the tab's name, which is all a guard's arrival check looks for.
export const TAB_LOAD_FAILURE_TAIL = 'could not load. Reload the page to try again.';

const str = (v) => (typeof v === 'string' ? v : '');

/**
 * What the browser said about a failed lazy load, as one short line of plain text.
 *
 * An Error (or anything shaped like one) reads "Name: message". Anything else is turned into
 * text. Nothing usable — null, undefined, an empty message, an object that cannot even be turned
 * into text — reads "no reason given", never an empty line and never "[object Object]". Long
 * messages (a URL, a stack pasted into a message) are cut to `max` characters with an ellipsis.
 *
 * @param {unknown} err  whatever the import() rejected with
 * @param {number} [max] longest line returned; malformed or under 2 falls back to the default
 * @returns {string}
 */
export function loadFailureDetail(err, max = LOAD_FAILURE_DETAIL_MAX) {
  const cap = Number.isFinite(max) && max >= 2 ? Math.floor(max) : LOAD_FAILURE_DETAIL_MAX;
  let text = '';
  try {
    if (err == null) {
      text = '';
    } else if (typeof err === 'object' || typeof err === 'function') {
      const name = str(err.name).trim();
      const message = str(err.message).trim();
      text = name || message ? [name, message].filter(Boolean).join(': ') : String(err);
      if (text === '[object Object]') text = '';
    } else {
      text = String(err);
    }
  } catch {
    // A Proxy whose getter throws, an object with no prototype (String() of it throws), a
    // toString that throws — none of them may escape this function.
    text = '';
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return 'no reason given';
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}
