// uat-mirror-refresh-background.mts — load production's days into the UAT mirror, from
// Firestore alone, every morning. ZERO NuVizz calls, by construction: the only outbound traffic
// is the Firestore REST API, on both sides.
//
// Chad, 2026-09-20: "I want to use firestore to load up all our stops so I can test there
// without doing anything in nuvizz or nuvizz uat … We can do this all without a single nuvizz
// call just using our uat and firestore data."
//
// SCHEDULED ONLY. Netlify's cron is the one caller this function can have: "You can't invoke
// scheduled functions directly with a URL" (Netlify docs), and a POST to it on the UAT site
// answered 403 before any of this code ran (2026-09-24). To run the refresh by hand — or finish
// one that stopped at the budget — POST uat-mirror-resume-background, which runs the same
// handler behind no schedule. Gates, overrides and the run itself: lib/uat-mirror-endpoint.mts.
//
// SCHEDULE: 06:45 UTC daily, after production's 06:00 capture has sealed yesterday. On the
// mirror that copies yesterday's sealed day (and re-mines it), today's and the next days'
// boards, the rosters and the static collections; days already mirrored and unchanged in
// production are skipped. ON PRODUCTION THE SAME CRON FIRES AND EXITS IN THE HANDLER'S FIRST
// LINE: this is not a mirror, so there is nothing to do and nothing to spend.
import { mirrorRefreshHandler } from './lib/uat-mirror-endpoint.mts';

export { OVERRIDE_PARAMS } from './lib/uat-mirror-endpoint.mts';

export default (req: Request): Promise<Response> =>
  mirrorRefreshHandler(req, { job: 'uat-mirror-refresh-background' });

export const config = {
  schedule: '45 6 * * *',
};
