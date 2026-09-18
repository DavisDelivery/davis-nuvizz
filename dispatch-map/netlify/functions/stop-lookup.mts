// stop-lookup.mts — EVERYTHING WE HOLD ABOUT ONE STOP, FOR FREE.
//
// Chad, 2026-09-18: "i want to develop a stops screen under more where i can look up any
// stop and it's history we have in firestore."
//
//   GET ?stop=007174397          one order's whole Firestore footprint
//   GET ?stop=AVRT-0170416694    carrier PROs, segmented PROs and bare PROs all resolve
//   GET ?name=LED ENERGY         customers whose name matches, each with their recent PROs
//   GET ?stop=…&days=30          widen the board window (default 14 back / 3 ahead, max 60)
//   → { ok, nuvizzCalls: 0, dossier, window, errors, … }
//
// STRICTLY FIRESTORE-ONLY. ZERO NuVizz calls, and that is the point rather than a nicety:
// this answers the question people spend a vendor call on today, about orders we already
// hold. Chad, 2026-09-15, searching a week-old PRO: "this order is a week old why is it not
// in the history? we should be keeping all orders in history it shouldn't be asking for a
// nuvizz call here." The warehouse was never the problem — the SEARCH was, and history_pros
// fixed it. This is the screen that finally uses that index for more than one card footer.
//
// ── WHAT IS READ ─────────────────────────────────────────────────────────────
//
//   history_pros/{tenant}__{key}             ≤2 doc reads → which days this PRO was on
//   history_days/{tenant}__{d}/stops/{id}    the sealed record for each of those days
//   nuvizz_stop_index/{tenant}__{d}/stops/…  the LIVE board copies (today is never sealed)
//   attempts/{tenant}__{d}/items/{stopNbr}   a redelivery marker on one of those days
//   att_plan/{tenant}__{d}/stops/{stopNbr}   who had it when the board froze at 8:30
//   history_customers/{tenant}__{matchKey}   this customer's other deliveries
//   customer_notes/{matchKey}                notes, receiving hours, contacts, overrides
//   nuvizz_ops/addr_changes__{tenant}__{d}   every address that moved
//   nuvizz_write_ops                         what WE sent NuVizz about it
//
// ── AND WHY THE DAY SETS ARE THE SHAPE THEY ARE ──────────────────────────────
//
// The warehouse is partitioned by DAY, so an unbounded "find this order" is a scan of every
// day we have ever captured. Three bounded sets instead, each answering a different miss:
//
//   • THE POINTER DAYS (≤12, capped by history-pro-index itself). The index exists precisely
//     so a PRO resolves to its days without a scan. This is the common path and it is cheap.
//   • THE BOARD WINDOW (14 back / 3 ahead by default). Today is never sealed and neither is
//     tomorrow, so an order on the board in front of the dispatcher has NO pointer yet. The
//     index alone would answer "we have nothing" about the stop they are looking at.
//   • THE FALLBACK SWEEP. When the index returns nothing at all, the sealed read widens to
//     the whole board window rather than trusting one negative — that is exactly the case
//     where the alternative is telling somebody we have no record, and it is the answer that
//     costs the most to get wrong.
//
// Attempts and the morning plan are read only for days a stop record was actually found on,
// plus the pointer days: an attempt is written for a day the stop was on the board, so days
// with no stop cannot carry one. That keeps the read count flat in how long a customer has
// been trading, which an unbounded version would not.
//
// THE SOURCE LEDGER IS PART OF THE ANSWER, NOT DECORATION. Every collection above is
// reported with what it held, whether or not it held anything — because "we looked in nine
// places and they were empty" and "the read threw" render as the same blank screen
// otherwise, which is the exact failure CLAUDE.md records from the roster evening. A read
// that throws is reported UNREAD with its reason, never as empty.
//
// Gated at viewer: one stop's own history, the same facts the stop card shows whoever opens
// it. Inert until AUTH_REQUIRED=true.

