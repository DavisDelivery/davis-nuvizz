// nuvizz-loads-roster.mts
//
// On-demand load roster for a given board date — the FULL list of that day's loads
// (route name, status, trip/stop count), INCLUDING empty loads created but not yet filled
// with orders. The stop-grouped Loads view can't show an empty load (it has no stops to
// group), so the dispatcher couldn't see e.g. Monday's empty loads waiting for orders.
// This surfaces them. One deliberate NuVizz call per request (the portal's PkgRoute
// filterdata, customListDefId 35833); creds stay server-side. Best-effort: an error
// returns ok:false and the UI just shows the stop-grouped loads it already has.
//
//   GET ?date=YYYY-MM-DD   → { ok, date, loads: [{ loadId, name, status, trips }] }
import { loadRosterForDate } from './lib/nuvizz-loads.mts';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  const date = new URL(req.url).searchParams.get('date') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response(JSON.stringify({ ok: false, reason: 'missing or bad date (YYYY-MM-DD)' }), { status: 400, headers: cors });
  }
  try {
    const loads = await loadRosterForDate(date);
    return new Response(JSON.stringify({ ok: true, date, count: loads.length, loads }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, reason: e?.message || 'roster failed' }), { status: 502, headers: cors });
  }
};
