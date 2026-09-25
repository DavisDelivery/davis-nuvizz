// lib/wb-own-day.js — A ROUTE IN THE ROUTES PANEL OPENS IN COMPARE, EVEN WHEN NUVIZZ DATED IT YESTERDAY.
//
// Chad, 2026-09-24, with ESTES APPT listed in the Routes panel and refusing to open: "if its panel
// for routes it should load."
//
// WHY IT REFUSED. A Compare card must know its NuVizz load (number or id) or a Save is refused and
// strands every stop moved onto it — so buildWbCard looks the route up in the SELECTED DAY's load
// roster. ESTES APPT was not there: its load (DAVIS000204757, Draft) is on 9/23's roster, and its
// four stops still carry NuVizz's 9/23 arrival date. The scan files an OPEN stop that is on a
// route forward onto today (boardDayFor's live-route clamp), so the route showed on 9/24's Routes
// panel while its load lived on 9/23's roster. Two screens, two days, one route.
//
// THE RULE. When the selected day's roster cannot name the load and no stop carries a load id,
// look on the roster of the day NuVizz itself files those stops under — their own arrival day —
// and take the load that owns the route name THERE. Deliberately narrow, because route names
// repeat every day and the wrong same-named load is the one thing a card must never save to:
//   • every OPEN stop on the route must share ONE own day, and it must be before the board day
//     (finished stops are pinned to the day they finished, so they say nothing about the load);
//   • that day's roster must have exactly one load owning the name, by the same resolveNameOwner
//     rule the screen already uses (a cancelled twin loses; two live loads → nobody speaks);
//   • a cancelled load never speaks for live freight.
// Anything short of that keeps today's refusal, word for word.
//
// THE WAY BACK: VITE_WB_OWN_DAY_ROSTER=off (house shape — default on, an off-word turns it off,
// anything malformed leaves it on). A VITE_ flag is build-time, so flipping it is a redeploy.
import { resolveNameOwner } from './route-status.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FINISHED = new Set(['DELIVERED', 'EXCEPTION', 'CANCELLED']);

export function wbOwnDayRosterEnabled(env) {
  const v = String(env?.VITE_WB_OWN_DAY_ROSTER ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** PURE. The one earlier day NuVizz files every open stop of this route under, or null. */
export function routeOwnDay(routeStops, boardDate) {
  if (!DAY.test(String(boardDate || ''))) return null;
  const open = (routeStops || []).filter((s) => s && !FINISHED.has(String(s.normalizedStatus || '').toUpperCase()));
  if (!open.length) return null;
  const days = new Set(open.map((s) => String(s.boardDate || '')));
  if (days.size !== 1) return null;
  const [d] = days;
  if (!DAY.test(d) || d >= boardDate) return null;
  return d;
}

/** PURE. The load that owns `name` on that day's roster, as a card identity — or null. */
export function ownDayIdentity(rosterLoads, name) {
  const { load, ambiguous } = resolveNameOwner(name, rosterLoads || []);
  if (ambiguous || !load) return null;
  if (/cancel/i.test(String(load.status || ''))) return null;
  const loadId = load.loadId ? String(load.loadId) : null;
  const loadNbr = load.loadNbr ? String(load.loadNbr) : null;
  if (!loadId && !loadNbr) return null;
  return { loadId, loadNbr, name: String(load.name || ''), status: load.status || null };
}
