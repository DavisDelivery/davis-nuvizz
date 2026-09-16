// test/routing-send-state.test.mjs — the Compare header's send control (v1.36.0).
//
// The v1.33.0 card chip (cardSendState) and map-paint rule (routePaintSource) that used to
// share this file were REVERTED in v1.36.1 at Chad's direction; only the send control remains.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendControlState } from '../src/lib/routing-select.js';

// The failure this pins, in Chad's words: "where is my save send to nuvizz button? ... i
// have no way to send these loads to nuvizz." The header's Save, the engine badge and the
// LIVE switch were all hidden by a per-device gear while the cards carried staged changes.

test('STAGED CHANGES ALWAYS GET A CONTROL THAT DOES SOMETHING — the bug of Sep 15, as a rule', () => {
  for (const liveMode of [true, false]) {
    const panel = sendControlState({ openCards: 1, dirtyCards: 1, liveMode });
    assert.ok(panel.actionable, `dirty card in ${liveMode ? 'Live' : 'Beta'} offers "${panel.label}" (kind ${panel.kind})`);
    assert.ok(panel.label, 'an actionable control must have words on it');
  }
});

test('the control is named for what it does — the dispatcher went looking for "send to nuvizz"', () => {
  const s = sendControlState({ openCards: 1, dirtyCards: 2, liveMode: true });
  assert.equal(s.kind, 'send');
  assert.match(s.label, /Send to NuVizz/);
  assert.match(s.label, /\(2\)/);   // how many cards it covers, so a forgotten card is visible
});

test('BETA NEVER SAYS "SEND TO NUVIZZ" — in Beta the button sends nothing at all', () => {
  const s = sendControlState({ openCards: 1, dirtyCards: 2, liveMode: false });
  assert.equal(s.kind, 'beta');
  assert.ok(!/Send to NuVizz/.test(s.label), `Beta must not read as sending: ${s.label}`);
  assert.match(s.label, /Beta/);
  assert.ok(s.actionable, 'Beta still simulates, so the button is still live');
});

test('NOTHING STAGED → NOTHING RENDERED — the header as it was before v1.33.0 (reverted v1.36.1)', () => {
  const s = sendControlState({ openCards: 2, dirtyCards: 0 });
  assert.equal(s.kind, 'none');
  assert.equal(s.actionable, false);
  assert.equal(s.label, '');
});

test('with no cards open there is nothing to render', () => {
  assert.equal(sendControlState({ openCards: 0, dirtyCards: 0 }).kind, 'none');
  assert.equal(sendControlState({ openCards: 0, dirtyCards: 3 }).kind, 'none');
  assert.equal(sendControlState().kind, 'none');
  assert.equal(sendControlState({}).kind, 'none');
});

test('malformed counts never hide the control or invent one', () => {
  // Number(undefined) is NaN and NaN > 0 is false — the dangerous direction is a hidden
  // button, so prove the empty/absent cases land on 'none' rather than throwing.
  assert.equal(sendControlState({ openCards: null, dirtyCards: null }).kind, 'none');
  assert.equal(sendControlState({ openCards: '2', dirtyCards: '1' }).kind, 'send');
});
