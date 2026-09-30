// lib/nuvizz-rwb.mts
//
// ── Route Workbench (RWB) — the 2-call, SYNCHRONOUS stop-order engine ───────────
//
// The existing ⚡ Import engine sets a load's order via NuVizz's ASYNC load/update
// import — which is why every Save needs the client-side poll/re-send/reverse-unstick
// ladder (verifyPendingImports, ~30-90s to confirm, and the Jul 2 incident where an
// incomplete echo cloned/wiped orders). RWB is the NuVizz PORTAL's own Route Workbench
// screen — it sets the whole sequence with 2 SYNCHRONOUS calls and, critically,
// references stops BY ID ONLY: it never re-sends the stop record, so freight / item
// lines / addresses cannot be blanked or cloned by an incomplete echo. Proven
// byte-for-byte against UAT (DAVISV5) Jul 2026: before/after stop snapshots differed
// ONLY in seq / ETA / leg-distance / audit fields — every cargo field was identical.
//
// AUTH (reverse-engineered, portal session — NOT the v7 Basic-auth API):
//   1. GET  {loginBase}/loginreg/                       -> SESSION cookie + <meta _csrf>
//   2. POST {loginBase}/loginreg/reg/checkCompanyLogin   {companyCode, appCode:"portal"}
//   3. POST {loginBase}/loginreg/auth/userLogin          (multipart) -> JWT (data.data.jwtToken)
//   4. POST {portalBase}/deliverit/instance/ndv2/openapi/loginreg/authtoken/{COMPANY}
//      {username:"jwt", password:JWT} -> authToken
//   5. RWB calls: Authorization: Basic base64("JWT:"+authToken) + Cookie: Instance=ndv2
// authToken is short-lived (~15 min) — cached per warm function instance and re-used
// across Saves; a 401 anywhere drops the cache and re-logs in once.
//
// SAFETY — this is a SEPARATE credential/target surface from the rest of this file's
// v7 API (which defaults to whatever NUVIZZ_DAVIS_* env this deploy is configured
// with — production on the real site, UAT on this prod-mirror). RWB's login/company/
// creds are their OWN env vars and do NOT fall back to NUVIZZ_DAVIS_USER/PASS — an
// operator must explicitly set NUVIZZ_RWB_USER/PASS before RWB can log in at all, and
// the login target defaults to UAT (loginqa.nuvizz.com / DAVISV5) so flipping
// NUVIZZ_RWB_ENABLED on this deploy alone can NEVER reach production. The prod switch
// is a deliberate, separate env change (see the checklist at the bottom of this file) —
// matching how NUVIZZ_LOAD_IMPORT was rolled out (double-gated, OFF until sign-off).

import { createHash } from 'node:crypto';
import { classifyPortalLogin, type CheckVerdict } from './nuvizz-identity.mts';

// Structurally the same shape as nuvizz-write.mts's RequesterLike (not imported directly —
// that would be a circular import — but TS structural typing makes any compatible object
// interchangeable). Every RWB call rides the SAME metered, counted, breaker-guarded
// requester as every v7 call, so a Save's true call volume is fully visible in Diagnostics
// (this is also required by test/no-direct-nuvizz-fetch.test.mjs — RWB is a different host/
// auth surface than the v7 API, but it must never be an invisible uncounted request).
export interface RwbRequesterLike {
  request(url: string, opts: { method?: string; headers?: Record<string, string>; body?: any; maxRetries?: number }, meta: { route: string; tenant: string; source?: string }): Promise<Response>;
}

export function rwbEngineEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test(String(process.env.NUVIZZ_RWB_ENABLED ?? '').trim());
}
export function rwbEngineBlocked(): boolean {
  return !rwbEngineEnabled();
}
/** True only when the RWB portal login is fully configured (enabled AND creds present).
 * Callers gate on this BEFORE issuing any v7 membership write (insertStops/removeStops),
 * so an enabled-but-credentialless deploy can never leave a load half-mutated (order
 * unset) — the empty-creds refusal happens before the first network call, not after.
 *
 * `auth` — a PERSONAL portal login (lib/nuvizz-identity.mts). When one is passed it is the
 * ONLY login considered: an incomplete personal login is NOT ready, rather than quietly
 * becoming the shared one. See rwbConfig. */
export function rwbConfigReady(auth?: RwbAuth | null): boolean {
  if (rwbEngineBlocked()) return false;
  const c = rwbConfig(auth);
  return !!c.username && !!c.password;
}

/**
 * A PERSON'S OWN NuVizz portal login, for the Route Workbench calls made on their behalf
 * (Chad, 2026-09-26: "...with their personal nuvizz login information instead of every
 * dispatcher using mine"). Absent ⇒ the shared NUVIZZ_RWB_USER/PASS, exactly as before this
 * existed — every entry point below takes it as an optional LAST argument, so a caller that
 * passes nothing gets byte-for-byte the old behaviour.
 */
export interface RwbAuth { username: string; password: string }

interface RwbConfig {
  loginBase: string;
  portalBase: string;
  companyCode: string;
  company: string;
  username: string;
  password: string;
  /** true when the login is a person's own (the RwbAuth override), false for the shared env one. */
  personal: boolean;
}

function rwbConfig(auth?: RwbAuth | null): RwbConfig {
  const base = {
    loginBase: process.env.NUVIZZ_RWB_LOGIN_BASE || 'https://loginqa.nuvizz.com',
    portalBase: process.env.NUVIZZ_RWB_PORTAL_BASE || 'https://uat.nuvizz.com',
    companyCode: process.env.NUVIZZ_RWB_COMPANY_CODE || 'davisv5',
    company: (process.env.NUVIZZ_RWB_COMPANY || 'DAVISV5').toUpperCase(),
  };
  // A personal login REPLACES the shared one entirely — it never falls back to it field by
  // field. An override with an empty password is therefore an unready config (refused before
  // any call), not a half-shared one that signs in as Chad under the dispatcher's name.
  if (auth) return { ...base, username: String(auth.username || ''), password: String(auth.password || ''), personal: true };
  return { ...base, username: process.env.NUVIZZ_RWB_USER || '', password: process.env.NUVIZZ_RWB_PASS || '', personal: false };
}

// Per-host cookie jar (SESSION cookie only matters within the login+authtoken handshake).
function makeJar() {
  const byHost = new Map<string, Map<string, string>>();
  return {
    store(host: string, res: Response) {
      let list: string[] = [];
      try { list = (res.headers as any).getSetCookie?.() || []; } catch { /* older runtime */ }
      if (!list.length) { const raw = res.headers.get('set-cookie'); if (raw) list = [raw]; }
      if (!byHost.has(host)) byHost.set(host, new Map());
      const m = byHost.get(host)!;
      for (const c of list) { const f = c.split(';')[0]; const i = f.indexOf('='); if (i > 0) m.set(f.slice(0, i).trim(), f.slice(i + 1).trim()); }
    },
    header(host: string) { const m = byHost.get(host); return m && m.size ? [...m.entries()].map(([k, v]) => `${k}=${v}`).join('; ') : ''; },
  };
}
const hostOf = (u: string) => new URL(u).host;

