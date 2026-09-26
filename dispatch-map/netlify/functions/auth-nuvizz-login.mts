// auth-nuvizz-login.mts — a person's own NuVizz login: see it, save it, test it, remove it.
//
//   GET                          → { ok, mode, login, keyReady, rwbEngine, checkCalls }   yours
//   GET ?username=jane           → the same, for jane                                     admin
//   POST { action:'save', nuvizzUsername, nuvizzPassword, username? }  → { ok, login, check }
//   POST { action:'test', username? }                                  → { ok, login, check }
//   POST { action:'remove', username? }                                → { ok, login }
//
// Chad, 2026-09-26: "I want to create logins for all the different users with their personal
// nuvizz login information instead of every dispatcher using mine." This is where that
// information goes in. What uses it is nuvizz-write.mts (lib/nuvizz-identity.mts decides).
//
// SIGNED IN, ALWAYS (strict): the pre-login "everyone" caller has no account to save a login on.
// Your own login is yours to manage at any role; someone else's is an admin's job — Chad setting
// his dispatchers up is the case this was built for.
//
// THE PASSWORD GOES ONE WAY. It arrives here, is tested against NuVizz, is sealed (AES-256-GCM,
// bound to both usernames — lib/nuvizz-identity.mts) and stored. Nothing on any path sends it,
// its seal, or any fragment of it back to a browser — not to the person, not to an admin. The
// logs name the accounts and the verdict, never the password.
//
// SAVING TESTS FIRST, AND A LOGIN NuVizz REFUSES IS NOT SAVED. A typo stored here would fail at
// the first Save of the night instead of now, with the person who typed it no longer looking.
// The test is exactly the sign-in a Save performs (lib/nuvizz-rwb.mts rwbCheckLogin) plus one
// v7 API read, so "tested OK" means "a Save would get in". It spends NuVizz calls — ~5 with the
// Route Workbench on, 1 without — through the metered requester, visible in Diagnostics as
// trigger 'login-check', and only when a person presses the button.
//
// AND IT PROTECTS THE NuVizz ACCOUNT. A wrong password tried over and over is how an account
// gets locked — in NuVizz, not here, so the person loses NuVizz itself. So: the portal is asked
// FIRST and a clear refusal skips the API check (one wrong attempt per test, not two); the exact
// same wrong password is not re-sent to NuVizz inside the hold window (rwbCheckLogin); and tests
// of one account are throttled. None of that makes a lockout impossible — NuVizz's own threshold
// is not readable from this repo — it makes one unlikely, and the screen says why it is careful.

import { requireUser, readJsonBody, jsonResponse, denied, throttled } from './lib/require-user.mts';
import { normalizeUsername, roleAtLeast } from './lib/auth-core.mts';
import { getUser, patchUser, storeReady } from './lib/auth-store.mts';
import {
  personalLoginsMode, normalizeNuvizzUsername, nuvizzPasswordProblem, loginKey, loginKeyReady,
  sealNuvizzPassword, openNuvizzPassword, publicNuvizzLogin, classifyApiCheck, describeCheck,
  NUVIZZ_LOGIN_FIELD_NAMES, type NuvizzCheck, type CheckVerdict,
} from './lib/nuvizz-identity.mts';
import { personalWriteCreds } from './lib/nuvizz-write.mts';
import { buildOpRequest } from './lib/nuvizz-write-ops.mts';
import { rwbCheckLogin, rwbEngineEnabled } from './lib/nuvizz-rwb.mts';
import { getNuvizzRequester, setCallTrigger, NuvizzCircuitOpenError } from './lib/nuvizz-request.mts';
import { isMirrorDeploy } from './lib/mirror-guard.mts';

const bad = (error: string, status = 400, extra: Record<string, any> = {}) => jsonResponse({ ok: false, error, ...extra }, status);

/** A load number NuVizz cannot have: the v7 check reads it to see whether the login gets past the door. */
export const CHECK_LOAD_NBR = 'DDLOGINCHECK0';

/** Tests of ONE account per warm instance per window. A person typing carefully needs one or two. */
export const TESTS_PER_WINDOW = 3;
export const TEST_WINDOW_MS = 15 * 60_000;

/** The NuVizz calls a test spends, for the button to say before it is pressed. */
export function checkCallCost(): number { return rwbEngineEnabled() ? 5 : 1; }

/**
 * Ask NuVizz whether this login gets in. Portal first (4 calls — the Save's own sign-in), then
 * one v7 read — skipped when the portal CLEARLY refused, so a wrong password costs one failed
 * attempt at NuVizz rather than two. Never throws; every failure mode is a verdict.
 */
