// uat-seed.mts — the UAT test bench: pick orders out of production's day, write just those
// into the UAT tenant, run the scenario, strike the set.
//
//   GET  ?op=catalogue&date=YYYY-MM-DD   → production's day to pick from (ZERO NuVizz calls)
//   POST { op:'preview', date, stopNbrs[] } → the exact payloads that WOULD be sent (ZERO calls)
//   POST { op:'seed',    date, stopNbrs[], label? } → create them in UAT + fill the UAT board
//   POST { op:'clear',   date }            → cancel everything this bench seeded, empty the board
//
// Chad, 2026-09-10: "we need to use firestore to see what data/orders are put into system
// daily so we are not running scans. Then we can design a way to test using that information
// so we need to test something we will write just the orders we need to test whatever
// scenario we are testing into the uat."
//
// WHERE THE SAFETY IS. Four gates, and the first is the one that matters: this endpoint
// REFUSES ON PRODUCTION, structurally, keyed on FIRESTORE_DATABASE — the one marker a mirror
// always has and production never does (lib/mirror-guard.mts). It is not "be careful with the
// date"; production cannot reach this code at all. Then: the dispatcher gate, the site's own
// NUVIZZ_WRITE_ENABLED kill switch, and the mirror's outbound gate
// (MIRROR_ALLOW_OUTBOUND=nuvizz-write), which must be set deliberately on the UAT site.
//
// WHAT IT COSTS. catalogue and preview: zero NuVizz calls, ever. seed: one create per order
// against the UAT tenant. clear: a read and a cancel per seeded order. Production is never
// called by any of them — the catalogue is a Firestore read of data production already paid
// for (lib/prod-catalogue.mts, which has no writer and can only address the default database).

import { readProdDay, catalogueEnabled, CATALOGUE_MASK } from './lib/prod-catalogue.mts';
import { planSeed, seedIndexRow, clearableRow, isUatSeededNbr, UAT_PREFIX } from './lib/uat-seed.mts';
import { buildStopPayload } from './lib/nuvizz-write-ops.mts';
import { runOp, resolveWriteCreds } from './lib/nuvizz-write.mts';
import { getNuvizzRequester, setCallTrigger } from './lib/nuvizz-request.mts';
import { isMirrorDeploy, firestoreDatabaseName, outboundAllowed, outboundRefusal } from './lib/mirror-guard.mts';
import { isFirestoreEnabled, getDoc, setDoc, listDocs, deleteDoc, etDayString } from './lib/firestore.mts';
import { putOpRecord } from './lib/write-registries.mts';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';
const INDEX = 'nuvizz_stop_index';
const LEDGER = 'uat_seed';
const MAX_SEED = 60;   // a scenario, not a day. 60 orders is already 60 UAT calls.

// The ship-from every seeded order is created against — the Davis terminal, the same built-in
// the New Order form uses (NEWORDER_ORIGIN_DEFAULT, src/App.jsx). Hard-coded here rather than
// read from a browser's localStorage: this is a server-side bench and the origin must not
// depend on which device happened to open it.
const SEED_ORIGIN = { name: 'Davis Delivery Service', addr1: '943 Gainesville Hwy 200-4000', city: 'Buford', state: 'GA', zip: '30518' };

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const J = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: CORS });

const isDay = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));
const parentId = (dateStr: string) => `${TENANT}__${dateStr}`;

/** The seed ledger for a day: which UAT numbers this bench created, and from what. It is one
 *  half of what makes a clear safe (the other is the UT- prefix — see clearableRow). */
async function readLedger(dateStr: string): Promise<{ nbrs: string[]; at: string | null; label: string | null; byNbr: Record<string, string> }> {
  const d = (await getDoc(`${LEDGER}/${parentId(dateStr)}`)) as any;
  return {
    nbrs: Array.isArray(d?.nbrs) ? d.nbrs.map(String) : [],
    at: d?.at ?? null,
    label: d?.label ?? null,
    byNbr: (d?.byNbr && typeof d.byNbr === 'object') ? d.byNbr : {},
  };
}

