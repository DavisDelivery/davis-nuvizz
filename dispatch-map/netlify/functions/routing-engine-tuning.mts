// routing-engine-tuning.mts
//
// Read + edit the LIVE routing-engine knobs from the Engine tab — no redeploy.
// Mirrors the nuvizz-scan-config pattern (same GET/POST shape, same clamp-on-
// write + clamp-on-read discipline via the pure helpers the solver itself uses).
//
//   GET  /.netlify/functions/routing-engine-tuning
//        → { ok, persistent, engine_version, config, stored, defaults, bounds }
//        config   = effective knobs the engine runs (defaults overlaid with stored)
//        stored   = just the persisted overrides (so the UI can show what's customized)
//        defaults = env/hardcoded baseline
//        bounds   = per-knob [min,max] the editor clamps to
//   POST /.netlify/functions/routing-engine-tuning
//        body: partial knobs, plus optional reset: [keys] to drop overrides back
//        to the default. Validates + clamps, persists to routing_engine_config/
//        {tenant}, returns the new effective config. The nightly shadow reads
//        this each run; historical re-scores go through the replay function.
//
// ZERO NuVizz calls. Writes confined to routing_engine_config.

import { isFirestoreEnabled, getDoc, setDoc } from './lib/firestore.mts';
import {
  ENGINE_VERSION, ENGINE_CONFIG_BOUNDS, engineConfigDefaults, engineConfigPath,
  effectiveEngineConfig, mergeEngineConfigUpdate,
} from './lib/routing-engine-config.mts';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  const payload = (stored: any, persistent: boolean) => JSON.stringify({
    ok: true, persistent, engine_version: ENGINE_VERSION,
    config: effectiveEngineConfig(stored || {}), stored: stored || {},
    defaults: engineConfigDefaults(), bounds: ENGINE_CONFIG_BOUNDS,
  });

  if (!isFirestoreEnabled()) {
    // No Firestore (e.g. a preview without FIREBASE_SA): serve defaults so the
    // editor renders, but it can't persist.
    return new Response(payload({}, false), { status: 200, headers: cors });
  }

  try {
    if (req.method === 'GET') {
      const stored = await getDoc(engineConfigPath(TENANT)).catch(() => null);
      return new Response(payload(stored, true), { status: 200, headers: cors });
    }

    if (req.method === 'POST') {
      // Gate at admin: a POST here persists the knobs TONIGHT'S live assignment run reads —
      // no deploy, no review, and the only record of who did it is the free-text updatedBy the
      // caller sends. The GET stays open at this level because the editor has to render the
      // current values to show anyone what would change. Inert until AUTH_REQUIRED=true
      // (lib/require-user.mts).
      const gate = await requireUser(req, { role: 'admin' });
      if (!gate.ok) return gate.response;
      let body: any;
      try { body = await req.json(); } catch { return new Response(JSON.stringify({ ok: false, error: 'invalid JSON' }), { status: 400, headers: cors }); }
      const prior = await getDoc(engineConfigPath(TENANT)).catch(() => null);
      const resets = Array.isArray(body?.reset) ? body.reset.map(String) : [];
      const merged = mergeEngineConfigUpdate(prior, body, resets);
      const toStore = {
        ...merged,
        updated_at: new Date().toISOString(),
        updated_by: String(body?.updatedBy || 'engine-tab').slice(0, 120),
      };
      await setDoc(engineConfigPath(TENANT), toStore);
      return new Response(payload(toStore, true), { status: 200, headers: cors });
    }

    return new Response(JSON.stringify({ ok: false, error: 'GET or POST only' }), { status: 405, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || 'engine-tuning failed' }), { status: 500, headers: cors });
  }
};
