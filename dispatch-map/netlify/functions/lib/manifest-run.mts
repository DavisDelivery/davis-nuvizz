// lib/manifest-run.mts
//
// The FREE half of the manifest check, shared by the two callers that need it:
//   • manifest-check.mts — the HTTP endpoint behind the "drop the PDF" screen
//   • manifest-email-ingest — the scheduled job that runs the same check on the
//     nightly report arriving BY EMAIL (Chad: "This should happen automatically
//     from email parse.")
// Parse the Uline freight-report PDF (text layer — no AI call) and diff its PROs
// against the Firestore stop index. ZERO NuVizz calls, by construction: the probe
// step (one call per suspect) stays in the HTTP endpoint behind an explicit
// human click and is deliberately NOT reachable from any scheduled path.

import { isFirestoreEnabled, listDocs, etDayString } from './firestore.mts';
import { readUlineManifest } from './uline-manifest.mts';
import { deliveryWindow, boardCoverage, gradeSuspects } from '../../../src/lib/manifest-window.js';
import { reconcileAgainstBoard, summarize } from './manifest-reconcile.mts';
import { getCreds } from './nuvizz-scan.mts';

/** "8/06/26" → "2026-08-06". The manifest prints M/DD/YY. */
export function manifestDateToIso(v: any): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const yy = Number(m[3]);
  const year = 2000 + yy;
  const mm = String(Number(m[1])).padStart(2, '0');
  const dd = String(Number(m[2])).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface ManifestDiffOptions {
  dateOverride?: string | null;  // board day to diff against; default = the manifest's ship date
  spanDays?: number;             // also accept the next N DELIVERY days' boards (default 2)
}

/**
 * Parse a freight-report PDF buffer and diff it against the cached board.
 * Returns the exact shape the drop-screen endpoint returns in its free mode —
 * ok:false shapes included — so a stored email-run and a stored manual run are
 * interchangeable to every consumer. Zero NuVizz calls, Firestore reads only.
 */
export async function runManifestBoardDiff(buf: Buffer, opts: ManifestDiffOptions = {}): Promise<any> {
  if (!isFirestoreEnabled()) return { ok: false, error: 'Firestore off — no board to check against' };
  if (buf.subarray(0, 4).toString('latin1') !== '%PDF') return { ok: false, error: 'not a PDF' };

  const manifest = readUlineManifest(buf);
  if (!manifest.rows.length) {
    return { ok: false, notManifest: true, error: 'no orders found — is this the Uline freight report?', warnings: manifest.warnings };
  }

  const spanDays = Math.min(7, Math.max(0, opts.spanDays ?? 2));
  const base = String(opts.dateOverride || '')
    || manifestDateToIso(manifest.rows[0]?.shipDate) || etDayString(new Date());
  // DELIVERY days, not calendar days. The old window was base + 2 calendar days, which is
  // right Monday to Thursday and wrong on a Friday: the next two days are Saturday and
  // Sunday, we deliver on neither, and Monday — where the freight actually moves — fell one
  // day outside. Chad's 2026-08-21 run spent two of its three days on an empty weekend and
  // never opened the board it was really looking for. See src/lib/manifest-window.js.
  const dates = deliveryWindow(base, spanDays);

  let tenant = 'davis';
  try { tenant = String(getCreds().companyCode || 'davis'); } catch { /* default */ }
  const t = tenant.toLowerCase();

  const boardPros: string[] = [];
  const boardDays: Array<{ date: string; stops: number }> = [];
  for (const d of dates) {
    const rows = await listDocs(`nuvizz_stop_index/${t}__${d}/stops`, { mask: ['stopNbr'] }).catch(() => []);
    boardDays.push({ date: d, stops: rows.length });
    for (const r of rows) { const id = String((r as any)?._id ?? (r as any)?.stopNbr ?? ''); if (id) boardPros.push(id); }
  }
  if (!boardPros.length) {
    return {
      ok: false, base, dates, boardDays,
      error: 'no board rows cached for those dates — a scan must run first, or pass ?date=',
    };
  }

  const board = reconcileAgainstBoard(manifest.rows, boardPros);
  // WHAT THESE BOARDS CAN ACTUALLY PROVE. A day with no cached stops was never scanned —
  // for a future delivery day that is the ordinary state until the routing evening runs — so
  // it can neither confirm nor deny an order. Riding this along lets the screen tell
  // "we looked and it is not there" apart from "there is nothing to look at yet".
  const coverage = boardCoverage(boardDays);
  const grade = gradeSuspects(board.offBoard, coverage);
  return {
    ok: true,
    mode: 'board-diff', nuvizzCalls: 0,
    base, dates,
    coverage, grade,
    manifest: {
      orders: manifest.rows.length, totals: manifest.totals,
      verified: manifest.verified, warnings: manifest.warnings,
    },
    checkedAgainst: boardDays,
    onBoard: board.onBoardCount,
    boardOnly: board.boardOnlyCount,
    duplicatePros: board.duplicatePros,
    suspects: board.offBoard,
    summary: summarize(board, null),
    note: !board.offBoard.length
      ? 'Every order on the manifest is on the board. Zero NuVizz calls were made.'
      : grade.verdict === 'unrouted'
        ? `${board.offBoard.length} order(s) on the manifest are not on any board yet, but no board has been built for ${coverage.empty.join(', ') || 'the delivery days checked'} — tomorrow's routes are built in the routing evening. This is not a missing-freight finding; re-check after routing.`
        : `${board.offBoard.length} order(s) on the manifest are not on the board. That is NOT yet "missing from NuVizz" — probe from the Manifest check tab to ask NuVizz about each one.`,
    // The board object rides along for the endpoint's probe step; stored copies drop it.
    _board: board,
  };
}
