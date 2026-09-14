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
 * PURE. WHAT THE FEED IS DOING — and the state this screen got wrong on day one.
 *
 * THE BUG THIS REPLACES, because it is the whole reason this function exists. tvFeedStale()
 * below answers "has a board that LOADED gone quiet", and it deliberately answers `false`
 * when nothing has ever loaded, on the reasoning that the first ten seconds of a morning are
 * not a failure. That reasoning is right and the conclusion was wrong: a board that has never
 * loaded is not "not stale", it is NOT THERE — and with no other state to fall into it came
 * out of tvVerdict() as `clear`. Chad's wall display spent its first morning printing a green
 * "Nothing needs a call" and "All clear" over a board it had never once read.
 *
 * That is the exact failure this file's own header warns about, arriving through the one door
 * left open: a detector that could not look, pixel-identical to a clean board. "Not yet" and
 * "never" are different claims and they need different words.
 *
 * SO THERE IS A GRACE WINDOW AND THEN THERE IS NOT. Inside it, "loading…" is honest and the
 * verdict stays quiet — nobody should read a boot as a breakage. Past it, a board with no
 * successful read is DOWN, and it says so in the same place a late stop would.
 *
 * AND AN ERROR SHORT-CIRCUITS THE GRACE. If the fetch has already come back refused, waiting
 * out a timer to admit it is just a slower lie.
 *
 * @param lastRefreshed  Date|ms of the last SUCCESSFUL read, or null
 * @param error          the message from the last failed read, or null
 * @param bootedAt       ms when this screen mounted — the clock the grace runs on
 * @param nowMs          now
 * @param budgetMs       how long a loaded board may go unrefreshed before it is stale
 * @param graceMs        how long "loading…" is an acceptable answer (default 90s)
 * @returns {{state:'loading'|'live'|'stale'|'down', text:string}}
 */
export function tvFeedState({ lastRefreshed, error, bootedAt, nowMs, budgetMs, graceMs = 90 * 1000 } = {}) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const at = lastRefreshed instanceof Date ? lastRefreshed.getTime() : Number(lastRefreshed);
  const loaded = Number.isFinite(at) && at > 0;
  const err = typeof error === 'string' ? error.trim() : (error ? String(error) : '');

  if (!loaded) {
    const boot = Number.isFinite(Number(bootedAt)) ? Number(bootedAt) : now;
    const waited = now - boot;
    const grace = Number.isFinite(Number(graceMs)) && Number(graceMs) > 0 ? Number(graceMs) : 90 * 1000;
    // Refused already, or waited long enough that "loading" has stopped being true.
    if (err) return { state: 'down', text: `Board will not load — ${err}` };
    if (waited > grace) return { state: 'down', text: 'Board has not loaded' };
    return { state: 'loading', text: 'loading…' };
  }

  // It HAS loaded at least once. A later failure is worth saying, but the board on screen is
  // real freight from a real read, so this is "going stale", not "not there".
  const mins = Math.max(0, Math.floor((now - at) / 60000));
  const ago = mins < 1 ? 'updated just now' : `updated ${mins} min ago`;
  if (tvFeedStale(at, now, budgetMs)) return { state: 'stale', text: `${ago} — not updating` };
  return { state: 'live', text: ago };
}

/**
 * PURE. THE ONE-LINE VERDICT ACROSS THE TOP, and the tone that paints it.
 *
 * "NOTHING NEEDS A CALL" IS SAID OUT LOUD rather than left as an empty rail. An empty panel
 * and a panel whose data never arrived are the same pixels, and this app has already shipped
 * that mistake once (v0.54.x, the flags chip): a detector that could not look must never be
 * indistinguishable from a clean board.
 *
 * `feed` IS CHECKED FIRST AND BEATS EVERY COUNT. A wall display whose feed died at 6am
 * otherwise reads as a perfect morning for the rest of the day, which is the single worst
 * thing this screen could do — and a board that never loaded at all is the same claim with
 * less excuse. Both 'stale' and 'down' take the headline; only 'live' and 'loading' let the
 * counts speak, and 'loading' does so because on a board mid-boot the counts are simply 0.
 *
 * @param urgent  count of critical+red rows on the rail
 * @param amber   count of advisory rows
 * @param feed    the state from tvFeedState() — 'loading' | 'live' | 'stale' | 'down'
 */
export function tvVerdict({ urgent = 0, amber = 0, feed = 'live' } = {}) {
  const u = Number.isFinite(Number(urgent)) && Number(urgent) > 0 ? Math.floor(Number(urgent)) : 0;
  const a = Number.isFinite(Number(amber)) && Number(amber) > 0 ? Math.floor(Number(amber)) : 0;
  if (feed === 'down') return { tone: 'down', text: 'NO BOARD — nothing is being read' };
  if (feed === 'stale') return { tone: 'stale', text: 'Board not updating — check the scan' };
  // Mid-boot the counts are 0 because nothing has arrived, not because the day is clean.
  if (feed === 'loading') return { tone: 'loading', text: 'Loading the board…' };
  if (u > 0) return { tone: 'urgent', text: `${u} stop${u === 1 ? '' : 's'} need${u === 1 ? 's' : ''} a call` };
  if (a > 0) return { tone: 'watch', text: `${a} to watch · nothing needs a call` };
  return { tone: 'clear', text: 'Nothing needs a call' };
}

/**
 * PURE. IS A BOARD THAT HAS LOADED NOW STALE? Minutes since the last successful read,
 * against a budget. Used by tvFeedState above; kept separate because it is one idea.
 *
 * useStops re-reads every STOPS_REFRESH_MS while the tab is visible, so on a wall display
 * — which is visible by definition, all day — a gap much past that interval means the
 * fetches are failing, silently, the way a silent poll is designed to. That silence is
 * correct on a dispatcher's tab (they can see the board is alive) and dangerous on a wall.
 *
 * A NULL TIMESTAMP IS NOT STALE — it is "we have never read", which is a DIFFERENT and worse
 * claim, and tvFeedState is what tells the two apart. This answering `false` for null is why
 * the first cut of the wall display printed "All clear" over a board it had never read; the
 * behaviour is correct for the question this function asks, and the bug was asking only this
 * question. Left as it was, with that noted, because the fix belonged one level up.
 */
export function tvFeedStale(lastRefreshed, nowMs, budgetMs) {
  const at = lastRefreshed instanceof Date ? lastRefreshed.getTime() : Number(lastRefreshed);
  if (!Number.isFinite(at) || at <= 0) return false;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const budget = Number.isFinite(Number(budgetMs)) && Number(budgetMs) > 0 ? Number(budgetMs) : 10 * 60 * 1000;
  return now - at > budget;
}
