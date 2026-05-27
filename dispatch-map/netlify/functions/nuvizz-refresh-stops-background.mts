// nuvizz-refresh-stops-background.mts  (M5.2)
//
// Scheduled BACKGROUND writer (DAYTIME window) for the Firestore stop index.
// The inline scan can't run on the request path — load+unplanned scan is >22s
// and 502s past the 26s request cap — so the scan lives here instead, and the
// map reads the index in <2s (see nuvizz-pull-today-stops.mts). The shared scan
// + write logic is in lib/refresh-stops-core.mts; the evening/Sunday-night
// window is in nuvizz-refresh-stops-evening-background.mts.
//
// Why two files: Netlify scheduled functions accept exactly ONE cron expression
// (config.schedule is a single string, no arrays) and crons run in UTC. The
// "-background" suffix is what gives the 15-min budget the multi-day scan needs;
// a plain scheduled function caps at 30s.
//
// Manual trigger (any time): POST /.netlify/functions/nuvizz-refresh-stops-background
//   optional ?date=YYYY-MM-DD (single date) or ?days=N (today+N-1).
//   Background fns return 202 and run async — poll the read endpoint's
//   lastScannedAt to confirm (see acceptance test in RESEARCH-m5.md).
//   NOTE: scheduled (cron) triggers only fire on PUBLISHED deploys, never on
//   deploy previews/branch deploys — use the manual POST to test a preview.
//
// ── Schedule (target: 10:00am–11:59pm ET, plus Sun 10pm–11:59pm ET) ──────────
// This file: DAYTIME. Evening + Sunday-night are in the -evening- file.
//   DAYTIME  cron (here): */5 14-23 * * 1-5   → Mon–Fri 14:00–23:59 UTC = Mon–Fri 10:00am–7:59pm ET
//   EVENING  cron (other): */5 0-3  * * 1-6   → Mon–Sat 00:00–03:59 UTC = Sun & Mon–Fri 8:00pm–11:59pm ET
// (UTC weekday numbering, not ET: Sun-10pm-ET → Mon-02:00-UTC, Fri-evening-ET → Sat-00:00-UTC.)
//
// ── DST: these expressions are tuned for EDT (UTC−4) ─────────────────────────
// On 2026-11-01 ET switches to EST (UTC−5); every UTC hour above shifts +1h.
// Update BOTH files on that date to keep scans at the same ET local times:
//   DAYTIME  → */5 15-23 * * 1-5     (10:00am–6:59pm ET)
//   EVENING  → */5 0-4  * * 1-6      (7:00pm–11:59pm ET, incl. Sun-night Mon 03:00–04:59 UTC)
// Reverts on 2027-03-08 (EST→EDT) — restore the EDT expressions above.
// (No auto-DST: Netlify cron is fixed UTC. Revisit each flip; ~2 lines each.)

import { runRefreshStops } from './lib/refresh-stops-core.mts';

export default runRefreshStops;

export const config = {
  schedule: '*/5 14-23 * * 1-5',
};
