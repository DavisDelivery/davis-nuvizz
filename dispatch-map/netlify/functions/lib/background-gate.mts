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
// nuvizz_ops/background_refusals/rows, so a refusal is never nowhere. That ledger is served
// back by nuvizz-scan-config?explain=1 (`backgroundRefusals`), because a record nobody in the
// app can read is a record that only exists for whoever thinks to open the Firebase console —
// which is a place neither Chad nor a dispatcher has ever been.
//
// It still returns the 401/403 Response. The PLATFORM is what discards it, not the function:
// `netlify dev`, a curl, an integration test and any future non-background caller all see the
// real status, and returning it keeps this identical in shape to every other gate here.
//
// SHIPS INERT, like requireUser: with AUTH_REQUIRED unset a token-less request is the legacy
// admin principal, so nothing below this line runs and no refusal is ever recorded. The first
// day it can refuse anybody is the day the switch is flipped.

import { isFirestoreEnabled, setDoc, listDocs, deleteDoc } from './firestore.mts';
import { requireUser, clientIp, throttled, type GateOptions, type Principal } from './require-user.mts';
import type { Role } from './auth-core.mts';

/**
 * The catch-all ledger: every background refusal, ONE FIRESTORE DOCUMENT PER ROW.
 *
 * NOT an array on a single doc, and that is not a style choice. The array version of this was
 * a read-modify-write — getDoc, push, setDoc — which is a lost update by construction: two
 * refusals landing at the same moment both read the same array, both append their own row to
 * their own stale copy, and the second write erases the first. A ledger whose whole job is
 * "a refusal is never nowhere" cannot be the one place a refusal goes missing.
 *
 * manifest-push-log.mts already hit this in production (v0.50.57, same shape, same fix): two
 * near-simultaneous pushes silently erased each other's records[]. One doc per row makes the
 * write atomic by construction — separate paths never race — and needs no read at all.
 */
export const BACKGROUND_REFUSALS_PATH = 'nuvizz_ops/background_refusals';
export const BACKGROUND_REFUSALS_ROWS = `${BACKGROUND_REFUSALS_PATH}/rows`;
// Enough to cover a bad morning without the collection growing without bound — the same
// discipline as nuvizz_ops/scan_runs, which keeps 400.
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
 * PURE given `at` and `rand`. The document id for one refusal row: time-ordered so a plain id
 * sort is a time sort (which is what the prune below relies on), with a random tail so two
 * refusals in the same millisecond cannot land on one document. Colons and dots are legal in a
 * Firestore segment but awkward in a path, so they go.
 */
export function refusalRowId(at: string, rand = Math.random): string {
  const stamp = String(at || new Date().toISOString()).replace(/[:.]/g, '-');
  const tail = Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0');
  return `${stamp}__${tail}`;
}

/**
 * Append one refusal to the shared ledger — ONE WRITE, NO READ, so concurrent refusals cannot
 * lose each other (see BACKGROUND_REFUSALS_ROWS above).
 *
 * THROTTLED PER CALLER: once the gate is enforcing, a refusal is the only thing an anonymous
 * POST can still make these endpoints do, and an un-throttled Firestore write per hit would
 * turn the fix into a cheaper way to spend Chad's money. The per-job `record` write is not
 * throttled here — that one is a real dispatcher's job doc and is what they actually read.
 */
export async function appendBackgroundRefusal(refusal: BackgroundRefusal, ip = 'unknown'): Promise<void> {
  if (!isFirestoreEnabled()) return;
  if (throttled(`bg-refusal:${ip}`, 10, 60_000)) return;
  try {
    await setDoc(`${BACKGROUND_REFUSALS_ROWS}/${refusalRowId(refusal.at)}`, { ...refusal, ip } as any);
  } catch { /* best-effort: a ledger that can break a job is worse than no ledger */ }
  // Keep the collection bounded WITHOUT paying a list on every refusal: at most one prune per
  // ten minutes per warm instance, and never allowed to throw. A prune that fails leaves a
  // slightly longer ledger, which is the harmless direction.
  if (throttled('bg-refusal-prune', 1, 600_000)) return;
  try { await pruneBackgroundRefusals(); } catch { /* best-effort */ }
}

