// test/mirror-scans.test.mjs — may the UAT board see anything?
//
// Chad, 2026-09-10: "Why don't we hook up our uat to nuvizz's uat so we can test and work
// through things."
//
// It already IS hooked up. Read off the dd-dispatch-map-uat site that day:
// NUVIZZ_BASE_URL=https://uat.nuvizz.com/deliverit/openapi/v7, company DAVISV5 with its own
// credentials, FIRESTORE_DATABASE=uat-mirror, NUVIZZ_WRITE_ENABLED=true. Writes reach NuVizz
// UAT. What you cannot do there is SEE anything to write about: isMirrorDeploy() shut every
// read path on every mirror (v0.90.0, after UAT quietly spent 109 NuVizz calls in a day), and
// that gate is in CODE — no env var could re-open it, including the manual-scan button.
//
// A dispatcher cannot test building a route on a board with no orders on it. So a mirror may
// now be TOLD to scan the tenant it is pointed at. These tests pin the four properties that
// make that safe, because each one is a way this could go wrong in the dangerous direction:
//   1. production is untouched, even with the flag stray-set;
//   2. a mirror is still silent by default — a NEW mirror is born quiet, as before;
//   3. the P0 runaway kill switch still outranks the new switch;
//   4. the refusal SAYS WHICH of the three reasons it was.
import test from 'node:test';
import assert from 'node:assert/strict';

import { isMirrorDeploy, mirrorScansAllowed, scanBlockReason } from '../netlify/functions/lib/mirror-guard.mts';
import { scansEnabled } from '../netlify/functions/lib/nuvizz-scan.mts';

const KEYS = ['FIRESTORE_DATABASE', 'NUVIZZ_MIRROR_SCANS', 'NUVIZZ_SCANS_ENABLED'];
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

test('PRODUCTION IS UNTOUCHED — and the flag is inert there even if somebody sets it', () => {
  withEnv({}, () => {
    assert.equal(isMirrorDeploy(), false, 'no FIRESTORE_DATABASE = not a mirror');
    assert.equal(scansEnabled(), true);
    assert.equal(scanBlockReason(), null);
  });
  // The dangerous direction: a copied env, or a stray flag, must never change production.
  withEnv({ NUVIZZ_MIRROR_SCANS: 'on' }, () => {
    assert.equal(mirrorScansAllowed(), false, 'the flag is only readable BY a mirror');
    assert.equal(scansEnabled(), true, 'production scans as it always did — nothing new applies');
  });
  // And the P0 brake still works there, unchanged.
  withEnv({ NUVIZZ_SCANS_ENABLED: 'false' }, () => {
    assert.equal(scansEnabled(), false);
    assert.equal(scanBlockReason(), 'kill-switch');
  });
});

test('A NEW MIRROR IS BORN SILENT — the Sep 3 rule survives (109 calls/day is why)', () => {
  withEnv({ FIRESTORE_DATABASE: 'uat-mirror' }, () => {
    assert.equal(isMirrorDeploy(), true);
    assert.equal(mirrorScansAllowed(), false, 'silence is the default, never a variable somebody must remember');
    assert.equal(scansEnabled(), false);
    assert.equal(scanBlockReason(), 'mirror');
  });
  // Any named database, not just the one we happen to use today.
  withEnv({ FIRESTORE_DATABASE: 'some-other-mirror' }, () => assert.equal(scansEnabled(), false));
});

test('THE P0 KILL SWITCH OUTRANKS THE NEW SWITCH — a runaway brake is not overridable by a convenience', () => {
  // This is the dd-dispatch-map-uat site as it stands: BOTH are set against scanning, so
  // turning the mirror switch on alone changes nothing. That is deliberate, and the reason
  // reported flips to 'kill-switch' so an operator can see which one is still holding.
  withEnv({ FIRESTORE_DATABASE: 'uat-mirror', NUVIZZ_MIRROR_SCANS: 'on', NUVIZZ_SCANS_ENABLED: 'false' }, () => {
    assert.equal(mirrorScansAllowed(), true, 'the mirror has permission');
    assert.equal(scansEnabled(), false, 'and is still stopped, by the brake');
    assert.equal(scanBlockReason(), 'kill-switch', 'and it says which one is holding');
  });
});

test('BOTH MOVED: the UAT board can index its own tenant', () => {
  withEnv({ FIRESTORE_DATABASE: 'uat-mirror', NUVIZZ_MIRROR_SCANS: 'on' }, () => {
    assert.equal(scansEnabled(), true);
    assert.equal(scanBlockReason(), null);
  });
  for (const on of ['on', 'ON', 'true', '1', 'yes']) {
    withEnv({ FIRESTORE_DATABASE: 'uat-mirror', NUVIZZ_MIRROR_SCANS: on }, () => assert.equal(scansEnabled(), true, on));
  }
  // Anything else is not permission. "off", a typo and a blank all mean silent.
  for (const off of ['off', 'false', '0', 'no', '', '  ', 'yes please', undefined]) {
    withEnv({ FIRESTORE_DATABASE: 'uat-mirror', ...(off === undefined ? {} : { NUVIZZ_MIRROR_SCANS: off }) },
      () => assert.equal(scansEnabled(), false, JSON.stringify(off)));
  }
});

test('the three reasons scanning can be off are distinguishable — the same blank screen is three bugs', () => {
  const reason = (env) => withEnv(env, () => scanBlockReason());
  assert.equal(reason({}), null, 'running');
  assert.equal(reason({ NUVIZZ_SCANS_ENABLED: 'false' }), 'kill-switch');
  assert.equal(reason({ FIRESTORE_DATABASE: 'uat-mirror' }), 'mirror');
  assert.equal(reason({ FIRESTORE_DATABASE: 'uat-mirror', NUVIZZ_MIRROR_SCANS: 'on' }), null);
});
