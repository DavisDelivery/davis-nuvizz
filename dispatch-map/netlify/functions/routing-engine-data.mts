// routing-engine-data.mts
//
// READ endpoint for the Engine tab. Serves route_proposals +
// route_proposals_daily ONLY — on-demand, no polling, zero NuVizz calls,
// nothing here can touch live plan data.
//
//   GET ?view=daily            → every daily rollup (the trend series) + config echo
//   GET ?view=day&date=YYYY-MM-DD → that date's rollup + full proposal docs
import { isFirestoreEnabled, getDoc, listDocs, runQuery } from './lib/firestore.mts';
import { ENGINE_VERSION, loadEngineConfig } from './lib/routing-engine-config.mts';
import { PROPOSALS_COLLECTION, PROPOSALS_DAILY_COLLECTION, dailyRollupPath } from './lib/routing-engine-core.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
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

  return new Response(JSON.stringify({ ok: false, error: `unknown view '${view}'` }), { status: 400, headers });
};
