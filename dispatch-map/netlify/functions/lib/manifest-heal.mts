// lib/manifest-heal.mts — THE MANIFEST HISTORY ROW ASKS THE BOARD AGAIN. (pure)
//
// Chad, 2026-09-15, on the Manifest history panel:
//
//     2026-09-14   all on the board      728 orders · 3 reports
//     2026-09-13   all on the board       56 orders · 6 reports
//     2026-09-11   136 not routed yet    556 orders · 7 reports
//
// "why do these show not routed yet i think that is stale and it needs to be dynamic and self
// heal."
//
// HE IS RIGHT, AND THE MECHANISM IS EXACT — run, not reasoned (manifest-heal.test.mjs replays
// it). 2026-09-11 is a FRIDAY, so manifestWindow puts its expected delivery on MONDAY the 14th.
// The nightly pass read that manifest overnight Friday→Saturday, with `asOf` = 2026-09-12, and
// Monday's board did not exist yet:
//
//     asOf 2026-09-12 → unrouted → "136 orders not routed yet — 2026-09-14 has not come
//                                   round yet, so that board is still being built"
//
// That sentence was TRUE when it was written and nothing has re-asked since. manifest-history
// prefers the stored `latest.grade` verbatim, and its fallback re-derivation is no fresher: it
// feeds `boardCoverage` the same night's stop-count snapshot with `asOf` taken from the run's
// own stamp. Both roads lead back to Saturday morning.
//
// WHY THE ONE-LINE FIX IS A TRAP, and this is the thing worth knowing before touching it.
// Un-freezing `asOf` alone — re-grading with today's date but the STORED board snapshot — does
// not heal the row, it makes it lie in a new way:
//
//     asOf 2026-09-15, stored boards → unrouted → "136 orders not routed yet — no board has
//                                                  been built for 2026-09-14"
//
// and 2026-09-14 has 728 orders on it. A heal that does not re-read the BOARD is not a heal.
//
// WHAT THIS MODULE DOES INSTEAD. The archive already stores the suspects themselves
// (`latest.missing` — the off-board rows, each carrying its PRO), so the row can be re-asked
// for free: take those PROs, look them up in the stop index as it stands NOW, and re-grade.
// ZERO NuVizz calls and no PDF re-parse — Firestore reads only, and only for nights that could
// actually have changed.
//
// WHY RE-CHECKING THE STORED SUSPECTS IS THE RIGHT QUESTION, not merely the cheap one. The
// manifest check exists because "an order Uline handed us that NuVizz never received is
// invisible to every other check in this app" (manifest-check.mts). An order that reached the
// board and was later cancelled or reconsigned WAS received — that is a cancellation, not lost
// freight, and it is not what this row is for. So the suspects are exactly the set in question.
// Stated plainly because it IS a narrowing: a full re-diff would need the PDF back out of the
// blob store, and it would answer a question the row is not asking.
//
// IT CONVERGES, AND THAT IS DELIBERATE. A night healed clean is never re-read again — once an
// order has been seen on the board it was received, and no later board change can un-receive
// it. So the cost of this feature falls to zero as nights settle, instead of re-reading thirty
// nights on every page load.
//
// IT MUST NOT ONLY EVER GO GREEN. On the real 09-11 numbers the heal turns "136 not routed
// yet" into "2 orders on the manifest are not in the scan" — the stale amber was CONCEALING a
// genuine red, and a dispatcher who has learned to ignore "Monday hasn't happened" ignores the
// two orders that never arrived with it. Surfacing those is the operational point; the tidiness
// is not.
//
// MANIFEST_HISTORY_SELFHEAL=off puts the old frozen rows back — read, write and endpoint in one
// switch. House shape: default ON, an explicit off-word turns it off, anything malformed leaves
// it ON, because a typo in an env var must never silently disable a rule.
//
// PURE. No Firestore, no blobs, no clock — the caller supplies today, the board and the rows.

import { boardCoverage, gradeSuspects, gradeText, deliveryWindow } from '../../../src/lib/manifest-window.js';
import { boardProIndex, onBoard } from './manifest-reconcile.mts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The delivery-day span the nightly diff uses (Uline ships tonight for tomorrow; a deferred
 *  order lands the day after). Same 2 as manifest-run.mts and manifest-check.mts. */
