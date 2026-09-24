// claude-shadow.mts — THE CLAUDE SHADOW TAB'S ENDPOINT. Status, and one test call.
//
// The Claude shadow planner plans tomorrow's loads beside the router, for comparison only.
// This first cut builds the plumbing and nothing that plans: the switches, the write gateway
// (lib/claude-shadow/store.mts), and a single model call that proves the key reaches the
// configured model with the request shape the plan loop will use.
//
//   GET                                   status: switch, model, key configured, last test call
//   POST {action:"probe", dry:true}       the exact request that WOULD be sent. No call.
//   POST {action:"probe", confirm:true}   ONE Messages API call (well under 1¢ at list price),
//                                         recorded to claude_shadow_meta/probe_last and
//                                         claude_shadow_probes/<at>, then returned.
//
// ZERO NuVizz calls on every path — not a scan, not a live read, not a vendor lookup. The
// import graph of this file is checked in CI by scripts/check-shadow-isolation.mjs, which
// fails the build if it ever reaches a module that talks to NuVizz or a host other than
// api.anthropic.com and Firestore.
//
// CLAUDE_SHADOW=off (off/0/false/no) refuses the call with a 409 and makes none. The GET
// still answers, so the switch's position can always be read back.
import { isFirestoreEnabled, getDoc } from './lib/firestore.mts';
import { requireUser } from './lib/require-user.mts';
import { claudeShadowEnabled, shadowModel, anthropicKeyConfigured, SHADOW_PREFIX } from './lib/claude-shadow/config.mts';
import { shadowSet, shadowCreate } from './lib/claude-shadow/store.mts';
import { callMessages } from './lib/claude-shadow/anthropic.mts';
import { buildProbeRequest, readProbeResult } from './lib/claude-shadow/probe.mts';

export const PROBE_LAST_PATH = 'claude_shadow_meta/probe_last';
export const PROBE_LOG_COLLECTION = 'claude_shadow_probes';
// Under the 26s function timeout in netlify.toml, so a slow answer is recorded as a timeout
// by this code rather than killed mid-flight by the platform with nothing written.
const PROBE_TIMEOUT_MS = 22_000;

const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function statusBody(lastProbe: any, lastProbeNote: string | null) {
  const m = shadowModel();
  return {
    ok: true,
    enabled: claudeShadowEnabled(),
    switch: { name: 'CLAUDE_SHADOW', raw: process.env.CLAUDE_SHADOW ?? null, default: 'on' },
    model: m.model,
    modelSource: m.source,
    modelRejected: m.rejected,
    keyConfigured: anthropicKeyConfigured(),
    prefix: SHADOW_PREFIX,
    built: ['switches', 'write gateway', 'isolation guard', 'test call'],
    notBuilt: ['snapshot', 'plan run', 'late-manifest flag', 'grading', 'comparison screen'],
    lastProbe,
    lastProbeNote,
    nuvizzCalls: 0,
  };
}

export default async (req: Request): Promise<Response> => {
  if (req.method === 'GET') {
    const gate = await requireUser(req, { role: 'viewer' });
    if (!gate.ok) return gate.response;
    if (!isFirestoreEnabled()) return J(statusBody(null, 'FIREBASE_SA not set — the last test call cannot be read'));
    try {
      const last = await getDoc(PROBE_LAST_PATH);
      return J(statusBody(last, last ? null : 'no test call has been recorded yet'));
    } catch (e: any) {
      return J(statusBody(null, `could not read ${PROBE_LAST_PATH}: ${String(e?.message || e)}`));
    }
  }
  if (req.method !== 'POST') return J({ ok: false, error: 'method not allowed' }, 405);

  // Dispatcher, not viewer: this POST spends an Anthropic call. Inert until AUTH_REQUIRED=true.
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;

  let body: any = {};
  try { body = await req.json(); } catch { return J({ ok: false, error: 'bad json', calls: 0 }, 400); }
  if (body?.action !== 'probe') return J({ ok: false, error: 'unknown action', calls: 0 }, 400);

  const { model } = shadowModel();
  const request = buildProbeRequest(model);
  if (body?.dry === true) return J({ ok: true, dry: true, calls: 0, request });

  if (!claudeShadowEnabled()) return J({ ok: false, error: 'CLAUDE_SHADOW is off — no call made', calls: 0 }, 409);
  if (!anthropicKeyConfigured()) return J({ ok: false, error: 'ANTHROPIC_API_KEY is not set — no call made', calls: 0 }, 409);
  if (body?.confirm !== true) {
    return J({ ok: false, error: 'a test call spends money: send confirm:true to make it, or dry:true to see it', calls: 0, request }, 400);
  }

  const at = new Date().toISOString();
  const call = await callMessages(request, { apiKey: String(process.env.ANTHROPIC_API_KEY), timeoutMs: PROBE_TIMEOUT_MS });
  const result = { ...readProbeResult(model, call, at), by: gate.user.username };

  // THE CALL HAPPENED whether or not this record lands, so the response says both things
  // separately: what the model returned, and whether the record of it was written.
  let recorded = { last: false, log: false, error: null as string | null };
  if (isFirestoreEnabled()) {
    try {
      recorded.last = await shadowSet(PROBE_LAST_PATH, result);
      recorded.log = await shadowCreate(`${PROBE_LOG_COLLECTION}/${at}`, result);
    } catch (e: any) {
      recorded.error = String(e?.message || e);
    }
  } else {
    recorded.error = 'FIREBASE_SA not set';
  }
  return J({ ok: result.reached, calls: 1, result, recorded }, result.reached ? 200 : 502);
};
