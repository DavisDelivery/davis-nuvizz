// uat-seed.mts — the UAT test bench: pick orders out of production's day, write just those
// into the UAT tenant, run the scenario, strike the set.
//
//   GET  ?op=catalogue&date=YYYY-MM-DD   → production's day to pick from (ZERO NuVizz calls)
//   POST { op:'preview', date, stopNbrs[] } → the exact payloads that WOULD be sent (ZERO calls)
//   POST { op:'seed',    date, stopNbrs[], label? } → create them in UAT + fill the UAT board
//   POST { op:'clear' }                    → unplan, cancel and remove everything it seeded
//
// Chad, 2026-09-10: "we need to use firestore to see what data/orders are put into system
// daily so we are not running scans. Then we can design a way to test using that information
// so we need to test something we will write just the orders we need to test whatever
// scenario we are testing into the uat."
//
// ── THE FIVE GATES, AND WHY EACH ONE IS THERE ───────────────────────────────
//
//  1. MIRROR ONLY. Keyed on FIRESTORE_DATABASE, checked before an op is even parsed. Not a
//     date check, not a flag — a property of the deploy. Production cannot reach this code.
//  2. THE NUVIZZ TARGET MUST BE UAT. Gate 1 proves the FIRESTORE database is named; it says
//     nothing about which TENANT the writes reach, and NUVIZZ_BASE_URL /
//     NUVIZZ_DAVIS_COMPANY_CODE both DEFAULT TO PRODUCTION when unset. A mirror is built by
//     copying production's env, so "named database" and "UAT tenant" are two different facts
//     and only one of them was ever checked. unsafeWriteTarget() fails closed.
//  3. POST ONLY for anything that writes. `op` can arrive in the query string, `clear` needs
//     no body, and the date defaults to today — so a GET would mean an <img> tag, a link
//     preview or a browser prefetch could cancel the whole bench. requireUser is inert until
//     AUTH_REQUIRED is set, and this is the site least likely to have it on.
//  4. THE SITE'S OWN KILL SWITCH. NUVIZZ_WRITE_ENABLED, checked here — this endpoint calls
//     runOp directly and so bypasses the HTTP handler where that gate normally lives.
//  5. THE MIRROR'S OUTBOUND GRANT. MIRROR_ALLOW_OUTBOUND=nuvizz-write, set deliberately.
//
// ── WHY THE LEDGER IS WRITTEN FIRST ─────────────────────────────────────────
//
// An order that exists in the tenant and in no ledger cannot be cleared by anything, ever —
// somebody has to find it in the portal by hand. So the ledger records INTENT before the
// create, not success after it: if the function is killed mid-loop (Netlify's budget is 10s
// and a create is ~1s), or a create applies and then answers 5xx, or anything between the
// creates and the ledger write throws, every order is still recorded and still clearable.
// One document per order rather than one array per day, because two people on the bench at
// once would lose each other's writes through a read-modify-write, and because the ledger is
// keyed by TENANT not by date — the UAT order number carries no date, so a day-scoped ledger
// would let one day's clear cancel an order another day's bench is still using.

import { readProdDay, catalogueEnabled, CATALOGUE_MASK } from './lib/prod-catalogue.mts';
import { planSeed, seedIndexRow, unsafeWriteTarget, isUatSeededNbr } from './lib/uat-seed.mts';
import { buildStopPayload } from './lib/nuvizz-write-ops.mts';
import { runOp, resolveWriteCreds } from './lib/nuvizz-write.mts';
import { getNuvizzRequester, setCallTrigger } from './lib/nuvizz-request.mts';
import { isMirrorDeploy, firestoreDatabaseName, outboundAllowed, outboundRefusal } from './lib/mirror-guard.mts';
import { isFirestoreEnabled, getDoc, setDoc, listDocs, deleteDoc, etDayString } from './lib/firestore.mts';
import { putOpRecord } from './lib/write-registries.mts';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';
const INDEX = 'nuvizz_stop_index';
/** One document per seeded order, keyed by TENANT — see the header for why not by date. */
const LEDGER = `uat_seed/${TENANT}/orders`;
const MAX_SEED = 25;   // a scenario, not a day — and small enough to finish inside the budget.

