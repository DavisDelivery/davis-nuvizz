// nuvizz-att-fill-background.mts — the nightly safety net for attempts still without a driver (v1.104.0).
//
// Scheduled only. It takes no parameters and a cron'd function is not reachable over plain HTTP in this
// app, so the only way it runs is the schedule below, and it only ever acts on ET-yesterday. At most 10
// NuVizz requests per run and one run per date — the full account is in lib/att-fill.mts.
//
// ── Schedule: 04:30 AND 05:30 UTC ────────────────────────────────────────────
// 00:30 ET under EDT is 04:30 UTC; under EST it is 05:30 UTC. Both fire; fillDecision lets only a fire
// between midnight and 2 AM ET act, and the date claim stops the second one from spending anything.
// The attempts scans run 8–11 PM ET (nuvizz-att-scan-background), so the day is finished by then.
//
// NUVIZZ_ATT_TIMELINE_FILL=off turns it off.
import { runAttFill } from './lib/att-fill-run.mts';

export default async (): Promise<Response> => {
  try {
    const result = await runAttFill(new Date());
    console.log(`[att-fill] ${JSON.stringify(result)}`);
    return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error(`[att-fill] ERROR: ${e?.message}`);
    return new Response(JSON.stringify({ ok: false, error: e?.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = {
  schedule: '30 4,5 * * *',
};
