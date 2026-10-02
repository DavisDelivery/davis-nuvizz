// src/lib/stops-tab.js — WHERE THE DESKTOP "STOPS" TAB LIVES: ON THE BAR WHEN IT FITS, UNDER MORE WHEN IT DOES NOT.
//
// Chad, 2026-09-30: "take the stops out of the more tab drop down and I want to move it into the main
// bar on desktop. Um, probably to the right of routing." — then "Just call it stops not stop lookup now."
//
// THE ROW HAS A FIXED BUDGET. On Routing → Build the same header also carries the board card, the
// presence chip and Build | Engine | Shadow, and the tab row is the only part that shrinks. With Stops
// on it, a 1366px window ran 45px past its space and cut off Messages' unread badge — on Routing the
// only sign a driver or customer has texted (verify-routing-topbar.mjs; measured on v1.99.11, 1180px
// 69px over, 1194px 55px, 1366px 30px with a one-digit badge). So, Chad, 2026-10-02, choosing between
// "on the bar when it fits, under More when it doesn't" and loosening the check: "1 i like your idea".
//
// ONE WIDTH, BOTH SCREENS. The Map's header has more room than Routing's, but a tab that moves when you
// change screens is worse than one that sits in More on a small laptop. The cutoff is the narrowest
// window where Routing → Build holds the row with a 99+ badge on Messages — measured, not reasoned.
export const STOPS_BAR_MIN_WIDTH = 1440;

/** The media query the shell listens to. */
export const STOPS_BAR_QUERY = `(min-width: ${STOPS_BAR_MIN_WIDTH}px)`;

/**
 * PURE. Is a window this wide given the Stops tab on the bar? Anything that is not a finite width
 * (no window, a test) says YES: the bar is the desktop's home for it, and More is the fallback.
 */
export function stopsOnBar(width) {
  const w = Number(width);
  if (width == null || !Number.isFinite(w)) return true;
  return w >= STOPS_BAR_MIN_WIDTH;
}

/** The More menu's row for Stops — offered there ONLY while the bar is not carrying it. */
export const STOPS_MORE_ITEM = Object.freeze({
  id: 'stoplookup',
  label: 'Stops',
  hint: 'Everything we hold about one order — 0 NuVizz calls',
});