export const HEAL_SPAN_DAYS = 2;

/**
 * HOW LONG A NIGHT KEEPS BEING RE-ASKED AFTER ITS LAST DELIVERY DAY.
 *
 * A heal is not free. A Firestore field mask trims the bytes on the wire but NOT the billed
 * read count, so re-asking one night costs one document read per stop on each of its window
 * days — for the 09-11 night, roughly 1,100. A night that heals CLEAN settles immediately and
 * is never read again, but one left holding a genuine miss would otherwise be re-asked every
 * day for ever: a slow leak that grows with every bad night on file.
 *
 * So the window closes. An order still not on the board three delivery days after the last day
 * it could have been delivered on is not going to appear — that is missing freight, and the row
 * should say so and stop spending reads to re-confirm it. Until then it keeps asking, because a
 * late re-route inside that tail is exactly the case a dispatcher would want picked up.
 */
export const HEAL_TAIL_DAYS = 3;

/**
 * THE HEAL'S SCHEMA VERSION — how a heal written by a BUILD WE NO LONGER TRUST gets thrown away.
 *
 * v1.30.0 shipped with every stale night's board PROs pooled into one index, so a night could
 * heal CLEAN off a day in another night's delivery window. Clean is terminal, so any such
 * record would have sat in Firestore being served for ever, and nothing would revisit it: the
 * feature's one genuinely unrecoverable failure mode, written by the feature itself.
 *
 * Bumping this is the repair. validHeal refuses a heal that does not carry the CURRENT version —
 * including every heal from v1.30.0, which carries none at all — so those are discarded and
 * recomputed correctly the next time the panel is opened. No migration to run, no rows to hunt
 * for, and the same mechanism is there for the next time a heal's meaning changes.
 */
