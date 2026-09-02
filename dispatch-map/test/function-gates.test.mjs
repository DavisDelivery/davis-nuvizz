// test/function-gates.test.mjs — WHICH DOORS ARE SHUT, WHICH ARE DELIBERATELY OPEN, AND WHY.
//
// Two kinds of test, both needed.
//
// The SOURCE guards keep the map honest: every endpoint in the gated set actually calls the
// gate, every *-background function without a cron carries the observable-refusal pattern
// (a plain 401 in one of those is invisible — see test/background-gate.test.mjs), and the
// three endpoints left open carry a written reason, so the next person to read them finds a
// decision rather than an omission.
//
// The BEHAVIOURAL tests pin the pairs that are easy to get backwards and expensive to get
// wrong — the half of an endpoint that must stay open beside the half that must shut. A gate
// on ai-search's GET blanks the AI button instead of disabling it; a gate on
// nuvizz-board-reconcile's GET takes away the dry run that exists so nobody fires the
// expensive one blind; a gate on manifest-history?pdf=1 breaks the "open in browser" hatch
// and the iOS share sheet, neither of which can carry a header.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SA = JSON.stringify({
  project_id: 'testproj',
  client_email: 'sa@testproj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});
process.env.NUVIZZ_BASE_URL = '';
delete process.env.FIRESTORE_DATABASE;
process.env.AUTH_SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';
delete process.env.AUTH_REQUIRED;

import { installFirestoreFake } from './_firestore-fake.mjs';
import { issueSessionToken } from '../netlify/functions/lib/auth-core.mts';
import { _resetUserCacheForTests, _resetThrottleForTests } from '../netlify/functions/lib/require-user.mts';

