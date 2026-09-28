// test/routing-engine-version.test.mjs — ENGINE_VERSION is the label on the engine's scores.
//
// #1022 (2026-09-26) moved the tractor per-trip payload cap default from 44,000 lb to 30,000
// and left ENGINE_VERSION at 2.13.0, so assignment days scored under either cap all read
// "2.13.0" (audit rules-tests-07). That label is what the replays use to decide a day needs
// scoring again (runShadowForDate / runPlanForDate skip a day already at ENGINE_VERSION) and
// what the Engine tab's version cards are keyed by (plan_version_rollups/{tenant}__{version}),
// so a scoring change the label does not show is a change nobody can measure.
//
// The engine's default knobs are therefore pinned to the version they ship under. Change a
// default and this fails until ENGINE_VERSION moves — with its note in
// routing-engine-config.mts — and the table below is re-pinned to the new version. A change
// to the engine's LOGIC cannot be caught this way (the version note is the rule for that);
// a changed default can, and #1022 was one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ENGINE_VERSION, ENGINE_CONFIG_BOUNDS, engineConfigDefaults,
} from '../netlify/functions/lib/routing-engine-config.mts';

const PINNED = {
  version: '2.13.1',
  defaults: {
    zone_precision: 6, super_precision: 5, top_precision: 4,
    road_factor: 1.35, speed_short_mph: 22, speed_mid_mph: 35, speed_long_mph: 48, short_break_mi: 3, long_break_mi: 10,
    big_m_min: 100000, precedence_penalty: 1, hierarchy_penalty: 10, penalty_multiplier: 1500, restarts: 8, solver_ms_cap: 1000,
    min_route_stops: 5, max_missing_coord_frac: 0.2, executed_fallback_min_frac: 0.5,
    min_reference_zone_overlap: 2, min_prior_reference_days: 14,
    service_min_clamp: 2, service_max_clamp: 120, min_observation_days: 10, hard_cap_factor: 1.15, assignment_ms_cap: 90000,
    reload_gap_min: 132, typical_shift_hours: 10, far_first_adherence: 0.82, trip2_radius_mi: 20,
    w_affinity: 2, w_trips: 12, w_shift_overflow: 4, w_far_first: 1, w_strict_window: 2, w_compactness: 1,
    reference_top_k: 5, reference_half_life_days: 45, same_driver_multiplier: 2, reference_edge_floor: 0.2,
    w_habit: 3, habit_shrink_n: 4,
    far_deadhead_mi: 45, w_far_deadhead: 6, habit_far_discount: 0.35, w_zone_cohesion: 8,
    w_zone_owner: 10, zone_owner_min_share: 0.1, zone_owner_min_obs: 25,
    skid_cap_box_soft: 20, skid_cap_box_hard: 22, skid_cap_tractor_soft: 31, skid_cap_tractor_hard: 37, loose_per_skid: 10,
    w_skid_soft: 0, skid_cap_driver_min: 10, skid_cap_driver_headroom: 0,
    // 2.13.0 shipped with 44000 here; #1022 made it 30000 (Chad, 2026-09-26) — the change 2.13.1 labels.
    weight_cap_box_lb: 10000, weight_cap_tractor_lb: 30000,
    w_candidate_rank: 2, habit_rank_aware: 0, territory_half_life_days: 0, candidate_zone_k: 5, candidate_area_k: 3,
  },
};

test('a changed engine default (the #1022 tractor cap) cannot ship under the old ENGINE_VERSION label', () => {
  // Defaults as the code ships them — no Netlify env, which only an operator sets.
  const d = engineConfigDefaults({});
  const shipped = Object.fromEntries(Object.keys(PINNED.defaults).map((k) => [k, d[k]]));
  assert.equal(ENGINE_VERSION, PINNED.version,
    `ENGINE_VERSION is ${ENGINE_VERSION} but the defaults below are pinned for ${PINNED.version} — re-pin them to the new version`);
  assert.deepEqual(shipped, PINNED.defaults,
    'an engine default changed: that changes the scores, so bump ENGINE_VERSION with a note in routing-engine-config.mts and re-pin this table');
});

test('every engine knob is pinned — a new knob cannot slip in unlabelled', () => {
  assert.deepEqual(Object.keys(ENGINE_CONFIG_BOUNDS).sort(), Object.keys(PINNED.defaults).sort());
});

test('every ENGINE_VERSION carries its note above the constant — the engine\'s own changelog', () => {
  const src = readFileSync(new URL('../netlify/functions/lib/routing-engine-config.mts', import.meta.url), 'utf8');
  const constAt = src.indexOf('export const ENGINE_VERSION');
  assert.ok(constAt > 0, 'ENGINE_VERSION is declared');
  const noteAt = src.indexOf(`// ${ENGINE_VERSION}:`);
  assert.ok(noteAt > 0 && noteAt < constAt, `no "// ${ENGINE_VERSION}: …" note above the constant`);
});