// Routes through the SAME metered requester as the v7 API (counted, breaker-guarded) —
// never an uncounted direct request. maxRetries:0 always: RWB writes are never transport-retried, same
// posture as insertStops/removeStops/assignDriver/dispatchLoad (a retried
// saveComparedRouteData on a transient 5xx must not double-fire the full-route replace).
// No `redirect` override is passed (defaults to 'follow') — proven fine live: the login
// bootstrap GET returns its HTML body (+ Set-Cookie) directly, never a redirect.
// Browser-identity headers so the engine's portal calls match a real Route Workbench
// browser session (not a Node/undici fetch) — the request profile is already
// HAR-matched; these close the header-fingerprint gap. RWB_BROWSER_UA is the
// dispatcher's ACTUAL Chrome, captured from the app's debug bundles (same
// machine/browser used for the NuVizz portal); bump it when their browser updates,
// or override via NUVIZZ_RWB_USER_AGENT. Set on EVERY portal request via go(); the
// authed XHR calls additionally send Accept + X-Requested-With (see rwbAuthedCall).
// Values verified against the dispatcher's real Route Workbench HAR
// (Route_Sequencing.har): a macOS Chrome 147 session. The client hints are
// version-coupled — bump alongside the UA (or override the UA via
// NUVIZZ_RWB_USER_AGENT). The real portal does NOT send X-Requested-With, so we
// don't either. accept-encoding/connection are managed by undici, not set here.
const RWB_BROWSER_UA = (typeof process !== 'undefined' && process.env && process.env.NUVIZZ_RWB_USER_AGENT)
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const RWB_BASE_BROWSER_HEADERS = {
  'user-agent': RWB_BROWSER_UA,
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

async function go(requester: RwbRequesterLike, jar: ReturnType<typeof makeJar>, method: string, url: string, opts: { headers?: Record<string, string>; body?: any; route: string; tenant: string } = { route: 'rwb', tenant: '' }): Promise<{ status: number; text: string; data: any }> {
  const host = hostOf(url);
  const cookie = jar.header(host);
  const res = await requester.request(url, { method, headers: { ...RWB_BASE_BROWSER_HEADERS, ...(cookie ? { cookie } : {}), ...(opts.headers || {}) }, body: opts.body, maxRetries: 0 }, { route: opts.route, tenant: opts.tenant, source: 'rwb' });
  jar.store(host, res);
  const text = await res.text().catch(() => '');
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, data };
}

// Warm-instance session cache — Netlify functions stay warm between invocations in the
// same process, so a login (~4 calls) is skipped on every Save within a warm instance
// as long as the token is still fresh (~15 min real life; cached for 12 to be safe).
//
// ONE SESSION PER LOGIN, NEVER ONE FOR EVERYBODY. This was a single variable while every Save
// used the one shared login. With personal logins, a single slot would hand the NEXT dispatcher
// whose Save reached this warm instance the PREVIOUS dispatcher's portal session — their route
// saved under someone else's name, which is precisely the attribution this change exists to
// fix, and invisible, because the Save would succeed. So the cache is keyed by the login itself
// (rwbSessionKey): login host, company, username and a fingerprint of the password, so a
// re-entered password is a new login rather than a stale session wearing the new one's name.
type RwbSession = { authToken: string; jar: ReturnType<typeof makeJar>; ref: string; at: number };
const sessions = new Map<string, RwbSession>();
const SESSION_TTL_MS = 12 * 60 * 1000;
// A dispatch office is a handful of logins; the cap only stops a warm instance's map from
// growing without bound. The oldest session goes first — it costs a re-login, never a wrong one.
const SESSION_CAP = 64;

export function rwbSessionKey(cfg: { loginBase: string; companyCode: string; username: string; password: string }): string {
  const fp = createHash('sha256').update(String(cfg.password)).digest('hex').slice(0, 16);
  return `${cfg.loginBase}|${cfg.companyCode}|${cfg.username}|${fp}`;
}

// ── A REFUSED PERSONAL LOGIN IS NOT RETRIED ──────────────────────────────────
//
// THE BAD NIGHT THIS PREVENTS. A dispatcher changes their NuVizz password in the portal and
// forgets the copy saved here. Every Save then attempts a portal sign-in with the old one — and
// a Save is up to two sign-ins (the preference call and the first preview each open a session).
// NuVizz, like any login, locks an account after enough wrong passwords, so a few Saves at 8:45pm
// would lock the dispatcher out of NuVizz ITSELF, portal and phone app, in the middle of routing.
//
// So a PERSONAL login NuVizz clearly refused (classifyPortalLogin — an outage never counts) is
// held here and not tried again for REFUSAL_HOLD_MS in this instance; the Save fails at once with
// a sentence saying why. The write endpoint picks the refusal up (takeRwbLoginRefusal) and records
// it on the person's account, which is what stops every OTHER instance using it too, until the
// login is re-entered. The SHARED login is deliberately untouched by this: with the switch off,
// this module behaves exactly as it did before personal logins existed.
const refusedLogins = new Map<string, { at: number; detail: string }>();
export const REFUSAL_HOLD_MS = 10 * 60 * 1000;
// Keyed by the LOGIN (rwbSessionKey), not by the NuVizz username alone: a refusal belongs to the
// exact username-and-password that was refused, and must not be picked up by a request carrying a
// different one.
const refusalsToReport = new Map<string, { at: string; detail: string }>();

/** The refusal a Save's portal sign-in hit for THIS login, once — or null. */
export function takeRwbLoginRefusal(auth: RwbAuth | null | undefined): { at: string; detail: string } | null {
  if (!auth) return null;
  const k = rwbSessionKey(rwbConfig(auth));
  const r = refusalsToReport.get(k) || null;
  refusalsToReport.delete(k);
  return r;
}

/**
 * Hold a personal login that NuVizz refused somewhere ELSE — the v7 API answering 401 to the same
 * username and password (lib/nuvizz-write-identity.mts). One Save, one brake: without this, a v7
 * refusal early in a Save leaves the portal free to try the same stale password again a moment
 * later, one more wrong attempt toward a NuVizz lockout.
 */
export function holdRwbLogin(auth: RwbAuth | null | undefined, detail: string): void {
  if (!auth) return;
  refusedLogins.set(rwbSessionKey(rwbConfig(auth)), { at: Date.now(), detail: String(detail || 'refused') });
}

/**
 * Drop this instance's hold on a login that PASSED a check at or after the moment it was held.
 * The check (Test, or a re-save) runs in auth-nuvizz-login, a separate function, so it cannot
 * clear this process's hold itself; the write endpoint reads the account fresh and hands the
 * check's time here. A hold with no passing check since it was taken stays — that is the brake
 * that keeps a stale password from locking the NuVizz account when marking the account failed.
 */
export function releaseRwbLoginCheckedSince(auth: RwbAuth | null | undefined, checkedOkAt: string | null | undefined): boolean {
  if (!auth || !checkedOkAt) return false;
  const t = Date.parse(checkedOkAt);
  if (!Number.isFinite(t)) return false;
  const key = rwbSessionKey(rwbConfig(auth));
  const held = refusedLogins.get(key);
  if (!held || held.at > t) return false;
  refusedLogins.delete(key);
  return true;
}

/** Is this personal login being held after a refusal (portal or API), in this instance? */
export function rwbLoginHeld(auth: RwbAuth | null | undefined): boolean {
  if (!auth) return false;
  const cfg = rwbConfig(auth);
  return heldRefusal(cfg, rwbSessionKey(cfg)) != null;
}

/** Test hook: forget every session, every preference latch and every held refusal. */
export function _resetRwbSessions(): void {
  sessions.clear();
  refusedLogins.clear();
  refusalsToReport.clear();
  prefSet.clear();
}

function heldRefusal(cfg: RwbConfig, key: string): string | null {
  if (!cfg.personal) return null;
  const held = refusedLogins.get(key);
  if (!held) return null;
  const age = Date.now() - held.at;
  if (age >= REFUSAL_HOLD_MS) { refusedLogins.delete(key); return null; }
  const mins = Math.max(1, Math.round(age / 60000));
  return `NuVizz refused the NuVizz login saved as ${cfg.username} ${mins} min ago (${held.detail}) — not tried again, so NuVizz does not lock the account. It has to be re-entered under Account & logins.`;
}

function credsMissingMessage(cfg: RwbConfig): string {
  return cfg.personal
    ? 'the personal NuVizz login is incomplete (no username or password) — refused before any write'
    : 'RWB creds not configured (NUVIZZ_RWB_USER/PASS)';
}

