// nuvizz-refresh-stops-evening-background.mts  (M5.2)
//
// Scheduled BACKGROUND writer (EVENING + SUNDAY-NIGHT window) for the Firestore
// stop index. Shares the exact scan + write logic of the daytime writer via
// lib/refresh-stops-core.mts — this file exists only to attach a second cron
// expression, since Netlify allows just one per scheduled function.
//
// EVENING cron: */5 0-3 * * 1-6  → Mon–Sat 00:00–03:59 UTC, which in ET (EDT) is:
//   • Sun 10:00pm–11:59pm ET  (= Mon 02:00–03:59 UTC)  ← NEW: catches weekend Uline drops
//   • Mon–Fri 8:00pm–11:59pm ET (= Tue–Sat 00:00–03:59 UTC)
// Combined with the daytime file (*/5 14-23 * * 1-5) this yields continuous
// coverage 10:00am–11:59pm ET Mon–Fri, plus Sun 10:00pm–11:59pm ET.
//
// See nuvizz-refresh-stops-background.mts for the full schedule rationale and
// the 2026-11-01 EDT→EST DST adjustment (this file's EST form: */5 0-4 * * 1-6).

import { runRefreshStops } from './lib/refresh-stops-core.mts';

export default runRefreshStops;

export const config = {
  schedule: '*/5 0-3 * * 1-6',
};
