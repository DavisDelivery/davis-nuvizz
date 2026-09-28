// lib/window-check.mts — "check what we are showing against what NuVizz shows for the same
// filters", as a function.
//
// Chad, after the 09/07 reconciliation: "is there a way we can design a button that checks
// nuvizz's response to the filters and set up that our route workbench has showing … a way to
// do what we just did." This is that, made repeatable. The client sends the filter the grid is
// on (a date range or a NuVizz period, plus the status buckets) AND the rows it is actually
// showing; the endpoint spends ONE live list call for the same filter and diffs the two sets.
//
// Why the client sends its rows instead of the server recomputing them: the diff must be
// WYSIWYG. What is on screen has been through the cache reconcile, the plan overlay, the
// status/driver filters and "Unplanned only" — recomputing that server-side would compare
// NuVizz against a set nobody is looking at.
//
// ONLY OPEN WORK IS COMPARED. Delivered and cancelled rows are history; the unfiltered
// all-status ±7d list is also the one NuVizz call that reliably blows the 22-second budget.
// So the status set is clamped to 10/20/40/50 (unplanned, planned, out for delivery, arrived)
// and the response says so.
//
// The live pull rides the metered requester like every other NuVizz call. PURE diff below;
// the pull is the only I/O and is kept in its own function.

import { getNuvizzRequester } from './nuvizz-request.mts';
import { getCreds, basicAuthHeader } from './nuvizz-scan.mts';
import { buildBody, normalize, cleanPeriod, coveringWindowForRange, rowInRange, rowDay, toBoardStop, boardDayFor, LIST_MAX_RESULT, OPENAPI_BASE } from './nuvizz-list.mts';

export const ACTIVE_CODES = ['10', '20', '40', '50'];

/** PURE: the status codes a check compares — the request's, clamped to open work; none → all four. */
export function checkCodes(requested: any): string[] {
  const want = Array.isArray(requested) ? requested.map((c) => String(c).trim()).filter((c) => ACTIVE_CODES.includes(c)) : [];
  const uniq = [...new Set(want)];
  return uniq.length ? uniq : ACTIVE_CODES.slice();
}

/**
 * PURE: the request asked for statuses, and none of them is open work — a grid filtered to
 * Completed and/or Cancelled. The grid's rows are already filtered to those buckets, so every
 * one of them would be set aside and checkCodes' "none → all four" fallback would compare an
 * EMPTY shown set against all open work: one call spent to list every open order as missing.
 * No statuses at all (the unfiltered window) is not this — that is still all four.
 */
export function closedOnlyRequest(requested: any): boolean {
  if (!Array.isArray(requested)) return false;
  const asked = requested.map((c) => String(c ?? '').trim()).filter(Boolean);
  return asked.length > 0 && !asked.some((c) => ACTIVE_CODES.includes(c));
}

export interface ShownRow {
  stopNbr: string; status?: any; day?: string | null; routeName?: string | null;
  weight?: any; cartons?: any; volume?: any; businessName?: string | null; city?: string | null;
  /** the day of the NuVizz load the scan read holding it (route-load-day `loadDay`, read through
   *  stampedLoadOf) — the board files it there, whatever NuVizz's own arrival date says */
  loadDay?: string | null;
  /** the route of the PAST day's load it is still on in NuVizz while we show it un-planned
   *  (route-load-day `heldOn`, read through heldLoadOf) */
  held?: string | null;
}

const num = (x: any) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const norm = (x: any) => String(x ?? '').trim();
const plannedOf = (status: any, routeName: any): boolean => {
  const c = norm(status);
  if (c === '10') return false;
  if (c === '20' || c === '40' || c === '50') return true;
  return !!norm(routeName);
};

export interface WindowTotals { count: number; unplanned: number; planned: number; weight: number; skids: number; loose: number }

/** PURE: the header numbers for one side — the same four the Workbench header and the
 *  Routing selection panel show (skids = NuVizz cartons, loose = NuVizz volume). */
export function totalsOf(rows: Array<{ status?: any; routeName?: any; weight?: any; cartons?: any; volume?: any; held?: any }>): WindowTotals {
  const t: WindowTotals = { count: 0, unplanned: 0, planned: 0, weight: 0, skids: 0, loose: 0 };
  for (const r of rows || []) {
    t.count++;
    // A held row keeps NuVizz's status code (the record IS still on that load) but we show it
    // un-planned — our side counts it the way the screen shows it.
    if (!norm(r.held) && plannedOf(r.status, r.routeName)) t.planned++; else t.unplanned++;
    t.weight += num(r.weight); t.skids += num(r.cartons); t.loose += num(r.volume);
  }
  t.weight = Math.round(t.weight);
  return t;
}