async function portalLogin(requester: RwbRequesterLike, cfg: RwbConfig): Promise<{ authToken?: string; jar?: ReturnType<typeof makeJar>; ref?: string; error?: string; steps: any[] }> {
  const jar = makeJar();
  const steps: any[] = [];
  const ref = `${cfg.portalBase}/deliverit/dirouteworkbench/index.html`;
  const tenant = cfg.company;

  const boot = await go(requester, jar, 'GET', `${cfg.loginBase}/loginreg/`, { route: '/rwb/loginreg', tenant });
  const mTok = (boot.text || '').match(/name=["']_csrf["']\s+content=["']([^"']+)["']/i);
  const mHdr = (boot.text || '').match(/name=["']_csrf_header["']\s+content=["']([^"']+)["']/i);
  const csrf = mTok ? mTok[1] : null;
  const csrfHeaderName = mHdr ? mHdr[1] : 'X-CSRF-TOKEN';
  steps.push({ step: 'bootstrap', status: boot.status, csrfFound: !!csrf });
  if (!csrf) return { error: 'no CSRF token from login page', steps };
  const csrfHdr = { [csrfHeaderName]: csrf };

  const cc = await go(requester, jar, 'POST', `${cfg.loginBase}/loginreg/reg/checkCompanyLogin`, {
    headers: { 'content-type': 'application/json', origin: cfg.loginBase, referer: `${cfg.loginBase}/loginreg/`, ...csrfHdr },
    body: JSON.stringify({ companyCode: cfg.companyCode, appCode: 'portal' }),
    route: '/rwb/checkCompanyLogin', tenant,
  });
  steps.push({ step: 'checkCompanyLogin', status: cc.status });

  const fd = new FormData();
  fd.set('companyCode', cfg.companyCode); fd.set('username', cfg.username); fd.set('password', cfg.password); fd.set('appCode', 'portal');
  const ul = await go(requester, jar, 'POST', `${cfg.loginBase}/loginreg/auth/userLogin`, { headers: { origin: cfg.loginBase, referer: `${cfg.loginBase}/loginreg/`, ...csrfHdr }, body: fd, route: '/rwb/userLogin', tenant });
  const jwt = ul.data && ((ul.data.data && ul.data.data.jwtToken) || ul.data.jwtToken);
  // `json`: whether the sign-in answered with a JSON body at all — a clear "wrong password" is JSON;
  // a rate-limit page or an HTML error is not, and must not be read as one (classifyPortalLogin).
  steps.push({ step: 'userLogin', status: ul.status, jwt: !!jwt, msg: ul.data && ul.data.message, json: ul.data != null && typeof ul.data === 'object' });
  if (!jwt) return { error: cfg.personal ? `login failed (no JWT) — NuVizz did not accept the NuVizz login saved as ${cfg.username}` : 'login failed (no JWT) — check NUVIZZ_RWB_USER/PASS', steps };

  const at = await go(requester, jar, 'POST', `${cfg.portalBase}/deliverit/instance/ndv2/openapi/loginreg/authtoken/${cfg.company}`, {
    headers: { 'content-type': 'application/json', origin: cfg.portalBase, referer: ref },
    body: JSON.stringify({ username: 'jwt', password: jwt }),
    route: '/rwb/authtoken', tenant,
  });
  const authToken = at.data && (at.data.authToken || at.data.token || at.data.jwtToken);
  steps.push({ step: 'authtoken', status: at.status, authToken: !!authToken });
  if (!authToken) return { error: 'no authToken', steps };

  return { authToken, jar, ref, steps };
}

function keepSession(key: string, s: RwbSession): RwbSession {
  sessions.delete(key);                                   // re-insert = newest, for the eviction order
  if (sessions.size >= SESSION_CAP) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
  sessions.set(key, s);
  return s;
}

async function session(requester: RwbRequesterLike, cfg: RwbConfig): Promise<{ authToken: string; jar: ReturnType<typeof makeJar>; ref: string } | { error: string }> {
  const key = rwbSessionKey(cfg);
  const hit = sessions.get(key);
  if (hit && Date.now() - hit.at < SESSION_TTL_MS) return hit;
  const held = heldRefusal(cfg, key);
  if (held) return { error: held };
  const r = await portalLogin(requester, cfg);
  if (r.error || !r.authToken || !r.jar || !r.ref) {
    if (cfg.personal) {
      const c = classifyPortalLogin(r.steps, false);
      if (c.verdict === 'refused') {
        const detail = c.detail || 'refused';
        refusedLogins.set(key, { at: Date.now(), detail });
        refusalsToReport.set(key, { at: new Date().toISOString(), detail });
      }
    }
    return { error: r.error || 'login failed' };
  }
  return keepSession(key, { authToken: r.authToken, jar: r.jar, ref: r.ref, at: Date.now() });
}

async function rwbAuthedCall(requester: RwbRequesterLike, cfg: RwbConfig, method: string, path: string, form: Record<string, string> | null, retried = false): Promise<{ ok: boolean; status: number; body: any; error?: string }> {
  const sess = await session(requester, cfg);
  if ('error' in sess) return { ok: false, status: 0, body: null, error: `RWB login failed: ${sess.error}` };
  const basic = 'Basic ' + Buffer.from(`JWT:${sess.authToken}`).toString('base64');
  const url = `${cfg.portalBase}/deliverit/${path}`;
  // GET calls (validate/check endpoints) carry no multipart body; POSTs send the form.
  let body: any = null;
  if (form && method.toUpperCase() !== 'GET') { const fd = new FormData(); for (const [k, v] of Object.entries(form)) fd.set(k, v); body = fd; }
  const routeLabel = path.split('/').filter((s) => !/^[0-9a-f]{24}$/.test(s)).pop();
  const r = await go(requester, sess.jar, method, url, { headers: { authorization: basic, cookie: 'Instance=ndv2', referer: sess.ref, origin: cfg.portalBase, accept: 'application/json, text/plain, */*', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }, body, route: `/rwb/${routeLabel}`, tenant: cfg.company });
  if (r.status === 401 && !retried) {
    sessions.delete(rwbSessionKey(cfg)); // token expired mid-instance-life — one retry with a fresh login
    return rwbAuthedCall(requester, cfg, method, path, form, true);
  }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.data ?? r.text?.slice(0, 2000) };
}

// True when a portal JSON body (or plain-text "Success") indicates application success. deliverit
// answers 200 with either { responseCode:200, message:'SUCCESS' } or a bare "Success" string, and
// signals failure with a non-200 responseCode / success:false — which MUST reject a 2xx.
function rwbBodyOk(body: any): boolean {
  if (body == null) return true;
  if (typeof body === 'string') return /success/i.test(body);
  if (typeof body === 'object') {
    if (body.success === false) return false;
    if (body.responseCode != null && Number(body.responseCode) !== 200) return false;
    return true;
  }
  return true;
}

// Per-stop add (the portal's proven shape from the HAR): validate GET then add POST, one at a
// time. Used as the FALLBACK when the batch add is rejected. Returns ok + calls made.
async function rwbAddStopsPerStop(requester: RwbRequesterLike, cfg: RwbConfig, routePlanId: string, ids: string[], steps: any[]): Promise<{ ok: boolean; message: string; calls: number }> {
  let calls = 0;
  for (const id of ids) {
    // ?routeId= rides EVERY portal validate — 10/10 in the Jul 9 HARs, single-stop included
    // (it scopes the server-side eligibility check); the fallback used to drop it.
    const v = await rwbAuthedCall(requester, cfg, 'GET', `dirouteworkbench/stop/validateStopstoPerformAction/${id}?routeId=${encodeURIComponent(routePlanId)}`, null);
    calls++;
    steps.push({ op: 'validateStop', stopId: id, ok: v.ok && rwbBodyOk(v.body), status: v.status });
    if (!v.ok || !rwbBodyOk(v.body)) return { ok: false, message: `stop ${id} failed RWB add-validation (status ${v.status})`, calls };
    const a = await rwbAuthedCall(requester, cfg, 'POST', 'dirouteworkbench/stop/addStopsToRouteAfterValidation', { routePlanId, stopIds: id, isPlanningMode: 'true' });
    calls++;
    const ok = a.ok && rwbBodyOk(a.body);
    steps.push({ op: 'addStopsToRoute', stopId: id, ok, status: a.status });
    if (!ok) return { ok: false, message: a.error || `addStopsToRoute failed for stop ${id} (status ${a.status})`, calls };
  }
  return { ok: true, message: `Added ${ids.length} stop(s) per-stop.`, calls };
}

// ── Session preference: keep OUR order (no server-side re-optimization) ──────
// The portal fires saveRwbPreference?preference=RWB_RTE_EXRTESEC&value=OFF before building a route,
// which disables the workbench's auto re-sequence. We do our OWN optimization in dispatch-map and
// send seqMode:'Manual', so we set this once per warm instance to guarantee the saved order is
// exactly what we sent. Best-effort: a failure here never fails the actual save.
//
// PER LOGIN, NOT PER INSTANCE. It is a Route Workbench PREFERENCE, saved against the portal user
// who sets it — and whether NuVizz scopes it to the user or the company cannot be read from this
// repo. When every Save was the shared login, one latch per instance was exactly right. With
// personal logins it would be wrong in the dangerous direction: the first dispatcher's Save sets
// it for THEIR user and latches, and every other dispatcher's route on that warm instance is then
// saved with NuVizz's auto re-sequence possibly still ON for them — a stop order the dispatcher
// built, quietly rearranged by the vendor. So the latch is keyed like the session: one call per
// login per warm instance. If the preference is company-wide, the extra calls are harmless.
const prefSet = new Set<string>();
/** Test hook: clears the once-per-login preference latches. */
export function _resetRwbPref(): void { prefSet.clear(); }
export async function rwbEnsurePreference(requester: RwbRequesterLike, cfg: RwbConfig): Promise<number> {
  const key = rwbSessionKey(cfg);
  if (prefSet.has(key)) return 0;
  try {
    const r = await rwbAuthedCall(requester, cfg, 'POST', 'dirouteworkbench/routePlan/saveRwbPreference?preference=RWB_RTE_EXRTESEC&value=OFF', null);
    if (r.ok) prefSet.add(key);  // only latch on success so a transient failure retries next save
    return 1;
  } catch { return 1; }
}

/**
 * rwbAddStopsToRoute — attach EXISTING stops to a route plan the way the portal does at scale
 * (verified from a 22-stop HAR): ONE batched validateStopstoPerformAction/{id,id,…}?routeId=… (the
 * server-side steal/eligibility check for the whole set) then ONE batched addStopsToRouteAfterValidation
 * with all ids comma-joined. So adding N stops is 2 calls, not 2·N — a 20-stop route is 2 calls instead
 * of 40. If either batched call is rejected, we FALL BACK to the proven per-stop validate+add so a save
 * never fails just because the batched shape wasn't accepted.
 */
export async function rwbAddStopsToRoute(requester: RwbRequesterLike, routePlanId: string, stopIds: string[], auth?: RwbAuth | null): Promise<{ ok: boolean; message: string; calls: number; steps: any[]; mode?: string }> {
  const cfg = rwbConfig(auth);
  if (rwbEngineBlocked()) return { ok: false, message: 'RWB engine is disabled on the server', calls: 0, steps: [] };
  if (!cfg.username || !cfg.password) return { ok: false, message: credsMissingMessage(cfg), calls: 0, steps: [] };
  const ids = [...new Set(stopIds.map(String).filter(Boolean))];
  if (!ids.length) return { ok: true, message: 'no stops to add', calls: 0, steps: [] };
  const steps: any[] = [];
  // BATCH VALIDATE — all ids + routeId in one call (the portal's whole-set eligibility check).
  const vurl = `dirouteworkbench/stop/validateStopstoPerformAction/${ids.join(',')}?routeId=${encodeURIComponent(routePlanId)}`;
  const v = await rwbAuthedCall(requester, cfg, 'GET', vurl, null);
  const vok = v.ok && rwbBodyOk(v.body);
  steps.push({ op: 'validateStops(batch)', count: ids.length, ok: vok, status: v.status });
  if (vok) {
    // BATCH ADD — all ids in one call.
    const a = await rwbAuthedCall(requester, cfg, 'POST', 'dirouteworkbench/stop/addStopsToRouteAfterValidation', { routePlanId, stopIds: ids.join(','), isPlanningMode: 'true' });
    const aok = a.ok && rwbBodyOk(a.body);
    steps.push({ op: 'addStopsToRoute(batch)', count: ids.length, ok: aok, status: a.status });
    if (aok) return { ok: true, message: `Added ${ids.length} stop(s) in one batch.`, calls: 2, steps, mode: 'batch' };
    steps.push({ op: 'batch-fallback', note: `batch add rejected (status ${a.status}) — retrying per-stop` });
    const r = await rwbAddStopsPerStop(requester, cfg, routePlanId, ids, steps);
    return { ok: r.ok, message: r.ok ? `Added ${ids.length} stop(s) per-stop (batch fell back).` : r.message, calls: 2 + r.calls, steps, mode: 'batch-fallback' };
  }
  // Batched validate rejected — fall back to the proven per-stop validate+add.
  steps.push({ op: 'batch-fallback', note: `batch validate rejected (status ${v.status}) — retrying per-stop` });
  const r = await rwbAddStopsPerStop(requester, cfg, routePlanId, ids, steps);
  return { ok: r.ok, message: r.ok ? `Added ${ids.length} stop(s) per-stop (batch fell back).` : r.message, calls: 1 + r.calls, steps, mode: 'validate-fallback' };
}

const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

// GMT offset (e.g. 'GMT-04:00') for a given calendar DATE in `timeZone`, computed from the
// runtime's IANA database so it is DST-correct year-round (Eastern is -04:00 in summer,
// -05:00 in winter). Falls back to EST (-05:00) if the zone can't be resolved. Netlify
// functions run on real Node, so Intl + Date are available here.
function gmtOffsetForDate(yyyy: string, mm: string, dd: string, timeZone: string): string {
  try {
    const at = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), 12, 0, 0));
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(at).find((p) => p.type === 'timeZoneName');
    const match = part && part.value.match(/GMT([+-]\d{2}:\d{2})/);
    return match ? `GMT${match[1]}` : 'GMT-05:00';
  } catch { return 'GMT-05:00'; }
}

function routeWindow(dttm: string | undefined, timeZone = 'America/New_York'): { start: string; end: string } | null {
  // schStartTime.dttm carries the route's REAL start time ("Jul 9, 2026, 12:00:00 PM" — Jul 9
  // portal HAR), and the portal's save echoes exactly that as routeStartTime ("07/09/2026
  // 12:00:00 pm GMT-04:00"). We used to fabricate 08:00 am regardless — a wrong window on every
  // load that doesn't start at 8 (BEN 2 was a 12 PM route) and a stale one on carry-over edits.
  // Older responses carry a bare date; those keep the 08:00 fallback.
  const m = String(dttm || '').match(/^(\w{3})\s+(\d{1,2}),\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM))?/i);
  if (!m) return null;
  const mm = MONTHS[m[1]];
  if (!mm) return null;
  const dd = String(m[2]).padStart(2, '0');
  const date = `${mm}/${dd}/${m[3]}`;
  const off = gmtOffsetForDate(m[3], mm, dd, timeZone);   // DST-correct, not a hardcoded EDT literal
  const start = m[4] != null
    ? `${String(m[4]).padStart(2, '0')}:${m[5]}:${m[6]} ${String(m[7]).toLowerCase()}`
    : '08:00:00 am';
  return { start: `${date} ${start} ${off}`, end: `${date} 11:59:00 pm ${off}` };
}

