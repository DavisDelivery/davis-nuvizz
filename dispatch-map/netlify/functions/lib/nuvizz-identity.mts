// lib/nuvizz-identity.mts — WHOSE NuVizz LOGIN A WRITE GOES OUT UNDER.
//
// Chad, 2026-09-26: "I want to create logins for dispatch map to improve the security. I want
// to create logins for all the different users with their personal nuvizz login information
// instead of every dispatcher using mine."
//
// Until this file, every NuVizz write this app made — the Route Workbench save, assign,
// dispatch, notes, new orders, address fixes, cancels — went out under ONE login, Chad's, held
// in the site environment (NUVIZZ_DAVIS_USER/PASS for the v7 API, NUVIZZ_RWB_USER/PASS for the
// portal's Route Workbench). NuVizz's own history therefore said "Chad" for every stop any
// dispatcher ever moved, and our write ledger stamped the literal string 'dispatcher'
// (App.jsx's commitBoard call). When a route goes out wrong, "who did this" had no answer
// anywhere.
//
// This module holds the RULES of the fix. Pure where it can be, so the decisions are tested
// without Firestore or NuVizz:
//
//   personalLoginsMode()  the switch, NUVIZZ_PERSONAL_LOGINS
//   seal/open             a dispatcher's NuVizz password, AES-256-GCM, bound to BOTH usernames
//   resolveIdentity()     for one write: personal login, the shared one, or a refusal
//   classify*()           reading NuVizz's answer to a login check
//
// WHAT IS DELIBERATELY NOT HERE: reads. Scheduled scans, the stop explorer, POD pulls and the
// window check stay on the shared login. They have no person behind them (a scan at 3am is
// nobody's action) and reads leave no trail in NuVizz's history — the thing this exists to fix
// is attribution of CHANGES. Moving reads onto personal logins would also move the whole scan
// budget onto whichever dispatcher happened to press Refresh.

import crypto from 'node:crypto';

// ── THE SWITCH ───────────────────────────────────────────────────────────────
//
// House shape (CLAUDE.md "Ship it so it can be put back"): default ON, an explicit off-word
// turns it off, anything malformed leaves it ON. "ON" here is `preferred` — the setting that can
// never stop a Save:
//
//   preferred  (default) a signed-in person with a working saved NuVizz login writes as
//              themselves; everybody else — not signed in, nothing saved, a login NuVizz refused —
//              writes under the shared login exactly as today, and the answer SAYS which.
//   required   no personal login, no write. The Save is refused before any NuVizz call, with a
//              sentence saying what to fix. For after every dispatcher has one saved and tested.
//   off        every write under the shared login — byte-for-byte what shipped before this.
//
// A typo ("requried") lands on `preferred`, never on `required` and never on `off`: a
// misspelled switch must neither block a 700-stop night nor quietly put everyone back on one
// login.
export type PersonalLoginsMode = 'preferred' | 'required' | 'off';

export function personalLoginsMode(env: Record<string, any> = process.env): PersonalLoginsMode {
  const v = String(env?.NUVIZZ_PERSONAL_LOGINS ?? '').trim().toLowerCase();
  if (/^(off|0|false|no)$/.test(v)) return 'off';
  if (/^(required|require|strict|only)$/.test(v)) return 'required';
  return 'preferred';
}

// ── WHAT A PERSON MAY TYPE ───────────────────────────────────────────────────

export const NUVIZZ_USER_MAX = 120;
export const NUVIZZ_PASS_MAX = 200;

/**
 * A NuVizz username as typed, trimmed — NOT lower-cased. Whether NuVizz treats "JDoe" and
 * "jdoe" as one account cannot be read from this repo, and lower-casing would let two
 * different accounts share one cached portal session if it does not.
 *
 * No whitespace, no control characters, and NO COLON: the v7 API is Basic auth, where the
 * first ':' separates username from password — a colon in the name would send NuVizz a
 * different username than the one on screen.
 */
export function normalizeNuvizzUsername(v: any): string | null {
  const s = String(v ?? '').trim();
  if (!s || s.length > NUVIZZ_USER_MAX) return null;
  if (/[\s:\x00-\x1f\x7f]/.test(s)) return null;
  return s;
}

