// lib/print-layout.js — WHICH LAYOUT THE DRIVER MANIFEST AND THE DELIVERY TICKET PRINT IN.
//
// Chad, 2026-10-03, approving the redesigned manifest: "i want to move to production but i want
// a way to roll back to old one if needed in diagnostics screen somewhere i want to be able to
// pick which version i'm running."
//
// ONE SETTING FOR EVERY DEVICE, NOT ONE PER BROWSER. The paper comes off the office PCs and the
// switch gets thrown from a phone, so a per-device setting would roll back the one device that
// never prints. The choice is one document (nuvizz_ops/print_layout) behind
// netlify/functions/print-layout.mts. Diagnostics → Manifest layout reads it back and changes it.
//
// WHAT A DEVICE PRINTS BETWEEN READS. The builders run inside a click and cannot wait on a
// request, so each device keeps the server's last answer and prints from that. It asks again
// when the app opens, when the tab comes back to the front, every PRINT_LAYOUT_REFRESH_MS while
// it is showing, and each time a print preview opens. A device that has never had an answer
// prints the default.
//
// THE DEFAULT IS THE NEW LAYOUT, and only the words 'classic' and 'old' mean the old one. A
// missing document, an empty field and a typo all print the new layout: a malformed value must
// never switch something off by accident, because that failure looks exactly like a working
// switch (the house shape for every switch in this repo).
//
// PURE CORE, THIN EDGE: everything here takes its inputs by argument. The request lives in
// App.jsx (pullPrintLayout) and the document in the endpoint.

export const PRINT_LAYOUTS = ['new', 'classic'];
export const DEFAULT_PRINT_LAYOUT = 'new';
/** Where a device keeps the server's last answer. A cache of the shared setting, never a setting of its own. */
export const PRINT_LAYOUT_CACHE_KEY = 'print.layout';
export const PRINT_LAYOUT_REFRESH_MS = 5 * 60 * 1000;

/** PURE: is this exactly one of the two layouts? The only values the endpoint will store. */
export function isPrintLayout(v) {
  return v === 'new' || v === 'classic';
}

/** PURE: any stored or served value → the layout it means. Malformed means the default. */
export function normalizePrintLayout(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'classic' || s === 'old' ? 'classic' : DEFAULT_PRINT_LAYOUT;
}

/** PURE: the word the screens use for a layout — Chad's own: "new" and "old". */
export function printLayoutWord(layout) {
  return normalizePrintLayout(layout) === 'classic' ? 'old' : 'new';
}

// The server's last answer IN THIS PAGE. Storage can be blocked (a private window), and a device
// that cannot write its cache must still follow the switch for as long as the page is open.
let lastAnswer = null;
// How many answers this page has kept. A read that was already in flight when a newer answer
// landed (the switch pressed while the periodic read was out) must not overwrite it: the reader
// notes the count before it asks and drops its answer if the count has moved (pullPrintLayout).
let answersKept = 0;
const ownStorage = () => {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
};

/**
 * What this device prints right now: the last answer it had from the server, else the default.
 * Storage first — it is shared by every tab on the device, so a tab that did not make the request
 * still prints what the newest answer said.
 */
export function printLayoutNow(storage = ownStorage()) {
  let raw = null;
  try { raw = storage?.getItem?.(PRINT_LAYOUT_CACHE_KEY) ?? null; } catch { raw = null; }
  if (raw != null) return normalizePrintLayout(raw);
  return lastAnswer ?? DEFAULT_PRINT_LAYOUT;
}

/** Keep an answer that was READ FROM THE SERVER — never a guess. Returns the layout kept. */
export function rememberPrintLayout(layout, storage = ownStorage()) {
  const v = normalizePrintLayout(layout);
  lastAnswer = v;
  answersKept += 1;
  try { storage?.setItem?.(PRINT_LAYOUT_CACHE_KEY, v); } catch { /* blocked storage: lastAnswer carries it for this page */ }
  return v;
}

