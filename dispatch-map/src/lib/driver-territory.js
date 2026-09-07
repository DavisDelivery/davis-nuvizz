// src/lib/driver-territory.js — WHOSE AREA IS THIS? (PURE)
//
// Chad: "design a map for a trainee so they have a general idea where drivers most frequent
// areas are ... I was thinking circles or ovals of where their general work area is if you can
// think of a better way please present it as well." And: "I know there are a few drivers this
// probably won't work great for like rasko or chris."
//
// ── WHY NOT CIRCLES, WHICH IS THE WHOLE DESIGN ARGUMENT ─────────────────────────────────────
//
// The trainee's real question is not "what shape is Rasko's territory". It is "this order is in
// Dacula — whose is it?" That is a question about a PLACE, and a circle answers a different one
// badly:
//
//   • A driver with TWO clusters gets a circle centred between them, on countryside he never
//     visits. Not imprecise — WRONG, and a trainee cannot tell it is wrong. Chad named this
//     failure himself before any code was written.
//   • Real routes follow corridors (I-85, GA-316): long and thin. A circle wide enough to cover
//     one covers everything either side of it too.
//   • Twenty translucent circles over one metro area is unreadable.
//
// So this module never fits a shape. It asks each PLACE who serves it, and lets the answer have
// whatever shape it has. A driver who scatters simply owns few places, which is the truth rather
// than a misleading blob.
//
// ── WHY ZIP ─────────────────────────────────────────────────────────────────────────────────
//
// `zip` and `city` arrive on EVERY stop free from the NuVizz saved search (nuvizz-list normalize
// → toBoardStop), with no geocoding. Coordinates are geocoded and therefore partial, so a
// coordinate-based grid would silently cover fewer stops and nobody would know which. ZIP is
// ~100% and it is also the unit dispatchers already speak in.
//
// ── ABSENT IS NOT ZERO, AGAIN ───────────────────────────────────────────────────────────────
//
// "Nobody covers this ZIP" and "we have no history for this ZIP" are opposite facts and this
// repo has now been bitten by conflating them in four places. A ZIP with no rows is simply not
// in the output; the caller renders that as unknown, never as unserved.
//
// PURE: no Firestore, no network, no clock. Every decision is testable on plain data.

/** A stop contributes to a territory only if we can place it AND attribute it. */
export function usableStop(s) {
  if (!s) return false;
  return !!zipOf(s) && !!driverKeyOf(s);
}

/** 5-digit ZIP, or null. NuVizz sometimes carries ZIP+4 ("30518-1234") and stray whitespace. */
export function zipOf(s) {
  const raw = String(s?.zip ?? '').trim();
  const m = raw.match(/^(\d{5})(?:-\d{4})?$/);
  return m ? m[1] : null;
}

/**
 * The driver a stop is attributed to.
 *
 * Prefers driverUserName (the stable key the history warehouse itself uses — driverKeyFor in
 * history-derive.mts) over the display name, because the display name is the field that has
 * historically arrived as a bare ObjectId (#254) and because two people can share a first name.
 */
export function driverKeyOf(s) {
  const u = String(s?.driverUserName ?? '').trim();
  if (u) return u.toUpperCase().replace(/\s+/g, '_');
  const n = String(s?.driverName ?? '').trim();
  if (!n) return null;
  return n.toUpperCase().replace(/\s+/g, '_');
}

/** The human label for a driver key — the display name when we have one, else the key. */
export function driverLabelOf(s) {
  const n = String(s?.driverName ?? '').trim();
  return n || driverKeyOf(s) || 'Unknown';
}

/**
 * A CARRIER IS NOT A DRIVER, AND A TRAINEE MUST NOT BE TAUGHT OTHERWISE.
 *
 * Freight handed to a line-haul carrier carries that carrier's name where a driver name would
 * be — the repo already trips over this elsewhere ("AVRT-0028093763", "ESTES-0538243875"). Shown
 * on a territory sheet, "ESTES" reads as a person with a patch, and a trainee would try to give
 * them a stop. `roster` is the authoritative list of real drivers (nuvizzRoster); when it is
 * available nothing outside it is a driver. With NO roster we do not guess — everything is kept
 * and the caller is told the list is unfiltered, because silently dropping a real driver is the
 * worse error of the two.
 */
export function isDriver(key, roster) {
  if (!key) return false;
  if (!roster || !roster.size) return true;          // no roster → keep everything, say so
  return roster.has(String(key).toUpperCase());
}

/**
 * PER-ZIP OWNERSHIP. For each ZIP: who serves it, how often, who serves it MOST, and how
 * dominant that is.
 *
 * `share` is the owner's fraction of that ZIP's stops. It is reported rather than thresholded:
 * a pale, contested ZIP is a true and useful thing for a trainee to see ("several people run
 * here — ask"), and picking a cutoff would turn that into a false certainty.
 */