export interface WindowDiff {
  matches: boolean;
  shown: WindowTotals;
  nuvizz: WindowTotals;
  /** on screen, not in NuVizz's list for these filters */
  stale: any[];
  /** in NuVizz's list, not on screen */
  missing: any[];
  /** on both, but planned-ness, load or day differ */
  changed: any[];
  /** shown un-planned ON PURPOSE: NuVizz lists it planned on the very route whose PAST day's load
   *  still holds it (route-load-day). Not a difference — the reason for one; never counted in
   *  `matches`. */
  held: any[];
}

const pick = (r: any) => ({
  stopNbr: norm(r.stopNbr), businessName: r.businessName ?? null, city: r.city ?? null,
  day: r.day ?? r.boardDate ?? r.scheduledDate ?? null, status: r.status ?? null, routeName: r.routeName ?? null,
  weight: num(r.weight), cartons: num(r.cartons), volume: num(r.volume),
});

/**
 * PURE: shown vs live, by stop number. `changed` compares only what a dispatcher acts on —
 * whether it is planned, which load, which day — never enrichment detail.
 */
export function diffWindow(shown: ShownRow[], live: any[], opts: { all?: any[] | null; today?: string } = {}): WindowDiff {
  // THE BOARD'S OWN DAY for NuVizz's row. NuVizz keeps a rolled-over stop's arrival on the day
  // it first arrived; the board files open route-assigned work on TODAY (boardDayFor's live-route
  // clamp) and the window serves that day. Our day matching the day the board itself would file
  // NuVizz's row on is agreement, not a day change — otherwise every multi-day routed stop in the
  // window reads "changed" with plan, route and status all agreeing.
  const boardDayOfLive = (l: any, rawDay: any) => boardDayFor({ ...l, boardDate: rawDay || l.boardDate || null }, opts.today);
  // …and a day the scan READ off the load itself (the load that holds it runs that day) is
  // agreement too: NuVizz never moves an order's arrival forward when it is planned onto a later load.
  const dayDiffers = (oursDay: any, theirsDay: any, l: any, s?: any) =>
    !!(oursDay && theirsDay && oursDay !== theirsDay && oursDay !== boardDayOfLive(l, theirsDay) && !(s?.loadDay && oursDay === s.loadDay));
  // Held on purpose: we show it un-planned, NuVizz lists it planned on the route we say still holds it.
  const heldAgrees = (s: any, l: any) => !!norm(s?.held) && plannedOf(l?.status, l?.routeName) && norm(l?.routeName).toLowerCase() === norm(s.held).toLowerCase();
  const shownBy = new Map<string, any>();
  for (const s of shown || []) { const k = norm(s?.stopNbr); if (k && !shownBy.has(k)) shownBy.set(k, s); }
  const liveBy = new Map<string, any>();
  for (const l of live || []) { const k = norm(l?.stopNbr); if (k && !liveBy.has(k)) liveBy.set(k, l); }
  // The whole covering pull, before the range filter: a shown row NuVizz now files on a day
  // OUTSIDE this window is a day change, not an order NuVizz no longer lists (v0.95.0).
  const allBy = new Map<string, any>();
  for (const l of opts.all || []) { const k = norm(l?.stopNbr); if (k && !allBy.has(k)) allBy.set(k, l); }
  const stale: any[] = [], missing: any[] = [], changed: any[] = [], held: any[] = [];
  // NuVizz rows whose raw arrival sits outside the window but which the board files inside it
  // (the clamp above) — on both sides, so they count on both sides of the header numbers too.
  const clampedIn: any[] = [];
  for (const [k, s] of shownBy) {
    const l = liveBy.get(k);
    if (!l) {
      const elsewhere = allBy.get(k);
      if (elsewhere && heldAgrees(s, elsewhere)) { held.push({ ...pick(elsewhere), heldOn: norm(s.held) }); continue; }
      if (elsewhere) {
        const ours = { planned: plannedOf(s.status, s.routeName), routeName: norm(s.routeName), day: s.day || null };
        const theirs = { planned: plannedOf(elsewhere.status, elsewhere.routeName), routeName: norm(elsewhere.routeName), day: elsewhere.day || elsewhere.boardDate || null };
        if (ours.planned === theirs.planned && ours.routeName === theirs.routeName && ours.day && theirs.day && ours.day !== theirs.day && !dayDiffers(ours.day, theirs.day, elsewhere, s)) {
          clampedIn.push(elsewhere); continue;
        }
        changed.push({ stopNbr: k, businessName: s.businessName ?? elsewhere.businessName ?? null, ours: { ...ours, status: s.status ?? null }, nuvizz: { ...theirs, status: elsewhere.status ?? null, weight: num(elsewhere.weight) }, movedOut: true });
        continue;
      }
      stale.push(pick(s)); continue;
    }
    if (heldAgrees(s, l)) { held.push({ ...pick(l), heldOn: norm(s.held) }); continue; }
    const ours = { planned: !norm(s.held) && plannedOf(s.status, s.routeName), routeName: norm(s.routeName), day: s.day || null };
    const theirs = { planned: plannedOf(l.status, l.routeName), routeName: norm(l.routeName), day: l.day || l.boardDate || null };
    if (ours.planned !== theirs.planned || ours.routeName !== theirs.routeName || dayDiffers(ours.day, theirs.day, l, s)) {
      changed.push({ stopNbr: k, businessName: s.businessName ?? l.businessName ?? null, ours: { ...ours, status: s.status ?? null }, nuvizz: { ...theirs, status: l.status ?? null, weight: num(l.weight) } });
    }
  }
  for (const [k, l] of liveBy) if (!shownBy.has(k)) missing.push(pick(l));
  const byNbr = (a: any, b: any) => String(a.stopNbr).localeCompare(String(b.stopNbr));
  stale.sort(byNbr); missing.sort(byNbr); changed.sort(byNbr); held.sort(byNbr);
  return {
    matches: !stale.length && !missing.length && !changed.length,
    shown: totalsOf([...shownBy.values()]),
    nuvizz: totalsOf([...liveBy.values(), ...clampedIn]),
    stale, missing, changed, held,
  };
}