/**
 * Drop everything past the newest MAX_REFUSAL_ROWS, oldest first. Best-effort.
 *
 * CAPPED PER PASS. This runs inline in a refusal, which is on the path of a request somebody
 * may be waiting on, so it must not turn into a hundred sequential deletes because a backlog
 * built up. Whatever it does not clear this time it clears on the next pass; a ledger that is
 * temporarily a little long is the harmless direction.
 */
const MAX_PRUNE_PER_PASS = 50;
export async function pruneBackgroundRefusals(): Promise<number> {
  if (!isFirestoreEnabled()) return 0;
  const rows = await listDocs(BACKGROUND_REFUSALS_ROWS, { mask: ['at'] }).catch(() => [] as any[]);
  if (rows.length <= MAX_REFUSAL_ROWS) return 0;
  const doomed = rows
    .map((r: any) => String(r?._id || ''))
    .filter(Boolean)
    .sort()                                   // ids are time-ordered by construction
    .slice(0, rows.length - MAX_REFUSAL_ROWS)
    .slice(0, MAX_PRUNE_PER_PASS);
  for (const id of doomed) await deleteDoc(`${BACKGROUND_REFUSALS_ROWS}/${id}`).catch(() => {});
  return doomed.length;
}

/**
 * Read the ledger back, NEWEST FIRST. This is the half that was missing: sixteen of the
 * eighteen gates route their only durable record here, and until nuvizz-scan-config?explain=1
 * served it, nothing in the repo read it — the record existed only for somebody who thought to
 * open the Firebase console, which is not a place a dispatcher or Chad ever goes.
 */
export async function readBackgroundRefusals(limit = MAX_REFUSAL_ROWS): Promise<Array<BackgroundRefusal & { ip?: string }>> {
  if (!isFirestoreEnabled()) return [];
  const rows = await listDocs(BACKGROUND_REFUSALS_ROWS).catch(() => [] as any[]);
  return rows
    .map(({ _id, ...r }: any) => r)
    .filter((r: any) => r && typeof r.at === 'string')
    .sort((a: any, b: any) => String(b.at).localeCompare(String(a.at)))
    .slice(0, Math.max(0, limit));
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
//
// Like every other gate in this change set it is INERT until AUTH_REQUIRED=true; see
// gateScheduledOverride for why the strict version of this was a runbook that silently did
// nothing rather than a door that was shut.

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
 * SHIPS INERT, like every other gate here — and the earlier decision to make it { strict: true }
 * was WRONG, in a way that is worth spelling out because the reasoning was superficially good.
 *
 * The argument for strict was one-sided cost: a refused override runs nothing and can be
 * retried with a token, a wrongly-allowed one spends ~3,000 metered NuVizz calls and cannot be
 * taken back. True as far as it goes. What it missed is that AUTH_SESSION_SECRET IS NOT SET ON
 * THE PRODUCTION SITE, so strict here does not mean "admins only" — it means requireUser
 * answers every single caller 401 "sign-in not configured (AUTH_SESSION_SECRET)", including
 * Chad, because there is no token anybody could present that would pass. And all seven of these
 * writers are *-background* functions, so Netlify answers 202 and throws that 401 away.
 *
 * Concretely, the failure it shipped: Chad follows docs/ATTEMPTS.md and POSTs
 * nuvizz-att-plan-snapshot-background?date=2026-08-27 to re-freeze a day whose attempts blamed
 * the wrong driver. He gets 202. Nothing happens. He then runs the evening scan against a
 * snapshot that was never written and gets a second wrong answer — with no error on the
 * response, nothing in the app, and nothing in any place he would think to look. A documented
 * runbook that silently does nothing is worse than an open endpoint, which is the same lesson
 * this whole file was written to record.
 *
 * So it closes with everything else, on the day AUTH_REQUIRED flips — at which point an
 * override needs `Authorization: Bearer <admin session>` and the runbooks say so. Until then
 * the override branch is exactly as reachable as it has been since it was written, and the
 * cron path (no query string) never consults the gate at all.
 */
export async function gateScheduledOverride(
  req: Request,
  job: string,
  keys: readonly string[],
): Promise<Response | null> {
  const present = overrideParams(req.url, keys);
  if (!present.length) return null;
  const gate = await requireUserForBackground(req, `${job}?${present.join(',')}`, { role: 'admin' });
  return gate.ok ? null : gate.response;
}
