// nuvizz-manual-scan-background.mts — the "Scan now" button's PRIMARY endpoint.
//
// Chad, Jul 31: "Scan refused (HTTP 504) — the scanner endpoint did not accept the request."
// The 504 was Netlify's gateway killing nuvizz-manual-scan: that fallback (added in v0.54.19
// when the button broke a different way) runs the WHOLE scan inside a synchronous function,
// and the scheduled writer's own header has warned about exactly that since M5.2 — "the
// inline scan can't run on the request path — load+unplanned scan is >22s and 502s past the
// 26s request cap." On a light day it squeaks under the cap and the button works; on a real
// morning (743 stops, 44 carry-overs, 61 calls in the 06:00 hour) it doesn't, and the button
// fails exactly when a dispatcher most wants a fresh scan.
//
// Why the button couldn't just use the scheduled background writer: carrying a cron
// `config.schedule` makes a function SCHEDULED, and a scheduled function is not reliably
// invocable over HTTP (the POST answers 404/405 while the cron runs fine) — the very failure
// v0.54.19 was papering over.
//
// So this is the missing piece: the SAME runRefreshStops behind a PLAIN background function.
//   • the '-background' filename suffix is what buys the 202-immediately + 15-minute budget
//     (same mechanism as the scheduled writer — the suffix, not the schedule);
//   • NO `config.schedule`, so a plain HTTP POST reaches it. Do not add one — a schedule here
//     re-breaks the Scan-now button in the 404/405 way, and the test pins its absence.
// The client already polls the read endpoint's lastScannedAt after firing, so 202-now fits
// the existing flow with no client-side wait change.
import { runRefreshStops } from './lib/refresh-stops-core.mts';
import { recordScanRun, recordScanRefusal, etDayString } from './lib/firestore.mts';
import { requireUserForBackground } from './lib/background-gate.mts';

/**
 * The inner scan URL — MANUAL LIST-DISCOVERY ONLY (pure; exported for tests).
 *
 * `manual=1` is forced, and `date`/`days` are deliberately DISCARDED rather than forwarded:
 * runRefreshStops with a date flips into the explicit number-probe path — a ~3,000-NuVizz-call
 * cold scan (CLAUDE.md hard rule). The sync fallback forwards its whole query string, so a
 * stray ?date= there rides through; this endpoint structurally cannot reach that path,
 * whatever it is called with. Manual list-discovery is the same cheap ~4-call scan the cron
 * runs.
 */
export function manualScanUrl(reqUrl: string): string {
  const url = new URL(reqUrl);
  const clean = new URL(url.origin + url.pathname);
  clean.searchParams.set('manual', '1');
  // `viewedDate` — the board the dispatcher is looking at — is the ONE other parameter allowed
  // through, and it is re-validated here rather than trusted. Chad: "if I have it set for a
  // future date when I hit the refresh button it should pull the load roster for that day and
  // the next." runRefreshStops reads it only in rosterDatesFor.
  //
  // WHY THIS IS SAFE WHERE `?date=` IS NOT: `date` and `days` set `explicit` in runRefreshStops
  // and flip it into the ~3,000-call number-probe engine, which is why this builder discards
  // them and a test pins that they are structurally unreachable. `viewedDate` reaches nothing
  // but the roster horizon — same call count, aimed at the day on screen. Anything that is not
  // a real YYYY-MM-DD is dropped, so a typo silently means "the normal horizon", never an error
  // and never a wider scan.
  const viewed = url.searchParams.get('viewedDate') || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(viewed) && Number.isFinite(Date.parse(viewed + 'T00:00:00Z'))) {
    clean.searchParams.set('viewedDate', viewed);
  }
  return clean.toString();
}

export default async (req: Request): Promise<Response> => {
  // GATED AT dispatcher — a manual scan spends real NuVizz calls and moves the board every
  // dispatcher is reading.
  //
  // WHERE THE REFUSAL GOES, AND WHAT IT STILL DOES NOT REACH. Netlify has already answered
  // this caller 202, so the 401 below is thrown away (see lib/background-gate.mts). The
  // refusal is therefore filed as a RUN ROW in the scan ledger — the same
  // nuvizz_ops/scan_runs the scheduled scanner writes and nuvizz-scan-config?explain=1 reads
  // back — with startedAt AND finishedAt set, so it can never be mistaken for the
  // started-and-died row that ledger exists to expose. That is the honest record of "the
  // 05:12 scan did not happen, and here is why".
  //
  // AND WHERE THE BUTTON CAN SEE IT. The scan ledger answers the ops question ("did the 05:12
  // scan happen?") but it is a 400-row document and the Map's Scan-now button never reads it:
  // App.jsx useManualScan polls nuvizz-pull-today-stops for a CHANGED lastScannedAt, sees the
  // 202 as success, and falls through to "Scan running — the board will refresh automatically"
  // while nothing runs. So the refusal is ALSO stamped on nuvizz_ops/scan_refusal, one tiny
  // doc holding only the most recent one, which that same poll now serves back as
  // `lastScanRefusal` (see nuvizz-pull-today-stops). Rendering it is the client's half.
  //
  // The two doc-backed alternatives were both rejected on purpose, and stay rejected: writing
  // lastScannedAt would claim a scan that never ran, and writing markScanState({halted}) paints
  // "Scanning paused (kill switch) — board may be stale" — wrong words — on EVERY viewer's
  // board, which would hand one refused caller a way to red-banner the whole dispatch floor.
  const gate = await requireUserForBackground(req, 'nuvizz-manual-scan-background', {
    role: 'dispatcher',
    record: async (refusal) => {
      const at = refusal.at;
      await recordScanRun({
        id: `${at}__refused`, startedAt: at, finishedAt: at, ms: 0,
        trigger: 'manual', path: 'auth', outcome: 'refused',
        skip: 'not-signed-in', reason: refusal.reason, error: refusal.message,
        etDate: etDayString(new Date(at)),
      });
      await recordScanRefusal({
        at, reason: refusal.reason, message: refusal.message,
        job: 'nuvizz-manual-scan-background', trigger: 'manual',
      });
    },
  });
  if (!gate.ok) return gate.response;
  return runRefreshStops(new Request(manualScanUrl(req.url), { method: 'POST' }));
};
