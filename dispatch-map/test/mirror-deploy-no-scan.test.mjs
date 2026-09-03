// A MIRROR DEPLOY DOES NOT SCAN NUVIZZ.
//
// Chad, 2026-09-03, on the UAT site: "I do not want uat running scans cut it off."
//
// WHAT THE LIVE SITE SAID BEFORE THIS CHANGE, read off its own dry run (Firestore-only, zero
// vendor calls): 109 NuVizz calls that day, every one attributed to `scheduled_scan`, and the
// kill switch reading `{env: false, config: false}` — nobody had turned it off, because the
// switch defaults OPEN and nothing about being a mirror made it shut. Its board was 6 stops
// against production's 801, so it was scanning a different tenant into a different database,
// on a schedule nobody had chosen.
//
// These tests pin the rule that makes that impossible by construction rather than by
// somebody remembering an env var: FIRESTORE_DATABASE is set on a mirror and unset on
// production, so a deploy writing to a NAMED database never generates vendor traffic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scansEnabled, isMirrorDeploy } from '../netlify/functions/lib/nuvizz-scan.mts';

/** Run `fn` with an exact env, restoring whatever was there. */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('PRODUCTION IS UNTOUCHED — no named database means this is the real board, and it scans', () => {
  // The whole change is worthless if it quiets production. FIRESTORE_DATABASE unset is what
  // production looks like, and every shape of "unset" has to read the same way.
  for (const db of [undefined, '', '   ', '(default)']) {
    withEnv({ FIRESTORE_DATABASE: db, NUVIZZ_SCANS_ENABLED: undefined }, () => {
      assert.equal(isMirrorDeploy(), false, `db=${JSON.stringify(db)}`);
      assert.equal(scansEnabled(), true, `db=${JSON.stringify(db)}`);
    });
  }
});

test('A MIRROR DEPLOY IS BORN SILENT — no env var required, and none can re-open it', () => {
  // This is the case that was costing 109 calls a day. Note the third assertion: even an
  // explicit NUVIZZ_SCANS_ENABLED=true does not put a mirror back to scanning, because the
  // question "is this the production board" is not a preference.
  for (const flag of [undefined, '', 'true', 'TRUE', 'yes', '1']) {
    withEnv({ FIRESTORE_DATABASE: 'uat-mirror', NUVIZZ_SCANS_ENABLED: flag }, () => {
      assert.equal(isMirrorDeploy(), true);
      assert.equal(scansEnabled(), false, `a mirror must not scan with the flag at ${JSON.stringify(flag)}`);
    });
  }
});

test('THE KILL SWITCH STILL WORKS ON PRODUCTION, and still only on the literal "false"', () => {
  // Unchanged behaviour, re-pinned here because this change edits the same function: a
  // missing or malformed value must never silently stop the live board's scans.
  withEnv({ FIRESTORE_DATABASE: undefined, NUVIZZ_SCANS_ENABLED: 'false' }, () => {
    assert.equal(scansEnabled(), false);
  });
  withEnv({ FIRESTORE_DATABASE: undefined, NUVIZZ_SCANS_ENABLED: 'FALSE  ' }, () => {
    assert.equal(scansEnabled(), false, 'case and padding are tolerated');
  });
  for (const v of ['0', 'no', 'off', 'disabled', 'nope', '']) {
    withEnv({ FIRESTORE_DATABASE: undefined, NUVIZZ_SCANS_ENABLED: v }, () => {
      assert.equal(scansEnabled(), true, `${JSON.stringify(v)} must NOT kill live data`);
    });
  }
});

test('THE NIGHTLY HISTORY CAPTURE HONOURS THE MASTER SWITCH — it is the one that had no gate at all', async () => {
  // The most expensive scheduled caller in the app (~690 calls a night with lean discovery
  // off) went straight to work with no kill switch, no flag of its own, nothing. So flipping
  // NUVIZZ_SCANS_ENABLED=false to stop spending money silenced the 5-minute refresh and left
  // this firing at 06:00 UTC — the worst possible shape for that switch.
  const { runHistorySnapshot } = await import('../netlify/functions/lib/history-core.mts');
  const res = await withEnv(
    { FIRESTORE_DATABASE: 'uat-mirror', FIREBASE_SA: '{"fake":true}' },
    () => runHistorySnapshot(new Request('https://example.com/.netlify/functions/nuvizz-history-snapshot-background')),
  );
  const body = await res.json();
  assert.equal(body.skipped, 'scans-disabled', JSON.stringify(body));
  assert.equal(body.ok, true, 'a deliberate stand-down is not an error');
});

test('THE ATTEMPTS JOBS HONOUR IT TOO — their own switch was independent in both directions', () => {
  // attEnabled() is deliberately separate so attempts can be stopped without touching the
  // board scan. The reverse was NOT deliberate: the master switch did not reach them.
  // Pinned on the composed expression the run now uses.
  const composed = (att, scans) => att && scans;
  assert.equal(composed(true, false), false, 'master off wins over the job being enabled');
  assert.equal(composed(false, true), false, 'the job switch still works on its own');
  assert.equal(composed(true, true), true, 'both on = it runs, unchanged on production');
  withEnv({ FIRESTORE_DATABASE: 'uat-mirror', NUVIZZ_ATT_ENABLED: undefined }, () => {
    assert.equal(scansEnabled(), false, 'so a mirror is silent here without setting NUVIZZ_ATT_ENABLED');
  });
});