/**
 * rwbSequenceStops — set a route's stop set AND order to EXACTLY `orderedStopIds` via the
 * portal's Route Workbench. 2 calls (flat, regardless of stop count): fetchUpdatedJson
 * (recompute the route in the desired order — read-only preview) then saveComparedRouteData
 * (PERSIST). The save is DECLARATIVE (verified from a live portal HAR): the route ends up
 * with exactly the stops in the payload, so a stop currently on the route but OMITTED here is
 * REMOVED — this is how RWB unplans. It never rewrites the stop record itself, so cargo data
 * cannot be lost. A stop NOT yet on the route must first be attached with rwbAddStopsToRoute
 * (the save alone won't create membership for a brand-new stop).
 *
 * Depot-pickup model: every DELIVERY stop is picked up at `origin` then delivered in the given
 * order (matches how this app's loads run — one shared depot per route). 1+ stops (the portal
 * accepts a single-stop route; 0 stops is an empty route → use load/cancel, not this).
 *
 * PICKUP orders (returns / RAs — pickupLegIds): the CUSTOMER-side visit is the _PU leg, not
 * the _DO. The old payload put every _PU leg in one block at the FRONT, which is only correct
 * when each _PU is the depot loading of a delivery — a customer pickup emitted there landed at
 * DELIVERY #1 in production no matter where the dispatcher sequenced it (the "RA placed 11th,
 * ran 1st" bug). A pickup order now contributes its _PU at the dispatcher's REQUESTED position
 * in the visit sequence, and its _DO (the return to depot) at the tail. Routes with no pickup
 * orders produce a byte-identical payload to before.
 */
