// test/scheduled-override-gate.test.mjs — A CRON SCHEDULE IS NOT AN ACCESS CONTROL.
//
// THE EVENT THIS PREVENTS. Seven scheduled writers read caller-chosen query params that skip
// their own cadence guards. The sharpest is nuvizz-refresh-stops-background: POST it with
// ?date= and runRefreshStops flips into the EXPLICIT number-probe path — the ~3,000-metered-
// call cold scan CLAUDE.md's hard rule exists to forbid — from an unauthenticated URL anybody
// can type, as many times as they like. The others re-freeze a routed plan onto the wrong
// day, re-run the ATTEMPTS saved search, replay the flag mailer against a chosen clock, or
// re-score the ledger the alert thresholds are tuned against.
//
// AND THE THING THAT MUST NOT BREAK IS THE CRON. Netlify's scheduler sends NO query string,
// so gating only the override branch costs the schedule nothing — and these tests pin BOTH
// directions, because a gate that breaks the 5-minute board scan gets ripped out by lunchtime
// and then nothing is guarded at all.
//
// THE THIRD DIRECTION, added after the gate shipped strict and broke a runbook: it must be
// INERT today and SHUT after AUTH_REQUIRED=true. Every writer below is exercised on both sides
// of that switch, because "refuses everybody, including Chad, and answers 202 while doing it"
// passed the old two-direction test perfectly.
//
// Firestore is deliberately OFF here: every core answers "FIREBASE_SA not set" without
// touching the network, so an un-refused call is visible as that answer rather than as a
// vendor call. Global fetch throws, so any network attempt fails the test loudly.
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.FIREBASE_SA;          // isFirestoreEnabled() false → cores bail harmlessly
process.env.NUVIZZ_BASE_URL = '';
process.env.AUTH_SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';
delete process.env.AUTH_REQUIRED;        // proving these are enforced with the switch OFF
delete process.env.NUVIZZ_SCANS_ENABLED;
delete process.env.ROUTING_ENGINE;

import { overrideParams, gateScheduledOverride } from '../netlify/functions/lib/background-gate.mts';
import { _resetThrottleForTests } from '../netlify/functions/lib/require-user.mts';

import refreshStops, { OVERRIDE_PARAMS as REFRESH_PARAMS } from '../netlify/functions/nuvizz-refresh-stops-background.mts';
import historySnapshot, { OVERRIDE_PARAMS as HISTORY_PARAMS } from '../netlify/functions/nuvizz-history-snapshot-background.mts';
import attPlan, { OVERRIDE_PARAMS as ATT_PLAN_PARAMS } from '../netlify/functions/nuvizz-att-plan-snapshot-background.mts';
import attScan, { OVERRIDE_PARAMS as ATT_SCAN_PARAMS } from '../netlify/functions/nuvizz-att-scan-background.mts';
import flagAlert, { OVERRIDE_PARAMS as ALERT_PARAMS } from '../netlify/functions/eta-flag-alert-background.mts';
import missLedger, { OVERRIDE_PARAMS as LEDGER_PARAMS } from '../netlify/functions/eta-miss-ledger-background.mts';
import engineShadow, { OVERRIDE_PARAMS as SHADOW_PARAMS } from '../netlify/functions/routing-engine-shadow-background.mts';

const WRITERS = [
  ['nuvizz-refresh-stops-background', refreshStops, REFRESH_PARAMS, ['date', 'days']],
  ['nuvizz-history-snapshot-background', historySnapshot, HISTORY_PARAMS, ['date', 'from', 'to']],
  ['nuvizz-att-plan-snapshot-background', attPlan, ATT_PLAN_PARAMS, ['date']],
  ['nuvizz-att-scan-background', attScan, ATT_SCAN_PARAMS, ['date']],
  ['eta-flag-alert-background', flagAlert, ALERT_PARAMS, ['dry', 'date', 'now']],
  ['eta-miss-ledger-background', missLedger, LEDGER_PARAMS, ['force', 'from', 'to', 'date']],
  ['routing-engine-shadow-background', engineShadow, SHADOW_PARAMS, ['date', 'force']],
];

const post = (name, qs = '') =>
  new Request(`https://x.netlify.app/.netlify/functions/${name}${qs}`, { method: 'POST' });

async function withNoNetwork(fn) {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (u) => { calls++; throw new Error(`network reached: ${String(u?.url ?? u)}`); };
  try { return await fn(() => calls); } finally { globalThis.fetch = realFetch; }
}

// ── the rule ─────────────────────────────────────────────────────────────────

test('overrideParams: the cron\'s empty query string is the ungated path, and a valueless flag still counts', () => {
  const base = 'https://x.test/.netlify/functions/f';
  assert.deepEqual(overrideParams(base, ['date', 'days']), [], 'no query string = the schedule fired it');
  assert.deepEqual(overrideParams(`${base}?date=2026-09-01`, ['date', 'days']), ['date']);
  assert.deepEqual(overrideParams(`${base}?days=3&date=x`, ['date', 'days']), ['date', 'days']);
  // `?dry` and `?dry=1` mean the same thing to the endpoints that read them, so a bare flag
  // must not slip past by being "absent" — URLSearchParams.get returns '' for it, not null.
  assert.deepEqual(overrideParams(`${base}?dry`, ['dry']), ['dry']);
  // An unrelated param is not an override: ?manual=1 is the Scan-now button's cheap
  // list-discovery path and gating it would break that button's fallback chain.
  assert.deepEqual(overrideParams(`${base}?manual=1`, ['date', 'days']), []);
  assert.deepEqual(overrideParams('not a url', ['date']), [], 'a malformed URL is never an override');
});

