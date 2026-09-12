// test/routing-panel-rules.test.mjs — the Setup panel's rules, each named for the
// screen it was wrong on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectionTally, strategyChoices, effectiveStrategy, tractorInPlay, planCopyLabels,
  aiAssistStatus, profileDraftCheck, ROUTING_STRATEGIES,
} from '../src/lib/routing-select.js';

// ── step 1 tally ──
test('CHAD\'S SCREENSHOT: 24 orders, 29 skids, 0 loose → loose is 0 and total pieces is 29', () => {
  // The panel read "Loose pieces 29" because it summed `pallets` (total pieces).
  const stops = Array.from({ length: 24 }, (_, i) => ({ stopNbr: `S${i}`, matchKey: `k${i}`, cartons: i < 5 ? 2 : 1, volume: 0, pallets: i < 5 ? 2 : 1, weight: 100 }));
  const t = selectionTally(stops);
  assert.equal(t.orders, 24);
  assert.equal(t.skids, 29);
  assert.equal(t.loose, 0, 'no loose pieces on this selection');
  assert.equal(t.pieces, 29, 'total pieces = skids + loose');
  assert.equal(t.weight, 2400);
});

test('loose and total are different numbers when there IS loose freight', () => {
  const t = selectionTally([{ stopNbr: 'A', cartons: 3, volume: 2, pallets: 5, weight: 900 }]);
  assert.equal(t.skids, 3); assert.equal(t.loose, 2); assert.equal(t.pieces, 5);
});

test('orders vs physical stops: two orders at one address are one truck stop', () => {
  const t = selectionTally([
    { stopNbr: '1', matchKey: 'acme|123 main', cartons: 1, pallets: 1 },
    { stopNbr: '2', matchKey: 'acme|123 main', cartons: 1, pallets: 1 },
    { stopNbr: '3', matchKey: 'beta|9 oak', cartons: 1, pallets: 1 },
  ]);
  assert.equal(t.orders, 3);
  assert.equal(t.places, 2, 'same matchKey rides together, exactly as the Compare header counts');
});

test('the empty, the absent and the malformed: no NaN ever reaches the panel', () => {
  const t = selectionTally([null, { stopNbr: 'X' }, { stopNbr: 'Y', cartons: 'abc', volume: null, pallets: undefined, weight: '12' }]);
  assert.deepEqual(t, { orders: 2, places: 2, skids: 0, loose: 0, pieces: 0, weight: 12 });
  assert.deepEqual(selectionTally(), { orders: 0, places: 0, skids: 0, loose: 0, pieces: 0, weight: 0 });
});

// ── strategy vs matrix ──
test('MIN TIME IS OFFERED ONLY WITH GOOGLE DRIVE-TIMES — on the free estimate it is Min distance', () => {
  const free = strategyChoices(false);
  const mt = free.find((c) => c.value === 'MIN_TIME');
  assert.equal(mt.disabled, true);
  assert.match(mt.label, /needs Google/);
  assert.ok(free.filter((c) => c.value !== 'MIN_TIME').every((c) => !c.disabled), 'only Min time is gated');
  const paid = strategyChoices(true);
  assert.ok(paid.every((c) => !c.disabled), 'every strategy is live with Google on');
  assert.equal(paid.find((c) => c.value === 'MIN_TIME').label, 'Min time');
});

test('the pick is remembered: Min time falls back to Min distance while Google is off and comes back when it is on', () => {
  assert.equal(effectiveStrategy('MIN_TIME', false), 'MIN_DISTANCE');
  assert.equal(effectiveStrategy('MIN_TIME', true), 'MIN_TIME');
  assert.equal(effectiveStrategy('CLOSEST_FIRST', false), 'CLOSEST_FIRST');
  assert.equal(effectiveStrategy('bogus', true), 'MIN_DISTANCE', 'an unknown strategy never reaches the solver');
  assert.equal(ROUTING_STRATEGIES.length, 4);
});

// ── the trailer rule ──
test('the green-only rule has a job only when a tractor is in play', () => {
  assert.equal(tractorInPlay([{ capabilities: { tractor: false } }, { capabilities: {} }]), false);
  assert.equal(tractorInPlay([{ capabilities: { tractor: false } }, { capabilities: { tractor: true } }]), true);
  assert.equal(tractorInPlay([]), false);
  assert.equal(tractorInPlay(null), false);
});

// ── which Save is which ──
test('a loads-bound build keeps only ONE thing called Save on the screen', () => {
  const l = planCopyLabels(true);
  assert.ok(!/^save/i.test(l.button), `the copy button must not be called Save: ${l.button}`);
  assert.match(l.hint, /Compare cards/);
  const t = planCopyLabels(false);
  assert.equal(t.button, 'Save load', 'trucks mode is unchanged — the copy is its only artefact');
});

// ── AI assist status ──
test('AI assist status tells "never asked" apart from "asked, no key on the site"', () => {
  assert.equal(aiAssistStatus({ requested: false, configured: false }), 'off');
  assert.match(aiAssistStatus({ requested: true, configured: false }), /ANTHROPIC_API_KEY/);
  assert.equal(aiAssistStatus({ requested: true, configured: true, ai: { intent: true, explain: true } }), 'on — note read, rationale');
  assert.equal(aiAssistStatus({ requested: true, configured: true, ai: {} }), 'on — nothing needed it');
  assert.equal(aiAssistStatus(), 'off');
});

// ── truck profile drafts ──
const saved = { id: 'box', maxSkids: 12, maxWeightLbs: 10000, deckLengthIn: 312, capabilities: { liftgate: true } };
test('A BLANK SKIDS BOX NEVER WRITES A 0-SKID FLEET PROFILE', () => {
  const r = profileDraftCheck({ maxSkids: '', maxWeightLbs: '10000', deckLengthIn: '312', capabilities: { liftgate: true } }, saved);
  assert.equal(r.valid, false);
  assert.match(r.problems.join(' '), /Skids/);
});
test('an unchanged draft is not dirty; a real change is, and normalizes to numbers', () => {
  const same = profileDraftCheck({ maxSkids: '12', maxWeightLbs: '10000', deckLengthIn: '312', capabilities: { liftgate: true } }, saved);
  assert.equal(same.dirty, false); assert.equal(same.valid, true);
  const changed = profileDraftCheck({ maxSkids: '14', maxWeightLbs: '10000', deckLengthIn: '312', capabilities: { liftgate: false } }, saved);
  assert.equal(changed.dirty, true); assert.equal(changed.valid, true);
  assert.equal(changed.normalized.maxSkids, 14);
  assert.equal(changed.normalized.capabilities.liftgate, false);
  assert.equal(changed.normalized.id, 'box', 'identity survives the merge');
});
test('zero, negative and text capacities are refused', () => {
  for (const bad of ['0', '-3', 'lots', 'NaN']) {
    const r = profileDraftCheck({ maxSkids: bad, maxWeightLbs: '1', deckLengthIn: '1' }, saved);
    assert.equal(r.valid, false, `skids=${bad}`);
  }
});