export function zipOwnership(stops = [], opts = {}) {
  const roster = opts.roster || null;
  const byZip = new Map();
  for (const s of stops || []) {
    if (!usableStop(s)) continue;
    const key = driverKeyOf(s);
    if (!isDriver(key, roster)) continue;
    const zip = zipOf(s);
    if (!byZip.has(zip)) byZip.set(zip, { zip, city: null, total: 0, drivers: new Map(), labels: new Map() });
    const z = byZip.get(zip);
    z.total += 1;
    z.drivers.set(key, (z.drivers.get(key) || 0) + 1);
    if (!z.labels.has(key)) z.labels.set(key, driverLabelOf(s));
    // The city name a trainee actually reads. First non-empty wins; ZIPs do not straddle
    // cities often enough to be worth more than that, and a blank must never overwrite a name.
    if (!z.city) { const c = String(s.city ?? '').trim(); if (c) z.city = c; }
  }
  const out = [];
  for (const z of byZip.values()) {
    const ranked = [...z.drivers.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    const [ownerKey, ownerStops] = ranked[0];
    out.push({
      zip: z.zip,
      city: z.city || null,
      total: z.total,
      owner: ownerKey,
      ownerLabel: z.labels.get(ownerKey) || ownerKey,
      ownerStops,
      share: z.total ? ownerStops / z.total : 0,
      // Everyone else who has run it, so "also seen" is a fact rather than an omission.
      others: ranked.slice(1).map(([k, n]) => ({ key: k, label: z.labels.get(k) || k, stops: n })),
      contested: ranked.length > 1,
    });
  }
  // Busiest first: a printed sheet should lead with the ZIPs a trainee meets most.
  return out.sort((a, b) => b.total - a.total || a.zip.localeCompare(b.zip));
}

/**
 * A DRIVER'S CORE, WITHOUT DRAWING A SHAPE AROUND IT.
 *
 * The smallest set of ZIPs covering `coverage` of a driver's stops (default 80%), plus the tail
 * they range into beyond it. This is Chad's "general work area" answered honestly: for a
 * compact driver the core is a handful of adjacent ZIPs and reads exactly like the oval he
 * imagined; for a scattered one the core is large and the tail is long, which SAYS "this driver
 * does not have a patch" instead of inventing one.
 */
export function driverCore(stops = [], opts = {}) {
  const coverage = typeof opts.coverage === 'number' ? opts.coverage : 0.8;
  const roster = opts.roster || null;
  const byDriver = new Map();
  for (const s of stops || []) {
    if (!usableStop(s)) continue;
    const key = driverKeyOf(s);
    if (!isDriver(key, roster)) continue;
    if (!byDriver.has(key)) byDriver.set(key, { key, label: driverLabelOf(s), total: 0, zips: new Map(), cities: new Map() });
    const d = byDriver.get(key);
    d.total += 1;
    const zip = zipOf(s);
    d.zips.set(zip, (d.zips.get(zip) || 0) + 1);
    const c = String(s.city ?? '').trim();
    if (c) d.cities.set(zip, d.cities.get(zip) || c);
  }
  const out = [];
  for (const d of byDriver.values()) {
    const ranked = [...d.zips.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const core = [];
    let acc = 0;
    for (const [zip, n] of ranked) {
      // The stop that CROSSES the threshold belongs inside the core, not outside it: stopping
      // before it would report a core covering less than the coverage it claims.
      core.push({ zip, city: d.cities.get(zip) || null, stops: n });
      acc += n;
      if (acc / d.total >= coverage) break;
    }
    const coreZips = new Set(core.map((c) => c.zip));
    const tail = ranked.filter(([z]) => !coreZips.has(z)).map(([zip, n]) => ({ zip, city: d.cities.get(zip) || null, stops: n }));
    out.push({
      key: d.key,
      label: d.label,
      total: d.total,
      core,
      coreShare: d.total ? acc / d.total : 0,
      tail,
      zipCount: ranked.length,
      // A driver whose core needs many ZIPs has no compact patch. Reported as a number so the
      // sheet can SAY so rather than drawing a circle that implies one.
      concentrated: core.length <= 6,
    });
  }
  return out.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

/**
 * WHAT THIS SHEET IS AND IS NOT BUILT FROM — the coverage a reader needs to judge it by.
 *
 * A territory sheet printed from three days of data looks identical to one printed from three
 * months, and a trainee cannot tell. So every render carries this, and the caller prints it.
 */
export function territoryCoverage(stops = [], opts = {}) {
  const roster = opts.roster || null;
  const total = (stops || []).length;
  let noZip = 0, noDriver = 0, withCoords = 0, filteredOut = 0;
  const days = new Set();
  for (const s of stops || []) {
    if (!s) continue;
    if (s.boardDate || s.date) days.add(String(s.boardDate || s.date));
    if (!zipOf(s)) noZip++;
    const key = driverKeyOf(s);
    if (!key) noDriver++;
    else if (!isDriver(key, roster)) filteredOut++;
    if (Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng))) withCoords++;
  }
  const usable = (stops || []).filter((s) => usableStop(s) && isDriver(driverKeyOf(s), roster)).length;
  return {
    stops: total,
    usable,
    days: days.size,
    noZip,
    noDriver,
    nonDriver: filteredOut,
    withCoords,
    coordShare: total ? withCoords / total : 0,
    rosterApplied: !!(roster && roster.size),
  };
}
