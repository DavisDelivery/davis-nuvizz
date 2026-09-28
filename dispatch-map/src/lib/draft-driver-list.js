// lib/draft-driver-list.js
//
// STEP 4'S BY-DRIVER LIST — PICKED, NOT TYPED. Chad, on the box that read "Victor, Scott":
// "This should be a list that i select from not a type in situation other than type in to find
// the name or route to select."
//
// The list is the drivers who ran a route in the 30 days before the day — the engine's own roster
// (routing-draft GET), so every row is one the draft will accept — and each row carries the route
// names that driver ran most. The box above it only NARROWS the list; it never becomes a name
// the server has to guess at. A pick sends the row's exact driver key.
//
// THE MATCH RULE is the route card's driver search (lib/driver-filter.js), with ROUTES added as
// a field: any order, any field, prefixes, every word must hit. So "suw" finds whoever runs
// SUW 2, "vic m" finds Victor M, and "mike f" narrows rather than widens. Deliberately not fuzzy
// — the wrong driver on a day's freight is a morning on the phone, not a typo.
//
// Pure — no React, no fetch — so the rule is tested without rendering anything.

import { queryWords } from './driver-filter.js';

// The most one draft takes (routing-draft-core runDraft) — said here so the list stops offering
// a fifth row instead of letting the server refuse it.
export const DRAFT_MAX_DRIVERS = 4;

function fields(d) {
  return [d?.name, d?.key, d?.userName, ...(Array.isArray(d?.routes) ? d.routes : [])]
    .filter((v) => v != null && v !== '')
    .map((v) => String(v).toLowerCase());
}

/** Does this driver match every word typed — by name, code or a route they run? */
export function draftDriverMatches(d, query) {
  const words = queryWords(query);
  if (!words.length) return true;
  const fs = fields(d);
  if (!fs.length) return false;
  return words.every((w) => fs.some((f) => f.startsWith(w) || f.split(/[^a-z0-9]+/).some((t) => t.startsWith(w))));
}

/** The list narrowed by the box, left in the order it arrived (A→Z from the server). */
export function filterDraftDrivers(list, query) {
  const all = Array.isArray(list) ? list : [];
  return queryWords(query).length ? all.filter((d) => draftDriverMatches(d, query)) : all;
}

/**
 * Tap a row: add it, or take it off if it was already picked. A fifth pick is refused (returns
 * the picks unchanged) — the row says why rather than the server.
 */
export function togglePick(picked, key, max = DRAFT_MAX_DRIVERS) {
  const cur = Array.isArray(picked) ? picked : [];
  const k = String(key ?? '');
  if (!k) return cur;
  if (cur.includes(k)) return cur.filter((x) => x !== k);
  if (cur.length >= max) return cur;
  return [...cur, k];
}

/**
 * Picks that are still on the list after it reloads (another date) — a driver who is not on the
 * new day's list is dropped from the picks, never sent for a day the engine cannot draft them.
 */
export function keepListedPicks(picked, list) {
  const keys = new Set((Array.isArray(list) ? list : []).map((d) => String(d?.key ?? '')));
  return (Array.isArray(picked) ? picked : []).filter((k) => keys.has(String(k)));
}

/** "Tractor" / "Box truck" — what a row says about the truck the draft will plan them on. */
export function draftDriverClassLabel(truckClass) {
  return truckClass === 'tractor' ? 'Tractor' : 'Box truck';
}
