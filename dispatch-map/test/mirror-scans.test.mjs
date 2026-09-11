// test/mirror-scans.test.mjs — a mirror never scans, and it says so.
//
// Two instructions, four weeks apart, pointing the same way:
//   2026-09-03 — "I do not want uat running scans cut it off" (the UAT site had quietly
//                spent 109 NuVizz calls in a day, attributed to scheduled_scan).
//   2026-09-10 — "we need to use firestore to see what data/orders are put into system
//                daily so we are not running scans."
//
// So isMirrorDeploy() keying on FIRESTORE_DATABASE — rather than on a flag somebody has to
// remember — is the rule, and it stays. A NEW mirror is born silent. The UAT board gets its
// day from production's Firestore and its orders from a deliberate seed, never discovery.
//
// What these tests pin is the RULE plus the one thing that was missing: the REASON. Three
// different things can shut scanning, and the board showed one blank screen for all three —
// the UAT site read `scansEnabled: false` for a week with no way to tell "a mirror may not
// scan" from "somebody pulled the kill switch". Same defect as the 300-character truncation
// on the write path, arriving from the other direction.
import test from 'node:test';
import assert from 'node:assert/strict';

import { isMirrorDeploy, scanBlockReason } from '../netlify/functions/lib/mirror-guard.mts';
import { scansEnabled } from '../netlify/functions/lib/nuvizz-scan.mts';

const KEYS = ['FIRESTORE_DATABASE', 'NUVIZZ_SCANS_ENABLED'];
function withEnv(env, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    return fn();
  } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('A MIRROR NEVER SCANS — no variable re-opens it, which is the whole point of keying on the database', () => {
  withEnv({ FIRESTORE_DATABASE: 'uat-mirror' }, () => {
    assert.equal(isMirrorDeploy(), true);
    assert.equal(scansEnabled(), false);
  });
  // Any named database, not just the one we happen to use today — a new mirror is born silent.
  withEnv({ FIRESTORE_DATABASE: 'some-other-mirror' }, () => assert.equal(scansEnabled(), false));
  // And not even the kill switch's own "not false" can turn a mirror back on.
  withEnv({ FIRESTORE_DATABASE: 'uat-mirror', NUVIZZ_SCANS_ENABLED: 'true' }, () => assert.equal(scansEnabled(), false));
});

test('PRODUCTION IS UNTOUCHED — it scans, and the P0 kill switch still stops it', () => {
  withEnv({}, () => {
    assert.equal(isMirrorDeploy(), false, 'no FIRESTORE_DATABASE = not a mirror');
    assert.equal(scansEnabled(), true);
    assert.equal(scanBlockReason(), null);
  });
  withEnv({ NUVIZZ_SCANS_ENABLED: 'false' }, () => {
    assert.equal(scansEnabled(), false);
    assert.equal(scanBlockReason(), 'kill-switch');
  });
});

test('the three reasons scanning can be off are distinguishable — the same blank screen was three bugs', () => {
  const reason = (env) => withEnv(env, () => scanBlockReason());
  assert.equal(reason({}), null, 'running');
  assert.equal(reason({ NUVIZZ_SCANS_ENABLED: 'false' }), 'kill-switch');
  assert.equal(reason({ FIRESTORE_DATABASE: 'uat-mirror' }), 'mirror');
  // A mirror reports 'mirror' even when the kill switch is ALSO set: the mirror gate is the
  // one that actually decides (it is checked first and cannot be overridden), so naming the
  // switch here would send an operator to flip something that would change nothing.
  assert.equal(reason({ FIRESTORE_DATABASE: 'uat-mirror', NUVIZZ_SCANS_ENABLED: 'false' }), 'mirror');
});
