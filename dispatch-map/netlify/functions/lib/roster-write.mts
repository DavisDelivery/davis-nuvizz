// lib/roster-write.mts — WHEN MAY A ROSTER PULL REPLACE THE ONE WE HAVE? (PURE)
//
// Chad, on the deployed v0.93.3: "load roster 35833 this scan is not loading loads to system
// like it should also each refresh is causing like 14 calls when it should only be 3 or 4 …
// routes is only supposed to show loads with stops on them and that is what the bottom panel
// is doing that it didn't used to do."
//
// Two symptoms, ONE loop, and every step of it is in the code:
//
//   1. loadRosterForDate can return [] WITHOUT THROWING. normalizeLoads answers `[]` the
//      moment the response carries no filterData column defs (nuvizz-loads.mts:70), and drops
//      any row it cannot find a loadId on (:89). A 200 with an unexpected shape is an empty
//      roster, not an error.
//   2. writeLoadRoster is a bare setDoc — a REPLACE (firestore.mts). So one empty answer
//      overwrites a hundred good loads with nothing. Nothing anywhere refuses that write,
//      although this repo already refuses the identical shape of mistake twice over: the scan
//      will not prune a board it could not fully see, and finalizeCaptureSeal will not seal a
//      zero-stop capture. The roster was the third one and had no guard at all.
//   3. And an empty cache is not served. nuvizz-loads-roster keeps the cache only
//      `if (cached && cached.loads.length)` — deliberately, because an empty cache is supposed
//      to mean "never captured". So once step 2 lands, EVERY read falls through to a live
//      NuVizz call: three automatic client fetch sites (the Map routes panel, the bottom grid's
//      Loads view, the Routing rail) × every page load × every board-date change, each one
//      re-pulling and re-writing the same empty roster. That is the "14 calls when it should
//      only be 3 or 4", and it is also why both Loads panels show only the loads that have
//      stops: they are being handed nothing to merge.
//
// So the guard is two rules, both here, both pure:
//
//   acceptRosterWrite   — never REPLACE a non-empty roster with an empty one … until the
//                         emptiness has been seen enough times in a row to be believed. A day
//                         whose loads are genuinely all gone must still be able to land, so
//                         "refuse forever" is not an option: a stale list a dispatcher acts on
//                         is its own kind of wrong. A blip does not repeat; a real emptying
//                         does.
// The amplification is fixed a different way, and a simpler one than the ten-minute cooldown
// this module first carried. Chad: "i don't need 10 and i need it to fire when i manually
// refresh. Nothing should be calling nuvizz on Saturday except for a manual scan." So the read
// endpoint no longer spends a vendor call on its own AT ALL: an automatic read is cache-only,
// and the only things that reach NuVizz are the scheduled scan and an explicit refresh. Three
// fetch sites × every page load now costs nothing, on any day of the week, with no clock and
// no window to reason about.
//
// PURE. No Firestore, no network, no clock of its own — every decision is testable on data.

/** How many consecutive empty answers before we believe the day really has no loads. */
export const ACCEPT_EMPTY_AFTER = Math.max(1, Number(process.env.NUVIZZ_ROSTER_EMPTY_STREAK) || 3);

export interface RosterCache {
  at?: string | null;
  loads?: any[] | null;
  /** Consecutive pulls that came back empty. Absent on documents written before this guard. */
  emptyStreak?: number | null;
  /** When the most recent empty answer was observed. */
  emptyAt?: string | null;
}

export interface RosterWriteVerdict {
  write: boolean;
  /** What to store as the streak alongside the write (or to carry forward on a refusal). */
  emptyStreak: number;
  /** Plain English, for the log line and the ops row — a refusal must never be silent. */
  reason: string;
}

const rows = (v: any[] | null | undefined): number => (Array.isArray(v) ? v.length : 0);
const streakOf = (c: RosterCache | null | undefined): number => {
  const n = Number(c?.emptyStreak);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * acceptRosterWrite(cached, fresh) → may this pull replace what is cached?
 *
 * A NON-EMPTY answer always writes and resets the streak: whatever we have, a real list beats
 * it, and a shrink from 106 loads to 3 is a fact about the day rather than a failure — refusing
 * shrinks would freeze a Friday roster onto a Monday board.
 *
 * An EMPTY answer is the dangerous one, and it is only dangerous when there is something to
 * lose. Over an absent or already-empty cache it writes freely (it changes nothing, and it is
 * how a genuinely empty day gets recorded at all). Over a NON-EMPTY cache it is refused, and
 * the refusal is counted: on the ACCEPT_EMPTY_AFTER-th consecutive empty it is believed and
 * written, because a vendor blip does not repeat three times and a day whose loads were really
 * all cancelled must eventually be allowed to say so.
 */
export function acceptRosterWrite(
  cached: RosterCache | null | undefined,
  fresh: any[] | null | undefined,
): RosterWriteVerdict {
  const freshCount = rows(fresh);
  if (freshCount > 0) {
    return { write: true, emptyStreak: 0, reason: `${freshCount} load(s) — a real list always writes` };
  }
  const heldCount = rows(cached?.loads);
  const streak = streakOf(cached) + 1;
  if (heldCount === 0) {
    return { write: true, emptyStreak: streak, reason: 'empty answer over an empty/absent cache — nothing to lose' };
  }
  if (streak >= ACCEPT_EMPTY_AFTER) {
    return {
      write: true,
      emptyStreak: streak,
      reason: `empty ${streak}× in a row — believed, replacing ${heldCount} held load(s)`,
    };
  }
  return {
    write: false,
    emptyStreak: streak,
    reason: `REFUSED: empty answer would erase ${heldCount} held load(s) (${streak}/${ACCEPT_EMPTY_AFTER} strikes)`,
  };
}

/**
 * PURE. What does the cache hold for one date, in the terms the question is actually asked in?
 *
 * Chad, three rounds in: "the problem is the roster scan not populating the loads panel you are
 * fixing the wrong thing." He was right every time, and the reason it took three rounds is that
 * nothing could ANSWER the question — "the scan wrote a roster" and "the panel got nothing" are
 * the same blank screen from outside, and telling them apart meant spending a vendor call.
 *
 * The number that settles it is not `count`. A roster of three loads that all carry trips and a
 * roster that failed look identical on the Loads panels, because those panels exist to show the
 * loads with NO trips — the ones the stop-grouped board cannot render. So this reports `empties`
 * first and says in words which of the three states a date is in:
 *
 *   never captured        — no document at all
 *   captured but empty    — a document holding zero loads
 *   captured, no empties  — a real roster in which every load carries trips
 *   N empty load(s)       — working
 */
export function explainRosterRow(date: string, cached: RosterCache | null | undefined): Record<string, any> {
  if (!cached) return { date, cached: false, note: 'no roster document — this date has never been captured' };
  const loads = Array.isArray(cached.loads) ? cached.loads : [];
  const empties = loads.filter((l: any) => !(Number(l?.trips) > 0)).length;
  const numbered = loads.filter((l: any) => l?.loadNbr).length;
  return {
    date, cached: true, count: loads.length, empties, built: loads.length - empties, numbered,
    at: cached.at ?? null, emptyStreak: streakOf(cached), emptyAt: cached.emptyAt ?? null,
    note: loads.length === 0 ? 'captured but EMPTY — the scan wrote a roster with no loads in it'
      : empties === 0 ? 'captured, but every load carries trips — there are no empty loads in it'
        : `${empties} empty load(s) available to the Loads panels`,
  };
}
