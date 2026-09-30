// lib/att-timeline.mts — WHO WAS ASSIGNED THE ORDER ON THE DAY IT WAS DUE, READ OFF ITS NuVizz
// ACTIVITY TIMELINE (v1.99.6). PURE: no Firestore, no NuVizz — it reads events it is handed.
//
// Chad, 2026-09-30: "I want the driver it was assigned to on day it should have delivered not the
// driver that delivered it the next day late."
//
// This is the backfill's rule, for attempts written before v1.99.0 recorded who had each stop all day
// (lib/att-holder.mts). For those days nothing in Firestore holds the answer: the live index row was
// re-written by the redelivery, the nightly sealed copy was taken after customer service unplanned it
// (driver blank), and the 8:30 freeze skipped routes that had no driver yet. The stop's own timeline
// still has it, one NuVizz call per stop.
//
// THE RULE, checked by hand on five real timelines (2026-09-30) before it was written down:
//   1. Keep only events on the DUE DAY (the attempt's board day). Everything after it is the
//      redelivery — 007180345 was dispatched to Christopher Garrett on 9/23 and to Joe Gibbs on 9/24;
//      the answer is Garrett.
//   2. The assignment is the Davis driver on the "Stop Dispatched" event. A planner's Stop Planned /
//      Unplanned (the 3–4 AM shuffle on 007181840) is not an assignment and is never read as one.
//   3. The window closes at the first "Stop Unplanned" AFTER the first dispatch that day — that is
//      customer service pulling the failed order. A re-dispatch after it is the next driver, not the
//      one who had it when it failed.
//   4. The last dispatch inside that window is the answer. No dispatch that day → the last Davis
//      driver event (pickup, arrival, departure, exception) inside it. Nothing at all → no answer,
//      and none is invented.
// `atCustomer` says whether that driver recorded a Stop Arrival at the customer that day. In the
// five-stop test only one of the five had one: the order was on the truck, the door was never
// reached. That is worth knowing before an "attempt" is charged as one.
//
// TIMES. NuVizz returns "9/25/26 12:43 PM". It is read as the portal's own clock and only its
// calendar day is used; every dispatch in the five-stop test fell between 9 AM and 4 PM, far from
// either midnight.

import { driverKeyFor } from './history-derive.mts';

export interface TimelineEvent { name?: string | null; code?: string | null; dttm?: string | null; user?: string | null; company?: string | null }

export interface DueDayAnswer {
  driver: string;            // the NuVizz user name, exactly as the timeline carries it
  basis: 'dispatched' | 'driver-event';
  dispatchedAt: string;      // YYYY-MM-DDTHH:MM of the event the answer came from
  atCustomer: boolean;       // a Stop Arrival by that driver on the due day, inside the window
  unplannedAt: string | null;
  laterDrivers: string[];    // dispatched on a LATER day — the redelivery, never the answer
}

/** "9/25/26 12:43 PM" → "2026-09-25T12:43". Null when it is not that shape. */
export function eventStamp(dttm: any): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(String(dttm ?? '').trim());
  if (!m) return null;
  let h = Number(m[4]);
  const ap = (m[6] || '').toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
  const p = (n: any) => String(n).padStart(2, '0');
  return `${yr}-${p(m[1])}-${p(m[2])}T${p(h)}:${m[5]}`;
}

const clean = (s: any) => String(s ?? '').replace(/\s+/g, ' ').trim();
const isDavis = (e: TimelineEvent) => /davis/i.test(String(e.company ?? ''));
const isDispatch = (e: TimelineEvent) => /^stop dispatched$/i.test(clean(e.name));
const isUnplan = (e: TimelineEvent) => /^stop unplanned$/i.test(clean(e.name));
// Events only a driver produces, out on the road. Planning, unplanning, creating and updating are
// dispatcher and customer-service actions and are deliberately absent.
const DROVE_IT = /(arrival|depart|confirmation|dispatched|delivered|delivery|pod|signature|exception)/i;

/**
 * PURE. The driver assigned the order on `dueDate` (YYYY-MM-DD), from its timeline. Null when the
 * timeline shows no Davis driver on it that day — the caller leaves the attempt unattributed.
 */
