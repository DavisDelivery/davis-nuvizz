// stop-lookup.mts — EVERYTHING WE HOLD ABOUT ONE STOP, FOR FREE.
//
// Chad, 2026-09-18: "i want to develop a stops screen under more where i can look up any
// stop and it's history we have in firestore."
//
//   GET ?stop=007174397          one order's whole Firestore footprint
//   GET ?stop=AVRT-0170416694    carrier PROs, segmented PROs and bare PROs all resolve
//   GET ?name=LED ENERGY         that customer's deliveries over a window, with drivers
//   GET ?name=…&year=2026        a YEAR of that customer, counted nightly rather than swept
//   GET ?detail=…&date=…         ONE order, unmasked — line items, POD, instructions, contact
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
  isFirestoreEnabled, getDoc, listDocs, etDayString, readStopDoc, readStops, readAddressChanges,
} from './lib/firestore.mts';
import { getStop as getSealedStop, listStops as listSealedStops } from './lib/history-store.mts';
import { lookupProDays, proIndexEnabled } from './lib/history-pro-index.mts';
import { getCustomerByMatchKey, queryCustomersByName, readTallyRange } from './lib/history-customers.mts';
import { selectAddressChanges } from './lib/address-history.mts';
import { CUSTOMER_STOP_FIELDS } from './lib/board-fields.mts';
import { stopCustomerKey } from './lib/customer-key.mts';
import { isMirrorDeploy } from './lib/mirror-guard.mts';
import { selectWriteRows } from './nuvizz-stop-explain.mts';
import { requireUser } from './lib/require-user.mts';
import { resolveRange, selectionFromParams } from '../../src/lib/history-range.js';
import {
  buildStopDossier, buildCustomerView, buildCustomerYear, buildOrderDetail, classifyQuery,
  stopIdVariants, notesSummary, isDayId, customerNameKey, nameMatchesQuery, promptedCallAvailability,
} from '../../src/lib/stop-lookup.js';

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

/**
 * THE CUSTOMER WINDOW'S OWN CEILING, and why it is not history-range's 60.
 *
 * Every other screen that uses resolveRange reads ONE document per day (a day's flag rows, a
 * day's address log), so sixty days is sixty gets. This reads a whole BOARD per day — ~700
 * stop documents, twice over (live and sealed), to keep the handful that match one customer.
 * Sixty days would be ~84,000 document reads to answer "did we deliver to them last month",
 * and it would sit there while a customer waits on the phone.
 *
 * Fourteen is the Map's own carry-over reach, so it is the span the rest of the app already
 * treats as "recent", and it covers the question this screen was built for several times
 * over. Older than that is what the per-customer rollup below is for: one small document,
 * free, with the driver on every row.
 */
