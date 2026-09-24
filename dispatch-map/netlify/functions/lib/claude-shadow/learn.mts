// lib/claude-shadow/learn.mts — THE SHADOW'S LEARNING RUN: sealed history in, claude_shadow_* out.
//
// Reads (Firestore only, ZERO NuVizz calls):
//   history_days                              the warehouse's day manifests — which days are sealed
//   history_days/davis__{D}/stops             each sealed day's stops, masked to HISTORY_STOP_MASK
//   nuvizz_load_roster/davis__{D}             that day's loads, to spot two loads under one name
//   claude_shadow_learn_days                  what has already been learned
//   claude_shadow_settings/davis              the loose-pieces-per-skid setting, when one is saved
// Writes (only through store.mts, so only claude_shadow_*):
//   claude_shadow_learn_days/davis__{D}       one summary per sealed day: trips + stop order
//   claude_shadow_learned/davis__capacity     the capacity model built from every summary
//   claude_shadow_meta/learn_last             what this run did, including what it refused
//
// INCREMENTAL. A sealed day is learned once and re-learned when it is healed (its manifest stamp
// moves) or LEARN_VERSION changes; the newest RELEARN_RECENT_DAYS are re-read every run as well,
// because a stop filed into a sealed day later moves no stamp. The first run reads every sealed
// day; a nightly run after that reads a handful. The model is rebuilt from all summaries each run.
//
// A MODEL IS NEVER REPLACED BY A WORSE ONE SILENTLY. A settings read that FAILS (as opposed to a
// setting that is simply not saved) leaves the previous model in place and marks the run failed,
// rather than rebuilding it at the default ratio and calling that "default". A run that had to
// leave days for later says so and is not ok.
//
// THE RUN RECORD IS THE OBSERVABLE. The nightly run is a background function, whose response the
// platform discards, so every run — including a refused one — writes learn_last, and the Claude
// shadow tab reads it back. "Learn now" runs the same code inside the tab's own (synchronous)
// endpoint with a TIME BUDGET: it learns as many days as fit, returns the record directly, and
// says how many are left; the nightly run finishes the rest.
import { getDoc, listDocs, isFirestoreEnabled } from '../firestore.mts';
import { shadowSet } from './store.mts';
import { claudeShadowEnabled } from './config.mts';
import {
  LEARN_TENANT, LEARN_DAYS_COLLECTION, CAPACITY_PATH, LEARN_LAST_PATH, SETTINGS_PATH,
  HISTORY_STOP_MASK, HISTORY_MANIFEST_MASK, DEFAULT_LOOSE_PER_SKID,
  sealedDaysFrom, daysToLearn, learnDay, buildCapacityModel, num,
} from './learn-core.mts';

export interface LearnDeps {
  getDoc: (path: string) => Promise<any | null>;
  listDocs: (path: string, opts?: { mask?: string[] }) => Promise<any[]>;
  shadowSet: (path: string, data: Record<string, any>) => Promise<boolean>;
  now: () => Date;
}
const LIVE: LearnDeps = { getDoc, listDocs, shadowSet, now: () => new Date() };

// Days read in parallel. Each is three list pages of masked stops plus one roster document.
const DAY_CONCURRENCY = 4;
export const MAX_DAYS_PER_RUN = 150;

/** Why a run must not happen here, or null. The whole feature's switch stops learning too
 *  (CLAUDE_SHADOW=off puts EVERY side back at once), and a mirror database is not production's
 *  history: the UAT site copies production's environment, so it would otherwise learn a copy. */
export function learnRefusal(env: Record<string, any> = process.env, firestoreOn: boolean = isFirestoreEnabled()): string | null {
  if (!claudeShadowEnabled(env)) return 'CLAUDE_SHADOW is off';
  // Covers a UAT-pointed deploy with no named database: firestore.mts refuses the (default)
  // database there, and the shadow must not write production's claude_shadow_* from it either.
  if (!firestoreOn) return 'Firestore is not usable on this site';
  const db = String(env?.FIRESTORE_DATABASE ?? '').trim();
  if (db && db !== '(default)') return `this site reads the ${db} database, not production's history`;
  return null;
}

/** The loose-pieces-per-skid-spot ratio in force: the saved setting, else the default. */
export function loosePerSkidFrom(settings: any): { value: number; source: 'setting' | 'default' } {
  const v = num(settings?.loosePerSkid);
  if (v != null && v >= 1 && v <= 100) return { value: v, source: 'setting' };
  return { value: DEFAULT_LOOSE_PER_SKID, source: 'default' };
}

