// src/lib/closed-days.js — "CLOSED ON MONDAYS" IS READ FROM THE ORDER, EVERY TIME.
//
// Chad, 2026-09-28: "the closed on Fridays and closed on Mondays. I want those to be read live
// every time an order comes in. and not stored because we had a situation where a delivery today
// was marked closed on Mondays, but the new orders do not signify that. And therefore we did not
// deliver it because our system stored the closed on Mondays instead of reading it every time the
// order comes in and it's enriched."
//
// THE CASE, from our own records (zero NuVizz calls): SANTA FE TORTILLAS, 4234 JONESBORO RD STE L,
// FOREST PARK. The June 19 order (007135975) said "SPL-INSTR-TEXT: CLOSED ON MONDAYS". The Aug 10
// order (007159306) and today's (007182580, Monday 2026-09-28) say only "RECEIVING HOURS … / DO NOT
// BREAKDOWN SKID". The text scanner had written `closed_days: ['mon']` onto the CUSTOMER in June,
// customer-notes-writer only ever ADDS days, and every reader asked the customer, not the order —
// so a Monday delivery the customer never refused was treated as a closed dock.
//
// THE RULE NOW. Whether a stop is closed on its delivery day comes from two places, and only two:
//   1. what THIS order says — its own instruction text and address line, parsed by the same
//      scanner (signal-scanner.ts scanClosedDays) on every read, never stored; and
//   2. a closed day a DISPATCHER typed into the customer's notes — a person at Davis deciding it,
//      which is not an order's word and does not expire with one.
// A closed day the text scanner stored on the customer from some earlier order is IGNORED.
//
// THE WAY BACK, both sides at once: CLOSED_DAYS_FROM_ORDER=off (server) or
// VITE_CLOSED_DAYS_FROM_ORDER=off (the bundle) puts back the stored-day behaviour everywhere this
// is read, and the scanner goes back to storing them. Read on both sides for the same reason as
// HOURS_PM_SHIFT (daytime-window.js): the route build runs on the server and the flags run in the
// browser, and a switch that reverted only one of them would leave the two disagreeing about the
// same dock.
import { scanClosedDays } from './signal-scanner.ts';

const OFF_WORDS = new Set(['off', '0', 'false', 'no']);

/** House shape: default ON, an explicit off-word turns it off, anything malformed leaves it ON. */
export function closedDaysFromOrderEnabled(env) {
  let raw = env;
  if (!raw) {
    const bag = {};
    try { Object.assign(bag, import.meta.env ?? {}); } catch { /* not a Vite bundle */ }
    try { Object.assign(bag, typeof process !== 'undefined' ? process.env ?? {} : {}); } catch { /* not Node */ }
    raw = bag;
  }
  for (const k of ['CLOSED_DAYS_FROM_ORDER', 'VITE_CLOSED_DAYS_FROM_ORDER']) {
    if (OFF_WORDS.has(String(raw?.[k] ?? '').trim().toLowerCase())) return false;
  }
  return true;
}

/**
 * PURE. The days THIS order says the customer is closed, read from its own text right now.
 *
 * The instruction text is the LIVE list field (`orderInstructions`, refreshed from NuVizz every
 * scan), falling back to the enrichment copy only when the list carried none. The address line is
 * read too — Davis types dock notes there, and the scanner has always read both.
 *
 * @param row a board row
 * @returns {{ day: string, text: string, source: string }[]}
 */
export function orderClosedDays(row) {
  if (!row) return [];
  const ss = row.signalSources || {};
  const orderText = (typeof row.orderInstructions === 'string' && row.orderInstructions.trim())
    ? row.orderInstructions
    : (ss.orderInstructions ?? null);
  const addrText = ss.addressLine2 ?? row.addr2 ?? null;
  const out = [];
  const seen = new Set();
  for (const r of [...scanClosedDays(addrText, 'addressLine2'), ...scanClosedDays(orderText, 'orderInstructions')]) {
    if (seen.has(r.day)) continue;
    seen.add(r.day);
    out.push({ day: r.day, text: r.matchedText, source: r.matchedSource });
  }
  return out;
}

/**
 * PURE. Did a DISPATCHER record this day closed on the customer? The same provenance test
 * board-flags has always used for "typed": a person edited the closed days, and the text scanner
 * did not set this one.
 */
export function typedClosedDay(note, dayKey) {
  if (!note || !dayKey) return false;
  const days = Array.isArray(note.closed_days) ? note.closed_days : [];
  if (!days.includes(dayKey)) return false;
  const prints = note.auto_matches?.closed_days || [];
  const scannerSetThisDay = prints.some((p) => String(p?.pattern ?? '') === `closed_${dayKey}`);
  return note.manual_overrides?.closed_days === true && !scannerSetThisDay;
}

// ── THE NOTES EDITOR ─────────────────────────────────────────────────────────
//
// The one lever left for a customer that really is shut on a weekday is a dispatcher typing it
// (App.jsx StopNotesEditor, shared by the Map and Stop lookup). Two traps would have broken it:
//   • a day the scanner stored from an old order is still in `closed_days`, so the editor showed it
//     ticked — "closed Monday" on the form while the board routes the stop;
//   • ticking that day again was a toggle OFF (it was already in the list), and even re-ticked, the
//     scanner's fingerprint (auto_matches.closed_days) would keep reading it as the scanner's, never
//     the dispatcher's — a closed day a person ticked, silently ignored.
// So the editor shows a day ticked only when it is IN EFFECT, and ticking a day makes it the
// dispatcher's by dropping the scanner's fingerprint for it. Switch off → exactly the old editor.

/** PURE. Is `day` ticked in the editor — i.e. does it count? */
export function editorClosedDay(note, day, env = undefined) {
  if (!closedDaysFromOrderEnabled(env)) return Array.isArray(note?.closed_days) && note.closed_days.includes(day);
  return typedClosedDay(note, day);
}

/** PURE. `{ auto_matches }` with the scanner's fingerprints for `days` removed, or {} if none. */
export function dropClosedPrints(note, days) {
  const prints = note?.auto_matches?.closed_days;
  if (!Array.isArray(prints) || !prints.length) return {};
  const drop = new Set((days || []).map((d) => `closed_${d}`));
  const kept = prints.filter((p) => !drop.has(String(p?.pattern ?? '')));
  if (kept.length === prints.length) return {};
  return { auto_matches: { ...(note.auto_matches || {}), closed_days: kept } };
}

/** PURE. The patch one tick on a weekday button writes. */
export function toggleClosedPatch(note, day, env = undefined) {
  const current = Array.isArray(note?.closed_days) ? note.closed_days : [];
  const manual_overrides = { ...(note?.manual_overrides || {}), closed_days: true };
  if (!closedDaysFromOrderEnabled(env)) {
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
    return { closed_days: next, manual_overrides };
  }
  const next = editorClosedDay(note, day, env)
    ? current.filter((d) => d !== day)
    : (current.includes(day) ? [...current] : [...current, day]);
  return { closed_days: next, manual_overrides, ...dropClosedPrints(note, [day]) };
}

/** PURE. Days still stored on the customer that no longer count — the scanner's, from old orders. */
export function unusedStoredClosedDays(note, env = undefined) {
  if (!closedDaysFromOrderEnabled(env)) return [];
  const days = Array.isArray(note?.closed_days) ? note.closed_days : [];
  return days.filter((d) => !typedClosedDay(note, d));
}
