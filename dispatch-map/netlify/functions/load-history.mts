// load-history.mts — EVERY TIME A LOAD WAS SENT TO NUVIZZ, AND WHAT CHANGED.
//
// Chad, 2026-09-16: "we have a new sent to nuvizz tab that records time we sent the loads to
// nuvizz can we design a history of those changes and what changed and everytime a load was
// updated so changes can be tracked and then we design a ui for it to interact with it."
//
// STRICTLY FIRESTORE-ONLY. ZERO NuVizz calls — it reads our own ledger, the same promise
// nuvizz-write-log and address-history make. Safe to hit any time; costs nothing against the
// vendor ceiling, and the response says so in as many words.
//
//   GET ?days=7                 the last N days, newest first (default 7, max 60)
//   GET ?date=YYYY-MM-DD        one board day
//   GET ?from=&to=              an arbitrary window, inclusive
//   GET ?load=ALPHA             one route name or load number (case-insensitive substring)
//   GET ?stop=007175992         only sends that touched this order, ON EITHER SIDE
//   GET ?verdict=refused        only confirmed / partial / refused
//   → { ok, nuvizzCalls: 0, range, summary, days:[{date,count}], rows:[…] }
//
// It REACHES FORWARD, and it has to: a Save at 11pm is building TOMORROW's board and the row
// is filed against that day. A window clamped at today could not ask for the rows it had just
// written — the exact defect that hid twenty address corrections for two sessions (v1.29.0).
//
// The window rule is src/lib/history-range.js — the same module the screen resolves with, so
// the header and the numbers under it can never describe different ranges.

import { isFirestoreEnabled, readLoadSends, etDayString } from './lib/firestore.mts';
import { selectLoadSends, summarizeLoadSends, loadHistoryEnabled } from './lib/load-history.mts';
import { resolveRange, expandRange, selectionFromParams, QUEUE_DAYS_AHEAD } from '../../src/lib/history-range.js';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';
const MAX_ROWS = 1000;
const DEFAULT_DAYS = 7;
const VERDICTS = new Set(['confirmed', 'partial', 'refused']);

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'GET') return J({ ok: false, error: 'GET only' }, 405);

  // THE SWITCH REVERTS BOTH SIDES AT ONCE. With LOAD_HISTORY=off the Save stops recording AND
  // this endpoint says so plainly — a screen quietly asking for days nothing writes any more
  // is a new bug wearing the old feature's name.
  if (!loadHistoryEnabled()) {
    return J({ ok: false, disabled: true, error: 'The load send history is switched off (LOAD_HISTORY=off).' });
  }
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore off — no send history available' });

  // Gate at viewer: this names loads, drivers and order numbers — the same facts the board
  // shows whoever opens it. Inert until AUTH_REQUIRED=true.
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const get = (k: string) => url.searchParams.get(k);
  const sel = selectionFromParams(get);
  if (sel.kind === 'days' && !get('days')) sel.days = DEFAULT_DAYS;
  const range = resolveRange(sel, etDayString(), QUEUE_DAYS_AHEAD);
  if (!range.from || !range.to) return J({ ok: false, error: 'could not resolve a date range' }, 400);

  const verdict = VERDICTS.has(String(get('verdict'))) ? String(get('verdict')) : null;
  const q = { load: get('load'), stop: get('stop'), verdict };
  const limit = Math.min(MAX_ROWS, Math.max(1, Number(get('limit')) || MAX_ROWS));

  const dates = expandRange(range.from, range.to);
  const perDay: Array<{ date: string; count: number }> = [];
  let all: any[] = [];
  let counted: any[] = [];
  try {
    // One document per day, read in parallel — the same shape and cap the address log uses,
    // so a 60-day window is 60 gets and never a collection walk.
    const reads = await Promise.all(dates.map((d) => readLoadSends(TENANT, d).then((rows) => ({ d, rows }))));
    for (const { d, rows } of reads) {
      // The per-day count reports what the CALLER asked for, not the raw document — a strip
      // reading 40 above a list of 3 is a screen arguing with itself.
      const visible = selectLoadSends(rows, q);
      perDay.push({ date: d, count: visible.length });
      all = all.concat(visible);
      // THE SUMMARY IGNORES THE VERDICT FILTER, because the screen's verdict pills ARE that
      // filter and they carry these counts. Summarising the already-filtered rows would zero
      // every other pill the moment one was pressed — the breakdown vanishing exactly when
      // somebody starts using it (the address log's own lesson).
      counted = counted.concat(selectLoadSends(rows, { load: q.load, stop: q.stop }));
    }
  } catch (e: any) {
    return J({ ok: false, error: e?.message || 'send history read failed' }, 500);
  }

  const ordered = selectLoadSends(all, { limit });
  return J({
    ok: true,
    nuvizzCalls: 0,
    range: { from: range.from, to: range.to, days: range.days, clamped: range.clamped },
    summary: summarizeLoadSends(counted),
    matched: all.length,
    truncated: all.length > ordered.length,
    days: perDay,
    rows: ordered,
    note: 'Firestore only — nothing here spent a NuVizz call.',
  });
};