/** Recompute the board index meta from what is actually in it. The seeder writes the board
 *  itself (no scan ever runs here), so it owns the counts too — and derives them from the
 *  documents rather than tracking them, which is the version that cannot drift. */
async function rewriteMeta(dateStr: string, at: string): Promise<{ count: number }> {
  const base = `${INDEX}/${parentId(dateStr)}`;
  const docs = await listDocs(`${base}/stops`, { mask: ['isPlanned'] });
  const count = docs.length;
  const plannedCount = docs.filter((d: any) => d?.isPlanned === true).length;
  await setDoc(base, {
    tenant: TENANT, date: dateStr, last_scanned_at: at, count, plannedCount,
    unplannedCount: count - plannedCount,
    lastLoadScanAt: at, lastUnplannedScanAt: at, lastCompletedScanAt: null, scanState: null,
    // So anything reading this board knows it was SEEDED, not scanned. A test board that
    // looks like it was scanned is a test board somebody will eventually mistake for one.
    seededBench: true,
  } as any);
  return { count };
}

export default async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  // ── GATE 1: production cannot reach this code ──────────────────────────────
  // Keyed on FIRESTORE_DATABASE, the one marker a mirror always carries and production never
  // does. Not a date check, not a flag somebody sets — a property of the deploy.
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

  const bench = { mirror: firestoreDatabaseName(), tenantRead: TENANT };

  try {
    // ── CATALOGUE — what came in today, from production's Firestore. Zero NuVizz calls. ──
    if (op === 'catalogue') {
      if (!catalogueEnabled()) return J({ ok: false, error: 'uat-seed: UAT_PROD_CATALOGUE is off on this site', bench }, 503);
      const cat = await readProdDay(TENANT, date, { mask: CATALOGUE_MASK });
      const ledger = await readLedger(date);
      return J({
        ok: true, op, date, bench, nuvizzCalls: 0,
        dayTotal: cat.dayTotal, unplannedTotal: cat.unplannedTotal, note: cat.note,
        rows: cat.rows,
        seeded: { nbrs: ledger.nbrs, at: ledger.at, label: ledger.label, count: ledger.nbrs.length },
      });
    }

    // Everything below takes an explicit list of production order numbers.
    const stopNbrs: string[] = Array.isArray(body?.stopNbrs) ? body.stopNbrs.map((x: any) => String(x ?? '').trim()).filter(Boolean) : [];
    const label = body?.label ? String(body.label).slice(0, 60) : null;

    // ── PREVIEW — the exact payloads, without sending one. Zero NuVizz calls. ──
    // CLAUDE.md: "every job that acts on its own needs a way to ask what it is about to do,
    // without doing it. A dry run is part of the feature, not a nicety."
    if (op === 'preview' || op === 'seed') {
      if (!catalogueEnabled()) return J({ ok: false, error: 'uat-seed: UAT_PROD_CATALOGUE is off on this site', bench }, 503);
      if (!stopNbrs.length) return J({ ok: false, error: 'stopNbrs[] required — pick the orders this scenario needs', bench }, 400);
      if (stopNbrs.length > MAX_SEED) return J({ ok: false, error: `uat-seed: ${stopNbrs.length} orders — this bench seeds at most ${MAX_SEED} at a time (each one is a NuVizz call on the UAT tenant)`, bench }, 400);

      const cat = await readProdDay(TENANT, date, { mask: CATALOGUE_MASK });
      const { plan, skipped, warnings } = planSeed(cat.rows, stopNbrs, { label });
      const prodByNbr = new Map(cat.rows.map((r: any) => [String(r?.stopNbr), r]));
      const payloads = plan.map((p) => ({
        prodStopNbr: p.prodStopNbr,
        uatStopNbr: p.uatStopNbr,
        window: p.window,
        // The literal body that would go to NuVizz. The service date is the production row's
        // own delivery day, so a scenario's windows line up with the board it is tested on.
        payload: buildStopPayload(p.row, { origin: SEED_ORIGIN, serviceDate: date }),
      }));

      if (op === 'preview') {
        return J({ ok: true, op, date, bench, nuvizzCalls: 0, willCreate: plan.length, skipped, warnings, payloads });
      }

      // ── SEED — the only path here that spends a call, and only against UAT ──
      if (!outboundAllowed('nuvizz-write')) return J({ ok: false, error: outboundRefusal('nuvizz-write'), bench }, 403);
      if (!plan.length) return J({ ok: false, error: 'uat-seed: nothing seedable in that selection', skipped, bench }, 400);

      const reqr = getNuvizzRequester();
      setCallTrigger('uat-seed');
      const before = reqr.getStats().totalThisInstance;
      const creds = resolveWriteCreds();
      const created: any[] = [];
      const failed: any[] = [];
      const indexRows: any[] = [];
      // Sequential: a bench is not a race, and one create at a time keeps the UAT tenant's
      // call pattern readable in the ledger when something goes wrong.
      for (const p of plan) {
        const payload = { row: p.row, settings: { origin: SEED_ORIGIN, serviceDate: date } };
        let r: any;
        try { r = await runOp(reqr, 'createStop' as any, payload, creds); }
        catch (e: any) { r = { ok: false, error: e?.message || 'createStop threw' }; }
        if (!r?.ok) { failed.push({ prodStopNbr: p.prodStopNbr, uatStopNbr: p.uatStopNbr, error: r?.error || 'refused', sentBody: r?.sentBody ?? null, rawBody: r?.rawBody ?? null }); continue; }
        const rec = { stopId: r.entityId, stopNbr: r.entityNbr || p.uatStopNbr, updated: !!r.updated };
        created.push({ prodStopNbr: p.prodStopNbr, uatStopNbr: String(rec.stopNbr), stopId: rec.stopId ?? null, updated: rec.updated });
        const prodRow = prodByNbr.get(p.prodStopNbr);
        const idxRow = seedIndexRow(prodRow, p, rec);
        // No stopId back = we cannot prove the order exists, so no board row is written for
        // it. A phantom row is worse than a short board: the next test would plan freight
        // that is not there.
        if (idxRow) { idxRow.uatSeed = { prodStopNbr: p.prodStopNbr, at: new Date().toISOString(), label }; indexRows.push(idxRow); }
        else failed.push({ prodStopNbr: p.prodStopNbr, uatStopNbr: p.uatStopNbr, error: 'NuVizz accepted the create but returned no stopId — no board row was written for it' });
      }

      // ── FILL THE UAT BOARD, without a scan ───────────────────────────────
      // The seeder knows exactly what it created, so it writes the rows itself. This is the
      // step that makes the bench usable: a mirror never scans, so nothing else would ever
      // put these orders on the board.
      const at = new Date().toISOString();
      const base = `${INDEX}/${parentId(date)}`;
      for (const row of indexRows) await setDoc(`${base}/stops/${row.stopNbr}`, { ...row, last_scanned_at: at });
      const meta = indexRows.length ? await rewriteMeta(date, at) : { count: 0 };

      // Ledger: both the seed record (what a clear may touch) and the write-op journal.
      const prev = await readLedger(date);
      const nbrs = [...new Set([...prev.nbrs, ...created.map((c) => c.uatStopNbr)])];
      const byNbr = { ...prev.byNbr };
      for (const c of created) byNbr[c.uatStopNbr] = c.prodStopNbr;
      await setDoc(`${LEDGER}/${parentId(date)}`, { tenant: TENANT, date, nbrs, byNbr, at, label });

      const callsUsed = reqr.getStats().totalThisInstance - before;
      const result = { seeded: created.length, failed: failed.length, boardRows: meta.count, callsUsed };
      await putOpRecord({ clientOpId: `uatseed_${at}`, op: 'uatSeed', status: failed.length ? 'failed' : 'succeeded', tenant: creds.companyCode, at, result: { date, label, created, failed, skipped } }).catch(() => undefined);

      return J({ ok: failed.length === 0, op, date, bench, ...result, created, failed, skipped, warnings });
    }

    // ── CLEAR — strike the set. Destructive, so it needs both keys. ───────────
    if (op === 'clear') {
      if (!outboundAllowed('nuvizz-write')) return J({ ok: false, error: outboundRefusal('nuvizz-write'), bench }, 403);
      const ledger = await readLedger(date);
      const ledgerNbrs = new Set(ledger.nbrs);
      const base = `${INDEX}/${parentId(date)}`;
      const rows = await listDocs(`${base}/stops`, { mask: ['stopNbr'] });
      // BOTH halves: the UT- prefix AND the ledger. Either alone is a way to cancel something
      // nobody meant to cancel — a hand-made UT- order typed in the portal, or a ledger that
      // has drifted from the board. Anything that fails either check is left alone and NAMED.
      const targets = rows.map((d: any) => String(d?.stopNbr || d?._id)).filter(Boolean);
      const clearable = targets.filter((nbr) => clearableRow({ stopNbr: nbr }, ledgerNbrs));
      const leftAlone = targets.filter((nbr) => !clearable.includes(nbr))
        .map((nbr) => ({ stopNbr: nbr, why: isUatSeededNbr(nbr) ? 'carries the UT- prefix but is not in this bench\'s seed ledger' : 'was not seeded by this bench' }));

      const reqr = getNuvizzRequester();
      setCallTrigger('uat-seed');
      const before = reqr.getStats().totalThisInstance;
      const creds = resolveWriteCreds();
      const cancelled: string[] = [];
      const stuck: any[] = [];
      for (const nbr of clearable) {
        let r: any;
        try { r = await runOp(reqr, 'cancelOrder' as any, { stopNbr: nbr, reasonComments: 'UAT test bench clear' }, creds); }
        catch (e: any) { r = { ok: false, error: e?.message || 'cancelOrder threw' }; }
        if (r?.ok) cancelled.push(nbr);
        else stuck.push({ stopNbr: nbr, error: r?.error || 'refused' });
      }
      // The board row goes only for an order NuVizz confirmed cancelled. A row deleted for an
      // order still live in the tenant is an order nobody can see to clean up afterwards.
      for (const nbr of cancelled) await deleteDoc(`${base}/stops/${encodeURIComponent(nbr)}`).catch(() => undefined);
      const at = new Date().toISOString();
      const meta = await rewriteMeta(date, at);
      const remaining = ledger.nbrs.filter((n) => !cancelled.includes(n));
      const byNbr = { ...ledger.byNbr };
      for (const n of cancelled) delete byNbr[n];
      await setDoc(`${LEDGER}/${parentId(date)}`, { tenant: TENANT, date, nbrs: remaining, byNbr, at, label: ledger.label });

      const callsUsed = reqr.getStats().totalThisInstance - before;
      await putOpRecord({ clientOpId: `uatclear_${at}`, op: 'uatClear', status: stuck.length ? 'failed' : 'succeeded', tenant: creds.companyCode, at, result: { date, cancelled, stuck, leftAlone } }).catch(() => undefined);
      return J({ ok: stuck.length === 0, op, date, bench, cancelled: cancelled.length, stuck, leftAlone, boardRows: meta.count, callsUsed });
    }

    return J({ ok: false, error: `unknown op '${op}' — use catalogue | preview | seed | clear`, bench }, 400);
  } catch (e: any) {
    return J({ ok: false, op, date, bench, error: e?.message || 'uat-seed failed' }, 500);
  }
};
