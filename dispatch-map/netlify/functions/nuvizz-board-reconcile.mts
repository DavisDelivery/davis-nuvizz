// nuvizz-board-reconcile.mts
//
// ── ONE-SHOT board ↔ NuVizz reconcile (runs ONLY on an explicit trigger) ─────
//
//   GET  /.netlify/functions/nuvizz-board-reconcile?date=YYYY-MM-DD          → PREVIEW (ZERO NuVizz calls)
//   POST /.netlify/functions/nuvizz-board-reconcile?date=YYYY-MM-DD&run=1    → RECONCILE
//
// The run is POST-only. It spends up to 40 NuVizz calls and rewrites the day's board cache,
// and a GET that does that is a link: a browser prefetch, a re-opened tab, a URL pasted into
// chat and previewed by the chat client all fire it without anyone deciding to. The preview
// stays a plain GET (it reads Firestore and writes nothing). To run: curl -X POST '<url>&run=1'.
//
// Purpose: heal a board whose rows were reverted by the pre-v0.46.5 drop bug (scans
// un-planning confirmed saves while NuVizz's list feed lagged). For every non-empty load
// on the day's CACHED roster, ONE /load/info read pulls the load's actual stops in running
// order, and patchBoardPlan writes that truth through to the board cache — the exact same
// write a green Save performs (carry-over rescue included, so old-dated orders heal too).
// Nothing is EVER written to NuVizz here; the only NuVizz cost is the per-load read.
//
// COST: ~1 NuVizz call per roster load (a typical day ≈ 10–20 calls). The preview mode
// (?run absent) reads only Firestore and reports exactly which loads a run would touch.
// This endpoint is never scheduled — it fires only when the dispatcher explicitly opens
// the run URL (per-request permission by construction).

import { patchBoardPlan, readLoadRoster, isFirestoreEnabled, etDayString } from './lib/firestore.mts';
import { getCreds, lookupLoadPlan } from './lib/nuvizz-scan.mts';
import { requireUser } from './lib/require-user.mts';

const MAX_LOADS = 40;

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (obj: any, status = 200) => new Response(JSON.stringify(obj, null, 1), { status, headers: cors });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore off — no board cache to reconcile' });

  const url = new URL(req.url);
  const date = String(url.searchParams.get('date') || etDayString(new Date()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return J({ ok: false, error: 'date must be YYYY-MM-DD' }, 400);
  const run = url.searchParams.get('run') === '1';
  if (run && req.method !== 'POST') {
    return J({
      ok: false, date, error: 'run=1 requires POST',
      note: 'The reconcile spends NuVizz calls and rewrites the board cache, so it does not fire from a GET link. Preview with GET (no run=1); run with: curl -X POST "<this url>&run=1".',
    }, 405);
  }

  // Gate the RUN at dispatcher, before the roster read. run=1 spends one NuVizz /load/info per
  // roster load (~60 on a real morning) and REWRITES the board cache every dispatcher is
  // looking at; the GET preview spends nothing and only names what it would do, so it stays
  // open — a dry run somebody cannot reach is a dry run that does not exist. Inert until
  // AUTH_REQUIRED=true (lib/require-user.mts).
  if (run) {
    const gate = await requireUser(req, { role: 'dispatcher' });
    if (!gate.ok) return gate.response;
  }

  let tenant = 'DAVIS';
  try { tenant = getCreds().companyCode; } catch { /* default tenant */ }

  const roster = await readLoadRoster(tenant, date).catch(() => null);
  const candidates = (roster?.loads || [])
    .map((l: any) => ({ name: String(l?.name ?? l?.routeName ?? '').trim(), loadNbr: String(l?.loadNbr ?? '').trim() }))
    .filter((l: any) => l.loadNbr)
    .slice(0, MAX_LOADS);
  if (!candidates.length) return J({ ok: false, date, error: `no cached roster for ${date} — a load scan must run first` });

  if (!run) {
    return J({
      ok: true, date, mode: 'preview', nuvizzCalls: 0,
      wouldRead: candidates.length,
      note: `Add &run=1 to reconcile: ~${candidates.length} NuVizz /load/info calls (one per roster load), board cache rewritten to match each load's actual stops. Nothing is written to NuVizz.`,
      loads: candidates,
    });
  }

  const at = new Date().toISOString();
  const results: any[] = [];
  let calls = 0;
  // Small concurrency — this is a hand-fired repair, not a scan; be gentle on the vendor.
  let i = 0;
  const worker = async () => {
    while (i < candidates.length) {
      const c = candidates[i++];
      const plan = await lookupLoadPlan(c.loadNbr);
      calls++;
      if (!plan) { results.push({ ...c, ok: false, error: 'load unreadable' }); continue; }
      if (!plan.orderedStopNbrs.length) { results.push({ ...c, ok: true, stops: 0, skipped: 'empty load' }); continue; }
      try {
        const r = await patchBoardPlan(tenant, date, {
          routeName: plan.routeName || c.name || c.loadNbr,
          orderedStopNbrs: plan.orderedStopNbrs,
          unplannedStopNbrs: [],
          driverName: plan.driverName || null,
          at,
        });
        results.push({ ...c, ok: true, stops: plan.orderedStopNbrs.length, ...r });
      } catch (e: any) {
        results.push({ ...c, ok: false, stops: plan.orderedStopNbrs.length, error: e?.message || 'patch failed' });
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));

  const patched = results.reduce((a, r) => a + (r.patched || 0) + (r.rescued || 0), 0);
  console.log(`[reconcile] ${date}: ${calls} load reads, ${patched} board rows re-stamped across ${results.length} loads`);
  return J({ ok: true, date, mode: 'run', nuvizzCalls: calls, rowsRestamped: patched, loads: results });
};