import {
  isFirestoreEnabled, getDoc, listDocs, etDayString, readStopDoc, readAddressChanges,
} from './lib/firestore.mts';
import { getStop as getSealedStop } from './lib/history-store.mts';
import { lookupProDays, proIndexEnabled } from './lib/history-pro-index.mts';
import { getCustomerByMatchKey, queryCustomersByName } from './lib/history-customers.mts';
import { selectAddressChanges } from './lib/address-history.mts';
import { selectWriteRows } from './nuvizz-stop-explain.mts';
import { requireUser } from './lib/require-user.mts';
import { buildStopDossier, classifyQuery, stopIdVariants, notesSummary, isDayId } from '../../src/lib/stop-lookup.js';

const TENANT = 'davis';
const DEFAULT_DAYS_BACK = 14;   // the Map's carry-over reach — the window stop-explain walks
const DAYS_AHEAD = 3;           // the scan's write horizon
const MAX_DAYS_BACK = 60;       // a hard ceiling on the read count, whatever ?days= says
/** Days back the sealed read always covers regardless of the index — a night sealed after
 *  the last index write, or a day the backfill has not reached, is otherwise invisible. */
const RECENT_SEAL_DAYS = 4;
const WRITES_MAX = 12;
const ADDRESS_MAX = 40;
const NAME_RESULTS = 25;

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const uniqDays = (days: string[]) => [...new Set(days.filter(isDayId))].sort().reverse();

/** PURE: the inclusive day list a board window covers, newest first. Exported for tests. */
export function boardWindow(today: string, back: number, ahead: number): string[] {
  const days: string[] = [];
  for (let i = ahead; i >= -back; i--) days.push(addDays(today, i));
  return days;
}

/** PURE: `?days=` → a back-window inside the ceiling. Anything malformed falls to the
 *  DEFAULT rather than to zero — a typo must never quietly narrow a search to nothing, the
 *  same direction every switch in this repo fails in (CLAUDE.md). Exported for tests. */
export function daysBackParam(raw: string | null): number {
  const n = Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS_BACK;
  return Math.min(Math.floor(n), MAX_DAYS_BACK);
}

/** PURE: which days the sealed warehouse is read for. Exported for tests — the bound is the
 *  whole cost argument above, and a change to it should have to break a test. */
export function sealedDaysFor(pointerDays: string[], board: string[], today: string): string[] {
  const recent = Array.from({ length: RECENT_SEAL_DAYS + 1 }, (_, i) => addDays(today, -i));
  // No pointer at all → the fallback sweep. A single negative from the index is not enough
  // to tell somebody we have no record of their order.
  if (!pointerDays.length) return uniqDays(board);
  return uniqDays([...pointerDays, ...recent.filter((d) => board.includes(d))]);
}

/** Run `fn`, and turn a failure into an UNREAD marker rather than an empty result. */
async function tryRead<T>(fn: () => Promise<T>, empty: T): Promise<{ value: T; read: boolean | 'skipped'; error: string | null }> {
  try { return { value: await fn(), read: true, error: null }; } catch (e: any) {
    return { value: empty, read: false, error: String(e?.message || e || 'read failed').slice(0, 200) };
  }
}

