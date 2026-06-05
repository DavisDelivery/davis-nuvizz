// netlify/functions/nuvizz-write-test.mts
//
// PHASE-4 FEASIBILITY SPIKE — the FIRST and ONLY NuVizz WRITE in this codebase.
// Everything else is read-only. Purpose: prove we can write one load to NuVizz
// (import → readback → cancel) before investing further. Deliberately gated so it
// CANNOT fire by accident and CANNOT touch the live DAVIS tenant.
//
// THREE INDEPENDENT SAFETY GATES (all required):
//   1. NOT production — refuses when Netlify CONTEXT === 'production'.
//   2. Explicit enable — refuses unless NUVIZZ_WRITE_TEST_ENABLED === 'true'.
//   3. DEDICATED write target — uses NUVIZZ_WRITE_BASE_URL / _USER / _PASS /
//      _COMPANY ONLY (never the prod NUVIZZ_DAVIS_* read creds). If any is unset it
//      refuses, so it physically cannot write to live DAVIS. Point these at the
//      NuVizz UAT/sandbox tenant.
//   + the POST body must carry { confirm: 'WRITE-TEST-OK' }.
//
// Actions (body.action):
//   LOAD path (asynchronous):
//     'import'  → POST /load/update/default/{company}  (create one TEST load, NOT
//                 assigned/dispatched — we never call /load/assignanddispatch)
//     'verify'  → GET  /load/info/{loadNbr}/{company}
//     'cancel'  → POST /load/cancel/{company}
//   STOP path (synchronous — the one PROVEN to land on UAT, see note below):
//     'stop-import'  → POST /stop/sync/update/{company}  (inline create result)
//     'stop-verify'  → GET  /stop/info/{stopNbr}/{company}
//     'stop-cancel'  → POST /stop/cancel/{company}  ({ reasonCode } required)
// Returns the raw NuVizz status + body so the 200/400/401/403 verdict is visible.
// Endpoint shapes per the pinned v7 OpenAPI spec.
//
// LIVE FEASIBILITY RESULT (2026-06-05, UAT tenant Davisv5 = "Davis Delivery V5"):
//   • Auth works — never 401/403, always 200. We HAVE write permission.
//   • The synchronous STOP path is fully proven end-to-end:
//       POST /stop/sync/update → 200 "Stop created successfully" {created:1, failed:0}
//       GET  /stop/info        → 200, our data stored & normalized (addresses geocoded,
//                                schedule GMT→America/New_York, timeConstraint STRICT)
//       POST /stop/cancel      → 200 "SUCCESS"  (reversible cleanup)
//   • The LOAD import is ASYNCHRONOUS: it returns 200 "Async import SUCCESS" + an
//     AppMessageLog Id, but a minimal load did NOT appear on readback — the async
//     backend rejected it silently (likely needs valid master data: a registered
//     origin facility/depot). There is no API to query that async log, so the load
//     path's true verdict is opaque. Prefer the synchronous stop path for trustworthy
//     results; satisfy load master-data requirements before relying on /load/update.

const CONFIRM = 'WRITE-TEST-OK';

function writeCreds() {
  const base = process.env.NUVIZZ_WRITE_BASE_URL;       // e.g. the UAT .../v7 base
  const user = process.env.NUVIZZ_WRITE_USER;
  const pass = process.env.NUVIZZ_WRITE_PASS;
  const company = process.env.NUVIZZ_WRITE_COMPANY;
  return { base, user, pass, company };
}

function authHeader(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// Minimal-but-structured DeliverItLoad (one load, one delivery stop), modeled on the
// spec's LoadAPIExample. Clearly marked TEST; a future date; NOT dispatched.
function buildTestLoad(company: string) {
  const d = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10); // tomorrow
  const loadNbr = `WRITETEST-${Date.now()}`;
  const depot = { addr1: '943 Gainesville Hwy', city: 'Buford', state: 'GA', zip: '30518', country: 'USA', latitude: 34.14838, longitude: -83.95948 };
  return {
    loadNbr,
    body: {
      companyCode: company,
      loads: [{
        loadHeader: {
          loadNbr,
          earliestStartDttm: `${d}T08:00:00`,
          latestStartDttm: `${d}T10:00:00`,
          originAddr1: depot.addr1, originCity: depot.city, originState: depot.state, originZip: depot.zip, originCountry: depot.country,
          origin: company, originName: 'Buford Terminal (WRITE TEST)', loadTimeZone: 'GMT', returnToDepot: 'ALWAYS',
        },
        stops: [{
          stopNbr: `${loadNbr}-S1`, stopSeq: 1, stopType: 'DO', bol: 'WRITETEST',
          from: { address: { name: 'Buford Terminal', ...depot } },
          to: {
            address: { name: 'WRITE TEST — SAFE TO DELETE', addr1: '2860 Cumberland Mall', city: 'Atlanta', state: 'GA', zip: '30339', country: 'USA', latitude: 33.8838, longitude: -84.4674 },
            contact: { contactName: 'Write Test', phone: '0000000000' },
            schedule: { timeFrom: `${d}T08:00:00`, timeTo: `${d}T17:00:00`, timeZone: 'GMT', estDuration: 20 },
          },
        }],
      }],
    },
  };
}

