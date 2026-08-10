// manifest-check.mts
//
// ── DOES EVERY ORDER ON THE NIGHTLY ULINE MANIFEST EXIST? ────────────────────
//
//   POST /.netlify/functions/manifest-check            { pdfBase64 }        → FREE board diff
//   POST /.netlify/functions/manifest-check?probe=1    { pdfBase64 }        → + ask NuVizz about the suspects
//     &date=YYYY-MM-DD   board day to diff against (default: the manifest's own ship date)
//     &days=N            also accept the next N days' boards (default 2 — Uline ships
//                        tonight for tomorrow, and a deferred order lands the day after)
//     &max=N             hard cap on NuVizz probes (default 25, ceiling 100)
//
// WHY THIS EXISTS. Every other integrity check in this app starts FROM NuVizz —
// so an order Uline handed us that NuVizz never received is invisible to all of
// them: there is no record to notice the absence of. The shipper's own nightly
// manifest is the only independent statement of what we were actually given.
//
// COST, deliberately in two steps:
//   Step 1 (default) — ZERO NuVizz calls. Parse the PDF (a text-layer document, so
//     no AI call either) and diff its PROs against the Firestore stop index.
//     Produces SUSPECTS: on the manifest, not on our board.
//   Step 2 (?probe=1) — ONE NuVizz call per suspect, capped. Only this step can
//     turn a suspect into "not in NuVizz", and only on an explicit not_found/404.
//     Any other failure (scans disabled, auth, throttle, breaker) is UNKNOWN —
//     never absence — because those fail for every PRO at once and a two-state
//     model would report the whole manifest as missing on a bad night.
//
// Never scheduled. It runs only when someone asks, and the free step is the default.

import { isFirestoreEnabled, listDocs, etDayString } from './lib/firestore.mts';
import { readUlineManifest } from './lib/uline-manifest.mts';
import { reconcileAgainstBoard, classifyProbes, summarize } from './lib/manifest-reconcile.mts';
import { lookupStopByPro, getCreds } from './lib/nuvizz-scan.mts';

const MAX_PROBE_CEILING = 100;
const DEFAULT_PROBE_CAP = 25;

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

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (o: any, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: cors });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'POST') return J({ ok: false, error: 'POST { pdfBase64 }' }, 405);
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore off — no board to check against' });

  const url = new URL(req.url);
  const probe = url.searchParams.get('probe') === '1';
  const cap = Math.min(MAX_PROBE_CEILING, Math.max(1, Number(url.searchParams.get('max')) || DEFAULT_PROBE_CAP));
  const spanDays = Math.min(7, Math.max(0, Number(url.searchParams.get('days')) ?? 2));

  let body: any = null;
  try { body = await req.json(); } catch { return J({ ok: false, error: 'body must be JSON' }, 400); }
  const b64 = String(body?.pdfBase64 || '');
  if (!b64) return J({ ok: false, error: 'pdfBase64 required' }, 400);

  let buf: Buffer;
  try { buf = Buffer.from(b64, 'base64'); } catch { return J({ ok: false, error: 'pdfBase64 is not base64' }, 400); }
  if (buf.subarray(0, 4).toString('latin1') !== '%PDF') return J({ ok: false, error: 'not a PDF' }, 400);

  const manifest = readUlineManifest(buf);
  if (!manifest.rows.length) {
    return J({ ok: false, error: 'no orders found — is this the Uline freight report?', warnings: manifest.warnings });
  }

  // The board days to accept a PRO on. Uline ships tonight for tomorrow, and an
  // order deferred a day would otherwise read as missing, so a small forward
  // window is checked rather than a single date. Firestore only.
  const base = String(url.searchParams.get('date') || '')
    || manifestDateToIso(manifest.rows[0]?.shipDate) || etDayString(new Date());
  const dates = Array.from({ length: spanDays + 1 }, (_, i) => addDays(base, i));

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
    return J({
      ok: false, base, dates, boardDays,
      error: 'no board rows cached for those dates — a scan must run first, or pass ?date=',
    });
  }

  const board = reconcileAgainstBoard(manifest.rows, boardPros);

  const common = {
    ok: true,
    manifest: {
      orders: manifest.rows.length, totals: manifest.totals,
      verified: manifest.verified, warnings: manifest.warnings,
    },
    checkedAgainst: boardDays,
    onBoard: board.onBoardCount,
    boardOnly: board.boardOnlyCount,
    duplicatePros: board.duplicatePros,
  };

  if (!probe) {
    return J({
      ...common, mode: 'board-diff', nuvizzCalls: 0,
      suspects: board.offBoard,
      summary: summarize(board, null),
      note: board.offBoard.length
        ? `${board.offBoard.length} order(s) on the manifest are not on the board. That is NOT yet "missing from NuVizz" — add &probe=1 to ask NuVizz about each one (1 call per suspect, capped at ${cap}).`
        : 'Every order on the manifest is on the board. Zero NuVizz calls were made.',
    });
  }

  // ── step 2, explicit: one call per suspect, hard-capped ────────────────────
  const toProbe = board.offBoard.slice(0, cap);
  const skipped = board.offBoard.length - toProbe.length;
  const outcomes: Array<{ pro: string; ok?: boolean; reason?: string }> = [];
  for (const s of toProbe) {
    const r = await lookupStopByPro(s.pro).catch((e: any) => ({ ok: false, reason: e?.message || 'error' }));
    outcomes.push({ pro: s.pro, ok: !!(r as any)?.ok, reason: (r as any)?.reason });
  }
  const verdict = classifyProbes(board.offBoard, outcomes);

  return J({
    ...common,
    mode: 'probed', nuvizzCalls: outcomes.length, cap, skippedOverCap: skipped,
    missingFromNuvizz: verdict.missing,
    inNuvizzOffBoard: verdict.inNuvizzOffBoard,
    unverified: verdict.unknown,
    conclusive: verdict.conclusive && skipped === 0,
    summary: summarize(board, verdict),
    note: verdict.missing.length
      ? `${verdict.missing.length} order(s) are on Uline's manifest and DO NOT EXIST in NuVizz — these never made it in and nothing else would have caught them.`
      : verdict.unknown.length
        ? 'No confirmed missing orders, but some suspects could not be verified — see unverified. Nothing here is a claim of absence.'
        : 'Every suspect exists in NuVizz; they are simply not on the board day(s) checked.',
  });
};
