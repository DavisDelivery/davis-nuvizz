// lib/stop-explain.mts — WHY DOES THE BOARD SHOW THIS STOP THE WAY IT DOES? (pure)
//
// Chad, 2026-09-10, two orders sitting in the Routing selection — AVRT-0170416694 on
// WILLIAM's side of McDonough, RA5732712 on JOE's side of Forest Park — that NuVizz held on
// WILLIAM and JOE: "our system does not show this, you need to figure out why."
//
// From the code alone there were SEVEN ways a stop NuVizz holds on a load can read un-planned
// on our board, and no way to tell which one had happened without reading the board's own
// documents: the list reported it un-planned and nothing had ever held it planned; the list
// stopped returning it and the verify dropped the carried plan on a lagging stop record; the
// verify never got to ask the load because the roster had no load by that name; a Save's
// write-through never landed (the stop sat on another day's doc and the rescue missed it); the
// plan was stamped on one day's doc while the Map served another day's copy; a second NuVizz
// record shares the number and the un-planned twin won the merge; or a confirmed un-plan from a
// card was defended by the write grace. Every one of those leaves an identical grey pin.
//
// This module turns the documents into an answer. It is PURE — the endpoint gathers the facts
// (every copy of the stop across the board days around the date, the open-order pool's row,
// the un-planned snapshot, the retired list, the dispatcher-set date, the scan's verdict ledger,
// the write journal, the roster, sealed history) and this decides what they mean, in sentences
// a dispatcher can act on. Zero NuVizz calls anywhere in this path: the whole point is that the
// question is answerable for free, before anyone spends a call on it.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TERMINAL = new Set(['DELIVERED', 'EXCEPTION', 'CANCELLED']);

export interface StopCopy {
  day: string;
  /** the stored row on that day's board document, or null when the day holds no copy */
  row: any | null;
  /** that day document's own scan stamp (meta.last_scanned_at), when read */
  scannedAt?: string | null;
}
export interface StopFacts {
  stopNbr: string;
  /** the board day the question is about (ET) */
  date: string;
  /** ET today, so a future or frozen day can be named as such */
  today: string;
  copies: StopCopy[];
  pool: { at: string; windowStart: string; windowEnd: string; thin: boolean; row: any | null } | null;
  snapshot: { at: string | null; windowStart: string | null; thin: boolean; listed: boolean } | null;
  /** the retired list's entry (the day history proved it finished), when any */
  retiredOn: string | null;
  /** the dispatcher-set board date (setStopDate), when any */
  override: string | null;
  /** the scan's plan-verdict ledger rows for THIS stop, newest first */
  verdicts: any[];
  /** write-journal rows that mention the stop (or its route on this day), newest first */
  writes: Array<{ at: string; op: string; status: string; summary: string }>;
  /** the board day's cached load roster */
  roster: { at: string | null; loads: Array<{ name: string; loadNbr: string | null; status: string | null }> } | null;
  /** a sealed history record for the stop on a recent prior day, when terminal */
  history: { day: string; status: string } | null;
}

export interface StopExplanation {
  stopNbr: string;
  date: string;
  /** what the Map feed would serve for `date`: the day's own copy, a carry-over, or nothing */
  served: { source: 'day-doc' | 'carry-over' | 'none'; day: string | null };
  plan: { isPlanned: boolean | null; isUnplanned: boolean | null; route: string | null; seq: number | null; driver: string | null; status: string | null; normalizedStatus: string | null } | null;
  stamps: Record<string, any> | null;
  copies: Array<{ day: string; planned: boolean | null; route: string | null; status: string | null; scannedAt: string | null; writeAt: string | null; verifiedAt: string | null; absentFromPull: boolean; heal: string | null; carryover: boolean }>;
  pool: { at: string; listed: boolean; day: string | null; planned: boolean | null; route: string | null; thin: boolean } | null;
  snapshot: { at: string | null; listed: boolean; thin: boolean } | null;
  roster: { route: string | null; resolution: 'resolved' | 'ambiguous' | 'no-such-load' | 'no-roster' | 'no-route'; loadNbr: string | null; status: string | null; rosterAt: string | null };
  verdicts: any[];
  writes: StopFacts['writes'];
  history: StopFacts['history'];
  retiredOn: string | null;
  override: string | null;
  /** the answer, most important sentence first */
  findings: string[];
}

