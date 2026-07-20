// The live engine-tuning write path: mergeEngineConfigUpdate must clamp every
// update, honor resets (drop back to default), never persist junk keys, and
// keep untouched overrides intact. The endpoint and the solver both re-clamp on
// read, but the write path should already be clean.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeEngineConfigUpdate, effectiveEngineConfig, engineConfigDefaults, ENGINE_CONFIG_BOUNDS,
} from '../netlify/functions/lib/routing-engine-config.mts';

const DFLT = engineConfigDefaults({});

test('updates are clamped to bounds and unknown keys never persist', () => {
  const out = mergeEngineConfigUpdate({}, { w_zone_owner: 999999, nonsense_key: 42, w_habit: 'NaN-y' });
  assert.equal(out.w_zone_owner, ENGINE_CONFIG_BOUNDS.w_zone_owner[1], 'clamped to the max');
  assert.ok(!('nonsense_key' in out), 'unknown keys dropped');
  assert.ok(!('w_habit' in out), 'non-numeric values dropped');
});

test('resets drop an override back to the default; other overrides survive', () => {
  const prior = { w_zone_owner: 40, w_zone_cohesion: 12 };
  const out = mergeEngineConfigUpdate(prior, {}, ['w_zone_owner']);
  assert.ok(!('w_zone_owner' in out), 'reset key removed from the stored doc');
  assert.equal(out.w_zone_cohesion, 12, 'untouched override kept');
  const eff = effectiveEngineConfig(out);
  assert.equal(eff.w_zone_owner, DFLT.w_zone_owner, 'effective falls back to the default');
  assert.equal(eff.w_zone_cohesion, 12);
});

test('an update beats a simultaneous reset of the same key (explicit value wins)', () => {
  const out = mergeEngineConfigUpdate({ w_zone_owner: 40 }, { w_zone_owner: 20 }, ['w_zone_owner']);
  assert.equal(out.w_zone_owner, 20);
});

test('metadata junk in the prior doc never round-trips into the knobs', () => {
  const prior = { w_zone_owner: 40, updated_at: '2026-07-20T00:00:00Z', updated_by: 'engine-tab' };
  const out = mergeEngineConfigUpdate(prior, { far_deadhead_mi: 50 });
  assert.ok(!('updated_at' in out) && !('updated_by' in out), 'metadata stripped (the endpoint re-stamps it)');
  assert.equal(out.w_zone_owner, 40);
  assert.equal(out.far_deadhead_mi, 50);
});
