// nuvizz-load-columns.mts — ONE deliberate look at the raw load list.
//
// Chad, 2026-09-02, asked whether the NuVizz API exposes the per-load vehicle type, and then:
// "spend one call to check and see." This is that call, and nothing else: one POST to the
// same /entity/filterdata/PkgRoute the hourly roster already makes, the RAW response
// summarised (columns, first rows, whether any column is a vehicle type, and what
// normalizeLoads makes of it), written to nuvizz_ops/load_columns__<date> so it can be read
// back forever without a second call.
//
// GATES, because this is a metered vendor call on an open GET:
//   • ?confirm=1 is required — a bookmark or a prefetch must not spend it;
//   • requireUser at dispatcher (inert until AUTH_REQUIRED=true, same as every other door);
//   • NUVIZZ_SCANS_ENABLED=false refuses it, same as the roster refresh;
//   • no cron, ever. A scheduled function is not HTTP-reachable and this is the opposite.
//
//   GET ?date=YYYY-MM-DD&confirm=1   → { ok, date, httpStatus, summary, storedAt }
//   GET ?date=YYYY-MM-DD             → the stored summary if one exists, else 428 (nothing spent)
import { getNuvizzRequester, setCallTrigger } from './lib/nuvizz-request.mts';
import { getCreds, basicAuthHeader, scansEnabled } from './lib/nuvizz-scan.mts';
import { OPENAPI_BASE, periodForDate } from './lib/nuvizz-list.mts';
import { buildLoadBody, LOAD_ENTITY } from './lib/nuvizz-loads.mts';
import { summarizeLoadColumns } from './lib/load-columns.mts';
import { isFirestoreEnabled, getDoc, setDoc, etDayString } from './lib/firestore.mts';
import { requireUser } from './lib/require-user.mts';

const opsPath = (date: string) => `nuvizz_ops/load_columns__${date}`;

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const date = url.searchParams.get('date') || etDayString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return J({ ok: false, error: 'bad ?date (YYYY-MM-DD)' }, 400);
  const confirm = url.searchParams.get('confirm') === '1';

  // The stored answer first — reading it costs nothing and is the everyday path.
  if (!confirm) {
    const prev = isFirestoreEnabled() ? await getDoc(opsPath(date)).catch(() => null) : null;
    if (prev) return J({ ok: true, date, source: 'stored', ...prev });
    return J({ ok: false, date, error: 'no stored summary for this date — add &confirm=1 to spend ONE NuVizz call' }, 428);
  }
  if (!scansEnabled()) return J({ ok: false, error: 'NUVIZZ_SCANS_ENABLED=false — refusing the call' }, 503);

  try {
    setCallTrigger('manual');
    const { companyCode } = getCreds();
    const hdr = { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json' };
    const target = `${OPENAPI_BASE}/entity/filterdata/${LOAD_ENTITY}/${companyCode}`;
    const period = periodForDate(date);
    const body = JSON.stringify(buildLoadBody(period));
    const resp = await getNuvizzRequester().request(target, { method: 'POST', headers: hdr, body }, { route: '/entity/filterdata(columns)', tenant: companyCode, source: 'load-columns', trigger: 'manual' });
    const text = await resp.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* summarised as non-JSON below */ }
    const summary = json ? summarizeLoadColumns(json) : null;
    const record = {
      date, period, entity: LOAD_ENTITY, httpStatus: resp.status, ok: resp.ok,
      storedAt: new Date().toISOString(),
      summary,
      // A non-JSON or error body is kept (bounded) — it IS the answer in that case.
      rawHead: json ? undefined : text.slice(0, 1500),
    };
    if (isFirestoreEnabled()) { try { await setDoc(opsPath(date), record); } catch { /* the response still carries it */ } }
    return J({ ok: true, source: 'live', calls: 1, ...record });
  } catch (e: any) {
    return J({ ok: false, date, error: String(e?.message || e) }, 502);
  }
};