const CUSTOMER_MAX_DAYS = 14;
const CUSTOMER_DEFAULT_DAYS = 7;

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

  // ── CUSTOMER MODE — "how many deliveries for EARTHLY ALTERNATIVE today?" ───
  //
  // Chad, 2026-09-18: "I wanted to see how many deliveries we had for earthly alternative
  // today and couldn't. Wanted to see all the different ones and drivers who delivered them."
  //
  // THE FIRST BUILD ANSWERED THIS WITH THE ROLLUP AND COULD NOT HAVE BEEN RIGHT. history_
  // customers is built from SEALED history, and today is not sealed until tonight — so the
  // one day he asked about is the one day that document structurally cannot contain. It would
  // have said "no deliveries" about a customer we had been to three times that morning.
  //
  // So this sweeps the LIVE BOARD, day by day over a bounded window, and keeps the stops whose
  // business name matches. Board rows carry no customerMatchKey (routing-cleanup-core.mts says
  // so outright), so the match is on the NAME, normalised by the same rule the match key uses.
  // The sealed warehouse is swept alongside it for the same days: the seal is the record that
  // cannot change again, and a past day with only a board copy is a day the capture missed —
  // both facts belong on the row rather than being flattened away.
  // ── ?detail=<stop>&date=<day> — ONE ORDER, EVERYTHING ON IT ───────────────
  //
  // Chad, on the first cut of this screen: "You can't click on the order. You can't get any
  // details on each order or the customer."
  //
  // He was right, and the shape of the miss matters. The customer sweep reads a MASKED stop
  // (CUSTOMER_STOP_FIELDS) because it touches a whole board per day and must stay lean — so
  // the line items, the delivery instructions, the comment trail and the on-order contact are
  // deliberately not in it. Those are exactly what a rep needs once they have found the order.
  //
  // So detail is a SEPARATE, TARGETED read: one stop, one day, UNMASKED. One or two document
  // reads, paid only when somebody actually opens an order. Widening the sweep's mask instead
  // would have put a megabyte of line items and comment threads on every customer lookup to
  // serve the one row somebody eventually clicks.
  //
  // Sealed first, board second, and the answer says which — the seal cannot change again,
  // while a board copy is live and a delivery time read off it may still move.
  if (!stopRaw && url.searchParams.get('detail')) {
    const want = String(url.searchParams.get('detail') || '').trim();
    const day = String(url.searchParams.get('date') || '').trim();
    if (!want) return J({ ok: false, error: 'pass ?detail=<stop number>' }, 400);
    if (!isDayId(day)) return J({ ok: false, error: 'date must be YYYY-MM-DD' }, 400);
    const ids = stopIdVariants(want);

    const sealedR = await tryRead(() => firstHit(ids, (id) => getSealedStop(TENANT, day, id)), null as any);
    const boardR = sealedR.value
      ? { value: null as any, read: true, error: null }
      : await tryRead(() => firstHit(ids, (id) => readStopDoc(TENANT, day, id)), null as any);
    const stop = sealedR.value || boardR.value;

    if (!stop) {
      return J({
        ok: true, nuvizzCalls: 0, mode: 'detail', date: day, stopNbr: want, stop: null,
        source: null, complete: sealedR.read && boardR.read,
        error: sealedR.error || boardR.error || null,
        note: 'Firestore only — nothing here spent a NuVizz call.',
      });
    }

    // The customer's own note, joined by the DERIVED key — the board carries none, and this
    // is what puts receiving hours and the dock instructions beside the order.
    const key = stopCustomerKey(stop);
    const noteR = key ? await tryRead(() => getDoc(`customer_notes/${key}`), null as any)
      : { value: null as any, read: 'skipped' as const, error: 'no customer key on this record' };

    return J({
      ok: true, nuvizzCalls: 0, mode: 'detail', date: day, stopNbr: want,
      source: sealedR.value ? 'sealed' : 'board',
      stop: buildOrderDetail(stop, { date: day, today, source: sealedR.value ? 'sealed' : 'board' }),
      note: notesSummary(noteR.value),
      matchKey: key,
      complete: sealedR.read && boardR.read,
      errors: Object.fromEntries(Object.entries({ sealed: sealedR.error, board: boardR.error, notes: noteR.error }).filter(([, v]) => v)),
      noteText: 'Firestore only — nothing here spent a NuVizz call.',
    });
  }

  // ── ?year=2026 — A YEAR WITHOUT READING A YEAR OF BOARDS ───────────────────
  //
  // Chad, 2026-09-19: "I want there to be a this year button in the date ranges."
  //
  // The window path below sweeps a whole board per day, twice — ~1,400 document reads per day
  // of window. A year of that is ~510,000 reads: it would not finish inside this function's 26
  // seconds, and nobody holds a phone that long. A button that times out is worse than no
  // button, so the year is READ rather than swept.
  //
  // lib/history-customers.mts counts four numbers per month into the per-customer rollup as
  // the nightly post-seal hook passes over each sealed day. This costs ONE DOCUMENT per dock,
  // and it makes NO board reads at all — which is why it is handled before the sweep is even
  // set up rather than as a wider case of it.
  //
  // THE MONTHS IT HAS NOT COUNTED ARE REPORTED AS UNCOUNTED, NEVER AS ZERO. A rollup written
  // before the tally shipped has no months at all, and that is indistinguishable from a
  // customer we never delivered to unless the answer says so. Backfill with
  // nuvizz-rebuild-customer-history-background (?from=&to=), a month at a time.
  if (!stopRaw && nameRaw && url.searchParams.get('year')) {
    const year = String(url.searchParams.get('year') || '').trim();
    if (!/^\d{4}$/.test(year)) return J({ ok: false, error: 'year must be YYYY' }, 400);

    const matchedR = await tryRead(() => queryCustomersByName(nameRaw, NAME_RESULTS), [] as any[]);
    const wantKey = String(url.searchParams.get('nameKey') || '').trim();
    const mine = matchedR.value.filter((c: any) => {
      const k = customerNameKey(c?.name);
      return k && (wantKey ? k === wantKey : true);
    });
    // Distinct businesses, so the chooser rule matches the window path's exactly.
    const names = [...new Set(mine.map((c: any) => customerNameKey(c?.name)).filter(Boolean))];
    if (!wantKey && names.length > 1) {
      return J({
        ok: true, nuvizzCalls: 0, mode: 'customer-choose', query: nameRaw, today, year,
        complete: matchedR.read,
        matches: names.map((k) => {
          const first = mine.find((c: any) => customerNameKey(c?.name) === k);
          return { name: first?.name || nameRaw, nameKey: k, stops: 0, today: 0, lastDate: first?.lastDate ?? null, source: 'rollup' };
        }),
        note: 'Firestore only — nothing here spent a NuVizz call.',
      });
    }

    const chosenName = mine[0]?.name || nameRaw;
    // THE TALLY'S OWN RANGE — one document, the first and last sealed day the month count has
    // been run over for everyone. It is what lets a month with no bucket be called a real zero
    // (lib/history-customers.mts, TALLY_RANGE_PATH); without it the year falls back to the
    // per-dock floor, which can only ever say "since this customer's first delivery".
    const tallyR = await tryRead(() => readTallyRange(), null as any);
    const view = buildCustomerYear({ year, today, customers: mine, tally: tallyR.value });
    return J({
      ok: true, nuvizzCalls: 0, mode: 'customer-year', query: nameRaw, today, year,
      name: chosenName, nameKey: customerNameKey(chosenName),
      view,
      sources: [
        { key: 'customer', label: 'Customer rollup', where: 'history_customers',
          note: `${mine.length} location document${mine.length === 1 ? '' : 's'} — the year is counted nightly, not swept`,
          looked: matchedR.read, count: mine.length, found: matchedR.read && mine.length > 0,
          state: matchedR.read ? (mine.length ? 'found' : 'empty') : 'unread' },
        { key: 'tally', label: 'Tally range', where: 'nuvizz_ops/customer_history_tally',
          note: tallyR.value ? `counted for everyone from ${tallyR.value.monthsFrom}${tallyR.value.countedThrough ? ` through ${tallyR.value.countedThrough}` : ''}` : 'no range on file — the floor falls back to this customer\'s first counted day',
          looked: tallyR.read, count: tallyR.value ? 1 : 0, found: !!tallyR.value,
          state: tallyR.read ? (tallyR.value ? 'found' : 'empty') : 'unread' },
        // NAMED, not omitted. The year deliberately reads NO board or warehouse day — that is
        // the whole design — and a ledger that simply left them out would look like an
        // oversight rather than a decision.
        { key: 'board', label: "Today's board", where: 'nuvizz_stop_index/…/stops',
          note: 'not read for a year — that is ~510,000 documents; pick Today / 7 / 14 days for stop-by-stop detail',
          looked: 'skipped', count: 0, found: false, state: 'skipped' },
        { key: 'sealed', label: 'Sealed history', where: 'history_days/…/stops',
          note: 'not read for a year, for the same reason — its counts are folded into the rollup nightly instead',
          looked: 'skipped', count: 0, found: false, state: 'skipped' },
      ],
      errors: Object.fromEntries(Object.entries({ customer: matchedR.error, tally: tallyR.error }).filter(([, v]) => v)),
      note: 'Firestore only — nothing here spent a NuVizz call.',
    });
  }

  if (!stopRaw && nameRaw) {
    const sel = selectionFromParams((k: string) => url.searchParams.get(k));
    // The screen and this endpoint resolve the identical selection through the identical
    // module, so the header can never describe one window over rows from another.
    const asked = resolveRange(sel.kind === 'days' && !url.searchParams.get('days')
      ? { kind: 'days', days: CUSTOMER_DEFAULT_DAYS } : sel, today, 0);
    // …and then this screen's OWN ceiling is applied on top, because a day here is a whole
    // board rather than one document. Named in the response so the header says it was clamped
    // rather than quietly showing a shorter window than the one that was asked for.
    const span = Math.max(1, Math.round((Date.parse(`${asked.to}T12:00:00Z`) - Date.parse(`${asked.from}T12:00:00Z`)) / 86400000) + 1);
    const clampedDays = Math.min(span, CUSTOMER_MAX_DAYS);
    const from = clampedDays === span ? asked.from : addDays(asked.to, -(clampedDays - 1));
    const window = { from, to: asked.to, days: clampedDays, kind: asked.kind, clamped: clampedDays !== span ? `${span} days asked, ${CUSTOMER_MAX_DAYS} is this screen's ceiling` : (asked.clamped || null) };
    const days = uniqDays(Array.from({ length: clampedDays }, (_, i) => addDays(window.to, -i)));

    // ── the sweep: the live board and the sealed warehouse, in parallel ──────
    const [boardSweep, sealedSweep] = await Promise.all([
      tryRead(async () => {
        const per = await Promise.all(days.map(async (date) => {
          const { stops } = await readStops(TENANT, date, { mask: CUSTOMER_STOP_FIELDS });
          return (stops || []).filter((st: any) => nameMatchesQuery(st?.businessName, nameRaw)).map((stop: any) => ({ date, source: 'board', stop }));
        }));
        return per.flat();
      }, [] as any[]),
      tryRead(async () => {
        const per = await Promise.all(days.map(async (date) => {
          const stops = await listSealedStops(TENANT, date, { mask: CUSTOMER_STOP_FIELDS });
          return (stops || []).filter((st: any) => nameMatchesQuery(st?.businessName, nameRaw)).map((stop: any) => ({ date, source: 'sealed', stop }));
        }));
        return per.flat();
      }, [] as any[]),
    ]);
    const swept = [...boardSweep.value, ...sealedSweep.value];

    // ── WHICH CUSTOMER DID THEY MEAN? ────────────────────────────────────────
    //
    // "earthly" can match more than one business, and a screen that silently picks one and
    // reports its count as the answer is worse than one that asks. Distinct NAMES are offered;
    // distinct ADDRESSES are not, because one customer with two docks is still one customer to
    // the rep on the phone and the view lists their locations underneath.
    const byName = new Map<string, { name: string; nameKey: string; stops: number; today: number; lastDate: string | null; source: string }>();
    const note = (name: string, date: string, source: string) => {
      const key = customerNameKey(name);
      if (!key) return;
      const cur = byName.get(key) || { name, nameKey: key, stops: 0, today: 0, lastDate: null as string | null, source };
      if (date) { cur.stops += 1; if (date === today) cur.today += 1; if (!cur.lastDate || date > cur.lastDate) cur.lastDate = date; }
      byName.set(key, cur);
    };
    for (const r of swept) note(String(r.stop?.businessName ?? ''), r.date, 'board');

    // The rollup is consulted too — a customer with no stop in the window still has to be
    // FINDABLE, or "we have not been there recently" reads identically to "no such customer".
    const rollupR = await tryRead(() => queryCustomersByName(nameRaw, NAME_RESULTS), [] as any[]);
    for (const c of rollupR.value) {
      const key = customerNameKey(c?.name);
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, { name: c.name, nameKey: key, stops: 0, today: 0, lastDate: c?.pros?.[0]?.date ?? null, source: 'rollup' });
    }

    const matches = [...byName.values()].sort((a, b) => b.today - a.today || b.stops - a.stops || String(b.lastDate ?? '').localeCompare(String(a.lastDate ?? '')));
    const wantKey = String(url.searchParams.get('nameKey') || '').trim();
    // Both sweeps have to have worked for a name list to mean anything.
    const sweepComplete = boardSweep.read === true && sealedSweep.read === true;

    // ── WHICH CUSTOMER, AND WHEN TO ASK ──────────────────────────────────────
    //
    // The chooser appears ONLY when two or more distinct businesses genuinely matched. Every
    // other case builds a view:
    //
    //   • one match, or one pinned          → that customer
    //   • NO match                          → a view for the name as typed, with zero stops.
    //     "We have not been to EARTHLY ALTERNATIVE this week" and "no such customer" are
    //     different answers and the ledger underneath is what tells them apart; an empty
    //     chooser says neither.
    //   • a sweep FAILED                    → likewise a view, so the failure is on screen.
    //     This is the case the first cut got wrong: a 500 on the board read emptied `matches`,
    //     the chooser came back with nothing in it, and the screen said "no customer matches"
    //     about a customer we deliver to every week. A rep repeats that to the person on the
    //     phone. A read that broke must never render as a customer that does not exist.
    const chosen = wantKey
      ? matches.find((m) => m.nameKey === wantKey) || { name: nameRaw, nameKey: wantKey, stops: 0, today: 0, lastDate: null, source: 'typed' }
      : matches.length === 1
        ? matches[0]
        : matches.length === 0
          ? { name: nameRaw, nameKey: customerNameKey(nameRaw), stops: 0, today: 0, lastDate: null, source: 'typed' }
          : null;

    if (!chosen) {
      return J({
        ok: true, nuvizzCalls: 0, mode: 'customer-choose', query: nameRaw, today, window,
        matches, complete: sweepComplete,
        errors: Object.fromEntries(Object.entries({
          board: boardSweep.error, sealed: sealedSweep.error, rollup: rollupR.error,
        }).filter(([, v]) => v)),
        note: 'Firestore only — nothing here spent a NuVizz call.',
      });
    }

    const mine = swept.filter((r) => customerNameKey(String(r.stop?.businessName ?? '')) === chosen.nameKey);

    // ── the customer's own documents, joined by the DERIVED key ──────────────
    //
    // stopCustomerKey derives name+addr+city+zip rather than trusting a stored field, because
    // the board does not carry one — customer-key.mts exists because an alert once read 778
    // board rows with matchKey null on every one and reported a clean day.
    const keys = [...new Set(mine.map((r) => stopCustomerKey(r.stop)).filter(Boolean) as string[])].slice(0, 6);
    const [rollupsR, notesR] = await Promise.all([
      tryRead(async () => {
        const got = await Promise.all(keys.map((k) => getCustomerByMatchKey(TENANT, k).catch(() => null)));
        const fromKeys = got.filter(Boolean) as any[];
        // A customer whose only stops are in the window has no key from the sweep — fall back
        // to the rollup's own name match so their older deliveries still show.
        const byName2 = rollupR.value.filter((c: any) => customerNameKey(c?.name) === chosen.nameKey);
        const seenK = new Set(fromKeys.map((c) => c.matchKey));
        return [...fromKeys, ...byName2.filter((c: any) => !seenK.has(c.matchKey))];
      }, [] as any[]),
      tryRead(async () => {
        const got = await Promise.all(keys.map((k) => getDoc(`customer_notes/${k}`).catch(() => null)));
        // One note per dock; the first that carries anything is the one worth showing beside a
        // customer-wide answer, and its key rides along so the screen can say which dock.
        const hit = got.map((doc, i) => ({ key: keys[i], doc })).find((x) => x.doc && Object.keys(x.doc).length);
        return hit ? { ...hit.doc, _key: hit.key } : null;
      }, null as any),
    ]);

    // Older than the window: the rollup's most recent deliveries, with the driver on each.
    // Free (one small document per dock) and the honest answer to "when were you here before".
    const recent = rollupsR.value
      .flatMap((c: any) => (c?.pros || []).map((p: any) => ({ pro: p.pro, date: p.date, driver: p.driver ?? null, location: c.addr1 ?? null })))
      .filter((p: any) => p.pro && p.date && !(p.date >= window.from && p.date <= window.to))
      .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 40);

    const view = buildCustomerView({
      query: nameRaw, name: chosen.name, today, window,
      stops: mine, recent, notes: notesR.value, matches,
      sources: [
        { key: 'board', label: "Today's board", where: 'nuvizz_stop_index/…/stops', note: `${days.length} day${days.length === 1 ? '' : 's'} swept, ${window.from} → ${window.to}`,
          looked: boardSweep.read, count: boardSweep.value.length, found: boardSweep.read && boardSweep.value.length > 0, state: boardSweep.read ? (boardSweep.value.length ? 'found' : 'empty') : 'unread' },
        { key: 'sealed', label: 'Sealed history', where: 'history_days/…/stops', note: 'the same days, from the immutable nightly capture',
          looked: sealedSweep.read, count: sealedSweep.value.length, found: sealedSweep.read && sealedSweep.value.length > 0, state: sealedSweep.read ? (sealedSweep.value.length ? 'found' : 'empty') : 'unread' },
        { key: 'customer', label: 'Customer rollup', where: 'history_customers', note: 'deliveries older than the window, with their drivers',
          looked: rollupsR.read, count: recent.length, found: rollupsR.read && recent.length > 0, state: rollupsR.read ? (recent.length ? 'found' : 'empty') : 'unread' },
        { key: 'notes', label: 'Dispatcher notes', where: 'customer_notes', note: keys.length ? `joined on ${keys.length} derived customer key${keys.length === 1 ? '' : 's'}` : 'no stop to derive a customer key from',
          looked: keys.length ? notesR.read : 'skipped', count: notesR.value ? 1 : 0, found: !!notesR.value, state: !keys.length ? 'skipped' : notesR.read ? (notesR.value ? 'found' : 'empty') : 'unread' },
      ],
    });

    return J({
      ok: true, nuvizzCalls: 0, mode: 'customer', query: nameRaw, today, window,
      // `complete` is what licenses the screen to say "we were not there" rather than "we
      // could not finish looking" — the same distinction the per-order view draws, and for
      // the same reason: only one of the two is a fact a rep may pass on to a customer.
      view: { ...view, complete: sweepComplete, notes: notesSummary(notesR.value) },
      errors: Object.fromEntries(Object.entries({
        board: boardSweep.error, sealed: sealedSweep.error, customer: rollupsR.error, notes: notesR.error, rollup: rollupR.error,
      }).filter(([, v]) => v)),
      note: 'Firestore only — nothing here spent a NuVizz call.',
      // A NAME CANNOT BE PROMPTED. NuVizz has no endpoint that takes a customer name — every
      // list-style endpoint demands a per-record id (lib/nuvizz-scan.mts, verified live) — so
      // the screen says that outright on an empty customer instead of offering a button that
      // cannot work. A PRO can be prompted; that is the sentence the empty state points at.
      promptedCall: { available: false, reason: 'name', text: 'NuVizz cannot be searched by customer name — if you have a PRO or stop number, look that up and the screen can ask NuVizz for it.' },
    });
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
    // WHETHER THE SCREEN MAY OFFER THE PROMPTED CALL (stop-lookup-prompted.mts) after a complete
    // miss — judged here, off the same env this deployment would refuse on, so the button never
    // shows where it would fail for a configuration reason. Reading env is not calling anyone:
    // this file still imports nothing that can spend a call.
    promptedCall: promptedCallAvailability({
      promptedSwitch: process.env.STOP_LOOKUP_PROMPTED_CALL, scansSwitch: process.env.NUVIZZ_SCANS_ENABLED, mirror: isMirrorDeploy(),
    }),
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
