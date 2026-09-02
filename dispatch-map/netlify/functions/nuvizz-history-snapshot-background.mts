// nuvizz-history-snapshot-background.mts  (Phase 1 — immutable daily history warehouse)
//
// Scheduled BACKGROUND writer for the immutable history warehouse. Each nightly
// run captures the just-closed America/New_York day: one scanDate() read, then
// derive + write immutable history docs (stops, routes, drivers, captures audit,
// manifest). Shared capture logic lives in lib/history-core.mts.
//
// WHY "-background" (deviation from the brief's suggested filename):
//   A single-day scanDate() (planned load-range probe + unplanned number-space
//   scan) runs well past the 30s cap of a plain scheduled function — the exact
//   reason the stop-index writer is a background function. Netlify gives the
//   "-background" suffix a 15-min budget, so we mirror the proven
//   nuvizz-refresh-stops-background pattern. Background fns return 202 and run
//   async; the verified result is in the function log + the captures audit doc.
//
// Manual trigger (any time, e.g. against a deploy preview — cron only fires on
// PUBLISHED deploys):
//   POST /.netlify/functions/nuvizz-history-snapshot-background
//     ?date=YYYY-MM-DD                      → single day
//     ?from=YYYY-MM-DD&to=YYYY-MM-DD        → inclusive range, ≤31 days (backfill)
//   No query string → captures ET-yesterday (the scheduled default).
//
// ── Schedule: 06:00 UTC nightly ──────────────────────────────────────────────
//   0 6 * * *
// DST reasoning: 06:00 UTC is 01:00 ET under EST (UTC-5) and 02:00 ET under EDT
// (UTC-4) — both safely after ET midnight, so the target day (ET-yesterday) is
// fully closed and POD/executed data has settled. The cron itself is
// timezone-agnostic (runs at the same UTC instant year-round); the ET-yesterday
// target is computed off the America/New_York clock in history-core, so the DST
// flips (2026-11-01 EDT→EST, 2027-03-08 EST→EDT) require NO change here.
//
// v1 = one nightly capture of the just-closed day. A future "settle pass"
// re-capturing day-2 (to absorb late POD) is out of scope — TODO v1.1.

import { runHistorySnapshot } from './lib/history-core.mts';
import { gateScheduledOverride } from './lib/background-gate.mts';

// ?date= / ?from=&to= is the backfill branch: each day costs a full scanDate() — the planned
// load-range probe plus the unplanned number-space descent — and ?from=&to= takes up to 31 of
// them in one POST. The scheduled run takes no params and captures ET-yesterday.
//
// The gate is ADMIN-only and, like every other gate in this change set, SHIPS INERT: with
// AUTH_REQUIRED unset the hand-driven override runs exactly as it always has, and the door
// shuts on the day that switch is flipped. See gateScheduledOverride in
// lib/background-gate.mts for why the STRICT version of this was wrong — AUTH_SESSION_SECRET
// is not set on the production site, so strict did not mean "admins only", it meant every
// caller got 401 "sign-in not configured", Chad included, and because this is a *-background*
// function Netlify answers 202 and throws that 401 away: a documented runbook that silently
// does nothing. It runs BEFORE the core is entered, so a refused override reaches no
// Firestore read and no vendor call.
export const OVERRIDE_PARAMS = ['date', 'from', 'to'] as const;

export default async (req: Request): Promise<Response> => {
  const refused = await gateScheduledOverride(req, 'nuvizz-history-snapshot-background', OVERRIDE_PARAMS);
  if (refused) return refused;
  return runHistorySnapshot(req);
};

export const config = {
  schedule: '0 6 * * *',
};
