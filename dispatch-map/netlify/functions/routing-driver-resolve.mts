// routing-driver-resolve.mts
//
// WHO DRIVES EACH LOAD ON THE DAY'S ROSTER, AND WHAT TRUCK — for the Routing screen's
// "Plan onto → My loads" list, so an empty shell named VICTOR defaults to the 53ft trailer
// Victor actually drives instead of to a 26ft box guessed from its name, and so the build
// can hand the engine Victor's own learned envelope rather than fleet averages.
//
//   POST { date: 'YYYY-MM-DD', names: ['VICTOR', 'BEN 2', 'SUW 2', …] }
//     → 200 { ok, date, calls: 0, employees, driver_days, resolved: { 'victor': {…} },
//             reasons: { 'suw 2': 'no match', 'ben 2': 'ambiguous' }, at }
//     → 400 bad date / names
//     → 200 { ok: false, error } when Firestore is not configured (the client falls back
//            to its name rule, exactly as it did before this endpoint existed)
//
// ZERO NuVizz calls, ever. Two Firestore reads: the MarginIQ employees roster and the
// engine's driver-day warehouse before the date — the same two inputs the Draft box
// resolves a typed name against (routing-draft-core.mts resolveDraftDriver), so the list
// and the Draft box cannot disagree about who VICTOR is. The rules are in
// lib/routing-driver-resolve-core.mts, which is pure and tested.

import { isFirestoreEnabled, listDocs, runQuery } from './lib/firestore.mts';
import { requireUser } from './lib/require-user.mts';
import { DRIVER_DAYS_COLLECTION } from './lib/routing-driver-days.mts';
import {
  resolveLoadNames, RESOLVE_MAX_NAMES, RESOLVE_MAX_NAME_LEN,
} from './lib/routing-driver-resolve-core.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMPLOYEES_COLLECTION = process.env.MARGINIQ_EMPLOYEES_COLLECTION || 'employees';

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  const J = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' });
  if (req.method !== 'POST') return J({ ok: false, error: 'POST { date, names: [load names] }' }, 405);
  // A read of our own roster, so the viewer gate — the same level as routing-engine-data.
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;
  let body: any = null;
  try { body = await req.json(); } catch { /* handled below */ }
  const date = String(body?.date || '');
  if (!DATE_RE.test(date)) return J({ ok: false, error: 'bad or missing date (YYYY-MM-DD)' }, 400);
  if (!Array.isArray(body?.names)) return J({ ok: false, error: 'names: the load names to resolve' }, 400);
  // Bounded like every other input: a day's roster is ~100 names.
  const names = body.names.slice(0, RESOLVE_MAX_NAMES).map((n: any) => String(n ?? '').slice(0, RESOLVE_MAX_NAME_LEN));

  try {
    const [employees, ddRows] = await Promise.all([
      listDocs(EMPLOYEES_COLLECTION).catch(() => [] as any[]),   // roster absent → history + fallbacks only
      runQuery({
        from: [{ collectionId: DRIVER_DAYS_COLLECTION }],
        where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN', value: { stringValue: date } } },
      }),
    ]);
    const driverDaysBefore = (ddRows as any[]).filter((r) => r?.tenant === TENANT);
    const { resolved, reasons } = resolveLoadNames(names, employees, driverDaysBefore, date);
    return J({
      ok: true, date, calls: 0,
      employees: employees.length, driver_days: driverDaysBefore.length,
      resolved, reasons, at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('[routing-driver-resolve] failed:', e?.message || e);
    return J({ ok: false, error: e?.message || 'resolve failed' }, 500);
  }
};
