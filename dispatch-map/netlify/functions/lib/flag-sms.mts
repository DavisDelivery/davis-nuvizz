import { flattenForConsumers } from './flag-rows.mts';
// The words the dispatcher actually ticked, from the module the map and the flag engine
// both read. A text that renamed the restriction would be quoting a mark nobody set.
import { trailerBlockerLabels } from '../../../src/lib/trailer-block.js';
// lib/flag-sms.mts
//
// THE EVENING FLAG TEXT — pure rules for who gets texted, about which board, saying what.
//
// Chad: "Flags need to show up on tomorrow's board for deliveries tomorrow soon as we
// start routing at 8pm tonight — shouldn't wait until 7. Trying to catch the clearly
// obvious problems or critical ones sooner." And: "Stop flag texts to Zach by 6am —
// after that he's no longer routing, so don't send him any more texts."
//
// The engine already judges any date; what never existed was a server pass outside
// 7:00a-7:40p and a channel that reaches a phone at 9pm. This module holds the pure
// decisions so the sweep stays a thin edge and every rule here is unit-tested:
//
//   * WHICH BOARD an evening/overnight sweep judges (8p-11p ET -> tomorrow's; after
//     midnight -> today's — the same board, crossing the date line).
//   * WHO is texted: FLAG_SMS_TO always; FLAG_SMS_TO_NIGHT (the router on duty) only
//     while routing is on — Zach's line goes quiet AT 6:00a ET sharp.
//   * WHAT the text says: facts in one breath — customer, stop position, estimated
//     arrival vs close, board date — nothing a phone screen truncates into mystery.
//
// AND, SINCE v0.82.0, A SECOND THING WORTH A PHONE AT 9PM. Chad: "stops we have put on a
// tractor that have been hardcoded as no tractor trailer by a dispatcher. Not the Uline
// advisory ones that we pick up automatically just the dispatcher hardcoded ones."
//
// That is board-flags R7 (`trailer_conflict`), and it is a different KIND of news from the
// hours rows beside it. An hours row is a prediction against a clock that the day can still
// make false; a trailer conflict is two recorded facts in contradiction — a human wrote "no
// tractor trailer" on this location and the load runs a tractor — so it has no ETA, nothing
// to be late about, and no reason to wait for a clock. It is knowable the moment the stop
// lands on the load, which is precisely the window this sweep runs in and precisely when the
// fix is still free: move the stop, or put a different truck on the route.
//
// Three rules keep it from becoming noise, and each one is a decision about the phone rather
// than about the board:
//   * ONE TEXT PER ROUTE, not per stop. Six box-only stops on one tractor load is ONE
//     problem — the wrong truck — and six texts would bury that instead of saying it. The
//     row carries the count and the text names it.
//   * ITS OWN SLICE OF THE PER-SWEEP CAP (TRAILER_SMS_CAP), so a bad night of either kind
//     cannot starve the other. Unused budget backfills, so the total is still SMS_PER_SWEEP_CAP.
//   * ITS OWN CLAIM KEY. The claim was keyed on the stop alone; a stop that is both late AND
//     on the wrong truck would have sent one message and silently swallowed the other.
//
// Recipients live in ENV (FLAG_SMS_TO / FLAG_SMS_TO_NIGHT, comma-separated), never in
// code: phone numbers are personal data and rosters change without a deploy.

export const NIGHT_CUTOFF_MIN = 6 * 60;    // 6:00a ET — the router is done routing
export const EVENING_START_HOUR = 19;      // ET hour from which a sweep aims at TOMORROW
export const SMS_PER_SWEEP_CAP = 8;        // worst-first; the rest wait for the next pass
// The slice of that cap trailer conflicts may take. Not a budget for how much trouble is
// allowed — a reservation, so neither kind of news can silence the other on the night both
// go wrong. Unused budget on either side backfills the other, so a quiet trailer night
// still texts eight hours rows, exactly as it did before this existed.
export const TRAILER_SMS_CAP = 4;
export const CLAIM_COLLECTION = 'eta_flag_sms';

const splitList = (v: any): string[] =>
  String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * PURE. Who gets this sweep's texts, given the ET minutes-past-midnight of the sweep.
 * The always-list rides every sweep; the night list (the router building loads) rides
 * only from the evening start THROUGH 5:59a — at 6:00a exactly it is dropped, per Chad.
 */
export function smsRecipients(env: any, etMin: number): string[] {
  const always = splitList(env?.FLAG_SMS_TO);
  const night = splitList(env?.FLAG_SMS_TO_NIGHT);
  const routing = etMin >= EVENING_START_HOUR * 60 || etMin < NIGHT_CUTOFF_MIN;
  const out = [...always, ...(routing ? night : [])];
  return [...new Set(out)];
}

/**
 * PURE. Which board date an evening/overnight sweep judges, given ET now.
 * From EVENING_START_HOUR onward the routers are building TOMORROW; after midnight the
 * same board has become TODAY. Outside both windows (the live day sweep's territory)
 * the answer is null — this sweep stands down rather than double-alerting.
 */
