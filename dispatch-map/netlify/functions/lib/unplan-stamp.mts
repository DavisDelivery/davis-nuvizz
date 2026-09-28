// lib/unplan-stamp.mts — ONE RULE, PURE, IMPORTED BY EVERY SURFACE THAT APPLIES IT (v1.77.0).
//
// unplanStampOvertaken lived in nuvizz-list.mts, which imports the NuVizz client, so nothing that
// must never reach NuVizz could apply it — the Claude shadow's planning area among them. It is
// moved here unchanged; nuvizz-list.mts, active-pool.mts and lib/carryover-fold.mts import it.
import { isHashLikeId, looksLikeLoadNbr } from './route-identity.mts';

/**
 * PURE: has the world MOVED ON from a confirmed un-plan, or is the list merely lagging it?
 *
 * WHY THIS EXISTS (Chad, Sep 10 2026, order 007174547): "Why is this order still showing
 * unplanned when it's on Ronald Gates in nuvizz." It was, and the board knew: a Save took it off
 * TREVARR at 6:18am, somebody re-planned it onto RONALD in the portal, and the 6:58 and 7:15 scans
 * BOTH read RONALD off NuVizz's own list and BOTH threw that answer away — because a confirmed
 * un-plan outranked the list for sixty minutes and nothing was allowed to argue. For that hour the
 * order sat in the selection pool looking free while RONALD held it, which is the setup for
 * planning the same freight onto a second truck. His rule: "whatever the scan says is the truth."
 *
 * The grace is not simply wrong, which is why this is a discriminator and not a deletion. It was
 * built because NuVizz's saved-search index lagged an ACCEPTED save by 30+ minutes (OWUSU 1), and
 * a list that has not caught up must never revert a Save the dispatcher watched confirm. The
 * defect was that the un-plan direction had NO way to tell those two apart — the PLANNED direction
 * has the demotion verify (ask the load itself), and the un-plan direction had only a clock.
 *
 * The route name tells them apart for nothing. LAG names the OLD route: we removed it from
 * TREVARR, so a stale index still says TREVARR. A RE-PLAN names a DIFFERENT one: it says RONALD,
 * and it can only say RONALD because it has already seen an event that happened AFTER our Save.
 * A list that has caught up that far is a verdict, not lag.
 *
 * Deliberately NOT released when the list names the SAME route we removed it from: that reading is
 * exactly what a lagging index produces, and taking it would revert a cancelled route's un-plan
 * (nuvizz-write-cancel-through). It stays held by the clock, as before. Closing that last case
 * takes one metered /load/info — the demote verify's own ladder — and is not done here.
 *
 * No from-route on the stamp (written before v1.8.0, or a caller that had no route) → never
 * released: absence of the baseline is not evidence, and this must not guess a stop off a route.
 */
export function unplanStampOvertaken(prior: any, fresh: any): boolean {
  if (prior?.board_write_planned !== false) return false;   // not an un-plan stamp — the planned side has its own verify
  if (fresh?.isPlanned !== true) return false;              // the list agrees it is un-planned; nothing to argue about
  const from = String(prior?.board_write_from ?? '').trim();
  const now = String(fresh?.routeName ?? fresh?.loadNbr ?? '').trim();
  if (!from || !now) return false;                          // cannot tell → hold, exactly as before
  // A BASELINE THAT CANNOT BE COMPARED LIKE FOR LIKE IS NO BASELINE, and this one is the way
  // this rule could LOSE freight rather than merely be slow. Both write-through callers fall
  // back to something that is not a route name when a card has no resolvable one: the server
  // takes the load NUMBER (nuvizz-write.mts — `|| String(p.loadNbr || '')`), the client can take
  // a hex card key. The list always reports the human NAME, so "DAVIS000203388" vs "RONALD"
  // reads as a different route for EVERY such stop — and would release exactly the holds that
  // must stand, on a genuine un-plan the list is merely lagging. Two namespaces are not a
  // disagreement. Refuse to decide, and let the clock hold it as it did before.
  if (looksLikeLoadNbr(from) || isHashLikeId(from)) return false;
  return now.toLowerCase() !== from.toLowerCase();
}
