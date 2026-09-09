// src/lib/dispatch-all.js — WHICH ROUTES WOULD "DISPATCH ALL" ACTUALLY SEND?
//
// Chad: "In this menu i want a dispatch all button that dispatches every route that hasn't
// been dispatched in the routes menu."
//
// THE LOGISTICS CASE FOR IT, AND THE ONE AGAINST DOING IT NAIVELY. Twenty Draft routes at
// 5am is twenty clicks, each one a small chance of missing a row, and the cost of a MISSED
// dispatch is a truck that leaves with no load on the driver's phone. So the button earns its
// place. But dispatch is the least reversible thing this app does — it releases a load to a
// driver in production NuVizz — so a bulk version must be exactly as picky as the twenty
// clicks it replaces, and it must say what it is about to do before it does it.
//
// THE PICKY PART IS THIS MODULE. It is the SAME eligibility the per-row Dispatch button
// enforces, lifted out so both read one rule and so it can be tested without a browser:
//
//   • the status is still pre-dispatch — NuVizz has not moved the load past it;
//   • a driver is assigned — dispatching to nobody is the one failure mode with no undo
//     that also looks like success;
//   • the load id resolves — the write needs it, and "not loaded yet" is not "not there".
//
// NOTHING IS SILENTLY DROPPED. A route that cannot go comes back in `skipped` with the
// reason in words, because a bulk action that reports "18 dispatched" while quietly passing
// over four is the failure this repo has a rule about: a preflight that skips in silence is
// worse than no preflight, because it is believed.

/** The lifecycle states a load can still be dispatched FROM. Mirrors the per-row button. */
export const DISPATCHABLE_STATUSES = ['Draft', 'Un-Planned', 'Unassigned', 'Planned'];

const nameOf = (g) => String(g?.name || g?.loadNbr || g?.key || '').trim() || 'Unnamed load';

/**
 * PURE. Split the visible routes into what Dispatch all would send and what it would not.
 *
 * @param groups      the route rows the panel is showing (the FILTERED list — the button
 *                    acts on what is on screen, so a status filter narrows it, which is the
 *                    only behaviour that cannot surprise anyone).
 * @param driverFor   (g) => driver name or null — includes the optimistic just-assigned
 *                    override, exactly as the row does.
 * @param loadIdFor   (g) => NuVizz load id or null — the roster lookup the write needs.
 * @returns {{eligible: object[], skipped: {name: string, reason: string}[], alreadyDispatched: number}}
 */
export function planDispatchAll({ groups = [], driverFor = () => null, loadIdFor = () => null } = {}) {
  const eligible = [];
  const skipped = [];
  let alreadyDispatched = 0;
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g) continue;
    const name = nameOf(g);
    if (!DISPATCHABLE_STATUSES.includes(g.status)) {
      // Not a problem and not worth listing one by one — a board of dispatched routes would
      // bury the four that need a driver under eighteen that need nothing.
      alreadyDispatched += 1;
      continue;
    }
    if (!driverFor(g)) { skipped.push({ name, reason: 'no driver assigned' }); continue; }
    if (!loadIdFor(g)) { skipped.push({ name, reason: 'NuVizz load id not loaded yet' }); continue; }
    eligible.push(g);
  }
  return { eligible, skipped, alreadyDispatched };
}

/** The confirm modal's line for one route — what the dispatcher is agreeing to, per load. */
export function dispatchPlanLines(eligible, driverFor) {
  return (eligible || []).map((g) => `Dispatch ${nameOf(g)} → ${driverFor(g) || '(no driver)'}`);
}

/**
 * PURE. The sentence a bulk run reports when it finishes.
 *
 * NEVER "✓ done". Every failure is named, because the whole risk of a bulk write is that the
 * successes drown the one truck that did not get its load.
 */
export function dispatchAllSummary(results = []) {
  const ok = results.filter((r) => r?.ok);
  const bad = results.filter((r) => r && !r.ok);
  if (!results.length) return 'Nothing to dispatch.';
  if (!bad.length) return `✓ ${ok.length} route${ok.length === 1 ? '' : 's'} dispatched.`;
  const named = bad.slice(0, 4).map((r) => `${r.name}${r.error ? ` (${r.error})` : ''}`).join(', ');
  const more = bad.length > 4 ? ` +${bad.length - 4} more` : '';
  return `${ok.length} dispatched · ${bad.length} FAILED: ${named}${more}`;
}
