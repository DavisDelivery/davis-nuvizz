// nuvizz-undelivered-report.mts — Phase 5 read-only report endpoint.
//
// Builds the undelivered / delivered-late / aged-out report + 91(manual)-vs-90(system)
// completion breakdown from the history warehouse over the last N days. ZERO NuVizz
// calls — pure derivation over already-captured snapshots (see straggler-report.mts).
//
// Query: ?days=N (default 7, max 31)

import { isFirestoreEnabled } from './lib/firestore.mts';
import { listStops } from './lib/history-store.mts';
import { todayUTC } from './lib/nuvizz-scan.mts';
import { buildUndeliveredReport } from './lib/straggler-report.mts';

const TENANT = 'davis';

function addDaysUTC(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  try {
    if (!isFirestoreEnabled()) {
      return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), { status: 200, headers: cors });
    }
    const url = new URL(req.url);
    const windowDays = Math.max(1, Math.min(31, parseInt(url.searchParams.get('days') || '7', 10) || 7));
    const today = todayUTC();
    // Read the window of warehoused days (newest..oldest), best-effort per day.
    const dates = Array.from({ length: windowDays + 1 }, (_, i) => addDaysUTC(today, -i));
    const daysByDate: Record<string, any[]> = {};
    await Promise.all(dates.map(async (d) => {
      try { daysByDate[d] = await listStops(TENANT, d); } catch { daysByDate[d] = []; }
    }));
    const report = buildUndeliveredReport(daysByDate, { windowDays, today });
    // Window caveat (audit): classification is bounded to the read window, so a PRO whose
    // true origin/delivery falls outside [today-windowDays, today] can have approximate
    // dates (e.g. a rolled stop older than the window shows a clamped scheduledDate).
    const note = `Derived from the ${windowDays + 1}-day history warehouse (zero NuVizz calls). Rows whose activity predates the window may have approximate scheduled/late dates.`;
    return new Response(JSON.stringify({ ok: true, tenant: TENANT, generated: new Date().toISOString(), note, ...report }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || 'report failed' }), { status: 500, headers: cors });
  }
};
