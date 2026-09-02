// nuvizz-att-plan-snapshot-background.mts  (Attempts — morning routed-plan freeze)
//
// Scheduled BACKGROUND writer. Each morning run freezes today's ROUTED plan —
// stopNbr → {driver, load, route, customer} for every PLANNED stop — into
// att_plan/{tenant}__{date}. This is the "who had it originally" record the evening
// attempt scan joins against. Shared logic lives in lib/attempts-core.mts.
//
// Manual trigger (any time; cron only fires on PUBLISHED deploys):
//   POST /.netlify/functions/nuvizz-att-plan-snapshot-background?date=YYYY-MM-DD
//   No query string → today (ET), gated to the 08:00–11:59 ET window, once/day.
//
// ── Schedule: 12:30 AND 13:30 UTC ────────────────────────────────────────────
//   30 12,13 * * *
// 8:30am ET is 12:30 UTC under EDT (UTC-4) and 13:30 UTC under EST (UTC-5). Firing
// at BOTH and gating on the real ET hour (attempts-core: window [8,12), once/day)
// means exactly one fire acts year-round with no DST code; if the first candidate is
// dropped, the second still finds the day not-yet-captured and runs.

import { runPlanSnapshot } from './lib/attempts-core.mts';
import { gateScheduledOverride } from './lib/background-gate.mts';

// ?date= drops the 08:00-11:59 ET window AND the once-a-day guard, so a hand-run POST can
// re-freeze any day's routed plan — the "who had it originally" record the evening attempt
// scan attributes drivers from. Overwrite the wrong date and the attempt list blames the
// wrong driver. The scheduled run takes no params.
//
// The gate is ADMIN-only and, like every other gate in this change set, SHIPS INERT: with
// AUTH_REQUIRED unset the hand-driven override runs exactly as it always has, and the door
// shuts on the day that switch is flipped. See gateScheduledOverride in
// lib/background-gate.mts for why the STRICT version of this was wrong — AUTH_SESSION_SECRET
// is not set on the production site, so strict did not mean "admins only", it meant every
// caller got 401 "sign-in not configured", Chad included, and because this is a *-background*
// function Netlify answers 202 and throws that 401 away: a documented runbook that silently
// does nothing. It runs BEFORE the core is entered, so a refused override reaches no
// Firestore read and no vendor call.
export const OVERRIDE_PARAMS = ['date'] as const;

export default async (req: Request): Promise<Response> => {
  const refused = await gateScheduledOverride(req, 'nuvizz-att-plan-snapshot-background', OVERRIDE_PARAMS);
  if (refused) return refused;
  return runPlanSnapshot(req);
};

export const config = {
  schedule: '30 12,13 * * *',
};
