// lib/background-gate.mts — how a *-background* function refuses a caller SO THAT SOMEBODY
// CAN SEE IT.
//
// THE FAILURE THIS EXISTS TO PREVENT. Netlify answers a *-background* function's caller 202
// the instant the request lands and then THROWS THE HANDLER'S RESPONSE AWAY. So the ordinary
// gate used everywhere else in this repo —
//
//     const gate = await requireUser(req, { role: 'dispatcher' });
//     if (!gate.ok) return gate.response;
//
// — is INVISIBLE inside a background function. The 401 never reaches the browser, the client
// reads 202 as success, and the job simply never happens. On nuvizz-manual-scan-background
// that is a dispatcher pressing "Scan now" at 5am, the button reporting "Scan running", and
// no scan, no error, and nothing anywhere that says so. That is CLAUDE.md's "never report an
// intent as an outcome" wearing a security fix's clothes, and it is worse than leaving the
// endpoint open, because an open endpoint at least does the work.
//
// THE PATTERN, ONE SHAPE FOR ALL ELEVEN. A refused background job writes the refusal WHERE
// ITS OWN CLIENT IS ALREADY LOOKING — the job doc it polls (routing_jobs/{id} via onSnapshot,
// nuvizz_ops/manifest_ocr__{id} via manifest-ocr-result), or the ledger that job family
// already keeps (nuvizz_ops/scan_runs, read back by nuvizz-scan-config?explain=1). That is
// the `record` callback each caller supplies. On top of that, EVERY refusal — including the
// jobs that have no client-visible doc at all — lands in one shared ledger,
// nuvizz_ops/background_refusals, so a refusal is never nowhere.
//
// It still returns the 401/403 Response. The PLATFORM is what discards it, not the function:
// `netlify dev`, a curl, an integration test and any future non-background caller all see the
// real status, and returning it keeps this identical in shape to every other gate here.
//
// SHIPS INERT, like requireUser: with AUTH_REQUIRED unset a token-less request is the legacy
// admin principal, so nothing below this line runs and no refusal is ever recorded. The first
// day it can refuse anybody is the day the switch is flipped.

import { isFirestoreEnabled, setDoc, getDoc } from './firestore.mts';
import { requireUser, clientIp, throttled, type GateOptions, type Principal } from './require-user.mts';
import type { Role } from './auth-core.mts';

/** The catch-all ledger: every background refusal, newest last. Bounded ring. */
export const BACKGROUND_REFUSALS_PATH = 'nuvizz_ops/background_refusals';
// Enough to cover a bad morning without the doc growing without bound — the same discipline
// as nuvizz_ops/scan_runs, which keeps 400.
const MAX_REFUSAL_ROWS = 100;

export interface BackgroundRefusal {
  /** the function that refused, e.g. 'nuvizz-manual-scan-background' */
  job: string;
  /** requireUser's own reason: no-token | bad-token | inactive | revoked | role | store-error */
  reason: string;
  /** the sentence a dispatcher should end up reading */
  message: string;
  at: string;
}

/**
 * PURE. The words a refused job reports. Written for the person holding the phone, not for a
 * log: it has to say what happened AND what to do, because on the screens below it is the
 * only thing they will get.
 */
export function refusalMessage(reason: string, role?: Role): string {
  switch (reason) {
    case 'role':
      return `Refused — this needs the ${role || 'required'} role, and your account does not have it. Ask an admin, then run it again.`;
    case 'store-error':
      // Fail-closed on an unreachable user store is correct, but it is a DIFFERENT problem
      // from "you are not allowed" and must not be reported as one — the fix is to retry,
      // not to go and find an admin.
      return 'Refused — the sign-in could not be checked (the user store is unreachable). Nothing ran; try again in a minute.';
    case 'inactive':
    case 'revoked':
    case 'bad-token':
      return 'Refused — your session is no longer valid. Sign in again and run it once more.';
    default:
      return 'Refused — not signed in. Nothing ran. Sign in and run it again.';
  }
}

/**
 * Append one refusal to the shared ledger. Best-effort and THROTTLED PER CALLER: once the
 * gate is enforcing, a refusal is the only thing an anonymous POST can still make these
 * endpoints do, and an un-throttled Firestore read+write per hit would turn the fix into a
 * cheaper way to spend Chad's money. The per-job `record` write is not throttled — that one
 * is a real dispatcher's job doc and is what they actually read.
 */