/** A human-readable problem, or null. Spaces are allowed; control characters are not. */
export function nuvizzPasswordProblem(v: any): string | null {
  if (typeof v !== 'string' || !v) return 'the NuVizz password is required';
  if (v.length > NUVIZZ_PASS_MAX) return `the NuVizz password must be at most ${NUVIZZ_PASS_MAX} characters`;
  if (/[\x00-\x1f\x7f]/.test(v)) return 'the NuVizz password contains a control character';
  return null;
}

// ── SEALING ──────────────────────────────────────────────────────────────────
//
// The password has to be RECOVERABLE — the v7 API takes it as Basic auth on every call and the
// portal login posts it — so it cannot be hashed like the dispatch-map password. It is sealed
// with AES-256-GCM before Firestore ever sees it, the same construction lib/gmail-store.mts
// uses for the Gmail refresh token, with one addition: the AUTHENTICATED DATA binds the blob to
// the dispatch-map account AND the NuVizz username it was saved with. A blob copied from one
// person's record into another's, or left in place under an edited NuVizz username, fails to
// open instead of logging somebody in as somebody else.
//
// THE KEY IS SERVER-ONLY: NUVIZZ_LOGIN_KEY when set (any passphrase; rotating it invalidates
// every saved login at once — everyone re-enters theirs), otherwise derived from the FIREBASE_SA
// private key with a label of its own, so this works with no new configuration. Rotating the
// service account therefore also invalidates the saved logins; under `preferred` that is a
// quiet return to the shared login with the reason on screen, under `required` it is a
// sentence asking each person to re-enter theirs. Never a crash, never plaintext.

export function loginKey(env: Record<string, any> = process.env): Buffer {
  const explicit = String(env?.NUVIZZ_LOGIN_KEY || '').trim();
  if (explicit) return crypto.createHash('sha256').update(`dd-nuvizz-login|${explicit}`).digest();
  const raw = env?.FIREBASE_SA;
  if (!raw) throw new Error('no key material: set NUVIZZ_LOGIN_KEY or FIREBASE_SA');
  let priv = '';
  try { priv = String(JSON.parse(String(raw))?.private_key ?? ''); } catch { /* fall through */ }
  if (!priv) throw new Error('FIREBASE_SA has no private_key — set NUVIZZ_LOGIN_KEY');
  return crypto.createHash('sha256').update(`dd-nuvizz-login|${priv}`).digest();
}

export function loginKeyReady(env: Record<string, any> = process.env): boolean {
  try { loginKey(env); return true; } catch { return false; }
}

const aad = (appUser: string, nuvizzUser: string) =>
  Buffer.from(`dd-nuvizz-login|v1|${String(appUser)}|${String(nuvizzUser)}`, 'utf8');

/** PURE given the key. Format: v1.<iv>.<tag>.<ciphertext>, base64url. */
export function sealNuvizzPassword(plain: string, appUser: string, nuvizzUser: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(appUser, nuvizzUser));
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  const b = (x: Buffer) => x.toString('base64url');
  return `v1.${b(iv)}.${b(tag)}.${b(ct)}`;
}

/** Null for anything that is not an authentic v1 blob for exactly these two usernames. Never throws. */
export function openNuvizzPassword(blob: any, appUser: string, nuvizzUser: string, key: Buffer): string | null {
  const parts = String(blob ?? '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
    d.setAAD(aad(appUser, nuvizzUser));
    d.setAuthTag(Buffer.from(parts[2], 'base64url'));
    const out = Buffer.concat([d.update(Buffer.from(parts[3], 'base64url')), d.final()]).toString('utf8');
    return out || null;
  } catch { return null; }
}

// ── THE STORED SHAPE ─────────────────────────────────────────────────────────
//
// Fields on the person's own app_users/{username} document. app_users is already the
// server-only collection that holds the password hash (firestore.rules serverOnlyCollection),
// so a second collection would add a second thing to lock down and nothing else. Every write is
// field-masked (auth-store patchUser), so saving a NuVizz login can never take the dispatch-map
// password hash with it.

export type CheckVerdict = 'ok' | 'refused' | 'unknown' | 'skipped';

export interface NuvizzCheck {
  at: string;
  /** The v7 API (assign, dispatch, notes, new orders, adding/removing stops). */
  api: CheckVerdict;
  apiStatus?: number | null;
  apiDetail?: string | null;
  /** The portal's Route Workbench (the Save that sets a route's stops and order). */
  portal: CheckVerdict;
  portalDetail?: string | null;
  /** NuVizz calls the check spent, measured off the metered requester — not assumed. */
  calls?: number | null;
}