export async function rwbSequenceStops(requester: RwbRequesterLike, routePlanId: string, orderedStopIds: string[], origin: { lat: number; lng: number }, pickupLegIds: string[] = [], extras: { totals?: any; isStandingRoute?: boolean; resequence?: boolean } = {}, auth?: RwbAuth | null): Promise<{ ok: boolean; message: string; calls: number; steps: any[] }> {
  const r = await rwbSequenceRoutes(requester, [{ routePlanId, orderedStopIds, origin, pickupLegIds, ...extras }], auth);
  const ids = [...new Set(orderedStopIds.map(String).filter(Boolean))];
  return { ok: r.ok, message: r.ok ? `Sequenced ${ids.length} stop(s) via RWB.` : r.message, calls: r.calls, steps: r.steps };
}

// The shared leg sequence (see rwbSequenceStops doc): delivery orders → depot _PU up front +
// customer _DO at the requested position; PICKUP orders (returns/RAs) → customer _PU at the
// requested position + return _DO at the tail.
function legsFor(ids: string[], pickupLegIds?: string[]): Array<{ id: string; leg: string }> {
  const pu = new Set((pickupLegIds || []).map(String));
  const isPickup = (id: string) => pu.has(id);
  return [
    ...ids.filter((id) => !isPickup(id)).map((id) => ({ id, leg: '_PU' })),          // depot loading (deliveries)
    ...ids.map((id) => ({ id, leg: isPickup(id) ? '_PU' : '_DO' })),                 // CUSTOMER visits, requested order
    ...ids.filter(isPickup).map((id) => ({ id, leg: '_DO' })),                       // pickups' return-to-depot legs
  ];
}

// rwbResequenceRoute — the OPTIMIZER's persist call (Jul 9 opti HAR: fetchUpdatedJson →
// opt-job/routeopt/resequenceRoute(seqMode None) → saveComparedRouteData). The Jul 9
// MANUAL-reorder HAR proves the portal does NOT fire this for a manual sequence — the save
// alone persists it (seqMode 'Manual', isStandingRoute true, real window/totals). Kept as an
// env-gated escape lever (NUVIZZ_RWB_RESEQUENCE=on) in case a field-faithful save still fails
// to move seqs; reqSource RWB_CP verbatim from the HAR.
async function rwbResequenceRoute(
  requester: RwbRequesterLike, cfg: RwbConfig,
  routePlanId: string, orderedStopIds: string[], pickupLegIds: string[] | undefined, steps: any[],
): Promise<{ ok: boolean; message?: string }> {
  const ids = [...new Set(orderedStopIds.map(String).filter(Boolean))];
  const stopIdsStr = legsFor(ids, pickupLegIds).map(({ id, leg }) => id + leg).join(',');
  const r = await rwbAuthedCall(requester, cfg, 'POST', 'opt-job/routeopt/resequenceRoute', {
    routePlanId, stopIdsStr, returnToDepot: 'NEVER', seqMode: 'Manual', reqSource: 'RWB_CP',
  });
  const ok = r.ok && rwbBodyOk(r.body);
  steps.push({ op: 'resequenceRoute', routePlanId, ok, status: r.status, error: ok ? null : (r.error || null) });
  return ok ? { ok } : { ok, message: r.error || `resequenceRoute failed (status ${r.status})` };
}

// Build ONE route's fetchUpdatedJson preview + its routeJsonData save entry. `listIdx` feeds the
// portal's per-route `list` discriminator ("list1", "list2", …) seen in the multi-route move HAR.
async function rwbPreviewRoute(
  requester: RwbRequesterLike, cfg: RwbConfig,
  route: { routePlanId: string; orderedStopIds: string[]; origin: { lat: number; lng: number }; pickupLegIds?: string[]; totals?: any; isStandingRoute?: boolean },
  listIdx: number, steps: any[],
): Promise<{ ok: boolean; entry?: any; message?: string }> {
  const ids = [...new Set(route.orderedStopIds.map(String).filter(Boolean))];
  const { routePlanId, origin } = route;
  // Leg sequence via legsFor (shared with resequenceRoute). No pickups ⇒ identical to the
  // original [all _PU..., all _DO...] shape.
  const legs = legsFor(ids, route.pickupLegIds);
  const stoplist = legs.map(({ id, leg }) => id + leg).join(',');
  const fujForm = { originLat: String(origin.lat), originLng: String(origin.lng), originOption: '02', stoplist, routePlanId, returnToDepot: 'NEVER', computeLatestEta: 'true' };
  const fr = await rwbAuthedCall(requester, cfg, 'POST', 'dirouteworkbench/routePlan/fetchUpdatedJson', fujForm);
  steps.push({ op: 'fetchUpdatedJson', routePlanId, ok: fr.ok, status: fr.status, error: fr.error || null });
  if (!fr.ok) return { ok: false, message: fr.error || `fetchUpdatedJson failed (status ${fr.status})` };
  let d: any = fr.body;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { /* keep */ } }
  const o = Array.isArray(d) ? d[0] : d;
  if (!o || !Array.isArray(o.etaStopVOList)) return { ok: false, message: 'fetchUpdatedJson returned no route preview' };
  const routeTz = (o.etaStopVOList[0] && o.etaStopVOList[0].timeZone) || 'America/New_York';
  const win = routeWindow(o.schStartTime && o.schStartTime.dttm, routeTz);
  // Preview rows by leg id — the portal populates each _DO save row from its OWN preview row
  // (byte-verified, Jul 9 manual-reorder HAR): plannedETA = stopETADTTM, etaCode = etaCode,
  // timeLapse = idleTime (NUMBER), deadHeadMins/Miles = duration/distance and OMITTED when both
  // are 0. _PU rows stay blank ("" strings). NOTE the v0.45.16 incident: echoing the FULL
  // preview row (stopNbr/stopSeq/lat/…, a shape the portal never sends) made deliverit
  // half-apply saves — populate EXACTLY these fields and nothing more.
  const rowByLeg = new Map<string, any>();
  for (const row of o.etaStopVOList) { const k = String((row && row.stopId) ?? ''); if (k && !rowByLeg.has(k)) rowByLeg.set(k, row); }
  const num = (v: any) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  return { ok: true, entry: {
    routePlanId, originLat: origin.lat, originLong: origin.lng,
    routeEndTime: win ? win.end : '', routeStartTime: win ? win.start : '',
    routeDistance: o.distance, transitTime: o.duration, totalTrips: ids.length,
    // The Jul 9 portal HARs populate totalData with the route's REAL freight sums and send
    // isStandingRoute:true on every captured save. Callers thread both when they can derive
    // them; the legacy zeros/'Loose' + false stay the byte-exact fallback.
    totalData: route.totals ?? { totalP: 0, totalC: 0, totalW: 0, totalV: 0, weightUOM: 'Lbs', volumeUOM: 'Loose' },
    IdleTime: o.idleTime || 0, buildType: '02', isStandingRoute: route.isStandingRoute === true, seqMode: 'Manual',
    // Portal omits the top-level deadhead keys when the preview reports zero (manual-reorder HAR).
    ...(num(o.deadHeadMins) || num(o.deadHeadMiles) ? { deadHeadMins: o.deadHeadMins, deadHeadMiles: o.deadHeadMiles } : {}),
    // ONE tripId per LEG — duplicates included, exactly stopDataJsonArray's stopIds with the leg
    // suffix stripped (byte-verified across all three captured portal saves; we used to send N
    // unique ids, the top remaining stray inside the order-persisting payload).
    tripDataJsonArray: legs.map(({ id }) => id), list: `list${listIdx}`,
    // Mirrors the stoplist's leg sequence exactly. _PU rows are the blank 7-key shape; _DO rows
    // carry the preview's ETA fields (see rowByLeg above) exactly as the portal writes them —
    // and NOTHING more (the v0.45.16 full-row echo is how the half-apply happened). A _DO leg
    // whose preview row is missing/unidentified falls back to the blank shape. A pickup order's
    // CUSTOMER _PU leg stays blank: no capture shows a populated _PU, and blank is the
    // long-accepted shape.
    stopDataJsonArray: legs.map(({ id, leg }) => {
      const row = leg === '_DO' ? rowByLeg.get(id + leg) : null;
      if (!row || !row.stopETADTTM) {
        return { stopId: id + leg, plannedETA: '', routePlanId, etaCode: '', timeLapse: '', tripId: id, timeZone: routeTz };
      }
      const dhMins = num(row.duration), dhMiles = num(row.distance);
      return {
        stopId: id + leg, plannedETA: String(row.stopETADTTM), routePlanId,
        etaCode: String(row.etaCode ?? ''), timeLapse: num(row.idleTime),
        ...(dhMins || dhMiles ? { deadHeadMins: dhMins, deadHeadMiles: dhMiles } : {}),
        tripId: id, timeZone: row.timeZone || routeTz,
      };
    }),
  } };
}

