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

/**
 * A COORDINATE THAT IS NOT THERE IS NOT ZERO.
 *
 * The board carries `lat: null, lng: null` until a stop is geocoded (nuvizz-list starts every
 * stop that way, and history keeps what the board had). Number(null) is 0 and 0 is finite, so a
 * stop with no position was counted as HAVING one and placed at 0°,0° — off the coast of Africa:
 * a driver with a few of them grew a ring there, those stops were "covered" by it, and the "what
 * this is built from" line counted them as mapped. Blank and null are absent; anything else is
 * read as a number, and NaN stays NaN.
 */
export function coordOf(v) {
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return NaN;
  return Number(v);
}

/**
 * Where a stop is, or null when it has no position we can use.
 *
 * 0°,0° IS "NO POSITION" TOO. nuvizz-scan reads `Number(addr.latitude)` whenever the field is
 * not null, and Number('') is 0 — so a blank the vendor sends becomes exactly 0,0. No Davis
 * delivery is in the Gulf of Guinea; a stop there is a stop nobody geocoded.
 */
export function positionOf(s) {
  const lat = coordOf(s?.lat), lng = coordOf(s?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

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
  const n = String(s?.driverName ?? '').trim();
  const raw = u || n;
  return raw ? canonicalDriver(raw).key : null;
}

/**
 * ONE HUMAN, ONE KEY — the slash rule, and it is Chad's fact, not an inference.
 *
 * The driver field sometimes carries a LOAD name rather than a person: "COLIN/DJ 1". Four
 * comments in this repo read that as a co-driver load, "two drivers on one truck". It is not.
 * Chad: "Colin/dj1 is Colin's second load usually but always Colin never dj."
 *
 * That is a fact about how Davis names loads that nothing in the data could have told me, and
 * getting it wrong on a trainee's sheet costs twice over: COLIN and COLIN/DJ_1 become two
 * drivers with half a territory each, AND a trainee learns that "DJ" is somebody who runs a
 * patch. So the first segment before the slash is the driver, and a trailing load index is not
 * part of anybody's name.
 *
 * ANY REWRITE IS REPORTED (see `rewritten`). A rule inferred from ONE example that silently
 * merges two identities is exactly the kind of confident wrongness this sheet must not print —
 * the caller surfaces every name it changed so Chad can check them rather than trust me.
 */
export function canonicalDriver(raw) {
  const original = String(raw ?? '').trim();
  if (!original) return { key: null, label: '', rewritten: false };
  // "COLIN/DJ 1" → "COLIN". The load's second name is not a second driver.
  let name = original.split('/')[0].trim();
  // "COLIN 2" → "COLIN": a trailing load index would split one man across his own loads. Only a
  // SHORT bare number, so a name that genuinely ends in a numeral is left alone.
  name = name.replace(/\s+\d{1,2}$/, '').trim();
  if (!name) name = original;
  const key = name.toUpperCase().replace(/\s+/g, '_');
  // The vendor spells plenty of names with a double space ("Anthony  Bennett"). The KEY already
  // collapses whitespace, so the two spellings are one driver either way; the LABEL is what gets
  // printed and handed to somebody, so it is tidied. `rewritten` is computed before the tidy —
  // whitespace is not a merge, and reporting it as one would bury the merges that matter.
  return { key, label: name.replace(/\s+/g, ' '), rewritten: name !== original };
}

/**
 * WHICH SPELLING OF A NAME GOES ON THE PRINTED PAGE.
 *
 * One driver reaches us under more than one spelling — the vendor's own rename, and the alias
 * fold, which rewrites a stop's driver to the canonical KEY ("BRENT_BRYD"). Both spellings share
 * a key, so the territory is whole; the label was simply whichever stop happened to be read
 * first, and "BRENT_BRYD" printed on a sheet handed to a trainee looks like a fault in the
 * paperwork. A name a person would write beats a machine key.
 */
export function betterLabel(a, b) {
  const score = (v) => {
    const t = String(v ?? '').trim();
    if (!t) return -1;
    return (/[a-z]/.test(t) ? 2 : 0) + (/\s/.test(t) ? 2 : 0) + (t.includes('_') ? 0 : 1);
  };
  return score(b) > score(a) ? String(b) : String(a);
}

/**
 * Every driver name this sheet rewrote, so a human can check the merges rather than trust them.
 * Absent from the output = nothing was changed, which is a different fact from "no drivers".
 */
export function driverRewrites(stops = []) {
  const seen = new Map();
  for (const s of stops || []) {
    const raw = String(s?.driverUserName ?? '').trim() || String(s?.driverName ?? '').trim();
    if (!raw) continue;
    const c = canonicalDriver(raw);
    if (c.rewritten && !seen.has(raw)) seen.set(raw, c.key);
  }
  return [...seen].map(([from, to]) => ({ from, to })).sort((a, b) => a.from.localeCompare(b.from));
}

/** The human label for a driver key — the display name when we have one, else the key. */
export function driverLabelOf(s) {
  const n = String(s?.driverName ?? '').trim();
  if (n) return canonicalDriver(n).label;
  return driverKeyOf(s) || 'Unknown';
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
/**
 * Build the roster Set from raw NuVizz driver names.
 *
 * The roster arrives spelled the way the vendor spells it, so it can hold "COLIN/DJ 1" — and a
 * raw Set would then fail to match the canonical key COLIN and drop a real driver off the sheet
 * as if he were a carrier. Canonicalising both sides is the only way the comparison means
 * anything; leaving it to the caller is how that gets forgotten.
 */
export function rosterOf(names = []) {
  const out = new Set();
  for (const n of names || []) {
    const k = canonicalDriver(n).key;
    if (k) out.add(k);
  }
  return out;
}

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
  const labels = new Map();
  for (const s of stops || []) {
    if (!usableStop(s)) continue;
    const key = driverKeyOf(s);
    if (!isDriver(key, roster)) continue;
    const zip = zipOf(s);
    if (!byZip.has(zip)) byZip.set(zip, { zip, city: null, total: 0, drivers: new Map() });
    const z = byZip.get(zip);
    z.total += 1;
    z.drivers.set(key, (z.drivers.get(key) || 0) + 1);
    // ONE NAME PER MAN ACROSS THE WHOLE TABLE, not the best spelling seen inside each ZIP: a
    // driver whose only stop in Clarkston came through under the folded key printed as
    // "BRENT_BRYD" in that row and as "Brent Bryd" in the next one, which reads as two people.
    labels.set(key, betterLabel(labels.get(key), driverLabelOf(s)));
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
      ownerLabel: labels.get(ownerKey) || ownerKey,
      ownerStops,
      share: z.total ? ownerStops / z.total : 0,
      // Everyone else who has run it, so "also seen" is a fact rather than an omission.
      others: ranked.slice(1).map(([k, n]) => ({ key: k, label: labels.get(k) || k, stops: n })),
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
    d.label = betterLabel(d.label, driverLabelOf(s));
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
    if (positionOf(s)) withCoords++;
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

// ── ACTIVE DRIVERS ONLY ─────────────────────────────────────────────────────
//
// Chad, reading the first draft: "terry hasn't ran for me in a long time ... just guys that
// have ran in last 4 weeks."
//
// A trainee handed a sheet listing somebody who left, or who has not driven in months, learns a
// territory that does not exist and will try to give them freight. So the window is the filter:
// a driver earns a place by having WORKED in it.
//
// `minStops` is the second half of the same rule. One stop in four weeks is not a territory —
// it is a favour somebody did on a Tuesday — and drawing a circle around it states a pattern
// from a single point. Excluded drivers are RETURNED, not silently dropped, so the sheet can
// say who it left out and why; a name quietly missing is indistinguishable from a name that was
// never there, which is the same absent-is-not-zero mistake in a different coat.
export function activeDrivers(stops = [], opts = {}) {
  const minStops = typeof opts.minStops === 'number' ? opts.minStops : 5;
  // STILL RUNNING, not merely present. A driver who did seventy stops in the first week of the
  // window and nothing since passes any count test — and is precisely the driver Chad was
  // pointing at. So the last day they worked has to be recent, measured against the END of the
  // window rather than against a clock, so re-printing an old window gives the same answer.
  const staleDays = typeof opts.staleDays === 'number' ? opts.staleDays : 14;
  const roster = opts.roster || null;
  const counts = new Map();
  const labels = new Map();
  const lastSeen = new Map();
  for (const s of stops || []) {
    if (!usableStop(s)) continue;
    const key = driverKeyOf(s);
    if (!isDriver(key, roster)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
    labels.set(key, betterLabel(labels.get(key), driverLabelOf(s)));
    const d = String(s.boardDate || s.date || '');
    if (d && (!lastSeen.has(key) || d > lastSeen.get(key))) lastSeen.set(key, d);
  }
  const windowEnd = [...lastSeen.values()].sort().pop() || null;
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const active = new Set();
  const excluded = [];
  for (const [key, n] of counts) {
    const last = lastSeen.get(key) || null;
    const gap = (last && windowEnd) ? daysBetween(last, windowEnd) : 0;
    const why = n < minStops ? 'too few' : (gap > staleDays ? 'stopped running' : null);
    if (!why) active.add(key);
    else excluded.push({ key, label: labels.get(key) || key, stops: n, lastSeen: last, daysSince: gap, why });
  }
  return { active, excluded: excluded.sort((a, b) => b.stops - a.stops), counts, lastSeen, windowEnd };
}

// ── CIRCLES, BUT ONE PER CLUSTER ────────────────────────────────────────────
//
// Chad: "I think big circles will work better than dots." His call, and this builds it — but
// built so it cannot tell the lie the dots were guarding against.
//
// ONE circle per driver is what fails: a driver working Buford and Athens gets a circle centred
// on countryside between them, covering fifty miles of ground he never touches. So a driver
// gets one circle PER CLUSTER of their work. A compact driver has one, which is exactly the
// "big circle" Chad pictured. A scattered driver gets several small ones, which is still
// circles, still readable, and still true.
//
// The clustering is deterministic and dependency-free: bucket stops into a coarse grid, flood
// fill adjacent occupied cells into clusters, and keep the clusters that carry a real share of
// the driver's work. No random seeds, no k to choose, nothing that could draw a different map
// from the same data twice.
const KM_PER_DEG_LAT = 110.574;
const kmPerDegLng = (lat) => 111.320 * Math.cos((lat * Math.PI) / 180);

export function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180, la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ── AN OVAL, WHERE THE WORK RUNS ALONG A ROAD ───────────────────────────────
//
// Chad asked at the very start for "circles or ovals of where their general work area is"; on
// 2026-09-27, with the rings on the live map: "if for some drivers an oval would be a better shape
// than a circle, use that instead"; and the next morning: "Some may be circles others may be ovals
// you just look at the data."
//
// "BETTER" IS A MEASUREMENT, NOT A LOOK. A ring claims that most of a driver's work — the 70% of
// his stops the circle's radius is drawn round — sits inside it. Work strung out along a road (the
// towns up I-985, out GA-316, along I-85) gets a circle as wide as the road is long, and most of
// that width is ground he never touches. An oval that holds the SAME share of his stops on less
// ground is the better claim, and that is the whole test:
//
//   • THE OVAL IS THE SMALLEST ONE, centred where the circle is, that holds the same 70% of his
//     stops — found by trying every direction in 5° steps and every stretch up to 4 to 1. A grid,
//     not a fit with a random start, so the same stops always draw the same oval; and the circle
//     is one of the shapes tried, so an oval can never cover more ground than the circle would.
//   • NEVER NARROWER THAN 2.5km (the circle is never smaller than that) AND NEVER LONGER THAN 4 TO
//     1. The very smallest oval round a road run is a needle as thin as the road, which claims a
//     precision four weeks of stops do not have; 4 to 1 still reads as a run.
//   • DRAWN ONLY WHEN IT IS PLAINLY BETTER: the same share of his stops on at most 62% of the
//     circle's ground — and on half of it for a ring of under 100 stops, because a small sample
//     shows a "direction" by chance more often — and at least half as long again as it is wide.
//   • AND ONLY WITH ENOUGH WORK TO SHOW A DIRECTION: 60 stops (three a day for four weeks) at 12
//     different places. Below that the ring stays round.
//
// THE CENTRE DOES NOT MOVE AND NOTHING ELSE CHANGES. Who gets a ring, the 30km rule and the
// coverage test are all decided on the circle exactly as before; only the outline drawn differs.
//
// SET BY LOOKING AT DAVIS'S OWN HISTORY, 2026-09-28, as Chad asked: September 1–28, 13,876
// deliveries, 52 rings with enough stops to have a shape, every one drawn over its own stops and
// looked at. 24 come out ovals, and every one of them is work running along a road or between two
// towns. There is no clean gap in the numbers — the smallest ovals run 0.31, … 0.56, 0.58, 0.61,
// then 0.64, 0.64, 0.65 — so the line is where the pictures stop being runs: just past it are
// Brent Dixon and Sirdedrick Sheats (scattered), Brian Worley, Theo Afunyah and Anthony Bennett
// (oblong patches round a town), and Denis Salkic — a town with a trail of stops off one side, the
// case a line has to keep round, because an oval there would point down the trail. The first
// version (1.81.0) shaped the oval from how the stops spread (their covariance) and, on this same
// history, left three plain runs round — Victor Fernandez, Rasheed Davis, Marcus Young — because
// their outlying stops pulled that shape off the band. That is why the oval is now searched for.
// Checked on made-up work too, 80 tries of each shape at 60 to 400 stops: a round town came out an
// oval at most once in 80; three or four towns along a road, 64 in 80 or more (77 from 100 stops);
// a town with a quarter of its work trailing out along one road, at most 7 in 80 and none from 200.
export const OVAL_RULE = Object.freeze({
  minStops: 60, minPlaces: 12, minAspect: 1.5, maxStretch: 4,
  maxGround: 0.62, fewStops: 100, maxGroundFew: 0.5,
});

// The k-th smallest of `a` (0-based), reordering `a`. Hoare's selection: linear on average, and the
// value it returns cannot depend on the order the stops arrived in.
function kthSmallest(a, k) {
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const p = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < p) i++;
      while (a[j] > p) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}

/**
 * THE OVAL THAT COULD REPLACE A CLUSTER'S CIRCLE — see the note above.
 *
 * `points` are the cluster's stops as { lat, lng }, one per stop, repeats and all (the same stops the
 * circle's radius is measured over); `centre` is the circle's centre. Returns null when there is too
 * little work to show a direction; otherwise the smallest oval, whether or not it is drawn:
 *   { majorKm, minorKm, angleDeg, aspect, areaRatio, better }
 * majorKm/minorKm are the HALF-lengths (the oval's "radii"); angleDeg is the long way, measured
 * anticlockwise from east, 0 ≤ angleDeg < 180, in 5° steps; areaRatio is the oval's ground over the
 * circle's; `better` is whether it replaces the circle. Pure and deterministic.
 */
export function fitOval(points = [], centre = null, opts = {}) {
  const rule = { ...OVAL_RULE, ...(opts.rule || {}) };
  const pctile = opts.radiusPercentile ?? 0.7;
  const minKm = opts.minKm ?? 2.5;
  if (!centre || !Number.isFinite(centre.lat) || !Number.isFinite(centre.lng)) return null;
  const pts = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
  const n = pts.length;
  if (n < rule.minStops) return null;
  if (new Set(pts.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`)).size < rule.minPlaces) return null;
  // Flat km about the centre. Over the few tens of km a ring spans, that is the ground to well
  // under 1%, and the oval is drawn back through the same two factors (ovalPath), so it sits on
  // exactly the stops it was fitted to.
  const kx = kmPerDegLng(centre.lat);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = (pts[i].lng - centre.lng) * kx;
    ys[i] = (pts[i].lat - centre.lat) * KM_PER_DEG_LAT;
  }
  const at = Math.min(n - 1, Math.floor(pctile * n));    // the circle's own percentile
  const far = new Float64Array(n);                         // how far out each stop is, in this shape
  for (let i = 0; i < n; i++) far[i] = xs[i] * xs[i] + ys[i] * ys[i];
  const r2 = kthSmallest(far, at);                         // the circle, measured the same way
  // Every direction, every stretch: an oval stretched q times as long as it is wide, holding the
  // same 70%, covers ground in proportion to k² — so the smallest k² is the smallest oval.
  let best = { q: 1, deg: 0, k2: r2 };
  for (let deg = 0; deg < 180; deg += 5) {
    const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
    for (let q = 1.1; q <= rule.maxStretch + 1e-9; q *= 1.1) {
      for (let i = 0; i < n; i++) {
        const u = xs[i] * c + ys[i] * s;
        const v = ys[i] * c - xs[i] * s;
        far[i] = (u * u) / q + v * v * q;
      }
      const k2 = kthSmallest(far, at);
      if (k2 < best.k2) best = { q, deg, k2 };             // strictly smaller: a tie keeps the rounder
    }
  }
  const k = Math.sqrt(best.k2);
  const minorKm = Math.max(minKm, k / Math.sqrt(best.q));
  const majorKm = Math.max(minorKm, k * Math.sqrt(best.q));
  const R = Math.max(minKm, Math.sqrt(r2));
  const aspect = majorKm / minorKm;
  const areaRatio = (majorKm * minorKm) / (R * R);
  const maxGround = n < rule.fewStops ? rule.maxGroundFew : rule.maxGround;
  return { majorKm, minorKm, angleDeg: best.deg, aspect, areaRatio, better: aspect >= rule.minAspect && areaRatio <= maxGround };
}

/**
 * A usable oval off a ring, or null — so a drawer never has to trust the wire. A ring whose `oval`
 * is missing or malformed is drawn as its circle, never as nothing.
 */
export function ovalOf(ring) {
  const o = ring && ring.oval;
  if (!o || !Number.isFinite(ring.lat) || !Number.isFinite(ring.lng)) return null;
  const { majorKm, minorKm, angleDeg } = o;
  if (![majorKm, minorKm, angleDeg].every(Number.isFinite) || !(minorKm > 0) || !(majorKm >= minorKm)) return null;
  return { majorKm, minorKm, angleDeg };
}

/** The point on a ring's oval at parameter `t` (radians; 0 = the long way's end, π/2 = the short way's). */
function ovalPoint(ring, o, t) {
  const th = (o.angleDeg * Math.PI) / 180;
  const u = o.majorKm * Math.cos(t);
  const v = o.minorKm * Math.sin(t);
  const x = u * Math.cos(th) - v * Math.sin(th);           // km east
  const y = u * Math.sin(th) + v * Math.cos(th);           // km north
  return { lat: ring.lat + y / KM_PER_DEG_LAT, lng: ring.lng + x / kmPerDegLng(ring.lat) };
}

/** The oval's outline as lat/lng points (a closed ring, first point not repeated), or null for a circle. */
export function ovalPath(ring, steps = 72) {
  const o = ovalOf(ring);
  if (!o) return null;
  return Array.from({ length: steps }, (_, i) => ovalPoint(ring, o, (2 * Math.PI * i) / steps));
}

/** Where the oval's long and short radii end, as lat/lng — what a map measures the oval by on screen. */
export function ovalEnds(ring) {
  const o = ovalOf(ring);
  if (!o) return null;
  return { major: ovalPoint(ring, o, 0), minor: ovalPoint(ring, o, Math.PI / 2) };
}

export function driverCircles(stops = [], opts = {}) {
  const cellKm = opts.cellKm || 9;          // grid coarse enough that one town is one cell
  const minShare = opts.minShare ?? 0.12;   // a cluster worth drawing at all
  const maxCircles = opts.maxCircles || 4;
  const pctile = opts.radiusPercentile ?? 0.7;
  // A CELL MUST BE BUSY TO JOIN A CLUSTER. Without this, a trail of one-stop cells bridges two
  // genuinely separate areas and the whole metro merges into a single circle — which is exactly
  // the lie the per-cluster design exists to prevent, arriving through the clustering itself.
  const minCellStops = opts.minCellStops ?? 3;
  // AND A DRIVER WITH NO REAL PATCH GETS NO CIRCLE AT ALL. Chad, before any of this was built:
  // "there are a few drivers this probably won't work great for like rasko or chris." He is
  // right, and the honest answer is to say so rather than draw a circle round scattered work.
  const minCovered = opts.minCovered ?? 0.55;
  // AND A CIRCLE TOO BIG IS NOT A TERRITORY, IT IS THE WHOLE CITY.
  //
  // This is the rule that actually catches the drivers Chad named, and it took a MEASUREMENT to
  // find — coverage does not catch them. Once the metro is dense, a scattered driver's stops all
  // sit in one connected region, so the single cluster covered 99% of his work and passed every
  // test I had written: a 23km circle over Rasko and a 35km one over Chris, each swallowing four
  // other drivers' areas whole. They looked confident and said nothing.
  //
  // WHERE THE LINE ACTUALLY IS — MEASURED ON DAVIS'S OWN WORK, NOT GUESSED.
  //
  // The first number here was 15km, reasoned from "roughly a morning's drops in one direction"
  // and tuned against an invented dozen-driver sample. Run against 14,270 real deliveries over
  // twenty working days it threw out 27 of 59 drivers, including Richard Mawuenyega — ONE
  // cluster holding 98% of his work. A man with 98% of his stops in one blob has a territory;
  // calling that "no fixed area" is not caution, it is a wrong answer printed confidently.
  //
  // The real distribution of Davis cluster radii: p25 7.4km, p50 11.8km, p75 17.0km, p90 24km,
  // max 42km. A cap at 15km cuts the distribution in half. At 30km five drivers get no circle —
  // and 35km excludes exactly the same five, so this sits on a plateau rather than on a knife
  // edge, which is the difference between a threshold and a fudge factor.
  //
  // Those five are the answer the shape of the data gives, and they are the ones Chad predicted
  // before any of this was written ("a few drivers this probably won't work great for like rasko
  // or chris"): Seymour Watts (42km — that is north Georgia, not a patch), RASKO SULJIC (eight
  // clusters, biggest holding 48%), Anthony Kostner (51%), Christopher Garrett (44%) and Brandi
  // Bradberry (6 deliveries). Scattered work is caught by COVERAGE, which is the honest test for
  // it; size only has to catch the circle that has stopped meaning anything at all.
  //
  // The sheet also now prints each driver's own stops as dots underneath his ring, so a wide
  // circle can no longer imply a precision the data does not have — the reader sees the spread.
  const maxRadiusKm = opts.maxRadiusKm ?? 30;
  const roster = opts.roster || null;
  const active = opts.active || null;
  // Ovals where the work runs along a road (fitOval). `ovals: false` draws every ring round, which
  // is how a test proves the circles themselves came through untouched.
  const ovals = opts.ovals ?? true;

  const byDriver = new Map();
  for (const s of stops || []) {
    const at = positionOf(s);
    if (!at) continue;                                              // circles need coordinates
    const { lat, lng } = at;
    const key = driverKeyOf(s);
    if (!key || !isDriver(key, roster)) continue;
    if (active && !active.has(key)) continue;
    if (!byDriver.has(key)) byDriver.set(key, { key, label: driverLabelOf(s), pts: [] });
    const d = byDriver.get(key);
    d.label = betterLabel(d.label, driverLabelOf(s));
    d.pts.push({ lat, lng });
  }

  const out = [];
  for (const d of byDriver.values()) {
    const cells = new Map();
    for (const p of d.pts) {
      const cy = Math.floor((p.lat * KM_PER_DEG_LAT) / cellKm);
      const cx = Math.floor((p.lng * kmPerDegLng(p.lat)) / cellKm);
      const id = `${cx},${cy}`;
      if (!cells.has(id)) cells.set(id, { cx, cy, pts: [] });
      cells.get(id).pts.push(p);
    }
    // Flood fill over the 8 neighbours, so a town spilling across a cell edge stays one cluster.
    for (const [id, c] of [...cells]) if (c.pts.length < minCellStops) cells.delete(id);
    const seen = new Set();
    const clusters = [];
    for (const id of cells.keys()) {
      if (seen.has(id)) continue;
      const stack = [id]; seen.add(id);
      const group = [];
      while (stack.length) {
        const cur = cells.get(stack.pop());
        group.push(...cur.pts);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const nid = `${cur.cx + dx},${cur.cy + dy}`;
          if (cells.has(nid) && !seen.has(nid)) { seen.add(nid); stack.push(nid); }
        }
      }
      clusters.push(group);
    }
    const total = d.pts.length;
    const circles = clusters
      .filter((g) => g.length / total >= minShare)
      .sort((a, b) => b.length - a.length)
      .slice(0, maxCircles)
      .map((g) => {
        const lat = g.reduce((t, p) => t + p.lat, 0) / g.length;
        const lng = g.reduce((t, p) => t + p.lng, 0) / g.length;
        const dists = g.map((p) => haversineKm({ lat, lng }, p)).sort((x, y) => x - y);
        // A PERCENTILE, not the maximum: one stop somebody took as a favour must not inflate a
        // circle by twenty miles and imply a territory nobody works.
        const r = dists[Math.min(dists.length - 1, Math.floor(pctile * dists.length))] || 0;
        const circle = { lat, lng, radiusKm: Math.max(2.5, r), stops: g.length, share: g.length / total };
        // THE OUTLINE, AND ONLY THE OUTLINE: an oval where it holds the same share of his stops on
        // plainly less ground (fitOval). Everything below — the 30km rule, coverage, who gets a
        // ring at all — is still decided on the circle, so no driver gains or loses a ring by it.
        const fit = ovals ? fitOval(g, circle, { radiusPercentile: pctile }) : null;
        return fit && fit.better
          ? { ...circle, oval: { majorKm: fit.majorKm, minorKm: fit.minorKm, angleDeg: fit.angleDeg } }
          : circle;
      });
    const tight = circles.filter((c) => c.radiusKm <= maxRadiusKm);
    const shown = tight.reduce((t, c) => t + c.stops, 0);
    const covered = total ? shown / total : 0;
    const noFixedArea = !tight.length || covered < minCovered;
    out.push({
      key: d.key, label: d.label, plotted: total,
      // Drawn only when the circles actually describe the work. Otherwise none, and the caller
      // prints the name under "no fixed area" instead.
      circles: noFixedArea ? [] : tight,
      candidateCircles: circles,
      noFixedArea,
      covered,
      // What the circles do NOT cover, said out loud rather than left to the eye.
      outsideShare: total ? (total - shown) / total : 0,
      clusterCount: clusters.length,
    });
  }
  return out.sort((a, b) => b.plotted - a.plotted || a.label.localeCompare(b.label));
}

// ── NAMES THAT MIGHT BE ONE PERSON ──────────────────────────────────────────
//
// NuVizz renamed a driver from "Brent  Boyd" to "Brent  Bryd" on 2026-08-27 (recorded in
// tractor-flags.mts). Nothing keyed on the name can see that they are one man, so his territory
// splits in two and a trainee learns half of it twice under two spellings.
//
// THIS DOES NOT MERGE THEM. Merging on a spelling guess is how you fuse two genuinely different
// people — Davis has had two STEVENs — and a trainee cannot tell a wrong merge from a right one.
// So it only ASKS: these two names are one edit apart and share a first name, are they the same
// person? Chad answers once, the answer goes in the alias list, and the sheet stops guessing.
//
// Cheap bounded edit distance: anything past `max` is not a near-miss and is not worth counting.
/**
 * EVERY STOP THE DRIVER ACTUALLY MADE, as plain coordinates, keyed by driver.
 *
 * The circles are a SUMMARY and a summary can be wrong in a way the reader cannot see. Printed
 * under its own circle, the driver's real stops say whether the circle is honest: a tight cloud
 * inside the ring is a territory, a ring with half its dots outside is a fiction. It is also the
 * only thing that can be drawn for the drivers who get NO circle — Chad named two of them before
 * a line was written — because "no fixed area" plus a blank square teaches nothing, while the
 * same square full of scattered dots teaches exactly the right lesson.
 *
 * Rounded to ~11m and de-duplicated: a customer delivered to thirty times is one dot, so the
 * page does not carry thirty identical circles and the eye is not told that address is a region.
 */
export function driverPoints(stops = [], opts = {}) {
  const roster = opts.roster || null;
  const active = opts.active || null;
  const byDriver = new Map();
  for (const s of stops || []) {
    const at = positionOf(s);
    if (!at) continue;
    const { lat, lng } = at;
    const key = driverKeyOf(s);
    if (!key || !isDriver(key, roster)) continue;
    if (active && !active.has(key)) continue;
    if (!byDriver.has(key)) byDriver.set(key, new Map());
    const seen = byDriver.get(key);
    const id = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (!seen.has(id)) seen.set(id, { lat: Number(lat.toFixed(4)), lng: Number(lng.toFixed(4)) });
  }
  const out = new Map();
  for (const [key, seen] of byDriver) out.set(key, [...seen.values()]);
  return out;
}

/**
 * THE FRAME EVERY MAP ON THE SHEET SHARES — and sharing it is the whole point.
 *
 * Fit each driver's map to his own work and every driver's picture looks the same: one blob
 * filling one square. The trainee cannot see that one man runs Buford and the next runs Athens,
 * which is the ONLY thing a set of small maps is for. So the frame is computed once over
 * everybody and reused, and a card is read by WHERE the ink is, not by its shape.
 *
 * Percentile bounds, not min/max: one delivery taken to Chattanooga as a favour must not zoom
 * the whole booklet out until every real territory is a smudge. Points outside the frame are not
 * drawn, and the caller says so rather than letting them silently vanish.
 */
export function mapFrame(points = [], opts = {}) {
  const pad = opts.pad ?? 0.12;
  const q = opts.percentile ?? 0.02;
  const pts = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
  if (!pts.length) return null;
  const at = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(f * (arr.length - 1))))];
  const lats = pts.map((p) => p.lat).sort((a, b) => a - b);
  const lngs = pts.map((p) => p.lng).sort((a, b) => a - b);
  let y0 = at(lats, q) - pad, y1 = at(lats, 1 - q) + pad;
  let x0 = at(lngs, q) - pad, x1 = at(lngs, 1 - q) + pad;
  for (const m of opts.include || []) {
    if (!Number.isFinite(m?.lat) || !Number.isFinite(m?.lng)) continue;
    y0 = Math.min(y0, m.lat - pad); y1 = Math.max(y1, m.lat + pad);
    x0 = Math.min(x0, m.lng - pad); x1 = Math.max(x1, m.lng + pad);
  }
  return { x0, x1, y0, y1 };
}

export function withinEdits(a, b, max = 2) {
  const s = String(a || ''), t = String(b || '');
  if (Math.abs(s.length - t.length) > max) return false;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return false;                 // whole row already past the budget
    prev = cur;
  }
  return prev[t.length] <= max;
}

/**
 * Pairs of driver keys that look like one person spelled two ways. Reported, never merged.
 * Requires a shared first token, so BRENT_BOYD/BRENT_BRYD is flagged and two unrelated short
 * names that happen to be two edits apart are not.
 */
export function possibleSameDriver(stops = [], opts = {}) {
  const max = opts.maxEdits ?? 2;
  const seen = new Map();
  for (const s of stops || []) {
    const k = driverKeyOf(s);
    if (!k) continue;
    if (!seen.has(k)) seen.set(k, { key: k, label: driverLabelOf(s), stops: 0, last: null });
    seen.get(k).label = betterLabel(seen.get(k).label, driverLabelOf(s));
    const e = seen.get(k);
    e.stops += 1;
    const d = String(s.boardDate || s.date || '');
    if (d && (!e.last || d > e.last)) e.last = d;
  }
  const keys = [...seen.values()];
  const out = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i], b = keys[j];
      const fa = a.key.split('_')[0], fb = b.key.split('_')[0];
      if (fa !== fb) continue;                    // a shared first name is the evidence
      if (a.key === b.key) continue;
      if (!withinEdits(a.key, b.key, max)) continue;
      out.push({ a, b });
    }
  }
  return out;
}

/** Fold a confirmed alias list ({ from: 'BRENT_BRYD', to: 'BRENT_BOYD' }) over the stops. */
export function applyAliases(stops = [], aliases = []) {
  if (!aliases || !aliases.length) return stops || [];
  const map = new Map(aliases.map((a) => [String(a.from || '').toUpperCase(), String(a.to || '').toUpperCase()]));
  if (!map.size) return stops || [];
  return (stops || []).map((s) => {
    const k = driverKeyOf(s);
    const to = k && map.get(k);
    if (!to) return s;
    // Rewrite BOTH name fields, so whichever one downstream reads it lands on the same person.
    return { ...s, driverUserName: to, driverName: to };
  });
}

// ── THE RINGS, COMPUTED ONCE FOR THE PAPER AND FOR THE SCREEN ───────────────
//
// Chad, 2026-09-27: "find the circles we were working on for the new trainee learning to route
// to try and guide him to where drivers go and we were going to build an overlay for the map that
// we could toggle on and off."
//
// The printed sheet and the Map overlay must draw the SAME rings in the SAME colours. A trainee
// holding the sheet beside the screen and seeing two different answers cannot tell which to
// believe, and building the pipeline twice is exactly how a printout and a screen drift apart —
// this repo has already paid for that once, on the roster freshness line. So the pipeline lives
// here once: territorySheetHtml renders it to paper, territoryLayer projects it to the small JSON
// the map draws.

/**
 * EVERY FIELD OF A HISTORY STOP THAT THIS MODULE OR THE SHEET READS — and the endpoint asks
 * Firestore for these and nothing else.
 *
 * A history stop is the whole normalized vendor stop, raw payload and all. Reading four weeks of
 * them in full is what made the sheet stop answering: measured 2026-09-27, ONE week took 21s and
 * four did not come back inside 31s, against a 26s function ceiling. The territory code has never
 * looked at more than these six fields (a test proves it by watching every read), so the other
 * few hundred were bytes carried across the wire to be thrown away.
 *
 * `stopNbr` is NOT read here. It rides along because every history stop is written with it
 * (upsertStops keys the document by it), and listDocs SKIPS a masked document that has none of
 * its masked fields — so without one field every document is guaranteed to carry, a stop with no
 * driver, no ZIP and no coordinates would silently vanish from the "what this is built from"
 * counts. Absent is not zero, again.
 */
export const TERRITORY_STOP_FIELDS = Object.freeze(['stopNbr', 'driverUserName', 'driverName', 'zip', 'city', 'lat', 'lng']);

// COLOUR TELLS RINGS APART. IT DOES NOT NAME ANYBODY.
//
// A dozen swatches across sixty drivers means several men share every colour, so a colour cannot
// identify a person — and the first sheet printed a legend that implied it could, which cost a
// whole page and told the reader something false. There is no legend. The colours exist so that
// two rings crossing each other read as two rings, and so a name can be matched to its ring; the
// NAME is the answer. Kept here, not in the sheet, so the screen colours a driver exactly as the
// paper does.
//
// VARIED AND BRIGHT, BECAUSE THE FIRST SET COULD NOT BE TOLD APART. It was ten muted print colours
// — navy, slate, a second blue, two browns — and on the live map fifty-odd thin lines in near-black
// shades read as one tangle, with names whose colour nobody could match to a line. Chad,
// 2026-09-28: "Make drivers name match color of their circle ... and give circles a varied color
// pallette." Twelve now, each from a different family — red, blue, green, orange, purple, teal,
// pink, gold, sky, brown, violet, olive — every one dark enough to read as bold 11px type on the
// map (3.8:1 against white or better) and bright enough not to read as black.
export const RING_PALETTE = Object.freeze(['#d62728', '#1565c0', '#2e7d32', '#e04e00', '#8e24aa', '#00897b',
  '#d81b60', '#9e6a00', '#0288d1', '#6d4c41', '#5e35b1', '#827717']);

// How different two palette colours LOOK: distance in CIE Lab (ΔE), not in the list's order.
function labOf(hex) {
  const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16)));
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const X = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const Y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const Z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
const PALETTE_LAB = RING_PALETTE.map(labOf);
const LOOK_APART = PALETTE_LAB.map((p) => PALETTE_LAB.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])));

/**
 * EACH DRIVER'S RING COLOUR — AND NEIGHBOURS GET DIFFERENT ONES.
 *
 * Twelve colours over sixty rings: handed out by rank, two drivers side by side could get the same
 * one, and two blue rings crossing are exactly the confusion colour is there to end. So colours go
 * out busiest first (`drivers` is driverCore's order) and each driver takes the colour that clashes
 * least with the rings his own rings touch (overlap, or pass within 2km). The same colour on a
 * neighbour counts fully, a similar one partly, a different one hardly at all — and a neighbour
 * whose ring sits right on top of his counts far more than one that only grazes it, because that
 * is where two names and two lines crowd together. Ties go to the colour used least so far, then to
 * palette order, so the same rings always get the same colours. On the four weeks to 2026-09-28
 * (52 drivers with rings, 191 pairs overlapping by more than half) handing out by rank left 12 of
 * those heavy pairs in one colour; this leaves 4.
 *
 * `circleSets` is driverCircles' output. Without it — no positions to go on — colours go by rank, as
 * they did before. A driver with no ring gets one too (nobody sees it), after everyone who has one.
 */
export function ringColours(drivers = [], circleSets = null) {
  const list = drivers || [];
  if (!circleSets) return new Map(list.map((d, i) => [d.key, RING_PALETTE[i % RING_PALETTE.length]]));
  const ringsOf = new Map(circleSets.map((c) => [c.key, c.circles || []]));
  const reach = (c) => ovalOf(c)?.majorKm ?? c.radiusKm;
  // How much two drivers' rings crowd each other: 0 when no ring of one comes within 2km of the
  // other's, 0.15 for a graze, up to 1.15 for two rings on the same centre.
  const crowding = (a, b) => {
    let w = 0;
    for (const x of a) for (const y of b) {
      const d = haversineKm(x, y), reachBoth = reach(x) + reach(y);
      if (d <= reachBoth + 2) w = Math.max(w, 0.15 + Math.max(0, 1 - d / reachBoth));
    }
    return w;
  };
  const out = new Map();
  const used = RING_PALETTE.map(() => 0);
  const coloured = [];                                     // { rings, i } for every driver done so far
  const ringed = list.filter((d) => (ringsOf.get(d.key) || []).length);
  for (const d of ringed) {
    const mine = ringsOf.get(d.key);
    const near = coloured.map((o) => ({ i: o.i, w: crowding(mine, o.rings) })).filter((o) => o.w > 0);
    let pick = 0;
    let worst = Infinity;
    for (let i = 0; i < RING_PALETTE.length; i++) {
      const clash = near.reduce((t, o) => t + o.w * Math.exp(-((LOOK_APART[i][o.i] / 20) ** 2)), 0);
      if (clash < worst - 1e-9 || (Math.abs(clash - worst) <= 1e-9 && used[i] < used[pick])) { pick = i; worst = clash; }
    }
    used[pick]++;
    coloured.push({ rings: mine, i: pick });
    out.set(d.key, RING_PALETTE[pick]);
  }
  list.filter((d) => !out.has(d.key)).forEach((d, n) => out.set(d.key, RING_PALETTE[n % RING_PALETTE.length]));
  return out;
}

/**
 * PEOPLE WHO GET NO RING, BY NAME, BECAUSE CHAD SAID SO.
 *
 * Chad, 2026-09-27, on the first map drawn from real history: "I don't want Chad Brandi Freddy or
 * Jessica on the map in rings." Three of those names carry loads in the four weeks behind that
 * map — Chad Davis (208 deliveries, three rings), Jessica Sage (40, three) and Brandi Bradberry
 * (23, three) — so the data drew them exactly like route drivers. The rings are a trainee's guide
 * to whose area a stop is in, and who counts as that is Chad's call, not the data's.
 *
 * THE CANONICAL KEY, NEVER A SUBSTRING: matched on driverKeyOf after the alias fold, so a load
 * under another spelling of the same man is caught and a "Chad Davison" hired next year is not.
 * They are taken out before ANYTHING is counted — no ring, no row in the town table, no card, no
 * share of anybody's ZIP — on the map and on the printed sheet alike, which are one pipeline. And
 * what was left out is still SAID, in the layer's `hidden` list, so a missing name is never a
 * mystery to whoever looks next.
 *
 * "Freddy" is not here: as of 2026-09-27 no driver of that name is anywhere in the history (the
 * nearest are Frank Okine, on the map, and Alfred Andi, on the roster but not in the window), and
 * a name added on a guess could take the wrong man off a trainee's map.
 */
export const HIDDEN_FROM_RINGS = Object.freeze(['CHAD_DAVIS', 'BRANDI_BRADBERRY', 'JESSICA_SAGE']);

/** Stops of the named people set aside, and the names that were actually present to set aside. */
export function splitHidden(stops = [], keys = HIDDEN_FROM_RINGS) {
  const hide = new Set((keys || []).map((k) => String(k).toUpperCase()));
  const kept = [];
  const labels = new Map();
  for (const s of stops || []) {
    const k = hide.size ? driverKeyOf(s) : null;
    if (k && hide.has(k)) { labels.set(k, betterLabel(labels.get(k), driverLabelOf(s))); continue; }
    kept.push(s);
  }
  return { kept, hidden: [...labels.values()].sort((a, b) => a.localeCompare(b)) };
}

/**
 * THE WHOLE PIPELINE, ONCE: who is still running, their work, their rings and their colours.
 *
 * `drivers` and `circles` are the sheet's existing overrides, carried through unchanged so the
 * printed page is byte-for-byte what it was before this was shared.
 */
export function territoryModel(stops = [], opts = {}) {
  // CHAD'S LIST GOES FIRST, so nobody he named is counted anywhere below (see HIDDEN_FROM_RINGS).
  const { kept: all, hidden } = splitHidden(stops, opts.hidden ?? HIDDEN_FROM_RINGS);
  const roster = opts.roster || null;
  // ONLY DRIVERS WHO HAVE ACTUALLY RUN IN THE WINDOW. Chad: "terry hasn't ran for me in a long
  // time ... just guys that have ran in last 4 weeks."
  const { active, excluded } = activeDrivers(all, { roster, minStops: opts.minStops ?? 5 });
  // THE KEY COMES FROM ONE PLACE — driverKeyOf, never re-derived inline. An inline uppercase-and-
  // underscore once turned "COLIN/DJ 1" into COLIN/DJ_1, which is in no active set, and Colin's
  // second load vanished from the tables while the rings (which asked properly) still drew it.
  const inWindow = all.filter((s) => active.has(driverKeyOf(s)));
  const drivers = opts.drivers || driverCore(inWindow, { roster });
  const circleSets = opts.circles || driverCircles(all, { roster, active });
  return { roster, active, excluded, inWindow, drivers, circleSets, colourOf: ringColours(drivers, circleSets), hidden };
}

const round = (v, dp) => Number(Number(v).toFixed(dp));

/**
 * THE MAP OVERLAY'S DATA — the sheet's page one, as JSON a map can draw.
 *
 * Only what a ring needs: where, how wide, whose, which colour. Nothing about customers, prices
 * or addresses leaves the server, so a phone downloads a few kilobytes rather than four weeks of
 * stops. A driver with no ring is LISTED with the reason, never silently missing — the same
 * absent-is-not-zero rule the sheet prints under "No settled patch".
 */
export function territoryLayer(stops = [], opts = {}) {
  const m = territoryModel(stops, opts);
  const setBy = new Map(m.circleSets.map((c) => [c.key, c]));
  const rings = [];
  const noRing = [];
  for (const d of m.drivers) {
    const cs = setBy.get(d.key);
    if (!cs) {
      // Active, but not one of his stops carries a position, so there is nothing to draw a ring
      // round. Said, not dropped: "no positions" and "too spread out" are different facts.
      noRing.push({ key: d.key, label: d.label, stops: d.total, mapped: 0, why: 'no coordinates' });
    } else if (!cs.circles.length) {
      // TOO FEW POSITIONS IS NOT "SPREAD OUT". A man with forty stops in one ZIP and two of them
      // geocoded has no cell busy enough to cluster, and calling that scattered work would tell
      // a trainee the opposite of the truth. With under half his stops mapped, a missing ring
      // says more about the geocoding than about his work — so say how many could be placed.
      const few = cs.plotted < d.total / 2;
      noRing.push({ key: d.key, label: cs.label, stops: d.total, mapped: cs.plotted, why: few ? 'few coordinates' : 'spread out' });
    } else {
      rings.push({
        key: d.key,
        label: cs.label,
        colour: m.colourOf.get(d.key),
        stops: d.total,
        // `oval` only where one is drawn (fitOval). radiusKm stays either way: it is the circle the
        // ring was earned on, and a drawer that cannot read the oval still has a true ring to draw.
        circles: cs.circles.map((c) => ({
          lat: round(c.lat, 5), lng: round(c.lng, 5), radiusKm: round(c.radiusKm, 2),
          ...(c.oval ? { oval: { majorKm: round(c.oval.majorKm, 2), minorKm: round(c.oval.minorKm, 2), angleDeg: round(c.oval.angleDeg, 0) % 180 } } : {}),
        })),
      });
    }
  }
  const cov = territoryCoverage(m.inWindow, { roster: m.roster });
  return {
    rings,
    noRing: noRing.sort((a, b) => a.label.localeCompare(b.label)),
    excluded: m.excluded.map((e) => ({ label: e.label, why: e.why, stops: e.stops, lastSeen: e.lastSeen, daysSince: e.daysSince })),
    coverage: { deliveries: cov.usable, days: cov.days, drivers: m.drivers.length, coordShare: round(cov.coordShare, 3) },
    rosterApplied: cov.rosterApplied,
    // Left off by name (HIDDEN_FROM_RINGS) — said here so the JSON explains a missing name. Not
    // printed on the map or the sheet: Chad asked for them to be off it, not listed on it.
    hidden: m.hidden,
  };
}