/** The first of a stop's id spellings a per-day reader actually answers for. */
async function firstHit<T>(ids: string[], read: (id: string) => Promise<T | null>): Promise<T | null> {
  for (const id of ids) {
    const doc = await read(id).catch(() => null);
    if (doc) return doc;
  }
  return null;
}

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'GET') return J({ ok: false, error: 'GET only' }, 405);

  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore off — there is nothing to read' }, 500);

  const url = new URL(req.url);
  const stopRaw = String(url.searchParams.get('stop') ?? url.searchParams.get('pro') ?? '').trim();
  const nameRaw = String(url.searchParams.get('name') ?? '').trim();
  const today = etDayString();

  // ── NAME SEARCH — the door in, when all the rep has is who called ──────────
  //
  // Not a second feature: a customer rings about "that delivery last week" and quotes a
  // business name, never a PRO. This hands back the customers and their recent PROs so the
  // next tap is a stop lookup. One indexed Firestore query, ZERO NuVizz calls, reusing the
  // rollup the mobile customer search already reads.
  if (!stopRaw && nameRaw) {
    const r = await tryRead(() => queryCustomersByName(nameRaw, NAME_RESULTS), [] as any[]);
    return J({
      ok: r.read, nuvizzCalls: 0, mode: 'name', query: nameRaw, today,
      customers: r.value, ...(r.error ? { error: r.error } : {}),
    }, r.read ? 200 : 500);
  }

  if (!stopRaw) return J({ ok: false, error: 'pass ?stop=<PRO or stop number> or ?name=<customer>' }, 400);

  const kind = classifyQuery(stopRaw).kind;
  const ids = stopIdVariants(stopRaw);
  const daysBack = daysBackParam(url.searchParams.get('days'));
  const board = boardWindow(today, daysBack, DAYS_AHEAD);

  // ── 1. the PRO index: which days was this order ever captured on? ──────────
  const indexOn = proIndexEnabled();
  // PRO_INDEX=off is a switch somebody threw, not a read that failed — `skipped`, so the
  // ledger says so in grey and the answer is still allowed to call itself complete. The
  // fallback sweep below covers the whole board window when the index gives nothing.
  const pointers = indexOn
    ? await tryRead(() => lookupProDays(TENANT, stopRaw), [] as any[])
    : { value: [] as any[], read: 'skipped' as const, error: 'PRO_INDEX=off — the pointer index was not consulted' };
  const pointerDays = uniqDays(pointers.value.map((p: any) => String(p?.date ?? '')));
  const sealedDays = sealedDaysFor(pointerDays, board, today);

  // ── 2. the stop itself, sealed and live, in parallel over bounded day sets ──
  const [sealedR, boardR, addressR, writesR] = await Promise.all([
    tryRead(async () => {
      const rows = await Promise.all(sealedDays.map(async (date) => ({
        // getStop already tries the raw id and NuVizz's zero-padded form; firstHit adds the
        // segment-stripped and padding-stripped spellings a dispatcher types.
        date, stop: await firstHit(ids, (id) => getSealedStop(TENANT, date, id)),
      })));
      return rows.filter((r) => r.stop);
    }, [] as any[]),
    tryRead(async () => {
      const rows = await Promise.all(board.map(async (date) => {
        const row = await firstHit(ids, (id) => readStopDoc(TENANT, date, id));
        if (!row) return null;
        // The day document's own scan stamp, read ONLY for a day that held the stop, so a
        // stale board copy can say when it was last looked at rather than implying "now".
        const meta: any = await getDoc(`nuvizz_stop_index/${TENANT}__${date}`).catch(() => null);
        return { date, row, scannedAt: meta?.last_scanned_at ?? null };
      }));
      return rows.filter(Boolean);
    }, [] as any[]),
    tryRead(async () => {
      const perDay = await Promise.all(board.map((d) => readAddressChanges(TENANT, d)));
      // `all: true` on purpose, the same call nuvizz-stop-explain makes: a formatting row is
      // noise on a 700-stop screen and EVIDENCE when somebody is asking about one order.
      return selectAddressChanges(perDay.flat(), { stop: stopRaw, limit: ADDRESS_MAX });
    }, [] as any[]),
    tryRead(async () => {
      const all = ((await listDocs('nuvizz_write_ops')) as any[]) || [];
      // routes: [] DELIBERATELY. selectWriteRows also matches board-sync rows by ROUTE, which
      // is right for stop-explain's question ("why does the board show this stop this way")
      // and wrong for this one. A route-wide sync is not something we sent about THIS order,
      // and listing it here would answer "did we push this stop" with somebody else's write.
      return selectWriteRows(all, { candidates: ids, routes: [], date: today, max: WRITES_MAX });
    }, [] as any[]),
  ]);

  // ── 3. attempts and the morning plan, only for days we actually hold ───────
  const eventDays = uniqDays([
    ...pointerDays,
    ...sealedR.value.map((r: any) => r.date),
    ...boardR.value.map((r: any) => r.date),
  ]);
  const [attemptsR, plansR] = await Promise.all([
    tryRead(async () => {
      const rows = await Promise.all(eventDays.map(async (date) => ({
        date, item: await firstHit(ids, (id) => getDoc(`attempts/${TENANT}__${date}/items/${encodeURIComponent(id)}`)),
      })));
      return rows.filter((r) => r.item);
    }, [] as any[]),
    tryRead(async () => {
      const rows = await Promise.all(eventDays.map(async (date) => ({
        date, item: await firstHit(ids, (id) => getDoc(`att_plan/${TENANT}__${date}/stops/${encodeURIComponent(id)}`)),
      })));
      return rows.filter((r) => r.item);
    }, [] as any[]),
  ]);

  // ── 4. the customer, resolved off whatever the days actually told us ───────
  const matchKey = [
    ...sealedR.value.map((r: any) => r?.stop?.customerMatchKey),
    ...boardR.value.map((r: any) => r?.row?.customerMatchKey),
    ...plansR.value.map((r: any) => r?.item?.customerMatchKey),
    ...attemptsR.value.map((r: any) => r?.item?.customerMatchKey),
    ...pointers.value.map((p: any) => p?.matchKey),
  ].map((v: any) => String(v ?? '').trim()).find(Boolean) || '';

  // NOT AN ERROR, AND THE DIFFERENCE MATTERS ON SCREEN. These two are keyed by the CUSTOMER,
  // which we only learn from one of the stop documents above — so on a genuine miss they were
  // not left unread, there was nothing to read them by. Reported as `skipped` so the ledger
  // can paint them grey; marking them the same red as a failed read made every empty answer
  // look broken, and made the empty state contradict the ledger directly underneath it.
  const noKey = 'nothing to look it up by — no customer key on any record we hold';
  const [customerR, notesR] = await Promise.all([
    matchKey ? tryRead(() => getCustomerByMatchKey(TENANT, matchKey), null as any)
      : Promise.resolve({ value: null as any, read: 'skipped' as const, error: noKey }),
    // customer_notes is keyed by the SAME matchKey the board and the map use (lib/customer-key
    // .mts), so a key found on a sealed record from June still opens today's note.
    matchKey ? tryRead(() => getDoc(`customer_notes/${matchKey}`), null as any)
      : Promise.resolve({ value: null as any, read: 'skipped' as const, error: noKey }),
  ]);

  const boardFrom = board[board.length - 1];
  const boardTo = board[0];
  const dossier = buildStopDossier({
    query: stopRaw, today,
    pointers: pointers.value,
    sealed: sealedR.value, board: boardR.value, attempts: attemptsR.value, plans: plansR.value,
    customer: customerR.value, notes: notesR.value,
    addressChanges: addressR.value, writes: writesR.value,
    looked: {
      pros: pointers.read, sealed: sealedR.read, board: boardR.read, attempts: attemptsR.read,
      plans: plansR.read, customer: customerR.read, notes: notesR.read, address: addressR.read,
      writes: writesR.read,
      sealedWindow: pointerDays.length
        ? `${sealedDays.length} day${sealedDays.length === 1 ? '' : 's'} — ${pointerDays.length} the PRO index pointed at, plus the last ${RECENT_SEAL_DAYS} nights`
        : `${sealedDays.length} days (${boardFrom} → ${boardTo}) — the PRO index had no day for this order, so the whole window was swept`,
      boardWindow: `${boardFrom} → ${boardTo}`,
      addressWindow: `${boardFrom} → ${boardTo}`,
    },
  });

  return J({
    ok: true,
    nuvizzCalls: 0,
    mode: 'stop',
    kind,
    today,
    candidates: ids,
    proIndex: indexOn,
    window: { from: boardFrom, to: boardTo, daysBack, daysAhead: DAYS_AHEAD, pointerDays, sealedDays, eventDays },
    dossier: { ...dossier, notes: notesSummary(notesR.value) },
    // A read that FAILED is named, never folded into "nothing found". The screen prints these
    // beside the source ledger so an empty answer can always be told from a broken one.
    errors: Object.fromEntries(
      Object.entries({
        pros: pointers.error, sealed: sealedR.error, board: boardR.error, attempts: attemptsR.error,
        plans: plansR.error, customer: customerR.error, notes: notesR.error, address: addressR.error,
        writes: writesR.error,
      }).filter(([, v]) => v),
    ),
    note: 'Firestore only — nothing here spent a NuVizz call.',
  });
};