export async function runLoginCheck(nuvizzUser: string, password: string): Promise<NuvizzCheck> {
  const at = new Date().toISOString();
  if (isMirrorDeploy()) {
    const why = 'a UAT / mirror site makes no NuVizz calls, so this login was saved untested';
    return { at, api: 'skipped', apiStatus: null, apiDetail: why, portal: 'skipped', portalDetail: why, calls: 0 };
  }
  setCallTrigger('login-check');
  const reqr = getNuvizzRequester();
  const before = reqr.getStats().totalThisInstance;

  const portal = await rwbCheckLogin(reqr, { username: nuvizzUser, password });

  let api: CheckVerdict = 'unknown';
  let apiStatus: number | null = null;
  let apiDetail: string | null = null;
  if (portal.verdict === 'refused') {
    api = 'skipped';
    apiDetail = 'not asked — the Route Workbench sign-in already refused this login, and a second wrong attempt only brings a NuVizz lockout closer';
  } else {
    try {
      const creds = personalWriteCreds(nuvizzUser, password);
      const br = buildOpRequest('getLoad', { loadNbr: CHECK_LOAD_NBR }, creds);
      const resp = await reqr.request(br.url, { method: br.method, headers: br.headers, maxRetries: 0 }, { ...br.meta, source: 'login-check' });
      apiStatus = resp.status;
      api = classifyApiCheck(resp.status);
      if (api === 'refused') apiDetail = `the NuVizz API answered ${resp.status} to this login`;
      else if (api === 'unknown') apiDetail = `the NuVizz API answered ${resp.status} — no clear answer either way`;
    } catch (e: any) {
      apiDetail = e instanceof NuvizzCircuitOpenError
        ? "the day's NuVizz call ceiling is reached, so the API could not be asked"
        : `the NuVizz API could not be asked: ${String(e?.message || e).slice(0, 160)}`;
    }
  }
  const calls = Math.max(0, reqr.getStats().totalThisInstance - before);
  return { at, api, apiStatus, apiDetail, portal: portal.verdict, portalDetail: portal.detail, calls };
}

const refusedIn = (c: NuvizzCheck | null) => !!c && (c.api === 'refused' || c.portal === 'refused');
const refusalWords = (c: NuvizzCheck) => (c.portal === 'refused' ? c.portalDetail : c.apiDetail) || 'wrong username or password';
/** A check that clears an earlier refusal: nothing refused, and at least one side said yes. */
const clearsRefusal = (c: NuvizzCheck) => !refusedIn(c) && (c.api === 'ok' || c.portal === 'ok');

