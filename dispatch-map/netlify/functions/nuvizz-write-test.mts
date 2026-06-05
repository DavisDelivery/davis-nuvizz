// netlify/functions/nuvizz-write-test.mts
//
// PHASE-4 FEASIBILITY SPIKE — gated NuVizz WRITE probe (UAT only). Everything else
// in the codebase is read-only. CANNOT fire by accident, CANNOT touch live DAVIS,
// and NEVER dispatches a driver.
//
// FOUR INDEPENDENT SAFETY GATES (all required):
//   1. NOT production — refuses when Netlify CONTEXT === 'production'.
//   2. Explicit enable — refuses unless NUVIZZ_WRITE_TEST_ENABLED === 'true'.
//   3. DEDICATED write target — uses NUVIZZ_WRITE_BASE_URL / _USER / _PASS / _COMPANY
//      ONLY (never the prod NUVIZZ_DAVIS_* read creds). Refuses if any unset. Point
//      these at the NuVizz UAT/sandbox tenant.
//   4. The POST body must carry { confirm: 'WRITE-TEST-OK' }.
// It never calls /load/assignanddispatch (no driver dispatch).
//
// ── v2 (this file): ASSEMBLE A LOAD FROM EXISTING STOPS ─────────────────────────
// Correcting the v1 jargon error: we do NOT author stops — the shipper (e.g. ULINE)
// does. We build LOADS and attach EXISTING Un-Planned stops to them BY REFERENCE
// (stopNbr), in our sequence — the operation the charter calls "assemble a Load from
// existing stops in our sequence." The right endpoint is routePlan/update with
// `planStops` (stop REFERENCES, not inline stop objects).
//
//   action 'assemble-existing' — read an existing Un-Planned stop, create ONE neutral
//     test load (loadNbr prefix DDTEST-, marked SAFE TO DELETE), attach the stop by
//     reference via POST /routePlan/update/{routeService}/{company}, then read both
//     back. Reuses the stop's OWN schedule so the borrowed stop is not altered.
//   action 'assemble-detach' — restore: re-POST routePlan/update with the borrowed
//     stop REMOVED (empty planStops) so it returns to Un-Planned. NEVER cancels the
//     borrowed stop.
//   action 'assemble-cancel-load' — cancel the TEST LOAD only (POST /load/cancel).
//     Refuses to cancel anything that isn't a DDTEST-/WT-LOAD- test load.
//
// LIVE RESULT (2026-06-05, UAT Davisv5): the request VALIDATES (correct planStops
// reference shape) but POST /routePlan/update/default returns HTTP 500 / NPE 998
// "DeliverItLoad ... is null" for serviceName 'default' (the documented value) and
// every variant tried — i.e. routePlan cannot assemble the load on this tenant.
// Nothing was created; the borrowed ULINE stop (050626_S15) stayed Un-Planned. The
// missing piece is NuVizz-side: the route-assembly serviceName for Davis (the one the
// portal's "Add Stop(s)/Load(s)" uses), the registered origin/depot facility, and the
// company that should own the assembled load (stops are ULINE-owned; our creds are
// Davisv5). Set NUVIZZ_WRITE_ROUTE_SERVICE once NuVizz provides it, then re-run.
//
// The synchronous STOP path (stop-import/-verify/-cancel) below is proven to persist
// and is reversible; kept for reference.

const CONFIRM = 'WRITE-TEST-OK';
const TEST_LOAD_PREFIXES = ['DDTEST-', 'WT-LOAD-', 'DDTEST', 'WT-LOAD'];

function writeCreds() {
  return {
    base: process.env.NUVIZZ_WRITE_BASE_URL,        // e.g. the UAT .../v7 base
    user: process.env.NUVIZZ_WRITE_USER,
    pass: process.env.NUVIZZ_WRITE_PASS,
    company: process.env.NUVIZZ_WRITE_COMPANY,
    // serviceName for routePlan/load assembly. 'default' per the v7 spec when there is
    // no custom integration; on Davisv5 it 500s — override once NuVizz supplies the real one.
    routeService: process.env.NUVIZZ_WRITE_ROUTE_SERVICE || 'default',
  };
}

