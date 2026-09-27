// lib/nuvizz-write-identity.mts — the write endpoint's side of personal NuVizz logins.
//
// nuvizz-write.mts is the one door every NuVizz write goes through. This is what that door asks,
// in order, for a write that changes something in NuVizz:
//
//   1. resolveWriteIdentity   — whose login does THIS write go out under (lib/nuvizz-identity.mts
//                               decides; this only fetches the account and the key for it)
//   2. watchPersonalRefusals  — while the write runs, did the v7 API answer 401 to that login?
//   3. refusalAfterWrite      — combine that with the portal's refusal (lib/nuvizz-rwb.mts) into
//                               one reason, or none
//   4. markLoginRejected      — record it on the person's account, so the NEXT write, on any
//                               instance, stops using a login NuVizz just refused (and cannot lock
//                               the person out of NuVizz by trying it again and again)
//
// Dependencies are injected so each step is testable without Firestore or NuVizz.

import {
  resolveIdentity, loginKey as realLoginKey, openNuvizzPassword,
  type Identity, type PersonalLoginsMode,
} from './nuvizz-identity.mts';

export interface Principal { username: string; displayName?: string | null; authenticated: boolean }

export interface IdentityDeps {
  getUser: (username: string) => Promise<any | null>;
  loginKey?: () => Buffer;
}

/**
 * Step 1. The account is read FRESH (not the gate's 30-second cache): a login saved, removed or
 * marked refused a moment ago must decide this write, not the one before it.
 *
 * Nothing is read at all when the switch is off or nobody is signed in — the shared login needs
 * no account, and the off switch must cost exactly what the code before it cost.
 */
export async function resolveWriteIdentity(
  mode: PersonalLoginsMode, principal: Principal | null, deps: IdentityDeps,
  opts: { tokenPresented?: boolean } = {},
): Promise<Identity> {
  const none = () => null;
  // A request that carried a session token and still arrived as the pre-login caller is a
  // signed-in person whose account the gate could not read (require-user.mts, legacy mode) —
  // not somebody who never signed in. See ResolveInput.tokenUnverified.
  const tokenUnverified = !!opts.tokenPresented && !principal?.authenticated;
  if (mode === 'off' || !principal?.authenticated) {
    return resolveIdentity({ mode, principal, doc: null, open: none, tokenUnverified });
  }
  let doc: any = null;
  let docUnavailable = false;
  try { doc = await deps.getUser(principal.username); } catch { docUnavailable = true; }
  let key: Buffer | null = null;
  try { key = (deps.loginKey || realLoginKey)(); } catch { key = null; }
  return resolveIdentity({
    mode, principal, doc, docUnavailable,
    open: (blob, appUser, nuvizzUser) => (key ? openNuvizzPassword(blob, appUser, nuvizzUser, key) : null),
  });
}

export interface RequesterLike {
  request(url: string, opts: any, meta: any): Promise<Response>;
  getStats?: () => any;
}

/**
 * Step 2. A requester around the real one that notices a 401 on a v7 call carrying THIS person's
 * Basic auth — and, from then on, STOPS SENDING IT. Only 401: a 403 is NuVizz saying "this login
 * may not do that" (a permission), which a re-typed password would not fix, so it must not take a
 * working login out of service.
 *
 * WHY IT STOPS, NOT JUST NOTICES. The first draft only observed, and the review measured what that
 * costs: a Save of five loads keyed by number sent the stale password FIVE times, one per load
 * read; five loads known only by id sent it fifteen. Each is a wrong attempt at NuVizz, and enough
 * of them lock the person out of NuVizz itself. So after the first refusal every further request
 * carrying that exact header is answered HERE with a 401 that says it was not sent — the engine
 * fails the rest of the Save the same way it would have, without asking NuVizz again. The same
 * holds when the portal side already refused this login (`isHeld`), and a v7 refusal is handed to
 * the portal side (`onRefused`) so it does not try the password either: one brake for the Save.
 *
 * Portal (Route Workbench) calls carry a portal token, not this header, so they pass straight
 * through — lib/nuvizz-rwb.mts brakes its own sign-ins (heldRefusal).
 *
 * The answered-here 401 is never counted as a NuVizz call: nothing was sent.
 */
export function watchPersonalRefusals<R extends RequesterLike>(
  requester: R, personalAuth: string | null,
  hooks: { onRefused?: (status: number) => void; isHeld?: () => boolean } = {},
): { requester: R; refusedStatus: () => number | null; withheld: () => number } {
  let refused: number | null = null;
  let withheld = 0;
  if (!personalAuth) return { requester, refusedStatus: () => null, withheld: () => 0 };
  const notSent = () => new Response(JSON.stringify({
    message: 'Not sent: NuVizz already refused this NuVizz login during this Save, so it was not tried again (a wrong password tried repeatedly can lock the NuVizz account).',
  }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  const wrapped: any = {
    ...requester,
    async request(url: string, opts: any, meta: any) {
      const h = opts?.headers || {};
      const sent = h.Authorization ?? h.authorization;
      const mine = sent === personalAuth;
      if (mine && (refused != null || (hooks.isHeld ? hooks.isHeld() : false))) {
        if (refused == null) refused = 401;   // held by the portal side: the same refusal, for the same Save
        withheld++;
        return notSent();
      }
      const resp = await requester.request(url, opts, meta);
      if (mine && resp && resp.status === 401 && refused == null) {
        refused = 401;
        try { hooks.onRefused?.(401); } catch { /* the brake below still holds for this Save */ }
      }
      return resp;
    },
    getStats: requester.getStats ? () => requester.getStats!() : undefined,
  };
  return { requester: wrapped as R, refusedStatus: () => refused, withheld: () => withheld };
}

/**
 * PURE. When the account's saved NuVizz login last PASSED a check (Test, or the check a save
 * runs) — nothing refused, and at least one side said yes, the same rule auth-nuvizz-login uses to
 * clear a refusal — or null. The write process's refusal hold lives in its own memory, and a Test
 * runs in a different function; this is how the write process learns a person has re-tested the
 * login since it was held (lib/nuvizz-rwb.mts releaseRwbLoginCheckedSince).
 */
export function passingCheckAt(doc: any): string | null {
  const c = doc?.nuvizzCheck;
  if (!c || typeof c !== 'object') return null;
  if (c.api === 'refused' || c.portal === 'refused') return null;
  if (c.api !== 'ok' && c.portal !== 'ok') return null;
  const at = typeof c.at === 'string' ? c.at : '';
  return Number.isFinite(Date.parse(at)) ? at : null;
}

/** Step 3, PURE. One reason, or null. The portal's own words win: they say what NuVizz said. */
export function refusalAfterWrite(identity: Identity, v7Status: number | null, portal: { detail: string } | null): string | null {
  if (identity.kind !== 'personal') return null;
  if (portal?.detail) return String(portal.detail).slice(0, 300);
  if (v7Status === 401) return `NuVizz answered 401 to the NuVizz login saved as ${identity.nuvizzUser}`;
  return null;
}

/** Step 4. Best-effort: a failure to record must never turn a finished write into an error. */
export async function markLoginRejected(appUser: string, reason: string, deps: { patchUser: (u: string, f: Record<string, any>) => Promise<void> }, nowIso = new Date().toISOString()): Promise<boolean> {
  try {
    await deps.patchUser(appUser, { nuvizzRejectedAt: nowIso, nuvizzRejectedReason: String(reason).slice(0, 300) });
    return true;
  } catch { return false; }
}
