// routing-engine-data.mts
//
// READ endpoint for the Engine tab. Serves route_proposals +
// route_proposals_daily ONLY — on-demand, no polling, zero NuVizz calls,
// nothing here can touch live plan data.
//
//   GET ?view=daily              → every sequence daily rollup (trend) + config echo
//   GET ?view=day&date=…         → that date's sequence rollup + full route proposals
//   GET ?view=plan-daily         → every assignment daily rollup (agreement trend)
//   GET ?view=plan-day&date=…    → that date's assignment rollup + full plan proposal
//   GET ?view=version-rollups    → one aggregate per engine version (cross-version progress)
//   GET ?view=experiments        → every labeled experiment run (offline knob sweeps)
//   GET ?view=experiment&label=… → one experiment run in full (per-day rows)
import { isFirestoreEnabled, getDoc, listDocs, runQuery } from './lib/firestore.mts';
import { ENGINE_VERSION, loadEngineConfig } from './lib/routing-engine-config.mts';
import { PROPOSALS_COLLECTION, PROPOSALS_DAILY_COLLECTION, dailyRollupPath } from './lib/routing-engine-core.mts';
import { PLAN_PROPOSALS_DAILY_COLLECTION, PLAN_VERSION_ROLLUPS_COLLECTION, EXPERIMENTS_COLLECTION, planProposalPath, planDailyPath, experimentPath } from './lib/routing-plan-core.mts';
import { requireUser } from './lib/require-user.mts';

// Sort engine version strings numerically ("2.10.0" after "2.9.1", not before).
function cmpVersion(a: string, b: string): number {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  // Gate at viewer: the engine's whole learning record — every day's proposals, agreement
  // scores and experiment sweeps. Inert until AUTH_REQUIRED=true.
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;

  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), { status: 200, headers });
  }
  const url = new URL(req.url);
  const view = url.searchParams.get('view') || 'daily';

  if (view === 'daily') {
    const rows = await listDocs(PROPOSALS_DAILY_COLLECTION);
    const days = rows
      .filter((r: any) => r?.tenant === TENANT)
      .sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)));
    const cfg = await loadEngineConfig(TENANT);
    return new Response(JSON.stringify({ ok: true, engine_version: ENGINE_VERSION, days, config: cfg }), { status: 200, headers });
  }

  if (view === 'day') {
    const date = url.searchParams.get('date');
    if (!date || !DATE_RE.test(date)) {
      return new Response(JSON.stringify({ ok: false, error: 'bad or missing ?date' }), { status: 400, headers });
    }
    const [rollup, proposals] = await Promise.all([
      getDoc(dailyRollupPath(TENANT, date)),
      runQuery({
        from: [{ collectionId: PROPOSALS_COLLECTION }],
        where: {
          fieldFilter: { field: { fieldPath: 'date' }, op: 'EQUAL', value: { stringValue: date } },
        },
      }),
    ]);
    const routes = (proposals || [])
      .filter((r: any) => r?.tenant === TENANT)
      .sort((a: any, b: any) => String(a.load_key).localeCompare(String(b.load_key)));
    return new Response(JSON.stringify({ ok: true, engine_version: ENGINE_VERSION, date, rollup, routes }), { status: 200, headers });
  }

  if (view === 'plan-daily') {
    const rows = await listDocs(PLAN_PROPOSALS_DAILY_COLLECTION);
    const days = rows
      .filter((r: any) => r?.tenant === TENANT)
      .sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)));
    const cfg = await loadEngineConfig(TENANT);
    return new Response(JSON.stringify({ ok: true, engine_version: ENGINE_VERSION, days, config: cfg }), { status: 200, headers });
  }

  if (view === 'version-rollups') {
    const rows = await listDocs(PLAN_VERSION_ROLLUPS_COLLECTION);
    const versions = rows
      .filter((r: any) => r?.tenant === TENANT && r?.engine_version)
      .sort((a: any, b: any) => cmpVersion(a.engine_version, b.engine_version));
    return new Response(JSON.stringify({ ok: true, engine_version: ENGINE_VERSION, versions }), { status: 200, headers });
  }

  if (view === 'experiments') {
    // Field-masked: the per-day map can be hundreds of KB per run — the listing
    // pulls only the header fields instead of downloading it to throw it away.
    const rows = await listDocs(EXPERIMENTS_COLLECTION, {
      mask: ['tenant', 'label', 'engine_version', 'config_overlay', 'window_from', 'window_to', 'days_scored', 'skipped', 'summary', 'done', 'created_at', 'updated_at'],
    });
    const runs = rows
      .filter((r: any) => r?.tenant === TENANT)
      .sort((a: any, b: any) => String(a.label).localeCompare(String(b.label)));
    return new Response(JSON.stringify({ ok: true, engine_version: ENGINE_VERSION, runs }), { status: 200, headers });
  }

  if (view === 'experiment') {
    const label = url.searchParams.get('label') || '';
    if (!/^[a-z0-9_-]{1,40}$/.test(label)) {
      return new Response(JSON.stringify({ ok: false, error: 'bad or missing ?label' }), { status: 400, headers });
    }
    const run = await getDoc(experimentPath(TENANT, label));
    return new Response(JSON.stringify({ ok: true, engine_version: ENGINE_VERSION, run }), { status: 200, headers });
  }

  if (view === 'plan-day') {
    const date = url.searchParams.get('date');
    if (!date || !DATE_RE.test(date)) {
      return new Response(JSON.stringify({ ok: false, error: 'bad or missing ?date' }), { status: 400, headers });
    }
    const [rollup, plan] = await Promise.all([
      getDoc(planDailyPath(TENANT, date)),
      getDoc(planProposalPath(TENANT, date)),
    ]);
    return new Response(JSON.stringify({ ok: true, engine_version: ENGINE_VERSION, date, rollup, plan }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ ok: false, error: `unknown view '${view}'` }), { status: 400, headers });
};