const FN_DIR = new URL('../netlify/functions/', import.meta.url);
const src = (name) => readFileSync(new URL(`${name}.mts`, FN_DIR), 'utf8');
const hasGate = (name) => /requireUser\s*\(|requireUserForBackground\s*\(|gateScheduledOverride\s*\(/.test(src(name));

// ── SOURCE GUARD 1: the gated set stays gated ────────────────────────────────

const VIEWER_SET = [
  'comms-optouts', 'customer-comms-log', 'day-completion', 'driver-phone', 'eta-backtest',
  'eta-flag-check', 'eta-flag-history', 'flag-evening-status', 'flag-replay',
  'history-capture-health', 'manifest-history', 'manifest-ocr-result', 'manifest-push-log',
  'messaging-roster', 'motive-driver-positions', 'motive-drivers', 'nuvizz-customer-history',
  'nuvizz-driver-route', 'nuvizz-loads-roster', 'nuvizz-pull-today-stops',
  'nuvizz-undelivered-report', 'nuvizz-write-log', 'route-departures', 'routing-engine-data',
  'travel-model', 'customer-comms-config', 'gmail-auth',
];
const DISPATCHER_SET = [
  'ai-search', 'anthropic-routing', 'debug-capture', 'manifest-email-check', 'manifest-upload',
  'nuvizz-board-reconcile', 'nuvizz-pro-lookup', 'nuvizz-stop-events', 'nuvizz-stop-explorer',
];
const ADMIN_SET = ['routing-engine-tuning'];

test('every endpoint in the gated set calls the gate — an ungated one here is a door somebody thinks is shut', () => {
  for (const [role, set] of [['viewer', VIEWER_SET], ['dispatcher', DISPATCHER_SET], ['admin', ADMIN_SET]]) {
    for (const name of set) {
      assert.ok(hasGate(name), `${name} must call requireUser`);
      assert.ok(new RegExp(`role: '${role}'`).test(src(name)), `${name} must gate at ${role}`);
    }
  }
});

// ── SOURCE GUARD 1b: the SPLIT gates keep both halves ───────────────────────

test('the split endpoints gate their acting branch above their read — collapsing one back is a regression', () => {
  // Each of these carries a branch that does something the role its READ deserves must never be
  // able to do. The behaviour is pinned in test/split-role-gates.test.mjs; this is the cheap
  // guard that catches somebody "tidying" the ternary back into one call next month.
  const SPLIT = [
    ['route-departures', 'viewer', 'dispatcher', /refit/],          // ?refit=1 republishes every ETA's basis
    ['manifest-push-log', 'viewer', 'dispatcher', /POST/],          // the POST appends to the push audit trail
    ['nuvizz-pull-today-stops', 'viewer', 'admin', /live/],         // ?live=1 is a ~3,000-call cold probe
  ];
  for (const [name, readRole, actRole, branch] of SPLIT) {
    const body = src(name);
    assert.ok(new RegExp(`role: '${readRole}'`).test(body), `${name} must still serve its read at ${readRole}`);
    assert.ok(new RegExp(`role: '${actRole}'`).test(body), `${name} must gate its acting branch at ${actRole}`);
    assert.match(body, branch, `${name} must still name the branch the split turns on`);
  }
});

// ── SOURCE GUARD 2: background functions get the OBSERVABLE gate ─────────────

test('a *-background function without a cron must use the observable gate, never a bare requireUser', () => {
  // A bare `return gate.response` here is thrown away by the platform: the caller reads 202,
  // the job silently does not run, and nothing anywhere says so. That is the failure this
  // whole pattern exists to prevent, and a new background function added next month must not
  // be able to reintroduce it quietly.
  const files = readdirSync(FN_DIR).filter((f) => f.endsWith('-background.mts'));
  assert.ok(files.length >= 18, `expected the background family to still be here, found ${files.length}`);
  for (const f of files) {
    const name = f.replace(/\.mts$/, '');
    const body = src(name);
    if (!hasGate(name)) continue;                     // ungated background jobs are out of scope here
    assert.ok(
      /requireUserForBackground|gateScheduledOverride/.test(body),
      `${name} gates with a bare requireUser — the 401 is invisible behind Netlify's 202; use lib/background-gate.mts`,
    );
  }
});

test('the eleven plain background jobs (no cron) are all gated — none was missed', () => {
  const PLAIN = [
    'nuvizz-manual-scan-background', 'routing-build-background', 'manifest-ocr-background',
    'history-manifest-heal-background', 'nuvizz-rebuild-customer-history-background',
    'routing-engine-experiment-background', 'routing-engine-replay-background',
    'routing-engine-plan-replay-background', 'routing-observations-backfill-background',
    'routing-reference-backfill-background', 'tractor-flags-rebuild-background',
  ];
  for (const name of PLAIN) {
    const body = src(name);
    assert.ok(/requireUserForBackground/.test(body), `${name} is a public POST endpoint and must be gated`);
    assert.ok(!/config\s*=\s*\{[^}]*schedule/s.test(body), `${name} must stay schedule-free (a schedule makes it un-invocable over HTTP)`);
  }
});

// ── SOURCE GUARD 3: the open doors carry a written reason ───────────────────

test('the three headerless endpoints stay OPEN and say why — an undocumented open door reads as an oversight', () => {
  // Each is reached by something that cannot set an Authorization header: an <img src>, or a
  // Content-Disposition download opened from the address bar. Gating them would not tighten a
  // door, it would take away a POD photo mid-dispute or a report Chad runs by pasting a URL.
  for (const name of ['nuvizz-pod', 'freight-class-report', 'time-restricted-pros']) {
    const body = src(name);
    assert.ok(!hasGate(name), `${name} must stay ungated until its consumer can carry a header`);
    assert.match(body, /DELIBERATELY NOT GATED/, `${name} must record the decision`);
    assert.match(body, /WHAT WOULD HAVE TO CHANGE FIRST/, `${name} must say what would close it`);
  }
});

test('nuvizz-attempts: the cross-origin GET stays open, the preflight ADMITS a bearer token, and the open decision has an OWNER AND A DEADLINE', () => {
  // The non-GET gate has shipped for a while, but the preflight only allowed Content-Type —
  // so a cross-origin DELETE carrying a token was refused by the browser before it left, and
  // the gate it was meant to satisfy was unreachable.
  //
  // THAT FIX IS NECESSARY AND NOT SUFFICIENT, which is the part worth pinning. The scorecard's
  // delete (docs/scorecard-attempts/AttemptsCard.jsx:92) sends no credential at all, so it still
  // 401s the day AUTH_REQUIRED flips — on a site nobody in this repo is watching. An open
  // question with no owner and no date is how that flip happens with this unresolved.
  const body = src('nuvizz-attempts');
  assert.match(body, /'Access-Control-Allow-Headers': 'Content-Type, Authorization'/);
  assert.match(body, /davis-driver-scorecard/, 'the outside consumer must be named where somebody will see it');
  assert.match(body, /OWNER: CHAD/, 'a decision with no owner is a decision nobody makes');
  assert.match(body, /DUE BEFORE AUTH_REQUIRED=true IS SET/, 'and one with no deadline gets made by the switch instead');
  assert.match(body, /AttemptsCard\.jsx:92/, 'name the exact line that breaks, so nobody has to go looking');
});

// ── BEHAVIOUR: the halves that must stay open ───────────────────────────────

const VIEWER_USER = { username: 'ro', displayName: 'Ro', role: 'viewer', active: true, tokenVersion: 0 };
const bearer = (u) => ({ authorization: `Bearer ${issueSessionToken(u).token}` });

async function enforcing(seed, fn) {
  process.env.AUTH_REQUIRED = 'true';
  _resetUserCacheForTests();
  _resetThrottleForTests();
  const fake = installFirestoreFake(seed, () => new Response('{}', { status: 200 }));
  try { return await fn(fake); } finally { fake.restore(); delete process.env.AUTH_REQUIRED; }
}

const req = (path, init = {}) => new Request(`https://x.netlify.app/.netlify/functions/${path}`, init);

test('ai-search: the GET availability probe stays open, the POST does not', async () => {
  // The GET returns one boolean so the client can HIDE the AI affordance. Gating it turns a
  // gracefully-absent button into a broken one.
  const { default: aiSearch } = await import('../netlify/functions/ai-search.mts');
  await enforcing({}, async () => {
    const probe = await aiSearch(req('ai-search'));
    assert.equal(probe.status, 200);
    assert.equal(typeof (await probe.json()).available, 'boolean');
    const post = await aiSearch(req('ai-search', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x', mode: 'parse' }),
    }));
    assert.equal(post.status, 401);
  });
});

test('routing-engine-tuning: the editor still RENDERS for anyone allowed to look; only the save is admin', async () => {
  const { default: tuning } = await import('../netlify/functions/routing-engine-tuning.mts');
  await enforcing({ 'app_users/ro': VIEWER_USER }, async () => {
    const get = await tuning(req('routing-engine-tuning'));
    assert.equal(get.status, 200, 'a screen that cannot show the current values cannot show what would change');
    const save = await tuning(req('routing-engine-tuning', {
      method: 'POST', headers: { 'content-type': 'application/json', ...bearer(VIEWER_USER) }, body: JSON.stringify({ w_candidate_rank: 2 }),
    }));
    assert.equal(save.status, 403, 'a viewer must not be able to change what tonight\'s run does');
  });
});

test('nuvizz-board-reconcile: the zero-cost preview stays open, the ~60-call run does not', async () => {
  // A dry run somebody cannot reach is a dry run that does not exist — and this is the one
  // thing standing between a dispatcher and firing 60 metered /load/info calls blind.
  const { default: reconcile } = await import('../netlify/functions/nuvizz-board-reconcile.mts');
  await enforcing({}, async () => {
    const preview = await reconcile(req('nuvizz-board-reconcile?date=2026-09-01'));
    assert.notEqual(preview.status, 401);
    assert.notEqual(preview.status, 403);
    const run = await reconcile(req('nuvizz-board-reconcile?date=2026-09-01&run=1', { method: 'POST' }));
    assert.equal(run.status, 401);
  });
});

test('manifest-history: the JSON is gated, ?pdf=1 is NOT — the share sheet and "open in browser" send no header', async () => {
  const { default: history } = await import('../netlify/functions/manifest-history.mts');
  await enforcing({}, async () => {
    const json = await history(req('manifest-history?date=2026-09-01'));
    assert.equal(json.status, 401);
    const pdf = await history(req('manifest-history?date=2026-09-01&pdf=1'));
    assert.notEqual(pdf.status, 401, 'App.jsx hands this exact URL to <a href> and navigator.share');
    assert.notEqual(pdf.status, 403);
  });
});

test('gmail-auth: status is gated (it names the connected mailbox); start stays a plain navigation', async () => {
  const { default: gmailAuth } = await import('../netlify/functions/gmail-auth.mts');
  await enforcing({}, async () => {
    const status = await gmailAuth(req('gmail-auth?action=status'));
    assert.equal(status.status, 401);
    const start = await gmailAuth(req('gmail-auth?action=start'));
    assert.notEqual(start.status, 401, 'start is window.location.href — it cannot carry a bearer token');
  });
});

test('customer-comms-config: a refused GET never reaches Resend — that was the rate-limit vector', async () => {
  // readDomainStatus calls Resend on EVERY hit. An anonymous GET in a loop is a rate limit
  // burned on the account that sends ~700 delivery confirmations a day.
  const { default: commsConfig } = await import('../netlify/functions/customer-comms-config.mts');
  process.env.RESEND_API_KEY = 'test-key';
  await enforcing({}, async (fake) => {
    const r = await commsConfig(req('customer-comms-config'));
    assert.equal(r.status, 401);
    assert.equal(fake.log.other.length, 0, 'nothing left for Resend');
  });
  delete process.env.RESEND_API_KEY;
});

test('the board itself: a signed-out poll is refused, a viewer\'s is served', async () => {
  const { default: pullStops } = await import('../netlify/functions/nuvizz-pull-today-stops.mts');
  await enforcing({ 'app_users/ro': VIEWER_USER }, async () => {
    const out = await pullStops(req('nuvizz-pull-today-stops?date=2026-09-01'));
    assert.equal(out.status, 401);
    const inn = await pullStops(req('nuvizz-pull-today-stops?date=2026-09-01', { headers: bearer(VIEWER_USER) }));
    assert.equal(inn.status, 200);
    assert.equal((await inn.json()).ok, true);
  });
});

// ── BEHAVIOUR: the small fixes ──────────────────────────────────────────────

test('travel-model and day-completion no longer offer a SHARED cache a body that varies by caller', async () => {
  // 'public, max-age=60' on a response that is now a 401 for one caller and a board for
  // another is an invitation for a CDN to serve one to the other.
  const { default: travelModel } = await import('../netlify/functions/travel-model.mts');
  const { default: dayCompletion } = await import('../netlify/functions/day-completion.mts');
  // Inert mode on purpose: these are the headers on the endpoint's OWN answer, which is the
  // response a cache would actually store. (A refusal comes from denied(), which is already
  // no-store.)
  delete process.env.AUTH_REQUIRED;
  const fake = installFirestoreFake({});
  try {
    for (const [name, h] of [['travel-model', travelModel], ['day-completion', dayCompletion]]) {
      const r = await h(req(name));
      const cc = r.headers.get('cache-control') || '';
      assert.ok(!/public/.test(cc), `${name} still sends a public cache directive: ${cc}`);
      assert.match(cc, /private|no-store/, name);
      assert.equal(r.headers.get('vary'), 'Authorization', `${name} must vary on the header that changes the body`);
    }
  } finally { fake.restore(); }
});

test('auth-bootstrap: guessing the bootstrap secret is throttled — the prize is the first admin account', async () => {
  const { default: bootstrap } = await import('../netlify/functions/auth-bootstrap.mts');
  process.env.AUTH_BOOTSTRAP_SECRET = 'a-long-enough-bootstrap-secret';
  const fake = installFirestoreFake({});
  _resetThrottleForTests();
  try {
    const guess = () => bootstrap(new Request('https://x.netlify.app/.netlify/functions/auth-bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': '5.5.5.5' },
      body: JSON.stringify({ secret: 'wrong', username: 'owner', password: 'password-1234' }),
    }));
    for (let i = 0; i < 5; i++) assert.equal((await guess()).status, 403, `guess ${i + 1} is refused, not rate-limited`);
    assert.equal((await guess()).status, 429, 'the sixth from the same caller is cut off');
  } finally {
    fake.restore();
    delete process.env.AUTH_BOOTSTRAP_SECRET;
  }
});
