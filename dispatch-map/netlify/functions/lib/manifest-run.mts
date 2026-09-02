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
import { parseClosedList } from '../../../src/lib/davis-calendar.js';
import { readUlineManifest } from './uline-manifest.mts';
import { deliveryWindow, manifestWindow, boardCoverage, gradeSuspects } from '../../../src/lib/manifest-window.js';
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
  /** The day we are asking on, YYYY-MM-DD. A required delivery day later than this has not
   *  come round yet, so its board is still being built — see boardCoverage. Defaults to
   *  today in ET; injectable so the rule is testable without moving the clock. */
  asOf?: string | null;
}

/**
 * Parse a freight-report PDF buffer and diff it against the cached board.
 * Returns the exact shape the drop-screen endpoint returns in its free mode —
 * ok:false shapes included — so a stored email-run and a stored manual run are
 * interchangeable to every consumer. Zero NuVizz calls, Firestore reads only.
 */
/** The ship date most rows agree on. One mis-parsed row must not move the whole window. */
function modeShipDate(rows: any[]): string | null {
  const tally = new Map<string, number>();
  for (const r of (rows || [])) {
    const d = String(r?.shipDate || '').trim();
    if (d) tally.set(d, (tally.get(d) || 0) + 1);
  }
  if (!tally.size) return null;
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0][0];
}

export async function runManifestBoardDiff(buf: Buffer, opts: ManifestDiffOptions = {}): Promise<any> {
  if (!isFirestoreEnabled()) return { ok: false, error: 'Firestore off — no board to check against' };
  if (buf.subarray(0, 4).toString('latin1') !== '%PDF') return { ok: false, error: 'not a PDF' };

  const manifest = readUlineManifest(buf);
  if (!manifest.rows.length) {
    return { ok: false, notManifest: true, error: 'no orders found — is this the Uline freight report?', warnings: manifest.warnings };
  }

  const spanDays = Math.min(7, Math.max(0, opts.spanDays ?? 2));
  // THE SHIP DATE IS NOT THE DELIVERY DAY. Chad: "Uline date column in manifest is date
  // shipped so expectation is we deliver it next business day except for the manifest we get
  // on sundays that is for Tuesday." The check had been using the column straight as a board
  // date and absorbing the difference with a tolerance window — which is why a Friday manifest
  // was diffed against Friday's board and reported 18 orders missing that were never for
  // Friday at all. manifestWindow does the real mapping, Sunday exception included.
  //
  // Mode of the ship dates, not rows[0]: one stray row must not move the whole window.
  const shipIso = manifestDateToIso(modeShipDate(manifest.rows));
  const override = String(opts.dateOverride || '');
  const win = override
    ? { expected: override, required: [override], dates: deliveryWindow(override, spanDays) }
    : manifestWindow(shipIso, spanDays, parseClosedList(process.env.ULINE_DAVIS_CLOSED));
  const base = win.expected || override || shipIso || etDayString(new Date());
  const dates = win.dates.length ? win.dates : deliveryWindow(base, spanDays);

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
  // The day we are ASKING on. A required delivery day later than this has not come round yet,
  // so its board is still being built and cannot disprove an order — see boardCoverage.
  const askedOn = opts.asOf || etDayString(new Date());
  const coverage = boardCoverage(boardDays, win.required, askedOn);
  const grade = gradeSuspects(board.offBoard, coverage);
  return {
    ok: true,
    mode: 'board-diff', nuvizzCalls: 0,
    base, dates,
    // Both dates, named, so the screen can say "shipped Friday, expected Monday" instead of
    // leaving a dispatcher to work out why it looked at the days it looked at.
    shipDate: shipIso || null,
    expectedDelivery: win.expected || null,
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
