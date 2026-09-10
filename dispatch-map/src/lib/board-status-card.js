// src/lib/board-status-card.js — what the board-status card shows, and where (PURE).
//
// The card ("805 stops · total pallets · feed freshness · NuVizz call meter") is drawn two
// ways: as the floating pill on the dispatch Map and the phone, and — since Chad asked for it
// off the routing map — as a control ON the desktop app bar whose detail DROPS DOWN from the
// bar. The markup differs; the rule about what is visible must not, and this is that rule.
//
// WHY IT IS A FUNCTION AND NOT TWO `&&`s IN THE JSX. In the pill, the detail and the scan
// error are stacked IN FLOW: they sit one under the other and both can show at once for free.
// In bar mode both are absolutely positioned under the same bar, so rendering them as siblings
// puts an open dropdown and an error on the SAME PIXELS — and the only morning anybody would
// find that is a morning a scan has already failed, which is the worst possible time to lose
// the message telling you so. One panel, and this decides what goes in it.
//
// THE SCAN ERROR IS VISIBLE WHILE COLLAPSED, in both modes. The refresh button lives in the
// always-visible header row, so an error that only exists inside a closed body is feedback
// nobody sees: the icon spins for a minute, goes quiet, and the button reads as broken.

/**
 * @param {{collapsed?: boolean, scanErr?: unknown}} card
 * @returns {{open: boolean, showDetails: boolean, showError: boolean}}
 *   open        — bar mode: render the dropdown panel at all
 *   showDetails — the pallets / freshness / call-meter block
 *   showError   — the scan-error line
 */
export function boardStatusPanel({ collapsed = false, scanErr = null } = {}) {
  const showDetails = collapsed !== true;
  // A blank or whitespace-only error is NOT an error. `Number(null)` being 0 once shipped a
  // customer-service email announcing a midnight deadline for a stop with no deadline at all;
  // an empty string opening an empty red box is the same mistake in a smaller hat, and in bar
  // mode it would also force open a dropdown with nothing in it.
  const showError = typeof scanErr === 'string' ? scanErr.trim().length > 0 : !!scanErr;
  return { open: showDetails || showError, showDetails, showError };
}
