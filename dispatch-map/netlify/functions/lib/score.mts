// lib/score.mts
//
// EXACT port of the official Amazon/MIT Last Mile Routing Research Challenge
// scoring metric, from MIT-CAVE/rc-cli scoring/score.py (score, seq_dev,
// erp_per_edit, normalize_matrix, dist_erp/gap_sum, isinvalid, route2list).
// 0 = the proposed sequence is identical to what dispatch actually built.
//
// Faithfulness notes (follow the code, not memory):
//   • normalize_matrix z-scores every entry of the cost matrix (population
//     mean/std over ALL entries, numpy defaults) then shifts so the minimum
//     normalized value is exactly 0.
//   • seq_dev strips the FIRST and LAST elements of both lists (the depot and
//     its duplicated return leg), then sums |pos(i)-pos(i-1)|-1 over adjacent
//     positions of the submitted order within the actual order, scaled by
//     2/(n(n-1)) where n counts the stripped actual list.
//   • erp_per_edit is ERP (Edit distance with Real Penalty, gap g=1000 on the
//     NORMALIZED matrix) divided by the number of edits; 0 edits → 0. The
//     Python recursion only ever compares suffixes, so the memo here is the
//     equivalent (i,j) suffix table, filled with the SAME option ordering and
//     tie-breaking (option_1, then option_2, then option_3 on equality).
//   • Route lists carry the depot at position 0 AND repeated at the end
//     (route2list appends the first stop), exactly like the challenge data.
//
// Everything here is PURE — no I/O, no config, unit-testable, and verified
// against the official Python implementation on shared fixtures (see
// test/routing-engine-score.test.mjs).

export type CostMatrix = Record<string, Record<string, number>>;

// route2list equivalent: the challenge encodes a route as {stopId: position};
// we already hold ordered ids, so building the scoring list is prepending the
// depot and repeating it at the end.
export function toScoreList(depotId: string, orderedStopIds: string[]): string[] {
  return [depotId, ...orderedStopIds, depotId];
}

// isinvalid — same stop set, same length, same first stop.
export function isInvalid(actual: string[], sub: string[]): boolean {
  if (actual.length !== sub.length) return true;
  const a = new Set(actual), s = new Set(sub);
  if (a.size !== s.size) return true;
  for (const x of a) if (!s.has(x)) return true;
  return actual[0] !== sub[0];
}

// normalize_matrix — population z-score over every entry, then shift min to 0.
export function normalizeMatrix(mat: CostMatrix): CostMatrix {
  const values: number[] = [];
  for (const o of Object.keys(mat)) {
    for (const d of Object.keys(mat[o])) values.push(mat[o][d]);
  }
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n; // population, numpy default
  const std = Math.sqrt(variance);
  let minNew = Infinity;
  const zed: CostMatrix = {};
  for (const o of Object.keys(mat)) {
    zed[o] = {};
    for (const d of Object.keys(mat[o])) {
      const v = (mat[o][d] - mean) / std;
      if (v < minNew) minNew = v;
      zed[o][d] = v;
    }
  }
  for (const o of Object.keys(zed)) {
    for (const d of Object.keys(zed[o])) zed[o][d] = zed[o][d] - minNew;
  }
  return zed;
}

// seq_dev — sequence deviation over the depot-stripped lists.
export function seqDev(actual: string[], sub: string[]): number {
  const a = actual.slice(1, -1);
  const s = sub.slice(1, -1);
  const posInActual = new Map<string, number>();
  for (let i = 0; i < a.length; i++) {
    if (!posInActual.has(a[i])) posInActual.set(a[i], i); // list.index = first occurrence
  }
  const compList = s.map((id) => {
    const p = posInActual.get(id);
    if (p === undefined) throw new Error(`seqDev: stop ${id} not in actual`);
    return p;
  });
  let compSum = 0;
  for (let i = 1; i < compList.length; i++) {
    compSum += Math.abs(compList[i] - compList[i - 1]) - 1;
  }
  const n = a.length;
  return (2 / (n * (n - 1))) * compSum;
}

// erp_per_edit — ERP / edit count via the suffix DP equivalent of the official
// memoized recursion, preserving option ordering and tie-breaking.
export function erpPerEdit(actual: string[], sub: string[], normMat: CostMatrix, g = 1000): number {
  const A = actual.length, B = sub.length;
  // d[i][j] / count[i][j] = ERP + edit count comparing actual[i:] to sub[j:].
  const d: number[][] = Array.from({ length: A + 1 }, () => new Array(B + 1).fill(0));
  const count: number[][] = Array.from({ length: A + 1 }, () => new Array(B + 1).fill(0));
  for (let i = A; i >= 0; i--) {
    for (let j = B; j >= 0; j--) {
      if (i === A && j === B) { d[i][j] = 0; count[i][j] = 0; continue; }
      if (j === B) { d[i][j] = (A - i) * g; count[i][j] = A - i; continue; } // gap_sum(actual rest)
      if (i === A) { d[i][j] = (B - j) * g; count[i][j] = B - j; continue; } // gap_sum(sub rest)
      const headA = actual[i], headS = sub[j];
      const distHead = normMat[headA]?.[headS];
      if (distHead === undefined) throw new Error(`erp: missing matrix entry ${headA}→${headS}`);
      const option1 = d[i + 1][j + 1] + distHead;
      const option2 = d[i + 1][j] + g; // dist_erp(headA,'gap') = g
      const option3 = d[i][j + 1] + g; // dist_erp(headS,'gap') = g
      const best = Math.min(option1, option2, option3);
      if (best === option1) {
        d[i][j] = option1;
        count[i][j] = count[i + 1][j + 1] + (headA === headS ? 0 : 1);
      } else if (best === option2) {
        d[i][j] = option2;
        count[i][j] = count[i + 1][j] + 1;
      } else {
        d[i][j] = option3;
        count[i][j] = count[i][j + 1] + 1;
      }
    }
  }
  const total = d[0][0], edits = count[0][0];
  return edits === 0 ? 0 : total / edits;
}

// score — the official per-route score.
export function scoreRoute(actual: string[], sub: string[], costMat: CostMatrix, g = 1000): number {
  const normMat = normalizeMatrix(costMat);
  return seqDev(actual, sub) * erpPerEdit(actual, sub, normMat, g);
}