export async function appendBackgroundRefusal(refusal: BackgroundRefusal, ip = 'unknown'): Promise<void> {
  if (!isFirestoreEnabled()) return;
  if (throttled(`bg-refusal:${ip}`, 10, 60_000)) return;
  try {
    const prev = await getDoc(BACKGROUND_REFUSALS_PATH).catch(() => null);
    const rows = Array.isArray(prev?.refusals) ? prev!.refusals : [];
    await setDoc(BACKGROUND_REFUSALS_PATH, {
      refusals: [...rows, { ...refusal, ip }].slice(-MAX_REFUSAL_ROWS),
      updated_at: new Date().toISOString(),
    } as any);
  } catch { /* best-effort: a ledger that can break a job is worse than no ledger */ }
}

export type BackgroundGateResult =
  | { ok: true; user: Principal }
  | { ok: false; response: Response; refusal: BackgroundRefusal };

export interface BackgroundGateOptions extends GateOptions {
  /**
   * Land the refusal where THIS job's client is already looking. Called before the shared
   * ledger write and never allowed to throw — a failed refusal write must not swallow the
   * refusal itself.
   */
  record?: (refusal: BackgroundRefusal) => Promise<void>;
}

/**
 * The gate for a *-background* function. `job` is the function's own name and is what the
 * ledger row is filed under, so keep it identical to the filename.
 */
export async function requireUserForBackground(
  req: Request,
  job: string,
  opts: BackgroundGateOptions = {},
): Promise<BackgroundGateResult> {
  const { record, ...gateOpts } = opts;
  const gate = await requireUser(req, gateOpts);
  if (gate.ok) return gate;

  const refusal: BackgroundRefusal = {
    job,
    reason: gate.reason,
    message: refusalMessage(gate.reason, gateOpts.role),
    at: new Date().toISOString(),
  };
  if (record) {
    try { await record(refusal); } catch (e: any) {
      console.error(`[bg-gate] ${job}: could not write the refusal to its own job doc:`, e?.message);
    }
  }
  await appendBackgroundRefusal(refusal, clientIp(req));
  console.warn(`[bg-gate] ${job} refused (${gate.reason}) — the platform has already answered 202, so the caller sees no status.`);
  return { ok: false, response: gate.response, refusal };
}

// ── Scheduled writers: the override branch is the door, not the cron ──────────
//
// A `config.schedule` IS NOT AN ACCESS CONTROL. Seven of these writers read caller-chosen
// params (?date ?days ?force ?now ?from ?to ?dry) that skip the cadence guards and can drive
// a ~3,000-call cold NuVizz scan — the exact spend CLAUDE.md's hard rule forbids — from an
// unauthenticated POST. Netlify's cron sends NO query string, so gating ONLY the branch that
// carries an override costs the schedule nothing: the cron path below is byte-for-byte the
// path it ran yesterday.

/**
 * PURE. Which of `keys` this request actually carries. `?dry` with no value counts as present
 * (URLSearchParams.get returns '' not null), because `?dry` and `?dry=1` mean the same thing
 * to the endpoints that read them. Exported so each writer's test can pin its own list.
 */
export function overrideParams(reqUrl: string, keys: readonly string[]): string[] {
  let q: URLSearchParams;
  try { q = new URL(reqUrl).searchParams; } catch { return []; }
  return keys.filter((k) => q.get(k) != null);
}

/**
 * The scheduled-writer gate. Returns null when this is the cron path (no override present) or
 * the caller is an authorised admin; returns the refusal Response otherwise.
 *
 * STRICT ON PURPOSE — enforced even with AUTH_REQUIRED off. Every other gate in this change
 * ships inert so that flipping the switch is a separate decision; this one cannot, because the
 * thing it guards is unbounded vendor spend from a URL anyone can type, and "inert until the
 * switch" would mean the spend stays open for exactly as long as the rollout takes. The cost of
 * being wrong here is one-sided: a refused override runs nothing and can be retried with a
 * token, while a wrongly-allowed one costs ~3,000 metered calls and cannot be taken back.
 */
export async function gateScheduledOverride(
  req: Request,
  job: string,
  keys: readonly string[],
): Promise<Response | null> {
  const present = overrideParams(req.url, keys);
  if (!present.length) return null;
  const gate = await requireUserForBackground(req, `${job}?${present.join(',')}`, { strict: true, role: 'admin' });
  return gate.ok ? null : gate.response;
}
