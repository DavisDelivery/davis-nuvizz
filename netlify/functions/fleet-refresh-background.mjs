// netlify/functions/fleet-refresh-background.mjs
//
// Scheduled function that pre-warms the Firestore fleet cache every 5 minutes during
// business hours. When users open the app, __fleet / __fleetstops / __driver all read
// from Firestore in <1 second instead of waiting 10-15 seconds for a fresh NuVizz scan.
//
// Strategy: hit the existing __refreshFleet endpoint, which does:
//   1. Full NuVizz scan (with stops)
//   2. Persists every load + summary + driver index to Firestore
//   3. Returns summary stats
// We just log results so the deploy log shows freshness.
//
// Runs Mon-Fri only (Davis doesn't dispatch weekends).

export default async () => {
  // P0 kill switch — set Netlify env NUVIZZ_SCANS_ENABLED=false to disable the
  // scheduled fleet refresh without a code deploy. The __refreshFleet endpoint it
  // calls also honors the switch (scanFleet returns []), so this is belt-and-braces.
  if (String(process.env.NUVIZZ_SCANS_ENABLED || '').trim().toLowerCase() === 'false') {
    console.log('fleet-refresh: NUVIZZ_SCANS_ENABLED=false — skipping (kill switch active)');
    return new Response('scans disabled', { status: 200 });
  }

  const url = process.env.URL || process.env.DEPLOY_URL;
  if (!url) {
    console.error('fleet-refresh: no site URL available, skipping');
    return new Response('no site url', { status: 200 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const dayOfWeek = new Date().getUTCDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log(`fleet-refresh: skipping weekend (${today})`);
    return new Response('weekend skip', { status: 200 });
  }

  // Only davis: the uline tenant is a branded view of the same DAVIS fleet data, so the
  // nuvizz function maps it to davis internally — refreshing it here would double-scan.
  const tenants = ['davis'];
  const results = [];

  for (const tenant of tenants) {
    const startTime = Date.now();
    try {
      const endpoint = `${url}/.netlify/functions/nuvizz?tenant=${tenant}&path=__refreshFleet&date=${today}`;
      const resp = await fetch(endpoint, { method: 'GET' });
      const ms = Date.now() - startTime;
      if (!resp.ok) {
        results.push({ tenant, ok: false, status: resp.status, ms });
        continue;
      }
      const data = await resp.json();
      const s = data.summary || {};
      results.push({
        tenant, ok: true, ms,
        loads: s.totalLoads,
        stops: s.totalStops,
        delivered: s.totalDelivered,
        exceptions: s.totalExceptions,
        drivers: s.uniqueDrivers,
      });
    } catch (e) {
      results.push({ tenant, ok: false, error: e.message, ms: Date.now() - startTime });
    }
  }

  console.log('fleet-refresh results:', JSON.stringify(results));
  return new Response(JSON.stringify({ date: today, results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

// Cron: every 15 minutes. Weekend skip is enforced in the handler above.
// P0 (Jun 2026, runaway-volume incident): eased from */5 (288 runs/day) to */15
// (96 runs/day). Each run still scans the davis load-number range via __refreshFleet;
// see the runaway-calls incident report. NOTE: this refresher scans BOTH the davis
// and uline tenants today — the open PR #61 drops the redundant uline scan (all
// load data lives under DAVIS), which roughly halves this function's volume again.
export const config = {
  schedule: '*/15 * * * *',
};
