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
// Two facts share one row and they must not overwrite each other:
//
//   GREEN  = a tractor trailer can be sent to this stop. It is a fact about the freight, it
//            drives the "Drop N non-tractor" button beside it, and a dispatcher reads it to
//            decide what equipment goes out.
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
};

/** The background classes for one row of the selection panel. */
export function selectionRowTone({ tractorOk = false, hot = false } = {}) {
  if (tractorOk) return hot ? ROW_TONE.tractorHot : ROW_TONE.tractor;
  return hot ? ROW_TONE.plainHot : ROW_TONE.plain;
}

/** Does this tone carry the tractor-friendly green? Used by the tests, and by anything that
 *  needs to ask "is this row still saying a trailer fits" without re-deriving the rule. */
export function toneIsGreen(tone) {
  return /(^|\s|:)bg-green-/.test(String(tone || ''));
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
