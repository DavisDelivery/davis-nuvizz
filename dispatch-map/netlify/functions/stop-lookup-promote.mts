// stop-lookup-promote.mts — THE ONE DOOR ON THE STOP LOOKUP SCREEN THAT SPENDS A NUVIZZ CALL.
//
// Chad, 2026-09-19: "if it's a specific customer pro or date range that is not in the
// firestore data allow a promoted nuvizz call."
//
//   GET ?stop=<PRO or stop number>   → ONE /stop/info call, on request, after Firestore missed
//   → { ok, nuvizzCalls: 0|1, mode: 'stop', promote, promoted: { attempted, ok, reason, text,
//        day, stored }, dossier, detail, … }
//
// A SEPARATE FUNCTION, ON PURPOSE. stop-lookup.mts makes a structural promise — it imports
// nothing that can call the vendor, and a test enforces that on its import list — and this
// screen prints "0 NuVizz calls" in its header off that promise. Putting the promoted call
// inside that file would have turned a proof into a comment. This file is the exception, it
// is the only exception, and it is small enough to read in one sitting.
//
// WHAT "PROMOTED" MEANS HERE, and every rule is pure and pinned in src/lib/stop-lookup.js:
//   • A person asked. The screen offers the button only after a COMPLETE Firestore miss —
//     every source that could have located the order was read and was empty — and the
//     button says the price. Nothing here runs on its own.
//   • It never spends on an order we already hold. The PRO index is consulted first (≤2
//     reads): a hit means the caller skipped the free lookup, and the answer is "already on
//     file", not a call. This is the exact waste Chad found on 2026-09-15 — the mobile
//     button offering to spend a call on an order sitting in our own warehouse.
//   • It honours every switch that already governs vendor traffic: the mirror guard, the
//     scans kill switch, the daily ceiling and the breaker (via the shared requester inside
//     lookupStopByPro), plus its own STOP_LOOKUP_PROMOTE (default on; off/0/false/no turns
//     it off; anything malformed leaves it on).
//   • A PAST order NuVizz answers for is FILED, so the next rep pays nothing: created in
//     the warehouse under its delivery day (createDocIfAbsent — never over a sealed record),
//     with a PRO-index pointer so ?stop= finds it outside the board window. Provenance is on
//     the record (promoted / promoted_at / promoted_by). Today's and future orders are shown
//     and NOT filed — the board scan owns those days.
//   • The call count in the answer is what happened, not what was intended: a refusal
//     before the wire (breaker open, scans off) reports nuvizzCalls: 0.
//
// Gated at dispatcher, like nuvizz-pro-lookup: every hit is a metered vendor call and the
// answer is written into history. Inert until AUTH_REQUIRED=true.

import { isFirestoreEnabled, getDoc, etDayString, createDocIfAbsent } from './lib/firestore.mts';
import { dayPath, histDocId } from './lib/history-store.mts';
import { lookupProDays, proIndexEnabled, updateProIndexForDay } from './lib/history-pro-index.mts';
import { getCustomerByMatchKey } from './lib/history-customers.mts';
import { stopCustomerKey } from './lib/customer-key.mts';
import { isMirrorDeploy } from './lib/mirror-guard.mts';
import { lookupStopByPro } from './lib/nuvizz-scan.mts';
import { setCallTrigger } from './lib/nuvizz-request.mts';
import { requireUser } from './lib/require-user.mts';
import {
  buildStopDossier, buildOrderDetail, notesSummary, classifyQuery, stopIdVariants,
  promoteAvailability, promotedRecordDay, promotedStoreDecision, promotedRecord, promoteOutcome, promotedSource,
} from '../../src/lib/stop-lookup.js';

