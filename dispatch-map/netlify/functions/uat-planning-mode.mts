// uat-planning-mode.mts — READ OR FLIP THE UAT SITE BETWEEN LIVE AND PLANNING MODE.
//
// Chad, 2026-09-28: "maybe we have a planning mode in the uat where it makes the days orders all
// unplanned so you have a live version essentially of uat and then have a planning mode where
// everything on any given day is in unplanned."
//
// What planning mode does, and why it is a view rather than a rewrite: lib/uat-planning-mode.mts.
// This is only the switch.
//
//   GET                         → { ok, available, planning, set_at, set_by }        (viewer)
//   POST { planning: boolean }  → the switch as READ BACK after writing it           (dispatcher)
//
// MIRROR ONLY, first line: on production this answers 403 before anything else runs — the mode is
// a UAT idea and production has no such document. The switch lives in the mirror's own database
// (uat_mode/davis), so flipping it cannot touch production's data by construction.
//
// NEVER REPORT AN INTENT AS AN OUTCOME: the POST answers with what a fresh read of the document
// says, not with what it was asked to write. If the two disagree it says so and answers 500.
//
// ZERO NuVizz calls. Both gates are inert until AUTH_REQUIRED=true, like every gate here.
import { isMirrorDeploy, firestoreDatabaseName } from './lib/mirror-guard.mts';
import { isFirestoreEnabled, setDoc } from './lib/firestore.mts';
import { requireUser, readJsonBody } from './lib/require-user.mts';
import { planningModeAvailable, planningModePath, readPlanningMode } from './lib/uat-planning-mode.mts';

const TENANT = 'davis';

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers });
  if (!isMirrorDeploy()) {
    return J({ ok: false, refused: 'not a mirror deploy — planning mode exists only on the UAT site', database: firestoreDatabaseName() }, 403);
  }
  if (!planningModeAvailable()) {
    return J({ ok: true, available: false, planning: false, note: 'UAT_PLANNING_MODE=off on this site — every screen shows the stored board' });
  }
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' });

  if (req.method === 'GET') {
    const gate = await requireUser(req, { role: 'viewer' });
    if (!gate.ok) return gate.response;
    const st = await readPlanningMode({ tenant: TENANT });
    return J({ ok: !st.error, available: true, planning: st.on, set_at: st.set_at, set_by: st.set_by, ...(st.error ? { error: st.error } : {}) });
  }

  if (req.method === 'POST') {
    const gate = await requireUser(req, { role: 'dispatcher' });
    if (!gate.ok) return gate.response;
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const want = parsed.body?.planning;
    if (typeof want !== 'boolean') return J({ ok: false, error: 'send { "planning": true } or { "planning": false }' }, 400);
    const setAt = new Date().toISOString();
    const setBy = gate.user.legacy ? null : (gate.user.displayName || gate.user.username || null);
    await setDoc(planningModePath(TENANT), { planning: want, set_at: setAt, set_by: setBy });
    const back = await readPlanningMode({ tenant: TENANT });
    if (back.error || back.on !== want) {
      return J({ ok: false, error: back.error || `wrote planning=${want} but reading it back says ${back.on}`, planning: back.on }, 500);
    }
    console.log(`[uat-planning-mode] planning=${back.on} set by ${setBy ?? '(no login)'} at ${setAt}`);
    return J({ ok: true, available: true, planning: back.on, set_at: back.set_at, set_by: back.set_by });
  }

  return J({ ok: false, error: 'GET or POST only' }, 405);
};
