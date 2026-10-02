// nuvizz-att-backfill.mts — NAME THE DRIVER ON PAST ATTEMPTS THAT WERE WRITTEN WITH NONE (v1.99.6).
//
// Chad, 2026-09-30: "We can go back and fix the history because we should know who had it so we
// should be able to back fill" — and, after a five-stop test run: "Run them all."
//
// For attempts written before v1.99.0 (lib/att-holder.mts), nothing in Firestore holds who had the
// order on the day it failed; the stop's NuVizz activity timeline does. The rule that reads it is
// lib/att-timeline.mts (pure, tested on real timelines); this endpoint only finds the rows, reads the
// timelines and writes the answers.
//
// v1.102.4 — ORIGINAL STOPS ONLY. Chad, 2026-10-01: "-1 and -2 are duplicate orders and have nothing
// to do with the original driver." A "-N" row is never looked up and never given its original's
// driver; ?revertCopies=1 takes back every one that was (see below).
//
//   GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD
//        DRY RUN. Firestore only, ZERO NuVizz calls. Every ORIGINAL stop's attempt row in the range
//        with no driver and no earlier backfill, and what a run would cost: 1 call per stop whose
//        stopId we hold, 2 for one we do not.
//   POST ?from=…&to=…&confirm=1[&limit=6][&recheck=1][&stop=NNN]
//        Reads up to `limit` timelines (default 6, max 8 — a sync function has 26 seconds), oldest
//        day first, writes each answer with a FIELD-MASKED update, and recounts each touched day's
//        manifest. Run it again to continue: rows it has read carry timelineCheckedAt, so no call is
//        ever spent twice on one (recheck=1 overrides that, for a rule change — and re-reads the
//        answers the backfill itself wrote, clearing any the rule no longer gives). &stop=NNN limits
//        a run to one order. Each result reports how many events its timeline held.
//   GET  ?from=…&to=…&revertCopies=1                 the "-N" rows carrying their original's driver
//   POST ?from=…&to=…&revertCopies=1&confirm=1       …cleared back to no driver. ZERO NuVizz calls.
//
// NOTHING RUNS ON ITS OWN. No schedule, no background: each POST is a person asking for it, with
// confirm=1 in the request. The calls ride the shared requester, so they count against the daily
// ceiling and stop at the breaker like every other call, and each response reports the calls it
// actually spent (counted, not assumed — the same before/after read nuvizz-stop-events uses).
//
// WHAT A LOOKUP WRITES, and only this: originalDriverName / UserName / Key, matched, attributedFrom:
// 'timeline', timeline { answer, basis, dispatchedAt, atCustomer, unplannedAt, laterDrivers, via,
// lookedUpAt } and timelineCheckedAt. Route and load are left as they were: a timeline's events all
// carry the stop's CURRENT route, which is the redelivery's.

import { isFirestoreEnabled, updateDocFields, readStopDoc } from './lib/firestore.mts';
import { getStop } from './lib/history-store.mts';
import { fetchStopEvents } from './lib/nuvizz-scan.mts';
import { setCallTrigger, getNuvizzRequester } from './lib/nuvizz-request.mts';
import { requireUser } from './lib/require-user.mts';
import {
  listAttemptItems, getAttemptsManifest, setAttemptsManifest, recountManifest, attemptsPath,
} from './lib/attempts-store.mts';
import {
  backfillGroups, dueDayDriver, attributionPatch, copyRevertPlan, copyRevertPatch, type BackfillGroup,
} from './lib/att-timeline.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 120;

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (d <= end && out.length <= MAX_DAYS) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function inPool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length || 1) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** The NuVizz stopId for the original stop on its due day, from Firestore: the day's board copy,
 *  else the sealed nightly copy. Null → the timeline read costs a /stop/info first (2 calls). */
async function stopIdFor(g: BackfillGroup): Promise<string | null> {
  const board = await readStopDoc(TENANT, g.date, g.original).catch(() => null);
  if (board?.stopId) return String(board.stopId);
  const sealed = await getStop(TENANT, g.date, g.original).catch(() => null);
  const id = sealed?.stopId ?? sealed?.stop?.stopId ?? null;
  return id ? String(id) : null;
}

