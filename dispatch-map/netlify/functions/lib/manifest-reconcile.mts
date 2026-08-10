// lib/manifest-reconcile.mts
//
// PURE reconciliation of a shipper manifest against our board. No I/O, no NuVizz,
// no Firestore — the caller supplies both sets and this decides what they mean.
//
// THE POINT: an order can be on Uline's nightly manifest and never reach NuVizz
// at all. Nothing else in this system would notice, because every other check
// starts FROM NuVizz — if the order was never created, there is nothing to be
// missing from. The manifest is the only independent statement of what the
// shipper actually handed us, so it is the only thing that can catch it.
//
// THREE STATES, NOT TWO. "Not on our board" and "not in NuVizz" are different
// claims and conflating them is the trap this module exists to prevent:
//
//   on_board  — the PRO is in our stop index. Costs nothing to determine.
//   missing   — NuVizz was asked about this specific PRO and said it does not
//               exist. This is the actionable finding.
//   unknown   — we could not get an answer we trust. Scans disabled, auth
//               rejected, throttled, the daily-ceiling breaker open, a network
//               error. On any of those the probe fails for EVERY pro at once, so
//               a two-state model would cheerfully report all 660 orders as
//               missing from NuVizz. Unknown is a first-class outcome and is
//               never reported as absence.
//
// Unit-tested in test/manifest-reconcile.test.mjs.

/** Probe reasons that are genuine evidence the PRO does not exist in NuVizz. */
export const ABSENCE_REASONS = new Set(['not_found', 'http_404']);

export function reasonMeansAbsent(reason: any): boolean {
  return ABSENCE_REASONS.has(String(reason ?? '').trim().toLowerCase());
}

// PRO KEYS. The manifest prints 9 digits (007158397); the board's doc id is the
// stopNbr, which is usually the same string but has been seen unpadded, and the
// warehouse/dock scanners match on the last 7 (see load-scan normalizePro). Match
// on the widest set of forms rather than declaring an order missing over a
// leading zero — a false "missing" costs a NuVizz call and a wild goose chase.
export function proKeys(pro: any): string[] {
  const raw = String(pro ?? '').trim();
  // SEGMENT SUFFIX. The board's stopNbr is often "007157687-1" — the 9-digit PRO
  // with a segment number — while the manifest prints the bare 9 digits. Strip
  // that suffix before matching, or every such order reads as missing and the
  // whole report becomes false alarms. Deliberately narrow: only a 1-2 digit tail
  // after a full 9-digit group, so an Estes-style "028-8347656" (where the dash
  // is just formatting inside a 10-digit PRO) is left alone.
  const seg = /^(\d{9})-(\d{1,2})$/.exec(raw);
  const digits = (seg ? seg[1] : raw).replace(/\D/g, '');
  if (!digits) return [];
  const keys = new Set<string>([digits]);
  keys.add(digits.replace(/^0+/, '') || digits);   // unpadded
  keys.add(digits.padStart(9, '0'));               // zero-padded to 9
  if (digits.length >= 7) keys.add(digits.slice(-7)); // dock-scanner rule
  return [...keys].filter(Boolean);
}

/** Index every form of every board PRO so a manifest PRO can be looked up by any of them. */
export function boardProIndex(boardPros: Iterable<any>): Set<string> {
  const idx = new Set<string>();
  for (const p of boardPros) for (const k of proKeys(p)) idx.add(k);
  return idx;
}

export function onBoard(index: Set<string>, pro: any): boolean {
  return proKeys(pro).some((k) => index.has(k));
}

export interface ManifestRowLike { pro: string; custName?: string | null; city?: string | null; zip?: string | null; lbs?: number; skids?: number; pieces?: number; shipDate?: string | null }

export interface OffBoardRow extends ManifestRowLike { state: 'off_board' }

export interface ReconcileBoardResult {
  /** Manifest orders whose PRO is on the board. Nothing to do. */
  onBoardCount: number;
  /** Manifest orders NOT on the board — SUSPECTS ONLY, not yet "missing from NuVizz". */
  offBoard: OffBoardRow[];
  /** Board PROs with no manifest row. Informational: non-Uline freight lives here too. */
  boardOnlyCount: number;
  manifestCount: number;
  /** Duplicate PROs within the manifest itself — a shipper-side data problem worth surfacing. */
  duplicatePros: string[];
}

