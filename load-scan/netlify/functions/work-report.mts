// work-report.mts
//
// GET ?shiftDay=YYYY-MM-DD&days=N[&format=csv]  -> the admin report.
//
// Dispatcher role required — it is staff performance data.
//
// ── WHERE THE NUMBERS COME FROM ──────────────────────────────────────────────
//
// Three sources, merged, in descending order of trust:
//
//   1. loadscan_worklog     explicit start/finish events. MEASURED.
//   2. nuvizz_load_scans    scan sessions. Their per-worker firstAt/lastAt give
//                           a DERIVED duration when an event is missing — a
//                           phone that died mid-truck, or a load worked before
//                           this feature existed.
//   3. nuvizz_stop_index    the board, so a load nobody touched can still be
//                           named. Absence of work is a finding, and it can only
//                           come from the list of what SHOULD have happened.
//
// Every row says which of those it came from, because a derived duration cannot
// see the time before the first successful scan and is therefore a floor. Mixing
// floors and measurements without saying so understates the real work.
//
// ZERO NuVizz calls.

import { listDocs, readStops, getDoc, isFirestoreEnabled } from './lib/firestore.mts';
import { authenticate } from './lib/auth.mts';
import { toManifestStop, groupIntoLoads } from './lib/manifest.mts';
import { mergeSession, type WorkSession, type Assignment } from './lib/worklog.mts';
import { buildShiftReport, toCsv, type ShiftReport } from './lib/workreport.mts';
import { recentShiftDays, shiftDayString, shiftWindow } from './lib/shift.mts';
import { ok, bad, unauthorized, forbidden, DATE_RE } from './lib/http.mts';

const WORKLOG = 'loadscan_worklog';
const ASSIGNMENTS = 'loadscan_assignments';
const SESSIONS = 'nuvizz_load_scans';
const TENANT = 'davis';

/**
 * Scan sessions overlapping a shift day.
 *
 * Scan sessions are keyed by CALENDAR date, not shift day, so a single shift
 * spans two of them: the evening half sits under the previous date. Both are
 * read and then filtered by the shift window, which is why the window is
 * computed as real instants rather than assumed.
 */
async function scanSessionsFor(shiftDay: string) {
  const { start, end } = shiftWindow(shiftDay);
  const prev = start.slice(0, 10);
  const docs = await listDocs(SESSIONS).catch(() => []);
  return (docs || []).filter((d: any) => {
    const date = String(d?.date ?? '');
    if (date !== shiftDay && date !== prev) return false;
    // Keep the doc if ANY worker touched it inside the window.
    return (d?.workers || []).some((w: any) => {
      const at = String(w?.lastAt ?? w?.firstAt ?? '');
      return at >= start && at < end;
    });
  });
}

/** Fill missing sessions from scan data so a dead phone still leaves a record. */
function deriveFromScans(sessions: WorkSession[], scanDocs: any[]): WorkSession[] {
  let out = sessions;
  for (const doc of scanDocs || []) {
    const loadNbr = String(doc?.loadNbr ?? '');
    if (!loadNbr) continue;
    for (const w of doc?.workers || []) {
      const worker = String(w?.driverNumber ?? '');
      if (!worker) continue;
      out = mergeSession(out, {
        worker,
        loadNbr,
        workerName: String(w?.displayName ?? ''),
        role: String(w?.role ?? 'driver'),
        startedAt: String(w?.firstAt ?? ''),
        finishedAt: String(w?.lastAt ?? ''),
        closedOut: !!doc?.closedAt,
        pieces: Number(w?.pieces ?? 0) || 0,
        // Never 'events' — mergeSession keeps the stronger source, so a real
        // start/finish already recorded is not downgraded by this pass.
        source: 'derived',
      });
    }
  }
  return out;
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'GET') return bad('GET only', 405);

  const claims = authenticate(req);
  if (!claims) return unauthorized();
  if (!isFirestoreEnabled()) return bad('not configured', 503);
  if (claims.role !== 'dispatcher') return forbidden('dispatcher role required');

  const url = new URL(req.url);
  const endDay = String(url.searchParams.get('shiftDay') || shiftDayString());
  if (!DATE_RE.test(endDay)) return bad('shiftDay must be YYYY-MM-DD');

  const days = Math.min(31, Math.max(1, Number(url.searchParams.get('days') || 1)));
  const wanted = recentShiftDays(endDay, days);

  const reports: ShiftReport[] = [];
  for (const shiftDay of wanted) {
    const [worklogDoc, assignDoc, scanDocs] = await Promise.all([
      getDoc(`${WORKLOG}/${TENANT}__${shiftDay}`).catch(() => null),
      getDoc(`${ASSIGNMENTS}/${TENANT}__${shiftDay}`).catch(() => null),
      scanSessionsFor(shiftDay),
    ]);

    let sessions: WorkSession[] = Array.isArray(worklogDoc?.sessions) ? worklogDoc.sessions : [];
    sessions = deriveFromScans(sessions, scanDocs);

    const assignments: Record<string, Assignment> =
      assignDoc?.assignments && typeof assignDoc.assignments === 'object' ? assignDoc.assignments : {};

    // The board for that shift. Loaded from the stop index for the shift day —
    // the freight loaded on Sunday night IS Monday's board, which is exactly the
    // alignment the 8pm rollover was chosen to give.
    let loads: any[] = [];
    try {
      const stops = (await readStops(TENANT, shiftDay)).map(toManifestStop);
      loads = groupIntoLoads(stops).map((l: any) => ({
        loadNbr: l.loadNbr,
        routeName: l.routeName ?? null,
        expectedPieces: l.expectedPieces ?? 0,
        stopCount: (l.stops || []).length,
        hasSession: (scanDocs || []).some((d: any) => String(d?.loadNbr) === String(l.loadNbr)),
      }));
    } catch {
      // No board cached for that day (a weekend, or before the index existed).
      // The worklog still reports what people did.
    }

    reports.push(buildShiftReport(shiftDay, sessions, assignments, loads));
  }

  if (String(url.searchParams.get('format') || '').toLowerCase() === 'csv') {
    return new Response(toCsv(reports), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="loadscan-${wanted[wanted.length - 1]}_to_${endDay}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return ok({ shiftDay: endDay, days, reports });
};
