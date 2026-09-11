// address-history.mts — WHAT HAPPENED TO THIS ADDRESS, AND WHO DID IT.
//
// Chad, 2026-09-11: "can we start having a log of every address that gets changed from the
// initial scan/enrichment ... lets build a history under the more tab."
//
// STRICTLY FIRESTORE-ONLY. This function makes ZERO NuVizz calls — it reads our own ledger,
// the same promise nuvizz-write-log makes. Safe to hit any time; costs nothing against the
// vendor ceiling.
//
//   GET ?days=14                the last N days, newest first (default 14, max 60)
//   GET ?date=YYYY-MM-DD        one day
//   GET ?from=&to=              an arbitrary window, inclusive
//   GET ?stop=007174397         only this order (matches the zero-padded form too)
//   GET ?kind=moved,renamed     only these classes
//   GET ?source=override        only what WE changed, or only what the scan observed
//   GET ?all=1                  include `formatting` rows (hidden by default — see below)
//   → { ok, range, summary, days:[{date,count}], rows:[…] }
//
//   POST { stopNbr, date, before, after, source, … }   record one dispatcher-made change
//
// WHY THE POST EXISTS. The scan's side of this is observed inside writeStops, which sees
// every address the vendor gives us. It cannot see the OTHER half: "Edit address" and "Fix &
// move pin" on the stop card write customer_notes.address_override straight from the browser
// with the Firestore client SDK, and never touch a function. That override is what the board,
// the pin and the customer emails actually use — so a log that omitted it would answer "did
// we change this address" with a confident and wrong no. The browser posts here after a save
// lands, and a failure to log NEVER fails the save.
//
// FORMATTING ROWS ARE HIDDEN, NOT DROPPED. The default view is what moved freight. `?all=1`
// returns everything, because the moment the log starts deciding what you are allowed to see
// it stops being able to settle an argument.
//
// The window rule is src/lib/history-range.js — the same module the screen resolves with, so
// the header and the numbers under it can never describe different ranges.

import { isFirestoreEnabled, readAddressChanges, recordAddressChanges, etDayString } from './lib/firestore.mts';
import {
  selectAddressChanges, summarizeAddressChanges, buildAddressChangeRow, addressHistoryEnabled,
  type AddressChangeKind, type AddressChangeSource,
} from './lib/address-history.mts';
import { resolveRange, expandRange, selectionFromParams } from '../../src/lib/history-range.js';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';
const MAX_ROWS = 1000;
const KINDS = new Set(['moved', 'renamed', 'suite', 'region', 'filled', 'cleared', 'formatting']);
const SOURCES = new Set(['scan', 'override', 'override-reset']);

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  // THE SWITCH REVERTS BOTH SIDES AT ONCE. With ADDRESS_HISTORY=off the scan stops recording
  // AND this endpoint says so plainly — a screen quietly asking for days nothing writes any
  // more is a new bug wearing the old feature's name.
  if (!addressHistoryEnabled()) {
    return J({ ok: false, disabled: true, error: 'The address-change log is switched off (ADDRESS_HISTORY=off).' });
  }
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore off — no address log available' });

  if (req.method === 'POST') return recordOne(req, J);
  if (req.method !== 'GET') return J({ ok: false, error: 'GET or POST only' }, 405);

  // Gate at viewer: the log names a customer's address and who changed it — the same facts
  // the stop card shows whoever opens it. Inert until AUTH_REQUIRED=true.
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const get = (k: string) => url.searchParams.get(k);
  const range = resolveRange(selectionFromParams(get), etDayString());
  if (!range.from || !range.to) return J({ ok: false, error: 'could not resolve a date range' }, 400);

  const kinds = String(get('kind') || '').split(',').map((k) => k.trim()).filter((k) => KINDS.has(k)) as AddressChangeKind[];
  const source = SOURCES.has(String(get('source'))) ? (String(get('source')) as AddressChangeSource) : null;
  const hideNoise = get('all') !== '1';
  const limit = Math.min(MAX_ROWS, Math.max(1, Number(get('limit')) || MAX_ROWS));

  const dates = expandRange(range.from, range.to);
  const perDay: Array<{ date: string; count: number }> = [];
  let all: any[] = [];
  let counted: any[] = [];
  try {
    // One document per day, read in parallel — the same shape and the same cap the flag
    // history uses, so a 60-day window is 60 gets and not a collection walk.
    const reads = await Promise.all(dates.map((d) => readAddressChanges(TENANT, d).then((rows) => ({ d, rows }))));
    for (const { d, rows } of reads) {
      // The per-day count reports what the CALLER asked for, not the raw document — a strip
      // reading 40 above a list of 3 is a screen arguing with itself.
      const visible = selectAddressChanges(rows, { stop: get('stop'), kinds, source, hideNoise });
      perDay.push({ date: d, count: visible.length });
      all = all.concat(visible);
      // THE SUMMARY IGNORES THE KIND FILTER *AND* THE NOISE TOGGLE, and both matter.
      //
      // Kind: the screen's kind pills ARE the filter and they carry these counts. Summarising
      // the already-kind-filtered rows zeroed every other pill the moment one was pressed, so
      // the breakdown vanished exactly when somebody started using it.
      //
      // Noise: `hideNoise` is the default, so a summary computed through it reported
      // formatting:0 ALWAYS — which made the checkbox read "Show formatting-only changes (0)"
      // on a day with forty of them, and made the empty state say "nothing was recorded at
      // all" when rows were sitting right there behind the toggle. A screen that cannot tell
      // you what it is withholding is worse than one that withholds nothing.
      counted = counted.concat(selectAddressChanges(rows, { stop: get('stop'), source }));
    }
  } catch (e: any) {
    return J({ ok: false, error: e?.message || 'address log read failed' }, 500);
  }

  const ordered = selectAddressChanges(all, { limit });
  return J({
    ok: true,
    nuvizzCalls: 0,
    range: { from: range.from, to: range.to, days: range.days, clamped: range.clamped },
    summary: summarizeAddressChanges(counted),
    matched: all.length,
    truncated: all.length > ordered.length,
    days: perDay,
    rows: ordered,
    note: 'Firestore only — nothing here spent a NuVizz call.',
  });
};

