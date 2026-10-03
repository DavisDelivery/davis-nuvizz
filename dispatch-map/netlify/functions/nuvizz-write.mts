// nuvizz-write.mts
//
// ── The ONE live-write endpoint (op-envelope) ────────────────────────────────
//
//   POST /.netlify/functions/nuvizz-write
//   Body: { op, payload, dryRun?, clientOpId?, createdBy? }
//   → { ok, op, tenant, live, dryRun, result, ops:{current,ceiling}, error? }
//
// This is the single chokepoint for every NuVizz WRITE, so all the safety lives in one
// auditable place (mirrors send-sms.mts: validate → guard → side-effect → {ok,…}).
//
// SAFETY MODEL (matches the agreed design — writes to DAVIS *production*):
//   • dryRun:true  → NEVER calls NuVizz. Returns the plan of what WOULD fire. Always
//                    allowed (this is what the Compare panel uses in Beta mode and while
//                    you build/reorder — nothing fires until you Save in Live mode).
//   • Mutating ops (create/insert/remove/assign/dispatch/commit) require the server-side
//     kill switch  NUVIZZ_WRITE_ENABLED=true  — OFF by default, so nothing can fire until
//     it is deliberately set. This is the hard cutoff behind the UI's Beta/Live toggle.
//   • Idempotency: a Save carries a clientOpId; a repeat returns the prior success
//     without re-firing (no duplicate orders/assignments on a retry).
//   • Pre-flight budget: refuse to start a write once the day's NuVizz call count is at
//     the ceiling. (This said the breaker is monitor-mode by default and won't block on its
//     own. It has not been true since Jul 29: nuvizz-request.mts:70 defaults BREAKER_MODE to
//     ENFORCE, and monitor is the explicit opt-out. It matters here — a group push that
//     crosses the ceiling mid-run is BLOCKED, not merely counted.)
//   • Every call routes through getNuvizzRequester() (counted, breaker-guarded, POSTs not
//     deduped) — enforced fleet-wide by test/no-direct-nuvizz-fetch.test.mjs.
//   • The response always reports `tenant` + `live` so the UI banner shows PROD vs the
//     write-enabled state. No NuVizz creds ever reach the browser (this fn is the proxy).
//   • WHOSE LOGIN (Sep 2026 — Chad: "...with their personal nuvizz login information instead of
//     every dispatcher using mine"). A write that changes something goes out under the SIGNED-IN
//     person's own NuVizz login when they have a working one saved, on the v7 API and the Route
//     Workbench alike; otherwise under the shared login, as before, and the answer says which
//     (`identity`). NUVIZZ_PERSONAL_LOGINS=off puts every write back on the shared login;
//     =required refuses a write with no personal login behind it. See lib/nuvizz-identity.mts.

import { WRITE_OPS, MUTATING_OPS, hoistResultError, buildOpRequest, parsePieceInput, piecesBoardDates, parseCopyWeight, copyBaseNbr, opLedgerStatus, type WriteOp, createProfileFor, orderProfileFor, parseDuplicateEdits, parseCopyNumber } from './lib/nuvizz-write-ops.mts';
import { piecesWriteEnabled } from './lib/pieces-hold.mts';
import { requireUser } from './lib/require-user.mts';
import { bearerFromHeaders } from './lib/auth-core.mts';
import { runOp, resolveWriteCreds, loadImportBlocked, personalWriteCreds, routeCreateEngine, duplicateOrderBlocked, siteWriteFeatures, DUP_PROBE_MAX } from './lib/nuvizz-write.mts';
import { rwbEngineBlocked, takeRwbLoginRefusal, holdRwbLogin, rwbLoginHeld, releaseRwbLoginCheckedSince, buildManualRouteJson, rwbHosts } from './lib/nuvizz-rwb.mts';
import { personalLoginsMode, publicIdentity, type Identity } from './lib/nuvizz-identity.mts';
import { resolveWriteIdentity, watchPersonalRefusals, refusalAfterWrite, markLoginRejected, passingCheckAt } from './lib/nuvizz-write-identity.mts';
import { getUser, patchUser } from './lib/auth-store.mts';
import { getNuvizzRequester, setCallTrigger, resolveDailyCeiling, dailyCeilingKnown, NuvizzCircuitOpenError } from './lib/nuvizz-request.mts';
import { isFirestoreEnabled, getDoc, etDayString } from './lib/firestore.mts';
import { getOpRecord, putOpRecord, priorShortCircuits, recordCreatedOrder, recordAssignment } from './lib/write-registries.mts';
import { saveSent } from './lib/save-sent.mts';
import { carryNoteAfterPush } from './lib/note-carry.mts';
import { outboundAllowed, outboundRefusal } from './lib/mirror-guard.mts';

