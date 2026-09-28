// lib/board-rows.mts — ONE BOARD DAY'S ROWS, AS THE MAP SERVES THEM (v1.77.0). PURE: no I/O.
//
// The Map's feed (nuvizz-pull-today-stops.mts) turns a stored board day into what a dispatcher sees
// in three steps, in this order:
//   1. filterFinishedPriorDay   a finished stop filed on an earlier day never shows on this one
//   2. foldCarryover            with a look-back, still-open unplanned orders from the prior days
//                               fold in, judged by the open-order pool (lib/carryover-fold.mts)
//   3. dropCancelledStops       a cancelled stop is not freight (BOARD_DROP_CANCELLED, default on)
// The Claude shadow's planning area plans exactly that board, so it calls THIS, which calls the same
// three functions in the same order — never a copy of them. The Map keeps its own inline calls
// (its counts sit between steps 2 and 3); test/map-planner-parity-e2e.test.mjs ("THE SAME RULE AS THE
// MAP") holds the two together by running the Map's handler and the planner's own board read against
// one in-memory Firestore, under each judge (the open-order pool, a superseded pool, the unplanned
// snapshot, none), with a retired order, yesterday's stale copies of a cancelled and a mis-filed row
// (so a side that runs these steps in another order serves a different board), and a clock that
// moves while the judges and the look-back are read.
import { filterFinishedPriorDay } from './board-day.mts';
import { foldCarryover, type CarryoverStats, type FoldInputs } from './carryover-fold.mts';
import { dropCancelledEnabled, dropCancelledStops } from '../../../src/lib/stop-cancelled.js';

export function boardRowsAsServed(
  dayRows: any[], date: string, fold: Omit<FoldInputs, 'date'> | null, env: Record<string, any>,
): { rows: any[]; carry: CarryoverStats | null; cancelled: number; cancelledDropOn: boolean } {
  const rows = filterFinishedPriorDay((dayRows || []).slice(), date);
  const carry = fold && fold.reads.length ? foldCarryover(rows, { ...fold, date }) : null;
  const on = dropCancelledEnabled(env || {});
  const { stops, dropped } = dropCancelledStops(rows, on);
  return { rows: stops, carry, cancelled: dropped.length, cancelledDropOn: on };
}
