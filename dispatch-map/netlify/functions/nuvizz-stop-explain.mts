// nuvizz-stop-explain.mts — WHY DOES THE BOARD SHOW THIS STOP THE WAY IT DOES?
//
//   GET /.netlify/functions/nuvizz-stop-explain?stop=AVRT-0170416694            (today's board)
//   GET /.netlify/functions/nuvizz-stop-explain?stop=RA5732712&date=2026-09-10
//
// Chad, 2026-09-10, two orders in the Routing selection that NuVizz held on WILLIAM and JOE:
// "our system does not show this — figure out why." The honest answer from the code was that
// there are seven ways that state arises and nothing in the app could say which one had,
// because the facts that decide it live in a dozen Firestore documents nobody can open from a
// dispatch screen. CLAUDE.md's rule for exactly that: build the free diagnostic FIRST.
//
// READ-ONLY. FIRESTORE ONLY. ZERO NuVizz CALLS — this is the question you ask BEFORE spending
// one. It gathers, for one stop number:
//   • every copy of the stop across the board day documents around the date (14 back, 3 ahead),
//     each with its plan, its stamps (scan, confirmed-save write-through, verify, absent-from-
//     pull, frozen heal, carry-over) and the day document's own scan time;
//   • the open-order pool's row (what NuVizz's active search listed at the last scan) and the
//     un-planned snapshot's answer;
//   • the scan's plan-verdict ledger for the stop — which scan took it off which route and on
//     whose word (load membership, a lagging stop record, a roster with no such load, a spent
//     budget, a confirmed save's grace);
//   • the write journal rows that mention it, or its route on that day;
//   • the day's cached load roster, and whether the route resolves on it;
//   • sealed history, the retired list and any dispatcher-set board date;
// and lib/stop-explain.mts (pure, tested) turns those into sentences, most important first.
//
// Gated at viewer: it reads one stop's board facts — the same facts the stop card shows
// whoever opens it. Inert until AUTH_REQUIRED=true.
import { isFirestoreEnabled, getDoc, listDocs, etDayString, readStopDoc, readActivePool, readActiveUnplannedSet, readCarryoverRetired, readBoardDateOverrides, readPlanVerdicts, readLoadRoster, readScanRuns, readAddressChanges } from './lib/firestore.mts';
// v1.20.0 — the address log, beside everything else this endpoint already gathers. It exists
// BECAUSE of a question asked of this endpoint ("did we change the address on 007174397")
// that it could not answer: the facts were nowhere, and now they are one read away.
import { selectAddressChanges } from './lib/address-history.mts';
import { getStop as getHistoryStop } from './lib/history-store.mts';
import { requireUser } from './lib/require-user.mts';
import { explainStop, sameNbr } from './lib/stop-explain.mts';
import { sentPlace } from './lib/save-sent.mts';
import { pastOverrideClampEnabled } from './lib/nuvizz-list.mts';
import type { StopCopy, StopFacts } from './lib/stop-explain.mts';

const TENANT = 'davis';
const DAYS_BACK = 14;   // the Map's carry-over reach
const DAYS_AHEAD = 3;   // the scan's write horizon
const VERDICT_DAYS_BACK = 3;
const HISTORY_DAYS_BACK = 7;
const WRITES_MAX = 8;

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

/** The doc ids one typed stop number could be stored under: as typed, upper-cased, and the
 *  9-digit zero-padded form NuVizz uses for numeric PROs. */
export function stopIdCandidates(raw: string): string[] {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const out = [s];
  if (s.toUpperCase() !== s) out.push(s.toUpperCase());
  if (/^[0-9]+$/.test(s) && s.length < 9) out.push(s.padStart(9, '0'));
  return [...new Set(out)];
}

/** What a row's `sent` says about THIS stop (lib/save-sent.mts): carried it and where, struck it
 *  off, or went out without it. `candidates` empty → just how many stops it carried. */
function sentNote(sent: any, candidates: string[] = [], listKey: 'removed' | 'unplanned' = 'removed'): string {
  if (!sent) return '';
  const ordered = Array.isArray(sent.ordered) ? sent.ordered : null;
  const n = sent.orderedTotal ?? (ordered ? ordered.length : 0);
  const p = candidates.length ? sentPlace(sent, candidates) : { at: null, of: null, removed: false };
  const struck = listKey === 'unplanned' ? 'un-planned this one' : 'struck this one off';
  if (!ordered) return p.removed ? ` · ${struck}` : ' · sent no stop order';
  const carried = ` · sent ${n} stop${n === 1 ? '' : 's'}`;
  if (!candidates.length) return carried;
  if (p.at != null) return `${carried}, this one #${p.at}`;
  if (p.removed) return `${carried} and ${struck}`;
  // Past the cap the list is cut, so an absence there is not proof the Save left it out.
  return sent.orderedTotal ? `${carried} (list cut at ${ordered.length}; this one not in it)` : `${carried} — NOT this one`;
}

