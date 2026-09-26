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
export async function resolveWriteIdentity(mode: PersonalLoginsMode, principal: Principal | null, deps: IdentityDeps): Promise<Identity> {
  const none = () => null;
  if (mode === 'off' || !principal?.authenticated) {
    return resolveIdentity({ mode, principal, doc: null, open: none });
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
 * Step 2. A pass-through requester that notices a 401 on a v7 call carrying THIS person's Basic
 * auth. Only 401: a 403 is NuVizz saying "this login may not do that" (a permission), which a
 * re-typed password would not fix, so it must not take a working login out of service.
 *
 * Portal (Route Workbench) calls carry a portal token, not the Basic header, so they never match
 * here — an expired portal token is handled inside lib/nuvizz-rwb.mts by one fresh sign-in, and a
 * sign-in NuVizz refuses is reported by that module instead (takeRwbLoginRefusal).
 */
export function watchPersonalRefusals<R extends RequesterLike>(requester: R, personalAuth: string | null): { requester: R; refusedStatus: () => number | null } {
  let refused: number | null = null;
  if (!personalAuth) return { requester, refusedStatus: () => null };
  const wrapped: any = {
    ...requester,
    async request(url: string, opts: any, meta: any) {
      const resp = await requester.request(url, opts, meta);
      const h = opts?.headers || {};
      const sent = h.Authorization ?? h.authorization;
      if (resp && resp.status === 401 && sent === personalAuth) refused = 401;
      return resp;
    },
    getStats: requester.getStats ? () => requester.getStats!() : undefined,
  };
  return { requester: wrapped as R, refusedStatus: () => refused };
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