/**
 * Record one change a dispatcher made in the app.
 *
 * Gated at DISPATCHER, not viewer: this appends to a forensic ledger, and a log anybody can
 * write to cannot be used to settle what happened. The row's `actor` comes from the SESSION,
 * never from the body — a caller naming somebody else in an audit trail is the whole reason
 * to read it off the gate instead.
 */
async function recordOne(req: Request, J: (o: any, s?: number) => Response): Promise<Response> {
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;

  let body: any = {};
  try { body = await req.json(); } catch { return J({ ok: false, error: 'bad JSON body' }, 400); }

  const source = SOURCES.has(String(body?.source)) ? String(body.source) as AddressChangeSource : null;
  if (!source || source === 'scan') {
    return J({ ok: false, error: "source must be 'override' or 'override-reset' — the scan records its own rows" }, 400);
  }

  const at = new Date().toISOString();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.date)) ? String(body.date) : etDayString();
  const row = buildAddressChangeRow({
    at, date,
    stopNbr: body?.stopNbr,
    businessName: body?.businessName,
    source,
    before: body?.before || {},
    after: body?.after || {},
    route: body?.route,
    planned: body?.planned === true,
    matchKey: body?.matchKey,
    // AUTH_REQUIRED is still off here, so every caller arrives as LEGACY_PRINCIPAL. Record
    // that honestly as null rather than stamping the row "Dispatch (no login)", which reads
    // like a person and is not one — the rest of the row is still worth having, and the day
    // logins are enforced these rows start naming who saved them with no code change.
    actor: gate.user?.legacy ? null : (gate.user?.displayName || gate.user?.username || null),
  });
  // Not an error: the dispatcher opened the editor and saved the address that was already
  // there. Nothing changed, so nothing is logged, and the client has nothing to fix.
  if (!row) return J({ ok: true, recorded: false, reason: 'no material change' });

  const wrote = await recordAddressChanges(TENANT, date, [row]);
  return J({ ok: true, recorded: wrote, row });
}
