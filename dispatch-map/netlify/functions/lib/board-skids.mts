// lib/board-skids.mts — THE DAY'S SKID COUNT, AS THE MAP COUNTS IT.
//
// Chad: "i want the davis delivery drivers board to have a live skid count from the dispatch
// map board." The drivers board (davisdeliverydrivers.netlify.app) builds the day's loads
// against a pallet total its dispatcher used to type in by hand; this is that number, read
// off the same stops the map shows.
//
// THE SKID FIELD IS `cartons`, NOT `pallets`. NuVizz labels them wrong: totalCartons is the
// skid count and totalPallets is total PIECES (lib/nuvizz-scan.mts normalizeStop). The map's
// own "N total pallets" sums `cartons` (src/App.jsx totalPalletsCount), and so does this —
// one rule, so the two boards can never disagree about the same day.
//
// ROUTED vs UNROUTED uses `isUnplanned` (no driver on the stop), the same flag the board feed's
// `unplannedCount` counts (nuvizz-pull-today-stops.mts).
//
// PURE: the caller hands in the stops already filtered the way the board feed filters them
// (prior-day finished bleed stripped, cancelled dropped, UAT planning view applied).

export type BoardSkids = {
  stops: number;
  skids: number;
  routedSkids: number;
  unroutedSkids: number;
  unroutedStops: number;
  /** of the above, the rows folded in from prior days (carryover:true) */
  carryoverStops: number;
  carryoverSkids: number;
  loose: number;
  weight: number;
};

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : 0;
};

export function sumBoardSkids(stops: any[]): BoardSkids {
  const out: BoardSkids = { stops: 0, skids: 0, routedSkids: 0, unroutedSkids: 0, unroutedStops: 0, carryoverStops: 0, carryoverSkids: 0, loose: 0, weight: 0 };
  for (const s of Array.isArray(stops) ? stops : []) {
    if (!s || typeof s !== 'object') continue;
    const sk = n(s.cartons);
    out.stops += 1;
    out.skids += sk;
    out.loose += n(s.volume);
    out.weight += n(s.weight);
    if (s.carryover) { out.carryoverSkids += sk; out.carryoverStops += 1; }
    if (s.isUnplanned) { out.unroutedSkids += sk; out.unroutedStops += 1; } else out.routedSkids += sk;
  }
  out.weight = Math.round(out.weight);
  return out;
}
