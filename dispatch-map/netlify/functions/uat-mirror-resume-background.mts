// uat-mirror-resume-background.mts — run the UAT mirror refresh BY HAND.
//
// The scheduled uat-mirror-refresh-background cannot be POSTed: Netlify refuses a direct URL
// call to a scheduled function ("You can't invoke scheduled functions directly with a URL"), and
// the UAT site answered 403 to exactly that on 2026-09-24. This is the same handler with NO
// `config.schedule`, so a plain POST reaches it — the pattern nuvizz-manual-scan-background.mts
// set for the same reason. Do not add a schedule here: that would make this one unreachable too,
// and the test pins its absence.
//
//   POST /.netlify/functions/uat-mirror-resume-background     → resume the stored run, or start
//                                                                today's window if none is open
//   Overrides as documented in lib/uat-mirror-endpoint.mts (admin only). The bare POST is gated
//   at dispatcher, inert until AUTH_REQUIRED=true like every other gate here.
//
// The '-background' suffix buys the 202-immediately + 15-minute allowance; the run stops at its
// 12-minute budget and records where. Mirror-only: on production it returns 403 before parsing.
// Confirm with GET uat-mirror-refresh?status=1. ZERO NuVizz calls, by construction.
import { mirrorRefreshHandler, RESUME_JOB } from './lib/uat-mirror-endpoint.mts';
import { requireUserForBackground } from './lib/background-gate.mts';

export default (req: Request): Promise<Response> =>
  mirrorRefreshHandler(req, {
    job: RESUME_JOB,
    // runs after the handler's mirror-only / switch / Firestore checks, before any parsing
    manualGate: (r) => requireUserForBackground(r, RESUME_JOB, { role: 'dispatcher' }),
  });