export function dueDayDriver(events: TimelineEvent[] | null | undefined, dueDate: string): DueDayAnswer | null {
  const stamped = (events || [])
    .map((e) => ({ e, at: eventStamp(e?.dttm) }))
    .filter((x): x is { e: TimelineEvent; at: string } => !!x.at)
    .sort((a, b) => a.at.localeCompare(b.at));
  const day = stamped.filter((x) => x.at.startsWith(`${dueDate}T`));
  const firstDispatch = day.find((x) => isDispatch(x.e) && isDavis(x.e) && clean(x.e.user));
  const unplan = firstDispatch ? day.find((x) => isUnplan(x.e) && x.at >= firstDispatch.at) : undefined;
  const inWindow = day.filter((x) => !unplan || x.at <= unplan.at);
  const dispatches = inWindow.filter((x) => isDispatch(x.e) && isDavis(x.e) && clean(x.e.user));
  const driven = inWindow.filter((x) => DROVE_IT.test(clean(x.e.name)) && isDavis(x.e) && clean(x.e.user));
  const pick = dispatches.length ? dispatches[dispatches.length - 1] : driven[driven.length - 1];
  if (!pick) return null;
  // Ends trimmed, inner spacing kept: NuVizz's own names carry double spaces ("Christopher  Garrett")
  // and the 8:30 freeze stores them that way, so the two must read identically.
  const driver = String(pick.e.user).trim();
  const later = stamped
    .filter((x) => x.at.slice(0, 10) > dueDate && isDispatch(x.e) && isDavis(x.e) && clean(x.e.user))
    .map((x) => clean(x.e.user));
  return {
    driver,
    basis: dispatches.length ? 'dispatched' : 'driver-event',
    dispatchedAt: pick.at,
    atCustomer: inWindow.some((x) => /^stop arrival$/i.test(clean(x.e.name)) && clean(x.e.user) === clean(driver)),
    unplannedAt: unplan ? unplan.at : null,
    laterDrivers: [...new Set(later)],
  };
}

// ── the backfill's plan and its write, PURE ──────────────────────────────────

/** "007174789-1" → "007174789". */
export const originalOf = (stopNbr: any): string => String(stopNbr ?? '').trim().replace(/-\d+$/, '');

export interface BackfillGroup { date: string; original: string; rows: string[] }

/**
 * PURE. Which attempts the backfill looks up: rows the evening join left without a driver and no
 * earlier backfill has already read (`timelineCheckedAt`). An original stop and its "-N" copies on
 * the same day are ONE group — one timeline read answers all of them, because the copy's failure is
 * the original's. Oldest day first, so a run that stops early leaves a clean line behind it.
 */
export function backfillGroups(days: Array<{ date: string; items: any[] }>, opts: { recheck?: boolean } = {}): BackfillGroup[] {
  const groups = new Map<string, BackfillGroup>();
  for (const { date, items } of [...(days || [])].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const it of items || []) {
      if (!it?.stopNbr || it.matched) continue;
      if (it.timelineCheckedAt && !opts.recheck) continue;
      const original = originalOf(it.stopNbr);
      const key = `${date}|${original}`;
      if (!groups.has(key)) groups.set(key, { date, original, rows: [] });
      groups.get(key)!.rows.push(String(it.stopNbr));
    }
  }
  return [...groups.values()];
}

/**
 * PURE. The field-masked write for one attempts row. With an answer: the driver, `matched`, and
 * where it came from (`attributedFrom: 'timeline'`, never mistaken for the 8:30 freeze). Without
 * one: only that the timeline was read and held nobody, so the next run does not spend a call on
 * it again. The row's route and load are left alone — every event on a timeline carries the stop's
 * CURRENT route (the redelivery's), so the timeline cannot say which route it was on that day.
 */
export function attributionPatch(answer: DueDayAnswer | null, via: 'stop' | 'original', lookedUpAt: string): Record<string, any> {
  if (!answer) {
    return { timelineCheckedAt: lookedUpAt, timeline: { answer: null, reason: 'no Davis driver on the due day', via, lookedUpAt } };
  }
  return {
    originalDriverName: answer.driver,
    originalDriverUserName: answer.driver,
    originalDriverKey: driverKeyFor({ driverUserName: answer.driver } as any),
    matched: true,
    attributedFrom: 'timeline',
    timelineCheckedAt: lookedUpAt,
    timeline: {
      answer: answer.driver, basis: answer.basis, dispatchedAt: answer.dispatchedAt,
      atCustomer: answer.atCustomer, unplannedAt: answer.unplannedAt, laterDrivers: answer.laterDrivers,
      via, lookedUpAt,
    },
  };
}
