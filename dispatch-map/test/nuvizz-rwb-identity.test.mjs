// test/nuvizz-rwb-identity.test.mjs — the Route Workbench under PERSONAL NuVizz logins.
//
// What each of these would look like if it broke on a real night:
//   • one warm instance, two dispatchers: the second one's route saved under the FIRST one's
//     portal session — succeeds, and says the wrong name in NuVizz's history, forever;
//   • the no-auto-resequence preference set for the first dispatcher only: the second one's
//     stop order quietly rearranged by NuVizz after they built it;
//   • a stale saved password tried on every Save: the dispatcher locked out of NuVizz itself;
//   • an incomplete personal login quietly becoming the shared one: attribution lost, silently.
// And the shared login must behave exactly as it did before personal logins existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  rwbConfigReady, rwbSequenceStops, rwbAddStopsToRoute, rwbCheckLogin,
  takeRwbLoginRefusal, _resetRwbSessions, rwbSessionKey, REFUSAL_HOLD_MS, holdRwbLogin, rwbLoginHeld,
} from '../netlify/functions/lib/nuvizz-rwb.mts';

const ENV_KEYS = ['NUVIZZ_RWB_ENABLED', 'NUVIZZ_RWB_USER', 'NUVIZZ_RWB_PASS', 'NUVIZZ_RWB_LOGIN_BASE', 'NUVIZZ_RWB_PORTAL_BASE'];
async function withRwb(over, fn) {
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    NUVIZZ_RWB_ENABLED: 'true', NUVIZZ_RWB_USER: 'Chad', NUVIZZ_RWB_PASS: 'shared-pw',
    NUVIZZ_RWB_LOGIN_BASE: 'https://loginqa.nuvizz.com', NUVIZZ_RWB_PORTAL_BASE: 'https://uat.nuvizz.com',
    ...over,
  });
  _resetRwbSessions();
  try { return await fn(); }
  finally { for (const k of ENV_KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } _resetRwbSessions(); }
}

// A portal that knows WHO signed in: each login gets a JWT and an auth token named after the
// user, so every later call can be traced back to the session that carried it.
// `passwords` = the passwords NuVizz accepts; anything else is refused the way a real sign-in
// is refused — an answer with no token. `signInStatus` simulates an outage.
function makePortal({ passwords = { Chad: 'shared-pw', jdoe: 'jane-pw', msmith: 'mike-pw' }, signInStatus = 200, tokenStatus = 200 } = {}) {
  const calls = [];
  const requester = {
    async request(url, opts, meta) {
      const method = (opts.method || 'GET').toUpperCase();
      const auth = (opts.headers && (opts.headers.authorization || opts.headers.Authorization)) || '';
      const bodyUser = opts.body && typeof opts.body.get === 'function' ? opts.body.get('username') : null;
      const bodyPass = opts.body && typeof opts.body.get === 'function' ? opts.body.get('password') : null;
      calls.push({ url, method, route: meta?.route, auth, bodyUser });
      const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
      const T = (txt, status = 200) => new Response(txt, { status });
      if (url.includes('/loginreg/') && method === 'GET') return T('<meta name="_csrf" content="tok"><meta name="_csrf_header" content="X-CSRF-TOKEN">');
      if (url.includes('checkCompanyLogin')) return J({ ok: true });
      if (url.includes('auth/userLogin')) {
        if (signInStatus !== 200) return J({ message: 'Service Unavailable' }, signInStatus);
        if (passwords[bodyUser] && passwords[bodyUser] === bodyPass) return J({ data: { jwtToken: `jwt-${bodyUser}` } });
        return J({ success: false, message: 'Invalid username or password' });
      }
      if (url.includes('/authtoken/')) {
        const jwt = JSON.parse(String(opts.body || '{}')).password || '';
        if (tokenStatus !== 200) return J({ message: 'Forbidden' }, tokenStatus);
        return J({ authToken: `tok-${String(jwt).replace(/^jwt-/, '')}` });
      }
      if (url.includes('saveRwbPreference')) return T('Success');
      if (url.includes('validateStopstoPerformAction')) return T('Success');
      if (url.includes('addStopsToRouteAfterValidation')) return J({ responseCode: 200, message: 'SUCCESS' });
      if (url.includes('fetchUpdatedJson')) return J([{ etaStopVOList: [{ timeZone: 'America/New_York' }], distance: 10, duration: 20, schStartTime: { dttm: 'Jul 2, 2026' } }]);
      if (url.includes('saveComparedRouteData')) return J({ responseCode: 200 });
      return J({});
    },
  };
  return { calls, requester };
}