export interface NuvizzLoginFields {
  nuvizzUsername?: string | null;
  nuvizzPasswordSealed?: string | null;
  nuvizzSavedAt?: string | null;
  nuvizzSavedBy?: string | null;
  nuvizzCheck?: NuvizzCheck | null;
  nuvizzRejectedAt?: string | null;
  nuvizzRejectedReason?: string | null;
}

/** Every field a save/remove writes — so "remove" clears exactly what "save" set, no more. */
export const NUVIZZ_LOGIN_FIELD_NAMES = [
  'nuvizzUsername', 'nuvizzPasswordSealed', 'nuvizzSavedAt', 'nuvizzSavedBy',
  'nuvizzCheck', 'nuvizzRejectedAt', 'nuvizzRejectedReason',
] as const;

export interface PublicNuvizzLogin {
  saved: boolean;
  username: string | null;
  savedAt: string | null;
  savedBy: string | null;
  check: NuvizzCheck | null;
  rejected: { at: string; reason: string | null } | null;
}

/** What a browser may see. Never the sealed blob — not even to an admin, not even ciphertext. */
export function publicNuvizzLogin(d: any): PublicNuvizzLogin {
  const saved = !!(d?.nuvizzUsername && d?.nuvizzPasswordSealed);
  if (!saved) return { saved: false, username: null, savedAt: null, savedBy: null, check: null, rejected: null };
  const c = d?.nuvizzCheck && typeof d.nuvizzCheck === 'object' ? d.nuvizzCheck : null;
  const verdict = (v: any): CheckVerdict => (v === 'ok' || v === 'refused' || v === 'skipped' ? v : 'unknown');
  return {
    saved: true,
    username: String(d.nuvizzUsername),
    savedAt: d?.nuvizzSavedAt ? String(d.nuvizzSavedAt) : null,
    savedBy: d?.nuvizzSavedBy ? String(d.nuvizzSavedBy) : null,
    check: c ? {
      at: String(c.at || ''),
      api: verdict(c.api), apiStatus: Number.isFinite(Number(c.apiStatus)) && c.apiStatus !== null ? Number(c.apiStatus) : null,
      apiDetail: c.apiDetail ? String(c.apiDetail) : null,
      portal: verdict(c.portal), portalDetail: c.portalDetail ? String(c.portalDetail) : null,
      calls: Number.isFinite(Number(c.calls)) && c.calls !== null ? Number(c.calls) : null,
    } : null,
    rejected: d?.nuvizzRejectedAt ? { at: String(d.nuvizzRejectedAt), reason: d?.nuvizzRejectedReason ? String(d.nuvizzRejectedReason) : null } : null,
  };
}

// ── ONE WRITE: WHOSE LOGIN? ──────────────────────────────────────────────────

export type SharedWhy = 'off' | 'not-signed-in' | 'not-saved' | 'rejected' | 'unreadable' | 'unavailable';

export type Identity =
  | { kind: 'personal'; appUser: string; nuvizzUser: string; password: string }
  | { kind: 'shared'; appUser: string | null; why: SharedWhy; note: string | null }
  | { kind: 'refused'; appUser: string | null; why: Exclude<SharedWhy, 'off'>; status: 403 | 503; error: string };

export interface ResolveInput {
  mode: PersonalLoginsMode;
  /** requireUser's principal. `authenticated:false` is the legacy "everyone" caller. */
  principal: { username: string; displayName?: string | null; authenticated: boolean } | null;
  /** The person's app_users document, or null when there is none to read. */
  doc: any | null;
  /**
   * true when the account COULD NOT BE READ (a Firestore error), as opposed to read and found
   * empty. The two must not share a sentence: "no NuVizz login is saved for Jane" said to Jane,
   * who saved one yesterday, sends her to re-enter a password that was never the problem.
   */
  docUnavailable?: boolean;
  /**
   * true when the request CARRIED a session token but the gate could not verify it against the
   * account store and let it through as the pre-login caller (require-user.mts does that in
   * legacy mode when the store read throws). That person IS signed in; treating them as "not
   * signed in" would, under `required`, tell a signed-in dispatcher to sign in — the wrong fix
   * for a store hiccup — and under `preferred` drop their name from our ledger without a word.
   */
  tokenUnverified?: boolean;
  /** Opens the sealed password. Injected so the rule is testable without a key; may throw. */
  open: (blob: string, appUser: string, nuvizzUser: string) => string | null;
}