// The ship-from every seeded order is created against — the Davis terminal, the same built-in
// New Order uses. Hard-coded rather than read from a browser's localStorage: this is a
// server-side bench and the origin must not depend on which device opened it.
const SEED_ORIGIN = { name: 'Davis Delivery Service', addr1: '943 Gainesville Hwy 200-4000', city: 'Buford', state: 'GA', zip: '30518' };

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const J = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: CORS });

const isDay = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));
const indexBase = (dateStr: string) => `${INDEX}/${TENANT}__${dateStr}`;

/** The site's own NuVizz kill switch. The HTTP handler in nuvizz-write.mts keeps this check
 *  private, and this endpoint calls runOp directly — so the gate is restated rather than
 *  advertised and skipped. */
function writeEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test(String(process.env.NUVIZZ_WRITE_ENABLED ?? '').trim());
}

interface LedgerRow { uatStopNbr: string; prodStopNbr: string; boardDate: string; status: string; stopId: string | null; at: string; label: string | null }

async function readLedger(): Promise<LedgerRow[]> {
  const docs = await listDocs(LEDGER);
  return docs
    .map((d: any) => ({
      uatStopNbr: String(d?.uatStopNbr || d?._id || ''),
      prodStopNbr: String(d?.prodStopNbr || ''),
      boardDate: String(d?.boardDate || ''),
      status: String(d?.status || 'unknown'),
      stopId: d?.stopId ?? null,
      at: String(d?.at || ''),
      label: d?.label ?? null,
    }))
    .filter((r) => r.uatStopNbr);
}

/**
 * Recompute the board index meta from what is actually in it. The seeder writes this board
 * (a mirror never scans), so it owns the counts — derived from the documents rather than
 * tracked, which is the version that cannot drift.
 *
 * IT DOES NOT STAMP A SCAN. last_scanned_at / lastLoadScanAt / lastUnplannedScanAt are how
 * the board's freshness strip renders "Orders updated 3m ago", and no scan ran here. Claiming
 * one would put a number on screen that means nothing — the same sin as the hardcoded
 * "routed to Google" this repo removed. `seededAt` says what actually happened.
 */
async function rewriteMeta(dateStr: string, at: string): Promise<{ count: number }> {
  const base = indexBase(dateStr);
  const docs = await listDocs(`${base}/stops`, { mask: ['isPlanned'] });
  const count = docs.length;
  const plannedCount = docs.filter((d: any) => d?.isPlanned === true).length;
  const prev = (await getDoc(base)) as any;
  await setDoc(base, {
    ...(prev || {}),
    tenant: TENANT, date: dateStr, count, plannedCount, unplannedCount: count - plannedCount,
    last_scanned_at: null, lastLoadScanAt: null, lastUnplannedScanAt: null, lastCompletedScanAt: null,
    scanState: null,
    // So every reader knows this board was SEEDED, not scanned. A test board that looks
    // scanned is a test board somebody will eventually mistake for a real morning.
    seededBench: true, seededAt: at,
  } as any);
  return { count };
}