/**
 * rwbSequenceRoutes — set N routes' stop sets AND orders in ONE atomic saveComparedRouteData,
 * exactly how the portal moves a stop between two open routes (verified from a live move HAR:
 * routeJsonData is an ARRAY of route entries; the moved stop is simply absent from the source's
 * stopDataJsonArray and present in the destination's — NO validate/addStopsToRoute calls at all).
 * Cost: 1 fetchUpdatedJson per route + ONE save = N+1 calls. Because the save is one payload,
 * a cross-load move (and even an A↔B swap) commits atomically — no source-before-destination
 * ordering problem, no window where a stop is off both routes.
 *
 * ALL-OR-NOTHING: if ANY route's preview fails, the whole group is aborted with NO write — a
 * half-saved move pair (destination gains the stop while the source save was dropped) would
 * double-plan, so we never save a partial group. Transient preview failures just re-Save.
 */
export async function rwbSequenceRoutes(
  requester: RwbRequesterLike,
  routes: Array<{ routePlanId: string; orderedStopIds: string[]; origin: { lat: number; lng: number }; pickupLegIds?: string[]; totals?: any; isStandingRoute?: boolean; resequence?: boolean }>,
  auth?: RwbAuth | null,
): Promise<{ ok: boolean; message: string; calls: number; steps: any[]; failedRoutePlanId?: string; wroteBefore?: boolean }> {
  const cfg = rwbConfig(auth);
  if (rwbEngineBlocked()) return { ok: false, message: 'RWB engine is disabled on the server (NUVIZZ_RWB_ENABLED must be explicitly set)', calls: 0, steps: [] };
  if (!cfg.username || !cfg.password) return { ok: false, message: credsMissingMessage(cfg), calls: 0, steps: [] };
  if (!routes.length) return { ok: true, message: 'no routes to sequence', calls: 0, steps: [] };
  for (const r of routes) {
    if (![...new Set(r.orderedStopIds.map(String).filter(Boolean))].length) {
      return { ok: false, message: `RWB sequence needs at least 1 stop (route ${r.routePlanId})`, calls: 0, steps: [], failedRoutePlanId: r.routePlanId };
    }
  }
  const steps: any[] = [];

  // Set the "don't auto re-sequence" preference once per session so our exact (dispatch-map-optimized)
  // order is what persists — never NuVizz's re-optimization. Best-effort; not counted as a save step.
  const prefCalls = await rwbEnsurePreference(requester, cfg);
  void prefCalls;

  // Previews run sequentially: the first call may perform the (cached) portal login, and racing
  // two cold logins would double it. One preview per route, exactly like the portal.
  const entries: any[] = [];
  let calls = 0;
  for (const [i, route] of routes.entries()) {
    calls += 1;
    const p = await rwbPreviewRoute(requester, cfg, route, i + 1, steps);
    if (!p.ok) return { ok: false, message: p.message || 'route preview failed', calls, steps, failedRoutePlanId: route.routePlanId };
    entries.push(p.entry);
  }

  // Optional order-persist lever (route.resequence — env-gated by the caller; the portal's
  // MANUAL reorder flow does NOT use it, only the optimizer does): preview → resequenceRoute →
  // save. A failed resequence aborts the group with NO save — but resequenceRoute is itself a
  // PERSIST, so `wroteBefore` tells the caller when an earlier route's resequence already
  // landed (the "nothing was written" claim would be false then).
  let resequenced = 0;
  for (const route of routes) {
    if (route.resequence !== true) continue;
    calls += 1;
    const rs = await rwbResequenceRoute(requester, cfg, route.routePlanId, route.orderedStopIds, route.pickupLegIds, steps);
    if (!rs.ok) return { ok: false, message: rs.message || 'resequenceRoute failed', calls, steps, failedRoutePlanId: route.routePlanId, wroteBefore: resequenced > 0 };
    resequenced++;
  }

  const sr = await rwbAuthedCall(requester, cfg, 'POST', 'dirouteworkbench/routePlan/saveComparedRouteData', { routeJsonData: JSON.stringify(entries), planningMode: 'true' });
  calls += 1;
  steps.push({ op: 'saveComparedRouteData', routes: routes.length, ok: sr.ok, status: sr.status, error: sr.error || null });
  // Success requires BOTH a 2xx transport status AND a non-error body (rwbBodyOk): deliverit
  // answers 200 with { responseCode:500 } / { success:false } on an application failure, which
  // must REJECT the save — never trust the HTTP status alone.
  const bodyObj = sr.body && typeof sr.body === 'object' ? sr.body : null;
  const bodyCode = bodyObj && bodyObj.responseCode != null ? Number(bodyObj.responseCode) : null;
  const okSave = sr.ok && rwbBodyOk(sr.body);
  if (!okSave) {
    const why = sr.ok ? `application error (responseCode ${bodyCode ?? '?'}${bodyObj?.message ? `: ${bodyObj.message}` : ''})` : `status ${sr.status}`;
    return { ok: false, message: sr.error || `saveComparedRouteData failed (${why})`, calls, steps };
  }
  return { ok: true, message: `Sequenced ${routes.length} route(s) in one save.`, calls, steps };
}

/**
 * rwbCheckLogin — does NuVizz's portal accept this person's login, and will it open the Route
 * Workbench for it? Exactly the sign-in a Save performs (portalLogin: the login page, the company
 * check, the sign-in, the Route Workbench token — 4 calls, all through the metered requester), so
 * "tested OK" means "a Save would get in", not something near it.
 *
 * A login it accepts is cached as that login's session in THIS module instance. That does not
 * carry over to a Save: the check runs in auth-nuvizz-login and a Save in nuvizz-write, which are
 * separate functions, so the Save signs in again — the cache is harmless, not a saving. A login it
 * clearly REFUSES is held exactly like a refused Save's (heldRefusal), and a held login is
 * answered from the hold WITHOUT asking NuVizz again, because pressing Test three times on the
 * same wrong password is how a NuVizz account gets locked.
 *
 * Never throws: an open breaker or a network failure is `unknown`, not a wrong password.
 */
export async function rwbCheckLogin(requester: RwbRequesterLike, auth: RwbAuth): Promise<{ verdict: CheckVerdict; detail: string | null; steps: any[] }> {
  if (rwbEngineBlocked()) return { verdict: 'skipped', detail: 'the Route Workbench engine is switched off on this site (NUVIZZ_RWB_ENABLED)', steps: [] };
  const cfg = rwbConfig(auth);
  if (!cfg.username || !cfg.password) return { verdict: 'skipped', detail: 'no NuVizz username or password to test', steps: [] };
  const key = rwbSessionKey(cfg);
  const held = heldRefusal(cfg, key);
  if (held) return { verdict: 'refused', detail: held, steps: [] };
  let r: Awaited<ReturnType<typeof portalLogin>>;
  try { r = await portalLogin(requester, cfg); }
  catch (e: any) { return { verdict: 'unknown', detail: `NuVizz could not be asked: ${String(e?.message || e).slice(0, 160)}`, steps: [] }; }
  const got = !r.error && !!r.authToken && !!r.jar && !!r.ref;
  const c = classifyPortalLogin(r.steps, got);
  if (got) {
    keepSession(key, { authToken: r.authToken!, jar: r.jar!, ref: r.ref!, at: Date.now() });
    refusedLogins.delete(key);
  } else if (c.verdict === 'refused') {
    refusedLogins.set(key, { at: Date.now(), detail: c.detail || 'refused' });
  }
  return { verdict: c.verdict, detail: c.detail, steps: r.steps };
}

