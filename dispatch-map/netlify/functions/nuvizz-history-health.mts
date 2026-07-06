// nuvizz-history-health.mts
//
// Zero-NuVizz health readout for the per-customer history rollup guard
// (lib/history-rollup-guard). Reads only our own Firestore state doc — it NEVER
// calls NuVizz — so it's safe to poll from an uptime monitor.
//
// The rollup is a derived cache the mobile "Search past PROs" reads; the warehouse
// (history_days) is the source of truth. If the nightly rollup refresh ever falls
// behind, the backlog + alert surface here instead of hiding in a log line (the
// 2026-07-06 silent-drift incident). Returns HTTP 503 while an alert is active so a
// plain uptime check trips; 200 when healthy.
//
//   GET /.netlify/functions/nuvizz-history-health
//     → { ok, alert, pending_days, pending_count, oldest_pending_business_days,
//         consecutive_sweep_failures, last_run_at, last_ok_at, last_error }

import { isFirestoreEnabled, etDayString } from './lib/firestore.mts';
import { readRollupHealth } from './lib/history-rollup-guard.mts';

const TENANT = 'davis';

export default async (req: Request): Promise<Response> => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers });
  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, reason: 'history_unavailable' }), { status: 200, headers });
  }
  try {
    const health = await readRollupHealth(TENANT, etDayString());
    // 503 when drift is alerting → a generic uptime monitor catches it with no extra wiring.
    return new Response(JSON.stringify({ ok: true, ...health }), { status: health.alert ? 503 : 200, headers });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, reason: e?.message || 'health read failed' }), { status: 500, headers });
  }
};
