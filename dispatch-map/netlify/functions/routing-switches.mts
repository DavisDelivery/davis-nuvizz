// routing-switches.mts
//
// THE ENDPOINT BEHIND DIAGNOSTICS → ROUTING SWITCHES (src/lib/routing-switches.js).
//
// Chad, 2026-10-01: "I would say we put in the Diagnostics tab … I would like to have the date that
// the switch was put in place so I'll know which ones to toggle on and off if there's a change made
// that I don't like."
//
// GET  → what is stored for each switch (who set it, when), plus the SERVER switches' environment
//        values, which the browser cannot see. Free: one Firestore read, zero NuVizz calls.
// POST → { name, on } sets ONE switch. Admin only (inert until AUTH_REQUIRED=true on the site,
//        the repo-wide posture). Field-masked, so two people flipping two switches both keep their
//        flip; the response is READ BACK from the document — never report an intent as an outcome.
import { requireUser } from './lib/require-user.mts';
import { isFirestoreEnabled } from './lib/firestore.mts';
import { readRoutingSwitches, writeRoutingSwitch } from './lib/routing-switches-store.mts';
import { ROUTING_SWITCHES, routingSwitchDef } from '../../src/lib/routing-switches.js';

const J = (body: any, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  },
});

/** The server switches' raw environment values — the only part of a switch the browser cannot see. */
function serverEnv(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const s of ROUTING_SWITCHES) if (s.side === 'server') out[s.name] = process.env[s.name] ?? null;
  return out;
}

export default async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return J({ ok: true });
  if (req.method !== 'GET' && req.method !== 'POST') return J({ ok: false, error: 'GET or POST only' }, 405);
  const gate = await requireUser(req, { role: req.method === 'POST' ? 'admin' : 'viewer' });
  if (!gate.ok) return gate.response;

  // No Firestore on this deploy (a preview without FIREBASE_SA): the page still renders and tells
  // the truth — every switch is at its Netlify value or default — it simply cannot store a flip.
  if (!isFirestoreEnabled()) {
    if (req.method === 'POST') return J({ ok: false, persistent: false, error: 'Firestore is not configured on this deploy — a switch cannot be stored here.' }, 503);
    return J({ ok: true, persistent: false, stored: {}, serverEnv: serverEnv() });
  }

  try {
    if (req.method === 'GET') {
      return J({ ok: true, persistent: true, stored: await readRoutingSwitches(), serverEnv: serverEnv() });
    }

    let body: any;
    try { body = await req.json(); } catch { return J({ ok: false, error: 'invalid JSON' }, 400); }
    const name = String(body?.name ?? '');
    if (!routingSwitchDef(name)) return J({ ok: false, error: `unknown switch: ${name.slice(0, 80) || '(none)'}` }, 400);
    if (typeof body?.on !== 'boolean') return J({ ok: false, error: '`on` must be true or false' }, 400);

    // THE PRINCIPAL, NOT THE BODY: the page prints "set … by X", so a caller-supplied name would
    // turn an audit line into an assertion by whoever made the request.
    const by = String(gate.user?.username || 'unauthenticated').slice(0, 120);
    await writeRoutingSwitch(name, body.on, by);
    const stored = await readRoutingSwitches();
    const saved = stored?.[name];
    if (!saved || saved.on !== body.on) {
      return J({ ok: false, error: `the switch did not read back as ${body.on ? 'on' : 'off'} — nothing changed`, stored, serverEnv: serverEnv() }, 500);
    }
    return J({ ok: true, persistent: true, saved: name, stored, serverEnv: serverEnv() });
  } catch (e: any) {
    return J({ ok: false, error: e?.message || 'routing-switches failed' }, 500);
  }
};