function writeEnabled(): boolean {
  // A MIRROR DEPLOY DOES NOT WRITE TO NuVizz. This is the one with a truck on the end of it:
  // assignDriver and dispatchLoad put freight on a driver's phone and release it. A mirror
  // copies production's env, so NUVIZZ_WRITE_ENABLED was true there too, and nothing else on
  // this path asked which environment it was in — isMirrorDeploy() gated READS (scansEnabled)
  // and nothing else, so a UAT deploy was silent about spending a vendor call and perfectly
  // willing to move a truck. See lib/mirror-guard.mts; MIRROR_ALLOW_OUTBOUND=nuvizz-write
  // opens it deliberately for a UAT tenant.
  if (!outboundAllowed('nuvizz-write')) return false;
  return String(process.env.NUVIZZ_WRITE_ENABLED ?? '').trim().toLowerCase() === 'true';
}

// The budget this endpoint refuses on, and the numbers it prints in the refusal.
//
// The ceiling is RESOLVED from the stored Diagnostics setting, not read out of a module
// variable that only the scanner ever populated. This function is why Chad's screen said
// "2,000 / 3,000" in the status card and "(2000/2000) - write refused" in the banner
// underneath it on the same load: the card reads the saved config, and this read an
// override that is always null in this process, landing on the 2,000 ambient default.
async function opsSnapshot(): Promise<{ current: number; ceiling: number }> {
  const ceiling = await resolveDailyCeiling();
  let current = 0;
  if (isFirestoreEnabled()) {
    try { const d = (await getDoc(`nuvizz_ops/calls__${etDayString()}`)) as any; current = Number(d?.count) || 0; } catch { /* treat as 0 */ }
  }
  return { current, ceiling };
}

