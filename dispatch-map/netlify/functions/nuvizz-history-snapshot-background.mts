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
//     &dryRun=1                             → with either of the above: WRITE NOTHING and call
//                                             NuVizz for nothing; log what the run would do
//                                             (dryrun / dry_run / dry count too; only
//                                             0/false/no/off runs for real). Every spelling
//                                             is behind the same admin gate as ?date=.
//   No query string → captures ET-yesterday (the scheduled default). THIS IS THE 2 AM RUN AS FAR
//     AS THE CODE CAN TELL: the cron sends no query string, and nothing here can tell a person's
//     no-query POST from it. So it is NOT checked by the re-capture guard below — it captures the
//     day exactly as the 2 AM run does (from the day's index as it stands, or where the capture
//     would scan, from a NuVizz scan) and overwrites every archived stop it writes again. Sent
//     the morning after a failed night, on the index path that seals the morning's heals into
//     the failed day. To re-run a failed night by hand, last night included, name it:
//     ?date=YYYY-MM-DD.
//
// A RE-CAPTURE THAT NAMES ITS DAY (?date= / ?from=&to=) CAN REFUSE. When the day's board index
// holds rows the frozen-day heal or a dispatcher Save changed after that day's last scan, or the
// archive already holds stops the run would replace, it writes nothing and logs the counts — what
// to do with those rows is Chad's decision (lib/history-recapture.mts; HISTORY_RECAPTURE_GUARD=off
// removes the refusal). A POST with no query string is not checked (above). Ask first,
// synchronously and for Firestore reads only:
//   GET /.netlify/functions/history-capture-health?recapture=YYYY-MM-DD
// (a -background function's own response is discarded by Netlify — ?dryRun=1 here only logs).
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

import { runHistorySnapshot, dryRunParamNames } from './lib/history-core.mts';
import { gateScheduledOverride } from './lib/background-gate.mts';

// ?date= / ?from=&to= is the backfill branch: each day costs a full scanDate() — the planned
// load-range probe plus the unplanned number-space descent — and ?from=&to= takes up to 31 of
// them in one POST. The scheduled run takes no params and captures ET-yesterday — and so does a
// hand POST with no query string, which neither this gate nor the re-capture guard can tell from
// it (the gate asks only when an override param is present).
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
export const OVERRIDE_PARAMS = ['date', 'from', 'to', 'dryRun'] as const;

/**
 * The overrides this request is gated on: the list above, plus EVERY spelling of the dry-run flag
 * that isDryRun reads (?dry, ?dryrun, ?dry_run, ?DryRun, ?dry-run…), whatever its value — read
 * with the same matcher (history-core dryRunParamNames), so the gate and the dry run cannot
 * disagree about what counts. A fixed list could only ever name some of them, and ?dry=1 alone
 * would have walked past the gate once AUTH_REQUIRED=true.
 */
export function gatedParams(req: Request): string[] {
  return [...new Set<string>([...OVERRIDE_PARAMS, ...dryRunParamNames(req)])];
}

export default async (req: Request): Promise<Response> => {
  const refused = await gateScheduledOverride(req, 'nuvizz-history-snapshot-background', gatedParams(req));
  if (refused) return refused;
  return runHistorySnapshot(req);
};

export const config = {
  schedule: '0 6 * * *',
};
