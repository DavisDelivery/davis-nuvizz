// nuvizz-att-scan-background.mts  (Attempts — evening attempt scan + join)
//
// Scheduled BACKGROUND writer. Each evening run finds the day's delivery ATTEMPTS
// (stops whose SHIPMENT number now carries the "ATT" marker customer service adds to
// a failed delivery) by re-probing this morning's snapshot stops LIVE, then JOINS
// each back to the driver who had it this morning (by stopNbr) and writes the per-day
// attempts list attempts/{tenant}__{date}. Shared logic in lib/attempts-core.mts.
//
// Manual trigger (any time; cron only fires on PUBLISHED deploys):
//   POST /.netlify/functions/nuvizz-att-scan-background?date=YYYY-MM-DD
//   No query string → today (ET), gated to the 20:00–23:59 ET window, once/day.
//   NOTE: needs the SAME day's morning snapshot to attribute drivers, so run the
//   plan-snapshot job for a date before back-running this one.
//
// ── Schedule: 00:00 AND 01:00 UTC ────────────────────────────────────────────
//   0 0,1 * * *
// 8:00pm ET is 00:00 UTC under EDT (UTC-4) and 01:00 UTC under EST (UTC-5) — both the
// NEXT UTC date but the SAME ET day (so attempts-core targets etDayString(), not
// todayUTC()). Firing at both + gating on the ET hour (window [20,24), once/day)
// lands exactly one action in the 8pm ET hour year-round with no DST code.

import { runAttemptsScan } from './lib/attempts-core.mts';

export default runAttemptsScan;

export const config = {
  schedule: '0 0,1 * * *',
};
