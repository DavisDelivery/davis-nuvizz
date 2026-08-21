// eta-flag-history.mts
//
// READ-ONLY: the flag history the board screen shows.
//
// Chad: "I want to build a history of flags... somewhere that tracks all the flags that
// have presented itself, then the time the shipment actually delivered. And if the flag
// allowed us to fix the problem or not."
//
//   GET ?days=14              the last N days, newest first (default 14, max 60)
//   GET ?date=YYYY-MM-DD      one day, with every row
//   GET ?from=&to=            an arbitrary window, inclusive — "was August better than July"
//   GET ?rows=1               include per-stop rows on a multi-day read (heavier)
//
// THE WINDOW RULE IS NOT HERE. It is in src/lib/history-range.js, imported, because the
// screen resolves the same selection to decide what to print at the top. Clamping the 60-day
// cap or a future end differently in the two places gives you a header describing one range
// over numbers covering another, and both halves look right on their own.
//
// Writes nothing, sends nothing, and makes ZERO NuVizz calls — it reads the documents the
// 20-minute sweep and the nightly ledger already wrote.
//
// NO SCHEDULE ON PURPOSE. A function carrying a cron is not reachable over plain HTTP in
// this app — a property rediscovered twice at cost. This one must answer a browser.
import { isFirestoreEnabled, getDoc, etDayString } from './lib/firestore.mts';
import { flagHistoryPath, summarize, FLAG_HISTORY_VERSION } from './lib/flag-history.mts';
import { resolveRange, expandRange, selectionFromParams, isDateStr } from '../../src/lib/history-range.js';

const TENANT = 'davis';

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), {
    status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);
    const one = url.searchParams.get('date');
    const wantRows = url.searchParams.get('rows') === '1';
    const today = etDayString();

    // ONE DAY, in full. ?date= keeps meaning "that day with every row", which is what an
    // expanded day row fetches; a one-day WINDOW goes through ?from=&to= like any other.
    if (one && isDateStr(one)) {
      const doc = await getDoc(flagHistoryPath(TENANT, one));
      if (!doc?.rows) return J({ ok: true, date: one, found: false, rows: [], summary: null });
      const rows = Object.values(doc.rows);
      return J({
        ok: true, date: one, found: true, version: doc.version ?? null,
        summary: doc.summary ?? summarize(rows as any),
        scoredAt: doc.scored_at ?? null,
        nextDayCaptured: doc.next_day_captured ?? null,
        rows,
      });
    }

    // A WINDOW, newest first. Reads are one doc per day and the span is capped, so this stays
    // a handful of gets rather than a query — and the collection needs no index.
    const range = resolveRange(selectionFromParams((k) => url.searchParams.get(k)), today);
    const wanted = expandRange(range.from, range.to);
    const results = await Promise.all(wanted.map(async (date) => {
      try {
        const doc = await getDoc(flagHistoryPath(TENANT, date));
        if (!doc?.rows) return { date, found: false };
        const rows = Object.values(doc.rows);
        return {
          date, found: true,
          summary: doc.summary ?? summarize(rows as any),
          scoredAt: doc.scored_at ?? null,
          // A day whose flags are recorded but not yet scored is a normal state before the
          // nightly run, and the screen says so rather than showing zeroes as outcomes.
          scored: !!doc.scored_at,
          nextDayCaptured: doc.next_day_captured ?? null,
          ...(wantRows ? { rows } : {}),
        };
      } catch { return { date, found: false, error: true }; }
    }));

    const found = results.filter((r: any) => r.found);
    // The window rolled up. Deliberately re-derived from the day summaries rather than
    // stored, so a change to what a column MEANS cannot leave stale totals behind.
    // Seeded with zeros rather than built up from {}, so a range with no data still answers
    // with every field present. An empty object forces each reader to invent its own
    // fallback, and the one that forgets prints "undefined" on a dashboard.
    const TOTAL_KEYS = ['flags', 'made', 'missed', 'rolled', 'undelivered', 'unknown', 'emailed', 'actedOn', 'warned', 'tooLateToAct', 'gradable'] as const;
    const total: any = Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0]));
    for (const d of found as any[]) {
      const s = d.summary || {};
      for (const k of TOTAL_KEYS) total[k] += s[k] || 0;
    }
    total.missedAfterWarning = total.gradable ? Math.round((total.missed / total.gradable) * 100) : null;

    return J({
      ok: true, version: FLAG_HISTORY_VERSION, days: results.length,
      // The window actually READ, not the one asked for. A range clamped to the cap or pulled
      // back off the future has to say so, or a silently narrowed window reads on the screen
      // as a genuinely quiet stretch.
      range: { from: range.from, to: range.to, days: range.days, clamped: range.clamped ?? null },
      daysWithData: found.length, total, results,
    });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e) }, 500);
  }
};