const WHERE = 'under Account & logins';

/**
 * PURE. The whole decision, for ONE mutating write.
 *
 * THE ASYMMETRY IS THE POINT OF THE SWITCH. Under `preferred`, every reason a personal login is
 * unusable falls back to the shared one — the board moves, and the answer carries `why` so the
 * screen can say it went out as the shared login. Under `required`, the same reasons refuse, with
 * a sentence naming the one thing to fix. Nothing here ever falls back to the shared login SILENTLY
 * under `required`: a strict mode that quietly isn't is worse than no strict mode, because nobody
 * goes looking.
 *
 * The 403 is deliberately NOT worded `requires <role>`: lib/api.js reads exactly that shape as a
 * ROLE refusal and raises the role bar. This is not about the role; the Save's own error line is
 * where it belongs.
 */
export function resolveIdentity(input: ResolveInput): Identity {
  const { mode, principal, doc, open } = input;
  const appUser = principal && principal.authenticated ? String(principal.username || '') || null : null;
  const who = principal?.displayName || appUser || 'this account';

  if (mode === 'off') return { kind: 'shared', appUser, why: 'off', note: null };

  const fallback = (why: Exclude<SharedWhy, 'off'>, sentence: string): Identity => (mode === 'required'
    ? { kind: 'refused', appUser, why, status: why === 'unavailable' ? 503 : 403, error: sentence }
    : { kind: 'shared', appUser, why, note: sentence });

  if (!appUser && input.tokenUnverified) {
    return fallback('unavailable', `Your sign-in could not be checked just now, so your NuVizz login could not be looked up — try the Save again in a moment.`);
  }
  if (!appUser) {
    return fallback('not-signed-in', `Writes to NuVizz need your own NuVizz login now — sign in ${WHERE} and save yours there.`);
  }
  if (input.docUnavailable) {
    return fallback('unavailable', `Your account could not be read just now, so your NuVizz login could not be looked up — try the Save again in a moment.`);
  }
  const nuvizzUser = doc?.nuvizzUsername ? String(doc.nuvizzUsername) : '';
  const sealed = doc?.nuvizzPasswordSealed ? String(doc.nuvizzPasswordSealed) : '';
  if (!nuvizzUser || !sealed) {
    return fallback('not-saved', `No NuVizz login is saved for ${who} — add yours ${WHERE}.`);
  }
  if (doc?.nuvizzRejectedAt) {
    return fallback('rejected', `NuVizz refused the login saved for ${who} (${String(doc.nuvizzRejectedReason || 'wrong username or password')}) — re-enter it ${WHERE}.`);
  }
  let password: string | null = null;
  try { password = open(sealed, appUser, nuvizzUser); } catch { password = null; }
  if (!password) {
    return fallback('unreadable', `The NuVizz login saved for ${who} can no longer be read (the server key changed) — re-enter it ${WHERE}.`);
  }
  return { kind: 'personal', appUser, nuvizzUser, password };
}

/** What a response may say about the identity. Never the password. */
export function publicIdentity(id: Identity, mode: PersonalLoginsMode): Record<string, any> {
  if (id.kind === 'personal') return { mode, as: 'personal', appUser: id.appUser, nuvizzUser: id.nuvizzUser };
  if (id.kind === 'shared') return { mode, as: 'shared', appUser: id.appUser, why: id.why, ...(id.note ? { note: id.note } : {}) };
  return { mode, as: 'refused', appUser: id.appUser, why: id.why };
}

/** Basic auth for the v7 API. Callers pass a username already through normalizeNuvizzUsername. */
export function basicAuthFor(nuvizzUser: string, password: string): string {
  return 'Basic ' + Buffer.from(`${nuvizzUser}:${password}`).toString('base64');
}