export interface LiveWindowPull {
  rows: any[];          // board-shaped (toBoardStop) + `day`
  /** the whole covering pull before the range filter — same shape; === rows for a period pull */
  allRows: any[];
  period: string;
  range: { from: string; to: string } | null;
  covered: { from: string; to: string } | null;
  partial: boolean;
}

/**
 * ONE live list call for a window: the exact pull the explorer's live path makes, minus the
 * count call (a range filters the covering window client-side and counts its own rows). The
 * caller owns the abort signal / time budget.
 */
export async function pullLiveWindow(
  filter: { range?: { from: string; to: string } | null; period?: string | null },
  codes: string[],
  signal?: AbortSignal,
): Promise<LiveWindowPull> {
  const win = filter.range ? coveringWindowForRange(filter.range.from, filter.range.to) : null;
  const period = win ? win.period : cleanPeriod(filter.period);
  const statusCsv = codes.length ? codes.join(',') : ACTIVE_CODES.join(',');
  const { companyCode } = getCreds();
  const hdr = { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json' };
  const payload = JSON.stringify(buildBody(period, statusCsv, 1, LIST_MAX_RESULT));
  const resp = await getNuvizzRequester().request(
    `${OPENAPI_BASE}/entity/filterdata/VizzonStop/${companyCode}`,
    { method: 'POST', headers: hdr, body: payload, signal, maxRetries: 1 },
    { route: '/entity/filterdata', tenant: companyCode },
  );
  if (!resp.ok) throw new Error(`NuVizz returned ${resp.status}`);
  const text = await resp.text();
  let j: any;
  try { j = JSON.parse(text); } catch { throw new Error('NuVizz returned a non-JSON response — the date window may be too large'); }
  const raw = normalize(j);
  const allRows = raw.map((r: any) => ({ ...toBoardStop(r), day: rowDay(r) }));
  const rows = filter.range ? allRows.filter((r: any, i: number) => rowInRange(raw[i], filter.range!.from, filter.range!.to)) : allRows;
  return {
    rows, allRows, period, range: filter.range || null,
    covered: win ? { from: win.from, to: win.to } : null,
    partial: raw.length >= LIST_MAX_RESULT || !!(win && win.clamped),
  };
}
