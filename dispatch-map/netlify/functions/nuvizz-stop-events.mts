// nuvizz-stop-events.mts
//
// On-demand activity timeline for a single stop (the portal's "Activity Timeline":
// STOP PLANNED / PICKUP DEPART / DISPATCHED / UPDATED / UNPLANNED, with time + user +
// company). Called only when a dispatcher opens the timeline on an individual order — a
// deliberate, one-off NuVizz call, not background traffic. Prefers the richer
// /event/eventinfo (carries the "By:"/"From:") when the system stopId is known; otherwise
// falls back to /stop/eventinfo by stop number. Creds stay server-side.
//
//   GET ?stopNbr=…&stopId=…[&refresh=0]
//   → { ok, events, source, stop, reason?, nuvizzCalls }
//
// `refresh=0` skips the /stop/info refresh when the caller already holds the stopId and has
// no use for a refreshed record — the Stop lookup's order panel (fetchStopEvents says why).
// Only an explicit off-word (0/off/false/no) turns the refresh off; absent or anything else
// is the stop card's behaviour, unchanged.
//
// `nuvizzCalls` is COUNTED, NOT ASSUMED — the same before/after read of the shared requester
// that stop-lookup-prompted, nuvizz-write and uat-seed use: every attempt NuVizz answered,
// retries included, which is exactly what the daily ceiling was charged. A refusal before the
// wire (scans off, breaker open) is 0. The Stop lookup's header chip adds it to what the
// screen has spent, so a rep can see what pressing the timeline cost.
import { fetchStopEvents } from './lib/nuvizz-scan.mts';
import { setCallTrigger, getNuvizzRequester } from './lib/nuvizz-request.mts';
import { requireUser } from './lib/require-user.mts';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  // Gate at dispatcher BEFORE the vendor call: a metered NuVizz read per hit, returning a
  // stop's full activity timeline. Inert until AUTH_REQUIRED=true.
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;

  setCallTrigger('on-demand'); // dispatcher opened the activity timeline → on-demand
  const url = new URL(req.url);
  const stopNbr = url.searchParams.get('stopNbr') || '';
  const stopId = url.searchParams.get('stopId') || '';
  const refresh = !/^(off|0|false|no)$/i.test(String(url.searchParams.get('refresh') ?? '').trim());
  if (!stopNbr.trim() && !stopId.trim()) {
    return new Response(JSON.stringify({ ok: false, reason: 'missing stopNbr or stopId', nuvizzCalls: 0 }), { status: 400, headers: cors });
  }
  const reqr = getNuvizzRequester();
  const callsBefore = reqr.getStats().totalThisInstance;
  const spent = () => Math.max(0, reqr.getStats().totalThisInstance - callsBefore);
  try {
    const res = await fetchStopEvents(stopNbr, stopId, { refresh });
    return new Response(JSON.stringify({ ...res, nuvizzCalls: spent() }), { status: res.ok ? 200 : 404, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, reason: e?.message || 'events failed', nuvizzCalls: spent() }), { status: 500, headers: cors });
  }
};
