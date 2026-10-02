// lib/att-fill-run.mts — runs the nightly attempts fill (v1.104.0). The rules, and the full account of
// why it can never spend more than ten NuVizz calls, are in lib/att-fill.mts (pure, tested); this file
// only claims the date, reads Firestore, sends the planned requests and writes what came back.
import { isFirestoreEnabled, createDocIfAbsent, updateDocFields, readStopDoc } from './firestore.mts';
import { getStop } from './history-store.mts';
import { fetchStopEventsOnce, scansEnabled } from './nuvizz-scan.mts';
import { setCallTrigger } from './nuvizz-request.mts';
import {
  listAttemptItems, getAttemptsManifest, setAttemptsManifest, recountManifest, attemptsPath, fillClaimPath,
} from './attempts-store.mts';
import { attEnabled } from './attempts-core.mts';
import { dueDayDriver, attributionPatch, isCopy } from './att-timeline.mts';
import { attFillEnabled, fillMaxCalls, fillDecision, fillPlan, fillSummary } from './att-fill.mts';

const TENANT = 'davis';

/** The stop's NuVizz id from Firestore — the day's board copy, else the sealed nightly copy. Free. */
export async function stopIdOnFile(date: string, stopNbr: string): Promise<string | null> {
  const board = await readStopDoc(TENANT, date, stopNbr).catch(() => null);
  if (board?.stopId) return String(board.stopId);
  const sealed = await getStop(TENANT, date, stopNbr).catch(() => null);
  const id = sealed?.stopId ?? sealed?.stop?.stopId ?? null;
  return id ? String(id) : null;
}

/** Everything the run touches, injectable so a test can drive the real loop against fakes. */
export interface FillDeps {
  env: Record<string, any>;
  ready: () => boolean;                                        // Firestore on, attempts on, scans on
  claim: (date: string, data: any) => Promise<boolean>;       // atomic create; false = already claimed
  listItems: (date: string) => Promise<any[]>;
  stopIdOnFile: (date: string, stopNbr: string) => Promise<string | null>;
  fetchOnce: (stopId: string) => Promise<{ ok: boolean; events?: any[]; reason?: string }>;
  writeItem: (date: string, stopNbr: string, fields: any) => Promise<any>;
  writeClaim: (date: string, fields: any) => Promise<any>;
  readManifest: (date: string) => Promise<any | null>;
  writeManifest: (date: string, manifest: any) => Promise<any>;
}

export const productionFillDeps: FillDeps = {
  env: process.env,
  ready: () => isFirestoreEnabled() && attEnabled() && scansEnabled(),
  claim: (date, data) => createDocIfAbsent(fillClaimPath(TENANT, date), data),
  listItems: async (date) => (await listAttemptItems(TENANT, date)).map(({ _id, ...r }: any) => r),
  stopIdOnFile,
  fetchOnce: (stopId) => fetchStopEventsOnce(stopId),
  writeItem: (date, nbr, fields) => updateDocFields(`${attemptsPath(TENANT, date)}/items/${nbr}`, fields),
  writeClaim: (date, fields) => updateDocFields(fillClaimPath(TENANT, date), fields),
  readManifest: (date) => getAttemptsManifest(TENANT, date),
  writeManifest: (date, m) => setAttemptsManifest(TENANT, date, m),
};

export async function runAttFill(now: Date = new Date(), deps: FillDeps = productionFillDeps): Promise<any> {
  if (!attFillEnabled(deps.env)) return { acted: false, reason: 'disabled (NUVIZZ_ATT_TIMELINE_FILL=off)' };
  if (!deps.ready()) return { acted: false, reason: 'Firestore, attempts or NuVizz scans switched off' };
  const decision = fillDecision(now);
  if (!decision.act) return { acted: false, date: decision.date, reason: decision.reason };
  const { date } = decision;
  const maxCalls = fillMaxCalls(deps.env);
  const at = now.toISOString();

  // CLAIM THE DATE BEFORE ANY REQUEST. A second fire, a platform retry, anything — finds this and stops.
  const claimed = await deps.claim(date, { tenant: TENANT, date, claimedAt: at, maxCalls, finished: false });
  if (!claimed) return { acted: false, date, reason: 'already ran for this date — 0 NuVizz calls' };

  setCallTrigger('att-fill');
  const items = await deps.listItems(date);
  const stopIds = new Map<string, string | null>();
  for (const it of items) {
    if (!it?.stopNbr || isCopy(it.stopNbr) || it.matched || it.timelineCheckedAt) continue;
    stopIds.set(String(it.stopNbr), await deps.stopIdOnFile(date, String(it.stopNbr)));
  }
  const plan = fillPlan(items, stopIds, maxCalls);

  let requests = 0;
  const results: Array<{ stopNbr: string; ok: boolean; driver?: string | null; reason?: string; events?: number }> = [];
  for (const l of plan.lookups) {
    if (requests >= maxCalls) break;      // the plan can never be longer than the cap; checked again anyway
    requests++;                           // counted BEFORE it is sent — a timed-out request still counts
    const res = await deps.fetchOnce(l.stopId);
    if (!res.ok) {
      results.push({ stopNbr: l.stopNbr, ok: false, reason: res.reason || 'not read' });
      if (res.reason === 'scans_disabled') break;
      continue;
    }
    const answer = dueDayDriver(res.events || [], date);
    try {
      await deps.writeItem(date, l.stopNbr, attributionPatch(answer, new Date().toISOString()));
      results.push({ stopNbr: l.stopNbr, ok: true, driver: answer?.driver ?? null, events: (res.events || []).length });
    } catch (e: any) {
      results.push({ stopNbr: l.stopNbr, ok: false, reason: `read, but the write failed: ${e?.message}` });
    }
  }
  const tried = new Set(results.map((r) => r.stopNbr));
  const untried = plan.lookups.filter((l) => !tried.has(l.stopNbr)).map((l) => ({ stopNbr: l.stopNbr, reason: 'over-cap' as const }));
  const summary = fillSummary({ date, at, maxCalls, requests, results, left: [...plan.left, ...untried] });

  await Promise.resolve(deps.writeClaim(date, { ...summary, results, finished: true, finishedAt: new Date().toISOString() }))
    .catch((e: any) => console.warn(`[att-fill] ${date}: claim summary not written (${e?.message})`));
  // The day's manifest carries it for the scorecard's flag, recounted the way a delete recounts it.
  try {
    const [all, prev] = await Promise.all([deps.listItems(date), deps.readManifest(date)]);
    if (prev) await deps.writeManifest(date, { ...recountManifest(prev, all), fill: summary });
  } catch (e: any) { console.warn(`[att-fill] ${date}: manifest not updated (${e?.message})`); }
  console.log(`[att-fill] ${date}: ${requests} request(s) of ${maxCalls}, ${summary.answered} answered, ${summary.left} left${summary.needsAttention ? ' — FLAGGED' : ''}`);
  return { acted: true, ...summary, results };
}