function authHeader(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function isTestLoadNbr(loadNbr: string): boolean {
  return TEST_LOAD_PREFIXES.some((p) => loadNbr.startsWith(p));
}

async function callNuvizz(method: string, url: string, auth: string, body?: unknown) {
  const resp = await fetch(url, {
    method,
    headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await resp.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep raw text */ }
  return { status: resp.status, ok: resp.ok, body: parsed };
}

// ── synchronous STOP create (proven), kept for reference ──
function buildTestStop(company: string) {
  const d = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const stopNbr = `ZZTEST${Math.floor(Date.now() / 1000)}`; // neutral, disposable
  const depot = { addr1: '943 Gainesville Hwy', city: 'Buford', state: 'GA', zip: '30518', country: 'USA', latitude: 34.14838, longitude: -83.95948 };
  return {
    stopNbr,
    body: {
      companyCode: company,
      stop: {
        stopNbr, stopSeq: 1, stopType: 'DO', bol: 'ZZTEST',
        from: { address: { name: 'Buford Terminal', ...depot }, schedule: { timeFrom: `${d}T08:00:00`, timeTo: `${d}T17:00:00`, timeZone: 'GMT', estDuration: 20 } },
        to: { address: { name: 'ZZTEST - SAFE TO DELETE', addr1: '2860 Cumberland Mall', city: 'Atlanta', state: 'GA', zip: '30339', country: 'USA', latitude: 33.8838, longitude: -84.4674 }, schedule: { timeFrom: `${d}T08:00:00`, timeTo: `${d}T17:00:00`, timeZone: 'GMT', estDuration: 20 } },
      },
    },
  };
}

// ── assemble: build a routePlan body that attaches EXISTING stops BY REFERENCE ──
// `stops` is the read-back stop record(s) so we can pass each stop's OWN schedule
// through unchanged (we attach/sequence; we do not rewrite the borrowed stop content).
function buildAssembleBody(company: string, loadNbr: string, stops: any[]) {
  const depot = { name: 'Buford Terminal', addr1: '943 Gainesville Hwy', city: 'Buford', state: 'GA', zip: '30518', country: 'USA', latitude: 34.14838, longitude: -83.95948 };
  const n = stops.length;
  const planStops = stops.map((s, i) => {
    const fromSched = s?.from?.schedule ?? { timeFrom: undefined, timeTo: undefined, timeZone: 'America/New_York' };
    const toSched = s?.to?.schedule ?? { timeFrom: undefined, timeTo: undefined, timeZone: 'America/New_York' };
    return {
      stopNbr: s.stopNbr,
      from: { seq: i + 1, schedule: { timeFrom: fromSched.timeFrom, timeTo: fromSched.timeTo, timeZone: fromSched.timeZone } },
      to: { seq: n + i + 1, schedule: { timeFrom: toSched.timeFrom, timeTo: toSched.timeTo, timeZone: toSched.timeZone } },
    };
  });
  return {
    companyCode: company,
    route: {
      loadHeader: {
        loadNbr, routeName: 'DDTEST-DEL', routeDesc: 'SAFE TO DELETE',
        earliestStartDttm: '2026-06-05T06:00:00', latestStartDttm: '2026-06-05T08:00:00',
        originAddr1: depot.addr1, originCity: depot.city, originState: depot.state, originZip: depot.zip, originCountry: depot.country,
        origin: company, originName: depot.name, loadTimeZone: 'America/New_York', returnToDepot: 'ALWAYS',
        originLatitude: depot.latitude, originLongitude: depot.longitude, depot: { address: depot },
      },
      planStops,
    },
  };
}

export default async function handler(req: Request): Promise<Response> {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { 'Content-Type': 'application/json' } });

  // ── Gate 1: never on production ──
  if ((process.env.CONTEXT || '') === 'production') {
    return json({ ok: false, refused: 'Disabled on production. Use a deploy preview.' }, 403);
  }
  // ── Gate 2: explicit enable flag ──
  if (process.env.NUVIZZ_WRITE_TEST_ENABLED !== 'true') {
    return json({ ok: false, refused: 'Set NUVIZZ_WRITE_TEST_ENABLED=true on the preview to arm the spike.' }, 403);
  }
  // ── Gate 3: dedicated write target only (never the prod DAVIS read creds) ──
  const { base, user, pass, company, routeService } = writeCreds();
  if (!base || !user || !pass || !company) {
    return json({ ok: false, refused: 'Set NUVIZZ_WRITE_BASE_URL / _USER / _PASS / _COMPANY (UAT/sandbox) to run.' }, 400);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  // ── Gate 4: explicit confirm token ──
  if (body?.confirm !== CONFIRM) {
    return json({ ok: false, refused: `Include { "confirm": "${CONFIRM}" } in the body to proceed.` }, 400);
  }

  const auth = authHeader(user!, pass!);
  const root = base!.replace(/\/$/, '');
  const action = body?.action;
  const enc = encodeURIComponent;

  try {
    // ============ ASSEMBLE A LOAD FROM EXISTING STOPS (the v2 operation) ============
    if (action === 'assemble-existing') {
      // body.stopNbrs: string[] of EXISTING Un-Planned stops to attach by reference.
      const stopNbrs: string[] = Array.isArray(body?.stopNbrs) ? body.stopNbrs : (body?.stopNbr ? [body.stopNbr] : []);
      if (!stopNbrs.length) return json({ ok: false, error: 'assemble-existing needs { stopNbrs: [..] } (existing Un-Planned stops)' }, 400);
      const loadNbr: string = body?.loadNbr || `DDTEST-${Date.now()}`.slice(0, 20);
      if (!isTestLoadNbr(loadNbr)) return json({ ok: false, error: `loadNbr must be a disposable test prefix (${TEST_LOAD_PREFIXES.join(', ')})` }, 400);

      // 1) Read each existing stop (confirm it exists + capture its OWN schedule; never authored here).
      const reads: any[] = [];
      for (const sn of stopNbrs) {
        const r = await callNuvizz('GET', `${root}/stop/info/${enc(sn)}/${enc(company!)}`, auth);
        const stop = (r.body as any)?.Stop?.stop;
        reads.push({ stopNbr: sn, status: r.status, found: !!stop, routeAsgnInfo: stop?.routeAsgnInfo ?? null, stop });
      }
      const missing = reads.filter((r) => !r.found);
      if (missing.length) return json({ ok: false, error: 'some stops not found', reads }, 400);
      const planned = reads.filter((r) => r.routeAsgnInfo);
      if (planned.length) return json({ ok: false, error: 'refusing: some stops are already planned (not Un-Planned)', planned: planned.map((p) => p.stopNbr) }, 400);

      // 2+3) Create the neutral test load AND attach the existing stops by reference (one routePlan call).
      const payload = buildAssembleBody(company!, loadNbr, reads.map((r) => r.stop));
      const url = `${root}/routePlan/update/${enc(routeService)}/${enc(company!)}`;
      const res = await callNuvizz('POST', url, auth, payload);

      // 4) Read back the load and each stop to confirm attachment.
      const loadBack = await callNuvizz('GET', `${root}/load/info/${enc(loadNbr)}/${enc(company!)}`, auth);
      const stopsBack = [];
      for (const sn of stopNbrs) {
        const r = await callNuvizz('GET', `${root}/stop/info/${enc(sn)}/${enc(company!)}`, auth);
        stopsBack.push({ stopNbr: sn, routeAsgnInfo: (r.body as any)?.Stop?.stop?.routeAsgnInfo ?? null });
      }
      const attached = stopsBack.every((s) => s.routeAsgnInfo);
      return json({ ok: res.ok && attached, action, loadNbr, routeService, url, request: payload, response: res, readback: { load: { status: loadBack.status }, stops: stopsBack }, attached });
    }

    // ============ RESTORE: detach the borrowed stop(s) → back to Un-Planned ============
    if (action === 'assemble-detach') {
      const loadNbr: string = body?.loadNbr;
      if (!loadNbr || !isTestLoadNbr(loadNbr)) return json({ ok: false, error: 'assemble-detach needs a { loadNbr } of a DDTEST-/WT-LOAD- test load' }, 400);
      // Re-plan the test load with NO stops → the borrowed stops return to Un-Planned.
      // We never cancel the borrowed stops themselves.
      const payload = { companyCode: company, route: { loadHeader: { loadNbr, earliestStartDttm: '2026-06-05T06:00:00' }, planStops: [] } };
      const url = `${root}/routePlan/update/${enc(routeService)}/${enc(company!)}`;
      const res = await callNuvizz('POST', url, auth, payload);
      const stopsBack = [];
      for (const sn of (Array.isArray(body?.stopNbrs) ? body.stopNbrs : (body?.stopNbr ? [body.stopNbr] : []))) {
        const r = await callNuvizz('GET', `${root}/stop/info/${enc(sn)}/${enc(company!)}`, auth);
        stopsBack.push({ stopNbr: sn, routeAsgnInfo: (r.body as any)?.Stop?.stop?.routeAsgnInfo ?? null, restored: !((r.body as any)?.Stop?.stop?.routeAsgnInfo) });
      }
      return json({ ok: res.ok, action, loadNbr, url, response: res, stopsBack });
    }

    // ============ Cancel the TEST LOAD only (never a stop) ============
    if (action === 'assemble-cancel-load') {
      const loadNbr: string = body?.loadNbr;
      if (!loadNbr) return json({ ok: false, error: 'assemble-cancel-load needs { loadNbr }' }, 400);
      if (!isTestLoadNbr(loadNbr)) return json({ ok: false, refused: 'refusing to cancel a non-test load; only DDTEST-/WT-LOAD- loads' }, 403);
      const url = `${root}/load/cancel/${enc(company!)}`;
      const res = await callNuvizz('POST', url, auth, { loadNbr, reasonCode: 'CANCEL', reasonComments: 'test load cleanup', sourceType: 'API' });
      return json({ ok: res.ok, action, loadNbr, url, response: res });
    }

    // ============ synchronous STOP path (proven; reference) ============
    if (action === 'stop-import') {
      const { stopNbr, body: payload } = buildTestStop(company!);
      const url = `${root}/stop/sync/update/${enc(company!)}`;
      const res = await callNuvizz('POST', url, auth, payload);
      return json({ ok: res.ok, action, stopNbr, url, request: payload, response: res });
    }
    if (action === 'stop-verify') {
      const stopNbr = body?.stopNbr;
      if (!stopNbr) return json({ ok: false, error: 'stop-verify needs { stopNbr }' }, 400);
      const res = await callNuvizz('GET', `${root}/stop/info/${enc(stopNbr)}/${enc(company!)}`, auth);
      return json({ ok: res.ok, action, stopNbr, response: res });
    }
    if (action === 'stop-cancel') {
      const stopNbr = body?.stopNbr;
      if (!stopNbr) return json({ ok: false, error: 'stop-cancel needs { stopNbr }' }, 400);
      // Only ever cancel our own disposable ZZTEST stops — never a borrowed/real stop.
      if (!String(stopNbr).startsWith('ZZTEST')) return json({ ok: false, refused: 'refusing to cancel a non-ZZTEST stop' }, 403);
      const url = `${root}/stop/cancel/${enc(company!)}`;
      const res = await callNuvizz('POST', url, auth, { stopNbr, reasonCode: 'CANCEL', reasonComments: 'test cleanup', sourceType: 'API' });
      return json({ ok: res.ok, action, stopNbr, url, response: res });
    }

    return json({ ok: false, error: "action must be one of: assemble-existing | assemble-detach | assemble-cancel-load | stop-import | stop-verify | stop-cancel" }, 400);
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'request failed' }, 500);
  }
}