// A human-readable plan of what a (non-dry) call WOULD fire — used for the dry-run echo
// the Compare panel shows before you commit. Pure; no NuVizz calls.
function planFor(op: WriteOp, payload: any): string[] {
  if (op === 'commitBoard') {
    const loads: any[] = Array.isArray(payload?.loads) ? payload.loads : [];
    if (!loads.length) return ['(no loads to commit)'];
    return loads.map((L) => {
      const ordered = Array.isArray(L?.orderedStopNbrs) ? L.orderedStopNbrs : (Array.isArray(L?.orderedStopIds) ? L.orderedStopIds : []);
      const rm = Array.isArray(L?.removeStopNbrs) ? L.removeStopNbrs.length : (Array.isArray(L?.removeStopIds) ? L.removeStopIds.length : 0);
      const bits: string[] = [];
      const inline = Array.isArray(L?.newStops) ? L.newStops.length : 0;
      if (L?.emptyLoad || (ordered.length === 0 && rm > 0)) {
        bits.push(`EMPTY the load — remove ALL orders and CANCEL the route${payload?.useRwb === true && !rwbEngineBlocked() ? ' (orders another card in this Save is taking move in the atomic RWB save FIRST; the cancel runs last)' : ''}`);
      } else {
        if (rm) bits.push(`unplan ${rm} order(s) (remove from route)`);
        // The Confirm modal tells you WHICH engine will fire — the classic anchor engine, the
        // async import + convergence reads, or (when the panel's engine toggle sent useRwb) the
        // 2-call SYNCHRONOUS Route Workbench sequence.
        if (ordered.length) bits.push(payload?.useRwb === true && !rwbEngineBlocked()
          ? `set ${ordered.length} stop(s) in order (RWB ENGINE — the portal's own flow: new orders are ADDED via validateStop + addStopsToRoute, then a SYNCHRONOUS fetchUpdatedJson + saveComparedRouteData sets the exact stop set + order by id; an omitted stop is unplanned; the load is then RE-READ to verify membership AND the actual stop order landed — a save NuVizz accepts but doesn't apply fails loudly instead of reporting saved)`
          : payload?.useImport === true && !loadImportBlocked()
            ? `set ${ordered.length} stop(s) in order (TWO-LEVER IMPORT ENGINE: not-yet-planned orders are first planned with insertStops — real records, never cloned — then ONE full-echo ordering import + convergence read-backs)`
            : `set ${ordered.length} stop(s) in order (anchor remove + one-at-a-time insert)`);
        // Inline creation (item A, existence-gated since Jul 2): the import itself creates them.
        if (inline) bits.push(`create ${inline} NEW order(s) INLINE in the import (each order # first verified ABSENT in NuVizz — a collision is refused, never cloned)`);
      }
      if (L?.driverId != null && String(L?.driverId).trim() !== '') bits.push(`assign ${L?.driverName || L?.driverId}`);
      if (L?.dispatch) bits.push('dispatch');
      return `Load ${L?.routeName ?? L?.loadNbr ?? L?.loadId ?? '?'}: ${bits.length ? bits.join(' · ') : '(no change)'}`;
    });
  }
  if (op === 'commitLoad') {
    const steps: string[] = [];
    const rm = Array.isArray(payload?.removeStopIds) ? payload.removeStopIds.length : 0;
    const ins = Array.isArray(payload?.insertStopIds) ? payload.insertStopIds.length : 0;
    if (rm) steps.push(`remove ${rm} stop(s) from load ${payload?.loadNbr ?? '?'} (load/edit)`);
    if (ins) steps.push(`plan ${ins} stop(s) onto load ${payload?.loadNbr ?? '?'} (load/insertstops)`);
    if (payload?.driverId != null && payload?.driverId !== '') steps.push(`assign driver ${payload?.driverName || payload?.driverId} (load/assignanddispatch ASSIGN_DISPATCH)`);
    if (payload?.dispatch) steps.push(`dispatch load ${payload?.loadNbr ?? '?'} (load/assignanddispatch DISPATCH)`);
    return steps.length ? steps : ['(no changes to commit)'];
  }
  if (op === 'importLoad' || op === 'commitImport') {
    const loads: any[] = op === 'importLoad'
      ? (payload?.load ? [payload.load] : [])
      : (Array.isArray(payload?.loads) ? payload.loads : []);
    if (!loads.length) return ['(no loads to import)'];
    const gate = 'NUVIZZ_LOAD_IMPORT'; // shown so the dry run tells you the path is double-gated
    return loads.map((L) => {
      const n = Array.isArray(L?.stops) ? L.stops.length : 0;
      return `Load ${L?.loadHeader?.routeName ?? L?.loadHeader?.loadNbr ?? '?'}: IMPORT ${n} stop(s) in exact array order (async load/update/default + convergence read-backs; gated by ${gate})`;
    });
  }
  if (op === 'newRoute') {
    // "HEADER ONLY (no stops in the payload)" stood here for five weeks after it stopped
    // being true — the create has carried planStops since Aug 3, when the live tenant refused
    // a stopless route (reason 903). The one surface that says what this op is about to do
    // was describing a payload the code no longer builds.
    const n = Array.isArray(payload?.orderedStopNbrs) ? payload.orderedStopNbrs.length : (payload?.seedStopNbr ? 1 : 0);
    // NUVIZZ_ROUTE_CREATE_RWB=on (v1.98.5) makes a different create — describing the v7 one here
    // would be this comment's five weeks again, one switch-flip away.
    const eng = routeCreateEngine();
    if (eng.engine === 'rwb') {
      const extras = [(payload?.driverId ?? '') !== '' && Number(payload?.driverId) !== 0 ? 'assign the driver' : '', payload?.dispatch ? 'dispatch' : ''].filter(Boolean);
      return [
        ...(eng.rwbReady ? [] : ['REFUSE before any call: the Route Workbench sign-in is not ready on this server (NUVIZZ_RWB_ENABLED / the NuVizz portal login)']),
        `READ all ${n} order(s) on the card — each must be readable, UNPLANNED and unexecuted, or the WHOLE create is refused`,
        `CREATE route "${payload?.routeName ?? '?'}" for ${payload?.date ?? 'today (ET)'} the portal's way (NUVIZZ_ROUTE_CREATE_RWB=on) — addNewRoutePlan on ${eng.portalHost}, signing in at ${eng.loginHost}: an EMPTY route that NuVizz numbers itself; a name already in use that day is refused`,
        `ATTACH the ${n} order(s) with the Route Workbench Save an existing load gets — add, sequence in card order, verify against NuVizz's read-back, board write-through${extras.length ? `, ${extras.join(', ')}` : ''}`,
      ];
    }
    return [
      `CHECK load ${payload?.loadNbr ?? '?'} is free (must read absent — an existing number is refused, never overwritten)`,
      `READ all ${n} order(s) on the card — each must be readable, UNPLANNED and unexecuted, or the WHOLE create is refused`,
      `CREATE route "${payload?.routeName ?? payload?.loadNbr ?? '?'}" for ${payload?.date ?? '(no date)'} — routePlan/update with the header + ${n} PlanStop REFERENCE(s) in card order, as ${2 * n} legs (from-legs 1..${n}, to-legs ${n + 1}..${2 * n})`,
      'VERIFY by reading the load back (the ack is async) — the route NAME landed AND every order rides it',
    ];
  }
  // The three single-order partialUpdate ops all run the same ladder, and it is never one
  // call — the read is what makes the write safe (partialUpdate is a full replace) and the
  // read-back is what proves it didn't cost the order anything else. Say so.
  if (op === 'cancelOrder') {
    return [
      `READ stop ${payload?.stopNbr ?? '?'} — record WHAT is about to be cancelled, and refuse if two orders share the number`,
      'REFUSE if the order is already delivered, or currently planned on a load (NuVizz only cancels unplanned orders)',
      `CANCEL BY stopId — never by number — reason ${String(payload?.reasonCode ?? '').trim() || 'ADMIN'}. THIS CANNOT BE UNDONE.`,
    ];
  }
  // §P piece counts (v1.105.0) — the same ladder, plus the board half, which is Firestore only.
  if (op === 'setStopPieces') {
    const want = parsePieceInput(payload);
    if ('error' in want) return [`REFUSE before any call: ${want.error}`];
    const days = piecesBoardDates(payload?.boardDates);
    return [
      ...(piecesWriteEnabled() ? [] : ['REFUSE before any call: piece-count edits are switched off on this site (NUVIZZ_PIECES_WRITE)']),
      `READ stop ${payload?.stopNbr ?? '?'} (partialUpdate is a FULL replace — the current record is what gets echoed back); refuse a second order sharing the number, or an order the driver already has`,
      `WRITE the echo with the piece counts set to ${want.pallets} pallet(s) + ${want.loose} loose = ${want.total} piece(s) (NuVizz totalCartons / volume / totalPallets — only the ones that change are sent; the line items are never sent)`,
      'VERIFY by reading the order back — each count must read as intended AND every other field byte-identical',
      `BOARD: put the read-back counts on this order's board row${days.length ? ` (${days.join(', ')})` : ''} and its stored copy — Firestore only, no NuVizz call`,
    ];
  }
  // §DUP (v1.107.0) — a NEW order, so the plan names how its number is found before anything else.
  if (op === 'duplicateOrder') {
    const want = parsePieceInput(payload);
    if ('error' in want) return [`REFUSE before any call: ${want.error}`];
    const w = parseCopyWeight(payload?.weight);
    if ('error' in w) return [`REFUSE before any call: ${w.error}`];
    const ed = parseDuplicateEdits(payload?.edits);
    if ('error' in ed) return [`REFUSE before any call: ${ed.error}`];
    const typed = parseCopyNumber(payload?.copyNbr);
    if ('error' in typed) return [`REFUSE before any call: ${typed.error}`];
    const base = copyBaseNbr(payload?.stopNbr);
    const changed = Object.keys(ed.edits);
    return [
      ...(duplicateOrderBlocked() ? ['REFUSE before any call: duplicating orders is switched off on this site (NUVIZZ_DUPLICATE_ORDER)'] : []),
      `READ order ${payload?.stopNbr ?? '?'} — the original to copy; refuse a second order sharing the number`,
      typed.nbr
        ? `USE the number typed for the copy, ${typed.nbr}: our own records must not know it, and it must read NOT FOUND in NuVizz (an explicit 404) — a number NuVizz holds is refused, never written (stop/sync/update would REPLACE that order)`
        : `FIND the first free number from ${base}-1: a number our own records know is skipped for free; any other must read NOT FOUND in NuVizz (an explicit 404) before it is used — a number NuVizz holds is skipped, never written (stop/sync/update would REPLACE that order); at most ${DUP_PROBE_MAX} reads`,
      ...(changed.length ? [`CHANGED on the copy (the rest is copied from the original): ${changed.join(', ')}`] : []),
      `CREATE it (stop/sync/update, as New Order does) for ${String(payload?.date ?? '').trim() || 'today'}: consignee, address, contact, delivery window, commodity, instructions and pickup origin copied from the original; ${want.pallets} pallet(s) + ${want.loose} loose = ${want.total} piece(s), ${(w as any).weight != null ? `${(w as any).weight} lbs` : "the original's weight"}; price ${payload?.copyPrice === true ? 'copied' : 'NOT copied'}; lands UNPLANNED`,
      'VERIFY by reading the new order back — its number, pieces and street must read as created',
    ];
  }
  if (op === 'addStopNote' || op === 'setStopDate' || op === 'setStopContact' || op === 'setStopAddress') {
    const a = payload?.address || {};
    const what = op === 'addStopNote' ? 'merge the note onto the order\'s existing comments'
      : op === 'setStopDate' ? `move the delivery window to ${payload?.date ?? '(no date)'}`
        : op === 'setStopAddress' ? `RE-ADDRESS the delivery to ${[a.addr1, a.city, a.state, a.zip].filter(Boolean).join(', ') || '(no address)'} — sent as a literal ANY address with no label, so NuVizz cannot resolve it away`
          : `set the customer contact to ${[payload?.name, payload?.phone].filter(Boolean).join(' · ') || '(nothing)'}`;
    // The note rides the SAME write on an address correction, so the plan must say so. A dry
    // run that describes half of what the live call will do is the inspectability rule broken —
    // and this is the surface a dispatcher checks before spending a group push.
    const noteText = String(payload?.note ?? '').trim();
    const noteLine = op === 'setStopAddress' && noteText
      ? ` AND append a ${payload?.noteAudience ?? 'dispatcher'} note ("${noteText.slice(0, 80)}${noteText.length > 80 ? '…' : ''}") to the order's EXISTING comments — same write, no extra NuVizz call`
      : '';
    return [
      `READ stop ${payload?.stopNbr ?? '?'} (partialUpdate is a FULL replace — the current record is what gets echoed back)`,
      `WRITE the echo with one block swapped: ${what}${noteLine}`,
      'VERIFY by reading the order back — the change must be there AND every other field byte-identical',
    ];
  }
  if (op === 'createStop') {
    const profile = createProfileFor(payload);
    const nbr = payload?.stop?.stopNbr ?? payload?.row?.stopNbr ?? '(no order number)';
    return [
      `CREATE order ${nbr} (stop/sync/update) → 1 NuVizz call`,
      // §EP (v1.108.0): said in the plan because it is in the body — the dry run shows what goes.
      ...(profile ? [`PROFILE ${profile} — NuVizz's ESTES order profile (3 mandatory photos), sent because this is an Estes order`] : []),
    ];
  }
  return [`${op} → 1 NuVizz call`];
}

