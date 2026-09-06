// lib/roster-shells.mts — THE STANDARD ROUTE SHELLS FOR A DAY NUVIZZ HAS NOT CREATED YET (PURE)
//
// Chad, Sunday Sep 6 2026, the board on Tue Sep 8: "I want to build loads on the weekend for
// next week and if I put the map on the date I want to build on and do a manual scan the loads
// should show up even if on the weekend."
//
// THE ONE CALL HE APPROVED SETTLED WHAT THE SCAN SEES. nuvizz-load-columns?date=2026-09-08
// &confirm=1 at 13:51 ET: HTTP 200, 21 column definitions, ZERO rows for period +2d. The
// request is byte-identical to July's; the parser kept 106 of 106 on Sep 2. NuVizz simply
// holds no loads for Tuesday yet — the day's empty trailers ("SUW 2", "ATL", "TRAILER 3" …)
// had not been created in the vendor, so no scan, on any schedule, could have shown them.
//
// A scan cannot show a load that does not exist. What the app CAN do is what Chad designed on
// Aug 3 for exactly this hole: "＋ New route" opens a pending Compare card and Save creates the
// route in NuVizz WITH its stops (NuVizz refuses an empty route, reason 903). What that flow
// lacked was the list. He should not have to type "SUW 2" from memory fifty times on a Sunday.
//
// So: the standard shells are the route names the last few captured delivery days agree on.
// The roster cache (nuvizz_load_roster/<tenant>__<date>) already holds every day's loads, so
// this costs Firestore reads and NOTHING from the vendor. A name on at least two of the last
// three captured days is a recurring route; a name on one is a one-off (a driver's name on a
// day he ran his own trailer) and is left out — he can still type that one.
//
// PURE. No Firestore, no clock, no network — every rule here is testable on data.

export interface ShellSource { date: string; loads: any[] }

/** How many recent captured days have to be found before the standard set is taken. */
export const SHELL_SOURCES = 3;
/** How many calendar days back the endpoint may look for them (a holiday week still has 3). */
export const SHELL_LOOKBACK_DAYS = 14;
/** A name must be on this many of the sources to count as a standard shell (when ≥ 2 sources). */
export const SHELL_MIN_AGREEMENT = 2;

const key = (v: any): string => String(v ?? '').trim().toLowerCase();

/**
 * Calendar days strictly BEFORE `fromDate`, most recent first, weekdays only (the roster is
 * never captured on a weekend — Davis does not run one), up to `maxDays` calendar days back.
 * Dates are the roster cache's own keys (YYYY-MM-DD, UTC-anchored like the scanner's).
 */
export function shellLookbackDates(fromDate: string, maxDays = SHELL_LOOKBACK_DAYS): string[] {
  const base = Date.parse(String(fromDate ?? '').trim() + 'T00:00:00Z');
  if (!Number.isFinite(base)) return [];
  const out: string[] = [];
  for (let i = 1; i <= maxDays; i++) {
    const d = new Date(base - i * 86400000);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * standardShellNames(sources) → the route names the sources agree on, A→Z (numeric-aware, so
 * "SUW 2" sorts before "SUW 10").
 *
 * With two or more sources a name must appear on at least SHELL_MIN_AGREEMENT of them; with
 * one source every name on it counts (one day is all the evidence there is). Names are matched
 * case-insensitively and trimmed; the first spelling seen is the one returned. A source's
 * BUILT loads count as much as its empties: DIXON carried 11 stops on Sep 2 and is still a
 * recurring route — what makes a shell standard is that the day has it, not that it was empty.
 */
export function standardShellNames(sources: ShellSource[]): string[] {
  const list = (sources || []).filter((s) => s && Array.isArray(s.loads));
  if (!list.length) return [];
  const seenOn = new Map<string, { display: string; days: number }>();
  for (const s of list) {
    const onThisDay = new Set<string>();
    for (const l of s.loads) {
      const display = String(l?.name ?? '').trim();
      const k = key(display);
      if (!k || onThisDay.has(k)) continue;
      onThisDay.add(k);
      const e = seenOn.get(k);
      if (e) e.days += 1; else seenOn.set(k, { display, days: 1 });
    }
  }
  const need = list.length >= 2 ? SHELL_MIN_AGREEMENT : 1;
  return [...seenOn.values()]
    .filter((e) => e.days >= need)
    .map((e) => e.display)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
}

/**
 * shouldOfferShells(date, today, rosterLoads, standard) → may the endpoint attach the shells?
 *
 *   • a PAST date       → never. Nothing gets built onto yesterday.
 *   • no standard names → never. There is nothing to offer.
 *   • an EMPTY roster   → yes. This is Chad's Sunday: NuVizz answered zero rows for the day.
 *   • a roster missing MORE THAN HALF of the standard names → yes. This is the same Sunday an
 *     hour later: he saved "SUW 2" and "ATL", the next scan captured those two, and the other
 *     hundred shells still need creating. Ninety-eight missing of a hundred is "NuVizz has not
 *     generated this day"; three missing of a hundred is an ordinary day with three routes
 *     cancelled, and offering those three as "not in NuVizz yet" would be noise on every
 *     normal morning.
 *
 * `missing` is returned so a caller can log or show it; the endpoint sends the full standard
 * list and the client subtracts what the board already has (roster, board groups, cards).
 */
export function shouldOfferShells(
  date: string, today: string, rosterLoads: any[] | null | undefined, standard: string[],
): { offer: boolean; missing: string[] } {
  const std = Array.isArray(standard) ? standard : [];
  if (!std.length) return { offer: false, missing: [] };
  if (String(date ?? '') < String(today ?? '')) return { offer: false, missing: [] };
  const have = new Set((rosterLoads || []).map((l) => key(l?.name)).filter(Boolean));
  const missing = std.filter((n) => !have.has(key(n)));
  const offer = have.size === 0 || missing.length * 2 > std.length;
  return { offer, missing };
}
