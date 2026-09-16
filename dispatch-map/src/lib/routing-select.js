// P2 (PR3) — pure selection-geometry + display helpers for the Routing tab.
// Extracted from App.jsx so the touch-selection math and the per-stop detail
// formatting can be unit-tested without the React / Google-Maps shell. App.jsx
// imports these; the on-map controls (Add-in-view, Box, Lasso) feed plain
// numbers/objects through here, so what the tests exercise is what ships.

// Day key order, Mon→Sun. Mirrors App.jsx's DAYS for receiving-hours grouping.
export const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// Ray-casting point-in-polygon. path = [[lat,lng], …]. Free; no geometry lib.
// Used by the Lasso tool (tap-to-place vertices → enclosed stops).
export function pointInPolygon(lat, lng, path) {
  if (lat == null || lng == null || !Array.isArray(path) || path.length < 3) return false;
  let inside = false;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const [yi, xi] = path[i], [yj, xj] = path[j];
    const intersect = ((xi > lng) !== (xj > lng)) && (lat < ((yj - yi) * (lng - xi)) / ((xj - xi) || 1e-12) + yi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Axis-aligned bounding-box containment. box = { north, south, east, west }.
// Used by Add-stops-in-view (from the map's getBounds) and Box (from the two
// tapped corners) — both reduce to a lat/lng range test, no Google object.
export function latLngInBounds(lat, lng, box) {
  if (lat == null || lng == null || !box) return false;
  return lat <= box.north && lat >= box.south && lng <= box.east && lng >= box.west;
}

// Normalize two corner points {lat,lng} into a { north, south, east, west } box.
export function boxFromCorners(a, b) {
  return {
    north: Math.max(a.lat, b.lat),
    south: Math.min(a.lat, b.lat),
    east: Math.max(a.lng, b.lng),
    west: Math.min(a.lng, b.lng),
  };
}

// "08:00" → "8:00a"; "14:30" → "2:30p". Already-formatted (am/pm) or unparseable
// strings pass through untouched so legacy free-text hours still render readably.
export function fmtTime12(t) {
  if (!t) return '';
  const s = String(t).trim();
  if (/[ap]\.?m/i.test(s)) return s.replace(/\s*([ap])\.?m\.?/i, (_, p) => p.toLowerCase());
  // A FULL TIMESTAMP IS A TIME TOO. The match below is anchored at the start, so an ISO
  // stamp fell straight through to `return s` — and the Appointment window row on a routing
  // stop reads scheduledFrom/To, which ARE stamps. The panel printed
  // "2026-08-24T08:00:00–2026-08-24T08:05:00" where it meant "8:00a–8:05a".
  //
  // The digits are read directly and no Date is ever constructed: these stamps are naive ET
  // wall-clock with no offset, so handing one to Date + timeZone reads four hours early and
  // rolls a pre-dawn slot to the previous day — the trap board-flags.stampMinutes and
  // time-restrictions.clockMinFromStamp both document, and both avoid the same way.
  const stamped = s.match(/[T ](\d{2}):(\d{2})/);
  if (stamped && Number(stamped[1]) <= 23 && Number(stamped[2]) <= 59) {
    let sh = Number(stamped[1]);
    const sap = sh >= 12 ? 'p' : 'a';
    sh = sh % 12; if (sh === 0) sh = 12;
    return `${sh}:${stamped[2]}${sap}`;
  }
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return s;
  let h = Number(m[1]);
  const ap = h >= 12 ? 'p' : 'a';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m[2]}${ap}`;
}

// Render a note's receiving hours as one compact human line, collapsing runs of
// consecutive days with identical hours into ranges, e.g.
// "Mon–Fri 8:00a–3:00p · Sat Closed". Returns null when nothing is set. Handles
// legacy string days and the M4.4 {open,close} shape, same as the notes popup.
export function formatReceivingHours(note) {
  if (!note) return null;
  const closed = new Set(Array.isArray(note.closed_days) ? note.closed_days : []);
  const hrs = note.receiving_hours || {};
  const label = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  const dayVal = (d) => {
    if (closed.has(d)) return 'Closed';
    const v = hrs[d];
    if (!v) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (v.open && v.close) return `${fmtTime12(v.open)}–${fmtTime12(v.close)}`;
    return fmtTime12(v.open || v.close) || null;
  };
  const segs = [];
  let i = 0;
  while (i < DAY_ORDER.length) {
    const val = dayVal(DAY_ORDER[i]);
    if (val == null) { i++; continue; }
    let j = i;
    while (j + 1 < DAY_ORDER.length && dayVal(DAY_ORDER[j + 1]) === val) j++;
    const range = i === j ? label[DAY_ORDER[i]] : `${label[DAY_ORDER[i]]}–${label[DAY_ORDER[j]]}`;
    segs.push(`${range} ${val}`);
    i = j + 1;
  }
  return segs.length ? segs.join(' · ') : null;
}

// One line item's dimensions as a short string ("96×48×40 in"), falling back to
// the single critical dimension when L/W/H aren't all present. "" when none.
export function lineItemDims(d) {
  if (d == null) return '';
  if (d.length != null || d.width != null || d.height != null) {
    const uom = d.lengthUOM || d.widthUOM || d.heightUOM || 'in';
    const n = (v) => (v == null ? '–' : v);
    return `${n(d.length)}×${n(d.width)}×${n(d.height)} ${uom}`;
  }
  if (d.criticalDimension != null) return `${d.criticalDimension} ${d.criticalDimensionUOM || 'in'}`;
  return '';
}

// ── Manual route reorder (PR: drag-and-drop) ──────────────────────────────────
// Pure helpers so the reorder + client-side recompute are unit-testable without
// the React/Maps shell. The recompute mirrors the engine's FREE haversine matrix
// convention (1.3× road factor over crow-flies, ~30 mph effective) so a manually
// reordered route's legs/ETAs are consistent with a free build.

export const ROUTE_ROAD_FACTOR = 1.3;     // mirror of google-route-matrix haversine
export const ROUTE_AVG_SPEED_MPS = 13.4;  // ~30 mph effective
export const DEFAULT_SERVICE_SEC = 20 * 60;

export function haversineMeters(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Pure array move: returns a NEW array with the item at `from` moved to `to`.
// Out-of-range / no-op moves return a shallow copy unchanged.
export function moveItem(arr, from, to) {
  const out = [...arr];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it);
  return out;
}

// Recompute legs + cumulative arrival ETAs for an ordered list of stops, starting
// from the depot at departSec, with serviceSec dwell after each stop. Returns
// straight-line (haversine) estimates — used after a MANUAL reorder, where any
// Google road legs no longer apply. orderedStops: [{ id, lat, lng }].
export function recomputeRoute(orderedStops, depot, departSec = 0, serviceSec = DEFAULT_SERVICE_SEC) {
  const legs = [];
  const etas = [];
  let totalDistanceMeters = 0;
  let totalDurationSec = 0;
  let prev = { id: 'depot', lat: depot.lat, lng: depot.lng };
  let clock = departSec;
  for (const s of orderedStops) {
    const dist = haversineMeters(prev, s) * ROUTE_ROAD_FACTOR;
    const dur = Math.round(dist / ROUTE_AVG_SPEED_MPS);
    clock += dur;
    legs.push({ fromId: prev.id, toId: s.id, distanceMeters: Math.round(dist), durationSec: dur });
    etas.push(clock);                 // arrival at this stop
    totalDistanceMeters += dist;
    totalDurationSec += dur;
    clock += serviceSec;              // dwell before departing to the next
    prev = s;
  }
  return { legs, etas, totalDistanceMeters: Math.round(totalDistanceMeters), totalDurationSec };
}


// ── Per-load client-side re-sequencing (PR: routing UX) ───────────────────────
// Mirrors the engine's sequencing strategies CLIENT-SIDE on haversine distance —
// same convention as the manual reorder recompute. `stops` are { id, lat, lng } in
// the route's CURRENT order; each returns a NEW array (a permutation of `stops`).
// The caller maps the result to ids and recomputes legs/ETAs via recomputeRoute.

function routeTotalMeters(orderedStops, depot) {
  let total = 0;
  let prev = depot;
  for (const s of orderedStops) { total += haversineMeters(prev, s); prev = s; }
  return total;
}

// Sort by crow-flies distance from the depot. This WAS "Closest first" / "Farthest first" until
// 2026-09-10 — a radial sort that ignores direction and zigzags between towns at one radius.
// Kept as a plain utility; the picker's strategies are the sweeps below.
export function depotSort(stops, depot, dir = 'asc') {
  const withD = stops.map((s) => ({ s, d: haversineMeters(depot, s) }));
  withD.sort((a, b) => (dir === 'asc' ? a.d - b.d : b.d - a.d));
  return withD.map((x) => x.s);
}

// Greedy nearest-neighbour tour starting from the depot.
export function nearestNeighbor(stops, depot) {
  const remaining = [...stops];
  const out = [];
  let cur = depot;
  while (remaining.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineMeters(cur, remaining[i]);
      if (d < bd) { bd = d; bi = i; }
    }
    cur = remaining.splice(bi, 1)[0];
    out.push(cur);
  }
  return out;
}

// Bounded 2-opt improvement over the depot-anchored path (segment reversals while
// they shorten the total). Capped passes so it's cheap for a single route.
export function twoOpt(stops, depot, maxPasses = 6) {
  let best = [...stops];
  let bestLen = routeTotalMeters(best, depot);
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const len = routeTotalMeters(cand, depot);
        if (len + 1e-6 < bestLen) { best = cand; bestLen = len; improved = true; }
      }
    }
    if (!improved) break;
  }
  return best;
}

// Closed-LOOP length: depot → s1 → … → sn → back to depot. The return leg is what
// makes 2-opt produce the "down one side, up the other" U-shape — an open path has
// no reason to come back, so it can leave the route crossing itself; closing the
// loop forces the optimizer to run out along one side of the corridor and return
// along the other.
function loopTotalMeters(orderedStops, depot) {
  if (!orderedStops.length) return 0;
  let total = 0;
  let prev = depot;
  for (const s of orderedStops) { total += haversineMeters(prev, s); prev = s; }
  total += haversineMeters(prev, depot);   // close the loop back to the terminal
  return total;
}

// 2-opt over the CLOSED loop (depot anchored at both ends). Same segment-reversal
// move as twoOpt(), but scored on the round-trip so crossings get un-crossed into a
// clean out-and-back loop. Returned in visiting order (depot start is implied).
export function twoOptLoop(stops, depot, maxPasses = 8) {
  let best = [...stops];
  let bestLen = loopTotalMeters(best, depot);
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const len = loopTotalMeters(cand, depot);
        if (len + 1e-6 < bestLen) { best = cand; bestLen = len; improved = true; }
      }
    }
    if (!improved) break;
  }
  return best;
}

// ── "Farthest first" / "Closest first" are a SWEEP, not a sort ──────────────
//
// Chad, 2026-09-10, on a 14-stop JEFF route re-sequenced Farthest first: "it should be pretty
// linear from furthest point out to the last but this is jumping all around."
//
// IT WAS A SORT. depotSort ranked every stop by its crow-flies RADIUS from Buford and by
// nothing else — and a radius says nothing about direction. Three towns that sit at about the
// same distance in three different directions (Canton to the south-west, Tate to the
// north-east, Ball Ground between them) interleave in a radial sort, so the driver was sent
// Jasper → Canton → Tate → Ball Ground → … → back out toward Tate, and every one of those
// jumps was a stretch of road driven twice.
//
// WHAT "FARTHEST FIRST" MEANS ON A DOCK: run out to the far end with the load, then deliver on
// the way home, so every stop after the first brings the truck closer to the yard. That is a
// path whose BOTH ends are already known — it starts at the farthest stop and it finishes at
// the terminal — and the only open question is the order of everything in between. So the far
// stop is pinned first, the depot is pinned last, and the shortest path between them through
// the rest is found: a nearest-neighbour seed, then 2-opt (reverse a run of stops) and or-opt
// (lift a run of one to three stops and set it down elsewhere) until neither move shortens it.
// Or-opt is there for the straggler 2-opt cannot reach: one stop off to the side of the
// corridor that a reversal alone leaves stranded between two towns. And since Chad's call the
// same evening, the sweep runs ONE TOWN AT A TIME — the block further down.
//
// "Closest first" is the same sweep run the other way: nearest stop pinned first, farthest
// pinned last, and the path walks outward. Without a pinned far end it would collapse into
// "Shortest distance" — the picker would offer two names for one order.
//
// Straight-line distance throughout, the same convention as every other client-side
// re-sequence here (recomputeRoute, twoOpt, twoOptLoop). The engine's FARTHEST_FIRST /
// CLOSEST_FIRST (routing-solver.mts) run the same sweep on the build's matrix, so a card
// re-sequenced here and a route built there agree about what the words mean.

const mappable = (s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lng);

// Symmetric haversine matrix over `nodes` ([{lat,lng}, …]); index i ↔ nodes[i].
function distanceMatrix(nodes) {
  const n = nodes.length;
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) { const d = haversineMeters(nodes[i], nodes[j]); m[i][j] = d; m[j][i] = d; }
  }
  return m;
}

// Length of start → order[0] → … → order[last] → end on a cost matrix of node indices.
export function pinnedPathCost(order, start, end, cost) {
  let prev = start, total = 0;
  for (const k of order) { total += cost[prev][k]; prev = k; }
  return total + cost[prev][end];
}

// Greedy nearest-neighbour walk over `pool` (node indices) starting from node `from`.
function nearestNeighborFrom(from, pool, cost) {
  const remaining = [...pool];
  const out = [];
  let cur = from;
  while (remaining.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < remaining.length; i++) { const d = cost[cur][remaining[i]]; if (d < bd) { bd = d; bi = i; } }
    cur = remaining.splice(bi, 1)[0];
    out.push(cur);
  }
  return out;
}

// Improve the interior of a path whose two ends are pinned. `order` is the interior as node
// indices; `start` / `end` are node indices that never move. Each pass tries every 2-opt
// reversal and every or-opt relocation (runs of 1–3, either way round), keeping any that
// shortens the path; it stops when a whole pass finds nothing. Every kept move strictly
// shortens the path, so the search always ends; maxPasses stops a badly seeded pass early
// (a lattice of 150 stops seeded in radius order was still improving at 40), and the
// multi-start below keeps whichever seed finished shortest.
//
// Each candidate is scored by the DELTA of the edges it changes, not by re-adding the whole
// path: a reversal swaps two edges, a relocation swaps three. The first cut of this re-summed
// every candidate and took 1.5 s on 150 stops — a visible freeze on the dropdown, and a
// wall-clock test that failed on a shared CI runner. On an asymmetric (road) matrix the edges
// INSIDE a reversed run change direction too, so those are re-read only when the matrix is
// actually asymmetric; the straight-line matrix never is.
export function improvePinnedPath(order, start, end, cost, maxPasses = 40) {
  const path = [...order];
  const n = path.length;
  if (n < 2) return path;
  const EPS = 1e-6;
  const at = (i) => (i < 0 ? start : i >= n ? end : path[i]);
  const asym = isAsymmetric(cost, [start, end, ...path]);
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    // 2-opt: reverse path[i..k]. Edges (p→a) and (b→q) become (p→b) and (a→q).
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const p = at(i - 1), a = path[i], b = path[k], q = at(k + 1);
        let delta = cost[p][b] + cost[a][q] - cost[p][a] - cost[b][q];
        if (asym) for (let t = i; t < k; t++) delta += cost[path[t + 1]][path[t]] - cost[path[t]][path[t + 1]];
        if (delta < -EPS) {
          for (let lo = i, hi = k; lo < hi; lo++, hi--) { const tmp = path[lo]; path[lo] = path[hi]; path[hi] = tmp; }
          improved = true;
        }
      }
    }
    // or-opt: lift path[i..i+len) and drop it into another slot, forwards or reversed.
    for (let len = 1; len <= 3 && len < n; len++) {
      for (let i = 0; i + len <= n; i++) {
        const a = path[i], b = path[i + len - 1], p = at(i - 1), q = at(i + len);
        let inner = 0, innerRev = 0;
        for (let t = i; t < i + len - 1; t++) { inner += cost[path[t]][path[t + 1]]; innerRev += cost[path[t + 1]][path[t]]; }
        const lifted = cost[p][a] + cost[b][q] - cost[p][q];          // what leaving this slot saves
        let bestDelta = -EPS, bestJ = -1, bestRev = false;
        for (let j = 0; j <= n; j++) {
          if (j >= i && j <= i + len) continue;                      // its own slot
          const u = at(j - 1), v = at(j);
          const dF = cost[u][a] + cost[b][v] - cost[u][v] - lifted;
          if (dF < bestDelta) { bestDelta = dF; bestJ = j; bestRev = false; }
          if (len > 1) {
            const dR = cost[u][b] + cost[a][v] - cost[u][v] - lifted + (innerRev - inner);
            if (dR < bestDelta) { bestDelta = dR; bestJ = j; bestRev = true; }
          }
        }
        if (bestJ >= 0) {
          const seg = path.splice(i, len);
          if (bestRev) seg.reverse();
          path.splice(bestJ > i ? bestJ - len : bestJ, 0, ...seg);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return path;
}

// Does any pair among `nodes` cost a different amount each way? (A Google road matrix can;
// straight-line never does.)
function isAsymmetric(cost, nodes) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (cost[nodes[i]][nodes[j]] !== cost[nodes[j]][nodes[i]]) return true;
    }
  }
  return false;
}

// ── ONE TOWN AT A TIME (Chad, 2026-09-10) ────────────────────────────────────
//
// Shown the pure sweep's answer on JEFF — Ball Ground, Ball Ground, Ball Ground, Canton, then
// four more Ball Ground — and the 4% of paper miles it saves: "2 let's try that and have a way
// to flip it back if I don't like the orders it's putting things in."
//
// A town is worked in one visit. Two stops within TOWN_RADIUS_METERS of each other are one
// town, and towns chain (A near B and B near C is one town of all three), so a contiguous
// industrial belt is one town and a lone customer nine miles off the corridor is its own. The
// sweep then runs at two levels. The towns are ordered as the pinned path — the town holding
// the far stop first, the yard last, the distance between two towns being the shortest hop
// between any of their stops — and inside each town the stops are ordered as a short pinned
// path from wherever the truck arrives to the nearest stop of the town it leaves for next. A
// spur out to a lone stop can still happen, because it has to be visited somewhere, but it can
// no longer land in the MIDDLE of another town's stops.
//
// THE SWITCH. SWEEP_MODE 'towns' is the rule above; 'pure' is the plain shortest pinned path
// (the spur-in-the-middle answer). Flip the word, bump the version, and the old order is back.
// The server twin in routing-solver.mts carries the same two constants and must say the same.
export const SWEEP_MODE = 'towns';
export const TOWN_RADIUS_METERS = 4000;   // ~2.5 miles: the same neighbourhood, not the same county

// Multi-start over one pinned path. 2-opt/or-opt only walk downhill, so where they finish
// depends on where they begin, and one greedy seed can leave a straggler no single move
// repairs. Four cheap starting orders — greedy from the pinned start, greedy from the pinned
// end walked backwards, radius order, and the canonical ascending order — are each improved
// and the shortest wins. `dir` only decides which way the radius seed runs. Every seed is a
// function of the node SET, so the same stops give the same answer whatever order they came in.
function bestPinnedPath(pool, start, end, cost, dir) {
  if (pool.length < 2) return [...pool];
  const byRadius = [...pool].sort((a, b) => cost[0][a] - cost[0][b]);
  const seeds = [
    nearestNeighborFrom(start, pool, cost),
    nearestNeighborFrom(end, pool, cost).reverse(),
    dir === 'homeward' ? byRadius.reverse() : byRadius,
    [...pool].sort((a, b) => a - b),
  ];
  let bestOrder = [...pool], best = Infinity;          // a valid order even if every score is NaN
  for (const seed of seeds) {
    const cand = improvePinnedPath(seed, start, end, cost);
    const len = pinnedPathCost(cand, start, end, cost);
    if (len + 1e-6 < best) { best = len; bestOrder = cand; }
  }
  return bestOrder;
}

// Farthest and nearest node by cost from the depot (node 0); ties go to the lowest index.
function extremes(nodes, cost) {
  let far = nodes[0], near = nodes[0];
  for (const n of nodes) {
    if (cost[0][n] > cost[0][far]) far = n;
    if (cost[0][n] < cost[0][near]) near = n;
  }
  return { far, near };
}

// The plain sweep: one pinned path through every node. 'homeward' = far stop first, depot
// last; 'outward' = near stop first, far stop last.
export function pureSweepNodes(nodes, cost, dir) {
  nodes = [...nodes].sort((a, b) => a - b);
  if (nodes.length < 2) return nodes;
  const { far, near } = extremes(nodes, cost);
  let start, end;
  if (dir === 'homeward') { start = far; end = 0; }
  else { start = near; end = far === near ? 0 : far; }   // every stop at one radius: nothing to pin at the end
  const pool = nodes.filter((n) => n !== start && n !== end);
  const interior = bestPinnedPath(pool, start, end, cost, dir);
  return [start, ...interior, ...(end === 0 ? [] : [end])];
}

// Group nodes into towns: single-linkage, two nodes within `radius` of each other (either
// direction on an asymmetric matrix) share a town. Towns come back as ascending arrays of node
// indices, ordered by their lowest member — a function of the set, not of the input order.
export function townsOf(nodes, cost, radius) {
  const parent = new Map(nodes.map((n) => [n, n]));
  const find = (n) => { while (parent.get(n) !== n) { parent.set(n, parent.get(parent.get(n))); n = parent.get(n); } return n; };
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (Math.min(cost[a][b], cost[b][a]) <= radius) { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }
    }
  }
  const groups = new Map();
  for (const n of [...nodes].sort((a, b) => a - b)) { const r = find(n); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n); }
  return [...groups.values()].sort((a, b) => a[0] - b[0]);
}

// The shortest hop from any node of A to any node of B, read in the driving direction.
function hop(A, B, cost) {
  let best = Infinity;
  for (const a of A) for (const b of B) if (cost[a][b] < best) best = cost[a][b];
  return best;
}
// The stop of `next` the truck aims for when it leaves `town`: the one closest to any of its stops.
function nearestEntry(town, next, cost) {
  let bestB = next[0], best = Infinity;
  for (const a of town) for (const b of next) if (cost[a][b] < best) { best = cost[a][b]; bestB = b; }
  return bestB;
}

// The two-level sweep: towns first, then the stops inside each.
export function townSweepNodes(nodes, cost, dir, radius = TOWN_RADIUS_METERS) {
  nodes = [...nodes].sort((a, b) => a - b);
  if (nodes.length < 2) return nodes;
  const towns = townsOf(nodes, cost, radius);
  if (towns.length < 2) return pureSweepNodes(nodes, cost, dir);   // one town: nothing to keep whole
  const { far, near } = extremes(nodes, cost);
  const townOf = new Map();
  towns.forEach((t, i) => t.forEach((n) => townOf.set(n, i)));
  const farTown = townOf.get(far), nearTown = townOf.get(near);
  // Outward with the near and the far stop in one town would have to start and finish in the
  // same town — a ring, not a corridor — and the plain sweep is the right tool for a ring.
  if (dir === 'outward' && farTown === nearTown) return pureSweepNodes(nodes, cost, dir);
  // Town-level matrix: index 0 is the depot, t+1 is towns[t].
  const T = towns.length;
  const tc = Array.from({ length: T + 1 }, () => new Array(T + 1).fill(0));
  for (let i = 0; i < T; i++) {
    tc[0][i + 1] = hop([0], towns[i], cost);
    tc[i + 1][0] = hop(towns[i], [0], cost);
    for (let j = 0; j < T; j++) if (i !== j) tc[i + 1][j + 1] = hop(towns[i], towns[j], cost);
  }
  let tStart, tEnd;
  if (dir === 'homeward') { tStart = farTown + 1; tEnd = 0; }
  else { tStart = nearTown + 1; tEnd = farTown + 1; }
  const tPool = towns.map((_, i) => i + 1).filter((t) => t !== tStart && t !== tEnd);
  const townOrder = [tStart, ...bestPinnedPath(tPool, tStart, tEnd, tc, dir), ...(tEnd === 0 ? [] : [tEnd])].map((t) => towns[t - 1]);
  // Inside each town, in that order: from where the truck arrives to where it leaves for next.
  const out = [];
  let prev = -1;
  for (let i = 0; i < townOrder.length; i++) {
    const town = townOrder[i];
    const lastTown = i === townOrder.length - 1;
    const exit = lastTown ? (dir === 'homeward' ? 0 : far) : nearestEntry(town, townOrder[i + 1], cost);
    let seq;
    if (i === 0) {
      const first = dir === 'homeward' ? far : near;           // the pinned first stop
      seq = [first, ...bestPinnedPath(town.filter((n) => n !== first), first, exit, cost, dir)];
    } else if (lastTown && dir === 'outward') {
      seq = [...bestPinnedPath(town.filter((n) => n !== far), prev, far, cost, dir), far];   // the pinned last stop
    } else {
      seq = bestPinnedPath(town, prev, exit, cost, dir);
    }
    out.push(...seq);
    prev = seq[seq.length - 1];
  }
  return out;
}

// The sweep over a card's stops. Node 0 is the depot, node k is stops[k-1]. Stops with no
// usable position cannot be placed on a line and ride at the END in their input order — never
// dropped, never allowed to poison the arithmetic for the ones that can be.
function sweep(stops, depot, dir, mode = SWEEP_MODE) {
  // CANONICAL ORDER FIRST. Tie-breaks and seeds read the order they are handed, and a card's
  // order is whatever the dispatcher last dragged it into — so the same stops in a different
  // order could land in a different local optimum, and re-picking the strategy after a drag
  // "changed its mind". Sorting the placed stops by position (then id) makes the answer a
  // function of the stop SET alone.
  const placed = stops.filter(mappable).sort((a, b) => (a.lat - b.lat) || (a.lng - b.lng) || String(a.id).localeCompare(String(b.id)));
  const unplaced = stops.filter((s) => !mappable(s));
  if (placed.length < 2) return [...placed, ...unplaced];
  const cost = distanceMatrix([depot, ...placed]);
  const nodes = placed.map((_, i) => i + 1);
  const order = mode === 'pure' ? pureSweepNodes(nodes, cost, dir) : townSweepNodes(nodes, cost, dir);
  return [...order.map((k) => placed[k - 1]), ...unplaced];
}

// Farthest first: drive out to the far end, then deliver on the way home, one town at a time.
// First stop is the farthest from the depot; the path from there ends at the terminal.
export function farthestFirst(stops, depot, mode = SWEEP_MODE) { return sweep(stops, depot, 'homeward', mode); }

// Closest first: the nearest stop first, walking outward town by town; the farthest stop is last.
export function closestFirst(stops, depot, mode = SWEEP_MODE) { return sweep(stops, depot, 'outward', mode); }

// ── SEQUENCING ON A REAL ROAD MATRIX ─────────────────────────────────────────
//
// Chad, 2026-09-11, on a 23-stop JEAN card re-sequenced Shortest distance: "Logic is still
// not fixed look at this."
//
// He was right, and it was not the search. Shortest distance was already within 0.6% of the
// best straight-line order on his own routes — there was nothing left to win there. The
// straight line itself is the lie. JEAN works both banks of the Chattahoochee, and the order
// it produced crossed the river FOUR times on legs of half a mile to a mile and a half,
// because on a crow-flies map the two banks are neighbours. Measured against real roads:
//
//   Weezie -> Dexter Axle          0.67 mi straight   3.76 mi by road   5.6x
//   Century -> Switch ATL          1.39 mi            5.26 mi           3.8x
//   Dexter Axle -> National Div.   0.82 mi            3.03 mi           3.7x
//   National Div. -> Bosch         0.50 mi            1.51 mi           3.0x
//
// 3.4 apparent miles, 13.6 real ones, 33 minutes of driving the optimizer could not see. No
// amount of better searching fixes that, because the map it searches is wrong. The only fix
// is to hand it real driving distances — which is what these functions take.
//
// Everything below is the SAME set of strategies as resequence(), re-expressed to read a cost
// MATRIX instead of computing crow-flies internally. Node 0 is the depot and node k is
// stops[k-1], the convention the sweep already used. Feed it a haversine matrix and it agrees
// with resequence() exactly; feed it a Google driving matrix and the river appears.

/** Length of depot -> order[0] -> … (an open path; no return leg). */
export function openPathCost(order, cost) {
  if (!order.length) return 0;
  let total = cost[0][order[0]];
  for (let i = 0; i + 1 < order.length; i++) total += cost[order[i]][order[i + 1]];
  return total;
}

/** Length of depot -> order… -> depot (a closed loop). */
export function loopPathCost(order, cost) {
  if (!order.length) return 0;
  return openPathCost(order, cost) + cost[order[order.length - 1]][0];
}

/** Greedy nearest-neighbour walk from the depot over `nodes`. */
function nnFromDepot(nodes, cost) {
  const remaining = [...nodes].sort((a, b) => a - b);   // canonical: same set, same answer
  const out = [];
  let cur = 0;
  while (remaining.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < remaining.length; i++) { const d = cost[cur][remaining[i]]; if (d < bd) { bd = d; bi = i; } }
    cur = remaining.splice(bi, 1)[0];
    out.push(cur);
  }
  return out;
}

/**
 * 2-opt + or-opt over an order scored by `score`, which is either openPathCost (Shortest
 * distance: the depot is pinned at the front, the last stop is free) or loopPathCost (Loop:
 * the depot is pinned at both ends). Scored whole rather than by edge deltas because the two
 * objectives differ in which edges a move touches, and at a card's size (well under the
 * 150-stop cap) the whole-path score is still milliseconds — correctness over cleverness on
 * a path that a dispatcher is about to send a truck down.
 */
function improveOrder(order, cost, score, maxPasses = 40) {
  let best = [...order];
  if (best.length < 2) return best;
  let bestLen = score(best, cost);
  const EPS = 1e-6;
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const len = score(cand, cost);
        if (len + EPS < bestLen) { best = cand; bestLen = len; improved = true; }
      }
    }
    for (let len_ = 1; len_ <= 3 && len_ < best.length; len_++) {
      for (let i = 0; i + len_ <= best.length; i++) {
        const seg = best.slice(i, i + len_);
        const rest = best.slice(0, i).concat(best.slice(i + len_));
        const segRev = [...seg].reverse();
        let moved = false;
        for (let j = 0; j <= rest.length && !moved; j++) {
          for (const piece of (len_ > 1 ? [seg, segRev] : [seg])) {
            if (j === i && piece === seg) continue;
            const cand = rest.slice(0, j).concat(piece, rest.slice(j));
            const l = score(cand, cost);
            if (l + EPS < bestLen) { best = cand; bestLen = l; improved = true; moved = true; break; }
          }
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

/**
 * Re-sequence on a cost MATRIX. `stops` are the card's stops in any order; `cost` is
 * (stops.length + 1)² with node 0 the depot and node k+1 = stops[k]. Returns a permutation of
 * `stops`, same contract as resequence(). Strategies mean exactly what they mean there.
 *
 * A stop the matrix cannot score (a missing or non-finite row) is not silently dropped and is
 * not allowed to poison the arithmetic either: it rides at the END in its own order, the same
 * rule sweep() uses for a stop with no map position.
 */
export function resequenceOnMatrix(stops, cost, strategy, mode = SWEEP_MODE) {
  const arr = Array.isArray(stops) ? stops : [];
  if (arr.length < 2) return [...arr];
  if (strategy === 'reverse') return [...arr].reverse();
  // WHICH STOPS THE MATRIX CAN ACTUALLY SCORE. A node needs a finite cost to and from the
  // depot, and to and from every other node that survives. It is a pairwise question, not a
  // per-row one: one unreachable address puts a NaN in EVERY other stop's row, so a naive
  // "is this whole row finite" test throws the entire card away over one bad geocode.
  const all = arr.map((_, i) => i + 1);
  const finite = (a, b) => Number.isFinite(cost?.[a]?.[b]);
  let keep = all.filter((k) => Array.isArray(cost?.[k]) && finite(0, k) && finite(k, 0));
  for (let guard = 0; guard < all.length; guard++) {
    const next = keep.filter((k) => keep.every((j) => j === k || (finite(k, j) && finite(j, k))));
    if (next.length === keep.length) break;
    keep = next;
  }
  const keepSet = new Set(keep);
  const nodes = keep;
  const unusable = all.filter((k) => !keepSet.has(k));
  if (nodes.length < 2) return [...arr];
  let order;
  switch (strategy) {
    case 'closest': order = mode === 'pure' ? pureSweepNodes(nodes, cost, 'outward') : townSweepNodes(nodes, cost, 'outward'); break;
    case 'farthest': order = mode === 'pure' ? pureSweepNodes(nodes, cost, 'homeward') : townSweepNodes(nodes, cost, 'homeward'); break;
    case 'loop': order = improveOrder(nnFromDepot(nodes, cost), cost, loopPathCost); break;
    case 'min': order = improveOrder(nnFromDepot(nodes, cost), cost, openPathCost); break;
    default: return [...arr];
  }
  return [...order, ...unusable].map((k) => arr[k - 1]);
}

// Re-sequence one route's stops by strategy. 'reverse' flips the current order;
// the others are computed fresh from depot + positions.
//   loop     — nearest-neighbour seed + closed-loop 2-opt → U-shape (down one side,
//              back the other), the no-crisscross order for a highway corridor.
//   min      — nearest-neighbour seed + open-path 2-opt → shortest one-way distance.
//   farthest — far stop first, then the shortest sweep home (see above).
//   closest  — near stop first, then the shortest sweep out to the far stop.
export function resequence(stops, depot, strategy) {
  const arr = Array.isArray(stops) ? stops : [];
  if (arr.length < 2) return [...arr];
  switch (strategy) {
    case 'reverse': return [...arr].reverse();
    case 'closest': return closestFirst(arr, depot);
    case 'farthest': return farthestFirst(arr, depot);
    case 'loop': return twoOptLoop(nearestNeighbor(arr, depot), depot);
    case 'min': return twoOpt(nearestNeighbor(arr, depot), depot);
    default: return [...arr];
  }
}

// Is this stop already committed to a load?
//
// Drives the Routing map's muted "already planned" pin. Trusts the board's own isPlanned
// flag first (what the scan and the save write-through both set), then falls back to simply
// carrying a route/load name — a row from an older cache shape can have the name without the
// flag, and a planned stop that reads unplanned is the failure this exists to prevent.
// isUnplanned wins outright: the write-through sets it explicitly when a stop comes OFF a
// load, and a stale routeName can still be sitting on that row.
export function isPlannedStop(s) {
  if (s?.isUnplanned === true) return false;
  if (s?.isPlanned === true) return true;
  return !!(s?.routeName || s?.loadNbr);
}

// ── THE SELECTION ROW'S BACKGROUND ──────────────────────────────────────────
//
// Three facts share one row and they must not overwrite each other:
//
//   GREEN  = a tractor trailer can be sent to this stop. It is a fact about the freight, it
//            drives the "Drop N non-tractor" button beside it, and a dispatcher reads it to
//            decide what equipment goes out.
//   RED    = somebody here has said a 53-footer CANNOT serve this stop — a Box-only mark or a
//            confirmed "No tractor trailer" (tractorBlockedSelection, the map's own rule).
//            Chad, 2026-09-16: "i want a no tractor trailer stop to highlight red in selection
//            panel." It is NOT the whole not-green set: unknown stays neutral, because a red
//            that fires on "nobody has checked" is a red a dispatcher learns to read past.
//   HOVER  = the pointer (or the MAP, through the shared hoverId) is on this row right now.
//            It is transient and says nothing about the stop.
//
// The first version painted every hovered row one amber fill, which erased the green while the
// pointer sat on it. Chad: "I don't want it to wash out a tractor friendly row so for those make
// the highlight a form of green." So a green row hovers to a DEEPER GREEN and never to the
// neutral tone — the highlight moves within the colour that carries the meaning, instead of
// replacing it.
//
// It is a pure function because the rule is worth a test and a className buried in JSX is not
// reachable from one. The browser guard cannot cover the green case at all: `tractorOk` is
// computed from customer_notes, which is a Firestore subscription that page.route cannot stub.
export const ROW_TONE = {
  plain: 'hover:bg-slate-50',
  plainHot: 'bg-slate-200',
  tractor: 'bg-green-100 hover:bg-green-200/70',
  // A step further than the resting green rather than a step towards grey, and a big enough
  // step to be seen: the neutral row goes from no fill at all to slate-200, so matching that
  // strength inside the greens takes 100 → 300, not 100 → 200.
  tractorHot: 'bg-green-300',
  // The red hovers WITHIN its own colour for the same reason the green does (v0.98.3): the
  // fill is carrying a fact about the freight, and a pointer must never eat it. Same 100 → 300
  // step, so the highlight is as visible on a blocked row as on any other.
  blocked: 'bg-red-100 hover:bg-red-200/70',
  blockedHot: 'bg-red-300',
};

/**
 * The background classes for one row of the selection panel.
 *
 * BLOCKED IS TESTED FIRST, and it is not a tie-break that can ever be reached in practice:
 * tractorBlockedSelection is the complement of two of tractorFriendlySelection's own refusal
 * branches, so a blocked row is never also tractorOk. It is ordered this way because if the
 * two callers ever DID disagree, the safe row is the one that says a trailer cannot come here
 * — telling a dispatcher a 53-footer fits at a dock somebody wrote off costs a driver his
 * morning and the customer the delivery, and the other mistake costs a trailer slot.
 */
export function selectionRowTone({ tractorOk = false, blocked = false, hot = false } = {}) {
  if (blocked) return hot ? ROW_TONE.blockedHot : ROW_TONE.blocked;
  if (tractorOk) return hot ? ROW_TONE.tractorHot : ROW_TONE.tractor;
  return hot ? ROW_TONE.plainHot : ROW_TONE.plain;
}

/** Does this tone carry the tractor-friendly green? Used by the tests, and by anything that
 *  needs to ask "is this row still saying a trailer fits" without re-deriving the rule. */
export function toneIsGreen(tone) {
  return /(^|\s|:)bg-green-/.test(String(tone || ''));
}

/** Does this tone carry the "a person said no tractor trailer" red? Same shape as
 *  toneIsGreen, and the pair is what the tests assert can never both be true of one row. */
export function toneIsRed(tone) {
  return /(^|\s|:)bg-red-/.test(String(tone || ''));
}

// THE BOTTOM DATA GRID'S ROW, RANKED. Chad (v1.3.0): "I want this bottom panel to highlight
// the tractor friendly rows." The Selected window has painted a tractor row green since
// v0.46.5; the board's own spreadsheet — the 700 rows a router picks FROM — never did, so the
// only way to learn which stops a 53-footer could run was to select them first and look. Now
// the grid reads the same rule (tractorFriendlySelection, through one helper in App.jsx) and
// paints the same green, so the two surfaces cannot disagree about a stop.
//
// FOUR THINGS CAN CLAIM A ROW, ranked by how recent the act behind them is, most recent first:
//   selected  — the map selection tool is on this stop RIGHT NOW (blue; the grid and the
//               lasso must read as one thing)
//   [staged]  — it sits on an open route card, saved to nothing yet. Painted as an INLINE
//               style in the card's own colour by the caller (grid-staged-rows pins that
//               markup), and an inline background beats every class here, so staging sits
//               between selection and the two facts below without this function naming it.
//   tractorOk — a tractor trailer can be sent here: a fact about the freight (green)
//   carryover — folded in from a prior day: a fact about the date (amber)
// A fact about the freight outranks a fact about the date because the router acts on the
// first (which truck) and only NOTES the second — and the Day column already says the day
// in window mode, while nothing else on the row says "a trailer fits".
export const GRID_ROW_TONE = {
  selected: 'bg-blue-100 hover:bg-blue-200/70',
  tractor: ROW_TONE.tractor,
  carryover: 'bg-amber-50/60 hover:bg-blue-50',
  plain: 'hover:bg-blue-50',
};

/** The background classes for one row of the bottom data grid. */
export function gridRowTone({ selected = false, tractorOk = false, carryover = false } = {}) {
  if (selected) return GRID_ROW_TONE.selected;
  if (tractorOk) return GRID_ROW_TONE.tractor;
  if (carryover) return GRID_ROW_TONE.carryover;
  return GRID_ROW_TONE.plain;
}

// ── WHAT A CLICK ON A ROUTING MAP PIN DOES ───────────────────────────────────
//
// Chad, 2026-09-11, about the change he asked for the day before: "i asked that when i click
// on a stop it opens the stop and i don't want that to happen anymore, i don't want it to
// open every order i click on when i'm clicking it on the map." So the order card comes back
// OFF the pin. v1.7.0 put it on every pin in every mode but two; this puts it back.
//
// WHY THE ASK REVERSED, in dispatch terms rather than code terms: a router BUILDS a load by
// clicking pins. A click means "put this on the truck", "show me this route", "grab this
// whole dock" — on a 700-stop morning that is hundreds of them, and it is a rhythm, not a
// series of questions. A full-height order card on each one covers the map, takes the right
// rail away from the route being tuned, and has to be dismissed before the next click. The
// card is a READING tool; the pin is a BUILDING tool. The list rows still open the card, and
// that is the surface where a dispatcher is reading rather than routing.
//
// WHAT A PIN DOES NOW — exactly what it did before v1.7.0:
//   • normal      — a planned pin opens its ROUTE in Compare; a pool pin toggles its whole
//                   place into the selection. No card.
//   • viewing     — a saved load is read-only and the click does nothing.
//   • paint       — marks the stop AND opens the card. LEFT ALONE: that is an older and
//                   separate dispatcher request ("first click does both"), it predates the
//                   card-on-every-pin change, and it is one deliberate click at a time rather
//                   than the routing rhythm. Say the word and it goes too.
//   • selectMode  — hands the draw tool the marker's POSITION. No card.
//   • ninja       — adds the stop to the open route. No card.
//
// PUTTING THE CARD BACK IS ONE LINE: give openPanel `!selectMode && !ninja` again (the tests
// beside this name each case, so they say what would have to change with it). The rule lives
// here and not in the handler because the handler sits inside a marker-building effect in a
// 25,000-line module node:test cannot import, and Google Maps is blocked in the headless
// guard — a decision written there is testable at neither end.
//
// Returns every action the click should take, so the caller is a dispatcher and holds no
// policy of its own.
export function mapPinClickActions({
  viewing = false, paint = false, selectMode = false, ninja = false,
  isUnplanned = false, hasRouteKey = false,
} = {}) {
  const none = { openPanel: false, paint: false, selectPoint: false, ninjaAdd: false, openRoute: false, toggleGroup: false };
  if (viewing) return none;                                        // saved load: read-only, click does nothing
  if (paint) return { ...none, openPanel: true, paint: true };     // the one card a pin still opens
  if (selectMode) return { ...none, selectPoint: true };
  if (ninja) return { ...none, ninjaAdd: true };
  // Normal mode: a planned stop opens its route; a pool stop toggles its whole place.
  const openRoute = !isUnplanned && hasRouteKey;
  return { ...none, openRoute, toggleGroup: !openRoute };
}

// ── THE SETUP PANEL'S OWN RULES (v1.21.0) ────────────────────────────────────
// Each of these was a decision buried in JSX until the panel review of 2026-09-12
// found four of them wrong on screen. A rule in JSX cannot be tested; these can.

// Step 1's tally. THE WORDS ARE THE POINT: the panel used to sum NuVizz `pallets`
// and call it "Loose pieces". `pallets` is the TOTAL piece count (skids + loose);
// loose is `volume`. Chad's own screenshot had the panel saying "Loose pieces 29"
// beside a Selected window saying "0 loose" for the same 24 orders — both computing
// correctly, one mislabelled. `places` is the physical-stop count the Compare
// header uses (orders sharing a matchKey ride together as ONE truck stop), so the
// panel and the card finally count in the same unit.
export function selectionTally(stops) {
  let skids = 0, loose = 0, pieces = 0, weight = 0, orders = 0;
  const places = new Set();
  for (const s of stops || []) {
    if (!s) continue;
    orders += 1;
    skids += Number(s.cartons) || 0;    // NuVizz totalCartons = skids
    loose += Number(s.volume) || 0;     // NuVizz volume = loose pieces
    pieces += Number(s.pallets) || 0;   // NuVizz totalPallets = TOTAL pieces (skids + loose)
    weight += Number(s.weight) || 0;
    places.add(s.matchKey || String(s.stopNbr ?? ''));
  }
  return { orders, places: places.size, skids, loose, pieces, weight };
}

// The strategy dropdown. "Min time" is "Min distance" on the free estimate — the
// haversine matrix makes every duration a constant multiple of its distance, so the
// same order wins both (measured: 50 random boards of 10–49 stops, 50/50 identical).
// Only live Google drive-times give the two anything to disagree about, so the option
// is offered only then; the dispatcher's pick is REMEMBERED and comes back the moment
// Google is ticked again (effectiveStrategy reads it, nothing overwrites it).
export const ROUTING_STRATEGIES = [
  ['MIN_DISTANCE', 'Min distance'],
  ['MIN_TIME', 'Min time'],
  ['CLOSEST_FIRST', 'Closest first'],
  ['FARTHEST_FIRST', 'Farthest first'],
];
export function strategyChoices(useGoogle) {
  return ROUTING_STRATEGIES.map(([value, label]) => {
    const gated = value === 'MIN_TIME' && !useGoogle;
    return { value, label: gated ? `${label} (needs Google drive-times)` : label, disabled: gated };
  });
}
export function effectiveStrategy(strategy, useGoogle) {
  const known = ROUTING_STRATEGIES.some(([v]) => v === strategy);
  if (!known) return 'MIN_DISTANCE';
  return (strategy === 'MIN_TIME' && !useGoogle) ? 'MIN_DISTANCE' : strategy;
}

// "Only put green stops on a 53′ trailer" is a rule about TRAILERS. With no tractor
// among the vehicles in play it changes nothing — tractorOnlyGreen only adds
// box_truck_only to non-green stops, which a box truck satisfies — so the checkbox is
// shown disabled with the reason rather than offered as a choice that does nothing.
export function tractorInPlay(profiles) {
  return (profiles || []).some((p) => p?.capabilities?.tractor === true);
}

// The result panel's Save writes a plan COPY to our own store; the Compare card's Save
// writes NuVizz. With a loads-bound build now staging itself, both are on screen at
// once, so only the one that sends may say "Save".
export function planCopyLabels(loadsBound) {
  if (loadsBound) {
    return {
      title: 'Keep a copy as',
      button: 'Keep a copy (our system only)',
      hint: 'A copy of this plan in our system — it does not send anything. Save on the Compare cards is what writes NuVizz.',
    };
  }
  return { title: 'Save as', button: 'Save load', hint: null };
}

// What the result panel says about AI assist. Three states, because "off" used to
// cover two very different facts: the dispatcher never asked, or asked and the site
// has no key — and the second one is a configuration problem somebody has to fix.
export function aiAssistStatus({ requested = false, configured = false, ai = null } = {}) {
  if (!requested) return 'off';
  if (!configured) return 'requested — ANTHROPIC_API_KEY is not set on the site';
  const used = [ai?.intent && 'note read', ai?.explain && 'rationale', ai?.geometry && 'geometry'].filter(Boolean);
  return used.length ? `on — ${used.join(', ')}` : 'on — nothing needed it';
}

// A truck profile draft in "Trucks" mode. The old fields wrote Firestore on blur; a
// blank Skids box became Number('') = 0 and a 0-skid fleet profile for every later
// build in both modes. Nothing writes until it is a truck: every capacity a positive
// finite number, liftgate a boolean, and something actually changed.
export const PROFILE_NUMERIC_FIELDS = [
  ['maxSkids', 'Skids'],
  ['maxWeightLbs', 'Weight'],
  ['deckLengthIn', 'Deck in'],
];
export function profileDraftCheck(draft, saved) {
  const problems = [];
  const normalized = { ...(saved || {}), ...(draft || {}) };
  for (const [k, label] of PROFILE_NUMERIC_FIELDS) {
    const raw = draft?.[k];
    const n = typeof raw === 'string' ? Number(raw.trim() === '' ? NaN : raw) : Number(raw);
    if (!Number.isFinite(n) || n <= 0) problems.push(`${label} must be a number above 0`);
    else normalized[k] = n;
  }
  normalized.capabilities = { ...(saved?.capabilities || {}), ...(draft?.capabilities || {}) };
  normalized.capabilities.liftgate = !!normalized.capabilities.liftgate;
  const dirty = PROFILE_NUMERIC_FIELDS.some(([k]) => Number(draft?.[k]) !== Number(saved?.[k]))
    || !!draft?.capabilities?.liftgate !== !!saved?.capabilities?.liftgate;
  return { dirty, valid: problems.length === 0, problems, normalized };
}


// ── THE PANEL'S SEND CONTROL, AND WHY IT IS NEVER HIDDEN (v1.36.0) ──────────
//
// Chad, Sep 15, looking at a Compare card reading NOT SENT TO NUVIZZ on a screen with
// nothing to send it with: "where is my save send to nuvizz button? ... i have no way
// to send these loads to nuvizz."
//
// READ OFF THE CODE, NOT GUESSED AT. Every send control in the Compare header — the Save
// button, the RWB engine badge and the ● LIVE / ○ Beta switch — was gated on `liveWrite`:
// a PER-DEVICE localStorage toggle ('routing.liveWrite') that lives in the Routing gear
// labelled "Live dispatch (assign driver + dispatch)". It seeds from VITE_NUVIZZ_WRITE_BETA
// (default false) the first time a browser loads the app, then persists its own answer. So
// a new device, cleared site data, a private window or one stray click leaves the dispatcher
// with a fully working planning screen and NO WAY TO SEND ANYTHING OFF IT. The card chip
// added in v1.33.0 is not gated on that toggle, which is how the two came to share a screen:
// a card announcing it is unsent, above a header offering nothing to send it with.
//
// THE GEAR IS ABOUT THE DRIVER-ASSIGN + DISPATCH ROW — its own comment says so, and that
// row stays behind it. Sending what is already staged is not an optional extra on this
// screen, it is the screen's whole purpose, and the two mistakes are nowhere near
// symmetrical: a hidden Save blocks the morning outright and looks like a working app,
// while a Save that is shown when it "need not" be still cannot write without LIVE mode AND
// the server's own NUVIZZ_WRITE_ENABLED. So this renders whenever a card is open, always.
//
// BETA STILL WINS OVER EVERY SEND WORDING (the v1.33.0 rule): in Beta the button must never
// say "Send to NuVizz", because in Beta it sends nothing at all.
export function sendControlState({ openCards = 0, dirtyCards = 0, liveMode = true } = {}) {
  const open = Number(openCards) || 0;
  const dirty = Number(dirtyCards) || 0;
  if (open <= 0) return { kind: 'none', tone: 'slate', label: '', title: '', actionable: false };
  if (dirty > 0) {
    return liveMode
      ? { kind: 'send', tone: 'red', label: `Send to NuVizz (${dirty})`, actionable: true, title: `Send the staged changes on ${dirty} card(s) to NuVizz now.` }
      : { kind: 'beta', tone: 'blue', label: `Save (${dirty}) — Beta`, actionable: true, title: 'The workbench is in Beta: Save only simulates and NOTHING is sent. Switch to ● LIVE to write NuVizz.' };
  }
  // Nothing staged → nothing rendered, exactly as the header behaved before v1.33.0
  // (whose "All sent / Nothing to send" text was reverted in v1.36.1).
  return { kind: 'none', tone: 'slate', label: '', title: '', actionable: false };
}

// ── THE MARK THAT SAYS THE SAVE LANDED (v1.37.0) ────────────────────────────
//
// Chad, 2026-09-16, pointing at a Compare card: "I want a check mark somewhere denoting
// that the save to nuvizz was successful."
//
// WHAT HE IS LOOKING AT WHEN HE ASKS THAT, read off the code rather than guessed at. On a
// confirmed save the card itself says nothing. The report is a TOAST at the top of the
// workbench — "✓ 1 load(s) saved to NuVizz" — which has a dismiss ✕ on it and which the
// next action overwrites, plus the Send button disappearing once nothing is staged. Five
// minutes later a card that went to NuVizz and a card nobody has touched are identical on
// screen, and the only way left to settle it is to open the load in the NuVizz portal or
// send it a second time.
//
// AND THE OTHER HALF, ASKED FOR THE SAME DAY. Chad: "what about a card that says did not
// save after I did send it? … this is just a chip to tell us if it did or did not
// successfully save after it was sent to NuVizz." So the rule has exactly two things to
// say, and BOTH are about a send that actually happened.
//
// THAT IS THE LINE BETWEEN THIS AND THE CHIP THAT WAS REVERTED. v1.33.0's amber NOT SENT
// TO NUVIZZ fired on any card carrying staged changes — including one nobody had ever
// tried to send — so it shouted at work in progress. This ✗ is only ever earned by a send
// that was MADE and REFUSED. A card nobody has sent still says nothing at all, and neither
// the header wording nor the map paint of that PR comes back with it.
//
// Nothing outside the card reads either stamp.
//
// THE TWO WAYS TO BE WRONG ARE NOWHERE NEAR SYMMETRICAL. A missing tick after a real save
// costs an annoyance — the dispatcher sends again and the second save is a no-op. A tick
// on a card NuVizz does not hold is freight that reads as routed and never gets driven,
// and nobody goes looking for it because the screen already said it was fine. So the tick
// is earned strictly, on both halves of "successful":
//
//   • WHEN IT IS EARNED — `savedAt` is stamped in ONE place, markSaved, which runs on a
//     CONFIRMED write and nowhere else: Beta returns long before it, and a refused or
//     partial save never reaches it. A wiring test pins that it has exactly one writer, so
//     this mark can never report an intent as an outcome.
//   • WHEN IT IS WITHDRAWN — the moment the card stops matching what was sent. `dirty` is
//     the same flag the Send button counts, so one drag, one strike-off, one driver pick
//     takes the tick away until the next confirmed save puts it back. A tick sitting over
//     unsent changes is the expensive direction, and this is what stops it.
//
// A ZERO IS NOT A TIMESTAMP. Number(null) is 0 and 0 is finite — the same shape that once
// mailed a customer a midnight deadline for a stop with no deadline at all — so the stamp
// has to be a positive number before this says anything.
export function fmtClockMs(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const ap = d.getHours() >= 12 ? 'PM' : 'AM';
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`;
}

// A stamp is only a stamp if it is a positive number. Number(null) is 0 and 0 is finite.
const stampOf = (v) => { const t = Number(v); return Number.isFinite(t) && t > 0 ? t : 0; };

export function savedMark({ savedAt = null, failedAt = null, dirty = false } = {}) {
  const ok = stampOf(savedAt);
  const bad = stampOf(failedAt);

  // THE MOST RECENT OBSERVED OUTCOME WINS, and a TIE GOES TO THE ✗. Both stamps are written
  // only where the result is read, so the later one is the later truth. On the knife edge the
  // safe answer flips compared with the tick above: a ✗ on a load that did save costs one
  // re-send, which is idempotent; a ✓ on a load that did not is freight nobody drives.
  if (bad && (!ok || bad >= ok)) {
    const clock = fmtClockMs(bad);
    return {
      show: true,
      kind: 'failed',
      label: `✗ DID NOT SAVE ${clock}`,
      clock,
      // It does NOT go away when you edit the card: the load is still not in NuVizz, and that
      // stays true however much the card is changed. Only a confirmed save clears it.
      title: `Sent at ${clock} and NuVizz REFUSED it — this load is NOT in NuVizz. The toast carried NuVizz's own reason. Fix it and send again; this stays until a save is confirmed.`,
    };
  }

  if (!ok) return { show: false, kind: 'none', label: '', title: '', clock: '' };
  const clock = fmtClockMs(ok);
  // Saved, then edited: the load in NuVizz is no longer what this card shows, so the mark
  // goes. It says nothing in its place — an amber "not sent" chip is exactly what was
  // reverted in v1.36.1, and it was not asked for here.
  if (dirty) return { show: false, kind: 'stale', label: '', title: '', clock };
  return {
    show: true,
    kind: 'sent',
    label: `✓ SENT ${clock}`,
    clock,
    title: `Sent to NuVizz at ${clock}, and NuVizz confirmed the write — this card matches the load. Change anything on it and the tick goes until you send again.`,
  };
}

// ── WHICH TRUCK RUNS THIS LOAD — ONE TAP, AND IT STICKS (v1.34.0) ────────────
//
// Chad: "on the loads when we put them in the [selection] panel make a quick button tractor
// or box truck and have system remember the choice going forward."
//
// WHAT IT REPLACED, AND WHY THE ASK IS RIGHT. Each ticked load row carried a <select> of every
// truck profile, defaulted by a REGEX ON THE LOAD'S NAME — /(trailer|trl|53)/. Read that
// against the names Davis actually runs (ALPHA, ALPHA 2, ATL, SUW, SUW 2) and it never
// matches once, so EVERY load defaulted to the box profile, every day, and a load that runs a
// tractor had to be re-picked from a dropdown on every single build. Forget once and the
// solver plans a 28-skid trailer's work at a 14-skid box's ceiling, or refuses tractor-only
// freight onto a box that could not have taken it anyway. A daily correction the system threw
// away overnight is the cheapest kind of bug to fix and the most expensive to keep.
//
// FIVE SOURCES, IN ORDER, AND THE ORDER IS THE DESIGN:
//
//   picked       what the dispatcher tapped in this session. Nothing outranks a person.
//   remembered   what they tapped on this load NAME before — the memory Chad asked for.
//   assigned     what NUVIZZ says is on this load today (the load header's vehicleType,
//                resolved by route-classes.mts and already in the browser for the day on
//                screen, at zero calls). A fact beats a regex.
//   name         the old /(trailer|trl|53)/ guess, kept as the last resort it always was.
//   default      the box profile — the smaller truck, so an unknown never over-plans.
//
// THE MEMORY IS KEYED ON THE LOAD'S NAME, NOT ITS ID. loadId and loadNbr are minted fresh for
// every day's roster, so a memory keyed on either would forget overnight — which is the exact
// thing this exists to stop.
//
// AND `remembered` OUTRANKING `assigned` IS A DELIBERATE, VISIBLE CHOICE. They are different
// claims: "SUW runs a tractor" is Chad's standing plan for a name; "a box is on SUW today" is
// a fact about this morning (route-classes.mts: "on exactly the day that matters — tractor in
// the shop, driver in a rental box — the header knows"). He asked to be remembered, so the
// memory wins — but when the two DISAGREE the row says so in one line, because a standing
// preference quietly out-planning the truck that is actually in the yard is a refused
// delivery nobody would go looking for. One tap follows NuVizz; doing nothing keeps his plan.
export const LOAD_VEHICLE_CLASSES = ['box', 'tractor'];

// Which class a truck PROFILE is. `capabilities.tractor` is the field the solver itself reads
// (routing-constraints.equipmentReqOk), so it is the field that decides here too; the length
// fallback catches a profile somebody added with the length filled in and the flag not.
export function vehicleClassOf(profile) {
  const cap = profile?.capabilities;
  if (cap?.tractor === true) return 'tractor';
  if (Number(cap?.lengthClassFt) >= 40) return 'tractor';
  return 'box';
}

// The profile that RUNS a class, out of the profiles the fleet actually has. `null` when the
// fleet has none of that class — which is a button to disable with a reason, never a silent
// no-op.
export function profileForClass(profiles = [], cls) {
  const list = Array.isArray(profiles) ? profiles.filter(Boolean) : [];
  return list.find((p) => vehicleClassOf(p) === cls) || null;
}

// The two buttons, with the profile each would use. A class the fleet cannot run comes back
// disabled and SAYS WHY — an enabled button that does nothing teaches that the control is
// broken, and this one decides what the truck can carry.
export function loadVehicleChoices(profiles = []) {
  return LOAD_VEHICLE_CLASSES.map((cls) => {
    const profile = profileForClass(profiles, cls);
    const label = cls === 'tractor' ? 'Tractor' : 'Box';
    return {
      cls,
      label,
      profile,
      disabled: !profile,
      title: profile
        ? `Plan this load as a ${label.toLowerCase()} — ${profile.label || profile.id}. Remembered for this load name from now on.`
        : `No ${label.toLowerCase()} profile in the fleet. Add one in 2 · Plan onto → Trucks.`,
    };
  });
}

// The Firestore document id for a load NAME's remembered class.
//
// A document id may not contain '/', may not be '.' or '..', and may not match __…__. Davis's
// load names are route codes ("SUW 2", "ALPHA"), so this is belt and braces — but an id built
// by substitution has to stay INJECTIVE, because two load names collapsing onto one id is a
// load silently inheriting another load's truck, and nobody would ever think to look here for
// it. '~' is the escape and is escaped first, every escape is delimited at both ends, so the
// mapping can always be read back. The 200-character cap is above any name a TMS route code
// can carry; names are normalised (trim, lowercase, whitespace collapsed) so "SUW  2" and
// "suw 2" are the same load.
export function loadVehicleKey(name) {
  const n = String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
  if (!n) return null;
  // ONE pass, and that is load-bearing: '~' is not in the allowed set, so it escapes to
  // '~7e~' here like anything else. Escaping it in a separate earlier pass — the obvious
  // way to write this — feeds '~7e~' straight back into the second replace, which escapes
  // its own delimiters and turns a name into mush that no longer reads back.
  const esc = n.replace(/[^a-z0-9 ._-]/g, (c) => `~${c.charCodeAt(0).toString(16)}~`);
  return /^\.\.?$/.test(esc) || /^__.*__$/.test(esc) ? `n${esc}` : esc;
}

/**
 * WHICH TRUCK THIS LOAD IS PLANNED AS, and WHERE THAT CAME FROM. Pure; the panel renders it
 * and the build sends `profile` straight to the solver as the load's capacity + capability.
 *
 * `source` is returned because the five sources are not equally strong and a screen is
 * entitled to say which one it is quoting — the same reasoning as route-classes' own
 * `sourceByRoute`. `conflict` is true only when a class the FLEET CAN RUN is assigned in
 * NuVizz today and the row is planned as something else; an assigned class with no profile
 * behind it is not actionable, so it raises nothing.
 */
export function resolveLoadVehicle({ profiles = [], name = '', picked = null, remembered = null, assigned = null } = {}) {
  const runnable = (c) => (c === 'tractor' || c === 'box') && !!profileForClass(profiles, c);
  const use = (c, source) => (runnable(c) ? { cls: c, source } : null);
  const nameGuess = /(^|\W)(trailer|trl|53)(\W|$)/i.test(String(name || '')) ? 'tractor' : null;
  const hit = use(picked, 'picked')
    || use(remembered, 'remembered')
    || use(assigned, 'assigned')
    || use(nameGuess, 'name')
    || use('box', 'default')
    || use('tractor', 'default');
  if (!hit) return { cls: null, source: 'none', profile: null, assigned: null, conflict: false };
  return {
    cls: hit.cls,
    source: hit.source,
    profile: profileForClass(profiles, hit.cls),
    assigned: runnable(assigned) ? assigned : null,
    conflict: runnable(assigned) && assigned !== hit.cls,
  };
}

// ── AREA SELECT: WHAT A BOX, LASSO OR "ADD IN VIEW" MAY PICK UP (v1.36.3) ───────────
//
// Chad, Sep 15, with CHE and MARCUS sent to NuVizz and their stops coming back up in a
// box-select: "its letting me select stops that are already on routes that have been sent to
// nuvizz". Read off the code: the three area tools took EVERY positioned stop inside the
// shape and skipped only a stop staged on an open Compare card (v0.45.15) or one another
// device was staging (v0.51.0). A stop the board holds PLANNED on a load with no card open
// was never on that list — it wears the muted slate pin and still rode into the selection.
//
// THE LOGISTICS READING. A box is how the next truck gets built. Freight that is already on
// CHE must not be picked up into the selection for MARCUS: the best case is a Save refused by
// NuVizz's own guard, the worst is a second truck built on top of the first. The other
// mistake — a stop the board wrongly holds planned that the box now leaves behind — costs a
// tap: the pin opens its route and says which load has it. Those costs are not close.
//
// THE RULE, tested here and read by one caller (addEnclosed in App.jsx, thin): staged on an
// open card → skipped as before; staged on another device → skipped as before; PLANNED on a
// load (isPlannedStop — the pin's own predicate, so the map and the box cannot disagree) →
// skipped, and the action line NAMES the loads so the dispatcher can see what was left out.
//
// PUT IT BACK: VITE_ROUTING_AREA_SELECT_SKIPS_PLANNED=off restores the old rule on the next
// build (build-time flag — a redeploy either way). House shape: ON unless an explicit
// off-word; anything malformed leaves it ON, so a typo can never silently reopen the hole.
export function areaSelectSkipsPlanned(raw) { return houseSwitchOn(raw); }

/**
 * THE HOUSE SWITCH SHAPE, one implementation instead of one per flag: default ON, an explicit
 * off-word turns it off, and ANYTHING MALFORMED LEAVES IT ON. A typo in an env var must never
 * silently disable a rule — that failure is invisible, and a quiet feature looks exactly like
 * a working one.
 */
export function houseSwitchOn(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

/**
 * Split the stops inside a box / lasso / viewport into what the selection may take and
 * what it must leave, with the reason for each.
 *
 * @param {Array} stops     every positioned stop inside the shape
 * @param {object} opts
 * @param {Map|Set} opts.staged   stopNbr → card key for every stop on an open Compare card
 * @param {Map|Set} opts.claims   stopNbr → name for every stop another device is staging
 * @param {boolean} opts.skipPlanned  the switch above (default true)
 * @returns {{ take: Array, onCards: Array, onPeer: Array, onLoads: Array, loads: Map }}
 *          loads = load name → how many of the skipped planned stops it holds
 */
export function areaSelectPartition(stops, { staged = null, claims = null, skipPlanned = true } = {}) {
  const take = [], onCards = [], onPeer = [], onLoads = [];
  const loads = new Map();
  for (const s of stops || []) {
    if (!s) continue;
    const id = String(s.stopNbr ?? '');
    // Order matters for the MESSAGE, not the outcome: a stop on an open card is also a
    // planned stop, and "already on open cards — use Ninja to move it" is the actionable line.
    if (staged && typeof staged.has === 'function' && staged.has(id)) { onCards.push(s); continue; }
    if (claims && typeof claims.has === 'function' && claims.has(id)) { onPeer.push(s); continue; }
    if (skipPlanned && isPlannedStop(s)) {
      onLoads.push(s);
      const name = String(s.routeName || s.loadNbr || '').trim() || 'a load';
      loads.set(name, (loads.get(name) || 0) + 1);
      continue;
    }
    take.push(s);
  }
  return { take, onCards, onPeer, onLoads, loads };
}

// "CHE" for one load, "loads (CHE 9, MARCUS 4)" for several — biggest first, three named,
// the rest counted, so a 700-stop board cannot turn the action line into a paragraph.
export function areaSelectLoadsText(loads) {
  const rows = [...(loads instanceof Map ? loads.entries() : [])].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  if (!rows.length) return 'loads';
  if (rows.length === 1) return rows[0][0];
  const shown = rows.slice(0, 3).map(([name, n]) => `${name} ${n}`);
  const more = rows.length - shown.length;
  return `loads (${shown.join(', ')}${more > 0 ? `, +${more} more` : ''})`;
}

/** The one line the status card shows after an area select. `total` = stops inside the shape. */
export function areaSelectMessage(part, total) {
  const n = Number(total) || 0;
  const pl = (k) => (k === 1 ? '' : 's');
  const c = part?.onCards?.length || 0, p = part?.onPeer?.length || 0, l = part?.onLoads?.length || 0;
  const k = part?.take?.length || 0;
  if (!k) {
    const reasons = [];
    if (c) reasons.push('already on open Compare cards');
    if (p) reasons.push('being staged on another device');
    if (l) reasons.push(`already on ${areaSelectLoadsText(part.loads)}`);
    if (!reasons.length) return 'No stops in that area';
    return `All ${n} stop${pl(n)} ${n === 1 ? 'is' : 'are'} ${reasons.join(' or ')}`;
  }
  return `Added ${k} stop${pl(k)}`
    + (c ? ` · skipped ${c} already on open cards` : '')
    + (p ? ` · skipped ${p} staged on another device` : '')
    + (l ? ` · skipped ${l} already on ${areaSelectLoadsText(part.loads)}` : '');
}

/**
 * THE STOPS ALREADY LIT UP ON THE MAP THAT THE SELECTION DOES NOT YET HOLD.
 *
 * Chad: "i don't want the add selection to prompt me to drag a box i want it to accept what i
 * have already selected" → "accept the stops already highlighted on map."
 *
 * WHAT "HIGHLIGHTED" IS, from the map's own definition and not from a guess: one line in
 * useLegendInventory — `selected OR a search hit`. The selected half is already in the
 * selection, so the half a button can usefully ACCEPT is the burnt-orange search hits, minus
 * anything already selected. A status filter is deliberately NOT highlight: the grid reports
 * it separately because "search is a burnt-orange highlight, never a hide".
 *
 * FED `drawnStops` — what the map is ACTUALLY drawing, filters and all — rather than the
 * grid's raw match list, for one reason a dispatcher pays for: a stop with no geocode has no
 * marker at all, cannot be box-selected, and cannot be routed. Letting one ride in on a search
 * hit is how an order goes silently missing from a build.
 *
 * @param {Array} drawnStops        the stops the map is drawing
 * @param {Set|null} opts.searchMatchIds  String(stopNbr) of the grid's current search hits
 * @param {Set|null} opts.selectedIds     String(stopNbr) already in the selection
 * @returns {Array} the stops to hand to the SAME area-select path box and lasso use
 */
export function highlightedForSelection(drawnStops, { searchMatchIds = null, selectedIds = null } = {}) {
  const has = (set, id) => !!set && typeof set.has === 'function' && set.has(id);
  if (!searchMatchIds) return [];
  const out = [];
  for (const s of drawnStops || []) {
    if (!s || s.lat == null || s.lng == null) continue;
    const id = String(s.stopNbr ?? '');
    if (!has(searchMatchIds, id)) continue;
    if (has(selectedIds, id)) continue;
    out.push(s);
  }
  return out;
}