/**
 * The EXACT JSON a create would POST, without POSTing it (dry run only).
 *
 * CLAUDE.md: "Make it inspectable — every job that acts on its own needs a way to ask what
 * it is about to do, without doing it. A dry run is part of the feature, not a nicety."
 * Until now no path at any permission level could print this body, so a malformed one could
 * only be discovered by spending a live production write — which is how the Sep 9/10 route
 * creates were spent. Returns null when there is nothing to preview.
 *
 * THE LIMIT, STATED ON THE PAYLOAD ITSELF: the real create echoes each order's own schedule
 * off a per-stop getStop, and a dry run must not make those reads. So the preview's schedules
 * are empty and it says so — it shows the SHAPE (header, leg numbering, key set), not the
 * windows. Never claim more for it than that.
 */
function previewBodyFor(op: WriteOp, payload: any): any {
  if (op !== 'newRoute') return null;
  if (routeCreateEngine().engine === 'rwb') {
    try {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(payload?.date ?? '')) ? String(payload.date) : etDayString();
      const entry = buildManualRouteJson({ routeName: String(payload?.routeName ?? ''), date: day });
      return {
        url: `${rwbHosts().portalBase}/deliverit/dirouteworkbench/routePlan/addNewRoutePlan`,
        body: { manualBuildJsonData: [entry], isPlanningMode: 'true' },
        caveat: 'SHAPE ONLY — the profile, depot and window are read from the tenant\'s template (buildEmptyRouteJson) at create time; shown here are the capture\'s own values. The orders are not in this call: the Route Workbench Save attaches them after.',
      };
    } catch (e: any) {
      return { refused: e?.message || 'the builder refused this card' };
    }
  }
  const nbrs: string[] = Array.isArray(payload?.orderedStopNbrs)
    ? payload.orderedStopNbrs.map((n: any) => String(n ?? '').trim()).filter(Boolean)
    : (payload?.seedStopNbr ? [String(payload.seedStopNbr)] : []);
  try {
    const creds = resolveWriteCreds();
    const br = buildOpRequest('createRoute', {
      route: {
        loadNbr: payload?.loadNbr, routeName: payload?.routeName, date: payload?.date,
        earliestStartDttm: payload?.earliestStartDttm, latestStartDttm: payload?.latestStartDttm,
        origin: payload?.origin, loadTimeZone: payload?.loadTimeZone,
        seeds: nbrs.map((n) => ({ stopNbr: n })),
      },
    }, creds);
    return {
      url: br.url,
      body: JSON.parse(br.body),
      caveat: 'SHAPE ONLY — every planStops[].schedule is {} here because the real echoes come from per-stop getStop reads a dry run must not make. The live body carries each order\'s own from/to window.',
    };
  } catch (e: any) {
    // A builder throw IS the useful answer here (over-long name, no origin, no date, no
    // orders): it names the refusal without a NuVizz call. Never let it 500 the dry run.
    return { refused: e?.message || 'the builder refused this card' };
  }
}

