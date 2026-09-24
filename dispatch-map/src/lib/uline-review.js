// src/lib/uline-review.js — "Uline says straight truck only here. Is Uline right?"
//
// PURE. The rules behind the Uline straight-truck tab in Address history. Imports only other
// pure modules, so the endpoint and the screen read one definition.
//
// Chad: "in our address history we built i want to add a tab inside it of the uline advisory
// straight truck only tab where the ui shows close up views of the building for each flag and
// we can quickly decide if we are going to make it no tractor trailer or not."
//
// WHAT THE FLAG IS, READ OFF THE CODE. `uline_straight_truck` is written by the signal scanner
// when Uline's own order instructions (SPL-INSTR-TEXT) say straight truck — another company's
// free text about its own shipment (customer-notes-writer.ts labels it "Uline-supplied,
// advisory"). The MAP calls it advisory and draws it half-and-half; the 9pm trailer alert
// ignores it (trailer-block.js ADVISORY_ONLY_KEYS).
//
// THE AUTO-BUILDER DOES NOT TREAT IT AS ADVISORY. routing-build-background.mts lists
// uline_straight_truck in TRAILER_BLOCKERS beside no_tractor_trailer, and routing-constraints.mts
// handles it in the same `case`. Every Uline-flagged stop is held off a 53' today whether or not
// one would fit. So this tab is not tidying: a wrong flag is a box-truck slot spent every day
// that customer has freight, and a right one nobody has confirmed is a "no" the map still draws
// as a maybe.
//
// THE DECISION IS A FIELD THAT ALREADY EXISTS — customer_notes.vehicle_eligibility:
//   'box_only' → "No tractor trailer": forced onto a box by the router, solid red on the map,
//                and the trailer-conflict alert fires if someone hand-puts it on a tractor.
//   'tractor'  → "Tractor OK": the router drops every trailer blocker (Uline's included), the
//                map drops them, the alert stands down.
//   unset      → undecided; Uline's advisory keeps holding the stop off a trailer.
// Three readers already agree on those values (map-legend drawnRestrictionKeys and
// tractorPaintAllowed, routing equipmentReqsFrom, trailer-block dispatcherTrailerBlock) and two
// writers already write them (the Routing brush, the stop card's vehicle picker). This is a
// third door into the same room, not a new room — so it cannot disagree with the other two.

import { confirmedBlockerKeys, normalizeEligibility } from './trailer-block.js';
import { normalizeBuildingType } from './place-mark.js';

export const ULINE_KEY = 'uline_straight_truck';

const s = (v) => (v == null ? '' : String(v).trim());

/** Does this note carry Uline's straight-truck advisory? */
export function hasUlineAdvisory(note) {
  const arr = Array.isArray(note?.equipment_restrictions) ? note.equipment_restrictions : [];
  return arr.includes(ULINE_KEY);
}

/**
 * Where a flagged location stands.
 *
 *   'box_only' / 'tractor' — a dispatcher decided, on this tab or anywhere else.
 *   'confirmed'            — a HUMAN already said "no 53'" another way: a ticked restriction,
 *                            a locked restriction list, or a Davis-typed Address 2 mark. The
 *                            question is answered, and a one-tap "Tractor OK" here would
 *                            silently overrule that person — vehicle_eligibility 'tractor'
 *                            drops EVERY trailer blocker, not just Uline's.
 *   'undecided'            — Uline's text is the only thing standing behind the "no". These
 *                            are exactly the stops the map draws half-and-half.
 *
 * 'confirmed' is read with confirmedBlockerKeys, the function the map paints by, so this tab
 * and the pin can never disagree about whether a person has spoken.
 */
export function ulineDecision(note) {
  const elig = normalizeEligibility(note?.vehicle_eligibility);
  if (elig) return elig;
  const keys = Array.isArray(note?.equipment_restrictions) ? note.equipment_restrictions : [];
  if (confirmedBlockerKeys(note, keys).length) return 'confirmed';
  return 'undecided';
}

/** What Uline actually wrote, deduped and whitespace-collapsed. The strongest single piece of
 *  evidence on the card: "STRAIGHT TRUCK ONLY - NO 53FT" and a vague "small truck preferred"
 *  are very different claims, and the flag alone cannot tell them apart. */
