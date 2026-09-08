// test/send-selection.test.mjs — one press of "→ LOAD (N)" moves the selection, and says what happened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSendSelection } from '../src/lib/send-selection.js';

const card = (key, order = [], extra = {}) => ({ key, name: key, loadNbr: null, order, ...extra });
const board = { 101: '', 102: '', 201: 'BEN 2', 202: 'BEN 2', 301: 'SUW 5' };   // '' = unplanned
const holderOf = (id) => board[id] || '';
const opener = (log = []) => (h, cards) => {
  log.push(h);
  const held = Object.entries(board).filter(([, r]) => r === h).map(([n]) => String(n));
  return { card: card(h, held) };
};

test('Sep 8: stops still planned on a load that is NOT open move in ONE press, and the source card opens to release them', () => {
  const opened = [];
  const plan = planSendSelection({ ids: ['201', '202'], targetKey: 'T1', cards: [card('T1'), card('T2')], max: 6, holderOf, openCard: opener(opened) });
  assert.deepEqual(opened, ['BEN 2']);
  assert.equal(plan.cards.length, 3, 'the source card is on the workbench now');
  const t1 = plan.cards.find((c) => c.key === 'T1');
  const src = plan.cards.find((c) => c.key === 'BEN 2');
  assert.deepEqual(t1.order, ['201', '202'], 'the target holds the stops after ONE press');
  assert.deepEqual(src.order, [], 'the source card no longer holds them — that is the staged release');
  assert.deepEqual(plan.held, [], 'nothing left selected for a second press');
  assert.equal(plan.changed, true);
  assert.match(plan.message, /^Sent 2 stops → T1 \(opened BEN 2 in Compare/);
});

test('unplanned stops go straight onto the target and the selection clears', () => {
  const plan = planSendSelection({ ids: ['101', '102'], targetKey: 'T2', cards: [card('T1'), card('T2')], max: 6, holderOf, openCard: opener() });
  assert.deepEqual(plan.cards.find((c) => c.key === 'T2').order, ['101', '102']);
  assert.deepEqual(plan.opened, []);
  assert.deepEqual(plan.held, []);
  assert.equal(plan.message, 'Sent 2 stops → T2');
});

test('a source that REFUSES to open keeps its stops selected and the message carries the real reason — never "Opened"', () => {
  const openCard = (h) => ({ refusal: `Two loads are named "${h}" today, so a card can't tell which one it would save to.` });
  const plan = planSendSelection({ ids: ['201', '101'], targetKey: 'T1', cards: [card('T1')], max: 6, holderOf, openCard });
  assert.deepEqual(plan.moved, ['101'], 'the unplanned stop still moves');
  assert.deepEqual(plan.held, ['201'], 'the blocked stop stays selected');
  assert.deepEqual(plan.opened, []);
  assert.doesNotMatch(plan.message, /Opened/i);
  assert.match(plan.message, /Sent 1 stop → T1 · 1 stop NOT moved — Two loads are named "BEN 2"/);
});

test('Compare full: the source is named, its stops are held, and the cap is not exceeded', () => {
  const cards = [card('T1'), card('A'), card('B')];
  const plan = planSendSelection({ ids: ['301'], targetKey: 'T1', cards, max: 3, holderOf, openCard: opener() });
  assert.equal(plan.cards.length, 3);
  assert.deepEqual(plan.held, ['301']);
  assert.deepEqual(plan.moved, []);
  assert.match(plan.message, /SUW 5 needs a free card — Compare is full \(3\/3\)/);
  assert.equal(plan.changed, false);
});

test('several sources: each opens once, all stops move, the message names every opened load', () => {
  const opened = [];
  const plan = planSendSelection({ ids: ['201', '202', '301', '101'], targetKey: 'T1', cards: [card('T1')], max: 6, holderOf, openCard: opener(opened) });
  assert.deepEqual(opened, ['BEN 2', 'SUW 5']);
  assert.deepEqual(plan.cards.find((c) => c.key === 'T1').order, ['201', '202', '301', '101']);
  assert.deepEqual(plan.cards.find((c) => c.key === 'SUW 5').order, []);
  assert.match(plan.message, /opened BEN 2, SUW 5 in Compare/);
});

test('a source already open under its load NUMBER counts as open (card identity is key, name or number)', () => {
  const opened = [];
  const cards = [card('T1'), { key: 'DAVIS000198197', name: 'BEN 2', loadNbr: 'DAVIS000198197', order: ['201', '202'] }];
  const plan = planSendSelection({ ids: ['201'], targetKey: 'T1', cards, max: 6, holderOf, openCard: opener(opened) });
  assert.deepEqual(opened, [], 'nothing re-opened');
  assert.deepEqual(plan.cards[1].order, ['202'], 'the open source card released it');
  assert.deepEqual(plan.cards[0].order, ['201']);
});

test('a stop staged on ANOTHER open card moves off it — a stop sits on one card only', () => {
  const plan = planSendSelection({ ids: ['101'], targetKey: 'T1', cards: [card('T1'), card('T2', ['101', '102'])], max: 6, holderOf, openCard: opener() });
  assert.deepEqual(plan.cards.find((c) => c.key === 'T2').order, ['102']);
  assert.deepEqual(plan.cards.find((c) => c.key === 'T1').order, ['101']);
});

test('a stop another device is staging is skipped, by name, and the rest still move', () => {
  const plan = planSendSelection({ ids: ['101', '102'], targetKey: 'T1', cards: [card('T1')], max: 6, holderOf, claimedBy: (id) => (id === '102' ? 'Jessica' : null), openCard: opener() });
  assert.deepEqual(plan.moved, ['101']);
  assert.deepEqual(plan.skippedClaimed, ['102']);
  assert.match(plan.message, /skipped 1 being staged by Jessica on another device/);
});

test('co-located twin orders ride along and are named, once, never duplicating a selected stop', () => {
  const twinsOf = (id) => (id === '101' ? [{ id: '102', label: '102 (ACME)' }, { id: '101', label: 'self' }] : []);
  const plan = planSendSelection({ ids: ['101', '102'], targetKey: 'T1', cards: [card('T1')], max: 6, holderOf, twinsOf, openCard: opener() });
  assert.deepEqual(plan.twins, [], 'a twin already selected is not a twin');
  const plan2 = planSendSelection({ ids: ['101'], targetKey: 'T1', cards: [card('T1')], max: 6, holderOf, twinsOf, openCard: opener() });
  assert.deepEqual(plan2.twins, ['102']);
  assert.deepEqual(plan2.cards[0].order, ['101', '102']);
  assert.match(plan2.message, /also added 1 co-located order the selection missed: 102 \(ACME\)/);
});

test('stops already on the target are not added twice, and an untouched card is the same object', () => {
  const t1 = card('T1', ['101']);
  const t2 = card('T2', ['999']);
  const plan = planSendSelection({ ids: ['101'], targetKey: 'T1', cards: [t1, t2], max: 6, holderOf, openCard: opener() });
  assert.equal(plan.cards[0], t1);
  assert.equal(plan.cards[1], t2);
  assert.equal(plan.changed, false);
  assert.equal(plan.message, 'Sent 1 stop → T1');
});

test('no target, an empty selection, or a target that is not open → null (nothing to do, nothing claimed)', () => {
  assert.equal(planSendSelection({ ids: [], targetKey: 'T1', cards: [card('T1')], max: 6, holderOf }), null);
  assert.equal(planSendSelection({ ids: ['101'], targetKey: '', cards: [card('T1')], max: 6, holderOf }), null);
  assert.equal(planSendSelection({ ids: ['101'], targetKey: 'GONE', cards: [card('T1')], max: 6, holderOf }), null);
  assert.equal(planSendSelection({ ids: [null, undefined, ''], targetKey: 'T1', cards: [card('T1')], max: 6, holderOf }), null);
});

test('the selection is left holding exactly the stops that could not move — and nothing else', () => {
  const openCard = (h) => (h === 'BEN 2' ? { refusal: 'no identity' } : { card: card(h, ['301']) });
  const plan = planSendSelection({ ids: ['201', '301', '101'], targetKey: 'T1', cards: [card('T1')], max: 6, holderOf, openCard });
  assert.deepEqual(plan.held, ['201']);
  assert.deepEqual(plan.moved.sort(), ['101', '301']);
  assert.equal(plan.cards.length, 2);
});

test('numeric stop ids are normalised to strings so a card never carries a mixed-type order', () => {
  const plan = planSendSelection({ ids: [101, '102'], targetKey: 'T1', cards: [card('T1')], max: 6, holderOf, openCard: opener() });
  assert.deepEqual(plan.cards[0].order, ['101', '102']);
});