const tokenOf = (user) => 'Basic ' + Buffer.from(`JWT:tok-${user}`).toString('base64');
const JANE = { username: 'jdoe', password: 'jane-pw' };
const MIKE = { username: 'msmith', password: 'mike-pw' };
const ORIGIN = { lat: 34.04, lng: -83.71 };
const signIns = (calls) => calls.filter((c) => c.url.includes('auth/userLogin'));
const portalCalls = (calls) => calls.filter((c) => /dirouteworkbench|opt-job/.test(c.url));

test('two dispatchers on one warm instance: each Save rides its OWN portal session', async () => {
  await withRwb({}, async () => {
    const p = makePortal();
    const a = await rwbSequenceStops(p.requester, 'r1', ['s1', 's2'], ORIGIN, [], {}, JANE);
    assert.equal(a.ok, true, a.message);
    const janeCalls = portalCalls(p.calls);
    assert.ok(janeCalls.length > 0);
    assert.ok(janeCalls.every((c) => c.auth === tokenOf('jdoe')), 'every call in Jane\'s Save carries Jane\'s session');

    p.calls.length = 0;
    const b = await rwbSequenceStops(p.requester, 'r2', ['s3', 's4'], ORIGIN, [], {}, MIKE);
    assert.equal(b.ok, true, b.message);
    assert.deepEqual(signIns(p.calls).map((c) => c.bodyUser), ['msmith'], 'Mike signs in as Mike — Jane\'s cached session is not reused');
    assert.ok(portalCalls(p.calls).every((c) => c.auth === tokenOf('msmith')));
  });
});

test('a person\'s session is reused for their own next Save (no second sign-in)', async () => {
  await withRwb({}, async () => {
    const p = makePortal();
    await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN, [], {}, JANE);
    p.calls.length = 0;
    await rwbSequenceStops(p.requester, 'r1', ['s1', 's2'], ORIGIN, [], {}, JANE);
    assert.equal(signIns(p.calls).length, 0);
  });
});

test('no auth passed: the shared login, exactly as before — and cached apart from everyone else', async () => {
  await withRwb({}, async () => {
    const p = makePortal();
    const r = await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN);
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(signIns(p.calls).map((c) => c.bodyUser), ['Chad']);
    assert.ok(portalCalls(p.calls).every((c) => c.auth === tokenOf('Chad')));
    p.calls.length = 0;
    await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN, [], {}, JANE);
    assert.deepEqual(signIns(p.calls).map((c) => c.bodyUser), ['jdoe'], 'Jane never borrows the shared session');
  });
});

test('the no-auto-resequence preference is set once PER LOGIN, not once per instance', async () => {
  await withRwb({}, async () => {
    const p = makePortal();
    const prefs = () => p.calls.filter((c) => c.url.includes('saveRwbPreference'));
    await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN, [], {}, JANE);
    assert.equal(prefs().length, 1);
    assert.equal(prefs()[0].auth, tokenOf('jdoe'));
    await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN, [], {}, JANE);
    assert.equal(prefs().length, 1, 'Jane\'s second Save does not set it again');
    await rwbSequenceStops(p.requester, 'r2', ['s2'], ORIGIN, [], {}, MIKE);
    assert.equal(prefs().length, 2, 'Mike\'s first Save sets it for Mike');
    assert.equal(prefs()[1].auth, tokenOf('msmith'));
  });
});

test('a refused personal login is tried ONCE, reported, and then held — no second sign-in', async () => {
  await withRwb({}, async () => {
    const p = makePortal();
    const stale = { username: 'jdoe', password: 'old-password' };
    const first = await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN, [], {}, stale);
    assert.equal(first.ok, false);
    assert.equal(signIns(p.calls).length, 1, 'the preference call and the preview must not BOTH sign in with a wrong password');
    assert.equal(takeRwbLoginRefusal(JANE), null, 'keyed by the exact login: a different password does not pick it up');
    const rep = takeRwbLoginRefusal(stale);
    assert.ok(rep, 'the refusal is handed to the write endpoint');
    assert.match(rep.detail, /Invalid username or password/);
    assert.equal(takeRwbLoginRefusal(stale), null, 'reported once');

    p.calls.length = 0;
    const second = await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN, [], {}, stale);
    assert.equal(second.ok, false);
    assert.equal(p.calls.length, 0, 'a held refusal costs no NuVizz call at all');
    assert.match(second.message, /not tried again/);
  });
});

