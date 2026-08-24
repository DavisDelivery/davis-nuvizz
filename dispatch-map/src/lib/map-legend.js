// THE LEGEND IS THE KEY TO *THIS* MAP, NOT A CATALOGUE OF EVERY MARK THE APP CAN DRAW.
//
// Chad, looking at the Legend panel on a 760-stop board: "only want it to display any icons
// that are currently on the map." The panel listed all twenty restriction icons plus every
// flag colour every time, so a dispatcher hunting the one pink clock he could see out on the
// satellite had to read past nineteen marks that were not on his board. A key you have to
// filter in your head is a key you stop opening.
//
// WHY THIS IS A MODULE AND NOT A `.filter()` IN THE PANEL. Deciding which icons a stop draws
// is not a one-liner — the marker layer suppresses the time marks behind an AM/PM window,
// suppresses trailer-blockers behind a dispatcher's "tractor OK", and replaces the icons
// outright with a pin when the stop is do-not-send, numbered inside an open route, or muted
// as already-planned. A legend that reimplemented any of that would drift from the map, and
// a legend that disagrees with the map is worse than no legend: it teaches the wrong thing
// with authority. So `drawnRestrictionKeys` lives here and stopMarkerIcon CALLS it. One
// definition, two readers.

import { TIME_MARK_KEYS } from './time-marks.js';

// Restrictions that mean "a 53' trailer cannot serve this stop". A dispatcher who has marked
// the stop tractor-OK by hand has overruled the auto-detected ones, so they stop drawing.
// (Moved here from App.jsx so the legend and the marker share the list rather than copy it.)
export const TRAILER_BLOCKER_KEYS = new Set([
  'no_tractor_trailer', 'box_truck_only', 'straight_truck_only', 'uline_straight_truck',
  'no_53', '26ft_max', 'no_overhead_clearance',
]);

// Why a stop draws a PIN instead of its restriction icons. Order matters only for reporting;
// any one of them hides the icons completely.
export const PIN_OVERRIDES = ['dns', 'inRoute', 'plannedMuted'];

/**
 * Which restriction icons a stop actually DRAWS on the map.
 *
 * @param rawKeys  resolved keys from getRestrictionBadgeKeys (already day-aware)
 * @param opts.deliveryWindow  'AM' | 'PM' | null — an explicit window IS the receiving-time
 *                             statement, so it takes the pin over from the time marks
 * @param opts.eligibility     'tractor' | 'box_only' | null — a hand-set "tractor OK" drops
 *                             the auto-detected trailer blockers
 * @param opts.hidden          true when a pin replaces the icons entirely (DNS / numbered
 *                             route pin / planned-muted). Returns [] — a mark nobody can see
 *                             is not on the map.
 * @param opts.resolve         alias resolver; identity by default
 */
export function drawnRestrictionKeys(rawKeys, opts = {}) {
  const { deliveryWindow = null, eligibility = null, hidden = false, resolve } = opts;
  if (hidden) return [];
  let keys = Array.isArray(rawKeys) ? rawKeys.filter(Boolean) : [];
  if (!keys.length) return [];
  if (deliveryWindow === 'AM' || deliveryWindow === 'PM') {
    keys = keys.filter((k) => !TIME_MARK_KEYS.includes(k));
  }
  if (eligibility === 'tractor') {
    const r = typeof resolve === 'function' ? resolve : (x) => x;
    keys = keys.filter((k) => !TRAILER_BLOCKER_KEYS.has(r(k)));
  }
  return keys;
}

// WHETHER THE TRACTOR-DELIVERED LIME PAINT IS ALLOWED TO SHOW. Chad: "need a no
// tractor trailer override button that will override the green auto paint."
//
// tractor_locations (the lime pin) is a STICKY, AUTOMATIC record: "a tractor delivered
// here once, ever." It never un-flags itself, so it can be years stale — and it says
// nothing about NOW. A dispatcher who has since set vehicle_eligibility to box-only, or
// checked "No tractor trailer" in Equipment restrictions, is stating a CURRENT fact that
// must outrank old history: a customer who called to say "no more 53-footers, we lost
// the turning radius" needs that reflected on the map, not a lime pin still promising a
// tractor-trailer is fine.
//
// Takes the ALREADY-DRAWN restriction keys (drawnRestrictionKeys' output), not the raw
// note, so this can never disagree with the badge that is or is not actually on the pin
// — e.g. a hand-set "tractor OK" already drops no_tractor_trailer from the drawn set
// upstream, and that suppression must read as "paint allowed," not as this function
// re-deciding the same question from raw data a second, possibly different, way.
//
// One function, three call sites (the numbered-route pin, the plain pin, and the
// restriction-icon cluster) — the bug this closes was exactly the three sites
// disagreeing: the plain pin already refused the lime for a hand-set box-only stop,
// while the other two did not, so a dispatcher could check "No tractor trailer," save,
// and watch the icon on the map stay exactly as lime as it was before they touched it.
export function tractorPaintAllowed(eligibility, drawnKeys) {
  const blocked = eligibility === 'box_only' || (drawnKeys || []).includes('no_tractor_trailer');
  return !blocked;
}

