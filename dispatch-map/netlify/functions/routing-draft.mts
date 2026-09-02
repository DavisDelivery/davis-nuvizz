// routing-draft.mts
//
// DRIVER-SCOPED ENGINE DRAFT endpoint (Assist, first slice). POST a date and
// 1-4 driver names; the learned engine drafts those drivers' routes from the
// live board's UNPLANNED pool and returns the proposal. It writes NOTHING and
// makes ZERO NuVizz calls — reads are the Firestore board cache + the same
// as-of learning collections the nightly shadow uses. Pushing a draft to
// NuVizz stays where it always was: the Compare workbench's Save, an explicit
// dispatcher action on the existing metered write path.
//
//   POST { date: 'YYYY-MM-DD', drivers: ['Victor', 'Scott'] }
//     → 200 DraftResult (see routing-draft-core.mts)
//     → 400 name/resolution errors (ambiguous names list their matches)
//     → 404 no board data for that date yet
//
// A draft is deterministic for (date, pool, cast) — the solver seeds from the
// date — so "regenerate" is stable and an edited draft can be diffed against
// the engine's original.

import { isFirestoreEnabled } from './lib/firestore.mts';
import { requireUser } from './lib/require-user.mts';
import { runDraft } from './lib/routing-draft-core.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), { status: 200, headers });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'POST { date, drivers: [names] }' }), { status: 405, headers });
  }
  // User gate — inert until AUTH_REQUIRED=true on the site (lib/require-user.mts).
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;
  let body: any = null;
  try { body = await req.json(); } catch { /* handled below */ }
  const date = String(body?.date || '');
  const drivers = Array.isArray(body?.drivers) ? body.drivers.map((d: any) => String(d)) : null;
  if (!DATE_RE.test(date)) {
    return new Response(JSON.stringify({ ok: false, error: 'bad or missing date (YYYY-MM-DD)' }), { status: 400, headers });
  }
  if (!drivers || !drivers.length) {
    return new Response(JSON.stringify({ ok: false, error: 'drivers: name 1-4 drivers' }), { status: 400, headers });
  }

  try {
    const res = await runDraft(TENANT, date, drivers);
    if (!res.ok) {
      return new Response(JSON.stringify({ ok: false, error: res.error, details: res.details || [] }), { status: res.status, headers });
    }
    return new Response(JSON.stringify(res.draft), { status: 200, headers });
  } catch (e: any) {
    console.error('[routing-draft] failed:', e?.message || e);
    return new Response(JSON.stringify({ ok: false, error: e?.message || 'draft failed' }), { status: 500, headers });
  }
};