test('a re-entered (different) password is a new login, not held by the old refusal', async () => {
  await withRwb({}, async () => {
    const p = makePortal();
    await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN, [], {}, { username: 'jdoe', password: 'old-password' });
    p.calls.length = 0;
    const r = await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN, [], {}, JANE);
    assert.equal(r.ok, true, r.message);
    assert.equal(signIns(p.calls).length, 1);
  });
});

test('an OUTAGE at sign-in is not a refusal: nothing is held, the next Save tries again', async () => {
  await withRwb({}, async () => {
    const p = makePortal({ signInStatus: 503 });
    const r = await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN, [], {}, JANE);
    assert.equal(r.ok, false);
    assert.equal(takeRwbLoginRefusal(JANE), null);
    const before = signIns(p.calls).length;
    await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN, [], {}, JANE);
    assert.ok(signIns(p.calls).length > before, 'tried again');
  });
});

test('a RATE LIMIT at sign-in is not a refusal: nothing held, nothing reported, the next Save tries again', async () => {
  await withRwb({}, async () => {
    const p = makePortal({ signInStatus: 429 });
    const r = await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN, [], {}, JANE);
    assert.equal(r.ok, false);
    assert.equal(takeRwbLoginRefusal(JANE), null, 'a working login must not be taken out of service by a 429');
    assert.equal(rwbLoginHeld(JANE), false);
    const before = signIns(p.calls).length;
    await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN, [], {}, JANE);
    assert.ok(signIns(p.calls).length > before);
  });
});

test('a login held from the API side is not sent to the portal either — one brake per Save', async () => {
  await withRwb({}, async () => {
    const p = makePortal();
    assert.equal(rwbLoginHeld(JANE), false);
    holdRwbLogin(JANE, 'the NuVizz API answered 401 to the NuVizz login saved as jdoe');
    assert.equal(rwbLoginHeld(JANE), true);
    assert.equal(rwbLoginHeld(MIKE), false, 'held per login');
    const r = await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN, [], {}, JANE);
    assert.equal(r.ok, false);
    assert.equal(p.calls.length, 0, 'no sign-in with a password the API just refused');
    assert.match(r.message, /API answered 401/);
    holdRwbLogin(null, 'x');   // nothing to hold: no throw
    assert.equal(rwbLoginHeld(null), false);
  });
});

test('the SHARED login is never held — its behaviour is exactly what it was', async () => {
  await withRwb({ NUVIZZ_RWB_PASS: 'wrong' }, async () => {
    const p = makePortal();
    await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN);
    const before = signIns(p.calls).length;
    assert.ok(before >= 1);
    await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN);
    assert.ok(signIns(p.calls).length > before, 'the shared login is tried again on the next Save, as before');
    assert.equal(takeRwbLoginRefusal({ username: 'Chad', password: 'wrong' }), null, 'and never reported as a personal refusal');
  });
});

test('an incomplete personal login is NOT ready — it never falls back to the shared one', async () => {
  await withRwb({}, async () => {
    assert.equal(rwbConfigReady(), true, 'shared creds are configured');
    assert.equal(rwbConfigReady({ username: 'jdoe', password: '' }), false);
    assert.equal(rwbConfigReady({ username: '', password: 'x' }), false);
    assert.equal(rwbConfigReady(JANE), true);
    const p = makePortal();
    const r = await rwbAddStopsToRoute(p.requester, 'r1', ['s1'], { username: 'jdoe', password: '' });
    assert.equal(r.ok, false);
    assert.match(r.message, /personal NuVizz login is incomplete/);
    assert.equal(p.calls.length, 0, 'refused before any call — and certainly not as Chad');
  });
});

test('adding stops as a person carries that person\'s session', async () => {
  await withRwb({}, async () => {
    const p = makePortal();
    const r = await rwbAddStopsToRoute(p.requester, 'r1', ['s1', 's2'], MIKE);
    assert.equal(r.ok, true, r.message);
    assert.ok(portalCalls(p.calls).every((c) => c.auth === tokenOf('msmith')));
  });
});

// ── the login check ──────────────────────────────────────────────────────────

