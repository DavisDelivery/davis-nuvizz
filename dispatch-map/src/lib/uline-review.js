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
          // The profile's "No tractor trailer" chip and the list lock — what a tick changes and
          // what its Undo must put back exactly (v1.62.2).
          ntt: (Array.isArray(note?.equipment_restrictions) ? note.equipment_restrictions : []).includes(NO_TRACTOR_KEY),
          restrictionLock: restrictionLockOf(note),
          // Uline's own stamp on the profile — always on at load (it is what put the row here);
          // Tractor OK takes it off (v1.62.3), and Undo needs to know it was there.
          ulineOn: hasUlineAdvisory(note),
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
 * The vehicle-mark fields a decision writes.
 *
 * The same three the Routing brush and the stop card write (App.jsx markEligibility and the two
 * notes saves), so a location decided here is indistinguishable from one decided there — and a
 * change of mind on either screen reads back correctly on the other. Never auto_scan_dismissed,
 * and Uline's own flag is never REMOVED from the list: the scanner re-adds it on every Uline
 * order. A "No tractor trailer" answer ALSO ticks the profile's restriction — see
 * noTractorTickFields below, which is the one list write this screen makes, and why it is safe.
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

// ── "NO TRACTOR TRAILER" TICKS THE CUSTOMER PROFILE TOO (v1.62.2) ──────────────────
//
// Chad, after answering No tractor trailer here and opening the customer: "if i select no tractor
// trailer it should then select the no tractor trailer icon on the customer profile and it
// didn't." It did not because this screen wrote only the Vehicle mark (Box truck only), and the
// stop card keeps that and the Equipment restrictions chip as two separate statements on purpose
// (v0.99.3). So the answer now writes both — the chip EXACTLY as the stop card's own toggle
// writes it (App.jsx toggleRestriction):
//
//   equipment_restrictions ∪ 'no_tractor_trailer'
//   manual_overrides.equipment_restrictions = true        ← the lock
//
// THE LOCK IS NOT OPTIONAL. It is what makes the tick a PERSON's: restrictionConfidence reads
// every key on a locked list as confirmed, so the pin draws a solid "no" instead of Uline's
// half-and-half. And without it the scanner's legacy migration (customer-notes-writer.ts) swaps
// a no_tractor_trailer that old scans tagged from Uline's order text back to the Uline advisory:
// the tick would vanish on the next scan. With it the scanner never touches the list again —
// the same thing that happens when a dispatcher ticks the chip on the stop card.
//
// WHAT IT DOES NOT CHANGE, read off the code: the router already holds a box-only customer off
// a tractor (routing-build-background equipmentReqsFrom), and the 9pm trailer alert already
// treats a box-only customer riding a tractor route as a conflict (trailer-block
// dispatcherTrailerBlock). The tick changes what the profile and
// the pin SAY, not which trucks or which alerts.
//
// arrayUnion, not the list re-written: rows do not carry the whole list, and a read-modify-write
// would drop anything added between the read and the press. The sentinels are injected (`fv`:
// arrayUnion / arrayRemove / deleteField from firebase/firestore) so this module stays pure.
export const NO_TRACTOR_KEY = 'no_tractor_trailer';

/** Is the lock on — true / false as stored, null when the field is absent. Undo needs the three. */
export function restrictionLockOf(note) {
  const v = note?.manual_overrides?.equipment_restrictions;
  return v === true ? true : v === false ? false : null;
}

/** The profile half of a "No tractor trailer" answer. */
export function noTractorTickFields(fv) {
  return {
    equipment_restrictions: fv.arrayUnion(NO_TRACTOR_KEY),
    manual_overrides: { equipment_restrictions: true },
  };
}

/** The whole "No tractor trailer" answer: Box truck only AND the profile's chip, one write. */
export function noTractorWrite(matchKey, stamp, fv) {
  return { ...eligibilityPayload(matchKey, 'box_only', stamp), ...noTractorTickFields(fv) };
}

/** What the row holds, restriction-wise — the snapshot Undo restores. */
export function restrictionSnapshot(row) {
  return {
    ntt: row?.ntt === true,
    ulineOn: row?.ulineOn !== false,
    restrictionLock: row?.restrictionLock === true ? true : row?.restrictionLock === false ? false : null,
    baseDecision: row?.baseDecision || 'undecided',
  };
}

/** The row after a tick: the chip lit, the list locked — so a person's "no" now stands under the
 *  vehicle mark, exactly as ulineDecision would read the note on the next load. */
