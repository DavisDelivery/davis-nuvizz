// netlify/functions/driver-territory.mts — THE PRINTED DRIVER-AREA SHEET, LIVE.
//
// Chad: "I want something I can print out and give to someone", and, having seen the sample:
// "I like the circles."
//
// Open it, press print. That is the whole interaction — a dispatcher should not have to run a
// script or ask anybody to regenerate a sheet that goes stale every few weeks.
//
// ── IT CANNOT SPEND A NUVIZZ CALL, AND THAT IS STRUCTURAL ───────────────────────────────────
// This module imports the history store and the sheet renderer. NEITHER can reach the vendor:
// history-store only knows Firestore paths, and the renderer is a pure string builder. There is
// no nuvizz-* import anywhere in this file's graph, so the cost rule in CLAUDE.md is enforced by
// what is reachable rather than by remembering not to. Firestore reads are free of NuVizz calls;
// they are not free of TIME, which is why the window is capped.
//
//   GET ?weeks=4                → the printable sheet (HTML; print to PDF from the browser)
//   GET ?weeks=4&format=json    → the same data, unrendered
//   GET ?explain=1              → what history actually exists, and nothing else
import { listStops } from './lib/history-store.mts';
import { isFirestoreEnabled, getDoc, etDayString } from './lib/firestore.mts';
import { territorySheetHtml } from '../../src/lib/territory-sheet-html.js';
import {
  territoryCoverage, activeDrivers, possibleSameDriver, applyAliases, rosterOf,
} from '../../src/lib/driver-territory.js';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';
const MAX_WEEKS = 12;
const ALIAS_PATH = 'nuvizz_ops/driver_aliases';

// Business days back from `end`, inclusive. Weekends carry no deliveries, so listing them is a
// Firestore round trip per day that can only come back empty.
export function windowDates(end: string, weeks: number): string[] {
  const out: string[] = [];
  const d = new Date(Date.parse(end + 'T00:00:00Z'));
  const wanted = Math.max(1, Math.min(MAX_WEEKS, weeks)) * 5;
  while (out.length < wanted) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out.reverse();
}

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  // A trainee reference, so the lowest role that can see the board can see this. It exposes
  // nothing a stop row does not.
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore not configured' }, 503);

  const url = new URL(req.url);
  const weeks = Math.max(1, Math.min(MAX_WEEKS, Number(url.searchParams.get('weeks')) || 4));
  const endRaw = url.searchParams.get('end') || '';
  const end = /^\d{4}-\d{2}-\d{2}$/.test(endRaw) ? endRaw : etDayString();
  const dates = windowDates(end, weeks);

  // A READ THAT FAILS IS SAID OUT LOUD. Swallowing it would silently shrink the window and the
  // sheet would print a confident picture built from half the history — the same absent-is-not-
  // zero mistake ?explain=1 was fixed for two releases ago.
  const stops: any[] = [];
  const missing: string[] = [];
  const failed: { date: string; error: string }[] = [];
  for (const date of dates) {
    try {
      const rows = await listStops(TENANT, date);
      if (!rows.length) missing.push(date);
      for (const r of rows) stops.push({ ...r, boardDate: r.boardDate || date });
    } catch (e: any) { failed.push({ date, error: String(e?.message || e).slice(0, 160) }); }
  }

  const aliases = (await getDoc(ALIAS_PATH).catch(() => null))?.aliases || [];
  const folded = applyAliases(stops, aliases);
  const rosterNames = (await getDoc(`nuvizzRoster/${TENANT}`).catch(() => null))?.drivers || null;

  if (url.searchParams.get('explain') === '1') {
    const { active, excluded } = activeDrivers(folded, { roster: rosterNames ? rosterOf(rosterNames) : null });
    return J({
      ok: failed.length === 0,
      window: { from: dates[0], to: dates[dates.length - 1], weeks, businessDays: dates.length },
      daysWithData: dates.length - missing.length,
      daysEmpty: missing,
      readFailures: failed,
      coverage: territoryCoverage(folded, { roster: rosterNames ? rosterOf(rosterNames) : null }),
      activeDrivers: [...active],
      excludedDrivers: excluded,
      possibleSameDriver: possibleSameDriver(folded).map((p) => ({ a: p.a.key, b: p.b.key, aStops: p.a.stops, bStops: p.b.stops })),
      aliasesApplied: aliases,
      nuvizzCalls: 0,
    });
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    window: { from: dates[0], to: dates[dates.length - 1] },
    roster: rosterNames,
    stops: folded,
    // Surfaced ON the sheet, never merged behind Chad's back — see possibleSameDriver.
    maybeSame: possibleSameDriver(folded),
    readFailures: failed,
  };
  if (url.searchParams.get('format') === 'json') return J({ ok: true, ...payload, stops: undefined, stopCount: folded.length });
  return new Response(territorySheetHtml(payload), { status: 200, headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' } });
};
