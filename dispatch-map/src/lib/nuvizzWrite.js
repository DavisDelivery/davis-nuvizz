// src/lib/nuvizzWrite.js
//
// Browser write-client for the live-write endpoint. The browser NEVER holds NuVizz
// creds — it POSTs an {op,payload} envelope to /.netlify/functions/nuvizz-write, which
// adds Basic auth server-side and forwards to NuVizz. Mirrors the rest of the app's
// fetch() convention (cache:'no-store', JSON in/out).
//
// SAFETY: pass { dryRun:true } and NOTHING fires to NuVizz — the endpoint returns the
// plan of what WOULD happen. This is what the Compare panel uses in Beta mode and while
// you build/reorder; a real write only happens on Save in Live mode (and only if the
// server-side NUVIZZ_WRITE_ENABLED flag is set). A clientOpId makes a Save idempotent.

const WRITE_FN = '/.netlify/functions/nuvizz-write';

export async function callWrite(op, payload = {}, opts = {}) {
  const { dryRun = false, clientOpId, createdBy } = opts;
  let res;
  try {
    res = await fetch(WRITE_FN, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, payload, dryRun, clientOpId, createdBy }),
    });
  } catch (e) {
    return { ok: false, error: `network error: ${e?.message || e}` };
  }
  let j;
  try { j = await res.json(); } catch { j = { ok: false, error: `bad response (${res.status})` }; }
  if (typeof j.ok !== 'boolean') j.ok = res.ok;
  j.httpStatus = res.status;
  return j;
}

// Convenience wrappers (thin — all of these go through callWrite).
export const previewCommit = (payload, opts = {}) => callWrite('commitLoad', payload, { ...opts, dryRun: true });
export const commitLoad = (payload, opts = {}) => callWrite('commitLoad', payload, { ...opts, dryRun: false });
export const fetchRoster = (opts = {}) => callWrite('roster', {}, { ...opts, dryRun: false });

// Write a dispatcher/driver instruction onto a live order (§N). The server reads the
// order first and merges onto its CURRENT comments — NuVizz replaces the whole list on
// this endpoint, so a blind write would erase the carrier's own instructions — then
// reads back to prove nothing else moved. audience: 'dispatcher' | 'driver' | 'both'.
// opts.stopId (when the board row carries one) pins the write to the record on the
// dispatcher's SCREEN: NuVizz can hold two orders under one number, its by-number read
// answers with either, and the server refuses rather than write the other twin.
export const addStopNote = (stopNbr, text, audience = 'both', opts = {}) =>
  callWrite('addStopNote', { stopNbr, text, audience, ...(opts.stopId ? { stopId: String(opts.stopId) } : {}) }, { ...opts, dryRun: false });

// Move an order to the day the customer actually wants it (§D). There is no "requested
// date" field in NuVizz — `to.schedule` IS the delivery date — so the server moves that
// window (keeping the appointment TIME), verifies nothing else on the order moved, and
// records the day as a board override so our own scans stop dragging it back onto today.
// date: 'YYYY-MM-DD'. 3 NuVizz calls; an order already on that day costs 1 and writes nothing.
// opts.stopId: same wrong-twin pin as addStopNote — the Estes-0828068215 lesson.
export const setStopDate = (stopNbr, date, opts = {}) =>
  callWrite('setStopDate', { stopNbr, date, ...(opts.stopId ? { stopId: String(opts.stopId) } : {}) }, { ...opts, dryRun: false });

// Create an EMPTY route the dispatcher can then build onto (§R). The server checks the load
// number is genuinely free (routePlan/update is create-OR-UPDATE — an existing number would
// be EDITED, so anything but a clean 404 refuses), writes a HEADER ONLY — no stops node, which
// is why this cannot repeat the Jul 2 import freight-wipe — then reads the route back, because
// the ack is async and a 200 is not proof. Resolves { ok, loadNbr, loadId, routeName }.
export const createRoute = (payload, opts = {}) =>
  callWrite('newRoute', payload, { ...opts, dryRun: false });

// Stable id so a Save can be retried without creating duplicate orders/assignments.
export function newClientOpId() {
  try { if (globalThis.crypto?.randomUUID) return `op_${globalThis.crypto.randomUUID()}`; } catch { /* fall through */ }
  return `op_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