// Minimal synchronous Stop (one DO stop) for /stop/sync/update — the PROVEN write.
// stopNbr must be <= 20 chars (NuVizz reason 1401), so keep the prefix short.
function buildTestStop(_company: string) {
  const d = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10); // tomorrow
  const stopNbr = `WT${Math.floor(Date.now() / 1000)}`; // e.g. WT1780678384 (12 chars)
  const depot = { addr1: '943 Gainesville Hwy', city: 'Buford', state: 'GA', zip: '30518', country: 'USA', latitude: 34.14838, longitude: -83.95948 };
  return {
    stopNbr,
    body: {
      companyCode: _company,
      stop: {
        stopNbr, stopSeq: 1, stopType: 'DO', bol: 'WRITETEST',
        from: {
          address: { name: 'Buford Terminal', ...depot },
          contact: { contactName: 'Write Test', phone: '0000000000' },
          schedule: { timeFrom: `${d}T08:00:00`, timeTo: `${d}T17:00:00`, timeZone: 'GMT', estDuration: 20 },
        },
        to: {
          address: { name: 'WRITE TEST - SAFE TO DELETE', addr1: '2860 Cumberland Mall', city: 'Atlanta', state: 'GA', zip: '30339', country: 'USA', latitude: 33.8838, longitude: -84.4674 },
          contact: { contactName: 'Write Test', phone: '0000000000' },
          schedule: { timeFrom: `${d}T08:00:00`, timeTo: `${d}T17:00:00`, timeZone: 'GMT', estDuration: 20 },
        },
      },
    },
  };
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

export default async function handler(req: Request): Promise<Response> {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { 'Content-Type': 'application/json' } });

  // ── Gate 1: never on production ──
  if ((process.env.CONTEXT || '') === 'production') {
    return json({ ok: false, refused: 'This write spike is disabled on production. Use a deploy preview.' }, 403);
  }
  // ── Gate 2: explicit enable flag ──
  if (process.env.NUVIZZ_WRITE_TEST_ENABLED !== 'true') {
    return json({ ok: false, refused: 'Set NUVIZZ_WRITE_TEST_ENABLED=true on the preview to arm the spike.' }, 403);
  }
  // ── Gate 3: dedicated write target only (never the prod DAVIS read creds) ──
  const { base, user, pass, company } = writeCreds();
  if (!base || !user || !pass || !company) {
    return json({ ok: false, refused: 'Set NUVIZZ_WRITE_BASE_URL / NUVIZZ_WRITE_USER / NUVIZZ_WRITE_PASS / NUVIZZ_WRITE_COMPANY (UAT/sandbox) to run.' }, 400);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  if (body?.confirm !== CONFIRM) {
    return json({ ok: false, refused: `Include { "confirm": "${CONFIRM}" } in the body to proceed.` }, 400);
  }

  const auth = authHeader(user, pass);
  const action = body?.action;

  try {
    if (action === 'import') {
      const { loadNbr, body: payload } = buildTestLoad(company);
      const url = `${base.replace(/\/$/, '')}/load/update/default/${encodeURIComponent(company)}`;
      const res = await callNuvizz('POST', url, auth, payload);
      return json({ ok: res.ok, action, loadNbr, url, request: payload, response: res });
    }
    if (action === 'verify') {
      const loadNbr = body?.loadNbr;
      if (!loadNbr) return json({ ok: false, error: 'verify needs { loadNbr }' }, 400);
      const url = `${base.replace(/\/$/, '')}/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(company)}`;
      const res = await callNuvizz('GET', url, auth);
      return json({ ok: res.ok, action, loadNbr, url, response: res });
    }
    if (action === 'cancel') {
      const loadNbr = body?.loadNbr;
      if (!loadNbr) return json({ ok: false, error: 'cancel needs { loadNbr }' }, 400);
      const url = `${base.replace(/\/$/, '')}/load/cancel/${encodeURIComponent(company)}`;
      const res = await callNuvizz('POST', url, auth, { companyCode: company, loadNbr });
      return json({ ok: res.ok, action, loadNbr, url, response: res });
    }
    // ── Synchronous STOP path (proven to land) ──
    if (action === 'stop-import') {
      const { stopNbr, body: payload } = buildTestStop(company);
      const url = `${base.replace(/\/$/, '')}/stop/sync/update/${encodeURIComponent(company)}`;
      const res = await callNuvizz('POST', url, auth, payload);
      return json({ ok: res.ok, action, stopNbr, url, request: payload, response: res });
    }
    if (action === 'stop-verify') {
      const stopNbr = body?.stopNbr;
      if (!stopNbr) return json({ ok: false, error: 'stop-verify needs { stopNbr }' }, 400);
      const url = `${base.replace(/\/$/, '')}/stop/info/${encodeURIComponent(stopNbr)}/${encodeURIComponent(company)}`;
      const res = await callNuvizz('GET', url, auth);
      return json({ ok: res.ok, action, stopNbr, url, response: res });
    }
    if (action === 'stop-cancel') {
      const stopNbr = body?.stopNbr;
      if (!stopNbr) return json({ ok: false, error: 'stop-cancel needs { stopNbr }' }, 400);
      const url = `${base.replace(/\/$/, '')}/stop/cancel/${encodeURIComponent(company)}`;
      const res = await callNuvizz('POST', url, auth, { stopNbr, reasonCode: 'CANCEL', reasonComments: 'write-test cleanup', sourceType: 'API' });
      return json({ ok: res.ok, action, stopNbr, url, response: res });
    }
    return json({ ok: false, error: "action must be 'import' | 'verify' | 'cancel' | 'stop-import' | 'stop-verify' | 'stop-cancel'" }, 400);
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'request failed' }, 500);
  }
}
