// uat-mirror-refresh.mts — READ what the mirror refresh has done or would do. Sync, no writes.
//
//   GET ?status=1                       → the progress document (uat_mirror_refresh/{tenant})
//   GET ?explain=1[&from=&to=&days=&horizon=&board=&history=&static=]
//                                       → per date, production's counts beside the mirror's;
//                                         reads both databases, writes NOTHING, spends nothing.
//
// The *-background function that does the copying answers 202 and discards its result, so
// this is the only way to see it. Mirror only, like everything that reads production from
// this side; ?explain is bounded to 14 history days per call because it lists every day on
// both sides and the sync budget is 26 s.
import { isMirrorDeploy, firestoreDatabaseName } from './lib/mirror-guard.mts';
import { isFirestoreEnabled, getDoc, listDocs, etDayString } from './lib/firestore.mts';
import { listProdDocs, getProdDoc, prodMirrorReadEnabled } from './lib/prod-mirror-read.mts';
import { requireUser } from './lib/require-user.mts';
import { planRefresh, explainRefresh, progressPath, onOff, type RefreshDeps } from './lib/uat-mirror-refresh.mts';

const TENANT = 'davis';
const EXPLAIN_MAX_DAYS = 14;

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  // MIRROR ONLY, first.
  if (!isMirrorDeploy()) return J({ ok: false, refused: 'not a mirror deploy', database: firestoreDatabaseName() }, 403);
  if (req.method !== 'GET') return J({ ok: false, error: 'GET only — the copy runs on the 06:45 schedule, or by hand: POST uat-mirror-resume-background' }, 405);
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 200);
  // Gate at viewer: status and counts. Inert until AUTH_REQUIRED=true (lib/require-user.mts).
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const q = (k: string) => url.searchParams.get(k);

  if (q('explain') === '1') {
    if (!prodMirrorReadEnabled()) return J({ ok: false, refused: 'UAT_PROD_MIRROR=off', database: firestoreDatabaseName() });
    const num = (k: string) => { const v = q(k); if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
    let plan;
    try {
      plan = planRefresh({
        tenant: TENANT, today: etDayString(),
        from: q('from'), to: q('to'),
        historyDays: Math.min(EXPLAIN_MAX_DAYS, num('days') ?? EXPLAIN_MAX_DAYS), horizonDays: num('horizon'),
        board: onOff(q('board')), history: onOff(q('history')), static: onOff(q('static')),
      });
    } catch (e: any) {
      return J({ ok: false, error: e?.message || 'bad parameters' }, 400);
    }
    // A wide ?from..?to is clamped to the newest EXPLAIN_MAX_DAYS so the read fits the budget.
    const span = Math.round((Date.parse(plan.historyTo + 'T12:00:00Z') - Date.parse(plan.historyFrom + 'T12:00:00Z')) / 86_400_000) + 1;
    let clamped = false;
    if (span > EXPLAIN_MAX_DAYS) {
      const d = new Date(plan.historyTo + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - (EXPLAIN_MAX_DAYS - 1));
      plan = { ...plan, historyFrom: d.toISOString().slice(0, 10) };
      clamped = true;
    }
    const deps: RefreshDeps = {
      listProd: (p, o) => listProdDocs(p, o), getProd: (p) => getProdDoc(p),
      listMirror: (p, o) => listDocs(p, o), getMirror: (p) => getDoc(p),
      setDoc: async () => { throw new Error('explain never writes'); },
    };
    try {
      const res = await explainRefresh(deps, plan);
      return J({ ok: true, database: firestoreDatabaseName(), clamped_to_days: clamped ? EXPLAIN_MAX_DAYS : null, ...res });
    } catch (e: any) {
      return J({ ok: false, error: e?.message || 'explain failed' }, 500);
    }
  }

  // default: status
  const progress = await getDoc(progressPath(TENANT)).catch((e: any) => ({ _read_error: e?.message || String(e) }));
  return J({ ok: true, database: firestoreDatabaseName(), progress: progress || null, nuvizz_calls: 0 });
};