export default async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  // ── GATE 1 ────────────────────────────────────────────────────────────────
  if (!isMirrorDeploy()) {
    return J({ ok: false, error: 'uat-seed: refused — this is the production deploy. The test bench only runs on a mirror (FIRESTORE_DATABASE set).' }, 403);
  }
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'uat-seed: Firestore is off on this deploy' }, 503);

  const url = new URL(req.url);
  let body: any = {};
  if (req.method === 'POST') {
    try { body = await req.json(); } catch { return J({ ok: false, error: 'invalid JSON' }, 400); }
  }
  const op = String(body?.op ?? url.searchParams.get('op') ?? 'catalogue');
  const date = String(body?.date ?? url.searchParams.get('date') ?? etDayString());
  if (!isDay(date)) return J({ ok: false, error: 'date (YYYY-MM-DD) required' }, 400);

  // ── GATE 3: nothing that writes may run on a GET ──────────────────────────
  const MUTATING = op === 'seed' || op === 'clear';
  if (MUTATING && req.method !== 'POST') {
    return J({ ok: false, error: `uat-seed: '${op}' changes NuVizz and must be POSTed. A GET can be fired by an <img> tag, a link preview or a browser prefetch.` }, 405);
  }

  // The write target, named on every reply so a refusal says WHERE it was pointed. Building
  // it can throw when the creds are absent, which must not break the zero-call catalogue read.
  let creds: any = null;
  let credsError: string | null = null;
  try { creds = resolveWriteCreds(); } catch (e: any) { credsError = e?.message || 'NuVizz credentials are not configured on this site'; }
  const bench = {
    mirror: firestoreDatabaseName(), tenantRead: TENANT,
    nuvizzBase: creds?.base ?? null, companyCode: creds?.companyCode ?? null,
  };

  try {
    // ── CATALOGUE — production's day, from Firestore. Zero NuVizz calls. ─────
    if (op === 'catalogue') {
      if (!catalogueEnabled()) return J({ ok: false, error: 'uat-seed: UAT_PROD_CATALOGUE is off on this site', bench }, 503);
      const cat = await readProdDay(TENANT, date, { mask: CATALOGUE_MASK });
      const ledger = await readLedger();
      return J({
        ok: true, op, date, bench, nuvizzCalls: 0,
        dayTotal: cat.dayTotal, unplannedTotal: cat.unplannedTotal, note: cat.note,
        rows: cat.rows,
        seeded: { count: ledger.length, orders: ledger },
      });
    }

    if (op === 'preview' || op === 'seed') {
      if (!catalogueEnabled()) return J({ ok: false, error: 'uat-seed: UAT_PROD_CATALOGUE is off on this site', bench }, 503);
      const stopNbrs: string[] = Array.isArray(body?.stopNbrs) ? body.stopNbrs.map((x: any) => String(x ?? '').trim()).filter(Boolean) : [];
      const label = body?.label ? String(body.label).slice(0, 60) : null;
      if (!stopNbrs.length) return J({ ok: false, error: 'stopNbrs[] required — pick the orders this scenario needs', bench }, 400);
      if (stopNbrs.length > MAX_SEED) return J({ ok: false, error: `uat-seed: ${stopNbrs.length} orders — this bench seeds at most ${MAX_SEED} at a time. Each is a NuVizz call, and the function's budget is ~10s.`, bench }, 400);

      const cat = await readProdDay(TENANT, date, { mask: CATALOGUE_MASK });
      const { plan, skipped, warnings } = planSeed(cat.rows, stopNbrs, { label });
      const prodByNbr = new Map(cat.rows.map((r: any) => [String(r?.stopNbr), r]));
      const payloads = plan.map((p) => ({
        prodStopNbr: p.prodStopNbr, uatStopNbr: p.uatStopNbr, window: p.window,
        payload: buildStopPayload(p.row, { origin: SEED_ORIGIN, serviceDate: date }),
      }));

      if (op === 'preview') {
        return J({ ok: true, op, date, bench, nuvizzCalls: 0, willCreate: plan.length, skipped, warnings, payloads, targetSafe: unsafeWriteTarget(creds) === null });
      }

      // ── GATES 2, 4, 5 — everything below reaches a real tenant ────────────
      if (credsError) return J({ ok: false, error: `uat-seed: ${credsError}`, bench }, 503);
      const unsafe = unsafeWriteTarget(creds);
      if (unsafe) return J({ ok: false, error: `uat-seed: ${unsafe}`, bench }, 403);
      if (!writeEnabled()) return J({ ok: false, error: 'uat-seed: NUVIZZ_WRITE_ENABLED is not true on this site', bench }, 403);
      if (!outboundAllowed('nuvizz-write')) return J({ ok: false, error: outboundRefusal('nuvizz-write'), bench }, 403);
      if (!plan.length) return J({ ok: false, error: 'uat-seed: nothing seedable in that selection', skipped, bench }, 400);

      const reqr = getNuvizzRequester();
      setCallTrigger('uat-seed');
      const before = reqr.getStats().totalThisInstance;
      const at = new Date().toISOString();

      // ── THE LEDGER GOES FIRST — intent, not success. See the header. ──────
      for (const p of plan) {
        await setDoc(`${LEDGER}/${p.uatStopNbr}`, {
          uatStopNbr: p.uatStopNbr, prodStopNbr: p.prodStopNbr, boardDate: date,
          status: 'creating', stopId: null, at, label,
        } as any);
      }

      const created: any[] = [];
      const failed: any[] = [];
      const indexRows: any[] = [];
      for (const p of plan) {
        let r: any;
        try { r = await runOp(reqr, 'createStop' as any, { row: p.row, settings: { origin: SEED_ORIGIN, serviceDate: date } }, creds); }
        catch (e: any) { r = { ok: false, error: e?.message || 'createStop threw' }; }
        if (!r?.ok) {
          // The ledger row STAYS, marked. A create that answered 5xx may still have applied —
          // NuVizz has been observed accepting a write and reporting a failure — and an order
          // nothing records is an order nothing can clear. `clear` reads the tenant to settle it.
          await setDoc(`${LEDGER}/${p.uatStopNbr}`, { uatStopNbr: p.uatStopNbr, prodStopNbr: p.prodStopNbr, boardDate: date, status: 'create-failed', stopId: null, at, label } as any).catch(() => undefined);
          failed.push({ prodStopNbr: p.prodStopNbr, uatStopNbr: p.uatStopNbr, error: r?.error || 'refused', sentBody: r?.sentBody ?? null, rawBody: r?.rawBody ?? null });
          continue;
        }
        const rec = { stopId: r.entityId, stopNbr: r.entityNbr || p.uatStopNbr, updated: !!r.updated };
        await setDoc(`${LEDGER}/${p.uatStopNbr}`, {
          uatStopNbr: String(rec.stopNbr), prodStopNbr: p.prodStopNbr, boardDate: date,
          status: 'created', stopId: rec.stopId ?? null, at, label,
        } as any).catch(() => undefined);
        created.push({ prodStopNbr: p.prodStopNbr, uatStopNbr: String(rec.stopNbr), stopId: rec.stopId ?? null, updated: rec.updated });
        const idxRow = seedIndexRow(prodByNbr.get(p.prodStopNbr), p, rec);
        if (idxRow) { idxRow.uatSeed = { prodStopNbr: p.prodStopNbr, at, label }; indexRows.push(idxRow); }
        else failed.push({ prodStopNbr: p.prodStopNbr, uatStopNbr: p.uatStopNbr, error: 'NuVizz accepted the create but returned no stopId — the order is in the ledger (so a clear will find it) but has no board row' });
      }

      // ── FILL THE UAT BOARD, without a scan ───────────────────────────────
      const base = indexBase(date);
      for (const row of indexRows) await setDoc(`${base}/stops/${row.stopNbr}`, { ...row, last_scanned_at: null, seededAt: at });
      // The board is recounted whatever happened: reporting 0 rows because THIS seed created
      // none would hide the rows a previous seed left standing.
      const meta = await rewriteMeta(date, at);

      const callsUsed = reqr.getStats().totalThisInstance - before;
      await putOpRecord({ clientOpId: `uatseed_${at}`, op: 'uatSeed', status: failed.length ? 'failed' : 'succeeded', tenant: creds.companyCode, at, result: { date, label, created, failed, skipped } }).catch(() => undefined);
      return J({ ok: failed.length === 0, op, date, bench, seeded: created.length, failed: failed.length, boardRows: meta.count, callsUsed, created, failed, skipped, warnings });
    }

    // ── CLEAR — strike the set ────────────────────────────────────────────────
    if (op === 'clear') {
      if (credsError) return J({ ok: false, error: `uat-seed: ${credsError}`, bench }, 503);
      const unsafe = unsafeWriteTarget(creds);
      if (unsafe) return J({ ok: false, error: `uat-seed: ${unsafe}`, bench }, 403);
      if (!writeEnabled()) return J({ ok: false, error: 'uat-seed: NUVIZZ_WRITE_ENABLED is not true on this site', bench }, 403);
      if (!outboundAllowed('nuvizz-write')) return J({ ok: false, error: outboundRefusal('nuvizz-write'), bench }, 403);

      // DRIVEN OFF THE LEDGER, not the board. An order with no board row — a create that
      // answered without a stopId, a row a later write removed — is exactly the one that
      // would otherwise be unreachable forever.
      const ledger = await readLedger();
      if (!ledger.length) return J({ ok: true, op, bench, cancelled: 0, note: 'the bench has nothing seeded', callsUsed: 0 });

      const reqr = getNuvizzRequester();
      setCallTrigger('uat-seed');
      const before = reqr.getStats().totalThisInstance;
      const cancelled: any[] = [];
      const stuck: any[] = [];
      const gone: string[] = [];
      const unplanned: string[] = [];

      for (const row of ledger) {
        const nbr = row.uatStopNbr;
        // Belt and braces: the ledger is the authority on WHAT to clear, and the prefix is a
        // second, independent check on a destructive call. A ledger row that somehow named a
        // production order must never authorise a cancel.
        if (!isUatSeededNbr(nbr)) { stuck.push({ stopNbr: nbr, error: 'ledger row does not carry the UT- prefix — left alone' }); continue; }

        let read: any;
        try { read = await runOp(reqr, 'getStop' as any, { stopNbr: nbr }, creds); }
        catch (e: any) { read = { ok: false, error: e?.message || 'getStop threw' }; }
        if (!read?.ok || !read.stop?.stopId) {
          // Not in the tenant: a create that never landed, or something already cancelled.
          // Nothing to cancel, so the ledger row and any board row go.
          gone.push(nbr);
          await deleteDoc(`${INDEX}/${TENANT}__${row.boardDate}/stops/${nbr}`).catch(() => undefined);
          await deleteDoc(`${LEDGER}/${nbr}`).catch(() => undefined);
          continue;
        }

        // NuVizz refuses to cancel a stop that is on a load — and the bench's flagship test
        // is building a route, which puts every seeded order on one. Without this the bench's
        // own undo fails after the bench's own test, and the remedy is unplanning them by
        // hand in the portal: exactly the work this endpoint exists to replace.
        const onLoad = String(read.stop?.assignedLoadNbr ?? '').trim();
        if (onLoad) {
          let un: any;
          try { un = await runOp(reqr, 'removeStops' as any, { loadNbr: onLoad, removeStopIds: [read.stop.stopId] }, creds); }
          catch (e: any) { un = { ok: false, error: e?.message || 'removeStops threw' }; }
          if (!un?.ok) { stuck.push({ stopNbr: nbr, onLoad, error: `still on route ${onLoad} and it could not be unplanned (${un?.error || 'refused'}) — empty that route in Compare, then clear again` }); continue; }
          unplanned.push(nbr);
        }

        let r: any;
        try { r = await runOp(reqr, 'cancelOrder' as any, { stopNbr: nbr, reasonComments: 'UAT test bench clear' }, creds); }
        catch (e: any) { r = { ok: false, error: e?.message || 'cancelOrder threw' }; }
        if (!r?.ok) { stuck.push({ stopNbr: nbr, error: r?.error || 'refused' }); continue; }

        // The board row and the ledger row go ONLY once NuVizz confirmed the cancel, and the
        // ledger row goes only if the board row actually went: a swallowed delete that still
        // stripped the ledger would leave a row on the board nothing could ever remove.
        cancelled.push(nbr);
        let boardRowGone = true;
        try { await deleteDoc(`${INDEX}/${TENANT}__${row.boardDate}/stops/${nbr}`); } catch { boardRowGone = false; }
        if (boardRowGone) await deleteDoc(`${LEDGER}/${nbr}`).catch(() => undefined);
        else stuck.push({ stopNbr: nbr, error: 'cancelled in NuVizz, but its board row could not be deleted — kept in the ledger so a re-run finishes it' });
      }

      const at = new Date().toISOString();
      const days = [...new Set(ledger.map((r) => r.boardDate).filter(isDay))];
      for (const d of days) await rewriteMeta(d, at).catch(() => undefined);
      const callsUsed = reqr.getStats().totalThisInstance - before;
      await putOpRecord({ clientOpId: `uatclear_${at}`, op: 'uatClear', status: stuck.length ? 'failed' : 'succeeded', tenant: creds.companyCode, at, result: { cancelled, unplanned, gone, stuck } }).catch(() => undefined);
      return J({ ok: stuck.length === 0, op, bench, cancelled: cancelled.length, unplannedFirst: unplanned.length, alreadyGone: gone.length, stuck, callsUsed });
    }

    return J({ ok: false, error: `unknown op '${op}' — use catalogue | preview | seed | clear`, bench }, 400);
  } catch (e: any) {
    return J({ ok: false, op, date, bench, error: e?.message || 'uat-seed failed' }, 500);
  }
};