export const TICKED = Object.freeze({ ntt: true, restrictionLock: true, baseDecision: 'confirmed' });

/** Undo of the tick: exactly what was there. The key comes off only if this press put it on; the
 *  lock goes back to its old value, or is DELETED when there was none. */
export function noTractorUntickFields(was, fv) {
  const out = {};
  if (was?.ntt !== true) out.equipment_restrictions = fv.arrayRemove(NO_TRACTOR_KEY);
  if (was?.restrictionLock !== true) {
    out.manual_overrides = { equipment_restrictions: was?.restrictionLock === false ? false : fv.deleteField() };
  }
  return out;
}

// ── "TRACTOR OK" TAKES ULINE'S STAMP OFF THE CUSTOMER PROFILE (v1.62.3) ────────────────
//
// Chad, the day the tick shipped: "same thing if we marked it tractor ok it should remove the
// uline straight truck advisory stamp on the order profile." So Tractor OK now writes what a
// dispatcher unticking "Uline: straight truck (advisory)" on the stop card writes — the stop
// card's own toggle (App.jsx toggleRestriction), key out and list locked:
//
//   equipment_restrictions − 'uline_straight_truck'
//   manual_overrides.equipment_restrictions = true        ← the lock
//
// THE LOCK IS WHAT MAKES THE REMOVAL STICK, and that is the whole reason v1.60.0 left the list
// alone: the scanner adds every flag it detects to an UNLOCKED list on every scan
// (customer-notes-writer.ts), and Uline writes "straight truck" on every order — so an unlocked
// removal comes back with the next Uline order. The scanner's own dismiss list
// (auto_scan_dismissed) would also stop it, but nothing in this app writes that field; the lock is
// the path a person already uses, and the one the stop card shows.
//
// WHAT IT DOES NOT CHANGE, read off the code: Tractor OK already let the router send a 53′
// (vehicle_eligibility 'tractor' drops every trailer blocker, equipmentReqsFrom) and already kept
// the 9pm alert quiet (dispatcherTrailerBlock returns early on 'tractor'). The stamp coming off
// changes what the profile and the pin say — and the customer leaves this tab on the next load,
// because Uline's stamp is what put it here.
//
// Only offered where no person's no stands (Tractor OK is an undecided row's answer, and Change
// to Tractor OK needs canMoveTowardTractor). The one trailer blocker that can still sit ADVISORY on
// such a list is a legacy no_tractor_trailer the v0.2.0 scanner lifted from Uline's text
// (restrictionConfidence; measured on four boards: none, trailer-block.js). The lock hardens it —
// the chip was already lit on the profile — so the row says so: see afterUlineOff.

/** The profile half of a Tractor OK answer: Uline's stamp off, the list locked. */
export function ulineUntickFields(fv) {
  return {
    equipment_restrictions: fv.arrayRemove(ULINE_KEY),
    manual_overrides: { equipment_restrictions: true },
  };
}

/** The whole Tractor OK answer: Tractor-trailer OK AND Uline's stamp off, one write. */
export function tractorOkWrite(matchKey, stamp, fv) {
  return { ...eligibilityPayload(matchKey, 'tractor', stamp), ...ulineUntickFields(fv) };
}

/** The row after the stamp comes off and the list is locked — what ulineDecision reads off the
 *  written note on the next load. A no_tractor_trailer still on the list becomes a person's once
 *  the list is locked (restrictionConfidence), so the row lands 'confirmed' under the answer. */
export function afterUlineOff(row) {
  return {
    ulineOn: false,
    restrictionLock: true,
    baseDecision: row?.ntt === true ? 'confirmed' : (row?.baseDecision || 'undecided'),
  };
}

/** Undo of taking the stamp off: it goes back on only if it was there; the lock goes back to its
 *  old value, or is DELETED when there was none. */
export function ulineRestoreFields(was, fv) {
  const out = {};
  if (was?.ulineOn !== false) out.equipment_restrictions = fv.arrayUnion(ULINE_KEY);
  if (was?.restrictionLock !== true) {
    out.manual_overrides = { equipment_restrictions: was?.restrictionLock === false ? false : fv.deleteField() };
  }
  return out;
}