/** A board write-through's `sent` (planned / un-planned lists) against THIS stop. The counts
 *  are already on the line, so this says only where the stop was. */
function boardSyncNote(sent: any, candidates: string[]): string {
  if (!sent || !candidates.length) return '';
  const p = sentPlace({ ordered: Array.isArray(sent.ordered) ? sent.ordered : [], removed: sent.unplanned }, candidates);
  if (p.at != null) return ` · this one #${p.at}`;
  if (p.removed) return ' · un-planned this one';
  return sent.orderedTotal ? ` · list cut at ${sent.ordered.length}; this one not in it` : ' · NOT this one';
}

/** The `sent` entry for one result load — joined by the load number / id the Save ASKED for,
 *  because a retargeted result carries the twin's identity (see keyOf in the client). */
function sentForResult(l: any, sent: any): any {
  const loads = Array.isArray(sent?.loads) ? sent.loads : [];
  const hit = loads.find((x: any) => (x?.loadNbr && [l?.requestedLoadNbr, l?.loadNbr].map(String).includes(String(x.loadNbr)))
    || (x?.loadId && [l?.requestedLoadId, l?.loadId].map(String).includes(String(x.loadId))));
  return hit ?? null;
}

/** One write-journal row → one line. A row names the stops a Save SENT only since v1.87.3
 *  (`sent`); older rows keep the RESULT alone, so a stop number appears in them only where the
 *  result names it, and board-sync rows are matched by route + day. `candidates` — the stop's
 *  numbers — lets the line say whether the Save carried THIS stop. */
export function summarizeWriteOp(rec: any, candidates: string[] = []): string {
  const r = rec?.result ?? {};
  // "left finished N" — stops a stamp skipped because the board already held them finished
  // (lib/finished-guard.mts). Shown wherever the counts are, so a skip is never a silent no-op.
  const finished = (b: any) => (b?.skippedFinished ? `, left finished ${b.skippedFinished}${Array.isArray(b.skippedFinishedNbrs) && b.skippedFinishedNbrs.length ? ` (${b.skippedFinishedNbrs.slice(0, 5).join(', ')})` : ''}` : '');
  if (rec?.op === 'boardSync') return `${r.routeName ?? '?'} on ${r.date ?? '?'}: ${r.ordered ?? 0} planned, ${r.unplanned ?? 0} un-planned → patched ${r.patched ?? 0}, rescued ${r.rescued ?? 0}, missing ${r.missing ?? 0}${Array.isArray(r.missingNbrs) && r.missingNbrs.length ? ` (${r.missingNbrs.slice(0, 5).join(', ')})` : ''}${finished(r)}${r.error ? ` — ${r.error}` : ''}${boardSyncNote(rec?.sent, candidates)}`;
  if (Array.isArray(r.loads)) {
    const single = Array.isArray(rec?.sent?.loads) && rec.sent.loads.length === 1 && r.loads.length === 1 ? rec.sent.loads[0] : null;
    return r.loads.map((l: any) => {
      const s = sentForResult(l, rec?.sent) ?? single;
      const name = s?.routeName && s.routeName !== l?.loadNbr ? ` (${s.routeName})` : '';
      return `${l?.loadNbr ?? '?'}${name}: ${l?.ok ? 'ok' : `FAILED — ${String(l?.error ?? 'no reason').slice(0, 160)}`}${l?.boardSync ? ` (board patched ${l.boardSync.patched ?? 0}, rescued ${l.boardSync.rescued ?? 0}, missing ${l.boardSync.missing ?? 0}${finished(l.boardSync)})` : ''}${l?.finishedRecorded ? ` [record read ${l.finishedRecorded.normalizedStatus}: ${l.finishedRecorded.patched ? 'recorded on the board' : (l.finishedRecorded.reason || 'not recorded')}]` : ''}${sentNote(s, candidates)}`;
    }).join('; ');
  }
  return r?.error ? String(r.error).slice(0, 200) : (r?.ok === false ? 'failed' : 'ok');
}