// ── ROUTE CREATE — THE PORTAL'S OWN "ORDER LOAD WITH FULL MANUAL SEQUENCE" (v1.98.5) ──────────
//
// Chad, 2026-09-30, after "Cannot invoke …DeliverItLoad.getCompanyCode() because deliverItLoad is
// null" on every ＋ New route since Sep 15 — the v7 routePlan/update the app used refuses an empty
// route (903) and crashes on one with stops — captured the portal creating a route and sent the HAR:
// "HERE IS A HAR FOR CREATING A ROUTE." What the portal does, read off that capture:
//   GET  dirouteworkbench/routePlan/buildEmptyRouteJson   the tenant's route profile, depot, window
//   POST dirouteworkbench/routePlan/addNewRoutePlan        multipart manualBuildJsonData=[{…}],
//                                                          isPlanningMode=true (+ the browser's _csrf)
// It creates the route EMPTY and answers with the new load: routes[0].id (the route plan id every
// other call here takes) and routes[0].rteNbr (the load NUMBER). A name already in use answers HTTP
// 200 with {"message":"{\"DuplicateRouteName\":[\"SHEATS\"]}"} (the capture's first two tries).
//
// WHAT IS MIRRORED, AND WHAT IS NOT:
//   • every field of the capture's entry, same shape, with the route name, the day and the window
//     filled in — profile, depot and window read from buildEmptyRouteJson (echo, never invent), the
//     capture's own values the fallback when that read fails;
//   • NO driver. The DAVISROUTE profile marks driver isReq:false; the staged driver is assigned
//     afterwards by the existing, verified assignDriver step. A driver object assembled here from our
//     roster would be a guess at a shape seen once;
//   • vehicle type 475 "Straight Truck" — the profile REQUIRES one, and 475 is the only one the
//     capture shows (all three creates in it used it). The list of vehicle types was not in the
//     capture, so a tractor type cannot be chosen from here; NUVIZZ_ROUTE_CREATE_VEHICLE_TYPE_ID
//     overrides the id (with its name in _NAME) the day that id is known;
//   • no _csrf. This module signs in with the portal's JWT/authToken scheme, not the browser session,
//     and none of its other dirouteworkbench POSTs send one. Whether addNewRoutePlan agrees is the
//     one thing the capture cannot show — which is why the engine ships switched OFF
//     (NUVIZZ_ROUTE_CREATE_RWB, nuvizz-write.mts) until one test create has landed.
const CREATE_HAR = {
  profileId: '625bb549938c3b055c6b66ab',
  company: { fullAddress: 'Davis Delivery, 943 Gainesville Highway, Buford, Georgia, United States, 30518', line1: '943 GAINESVILLE HIGHWAY', line2: '', city: 'BUFORD', state: 'GEORGIA', zipCode: '30518', country: 'UNITED STATES', name: 'DAVIS DELIVERY' },
  lat: 34.14838,
  lng: -83.95948,
  start: '08:00:00',
  end: '23:59:00',
  proReturnToDepot: { name: 'returnToDepot', selVal: 'NEVER', isReq: false, isLoc: false, isVis: true },
  proSeqMode: { name: 'seqMode', selVal: 'None', isReq: false, isLoc: false, isVis: true },
  vehicle475: {
    costPerMile: 0, fixedCost: 0, description: 'Straight Truck', isActive: true, costPerHour: 0,
    los: [{ capacityType: 'Weight', capacity: 15000 }, { capacityType: 'Volume', capacity: 100 }, { capacityType: 'Carton', capacity: 25 }, { capacityType: 'Pallet', capacity: 125 }],
    isDefault: false, vehicleIconName: 'STRAIGHT_TRUCK', text: 'Straight Truck', value: '475', maxRouteDistMiles: 0, mileage: 0,
  },
};
/** NuVizz caps a route name at 20 characters on the v7 side (ROUTE_FIELD_MAX); refuse up front. */
export const RWB_ROUTE_NAME_MAX = 20;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');

/** The portal's moment-style time object for "HH:MM[:SS]" — exactly the capture's shape. */
export function rwbTimeObj(hms: string): Record<string, string> {
  const [H, M] = String(hms).split(':').map((x) => Number(x));
  const h12 = H % 12 || 12;
  const k = H === 0 ? 24 : H;
  return { HH: pad2(H), H: String(H), hh: pad2(h12), h: String(h12), a: H < 12 ? 'am' : 'pm', A: H < 12 ? 'AM' : 'PM', kk: pad2(k), k: String(k), m: String(M), mm: pad2(M), s: '', ss: '' };
}
const clock12 = (hms: string) => { const t = rwbTimeObj(hms); return `${t.hh}:${t.mm}:00 ${t.a}`; };

/** The route-profile facts the create echoes, read off buildEmptyRouteJson (null → the capture's). */
function templateFacts(template: any) {
  const profiles = Array.isArray(template?.profilesData) ? template.profilesData : [];
  const profileId = String(template?.defaultProfileRef || '').trim() || CREATE_HAR.profileId;
  const prof = profiles.find((p: any) => String(p?.id) === profileId) || profiles.find((p: any) => p?.isDefault) || null;
  const info = Array.isArray(prof?.routeInfo) ? prof.routeInfo : [];
  const slot = info.find((f: any) => f?.name === 'startEndTime')?.timeSlots?.[0] || null;
  const rtd = info.find((f: any) => f?.name === 'returnToDepot') || null;
  const seq = (Array.isArray(prof?.addnlDtl) ? prof.addnlDtl : []).find((f: any) => f?.name === 'seqMode') || null;
  const ca = template?.companyAddress && typeof template.companyAddress === 'object' ? template.companyAddress : null;
  const hms = /^\d{2}:\d{2}(:\d{2})?$/;
  const lat = Number(template?.lattitude ?? template?.latitude);
  const lng = Number(template?.longitude);
  return {
    profileId,
    company: ca && ca.line1 ? { ...CREATE_HAR.company, ...ca, line2: String(ca.line2 ?? '') } : CREATE_HAR.company,
    lat: Number.isFinite(lat) && lat !== 0 ? lat : CREATE_HAR.lat,
    lng: Number.isFinite(lng) && lng !== 0 ? lng : CREATE_HAR.lng,
    start: hms.test(String(slot?.startTime || '')) ? String(slot.startTime) : CREATE_HAR.start,
    end: hms.test(String(slot?.endTime || '')) ? String(slot.endTime) : CREATE_HAR.end,
    proReturnToDepot: rtd ? { name: 'returnToDepot', selVal: String(rtd.selVal ?? 'NEVER'), isReq: !!rtd.isReq, isLoc: !!rtd.isLoc, isVis: rtd.isVis !== false } : CREATE_HAR.proReturnToDepot,
    proSeqMode: seq ? { name: 'seqMode', selVal: String(seq.selVal ?? 'None'), isReq: !!seq.isReq, isLoc: !!seq.isLoc, isVis: seq.isVis !== false } : CREATE_HAR.proSeqMode,
  };
}

/** The vehicle type the create names: the capture's 475, or the env override (id + name only). */
function createVehicle(): any {
  const id = String(process.env.NUVIZZ_ROUTE_CREATE_VEHICLE_TYPE_ID ?? '').trim();
  if (!id || id === '475') return CREATE_HAR.vehicle475;
  const name = String(process.env.NUVIZZ_ROUTE_CREATE_VEHICLE_TYPE_NAME ?? '').trim() || id;
  return { ...CREATE_HAR.vehicle475, description: name, text: name, value: id, vehicleIconName: '', los: [] };
}