/**
 * May this screen move a decided row TOWARD a tractor — Change to Tractor OK, or Clear? Not when
 * a person's "No tractor trailer" stands under the vehicle mark (baseDecision 'confirmed'): the
 * v1.60.0 rule, that Tractor OK drops EVERY trailer restriction and a person's no is changed on
 * the stop card. Once an answer here ticks the profile, that person is the dispatcher who pressed
 * it — Undo right after is the way back; later, the stop card, where both marks sit together.
 */
export function canMoveTowardTractor(row) {
  return (row?.baseDecision || 'undecided') !== 'confirmed';
}

/** The decision a row moves to once `next` is written — pure, so the screen's optimistic update
 *  and the server's next read cannot disagree about where a row belongs. */
export function decisionAfter(row, next) {
  const v = normalizeEligibility(next);
  return v || row?.baseDecision || 'undecided';
}

// ── BUILDING TYPE, FROM THIS SCREEN ─────────────────────────────────────────────
//
// Chad: "also give me options to label building type like this is residential so i would like
// to mark it as such and then would be double duty as residentials we don't allow to be planned
// on tractors as we flag it as well as it would be marked residential."
//
// WHAT THE CODE DID BEFORE THIS, read rather than assumed, because it is not what that sentence
// expects: a Residential building type keeps NOTHING off a tractor. place-mark.js puts only
// school, church and government in NO_TRACTOR_PLACE_MARKS ("Residential is never part of it"),
// and the auto-builder does not read building_type at all — "that rule is deliberately NOT
// written into equipment_restrictions". So "mark it residential" alone would have labelled the
// pin and changed no truck.
//
// SO RESIDENTIAL DOES THE DOUBLE DUTY HE ASKED FOR, EXPLICITLY, IN ONE WRITE: the building type
// AND Box truck only — the one mark the router enforces and the trailer-conflict alert watches.
// Scoped to this press, on purpose. Making every residential in the place rule count as
// no-tractor would re-flag everything Shiplify tags RES across the whole map, and the code does
// not record why residential was left out of that rule — that is a question for Chad, not a
// side effect of a button.

/** The fields a building-type label writes — the same three every stop-card notes save writes
 *  (building_type + _at + _by), so a type set here reads identically everywhere. */
export function buildingTypePayload(matchKey, type, stamp) {
  return {
    match_key: s(matchKey),
    building_type: normalizeBuildingType(type),
    building_type_at: stamp,
    building_type_by: 'dispatcher',
    last_updated: stamp,
  };
}

/** Building types that also mean "no 53′ here", on this screen. Residential only — the one Chad
 *  named. School, church and government already carry the place rule's no-tractor FLAG. */
export const BOX_ONLY_BUILDING_TYPES = new Set(['residential']);

/**
 * One press of a building-type chip → one merged write, and what it did.
 * Returns { fields, eligibility, ticks } — `eligibility` is 'box_only' when the press also
 * decided the vehicle question (so the screen moves the row and Undo restores it), and `ticks`
 * says it also ticked the profile's No tractor trailer: Residential's "no tractor" is the same
 * whole answer the No tractor trailer button gives (v1.62.2), not half of it.
 */
export function buildingTypeWrite(matchKey, type, stamp, fv) {
  const bt = normalizeBuildingType(type);
  const fields = buildingTypePayload(matchKey, bt, stamp);
  if (!BOX_ONLY_BUILDING_TYPES.has(bt)) return { fields, eligibility: undefined, ticks: false };
  return { fields: { ...fields, ...noTractorWrite(matchKey, stamp, fv) }, eligibility: 'box_only', ticks: true };
}

/** The write that puts a press back — building type, the vehicle mark, and the profile tick,
 *  each only when the press moved it. Built from what the row held BEFORE the press, never from a
 *  guess at it. */
export function undoWrite(matchKey, prev, stamp, fv) {
  const fields = {};
  if (prev && 'buildingType' in prev) Object.assign(fields, buildingTypePayload(matchKey, prev.buildingType, stamp));
  if (prev && 'eligibility' in prev) Object.assign(fields, eligibilityPayload(matchKey, prev.eligibility, stamp));
  if (prev && 'restriction' in prev) {
    // One list write per press, so one inverse: the tick comes off (No tractor trailer), or
    // Uline's stamp goes back on (Tractor OK). Firestore takes one transform per field per write.
    const inverse = prev.restriction?.op === 'uline-off' ? ulineRestoreFields : noTractorUntickFields;
    Object.assign(fields, { match_key: s(matchKey), ...inverse(prev.restriction, fv), last_updated: stamp });
  }
  return fields;
}
