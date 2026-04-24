// netlify/functions/fleet-refresh-background.mjs
//
// Scheduled function that pre-warms the fleet Blob cache every 2 minutes during business
// hours. When users open the app, __fleet / __fleetstops serve the pre-computed data
// instantly instead of waiting 10-15 seconds for a fresh NuVizz scan.
//
// Strategy: call the existing /nuvizz?path=__fleet and __fleetstops endpoints with
// nocache=1 so they bypass the in-memory cache, run a fresh scan, and write to Blob
// as a side effect. This reuses all the scan/calibrate logic from nuvizz.cjs.
//
// Runs for both DAVIS and ULINE tenants, only for today's date (historical dates are
// unchanged so no need to refresh them).

export default async () => {
  const url = process.env.URL || process.env.DEPLOY_URL; // Netlify auto-provides these
  if (!url) {
    console.error('fleet-refresh: no site URL available, skipping');
    return new Response('no site url', { status: 200 });
  }

  // Today in UTC (matches what the app uses)
  const today = new Date().toISOString().slice(0, 10);
  const dayOfWeek = new Date().getUTCDay(); // 0=Sun, 6=Sat
  // Skip weekends — Davis doesn't dispatch Sat/Sun, nothing to pre-warm
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log(`fleet-refresh: skipping weekend (${today})`);
    return new Response('weekend skip', { status: 200 });
  }

  const tenants = ['davis', 'uline'];
  const results = [];

  for (const tenant of tenants) {
    // Warm both __fleet and __fleetstops. They share the scan internally via range cache,
    // but need separate blob entries (different data shapes).
    for (const kind of ['__fleet', '__fleetstops']) {
      const startTime = Date.now();
      try {
        const endpoint = `${url}/.netlify/functions/nuvizz?tenant=${tenant}&path=${kind}&nocache=1&date=${today}`;
        const resp = await fetch(endpoint, { method: 'GET' });
        const ms = Date.now() - startTime;
        if (!resp.ok) {
          results.push({ tenant, kind, ok: false, status: resp.status, ms });
          continue;
        }
        const data = await resp.json();
        const summary = data.summary || {};
        results.push({
          tenant, kind, ok: true, ms,
          totalLoads: summary.totalLoads,
          totalStops: summary.totalStops,
          totalDelivered: summary.totalDelivered ?? summary.delivered,
          totalExceptions: summary.totalExceptions ?? summary.exceptions,
        });
      } catch (e) {
        results.push({ tenant, kind, ok: false, error: e.message, ms: Date.now() - startTime });
      }
    }
  }

  console.log('fleet-refresh results:', JSON.stringify(results));
  return new Response(JSON.stringify({ date: today, results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

// Cron: every 2 minutes, every day. Weekend skip is enforced in the handler above.
export const config = {
  schedule: '*/2 * * * *',
};