export function eveningTargetDate(etDate: string, etMin: number): { date: string; offsetDays: number } | null {
  if (etMin >= EVENING_START_HOUR * 60) {
    const d = new Date(`${etDate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return { date: d.toISOString().slice(0, 10), offsetDays: 1 };
  }
  if (etMin < NIGHT_CUTOFF_MIN + 60) return { date: etDate, offsetDays: 0 }; // through 6:59a, before the 7:00a day sweep
  return null;
}

const fmtMin = (m: any): string => {
  if (!Number.isFinite(m)) return '?';
  const mm = ((Math.round(m) % 1440) + 1440) % 1440;
  const h12 = ((Math.floor(mm / 60) + 11) % 12) + 1;
  const ap = mm < 720 ? 'a' : 'p';
  return `${h12}:${String(mm % 60).padStart(2, '0')}${ap}`;
};

/**
 * PURE. One flag as one text. Facts only, one breath — and it always names the board
 * day, because a 9pm text about "tomorrow" and a 5am text about "today" are the same
 * board and must not read like two different problems.
 *
 * TWO KINDS OF NEWS, TWO SENTENCES, and the difference is not cosmetic. An hours text is
 * about a CLOCK — an estimate against a close, which is why it leads with the customer and
 * carries the two times. A trailer text is about a TRUCK, so it leads with the ROUTE: the
 * fix is on the load, not on the stop, and six conflicting stops on one tractor is one
 * problem with one answer. Sending the trailer news in the hours wording would have printed
 * "est ?:?? vs close ?:??" — the two facts it does not have — which is how a message ends up
 * looking broken while being perfectly correct about something else.
 */
export function smsText(row: any, boardDate: string): string {
  if (String(row?.rule) === 'trailer_conflict') return trailerSmsText(row, boardDate);
  const cust = String(row?.customer || row?.stopNbr || 'stop');
  const route = String(row?.routeName || '').trim();
  const late = Number.isFinite(row?.lateBy) ? ` (~${row.lateBy}m past close)` : '';
  const eta = `est ${fmtMin(row?.etaMin)} vs close ${fmtMin(row?.closeMin)}`;
  return `DDS flag ${boardDate}: ${cust}${route ? ` on ${route}` : ''} — ${eta}${late}. Auto-alert, reply to Davis dispatch.`;
}

/**
 * PURE. The no-trailer text. Route first, because the route is what gets changed.
 *
 * It QUOTES the mark rather than summarising it — "marked No tractor trailer" is the label
 * off the dispatcher's own dropdown, so whoever reads the text at 9pm can go to the stop card
 * and find the words they are looking at. And it never says "dispatcher-set" about a mark it
 * cannot name: `blockedVia` says which of the two statements fired, and an eligibility paint
 * with no restriction ticks beside it is described as the paint it is.
 */
function trailerSmsText(row: any, boardDate: string): string {
  // The NAME, not the identity. routeKey (a load number, usually) is what this row is
  // grouped and claimed on; it is not what a router calls the route when they go to fix it.
  const route = String(row?.routeName || row?.routeKey || '').trim();
  const cust = String(row?.customer || row?.stopNbr || 'a stop');
  const labels = trailerBlockerLabels(row?.blockers);
  const said = String(row?.blockedVia) === 'eligibility'
    ? 'painted box-truck only by dispatch'
    : labels.length ? `marked ${labels.join(', ')} by dispatch` : 'marked no-tractor-trailer by dispatch';
  // The count is the whole point on a route with several: one is "move the stop", four is
  // "the wrong truck is on this load". Never printed as "+0 more" — an extra clause that
  // says nothing is the kind of thing that trains people to stop reading the message.
  const others = Math.max(0, (Number(row?.routeConflicts) || 1) - 1);
  const more = others > 0 ? ` +${others} more stop${others === 1 ? '' : 's'} on this route.` : '';
  return `DDS no-trailer ${boardDate}: ${route || 'a load'} runs a tractor-trailer — ${cust} is ${said}.${more} Move it or swap the truck. Auto-alert, reply to Davis dispatch.`;
}

/**
 * PURE. The claim key: one text per stop per board day, shared across every sweep.
 *
 * RULE-SCOPED, AND THE HOURS KEY IS DELIBERATELY UNCHANGED. A stop can be both late AND on a
 * truck that cannot reach it, and those are two different messages with two different fixes;
 * keyed on the stop alone the first one sent would have silently swallowed the second. The
 * hours rule keeps the bare key so every claim already written tonight still counts and
 * shipping this cannot re-text this evening's board.
 *
 * A TRAILER CONFLICT CLAIMS THE ROUTE, NOT THE STOP, because that is the grain the text is
 * sent at — one message per tractor load per board day. Keyed on the stop it would have
 * nagged: fix one of four box-only stops and the next sweep texts about the second.
 * The route name is made path-safe (a co-driver load is spelled "COLIN/DJ 1" and a slash in
 * a Firestore doc id is a path segment, not a character — the trap v0.50.8 was spent on).
 */
export function smsClaimPath(tenant: string, date: string, stopNbr: string, rule = 'hours_risk'): string {
  if (String(rule) === 'trailer_conflict') {
    const safe = String(stopNbr).replace(/[^A-Za-z0-9_.-]/g, '_') || '_';
    return `${CLAIM_COLLECTION}/${tenant}__${date}__route_${safe}__trailer`;
  }
  return `${CLAIM_COLLECTION}/${tenant}__${date}__${String(stopNbr)}`;
}

/**
 * PURE. Which rows an evening sweep may text, and in what order.
 *
 * TWO POPULATIONS, ONE CAP.
 *
 * hours_risk — red and critical occurrences with a real close ("clearly obvious problems or
 *   critical ones", not ambers), worst-late first.
 *
 *   THIS BAR IS DELIBERATELY ITS OWN, AND AS OF 2026-09-02 IT IS NO LONGER THE EMAIL BAR.
 *   Chad narrowed the customer-service email to critical alone ("I don't want a 100 Emails.
 *   We are only emailing on critical" — flag-alert.mts ALERT_MIN_TIER) and this line
 *   intentionally did not move with it, because the two channels buy different things. The
 *   email asks a rep to phone a dock about a delivery that is going to be late; there is
 *   nothing to phone about until it is confidently late. The text reaches the ROUTER at a
 *   board at 9pm, while the load can still be rebuilt — a red he can move tonight is worth a
 *   text and is not worth a phone call tomorrow. Narrowing this too would have been widening
 *   Chad's instruction, so it reads its own predicate and imports nothing from the email
 *   path.
 *
 * trailer_conflict — red occurrences, ONE PER ROUTE, worst route (most conflicting stops)
 *   first. No close is required and none exists: this row is not a prediction against a
 *   clock, and requiring the hours rule's `closeMin` would have filtered every one of them
 *   out on a condition that has nothing to do with them.
 *
 * The cap is shared but not first-come: trailer conflicts hold a reservation
 * (TRAILER_SMS_CAP) and hours rows take the rest, with either side backfilling budget the
 * other did not use. Without that, a 13-stop late night silences every trailer text and a
 * badly-trucked route silences every late one — and both failures are invisible, because a
 * capped list looks exactly like a quiet one.
 */
export function selectTextable(rows: any[], cap = SMS_PER_SWEEP_CAP, trailerCap = TRAILER_SMS_CAP): any[] {
  // Same un-collapse as the email path: on a capped board this selector saw one summary row
  // with no stopNbr and texted nobody, on exactly the night the board was worst.
  const flat = flattenForConsumers(rows);
  const urgent = (r: any) => r?.tier === 'critical' || r?.tier === 'red';
  const textable = (r: any) => urgent(r) && r?.scope === 'occurrence' && r?.stopNbr != null;

  const hours = flat.filter((r: any) => r?.rule === 'hours_risk' && textable(r) && Number.isFinite(r?.closeMin));
  // `??` does not protect from NaN: `undefined ?? 0` is 0 but `NaN ?? 0` is NaN, and a NaN
  // comparator makes the whole ordering undefined — so at the 8-per-sweep cap the texts that
  // got dropped were chosen arbitrarily rather than by how late they were.
  const worst = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : -Infinity);
  hours.sort((a: any, b: any) => worst(b?.lateBy) - worst(a?.lateBy));

  // ONE ROW PER ROUTE. The first row of a route is kept and the rest are dropped from the
  // TEXT only — every one of them is still on the board, and the kept row carries the count.
  const trailer: any[] = [];
  const seenRoute = new Set<string>();
  for (const r of flat) {
    if (r?.rule !== 'trailer_conflict' || !textable(r)) continue;
    const k = String(r?.routeKey || r?.routeName || '').trim();
    if (!k || seenRoute.has(k)) continue;
    seenRoute.add(k);
    trailer.push(r);
  }
  // Worst route first, then by name so the order is stable rather than feed-order — a cap
  // that drops an arbitrary route is a cap nobody can reason about.
  trailer.sort((a: any, b: any) => (worst(b?.routeConflicts) - worst(a?.routeConflicts))
    || String(a?.routeKey || a?.routeName || '').localeCompare(String(b?.routeKey || b?.routeName || '')));

  const total = Math.max(0, cap);
  const reserved = Math.min(trailer.length, Math.max(0, trailerCap));
  const takeHours = Math.max(0, Math.min(hours.length, total - reserved));
  const takeTrailer = Math.max(0, Math.min(trailer.length, total - takeHours));
  // Trailer first in the returned order: it is the certain one, and on a night the sender
  // dies half way through the list, the message that survives should be the one whose
  // failure mode is a truck that physically cannot make the delivery.
  return [...trailer.slice(0, takeTrailer), ...hours.slice(0, takeHours)];
}