// Which of the three "no icon" pin tints a stop wears, mirroring flagColor(). Kept here so
// the swatch list in the legend and the colour on the pin cannot disagree about what purple
// means. Returns a priority-flag key, or 'restricted', or 'plain'.
export function pinTintKind(note) {
  if (note && note.priority_flag) return note.priority_flag;
  if (note && ((note.equipment_restrictions || []).length || note.liftgate_required || note.appointment_required)) {
    return 'restricted';
  }
  return 'plain';
}

// WHICH of a stop's restrictions the marker actually paints. A cluster of four draws the
// first two plus a "+N", so restrictions three and four are on the record but not on the map.
// Both the legend inventory and the marker's own sizing read this, so neither can count a
// mark the other never drew.
export function visibleIconKeys(keys) {
  const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
  return list.length <= 3 ? list : list.slice(0, 2);
}

// How many icons a marker draws in one cluster, as the marker SVG lays it out: one circle,
// two or three side by side, or the first two plus a "+N" overflow.
export function iconClusterShape(count) {
  const n = Number(count) || 0;
  if (n <= 0) return null;
  if (n === 1) return 'single';
  if (n <= 3) return 'multi';
  return 'overflow';
}

export function emptyLegendInventory() {
  return {
    stops: 0,
    withIcons: 0,
    tints: {},                  // flag key / 'restricted' / 'plain' → count
    tractorDelivered: 0,
    iconCounts: {},             // restriction key → count of stops drawing it
    shapes: { single: 0, multi: 0, overflow: 0 },
    hiddenByPin: 0,             // stops whose icons a pin took over (DNS / route pin / muted)
  };
}

/**
 * Fold the stops the map is drawing into what the legend may show.
 *
 * Each entry is one stop AS THE MARKER LAYER SAW IT:
 *   { icons: string[], note: object|null, tractorDelivered: bool, hidden: bool }
 * `icons` must already be the output of drawnRestrictionKeys — this function does not
 * re-derive them, precisely so it cannot derive them differently.
 */
export function buildLegendInventory(entries) {
  const inv = emptyLegendInventory();
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || typeof e !== 'object') continue;
    inv.stops += 1;
    const tint = pinTintKind(e.note || null);
    inv.tints[tint] = (inv.tints[tint] || 0) + 1;
    if (e.tractorDelivered) inv.tractorDelivered += 1;
    if (e.hidden) { inv.hiddenByPin += 1; continue; }
    const icons = Array.isArray(e.icons) ? e.icons.filter(Boolean) : [];
    if (!icons.length) continue;
    inv.withIcons += 1;
    const shape = iconClusterShape(icons.length);
    if (shape) inv.shapes[shape] += 1;
    // A marker showing 4+ restrictions DRAWS only the first two and a "+N", so the third
    // and fourth icons are genuinely not on the map — counting them would put marks in the
    // legend that a dispatcher cannot find anywhere on the board.
    for (const k of new Set(visibleIconKeys(icons))) inv.iconCounts[k] = (inv.iconCounts[k] || 0) + 1;
  }
  return inv;
}

// The icon keys present, in the caller's canonical display order (the RESTRICTION_ICONS key
// order), so filtering never reshuffles the list a dispatcher has learned the shape of.
export function presentIconKeys(inv, order) {
  const counts = (inv && inv.iconCounts) || {};
  const seen = new Set(Object.keys(counts));
  const out = [];
  for (const k of (order || [])) if (seen.has(k)) { out.push(k); seen.delete(k); }
  // Anything the map drew that the order does not list still gets shown — an unknown mark is
  // exactly the one somebody needs explained.
  for (const k of seen) out.push(k);
  return out;
}

// Is there anything at all to show? An empty board must say so rather than render a panel of
// headings with nothing under them, which reads as broken.
export function legendIsEmpty(inv) {
  if (!inv) return true;
  return inv.stops === 0;
}