/** WHAT A RUN WOULD DO, without doing it: the sealed days, and which of them need learning. */
export async function planLearn(deps: LearnDeps = LIVE) {
  const [manifests, learned] = await Promise.all([
    deps.listDocs('history_days', { mask: HISTORY_MANIFEST_MASK }),
    deps.listDocs(LEARN_DAYS_COLLECTION, { mask: ['learnVersion', 'sourceStamp', 'date'] }),
  ]);
  const sealed = sealedDaysFrom(manifests);
  const { toLearn, refresh } = daysToLearn(sealed, learned);
  const wouldLearn = toLearn.slice(-MAX_DAYS_PER_RUN);   // when capped, the NEWEST days: yesterday matters most
  return {
    sealedDays: sealed.length,
    firstSealed: sealed[0]?.date ?? null,
    lastSealed: sealed[sealed.length - 1]?.date ?? null,
    learnedDays: learned.length,
    toLearn,
    wouldLearn,
    refresh,
    deferred: toLearn.length - wouldLearn.length,
    stamps: new Map(sealed.map((s) => [s.date, s.stamp])),
  };
}

// Runs `fn` over `items`, n at a time. `stop()` is asked before each item is STARTED — an item
// already running always finishes — and the items never started are returned.
async function inPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>, stop: () => boolean = () => false): Promise<T[]> {
  let i = 0;
  const lane = async () => { while (i < items.length && !stop()) { const it = items[i++]; await fn(it); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
  return items.slice(i);
}

export async function runLearn(opts: { trigger: string; by?: string | null; maxDays?: number; budgetMs?: number }, deps: LearnDeps = LIVE) {
  const started = deps.now();
  const at = started.toISOString();
  const record: any = {
    at, trigger: opts.trigger, by: opts.by ?? null, ok: false, refused: null,
    sealedDays: null, learned: [], refreshed: [], failed: [], deferred: 0, modelDays: null, modelWritten: false, loosePerSkid: null,
    ms: null, finishedAt: null, nuvizzCalls: 0,
  };
  const finish = async () => {
    const end = deps.now();
    record.finishedAt = end.toISOString();
    record.ms = end.getTime() - started.getTime();
    try { await deps.shadowSet(LEARN_LAST_PATH, record); } catch (e: any) { record.recordError = String(e?.message || e); }
    return record;
  };

  const refused = learnRefusal();
  if (refused) {
    record.refused = refused;
    // With Firestore unusable there is nowhere this record may go: on a UAT-pointed deploy the only
    // database in reach is production's (default), which firestore.mts itself refuses to use.
    if (!isFirestoreEnabled()) { record.finishedAt = deps.now().toISOString(); return record; }
    return finish();
  }

  try {
    const plan = await planLearn(deps);
    record.sealedDays = plan.sealedDays;
    const cap = Math.max(1, Math.min(MAX_DAYS_PER_RUN, opts.maxDays ?? MAX_DAYS_PER_RUN));
    const fresh = plan.toLearn.slice(-cap);          // when capped, the NEWEST days: yesterday matters most
    record.deferred = plan.toLearn.length - fresh.length;
    const isFresh = new Set(fresh);
    const todo = [...fresh, ...plan.refresh];
    const outOfTime = () => opts.budgetMs != null && deps.now().getTime() - started.getTime() >= opts.budgetMs;

    const notStarted = await inPool(todo, DAY_CONCURRENCY, async (date) => {
      try {
        const [rows, roster] = await Promise.all([
          deps.listDocs(`history_days/${LEARN_TENANT}__${date}/stops`, { mask: HISTORY_STOP_MASK }),
          deps.getDoc(`nuvizz_load_roster/${LEARN_TENANT}__${date}`),
        ]);
        const summary = learnDay(rows, date, plan.stamps.get(date) ?? '', roster, deps.now().toISOString());
        await deps.shadowSet(`${LEARN_DAYS_COLLECTION}/${LEARN_TENANT}__${date}`, summary);
        (isFresh.has(date) ? record.learned : record.refreshed).push(date);
      } catch (e: any) {
        record.failed.push({ date, error: String(e?.message || e).slice(0, 300) });
      }
    }, outOfTime);
    // Days the budget did not reach are left for the next run, and said so — never dropped.
    record.deferred += notStarted.filter((d) => isFresh.has(d)).length;
    record.learned.sort();
    record.refreshed.sort();

    // A thrown settings read is NOT "no setting": the previous model stays, and the run says why.
    let settings: any;
    try { settings = await deps.getDoc(SETTINGS_PATH); }
    catch (e: any) { throw new Error(`settings read failed (${String(e?.message || e)}) — the previous model was kept`); }
    const days = await deps.listDocs(LEARN_DAYS_COLLECTION, { mask: ['date', 'learnVersion', 'roster', 'stampGate', 'counts', 'trips'] });
    const lps = loosePerSkidFrom(settings);
    record.loosePerSkid = lps;
    const model = { ...buildCapacityModel(days, { loosePerSkid: lps.value }, deps.now().toISOString()), loosePerSkidSource: lps.source };
    await deps.shadowSet(CAPACITY_PATH, model);
    record.modelWritten = true;
    record.modelDays = model.days.count;
    record.ok = record.failed.length === 0 && record.deferred === 0;
  } catch (e: any) {
    record.error = String(e?.message || e).slice(0, 500);
  }
  return finish();
}
