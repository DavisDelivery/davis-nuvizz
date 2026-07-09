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
 * unset) — the empty-creds refusal happens before the first network call, not after. */
export function rwbConfigReady(): boolean {
  if (rwbEngineBlocked()) return false;
  const c = rwbConfig();
  return !!c.username && !!c.password;
}

interface RwbConfig {
  loginBase: string;
  portalBase: string;
  companyCode: string;
  company: string;
  username: string;
  password: string;
}

function rwbConfig(): RwbConfig {
  return {
    loginBase: process.env.NUVIZZ_RWB_LOGIN_BASE || 'https://loginqa.nuvizz.com',
    portalBase: process.env.NUVIZZ_RWB_PORTAL_BASE || 'https://uat.nuvizz.com',
    companyCode: process.env.NUVIZZ_RWB_COMPANY_CODE || 'davisv5',
    company: (process.env.NUVIZZ_RWB_COMPANY || 'DAVISV5').toUpperCase(),
    username: process.env.NUVIZZ_RWB_USER || '',
    password: process.env.NUVIZZ_RWB_PASS || '',
  };
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
let cachedSession: { authToken: string; jar: ReturnType<typeof makeJar>; ref: string; at: number } | null = null;
const SESSION_TTL_MS = 12 * 60 * 1000;

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
  steps.push({ step: 'userLogin', status: ul.status, jwt: !!jwt, msg: ul.data && ul.data.message });
  if (!jwt) return { error: 'login failed (no JWT) — check NUVIZZ_RWB_USER/PASS', steps };

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

async function session(requester: RwbRequesterLike, cfg: RwbConfig): Promise<{ authToken: string; jar: ReturnType<typeof makeJar>; ref: string } | { error: string }> {
  if (cachedSession && Date.now() - cachedSession.at < SESSION_TTL_MS) return cachedSession;
  const r = await portalLogin(requester, cfg);
  if (r.error || !r.authToken || !r.jar || !r.ref) return { error: r.error || 'login failed' };
  cachedSession = { authToken: r.authToken, jar: r.jar, ref: r.ref, at: Date.now() };
  return cachedSession;
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
    cachedSession = null; // token expired mid-instance-life — one retry with a fresh login
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
    const v = await rwbAuthedCall(requester, cfg, 'GET', `dirouteworkbench/stop/validateStopstoPerformAction/${id}`, null);
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
let rwbPrefSet = false;
/** Test hook: clears the once-per-instance preference flag. */
export function _resetRwbPref(): void { rwbPrefSet = false; }
export async function rwbEnsurePreference(requester: RwbRequesterLike, cfg: RwbConfig): Promise<number> {
  if (rwbPrefSet) return 0;
  try {
    const r = await rwbAuthedCall(requester, cfg, 'POST', 'dirouteworkbench/routePlan/saveRwbPreference?preference=RWB_RTE_EXRTESEC&value=OFF', null);
    if (r.ok) rwbPrefSet = true;  // only latch on success so a transient failure retries next save
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
export async function rwbAddStopsToRoute(requester: RwbRequesterLike, routePlanId: string, stopIds: string[]): Promise<{ ok: boolean; message: string; calls: number; steps: any[]; mode?: string }> {
  const cfg = rwbConfig();
  if (rwbEngineBlocked()) return { ok: false, message: 'RWB engine is disabled on the server', calls: 0, steps: [] };
  if (!cfg.username || !cfg.password) return { ok: false, message: 'RWB creds not configured (NUVIZZ_RWB_USER/PASS)', calls: 0, steps: [] };
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
  const m = String(dttm || '').match(/^(\w{3})\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const mm = MONTHS[m[1]];
  if (!mm) return null;
  const dd = String(m[2]).padStart(2, '0');
  const date = `${mm}/${dd}/${m[3]}`;
  const off = gmtOffsetForDate(m[3], mm, dd, timeZone);   // DST-correct, not a hardcoded EDT literal
  return { start: `${date} 08:00:00 am ${off}`, end: `${date} 11:59:00 pm ${off}` };
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
export async function rwbSequenceStops(requester: RwbRequesterLike, routePlanId: string, orderedStopIds: string[], origin: { lat: number; lng: number }, pickupLegIds: string[] = []): Promise<{ ok: boolean; message: string; calls: number; steps: any[] }> {
  const r = await rwbSequenceRoutes(requester, [{ routePlanId, orderedStopIds, origin, pickupLegIds }]);
  const ids = [...new Set(orderedStopIds.map(String).filter(Boolean))];
  return { ok: r.ok, message: r.ok ? `Sequenced ${ids.length} stop(s) via RWB.` : r.message, calls: r.calls, steps: r.steps };
}

// Build ONE route's fetchUpdatedJson preview + its routeJsonData save entry. `listIdx` feeds the
// portal's per-route `list` discriminator ("list1", "list2", …) seen in the multi-route move HAR.
async function rwbPreviewRoute(
  requester: RwbRequesterLike, cfg: RwbConfig,
  route: { routePlanId: string; orderedStopIds: string[]; origin: { lat: number; lng: number }; pickupLegIds?: string[] },
  listIdx: number, steps: any[],
): Promise<{ ok: boolean; entry?: any; message?: string }> {
  const ids = [...new Set(route.orderedStopIds.map(String).filter(Boolean))];
  const { routePlanId, origin } = route;
  // Leg sequence (see rwbSequenceStops doc): delivery orders → depot _PU up front + customer
  // _DO at the requested position; PICKUP orders (returns/RAs) → customer _PU at the requested
  // position + return _DO at the tail. No pickups ⇒ identical to the original
  // [all _PU..., all _DO...] shape.
  const pu = new Set((route.pickupLegIds || []).map(String));
  const isPickup = (id: string) => pu.has(id);
  const legs = [
    ...ids.filter((id) => !isPickup(id)).map((id) => ({ id, leg: '_PU' })),          // depot loading (deliveries)
    ...ids.map((id) => ({ id, leg: isPickup(id) ? '_PU' : '_DO' })),                 // CUSTOMER visits, requested order
    ...ids.filter(isPickup).map((id) => ({ id, leg: '_DO' })),                       // pickups' return-to-depot legs
  ];
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
  return { ok: true, entry: {
    routePlanId, originLat: origin.lat, originLong: origin.lng,
    routeEndTime: win ? win.end : '', routeStartTime: win ? win.start : '',
    routeDistance: o.distance, transitTime: o.duration, totalTrips: ids.length,
    totalData: { totalP: 0, totalC: 0, totalW: 0, totalV: 0, weightUOM: 'Lbs', volumeUOM: 'Loose' },
    IdleTime: o.idleTime || 0, buildType: '02', isStandingRoute: false, seqMode: 'Manual',
    deadHeadMins: o.deadHeadMins, deadHeadMiles: o.deadHeadMiles,
    tripDataJsonArray: ids, list: `list${listIdx}`,
    // Mirrors the stoplist's leg sequence exactly (delivery-only routes: unchanged shape).
    stopDataJsonArray: legs.map(({ id, leg }) => ({
      stopId: id + leg, plannedETA: '', routePlanId, etaCode: '', timeLapse: '',
      tripId: id, timeZone: routeTz,
    })),
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
  routes: Array<{ routePlanId: string; orderedStopIds: string[]; origin: { lat: number; lng: number }; pickupLegIds?: string[] }>,
): Promise<{ ok: boolean; message: string; calls: number; steps: any[]; failedRoutePlanId?: string }> {
  const cfg = rwbConfig();
  if (rwbEngineBlocked()) return { ok: false, message: 'RWB engine is disabled on the server (NUVIZZ_RWB_ENABLED must be explicitly set)', calls: 0, steps: [] };
  if (!cfg.username || !cfg.password) return { ok: false, message: 'RWB creds not configured (NUVIZZ_RWB_USER/PASS)', calls: 0, steps: [] };
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