export default async (req: Request): Promise<Response> => {
  if (!storeReady()) return bad('user store not configured (FIREBASE_SA)', 503);
  const gate = await requireUser(req, { strict: true });
  if (!gate.ok) {
    // Like auth-me: a caller with no session may still learn the one site-level fact the screen
    // needs (which mode the switch is in). Nothing about any account.
    const orig = await gate.response.json().catch(() => ({}));
    return jsonResponse({ ...orig, ok: false, mode: personalLoginsMode() }, gate.response.status);
  }
  const me = gate.user;

  let body: any = {};
  if (req.method === 'POST') {
    const b = await readJsonBody(req);
    if (!b.ok) return b.response;
    body = b.body;
  } else if (req.method !== 'GET') {
    return bad('GET or POST only', 405);
  }

  const asked = req.method === 'GET' ? new URL(req.url).searchParams.get('username') : body.username;
  const target = asked ? normalizeUsername(asked) : me.username;
  if (!target) return bad('username must be 2–40 chars: lower-case letters, digits, _ or -');
  // Someone else's NuVizz login is an admin's job. Worded `requires admin` on purpose: that is the
  // shape lib/api.js reads as a ROLE refusal, which is exactly what this is.
  if (target !== me.username && !roleAtLeast(me.role, 'admin')) return denied(403, 'requires admin');

  const doc = await getUser(target);
  if (!doc) return bad('no such user', 404);

  const answer = (extra: Record<string, any> = {}, d: any = doc) => jsonResponse({
    ok: true, username: target, mode: personalLoginsMode(), login: publicNuvizzLogin(d),
    keyReady: loginKeyReady(), rwbEngine: rwbEngineEnabled(), checkCalls: checkCallCost(), ...extra,
  });

  if (req.method === 'GET') return answer();

  const action = String(body.action || '');

  // ── save ──────────────────────────────────────────────────────────────────
  if (action === 'save') {
    const nuvizzUser = normalizeNuvizzUsername(body.nuvizzUsername);
    if (!nuvizzUser) return bad('NuVizz username: 1–120 characters, no spaces and no colon');
    const problem = nuvizzPasswordProblem(body.nuvizzPassword);
    if (problem) return bad(problem.charAt(0).toUpperCase() + problem.slice(1));
    const password = String(body.nuvizzPassword);
    let key: Buffer;
    try { key = loginKey(); } catch {
      return bad('NuVizz logins cannot be stored on this site yet — it has no key to seal them with (set NUVIZZ_LOGIN_KEY). Tell Chad.', 503);
    }
    // Saving untested is an admin's call only (NuVizz down, a login they are sure of). A person
    // entering their own always gets the test, because they are the one a typo would strand.
    const test = !(body.test === false && roleAtLeast(me.role, 'admin'));
    let check: NuvizzCheck | null = null;
    if (test) {
      if (throttled(`nuvizz-login-test:${target}`, TESTS_PER_WINDOW, TEST_WINDOW_MS)) {
        return bad(`Too many NuVizz login tests for ${doc.displayName || target} — wait 15 minutes. Repeated wrong passwords can lock the NuVizz account itself.`, 429);
      }
      check = await runLoginCheck(nuvizzUser, password);
      if (refusedIn(check)) {
        console.warn(`[auth-nuvizz-login] ${me.username} save for user=${target} nuvizz=${nuvizzUser}: REFUSED — ${describeCheck(check)} — nothing saved`);
        return bad(`NuVizz refused this login, so nothing was saved: ${refusalWords(check)}. Check it by signing in to NuVizz directly before trying again — several wrong tries can lock the NuVizz account.`, 422, { check });
      }
    }
    const fields = {
      nuvizzUsername: nuvizzUser,
      nuvizzPasswordSealed: sealNuvizzPassword(password, target, nuvizzUser, key),
      nuvizzSavedAt: new Date().toISOString(),
      nuvizzSavedBy: me.username,
      nuvizzCheck: check,
      nuvizzRejectedAt: null,
      nuvizzRejectedReason: null,
    };
    await patchUser(target, fields);
    console.log(`[auth-nuvizz-login] ${me.username} saved the NuVizz login for user=${target} nuvizz=${nuvizzUser} — ${describeCheck(check)}`);
    return answer({ check }, { ...doc, ...fields });
  }

  // ── test (the saved login) ────────────────────────────────────────────────
  if (action === 'test') {
    if (!doc.nuvizzUsername || !doc.nuvizzPasswordSealed) return bad('No NuVizz login is saved for this account yet.', 409);
    let password: string | null = null;
    try { password = openNuvizzPassword(doc.nuvizzPasswordSealed, target, String(doc.nuvizzUsername), loginKey()); } catch { password = null; }
    if (!password) return bad('The saved NuVizz login can no longer be read (the server key changed). Enter it again.', 409);
    if (throttled(`nuvizz-login-test:${target}`, TESTS_PER_WINDOW, TEST_WINDOW_MS)) {
      return bad(`Too many NuVizz login tests for ${doc.displayName || target} — wait 15 minutes. Repeated wrong passwords can lock the NuVizz account itself.`, 429);
    }
    const check = await runLoginCheck(String(doc.nuvizzUsername), password);
    const fields: Record<string, any> = { nuvizzCheck: check };
    // A refusal takes the login out of service now (the same mark a refused Save leaves); a clean
    // answer puts a previously refused one back. "No clear answer" changes neither.
    if (refusedIn(check)) { fields.nuvizzRejectedAt = check.at; fields.nuvizzRejectedReason = refusalWords(check); }
    else if (clearsRefusal(check)) { fields.nuvizzRejectedAt = null; fields.nuvizzRejectedReason = null; }
    await patchUser(target, fields);
    console.log(`[auth-nuvizz-login] ${me.username} tested the NuVizz login of user=${target} nuvizz=${doc.nuvizzUsername} — ${describeCheck(check)}`);
    return answer({ check }, { ...doc, ...fields });
  }

  // ── remove ────────────────────────────────────────────────────────────────
  if (action === 'remove') {
    const fields = Object.fromEntries(NUVIZZ_LOGIN_FIELD_NAMES.map((k) => [k, null]));
    await patchUser(target, fields);
    console.log(`[auth-nuvizz-login] ${me.username} removed the NuVizz login of user=${target}`);
    return answer({}, { ...doc, ...fields });
  }

  return bad(`unknown action '${action}'`);
};