test('check: an accepted login is ok — and its session is kept for the next Save', async () => {
  await withRwb({}, async () => {
    const p = makePortal();
    const c = await rwbCheckLogin(p.requester, JANE);
    assert.equal(c.verdict, 'ok');
    assert.equal(signIns(p.calls).length, 1);
    assert.equal(p.calls.length, 4, 'login page, company check, sign-in, Route Workbench token');
    p.calls.length = 0;
    await rwbSequenceStops(p.requester, 'r1', ['s1'], ORIGIN, [], {}, JANE);
    assert.equal(signIns(p.calls).length, 0, 'the check was not thrown away');
  });
});

test('check: a wrong password is refused — and pressing Test again does not ask NuVizz again', async () => {
  await withRwb({}, async () => {
    const p = makePortal();
    const bad = { username: 'jdoe', password: 'typo' };
    const c = await rwbCheckLogin(p.requester, bad);
    assert.equal(c.verdict, 'refused');
    assert.match(c.detail, /Invalid username or password/);
    p.calls.length = 0;
    const again = await rwbCheckLogin(p.requester, bad);
    assert.equal(again.verdict, 'refused');
    assert.equal(p.calls.length, 0, 'three presses of Test on one wrong password is how an account gets locked');
  });
});

test('check: a login with no Route Workbench access is refused, and says which step', async () => {
  await withRwb({}, async () => {
    const p = makePortal({ tokenStatus: 403 });
    const c = await rwbCheckLogin(p.requester, JANE);
    assert.equal(c.verdict, 'refused');
    assert.match(c.detail, /Route Workbench/);
  });
});

test('check: an outage is unknown, never a wrong password', async () => {
  await withRwb({}, async () => {
    const p = makePortal({ signInStatus: 502 });
    assert.equal((await rwbCheckLogin(p.requester, JANE)).verdict, 'unknown');
    const thrower = { async request() { throw new Error('NuVizz circuit breaker open'); } };
    const t = await rwbCheckLogin(thrower, JANE);
    assert.equal(t.verdict, 'unknown');
    assert.match(t.detail, /breaker/);
  });
});

test('check: skipped when the Route Workbench engine is off on this site', async () => {
  await withRwb({ NUVIZZ_RWB_ENABLED: '' }, async () => {
    const p = makePortal();
    const c = await rwbCheckLogin(p.requester, JANE);
    assert.equal(c.verdict, 'skipped');
    assert.equal(p.calls.length, 0);
  });
});

test('session key: same person, same password ⇒ same key; anything different ⇒ a different key', () => {
  const base = { loginBase: 'https://login.nuvizz.com', companyCode: 'davis' };
  const k = rwbSessionKey({ ...base, username: 'jdoe', password: 'a' });
  assert.equal(k, rwbSessionKey({ ...base, username: 'jdoe', password: 'a' }));
  assert.notEqual(k, rwbSessionKey({ ...base, username: 'jdoe', password: 'b' }));
  assert.notEqual(k, rwbSessionKey({ ...base, username: 'JDoe', password: 'a' }));
  assert.notEqual(k, rwbSessionKey({ ...base, companyCode: 'davisv5', username: 'jdoe', password: 'a' }));
  assert.ok(!k.includes('a|') && !k.endsWith('|a'), 'the password itself is never in the key');
  assert.ok(REFUSAL_HOLD_MS >= 5 * 60_000);
});

// ── the Save engine passes the person's login to EVERY Route Workbench call ──
//
// One Save, one person. A call site that forgets creds.rwb quietly signs that one step in as
// the shared login: the stops are added as Chad and sequenced as the dispatcher, and NuVizz's
// history splits one Save across two names. This reads the engine's source rather than trusting
// that every future call site will remember.
test('lib/nuvizz-write.mts: every Route Workbench call passes creds.rwb', () => {
  const src = readFileSync(new URL('../netlify/functions/lib/nuvizz-write.mts', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/\b(rwbAddStopsToRoute|rwbSequenceStops|rwbSequenceRoutes|rwbConfigReady)\(/g)];
  assert.ok(calls.length >= 9, `expected the known call sites, found ${calls.length}`);
  for (const m of calls) {
    // Walk to the matching close paren of THIS call.
    let depth = 0; let end = m.index + m[0].length - 1;
    for (let i = end; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    const call = src.slice(m.index, end + 1);
    if (/^\w+\(\)$/.test(call) && m[1] !== 'rwbConfigReady') continue;
    assert.match(call, /creds\.rwb\)\s*$/, `this call does not pass the person's login:\n${call.slice(0, 160)}`);
  }
});