const TENANT = 'davis';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' });

  const url = new URL(req.url);
  const stopRaw = String(url.searchParams.get('stop') || '').trim();
  if (!stopRaw) return J({ ok: false, error: 'pass ?stop=<PRO or stop number>' }, 400);

  const today = etDayString();
  const kind = classifyQuery(stopRaw).kind;
  const ids = stopIdVariants(stopRaw);
  const promote = promoteAvailability({
    promoteSwitch: process.env.STOP_LOOKUP_PROMOTE,
    scansSwitch: process.env.NUVIZZ_SCANS_ENABLED,
    mirror: isMirrorDeploy(),
  });
  const base = { ok: true, mode: 'stop', kind, today, query: stopRaw, candidates: ids, promote, proIndex: proIndexEnabled() };

  if (!promote.available) {
    return J({ ...base, nuvizzCalls: 0, promoted: { attempted: false, ok: false, reason: promote.reason, text: promote.text } });
  }

  // NEVER SPEND ON AN ORDER WE ALREADY HOLD. Two reads at most, and the whole point.
  if (proIndexEnabled()) {
    const days = await lookupProDays(TENANT, stopRaw).catch(() => [] as any[]);
    if (days.length) {
      const dates = [...new Set(days.map((d: any) => String(d?.date || '')).filter(Boolean))].sort().reverse();
      return J({
        ...base, nuvizzCalls: 0,
        promoted: {
          attempted: false, ok: false, reason: 'on-file', days: dates,
          text: `This order is already on file (${dates.join(', ')}) — no call was spent. Look it up again and it will show.`,
        },
      });
    }
  }

  setCallTrigger('on-demand');
  let res: any;
  try { res = await lookupStopByPro(stopRaw); } catch (e: any) { res = { ok: false, reason: e?.message || 'error' }; }
  const outcome = promoteOutcome(res);
  const nuvizzCalls = outcome.spent ? 1 : 0;

  if (!outcome.ok) {
    return J({
      ...base, nuvizzCalls,
      promoted: { attempted: true, ok: false, reason: outcome.reason, text: outcome.text, vendorReason: res?.reason ?? null },
      note: nuvizzCalls ? 'ONE NuVizz call, spent on request.' : 'No NuVizz call was spent.',
    });
  }

  const stop = res.stop;
  const stopNbr = String(stop?.stopNbr || stopRaw);
  const day = promotedRecordDay(stop);
  const decision = promotedStoreDecision({ day, today });
  const matchKey = stopCustomerKey(stop);
  const at = new Date().toISOString();
  // Displayed under its own day when it has one, under today when it does not — the record
  // itself says which (date null) so nothing downstream mistakes "today" for a fact.
  const record = promotedRecord(stop, { day, at, by: gate.user?.username ?? null, matchKey });
  const shownDay = day || today;

  let stored: any = null;
  if (decision.store) {
    const path = `${dayPath(TENANT, day!)}/stops/${histDocId(stopNbr)}`;
    try {
      // createDocIfAbsent: a sealed record already there wins, always — this can only fill a
      // hole, never overwrite a capture.
      const created = await createDocIfAbsent(path, record);
      stored = { ok: true, created, path, day };
    } catch (e: any) {
      stored = { ok: false, created: false, path, day, error: e?.message || 'write failed' };
    }
    if (stored.ok && proIndexEnabled()) {
      try { await updateProIndexForDay(TENANT, day!, [record]); stored.pointer = true; } catch (e: any) { stored.pointer = false; stored.pointerError = e?.message || 'pointer write failed'; }
    }
  }

  // The customer's own note and rollup, for the panel beside the order — Firestore only.
  const [notes, customer] = await Promise.all([
    matchKey ? getDoc(`customer_notes/${matchKey}`).catch(() => null) : Promise.resolve(null),
    matchKey ? getCustomerByMatchKey(TENANT, matchKey).catch(() => null) : Promise.resolve(null),
  ]);

  const dossier = buildStopDossier({
    query: stopRaw, today,
    pointers: [], sealed: [{ date: shownDay, stop: record }], board: [], attempts: [], plans: [],
    customer, notes, addressChanges: [], writes: [],
    looked: {
      pros: 'skipped', sealed: true, board: 'skipped', attempts: 'skipped', plans: 'skipped',
      customer: matchKey ? true : 'skipped', notes: matchKey ? true : 'skipped', address: 'skipped', writes: 'skipped',
      sealedWindow: day ? `the record NuVizz just returned, filed under ${day}` : 'the record NuVizz just returned — it carries no delivery day',
      boardWindow: 'not read — this answer came from NuVizz',
    },
  });

  return J({
    ...base, nuvizzCalls,
    window: null,
    dossier: { ...dossier, found: true, sources: [promotedSource({ day }), ...dossier.sources], notes: notesSummary(notes) },
    detail: {
      ok: true, mode: 'detail', date: shownDay, stopNbr, source: 'nuvizz', complete: true, errors: {},
      stop: buildOrderDetail(record, { date: shownDay, today, source: 'nuvizz' }),
      note: notesSummary(notes), matchKey,
    },
    promoted: {
      attempted: true, ok: true, reason: 'found', day, decision: decision.reason, stored,
      text: `${outcome.text} ${stored && stored.ok === false ? `Filing it failed (${stored.error}) — shown here, but the next lookup will cost another call.` : decision.text}`,
    },
    errors: {},
    note: 'ONE NuVizz call, spent on request.',
  });
};