// ── READING NuVizz's ANSWER TO A LOGIN CHECK ─────────────────────────────────
//
// WHAT THIS KNOWS AND WHAT IT DOES NOT. The v7 check is one authenticated GET for a load number
// that cannot exist. The rule below is the Basic-auth norm, and the portal's own pages carry
// Spring Security's _csrf meta tags (lib/nuvizz-rwb.mts reads them), whose filter chain refuses
// bad credentials with a 401 BEFORE any controller can answer 404. So a 401 is a refusal, and a
// 403 is too for this purpose (the login got in but may not read loads — no use for writes). Only
// the answers a CONTROLLER gives — 2xx, 400, 404 — mean the credentials got past the door.
// Everything else (408, 429, 405, a 5xx, no answer) says nothing about the password, and is
// `unknown`: a rate limit read as "accepted" would save a mistyped password as working, and read
// as "refused" would take a good one out of service. That is reasoned from the framework, not
// observed on this tenant — the first real check is what confirms it, and every check records
// the raw status beside the verdict so the confirmation is readable.

export function classifyApiCheck(status: number | null | undefined): CheckVerdict {
  const s = Number(status);
  if (!Number.isFinite(s) || s <= 0) return 'unknown';
  if (s === 401 || s === 403) return 'refused';
  if ((s >= 200 && s < 300) || s === 400 || s === 404) return 'ok';
  return 'unknown';
}

/**
 * The portal login's steps (lib/nuvizz-rwb.mts portalLogin) → a verdict.
 *
 * `refused` only on a CLEAR answer about the credentials:
 *   • the sign-in answered 200 or 401 WITH A JSON BODY and issued no token — the shape of "wrong
 *     username or password" from a JSON login endpoint; or
 *   • the Route Workbench token step answered 401/403 to a login that DID get a token (a real
 *     account with no Route Workbench access).
 * Everything else is `unknown`: a 429 (rate limit), 408, 403 (Spring's "Invalid CSRF Token" is a
 * 403), 404/405, a non-JSON page, a 5xx, a missing login page, no answer. A recorded refusal takes
 * a login out of service until somebody re-enters it, so a rate limit read as a wrong password
 * quietly puts a dispatcher back on the shared login — the review of this change ran exactly that
 * case. What NuVizz actually sends for a wrong password is not readable from this repo; if it is
 * something other than 200/401-with-JSON, the check reports `unknown` (never a false refusal) and
 * the recorded status/message says what it was.
 */
export function classifyPortalLogin(steps: any[], gotToken: boolean): { verdict: CheckVerdict; detail: string | null } {
  if (gotToken) return { verdict: 'ok', detail: null };
  const list = Array.isArray(steps) ? steps : [];
  const ul = list.find((s) => s && s.step === 'userLogin');
  if (!ul) {
    const boot = list.find((s) => s && s.step === 'bootstrap');
    return { verdict: 'unknown', detail: boot ? `the NuVizz login page answered ${boot.status || 'nothing'} with no sign-in form` : 'the NuVizz login page did not answer' };
  }
  const st = Number(ul.status) || 0;
  if (!ul.jwt) {
    const said = ul.msg ? String(ul.msg).slice(0, 160) : null;
    if ((st === 200 || st === 401) && ul.json === true) {
      return { verdict: 'refused', detail: said ? `NuVizz said: ${said}` : `NuVizz would not sign this login in (HTTP ${st})` };
    }
    return { verdict: 'unknown', detail: `the NuVizz sign-in answered ${st || 'nothing'}${said ? ` (${said})` : ''} — not a clear answer about the password` };
  }
  const at = list.find((s) => s && s.step === 'authtoken');
  const ast = Number(at?.status) || 0;
  if (ast === 401 || ast === 403) {
    return { verdict: 'refused', detail: `signed in, but NuVizz would not open the Route Workbench for this login (HTTP ${ast})` };
  }
  return { verdict: 'unknown', detail: `signed in, but the Route Workbench token step answered ${ast || 'nothing'}` };
}

/** One sentence for a check, for logs and for the screen. */
export function describeCheck(c: NuvizzCheck | null | undefined): string {
  if (!c) return 'not tested';
  const word = (v: CheckVerdict) => (v === 'ok' ? 'accepted' : v === 'refused' ? 'REFUSED' : v === 'skipped' ? 'not tested here' : 'no clear answer');
  return `API ${word(c.api)}${c.apiStatus ? ` (HTTP ${c.apiStatus})` : ''} · Route Workbench ${word(c.portal)}`;
}
