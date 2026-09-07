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
  return { key, label: name, rewritten: name !== original };
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
    if (!labels.has(key)) labels.set(key, driverLabelOf(s));
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
  // 15km (~9 miles) is roughly a morning's drops in one direction. Past that a circle stops
  // meaning "his patch" and starts meaning "somewhere in Gwinnett", which a trainee already
  // knows and cannot act on.
  const maxRadiusKm = opts.maxRadiusKm ?? 15;
  const roster = opts.roster || null;
  const active = opts.active || null;

  const byDriver = new Map();
  for (const s of stops || []) {
    const lat = Number(s?.lat), lng = Number(s?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;   // circles need coordinates
    const key = driverKeyOf(s);
    if (!key || !isDriver(key, roster)) continue;
    if (active && !active.has(key)) continue;
    if (!byDriver.has(key)) byDriver.set(key, { key, label: driverLabelOf(s), pts: [] });
    byDriver.get(key).pts.push({ lat, lng });
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
        return { lat, lng, radiusKm: Math.max(2.5, r), stops: g.length, share: g.length / total };
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