/** PURE: which journal rows belong beside this stop — rows that name the number (in the result,
 *  or in what a Save sent), board-sync rows for one of its routes on the day in question, and —
 *  since `sent` exists — every Save of one of its routes made against that day, INCLUDING the
 *  ones that went out without it. Those are the rows that answer "when did the card lose it".
 *  Newest first, capped. */
export function selectWriteRows(all: any[], opts: { candidates: string[]; routes: string[]; date: string; max?: number }): Array<{ at: string; op: string; status: string; summary: string }> {
  const max = opts.max ?? WRITES_MAX;
  const routes = new Set(opts.routes.map((r) => String(r).trim().toLowerCase()).filter(Boolean));
  const mentions = (rec: any) => { const j = JSON.stringify(rec ?? {}); return opts.candidates.some((c) => c && j.includes(`"${c}"`) || (c && new RegExp(`[^A-Za-z0-9]${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^A-Za-z0-9]`).test(j))); };
  const forRoute = (rec: any) => rec?.op === 'boardSync' && String(rec?.result?.date ?? '') === opts.date && routes.has(String(rec?.result?.routeName ?? '').trim().toLowerCase());
  const savedRoute = (rec: any) => rec?.op !== 'boardSync' && String(rec?.sent?.date ?? '') === opts.date
    && Array.isArray(rec?.sent?.loads) && rec.sent.loads.some((l: any) => routes.has(String(l?.routeName ?? '').trim().toLowerCase()));
  return (all || [])
    .filter((rec) => rec && (mentions(rec) || forRoute(rec) || savedRoute(rec)))
    .sort((a, b) => String(b?.at ?? '').localeCompare(String(a?.at ?? '')))
    .slice(0, max)
    .map((rec) => ({ at: String(rec.at ?? ''), op: String(rec.op ?? '?'), status: String(rec.status ?? '?'), summary: summarizeWriteOp(rec, opts.candidates) }));
}

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b, null, 1), {
    status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
  });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
  if (req.method !== 'GET') return J({ ok: false, error: 'GET only' }, 405);
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set — no board documents to read' }, 500);

  const url = new URL(req.url);
  const stopRaw = String(url.searchParams.get('stop') ?? url.searchParams.get('stopNbr') ?? '').trim();
  const date = String(url.searchParams.get('date') || etDayString());
  if (!stopRaw) return J({ ok: false, error: 'pass ?stop=<stop number> (and optionally &date=YYYY-MM-DD)' }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return J({ ok: false, error: 'date must be YYYY-MM-DD' }, 400);
  const candidates = stopIdCandidates(stopRaw);
  const today = etDayString();

  // ── every copy across the board days around the date ────────────────────────
  const days = Array.from({ length: DAYS_BACK + DAYS_AHEAD + 1 }, (_, i) => addDays(date, i - DAYS_BACK));
  const copies: StopCopy[] = await Promise.all(days.map(async (day): Promise<StopCopy> => {
    for (const id of candidates) {
      const row = await readStopDoc(TENANT, day, id).catch(() => null);
      if (row) return { day, row };
    }
    return { day, row: null };
  }));
  await Promise.all(copies.filter((c) => c.row).map(async (c) => {
    const meta: any = await getDoc(`nuvizz_stop_index/${TENANT}__${c.day}`).catch(() => null);
    c.scannedAt = meta?.last_scanned_at ?? null;
  }));

  // ── the judges: pool, snapshot, retired, override ────────────────────────────
  const [pool, snap, retired, overrides, roster, runs] = await Promise.all([
    readActivePool(TENANT).catch(() => null),
    readActiveUnplannedSet(TENANT).catch(() => null),
    readCarryoverRetired(TENANT).catch(() => ({} as Record<string, string>)),
    readBoardDateOverrides(TENANT).catch(() => ({} as Record<string, string>)),
    readLoadRoster(TENANT, date).catch(() => null),
    readScanRuns().catch(() => [] as any[]),
  ]);
  const poolRow = pool ? (pool.rows || []).find((r: any) => sameNbr(r?.stopNbr, stopRaw)) ?? null : null;
  const listedInSnapshot = !!snap && candidates.some((c) => snap.stopNbrs.has(c));
  const firstHit = (m: Record<string, string>) => { for (const c of candidates) if (m && m[c]) return m[c]; return null; };

  // ── the scan's own verdicts about this stop ───────────────────────────────────
  const verdictDays = Array.from({ length: VERDICT_DAYS_BACK + 2 }, (_, i) => addDays(date, i - VERDICT_DAYS_BACK));
  const verdictLists = await Promise.all(verdictDays.map((d) => readPlanVerdicts(TENANT, d).catch(() => [])));
  const verdicts = verdictLists.flat()
    .filter((r: any) => sameNbr(r?.stopNbr, stopRaw))
    .sort((a: any, b: any) => String(b?.at ?? '').localeCompare(String(a?.at ?? '')));

  // ── the write journal, for the stop or its route on this day ──────────────────
  const routes = [...new Set([
    ...copies.map((c) => String(c.row?.routeName || c.row?.loadNbr || '')),
    String(poolRow?.routeName || poolRow?.loadNbr || ''),
    ...verdicts.map((v: any) => String(v?.route ?? '')),
  ].map((s) => s.trim()).filter(Boolean))];
  let writes: StopFacts['writes'] = [];
  let journalError: string | null = null;
  try {
    const all = ((await listDocs('nuvizz_write_ops')) as any[]) || [];
    writes = selectWriteRows(all, { candidates, routes, date });
  } catch (e: any) { journalError = e?.message || 'journal read failed'; }

  // ── the address log: has this order's address moved, and who moved it? ───────
  // Reads the same per-day documents the Address history screen does, over the window this
  // endpoint already walks — so a stop's whole address story is on the page that answers
  // "why does the board show this stop the way it does".
  let addressChanges: any[] = [];
  try {
    const days = Array.from({ length: DAYS_BACK + DAYS_AHEAD + 1 }, (_, i) => addDays(date, DAYS_AHEAD - i));
    const perDay = await Promise.all(days.map((d) => readAddressChanges(TENANT, d)));
    // `all: true` on purpose — a formatting row is noise on a 700-stop screen and evidence
    // when you are asking about ONE order.
    addressChanges = selectAddressChanges(perDay.flat(), { stop: stopRaw, limit: 20 });
  } catch { /* the log is an extra, never the reason this endpoint fails */ }

  // ── sealed history: has a recent prior day already recorded it finished? ─────
  let history: StopFacts['history'] = null;
  for (let i = 1; i <= HISTORY_DAYS_BACK && !history; i++) {
    const d = addDays(date, -i);
    const rec: any = await getHistoryStop(TENANT, d, stopRaw).catch(() => null);
    const st = String(rec?.normalizedStatus ?? '').toUpperCase();
    if (st === 'DELIVERED' || st === 'EXCEPTION' || st === 'CANCELLED') history = { day: d, status: st };
  }

  const facts: StopFacts = {
    stopNbr: stopRaw, date, today, copies,
    pool: pool ? { at: pool.at, windowStart: pool.windowStart, windowEnd: pool.windowEnd, thin: pool.thin === true, row: poolRow } : null,
    snapshot: snap ? { at: snap.at, windowStart: snap.windowStart, thin: snap.thin === true, listed: listedInSnapshot } : null,
    retiredOn: firstHit(retired), override: firstHit(overrides), pastOverrideClamp: pastOverrideClampEnabled(),
    verdicts, writes,
    roster: roster ? { at: roster.at ?? null, loads: (roster.loads || []).map((l: any) => ({ name: String(l?.name ?? l?.routeName ?? ''), loadNbr: l?.loadNbr ? String(l.loadNbr) : null, status: l?.status ? String(l.status) : null })) } : null,
    history,
  };
  const out = explainStop(facts);
  // The last few scan fires, so "was there even a scan after the save" is on the same page.
  const recentScans = (runs || []).slice(-6).reverse().map((r: any) => ({
    startedAt: r?.startedAt ?? null, finishedAt: r?.finishedAt ?? null, trigger: r?.trigger ?? null, path: r?.path ?? null, outcome: r?.outcome ?? null,
    planVerdicts: Array.isArray(r?.dates) ? r.dates.filter((d: any) => d?.planVerdicts).map((d: any) => ({ date: d.date, ...d.planVerdicts })) : [],
    // v1.31.0 — what the run did about two loads sharing a name (checked / read / dropped).
    nameCollisions: Array.isArray(r?.dates) ? r.dates.filter((d: any) => d?.nameCollisions).map((d: any) => ({ date: d.date, ...d.nameCollisions })) : [],
  }));
  return J({
    ok: true, nuvizzCalls: 0, candidates, ...out, recentScans, addressChanges,
    ...(journalError ? { journalError } : {}),
    note: 'Firestore only — nothing here spent a NuVizz call. To ask NuVizz itself, POST nuvizz-stop-explorer {savedSearch:"active", full:true, find:"<stop>"} (ONE call) shows what the planned/un-planned list says about this stop right now.',
  });
};
