// lib/wb-stop-load.js — A COMPARE CARD FINDS ITS LOAD BY THE NUMBER ITS OWN STOPS CARRY.
//
// Chad, 2026-09-30, with STEVEN 1 in the Routes panel and the card refusing to open: "STEVEN1 HOW
// CAN IT NOT FIND THE LOAD I LITERALLY SHOWED IT TO YOU IN DISPATCH MAP. THE MANUAL REFRESH BUTTON
// WHICH I HAD HIT BEFORE SHOULD OF PICKED UP THE LOAD AND LOAD NUMBER WITH THE ROSTER SCAN."
//
// WHAT HAPPENED, read off the scan log, the stored rosters and the load's own id — not reasoned:
//   5:12 and 5:29 AM ET  two manual refreshes; each pulled that morning's roster.
//   5:49 AM              STEVEN 1 built in the portal (the timestamp inside its load id).
//   6:00 and 6:15 AM     the stop scans put its 17 orders on the board — and every routed order
//                        in those scans carried its load NUMBER (2,625 of 2,625 at 6:15).
//   6:30 AM              the next hourly roster pull, the first that could name STEVEN 1.
// For those 40 minutes the card had nowhere to look. A list row never carries a load id (only
// the one-time /stop/info enrichment adds one), and buildWbCard asked the stored roster by NAME
// and nothing else. The number riding on every one of its orders (nuvizzLoadNbr, v1.81.6) was
// never read — the board feed did not even serve it (LEAN_STOP_FIELDS, board-fields.mts).
//
// THE RULE. When the roster, a stop's load id and the own-day look-back all fail, the route's own
// stops name the load: if every stop that carries a load number carries the SAME one, that is the
// load — the one name that does not repeat from day to day. Two different numbers under one route
// name → refuse, naming both, because route names repeat and the stops then disagree about which
// load this card is. Nothing is guessed: a row with no number (the write grace holds a moved order
// at null until the list catches up, never at the old load's number) simply does not vote.
//
// A ROW OUR OWN SAVE JUST RE-ROUTED DOES NOT VOTE EITHER. The write-through (patchBoardPlan) and
// the browser's post-save overlay (applyPlanOverlay) both rewrite the route NAME and keep the rest
// of the row — so until the next scan re-reads it, a moved order carries its OLD load's number
// under its NEW route. Those rows are the ones stamped board_write_at (server) or planOverlay
// (browser); the scan drops the stamp once the list agrees. Skipping them can only make a card
// refuse where it would otherwise open on the wrong load — the safe direction.
//
// THE WAY BACK: VITE_WB_STOP_LOADNBR=off (house shape — default on, an off-word turns it off,
// anything malformed leaves it on). A VITE_ flag is build-time, so flipping it is a redeploy.
import { looksLikeLoadNbr } from './route-identity.js';

export function wbStopLoadNbrEnabled(env) {
  const v = String(env?.VITE_WB_STOP_LOADNBR ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/**
 * PURE. The NuVizz load number a route's own stops carry.
 *   → { loadNbr }           every numbered stop names the same load
 *   → { conflict: [a, b] }  the stops name two or more loads (sorted, each once)
 *   → null                  no stop carries a load-number-shaped value
 */
export function stopLoadNbrIdentity(routeStops) {
  const seen = new Set();
  for (const s of routeStops || []) {
    if (!s || s.planOverlay === true || s.board_write_at) continue;   // just re-routed by our Save
    const v = s.nuvizzLoadNbr != null ? String(s.nuvizzLoadNbr).trim() : '';
    if (v && looksLikeLoadNbr(v)) seen.add(v);
  }
  if (!seen.size) return null;
  const nbrs = [...seen].sort();
  return nbrs.length === 1 ? { loadNbr: nbrs[0] } : { conflict: nbrs };
}
