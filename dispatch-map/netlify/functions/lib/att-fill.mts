// lib/att-fill.mts — THE NIGHTLY SAFETY NET FOR ATTEMPTS STILL WITHOUT A DRIVER (v1.104.0).
// PURE: no Firestore, no NuVizz. The job that runs it is nuvizz-att-fill-background.mts.
//
// Chad, 2026-10-01, approving it: "I'm ok with this but you better triple check there is no way it
// could make more than 10 calls and if it needs more it should throw a flag in the ui on the
// scorecard."
//
// WHAT IT DOES. After the evening attempts scans are done, it reads the NuVizz activity timeline of
// each ORIGINAL attempt the evening join still left without a driver (the 8:30 freeze and the day's
// all-day record both had nothing), applies the due-day rule (lib/att-timeline.mts) and writes the
// answer. "-1"/"-2" duplicates are never read (Chad: "duplicate orders … nothing to do with the
// original driver"). Anything it could not read is listed in the day's manifest as `fill.left`, which
// the scorecard shows as a flag.
//
// THE 10-CALL BOUND — every way a run could spend more, and what closes it:
//   • Retries. The shared requester retries 429/5xx up to 4 times and a timeout once, and the
//     timeline fetch falls back to a second endpoint when the first fails — one "lookup" could be
//     10 calls on a bad night. The fill uses fetchStopEventsOnce: ONE request, maxRetries 0 (which
//     also refuses the timeout retry), no fallback. Pinned by test/att-fill.test.mjs against the
//     requester itself.
//   • A lookup that needs the stop's id first (/stop/info). Only stops whose stopId is already in
//     Firestore are read; one without is left, and listed.
//   • The count. Requests are counted BEFORE they are sent, so one that times out (never answered,
//     never on the shared counter) still uses up the budget. The plan never holds more than the cap,
//     and the loop checks the count again before every request.
//   • The cap itself. FILL_MAX_CALLS = 10 is a constant. NUVIZZ_ATT_TIMELINE_FILL_MAX can only LOWER
//     it; anything malformed, zero or higher leaves 10.
//   • Running twice. The job claims att_fill/{tenant}__{date} with an atomic create BEFORE its first
//     request. A second cron fire, a platform retry or anything else finds the claim and spends 0.
//   • Other dates. It takes no ?date=: it only ever reads ET-yesterday, and a cron'd function is not
//     reachable over plain HTTP in this app. So: at most 10 requests per calendar day, total.
//
// NUVIZZ_ATT_TIMELINE_FILL=off turns it off (house shape: off-words only; a typo leaves it ON).
import { isCopy } from './att-timeline.mts';

export const FILL_MAX_CALLS = 10;

export function attFillEnabled(env: Record<string, any> = process.env): boolean {
  return !['off', '0', 'false', 'no'].includes(String(env.NUVIZZ_ATT_TIMELINE_FILL ?? '').trim().toLowerCase());
}

/** The cap for this run: 10, or LOWER when NUVIZZ_ATT_TIMELINE_FILL_MAX says so. Never higher. */
export function fillMaxCalls(env: Record<string, any> = process.env): number {
  const n = Number(String(env.NUVIZZ_ATT_TIMELINE_FILL_MAX ?? '').trim());
  return Number.isInteger(n) && n >= 1 && n < FILL_MAX_CALLS ? n : FILL_MAX_CALLS;
}

/** ET calendar parts of an instant. */
function etParts(now: Date): { date: string; hour: number } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => f.find((p) => p.type === t)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/**
 * PURE. Whether this fire acts, and on which day. The cron fires at 04:30 and 05:30 UTC (00:30 ET
 * under EDT, 00:30 ET under EST); only a fire between midnight and 2 AM ET acts, and it acts on
 * ET-yesterday — the day the 8–11 PM attempts scans have just finished.
 */
export function fillDecision(now: Date): { act: boolean; date: string; etHour: number; reason: string } {
  const { date: today, hour } = etParts(now);
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const date = d.toISOString().slice(0, 10);
  if (hour >= 0 && hour < 2) return { act: true, date, etHour: hour, reason: `act h=${hour} in[0,2)` };
  return { act: false, date, etHour: hour, reason: `out-of-window h=${hour} not in[0,2)` };
}

export interface FillLookup { stopNbr: string; stopId: string }
export interface FillLeft { stopNbr: string; reason: 'over-cap' | 'no-stopId' }

/**
 * PURE. Which of the day's attempts the run reads. Candidates: ORIGINAL stops (never a "-N"
 * duplicate) with no driver and no earlier timeline read. Those with a stopId on file are read in
 * stop-number order up to the cap; the rest are `left`, each with why. The plan can never hold more
 * lookups than `maxCalls`, and every lookup is exactly one request.
 */
export function fillPlan(items: any[], stopIds: Map<string, string | null>, maxCalls: number): { lookups: FillLookup[]; left: FillLeft[] } {
  const cap = Math.max(0, Math.min(FILL_MAX_CALLS, Math.floor(maxCalls)));
  const lookups: FillLookup[] = [];
  const left: FillLeft[] = [];
  const candidates = (items || [])
    .filter((it) => it?.stopNbr && !isCopy(it.stopNbr) && !it.matched && !it.timelineCheckedAt)
    .map((it) => String(it.stopNbr))
    .sort();
  for (const nbr of candidates) {
    const id = stopIds.get(nbr) || null;
    if (!id) { left.push({ stopNbr: nbr, reason: 'no-stopId' }); continue; }
    if (lookups.length < cap) lookups.push({ stopNbr: nbr, stopId: id });
    else left.push({ stopNbr: nbr, reason: 'over-cap' });
  }
  return { lookups, left };
}

/**
 * PURE. What the day's manifest says about the run, for the scorecard's flag. `needsAttention` is
 * true whenever an attempt is still without a driver because the run could not read it — over the
 * cap, no stopId on file, or a request that did not come back — as distinct from a timeline that
 * was read and named nobody (a route never dispatched; nothing more to read).
 */
export function fillSummary(input: {
  date: string; at: string; maxCalls: number; requests: number;
  results: Array<{ stopNbr: string; ok: boolean; driver?: string | null }>;
  left: FillLeft[];
}): any {
  const notRead = input.results.filter((r) => !r.ok).map((r) => ({ stopNbr: r.stopNbr, reason: 'not-read' }));
  const left = [...input.left, ...notRead];
  return {
    date: input.date, at: input.at, maxCalls: input.maxCalls, requests: input.requests,
    read: input.results.filter((r) => r.ok).length,
    answered: input.results.filter((r) => r.ok && r.driver).length,
    noDriverOnTimeline: input.results.filter((r) => r.ok && !r.driver).length,
    left: left.length, leftStops: left,
    needsAttention: left.length > 0,
  };
}