// ── inert until the switch, then shut ────────────────────────────────────────

test('the override gate SHIPS INERT — a documented curl runbook must not silently stop working today', async () => {
  // THE BUG THIS PINS. This gate used to be { strict: true }: enforced even with AUTH_REQUIRED
  // off. The argument was one-sided cost (a refused override runs nothing; a wrongly-allowed one
  // spends ~3,000 metered calls). What it missed is that AUTH_SESSION_SECRET IS NOT SET ON THE
  // PRODUCTION SITE — so strict did not mean "admins only", it meant requireUser answered EVERY
  // caller 401 "sign-in not configured", Chad included, with no token that could ever pass. And
  // because all seven are *-background functions, Netlify answers 202 and throws that 401 away.
  //
  // Chad follows docs/ATTEMPTS.md, POSTs nuvizz-att-plan-snapshot-background?date=2026-08-27 to
  // re-freeze a day whose attempts blamed the wrong driver, gets 202, and nothing happens. He
  // then runs the evening scan against a snapshot that was never written and gets a second wrong
  // answer, with no error anywhere he would look. A runbook that silently does nothing is worse
  // than an open endpoint, which is the lesson the whole background-gate file exists to record.
  delete process.env.AUTH_REQUIRED;
  _resetThrottleForTests();
  const none = await gateScheduledOverride(post('f'), 'f', ['date']);
  assert.equal(none, null, 'the cron path never even consults the gate');
  const inert = await gateScheduledOverride(post('f', '?date=2026-09-01'), 'f', ['date']);
  assert.equal(inert, null, 'and with the switch off the hand-driven path runs, like every other gate here');
});

test('the override gate SHUTS when AUTH_REQUIRED flips — and it wants admin, not just any session', async () => {
  process.env.AUTH_REQUIRED = 'true';
  _resetThrottleForTests();
  try {
    const none = await gateScheduledOverride(post('f'), 'f', ['date']);
    assert.equal(none, null, 'the cron still sends no query string, so the cron still never consults the gate');
    const refused = await gateScheduledOverride(post('f', '?date=2026-09-01'), 'f', ['date']);
    assert.ok(refused, 'the ~3,000-call cold scan is not reachable from a URL anybody can type');
    assert.equal(refused.status, 401);
  } finally { delete process.env.AUTH_REQUIRED; }
});

// ── all seven, both directions, both sides of the switch ─────────────────────

for (const [name, handler, declared, expected] of WRITERS) {
  test(`${name}: the cron path (no query string) runs exactly as before`, async () => {
    await withNoNetwork(async (calls) => {
      const r = await handler(post(name));
      assert.notEqual(r.status, 401, 'a gate that refuses the 5-minute board scan is a broken board');
      assert.notEqual(r.status, 403);
      assert.equal(calls(), 0, 'and it reached no vendor — Firestore is off, so it bails at the SA check');
    });
  });

  test(`${name}: today (switch off) every documented override still works`, async () => {
    // The runbooks in docs/ATTEMPTS.md, RESEARCH-m5.md and HANDOFF.md are curl commands Chad
    // actually runs. Until AUTH_REQUIRED is set they must behave exactly as they always have.
    assert.deepEqual([...declared], expected, 'the gated list must match the params the handler actually reads');
    delete process.env.AUTH_REQUIRED;
    await withNoNetwork(async () => {
      for (const p of expected) {
        _resetThrottleForTests();
        const r = await handler(post(name, `?${p}=2026-09-01`));
        assert.notEqual(r.status, 401, `?${p}= must not be refused while every other gate here is inert`);
        assert.notEqual(r.status, 403, `?${p}= must not be refused while every other gate here is inert`);
      }
    });
  });

  test(`${name}: once AUTH_REQUIRED is on, every hand-driven override is refused and nothing runs`, async () => {
    process.env.AUTH_REQUIRED = 'true';
    try {
      await withNoNetwork(async (calls) => {
        for (const p of expected) {
          _resetThrottleForTests();
          const r = await handler(post(name, `?${p}=2026-09-01`));
          assert.equal(r.status, 401, `?${p}= must not be reachable without an admin session`);
          assert.equal(calls(), 0, `?${p}= must cost no vendor call — a refused ~3,000-call scan is the whole point`);
        }
      });
    } finally { delete process.env.AUTH_REQUIRED; }
  });
}

// ── the one param that must NOT be gated ─────────────────────────────────────

test('"Scan now" still works: ?manual=1 is the cheap list pull, not an override', async () => {
  // The Map's Scan-now button falls back to nuvizz-refresh-stops-background?manual=1 when the
  // background endpoint refuses. Gating manual=1 here would turn one refusal into three.
  await withNoNetwork(async () => {
    const r = await refreshStops(post('nuvizz-refresh-stops-background', '?manual=1'));
    assert.notEqual(r.status, 401);
    assert.equal((await r.json()).error, 'FIREBASE_SA not set', 'it entered the scan and stopped at the unset SA');
  });
});