// STEP 1 — free. Diff the manifest against the board using Firestore only.
export function reconcileAgainstBoard(
  rows: ManifestRowLike[], boardPros: Iterable<any>,
): ReconcileBoardResult {
  const index = boardProIndex(boardPros);
  const seen = new Set<string>();
  const duplicatePros: string[] = [];
  const offBoard: OffBoardRow[] = [];
  let onBoardCount = 0;
  for (const r of rows || []) {
    const digits = String(r?.pro ?? '').replace(/\D/g, '');
    if (!digits) continue;
    if (seen.has(digits)) { duplicatePros.push(digits); continue; }
    seen.add(digits);
    if (onBoard(index, digits)) onBoardCount++;
    else offBoard.push({ ...r, state: 'off_board' });
  }
  // Board rows the manifest never mentioned. Expected and healthy — the board
  // carries every shipper, not just Uline — so this is a count, not a list.
  let boardOnlyCount = 0;
  const manifestIndex = boardProIndex(seen);
  for (const p of boardPros) if (!onBoard(manifestIndex, p)) boardOnlyCount++;

  return { onBoardCount, offBoard, boardOnlyCount, manifestCount: seen.size, duplicatePros };
}

export interface ProbeOutcome { pro: string; ok?: boolean; reason?: string }

export interface VerdictRow extends ManifestRowLike {
  state: 'missing_from_nuvizz' | 'in_nuvizz_off_board' | 'unknown';
  reason?: string;
}

export interface ReconcileVerdict {
  missing: VerdictRow[];
  inNuvizzOffBoard: VerdictRow[];
  unknown: VerdictRow[];
  probed: number;
  /** True when every off-board suspect got a trustworthy answer. */
  conclusive: boolean;
}

// STEP 2 — costs one NuVizz call per suspect. Turn off-board suspects into
// verdicts. Only an explicit not_found/404 becomes "missing"; every other failure
// is unknown, so a disabled scan or an open breaker can never be reported as 660
// missing orders.
export function classifyProbes(
  suspects: ManifestRowLike[], outcomes: ProbeOutcome[],
): ReconcileVerdict {
  const byPro = new Map<string, ProbeOutcome>();
  for (const o of outcomes || []) {
    for (const k of proKeys(o?.pro)) if (!byPro.has(k)) byPro.set(k, o);
  }
  const missing: VerdictRow[] = [];
  const inNuvizzOffBoard: VerdictRow[] = [];
  const unknown: VerdictRow[] = [];
  let probed = 0;
  for (const s of suspects || []) {
    const hit = proKeys(s?.pro).map((k) => byPro.get(k)).find(Boolean);
    if (!hit) { unknown.push({ ...s, state: 'unknown', reason: 'not probed' }); continue; }
    probed++;
    if (hit.ok) inNuvizzOffBoard.push({ ...s, state: 'in_nuvizz_off_board' });
    else if (reasonMeansAbsent(hit.reason)) missing.push({ ...s, state: 'missing_from_nuvizz', reason: hit.reason });
    else unknown.push({ ...s, state: 'unknown', reason: hit.reason || 'no answer' });
  }
  return { missing, inNuvizzOffBoard, unknown, probed, conclusive: unknown.length === 0 };
}

/** One-line summary a human (or an alert email) can act on. */
export function summarize(board: ReconcileBoardResult, verdict?: ReconcileVerdict | null): string {
  const parts = [`${board.manifestCount} on the manifest`, `${board.onBoardCount} on the board`];
  if (board.offBoard.length) parts.push(`${board.offBoard.length} not on the board`);
  if (verdict) {
    if (verdict.missing.length) parts.push(`${verdict.missing.length} NOT IN NUVIZZ`);
    if (verdict.inNuvizzOffBoard.length) parts.push(`${verdict.inNuvizzOffBoard.length} in NuVizz but off the board`);
    if (verdict.unknown.length) parts.push(`${verdict.unknown.length} unverified`);
  }
  if (board.duplicatePros.length) parts.push(`${board.duplicatePros.length} duplicate PRO(s) on the manifest`);
  return parts.join(' · ');
}
