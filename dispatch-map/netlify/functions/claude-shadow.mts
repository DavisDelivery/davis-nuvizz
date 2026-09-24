// claude-shadow.mts — THE CLAUDE SHADOW TAB'S ENDPOINT. Status, and one test call.
//
// The Claude shadow planner plans tomorrow's loads beside the router, for comparison only.
// This first cut builds the plumbing and nothing that plans: the switches, the write gateway
// (lib/claude-shadow/store.mts), and a single model call that proves the key reaches the
// configured model with the request shape the plan loop will use.
//
//   GET                                   status: switch, model, key configured, last test call,
//                                         the learned truck-capacity model and the last learning run
//   GET ?view=learn-plan                  DRY RUN of learning: which sealed days a run would read.
//                                         Firestore reads only; writes nothing.
//   POST {action:"learn"}                 "Learn now": the nightly learning run, here and now, within
//                                         LEARN_NOW_BUDGET_MS — as many sealed days as fit, the rest
//                                         left for the next press or the nightly run. Returns the run
//                                         record itself: 200, 403 (role) or 409 (refused, and why).
//                                         Firestore reads; writes claude_shadow_* only; 0 NuVizz calls.
//   POST {action:"probe", dry:true}       the exact request that WOULD be sent. No call.
//   POST {action:"probe", confirm:true}   ONE Messages API call (at most ~4.9¢ at list price —
//                                         see PROBE_INPUT_TOKEN_BOUND — and usually well under 1¢),
//                                         recorded to claude_shadow_meta/probe_last and
//                                         claude_shadow_probes/<at>, then returned.
//
// ZERO NuVizz calls on every path — not a scan, not a live read, not a vendor lookup. The
// import graph of this file is checked in CI by scripts/check-shadow-isolation.mjs, which
// fails the build if it ever reaches a module that talks to NuVizz or a host other than
// api.anthropic.com and Firestore.
//
// A RUNTIME NET SITS UNDER THAT GUARD: lockEgress() (lib/claude-shadow/egress.mts) runs first on
// every invocation and refuses any request to a host but Anthropic's and Firestore's, and any
// Firestore write outside claude_shadow_*, however the request was spelled.
//
// CLAUDE_SHADOW=off (off/0/false/no) refuses the call with a 409 and makes none. The GET
// still answers, so the switch's position can always be read back.
import { lockEgress } from './lib/claude-shadow/egress.mts';
import { isFirestoreEnabled, getDoc } from './lib/firestore.mts';
import { requireUser } from './lib/require-user.mts';
import { claudeShadowEnabled, shadowModel, anthropicKeyConfigured, SHADOW_PREFIX } from './lib/claude-shadow/config.mts';
import { shadowSet, shadowCreate } from './lib/claude-shadow/store.mts';
import { callMessages } from './lib/claude-shadow/anthropic.mts';
import { buildProbeRequest, readProbeResult, probeCeilingUsd, PROBE_EFFORT, PROBE_MAX_TOKENS } from './lib/claude-shadow/probe.mts';
import { CAPACITY_PATH, LEARN_LAST_PATH } from './lib/claude-shadow/learn-core.mts';
import { planLearn, learnRefusal, runLearn } from './lib/claude-shadow/learn.mts';

export const PROBE_LAST_PATH = 'claude_shadow_meta/probe_last';
export const PROBE_LOG_COLLECTION = 'claude_shadow_probes';
// Under the 26s function timeout in netlify.toml, so a slow answer is recorded as a timeout
// by this code rather than killed mid-flight by the platform with nothing written.
const PROBE_TIMEOUT_MS = 22_000;
// Learn now stops STARTING days after this, leaving room to build and write the model inside the
// same 26s limit. A day already being read always finishes.
const LEARN_NOW_BUDGET_MS = 15_000;

const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function statusBody(lastProbe: any, lastProbeNote: string | null, learned: any = null, learnLast: any = null) {
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
    probe: { effort: PROBE_EFFORT, maxTokens: PROBE_MAX_TOKENS, ceilingUsd: probeCeilingUsd(m.model) },
    built: ['switches', 'write gateway', 'isolation guard', 'test call', 'learned truck capacity and route order'],
    notBuilt: ['capacity settings', 'snapshot', 'plan run', 'late-manifest flag', 'grading', 'comparison screen'],
    lastProbe,
    lastProbeNote,
    learned,
    learnLast,
    learnRefused: learnRefusal(),
    nuvizzCalls: 0,
  };
}

export default async (req: Request): Promise<Response> => {
  // FIRST, before anything can fetch: only Anthropic and Firestore reads/shadow writes get out.
  lockEgress();
  if (req.method === 'GET') {
    const gate = await requireUser(req, { role: 'viewer' });
    if (!gate.ok) return gate.response;
    if (!isFirestoreEnabled()) {
      const off = 'Firestore is not configured on this site — cannot be read';
      return J({ ...statusBody(null, 'Firestore is not configured on this site — the last test call cannot be read'), learnedNote: off, learnLastNote: off });
    }
    const view = new URL(req.url).searchParams.get('view');
    if (view === 'learn-plan') {
      try {
        const { stamps, ...plan } = await planLearn();
        return J({ ok: true, dry: true, calls: 0, writes: 0, refused: learnRefusal(), ...plan });
      } catch (e: any) {
        return J({ ok: false, dry: true, calls: 0, writes: 0, error: String(e?.message || e) }, 502);
      }
    }
    // Three independent reads; one failing must not blank the other two.
    const read = (path: string) => getDoc(path).then((d) => ({ d, e: null as string | null }), (e) => ({ d: null, e: String(e?.message || e) }));
    const [probe, learned, learnLast] = await Promise.all([read(PROBE_LAST_PATH), read(CAPACITY_PATH), read(LEARN_LAST_PATH)]);
    const note = probe.e ? `could not read ${PROBE_LAST_PATH}: ${probe.e}` : probe.d ? null : 'no test call has been recorded yet';
    return J({
      ...statusBody(probe.d, note, learned.d, learnLast.d),
      learnedNote: learned.e ? `could not read ${CAPACITY_PATH}: ${learned.e}` : learned.d ? null : 'nothing has been learned yet',
      learnLastNote: learnLast.e ? `could not read ${LEARN_LAST_PATH}: ${learnLast.e}` : null,
    });
  }
  if (req.method !== 'POST') return J({ ok: false, error: 'method not allowed' }, 405);

  // Dispatcher, not viewer: this POST spends an Anthropic call. Inert until AUTH_REQUIRED=true.
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;

  let body: any = {};
  try { body = await req.json(); } catch { return J({ ok: false, error: 'bad json', calls: 0 }, 400); }
  if (body?.action === 'learn') {
    const refused = learnRefusal();
    if (refused) return J({ ok: false, error: `learning is off here: ${refused}`, calls: 0 }, 409);
    const run = await runLearn({ trigger: 'manual', by: gate.user?.username ?? null, budgetMs: LEARN_NOW_BUDGET_MS });
    return J({ ...run, calls: 0 });
  }
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
    recorded.error = 'Firestore is not configured on this site';
  }
  return J({ ok: result.ok, calls: 1, result, recorded }, result.ok ? 200 : 502);
};