/**
 * PURE (given the env override). One manualBuildJsonData entry — the capture's shape, field for
 * field, with no driver. Throws on a missing/over-long name or a malformed day, so nothing
 * malformed is ever sent.
 */
export function buildManualRouteJson(spec: { routeName: string; date: string }, template: any = null): any {
  const name = String(spec?.routeName ?? '').trim();
  if (!name) throw new Error('createRoute: the route needs a name — NuVizz names every route');
  if (name.length > RWB_ROUTE_NAME_MAX) throw new Error(`createRoute: route name "${name}" is ${name.length} chars — NuVizz caps it at ${RWB_ROUTE_NAME_MAX}`);
  const m = String(spec?.date ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`createRoute: '${spec?.date}' is not a YYYY-MM-DD service day`);
  const [, y, mo, d] = m;
  const us = `${mo}/${d}/${y}`;
  const f = templateFacts(template);
  const vehicle = createVehicle();
  const routeEnd = `${us} ${clock12(f.end)}`;
  return {
    profileId: f.profileId,
    routePlanName: name,
    plannedETAWindow: '30',
    routeStart: `${us} ${clock12(f.start)}`,
    routeEnd,
    days: '0',
    originOption: '02',
    origin: f.company.fullAddress,
    lat: f.lat,
    lng: f.lng,
    routeStartTime: rwbTimeObj(f.start),
    routeEndTime: rwbTimeObj(f.end),
    vehicleType: vehicle,
    tz: 'America/New_York',
    returnToDepot: 'ALWAYS',
    seqMode: 'None',
    stagingLocation: '',
    stagingLocationText: '',
    recurrenceDay: '0111110',
    selectedProfile: {},
    isStartEndTimeLocked: false,
    isVehicleLocked: false,
    isRteOriginLocked: false,
    isOriginAddrLocked: false,
    proReturnToDepot: f.proReturnToDepot,
    proSeqMode: f.proSeqMode,
    cutOffTime: routeEnd,
    line1: f.company.line1,
    city: f.company.city,
    state: f.company.state,
    line2: f.company.line2 ?? '',
    zipCode: f.company.zipCode,
    country: f.company.country,
    orgAddrName: f.company.name,
    globalDate: `${MON[Number(mo) - 1]} ${Number(d)}, ${y}`,
    routeDate: us,
    vehicleTypeId: String(vehicle.value),
  };
}

export type RwbCreatedRoute = { id: string; loadNbr: string; name: string | null; status: string | null };

/**
 * PURE. Read addNewRoutePlan's answer. Success names the route (id + rteNbr); a duplicate name is a
 * refusal carried in a 200 (inside a JSON STRING); anything else — including a 200 with no route in
 * it — is a failure, never a guess that it landed.
 */
export function parseAddNewRoutePlan(status: number, body: any):
  { ok: true; route: RwbCreatedRoute } | { ok: false; duplicate?: string[]; error: string } {
  const text = (v: any) => String(typeof v === 'string' ? v : JSON.stringify(v ?? '')).slice(0, 200);
  if (!(status >= 200 && status < 300)) return { ok: false, error: `NuVizz answered HTTP ${status} to the route create${body ? `: ${text(body)}` : ''}` };
  if (!body || typeof body !== 'object') return { ok: false, error: `NuVizz answered the route create with something that is not JSON: ${text(body)}` };
  if (body.responseCode != null && Number(body.responseCode) !== 200) return { ok: false, error: `NuVizz refused the route create (responseCode ${body.responseCode}): ${text(body.message)}` };
  let msg: any = body.message;
  if (typeof msg === 'string') { try { const j = JSON.parse(msg); if (j && typeof j === 'object') msg = j; } catch { /* a plain sentence */ } }
  if (msg && typeof msg === 'object' && Array.isArray(msg.DuplicateRouteName) && msg.DuplicateRouteName.length) {
    const names = msg.DuplicateRouteName.map(String);
    return { ok: false, duplicate: names, error: `NuVizz already has a route named ${names.join(', ')} — open it from the Routes panel instead of creating it again, or pick another name` };
  }
  const r = Array.isArray(body.routes) ? body.routes[0] : null;
  const id = r?.id != null ? String(r.id).trim() : '';
  const nbr = r?.rteNbr != null ? String(r.rteNbr).trim() : '';
  if (!id || !nbr) return { ok: false, error: `NuVizz answered the route create without naming a route (${text(body.message) || 'no message'}) — check the portal before trying again` };
  return { ok: true, route: { id, loadNbr: nbr, name: r?.name != null ? String(r.name) : null, status: r?.status != null ? String(r.status) : null } };
}

/**
 * rwbCreateRoute — make an EMPTY route the way the portal does: read the profile template, then
 * addNewRoutePlan. 2 calls after sign-in. The create is never transport-retried (go() sends
 * maxRetries:0); a 401 re-signs in and re-sends once, which is safe because an unauthenticated
 * request was never processed.
 */
export async function rwbCreateRoute(requester: RwbRequesterLike, spec: { routeName: string; date: string }, auth?: RwbAuth | null):
  Promise<{ ok: boolean; route?: RwbCreatedRoute; duplicate?: string[]; error?: string; calls: number; steps: any[]; sent?: any }> {
  const cfg = rwbConfig(auth);
  if (rwbEngineBlocked()) return { ok: false, error: 'the Route Workbench engine is switched off on this site (NUVIZZ_RWB_ENABLED)', calls: 0, steps: [] };
  if (!cfg.username || !cfg.password) return { ok: false, error: credsMissingMessage(cfg), calls: 0, steps: [] };
  let entry: any;
  try { entry = buildManualRouteJson(spec, null); }   // validate BEFORE any call
  catch (e: any) { return { ok: false, error: String(e?.message || e), calls: 0, steps: [] }; }
  const steps: any[] = [];
  const t = await rwbAuthedCall(requester, cfg, 'GET', 'dirouteworkbench/routePlan/buildEmptyRouteJson', null);
  const template = t.ok && t.body && typeof t.body === 'object' ? t.body : null;
  steps.push({ op: 'buildEmptyRouteJson', ok: !!template, status: t.status, ...(t.error ? { error: t.error } : {}) });
  if (t.error && /login failed/i.test(t.error)) return { ok: false, error: t.error, calls: 1, steps };
  entry = buildManualRouteJson(spec, template);
  const c = await rwbAuthedCall(requester, cfg, 'POST', 'dirouteworkbench/routePlan/addNewRoutePlan', { manualBuildJsonData: JSON.stringify([entry]), isPlanningMode: 'true' });
  const parsed = c.error ? { ok: false as const, error: c.error } : parseAddNewRoutePlan(c.status, c.body);
  steps.push({ op: 'addNewRoutePlan', ok: parsed.ok, status: c.status, ...(parsed.ok ? { routeId: parsed.route.id, loadNbr: parsed.route.loadNbr } : { error: parsed.error }) });
  if (!parsed.ok) return { ok: false, error: parsed.error, ...('duplicate' in parsed && parsed.duplicate ? { duplicate: parsed.duplicate } : {}), calls: 2, steps, sent: entry };
  return { ok: true, route: parsed.route, calls: 2, steps, sent: entry };
}

// ── PRODUCTION SWITCH CHECKLIST (mirrors the v7 DAVIS switch elsewhere in this repo) ──
// This deploy's RWB target defaults to UAT (DAVISV5) regardless of which NuVizz tenant
// the rest of this file's v7 writes point at. To point RWB at PRODUCTION on a specific
// deploy, ALL of the following must be set explicitly — there is no single flag:
//   NUVIZZ_RWB_ENABLED=true
//   NUVIZZ_RWB_LOGIN_BASE=https://login.nuvizz.com
//   NUVIZZ_RWB_PORTAL_BASE=https://<production portal host, no "uat." prefix>
//   NUVIZZ_RWB_COMPANY_CODE=davis
//   NUVIZZ_RWB_COMPANY=DAVIS
//   NUVIZZ_RWB_USER / NUVIZZ_RWB_PASS = production portal credentials
// Do this ONLY after a UAT verification pass (byte-diff a test load's stops before/
// after a Save, same method as the Jul 2026 UAT proof) — same sign-off bar as
// NUVIZZ_LOAD_IMPORT.
