// src/lib/cancel-guard.js — the "this will CANCEL the route" Save gate (PURE).
//
// Emptying a load is the one Compare edit that DESTROYS something: removing every delivery
// cancels the route in NuVizz — the load stops existing, its orders go back to Un-Planned,
// and there is no undo in this app (rebuilding means creating the route again in the portal).
// v0.54.17 made the last stop removable and v0.54.18 taught the board to notice, so the
// destructive path is now fully reachable — and it was gated by nothing but a toast that
// appears at the same moment the write fires.
//
// Every OTHER Save stays exactly as it is: direct-commit, no popup (that was a deliberate
// call — see onPanelSave). This helper isolates the one case that earns an interruption, so
// the gate can never widen to ordinary saves by accident: it reads the BUILT payload (the
// same object the write sends), and a load qualifies ONLY on the explicit emptyLoad flag the
// payload builder sets when a card's order list reaches zero.
//
// Returns one descriptor per cancelling load: { routeName, loadNbr, loadId, orderCount }.
// orderCount is how many orders that cancel returns to Un-Planned (removeStopNbrs — what the
// builder puts there for an emptied card is its whole order list). Empty array = an ordinary
// Save, so `cancelsIn(loads).length` is the whole gate condition.
export function cancelsIn(loads) {
  if (!Array.isArray(loads)) return [];
  return loads
    .filter((L) => L && L.emptyLoad === true)
    .map((L) => ({
      routeName: String(L.routeName ?? '').trim() || null,
      loadNbr: L.loadNbr ?? null,
      loadId: L.loadId ?? null,
      orderCount: Array.isArray(L.removeStopNbrs) ? L.removeStopNbrs.length : 0,
    }));
}

// Plain-English summary for the modal body. `nameOf` resolves a display label (App passes
// loadDisplayName so a hex Loads-grid id never reaches the dispatcher as a "route name").
// Kept pure + separate so the wording is asserted in test rather than read off a screenshot.
export function cancelSummary(cancels, nameOf = (c) => c.routeName || c.loadNbr || 'this load') {
  const n = cancels.length;
  if (!n) return '';
  const orders = cancels.reduce((sum, c) => sum + (c.orderCount || 0), 0);
  const names = cancels.map((c) => nameOf(c) || 'this load');
  const list = names.length === 1 ? names[0]
    : names.length === 2 ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const routeWord = n === 1 ? 'route' : 'routes';
  const orderPart = orders === 1 ? '1 order' : `${orders} orders`;
  return `Saving now DELETES ${n === 1 ? 'the' : ''} ${routeWord} ${list} in NuVizz. ${orderPart.charAt(0).toUpperCase()}${orderPart.slice(1)} ${orders === 1 ? 'goes' : 'go'} back to Un-Planned. This cannot be undone from this app — rebuilding means creating the route again in NuVizz.`
    .replace(/\s+/g, ' ')
    .trim();
}
