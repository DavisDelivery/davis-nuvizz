// src/lib/stop-lookup-recent.js — THE "RECENT LOOKUPS" LIST ON THE STOP LOOKUP SCREEN.
//
// The searches this browser ran, newest first, one tap to run again. It replaced two cards of
// instructions under the search box: at a service desk the thing a rep most often wants next is
// the thing they looked up ten minutes ago, when the customer calls back.
//
// PER DEVICE (localStorage), and a CONVENIENCE, never a record: nothing reads it but this screen,
// and a browser that refuses storage simply shows none. Pure, so the rules — what counts as the
// same search, how many are kept, what a damaged stored value turns into — are tested rather
// than hoped.

export const RECENT_MAX = 8;
export const RECENT_KINDS = ['order', 'customer', 'place'];
const PLACE_KEYS = ['addr', 'city', 'state', 'zip'];

const squash = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

/** A place as it is kept: the four boxes, trimmed, state upper-cased. */
function cleanPlace(p) {
  const src = p && typeof p === 'object' ? p : {};
  const out = {};
  for (const k of PLACE_KEYS) out[k] = squash(src[k]);
  out.state = out.state.toUpperCase();
  return out;
}

/**
 * THE IDENTITY OF A SEARCH. Two entries with the same key are the same search, whatever case or
 * spacing they were typed in — "Earthly  alternative" run twice is one row, moved to the top, not
 * two rows that look like a stutter. Null for anything that is not a runnable search.
 */
export function recentKey(e) {
  if (!e || !RECENT_KINDS.includes(e.kind)) return null;
  if (e.kind === 'place') {
    const p = cleanPlace(e.place);
    // A state alone is not a search the screen will run (placeQueryUsable), so it is not kept.
    if (!p.addr && !p.city && !p.zip) return null;
    return `place|${PLACE_KEYS.map((k) => p[k].toLowerCase()).join('|')}`;
  }
  const t = squash(e.term).toLowerCase();
  return t ? `${e.kind}|${t}` : null;
}

/** A place written the way a person writes it on an envelope: "1100 Northside Dr, Atlanta GA 30318". */
export function placeLabel(place) {
  const p = cleanPlace(place);
  const tail = [[p.city, p.state].filter(Boolean).join(' '), p.zip].filter(Boolean).join(' ');
  if (p.addr) return tail ? `${p.addr}, ${tail}` : p.addr;
  if (p.city) return tail;
  return p.zip ? `ZIP ${p.zip}` : '';
}

/** What kind of search it was, in the word a rep would use. */
export function recentKindLabel(e) {
  if (e?.kind === 'order') return 'Order';
  if (e?.kind === 'customer') return 'Customer';
  if (e?.kind === 'place') {
    const p = cleanPlace(e.place);
    return p.addr ? 'Address' : p.city ? 'City' : 'ZIP';
  }
  return '';
}

/**
 * The entry a FINISHED search leaves behind — built from what the rep typed, labelled with what
 * the answer called it when it said (a customer's full business name reads better than the four
 * letters typed to find it). Null for anything not worth keeping.
 */
export function recentEntry({ kind, term, place, label, at } = {}) {
  const when = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();
  if (kind === 'place') {
    const p = cleanPlace(place);
    const e = { kind, place: p, label: squash(label) || placeLabel(p), at: when };
    return recentKey(e) ? e : null;
  }
  if (kind !== 'order' && kind !== 'customer') return null;
  const t = squash(term);
  if (!t) return null;
  return { kind, term: t, label: squash(label) || t, at: when };
}

/** Put `entry` on top, drop any earlier copy of the same search, keep the newest `max`. */
export function addRecent(list, entry, max = RECENT_MAX) {
  const prior = Array.isArray(list) ? list : [];
  const key = recentKey(entry);
  if (!key) return prior.slice(0, max);
  return [entry, ...prior.filter((e) => recentKey(e) !== key)].slice(0, max);
}

/**
 * Read what localStorage holds. ANYTHING DAMAGED IS DROPPED, NEVER THROWN: a hand-edited value, an
 * older shape or a truncated write must cost the rep their recent list at most — never the screen.
 */
export function parseRecent(raw, max = RECENT_MAX) {
  let arr;
  try { arr = JSON.parse(raw || '[]'); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    // No readable time is a damaged row, and it is dropped rather than stamped "just now" — a
    // week-old search must never float to the top looking fresh.
    if (!x || typeof x !== 'object' || Number.isNaN(Date.parse(x.at))) continue;
    const e = recentEntry(x);
    const key = recentKey(e);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const ET_SHORT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });

/**
 * "just now", "6 min ago", "3 h ago", "yesterday", "Sep 18" — ON DAVIS'S CLOCK. "Yesterday" is a
 * calendar word, so it is decided by the Eastern date, not by 24 hours: a search at 11pm is
 * "yesterday" at 8am, nine hours later.
 */
export function recentAgo(iso, nowMs = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = nowMs - t;
  if (diff < 60_000) return 'just now'; // a clock a little ahead reads as now, not "in 2 min"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const day = ET_DAY.format(new Date(t));
  const today = ET_DAY.format(new Date(nowMs));
  if (day === today) return `${Math.floor(diff / 3_600_000)} h ago`;
  const yesterday = ET_DAY.format(new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000));
  if (day === yesterday) return 'yesterday';
  return ET_SHORT.format(new Date(t));
}
