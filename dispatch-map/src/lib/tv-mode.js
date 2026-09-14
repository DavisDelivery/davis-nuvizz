// tv-mode.js — WHAT THE OFFICE WALL DISPLAY IS, AND WHAT GOES ON IT.
//
// PURE. No React, no window, no fetch, no Firestore. Every decision the TV view makes about
// WHICH freight is worth a room's attention lives here, so it can be run against a real
// board in a test instead of being read off a screenshot of a 55" television nobody on this
// side of the code can see.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE OPERATIONAL BRIEF, because it decides every rule below.
//
// This screen is on a wall. Nobody clicks it, nobody scrolls it, and the person reading it
// is fifteen feet away with their hands full. That makes it a DIFFERENT INSTRUMENT from the
// dispatch board, not a bigger copy of one:
//
//   · The board answers "tell me about this stop". The wall answers "is anything on fire,
//     and how is the day going" — from across the room, in one glance, with no input.
//   · A control nobody can press is decoration. A count nobody can act on is worse: it uses
//     up the attention the one actionable number needed.
//   · It runs unattended for twelve hours. Every failure mode has to end somewhere legible,
//     because there is no dispatcher in front of it to notice a spinner that never stopped.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PURE. Is this URL the wall display?
 *
 * Exact match on the path only. A prefix test (`startsWith('/tv')`) would swallow any future
 * /tv-something route, and this app's SPA catch-all serves index.html for EVERY path — so a
 * typo'd URL on a TV nobody is watching would come up in a mode nobody asked for and stay
 * there. Query strings and hashes are stripped because the TV's browser may append its own,
 * and one trailing slash is forgiven because a kiosk launcher is as likely to send "/tv/".
 */
export function isTvPath(pathname) {
  const raw = String(pathname ?? '').split('?')[0].split('#')[0];
  const p = raw.replace(/\/+$/, '').toLowerCase();
  return p === '/tv';
}

/** How many flag rows the rail can show before it is just a wall of text. */
export const TV_RAIL_LIMIT = 12;

/**
 * PURE. WHAT THE FLAG RAIL SHOWS, and what it must say about the rest.
 *
 * CRITICAL AND RED ONLY, and that is a logistics call rather than a display one. Red means a
 * stop is predicted past its close — somebody can still pick up a phone and save it. Amber
 * means watch it. On a board carrying twenty-five ambers and three reds, a rail that lists
 * all of them puts the three that need a call today below the fold of a screen that cannot
 * scroll, which is the exact failure the rail exists to prevent. Amber still comes back as a
 * COUNT (below), because a lane silently dropping a whole tier is how a quiet board and a
 * half-blind one come to look identical.
 *
 * THE OVERFLOW IS RETURNED, NEVER SWALLOWED. Twelve rows and a truncation nobody mentions
 * reads as "twelve problems" on a morning that has thirty. The caller is expected to print
 * it; that is the difference between a summary and a lie.
 *
 * @param rows       boardFlags.rows from computeBoardFlags
 * @param dismissed  the dismissKey map the dispatch board already keeps
 * @param limit      rows to show (default TV_RAIL_LIMIT)
 * @returns {{rows: object[], overflow: number, urgent: number, amber: number}}
 */
export function tvRailRows(rows, dismissed = null, limit = TV_RAIL_LIMIT) {
  const dis = dismissed && typeof dismissed === 'object' ? dismissed : {};
  const live = (Array.isArray(rows) ? rows : []).filter((r) => r && !dis[r.dismissKey]);
  const urgent = live.filter((r) => r.tier === 'critical' || r.tier === 'red');
  // Critical above red; otherwise the detector's own order is kept, because it already sorts
  // worst-first within a tier and re-sorting here would be a second opinion nobody asked for.
  const rank = (t) => (t === 'critical' ? 0 : 1);
  const sorted = [...urgent].sort((a, b) => rank(a.tier) - rank(b.tier));
  // A malformed limit must not silently empty the rail — the failure that leaves a screen
  // looking like a clean board. Anything not a positive integer falls back to the default.
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : TV_RAIL_LIMIT;
  return {
    rows: sorted.slice(0, n),
    overflow: Math.max(0, sorted.length - n),
    urgent: sorted.length,
    amber: live.filter((r) => r.tier === 'amber').length,
  };
}

/**
 * PURE. THE ONE-LINE VERDICT ACROSS THE TOP, and the tone that paints it.
 *
 * "NOTHING NEEDS A CALL" IS SAID OUT LOUD rather than left as an empty rail. An empty panel
 * and a panel whose data never arrived are the same pixels, and this app has already shipped
 * that mistake once (v0.54.x, the flags chip): a detector that could not look must never be
 * indistinguishable from a clean board. `stale` is therefore its OWN tone and its own
 * sentence — a wall display whose feed died at 6am otherwise reads as a perfect morning for
 * the rest of the day, which is the single worst thing this screen could do.
 *
 * @param urgent  count of critical+red rows on the rail
 * @param amber   count of advisory rows
 * @param stale   true when the feed has not refreshed within its expected window
 */
export function tvVerdict({ urgent = 0, amber = 0, stale = false } = {}) {
  const u = Number.isFinite(Number(urgent)) && Number(urgent) > 0 ? Math.floor(Number(urgent)) : 0;
  const a = Number.isFinite(Number(amber)) && Number(amber) > 0 ? Math.floor(Number(amber)) : 0;
  // Checked FIRST and regardless of the counts: with a dead feed the counts are yesterday's
  // news, and printing "all clear" over them is the claim that must never be made.
  if (stale) return { tone: 'stale', text: 'Board not updating — check the scan' };
  if (u > 0) return { tone: 'urgent', text: `${u} stop${u === 1 ? '' : 's'} need${u === 1 ? 's' : ''} a call` };
  if (a > 0) return { tone: 'watch', text: `${a} to watch · nothing needs a call` };
  return { tone: 'clear', text: 'Nothing needs a call' };
}

/**
 * PURE. IS THE FEED STALE? Minutes since the last refresh, against a budget.
 *
 * useStops re-reads every STOPS_REFRESH_MS while the tab is visible, so on a wall display
 * — which is visible by definition, all day — a gap much past that interval means the
 * fetches are failing, silently, the way a silent poll is designed to. That silence is
 * correct on a dispatcher's tab (they can see the board is alive) and dangerous on a wall.
 *
 * A NULL TIMESTAMP IS NOT STALE. It is "we have not loaded yet", which is the first ten
 * seconds of every morning; painting the boot as a failure teaches the room to ignore it.
 */
export function tvFeedStale(lastRefreshed, nowMs, budgetMs) {
  const at = lastRefreshed instanceof Date ? lastRefreshed.getTime() : Number(lastRefreshed);
  if (!Number.isFinite(at) || at <= 0) return false;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const budget = Number.isFinite(Number(budgetMs)) && Number(budgetMs) > 0 ? Number(budgetMs) : 10 * 60 * 1000;
  return now - at > budget;
}
