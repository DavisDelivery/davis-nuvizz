// test/routing-send-state.test.mjs — what is in NuVizz, and what is only on this screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardSendState, routePaintSource, sendControlState } from '../src/lib/routing-select.js';

// ── the card chip ──
test('A CARD WITH STAGED CHANGES SAYS SO — the old signal was a button disappearing', () => {
  const s = cardSendState({ dirty: true });
  assert.equal(s.kind, 'unsent');
  assert.equal(s.tone, 'amber');
  assert.match(s.label, /Not sent to NuVizz/);
});

test('a confirmed save turns it green, and only a confirmed save can', () => {
  assert.equal(cardSendState({ dirty: false, savedAt: 1757000000000 }).kind, 'sent');
  // Still dirty after a save (the dispatcher moved another stop) → back to not-sent.
  assert.equal(cardSendState({ dirty: true, savedAt: 1757000000000 }).kind, 'unsent');
});

test('an untouched card does not claim to have been sent', () => {
  const s = cardSendState({ dirty: false, savedAt: null });
  assert.equal(s.kind, 'clean');
  assert.equal(s.tone, 'slate');
  assert.ok(!/Sent/.test(s.label), `a card nobody saved must not read as sent: ${s.label}`);
});

test('A NEW ROUTE IS "NOT CREATED" — the load does not exist in NuVizz at all yet', () => {
  assert.equal(cardSendState({ dirty: true, pendingCreate: true }).kind, 'new');
  // …and an EMPTY new-route card still says so: nothing is dirty, but there is no load either.
  assert.equal(cardSendState({ dirty: false, pendingCreate: true }).kind, 'new');
  // Once created and verified, it is an ordinary sent card.
  assert.equal(cardSendState({ dirty: false, pendingCreate: true, savedAt: 1757000000000 }).kind, 'sent');
});

test('BETA WINS OVER EVERY NOT-SENT WORDING — the button is blue and says "Save (2)" and sends nothing', () => {
  assert.equal(cardSendState({ dirty: true, liveMode: false }).kind, 'beta');
  assert.equal(cardSendState({ dirty: true, pendingCreate: true, liveMode: false }).kind, 'beta');
  // A card already written in Live, now viewed in Beta with nothing staged, is still sent.
  assert.equal(cardSendState({ dirty: false, savedAt: 1757000000000, liveMode: false }).kind, 'sent');
});

test('called with nothing, it never claims anything was sent', () => {
  assert.equal(cardSendState().kind, 'clean');
  assert.equal(cardSendState({}).kind, 'clean');
});

// ── what the map paints ──
test('open cards are the working set — the map paints them', () => {
  assert.equal(routePaintSource({ openCards: 2, planStaged: true }), 'cards');
  assert.equal(routePaintSource({ openCards: 1, planStaged: false }), 'cards');
});

test('CLOSING THE LAST STAGED CARD LETS THE STOPS GO — it must not fall back to the engine plan', () => {
  // The v1.19.0 bug: build → auto-staged cards → close them → the same stops came back
  // numbered and route-coloured off the build result, with nothing sent to NuVizz.
  assert.equal(routePaintSource({ openCards: 0, planStaged: true }), 'none');
});

test('a plan that was never staged still paints — that is how you see the build on the map', () => {
  assert.equal(routePaintSource({ openCards: 0, planStaged: false }), 'plan');
  assert.equal(routePaintSource(), 'plan');
});

// ── the panel's send control (v1.36.0) ──
// The failure this pins, in Chad's words: "where is my save send to nuvizz button? ... i
// have no way to send these loads to nuvizz." A card said NOT SENT TO NUVIZZ while the
// header's Save, the engine badge and the LIVE switch were all hidden by a per-device gear.

test('A CARD THAT SAYS "NOT SENT" MUST NEVER SIT ON A PANEL WITH NOTHING TO SEND IT WITH', () => {
  // THE INVARIANT. For every card state that reads as not-in-NuVizz, the panel holding that
  // card has to offer a control that does something. This is the bug of Sep 15, as a rule.
  for (const liveMode of [true, false]) {
    for (const pendingCreate of [false, true]) {
      const card = cardSendState({ dirty: true, pendingCreate, liveMode });
      if (!['unsent', 'new', 'beta'].includes(card.kind)) continue;
      const panel = sendControlState({ openCards: 1, dirtyCards: 1, liveMode });
      assert.ok(panel.actionable, `card says "${card.label}" but the panel offers "${panel.label}" (kind ${panel.kind})`);
      assert.ok(panel.label, 'an actionable control must have words on it');
    }
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

test('nothing staged: the panel SAYS which kind of nothing — the old signal was a button vanishing', () => {
  assert.equal(sendControlState({ openCards: 2, dirtyCards: 0, anySaved: true }).kind, 'sent');
  assert.equal(sendControlState({ openCards: 2, dirtyCards: 0, anySaved: false }).kind, 'clean');
  // The exact wording (it used to be greppable in App.jsx; the rule owns it now).
  assert.equal(sendControlState({ openCards: 2, dirtyCards: 0, anySaved: true }).label, '\u2713 All sent to NuVizz');
  assert.equal(sendControlState({ openCards: 2, dirtyCards: 0, anySaved: false }).label, 'Nothing to send');
  // Neither claims a send is pending, and neither is a button.
  assert.equal(sendControlState({ openCards: 2, dirtyCards: 0, anySaved: true }).actionable, false);
  assert.equal(sendControlState({ openCards: 2, dirtyCards: 0, anySaved: false }).actionable, false);
});

test('with no cards open there is nothing to render, and never a false "sent"', () => {
  assert.equal(sendControlState({ openCards: 0, dirtyCards: 0 }).kind, 'none');
  assert.equal(sendControlState({ openCards: 0, dirtyCards: 3, anySaved: true }).kind, 'none');
  assert.equal(sendControlState().kind, 'none');
  assert.equal(sendControlState({}).kind, 'none');
});

test('malformed counts never hide the control or invent one', () => {
  // Number(undefined) is NaN and NaN > 0 is false — the dangerous direction is a hidden
  // button, so prove the empty/absent cases land on 'none' rather than throwing.
  assert.equal(sendControlState({ openCards: null, dirtyCards: null }).kind, 'none');
  assert.equal(sendControlState({ openCards: '2', dirtyCards: '1' }).kind, 'send');
});
