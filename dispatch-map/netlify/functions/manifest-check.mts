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
//     Produces SUSPECTS: on the manifest, not on our board. This step lives in
//     lib/manifest-run.mts and is SHARED with the scheduled email ingest — the
//     nightly report arriving by email runs the same free diff automatically.
//   Step 2 (?probe=1) — ONE NuVizz call per suspect, capped. Only this step can
//     turn a suspect into "not in NuVizz", and only on an explicit not_found/404.
//     Any other failure (scans disabled, auth, throttle, breaker) is UNKNOWN —
//     never absence — because those fail for every PRO at once and a two-state
//     model would report the whole manifest as missing on a bad night.
//     The probe step is HTTP-only, behind a human click: no scheduled path can
//     reach it, so automation can never spend NuVizz calls.
//
// Never scheduled. It runs only when someone asks, and the free step is the default.

import { isFirestoreEnabled } from './lib/firestore.mts';
import { runManifestBoardDiff, manifestDateToIso, addDays } from './lib/manifest-run.mts';
import { classifyProbes, summarize } from './lib/manifest-reconcile.mts';
import { lookupStopByPro } from './lib/nuvizz-scan.mts';

// Re-exported for the tests (and any caller) that imported these from here.
export { manifestDateToIso, addDays };

const MAX_PROBE_CEILING = 100;
const DEFAULT_PROBE_CAP = 25;

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

  const diff = await runManifestBoardDiff(buf, { dateOverride: url.searchParams.get('date'), spanDays });
  if (!diff.ok) return J(diff, diff.error === 'not a PDF' || diff.notManifest ? 400 : 200);
  const { _board: board, ...common } = diff;

  if (!probe) return J(common);

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