/** How many answers this page has kept so far — see answersKept above. */
export function printLayoutAnswersKept() {
  return answersKept;
}

/** Tests only: forget the in-page answer so one test cannot leak a layout into the next. */
export function _resetPrintLayoutForTests() {
  lastAnswer = null;
  answersKept = 0;
}

/** "Oct 3, 2026, 2:14 PM" on the office's own clock, or '' for a stamp that is missing or unreadable. */
export function printLayoutStamp(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return '';
  try {
    // Some runtimes put a narrow no-break space before AM/PM; the screen gets a plain one either way.
    return new Date(t).toLocaleString('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    }).replace(/\u202f/g, ' ');
  } catch { return ''; }
}

/**
 * PURE: the line the Diagnostics panel leads with, from what was READ.
 *
 *   phase   'loading' | 'ready' | 'error'
 *   answer  the endpoint's body ({ layout, stored, persistent, set_at, set_by }) or null
 *   error   why the read failed, when it did
 *   device  what this device will print meanwhile (printLayoutNow())
 *
 * A FAILED READ SAYS SO. It names what this device is printing in the meantime and never shows a
 * layout nobody read — `layout` is null then, so no choice on the screen is marked "in use".
 * `tone` is 'idle' | 'good' | 'warn' | 'bad'; `canChange` is false where a change could not be stored.
 */
export function printLayoutStatus({ phase, answer = null, error = null, device = DEFAULT_PRINT_LAYOUT } = {}) {
  if (phase === 'loading') {
    return { tone: 'idle', layout: null, canChange: false, headline: 'Reading which layout is in use…', detail: '' };
  }
  if (phase !== 'ready' || !answer || answer.ok === false) {
    const why = String(error ?? answer?.error ?? '').trim();
    return {
      tone: 'bad', layout: null, canChange: false,
      headline: `Could not read the setting${why ? ` — ${why}` : ''}.`,
      detail: `Until it can be read, this device prints the ${printLayoutWord(device)} layout — the last answer it had.`,
    };
  }
  const layout = normalizePrintLayout(answer.layout);
  const headline = `In use: the ${printLayoutWord(layout).toUpperCase()} layout.`;
  const who = String(answer.set_by ?? '').trim();
  const when = printLayoutStamp(answer.set_at);
  const by = [who ? `by ${who}` : '', when ? `on ${when}` : ''].filter(Boolean).join(' ');
  if (answer.persistent === false) {
    return {
      tone: 'idle', layout, canChange: false, headline,
      detail: String(answer.note ?? '').trim() || 'This site has no database, so the choice cannot be stored here.',
    };
  }
  if (layout === 'classic') {
    return { tone: 'warn', layout, canChange: true, headline, detail: by ? `Switched back ${by}.` : 'Switched back to the old layout.' };
  }
  // A stored value that is not a layout name prints the new layout — and the screen says which
  // value it found, so a hand-edited document is not a mystery.
  const stored = answer.stored == null ? '' : String(answer.stored).trim();
  if (stored && normalizePrintLayout(stored) === 'new' && stored.toLowerCase() !== 'new') {
    return { tone: 'good', layout, canChange: true, headline, detail: `The stored value “${stored}” is not a layout name, so the new layout prints.` };
  }
  return {
    tone: 'good', layout, canChange: true, headline,
    detail: stored ? (by ? `Chosen ${by}.` : 'Chosen here.') : 'This is the default — nobody has changed it.',
  };
}

/** The two choices as the panel lists them: new first, because it is the default. */
export const PRINT_LAYOUT_CHOICES = [
  {
    layout: 'new',
    title: 'New layout',
    does: 'Large PRO number and piece counts, BOL beside the phone number, comments above the freight lines, and the top-right corner left clear for the staple.',
    action: 'Use the new layout',
  },
  {
    layout: 'classic',
    title: 'Old layout',
    does: 'The manifest and delivery ticket exactly as they printed before the new layout.',
    action: 'Go back to the old layout',
  },
];