const norm = (v: any) => String(v ?? '').trim();
const routeOf = (row: any): string | null => { const r = norm(row?.routeName || row?.loadNbr); return r || null; };
const isFinished = (row: any) => TERMINAL.has(norm(row?.normalizedStatus).toUpperCase()) || ['90', '91', '80', '99'].includes(norm(row?.status));
const ownDay = (row: any): string | null => { const d = row?.boardDate || row?.requestedDate || row?.scheduledDate || null; return typeof d === 'string' && DAY_RE.test(d) ? d : null; };
const clock = (iso: any): string => {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return String(iso ?? '?');
  // ET wall clock, the clock every other stamp in the app is read in.
  try { return new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return String(iso); }
};
export const sameNbr = (a: any, b: any): boolean => {
  const n = (v: any) => norm(v).toUpperCase().replace(/^0+(?=\d)/, '');
  return !!n(a) && n(a) === n(b);
};

/** Which roster load a route NAME resolves to — the same rule the verify applies. */
export function resolveRouteOnRoster(route: string | null, roster: StopFacts['roster']): StopExplanation['roster'] {
  const rosterAt = roster?.at ?? null;
  if (!route) return { route: null, resolution: 'no-route', loadNbr: null, status: null, rosterAt };
  if (!roster) return { route, resolution: 'no-roster', loadNbr: null, status: null, rosterAt };
  const hits = (roster.loads || []).filter((l) => norm(l?.name).toLowerCase() === route.toLowerCase());
  if (!hits.length) return { route, resolution: 'no-such-load', loadNbr: null, status: null, rosterAt };
  if (hits.length > 1) return { route, resolution: 'ambiguous', loadNbr: null, status: null, rosterAt };
  return { route, resolution: 'resolved', loadNbr: hits[0].loadNbr ?? null, status: hits[0].status ?? null, rosterAt };
}

/** The copy the Map feed would serve for `date`: the day's own document first (a finished row
 *  filed under an earlier day is stripped at serve time, as the feed does), else the newest
 *  OPEN, UN-PLANNED copy on a prior day inside the carry-over reach — what the fold would
 *  offer, before the pool/snapshot have their say. */
export function servedCopy(copies: StopCopy[], date: string): { source: StopExplanation['served']['source']; copy: StopCopy | null } {
  const own = copies.find((c) => c.day === date && c.row);
  if (own) {
    const d = ownDay(own.row);
    if (!(isFinished(own.row) && d && d < date)) return { source: 'day-doc', copy: own };
  }
  const prior = copies
    .filter((c) => c.row && c.day < date && !isFinished(c.row) && c.row.isUnplanned === true)
    .sort((a, b) => (a.day < b.day ? 1 : -1));
  if (prior.length) return { source: 'carry-over', copy: prior[0] };
  return { source: 'none', copy: null };
}