export function ulineWords(note, max = 3) {
  const list = note?.auto_matches?.[ULINE_KEY];
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const t = s(m?.text).replace(/\s+/g, ' ');
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Compass bearing, degrees in [0, 360), from `a` to `b`.
 *
 * Street View opens facing wherever the camera car was driving, which on a frontage road is
 * parallel to the building — a picture of the road. Pointing the camera from the panorama to the
 * pin is what makes it a view OF THE BUILDING. Computed here rather than via the Maps geometry
 * library because the app's loader does not request that library, and a pure function can be
 * tested without a browser.
 */
export function bearingDeg(a, b) {
  const lat1 = Number(a?.lat), lng1 = Number(a?.lng), lat2 = Number(b?.lat), lng2 = Number(b?.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return 0;
  const r = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

export const DECISION_RANK = { undecided: 0, confirmed: 1, box_only: 2, tractor: 3 };

/**
 * One row per LOCATION, not per stop.
 *
 * The decision is keyed by location (customer_notes, by matchKey) and holds for every future
 * order there — so three stops for one customer across three board days are one question, and
 * listing it three times invites three answers. The row carries every stop it covers so the
 * dispatcher can see what freight is riding on the answer.
 *
 * `positionOf` / `addressOf` are INJECTED, not imported: the endpoint passes board-flags'
 * stopPosition and address-log's shownAddress — the same pin and the same address every other
 * screen draws — without this module importing a 10,000-line file to get them.
 */
export function buildUlineRows(days, notesByKey, { positionOf, addressOf, tractorOf } = {}) {
  const byKey = new Map();
  for (const day of days || []) {
    for (const stop of day?.stops || []) {
      const mk = s(stop?.matchKey);
      if (!mk) continue;
      const note = notesByKey?.get ? notesByKey.get(mk) : null;
      if (!hasUlineAdvisory(note)) continue;
      let row = byKey.get(mk);
      if (!row) {
        const pos = typeof positionOf === 'function' ? positionOf(stop, note) : null;
        row = {
          key: mk,
          businessName: s(stop?.businessName) || s(note?.raw_name) || mk,
          address: typeof addressOf === 'function' ? addressOf(stop, note) : null,
          pin: pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng) ? { lat: pos.lat, lng: pos.lng, source: pos.source || null } : null,
          stops: [],
          firstDate: s(day?.date),
          decision: ulineDecision(note),
          // WHERE IT GOES BACK TO when the mark is cleared — 'undecided', or 'confirmed' when a
          // person also ticked a restriction. The screen needs this to move a row correctly on
          // Undo without re-reading the note: clearing vehicle_eligibility on a location a
          // dispatcher had separately marked "No tractor trailer" must NOT drop it back into
          // "to decide" as if Uline were the only voice.
          baseDecision: ulineDecision({ ...(note || {}), vehicle_eligibility: null }),
          decidedAt: s(note?.vehicle_eligibility_at) || null,
          decidedBy: s(note?.vehicle_eligibility_by) || null,
          uline: ulineWords(note),
          tractor: null,
          buildingType: normalizeBuildingType(note?.building_type),
        };
        const t = typeof tractorOf === 'function' ? tractorOf(mk) : null;
        if (t && (Number(t.count) > 0 || t.last)) row.tractor = { count: Number(t.count) || 0, last: s(t.last) || null };
        byKey.set(mk, row);
      }
      row.stops.push({
        date: s(day?.date), stopNbr: s(stop?.stopNbr), pro: s(stop?.primaryPro || stop?.pro) || null,
        routeName: s(stop?.routeName) || null, planned: stop?.isPlanned === true,
      });
      if (s(day?.date) && s(day?.date) < row.firstDate) row.firstDate = s(day?.date);
    }
  }
  return sortUlineRows([...byKey.values()]);
}

/** Undecided first; within that, the earliest board day first — today's freight is the truck
 *  about to be assigned, and Thursday's can wait until Thursday is closer. Then by name so the
 *  list does not reshuffle between loads. */
export function sortUlineRows(rows) {
  return [...(rows || [])].sort((a, b) => (DECISION_RANK[a.decision] ?? 9) - (DECISION_RANK[b.decision] ?? 9)
    || String(a.firstDate).localeCompare(String(b.firstDate))
    || String(a.businessName).localeCompare(String(b.businessName)));
}

/**
 * The fields a decision writes, and nothing else.
 *
 * The same three the Routing brush and the stop card write (App.jsx markEligibility and the two
 * notes saves), so a location decided here is indistinguishable from one decided there — and a
 * change of mind on either screen reads back correctly on the other. NEVER the restriction list,
 * never auto_scan_dismissed: `vehicle_eligibility` is the one statement every reader already
 * ranks above the Uline flag, and touching the list would fight the scanner, which re-adds the
 * flag on every Uline order.
 *
 * `stamp` is injected (serverTimestamp in the browser) so this stays pure and testable.
 */
export function eligibilityPayload(matchKey, next, stamp) {
  const value = normalizeEligibility(next);
  return {
    match_key: s(matchKey),
    vehicle_eligibility: value,
    vehicle_eligibility_at: stamp,
    vehicle_eligibility_by: 'dispatcher',
    last_updated: stamp,
  };
}

/** The decision a row moves to once `next` is written — pure, so the screen's optimistic update
 *  and the server's next read cannot disagree about where a row belongs. */
export function decisionAfter(row, next) {
  const v = normalizeEligibility(next);
  return v || row?.baseDecision || 'undecided';
}
