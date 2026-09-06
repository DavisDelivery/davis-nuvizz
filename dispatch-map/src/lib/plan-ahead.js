// src/lib/plan-ahead.js — WHICH STANDARD SHELLS TO OFFER ON A DAY NUVIZZ HAS NOT CREATED (PURE)
//
// The load-roster endpoint attaches `shells: { names, from }` when the day being viewed is on
// or after today and NuVizz holds none (or almost none) of the standard route names — see
// netlify/functions/lib/roster-shells.mts for how "standard" is decided and why. The server
// cannot know what THIS screen already shows, so the subtraction happens here:
//
//   • a name already on the ROSTER   — NuVizz has that load; it is a real row, not a shell
//   • a name already on the BOARD    — a route group built out of stops (a load NuVizz created,
//                                       or one this screen created and synced); same thing
//   • a name already on a CARD       — a pending route card is open for it; tapping the shell
//                                       again must not offer a second card for the same name
//   • a name longer than NuVizz's cap — Save would refuse it; see below
//
// What is left is what a dispatcher can still create for the day, in the endpoint's order.

import { ROUTE_FIELD_MAX } from './route-create.js';

const key = (v) => String(v ?? '').trim().toLowerCase();

/**
 * planAheadNames({ shells, rosterLoads, boardNames, pendingNames }) → string[]
 *
 * `shells` is the endpoint's envelope field (or null/undefined when it sent none). Every other
 * list is optional. Returns [] whenever there is nothing to offer, never null.
 */
export function planAheadNames({ shells, rosterLoads = [], boardNames = [], pendingNames = [] } = {}) {
  const names = Array.isArray(shells?.names) ? shells.names : [];
  if (!names.length) return [];
  const taken = new Set();
  for (const l of rosterLoads || []) { const k = key(l?.name); if (k) taken.add(k); }
  for (const n of boardNames || []) { const k = key(n); if (k) taken.add(k); }
  for (const n of pendingNames || []) { const k = key(n); if (k) taken.add(k); }
  const out = [];
  const seen = new Set();
  for (const n of names) {
    const k = key(n);
    if (!k || taken.has(k) || seen.has(k)) continue;
    // A name NuVizz would refuse on Save (its route-name cap) is never offered: a row that
    // toasts a refusal on every tap is a dead row that reads as tappable. He can make that one
    // in the portal, where the cap does not apply the same way.
    if (String(n).trim().length > ROUTE_FIELD_MAX) continue;
    seen.add(k);
    out.push(String(n).trim());
  }
  return out;
}

/** The grid keys its rows by load number; a shell has none, so it gets a key that cannot collide. */
export const SHELL_ROW_PREFIX = 'shell:';
export function shellRowKey(name) { return SHELL_ROW_PREFIX + String(name ?? '').trim(); }
