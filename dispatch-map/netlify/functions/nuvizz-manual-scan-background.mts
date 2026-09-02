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
import { recordScanRun, etDayString } from './lib/firestore.mts';
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
  // WHAT IT DOES NOT DO, said plainly rather than assumed: the Map's Scan-now button
  // (App.jsx useManualScan) polls nuvizz-pull-today-stops for a CHANGED lastScannedAt and has
  // no other channel, so on a refusal it still falls through to "Scan running — the board
  // will refresh automatically". Making that button say "not signed in" needs a client change
  // in App.jsx, which this stream does not own. The two doc-backed alternatives were both
  // rejected on purpose: writing lastScannedAt would claim a scan that never ran, and writing
  // markScanState({halted}) paints "Scanning paused (kill switch) — board may be stale" —
  // wrong words — on EVERY viewer's board, which hands one refused caller a way to red-banner
  // the whole dispatch floor.
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
    },
  });
  if (!gate.ok) return gate.response;
  return runRefreshStops(new Request(manualScanUrl(req.url), { method: 'POST' }));
};