export default async (req: Request): Promise<Response> => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  const J = (status: number, body: any) => new Response(JSON.stringify(body), { status, headers: cors });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'GET' && req.method !== 'POST') return J(405, { ok: false, error: 'GET (dry run) or POST ?confirm=1' });

  const url = new URL(req.url);
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    return J(400, { ok: false, error: 'from and to must be YYYY-MM-DD, from ≤ to' });
  }
  const dates = daysBetween(from, to);
  if (dates.length > MAX_DAYS) return J(400, { ok: false, error: `at most ${MAX_DAYS} days per request` });
  if (!isFirestoreEnabled()) return J(200, { ok: false, error: 'firestore-disabled' });

  const run = req.method === 'POST';
  if (run) {
    const gate = await requireUser(req, { role: 'dispatcher' });
    if (!gate.ok) return gate.response;
    if (url.searchParams.get('confirm') !== '1') {
      return J(400, { ok: false, error: 'a run spends NuVizz calls: POST with confirm=1, or GET for the dry run' });
    }
  }
  const recheck = url.searchParams.get('recheck') === '1';
  // v1.99.8: one order only (its original stop number), for correcting a single answer.
  const stopOnly = (url.searchParams.get('stop') || '').trim() || undefined;

  // Firestore only from here to the first timeline read.
  let days: Array<{ date: string; items: any[] }>;
  try {
    days = await inPool(dates, 6, async (date) => ({ date, items: (await listAttemptItems(TENANT, date)).map(({ _id, ...r }: any) => r) }));
  } catch (e: any) {
    return J(500, { ok: false, error: `could not read the attempts lists: ${e?.message}`, nuvizzCalls: 0 });
  }
  const touched = new Set<string>();
  const recountTouched = async () => {
    // Keep each touched day's manifest honest, the same way a delete does.
    const recounted: string[] = [];
    for (const date of touched) {
      try {
        const [items, prev] = await Promise.all([listAttemptItems(TENANT, date), getAttemptsManifest(TENANT, date)]);
        if (prev) { await setAttemptsManifest(TENANT, date, { ...recountManifest(prev, items), lastEditedAt: new Date().toISOString(), backfilledAt: new Date().toISOString() }); recounted.push(date); }
      } catch (e: any) { console.warn(`[att-backfill] ${date}: manifest recount failed (${e?.message})`); }
    }
    return recounted;
  };

  // ── v1.102.4: take back every "-N" row that was given its original's driver. Firestore only. ──
  if (url.searchParams.get('revertCopies') === '1') {
    const plan = copyRevertPlan(days);
    if (!run) return J(200, { ok: true, dryRun: true, from, to, nuvizzCalls: 0, revertCopies: plan.length, rows: plan });
    const at = new Date().toISOString();
    const done: any[] = [];
    const failed: any[] = [];
    for (const r of plan) {
      try { await updateDocFields(`${attemptsPath(TENANT, r.date)}/items/${r.stopNbr}`, copyRevertPatch(r, at)); done.push(r); touched.add(r.date); }
      catch (e: any) { failed.push({ ...r, error: e?.message }); }
    }
    const recounted = await recountTouched();
    console.log(`[att-backfill] revertCopies ${from}..${to}: ${done.length} cleared, ${failed.length} failed, 0 NuVizz calls`);
    return J(200, { ok: failed.length === 0, from, to, nuvizzCalls: 0, reverted: done.length, failed, recounted, rows: done });
  }

  const paid = backfillGroups(days, { recheck, stop: stopOnly });

  if (!run) {
    const ids = await inPool(paid, 6, stopIdFor);
    const withId = ids.filter(Boolean).length;
    return J(200, {
      ok: true, dryRun: true, from, to, nuvizzCalls: 0,
      lookups: paid.length,
      estimatedCalls: withId + 2 * (paid.length - withId),
      groups: paid.map((g, i) => ({ ...g, stopId: ids[i] })),
    });
  }

  const limit = Math.max(1, Math.min(8, Number(url.searchParams.get('limit')) || 6));
  const batch = paid.slice(0, limit);
  setCallTrigger('att-backfill');
  const reqr = getNuvizzRequester();
  const before = reqr.getStats().totalThisInstance;
  const results: any[] = [];
  for (const g of batch) {
    const stopId = await stopIdFor(g);
    const res = await fetchStopEvents(g.original, stopId, { refresh: false });
    if (!res.ok) {
      // Not read — nothing is marked, so the next run tries it again.
      results.push({ ...g, ok: false, reason: res.reason || 'timeline not read' });
      if (res.reason === 'scans_disabled') break;
      continue;
    }
    const answer = dueDayDriver(res.events || [], g.date);
    const at = new Date().toISOString();
    const written: string[] = [];
    const failed: string[] = [];
    for (const nbr of g.rows) {
      try {
        await updateDocFields(`${attemptsPath(TENANT, g.date)}/items/${nbr}`, attributionPatch(answer, at));
        written.push(nbr);
      } catch { failed.push(nbr); }
    }
    if (written.length) touched.add(g.date);
    results.push({
      ...g, ok: true, events: (res.events || []).length, driver: answer?.driver ?? null, basis: answer?.basis ?? null,
      dispatchedAt: answer?.dispatchedAt ?? null, atCustomer: answer?.atCustomer ?? null,
      laterDrivers: answer?.laterDrivers ?? [], written, ...(failed.length ? { failed } : {}),
    });
  }
  const nuvizzCalls = Math.max(0, reqr.getStats().totalThisInstance - before);

  const recounted = await recountTouched();
  const answered = results.filter((r) => r.ok && r.driver).length;
  const remaining = paid.length - results.filter((r) => r.ok).length;
  console.log(`[att-backfill] ${from}..${to}: ${results.length} timeline(s) read, ${answered} answered, ${nuvizzCalls} NuVizz call(s), ${remaining} left`);
  return J(200, {
    ok: true, from, to, nuvizzCalls,
    read: results.length, answered, noAnswer: results.filter((r) => r.ok && !r.driver).length,
    notRead: results.filter((r) => !r.ok).length,
    remaining,
    recounted, results,
  });
};