export const HEAL_VERSION = 2;

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function healEnabled(env: any = process.env): boolean {
  const v = String(env?.MANIFEST_HISTORY_SELFHEAL ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** The suspect PROs a stored night can be re-asked with, and whether that list is the whole
 *  story. `missing` is capped at MAX_MISSING_ROWS while `missingCount` stays exact, so a night
 *  with more off-board rows than the cap can only ever be PARTIALLY healed — and must say so
 *  rather than reporting the remainder as resolved. */
export function storedSuspects(l: any): { pros: string[]; rows: any[]; capped: number } {
  const rows = Array.isArray(l?.missing) ? l.missing.filter((r: any) => r && String(r.pro ?? '').trim()) : [];
  const exact = Number(l?.missingCount);
  const total = Number.isFinite(exact) && exact > 0 ? exact : rows.length;
  return { pros: rows.map((r: any) => String(r.pro)), rows, capped: Math.max(0, total - rows.length) };
}

/**
 * PURE. Is this night worth re-asking, and if not, why not?
 *
 * Deliberately conservative — every gate here exists to avoid spending a read on a night whose
 * answer cannot have changed:
 *   • a night already reading clean has nothing to heal;
 *   • a night whose suspects were never stored cannot be re-asked at all (never invent one);
 *   • a night already healed CLEAN is settled for good (see the header — clean is terminal);
 *   • a night already healed TODAY is not re-read twice in one day;
 *   • and the day the verdict turns on must actually have come round, or we would be re-asking
 *     a board that is still being built and getting the same honest "not yet" back.
 */
export function needsHeal(l: any, today: string, prior: any = null): { heal: boolean; why: string } {
  if (!l || !DATE_RE.test(String(today ?? ''))) return { heal: false, why: 'no record' };
  const filedCount = Number(l.missingCount) || 0;
  if (prior && prior.stillOff === 0) return { heal: false, why: 'already healed clean — settled' };
  if (filedCount <= 0 && !prior) return { heal: false, why: 'filed clean' };
  const { pros } = storedSuspects(l);
  if (!pros.length) return { heal: false, why: 'no suspect PROs were stored for this night — it cannot be re-asked' };
  if (prior && String(prior.asOf || '') === today) return { heal: false, why: 'already re-asked today' };
  // THE WINDOW CLOSES (see HEAL_TAIL_DAYS). Only once an answer is already on file: a night
  // that has never been re-asked is always given its one read, however old, so a row filed
  // before this existed still heals the first time somebody opens the panel.
  if (prior) {
    const days = healDates(l);
    const last = days.length ? days[days.length - 1] : null;
    if (last && addDays(last, HEAL_TAIL_DAYS) < today) {
      return { heal: false, why: `settled — nothing has appeared since ${last}, and freight this far past its last delivery day is missing, not late` };
    }
  }
  // The day that DECIDES. A required delivery day still in the future is the honest "not yet"
  // the row already says; re-reading an unbuilt board would only reprint it.
  const expected = DATE_RE.test(String(l.expectedDelivery ?? '')) ? String(l.expectedDelivery) : null;
  if (expected && expected > today) return { heal: false, why: `${expected} has not come round yet` };
  return { heal: true, why: expected ? `${expected} has come round — ask the board again` : 'ask the board again' };
}

/**
 * PURE. The stored heal for a night, but ONLY if it still speaks for the manifest on file.
 *
 * The heal lives at the day document's TOP LEVEL, deliberately — not inside `latest`. Writing
 * it into `latest` would mean reading that object and writing it back whole, and the nightly
 * ingest owns `latest`: a report landing between the read and the write would be silently
 * clobbered. One field-masked write to its own key touches nothing the ingest owns.
 *
 * The cost of living outside `latest` is that the two can drift — a fifth report can arrive
 * after a heal and supersede the manifest it was computed against. `ofAt` is the guard: a heal
 * whose `ofAt` no longer matches `latest.at` is a heal of a document that has moved on, and is
 * discarded rather than shown against numbers it was never computed from.
 *
 * AND THE VERSION IS THE SECOND GUARD. A heal carrying anything but the current HEAL_VERSION was
 * written by a build whose answer we no longer trust — v1.30.0's pooled index could mark a night
 * clean off another night's board, and clean is terminal, so such a record would be served for
 * ever. Refusing it here is what makes that repairable: it is dropped and recomputed on the next
 * read, with nothing to migrate.
 */
export function validHeal(doc: any): any | null {
  const h = doc?.heal;
  const at = doc?.latest?.at;
  if (!h || typeof h !== 'object') return null;
  if (Number(h.v) !== HEAL_VERSION) return null;
  if (!at || String(h.ofAt ?? '') !== String(at)) return null;
  return h;
}

/** The delivery days to re-read for a night: its expected day plus the same slack the nightly
 *  diff allows. Falls back to the days the original run checked when no expected day was filed
 *  (nights archived before expectedDelivery was stored). */
export function healDates(l: any, span = HEAL_SPAN_DAYS): string[] {
  const expected = DATE_RE.test(String(l?.expectedDelivery ?? '')) ? String(l.expectedDelivery) : null;
  if (expected) return deliveryWindow(expected, span);
  const prior = Array.isArray(l?.checkedAgainst) ? l.checkedAgainst : [];
  return [...new Set(prior.map((d: any) => String(d?.date ?? '')).filter((d: string) => DATE_RE.test(d)))];
}

export interface HealResult {
  /** the schema version this heal was written by — see HEAL_VERSION and validHeal */
  v: number;
  at: string;
  /** the `latest.at` this heal was computed against — see validHeal */
  ofAt: string | null;
  asOf: string;
  /** what the board looked like on THIS read — not the night's snapshot */
  checkedAgainst: Array<{ date: string; stops: number }>;
  /** suspects re-asked, and how many are still not on the board */
  reAsked: number;
  stillOff: number;
  /** suspects the stored list could not carry (cap), counted as unresolved — never as resolved */
  unreadable: number;
  verdict: string;
  verdictText: string;
  /** what the row said when it was filed, kept so the screen can show it healed */
  filed: { verdict: string | null; missingCount: number };
}

/**
 * PURE. Re-grade one night against the board as it stands now.
 *
 * `isOnBoard` is injected (the caller owns the index built from the stop-index reads) so this
 * stays testable on plain data, and so one board read can serve every night that shares a day.
 *
 * THE CAPPED REMAINDER IS COUNTED AS STILL-OFF, never as healed. A night whose suspect list was
 * truncated at the archive's cap cannot prove those rows landed, and the safe direction is the
 * one that keeps a dispatcher looking — a false clean is the expensive mistake here, a false
 * amber only costs attention.
 */
export function healNight(
  l: any,
  opts: { isOnBoard: (pro: string) => boolean; boardDays: Array<{ date: string; stops: number }>; asOf: string; at: string },
): HealResult | null {
  if (!l || typeof opts?.isOnBoard !== 'function') return null;
  const { rows, capped } = storedSuspects(l);
  if (!rows.length) return null;
  const stillOffRows = rows.filter((r: any) => !opts.isOnBoard(String(r.pro)));
  // The capped remainder rides as unresolved suspects so the grade counts them.
  const suspects = [...stillOffRows, ...new Array(capped).fill({ pro: null, unreadable: true })];
  const required = DATE_RE.test(String(l?.expectedDelivery ?? '')) ? [String(l.expectedDelivery)] : null;
  const coverage = boardCoverage(opts.boardDays, required, opts.asOf);
  const grade = gradeSuspects(suspects, coverage);
  return {
    v: HEAL_VERSION,
    at: opts.at,
    ofAt: (l && l.at) ?? null,
    asOf: opts.asOf,
    checkedAgainst: opts.boardDays,
    reAsked: rows.length,
    stillOff: suspects.length,
    unreadable: capped,
    verdict: String(grade?.verdict || 'none'),
    verdictText: gradeText(grade, coverage),
    filed: { verdict: l?.grade?.verdict ?? null, missingCount: Number(l.missingCount) || 0 },
  };
}

/**
 * PURE. THE WHOLE HEAL PASS, so the decision does not live in a handler no test can reach.
 *
 * This function exists because of a bug that got this far: the endpoint pooled every stale
 * night's board PROs into ONE index and handed it to all of them, so a 2026-09-04 manifest's
 * missing order was found on the 2026-09-15 board — a day in a LATER night's window, not its
 * own — and healed CLEAN. The same night got a different answer depending on which other
 * nights happened to share the request, and because clean is terminal that false clean would
 * never have been re-asked: genuinely missing freight, marked resolved, for good.
 *
 * It was invisible to the unit tests because every one of them tested the pure module, and the
 * pooling was in the endpoint. CLAUDE.md names exactly this: "Pure core, thin edges. Every
 * non-trivial decision in this repo that shipped broken shipped inside a handler nobody could
 * unit-test." So the decision moved here, where `healPass` is one call with plain data in and
 * plain data out, and the endpoint is left doing IO only.
 *
 * THE INVARIANT IT EXISTS TO HOLD: a night is graded against ITS OWN delivery window and
 * nothing else, so re-asking it alone and re-asking it beside thirty others give the identical
 * answer. Reads are still shared by the caller — one per distinct day — because sharing the
 * READ is free and sharing the LOOKUP is the bug.
 *
 * `prosByDate` carries only days that were actually READ. A day absent from it is a board we
 * could not open, which is not the same as an empty one: that night is skipped and said so,
 * never graded against a board nobody looked at.
 */
export function healPass(
  candidates: Array<{ date: string; l: any }>,
  opts: { prosByDate: Map<string, string[]>; stopsByDate: Map<string, number>; asOf: string; at: string },
): { healed: Array<{ date: string; heal: HealResult }>; skipped: Array<{ date: string; why: string }> } {
  const healed: Array<{ date: string; heal: HealResult }> = [];
  const skipped: Array<{ date: string; why: string }> = [];
  for (const c of (candidates || [])) {
    if (!c || !c.l) continue;
    const days = healDates(c.l);
    if (!days.length) { skipped.push({ date: c.date, why: 'no delivery window on file for this night — it cannot be re-asked' }); continue; }
    if (days.some((d) => !opts.stopsByDate.has(d))) {
      skipped.push({ date: c.date, why: 'a board for one of its delivery days could not be read — left as filed' });
      continue;
    }
    // THIS NIGHT'S OWN WINDOW, AND NOTHING ELSE. See the header.
    const index = boardProIndex(days.flatMap((d) => opts.prosByDate.get(d) || []));
    const h = healNight(c.l, {
      isOnBoard: (pro) => onBoard(index, pro),
      boardDays: days.map((d) => ({ date: d, stops: opts.stopsByDate.get(d) as number })),
      asOf: opts.asOf, at: opts.at,
    });
    if (!h) { skipped.push({ date: c.date, why: 'no suspect PROs stored — cannot be re-asked' }); continue; }
    healed.push({ date: c.date, heal: h });
  }
  return { healed, skipped };
}
