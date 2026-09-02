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

test('the override gate is STRICT — it refuses with AUTH_REQUIRED off, because the spend is open until it does', async () => {
  delete process.env.AUTH_REQUIRED;
  _resetThrottleForTests();
  const none = await gateScheduledOverride(post('f'), 'f', ['date']);
  assert.equal(none, null, 'the cron path never even consults the gate');
  const refused = await gateScheduledOverride(post('f', '?date=2026-09-01'), 'f', ['date']);
  assert.ok(refused, 'and the hand-driven path is refused even though every other gate here is inert');
  assert.equal(refused.status, 401);
});

// ── all seven, both directions ───────────────────────────────────────────────

for (const [name, handler, declared, expected] of WRITERS) {
  test(`${name}: the cron path (no query string) runs exactly as before`, async () => {
    await withNoNetwork(async (calls) => {
      const r = await handler(post(name));
      assert.notEqual(r.status, 401, 'a gate that refuses the 5-minute board scan is a broken board');
      assert.notEqual(r.status, 403);
      assert.equal(calls(), 0, 'and it reached no vendor — Firestore is off, so it bails at the SA check');
    });
  });

  test(`${name}: every hand-driven override it honours is refused, and nothing runs`, async () => {
    assert.deepEqual([...declared], expected, 'the gated list must match the params the handler actually reads');
    await withNoNetwork(async (calls) => {
      for (const p of expected) {
        _resetThrottleForTests();
        const r = await handler(post(name, `?${p}=2026-09-01`));
        assert.equal(r.status, 401, `?${p}= must not be reachable without an admin session`);
        assert.equal(calls(), 0, `?${p}= must cost no vendor call — a refused ~3,000-call scan is the whole point`);
      }
    });
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