async function journal(op: WriteOp, payload: any, result: any, tenant: string, clientOpId: string | null, createdBy: string | null, by: string | null = null): Promise<void> {
  const date = String(payload?.date || etDayString());
  try {
    // A duplicate is a created order too, and it is journaled the moment NuVizz confirms the create
    // — even when the read-back could not verify it, because the order exists either way.
    if (op === 'duplicateOrder' && result?.created === true && result?.stopNbr) {
      await recordCreatedOrder({ tenant, stopNbr: result.stopNbr, stopId: result.stopId ?? null, loadNbr: null, status: 'succeeded', createdBy: createdBy || 'dispatcher-duplicate', by, createdAt: new Date().toISOString(), clientOpId, copyOf: result.copyOf ?? null, verified: result.ok === true, profile: orderProfileFor({ stopNbr: result.stopNbr }), edited: Array.isArray(result.edited) ? result.edited : [], numberTyped: result.numberTyped === true, nuvizzResponse: result });
    }
    if (op === 'createStop' && result?.ok) {
      // `createdBy` is the SOURCE the client names ('dispatcher', 'dispatcher-bulk',
      // 'dispatcher-manifest') and is kept exactly as sent; `by` is the PERSON — the signed-in
      // account, or null for the pre-login caller. Two facts, two fields.
      await recordCreatedOrder({ tenant, stopNbr: result.entityNbr, stopId: result.entityId, loadNbr: payload?.loadNbr ?? null, status: 'succeeded', createdBy, by, createdAt: new Date().toISOString(), clientOpId, profile: createProfileFor(payload), nuvizzResponse: result });
    }
    if ((op === 'assignDriver' || op === 'commitLoad') && payload?.driverId != null && payload?.driverId !== '') {
      await recordAssignment({ tenant, date, loadNbr: String(payload?.loadNbr ?? ''), loadId: payload?.loadId ?? result?.loadId ?? null, driverId: payload?.driverId, driverName: payload?.driverName ?? null, status: result?.ok ? 'assigned' : 'failed', assignedAt: new Date().toISOString() });
    }
    if ((op === 'dispatchLoad' || (op === 'commitLoad' && payload?.dispatch)) && result?.ok) {
      await recordAssignment({ tenant, date, loadNbr: String(payload?.loadNbr ?? ''), loadId: payload?.loadId ?? result?.loadId ?? null, status: 'dispatched', dispatchedAt: new Date().toISOString() });
    }
    if (op === 'commitBoard') {
      const reqLoads: any[] = Array.isArray(payload?.loads) ? payload.loads : [];
      const resLoads: any[] = Array.isArray(result?.loads) ? result.loads : [];
      for (const L of reqLoads) {
        // Join by loadId FIRST: a loadId-only card sends no loadNbr while the result carries the
        // server-resolved number, so a name-only join records every assignment as 'failed'.
        const res = resLoads.find((r) => (L?.loadId != null && r?.loadId != null && String(r.loadId) === String(L.loadId))
          || (L?.loadNbr != null && String(r?.loadNbr ?? '') === String(L.loadNbr))) || {};
        if (L?.driverId != null && String(L?.driverId).trim() !== '') {
          await recordAssignment({ tenant, date, loadNbr: String(L?.loadNbr ?? ''), loadId: L?.loadId ?? res?.loadId ?? null, driverId: L.driverId, driverName: L?.driverName ?? null, status: res?.ok ? 'assigned' : 'failed', assignedAt: new Date().toISOString() });
        }
        if (L?.dispatch && res?.ok) {
          await recordAssignment({ tenant, date, loadNbr: String(L?.loadNbr ?? ''), loadId: L?.loadId ?? res?.loadId ?? null, status: 'dispatched', dispatchedAt: new Date().toISOString() });
        }
      }
    }
  } catch { /* journaling is best-effort */ }
}

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });

  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'POST') return J({ ok: false, error: 'POST only' }, 405);
  // User gate — inert until AUTH_REQUIRED=true on the site (lib/require-user.mts).
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;

  let body: any;
  try { body = await req.json(); } catch { return J({ ok: false, error: 'invalid JSON' }, 400); }

  const op = String(body?.op ?? '') as WriteOp;
  if (!WRITE_OPS.includes(op)) return J({ ok: false, error: `unknown op '${body?.op}'`, allowed: WRITE_OPS }, 400);
  const payload = body?.payload ?? {};
  const dryRun = body?.dryRun === true;
  const clientOpId = body?.clientOpId ? String(body.clientOpId) : null;
  const createdBy = body?.createdBy ? String(body.createdBy) : null;

  // Resolve tenant for the response banner even on the early-return paths.
  let tenant = 'DAVIS';
  try { tenant = resolveWriteCreds().companyCode; } catch { /* creds resolved again below */ }
  const live = writeEnabled();
  const ops = await opsSnapshot();

  // 1) DRY RUN — never touches NuVizz. The Compare panel's default mode + Beta mode. `features`
  //    is which switched writes this site has on (siteWriteFeatures) — the stop card asks once per
  //    page load and offers the Duplicate panel only when the server would run it.
  if (dryRun) {
    const preview = previewBodyFor(op, payload);
    return J({ ok: true, op, tenant, live, dryRun: true, plan: planFor(op, payload), ...(preview ? { preview } : {}), ...(op === 'newRoute' ? { routeCreate: routeCreateEngine() } : {}), features: siteWriteFeatures(), ops });
  }

  // 2) Mutating ops require the server-side kill switch.
  if (MUTATING_OPS.has(op) && !live) {
    return J({ ok: false, op, tenant, live: false, dryRun: false, error: outboundAllowed('nuvizz-write')
      ? 'live writes disabled — set NUVIZZ_WRITE_ENABLED=true to enable'
      : outboundRefusal('nuvizz-write'), ops }, 403);
  }

  // 3) Creds must be present (basicAuthHeader throws if not) — fail clearly, no NuVizz call.
  let creds;
  try { creds = resolveWriteCreds(); }
  catch (e: any) { return J({ ok: false, op, tenant, error: e?.message || 'missing NuVizz creds', ops }, 500); }
  tenant = creds.companyCode;

  // 4) Idempotency — a repeated Save returns the prior success without re-firing. NOTE: the
  // ledger lives in Firestore; when Firestore is off it silently no-ops, so a retry CAN re-fire.
  // Warn loudly so an operator relying on dedup isn't unknowingly unprotected. (Truly-concurrent
  // identical Saves are also not deduped — only sequential retries; the UI's busy-disable + a
  // single clientOpId per Save cover the common case.)
  if (MUTATING_OPS.has(op) && clientOpId) {
    if (!isFirestoreEnabled()) console.warn(`[nuvizz-write] clientOpId supplied but Firestore is off — idempotency unavailable; a retry of op=${op} can re-fire.`);
    const prior = await getOpRecord(tenant, clientOpId);
    if (priorShortCircuits(prior)) return J({ ok: true, op, tenant, live, dryRun: false, idempotent: true, result: prior!.result, ops });
  }

  // 4b) WHOSE LOGIN THIS WRITE GOES OUT UNDER (lib/nuvizz-identity.mts). Only a write that CHANGES
  //     something: a read through this door stays on the shared login, as every read does. After
  //     the idempotency short-circuit on purpose, so a retry of a Save that already landed returns
  //     that success rather than a refusal about a login it no longer needs. A refusal (only under
  //     NUVIZZ_PERSONAL_LOGINS=required) happens HERE, before the budget check and before any
  //     NuVizz call — nothing half-done, nothing spent.
  const mode = personalLoginsMode();
  const who = gate.user.authenticated ? gate.user.username : null;
  let identity: Identity = { kind: 'shared', appUser: who, why: 'off', note: null };
  if (MUTATING_OPS.has(op)) {
    let account: any = null;
    identity = await resolveWriteIdentity(mode, gate.user, { getUser: async (u) => (account = await getUser(u)) }, { tokenPresented: !!bearerFromHeaders(req.headers) });
    if (identity.kind === 'refused') {
      return J({ ok: false, op, tenant, live, error: identity.error, identity: publicIdentity(identity, mode), ops }, identity.status);
    }
    if (identity.kind === 'personal') {
      creds = personalWriteCreds(identity.nuvizzUser, identity.password);
      // A Test that passed AFTER this instance held the login (it runs in another function, which
      // cannot reach this hold) puts the login back here too — the account read above decides.
      releaseRwbLoginCheckedSince(creds.rwb, passingCheckAt(account));
    }
  }
  const identityOut = publicIdentity(identity, mode);

  // 5) Pre-flight budget — refuse to start at/over the ceiling. The breaker itself defaults to
  //    ENFORCE (nuvizz-request.mts:70), so this is the polite refusal before the hard one.
  if (ops.current >= ops.ceiling) {
    // Say when the number is the DEFAULT only because the saved setting could not be read —
    // "(2000/2000)" under a card reading 3,000 is the contradiction of 2026-09-09.
    const guess = dailyCeilingKnown() ? '' : ` — the saved ceiling could not be read, so the ${ops.ceiling} default is in force`;
    return J({ ok: false, op, tenant, live, error: `daily NuVizz call ceiling reached (${ops.current}/${ops.ceiling})${guess} — write refused`, ops }, 429);
  }

  // 6) Fire. Attribute the spike distinctly so Diagnostics shows live-write volume.
  setCallTrigger('live-write');
  // Per-action call accounting: totalThisInstance is a monotonic per-instance
  // counter bumped on every NuVizz round-trip, so a before/after delta around runOp
  // is the EXACT number of NuVizz calls THIS action made (login handshake on a cold
  // instance + preview + save + validate/add + every verify read). Returned as
  // `callsUsed` so the UI can show it per-action and reconcile against the RWB HAR.
  const reqr = getNuvizzRequester();
  const callsBefore = reqr.getStats().totalThisInstance;
  const callsSince = () => reqr.getStats().totalThisInstance - callsBefore;
  // Watches for NuVizz refusing a PERSONAL login mid-write — and stops sending it once it has (a
  // no-op pass-through for the shared login). One brake for the whole Save: a v7 refusal holds the
  // portal side too, and a login the portal side already holds is not sent to the v7 API either.
  const personalRwb = identity.kind === 'personal' ? creds.rwb : null;
  const watch = watchPersonalRefusals(reqr, identity.kind === 'personal' ? creds.auth : null, {
    onRefused: () => holdRwbLogin(personalRwb, `the NuVizz API answered 401 to the NuVizz login saved as ${identity.kind === 'personal' ? identity.nuvizzUser : ''}`),
    isHeld: () => rwbLoginHeld(personalRwb),
  });
  // After the write, the one question the refusal watch exists for: did NuVizz just refuse this
  // person's saved login? If so it is recorded on their account, so the NEXT write — on any
  // instance — stops using it rather than trying it again (lib/nuvizz-rwb.mts: a stale password
  // tried on every Save is how a dispatcher gets locked out of NuVizz itself).
  const noteRefusal = async (): Promise<string | null> => {
    if (identity.kind !== 'personal') return null;
    const reason = refusalAfterWrite(identity, watch.refusedStatus(), takeRwbLoginRefusal(personalRwb));
    if (!reason) return null;
    const marked = await markLoginRejected(identity.appUser, reason, { patchUser });
    // Said as it happened. If the mark did not land, other instances will still try this login
    // until it does — this instance holds it (lib/nuvizz-rwb.mts), but a log that claims "marked"
    // over a failed write is the report-an-intent-as-an-outcome mistake this repo keeps naming.
    console.warn(`[nuvizz-write] NuVizz refused the personal login of user=${identity.appUser} (nuvizz=${identity.nuvizzUser}) — ${marked ? 'marked on the account' : 'MARK FAILED (held in this instance only)'}; withheld=${watch.withheld()}; reason=${reason}`);
    return reason;
  };
  let result: any;
  try {
    result = await runOp(watch.requester, op, payload, creds);
  } catch (e: any) {
    const loginRefused = await noteRefusal();
    const extra = { identity: identityOut, ...(loginRefused ? { loginRefused } : {}) };
    if (e instanceof NuvizzCircuitOpenError) return J({ ok: false, op, tenant, live, callsUsed: callsSince(), error: 'NuVizz circuit breaker open — write refused', ...extra, ops: await opsSnapshot() }, 503);
    // A builder threw → malformed payload (missing required field) → 400.
    return J({ ok: false, op, tenant, live, callsUsed: callsSince(), error: e?.message || 'write failed', ...extra, ops: await opsSnapshot() }, 400);
  }
  const loginRefused = await noteRefusal();

  // 6b) A PUSH THAT RE-KEYS AN ORDER TAKES ITS CUSTOMER NOTE WITH IT (lib/note-carry.mts): the
  //     hand-placed pin, receiving hours and the rest follow the order to the key its corrected
  //     address makes. BEFORE the journal, so the ledger row says what was carried — or why not.
  //     It never throws and never changes `ok`: the address is on the order either way.
  if (op === 'setStopAddress' && result && typeof result === 'object') {
    result.carry = await carryNoteAfterPush(payload, result);
  }

  // 7) Journal (best-effort) + idempotency ledger. `by` is the signed-in PERSON (null for the
  //    pre-login caller) and `nuvizzAs` the NuVizz login the write actually went out under — so
  //    "who changed this route" has an answer in our own ledger as well as in NuVizz's history.
  //    `sent` is WHICH STOPS the Save carried, per load (lib/save-sent.mts) — the result alone
  //    could say BRIAN's 8:38 Save was refused but not that its card no longer listed the pickup.
  if (MUTATING_OPS.has(op)) {
    await journal(op, payload, result, tenant, clientOpId, createdBy, who);
    const sent = saveSent(payload, { createdBy });
    if (clientOpId) await putOpRecord({ clientOpId, op, status: opLedgerStatus(op, result), result, tenant, at: new Date().toISOString(), by: who, nuvizzAs: identity.kind === 'personal' ? identity.nuvizzUser : 'shared', ...(sent ? { sent } : {}) });
  }

  // 8) Answer. A failure MUST carry its reason at the top level — the executors always build
  //    one, and this envelope used to drop it, leaving callers to guess (see hoistResultError).
  const failure = hoistResultError(result);
  return J({ ok: !!result?.ok, op, tenant, live, dryRun: false, ...(failure ? { error: failure } : {}), result, identity: identityOut, ...(loginRefused ? { loginRefused } : {}), callsUsed: callsSince(), ops: await opsSnapshot() }, result?.ok ? 200 : 502);
};