export function explainStop(f: StopFacts): StopExplanation {
  const copies = (f.copies || []).filter((c) => c && DAY_RE.test(c.day)).slice().sort((a, b) => (a.day < b.day ? -1 : 1));
  const served = servedCopy(copies, f.date);
  const row = served.copy?.row ?? null;
  const plan = row ? {
    isPlanned: row.isPlanned === true ? true : row.isPlanned === false ? false : null,
    isUnplanned: row.isUnplanned === true ? true : row.isUnplanned === false ? false : null,
    route: routeOf(row), seq: typeof row.routeSeq === 'number' ? row.routeSeq : null,
    driver: norm(row.driverName || row.driverUserName) || null,
    status: row.status != null ? String(row.status) : null, normalizedStatus: row.normalizedStatus ?? null,
  } : null;
  const stamps = row ? {
    lastScannedAt: served.copy?.scannedAt ?? null,
    boardWriteAt: row.board_write_at ?? null, boardWritePlanned: row.board_write_planned ?? null,
    planVerifiedAt: row.plan_verified_at ?? null, absentFromPull: row.absentFromPull === true,
    frozenHeal: row.frozen_heal_reason ? `${row.frozen_heal_reason} at ${row.frozen_heal_at ?? '?'}` : null,
    refiledFrom: row.refiledFrom ?? null, carryover: row.carryover === true, poolSynced: row.poolSynced === true,
    dupNbr: row.dupNbr === true || row.dupNbrSuspect === true, dupNbrOtherId: row.dupNbrOtherId ?? null,
    stopId: row.stopId ?? null, source: row.source ?? null, boardDate: row.boardDate ?? null,
  } : null;
  const poolRow = f.pool?.row ?? null;
  const pool = f.pool ? {
    at: f.pool.at, listed: !!poolRow, day: poolRow?.day ?? null,
    planned: poolRow ? poolRow.isPlanned === true : null, route: poolRow ? routeOf(poolRow) : null, thin: f.pool.thin === true,
  } : null;
  const snapshot = f.snapshot ? { at: f.snapshot.at, listed: f.snapshot.listed, thin: f.snapshot.thin } : null;
  const latestVerdict = (f.verdicts || [])[0] ?? null;
  const routeInQuestion = plan?.route ?? latestVerdict?.route ?? pool?.route ?? null;
  const roster = resolveRouteOnRoster(routeInQuestion, f.roster);

  const findings: string[] = [];
  const say = (s: string) => { if (s) findings.push(s); };
  const dayWord = f.date === f.today ? 'today' : f.date > f.today ? `${f.date} (a future day)` : `${f.date} (a past, frozen day)`;

  // ── 1. What the board serves for the day, and where it came from ─────────────
  if (served.source === 'none') {
    say(`${f.stopNbr} is on NO board document for ${dayWord}, and no prior day inside the carry-over reach holds it open and un-planned — so the ${f.date} Map does not show it at all.`);
    const elsewhere = copies.filter((c) => c.row);
    if (elsewhere.length) say(`It is filed on ${elsewhere.map((c) => `${c.day} (${describe(c.row)})`).join(', ')}.`);
  } else if (served.source === 'carry-over') {
    say(`${f.stopNbr} is NOT on the ${f.date} board document. The Map reaches it only as a carry-over from ${served.copy!.day}, where its copy reads ${describe(row)} — and a carry-over is served only while the open-order pool (or the un-planned snapshot) still lists it open and un-planned.`);
  } else {
    say(`On the ${f.date} board document ${f.stopNbr} reads ${describe(row)}${stamps?.lastScannedAt ? ` — written by the scan at ${clock(stamps.lastScannedAt)}` : ''}.`);
  }

  // ── 2. The plan's provenance ───────────────────────────────────────────────
  if (row) {
    if (plan!.isPlanned === true) {
      if (stamps!.boardWriteAt && stamps!.boardWritePlanned === true) say(`A confirmed Save stamped it planned on ${plan!.route ?? '?'} at ${clock(stamps!.boardWriteAt)} (the write-through); the scan has ${stamps!.planVerifiedAt ? `since had NuVizz confirm the plan (${clock(stamps!.planVerifiedAt)})` : 'not needed to verify it'}.`);
      else if (stamps!.planVerifiedAt) say(`NuVizz's list disagreed with this plan at some point and the scan asked NuVizz itself — the plan was confirmed at ${clock(stamps!.planVerifiedAt)}.`);
    } else {
      // Un-planned on the board. Which of the ways did it get there?
      if (stamps!.absentFromPull) {
        say(`The last scan did NOT get ${f.stopNbr} back from NuVizz's planned/un-planned saved search at all; the board carried it forward as a demote candidate and asked NuVizz to justify the plan.`);
      }
      if (stamps!.boardWriteAt && stamps!.boardWritePlanned === false) {
        say(`A confirmed Save UN-PLANNED it at ${clock(stamps!.boardWriteAt)} — it was struck off a Compare card and the write-through recorded that; the scan defends that stamp for an hour.`);
      }
      if (latestVerdict) {
        const v = latestVerdict;
        if (v.verdict === 'dropped') say(`${clock(v.at)}: the scan took it OFF ${v.route ?? 'its route'} — ${v.detail}${v.path?.length > 1 ? ` (steps: ${v.path.join(' → ')})` : ''}.`);
        else if (v.verdict === 'held') say(`${clock(v.at)}: the scan HELD it on ${v.route ?? 'its route'} (${v.detail}) — but the copy served now is un-planned, so a later write changed it${stamps!.lastScannedAt ? ` (last scan write ${clock(stamps!.lastScannedAt)})` : ''}.`);
        else if (v.verdict === 'kept') say(`${clock(v.at)}: NuVizz confirmed it on ${v.route ?? 'its route'} (${v.detail}) — but the copy served now is un-planned, so a later write changed it${stamps!.lastScannedAt ? ` (last scan write ${clock(stamps!.lastScannedAt)})` : ''}.`);
      } else if (!stamps!.absentFromPull && !(stamps!.boardWriteAt && stamps!.boardWritePlanned === false)) {
        say(`NuVizz's planned/un-planned saved search reported it un-planned (status ${plan!.status ?? '?'}) and the board had never held it planned, so there was nothing to verify: the list is the ONLY source that can put a stop on a route, and if the list lags the portal by minutes or hours the board lags with it. A confirmed Save from this app would have stamped it regardless — none is recorded for it.`);
      }
      if (stamps!.dupNbr) say(`Two NuVizz records share this number (other record ${stamps!.dupNbrOtherId ?? '?'}); the board is showing the copy with id ${stamps!.stopId ?? '?'}. If the OTHER record is the one on the load, the plan lives on a record this row is not.`);
    }
  }

  // ── 3. The pool and the snapshot: what NuVizz listed at the last scan ─────────
  if (pool) {
    if (pool.listed) {
      const poolSays = pool.planned ? `planned on ${pool.route ?? '?'}` : 'un-planned';
      const copySays = plan ? (plan.isPlanned ? `planned on ${plan.route ?? '?'}` : 'un-planned') : null;
      if (copySays && (pool.planned !== (plan!.isPlanned === true) || (pool.planned && pool.route !== plan!.route))) {
        say(`The open-order pool (every open row NuVizz listed at the ${clock(pool.at)} scan) says ${poolSays} under ${pool.day}, while the served copy says ${copySays}: the two disagree. The pool is what the Routing date window and the carry-over fold judge by; the day document is what the Map serves.`);
      } else {
        say(`The open-order pool (${clock(pool.at)} scan) agrees: ${poolSays}, filed under ${pool.day}.`);
      }
    } else {
      say(`The open-order pool (${clock(pool.at)} scan${pool.thin ? ', THIN — not trusted to say what is gone' : ''}) does not list ${f.stopNbr} open at all: NuVizz's active search did not return it${pool.thin ? '' : ', so a carry-over copy of it would be dropped as closed'}.`);
    }
  }
  if (snapshot && snapshot.listed) say(`The un-planned snapshot (${clock(snapshot.at)}) lists it among NuVizz's un-planned stops.`);

  // ── 4. The roster: could the verify have asked the load? ─────────────────────
  if (roster.route) {
    if (roster.resolution === 'resolved') say(`The ${f.date} roster (captured ${roster.rosterAt ? clock(roster.rosterAt) : '?'}) resolves ${roster.route} to ${roster.loadNbr}${roster.status ? ` (${roster.status})` : ''}, so the verify can read that load's own membership.`);
    else if (roster.resolution === 'no-such-load') say(`The ${f.date} roster (captured ${roster.rosterAt ? clock(roster.rosterAt) : '?'}) has NO load named ${roster.route}: the verify cannot ask the load itself and falls back to the stop record, which lags a planning-mode save on an undispatched load by 30+ minutes. A load created after the last roster pull is invisible here until the next one (hourly 04:00–13:00 and 20:00–24:00 ET).`);
    else if (roster.resolution === 'ambiguous') say(`The ${f.date} roster has TWO loads named ${roster.route}; neither may speak for the other, so the verify falls back to the stop record.`);
    else if (roster.resolution === 'no-roster') say(`No load roster is cached for ${f.date} — the verify could only consult the stop record.`);
  }

  // ── 5. Saves, history, overrides ──────────────────────────────────────────────
  if (f.writes?.length) say(`Write journal: ${f.writes.slice(0, 5).map((w) => `${clock(w.at)} ${w.op} ${w.status} — ${w.summary}`).join('; ')}.`);
  if (f.history) say(`Sealed history records it ${f.history.status} on ${f.history.day} — the scan drops a stale open copy of a stop history has sealed finished.`);
  if (f.retiredOn) say(`It is on the retired list (proven finished on ${f.retiredOn}); the carry-over fold will not serve it.`);
  if (f.override) say(`A dispatcher-set board date of ${f.override} is on file; the scan files the order there regardless of NuVizz's arrival date.`);
  const disagreeing = copies.filter((c) => c.row && c.day !== served.copy?.day && !isFinished(c.row) && c.row.isPlanned === true && (!plan || !plan.isPlanned || routeOf(c.row) !== plan.route));
  if (disagreeing.length) say(`Another day's copy still holds it planned: ${disagreeing.map((c) => `${c.day} on ${routeOf(c.row) ?? '?'}`).join(', ')} — a frozen day is never rewritten, so that copy is history, not a plan.`);

  return {
    stopNbr: f.stopNbr, date: f.date,
    served: { source: served.source, day: served.copy?.day ?? null },
    plan, stamps,
    copies: copies.filter((c) => c.row).map((c) => ({
      day: c.day, planned: c.row.isPlanned === true ? true : c.row.isPlanned === false ? false : null, route: routeOf(c.row),
      status: c.row.normalizedStatus ?? (c.row.status != null ? String(c.row.status) : null), scannedAt: c.scannedAt ?? null,
      writeAt: c.row.board_write_at ?? null, verifiedAt: c.row.plan_verified_at ?? null, absentFromPull: c.row.absentFromPull === true,
      heal: c.row.frozen_heal_reason ?? null, carryover: c.row.carryover === true,
    })),
    pool, snapshot, roster,
    verdicts: f.verdicts || [], writes: f.writes || [], history: f.history ?? null,
    retiredOn: f.retiredOn ?? null, override: f.override ?? null,
    findings,
  };
}

/** "planned on WILLIAM (seq 4, Un-Planned → SCHEDULED)" — one row, one phrase. */
export function describe(row: any): string {
  if (!row) return 'nothing';
  const st = row.normalizedStatus ?? (row.status != null ? `status ${row.status}` : 'no status');
  if (isFinished(row)) return `${st}${routeOf(row) ? ` on ${routeOf(row)}` : ''}`;
  if (row.isPlanned === true) return `PLANNED on ${routeOf(row) ?? '?'}${typeof row.routeSeq === 'number' ? ` (stop ${row.routeSeq})` : ''}${row.driverName ? `, ${row.driverName}` : ''}`;
  if (row.isUnplanned === true) return `UN-PLANNED (${st})${routeOf(row) ? ` — yet it still carries the route name ${routeOf(row)}` : ''}`;
  return `${st}${routeOf(row) ? ` on ${routeOf(row)}` : ''} (neither planned nor un-planned)`;
}
